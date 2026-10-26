import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function load<T>(id: string): T | null {
  try {
    return require(id) as T;
  } catch {
    return null;
  }
}

/** ffmpeg/ffprobe from the npm packages, overridable with FFMPEG_PATH / FFPROBE_PATH. */
export function resolveBinaries(env: NodeJS.ProcessEnv = process.env): { ffmpegPath: string; ffprobePath: string } {
  const ffmpegPath = env.FFMPEG_PATH?.trim() || load<string | null>('ffmpeg-static') || '';
  const ffprobePath = env.FFPROBE_PATH?.trim() || load<{ path: string }>('ffprobe-static')?.path || '';
  return { ffmpegPath, ffprobePath };
}
