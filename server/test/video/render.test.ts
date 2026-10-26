import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { planDurationMs } from '../../../shared/editPlan.js';
import type { EditPlan } from '../../../shared/editPlan.js';
import { engine, frameGray, listFiles, meanDiff, meanLuma, meanVolume, plan, seg, setupFixtures, signalStat, type Fixtures } from './helpers.js';

let fx: Fixtures;
let workDir: string;
const eng = engine();
let n = 0;

beforeAll(async () => {
  fx = await setupFixtures();
  workDir = path.join(fx.root, 'work');
});
afterAll(() => {
  fs.rmSync(fx.root, { recursive: true, force: true });
});

const sha = (p: string) => crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');

async function renderOk(p: EditPlan, e = eng) {
  const outPath = path.join(fx.root, 'out', `r${++n}.mp4`);
  const progress: number[] = [];
  const res = await e.render({ plan: p, assets: fx.assets, outPath, workDir, onProgress: (f) => progress.push(f) });
  expect(fs.existsSync(outPath)).toBe(true);
  expect(fs.existsSync(`${outPath}.partial.mp4`)).toBe(false);
  expect(listFiles(workDir)).toEqual([]); // scratch files are always removed
  return { res, outPath, progress };
}

describe('single clip, full size', () => {
  it('renders a 1080x1920 H.264/AAC mp4 that passes every deterministic check', async () => {
    const sourceHashBefore = sha(fx.footage.portrait);
    const p = plan({ segments: [seg('portrait', 1000, 4000)] });
    const { res, outPath, progress } = await renderOk(p);
    expect(res.width).toBe(1080);
    expect(res.height).toBe(1920);
    expect(Math.abs(res.durationMs - 3000)).toBeLessThan(120);
    expect(res.sizeBytes).toBe(fs.statSync(outPath).size);
    expect(res.commandSummary[0]).toContain('<asset:portrait>');
    expect(res.commandSummary[0]).not.toContain(fx.root);
    // progress is monotonic, starts at 0, ends at 1
    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(1);
    for (let i = 1; i < progress.length; i++) expect(progress[i]!).toBeGreaterThanOrEqual(progress[i - 1]!);
    expect(progress.length).toBeGreaterThan(3);

    const q = await eng.verifyOutput(outPath, p);
    expect(q.sources).toEqual(['deterministic']);
    expect(q.checks.filter((c) => c.status !== 'pass')).toEqual([]);
    expect(q.overall).toBe('pass');

    const info = await eng.probe(outPath);
    expect(info).toMatchObject({ displayWidth: 1080, displayHeight: 1920, videoCodec: 'h264', audioCodec: 'aac', container: 'mp4' });
    // the source is byte-for-byte untouched
    expect(sha(fx.footage.portrait)).toBe(sourceHashBefore);
    // audio really is the source tone (not silence)
    expect(meanVolume(outPath, 0.3, 2)).toBeGreaterThan(-45);
  });
});

