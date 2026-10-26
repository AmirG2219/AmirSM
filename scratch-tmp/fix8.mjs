import { edit } from './edit.mjs';
edit('server/src/video/types.ts', [
  ["import type { MediaInfo, QualityReport } from '../../../shared/domain.js';", "import type { MediaInfo, QualityReport } from '../../../shared/domain.js';\nimport type { SampledFrame, TechnicalProfile } from '../../../shared/analysis.js';"],
  ["  /** Deterministic export checks", `  /** Local signal measurements of a clip (exposure, focus proxy, steadiness, scene cuts, audio level). No AI. */
  technicalProfile(filePath: string, info: MediaInfo, opts?: { signal?: AbortSignal }): Promise<TechnicalProfile>;
  /** Evenly spread JPEG stills of a clip (long edge <= 768 px) for the vision model. */
  sampleFrames(filePath: string, info: MediaInfo, opts?: { count?: number; longEdge?: number; signal?: AbortSignal }): Promise<SampledFrame[]>;
  /** Deterministic export checks`],
]);
edit('server/src/video/index.ts', [
  ["import { FontLibrary } from './fonts.js';", "import { FontLibrary } from './fonts.js';\nimport { technicalProfile } from './analysis.js';\nimport { sampleFrames } from './frames.js';"],
  ["export { buildTimeline } from './timeline.js';", "export { buildTimeline } from './timeline.js';\nexport { technicalProfile, AnalysisError } from './analysis.js';\nexport { sampleFrames, frameTimestamps, jpegSize } from './frames.js';"],
  ["    verifyOutput(outPath: string, plan: EditPlan): Promise<QualityReport> {", `    technicalProfile(filePath, info, o) {
      return technicalProfile(ffmpegPath, filePath, info, o);
    },

    sampleFrames(filePath, info, o) {
      return sampleFrames(ffmpegPath, filePath, info, o);
    },

    verifyOutput(outPath: string, plan: EditPlan): Promise<QualityReport> {`],
]);
