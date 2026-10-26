/**
 * Technical clip analysis: local, deterministic, no AI, always available.
 *
 * It decodes the clip ONCE at low resolution (8 fps, long edge <= 384 px, 8-bit gray, piped as raw frames) and
 * measures per-frame signal facts in JS: exposure, edge-sharpness (a focus proxy), frame-to-frame change, global
 * camera shift (row/column projection matching -> jitter), hard scene cuts. Audio level is measured by a second,
 * cheap audio-only pass (astats per second). Results are aggregated into ~1 s windows.
 *
 * What this DOES NOT know: what is in the shot. "Sharp" means "strong edges", "static" means "frames barely
 * change", "shaky" means "the global image shift jitters between samples". These are proxies and are labelled so.
 */
import {
  TECH_ANALYZER_VERSION,
  TECH_ISSUE_LABELS,
  type TechIssueCode,
  type TechnicalProfile,
  type TechnicalWindow,
} from '../../../shared/analysis.js';
import type { MediaInfo } from '../../../shared/domain.js';
import { runBinary } from './spawn-binary.js';

export class AnalysisError extends Error {
  constructor(message: string, public readonly detail = '') {
    super(message);
    this.name = 'AnalysisError';
  }
}

export const ANALYSIS_FPS = 8;
export const ANALYSIS_LONG_EDGE = 384;
export const WINDOW_MS = 1000;
/** very long clips are measured only up to this length (the profile says so via analyzedMs) */
export const DEFAULT_MAX_ANALYZE_MS = 240_000;

// ---- thresholds (proxies; documented, calibrated on synthetic footage only) ----
const DARK_BRIGHTNESS = 0.14; // mean luma < ~36/255
const BRIGHT_BRIGHTNESS = 0.86;
const CLIPPED_HIGH_SHARE = 0.4; // > 40% of pixels >= 245
const BLUR_REL = 0.5; // window edge sharpness below half of this clip's sharp parts
const BLUR_ABS = 2.0; // edge sharpness so low that nothing crisp exists at all
const SHAKE_JITTER = 0.0075; // mean image-shift acceleration / frame width
const SHAKE_FULL = 0.02;
const STATIC_MOTION = 0.0025; // mean abs luma change between samples / 255
const SILENT_DB = -50;
const CUT_HIST = 0.5;
const CUT_DIFF = 0.15;

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const even = (n: number) => Math.max(16, Math.round(n / 2) * 2);

export interface TechnicalOptions {
  signal?: AbortSignal;
  /** hard timeout for the whole analysis (default 120 s) */
  timeoutMs?: number;
  /** analyse at most this much of the clip (default 240 s) */
  maxAnalyzeMs?: number;
}

interface SampleSeries {
  luma: number[]; // 0..1
  contrast: number[]; // 0..1
  clipHigh: number[]; // share of pixels >= 245
  sharp: number[]; // tail-mean |laplacian| (0..255 scale)
  diff: number[]; // mean abs diff vs previous sample 0..1 (NaN for the first sample and across cuts)
  vx: number[]; // image shift vs previous sample in analysis pixels (NaN if unreliable)
  vy: number[];
  cutAt: boolean[];
}

/** Incremental per-frame measurements; keeps only the previous frame. */
class FrameMeter {
  readonly s: SampleSeries = { luma: [], contrast: [], clipHigh: [], sharp: [], diff: [], vx: [], vy: [], cutAt: [] };
  private prev: Uint8Array | null = null;
  private prevCols: Float32Array | null = null;
  private prevRows: Float32Array | null = null;
  private prevHist64: Float32Array | null = null;
  private readonly maxShiftX: number;
  private readonly maxShiftY: number;
  constructor(readonly w: number, readonly h: number) {
    this.maxShiftX = Math.max(2, Math.floor(w * 0.08));
    this.maxShiftY = Math.max(2, Math.floor(h * 0.08));
  }

