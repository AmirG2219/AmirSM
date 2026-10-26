import { technicalProfile } from '../server/src/video/analysis.ts';
import { createVideoEngine, resolveBinaries } from '../server/src/video/index.ts';
const bins = resolveBinaries();
const eng = createVideoEngine(bins);
const file = process.env.TEMP + '/anfoot/an-hd10-1080x1920.mp4';
const info = await eng.probe(file);
for (let i = 0; i < 4; i++) {
  const t0 = performance.now();
  await technicalProfile(bins.ffmpegPath, file, info);
  console.log('run', i, Math.round(performance.now() - t0), 'ms');
}
const noAudio = { ...info, hasAudio: false };
for (let i = 0; i < 2; i++) {
  const t0 = performance.now();
  await technicalProfile(bins.ffmpegPath, file, noAudio);
  console.log('noaudio run', i, Math.round(performance.now() - t0), 'ms');
}