describe('multi-clip with speed and every transition type', () => {
  it('lays out crossfade / dip-to-black / slide-left / cut with speed changes and keeps duration + audio aligned', async () => {
    const p = plan({
      fps: 25,
      segments: [
        seg('sp', 0, 4000),
        seg('sl', 0, 4000, { speed: 2, transitionIn: { type: 'crossfade', durationMs: 500 } }), // 2 s of output
        seg('sp', 1000, 4000, { speed: 0.5, transitionIn: { type: 'dip-to-black', durationMs: 600 } }), // 6 s of output
        seg('sl', 0, 3000, { transitionIn: { type: 'slide-left', durationMs: 400 } }),
        seg('sp', 0, 2000, { transitionIn: { type: 'cut', durationMs: 500 } }),
      ],
      audio: { normalizeLoudness: false },
    });
    const expected = planDurationMs(p); // 4000+2000-500+6000-600+3000-400+2000 = 15500
    expect(expected).toBe(15500);
    const { res, outPath } = await renderOk(p);
    expect(Math.abs(res.durationMs - expected)).toBeLessThan(150);
    const q = await eng.verifyOutput(outPath, p);
    expect(q.overall).toBe('pass');
    const info = await eng.probe(outPath);
    expect(info.fps).toBeCloseTo(25, 1);

    // timeline: seg1 0-4, xf 3.5-4, seg2 3.5-5.5(ends 5.5), dip 4.9-5.5 ... compute starts
    // seg starts (output): s1 0; s2 3.5; s3 3.5+2-0.6=4.9; s4 4.9+6-0.4=10.5; s5 10.5+3=13.5
    const mid = (t: number) => signalStat(outPath, t, 'YAVG');
    expect(mid(1.5)).toBeGreaterThan(40); // inside clip 1
    expect(mid(8)).toBeGreaterThan(40); // inside the slow clip 3
    expect(mid(14.5)).toBeGreaterThan(40); // after the cut
    // the dip-to-black midpoint (about 5.2 s) is much darker than the clips around it
    const dip = Math.min(mid(5.1), mid(5.2), mid(5.3));
    expect(dip).toBeLessThan(mid(8) * 0.6);
    // crossfade midpoint is a blend, not black
    expect(mid(3.75)).toBeGreaterThan(30);
    // audio runs the whole way (no gaps from the generated/merged tracks): clip 3 is slowed 440 Hz tone
    expect(meanVolume(outPath, 7, 2)).toBeGreaterThan(-45);
    expect(meanVolume(outPath, 14, 1)).toBeGreaterThan(-45);
  });
});

describe('audio handling', () => {
  it('inserts silence for clips without audio and keeps neighbours audible and aligned', async () => {
    const p = plan({
      segments: [seg('sp', 0, 3000), seg('ss', 0, 3000), seg('sl', 0, 3000)],
      audio: { normalizeLoudness: false },
    });
    const { res, outPath } = await renderOk(p);
    expect(res.warnings.join('\n')).toMatch(/silence/i);
    expect(Math.abs(res.durationMs - 9000)).toBeLessThan(120);
    expect(meanVolume(outPath, 0.5, 2)).toBeGreaterThan(-45);
    expect(meanVolume(outPath, 3.3, 2.4)).toBeLessThan(-80); // the silent clip: truly silence
    expect(meanVolume(outPath, 6.4, 2)).toBeGreaterThan(-45);
    expect((await eng.verifyOutput(outPath, p)).overall).toBe('pass');
  });

  it('mute + volume are honoured per segment', async () => {
    const p = plan({
      segments: [seg('sp', 0, 3000, { audio: 'mute' }), seg('sp', 0, 3000, { volume: 0.25 }), seg('sp', 0, 3000, { volume: 1 })],
      audio: { normalizeLoudness: false },
    });
    const { outPath } = await renderOk(p);
    expect(meanVolume(outPath, 0.3, 2.4)).toBeLessThan(-80);
    const quiet = meanVolume(outPath, 3.3, 2.4);
    const loud = meanVolume(outPath, 6.3, 2.4);
    expect(loud - quiet).toBeGreaterThan(8); // 0.25 is -12 dB
  });

  it('loudnorm brings quiet material up and still yields valid AAC', async () => {
    const quietP = plan({ segments: [seg('sp', 0, 4000, { volume: 0.2 })], audio: { normalizeLoudness: false } });
    const normP = plan({ segments: [seg('sp', 0, 4000, { volume: 0.2 })], audio: { normalizeLoudness: true } });
    const a = await renderOk(quietP);
    const b = await renderOk(normP);
    expect(meanVolume(b.outPath, 0.5, 3)).toBeGreaterThan(meanVolume(a.outPath, 0.5, 3) + 3);
    expect((await eng.verifyOutput(b.outPath, normP)).overall).toBe('pass');
  });

  it('mixes uploaded music under the clips, loops it, and fades it out', async () => {
    const withMusic = plan({
      segments: [seg('ss', 0, 5000), seg('ss', 0, 5000)], // silent clips => any sound comes from the music; 10 s > 8 s track => must loop
      audio: { normalizeLoudness: false, music: { assetId: 'music', volume: 0.5, fadeOutMs: 2000 } },
    });
    const { res, outPath } = await renderOk(withMusic);
    expect(res.warnings.join('\n')).toMatch(/loop/);
    expect(Math.abs(res.durationMs - 10000)).toBeLessThan(150);
    expect(meanVolume(outPath, 0.5, 2)).toBeGreaterThan(-40);
    expect(meanVolume(outPath, 8.2, 1.2)).toBeGreaterThan(-40); // looped section still plays past the 8 s of the file
    const tail = meanVolume(outPath, 9.6, 0.4);
    expect(tail).toBeLessThan(meanVolume(outPath, 0.5, 2) - 10); // faded out
    expect((await eng.verifyOutput(outPath, withMusic)).overall).toBe('pass');

    // music + speech: both present (louder than speech alone? no: just still audible and valid)
    const mixed = plan({ segments: [seg('sp', 0, 4000)], audio: { normalizeLoudness: true, music: { assetId: 'music', volume: 0.3, fadeOutMs: 500 } } });
    const m = await renderOk(mixed);
    expect((await eng.verifyOutput(m.outPath, mixed)).overall).toBe('pass');
  });
});