  push(frame: Uint8Array): void {
    const { w, h, s } = this;
    const n = w * h;
    const hist = new Uint32Array(256);
    const cols = new Float32Array(w);
    const rows = new Float32Array(h);
    let sum = 0;
    for (let y = 0; y < h; y++) {
      let rowSum = 0;
      const o = y * w;
      for (let x = 0; x < w; x++) {
        const v = frame[o + x]!;
        hist[v]!++;
        rowSum += v;
        cols[x]! += v;
      }
      rows[y] = rowSum / w;
      sum += rowSum;
    }
    for (let x = 0; x < w; x++) cols[x] = cols[x]! / h;

    // percentiles from histogram
    const pct = (p: number) => {
      const target = n * p;
      let acc = 0;
      for (let v = 0; v < 256; v++) {
        acc += hist[v]!;
        if (acc >= target) return v;
      }
      return 255;
    };
    const p5 = pct(0.05);
    const p95 = pct(0.95);
    let hi = 0;
    for (let v = 245; v < 256; v++) hi += hist[v]!;

    // edge strength: |centre - mean of 4 neighbours|, tail-mean of the strongest 8% of pixels
    const lapHist = new Uint32Array(256);
    let lapCount = 0;
    for (let y = 1; y < h - 1; y++) {
      const o = y * w;
      for (let x = 1; x < w - 1; x++) {
        const c = frame[o + x]!;
        const l = Math.abs(c - (frame[o + x - 1]! + frame[o + x + 1]! + frame[o - w + x]! + frame[o + w + x]!) / 4);
        lapHist[Math.min(255, Math.round(l))]!++;
        lapCount++;
      }
    }
    let tailN = Math.max(1, Math.floor(lapCount * 0.08));
    let tailSum = 0;
    let taken = 0;
    for (let v = 255; v >= 0 && taken < tailN; v--) {
      const c = Math.min(lapHist[v]!, tailN - taken);
      tailSum += c * v;
      taken += c;
    }
    const sharp = taken ? tailSum / taken : 0;

    // 64-bin histogram for cut detection
    const hist64 = new Float32Array(64);
    for (let v = 0; v < 256; v++) hist64[v >> 2]! += hist[v]! / n;

    s.luma.push(sum / n / 255);
    s.contrast.push((p95 - p5) / 255);
    s.clipHigh.push(hi / n);
    s.sharp.push(sharp);

    let diff = NaN;
    let vx = NaN;
    let vy = NaN;
    let cut = false;
    if (this.prev && this.prevCols && this.prevRows && this.prevHist64) {
      let d = 0;
      for (let i = 0; i < n; i++) d += Math.abs(frame[i]! - this.prev[i]!);
      const mad = d / n / 255;
      let hd = 0;
      for (let b = 0; b < 64; b++) hd += Math.abs(hist64[b]! - this.prevHist64[b]!);
      hd /= 2;
      cut = hd > CUT_HIST && mad > CUT_DIFF;
      if (!cut) {
        diff = mad;
        const sx = bestShift(this.prevCols, cols, this.maxShiftX);
        const sy = bestShift(this.prevRows, rows, this.maxShiftY);
        if (sx !== null && sy !== null) {
          vx = sx;
          vy = sy;
        } else if (mad < STATIC_MOTION * 4) {
          vx = 0;
          vy = 0;
        }
      }
    }
    s.diff.push(diff);
    s.vx.push(vx);
    s.vy.push(vy);
    s.cutAt.push(cut);
    this.prev = frame.slice();
    this.prevCols = cols;
    this.prevRows = rows;
    this.prevHist64 = hist64;
  }
}

/** shift d (a[x] ~ b[x+d]) that best aligns two 1-D projections, or null if there is no clear match / no structure */
function bestShift(a: Float32Array, b: Float32Array, maxShift: number): number | null {
  const len = a.length;
  let mean = 0;
  for (let i = 0; i < len; i++) mean += a[i]!;
  mean /= len;
  let variance = 0;
  for (let i = 0; i < len; i++) variance += (a[i]! - mean) ** 2;
  if (Math.sqrt(variance / len) < 2) return null; // featureless: cannot tell
  let best = Infinity;
  let bestD = 0;
  let total = 0;
  let count = 0;
  for (let d = -maxShift; d <= maxShift; d++) {
    const from = Math.max(0, -d);
    const to = Math.min(len, len - d);
    let sad = 0;
    for (let i = from; i < to; i++) sad += Math.abs(a[i]! - b[i + d]!);
    sad /= Math.max(1, to - from);
    total += sad;
    count++;
    if (sad < best) {
      best = sad;
      bestD = d;
    }
  }
  const avg = total / count;
  if (!(best < avg * 0.6)) return null; // no distinct minimum
  return bestD;
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1) + 0.5))]!;
}
const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);
const finite = (v: number[]) => v.filter((x) => Number.isFinite(x));

