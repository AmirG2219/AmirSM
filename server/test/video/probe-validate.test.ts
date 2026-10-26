import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_OUTPUT_DURATION_MS, planDurationMs } from '../../../shared/editPlan.js';
import { ProbeError } from '../../src/video/index.js';
import { atempoChain, wrapText } from '../../src/video/filtergraph.js';
import { FontLibrary } from '../../src/video/fonts.js';
import { bins, engine, plan, seg, setupFixtures, type Fixtures } from './helpers.js';

let fx: Fixtures;
const eng = engine();

beforeAll(async () => {
  fx = await setupFixtures();
});
afterAll(() => {
  fs.rmSync(fx.root, { recursive: true, force: true });
});

describe('paths', () => {
  it('runs from a root containing a space and an apostrophe', () => {
    expect(fx.root).toContain("'");
    expect(fx.root).toContain(' ');
  });
});

describe('health', () => {
  it('reports ffmpeg usable with the filters we need', async () => {
    const h = await eng.health();
    expect(h.ok).toBe(true);
    expect(h.ffmpegVersion).toBeTruthy();
    expect(h.filters).toEqual({ drawtext: true, subtitles: true, xfade: true });
  });
  it('reports not ok (does not throw) for a bad binary path', async () => {
    const bad = engine({ ffmpegPath: path.join(fx.root, 'nope.exe') });
    const h = await bad.health();
    expect(h.ok).toBe(false);
    expect(h.detail).toBeTruthy();
  });
});

