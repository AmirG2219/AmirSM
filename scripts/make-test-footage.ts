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
