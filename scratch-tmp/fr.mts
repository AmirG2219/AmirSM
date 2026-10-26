import { sampleFrames } from '../server/src/video/frames.ts';
import { createVideoEngine, resolveBinaries } from '../server/src/video/index.ts';
const bins = resolveBinaries(); const eng = createVideoEngine(bins);
for (const n of ['an-hd10-1080x1920.mp4','an-tiny-270x480.mp4','an-cut-360x640.mp4']) {
  const file = process.env.TEMP + '/anfoot/' + n; const info = await eng.probe(file);
  const t0 = performance.now();
  const f = await sampleFrames(bins.ffmpegPath, file, info, { count: 6 });
  console.log(n, Math.round(performance.now()-t0)+'ms', f.map(x => `${x.timeMs}:${x.width}x${x.height}:${x.bytes}`).join(' '));
}
