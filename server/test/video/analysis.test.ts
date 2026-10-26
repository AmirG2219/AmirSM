import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { generateAnalysisFootage, type AnalysisFootage } from '../../../scripts/make-test-footage.js';
import { technicalToClipAnalysis, type TechnicalProfile } from '../../../shared/analysis.js';
import { AnalysisError, technicalProfile } from '../../src/video/analysis.js';
import { frameTimestamps, jpegSize, sampleFrames } from '../../src/video/frames.js';
import { bins, engine } from './helpers.js';

let f: AnalysisFootage;
const eng = engine();
const profileOf = async (file: string, opts = {}): Promise<TechnicalProfile> => technicalProfile(bins.ffmpegPath, file, await eng.probe(file), opts);
const windowsIn = (p: TechnicalProfile, fromMs: number, toMs: number) => p.windows.filter((w) => w.startMs >= fromMs && w.endMs <= toMs);

beforeAll(async () => {
  f = await generateAnalysisFootage(path.join(os.tmpdir(), 'amir-sm-an-footage-video'), { reuse: true });
}, 180_000);

describe('technicalProfile (real FFmpeg, synthetic footage with known bad sections)', () => {
  it('finds the dark section and the blurred section, and leaves the good parts clean', async () => {
    const p = await profileOf(f.mixed);
    expect(p.analyzerVersion).toBe('tech-1');
    expect(p.durationMs).toBeGreaterThan(11_500);
    // dark 3-5 s
    for (const w of windowsIn(p, 3000, 5000)) {
      expect(w.issues).toContain('too_dark');
      expect(w.brightness).toBeLessThan(0.1);
      expect(w.score).toBeLessThan(0.4);
    }
    // blurred 7-9 s
    for (const w of windowsIn(p, 7000, 9000)) {
      expect(w.issues).toContain('blurry');
      expect(w.sharpness).toBeLessThan(0.2);
    }
    // good parts: 0-3, 5-7, 9-12
    for (const [a, b] of [[0, 3000], [5000, 7000], [9000, 12000]] as const) {
      for (const w of windowsIn(p, a, b)) {
        expect(w.issues.filter((i) => i !== 'static')).toEqual([]);
        expect(w.score).toBeGreaterThan(0.9);
      }
    }
    const codes = p.issues.map((i) => i.code);
    expect(codes).toContain('too_dark');
    expect(codes).toContain('blurry');
    expect(p.issues.find((i) => i.code === 'too_dark')!.ranges).toEqual([{ startMs: 3000, endMs: 5000 }]);
    expect(p.issues.find((i) => i.code === 'blurry')!.ranges).toEqual([{ startMs: 7000, endMs: 9000 }]);
  });

  it('measures audio activity: tone for 6 s, then silence', async () => {
    const p = await profileOf(f.mixed);
    expect(p.audio?.present).toBe(true);
    for (const w of windowsIn(p, 0, 5000)) expect(w.audioDb!).toBeGreaterThan(-40);
    for (const w of windowsIn(p, 7000, 12000)) expect(w.audioDb!).toBeLessThan(-60);
    expect(p.audio!.silentRatio!).toBeGreaterThan(0.4);
    expect(p.audio!.silentRatio!).toBeLessThan(0.6);
  });

  it('detects a hard scene cut near 5 s and no cut in continuous footage', async () => {
    const cut = await profileOf(f.cut);
    expect(cut.sceneChangesMs.some((t) => Math.abs(t - 5000) <= 250)).toBe(true);
    expect(cut.sceneChangesMs.filter((t) => Math.abs(t - 5000) > 500)).toEqual([]);
    expect((await profileOf(f.steady)).sceneChangesMs).toEqual([]);
    expect((await profileOf(f.hd10)).sceneChangesMs).toEqual([]);
  });

  it('flags a jittering camera as shaky and a steady one as steady (and static)', async () => {
    const shaky = await profileOf(f.shaky);
    const steady = await profileOf(f.steady);
    expect(shaky.windows.every((w) => w.issues.includes('shaky'))).toBe(true);
    expect(shaky.windows.every((w) => w.shake > 0.5)).toBe(true);
    expect(steady.windows.some((w) => w.issues.includes('shaky'))).toBe(false);
    expect(steady.windows.every((w) => w.shake < 0.05)).toBe(true);
    expect(steady.issues.map((i) => i.code)).toContain('static');
    expect(steady.score).toBeGreaterThan(shaky.score);
  });

  it('near-black footage is "too dark" only (focus/stillness cannot be judged in the dark)', async () => {
    const p = await profileOf(f.dark);
    expect(p.issues.map((i) => i.code)).toEqual(['too_dark']);
    expect(p.issues[0]!.share).toBe(1);
    expect(p.score).toBeLessThan(0.4);
  });

  it('handles clips without audio, tiny clips and rotation metadata', async () => {
    const noAudio = await profileOf(f.cut);
    expect(noAudio.audio).toBeNull();
    expect(noAudio.windows.every((w) => w.audioDb === null)).toBe(true);

    const tiny = await profileOf(f.tiny);
    expect(tiny.windows).toHaveLength(1);
    expect(tiny.windows[0]!.startMs).toBe(0);
    expect(tiny.windows[0]!.endMs).toBeGreaterThan(500);

    const info = await eng.probe(f.rotated);
    expect(info.displayHeight).toBeGreaterThan(info.displayWidth); // stored 640x360, displays portrait
    const rot = await profileOf(f.rotated);
    expect(rot.windows.length).toBeGreaterThanOrEqual(4);
    expect(rot.windows.every((w) => w.brightness > 0.3 && w.brightness < 0.7)).toBe(true);
    expect(rot.issues.filter((i) => i.code !== 'static')).toEqual([]);
  });

  it('windows are ~1 s, contiguous, cover the clip, and all numbers are in range', async () => {
    const p = await profileOf(f.mixed);
    expect(p.windows[0]!.startMs).toBe(0);
    for (let i = 1; i < p.windows.length; i++) expect(p.windows[i]!.startMs).toBe(p.windows[i - 1]!.endMs);
    expect(p.windows.at(-1)!.endMs).toBe(p.analyzedMs);
    for (const w of p.windows) {
      expect(w.endMs - w.startMs).toBeLessThanOrEqual(1500);
      for (const v of [w.brightness, w.contrast, w.sharpness, w.motion, w.shake, w.score]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('is fast: a 10 s 1080x1920 clip with audio is analysed in a few seconds at most', async () => {
    const info = await eng.probe(f.hd10);
    expect(info.displayWidth).toBe(1080);
    await technicalProfile(bins.ffmpegPath, f.hd10, info); // warm file cache / process start
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      await technicalProfile(bins.ffmpegPath, f.hd10, info);
      times.push(performance.now() - t0);
    }
    const best = Math.min(...times);
    console.log(`[timing] technicalProfile 10 s 1080x1920 H.264 + audio: ${times.map((t) => Math.round(t)).join(' / ')} ms`);
    expect(best).toBeLessThan(4000); // target is ~1-2 s; the bound is loose so slow CI machines do not flake
  });

  it('rejects clearly: no video stream, missing file, cancelled', async () => {
    const info = await eng.probe(f.mixed);
    await expect(technicalProfile(bins.ffmpegPath, f.mixed, { ...info, hasVideo: false })).rejects.toBeInstanceOf(AnalysisError);
    await expect(technicalProfile(bins.ffmpegPath, path.join(os.tmpdir(), 'does-not-exist.mp4'), info)).rejects.toBeInstanceOf(AnalysisError);
    const ac = new AbortController();
    ac.abort();
    await expect(technicalProfile(bins.ffmpegPath, f.mixed, info, { signal: ac.signal })).rejects.toThrow(/cancel/i);
  });

  it('converts to the common ClipAnalysis shape without claiming anything about content', async () => {
    const p = await profileOf(f.mixed);
    const a = technicalToClipAnalysis('asset1', p);
    expect(a.source).toBe('technical');
    expect(a.summary).toBeUndefined();
    expect(a.tags).toEqual([]);
    expect(a.moments.length).toBeGreaterThan(0);
    expect(a.moments.every((m) => m.description.includes('content is unknown'))).toBe(true);
    expect(a.technical).toBeDefined();
  });
});

describe('sampleFrames (real FFmpeg)', () => {
  it('frameTimestamps are the midpoints of equal slices', () => {
    expect(frameTimestamps(10_000, 5)).toEqual([1000, 3000, 5000, 7000, 9000]);
    expect(frameTimestamps(600, 4)).toEqual([75, 225, 375, 525]);
    expect(frameTimestamps(0, 3)).toEqual([0, 0, 0]);
  });

  it('returns the requested number of evenly spaced JPEGs, long edge <= 768, never upscaled', async () => {
    const info = await eng.probe(f.hd10);
    const frames = await sampleFrames(bins.ffmpegPath, f.hd10, info, { count: 6 });
    expect(frames.map((x) => x.timeMs)).toEqual(frameTimestamps(info.durationMs, 6));
    for (const fr of frames) {
      expect(fr.mediaType).toBe('image/jpeg');
      const buf = Buffer.from(fr.data, 'base64');
      expect(buf.subarray(0, 3).toString('hex')).toBe('ffd8ff');
      expect(buf.length).toBe(fr.bytes);
      expect(jpegSize(buf)).toEqual({ width: fr.width, height: fr.height });
      expect(Math.max(fr.width, fr.height)).toBe(768);
      expect(fr.width).toBe(432); // 1080x1920 -> 432x768
      expect(fr.bytes).toBeLessThan(400_000);
    }
    // frames really come from different times
    expect(new Set(frames.map((x) => crypto.createHash('md5').update(x.data).digest('hex'))).size).toBe(6);

    const small = await sampleFrames(bins.ffmpegPath, f.tiny, await eng.probe(f.tiny), { count: 4 });
    expect(small).toHaveLength(4);
    expect(small.every((x) => x.width === 270 && x.height === 480)).toBe(true); // not upscaled
  });

  it('applies rotation metadata (stored 640x360 comes out portrait) and respects a custom long edge', async () => {
    const info = await eng.probe(f.rotated);
    const frames = await sampleFrames(bins.ffmpegPath, f.rotated, info, { count: 3, longEdge: 320 });
    expect(frames).toHaveLength(3);
    for (const fr of frames) {
      expect(fr.height).toBeGreaterThan(fr.width);
      expect(Math.max(fr.width, fr.height)).toBeLessThanOrEqual(320);
    }
  });

  it('returns [] for files without video and honours cancellation', async () => {
    const info = await eng.probe(f.mixed);
    expect(await sampleFrames(bins.ffmpegPath, f.mixed, { ...info, hasVideo: false })).toEqual([]);
    const ac = new AbortController();
    ac.abort();
    expect(await sampleFrames(bins.ffmpegPath, f.mixed, info, { count: 3, signal: ac.signal })).toEqual([]);
  });

  it('jpegSize rejects non-JPEG data', () => {
    expect(jpegSize(Buffer.from('not a jpeg at all'))).toBeNull();
  });
});
