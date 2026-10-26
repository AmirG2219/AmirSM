/** Data access + DTO mapping for projects, assets, versions and jobs. */
import path from 'node:path';
import fs from 'node:fs';
import type { AppConfig } from './config.js';
import type { Db, Row } from './db/index.js';
import { ID_RE, now, parseJson } from './db/index.js';
import { captionToText, type Caption, type MediaInfo, type QualityReport } from '../../shared/domain.js';
import type { EditPlan, OutputFormat, StylePreset } from '../../shared/editPlan.js';
import type { AssetDTO, JobDTO, ProjectDTO, ProjectSummary, VersionDTO } from '../../shared/api.js';
import { notFound } from './http.js';

// ---------- filesystem layout ----------
export function assertId(id: string) {
  if (!ID_RE.test(id)) throw new Error(`Refusing unsafe id: ${id}`);
  return id;
}
export const assetFilePath = (cfg: AppConfig, a: Row) => path.join(cfg.paths.uploads, assertId(a.project_id), path.basename(a.stored_name));
export const thumbFilePath = (cfg: AppConfig, name: string) => path.join(cfg.paths.thumbs, path.basename(name));
export const renderFilePath = (cfg: AppConfig, projectId: string, number: number) =>
  path.join(cfg.paths.renders, assertId(projectId), `v${Math.trunc(number)}.mp4`);
export const exportDirPath = (cfg: AppConfig, projectId: string, number: number) =>
  path.join(cfg.paths.exports, assertId(projectId), `v${Math.trunc(number)}`);

// ---------- events ----------
export function logEvent(db: Db, kind: string, message: string, projectId?: string | null, versionId?: string | null) {
  db.prepare('INSERT INTO events (ts, kind, project_id, version_id, message) VALUES (?,?,?,?,?)').run(now(), kind, projectId ?? null, versionId ?? null, message.slice(0, 500));
}

// ---------- projects ----------
export function getProjectRow(db: Db, id: string): Row {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined;
  if (!row) throw notFound('Project');
  return row;
}
export function toProjectDTO(r: Row): ProjectDTO {
  return {
    id: r.id,
    title: r.title,
    brief: r.brief,
    stylePreset: r.style_preset as StylePreset,
    format: r.format as OutputFormat,
    subtitleLines: parseJson<string[]>(r.subtitle_lines, []),
    status: r.status,
    approvedVersionId: r.approved_version_id ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
export function toProjectSummary(db: Db, r: Row): ProjectSummary {
  const counts = db.prepare("SELECT (SELECT COUNT(*) FROM assets WHERE project_id = ?1 AND excluded = 0) AS a, (SELECT COUNT(*) FROM versions WHERE project_id = ?1) AS v").get(r.id) as Row;
  const latest = db.prepare('SELECT id, number, status FROM versions WHERE project_id = ? ORDER BY number DESC LIMIT 1').get(r.id) as Row | undefined;
  let progress: number | null = null;
  if (latest) {
    const job = db.prepare("SELECT progress FROM jobs WHERE version_id = ? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1").get(latest.id) as Row | undefined;
    progress = job ? job.progress : null;
  }
  const thumb = db.prepare("SELECT id FROM assets WHERE project_id = ? AND kind = 'video' AND thumb_name IS NOT NULL AND excluded = 0 ORDER BY sort_order, created_at LIMIT 1").get(r.id) as Row | undefined;
  return {
    ...toProjectDTO(r),
    assetCount: counts.a,
    versionCount: counts.v,
    latestVersion: latest ? { id: latest.id, number: latest.number, status: latest.status, progress } : null,
    thumbUrl: thumb ? `/api/assets/${thumb.id}/thumb` : null,
  };
}

// ---------- assets ----------
export function getAssetRow(db: Db, id: string): Row {
  const row = db.prepare('SELECT * FROM assets WHERE id = ?').get(id) as Row | undefined;
  if (!row) throw notFound('Asset');
  return row;
}
export function toAssetDTO(r: Row): AssetDTO {
  return {
    id: r.id,
    projectId: r.project_id,
    kind: r.kind,
    originalName: r.original_name,
    mime: r.mime,
    sizeBytes: r.size_bytes,
    info: parseJson<MediaInfo>(r.info_json, {} as MediaInfo),
    excluded: !!r.excluded,
    sortOrder: r.sort_order,
    fileUrl: `/api/assets/${r.id}/file`,
    thumbUrl: r.thumb_name ? `/api/assets/${r.id}/thumb` : null,
    createdAt: r.created_at,
  };
}
export const listAssetRows = (db: Db, projectId: string) =>
  db.prepare('SELECT * FROM assets WHERE project_id = ? ORDER BY sort_order, created_at').all(projectId) as Row[];

// ---------- jobs / versions ----------
export function toJobDTO(r: Row): JobDTO {
  return {
    id: r.id,
    status: r.status,
    stage: r.stage ?? null,
    progress: r.progress,
    message: r.message ?? null,
    attempt: r.attempt,
    maxAttempts: r.max_attempts,
    error: r.error ?? null,
  };
}
export function latestJobFor(db: Db, versionId: string): Row | undefined {
  return db.prepare('SELECT * FROM jobs WHERE version_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(versionId) as Row | undefined;
}

export function getVersionRow(db: Db, id: string): Row {
  const row = db.prepare('SELECT * FROM versions WHERE id = ?').get(id) as Row | undefined;
  if (!row) throw notFound('Version');
  return row;
}

export function toVersionDTO(db: Db, r: Row): VersionDTO {
  const caption = parseJson<Caption | null>(r.caption_json, null);
  const job = latestJobFor(db, r.id);
  const hasOutput = !!r.output_name && ['ready', 'approved', 'superseded'].includes(r.status);
  return {
    id: r.id,
    projectId: r.project_id,
    number: r.number,
    parentVersionId: r.parent_version_id ?? null,
    instruction: r.instruction,
    isRevision: !!r.is_revision,
    status: r.status,
    plan: parseJson<EditPlan | null>(r.plan_json, null),
    planSource: r.plan_source ?? null,
    planRationale: r.plan_rationale ?? null,
    planNotes: parseJson<string[]>(r.plan_notes_json, []),
    caption,
    captionText: caption ? captionToText(caption) : null,
    captionStatus: r.caption_status,
    captionNote: r.caption_note ?? null,
    quality: parseJson<QualityReport | null>(r.quality_json, null),
    output: hasOutput
      ? {
          url: `/api/versions/${r.id}/video`,
          downloadUrl: `/api/versions/${r.id}/video?download=1`,
          sizeBytes: r.output_size,
          durationMs: r.output_duration_ms,
          width: r.output_width,
          height: r.output_height,
        }
      : null,
    warnings: parseJson<string[]>(r.warnings_json, []),
    error: r.error ?? null,
    approved: r.status === 'approved',
    exportPath: r.export_dir ?? null,
    createdAt: r.created_at,
    finishedAt: r.finished_at ?? null,
    approvedAt: r.approved_at ?? null,
    job: job ? toJobDTO(job) : null,
  };
}

export function dirSize(dir: string): number {
  let total = 0;
  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        try {
          total += fs.statSync(p).size;
        } catch { /* file vanished */ }
      }
    }
  };
  walk(dir);
  return total;
}
