import { technicalProfile } from '../server/src/video/analysis.ts';
import { createVideoEngine, resolveBinaries } from '../server/src/video/index.ts';
const bins = resolveBinaries();
const eng = createVideoEngine(bins);
const dir = process.env.TEMP + '/anfoot/';
const names = process.argv.slice(2);
for (const n of names) {
  const file = dir + n;
  const info = await eng.probe(file);
  const t0 = performance.now();
  const p = await technicalProfile(bins.ffmpegPath, file, info);
  const ms = Math.round(performance.now() - t0);
  console.log('==', n, `${info.displayWidth}x${info.displayHeight} ${info.durationMs}ms -> ${ms}ms`, 'scenes', p.sceneChangesMs, 'score', p.score, 'audio', JSON.stringify(p.audio));
  console.log(p.issues.map(i => `${i.code} ${i.share} ${JSON.stringify(i.ranges)}`).join('\n'));
  for (const w of p.windows) console.log(`${w.startMs}-${w.endMs} b=${w.brightness} c=${w.contrast} sh=${w.sharpness} mo=${w.motion} sk=${w.shake} a=${w.audioDb} s=${w.score} [${w.issues}]`);
}
