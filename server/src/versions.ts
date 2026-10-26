/** Creating a draft/revision and queueing its production job (shared by the REST route and the Studio chat). */
import type { AppContext } from './context.js';
import { newId, now, tx, type Row } from './db/index.js';
import { badRequest, conflict } from './http.js';
import { getProjectRow, getVersionRow, listAssetRows } from './repo.js';
import { recalcProjectStatus } from './orchestrator.js';

export const ACTIVE_STATUSES = ['queued', 'planning', 'rendering', 'captioning'];

export function hasActiveVersion(ctx: AppContext, projectId: string): boolean {
  return !!ctx.db.prepare(`SELECT 1 FROM versions WHERE project_id = ? AND status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})`).get(projectId, ...ACTIVE_STATUSES);
}

export function queueVersion(ctx: AppContext, projectId: string, opts: { instruction?: string; baseVersionId?: string; preset?: string } = {}): Row {
  const { db, jobs } = ctx;
  const project = getProjectRow(db, projectId);
  if (project.status === 'archived') throw conflict('archived', 'Unarchive the project first.');
  if (hasActiveVersion(ctx, projectId)) throw conflict('busy', 'A draft is already being produced for this project.');
  const assets = listAssetRows(db, projectId, 'footage').filter((a) => !a.excluded && a.kind === 'video');
  if (!assets.length) throw badRequest('Upload at least one video clip first.');

  const existing = db.prepare('SELECT COUNT(*) AS n FROM versions WHERE project_id = ?').get(projectId) as Row;
  const isRevision = existing.n > 0;
  let parentId: string | null = null;
  if (isRevision) {
    if (!opts.instruction || opts.instruction.length < 3) throw badRequest('Describe what to change.');
    if (!ctx.ai.status().configured) throw conflict('ai_unavailable', 'Revisions need the AI to interpret your request, and no Anthropic API key is configured. You can still edit the caption by hand.');
    if (opts.baseVersionId) {
      const base = getVersionRow(db, opts.baseVersionId);
      if (base.project_id !== projectId) throw badRequest('Base version belongs to another project.');
      parentId = base.id;
    } else {
      const last = db.prepare('SELECT id FROM versions WHERE project_id = ? AND plan_json IS NOT NULL ORDER BY number DESC LIMIT 1').get(projectId) as Row | undefined;
      parentId = last?.id ?? null;
    }
  }
  const instruction = isRevision ? opts.instruction! : opts.instruction || project.brief;
  if (!isRevision && opts.instruction && opts.instruction !== project.brief) {
    db.prepare('UPDATE projects SET brief = ? WHERE id = ?').run(opts.instruction, projectId);
  }
  if (opts.preset && opts.preset !== project.style_preset) {
    db.prepare('UPDATE projects SET style_preset = ? WHERE id = ?').run(opts.preset, projectId);
  }
  const id = newId('ver');
  tx(db, () => {
    const n = (db.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM versions WHERE project_id = ?').get(projectId) as Row).n as number;
    db.prepare('INSERT INTO versions (id, project_id, number, parent_version_id, instruction, is_revision, status, created_at) VALUES (?,?,?,?,?,?,?,?)').run(id, projectId, n, parentId, instruction, isRevision ? 1 : 0, 'queued', now());
  });
  jobs.enqueue({ type: 'produce_version', projectId, versionId: id });
  recalcProjectStatus(db, projectId);
  return getVersionRow(db, id);
}
