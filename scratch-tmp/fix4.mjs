import fs from 'node:fs';
let w = fs.readFileSync('server/src/ai/window-select.ts','utf8');
w = w.replace(`    .map((s) => ({ startMs: s, endMs: s + len, ...rangeScore(p, s, s + len, pref) }));`, `    .map((s) => {
      const r = rangeScore(p, s, s + len, pref);
      // tie-break only: among equally good ranges prefer one that starts a little into the clip (first frames are often unsettled)
      const room = Math.max(1, limit - len);
      return { startMs: s, endMs: s + len, issues: r.issues, score: r.score - 0.01 * (Math.abs(s - 0.2 * room) / room) };
    });`);
fs.writeFileSync('server/src/ai/window-select.ts', w);

let t = fs.readFileSync('server/src/ai/types.ts','utf8');
t = t.replace("import type { Caption, QualityReport, Role } from '../../../shared/domain.js';", "import type { Caption, MediaInfo, QualityReport, Role } from '../../../shared/domain.js';\nimport type { ClipAnalysis, SampledFrame } from '../../../shared/analysis.js';");
t = t.replace("  userSubtitleLines?: string[];\n}\nexport interface PlanEditResult", `  userSubtitleLines?: string[];
  /**
   * What is known about the clips (one entry per asset and source). 'visual' = Claude looked at sampled stills;
   * 'technical' = local signal measurements only. Both are optional; absent = nothing is known.
   */
  clipAnalyses?: ClipAnalysis[];
}
export interface PlanEditResult`);
t = t.replace("  feedback?: string; // revision feedback\n}", "  feedback?: string; // revision feedback\n  /** same as PlanEditInput.clipAnalyses; only 'visual' entries count as things that were seen */\n  clipAnalyses?: ClipAnalysis[];\n}");
t = t.replace("export interface UsageRecord {", `export interface ClipToAnalyze {
  assetId: string;
  name: string;
  durationMs: number;
  /** only needed when the model should be given pictures: used by analyzeClips to size the frame budget */
  info?: Pick<MediaInfo, 'displayWidth' | 'displayHeight'>;
}

/** Persistence of finished analyses (implemented over SQLite in analysis-store.ts; injected so tests need no DB). */
export interface ClipAnalysisCache {
  get(assetId: string, kind: 'visual' | 'technical', analyzerVersion: string): ClipAnalysis | null;
  put(a: ClipAnalysis): void;
}

export interface AnalyzeClipsInput {
  projectId: string;
  clips: ClipToAnalyze[];
  /** called only for clips that are NOT already cached; must return evenly spaced stills (see video.sampleFrames) */
  getFrames: (clip: ClipToAnalyze) => Promise<SampledFrame[]>;
  cache?: ClipAnalysisCache;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, message: string) => void;
}
export interface AnalyzeClipsResult {
  /** visual analyses for the requested clips (fresh + cached) */
  analyses: ClipAnalysis[];
  fromCache: number;
  /** clips that were not analysed, each with a human-readable reason */
  skipped: { assetId: string; reason: string }[];
  /** model calls actually made */
  calls: number;
  /** stills sent to the model in this run (cache hits send none) */
  framesSent: number;
  /** estimated input tokens of the calls made (images + text) */
  estimatedInputTokens: number;
  notes: string[];
}

export interface UsageRecord {`);
t = t.replace("  reviewQuality(input: ReviewInput): Promise<QualityReport>;", `  reviewQuality(input: ReviewInput): Promise<QualityReport>;

  /**
   * Visual clip analysis: Claude looks at a few sampled stills per clip and describes only what is visible.
   * Never throws for limits/unavailability/bad output: those clips come back in \`skipped\` with a reason.
   */
  analyzeClips(input: AnalyzeClipsInput): Promise<AnalyzeClipsResult>;`);
fs.writeFileSync('server/src/ai/types.ts', t);
