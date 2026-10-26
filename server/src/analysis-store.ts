/** SQLite persistence for clip analyses (table clip_analyses, migration 004). */
import { ClipAnalysisSchema, type AnalysisKind, type ClipAnalysis } from '../../shared/analysis.js';
import type { Db, Row } from './db/index.js';
import { now } from './db/index.js';
import type { ClipAnalysisCache } from './ai/types.js';

export interface AnalysisStore extends ClipAnalysisCache {
  /** every stored analysis (any version) for these assets, for display; invalid rows are skipped */
  forAssets(assetIds: string[]): ClipAnalysis[];
  delete(assetId: string): void;
}

export function createAnalysisStore(db: Db): AnalysisStore {
  return {
    /** Returns the row only if it was produced by exactly this analyzer version. */
    get(assetId: string, kind: AnalysisKind, analyzerVersion: string): ClipAnalysis | null {
      const r = db.prepare('SELECT analyzer_version, result_json FROM clip_analyses WHERE asset_id = ? AND kind = ?').get(assetId, kind) as Row | undefined;
      if (!r || r.analyzer_version !== analyzerVersion) return null;
      try {
        const parsed = ClipAnalysisSchema.safeParse(JSON.parse(r.result_json));
        return parsed.success && parsed.data.assetId === assetId && parsed.data.source === kind ? parsed.data : null;
      } catch {
        return null;
      }
    },
    put(a: ClipAnalysis): void {
      db.prepare(
        `INSERT INTO clip_analyses (asset_id, kind, analyzer_version, result_json, created_at) VALUES (?,?,?,?,?)
         ON CONFLICT(asset_id, kind) DO UPDATE SET analyzer_version = excluded.analyzer_version, result_json = excluded.result_json, created_at = excluded.created_at`,
      ).run(a.assetId, a.source, a.analyzerVersion, JSON.stringify(a), a.createdAt ?? now());
    },
    forAssets(assetIds: string[]): ClipAnalysis[] {
      if (assetIds.length === 0) return [];
      const out: ClipAnalysis[] = [];
      const stmt = db.prepare('SELECT result_json FROM clip_analyses WHERE asset_id = ?');
      for (const id of assetIds) {
        for (const r of stmt.all(id) as Row[]) {
          try {
            const parsed = ClipAnalysisSchema.safeParse(JSON.parse(r.result_json));
            if (parsed.success) out.push(parsed.data);
          } catch {
            /* skip unreadable row */
          }
        }
      }
      return out;
    },
    delete(assetId: string): void {
      db.prepare('DELETE FROM clip_analyses WHERE asset_id = ?').run(assetId);
    },
  };
}
