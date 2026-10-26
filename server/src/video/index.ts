/**
 * Video engine: probe, thumbnail, validate, render (EditPlan -> H.264/AAC MP4 via ffmpeg) and verify.
 * See ./types.ts for the contract with the orchestrator.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { EditPlan } from '../../../shared/editPlan.js';
import type { MediaInfo, QualityReport } from '../../../shared/domain.js';
import { RenderError, type PlanAsset, type RenderRequest, type RenderResult, type VideoEngine } from './types.js';
import { resolveBinaries } from './binaries.js';
import { capture } from './ffmpeg-run.js';
import { probeFile, ProbeError } from './probe.js';
import { validatePlan } from './validate.js';
import { renderPlan } from './render.js';
import { verifyOutputFile } from './verify.js';
import { FontLibrary } from './fonts.js';
import { technicalProfile } from './analysis.js';
import { sampleFrames } from './frames.js';

export { resolveBinaries } from './binaries.js';
export { RenderError, RenderCancelled } from './types.js';
export type { VideoEngine, PlanAsset, RenderRequest, RenderResult } from './types.js';
export { ProbeError } from './probe.js';
export { buildTimeline } from './timeline.js';
export { technicalProfile, AnalysisError } from './analysis.js';
export { sampleFrames, frameTimestamps, jpegSize } from './frames.js';

export interface VideoEngineOptions {
  ffmpegPath: string;
  ffprobePath: string;
  /** Font for titles/subtitles. Falls back to env AMIR_FONT_FILE / VIDEO_FONT_FILE, then common system fonts. */
  fontFile?: string;
  /** x264 preset (default "veryfast"); tests use "ultrafast" */
  preset?: string;
  /** x264 CRF (default 20) */
  crf?: number;
  /** false = only use fontFile / env font, never scan system font folders (default true) */
  systemFonts?: boolean;
  /** hard cap on one ffmpeg render (default 30 min) */
  renderTimeoutMs?: number;
}

export function createVideoEngine(opts: VideoEngineOptions): VideoEngine & { fontReport(): Promise<{ available: boolean; primary: string | null }> } {
  const { ffmpegPath, ffprobePath } = opts;
  const explicitFont = opts.fontFile || process.env.AMIR_FONT_FILE || process.env.VIDEO_FONT_FILE || null;
  const fonts = new FontLibrary(explicitFont, process.platform, opts.systemFonts ?? true);
  const deps = { ffmpegPath, ffprobePath, fonts, preset: opts.preset ?? 'veryfast', crf: opts.crf ?? 20, timeoutMs: opts.renderTimeoutMs ?? 30 * 60_000 };

  // validatePlan is synchronous by contract; font availability is resolved in the background at creation
  let fontOk: boolean | undefined;
  void fonts.available().then((v) => { fontOk = v; }, () => { fontOk = false; });

  let healthCache: Awaited<ReturnType<VideoEngine['health']>> | null = null;

  return {
    async health() {
      if (healthCache?.ok) return healthCache;
      const filters = { drawtext: false, subtitles: false, xfade: false };
      try {
        const ver = await capture(ffmpegPath, ['-hide_banner', '-version'], { timeoutMs: 15_000 });
        if (ver.code !== 0) return { ok: false, filters, detail: `ffmpeg exited with code ${ver.code}: ${ver.stderr.slice(0, 200)}` };
        const ffmpegVersion = /version\s+(\S+)/.exec(ver.stdout)?.[1];
        const list = await capture(ffmpegPath, ['-hide_banner', '-filters'], { timeoutMs: 15_000 });
        filters.drawtext = /\sdrawtext\s/.test(list.stdout);
        filters.subtitles = /\sass\s/.test(list.stdout) || /\ssubtitles\s/.test(list.stdout);
        filters.xfade = /\sxfade\s/.test(list.stdout);
        const enc = await capture(ffmpegPath, ['-hide_banner', '-encoders'], { timeoutMs: 15_000 });
        const missing: string[] = [];
        if (!/\slibx264\s/.test(enc.stdout)) missing.push('libx264 encoder');
        if (!/\saac\s/.test(enc.stdout)) missing.push('aac encoder');
        if (!filters.xfade) missing.push('xfade filter');
        const probeOk = (await capture(ffprobePath, ['-version'], { timeoutMs: 15_000 }).catch(() => null))?.code === 0;
        if (!probeOk) missing.push('ffprobe');
        const notes: string[] = [];
        if (missing.length) notes.push(`missing: ${missing.join(', ')}`);
        if (!filters.drawtext) notes.push('no drawtext (titles unavailable)');
        if (!filters.subtitles) notes.push('no libass (subtitles unavailable)');
        const res = { ok: missing.length === 0, ffmpegVersion, filters, detail: notes.length ? notes.join('; ') : undefined };
        if (res.ok) healthCache = res;
        return res;
      } catch (e) {
        return { ok: false, filters, detail: `Cannot run ffmpeg at "${ffmpegPath}": ${(e as Error).message}` };
      }
    },

    probe(filePath: string): Promise<MediaInfo> {
      return probeFile(ffprobePath, filePath);
    },

    async thumbnail(srcPath: string, destJpg: string, atMs?: number): Promise<void> {
      const info = await probeFile(ffprobePath, srcPath);
      if (!info.hasVideo) throw new ProbeError('This file has no video to take a thumbnail from');
      const at = atMs !== undefined ? Math.max(0, Math.min(atMs, Math.max(0, info.durationMs - 100))) : Math.min(1000, Math.round(info.durationMs * 0.1));
      await fs.mkdir(path.dirname(destJpg), { recursive: true });
      const tmp = `${destJpg}.partial.jpg`;
      const attempt = async (t: number) => {
        await fs.rm(tmp, { force: true });
        const r = await capture(ffmpegPath, ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-ss', (t / 1000).toFixed(3), '-i', srcPath, '-frames:v', '1', '-vf', "scale='min(720,iw)':-2", '-q:v', '3', '-f', 'image2', tmp], { timeoutMs: 60_000 });
        if (r.code !== 0) return false;
        try {
          return (await fs.stat(tmp)).size > 0;
        } catch {
          return false;
        }
      };
      const ok = (await attempt(at)) || (at > 0 && (await attempt(0)));
      if (!ok) {
        await fs.rm(tmp, { force: true });
        throw new Error('Could not extract a thumbnail frame from this video');
      }
      await fs.rename(tmp, destJpg);
    },

    validatePlan(plan: EditPlan, assets: Map<string, PlanAsset>) {
      // font availability is async; validatePlan is sync by contract, so use the cached answer when known
      return validatePlan(plan, assets, { fontAvailable: fontOk });
    },

    render(req: RenderRequest): Promise<RenderResult> {
      return renderPlan(deps, req).catch((e) => {
        if (e instanceof RenderError || (e as Error).name === 'RenderCancelled') throw e;
        throw new RenderError(`Render failed: ${(e as Error).message}`, '', false);
      });
    },

    technicalProfile(filePath, info, o) {
      return technicalProfile(ffmpegPath, filePath, info, o);
    },

    sampleFrames(filePath, info, o) {
      return sampleFrames(ffmpegPath, filePath, info, o);
    },

    verifyOutput(outPath: string, plan: EditPlan): Promise<QualityReport> {
      return verifyOutputFile(ffmpegPath, ffprobePath, outPath, plan);
    },

    async fontReport() {
      const p = await fonts.primary();
      return { available: p !== null, primary: p?.file ?? null };
    },
  };
}
