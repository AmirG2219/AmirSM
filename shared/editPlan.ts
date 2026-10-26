/**
 * EditPlan — the ONLY thing the video engine accepts.
 * The AI (or the rule-based planner) produces an EditPlan; the engine validates and executes it.
 * All times are integer milliseconds. Source times (startMs/endMs on a segment) refer to the source clip;
 * title/subtitle times refer to the OUTPUT timeline.
 */
import { z } from 'zod';

export const STYLE_PRESETS = ['day-in-the-life', 'calm-cinematic', 'motivation', 'high-energy', 'storytelling', 'custom'] as const;
export type StylePreset = (typeof STYLE_PRESETS)[number];

export const OUTPUT_FORMATS = {
  '9:16': { width: 1080, height: 1920 },
  '4:5': { width: 1080, height: 1350 },
  '1:1': { width: 1080, height: 1080 },
} as const;
export type OutputFormat = keyof typeof OUTPUT_FORMATS;

export const MAX_OUTPUT_DURATION_MS = 180_000;
export const MAX_SEGMENTS = 40;

const timeMs = z.number().int().min(0).max(6 * 60 * 60 * 1000);

export const TransitionSchema = z.object({
  type: z.enum(['cut', 'crossfade', 'dip-to-black', 'slide-left']),
  durationMs: z.number().int().min(150).max(2000).default(500),
});
export type Transition = z.infer<typeof TransitionSchema>;

export const SegmentSchema = z
  .object({
    id: z.string().min(1).max(40),
    assetId: z.string().min(1),
    startMs: timeMs,
    endMs: timeMs,
    /** playback speed; 1 = natural. Audio is pitch-corrected within 0.5–2. */
    speed: z.number().min(0.5).max(2).default(1),
    /** cover = fill frame by cropping; contain-blur = whole frame over a blurred copy of itself */
    fit: z.enum(['cover', 'contain-blur']).default('cover'),
    /** crop anchor for `cover`, 0..1 (0.5/0.5 = centre) */
    focus: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).default({ x: 0.5, y: 0.5 }),
    audio: z.enum(['keep', 'mute']).default('keep'),
    volume: z.number().min(0).max(2).default(1),
    /** how this segment enters from the previous one; ignored for the first segment */
    transitionIn: TransitionSchema.default({ type: 'cut', durationMs: 500 }),
  })
  .refine((s) => s.endMs > s.startMs, { message: 'segment endMs must be greater than startMs' });
export type Segment = z.infer<typeof SegmentSchema>;

export const TitleSchema = z
  .object({
    id: z.string().min(1).max(40),
    text: z.string().min(1).max(90),
    startMs: timeMs,
    endMs: timeMs,
    position: z.enum(['top', 'center', 'bottom', 'lower-third']).default('center'),
    size: z.enum(['small', 'medium', 'large']).default('medium'),
  })
  .refine((t) => t.endMs > t.startMs, { message: 'title endMs must be greater than startMs' });
export type Title = z.infer<typeof TitleSchema>;

/**
 * Subtitles are NEVER invented. Cues may only contain text supplied by the owner (typed in the brief
 * or edited in the UI). There is no automatic transcription in v1.
 */
export const SubtitleCueSchema = z
  .object({ startMs: timeMs, endMs: timeMs, text: z.string().min(1).max(160) })
  .refine((c) => c.endMs > c.startMs, { message: 'cue endMs must be greater than startMs' });
export const SubtitlesSchema = z.object({
  source: z.literal('user-provided'),
  position: z.enum(['bottom', 'center']).default('bottom'),
  cues: z.array(SubtitleCueSchema).max(200),
});
export type Subtitles = z.infer<typeof SubtitlesSchema>;

export const LOOK_PRESETS = ['natural', 'warm', 'cool', 'cinematic', 'bright', 'muted', 'bw'] as const;

export const EditPlanSchema = z.object({
  version: z.literal(1),
  format: z.enum(['9:16', '4:5', '1:1']).default('9:16'),
  fps: z.union([z.literal(24), z.literal(25), z.literal(30)]).default(30),
  /** One-sentence description of the intended edit, shown to the owner */
  summary: z.string().max(400).default(''),
  segments: z.array(SegmentSchema).min(1).max(MAX_SEGMENTS),
  titles: z.array(TitleSchema).max(20).default([]),
  subtitles: SubtitlesSchema.optional(),
  look: z
    .object({
      preset: z.enum(LOOK_PRESETS).default('natural'),
      vignette: z.boolean().default(false),
      fadeInMs: z.number().int().min(0).max(2000).default(0),
      fadeOutMs: z.number().int().min(0).max(2000).default(0),
    })
    .default({ preset: 'natural', vignette: false, fadeInMs: 0, fadeOutMs: 0 }),
  audio: z
    .object({
      normalizeLoudness: z.boolean().default(true),
      /** optional owner-uploaded audio asset (kind "audio"). The system never supplies music itself. */
      music: z
        .object({ assetId: z.string(), volume: z.number().min(0).max(1).default(0.25), fadeOutMs: z.number().int().min(0).max(5000).default(1000) })
        .optional(),
    })
    .default({ normalizeLoudness: true }),
  /** Things the owner asked for that cannot be done with the available tools. Must be shown in the UI. */
  limitations: z.array(z.string().max(300)).max(10).default([]),
});
export type EditPlan = z.infer<typeof EditPlanSchema>;
/** Input shape (before defaults are applied) */
export type EditPlanInput = z.input<typeof EditPlanSchema>;

/** Output-timeline duration of a plan, accounting for speed and transition overlaps. */
export function planDurationMs(plan: EditPlan): number {
  let total = 0;
  plan.segments.forEach((s, i) => {
    total += (s.endMs - s.startMs) / s.speed;
    if (i > 0 && s.transitionIn.type !== 'cut') total -= s.transitionIn.durationMs;
  });
  return Math.max(0, Math.round(total));
}

export function outputSize(format: OutputFormat) {
  return OUTPUT_FORMATS[format];
}
