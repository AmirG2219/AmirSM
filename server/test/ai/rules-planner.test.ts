import { describe, expect, it } from 'vitest';
import { planWithRules } from '../../src/ai/index.js';
import { extractQuotedTitle } from '../../src/ai/rules-planner.js';
import { EditPlanSchema, MAX_OUTPUT_DURATION_MS, STYLE_PRESETS, planDurationMs } from '../../../shared/editPlan.js';
import { assets, makeAssets } from './helpers.js';

const base = { projectId: 'p', brief: '', preset: 'custom' as const };

function check(plan: ReturnType<typeof planWithRules>['plan'], inputAssets: ReturnType<typeof makeAssets>) {
  expect(EditPlanSchema.safeParse(plan).success).toBe(true);
  const byId = new Map(inputAssets.map((a) => [a.id, a]));
  for (const s of plan.segments) {
    const a = byId.get(s.assetId)!;
    expect(a).toBeDefined();
    expect(s.startMs).toBeGreaterThanOrEqual(0);
    expect(s.endMs).toBeLessThanOrEqual(a.durationMs);
    expect(s.endMs).toBeGreaterThan(s.startMs);
  }
  expect(planDurationMs(plan)).toBeLessThanOrEqual(MAX_OUTPUT_DURATION_MS);
}

