import { edit } from './edit.mjs';
edit('server/src/repo.ts', [
  ["import type { AssetDTO, JobDTO, ProjectDTO, ProjectSummary, VersionDTO } from '../../shared/api.js';", "import type { AssetAnalysisDTO, AssetDTO, JobDTO, ProjectDTO, ProjectSummary, VersionDTO } from '../../shared/api.js';\nimport { VersionAnalysisSchema, type VersionAnalysis } from '../../shared/analysis.js';\nimport { createAnalysisStore } from './analysis-store.js';"],
  ["export function toVersionDTO(db: Db, r: Row): VersionDTO {", `/** Per-clip knowledge for the UI (optional; the caller attaches it to AssetDTOs): assetId -> summary of what is known. */
export function assetAnalysisSummaries(db: Db, assetIds: string[]): Map<string, AssetAnalysisDTO> {
  const out = new Map<string, AssetAnalysisDTO>();
  for (const a of createAnalysisStore(db).forAssets(assetIds)) {
    const cur = out.get(a.assetId) ?? { technical: null, visual: null };
    if (a.source === 'technical' && a.technical) {
      cur.technical = { score: a.technical.score, issues: a.technical.issues.map((i) => i.label) };
    } else if (a.source === 'visual') {
      cur.visual = { summary: a.summary ?? null, tags: a.tags };
    }
    out.set(a.assetId, cur);
  }
  return out;
}

export function parseVersionAnalysis(json: string | null | undefined): VersionAnalysis | null {
  const raw = parseJson<unknown>(json, null);
  if (!raw) return null;
  const parsed = VersionAnalysisSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function toVersionDTO(db: Db, r: Row): VersionDTO {`],
  ["    warnings: parseJson<string[]>(r.warnings_json, []),\n    error: r.error ?? null,", "    warnings: parseJson<string[]>(r.warnings_json, []),\n    analysis: parseVersionAnalysis(r.analysis_json),\n    error: r.error ?? null,"],
]);