describe('probe', () => {
  it('reads a portrait clip with audio', async () => {
    const i = await eng.probe(fx.footage.portrait);
    expect(i).toMatchObject({ width: 1080, height: 1920, displayWidth: 1080, displayHeight: 1920, rotation: 0, hasVideo: true, hasAudio: true, videoCodec: 'h264', audioCodec: 'aac', container: 'mp4' });
    expect(i.fps).toBeCloseTo(30, 1);
    expect(Math.abs(i.durationMs - 6000)).toBeLessThan(80);
    expect(i.sizeBytes).toBe(fs.statSync(fx.footage.portrait).size);
  });
  it('reports a clip without audio', async () => {
    const i = await eng.probe(fx.footage.silentPortrait);
    expect(i.hasVideo).toBe(true);
    expect(i.hasAudio).toBe(false);
    expect(i.audioCodec).toBeNull();
  });
  it('applies rotation metadata to the display size', async () => {
    const i = await eng.probe(fx.footage.rotated);
    expect(i.width).toBe(640);
    expect(i.height).toBe(360);
    expect(i.rotation).toBe(90);
    expect(i.displayWidth).toBe(360);
    expect(i.displayHeight).toBe(640);
  });
  it('probes an audio-only file as hasVideo=false', async () => {
    const i = await eng.probe(fx.footage.music);
    expect(i.hasVideo).toBe(false);
    expect(i.hasAudio).toBe(true);
    expect(i.displayWidth).toBe(0);
    expect(Math.abs(i.durationMs - 8000)).toBeLessThan(80);
  });
  it('rejects non-media files cleanly', async () => {
    const txt = path.join(fx.root, 'notes.mp4');
    fs.writeFileSync(txt, 'this is definitely not a video, just text '.repeat(50));
    await expect(eng.probe(txt)).rejects.toBeInstanceOf(ProbeError);
    const empty = path.join(fx.root, 'empty.mp4');
    fs.writeFileSync(empty, '');
    await expect(eng.probe(empty)).rejects.toThrow(/empty/i);
    await expect(eng.probe(path.join(fx.root, 'missing.mp4'))).rejects.toThrow(/not found/i);
  });
  it('rejects still images', async () => {
    const png = path.join(fx.root, 'still.png');
    const r = spawnSync(bins.ffmpegPath, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x64', '-frames:v', '1', png]);
    expect(r.status).toBe(0);
    await expect(eng.probe(png)).rejects.toBeInstanceOf(ProbeError);
  });
});

describe('thumbnail', () => {
  it('writes a JPEG at the default time and at an explicit time', async () => {
    const out = path.join(fx.root, 'thumbs', 'a.jpg');
    await eng.thumbnail(fx.footage.small.portrait, out);
    const b = fs.readFileSync(out);
    expect(b[0]).toBe(0xff);
    expect(b[1]).toBe(0xd8);
    const out2 = path.join(fx.root, 'thumbs', 'b.jpg');
    await eng.thumbnail(fx.footage.small.landscape, out2, 3000);
    expect(fs.statSync(out2).size).toBeGreaterThan(500);
    // beyond the end of the clip is clamped, not an error
    const out3 = path.join(fx.root, 'thumbs', 'c.jpg');
    await eng.thumbnail(fx.footage.small.landscape, out3, 999_000);
    expect(fs.statSync(out3).size).toBeGreaterThan(500);
    expect(fs.readdirSync(path.dirname(out)).filter((f) => f.includes('partial'))).toEqual([]);
  });
  it('refuses audio-only input', async () => {
    await expect(eng.thumbnail(fx.footage.music, path.join(fx.root, 'thumbs', 'x.jpg'))).rejects.toThrow();
  });
});

describe('validatePlan', () => {
  const ok = () => plan({ segments: [seg('sp', 0, 3000), seg('sl', 0, 3000, { transitionIn: { type: 'crossfade', durationMs: 500 } })] });

  it('accepts a good plan', () => {
    const r = eng.validatePlan(ok(), fx.assets);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });
  it('flags unknown assets, wrong kinds and ranges past the clip end', () => {
    const r = eng.validatePlan(plan({ segments: [seg('nope', 0, 1000), seg('music', 0, 1000), seg('sp', 0, 9000)] }), fx.assets);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/nope.*not found/);
    expect(r.errors.join('\n')).toMatch(/not a video/);
    expect(r.errors.join('\n')).toMatch(/runs past the end/);
  });
  it('allows <=50 ms over the clip end (warning) but not more', () => {
    const dur = fx.assets.get('sp')!.info.durationMs;
    const near = eng.validatePlan(plan({ segments: [seg('sp', 0, dur + 40)] }), fx.assets);
    expect(near.ok).toBe(true);
    expect(near.warnings.join('\n')).toMatch(/clip end/);
    const far = eng.validatePlan(plan({ segments: [seg('sp', 0, dur + 80)] }), fx.assets);
    expect(far.ok).toBe(false);
  });
  it('enforces the output duration cap', () => {
    const segs = Array.from({ length: 8 }, () => seg('portrait', 0, 5900, { speed: 0.5 })); // 8 * 11.8 s = 94 s
    expect(eng.validatePlan(plan({ segments: segs }), fx.assets).ok).toBe(true);
    const many = Array.from({ length: 16 }, () => seg('portrait', 0, 5900, { speed: 0.5 })); // 188 s
    const r = eng.validatePlan(plan({ segments: many }), fx.assets);
    expect(planDurationMs(plan({ segments: many }))).toBeGreaterThan(MAX_OUTPUT_DURATION_MS);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/maximum/);
  });
  it('validates the music asset', () => {
    const missing = eng.validatePlan(plan({ segments: [seg('sp', 0, 2000)], audio: { normalizeLoudness: true, music: { assetId: 'ghost', volume: 0.3, fadeOutMs: 500 } } }), fx.assets);
    expect(missing.errors.join('\n')).toMatch(/Music asset "ghost" was not found/);
    const wrong = eng.validatePlan(plan({ segments: [seg('sp', 0, 2000)], audio: { normalizeLoudness: true, music: { assetId: 'sp', volume: 0.3, fadeOutMs: 500 } } }), fx.assets);
    expect(wrong.errors.join('\n')).toMatch(/not an audio file/);
    const loop = eng.validatePlan(plan({ segments: [seg('portrait', 0, 5900), seg('portrait', 0, 5000)], audio: { normalizeLoudness: true, music: { assetId: 'music', volume: 0.3, fadeOutMs: 500 } } }), fx.assets);
    expect(loop.ok).toBe(true);
    expect(loop.warnings.join('\n')).toMatch(/loop/);
  });
  it('checks titles and subtitle cues against the output duration', () => {
    const base = { segments: [seg('sp', 0, 3000)] };
    const bad = eng.validatePlan(
      plan({ ...base, titles: [{ id: 't', text: 'late', startMs: 5000, endMs: 6000 }], subtitles: { source: 'user-provided', position: 'bottom', cues: [{ startMs: 4000, endMs: 5000, text: 'late' }] } }),
      fx.assets,
    );
    expect(bad.ok).toBe(false);
    expect(bad.errors.join('\n')).toMatch(/Title "t" starts at 5000/);
    expect(bad.errors.join('\n')).toMatch(/Subtitle cue 1 starts/);
    const spill = eng.validatePlan(plan({ ...base, titles: [{ id: 't', text: 'x', startMs: 2000, endMs: 4000 }] }), fx.assets);
    expect(spill.ok).toBe(true);
    expect(spill.warnings.join('\n')).toMatch(/cut at/);
  });
  it('rejects transitions that do not fit the neighbouring clips', () => {
    const long = eng.validatePlan(plan({ segments: [seg('sp', 0, 1000), seg('sl', 0, 600, { transitionIn: { type: 'crossfade', durationMs: 700 } })] }), fx.assets);
    expect(long.ok).toBe(false);
    expect(long.errors.join('\n')).toMatch(/not shorter/);
    const sandwiched = eng.validatePlan(
      plan({
        segments: [
          seg('sp', 0, 3000),
          seg('sl', 0, 900, { transitionIn: { type: 'crossfade', durationMs: 500 } }),
          seg('sp', 0, 3000, { transitionIn: { type: 'slide-left', durationMs: 500 } }),
        ],
      }),
      fx.assets,
    );
    expect(sandwiched.ok).toBe(false);
    expect(sandwiched.errors.join('\n')).toMatch(/both of its ends/);
  });
  it('warns (not errors) about silent clips and low-resolution sources', () => {
    const r = eng.validatePlan(plan({ segments: [seg('ss', 0, 2000)] }), fx.assets);
    expect(r.ok).toBe(true);
    expect(r.warnings.join('\n')).toMatch(/no audio track/);
    expect(r.warnings.join('\n')).toMatch(/soft/);
  });
  it('never throws on garbage', () => {
    // @ts-expect-error deliberately malformed
    expect(eng.validatePlan({ version: 1, segments: [] }, fx.assets).ok).toBe(false);
    // @ts-expect-error deliberately malformed
    expect(() => eng.validatePlan({}, fx.assets)).not.toThrow();
  });
  it('warns when no font exists for titles', async () => {
    const noFont = engine({ systemFonts: false, fontFile: path.join(fx.root, 'missing.ttf') });
    await new Promise((r) => setTimeout(r, 50));
    const r = noFont.validatePlan(plan({ segments: [seg('sp', 0, 2000)], titles: [{ id: 't', text: 'hi', startMs: 0, endMs: 1000 }] }), fx.assets);
    expect(r.warnings.join('\n')).toMatch(/No usable font/);
  });
});

describe('helpers', () => {
  it('chains atempo for any factor', () => {
    expect(atempoChain(1)).toEqual([]);
    expect(atempoChain(1.5)).toEqual(['atempo=1.500000']);
    expect(atempoChain(4)).toEqual(['atempo=2', 'atempo=2.000000']);
  });
  it('wraps long titles inside the frame and keeps odd characters intact', async () => {
    const lib = new FontLibrary();
    const text = "Amir's day: 100% real \\ 'quoted' text that needs wrapping across lines";
    const pick = (await lib.pickFor(text))!;
    expect(pick).toBeTruthy();
    const lines = wrapText(text, pick.face, 86, 900);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(pick.face.measureEm(l) * 86).toBeLessThanOrEqual(900);
    expect(lines.join(' ')).toBe(text);
  });
  it('picks a script-capable font for Amharic text', async () => {
    const lib = new FontLibrary();
    const pick = await lib.pickFor('ሰላም ዓለም');
    if (process.platform === 'win32') {
      expect(pick?.missing).toEqual([]);
      expect(pick?.face.family).toMatch(/Ebrima|Nyala/i);
    }
  });
});
