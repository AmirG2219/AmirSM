/**
 * Orchestrator: runs one "version" through Creative Director/Video Editor (plan) → engine (validate, render)
 * → Copywriter (caption) → Quality Reviewer. Every stage persists its result so a retry resumes where it stopped.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from './context.js';
import type { Row } from './db/index.js';
import { now, parseJson } from './db/index.js';
import type { Caption, MediaInfo, QualityReport } from '../../shared/domain.js';
import type { EditPlan, StylePreset } from '../../shared/editPlan.js';
import { AiLimitError, AiUnavailableError, type AssetBrief } from './ai/types.js';
import type { PlanAsset } from './video/types.js';
import { RenderCancelled } from './video/types.js';
import { FatalJobError, type JobContext, type JobHandler } from './jobs/runner.js';
import { assetFilePath, getProjectRow, getVersionRow, listAssetRows, logEvent, renderFilePath } from './repo.js';

const STAGES = {
  planning: [0, 0.1],
  validating: [0.1, 0.12],
  rendering: [0.12, 0.85],
  captioning: [0.85, 0.93],
  reviewing: [0.93, 1],
} as const;
type Stage = keyof typeof STAGES;
const span = (s: Stage, f: number) => STAGES[s][0] + (STAGES[s][1] - STAGES[s][0]) * Math.max(0, Math.min(1, f));

export function recalcProjectStatus(db: AppContext['db'], projectId: string) {
  const p = db.prepare('SELECT status, approved_version_id FROM projects WHERE id = ?').get(projectId) as Row | undefined;
  if (!p || p.status === 'archived') return;
  const vs = (db.prepare('SELECT status FROM versions WHERE project_id = ?').all(projectId) as Row[]).filter((v) => v.status !== 'cancelled');
  const has = (...s: string[]) => vs.some((v) => s.includes(v.status));
  let status = 'draft';
  if (has('queued', 'planning', 'rendering', 'captioning')) status = 'processing';
  else if (has('ready')) status = 'review';
  else if (p.approved_version_id) status = 'approved';
  else if (vs.length) status = 'failed';
  db.prepare('UPDATE projects SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), projectId);
}

function setVersion(ctx: AppContext, id: string, fields: Record<string, unknown>) {
  const keys = Object.keys(fields);
  ctx.db.prepare(`UPDATE versions SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...(keys.map((k) => fields[k]) as any[]), id);
}

export function createProduceHandler(ctx: AppContext): JobHandler {
  return {
    async run(job: JobContext) {
      const { db, ai, video, config } = ctx;
      const version = getVersionRow(db, job.job.version_id);
      const project = getProjectRow(db, version.project_id);
      const vid = version.id as string;
      const pid = project.id as string;
      const check = () => {
        if (job.signal.aborted) throw new RenderCancelled();
      };

      setVersion(ctx, vid, { status: 'planning', error: null });
      recalcProjectStatus(db, pid);

      // ---- inputs: preserved source files, never modified ----
      const rows = listAssetRows(db, pid).filter((a) => !a.excluded);
      const planAssets = new Map<string, PlanAsset>();
      const briefs: AssetBrief[] = [];
      for (const a of rows) {
        const file = assetFilePath(config, a);
        if (!fs.existsSync(file)) throw new FatalJobError(`Source file for "${a.original_name}" is missing on disk.`);
        const info = parseJson<MediaInfo>(a.info_json, {} as MediaInfo);
        planAssets.set(a.id, { id: a.id, path: file, kind: a.kind, info });
        briefs.push({ id: a.id, name: a.original_name, durationMs: info.durationMs, width: info.displayWidth || info.width, height: info.displayHeight || info.height, hasAudio: info.hasAudio, kind: a.kind });
      }
      if (![...planAssets.values()].some((a) => a.kind === 'video')) throw new FatalJobError('This project has no video clips to edit. Upload at least one clip.');

      // ---- 1. plan ----
      let plan = parseJson<EditPlan | null>(version.plan_json, null);
      if (!plan) {
        job.report('planning', span('planning', 0.1), version.is_revision ? 'Interpreting your revision…' : 'Creative Director is reading your brief…');
        const parent = version.parent_version_id ? (db.prepare('SELECT plan_json, caption_json FROM versions WHERE id = ?').get(version.parent_version_id) as Row | undefined) : undefined;
        const previousPlan = parseJson<EditPlan | null>(parent?.plan_json, null) ?? undefined;
        const subtitleLines = parseJson<string[]>(project.subtitle_lines, []);
        try {
          const res = await ai.planEdit(
            {
              projectId: pid,
              brief: version.is_revision ? project.brief : version.instruction || project.brief,
              preset: project.style_preset as StylePreset,
              assets: briefs,
              previousPlan,
              revisionRequest: version.is_revision ? version.instruction : undefined,
              userSubtitleLines: subtitleLines.length ? subtitleLines : undefined,
            },
            { allowRulesFallback: !version.is_revision },
          );
          plan = res.plan;
          setVersion(ctx, vid, { plan_json: JSON.stringify(plan), plan_source: res.source, plan_rationale: res.rationale, plan_notes_json: JSON.stringify(res.notes) });
        } catch (e) {
          if (e instanceof AiUnavailableError || e instanceof AiLimitError) {
            throw new FatalJobError(
              version.is_revision
                ? `Revisions need the AI to interpret your request, but it is unavailable: ${e.message}`
                : `Planning failed: ${e.message}`,
            );
          }
          throw e;
        }
      }
      check();

      // ---- 2. validate ----
      setVersion(ctx, vid, { status: 'rendering' });
      job.report('validating', span('validating', 0.5), 'Checking the edit plan against your footage…');
      const verdict = video.validatePlan(plan, planAssets);
      if (!verdict.ok) throw new FatalJobError(`The edit plan is not valid: ${verdict.errors.join('; ')}`);

      // ---- 3. render ----
      const outPath = renderFilePath(config, pid, version.number);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      const workDir = path.join(config.paths.work, job.job.id);
      fs.mkdirSync(workDir, { recursive: true });
      let result;
      try {
        result = await video.render({
          plan,
          assets: planAssets,
          outPath,
          workDir,
          signal: job.signal,
          onProgress: (f, msg) => job.report('rendering', span('rendering', f), msg),
        });
      } finally {
        fs.rmSync(workDir, { recursive: true, force: true });
      }
      setVersion(ctx, vid, {
        output_name: path.relative(config.paths.renders, result.outPath).replace(/\\/g, '/'),
        output_size: result.sizeBytes,
        output_duration_ms: result.durationMs,
        output_width: result.width,
        output_height: result.height,
        warnings_json: JSON.stringify([...verdict.warnings, ...result.warnings]),
        command_summary_json: JSON.stringify(result.commandSummary),
      });
      check();

      // ---- 4. caption (never fails the render) ----
      setVersion(ctx, vid, { status: 'captioning' });
      job.report('captioning', span('captioning', 0.1), 'Copywriter is drafting the caption…');
      const caption = await produceCaption(ctx, version, project, plan, briefs);
      check();

      // ---- 5. review ----
      job.report('reviewing', span('reviewing', 0.2), 'Quality Reviewer is checking the export…');
      const deterministic = await video.verifyOutput(result.outPath, plan);
      let quality: QualityReport = deterministic;
      try {
        quality = await ai.reviewQuality({ brief: project.brief, plan, caption: caption ?? undefined, deterministic });
      } catch {
        /* the deterministic report stands on its own */
      }

      if (quality.overall === 'fail') {
        const failed = quality.checks.filter((c) => c.status === 'fail').map((c) => c.detail);
        setVersion(ctx, vid, { quality_json: JSON.stringify(quality) });
        throw new FatalJobError(`Export checks failed: ${failed.join('; ')}`);
      }
      setVersion(ctx, vid, { status: 'ready', quality_json: JSON.stringify(quality), finished_at: now(), error: null });
      logEvent(db, 'version.ready', `Draft v${version.number} of “${project.title}” is ready for review.`, pid, vid);
      recalcProjectStatus(db, pid);
      ctx.n8n.emit('version.ready', { projectId: pid, versionId: vid, number: version.number, title: project.title }, pid);
    },

    onFinalFailure(job: Row, error: Error, cancelled: boolean) {
      const v = ctx.db.prepare('SELECT id, project_id, number, status FROM versions WHERE id = ?').get(job.version_id) as Row | undefined;
      if (!v) return;
      if (v.status !== 'failed' && v.status !== 'cancelled') {
        setVersion(ctx, v.id, { status: cancelled ? 'cancelled' : 'failed', error: cancelled ? null : error.message.slice(0, 1000), finished_at: now() });
      }
      const p = ctx.db.prepare('SELECT title FROM projects WHERE id = ?').get(v.project_id) as Row | undefined;
      logEvent(ctx.db, cancelled ? 'version.cancelled' : 'version.failed', `Draft v${v.number} of “${p?.title ?? ''}” ${cancelled ? 'was cancelled' : 'failed'}.`, v.project_id, v.id);
      recalcProjectStatus(ctx.db, v.project_id);
      if (!cancelled) ctx.n8n.emit('version.failed', { projectId: v.project_id, versionId: v.id, number: v.number, title: p?.title, error: error.message }, v.project_id);
    },
  };
}