function exposureScore(brightness: number, clipHigh: number): number {
  const low = clamp01((brightness - 0.06) / (0.28 - 0.06));
  const high = 1 - clamp01((brightness - 0.72) / (0.95 - 0.72));
  const clip = 1 - clamp01((clipHigh - 0.15) / 0.45);
  return Math.min(low, high, clip);
}

/** group sorted window indexes of one issue into time ranges */
function rangesOf(windows: TechnicalWindow[], code: TechIssueCode) {
  const out: { startMs: number; endMs: number }[] = [];
  for (const w of windows) {
    if (!w.issues.includes(code)) continue;
    const last = out[out.length - 1];
    if (last && w.startMs <= last.endMs + 1) last.endMs = w.endMs;
    else out.push({ startMs: w.startMs, endMs: w.endMs });
  }
  return out.slice(0, 20);
}

export function aggregateWindows(
  series: SampleSeries,
  frameW: number,
  analyzedMs: number,
  audioDb: (number | null)[] | null,
  sceneStartsMs: number[] = [],
): TechnicalWindow[] {
  const total = series.luma.length;
  const perWin = Math.round((ANALYSIS_FPS * WINDOW_MS) / 1000);
  const bounds: { from: number; to: number; startMs: number; endMs: number }[] = [];
  if (total <= perWin + Math.floor(perWin / 2)) {
    bounds.push({ from: 0, to: total, startMs: 0, endMs: analyzedMs });
  } else {
    for (let from = 0; from < total; from += perWin) {
      const rest = total - from;
      const last = rest < perWin * 1.5;
      const to = last ? total : from + perWin;
      bounds.push({ from, to, startMs: Math.round((from * 1000) / ANALYSIS_FPS), endMs: last ? analyzedMs : Math.round((to * 1000) / ANALYSIS_FPS) });
      if (last) break;
    }
  }

  // focus reference = the sharp parts of the SAME scene (different scenes have different amounts of detail)
  const rawSharp = bounds.map((b) => mean(series.sharp.slice(b.from, b.to)));
  const sceneOf = (startMs: number) => sceneStartsMs.filter((t) => t <= startMs + 250).length;
  const refByScene = new Map<number, number>();
  for (const sc of new Set(bounds.map((b) => sceneOf(b.startMs)))) {
    const vals = rawSharp.filter((_v, i) => sceneOf(bounds[i]!.startMs) === sc);
    refByScene.set(sc, Math.max(percentile(vals, 0.85), 1e-6));
  }

  return bounds.map((b, wi) => {
    const sl = <T>(arr: T[]) => arr.slice(b.from, b.to);
    const brightness = mean(sl(series.luma));
    const contrast = mean(sl(series.contrast));
    const clipHigh = mean(sl(series.clipHigh));
    const sharpRaw = rawSharp[wi]!;
    const diffs = finite(sl(series.diff));
    const motionRaw = diffs.length ? mean(diffs) : 0;

    // camera jitter: acceleration of the global image shift between consecutive reliable samples
    const vx = sl(series.vx);
    const vy = sl(series.vy);
    const acc: number[] = [];
    for (let i = 1; i < vx.length; i++) {
      if ([vx[i], vy[i], vx[i - 1], vy[i - 1]].every((v) => Number.isFinite(v))) acc.push(Math.hypot(vx[i]! - vx[i - 1]!, vy[i]! - vy[i - 1]!));
    }
    // median (not mean): one wrong shift estimate must not make a steady shot look shaky
    const jitter = acc.length >= 3 ? percentile(acc, 0.5) / frameW : 0;

    const refSharp = refByScene.get(sceneOf(b.startMs)) ?? 1e-6;
    const sharpRel = clamp01(sharpRaw / refSharp);
    const lowDetailClip = refSharp < 4; // nothing crisp anywhere in this clip -> judge by absolute edge strength
    const focus = lowDetailClip ? clamp01(sharpRaw / 6) : clamp01((sharpRel - 0.35) / (0.8 - 0.35));
    const exposure = exposureScore(brightness, clipHigh);
    const stability = 1 - clamp01(jitter / SHAKE_FULL);

    const issues: TechIssueCode[] = [];
    const dark = brightness < DARK_BRIGHTNESS;
    if (dark) issues.push('too_dark');
    if (brightness > BRIGHT_BRIGHTNESS || clipHigh > CLIPPED_HIGH_SHARE) issues.push('overexposed');
    // focus / shake / stillness cannot be judged in near-black frames: report only the exposure problem
    if (!dark && ((!lowDetailClip && sharpRel < BLUR_REL) || sharpRaw < BLUR_ABS)) issues.push('blurry');
    if (!dark && jitter > SHAKE_JITTER) issues.push('shaky');
    if (!dark && diffs.length >= 2 && motionRaw < STATIC_MOTION) issues.push('static');

    let score = 0.4 * exposure + 0.35 * focus + 0.25 * stability;
    if (issues.includes('static')) score -= 0.05;

    let audio: number | null = null;
    if (audioDb) {
      const vals = audioDb.slice(Math.floor(b.startMs / 1000), Math.max(Math.floor(b.startMs / 1000) + 1, Math.ceil(b.endMs / 1000))).filter((v): v is number => v !== null);
      audio = vals.length ? r3(mean(vals)) : null;
    }
    return {
      startMs: b.startMs,
      endMs: Math.max(b.endMs, b.startMs + 1),
      brightness: r3(clamp01(brightness)),
      contrast: r3(clamp01(contrast)),
      sharpness: r3(sharpRel),
      motion: r3(clamp01(motionRaw / 0.1)),
      shake: r3(clamp01(jitter / SHAKE_FULL)),
      audioDb: audio,
      score: r3(clamp01(score)),
      issues,
    } satisfies TechnicalWindow;
  });
}

