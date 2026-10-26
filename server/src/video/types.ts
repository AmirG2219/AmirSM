/** Contract between the orchestrator (lead) and the video engine (video agent). */
import type { EditPlan } from '../../../shared/editPlan.js';
import type { MediaInfo, QualityReport } from '../../../shared/domain.js';
import type { SampledFrame, TechnicalProfile } from '../../../shared/analysis.js';

export interface PlanAsset {
  id: string;
  path: string; // absolute path to the preserved source file (READ ONLY — never modify or overwrite)
  kind: 'video' | 'audio';
  info: MediaInfo;
}

export interface RenderRequest {
  plan: EditPlan;
  assets: Map<string, PlanAsset>;
  /** absolute path of the mp4 to produce. Write to a temp name and rename on success. */
  outPath: string;
  /** absolute scratch dir; engine may create files here and must remove them when done (success or failure) */
  workDir: string;
  onProgress?: (fraction: number, message: string) => void;
  signal?: AbortSignal;
}

export interface RenderResult {
  outPath: string;
  durationMs: number;
  sizeBytes: number;
  width: number;
  height: number;
  /** non-fatal notes, e.g. "clip 2 has no audio; silence inserted" */
  warnings: string[];
  /** the ffmpeg command line(s) used, with absolute paths of inputs redacted to asset ids (for the audit view) */
  commandSummary: string[];
}

export interface VideoEngine {
  /** ffmpeg/ffprobe binaries resolved and runnable? */
  health(): Promise<{ ok: boolean; ffmpegVersion?: string; filters: { drawtext: boolean; subtitles: boolean; xfade: boolean }; detail?: string }>;
  probe(filePath: string): Promise<MediaInfo>;
  thumbnail(srcPath: string, destJpg: string, atMs?: number): Promise<void>;
  /** Semantic validation against real assets (ids exist, ranges inside clip durations, duration cap, etc.). Never throws for bad plans. */
  validatePlan(plan: EditPlan, assets: Map<string, PlanAsset>): { ok: boolean; errors: string[]; warnings: string[] };
  /** Executes a validated plan. Rejects with RenderError on failure (message must be human-readable; stderr tail attached). */
  render(req: RenderRequest): Promise<RenderResult>;
  /** Local signal measurements of a clip (exposure, focus proxy, steadiness, scene cuts, audio level). No AI. */
  technicalProfile(filePath: string, info: MediaInfo, opts?: { signal?: AbortSignal }): Promise<TechnicalProfile>;
  /** Evenly spread JPEG stills of a clip (long edge <= 768 px) for the vision model. */
  sampleFrames(filePath: string, info: MediaInfo, opts?: { count?: number; longEdge?: number; signal?: AbortSignal }): Promise<SampledFrame[]>;
  /** Deterministic export checks on a finished file: playable, h264/aac mp4, dimensions, duration vs plan, audio present when expected. */
  verifyOutput(outPath: string, plan: EditPlan): Promise<QualityReport>;
}

export class RenderError extends Error {
  constructor(message: string, public readonly stderrTail = '', public readonly retryable = false) {
    super(message);
    this.name = 'RenderError';
  }
}
export class RenderCancelled extends Error {
  constructor() {
    super('Render cancelled');
    this.name = 'RenderCancelled';
  }
}

/**
 * Factory the video agent must export from server/src/video/index.ts:
 *   export function createVideoEngine(opts: { ffmpegPath: string; ffprobePath: string; fontFile?: string }): VideoEngine
 * Also export `resolveBinaries()` returning { ffmpegPath, ffprobePath } (ffmpeg-static / ffprobe-static, overridable by FFMPEG_PATH / FFPROBE_PATH env).
 */
