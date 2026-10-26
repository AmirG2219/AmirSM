import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RenderCancelled } from '../../src/video/index.js';
import { engine, listFiles, plan, seg, setupFixtures, type Fixtures } from './helpers.js';

let fx: Fixtures;
let workDir: string;
const eng = engine();

beforeAll(async () => {
  fx = await setupFixtures();
  workDir = path.join(fx.root, 'work');
});
afterAll(() => {
  fs.rmSync(fx.root, { recursive: true, force: true });
});

describe('cancel', () => {
  it('kills ffmpeg on abort, throws RenderCancelled and removes partial output + scratch files', async () => {
    const outPath = path.join(fx.root, 'out', 'cancel.mp4');
    const ac = new AbortController();
    // heavy enough (full-size sources, look + vignette, 4 clips) that it cannot finish before we abort
    const p = plan({
      segments: [seg('portrait', 0, 6000), seg('portrait', 0, 6000, { transitionIn: { type: 'crossfade', durationMs: 500 } }), seg('portrait', 0, 6000), seg('portrait', 0, 6000)],
      look: { preset: 'cinematic', vignette: true, fadeInMs: 0, fadeOutMs: 0 },
    });
    let sawRendering = false;
    const started = Date.now();
    const err = await eng
      .render({
        plan: p,
        assets: fx.assets,
        outPath,
        workDir,
        signal: ac.signal,
        onProgress: (_f, msg) => {
          if (msg.startsWith('Rendering') && !sawRendering) {
            sawRendering = true;
            setTimeout(() => ac.abort(), 300);
          }
        },
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(sawRendering).toBe(true);
    expect(err).toBeInstanceOf(RenderCancelled);
    expect(Date.now() - started).toBeLessThan(60_000);
    expect(fs.existsSync(outPath)).toBe(false);
    expect(fs.existsSync(`${outPath}.partial.mp4`)).toBe(false);
    expect(listFiles(workDir)).toEqual([]);
    expect(listFiles(path.join(fx.root, 'out')).filter((f) => f.includes('cancel'))).toEqual([]);
  });

  it('throws RenderCancelled immediately if already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(eng.render({ plan: plan({ segments: [seg('sp', 0, 1000)] }), assets: fx.assets, outPath: path.join(fx.root, 'out', 'pre.mp4'), workDir, signal: ac.signal })).rejects.toBeInstanceOf(RenderCancelled);
    expect(fs.existsSync(path.join(fx.root, 'out', 'pre.mp4'))).toBe(false);
  });
});

describe('verifyOutput', () => {
  const p = plan({ segments: [seg('portrait', 0, 5000)] });
  let good: string;

  beforeAll(async () => {
    good = path.join(fx.root, 'out', 'good.mp4');
    await eng.render({ plan: p, assets: fx.assets, outPath: good, workDir });
  });

  const failing = (q: { checks: Array<{ id: string; status: string }> }) => q.checks.filter((c) => c.status === 'fail').map((c) => c.id);

  it('passes on a good render', async () => {
    const q = await eng.verifyOutput(good, p);
    expect(q.overall).toBe('pass');
    expect(q.sources).toEqual(['deterministic']);
    expect(q.checks.map((c) => c.id)).toEqual(expect.arrayContaining(['playable', 'codec', 'dimensions', 'duration', 'audio', 'fps', 'faststart']));
  });

  it('fails a truncated file', async () => {
    const buf = fs.readFileSync(good);
    const cut = path.join(fx.root, 'out', 'truncated.mp4');
    fs.writeFileSync(cut, buf.subarray(0, Math.floor(buf.length * 0.4)));
    const q = await eng.verifyOutput(cut, p);
    expect(q.overall).toBe('fail');
    expect(failing(q)).toContain('playable');

    // moov at the END of a truncated file (no faststart) is the classic "unplayable" case
    const noMoov = path.join(fx.root, 'out', 'nomoov.mp4');
    fs.writeFileSync(noMoov, buf.subarray(0, 4096));
    expect((await eng.verifyOutput(noMoov, p)).overall).toBe('fail');
  });

  it('fails a missing, empty or non-video file', async () => {
    expect((await eng.verifyOutput(path.join(fx.root, 'out', 'nope.mp4'), p)).overall).toBe('fail');
    const empty = path.join(fx.root, 'out', 'empty.mp4');
    fs.writeFileSync(empty, '');
    expect((await eng.verifyOutput(empty, p)).overall).toBe('fail');
    const q = await eng.verifyOutput(fx.footage.music, p);
    expect(q.overall).toBe('fail');
    expect(failing(q)).toContain('playable');
  });

  it('fails the wrong dimensions and the wrong duration', async () => {
    const q1 = await eng.verifyOutput(good, plan({ format: '1:1', segments: [seg('portrait', 0, 5000)] }));
    expect(failing(q1)).toContain('dimensions');
    const q2 = await eng.verifyOutput(good, plan({ segments: [seg('portrait', 0, 6000), seg('landscape', 0, 6000)] }));
    expect(failing(q2)).toContain('duration');
  });

  it('fails when sound is expected but the file has no audio stream', async () => {
    // source video stream only (no audio track) vs a plan that keeps audio
    const q = await eng.verifyOutput(fx.footage.silentPortrait, plan({ segments: [seg('silent', 0, 5000)] }));
    expect(failing(q)).toContain('audio');
    expect(failing(q)).toEqual(expect.arrayContaining(['dimensions'])); // 720x1280 source is not an export
  });

  it('flags a non-faststart mp4 as a warning', async () => {
    const slow = path.join(fx.root, 'out', 'slow.mp4');
    // re-mux without +faststart so moov lands at the end
    const { spawnSync } = await import('node:child_process');
    const { bins } = await import('./helpers.js');
    const r = spawnSync(bins.ffmpegPath, ['-v', 'error', '-y', '-i', good, '-c', 'copy', slow]);
    expect(r.status).toBe(0);
    const q = await eng.verifyOutput(slow, p);
    const fs1 = q.checks.find((c) => c.id === 'faststart');
    expect(fs1?.status).toBe('warn');
    expect(q.overall).toBe('warn');
  });
});
