/**
 * Deterministic sanitisation of an EditPlan produced by a model (or anything else).
 * Guarantees: only real video assets, source ranges inside real durations, duration/segment caps,
 * subtitles ONLY from owner-supplied lines, limitations recorded.
 */
import {
  EditPlanSchema,
  MAX_OUTPUT_DURATION_MS,
  MAX_SEGMENTS,
  planDurationMs,
  type EditPlan,
  type Segment,
} from '../../../shared/editPlan.js';
import { detectLimitations } from './limitations.js';
import { evenCues, makeTraceabilityCheck, cleanUserLines, MAX_CUES } from './subtitles.js';
import { AiOutputError, type AssetBrief } from './types.js';

const MIN_SEGMENT_SRC_MS = 200;
const MIN_TRUNCATED_OUTPUT_MS = 500;

export interface SanitizeContext {
  assets: AssetBrief[];
  brief: string;
  revisionRequest?: string;
  userSubtitleLines?: string[];
}

export interface SanitizeResult {
  plan: EditPlan;
  notes: string[];
}

const outLen = (s: Segment) => (s.endMs - s.startMs) / s.speed;

function clampTransitions(segs: Segment[]): void {
  segs.forEach((s, i) => {
    if (i === 0) {
      s.transitionIn = { type: 'cut', durationMs: 500 };
      return;
    }
    if (s.transitionIn.type === 'cut') return;
    const max = Math.floor(Math.min(outLen(segs[i - 1]!), outLen(s)) / 2);
    if (max < 150) s.transitionIn = { type: 'cut', durationMs: 500 };
    else s.transitionIn = { ...s.transitionIn, durationMs: Math.min(s.transitionIn.durationMs, max) };
  });
}

