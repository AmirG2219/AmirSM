/** Semantic validation of an EditPlan against the real assets. Never throws for bad plans. */
import { MAX_OUTPUT_DURATION_MS, MAX_SEGMENTS, OUTPUT_FORMATS, planDurationMs, type EditPlan } from '../../../shared/editPlan.js';
import type { PlanAsset } from './types.js';
import { buildTimeline, transitionProblems } from './timeline.js';

/** how far past the end of a source clip a segment may reach (container durations are rarely exact) */
export const SOURCE_TOLERANCE_MS = 50;

export interface ValidateOptions {
  /** false = no usable font on this machine; titles/subtitles cannot be drawn */
  fontAvailable?: boolean;
}

export function validatePlan(plan: EditPlan, assets: Map<string, PlanAsset>, opts: ValidateOptions = {}): { ok: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const err = (m: string) => errors.push(m);
  const warn = (m: string) => warnings.push(m);

  if (!plan || !Array.isArray(plan.segments) || plan.segments.length === 0) {
    return { ok: false, errors: ['The plan has no segments'], warnings };
  }
  if (plan.segments.length > MAX_SEGMENTS) err(`Too many segments (${plan.segments.length}, max ${MAX_SEGMENTS})`);
  if (!(plan.format in OUTPUT_FORMATS)) {
    err(`Unknown output format "${String(plan.format)}"`);
    return { ok: false, errors, warnings };
  }
  if (![24, 25, 30].includes(plan.fps)) err(`Unsupported frame rate ${String(plan.fps)}`);

  const seen = new Set<string>();
  let timelineSane = true;
  plan.segments.forEach((s, i) => {
    const n = i + 1;
    const where = `Segment ${n}`;
    if (seen.has(s.id)) err(`${where}: duplicate segment id "${s.id}"`);
    seen.add(s.id);
    if (!(Number.isFinite(s.speed) && s.speed > 0) || !Number.isFinite(s.startMs) || !Number.isFinite(s.endMs) || !(s.endMs > s.startMs)) timelineSane = false;
    const a = assets.get(s.assetId);
    if (!a) {
      err(`${where}: asset "${s.assetId}" was not found`);
      return;
    }
    if (a.kind !== 'video' || !a.info.hasVideo) {
      err(`${where}: asset "${s.assetId}" is not a video`);
      return;
    }
    if (!Number.isFinite(s.startMs) || !Number.isFinite(s.endMs) || !(s.startMs >= 0)) err(`${where}: invalid start/end time`);
    else if (!(s.endMs > s.startMs)) err(`${where}: end (${s.endMs} ms) must be after start (${s.startMs} ms)`);
    else if (s.endMs > a.info.durationMs + SOURCE_TOLERANCE_MS) err(`${where}: range ${s.startMs}-${s.endMs} ms runs past the end of the clip (${a.info.durationMs} ms)`);
    else if (s.endMs > a.info.durationMs) warn(`${where}: ends ${s.endMs - a.info.durationMs} ms past the clip end; the last frame will be held`);
    if (!(s.speed >= 0.5 && s.speed <= 2)) err(`${where}: speed ${String(s.speed)} is outside 0.5-2`);
    if (!(s.volume >= 0 && s.volume <= 2)) err(`${where}: volume ${String(s.volume)} is outside 0-2`);
    if (s.endMs > s.startMs && (s.endMs - s.startMs) / s.speed < 400) warn(`${where}: very short (${Math.round((s.endMs - s.startMs) / s.speed)} ms)`);
    const target = OUTPUT_FORMATS[plan.format];
    if (a.info.displayWidth > 0 && (a.info.displayWidth < target.width / 2 || a.info.displayHeight < target.height / 2) && s.fit === 'cover') {
      warn(`${where}: source is ${a.info.displayWidth}x${a.info.displayHeight}, much smaller than the ${target.width}x${target.height} output; it will look soft`);
    }
    if (s.audio === 'keep' && !a.info.hasAudio) warn(`${where}: clip has no audio track; silence will be used`);
  });

  const music = plan.audio?.music;
  if (music) {
    const m = assets.get(music.assetId);
    if (!m) err(`Music asset "${music.assetId}" was not found`);
    else if (m.kind !== 'audio' || !m.info.hasAudio) err(`Music asset "${music.assetId}" is not an audio file`);
    else if (m.info.durationMs < 1000) err('Music track is shorter than 1 second');
  }

  // timeline
  const total = timelineSane ? planDurationMs(plan) : 0;
  if (timelineSane && total <= 0) err('The edit has no duration');
  if (total > MAX_OUTPUT_DURATION_MS) err(`The edit is ${(total / 1000).toFixed(1)} s long; the maximum is ${MAX_OUTPUT_DURATION_MS / 1000} s`);
  if (timelineSane) for (const p of transitionProblems(buildTimeline(plan))) err(p);

  if (music && total > 0) {
    const m = assets.get(music.assetId);
    if (m && m.kind === 'audio' && m.info.durationMs > 0 && m.info.durationMs < total) warn(`Music (${(m.info.durationMs / 1000).toFixed(1)} s) is shorter than the edit (${(total / 1000).toFixed(1)} s); it will loop`);
  }

  // titles + subtitles live on the OUTPUT timeline
  const ids = new Set<string>();
  for (const t of plan.titles ?? []) {
    if (ids.has(t.id)) err(`Duplicate title id "${t.id}"`);
    ids.add(t.id);
    if (!(t.endMs > t.startMs)) err(`Title "${t.id}": end must be after start`);
    else if (total > 0 && t.startMs >= total) err(`Title "${t.id}" starts at ${t.startMs} ms, after the end of the edit (${total} ms)`);
    else if (total > 0 && t.endMs > total + SOURCE_TOLERANCE_MS) warn(`Title "${t.id}" ends after the edit; it will be cut at ${total} ms`);
    if (!t.text?.trim()) err(`Title "${t.id}" has no text`);
  }
  const cues = plan.subtitles?.cues ?? [];
  cues.forEach((c, i) => {
    if (!(c.endMs > c.startMs)) err(`Subtitle cue ${i + 1}: end must be after start`);
    else if (total > 0 && c.startMs >= total) err(`Subtitle cue ${i + 1} starts at ${c.startMs} ms, after the end of the edit (${total} ms)`);
    else if (total > 0 && c.endMs > total + SOURCE_TOLERANCE_MS) warn(`Subtitle cue ${i + 1} ends after the edit; it will be cut at ${total} ms`);
    if (!c.text?.trim()) err(`Subtitle cue ${i + 1} has no text`);
  });
  if (plan.subtitles && plan.subtitles.source !== 'user-provided') err('Subtitles must be user-provided; the app never invents subtitle text');
  const sorted = [...cues].sort((a, b) => a.startMs - b.startMs);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.startMs < sorted[i - 1]!.endMs) {
      warn('Some subtitle cues overlap in time; they will be drawn on top of each other');
      break;
    }
  }
  if (opts.fontAvailable === false && ((plan.titles?.length ?? 0) > 0 || cues.length > 0)) {
    warn('No usable font file was found on this machine, so titles and subtitles cannot be drawn and will be left out of the render');
  }
  const lowTitles = (plan.titles ?? []).filter((t) => t.position === 'bottom' || t.position === 'lower-third');
  if (plan.subtitles?.position !== 'center' && cues.length > 0 && lowTitles.some((t) => cues.some((c) => c.startMs < t.endMs && c.endMs > t.startMs))) {
    warn('A bottom/lower-third title overlaps in time with bottom subtitles; they may collide');
  }

  return { ok: errors.length === 0, errors, warnings };
}
