/**
 * Deterministic "Basic auto-edit" planner. No LLM, no network. Used when there is no API key or the AI
 * failed and the caller allowed the fallback. It does NOT interpret the brief (except extracting
 * explicitly quoted title text and flagging unsupported requests).
 */
import {
  EditPlanSchema,
  MAX_OUTPUT_DURATION_MS,
  MAX_SEGMENTS,
  planDurationMs,
  type EditPlan,
  type Segment,
  type StylePreset,
  type Transition,
} from '../../../shared/editPlan.js';
import { detectLimitations } from './limitations.js';
import { sanitizePlan } from './sanitize.js';
import { cleanUserLines, evenCues } from './subtitles.js';
import { AiOutputError, type AssetBrief, type PlanEditInput, type PlanEditResult } from './types.js';

interface PresetDefaults {
  label: string;
  targetMs: number;
  perClipMs: number;
  transition: Transition;
  look: EditPlan['look']['preset'];
  vignette: boolean;
  fadeInMs: number;
  fadeOutMs: number;
  titleSize: 'small' | 'medium' | 'large';
  titlePosition: 'top' | 'center' | 'bottom' | 'lower-third';
}

const PRESETS: Record<StylePreset, PresetDefaults> = {
  'calm-cinematic': { label: 'Calm cinematic', targetMs: 30_000, perClipMs: 6_000, transition: { type: 'crossfade', durationMs: 600 }, look: 'cinematic', vignette: true, fadeInMs: 800, fadeOutMs: 1000, titleSize: 'medium', titlePosition: 'center' },
  'day-in-the-life': { label: 'Day in the life', targetMs: 30_000, perClipMs: 3_500, transition: { type: 'cut', durationMs: 500 }, look: 'warm', vignette: false, fadeInMs: 300, fadeOutMs: 500, titleSize: 'medium', titlePosition: 'lower-third' },
  motivation: { label: 'Motivation', targetMs: 25_000, perClipMs: 2_500, transition: { type: 'cut', durationMs: 500 }, look: 'cinematic', vignette: true, fadeInMs: 200, fadeOutMs: 500, titleSize: 'large', titlePosition: 'center' },
  storytelling: { label: 'Storytelling', targetMs: 40_000, perClipMs: 5_000, transition: { type: 'crossfade', durationMs: 400 }, look: 'natural', vignette: false, fadeInMs: 500, fadeOutMs: 800, titleSize: 'small', titlePosition: 'lower-third' },
  custom: { label: 'Custom', targetMs: 30_000, perClipMs: 4_000, transition: { type: 'cut', durationMs: 500 }, look: 'natural', vignette: false, fadeInMs: 300, fadeOutMs: 500, titleSize: 'medium', titlePosition: 'center' },
};

const MIN_SEG_MS = 1_200;
const REELS_MIN_MS = 15_000;
const REELS_MAX_MS = 45_000;
/** keep the number of segments reasonable even for very long footage */
const MAX_RULES_SEGMENTS = 12;
/** a clip is only split into several excerpts if they fill at most this share of it */
const SPLIT_FILL_RATIO = 0.7;
/** longest single shot the rules planner will use when footage is scarce */
const STRETCH_CLIP_MS = 10_000;

interface Slot {
  asset: AssetBrief;
  maxLen: number;
  start: number;
  len: number;
}

/** First straight- or curly-double-quoted text in the brief (explicit title text). */
export function extractQuotedTitle(brief: string): string | undefined {
  const m = /["“”„«]\s*([^"“”„«»]{2,90}?)\s*["“”»]/.exec(brief);
  const t = m?.[1]?.replace(/\s+/g, ' ').trim();
  return t && t.length >= 2 ? t : undefined;
}

