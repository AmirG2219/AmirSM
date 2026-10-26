/**
 * Frame-accurate timeline math shared by validation and rendering.
 * Every segment and transition is snapped to whole output frames so that audio (generated from the same
 * frame counts) stays aligned with video across many joins.
 */
import { OUTPUT_FORMATS, type EditPlan, type Segment } from '../../../shared/editPlan.js';

export interface TimelineSeg {
  index: number;
  segment: Segment;
  /** output length of this segment in ms before overlaps (source length / speed) */
  outMs: number;
  /** output length in frames */
  frames: number;
  /** frames of transition INTO this segment (0 for cut / first segment) */
  transFrames: number;
}

export interface Timeline {
  fps: number;
  width: number;
  height: number;
  segs: TimelineSeg[];
  totalFrames: number;
  totalSeconds: number;
}

export function buildTimeline(plan: EditPlan): Timeline {
  const fps = plan.fps;
  const { width, height } = OUTPUT_FORMATS[plan.format];
  const segs: TimelineSeg[] = plan.segments.map((segment, index) => {
    const outMs = (segment.endMs - segment.startMs) / segment.speed;
    const frames = Math.max(1, Math.round((outMs * fps) / 1000));
    const t = segment.transitionIn;
    const transFrames = index > 0 && t.type !== 'cut' ? Math.max(1, Math.round((t.durationMs * fps) / 1000)) : 0;
    return { index, segment, outMs, frames, transFrames };
  });
  const totalFrames = segs.reduce((n, s) => n + s.frames - s.transFrames, 0);
  return { fps, width, height, segs, totalFrames, totalSeconds: totalFrames / fps };
}

/** Problems where transitions cannot be laid out on the given clip lengths. Messages are human-readable. */
export function transitionProblems(tl: Timeline): string[] {
  const problems: string[] = [];
  const { segs, fps } = tl;
  for (let i = 1; i < segs.length; i++) {
    const cur = segs[i]!;
    const prev = segs[i - 1]!;
    if (cur.transFrames === 0) continue;
    const ms = Math.round((cur.transFrames * 1000) / fps);
    if (cur.transFrames >= cur.frames) problems.push(`Transition into segment ${i + 1} (${ms} ms) is not shorter than that segment (${Math.round(cur.outMs)} ms)`);
    if (cur.transFrames >= prev.frames) problems.push(`Transition into segment ${i + 1} (${ms} ms) is not shorter than the previous segment (${Math.round(prev.outMs)} ms)`);
  }
  // a segment sandwiched between two transitions needs room for both
  for (let i = 1; i < segs.length - 1; i++) {
    const cur = segs[i]!;
    const next = segs[i + 1]!;
    if (cur.transFrames > 0 && next.transFrames > 0 && cur.transFrames + next.transFrames >= cur.frames) {
      problems.push(`Segment ${i + 1} is too short (${Math.round(cur.outMs)} ms) for the transitions on both of its ends`);
    }
  }
  return problems;
}
