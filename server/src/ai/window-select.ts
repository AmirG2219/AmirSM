/**
 * Picks the technically best time ranges of a clip from its TechnicalProfile (exposure, focus proxy, steadiness,
 * scene cuts, audio level). Pure and deterministic. It knows NOTHING about content: "best" = best measured signal.
 */
import { TECH_ISSUE_LABELS, type TechIssueCode, type TechnicalProfile, type TechnicalWindow } from '../../../shared/analysis.js';
import type { StylePreset } from '../../../shared/editPlan.js';

export interface RangePick {
  startMs: number;
  endMs: number;
  /** time-weighted mean of the (preference-adjusted) window scores, roughly 0..1 */
  score: number;
  /** issues present in at least a third of the covered time */
  issues: TechIssueCode[];
}

/** +1 = prefer lively footage, -1 = prefer calm footage */
export function motionPreference(preset: StylePreset): number {
  if (preset === 'high-energy' || preset === 'motivation') return 1;
  if (preset === 'calm-cinematic') return -0.5;
  return 0;
}

const CUT_MARGIN_MS = 200;
const STEP_MS = 250;

function effective(w: TechnicalWindow, pref: number): number {
  let s = w.score + 0.15 * pref * w.motion;
  if (w.audioDb !== null && w.audioDb > -45) s += 0.03; // some audible activity
  return s;
}

/** time-weighted mean of window scores over [a,b) */
function rangeScore(p: TechnicalProfile, a: number, b: number, pref: number) {
  let sum = 0;
  let covered = 0;
  const issueMs = new Map<TechIssueCode, number>();
  for (const w of p.windows) {
    const lo = Math.max(a, w.startMs);
    const hi = Math.min(b, w.endMs);
    if (hi <= lo) continue;
    const d = hi - lo;
    sum += effective(w, pref) * d;
    covered += d;
    for (const c of w.issues) issueMs.set(c, (issueMs.get(c) ?? 0) + d);
  }
  if (covered <= 0) return { score: -1, issues: [] as TechIssueCode[] };
  let score = sum / covered;
  for (const c of p.sceneChangesMs) if (c > a + CUT_MARGIN_MS && c < b - CUT_MARGIN_MS) score -= 0.5;
  // a range partly outside the measured part of the clip is worth less
  score -= 0.3 * (1 - covered / Math.max(1, b - a));
  const issues = [...issueMs.entries()].filter(([, ms]) => ms >= (b - a) / 3).map(([c]) => c);
  return { score, issues };
}

/**
 * Up to `count` non-overlapping ranges of `lengthMs` (fewer if the clip is too short), best first by score, then
 * returned in time order. Returns [] when the profile has no windows.
 */
export function pickRanges(p: TechnicalProfile, lengthMs: number, count: number, preset: StylePreset = 'custom'): RangePick[] {
  if (!p.windows.length || lengthMs <= 0 || count <= 0) return [];
  const pref = motionPreference(preset);
  const limit = Math.min(p.durationMs, p.analyzedMs);
  const len = Math.min(lengthMs, limit);
  const starts = new Set<number>();
  for (let s = 0; s + len <= limit; s += STEP_MS) starts.add(s);
  starts.add(Math.max(0, limit - len));
  for (const c of p.sceneChangesMs) {
    for (const s of [c, c - len]) if (s >= 0 && s + len <= limit) starts.add(Math.round(s));
  }
  const candidates = [...starts]
    .sort((x, y) => x - y)
    .map((s) => {
      const r = rangeScore(p, s, s + len, pref);
      // tie-break only: among equally good ranges prefer one that starts a little into the clip (first frames are often unsettled)
      const room = Math.max(1, limit - len);
      return { startMs: s, endMs: s + len, issues: r.issues, score: r.score - 0.01 * (Math.abs(s - 0.2 * room) / room) };
    });

  const chosen: RangePick[] = [];
  const ranked = [...candidates].sort((x, y) => y.score - x.score || x.startMs - y.startMs);
  for (const c of ranked) {
    if (chosen.length >= count) break;
    if (chosen.some((o) => c.startMs < o.endMs && c.endMs > o.startMs)) continue;
    chosen.push({ startMs: c.startMs, endMs: c.endMs, score: Math.round(c.score * 1000) / 1000, issues: c.issues });
  }
  return chosen.sort((x, y) => x.startMs - y.startMs);
}

/** Plain-language list of the clip-level problems that cover at least `minShare` of the clip. */
export function majorIssueLabels(p: TechnicalProfile, minShare = 0.5): string[] {
  return p.issues.filter((i) => i.share >= minShare && i.code !== 'static' && i.code !== 'silent_audio').map((i) => TECH_ISSUE_LABELS[i.code]);
}

/** Short description of a pick for notes, e.g. "2.0-4.5 s". */
export function fmtRange(startMs: number, endMs: number): string {
  return `${(startMs / 1000).toFixed(1)}-${(endMs / 1000).toFixed(1)} s`;
}