export function planWithRules(input: PlanEditInput, extraNotes: string[] = []): PlanEditResult {
  const p = PRESETS[input.preset] ?? PRESETS.custom;
  const notes: string[] = [
    'Basic auto-edit (no AI): no AI interpreted your brief. The clips are arranged by rules only, using the "' + p.label + '" preset defaults.',
    ...extraNotes,
  ];
  const clips = input.assets.filter((a) => a.kind === 'video' && a.durationMs >= 500);
  if (clips.length === 0) throw new AiOutputError('There are no usable video clips (at least 0.5 s long) to build an edit from.');

  const transMs = p.transition.type === 'cut' ? 0 : p.transition.durationMs;
  const maxClips = Math.max(1, Math.min(MAX_RULES_SEGMENTS, Math.floor(p.targetMs / MIN_SEG_MS)));
  const used = clips.slice(0, maxClips);
  if (used.length < clips.length) {
    notes.push(`Only the first ${used.length} of ${clips.length} clips were used so each shot lasts long enough to be seen.`);
  }

  // How many excerpts per clip so that the total can reach the target (only long clips are split, leaving gaps).
  const k = used.map(() => 1);
  let limit = p.perClipMs;
  const perExcerptMax = (i: number) => Math.min(limit, Math.floor(used[i]!.durationMs / k[i]!));
  const capacity = () => used.reduce((sum, _a, i) => sum + k[i]! * perExcerptMax(i), 0);
  const segCount = () => k.reduce((a, b) => a + b, 0);
  const net = () => capacity() - Math.max(0, segCount() - 1) * transMs;
  let guard = 0;
  while (net() < p.targetMs && segCount() < MAX_RULES_SEGMENTS && guard++ < 100) {
    let best = -1;
    let bestGain = 0;
    used.forEach((a, i) => {
      const next = k[i]! + 1;
      if (next * limit > a.durationMs * SPLIT_FILL_RATIO) return; // not enough footage to split without just re-cutting the same shot
      const gain = next * limit - k[i]! * perExcerptMax(i);
      if (gain > bestGain) {
        bestGain = gain;
        best = i;
      }
    });
    if (best < 0 || bestGain <= transMs) break;
    k[best]!++;
  }
  if (net() < p.targetMs) {
    // Footage is scarce: let each shot run longer than the preset's preferred length rather than ending far below 15s.
    limit = STRETCH_CLIP_MS;
  }

  const gross = Math.min(p.targetMs, REELS_MAX_MS) + Math.max(0, segCount() - 1) * transMs;
  const factor = Math.min(1, gross / Math.max(1, capacity()));

  const slots: Slot[] = [];
  used.forEach((asset, i) => {
    const n = k[i]!;
    const maxLen = perExcerptMax(i);
    const len = Math.min(maxLen, Math.max(Math.min(MIN_SEG_MS, maxLen), Math.round(maxLen * factor)));
    for (let j = 0; j < n; j++) {
      const room = asset.durationMs - len;
      // single excerpt: start a little into the clip (the very first frames are often unstable); several: spread evenly
      const start = n === 1 ? Math.floor(room * 0.25) : Math.floor((room * j) / (n - 1));
      slots.push({ asset, maxLen, start, len });
    }
  });

  const segments: Segment[] = slots.slice(0, MAX_SEGMENTS).map((s, idx) => {
    const landscape = s.asset.width > s.asset.height;
    return {
      id: `s${idx + 1}`,
      assetId: s.asset.id,
      startMs: s.start,
      endMs: s.start + s.len,
      speed: 1,
      fit: landscape ? 'contain-blur' : 'cover',
      focus: { x: 0.5, y: 0.5 },
      audio: s.asset.hasAudio ? 'keep' : 'mute',
      volume: 1,
      transitionIn: idx === 0 ? { type: 'cut', durationMs: 500 } : { ...p.transition },
    };
  });
  if (segments.some((s) => s.fit === 'contain-blur')) {
    notes.push('Landscape clips are shown whole over a blurred background (contain-blur) instead of being cropped.');
  }

  const base = EditPlanSchema.parse({
    version: 1,
    format: '9:16',
    fps: 30,
    summary: '',
    segments,
    titles: [],
    look: { preset: p.look, vignette: p.vignette, fadeInMs: p.fadeInMs, fadeOutMs: p.fadeOutMs },
    audio: { normalizeLoudness: true },
    limitations: [],
  });
  const totalMs = planDurationMs(base);
  if (totalMs < REELS_MIN_MS) {
    notes.push(`The finished video is about ${(totalMs / 1000).toFixed(1)}s: your footage is shorter than the usual 15-45 s Reels range and cannot be stretched without inventing material.`);
  }

  // Title only from explicit quoted text in the brief.
  const quoted = extractQuotedTitle(input.brief);
  const titles: EditPlan['titles'] = [];
  if (quoted) {
    titles.push({
      id: 't1',
      text: quoted,
      startMs: Math.min(500, Math.max(0, totalMs - 1_000)),
      endMs: Math.min(totalMs, Math.max(2_500, Math.min(4_000, totalMs))),
      position: p.titlePosition,
      size: p.titleSize,
    });
    notes.push('Title text was taken from the text you put in quotes in your brief.');
  }

  // Subtitles only from the owner's own lines.
  const lines = cleanUserLines(input.userSubtitleLines);
  let subtitles: EditPlan['subtitles'];
  if (lines.length > 0) {
    subtitles = { source: 'user-provided', position: 'bottom', cues: evenCues(lines, totalMs) };
    notes.push('Your subtitle lines were spread evenly over the video. Timings are not synced to speech; adjust them if needed.');
  }

  const requestText = [input.brief, input.revisionRequest ?? ''].join('\n');
  const limitations = detectLimitations(requestText, input.assets);
  const hasBrief = input.brief.trim().length > 0 || Boolean(input.revisionRequest?.trim());
  if (hasBrief) {
    limitations.unshift('Your written instructions were not interpreted (no AI was used). Only the style preset, clip order and any quoted title text were applied.');
  }
  if (input.previousPlan || input.revisionRequest) {
    notes.push('This is a revision request, but the Basic auto-edit cannot apply changes you describe; it rebuilt the default edit.');
  }

  const oneClip = used.length;
  const draft = EditPlanSchema.parse({
    ...base,
    summary: `Basic auto-edit (no AI): ${oneClip} clip${oneClip === 1 ? '' : 's'} in your order, ${p.label.toLowerCase()} pacing, about ${Math.round(totalMs / 1000)}s.`,
    titles,
    subtitles,
    limitations,
  });

  // Same final safety net as the AI path.
  const sanitized = sanitizePlan(draft, { assets: input.assets, brief: input.brief, ...(input.revisionRequest ? { revisionRequest: input.revisionRequest } : {}), ...(input.userSubtitleLines ? { userSubtitleLines: input.userSubtitleLines } : {}) });
  const finalMs = planDurationMs(sanitized.plan);
  if (finalMs > MAX_OUTPUT_DURATION_MS) throw new AiOutputError('Basic auto-edit exceeded the maximum duration.');
  return {
    plan: sanitized.plan,
    rationale: `This is a Basic auto-edit (no AI): your clips were placed in the order you gave them using the "${p.label}" preset (${p.look} look, ${p.transition.type === 'cut' ? 'hard cuts' : `${p.transition.type} transitions`}, fade in/out, loudness normalised). It cannot read your brief or see the footage, so trim points are chosen by clip length only.`,
    source: 'rules',
    notes: [...notes, ...sanitized.notes.filter((n) => !notes.includes(n))],
  };
}
