import path from 'node:path';
import { createVideoEngine, resolveBinaries } from '../server/src/video/index.js';
import { EditPlanSchema } from '../shared/editPlan.js';
import { generateTestFootage } from './make-test-footage.js';
const dir = path.resolve('data/test-footage');
const f = await generateTestFootage(dir, { reuse: true });
const eng = createVideoEngine({ ...resolveBinaries(), preset: 'superfast' });
console.log(await eng.health());
const assets = new Map();
for (const [id, p, kind] of [['p', f.portrait, 'video'], ['l', f.landscape, 'video'], ['s', f.silentPortrait, 'video'], ['m', f.music, 'audio'], ['r', f.rotated, 'video']] as const) {
  assets.set(id, { id, path: p, kind, info: await eng.probe(p) });
}
const plan = EditPlanSchema.parse({
  version: 1, format: '9:16', fps: 30,
  segments: [
    { id: 's1', assetId: 'p', startMs: 500, endMs: 4000 },
    { id: 's2', assetId: 'l', startMs: 0, endMs: 4000, fit: 'contain-blur', speed: 1.5, transitionIn: { type: 'crossfade', durationMs: 500 } },
    { id: 's3', assetId: 's', startMs: 0, endMs: 3000, transitionIn: { type: 'slide-left', durationMs: 400 } },
    { id: 's4', assetId: 'r', startMs: 0, endMs: 3000, transitionIn: { type: 'dip-to-black', durationMs: 400 } },
  ],
  titles: [{ id: 't1', text: "Amir's day: 100% real, 'quoted' \ back:slash", startMs: 500, endMs: 3500, position: 'center', size: 'large' },
           { id: 't2', text: 'ሰላም ዓለም — Amharic title', startMs: 4000, endMs: 7000, position: 'lower-third' }],
  subtitles: { source: 'user-provided', position: 'bottom', cues: [{ startMs: 200, endMs: 2500, text: 'First subtitle {braces} line' }, { startMs: 2600, endMs: 6000, text: 'Second subtitle that is a bit longer so that it must wrap onto two lines on screen' }] },
  look: { preset: 'cinematic', vignette: true, fadeInMs: 300, fadeOutMs: 500 },
  audio: { normalizeLoudness: true, music: { assetId: 'm', volume: 0.25, fadeOutMs: 1000 } },
});
const v = eng.validatePlan(plan, assets);
console.log(v);
const out = path.resolve(process.argv[2] ?? 'data/_try/out.mp4');
const t0 = Date.now();
const res = await eng.render({ plan, assets, outPath: out, workDir: path.resolve('data/_try/work'), onProgress: (f, m) => console.log(f, m) });
console.log(Date.now() - t0, 'ms', { ...res, commandSummary: res.commandSummary[0] });
console.log(res.commandSummary[1]);
console.log(JSON.stringify(await eng.verifyOutput(out, plan), null, 1));
