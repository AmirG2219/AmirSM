import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { generateAnalysisFootage, type AnalysisFootage } from '../../../scripts/make-test-footage.js';
import { technicalToClipAnalysis, type ClipAnalysis, type TechnicalProfile } from '../../../shared/analysis.js';
import { planDurationMs } from '../../../shared/editPlan.js';
import { planWithRules } from '../../src/ai/index.js';
import { majorIssueLabels, motionPreference, pickRanges } from '../../src/ai/window-select.js';
import type { AssetBrief } from '../../src/ai/types.js';
import { technicalProfile } from '../../src/video/analysis.js';
import { bins, engine } from '../video/helpers.js';

let f: AnalysisFootage;
let mixed: TechnicalProfile;
let cut: TechnicalProfile;
const eng = engine();

beforeAll(async () => {
  f = await generateAnalysisFootage(path.join(os.tmpdir(), 'amir-sm-an-footage-rules'), { reuse: true, only: ['mixed', 'cut'] });
  mixed = await technicalProfile(bins.ffmpegPath, f.mixed, await eng.probe(f.mixed));
  cut = await technicalProfile(bins.ffmpegPath, f.cut, await eng.probe(f.cut));
}, 120_000);

/** n copies of a measured clip as separate assets, each with its own analysis entry */
function manyClips(n: number, profile: TechnicalProfile, durationMs: number): { assets: AssetBrief[]; analyses: ClipAnalysis[] } {
  const assets: AssetBrief[] = Array.from({ length: n }, (_v, i) => ({ id: `c${i + 1}`, name: `clip${i + 1}.mp4`, durationMs, width: 540, height: 960, hasAudio: true, kind: 'video' as const }));
  return { assets, analyses: assets.map((a) => technicalToClipAnalysis(a.id, profile)) };
}

const overlaps = (s: { startMs: number; endMs: number }, a: number, b: number) => s.startMs < b && s.endMs > a;

describe('pickRanges (technical window selection)', () => {
  it('avoids the dark and the blurred sections of a real clip', () => {
    for (let len = 1000; len <= 2800; len += 300) {
      const [pick] = pickRanges(mixed, len, 1);
      expect(pick, `len ${len}`).toBeDefined();
      expect(overlaps(pick!, 3000, 5000), `len ${len}: ${pick!.startMs}-${pick!.endMs} hits the dark part`).toBe(false);
      expect(overlaps(pick!, 7000, 9000), `len ${len}: ${pick!.startMs}-${pick!.endMs} hits the blurred part`).toBe(false);
      expect(pick!.issues.filter((i) => i !== 'static')).toEqual([]);
    }
  });

  it('several excerpts of one clip are non-overlapping, in time order, and all avoid the bad parts', () => {
    const picks = pickRanges(mixed, 1500, 3);
    expect(picks).toHaveLength(3);
    for (let i = 1; i < picks.length; i++) expect(picks[i]!.startMs).toBeGreaterThanOrEqual(picks[i - 1]!.endMs);
    for (const p of picks) {
      expect(overlaps(p, 3000, 5000)).toBe(false);
      expect(overlaps(p, 7000, 9000)).toBe(false);
    }
  });

  it('does not straddle a hard scene cut when a range fits inside one scene', () => {
    for (const len of [2000, 3000, 4000]) {
      const [pick] = pickRanges(cut, len, 1);
      expect(pick!.startMs >= 4800 || pick!.endMs <= 5200, `${pick!.startMs}-${pick!.endMs} straddles the cut at 5 s`).toBe(true);
    }
  });

  it('prefers lively footage for high-energy and calmer footage for calm-cinematic', () => {
    expect(motionPreference('high-energy')).toBeGreaterThan(0);
    expect(motionPreference('calm-cinematic')).toBeLessThan(0);
    const win = (i: number, motion: number) => ({ startMs: i * 1000, endMs: (i + 1) * 1000, brightness: 0.5, contrast: 0.6, sharpness: 1, motion, shake: 0, audioDb: null, score: 0.95, issues: [] });
    const profile: TechnicalProfile = {
      analyzerVersion: 'tech-1', durationMs: 8000, analyzedMs: 8000, windowMs: 1000, sampleFps: 8,
      windows: [win(0, 0.05), win(1, 0.05), win(2, 0.05), win(3, 0.05), win(4, 0.9), win(5, 0.9), win(6, 0.9), win(7, 0.9)],
      sceneChangesMs: [], audio: null, issues: [], score: 0.95,
    };
    expect(pickRanges(profile, 2000, 1, 'high-energy')[0]!.startMs).toBeGreaterThanOrEqual(4000);
    expect(pickRanges(profile, 2000, 1, 'calm-cinematic')[0]!.endMs).toBeLessThanOrEqual(4000);
  });

  it('returns nothing for an empty profile; a range longer than the clip is clamped', () => {
    expect(pickRanges({ ...mixed, windows: [] }, 2000, 1)).toEqual([]);
    const [p] = pickRanges(mixed, 60_000, 1);
    expect(p!.startMs).toBe(0);
    expect(p!.endMs).toBeLessThanOrEqual(mixed.analyzedMs);
  });
});

