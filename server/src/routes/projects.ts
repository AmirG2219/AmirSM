import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { newId, now, parseJson, tx, type Row } from '../db/index.js';
import { ALLOWED_AUDIO_EXT, ALLOWED_VIDEO_EXT, CaptionSchema, captionToText, type Caption, type MediaInfo } from '../../../shared/domain.js';
import { OUTPUT_FORMATS, STYLE_PRESETS, type EditPlan } from '../../../shared/editPlan.js';
import type { ProjectDetail, UploadResult } from '../../../shared/api.js';
import { HttpError, badRequest, conflict, mimeFor, notFound, sendFile, slugify } from '../http.js';
import {
  assetFilePath, exportDirPath, getAssetRow, getProjectRow, getVersionRow, listAssetRows, logEvent, renderFilePath,
  thumbFilePath, toAssetDTO, toProjectDTO, toProjectSummary, toVersionDTO,
} from '../repo.js';
import { produceCaption, recalcProjectStatus } from '../orchestrator.js';
import { captionChecks, overallOf } from '../ai/review.js';
import type { QualityReport } from '../../../shared/domain.js';

const ACTIVE = ['queued', 'planning', 'rendering', 'captioning'];

const createProjectSchema = z.object({
  title: z.string().trim().min(1).max(120),
  brief: z.string().max(5000).optional(),
  stylePreset: z.enum(STYLE_PRESETS).optional(),
  format: z.enum(Object.keys(OUTPUT_FORMATS) as [keyof typeof OUTPUT_FORMATS, ...(keyof typeof OUTPUT_FORMATS)[]]).optional(),
});
const patchProjectSchema = createProjectSchema.partial().extend({
  subtitleLines: z.array(z.string().trim().min(1).max(160)).max(200).optional(),
});
const versionSchema = z.object({ instruction: z.string().trim().max(5000).optional(), baseVersionId: z.string().optional() });