describe('rules planner (no LLM)', () => {
  it.each([1, 3, 10])('produces a valid plan for %i clip(s) of 10s', (n) => {
    const a = makeAssets(n, 10_000);
    const res = planWithRules({ ...base, assets: a });
    expect(res.source).toBe('rules');
    check(res.plan, a);
    expect(res.plan.segments.length).toBeGreaterThanOrEqual(1);
    expect(res.plan.audio.normalizeLoudness).toBe(true);
    expect(res.plan.look.fadeInMs).toBeGreaterThan(0);
    expect(res.plan.look.fadeOutMs).toBeGreaterThan(0);
    expect(res.notes.join(' ')).toMatch(/no AI interpreted your brief/i);
    expect(res.rationale).toMatch(/Basic auto-edit \(no AI\)/);
  });

  it('keeps the given clip order', () => {
    const a = makeAssets(4, 8_000);
    const res = planWithRules({ ...base, assets: a });
    const order = res.plan.segments.map((s) => s.assetId);
    expect(order).toEqual(['c1', 'c2', 'c3', 'c4']);
  });

  it('long clips: stays within 15-45s, uses several excerpts of one very long clip', () => {
    const a = makeAssets(1, 20 * 60_000);
    const res = planWithRules({ ...base, preset: 'calm-cinematic', assets: a });
    check(res.plan, a);
    const dur = planDurationMs(res.plan);
    expect(dur).toBeGreaterThanOrEqual(15_000);
    expect(dur).toBeLessThanOrEqual(45_000);
    expect(res.plan.segments.length).toBeGreaterThan(1);
    // excerpts of the same clip must not overlap
    const sorted = [...res.plan.segments].sort((x, y) => x.startMs - y.startMs);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i]!.startMs).toBeGreaterThanOrEqual(sorted[i - 1]!.endMs);
  });

  it('many long clips stay within the Reels range and the segment cap', () => {
    const a = makeAssets(30, 120_000);
    for (const preset of STYLE_PRESETS) {
      const res = planWithRules({ ...base, preset, assets: a });
      check(res.plan, a);
      const dur = planDurationMs(res.plan);
      expect(dur).toBeLessThanOrEqual(45_000);
      expect(dur).toBeGreaterThanOrEqual(15_000);
    }
  });

  it('scarce footage: shots run longer than the preset length instead of ending far below 15s', () => {
    const a = makeAssets(3, 10_000);
    const res = planWithRules({ ...base, preset: 'calm-cinematic', assets: a });
    expect(planDurationMs(res.plan)).toBeGreaterThanOrEqual(25_000);
    check(res.plan, a);
  });

  it('short footage is not stretched and the shortfall is explained', () => {
    const a = makeAssets(1, 4_000);
    const res = planWithRules({ ...base, assets: a });
    check(res.plan, a);
    expect(planDurationMs(res.plan)).toBeLessThanOrEqual(4_000);
    expect(res.notes.join(' ')).toMatch(/shorter than the usual 15-45 s/);
  });

  it('applies preset defaults: calm-cinematic crossfades 600ms with cinematic look; motivation uses cuts', () => {
    const a = makeAssets(6, 10_000);
    const calm = planWithRules({ ...base, preset: 'calm-cinematic', assets: a }).plan;
    expect(calm.look.preset).toBe('cinematic');
    expect(calm.segments[1]!.transitionIn).toMatchObject({ type: 'crossfade', durationMs: 600 });
    expect(calm.segments[0]!.endMs - calm.segments[0]!.startMs).toBeLessThanOrEqual(6_000);
    const mot = planWithRules({ ...base, preset: 'motivation', assets: a }).plan;
    expect(mot.segments.every((s) => s.transitionIn.type === 'cut')).toBe(true);
    const day = planWithRules({ ...base, preset: 'day-in-the-life', assets: a }).plan;
    expect(day.look.preset).toBe('warm');
  });

  it('muted clips without audio, landscape clips as contain-blur', () => {
    const a = makeAssets(2, 8_000); // c1: portrait + no audio (i=0), c2: landscape + audio
    const res = planWithRules({ ...base, assets: a });
    expect(res.plan.segments[0]).toMatchObject({ assetId: 'c1', audio: 'mute', fit: 'cover' });
    expect(res.plan.segments[1]).toMatchObject({ assetId: 'c2', audio: 'keep', fit: 'contain-blur' });
  });

  it('adds a title only when the brief has explicit quoted text', () => {
    const a = makeAssets(2, 8_000);
    const none = planWithRules({ ...base, brief: 'a motivational video about discipline', preset: 'motivation', assets: a });
    expect(none.plan.titles).toHaveLength(0);
    const quoted = planWithRules({ ...base, brief: 'Title: "Discipline beats motivation" please', preset: 'motivation', assets: a });
    expect(quoted.plan.titles).toHaveLength(1);
    expect(quoted.plan.titles[0]).toMatchObject({ text: 'Discipline beats motivation', size: 'large' });
    expect(quoted.plan.titles[0]!.endMs).toBeLessThanOrEqual(planDurationMs(quoted.plan));
  });

  it('extractQuotedTitle handles curly quotes and ignores apostrophes', () => {
    expect(extractQuotedTitle('use “Slow mornings” as the title')).toBe('Slow mornings');
    expect(extractQuotedTitle("it's amir's day")).toBeUndefined();
  });

  it('subtitles come only from the owner lines (none by default)', () => {
    const a = makeAssets(2, 8_000);
    expect(planWithRules({ ...base, assets: a }).plan.subtitles).toBeUndefined();
    const withLines = planWithRules({ ...base, assets: a, userSubtitleLines: ['First line', 'Second line'] });
    expect(withLines.plan.subtitles?.cues.map((c) => c.text)).toEqual(['First line', 'Second line']);
    expect(withLines.plan.subtitles?.source).toBe('user-provided');
  });

  it('flags that the brief was not interpreted and reports unsupported requests', () => {
    const a = makeAssets(2, 8_000);
    const res = planWithRules({ ...base, brief: 'make it epic with AI generated b-roll and trending songs', assets: a });
    expect(res.plan.limitations[0]).toMatch(/not interpreted/);
    expect(res.plan.limitations.join(' ')).toMatch(/B-roll/i);
    expect(res.plan.limitations.join(' ')).toMatch(/Music/i);
  });

  it('ignores audio assets as video clips; throws when no video exists', () => {
    const res = planWithRules({ ...base, assets: assets() });
    expect(res.plan.segments.every((s) => s.assetId === 'a1' || s.assetId === 'a2')).toBe(true);
    expect(() => planWithRules({ ...base, assets: assets().filter((a) => a.kind === 'audio') })).toThrow();
  });

  it('notes that a revision cannot be applied by rules', () => {
    const a = makeAssets(2, 8_000);
    const res = planWithRules({ ...base, assets: a, revisionRequest: 'make it faster' });
    expect(res.notes.join(' ')).toMatch(/cannot apply changes/);
  });
});
