/**
 * Frame sampling for the vision model: N evenly spread stills per clip as downscaled JPEGs.
 * Each frame is a separate fast-seek (-ss before -i), run a few at a time. Rotation metadata is applied by ffmpeg.
 */
import type { SampledFrame } from '../../../shared/analysis.js';
import type { MediaInfo } from '../../../shared/domain.js';
import { runBinary } from './spawn-binary.js';

export const DEFAULT_FRAME_LONG_EDGE = 768;

export interface SampleFramesOptions {
  /** number of stills (default 5) */
  count?: number;
  /** longest side in px; never upscaled (default 768) */
  longEdge?: number;
  /** JPEG quality, ffmpeg -q:v scale 2 (best) .. 31 (worst); default 5 */
  quality?: number;
  concurrency?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Midpoints of `count` equal slices of the clip: 1/(2n), 3/(2n), ... of the duration. */
export function frameTimestamps(durationMs: number, count: number): number[] {
  const n = Math.max(1, Math.floor(count));
  const d = Math.max(0, durationMs);
  return Array.from({ length: n }, (_v, i) => Math.round((d * (2 * i + 1)) / (2 * n)));
}

/** Reads width/height from a JPEG's SOF marker; null if it is not a readable JPEG. */
export function jpegSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1]!;
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

async function oneFrame(ffmpegPath: string, file: string, timeMs: number, o: Required<Pick<SampleFramesOptions, 'longEdge' | 'quality'>> & { signal?: AbortSignal; timeoutMs: number }): Promise<SampledFrame | null> {
  const box = Math.max(16, Math.round(o.longEdge));
  const args = [
    '-hide_banner', '-nostdin', '-v', 'error',
    '-ss', (timeMs / 1000).toFixed(3),
    '-i', file,
    '-map', '0:v:0', '-an', '-sn', '-dn',
    '-frames:v', '1',
    '-vf', `scale='min(${box},iw)':'min(${box},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`,
    '-q:v', String(o.quality),
    '-f', 'image2pipe', '-c:v', 'mjpeg', '-',
  ];
  const r = await runBinary(ffmpegPath, args, { signal: o.signal, timeoutMs: o.timeoutMs });
  if (r.code !== 0 || r.stdout.length < 200) return null;
  const size = jpegSize(r.stdout);
  if (!size) return null;
  return { timeMs, mediaType: 'image/jpeg', data: r.stdout.toString('base64'), width: size.width, height: size.height, bytes: r.stdout.length };
}

/** Evenly spread stills of a clip, in time order. Frames that cannot be decoded are skipped (the array may be shorter). */
export async function sampleFrames(ffmpegPath: string, file: string, info: MediaInfo, opts: SampleFramesOptions = {}): Promise<SampledFrame[]> {
  if (!info.hasVideo || info.durationMs <= 0) return [];
  const times = frameTimestamps(info.durationMs, opts.count ?? 5);
  const o = { longEdge: opts.longEdge ?? DEFAULT_FRAME_LONG_EDGE, quality: opts.quality ?? 5, signal: opts.signal, timeoutMs: opts.timeoutMs ?? 30_000 };
  const out: (SampledFrame | null)[] = new Array(times.length).fill(null);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= times.length || opts.signal?.aborted) return;
      let frame = await oneFrame(ffmpegPath, file, times[i]!, o);
      // some files cannot seek exactly; retry slightly earlier once
      if (!frame && times[i]! > 300) frame = await oneFrame(ffmpegPath, file, times[i]! - 250, { ...o });
      out[i] = frame ? { ...frame, timeMs: times[i]! } : null;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 3, times.length)) }, worker));
  return out.filter((f): f is SampledFrame => f !== null);
}
