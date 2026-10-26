/** ffprobe -> MediaInfo. */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { MediaInfo } from '../../../shared/domain.js';
import { capture } from './ffmpeg-run.js';

/** Thrown when a file cannot be read as usable media. Message is human-readable. */
export class ProbeError extends Error {
  constructor(message: string, public readonly detail = '') {
    super(message);
    this.name = 'ProbeError';
  }
}

interface FfStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
  nb_frames?: string;
  tags?: Record<string, string>;
  disposition?: { attached_pic?: number };
  side_data_list?: Array<{ side_data_type?: string; rotation?: number | string }>;
  pix_fmt?: string;
  profile?: string;
}
export interface FfProbeJson {
  streams?: FfStream[];
  format?: { format_name?: string; duration?: string; bit_rate?: string; size?: string; tags?: Record<string, string> };
}

export async function runFfprobe(ffprobePath: string, filePath: string, timeoutMs = 30_000): Promise<FfProbeJson> {
  let res;
  try {
    res = await capture(ffprobePath, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-i', filePath], { timeoutMs });
  } catch (e) {
    throw new ProbeError(`Could not run ffprobe: ${(e as Error).message}`);
  }
  if (res.timedOut) throw new ProbeError('Reading the file timed out');
  if (res.code !== 0) {
    const detail = res.stderr.trim().slice(-600);
    throw new ProbeError('This file is not a readable video or audio file', detail);
  }
  try {
    return JSON.parse(res.stdout) as FfProbeJson;
  } catch {
    throw new ProbeError('ffprobe returned unreadable output');
  }
}

function parseRate(r: string | undefined): number {
  if (!r) return 0;
  const m = /^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/.exec(r);
  if (m) {
    const den = Number(m[2]);
    return den > 0 ? Number(m[1]) / den : 0;
  }
  const n = Number(r);
  return Number.isFinite(n) ? n : 0;
}

function parseDurationTag(s: string | undefined): number {
  if (!s) return 0;
  const m = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(s.trim());
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
}

/** Clockwise degrees (0/90/180/270) that a player must rotate the stored frames to display them upright. */
export function rotationOf(v: FfStream): number {
  let deg = 0;
  const side = v.side_data_list?.find((s) => s.side_data_type === 'Display Matrix' && s.rotation !== undefined);
  if (side) {
    // ffprobe reports the display-matrix rotation counter-clockwise: -90 means rotate 90deg clockwise to display.
    deg = -Number(side.rotation);
  } else if (v.tags?.rotate !== undefined) {
    // legacy tag, clockwise
    deg = Number(v.tags.rotate);
  }
  if (!Number.isFinite(deg)) return 0;
  const r = ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
  return r;
}

function containerOf(formatName: string | undefined, filePath: string): string | null {
  if (!formatName) return null;
  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  const names = formatName.split(',');
  if (names.includes('mov') || names.includes('mp4')) return ext === 'mov' ? 'mov' : ext === 'm4a' ? 'm4a' : ext === 'm4v' ? 'm4v' : 'mp4';
  if (names.includes('matroska')) return ext === 'webm' ? 'webm' : 'matroska';
  return names[0] ?? null;
}

export function mediaInfoFromProbe(json: FfProbeJson, filePath: string, sizeBytes: number): MediaInfo {
  const streams = json.streams ?? [];
  const fmt = json.format ?? {};
  const formatName = fmt.format_name ?? '';
  if (formatName.includes('image2') || formatName.endsWith('_pipe') || formatName === 'png_pipe') {
    throw new ProbeError('Still images are not supported as footage; please upload a video or audio file');
  }
  // cover art embedded in an mp3 shows up as a video stream with attached_pic; it is not footage.
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic && (s.width ?? 0) > 0 && (s.height ?? 0) > 0);
  const audio = streams.find((s) => s.codec_type === 'audio');
  if (!video && !audio) throw new ProbeError('No video or audio stream found in this file');

  let durationSec = Number(fmt.duration);
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    const cands = [video, audio].flatMap((s) => (s ? [Number(s.duration), parseDurationTag(s.tags?.DURATION ?? s.tags?.duration)] : []));
    durationSec = Math.max(0, ...cands.filter((n) => Number.isFinite(n)));
  }
  const durationMs = Math.round(durationSec * 1000);

  const width = video?.width ?? 0;
  const height = video?.height ?? 0;
  const rotation = video ? rotationOf(video) : 0;
  const swap = rotation === 90 || rotation === 270;
  const fps = video ? parseRate(video.avg_frame_rate) || parseRate(video.r_frame_rate) : 0;
  const bitrate = Number(fmt.bit_rate);

  return {
    durationMs,
    width,
    height,
    displayWidth: swap ? height : width,
    displayHeight: swap ? width : height,
    rotation,
    fps: Math.round(fps * 1000) / 1000,
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    hasVideo: !!video,
    hasAudio: !!audio,
    container: containerOf(fmt.format_name, filePath),
    bitrate: Number.isFinite(bitrate) && bitrate > 0 ? Math.round(bitrate) : null,
    sizeBytes,
  };
}

/**
 * Probe a media file. Audio-only files are returned with hasVideo=false (needed for music assets);
 * unreadable / non-media / still-image files throw ProbeError.
 */
export async function probeFile(ffprobePath: string, filePath: string): Promise<MediaInfo> {
  let st;
  try {
    st = await fs.stat(filePath);
  } catch {
    throw new ProbeError('File not found');
  }
  if (!st.isFile()) throw new ProbeError('Not a file');
  if (st.size === 0) throw new ProbeError('The file is empty');
  const json = await runFfprobe(ffprobePath, filePath);
  return mediaInfoFromProbe(json, filePath, st.size);
}