export function registerProjectRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, config, video, jobs } = ctx;

  // ---------- projects ----------
  app.get('/api/projects', async (req) => {
    const q = z.object({ status: z.string().optional(), q: z.string().max(200).optional(), includeArchived: z.string().optional() }).parse(req.query);
    const where: string[] = [];
    const args: string[] = [];
    if (q.status) {
      where.push('status = ?');
      args.push(q.status);
    } else if (q.includeArchived !== 'true') where.push("status != 'archived'");
    if (q.q) {
      where.push('(title LIKE ? OR brief LIKE ?)');
      args.push(`%${q.q}%`, `%${q.q}%`);
    }
    const rows = db.prepare(`SELECT * FROM projects ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at DESC`).all(...args) as Row[];
    return rows.map((r) => toProjectSummary(db, r));
  });

  app.post('/api/projects', async (req, reply) => {
    const b = createProjectSchema.parse(req.body);
    const id = newId('prj');
    const t = now();
    db.prepare('INSERT INTO projects (id, title, brief, style_preset, format, created_at, updated_at) VALUES (?,?,?,?,?,?,?)').run(
      id, b.title, b.brief ?? '', b.stylePreset ?? 'calm-cinematic', b.format ?? '9:16', t, t,
    );
    logEvent(db, 'project.created', `Created project “${b.title}”.`, id);
    reply.code(201);
    return detail(id);
  });

  function detail(id: string): ProjectDetail {
    const p = getProjectRow(db, id);
    const versions = db.prepare('SELECT * FROM versions WHERE project_id = ? ORDER BY number DESC').all(id) as Row[];
    return { project: toProjectDTO(p), assets: listAssetRows(db, id).map(toAssetDTO), versions: versions.map((v) => toVersionDTO(db, v)) };
  }

  app.get('/api/projects/:id', async (req) => detail((req.params as { id: string }).id));

  app.patch('/api/projects/:id', async (req) => {
    const id = (req.params as { id: string }).id;
    const p = getProjectRow(db, id);
    const b = patchProjectSchema.parse(req.body);
    db.prepare('UPDATE projects SET title = ?, brief = ?, style_preset = ?, format = ?, subtitle_lines = ?, updated_at = ? WHERE id = ?').run(
      b.title ?? p.title, b.brief ?? p.brief, b.stylePreset ?? p.style_preset, b.format ?? p.format,
      b.subtitleLines ? JSON.stringify(b.subtitleLines) : p.subtitle_lines, now(), id,
    );
    return detail(id);
  });

  app.post('/api/projects/:id/archive', async (req) => {
    const id = (req.params as { id: string }).id;
    const p = getProjectRow(db, id);
    if (db.prepare(`SELECT 1 FROM versions WHERE project_id = ? AND status IN (${ACTIVE.map(() => '?').join(',')})`).get(id, ...ACTIVE)) {
      throw conflict('busy', 'A draft is still being produced. Cancel it first.');
    }
    db.prepare("UPDATE projects SET status = 'archived', updated_at = ? WHERE id = ?").run(now(), id);
    logEvent(db, 'project.archived', `Archived project “${p.title}”. Files are kept.`, id);
    return detail(id);
  });
  app.post('/api/projects/:id/unarchive', async (req) => {
    const id = (req.params as { id: string }).id;
    getProjectRow(db, id);
    db.prepare("UPDATE projects SET status = 'draft', updated_at = ? WHERE id = ?").run(now(), id);
    recalcProjectStatus(db, id);
    return detail(id);
  });

  // ---------- assets ----------
  app.post('/api/projects/:id/assets', async (req): Promise<UploadResult> => {
    const projectId = (req.params as { id: string }).id;
    const project = getProjectRow(db, projectId);
    if (project.status === 'archived') throw conflict('archived', 'Unarchive the project to add clips.');
    if (!req.isMultipart()) throw badRequest('Send multipart/form-data with one or more files.');
    const dir = path.join(config.paths.uploads, projectId);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(config.paths.thumbs, { recursive: true });
    const results: UploadResult['results'] = [];

    for await (const part of req.parts()) {
      if (part.type !== 'file') {
        continue;
      }
      const name = path.basename(part.filename || 'upload');
      const ext = path.extname(name).toLowerCase();
      const kind = (ALLOWED_VIDEO_EXT as readonly string[]).includes(ext) ? 'video' : (ALLOWED_AUDIO_EXT as readonly string[]).includes(ext) ? 'audio' : null;
      if (!kind) {
        part.file.resume();
        results.push({ name, ok: false, error: `Unsupported file type "${ext || 'none'}". Allowed: ${[...ALLOWED_VIDEO_EXT, ...ALLOWED_AUDIO_EXT].join(', ')}` });
        continue;
      }
      const id = newId('ast');
      const tmp = path.join(dir, `${id}.part`);
      const final = path.join(dir, `${id}${ext}`);
      const hash = crypto.createHash('sha256');
      let size = 0;
      try {
        await pipeline(
          part.file,
          new Transform({
            transform(chunk, _enc, cb) {
              hash.update(chunk);
              size += chunk.length;
              cb(null, chunk);
            },
          }),
          fs.createWriteStream(tmp),
        );
        if (part.file.truncated) throw new Error(`File exceeds the ${Math.round(config.maxUploadBytes / 1048576)} MB limit.`);
        if (size === 0) throw new Error('File is empty.');
        const sha = hash.digest('hex');
        const dup = db.prepare('SELECT original_name FROM assets WHERE project_id = ? AND sha256 = ?').get(projectId, sha) as Row | undefined;
        if (dup) throw new Error(`Already uploaded as “${dup.original_name}”.`);

        let info: MediaInfo;
        try {
          info = await video.probe(tmp);
        } catch (e) {
          throw new Error(`Not a readable media file (${(e as Error).message.split('\n')[0]}).`);
        }
        if (kind === 'video' && (!info.hasVideo || info.durationMs <= 0)) throw new Error('No playable video stream found.');
        if (kind === 'audio' && !info.hasAudio) throw new Error('No audio stream found.');

        fs.renameSync(tmp, final);
        let thumbName: string | null = null;
        if (kind === 'video') {
          try {
            thumbName = `${id}.jpg`;
            await video.thumbnail(final, thumbFilePath(config, thumbName));
          } catch {
            thumbName = null;
          }
        }
        const order = (db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM assets WHERE project_id = ?').get(projectId) as Row).n;
        db.prepare(
          'INSERT INTO assets (id, project_id, kind, original_name, stored_name, mime, size_bytes, sha256, info_json, thumb_name, sort_order, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        ).run(id, projectId, kind, name.slice(0, 200), `${id}${ext}`, mimeFor(final), size, sha, JSON.stringify(info), thumbName, order, now());
        db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now(), projectId);
        logEvent(db, 'asset.uploaded', `Uploaded “${name}” to “${project.title}”.`, projectId);
        results.push({ name, ok: true, asset: toAssetDTO(getAssetRow(db, id)) });
      } catch (e) {
        fs.rmSync(tmp, { force: true });
        fs.rmSync(final, { force: true });
        results.push({ name, ok: false, error: (e as Error).message });
      }
    }
    if (!results.length) throw badRequest('No files were received.');
    return { results };
  });

  const patchAssetSchema = z.object({ excluded: z.boolean().optional(), sortOrder: z.number().int().min(0).max(10_000).optional() });
  app.patch('/api/assets/:id', async (req) => {
    const a = getAssetRow(db, (req.params as { id: string }).id);
    const b = patchAssetSchema.parse(req.body);
    db.prepare('UPDATE assets SET excluded = ?, sort_order = ? WHERE id = ?').run(b.excluded === undefined ? a.excluded : b.excluded ? 1 : 0, b.sortOrder ?? a.sort_order, a.id);
    return toAssetDTO(getAssetRow(db, a.id));
  });

  app.get('/api/assets/:id/file', async (req, reply) => {
    const a = getAssetRow(db, (req.params as { id: string }).id);
    return sendFile(req, reply, assetFilePath(config, a), { mime: a.mime, downloadName: (req.query as { download?: string }).download ? a.original_name : undefined });
  });
  app.get('/api/assets/:id/thumb', async (req, reply) => {
    const a = getAssetRow(db, (req.params as { id: string }).id);
    if (!a.thumb_name) throw notFound('Thumbnail');
    return sendFile(req, reply, thumbFilePath(config, a.thumb_name), { mime: 'image/jpeg' });
  });

  // ---------- versions ----------
  app.post('/api/projects/:id/versions', async (req, reply) => {
    const projectId = (req.params as { id: string }).id;
    const project = getProjectRow(db, projectId);
    const b = versionSchema.parse(req.body ?? {});
    if (project.status === 'archived') throw conflict('archived', 'Unarchive the project first.');
    const active = db.prepare(`SELECT 1 FROM versions WHERE project_id = ? AND status IN (${ACTIVE.map(() => '?').join(',')})`).get(projectId, ...ACTIVE);
    if (active) throw conflict('busy', 'A draft is already being produced for this project.');
    const assets = listAssetRows(db, projectId).filter((a) => !a.excluded && a.kind === 'video');
    if (!assets.length) throw badRequest('Upload at least one video clip first.');

    const existing = db.prepare('SELECT COUNT(*) AS n FROM versions WHERE project_id = ?').get(projectId) as Row;
    const isRevision = existing.n > 0;
    let parentId: string | null = null;
    if (isRevision) {
      if (!b.instruction || b.instruction.length < 3) throw badRequest('Describe what to change.');
      if (!ctx.ai.status().configured) throw conflict('ai_unavailable', 'Revisions need the AI to interpret your request, and no Anthropic API key is configured. You can still edit the caption by hand.');
      if (b.baseVersionId) {
        const base = getVersionRow(db, b.baseVersionId);
        if (base.project_id !== projectId) throw badRequest('Base version belongs to another project.');
        parentId = base.id;
      } else {
        const last = db.prepare('SELECT id FROM versions WHERE project_id = ? AND plan_json IS NOT NULL ORDER BY number DESC LIMIT 1').get(projectId) as Row | undefined;
        parentId = last?.id ?? null;
      }
    }
    const instruction = isRevision ? b.instruction! : b.instruction || project.brief;
    if (!isRevision && b.instruction && b.instruction !== project.brief) {
      db.prepare('UPDATE projects SET brief = ? WHERE id = ?').run(b.instruction, projectId);
    }
    const id = newId('ver');
    const number = tx(db, () => {
      const n = (db.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM versions WHERE project_id = ?').get(projectId) as Row).n as number;
      db.prepare('INSERT INTO versions (id, project_id, number, parent_version_id, instruction, is_revision, status, created_at) VALUES (?,?,?,?,?,?,?,?)').run(id, projectId, n, parentId, instruction, isRevision ? 1 : 0, 'queued', now());
      return n;
    });
    jobs.enqueue({ type: 'produce_version', projectId, versionId: id });
    recalcProjectStatus(db, projectId);
    logEvent(db, 'version.queued', `Queued ${isRevision ? 'revision' : 'draft'} v${number} of “${project.title}”.`, projectId, id);
    reply.code(201);
    return toVersionDTO(db, getVersionRow(db, id));
  });

  app.get('/api/versions/:id', async (req) => toVersionDTO(db, getVersionRow(db, (req.params as { id: string }).id)));

  app.post('/api/versions/:id/cancel', async (req) => {
    const v = getVersionRow(db, (req.params as { id: string }).id);
    const job = db.prepare("SELECT id FROM jobs WHERE version_id = ? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1").get(v.id) as Row | undefined;
    if (!job) throw conflict('not_running', 'Nothing is running for this version.');
    jobs.cancel(job.id);
    return toVersionDTO(db, getVersionRow(db, v.id));
  });

  app.post('/api/versions/:id/retry', async (req) => {
    const v = getVersionRow(db, (req.params as { id: string }).id);
    const { replan } = z.object({ replan: z.boolean().optional() }).parse(req.body ?? {});
    if (v.status !== 'failed' && v.status !== 'cancelled') throw conflict('not_failed', 'Only failed or cancelled drafts can be retried.');
    const other = db.prepare(`SELECT 1 FROM versions WHERE project_id = ? AND id != ? AND status IN (${ACTIVE.map(() => '?').join(',')})`).get(v.project_id, v.id, ...ACTIVE);
    if (other) throw conflict('busy', 'Another draft is being produced for this project.');
    db.prepare(
      `UPDATE versions SET status = 'queued', error = NULL, quality_json = NULL, finished_at = NULL${replan ? ", plan_json = NULL, plan_source = NULL, plan_rationale = NULL, plan_notes_json = '[]'" : ''} WHERE id = ?`,
    ).run(v.id);
    jobs.enqueue({ type: 'produce_version', projectId: v.project_id, versionId: v.id });
    recalcProjectStatus(db, v.project_id);
    logEvent(db, 'version.retry', `Retrying draft v${v.number}${replan ? ' with a fresh plan' : ''}.`, v.project_id, v.id);
    return toVersionDTO(db, getVersionRow(db, v.id));
  });

  app.patch('/api/versions/:id/caption', async (req) => {
    const v = getVersionRow(db, (req.params as { id: string }).id);
    if (v.status !== 'ready') throw conflict('not_editable', 'The caption can only be edited while the draft is awaiting review.');
    const cap = CaptionSchema.parse(req.body);
    // The caption checks (and the AI consistency note, which described the old text) are stale after a manual edit: recompute them.
    const q = parseJson<QualityReport | null>(v.quality_json, null);
    let qualityJson = v.quality_json as string | null;
    if (q) {
      const kept = q.checks.filter((c) => !c.id.startsWith('caption-') && c.id !== 'ai-consistency');
      const checks = [...kept, ...captionChecks(cap)];
      qualityJson = JSON.stringify({ ...q, checks, overall: overallOf(checks), sources: q.sources.filter((s) => s !== 'ai') });
    }
    db.prepare("UPDATE versions SET caption_json = ?, caption_status = 'manual', caption_note = NULL, quality_json = ? WHERE id = ?").run(JSON.stringify(cap), qualityJson, v.id);
    return toVersionDTO(db, getVersionRow(db, v.id));
  });

  app.post('/api/versions/:id/caption/regenerate', async (req) => {
    const v = getVersionRow(db, (req.params as { id: string }).id);
    if (v.status !== 'ready') throw conflict('not_editable', 'Only drafts awaiting review can get a new caption.');
    if (!ctx.ai.status().configured) throw conflict('ai_unavailable', 'No Anthropic API key is configured.');
    const { feedback } = z.object({ feedback: z.string().trim().max(1000).optional() }).parse(req.body ?? {});
    const project = getProjectRow(db, v.project_id);
    const plan = parseJson<EditPlan | null>(v.plan_json, null);
    if (!plan) throw conflict('no_plan', 'This draft has no edit plan.');
    const briefs = listAssetRows(db, v.project_id).filter((a) => !a.excluded).map((a) => {
      const info = parseJson<MediaInfo>(a.info_json, {} as MediaInfo);
      return { id: a.id, name: a.original_name, durationMs: info.durationMs, width: info.displayWidth || info.width, height: info.displayHeight || info.height, hasAudio: info.hasAudio, kind: a.kind };
    });
    await produceCaption(ctx, v, project, plan, briefs, feedback);
    const fresh = getVersionRow(db, v.id);
    if (fresh.caption_status === 'failed' || fresh.caption_status === 'unavailable') throw new HttpError(502, 'caption_failed', fresh.caption_note ?? 'Caption generation failed.');
    return toVersionDTO(db, fresh);
  });

  app.post('/api/versions/:id/approve', async (req) => {
    const v = getVersionRow(db, (req.params as { id: string }).id);
    if (v.status !== 'ready') throw conflict('not_ready', v.status === 'approved' ? 'This draft is already approved.' : 'Only drafts awaiting review can be approved.');
    const project = getProjectRow(db, v.project_id);
    const src = renderFilePath(config, v.project_id, v.number);
    if (!fs.existsSync(src)) throw new HttpError(500, 'render_missing', 'The rendered file is missing on disk.');
    const dir = exportDirPath(config, v.project_id, v.number);
    if (fs.existsSync(dir)) throw conflict('export_exists', 'An export for this version already exists and will not be overwritten.');
    fs.mkdirSync(dir, { recursive: true });
    const base = `${slugify(project.title)}-v${v.number}`;
    const videoOut = path.join(dir, `${base}.mp4`);
    fs.copyFileSync(src, videoOut, fs.constants.COPYFILE_EXCL);
    const sha = crypto.createHash('sha256').update(fs.readFileSync(videoOut)).digest('hex');
    const caption = parseJson<Caption | null>(v.caption_json, null);
    if (caption) fs.writeFileSync(path.join(dir, `${base}-caption.txt`), captionToText(caption), { flag: 'wx' });
    fs.writeFileSync(path.join(dir, `${base}-plan.json`), v.plan_json ?? '{}', { flag: 'wx' });
    const approvedAt = now();
    fs.writeFileSync(
      path.join(dir, 'export.json'),
      JSON.stringify({ project: project.title, projectId: project.id, version: v.number, approvedAt, sha256: sha, planSource: v.plan_source, captionStatus: v.caption_status }, null, 2),
      { flag: 'wx' },
    );
    for (const f of fs.readdirSync(dir)) fs.chmodSync(path.join(dir, f), 0o444);
    tx(db, () => {
      db.prepare("UPDATE versions SET status = 'approved', approved_at = ?, export_dir = ? WHERE id = ?").run(approvedAt, path.relative(config.dataDir, dir).replace(/\\/g, '/'), v.id);
      db.prepare("UPDATE versions SET status = 'superseded' WHERE project_id = ? AND status = 'ready' AND id != ?").run(v.project_id, v.id);
      db.prepare('UPDATE projects SET approved_version_id = ?, updated_at = ? WHERE id = ?').run(v.id, approvedAt, v.project_id);
    });
    recalcProjectStatus(db, v.project_id);
    logEvent(db, 'version.approved', `Approved v${v.number} of “${project.title}”. Exported copy saved.`, v.project_id, v.id);
    ctx.n8n.emit('version.approved', { projectId: v.project_id, versionId: v.id, number: v.number, title: project.title }, v.project_id);
    return toVersionDTO(db, getVersionRow(db, v.id));
  });

  function versionVideoPath(v: Row): string {
    if (v.status === 'approved' && v.export_dir) {
      const dir = path.join(config.dataDir, v.export_dir);
      const f = fs.readdirSync(dir).find((n) => n.endsWith('.mp4'));
      if (f) return path.join(dir, f);
    }
    return renderFilePath(config, v.project_id, v.number);
  }

  app.get('/api/versions/:id/video', async (req, reply) => {
    const v = getVersionRow(db, (req.params as { id: string }).id);
    if (!['ready', 'approved', 'superseded'].includes(v.status) || !v.output_name) throw notFound('Video');
    const project = getProjectRow(db, v.project_id);
    const dl = (req.query as { download?: string }).download;
    return sendFile(req, reply, versionVideoPath(v), { mime: 'video/mp4', downloadName: dl ? `${slugify(project.title)}-v${v.number}.mp4` : undefined });
  });

  app.get('/api/versions/:id/caption.txt', async (req, reply) => {
    const v = getVersionRow(db, (req.params as { id: string }).id);
    const caption = parseJson<Caption | null>(v.caption_json, null);
    if (!caption) throw notFound('Caption');
    const project = getProjectRow(db, v.project_id);
    reply.header('Content-Type', 'text/plain; charset=utf-8');
    if ((req.query as { download?: string }).download) reply.header('Content-Disposition', `attachment; filename="${slugify(project.title)}-v${v.number}-caption.txt"`);
    return captionToText(caption);
  });

  app.get('/api/jobs', async () => {
    const rows = db.prepare("SELECT * FROM jobs WHERE status IN ('queued','running') ORDER BY created_at").all() as Row[];
    return rows.map((j) => ({ id: j.id, projectId: j.project_id, versionId: j.version_id, status: j.status, stage: j.stage, progress: j.progress, message: j.message }));
  });
}