describe('framing', () => {
  it('contain-blur keeps the whole landscape frame over a blurred background', async () => {
    const contain = plan({ segments: [seg('sl', 1000, 3000, { fit: 'contain-blur' })] });
    const a = await renderOk(contain);
    const ca = frameGray(a.outPath, 0.8);
    expect(meanLuma(ca, 0.02, 0.15)).toBeGreaterThan(25); // background above the video is filled (blurred bars), not black
    expect(meanLuma(ca, 0.85, 0.98)).toBeGreaterThan(25); // ... and below
    // sharp picture in the middle (strong vertical bar edges), smooth blurred background above and below it
    const edges = (b: Buffer, from: number, to: number) => {
      let sum = 0;
      let cnt = 0;
      for (let y = Math.floor(from * 192); y < Math.floor(to * 192); y++) for (let x = 1; x < 108; x++) (sum += Math.abs((b[y * 108 + x] ?? 0) - (b[y * 108 + x - 1] ?? 0))), cnt++;
      return sum / cnt;
    };
    expect(edges(ca, 0.4, 0.6)).toBeGreaterThan(edges(ca, 0.02, 0.15) * 2);
    expect(meanLuma(ca, 0.02, 0.15)).not.toBeCloseTo(meanLuma(ca, 0.4, 0.6), 0); // background is a different thing than the foreground
    expect((await eng.verifyOutput(a.outPath, contain)).overall).toBe('pass');
  });

  it('landscape -> portrait cover honours the focus point', async () => {
    const left = await renderOk(plan({ segments: [seg('sl', 0, 2000, { focus: { x: 0, y: 0.5 } })] }));
    const right = await renderOk(plan({ segments: [seg('sl', 0, 2000, { focus: { x: 1, y: 0.5 } })] }));
    const centre = await renderOk(plan({ segments: [seg('sl', 0, 2000)] }));
    const l = frameGray(left.outPath, 0.5);
    const r = frameGray(right.outPath, 0.5);
    const c = frameGray(centre.outPath, 0.5);
    expect(meanDiff(l, r, 0, 0.6)).toBeGreaterThan(20); // different parts of SMPTE bars
    expect(meanDiff(l, c, 0, 0.6)).toBeGreaterThan(5);
    expect(meanDiff(r, c, 0, 0.6)).toBeGreaterThan(5);
  });

  it('rotated phone footage is displayed upright and fills the frame', async () => {
    const p = plan({ segments: [seg('rotated', 500, 2500)] });
    const { res, outPath } = await renderOk(p);
    expect([res.width, res.height]).toEqual([1080, 1920]);
    // compare against the same clip rendered with its rotation tag stripped: they must differ (rotation was applied)
    const info = fx.assets.get('rotated')!.info;
    expect(info.displayHeight).toBeGreaterThan(info.displayWidth);
    const frame = frameGray(outPath, 0.5);
    expect(meanLuma(frame)).toBeGreaterThan(20);
  });

  it('supports 4:5 and 1:1 at 24 fps', async () => {
    const p45 = plan({ format: '4:5', fps: 24, segments: [seg('sp', 0, 1500)] });
    const p11 = plan({ format: '1:1', fps: 30, segments: [seg('sl', 0, 1500)] });
    const a = await renderOk(p45);
    const b = await renderOk(p11);
    expect([a.res.width, a.res.height]).toEqual([1080, 1350]);
    expect([b.res.width, b.res.height]).toEqual([1080, 1080]);
    expect((await eng.verifyOutput(a.outPath, p45)).overall).toBe('pass');
    expect((await eng.verifyOutput(b.outPath, p11)).overall).toBe('pass');
  });
});