/** Writes caption fields on the version. Returns the caption if one exists after this call. */
export async function produceCaption(ctx: AppContext, version: Row, project: Row, plan: EditPlan, briefs: AssetBrief[], feedback?: string): Promise<Caption | null> {
  const status = ctx.ai.status();
  const existing = parseJson<Caption | null>(version.caption_json, null);
  if (!status.configured) {
    if (existing) return existing;
    setVersion(ctx, version.id, { caption_status: 'unavailable', caption_note: 'No Anthropic API key is configured, so no caption was generated. Add ANTHROPIC_API_KEY in .env, or write the caption yourself below.' });
    return null;
  }
  const parent = version.parent_version_id ? (ctx.db.prepare('SELECT caption_json FROM versions WHERE id = ?').get(version.parent_version_id) as Row | undefined) : undefined;
  try {
    const res = await ctx.ai.writeCaption({
      projectId: project.id,
      brief: version.is_revision ? `${project.brief}\n\nRevision request: ${version.instruction}` : version.instruction || project.brief,
      preset: project.style_preset,
      plan,
      assets: briefs,
      previousCaption: existing ?? parseJson<Caption | null>(parent?.caption_json, null) ?? undefined,
      feedback: feedback ?? (version.is_revision ? version.instruction : undefined),
    });
    setVersion(ctx, version.id, { caption_json: JSON.stringify(res.caption), caption_status: 'ai', caption_note: null });
    return res.caption;
  } catch (e) {
    const msg = (e as Error).message;
    setVersion(ctx, version.id, { caption_status: e instanceof AiUnavailableError || e instanceof AiLimitError ? 'unavailable' : 'failed', caption_note: `Caption not generated: ${msg}` });
    return existing;
  }
}
