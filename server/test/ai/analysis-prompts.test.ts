import { describe, expect, it } from 'vitest';
import { technicalToClipAnalysis, type ClipAnalysis, type TechnicalProfile } from '../../../shared/analysis.js';
import { STYLE_PRESETS, planDurationMs } from '../../../shared/editPlan.js';
import { createAiService, planWithRules } from '../../src/ai/index.js';
import { PRESET_GUIDANCE, plannerSystemPrompt, plannerUserPrompt } from '../../src/ai/prompts/planner.js';
import { captionSystemPrompt, captionUserPrompt, CAPTION_TONES } from '../../src/ai/prompts/caption.js';
import { describeTechnical, hasVisual } from '../../src/ai/prompts/analysis.js';
import { FakeClient, MemoryUsageStore, assets, makeAssets, makeConfig, noSleep, planResponse, toolUse, validPlan } from './helpers.js';

const win = (i: number, over: Record<string, unknown> = {}) => ({
  startMs: i * 1000, endMs: (i + 1) * 1000, brightness: 0.5, contrast: 0.7, sharpness: 1, motion: 0.3, shake: 0, audioDb: -25, score: 1, issues: [] as any[], ...over,
});
const profile: TechnicalProfile = {
  analyzerVersion: 'tech-1', durationMs: 12_000, analyzedMs: 12_000, windowMs: 1000, sampleFps: 8,
  windows: [win(0), win(1), win(2), win(3, { score: 0.25, brightness: 0, issues: ['too_dark'] }), win(4, { score: 0.25, brightness: 0, issues: ['too_dark'] }), win(5), win(6), win(7)],
  sceneChangesMs: [3000, 5000],
  audio: { present: true, meanDb: -30, silentRatio: 0.1 },
  issues: [{ code: 'too_dark', label: 'too dark', share: 0.25, ranges: [{ startMs: 3000, endMs: 5000 }] }],
  score: 0.8,
};
const technical = (id: string) => technicalToClipAnalysis(id, profile);
const visual = (id: string, over: Partial<ClipAnalysis> = {}): ClipAnalysis => ({
  assetId: id, source: 'visual', analyzerVersion: 'vision-1', summary: 'A person sits in a car seat.', tags: ['driving'],
  moments: [{ startMs: 2000, endMs: 4000, description: 'Person at the wheel.', score: 0.8, issues: [] }], framesUsed: 5, model: 'claude-sonnet-5-5', ...over,
});

function make(script: ConstructorParameters<typeof FakeClient>[0]) {
  const client = new FakeClient(script);
  const ai = createAiService({ config: makeConfig(), usage: new MemoryUsageStore(), client, sleep: noSleep });
  return { ai, client };
}
const input = { projectId: 'p1', brief: 'A day of driving', preset: 'high-energy' as const, assets: assets() };

describe('planner receives the analyses, with provenance', () => {
  it('user prompt lists VISUAL and TECHNICAL separately and labels what each is', async () => {
    const { ai, client } = make([planResponse()]);
    await ai.planEdit({ ...input, clipAnalyses: [visual('a1'), technical('a1'), technical('a2')] });
    const user = client.userText();
    expect(user).toContain('<clip_analysis');
    expect(user).toMatch(/VISUAL \[Claude looked at a few SAMPLED STILLS of this clip \(no audio, no motion, not the full video\); 5 stills\]/);
    expect(user).toContain('summary: A person sits in a car seat.');
    expect(user).toContain('moment 2000-4000 ms (usability 0.8): Person at the wheel.');
    expect(user).toMatch(/TECHNICAL \[signal measurements only .* says NOTHING about what is in the shots\]/);
    expect(user).toMatch(/too dark: 3\.0-5\.0 s/);
    expect(user).toMatch(/hard cut\(s\) at 3\.0 s, 5\.0 s/);
    // a2 has only technical data: the prompt says the content is unknown
    expect(user).toMatch(/assetId="a2"[\s\S]*VISUAL: not analysed \(you know nothing about the content of this clip\)/);
  });

  it('system prompt: with visual data the "cannot see" notice becomes the partial-vision notice; without, it stays strict', async () => {
    const withVisual = make([planResponse()]);
    await withVisual.ai.planEdit({ ...input, clipAnalyses: [visual('a1')] });
    const s1 = withVisual.client.calls[0]!.params.system as string;
    expect(s1).toMatch(/You have NOT watched the video and you cannot hear it/);
    expect(s1).toMatch(/sampled still frames/);

    const technicalOnly = make([planResponse()]);
    await technicalOnly.ai.planEdit({ ...input, clipAnalyses: [technical('a1')] });
    expect(technicalOnly.client.calls[0]!.params.system).toMatch(/You cannot see or hear the video/);

    const none = make([planResponse()]);
    await none.ai.planEdit(input);
    expect(none.client.calls[0]!.params.system).toMatch(/You cannot see or hear the video/);
    expect(none.client.userText()).not.toContain('<clip_analysis');
  });

  it('only video assets of THIS project are listed; analyses of unknown assets are never rendered', () => {
    const text = plannerUserPrompt({ ...input, clipAnalyses: [visual('a1'), visual('ghost'), visual('m1')] });
    expect(text).toContain('assetId="a1"');
    expect(text).not.toContain('ghost');
    expect(text).not.toContain('assetId="m1"'); // audio asset
  });

  it('the planner system prompt tells the model how to use analyses without overclaiming', () => {
    const s = plannerSystemPrompt({ visual: true });
    expect(s).toMatch(/avoid stretches marked too dark/);
    expect(s).toMatch(/Do not claim anything about what is in the footage except what <clip_analysis> states/);
  });

  it('describeTechnical lists strong stretches, problems, cuts and audio', () => {
    const d = describeTechnical(profile);
    expect(d).toMatch(/technically strong .*: 0\.0-3\.0 s, 5\.0-8\.0 s/);
    expect(d).toMatch(/too dark: 3\.0-5\.0 s/);
    expect(d).toMatch(/audio level about -30 dBFS, 10% near-silent/);
    expect(hasVisual([technical('a1')])).toBe(false);
    expect(hasVisual([visual('a1')])).toBe(true);
    expect(hasVisual([visual('a1', { summary: undefined, tags: [], moments: [] })])).toBe(false);
  });
});