async function measureAudio(
  ffmpegPath: string,
  file: string,
  analyzedMs: number,
  opts: { signal?: AbortSignal; timeoutMs: number },
): Promise<(number | null)[] | null> {
  const args = [
    '-hide_banner', '-nostdin', '-v', 'error',
    '-t', (analyzedMs / 1000).toFixed(3),
    '-i', file,
    '-map', '0:a:0', '-vn', '-sn', '-dn',
    '-af', 'aresample=8000,asetnsamples=n=8000:p=0,astats=metadata=1:reset=1,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=-',
    '-f', 'null', '-',
  ];
  try {
    const r = await runBinary(ffmpegPath, args, { signal: opts.signal, timeoutMs: opts.timeoutMs });
    if (r.code !== 0) return null;
    const text = r.stdout.toString('utf8');
    const out: (number | null)[] = [];
    let t: number | null = null;
    for (const line of text.split(/\r?\n/)) {
      const tm = /pts_time:([\d.]+)/.exec(line);
      if (tm) {
        t = Number(tm[1]);
        continue;
      }
      const lv = /lavfi\.astats\.Overall\.RMS_level=(-?[\d.]+|-?inf)/i.exec(line);
      if (lv && t !== null) {
        const idx = Math.round(t);
        // ignore the trailing partial chunk at/after the end
        if (idx * 1000 >= analyzedMs - 200) continue;
        out[idx] = /inf/i.test(lv[1]!) ? -90 : Math.max(-90, Number(lv[1]));
      }
    }
    for (let i = 0; i < out.length; i++) if (out[i] === undefined) out[i] = null;
    return out.length ? out : null;
  } catch {
    return null;
  }
}

/**
 * Measure a clip. Rejects with AnalysisError when the clip cannot be read. Never throws for "boring" clips
 * (too short, no audio, rotated, featureless): they yield a profile with fewer facts.
 */
