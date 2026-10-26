import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EditPlanSchema, type EditPlanInput, type EditPlan } from '../../../shared/editPlan.js';
import { createVideoEngine, resolveBinaries } from '../../src/video/index.js';
import type { PlanAsset } from '../../src/video/types.js';
import { generateTestFootage, type TestFootage } from '../../../scripts/make-test-footage.js';

export const bins = resolveBinaries();

/** A scratch root whose name contains a space AND an apostrophe, to prove nothing breaks on such paths. */
export function makeTrickyRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "amir sm's video test "));
}

export function engine(extra: Partial<Parameters<typeof createVideoEngine>[0]> = {}) {
  return createVideoEngine({ ...bins, preset: 'superfast', crf: 26, ...extra });
}

export interface Fixtures {
  root: string;
  footage: TestFootage;
  assets: Map<string, PlanAsset>;
}

export async function setupFixtures(): Promise<Fixtures> {
  const root = makeTrickyRoot();
  const footage = await generateTestFootage(path.join(root, 'footage'));
  const eng = engine();
  const assets = new Map<string, PlanAsset>();
  const add = async (id: string, p: string, kind: 'video' | 'audio') => assets.set(id, { id, path: p, kind, info: await eng.probe(p) });
  await add('portrait', footage.portrait, 'video');
  await add('landscape', footage.landscape, 'video');
  await add('silent', footage.silentPortrait, 'video');
  await add('music', footage.music, 'audio');
  await add('rotated', footage.rotated, 'video');
  await add('sp', footage.small.portrait, 'video');
  await add('sl', footage.small.landscape, 'video');
  await add('ss', footage.small.silent, 'video');
  return { root, footage, assets };
}

export function plan(input: Partial<EditPlanInput> & { segments: EditPlanInput['segments'] }): EditPlan {
  return EditPlanSchema.parse({ version: 1, ...input });
}

export function seg(assetId: string, startMs: number, endMs: number, extra: Record<string, unknown> = {}) {
  return { id: `s-${assetId}-${startMs}-${Math.round(Math.random() * 1e6)}`, assetId, startMs, endMs, ...extra };
}

/** list of files (recursive) under a dir; empty array when the dir does not exist */
export function listFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

function run(args: string[]): Buffer {
  const r = spawnSync(bins.ffmpegPath, ['-hide_banner', '-nostdin', '-v', 'error', ...args], { maxBuffer: 64 * 1024 * 1024 });
  return r.stdout;
}

/** Mean absolute luma-difference helpers: 108x192 grayscale snapshot of the frame at time t (seconds). */
export function frameGray(file: string, t: number, w = 108, h = 192): Buffer {
  return run(['-ss', String(t), '-i', file, '-frames:v', '1', '-vf', `scale=${w}:${h}:flags=area`, '-pix_fmt', 'gray', '-f', 'rawvideo', '-']);
}

export function meanDiff(a: Buffer, b: Buffer, rowFrom = 0, rowTo = 1, w = 108, h = 192): number {
  const y0 = Math.floor(rowFrom * h);
  const y1 = Math.floor(rowTo * h);
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < w; x++) {
      sum += Math.abs((a[y * w + x] ?? 0) - (b[y * w + x] ?? 0));
      n++;
    }
  }
  return n ? sum / n : 0;
}

export function meanLuma(buf: Buffer, rowFrom = 0, rowTo = 1, w = 108, h = 192): number {
  const y0 = Math.floor(rowFrom * h);
  const y1 = Math.floor(rowTo * h);
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = 0; x < w; x++) (sum += buf[y * w + x] ?? 0), n++;
  return n ? sum / n : 0;
}

export function signalStat(file: string, t: number, key: 'YAVG' | 'SATAVG'): number {
  const r = spawnSync(bins.ffmpegPath, ['-hide_banner', '-nostdin', '-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', 'signalstats,metadata=mode=print:file=-', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = new RegExp(`lavfi\\.signalstats\\.${key}=([\\d.]+)`).exec(r.stdout);
  return m ? Number(m[1]) : NaN;
}

/** mean_volume (dB) of the audio between two output times */
export function meanVolume(file: string, fromSec: number, durSec: number): number {
  const r = spawnSync(bins.ffmpegPath, ['-hide_banner', '-nostdin', '-ss', String(fromSec), '-t', String(durSec), '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = /mean_volume:\s*(-?[\d.]+|-inf) dB/.exec(r.stderr);
  if (!m) return NaN;
  return m[1] === '-inf' ? -200 : Number(m[1]);
}
