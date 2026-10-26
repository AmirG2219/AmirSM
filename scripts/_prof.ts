import path from 'node:path';
import { createVideoEngine, resolveBinaries } from '../server/src/video/index.js';
import { EditPlanSchema } from '../shared/editPlan.js';
import { generateTestFootage } from './make-test-footage.js';
const f = await generateTestFootage(path.resolve('data/test-footage'), { reuse: true });
const eng = createVideoEngine({ ...resolveBinaries(), preset: 'superfast' });
const assets = new Map();
for (const [id, p, kind] of [['p', f.portrait, 'video'], ['l', f.landscape, 'video'], ['m', f.music, 'audio']] as const) assets.set(id, { id, path: p, kind, info: await eng.probe(p) });
const base = { version: 1, format: '9:16', fps: 30, segments: [{ id: 's1', assetId: 'p', startMs: 0, endMs: 5000 }] };
const variants: Record<string, any> = {
  base: { ...base, audio: { normalizeLoudness: false } },
  norm: { ...base },
  cinematic: { ...base, look: { preset: 'cinematic' } },
  warm: { ...base, look: { preset: 'warm' } },
  vignette: { ...base, look: { vignette: true } },
  title: { ...base, titles: [{ id: 't', text: 'Hello', startMs: 500, endMs: 3000 }] },
  subs: { ...base, subtitles: { source: 'user-provided', cues: [{ startMs: 0, endMs: 3000, text: 'Hello' }] } },
  blur: { ...base, segments: [{ id: 's1', assetId: 'l', startMs: 0, endMs: 5000, fit: 'contain-blur' }] },
  xfade: { ...base, segments: [{ id: 's1', assetId: 'p', startMs: 0, endMs: 3000 }, { id: 's2', assetId: 'p', startMs: 0, endMs: 3000, transitionIn: { type: 'crossfade', durationMs: 500 } }] },
};
for (const [name, v] of Object.entries(variants)) {
  const plan = EditPlanSchema.parse(v);
  const t0 = Date.now();
  await eng.render({ plan, assets, outPath: path.resolve('data/_try/prof.mp4'), workDir: path.resolve('data/_try/work') });
  console.log(name.padEnd(10), Date.now() - t0, 'ms');
}
