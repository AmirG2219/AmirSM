/** Reference ("inspiration") videos: measure their pacing locally and, when Claude is available, describe their style from sampled stills. */
import type { AppContext } from './context.js';
import { now, parseJson, type Row } from './db/index.js';
import { REFERENCE_ANALYZER_VERSION, paceLabel, type ReferencePace, type ReferenceProfile, type TechnicalProfile } from '../../shared/analysis.js';
import type { MediaInfo } from '../../shared/domain.js';
import { assetFilePath, listAssetRows } from './repo.js';

export function paceFrom(durationMs: number, t: TechnicalProfile): ReferencePace {
  const span = Math.max(1, t.analyzedMs || durationMs);
  const cuts = t.sceneChangesMs.length;
  const avg = span >= 2000 ? span / (cuts + 1) : null;
  const mean = (f: (w: TechnicalProfile['windows'][number]) => number) => (t.windows.length ? t.windows.reduce((n, w) => n + f(w), 0) / t.windows.length : null);
  return {
    durationMs,
    cuts,
    avgShotMs: avg === null ? null : Math.round(avg),
    cutsPerMinute: Math.round((cuts / (span / 60_000)) * 10) / 10,
    label: paceLabel(avg),
    brightness: mean((w) => w.brightness),
    contrast: mean((w) => w.contrast),
    motion: mean((w) => w.motion),
  };
}

export function getReferenceProfile(ctx: AppContext, assetId: string): ReferenceProfile | null {
  const r = ctx.db.prepare('SELECT result_json, analyzer_version FROM reference_profiles WHERE asset_id = ?').get(assetId) as Row | undefined;
  if (!r || r.analyzer_version !== REFERENCE_ANALYZER_VERSION) return null;
  return parseJson<ReferenceProfile | null>(r.result_json, null);
}

export function loadReferenceProfiles(ctx: AppContext, projectId: string): ReferenceProfile[] {
  return listAssetRows(ctx.db, projectId, 'reference')
    .filter((a) => !a.excluded)
    .map((a) => getReferenceProfile(ctx, a.id))
    .filter((p): p is ReferenceProfile => !!p);
}

/** Measure (always) and describe (if the API is available) one reference video; cached per asset. Never throws for AI problems. */
export async function ensureReferenceProfile(ctx: AppContext, asset: Row, opts: { signal?: AbortSignal } = {}): Promise<{ profile: ReferenceProfile | null; note?: string }> {
  const cached = getReferenceProfile(ctx, asset.id);
  // a profile measured while the AI was off is upgraded when the AI becomes available
  if (cached && (cached.visual || !ctx.ai.status().configured)) return { profile: cached };

  const file = assetFilePath(ctx.config, asset);
  const info = parseJson<MediaInfo>(asset.info_json, {} as MediaInfo);
  let pace: ReferencePace;
  try {
    pace = cached?.pace ?? paceFrom(info.durationMs, await ctx.video.technicalProfile(file, info, { signal: opts.signal }));
  } catch (e) {
    return { profile: null, note: `Could not measure the reference video: ${(e as Error).message}` };
  }
  let profile: ReferenceProfile = { assetId: asset.id, name: asset.original_name, analyzerVersion: REFERENCE_ANALYZER_VERSION, pace, framesUsed: 0, createdAt: now() };
  let note: string | undefined;
  if (ctx.ai.status().configured) {
    try {
      const frames = await ctx.video.sampleFrames(file, info, { count: info.durationMs > 20_000 ? 8 : 6, signal: opts.signal });
      const res = await ctx.ai.analyzeReference({ projectId: asset.project_id, assetId: asset.id, name: asset.original_name, durationMs: info.durationMs, frames });
      profile = { ...profile, visual: res.visual, framesUsed: frames.length, model: res.model };
    } catch (e) {
      note = `Only the pacing of "${asset.original_name}" was measured; the visual analysis failed: ${(e as Error).message}`;
    }
  } else {
    note = `Only the pacing of "${asset.original_name}" was measured (no AI key, so its look was not analysed).`;
  }
  ctx.db
    .prepare('INSERT INTO reference_profiles (asset_id, analyzer_version, result_json, created_at) VALUES (?,?,?,?) ON CONFLICT(asset_id) DO UPDATE SET analyzer_version = excluded.analyzer_version, result_json = excluded.result_json, created_at = excluded.created_at')
    .run(asset.id, REFERENCE_ANALYZER_VERSION, JSON.stringify(profile), now());
  return { profile, note };
}
