/**
 * Clip analysis contracts (shared by the video layer, the AI layer, the orchestrator and the web app).
 *
 * Two very different kinds of knowledge, which must never be confused:
 *  - source "technical": computed locally by FFmpeg signal measurements (exposure, focus proxy, camera steadiness,
 *    scene cuts, audio level). No AI. It says NOTHING about what is in the footage.
 *  - source "visual": Claude looked at a handful of SAMPLED FRAMES (stills, no audio, not the full video) and
 *    described only what is visible in them.
 */
import { z } from 'zod';

/** Bump when the measurement method changes; cached results with another version are recomputed. */
export const TECH_ANALYZER_VERSION = 'tech-1';
/** Bump when the vision prompt/sampling changes materially; cached results with another version are recomputed. */
export const VISION_ANALYZER_VERSION = 'vision-1';

export const ANALYSIS_KINDS = ['visual', 'technical'] as const;
export type AnalysisKind = (typeof ANALYSIS_KINDS)[number];

const ms = z.number().int().min(0).max(24 * 60 * 60 * 1000);
const unit = z.number().min(0).max(1);

// ---------------------------------------------------------------- technical (no AI)

export const TECH_ISSUE_CODES = ['too_dark', 'overexposed', 'blurry', 'shaky', 'static', 'silent_audio'] as const;
export type TechIssueCode = (typeof TECH_ISSUE_CODES)[number];

export const TECH_ISSUE_LABELS: Record<TechIssueCode, string> = {
  too_dark: 'too dark',
  overexposed: 'overexposed',
  blurry: 'blurry / out of focus (or featureless)',
  shaky: 'shaky camera',
  static: 'static (almost nothing changes)',
  silent_audio: 'audio is (near) silent',
};

export const TechnicalWindowSchema = z.object({
  startMs: ms,
  endMs: ms,
  /** mean luma 0..1 */
  brightness: unit,
  /** (p95 - p5) luma spread 0..1 */
  contrast: unit,
  /** relative focus/detail 0..1 (1 = as sharp as the sharpest part of this clip) */
  sharpness: unit,
  /** amount of change between frames 0..1 (subject + camera motion) */
  motion: unit,
  /** camera jitter 0..1 (0 = steady) */
  shake: unit,
  /** mean audio level in dBFS, null when the clip has no audio or it could not be measured */
  audioDb: z.number().nullable(),
  /** overall technical quality 0..1 (exposure + focus + steadiness). NOT about content. */
  score: unit,
  issues: z.array(z.enum(TECH_ISSUE_CODES)).default([]),
});
export type TechnicalWindow = z.infer<typeof TechnicalWindowSchema>;

export const TechnicalProfileSchema = z.object({
  analyzerVersion: z.string(),
  durationMs: ms,
  /** how much of the clip was measured (very long clips are measured up to a cap) */
  analyzedMs: ms,
  windowMs: z.number().int().positive(),
  sampleFps: z.number().positive(),
  windows: z.array(TechnicalWindowSchema),
  /** hard scene cuts found (output time of the first frame of the new scene), ascending */
  sceneChangesMs: z.array(ms),
  audio: z
    .object({
      present: z.boolean(),
      meanDb: z.number().nullable(),
      /** share of measured audio windows that are near-silent (below -50 dBFS) */
      silentRatio: unit.nullable(),
    })
    .nullable(),
  /** clip-level issues with the time ranges they were measured in */
  issues: z.array(
    z.object({
      code: z.enum(TECH_ISSUE_CODES),
      label: z.string(),
      /** share of analysed windows affected, 0..1 */
      share: unit,
      ranges: z.array(z.object({ startMs: ms, endMs: ms })).max(20),
    }),
  ),
  /** mean window score */
  score: unit,
  createdAt: z.string().optional(),
});
export type TechnicalProfile = z.infer<typeof TechnicalProfileSchema>;

// ---------------------------------------------------------------- shared clip analysis

export const MomentSchema = z.object({
  startMs: ms,
  endMs: ms,
  description: z.string(),
  /** 0..1: how usable/appealing the moment looks, judged from the sampled frames (visual) or signal quality (technical) */
  score: unit,
  issues: z.array(z.string()).default([]),
});
export type Moment = z.infer<typeof MomentSchema>;

export const ClipAnalysisSchema = z.object({
  assetId: z.string().min(1),
  source: z.enum(ANALYSIS_KINDS),
  analyzerVersion: z.string(),
  /** visual only: what is actually visible in the sampled frames */
  summary: z.string().optional(),
  tags: z.array(z.string()).default([]),
  moments: z.array(MomentSchema).default([]),
  /** visual: number of still frames sent to the model; technical: number of frames measured */
  framesUsed: z.number().int().min(0),
  model: z.string().optional(),
  createdAt: z.string().optional(),
  /** technical only: the full measurement */
  technical: TechnicalProfileSchema.optional(),
});
export type ClipAnalysis = z.infer<typeof ClipAnalysisSchema>;

/** One sampled still frame sent to the vision model. `data` is base64 (no data: prefix). */
export interface SampledFrame {
  timeMs: number;
  mediaType: 'image/jpeg';
  data: string;
  width: number;
  height: number;
  bytes: number;
}

