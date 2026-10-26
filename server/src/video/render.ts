/** Executes an EditPlan with ffmpeg. */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { RenderCancelled, RenderError, type PlanAsset, type RenderRequest, type RenderResult } from './types.js';
import { buildGraph, type BuiltGraph, type GraphCaps } from './filtergraph.js';
import { runFfmpeg, capture } from './ffmpeg-run.js';
import { runFfprobe, mediaInfoFromProbe } from './probe.js';
import type { FontLibrary } from './fonts.js';
import { validatePlan } from './validate.js';
import { buildTimeline } from './timeline.js';

export interface RenderDeps {
  ffmpegPath: string;
  ffprobePath: string;
  fonts: FontLibrary;
  preset: string;
  crf: number;
  timeoutMs: number;
}

const TRANSIENT = /no space left|not enough space|cannot allocate memory|out of memory|insufficient memory|resource temporarily unavailable|input\/output error|i\/o error|permission denied|device or resource busy|being used by another process|broken pipe|connection reset|timed out/i;

/** Decide whether re-running the same render could plausibly succeed. */
export function isRetryableFailure(code: number | null, signal: NodeJS.Signals | null, stderr: string, timedOut: boolean): boolean {
  if (timedOut) return true;
  if (TRANSIENT.test(stderr)) return true;
  if (signal) return true; // killed by the OS (OOM killer, task manager, ...)
  if (code === null) return true;
  // Windows crash / fatal NTSTATUS codes (0xC0000005 etc.) show up as large or negative exit codes
  if (code < 0 || code >= 0xc0000000) return true;
  return false;
}

function humanizeFailure(stderr: string): string {
  const s = stderr;
  if (/moov atom not found|invalid data found when processing input/i.test(s)) return 'A source video file is damaged or incomplete and could not be read';
  if (/no such file or directory|could not open|does not exist/i.test(s)) return 'A source file could not be opened';
  if (/no space left|not enough space/i.test(s)) return 'The disk is full';
  if (/error (?:initializing|reinitializing) (?:complex )?filter|error parsing|no such filter|invalid argument|cannot find a matching stream|failed to configure/i.test(s)) return 'ffmpeg could not build the edit (internal filter error)';
  if (/out of memory|cannot allocate memory/i.test(s)) return 'ffmpeg ran out of memory';
  return 'ffmpeg failed while rendering';
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  let lastErr: unknown;
  for (let i = 0; i < 6; i++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (e) {
      lastErr = e;
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') break;
      await new Promise((r) => setTimeout(r, 150 * (i + 1)));
    }
  }
  throw lastErr;
}

async function amixSupportsNormalize(ffmpegPath: string): Promise<boolean> {
  try {
    const r = await capture(ffmpegPath, ['-hide_banner', '-h', 'filter=amix'], { timeoutMs: 15_000 });
    return /\bnormalize\b/.test(r.stdout + r.stderr);
  } catch {
    return false;
  }
}
const capsCache: Map<string, Promise<boolean>> = new Map();

