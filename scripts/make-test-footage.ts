/**
 * Generates clearly SYNTHETIC test footage (lavfi test patterns + sine tones) for development and tests.
 * These are labelled fixtures, never real footage. Output dir defaults to data/test-footage/ (gitignored).
 *
 *   npx tsx scripts/make-test-footage.ts [outDir]
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBinaries } from '../server/src/video/binaries.js';
import { capture } from '../server/src/video/ffmpeg-run.js';

export interface TestFootage {
  dir: string;
  /** 1080x1920, 6s, 30fps, with 440Hz tone */
  portrait: string;
  /** 1920x1080, 6s, 30fps, with 660Hz tone */
  landscape: string;
  /** 720x1280, 5s, 30fps, NO audio stream */
  silentPortrait: string;
  /** 8s 330Hz-ish tone sweep, stereo wav, for music tests (shorter than long edits => must loop) */
  music: string;
  /** 5s landscape-stored 640x360 clip carrying 90deg rotation metadata (displays as 360x640) */
  rotated: string;
  /** small + fast variants for tests that are not about resolution */
  small: { portrait: string; landscape: string; silent: string };
}

export interface MakeFootageOptions {
  ffmpegPath?: string;
  /** skip files that already exist */
  reuse?: boolean;
}

async function ff(ffmpegPath: string, args: string[]): Promise<void> {
  const r = await capture(ffmpegPath, ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', ...args], { timeoutMs: 120_000 });
  if (r.code !== 0) throw new Error(`ffmpeg failed (${r.code}): ${r.stderr.slice(-800)}`);
}

const X264 = ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '36', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];