// ---------------------------------------------------------------- per-version summary shown in the UI

export const VersionAnalysisSchema = z.object({
  /** true ONLY if Claude actually looked at sampled frames of this version's clips (fresh or cached from a real earlier run) */
  visual: z.boolean(),
  /** true if local signal measurements were used */
  technical: z.boolean(),
  /** total sampled frames behind the visual analyses used for this version */
  framesAnalyzed: z.number().int().min(0),
  clips: z.array(
    z.object({
      assetId: z.string(),
      name: z.string(),
      summary: z.string().nullable(),
      tags: z.array(z.string()),
      moments: z.array(MomentSchema),
      /** technical issues found for this clip, as plain labels */
      technicalIssues: z.array(z.string()).default([]),
    }),
  ),
  /** plain-language notes: skipped analyses, limits, fallbacks */
  notes: z.array(z.string()),
});
export type VersionAnalysis = z.infer<typeof VersionAnalysisSchema>;

/** Convert a technical profile into the common ClipAnalysis shape (top technically-strong windows as moments). */
export function technicalToClipAnalysis(assetId: string, p: TechnicalProfile): ClipAnalysis {
  const ranked = [...p.windows].sort((a, b) => b.score - a.score).slice(0, 3).sort((a, b) => a.startMs - b.startMs);
  return {
    assetId,
    source: 'technical',
    analyzerVersion: p.analyzerVersion,
    tags: [],
    moments: ranked.map((w) => ({
      startMs: w.startMs,
      endMs: w.endMs,
      description: 'Technically strong window (signal measurements only; the content is unknown)',
      score: w.score,
      issues: w.issues.map((c) => TECH_ISSUE_LABELS[c]),
    })),
    framesUsed: Math.round((p.analyzedMs / 1000) * p.sampleFps),
    createdAt: p.createdAt,
    technical: p,
  };
}

// ---------------------------------------------------------------- reference ("inspiration") videos

export const REFERENCE_ANALYZER_VERSION = 'ref-1';

export const PACE_LABELS = ['very slow', 'slow', 'medium', 'fast', 'very fast'] as const;
export type PaceLabel = (typeof PACE_LABELS)[number];

/** Measured locally from the reference video (no AI). */
export const ReferencePaceSchema = z.object({
  durationMs: ms,
  cuts: z.number().int().min(0),
  /** average shot length (ms), null when too short to measure */
  avgShotMs: z.number().nullable(),
  cutsPerMinute: z.number().min(0),
  label: z.enum(PACE_LABELS),
  brightness: unit.nullable(),
  contrast: unit.nullable(),
  motion: unit.nullable(),
});
export type ReferencePace = z.infer<typeof ReferencePaceSchema>;

/** What Claude saw in a handful of sampled stills of the reference. Describes style only. */
export const ReferenceVisualSchema = z.object({
  summary: z.string(),
  mood: z.string(),
  look: z.string(),
  framing: z.string(),
  techniques: z.array(z.string()).default([]),
  textOnScreen: z.array(z.string()).default([]),
  transitions: z.array(z.string()).default([]),
});
export type ReferenceVisual = z.infer<typeof ReferenceVisualSchema>;

export const ReferenceProfileSchema = z.object({
  assetId: z.string(),
  name: z.string(),
  analyzerVersion: z.string(),
  pace: ReferencePaceSchema,
  visual: ReferenceVisualSchema.optional(),
  framesUsed: z.number().int().min(0),
  model: z.string().optional(),
  createdAt: z.string().optional(),
});
export type ReferenceProfile = z.infer<typeof ReferenceProfileSchema>;

export function paceLabel(avgShotMs: number | null): PaceLabel {
  if (avgShotMs === null) return 'medium';
  if (avgShotMs < 1200) return 'very fast';
  if (avgShotMs < 2200) return 'fast';
  if (avgShotMs < 4000) return 'medium';
  if (avgShotMs < 7000) return 'slow';
  return 'very slow';
}

/** Plain-language style brief handed to the planner/director. Visual parts only when Claude really looked. */
export function referenceStyleText(profiles: ReferenceProfile[]): string {
  return profiles
    .map((p) => {
      const lines = [
        `Reference "${p.name}" (${(p.pace.durationMs / 1000).toFixed(0)} s): measured pacing is ${p.pace.label}` +
          (p.pace.avgShotMs ? ` (about ${(p.pace.avgShotMs / 1000).toFixed(1)} s per shot, ${p.pace.cuts} hard cuts)` : '') +
          '.',
      ];
      if (p.visual) {
        lines.push(`Seen in sampled stills: ${p.visual.summary} Mood: ${p.visual.mood}. Look: ${p.visual.look}. Framing: ${p.visual.framing}.`);
        if (p.visual.techniques.length) lines.push(`Techniques: ${p.visual.techniques.join('; ')}.`);
        if (p.visual.textOnScreen.length) lines.push(`On-screen text style: ${p.visual.textOnScreen.join(' | ')}.`);
        if (p.visual.transitions.length) lines.push(`Transitions: ${p.visual.transitions.join('; ')}.`);
      } else {
        lines.push('Only the pacing was measured; its look and content were not analysed.');
      }
      return lines.join(' ');
    })
    .join('\n');
}