describe('caption prompt: only visual summaries count as "seen"', () => {
  const plan = validPlan({ summary: 'Fast edit' });
  const cinput = { projectId: 'p1', brief: 'driving day', preset: 'high-energy' as const, plan, assets: assets() };

  it('includes <what_the_editor_saw> for visual analyses of clips used in the plan, with the no-claim rules intact', async () => {
    const { ai, client } = make([toolUse('submit_caption', { hook: 'Hook', body: 'Body', cta: '', hashtags: ['drive'] })]);
    await ai.writeCaption({ ...cinput, clipAnalyses: [visual('a1'), visual('a2', { summary: 'A cup of coffee on a table.', tags: ['eating'] })] });
    const user = client.userText();
    expect(user).toContain('<what_the_editor_saw');
    expect(user).toContain('A person sits in a car seat.');
    expect(user).toContain('A cup of coffee on a table.');
    expect(user).toMatch(/sampled stills/i);
    const sys = client.calls[0]!.params.system as string;
    expect(sys).toMatch(/not the whole video/);
    expect(sys).toMatch(/Never describe what happens in the footage beyond that/);
    expect(sys).toMatch(/Never invent|never invent/);
  });

  it('technical-only analyses never appear as something seen', () => {
    const user = captionUserPrompt({ ...cinput, clipAnalyses: [technical('a1'), technical('a2')] });
    expect(user).not.toContain('what_the_editor_saw');
    expect(user).not.toMatch(/too dark|technically strong/);
    expect(captionSystemPrompt({ visual: false })).toMatch(/You cannot see or hear the video/);
  });

  it('visual analyses of clips that are NOT in the plan are left out', () => {
    const user = captionUserPrompt({ ...cinput, clipAnalyses: [visual('a1'), visual('c9', { summary: 'SECRET UNUSED CLIP' })] });
    expect(user).toContain('A person sits in a car seat.');
    expect(user).not.toContain('SECRET UNUSED CLIP');
  });
});

describe('high-energy preset (soccer / driving / sports / action)', () => {
  it('is a real preset with planner guidance: fast cuts, bright look, no slow fades or crossfades', () => {
    expect(STYLE_PRESETS).toContain('high-energy');
    const g = PRESET_GUIDANCE['high-energy'];
    expect(g).toMatch(/1-2 s per clip/);
    expect(g).toMatch(/HARD CUTS only/);
    expect(g).toMatch(/never crossfade or dip-to-black/);
    expect(g).toMatch(/Look: bright/);
    expect(g).toMatch(/no slow fades/);
    expect(plannerUserPrompt({ ...input }).includes('<style_preset name="high-energy">')).toBe(true);
    for (const p of STYLE_PRESETS) expect(PRESET_GUIDANCE[p]).toBeTruthy();
    for (const p of STYLE_PRESETS) expect(CAPTION_TONES[p] ?? CAPTION_TONES.custom).toBeTruthy();
  });

  it('rules planner: short punchy shots, hard cuts, bright look, quick fades, no vignette', () => {
    const a = makeAssets(8, 20_000);
    const he = planWithRules({ projectId: 'p', brief: '', preset: 'high-energy', assets: a });
    const calm = planWithRules({ projectId: 'p', brief: '', preset: 'calm-cinematic', assets: a });
    expect(he.plan.look).toMatchObject({ preset: 'bright', vignette: false });
    expect(he.plan.look.fadeInMs).toBeLessThanOrEqual(150);
    expect(he.plan.look.fadeOutMs).toBeLessThanOrEqual(300);
    expect(he.plan.segments.every((s) => s.transitionIn.type === 'cut')).toBe(true);
    const lens = he.plan.segments.map((s) => (s.endMs - s.startMs) / s.speed);
    expect(Math.max(...lens)).toBeLessThanOrEqual(2500);
    const avg = (xs: number[]) => xs.reduce((n, x) => n + x, 0) / xs.length;
    const calmLens = calm.plan.segments.map((s) => (s.endMs - s.startMs) / s.speed);
    expect(avg(lens)).toBeLessThan(avg(calmLens) / 2);
    expect(planDurationMs(he.plan)).toBeGreaterThanOrEqual(15_000);
    expect(planDurationMs(he.plan)).toBeLessThanOrEqual(45_000);
    expect(he.rationale).toMatch(/High energy/);
  });

  it('rules planner with a single long clip and a quoted title: large title, still valid', () => {
    const res = planWithRules({ projectId: 'p', brief: 'Match day "GAME ON"', preset: 'high-energy', assets: makeAssets(1, 60_000) });
    expect(res.plan.titles[0]).toMatchObject({ text: 'GAME ON', size: 'large' });
    expect(res.plan.segments.length).toBeGreaterThan(2);
  });
});