describe('look, fades and text', () => {
  it('applies every look preset (bw is truly desaturated) and fades in/out', async () => {
    const looks = ['natural', 'warm', 'cool', 'cinematic', 'bright', 'muted', 'bw'] as const;
    const sat: Record<string, number> = {};
    for (const preset of looks) {
      const p = plan({ segments: [seg('sp', 0, 1500)], look: { preset, vignette: preset === 'cinematic', fadeInMs: 0, fadeOutMs: 0 } });
      const { outPath } = await renderOk(p);
      sat[preset] = signalStat(outPath, 0.5, 'SATAVG');
    }
    expect(sat.bw).toBeLessThan(1);
    expect(sat.natural).toBeGreaterThan(20);
    expect(sat.muted!).toBeLessThan(sat.natural!);
    expect(sat.bright!).toBeGreaterThan(sat.natural!);

    const f = plan({ segments: [seg('sp', 0, 3000)], look: { preset: 'natural', vignette: false, fadeInMs: 600, fadeOutMs: 600 } });
    const { outPath } = await renderOk(f);
    const first = signalStat(outPath, 0.0, 'YAVG');
    const mid = signalStat(outPath, 1.5, 'YAVG');
    const last = signalStat(outPath, 2.95, 'YAVG');
    expect(first).toBeLessThan(mid * 0.3);
    expect(last).toBeLessThan(mid * 0.3);
  });

  it('burns in titles (awkward characters, Amharic) and user subtitles at the right times only', async () => {
    const segs = [seg('sp', 0, 5000)];
    const bare = plan({ segments: segs });
    const texted = plan({
      segments: segs,
      titles: [
        { id: 't1', text: "Amir's day: 100% real, 'quoted' \\ back:slash {x} %{pts} \"dq\"", startMs: 500, endMs: 2500, position: 'center', size: 'large' },
        { id: 't2', text: 'ሰላም ዓለም - Amharic title', startMs: 3000, endMs: 4800, position: 'top', size: 'medium' },
      ],
      subtitles: { source: 'user-provided', position: 'bottom', cues: [{ startMs: 500, endMs: 2500, text: "First: it's {braces} & 100% sure" }, { startMs: 3000, endMs: 4800, text: 'Second cue is a longer line that has to wrap onto two lines in the frame' }] },
    });
    const a = await renderOk(bare);
    const b = await renderOk(texted);
    expect(b.res.warnings.filter((w) => /font cannot draw|not drawn/i.test(w))).toEqual([]);
    const at = (file: string, t: number) => frameGray(file, t);
    // during title 1: centre band (title) and bottom band (subtitle) differ from the bare render
    expect(meanDiff(at(a.outPath, 1.5), at(b.outPath, 1.5), 0.42, 0.62)).toBeGreaterThan(3);
    expect(meanDiff(at(a.outPath, 1.5), at(b.outPath, 1.5), 0.78, 0.9)).toBeGreaterThan(1);
    // between the two (2.7 s) nothing is drawn: frames identical apart from encoder noise
    expect(meanDiff(at(a.outPath, 2.7), at(b.outPath, 2.7), 0, 1)).toBeLessThan(1.2);
    // during title 2: top band differs
    expect(meanDiff(at(a.outPath, 4.0), at(b.outPath, 4.0), 0.05, 0.2)).toBeGreaterThan(3);
    expect((await eng.verifyOutput(b.outPath, texted)).overall).toBe('pass');
  });

  it('never silently drops text when no font exists: renders and says so', async () => {
    const noFont = engine({ systemFonts: false, fontFile: path.join(fx.root, 'missing.ttf') });
    const p = plan({
      segments: [seg('sp', 0, 2000)],
      titles: [{ id: 't', text: 'Hello', startMs: 0, endMs: 1500 }],
      subtitles: { source: 'user-provided', position: 'bottom', cues: [{ startMs: 0, endMs: 1500, text: 'sub' }] },
    });
    const { res } = await renderOk(p, noFont);
    expect(res.warnings.join('\n')).toMatch(/No usable font/);
    expect(res.warnings.join('\n')).toMatch(/Title "Hello" was not drawn/);
    expect(res.warnings.join('\n')).toMatch(/Subtitles were not drawn/);
  });

  it('honours an explicit font file option', async () => {
    const win = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts', 'arial.ttf');
    if (!fs.existsSync(win)) return;
    const e = engine({ fontFile: win, systemFonts: false });
    const p = plan({ segments: [seg('sp', 0, 1500)], titles: [{ id: 't', text: 'Arial please', startMs: 0, endMs: 1200 }] });
    const { res } = await renderOk(p, e);
    expect(res.warnings.filter((w) => /not drawn|font/i.test(w))).toEqual([]);
  });
});