export function sanitizePlan(input: EditPlan, ctx: SanitizeContext): SanitizeResult {
  const notes: string[] = [];
  const assets = new Map(ctx.assets.map((a) => [a.id, a]));

  // ---- segments ----
  let unknown = 0;
  let tooShort = 0;
  let clamped = 0;
  const usedIds = new Set<string>();
  let segs: Segment[] = [];
  for (const s of input.segments) {
    const a = assets.get(s.assetId);
    if (!a || a.kind !== 'video') {
      unknown++;
      continue;
    }
    const startMs = Math.max(0, Math.min(Math.round(s.startMs), a.durationMs));
    const endMs = Math.min(Math.round(s.endMs), a.durationMs);
    if (endMs - startMs < MIN_SEGMENT_SRC_MS) {
      tooShort++;
      continue;
    }
    if (startMs !== s.startMs || endMs !== s.endMs) clamped++;
    let id = s.id;
    for (let n = 2; usedIds.has(id); n++) id = `${s.id.slice(0, 34)}-${n}`;
    usedIds.add(id);
    segs.push({
      ...s,
      id,
      startMs,
      endMs,
      audio: a.hasAudio ? s.audio : 'mute',
      transitionIn: { ...s.transitionIn },
    });
  }
  if (unknown) notes.push(`Removed ${unknown} segment(s) that referenced unknown or non-video assets.`);
  if (tooShort) notes.push(`Removed ${tooShort} segment(s) that were empty or outside the real clip duration.`);
  if (clamped) notes.push(`Trimmed ${clamped} segment(s) to the real clip durations.`);

  if (segs.length > MAX_SEGMENTS) {
    notes.push(`Kept the first ${MAX_SEGMENTS} of ${segs.length} segments (maximum per plan).`);
    segs = segs.slice(0, MAX_SEGMENTS);
  }
  if (segs.length === 0) {
    throw new AiOutputError('The edit plan contained no usable segments (none referenced real video clips within their durations).');
  }

  // ---- output duration cap ----
  clampTransitions(segs);
  const capped: Segment[] = [];
  let total = 0;
  let hitCap = false;
  for (const s of segs) {
    const overlap = capped.length > 0 && s.transitionIn.type !== 'cut' ? s.transitionIn.durationMs : 0;
    const add = outLen(s) - overlap;
    if (total + add <= MAX_OUTPUT_DURATION_MS) {
      capped.push(s);
      total += add;
      continue;
    }
    hitCap = true;
    const roomOut = MAX_OUTPUT_DURATION_MS - total + overlap;
    const newSrc = Math.floor(roomOut * s.speed);
    if (capped.length === 0 || (roomOut - overlap >= MIN_TRUNCATED_OUTPUT_MS && newSrc >= MIN_SEGMENT_SRC_MS)) {
      capped.push({ ...s, endMs: s.startMs + Math.max(newSrc, MIN_SEGMENT_SRC_MS) });
    }
    break;
  }
  if (capped.length < segs.length || hitCap) {
    notes.push(`The plan was longer than the ${MAX_OUTPUT_DURATION_MS / 1000}s maximum, so it was shortened.`);
  }
  segs = capped;
  clampTransitions(segs);

  let guard = 0;
  const draft = (): EditPlan => ({ ...input, segments: segs });
  while (planDurationMs(draft()) > MAX_OUTPUT_DURATION_MS && guard++ < 50) {
    const excess = planDurationMs(draft()) - MAX_OUTPUT_DURATION_MS;
    const last = segs[segs.length - 1]!;
    const cutSrc = Math.ceil(excess * last.speed);
    if (last.endMs - last.startMs - cutSrc >= MIN_SEGMENT_SRC_MS) segs[segs.length - 1] = { ...last, endMs: last.endMs - cutSrc };
    else if (segs.length > 1) segs.pop();
    else break;
    clampTransitions(segs);
  }

  const base: EditPlan = { ...input, segments: segs };
  const totalMs = planDurationMs(base);

  // ---- titles ----
  const titleIds = new Set<string>();
  let titlesDropped = 0;
  const titles = [] as EditPlan['titles'];
  for (const t of input.titles) {
    const startMs = Math.min(t.startMs, totalMs);
    const endMs = Math.min(t.endMs, totalMs);
    const text = t.text.replace(/\s+/g, ' ').trim();
    if (!text || endMs <= startMs) {
      titlesDropped++;
      continue;
    }
    let id = t.id;
    for (let n = 2; titleIds.has(id); n++) id = `${t.id.slice(0, 34)}-${n}`;
    titleIds.add(id);
    titles.push({ ...t, id, text, startMs, endMs });
  }
  if (titlesDropped) notes.push(`Removed ${titlesDropped} title(s) that fell outside the final video length.`);

  // ---- subtitles: NEVER invented ----
  const userLines = cleanUserLines(ctx.userSubtitleLines);
  let subtitles: EditPlan['subtitles'];
  if (input.subtitles && input.subtitles.cues.length > 0) {
    if (userLines.length === 0) {
      notes.push(`Removed ${input.subtitles.cues.length} subtitle cue(s): subtitles can only use text you supply, and none was supplied.`);
    } else {
      const traceable = makeTraceabilityCheck(userLines);
      const kept = [] as NonNullable<EditPlan['subtitles']>['cues'];
      let removed = 0;
      for (const c of input.subtitles.cues) {
        const startMs = Math.min(c.startMs, totalMs);
        const endMs = Math.min(c.endMs, totalMs);
        if (!traceable(c.text) || endMs <= startMs) {
          removed++;
          continue;
        }
        kept.push({ startMs, endMs, text: c.text.replace(/\s+/g, ' ').trim() });
      }
      if (removed) notes.push(`Removed ${removed} subtitle cue(s) that were not taken from your supplied subtitle lines or fell outside the video.`);
      if (kept.length > 0) subtitles = { source: 'user-provided', position: input.subtitles.position, cues: kept.slice(0, MAX_CUES) };
    }
  }
  if (!subtitles && userLines.length > 0) {
    subtitles = { source: 'user-provided', position: input.subtitles?.position ?? 'bottom', cues: evenCues(userLines, totalMs) };
    notes.push('Your subtitle lines were spread evenly over the video. Timings are not synced to speech; adjust them if needed.');
  }

  // ---- music: only an owner-uploaded audio asset ----
  let audio = input.audio;
  if (audio.music) {
    const m = assets.get(audio.music.assetId);
    if (!m || m.kind !== 'audio') {
      notes.push('Removed background music: it did not reference an audio file you uploaded.');
      audio = { normalizeLoudness: audio.normalizeLoudness };
    }
  }

  // ---- limitations ----
  const modelLimits = input.limitations.map((l) => l.trim()).filter(Boolean);
  const requestText = [ctx.brief, ctx.revisionRequest ?? ''].join('\n');
  const limitations = [...modelLimits, ...detectLimitations(requestText, ctx.assets, modelLimits)].map((l) => l.slice(0, 300)).slice(0, 10);

  const candidate = {
    ...input,
    segments: segs,
    titles,
    subtitles,
    audio,
    limitations,
    summary: input.summary.slice(0, 400),
  };
  const parsed = EditPlanSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new AiOutputError(`The sanitised edit plan is still invalid: ${parsed.error.issues[0]?.message ?? 'unknown error'}`);
  }
  if (planDurationMs(parsed.data) > MAX_OUTPUT_DURATION_MS) {
    throw new AiOutputError('The edit plan is longer than the maximum output duration and could not be shortened.');
  }
  return { plan: parsed.data, notes };
}