export async function generateTestFootage(dir: string, opts: MakeFootageOptions = {}): Promise<TestFootage> {
  const ffmpegPath = opts.ffmpegPath ?? resolveBinaries().ffmpegPath;
  await fs.mkdir(dir, { recursive: true });
  const p = (n: string) => path.join(dir, n);
  const want = async (file: string, make: () => Promise<void>) => {
    if (opts.reuse) {
      try {
        if ((await fs.stat(file)).size > 0) return;
      } catch {
        /* generate */
      }
    }
    await make();
  };

  const out: TestFootage = {
    dir,
    portrait: p('test-portrait-1080x1920-audio.mp4'),
    landscape: p('test-landscape-1920x1080-audio.mp4'),
    silentPortrait: p('test-silent-720x1280-noaudio.mp4'),
    music: p('test-music-8s.wav'),
    rotated: p('test-rotated-90.mp4'),
    small: { portrait: p('test-small-portrait-270x480-audio.mp4'), landscape: p('test-small-landscape-480x270-audio.mp4'), silent: p('test-small-silent-270x480.mp4') },
  };

  await want(out.portrait, () =>
    ff(ffmpegPath, ['-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=30:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=6', ...X264, '-c:a', 'aac', '-b:a', '96k', '-shortest', out.portrait]),
  );
  await want(out.landscape, () =>
    ff(ffmpegPath, ['-f', 'lavfi', '-i', 'smptebars=size=1920x1080:rate=30:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=6', ...X264, '-c:a', 'aac', '-b:a', '96k', '-shortest', out.landscape]),
  );
  await want(out.silentPortrait, () =>
    ff(ffmpegPath, ['-f', 'lavfi', '-i', 'testsrc2=size=720x1280:rate=30:duration=5', '-vf', 'hue=h=120', ...X264, '-an', out.silentPortrait]),
  );
  await want(out.music, () =>
    ff(ffmpegPath, ['-f', 'lavfi', '-i', 'sine=frequency=262:sample_rate=44100:duration=8', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=44100:duration=8', '-filter_complex', '[0][1]amerge=inputs=2,volume=0.5', '-c:a', 'pcm_s16le', out.music]),
  );
  await want(out.rotated, async () => {
    const tmp = p('_rotated-src.mp4');
    await ff(ffmpegPath, ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=5', '-f', 'lavfi', '-i', 'sine=frequency=550:sample_rate=48000:duration=5', ...X264, '-c:a', 'aac', '-b:a', '64k', '-shortest', tmp]);
    // phone-style: stored landscape, display matrix says "rotate 90deg clockwise" (-display_rotation is counter-clockwise)
    await ff(ffmpegPath, ['-display_rotation', '270', '-i', tmp, '-c', 'copy', out.rotated]);
    await fs.rm(tmp, { force: true });
  });
  await want(out.small.portrait, () =>
    ff(ffmpegPath, ['-f', 'lavfi', '-i', 'testsrc2=size=270x480:rate=30:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=6', ...X264, '-c:a', 'aac', '-b:a', '64k', '-shortest', out.small.portrait]),
  );
  await want(out.small.landscape, () =>
    ff(ffmpegPath, ['-f', 'lavfi', '-i', 'smptebars=size=480x270:rate=30:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=6', ...X264, '-c:a', 'aac', '-b:a', '64k', '-shortest', out.small.landscape]),
  );
  await want(out.small.silent, () =>
    ff(ffmpegPath, ['-f', 'lavfi', '-i', 'testsrc2=size=270x480:rate=30:duration=5', '-vf', 'hue=h=120', ...X264, '-an', out.small.silent]),
  );
  return out;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const dir = path.resolve(process.argv[2] ?? path.join(process.cwd(), 'data', 'test-footage'));
  generateTestFootage(dir, { reuse: false })
    .then((f) => {
      console.log(`Synthetic test footage written to ${dir} (test patterns + sine tones; not real footage):`);
      for (const v of [f.portrait, f.landscape, f.silentPortrait, f.music, f.rotated, ...Object.values(f.small)]) console.log('  ' + path.basename(v));
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}

// ---------------------------------------------------------------------------------------------
// Footage for the technical-analysis tests: clips with KNOWN bad sections (dark / blurred / shaky / hard cut).
// Everything is synthetic (lavfi). Times in comments are source seconds.
// ---------------------------------------------------------------------------------------------
export interface AnalysisFootage {
  dir: string;
  /** 540x960, 12s, audio. dark 3-5s, blurred 7-9s; sine tone 0-6s then silence 6-12s */
  mixed: string;
  /** 360x640, 10s, hard cut at 5s (testsrc2 -> smptebars) */
  cut: string;
  /** 360x640, 6s: static textured pattern with the camera jittering by up to +-20px every frame */
  shaky: string;
  /** same pattern, camera perfectly steady */
  steady: string;
  /** 360x640, 5s, almost black the whole time */
  dark: string;
  /** 1080x1920 10s 30fps with audio (timing test) */
  hd10: string;
  /** 0.6s 270x480 */
  tiny: string;
  /** 640x360 stored, 90deg rotation metadata (displays 360x640), 5s, audio */
  rotated: string;
}

const TEXTURE = "geq=lum='128+55*sin(X/9)*sin(Y/7)+40*sin((X+Y)/23)+25*sin(X/3.1)*sin(Y/2.7)':cb=128:cr=128";

export async function generateAnalysisFootage(dir: string, opts: MakeFootageOptions & { only?: (keyof Omit<AnalysisFootage, 'dir'>)[] } = {}): Promise<AnalysisFootage> {
  const ffmpegPath = opts.ffmpegPath ?? resolveBinaries().ffmpegPath;
  await fs.mkdir(dir, { recursive: true });
  const p = (n: string) => path.join(dir, n);
  const out: AnalysisFootage = {
    dir,
    mixed: p('an-mixed-540x960.mp4'),
    cut: p('an-cut-360x640.mp4'),
    shaky: p('an-shaky-360x640.mp4'),
    steady: p('an-steady-360x640.mp4'),
    dark: p('an-dark-360x640.mp4'),
    hd10: p('an-hd10-1080x1920.mp4'),
    tiny: p('an-tiny-270x480.mp4'),
    rotated: p('an-rotated-90.mp4'),
  };
  const want = async (file: string, make: () => Promise<void>) => {
    if (opts.only && !opts.only.some((k) => out[k] === file)) return;
    if (opts.reuse) {
      try {
        if ((await fs.stat(file)).size > 0) return;
      } catch {
        /* generate */
      }
    }
    await make();
  };
  await want(out.mixed, () =>
    ff(ffmpegPath, [
      '-f', 'lavfi', '-i', 'testsrc2=size=540x960:rate=30:duration=12',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=6',
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=6',
      '-filter_complex', "[0:v]eq=brightness=-0.85:enable='between(t,3,5)',gblur=sigma=20:enable='between(t,7,9)'[v];[1:a][2:a]concat=n=2:v=0:a=1[a]",
      '-map', '[v]', '-map', '[a]', ...X264, '-c:a', 'aac', '-b:a', '64k', out.mixed,
    ]),
  );
  await want(out.cut, () =>
    ff(ffmpegPath, [
      '-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=30:duration=5',
      '-f', 'lavfi', '-i', 'smptebars=size=360x640:rate=30:duration=5',
      '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', ...X264, '-an', out.cut,
    ]),
  );
  await want(out.shaky, () =>
    ff(ffmpegPath, [
      '-f', 'lavfi', '-i', `nullsrc=size=420x700:rate=30:duration=6,${TEXTURE}`,
      '-vf', "crop=w=360:h=640:x='30+(random(1)-0.5)*40':y='30+(random(2)-0.5)*40'", ...X264, '-an', out.shaky,
    ]),
  );
  await want(out.steady, () =>
    ff(ffmpegPath, [
      '-f', 'lavfi', '-i', `nullsrc=size=420x700:rate=30:duration=6,${TEXTURE}`,
      '-vf', 'crop=w=360:h=640:x=30:y=30', ...X264, '-an', out.steady,
    ]),
  );
  await want(out.dark, () =>
    ff(ffmpegPath, ['-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=30:duration=5', '-vf', 'eq=brightness=-0.9', ...X264, '-an', out.dark]),
  );
  await want(out.hd10, () =>
    ff(ffmpegPath, ['-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=30:duration=10', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000:duration=10', ...X264, '-c:a', 'aac', '-b:a', '64k', '-shortest', out.hd10]),
  );
  await want(out.tiny, () =>
    ff(ffmpegPath, ['-f', 'lavfi', '-i', 'testsrc2=size=270x480:rate=30:duration=0.6', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=0.6', ...X264, '-c:a', 'aac', '-b:a', '64k', '-shortest', out.tiny]),
  );
  await want(out.rotated, async () => {
    const tmp = p('_an-rotated-src.mp4');
    await ff(ffmpegPath, ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=5', '-f', 'lavfi', '-i', 'sine=frequency=550:sample_rate=48000:duration=5', ...X264, '-c:a', 'aac', '-b:a', '64k', '-shortest', tmp]);
    await ff(ffmpegPath, ['-display_rotation', '270', '-i', tmp, '-c', 'copy', out.rotated]);
    await fs.rm(tmp, { force: true });
  });
  return out;
}