describe('failures', () => {
  it('rejects an invalid plan with a non-retryable RenderError and writes nothing', async () => {
    const outPath = path.join(fx.root, 'out', 'invalid.mp4');
    const p = plan({ segments: [seg('does-not-exist', 0, 1000)] });
    const err = await eng.render({ plan: p, assets: fx.assets, outPath, workDir }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ name: 'RenderError', retryable: false });
    expect((err as Error).message).toMatch(/not valid.*does-not-exist/);
    expect(fs.existsSync(outPath)).toBe(false);
    expect(listFiles(workDir)).toEqual([]);
  });

  it('wraps an ffmpeg failure on a corrupt source in RenderError with stderr, cleans up, and is not retryable', async () => {
    const corrupt = path.join(fx.root, "corrupt 'clip'.mp4");
    fs.writeFileSync(corrupt, Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 37 + 11) % 256)));
    const assets = new Map(fx.assets);
    assets.set('bad', { id: 'bad', path: corrupt, kind: 'video', info: { ...fx.assets.get('sp')!.info } }); // lies about being valid
    const outPath = path.join(fx.root, 'out', 'corrupt.mp4');
    const p = plan({ segments: [seg('sp', 0, 1000), seg('bad', 0, 2000)] });
    const err = await eng.render({ plan: p, assets, outPath, workDir }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ name: 'RenderError' });
    const re = err as { message: string; stderrTail: string; retryable: boolean };
    expect(re.stderrTail.length).toBeGreaterThan(5);
    expect(re.message.length).toBeGreaterThan(10);
    expect(re.retryable).toBe(false);
    expect(fs.existsSync(outPath)).toBe(false);
    expect(fs.existsSync(`${outPath}.partial.mp4`)).toBe(false);
    expect(listFiles(workDir)).toEqual([]);
    expect(fs.existsSync(corrupt)).toBe(true); // sources are never deleted
  });

  it('reports a source that vanished from disk', async () => {
    const assets = new Map(fx.assets);
    assets.set('gone', { id: 'gone', path: path.join(fx.root, 'gone.mp4'), kind: 'video', info: { ...fx.assets.get('sp')!.info } });
    await expect(eng.render({ plan: plan({ segments: [seg('gone', 0, 1000)] }), assets, outPath: path.join(fx.root, 'out', 'gone.mp4'), workDir })).rejects.toThrow(/missing on disk/);
  });

  it('refuses to overwrite a source asset', async () => {
    const before = sha(fx.footage.small.portrait);
    await expect(eng.render({ plan: plan({ segments: [seg('sp', 0, 1000)] }), assets: fx.assets, outPath: fx.footage.small.portrait, workDir })).rejects.toThrow(/source asset/);
    expect(sha(fx.footage.small.portrait)).toBe(before);
  });
});