function summarizeArgs(args: string[], inputs: BuiltGraph['inputs'], inputPaths: string[], output: string): string {
  const redacted = args.map((a) => {
    if (a === output) return '<output.mp4>';
    const idx = inputPaths.indexOf(a);
    return idx >= 0 ? `<asset:${inputs[idx]!.assetId}>` : a;
  });
  return ['ffmpeg', ...redacted.map((a) => (/[\s'"]/.test(a) ? JSON.stringify(a) : a))].join(' ');
}

export async function renderPlan(deps: RenderDeps, req: RenderRequest): Promise<RenderResult> {
  const { plan, assets, outPath, workDir, onProgress, signal } = req;
  if (signal?.aborted) throw new RenderCancelled();

  const check = validatePlan(plan, assets, { fontAvailable: await deps.fonts.available() });
  if (!check.ok) throw new RenderError(`The edit plan is not valid: ${check.errors.join('; ')}`, '', false);
  const warnings = [...check.warnings];

  // never write over a source asset
  const absOut = path.resolve(outPath);
  for (const a of assets.values()) {
    if (path.resolve(a.path).toLowerCase() === absOut.toLowerCase()) throw new RenderError('Refusing to write the render over a source asset', '', false);
  }
  // all referenced sources must exist right now
  const usedIds = new Set<string>([...plan.segments.map((s) => s.assetId), ...(plan.audio.music ? [plan.audio.music.assetId] : [])]);
  for (const id of usedIds) {
    const a: PlanAsset = assets.get(id)!;
    try {
      await fs.access(a.path);
    } catch {
      throw new RenderError(`Source file for asset "${id}" is missing on disk`, '', false);
    }
  }

  let progress = -1;
  const emit = (f: number, msg: string) => {
    const q = Math.round(Math.min(1, Math.max(0, f)) * 100) / 100;
    if (q === progress) return;
    progress = q;
    try {
      onProgress?.(q, msg);
    } catch {
      /* a failing progress listener must not break the render */
    }
  };

  const partial = `${outPath}.partial.mp4`;
  await fs.mkdir(path.dirname(absOut), { recursive: true });
  await fs.mkdir(workDir, { recursive: true });
  const scratch = await fs.mkdtemp(path.join(workDir, `render-${crypto.randomBytes(3).toString('hex')}-`));
  const cleanup = async () => {
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  };
  const cleanupPartial = async () => {
    await fs.rm(partial, { force: true }).catch(() => undefined);
  };

  try {
    emit(0, 'Preparing edit');
    let amix = capsCache.get(deps.ffmpegPath);
    if (!amix) {
      amix = amixSupportsNormalize(deps.ffmpegPath);
      capsCache.set(deps.ffmpegPath, amix);
    }
    const caps: GraphCaps = { amixNormalize: await amix };
    const built = await buildGraph(plan, assets, deps.fonts, caps);
    warnings.push(...built.warnings);

    for (const f of built.files) {
      const dest = path.join(scratch, f.name);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      if (f.copyFrom) await fs.copyFile(f.copyFrom, dest);
      else await fs.writeFile(dest, f.text ?? '', 'utf8');
    }
    await fs.writeFile(path.join(scratch, 'filtergraph.txt'), built.graph, 'utf8');

    const tl = buildTimeline(plan);
    const args: string[] = ['-y'];
    const inputPaths: string[] = [];
    for (const inp of built.inputs) {
      if (inp.loop) args.push('-stream_loop', '-1');
      if (inp.seekSec !== undefined) args.push('-ss', inp.seekSec.toFixed(3));
      if (inp.durSec !== undefined) args.push('-t', inp.durSec.toFixed(3));
      args.push('-i', inp.path);
      inputPaths.push(inp.path);
    }
    args.push(
      '-filter_complex_script', 'filtergraph.txt',
      '-map', '[vout]', '-map', '[aout]',
      '-map_metadata', '-1', '-map_chapters', '-1',
      '-c:v', 'libx264', '-preset', deps.preset, '-crf', String(deps.crf), '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-r', String(tl.fps),
      '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
      '-movflags', '+faststart',
      '-f', 'mp4',
      partial,
    );

    // The scratch dir is the cwd, so the graph only uses short relative names. Fontconfig is given a tiny private
    // config so libass starts instantly and never scans (or writes caches into) the system font folders.
    const fcConf = path.join(scratch, 'fonts.conf');
    const fontDirAbs = path.join(scratch, 'fonts');
    const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    await fs.writeFile(fcConf, `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig><dir>${xmlEsc(fontDirAbs)}</dir><cachedir>${xmlEsc(path.join(scratch, 'fccache'))}</cachedir></fontconfig>\n`, 'utf8');
    const env = { ...process.env, FONTCONFIG_FILE: fcConf, FONTCONFIG_PATH: scratch };

    const commandSummary = [summarizeArgs(args, built.inputs, inputPaths, partial), `filtergraph:\n${built.graph}`];

    emit(0.01, 'Rendering');
    let res;
    try {
      res = await runFfmpeg(deps.ffmpegPath, args, {
        cwd: scratch,
        env,
        signal,
        expectedSeconds: built.totalSeconds,
        timeoutMs: deps.timeoutMs,
        onFraction: (f) => emit(0.01 + f * 0.96, `Rendering ${Math.round(f * 100)}%`),
      });
    } catch (e) {
      throw new RenderError(`Could not start ffmpeg: ${(e as Error).message}`, '', false);
    }
    if (res.aborted || signal?.aborted) {
      await cleanupPartial();
      throw new RenderCancelled();
    }
    if (res.code !== 0) {
      await cleanupPartial();
      const retryable = isRetryableFailure(res.code, res.signal, res.stderrTail, res.timedOut);
      const base = res.timedOut ? 'Rendering took too long and was stopped' : humanizeFailure(res.stderrTail);
      throw new RenderError(base, res.stderrTail, retryable);
    }

    emit(0.98, 'Finalizing');
    let st;
    try {
      st = await fs.stat(partial);
    } catch {
      throw new RenderError('ffmpeg finished but produced no file', res.stderrTail, true);
    }
    if (st.size === 0) {
      await cleanupPartial();
      throw new RenderError('ffmpeg produced an empty file', res.stderrTail, true);
    }
    if (signal?.aborted) {
      await cleanupPartial();
      throw new RenderCancelled();
    }
    let info;
    try {
      info = mediaInfoFromProbe(await runFfprobe(deps.ffprobePath, partial), partial, st.size);
    } catch (e) {
      await cleanupPartial();
      throw new RenderError(`The rendered file could not be read back: ${(e as Error).message}`, res.stderrTail, true);
    }
    try {
      await renameWithRetry(partial, outPath);
    } catch (e) {
      await cleanupPartial();
      throw new RenderError(`Could not save the render to ${path.basename(outPath)}: ${(e as Error).message}`, '', true);
    }
    emit(1, 'Done');
    return {
      outPath,
      durationMs: info.durationMs,
      sizeBytes: st.size,
      width: info.displayWidth,
      height: info.displayHeight,
      warnings,
      commandSummary,
    };
  } catch (e) {
    if (!(e instanceof RenderError) && !(e instanceof RenderCancelled)) {
      await cleanupPartial();
      throw new RenderError(`Unexpected error while preparing the render: ${(e as Error).message}`, '', false);
    }
    throw e;
  } finally {
    await cleanup();
  }
}
