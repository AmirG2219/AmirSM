/** Deterministic checks on a finished export (ffprobe + a full decode pass). */
import fs from 'node:fs/promises';
import { OUTPUT_FORMATS, planDurationMs, type EditPlan } from '../../../shared/editPlan.js';
import type { QualityReport } from '../../../shared/domain.js';
import { capture } from './ffmpeg-run.js';
import { runFfprobe, rotationOf, type FfProbeJson } from './probe.js';

type Status = 'pass' | 'warn' | 'fail';
interface Check {
  id: string;
  label: string;
  status: Status;
  detail: string;
}

/** Position of `moov` vs `mdat` among the top-level boxes: true = moov first (faststart), null = could not tell. */
export async function moovBeforeMdat(file: string): Promise<boolean | null> {
  let fh;
  try {
    fh = await fs.open(file, 'r');
    const { size } = await fh.stat();
    let pos = 0;
    let sawMoov = false;
    const head = Buffer.alloc(16);
    for (let n = 0; n < 64 && pos + 8 <= size; n++) {
      await fh.read(head, 0, 16, pos);
      let boxSize = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      if (boxSize === 1) boxSize = Number(head.readBigUInt64BE(8));
      else if (boxSize === 0) boxSize = size - pos;
      if (type === 'moov') sawMoov = true;
      if (type === 'mdat') return sawMoov;
      if (boxSize < 8) return null;
      pos += boxSize;
    }
    return sawMoov ? true : null;
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

export async function verifyOutputFile(ffmpegPath: string, ffprobePath: string, outPath: string, plan: EditPlan): Promise<QualityReport> {
  const checks: Check[] = [];
  const add = (id: string, label: string, status: Status, detail: string) => checks.push({ id, label, status, detail });
  const finish = (): QualityReport => {
    const overall: Status = checks.some((c) => c.status === 'fail') ? 'fail' : checks.some((c) => c.status === 'warn') ? 'warn' : 'pass';
    return { overall, sources: ['deterministic'], checks };
  };

  let json: FfProbeJson | null = null;
  let size = 0;
  try {
    size = (await fs.stat(outPath)).size;
  } catch {
    add('playable', 'File is playable', 'fail', 'The exported file does not exist');
    return finish();
  }
  if (size === 0) {
    add('playable', 'File is playable', 'fail', 'The exported file is empty');
    return finish();
  }
  try {
    json = await runFfprobe(ffprobePath, outPath);
  } catch (e) {
    add('playable', 'File is playable', 'fail', `The file could not be read: ${(e as Error).message}`);
    return finish();
  }

  const v = json.streams?.find((s) => s.codec_type === 'video');
  const a = json.streams?.find((s) => s.codec_type === 'audio');
  const fmtNames = json.format?.format_name ?? '';
  const fmtDur = Number(json.format?.duration);
  const durMs = Number.isFinite(fmtDur) ? Math.round(fmtDur * 1000) : 0;
  if (!v) {
    add('playable', 'File is playable', 'fail', 'The file has no video stream');
    return finish();
  }
  if (durMs <= 0) {
    add('playable', 'File is playable', 'fail', 'The file has no duration');
    return finish();
  }

  // full decode: catches truncated / corrupt media that still has a readable header
  const dec = await capture(ffmpegPath, ['-hide_banner', '-nostdin', '-v', 'error', '-i', outPath, '-f', 'null', '-'], { timeoutMs: 5 * 60_000 }).catch(() => null);
  if (!dec) add('playable', 'File is playable', 'fail', 'Could not run the decode check');
  else if (dec.timedOut) add('playable', 'File is playable', 'warn', 'The decode check timed out');
  else if (dec.code !== 0 || dec.stderr.trim().length > 0) add('playable', 'File is playable', 'fail', `Decoding reported errors: ${dec.stderr.trim().split('\n')[0]?.slice(0, 200) || `exit code ${dec.code}`}`);
  else add('playable', 'File is playable', 'pass', `Decodes cleanly (${size} bytes)`);

  // codecs / container
  const isMp4 = /\bmp4\b/.test(fmtNames);
  const profile = v.profile ?? '';
  const pix = v.pix_fmt ?? '';
  const codecProblems: string[] = [];
  if (v.codec_name !== 'h264') codecProblems.push(`video codec is ${v.codec_name ?? 'unknown'}, expected h264`);
  if (a && a.codec_name !== 'aac') codecProblems.push(`audio codec is ${a.codec_name ?? 'unknown'}, expected aac`);
  if (!isMp4) codecProblems.push(`container is ${fmtNames || 'unknown'}, expected mp4`);
  if (pix && pix !== 'yuv420p') codecProblems.push(`pixel format is ${pix}, expected yuv420p`);
  if (codecProblems.length > 0) add('codec', 'H.264 / AAC in MP4', 'fail', codecProblems.join('; '));
  else if (profile && profile !== 'High') add('codec', 'H.264 / AAC in MP4', 'warn', `H.264 ${profile} profile (High expected); still plays everywhere`);
  else add('codec', 'H.264 / AAC in MP4', 'pass', `h264 ${profile || ''} ${pix}${a ? ' + aac' : ''} in mp4`.replace(/\s+/g, ' '));

  // dimensions (apply rotation metadata, in case anything tagged the output)
  const want = OUTPUT_FORMATS[plan.format];
  const rot = rotationOf(v);
  const w = rot === 90 || rot === 270 ? (v.height ?? 0) : (v.width ?? 0);
  const h = rot === 90 || rot === 270 ? (v.width ?? 0) : (v.height ?? 0);
  if (w === want.width && h === want.height) add('dimensions', 'Frame size', 'pass', `${w}x${h} (${plan.format})`);
  else add('dimensions', 'Frame size', 'fail', `${w}x${h}, expected ${want.width}x${want.height} for ${plan.format}`);

  // duration
  const planMs = planDurationMs(plan);
  const tol = Math.max(300, planMs * 0.02);
  const diff = Math.abs(durMs - planMs);
  if (diff <= tol) add('duration', 'Duration matches the plan', 'pass', `${(durMs / 1000).toFixed(2)} s (plan ${(planMs / 1000).toFixed(2)} s)`);
  else add('duration', 'Duration matches the plan', 'fail', `${(durMs / 1000).toFixed(2)} s but the plan calls for ${(planMs / 1000).toFixed(2)} s`);

  // audio
  const wantsAudio = plan.segments.some((s) => s.audio === 'keep' && s.volume > 0) || !!plan.audio.music;
  if (a) {
    const aDur = Number(a.duration);
    const vDur = Number(v.duration);
    if (Number.isFinite(aDur) && Number.isFinite(vDur) && Math.abs(aDur - vDur) > 0.3) add('audio', 'Audio track', 'warn', `Audio (${aDur.toFixed(2)} s) and video (${vDur.toFixed(2)} s) lengths differ by more than 0.3 s`);
    else add('audio', 'Audio track', 'pass', `${a.codec_name} audio present${wantsAudio ? '' : ' (silent track; the plan has no sound)'}`);
  } else if (wantsAudio) add('audio', 'Audio track', 'fail', 'The plan expects sound but the file has no audio stream');
  else add('audio', 'Audio track', 'pass', 'No audio expected by the plan');

  // frame rate
  const [n, d] = (v.avg_frame_rate ?? '0/1').split('/').map(Number);
  const fps = d ? (n ?? 0) / d : 0;
  if (Math.abs(fps - plan.fps) <= 0.6) add('fps', 'Frame rate', 'pass', `${fps.toFixed(2)} fps`);
  else add('fps', 'Frame rate', 'warn', `${fps.toFixed(2)} fps, plan asks for ${plan.fps}`);

  // faststart
  const fast = await moovBeforeMdat(outPath);
  if (fast === true) add('faststart', 'Starts streaming immediately', 'pass', 'moov atom is at the start of the file');
  else if (fast === false) add('faststart', 'Starts streaming immediately', 'warn', 'moov atom is at the end; the video will not play until fully downloaded');
  else add('faststart', 'Starts streaming immediately', 'warn', 'Could not determine the atom order');

  return finish();
}