describe('Basic auto-edit (rules planner) with technical measurements', () => {
  const base = { projectId: 'p', brief: '', preset: 'high-energy' as const };

  it('picks technically strong moments instead of "a little into the clip"', () => {
    const { assets, analyses } = manyClips(12, mixed, 12_000);
    const without = planWithRules({ ...base, assets });
    const hitsBad = (segs: { startMs: number; endMs: number }[]) => segs.filter((s) => overlaps(s, 3000, 5000) || overlaps(s, 7000, 9000)).length;
    // the default positions land in the dark part (this is what the measurements are for)
    expect(hitsBad(without.plan.segments)).toBeGreaterThan(0);

    const withTech = planWithRules({ ...base, assets, clipAnalyses: analyses });
    expect(withTech.plan.segments.length).toBeGreaterThan(0);
    expect(hitsBad(withTech.plan.segments)).toBe(0);
    expect(withTech.source).toBe('rules');
    expect(planDurationMs(withTech.plan)).toBeGreaterThan(10_000);
    // honest labelling
    expect(withTech.notes.join(' ')).toMatch(/local signal measurements/);
    expect(withTech.notes.join(' ')).toMatch(/does not know what is in the shots/);
    expect(withTech.rationale).toMatch(/Basic auto-edit \(no AI\)/);
    expect(withTech.rationale).toMatch(/technically strong moments/);
    expect(withTech.rationale).toMatch(/does not know what is in them/);
    expect(withTech.notes.join(' ')).toMatch(/avoiding parts measured as/);
  });

  it('works for every preset, keeps clip order and stays inside real durations', () => {
    const { assets, analyses } = manyClips(5, mixed, 12_000);
    for (const preset of ['day-in-the-life', 'calm-cinematic', 'motivation', 'high-energy', 'storytelling', 'custom'] as const) {
      const res = planWithRules({ ...base, preset, assets, clipAnalyses: analyses });
      const order = res.plan.segments.map((s) => s.assetId);
      const nums = order.map((id) => Number(id.slice(1)));
      expect(nums).toEqual([...nums].sort((a, b) => a - b)); // the owner's clip order is kept
      expect(order[0]).toBe('c1');
      for (const s of res.plan.segments) {
        expect(s.startMs).toBeGreaterThanOrEqual(0);
        expect(s.endMs).toBeLessThanOrEqual(12_000);
        expect(s.endMs).toBeGreaterThan(s.startMs);
      }
    }
  });

  it('missing or empty analyses fall back to the previous behaviour; a technical entry without a profile is ignored', () => {
    const { assets } = manyClips(4, mixed, 12_000);
    const plain = planWithRules({ ...base, assets });
    const ignored = planWithRules({ ...base, assets, clipAnalyses: [{ assetId: 'c1', source: 'technical', analyzerVersion: 'tech-1', tags: [], moments: [], framesUsed: 0 }] });
    expect(ignored.plan.segments).toEqual(plain.plan.segments);
    expect(plain.notes.join(' ')).not.toMatch(/local signal measurements/);
    expect(plain.rationale).toMatch(/chosen by clip length only/);
  });

  it('visual analyses are NOT used by the rules planner (it stays a technical-only planner)', () => {
    const { assets } = manyClips(4, mixed, 12_000);
    const visual: ClipAnalysis = { assetId: 'c1', source: 'visual', analyzerVersion: 'vision-1', summary: 'a kitchen', tags: ['kitchen'], moments: [{ startMs: 9000, endMs: 11000, description: 'x', score: 1, issues: [] }], framesUsed: 4 };
    const a = planWithRules({ ...base, assets });
    const b = planWithRules({ ...base, assets, clipAnalyses: [visual] });
    expect(b.plan.segments).toEqual(a.plan.segments);
  });

  it('tells the owner when a clip measures as dark for most of its length', () => {
    const darkProfile = { ...mixed, windows: mixed.windows.map((w) => ({ ...w, brightness: 0.02, score: 0.25, issues: ['too_dark' as const] })), issues: [{ code: 'too_dark' as const, label: 'too dark', share: 1, ranges: [{ startMs: 0, endMs: mixed.analyzedMs }] }] };
    const { assets, analyses } = manyClips(3, darkProfile, 12_000);
    const res = planWithRules({ ...base, assets, clipAnalyses: analyses });
    expect(res.notes.join(' ')).toMatch(/"clip1\.mp4" measures as too dark for most of its length/);
    expect(majorIssueLabels(darkProfile)).toEqual(['too dark']);
  });
});