export async function technicalProfile(ffmpegPath: string, file: string, info: MediaInfo, opts: TechnicalOptions = {}): Promise<TechnicalProfile> {
  if (!info.hasVideo) throw new AnalysisError('This file has no video to analyse.');
  const durationMs = Math.max(0, Math.round(info.durationMs));
  if (durationMs < 100) throw new AnalysisError('This clip is too short to analyse.');
  const analyzedMs = Math.min(durationMs, opts.maxAnalyzeMs ?? DEFAULT_MAX_ANALYZE_MS);
  const timeoutMs = opts.timeoutMs ?? 120_000;

  const dw = info.displayWidth || info.width || 16;
  const dh = info.displayHeight || info.height || 16;
  const scale = Math.min(1, ANALYSIS_LONG_EDGE / Math.max(dw, dh));
  const w = even(dw * scale);
  const h = even(dh * scale);
  const frameBytes = w * h;

  const meter = new FrameMeter(w, h);
  let carry: Buffer = Buffer.alloc(0);
  const onStdout = (chunk: Buffer) => {
    carry = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    while (carry.length >= frameBytes) {
      meter.push(new Uint8Array(carry.buffer, carry.byteOffset, frameBytes));
      carry = carry.subarray(frameBytes);
    }
  };
  const videoArgs = [
    '-hide_banner', '-nostdin', '-v', 'error',
    '-t', (analyzedMs / 1000).toFixed(3),
    '-i', file,
    '-map', '0:v:0', '-an', '-sn', '-dn',
    '-vf', `fps=${ANALYSIS_FPS},scale=${w}:${h}:flags=area,format=gray`,
    '-f', 'rawvideo', '-pix_fmt', 'gray', '-',
  ];
  const [video, audioDb] = await Promise.all([
    runBinary(ffmpegPath, videoArgs, { signal: opts.signal, timeoutMs, onStdout }),
    info.hasAudio ? measureAudio(ffmpegPath, file, analyzedMs, { signal: opts.signal, timeoutMs }) : Promise.resolve(null),
  ]);
  if (video.aborted) throw new AnalysisError('Analysis was cancelled.');
  if (video.timedOut) throw new AnalysisError('Analysing this clip took too long.');
  if (video.code !== 0 && meter.s.luma.length === 0) throw new AnalysisError('Could not decode this clip for analysis.', video.stderr.slice(-300));
  if (meter.s.luma.length === 0) throw new AnalysisError('No frames could be decoded from this clip.');

  const series = meter.s;
  const sceneChangesMs: number[] = [];
  series.cutAt.forEach((c, i) => {
    if (!c) return;
    const t = Math.round((i * 1000) / ANALYSIS_FPS);
    const last = sceneChangesMs[sceneChangesMs.length - 1];
    if (last === undefined || t - last >= 500) sceneChangesMs.push(t);
  });
  const windows = aggregateWindows(series, w, analyzedMs, audioDb, sceneChangesMs);
  if (process.env.AN_DEBUG) console.error('rawSharp', series.sharp.map((v) => v.toFixed(1)).join(' '));

  // clip-level audio
  let audio: TechnicalProfile['audio'] = null;
  if (info.hasAudio) {
    const known = (audioDb ?? []).filter((v): v is number => v !== null);
    audio = {
      present: true,
      meanDb: known.length ? r3(mean(known)) : null,
      silentRatio: known.length ? r3(known.filter((v) => v < SILENT_DB).length / known.length) : null,
    };
  }

  const issues: TechnicalProfile['issues'] = [];
  for (const code of ['too_dark', 'overexposed', 'blurry', 'shaky', 'static'] as const) {
    const affected = windows.filter((win) => win.issues.includes(code)).length;
    if (affected === 0) continue;
    const share = affected / windows.length;
    if (affected >= 2 || share >= 0.5) issues.push({ code, label: TECH_ISSUE_LABELS[code], share: r3(share), ranges: rangesOf(windows, code) });
  }
  if (audio?.present && audio.silentRatio !== null && audio.silentRatio >= 0.9) {
    issues.push({ code: 'silent_audio', label: TECH_ISSUE_LABELS.silent_audio, share: audio.silentRatio, ranges: [{ startMs: 0, endMs: analyzedMs }] });
  }

  return {
    analyzerVersion: TECH_ANALYZER_VERSION,
    durationMs,
    analyzedMs,
    windowMs: WINDOW_MS,
    sampleFps: ANALYSIS_FPS,
    windows,
    sceneChangesMs,
    audio,
    issues,
    score: r3(mean(windows.map((x) => x.score))),
    createdAt: new Date().toISOString(),
  };
}
