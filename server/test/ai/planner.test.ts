import { describe, expect, it } from 'vitest';
import { createAiService, AiLimitError, AiOutputError, AiUnavailableError } from '../../src/ai/index.js';
import { EditPlanSchema, MAX_OUTPUT_DURATION_MS, MAX_SEGMENTS, planDurationMs } from '../../../shared/editPlan.js';
import { FakeClient, MemoryUsageStore, assets, httpError, makeConfig, noSleep, planResponse, rawPlan, toolUse, validPlan } from './helpers.js';

function setup(script: ConstructorParameters<typeof FakeClient>[0], cfg = makeConfig()) {
  const usage = new MemoryUsageStore();
  const client = new FakeClient(script);
  const ai = createAiService({ config: cfg, usage, client, sleep: noSleep });
  return { ai, usage, client };
}

const baseInput = { projectId: 'p1', brief: 'A calm morning routine', preset: 'calm-cinematic' as const, assets: assets() };

describe('planEdit (AI path)', () => {
  it('accepts a valid plan and records usage', async () => {
    const { ai, usage, client } = setup([planResponse()]);
    const res = await ai.planEdit(baseInput);
    expect(res.source).toBe('ai');
    expect(res.model).toBe('claude-sonnet-5-5');
    expect(res.plan.segments).toHaveLength(2);
    expect(EditPlanSchema.safeParse(res.plan).success).toBe(true);
    expect(res.rationale).toContain('Warm');
    expect(client.calls).toHaveLength(1);
    expect(usage.rows).toHaveLength(1);
    expect(usage.rows[0]).toMatchObject({ role: 'creative_director', model: 'claude-sonnet-5-5', inputTokens: 1000, outputTokens: 500, ok: true, projectId: 'p1' });
  });

  it('does not use forced tool_choice (rejected by sonnet-5-5) and sends a tool schema + timeout', async () => {
    const { ai, client } = setup([planResponse()]);
    await ai.planEdit(baseInput);
    const { params, options } = client.calls[0]!;
    expect(params.tool_choice).toEqual({ type: 'auto' });
    expect(params.tools[0].name).toBe('submit_edit_plan');
    expect(params.tools[0].input_schema.type).toBe('object');
    expect(params.system).toContain('submit_edit_plan');
    expect(options.timeout).toBe(90_000);
    expect(JSON.stringify(params)).not.toContain('test-key-not-real');
  });

  it('includes real assets, brief, preset guidance and the engine capability list in the prompt', async () => {
    const { ai, client } = setup([planResponse()]);
    await ai.planEdit({ ...baseInput, userSubtitleLines: ['Good morning'] });
    const user = client.userText();
    expect(user).toContain('morning.mp4');
    expect(user).toContain('id="a2"');
    expect(user).toContain('duration=12000ms');
    expect(user).toContain('hasAudio=false');
    expect(user).toContain('A calm morning routine');
    expect(user).toContain('Calm cinematic');
    expect(user).toContain('Good morning');
    const sys = client.calls[0]!.params.system as string;
    expect(sys).toContain('WHAT THE VIDEO ENGINE CAN DO');
    expect(sys).toContain('CANNOT DO');
    expect(sys).toContain('NEVER write subtitle text yourself');
  });

  it('repairs invalid output with one retry that includes the validation error', async () => {
    const bad = toolUse('submit_edit_plan', { rationale: 'x', plan: { version: 1, segments: [] } });
    const { ai, client, usage } = setup([bad, planResponse()]);
    const res = await ai.planEdit(baseInput);
    expect(res.plan.segments).toHaveLength(2);
    expect(res.notes.join(' ')).toMatch(/retry/);
    expect(client.calls).toHaveLength(2);
    const second = client.calls[1]!.params.messages;
    expect(second).toHaveLength(3);
    expect(second[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1', is_error: true });
    expect(second[2].content[0].content).toContain('segments');
    expect(usage.rows.map((r) => r.ok)).toEqual([false, true]);
  });

  it('repairs a response that did not call the tool at all', async () => {
    const text = { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Here is my plan...' }], usage: { input_tokens: 10, output_tokens: 10 } };
    const { ai, client } = setup([text, planResponse()]);
    await ai.planEdit(baseInput);
    expect(client.calls[1]!.params.messages[2].content).toContain('did not call the tool');
  });

  it('throws AiOutputError when the repair also fails (and records both failures)', async () => {
    const bad = toolUse('submit_edit_plan', { rationale: 'x', plan: { version: 2 } });
    const { ai, client, usage } = setup([bad, bad]);
    await expect(ai.planEdit(baseInput)).rejects.toBeInstanceOf(AiOutputError);
    expect(client.calls).toHaveLength(2);
    expect(usage.rows).toHaveLength(2);
    expect(usage.rows.every((r) => !r.ok && r.error)).toBe(true);
  });

  it('tolerates string-encoded tool input', async () => {
    const r = planResponse() as any;
    r.content[0].input = JSON.stringify(r.content[0].input);
    const { ai } = setup([r]);
    expect((await ai.planEdit(baseInput)).plan.segments).toHaveLength(2);
  });

  describe('sanitization', () => {
    it('clamps out-of-range segments to real asset durations', async () => {
      const plan = rawPlan({
        segments: [
          { id: 's1', assetId: 'a1', startMs: 9000, endMs: 60_000 }, // a1 is 12s
          { id: 's2', assetId: 'a2', startMs: 20_000, endMs: 30_000 }, // entirely beyond 8s -> dropped
        ],
      });
      const { ai } = setup([planResponse(plan)]);
      const res = await ai.planEdit(baseInput);
      expect(res.plan.segments).toHaveLength(1);
      expect(res.plan.segments[0]).toMatchObject({ assetId: 'a1', startMs: 9000, endMs: 12_000 });
      expect(res.notes.join(' ')).toMatch(/Trimmed 1/);
      expect(res.notes.join(' ')).toMatch(/Removed 1 segment/);
    });

    it('drops unknown asset ids and audio assets used as video', async () => {
      const plan = rawPlan({
        segments: [
          { id: 's1', assetId: 'ghost', startMs: 0, endMs: 3000 },
          { id: 's2', assetId: 'm1', startMs: 0, endMs: 3000 },
          { id: 's3', assetId: 'a1', startMs: 0, endMs: 3000 },
        ],
      });
      const { ai } = setup([planResponse(plan)]);
      const res = await ai.planEdit(baseInput);
      expect(res.plan.segments.map((s) => s.assetId)).toEqual(['a1']);
      expect(res.notes.join(' ')).toMatch(/unknown or non-video/);
    });

    it('fails with AiOutputError when no segment survives (no fallback)', async () => {
      const plan = rawPlan({ segments: [{ id: 's1', assetId: 'ghost', startMs: 0, endMs: 3000 }] });
      const { ai } = setup([planResponse(plan)]);
      await expect(ai.planEdit(baseInput)).rejects.toBeInstanceOf(AiOutputError);
    });

    it('strips invented subtitle cues when the owner supplied none', async () => {
      const plan = rawPlan({ subtitles: { source: 'user-provided', position: 'bottom', cues: [{ startMs: 0, endMs: 2000, text: 'Welcome to my channel' }] } });
      const { ai } = setup([planResponse(plan)]);
      const res = await ai.planEdit(baseInput);
      expect(res.plan.subtitles).toBeUndefined();
      expect(res.notes.join(' ')).toMatch(/Removed 1 subtitle cue/);
    });

    it('keeps cues traceable to the owner lines, removes invented ones, never alters text', async () => {
      const plan = rawPlan({
        subtitles: {
          source: 'user-provided',
          position: 'bottom',
          cues: [
            { startMs: 0, endMs: 2000, text: 'Good morning' },
            { startMs: 2000, endMs: 4000, text: 'Buy my course now' },
            { startMs: 4000, endMs: 6000, text: 'start the day, slowly.' },
          ],
        },
      });
      const { ai } = setup([planResponse(plan)]);
      const res = await ai.planEdit({ ...baseInput, userSubtitleLines: ['Good morning', 'Start the day slowly'] });
      expect(res.plan.subtitles?.cues.map((c) => c.text)).toEqual(['Good morning', 'start the day, slowly.']);
      expect(res.plan.subtitles?.source).toBe('user-provided');
      expect(res.notes.join(' ')).toMatch(/Removed 1 subtitle cue/);
    });

    it('places the owner lines evenly when the model emitted no usable cues', async () => {
      const { ai } = setup([planResponse()]);
      const res = await ai.planEdit({ ...baseInput, userSubtitleLines: ['Line one', 'Line two'] });
      expect(res.plan.subtitles?.cues.map((c) => c.text)).toEqual(['Line one', 'Line two']);
      expect(res.notes.join(' ')).toMatch(/spread evenly/);
    });

    it('enforces the maximum output duration', async () => {
      const long = [{ id: 'L', name: 'long.mp4', durationMs: 600_000, width: 1080, height: 1920, hasAudio: true, kind: 'video' as const }];
      const plan = rawPlan({
        segments: [
          { id: 's1', assetId: 'L', startMs: 0, endMs: 150_000 },
          { id: 's2', assetId: 'L', startMs: 150_000, endMs: 300_000 },
        ],
        titles: [{ id: 't1', text: 'late', startMs: 200_000, endMs: 205_000 }],
      });
      const { ai } = setup([planResponse(plan)]);
      const res = await ai.planEdit({ ...baseInput, assets: long });
      expect(planDurationMs(res.plan)).toBeLessThanOrEqual(MAX_OUTPUT_DURATION_MS);
      expect(res.plan.titles).toHaveLength(0);
      expect(res.notes.join(' ')).toMatch(/shortened/);
    });

    it('speed changes count towards the duration cap', async () => {
      const long = [{ id: 'L', name: 'long.mp4', durationMs: 900_000, width: 1080, height: 1920, hasAudio: true, kind: 'video' as const }];
      const plan = rawPlan({ segments: [{ id: 's1', assetId: 'L', startMs: 0, endMs: 400_000, speed: 0.5 }] });
      const { ai } = setup([planResponse(plan)]);
      const res = await ai.planEdit({ ...baseInput, assets: long });
      expect(planDurationMs(res.plan)).toBeLessThanOrEqual(MAX_OUTPUT_DURATION_MS);
    });

    it('never exceeds the segment cap', async () => {
      // the schema itself caps at 40, so build exactly 40 valid + duplicate ids and make sure ids stay unique
      const segs = Array.from({ length: MAX_SEGMENTS }, () => ({ id: 'dup', assetId: 'a1', startMs: 0, endMs: 1000 }));
      const { ai } = setup([planResponse(rawPlan({ segments: segs }))]);
      const res = await ai.planEdit(baseInput);
      expect(res.plan.segments.length).toBeLessThanOrEqual(MAX_SEGMENTS);
      expect(new Set(res.plan.segments.map((s) => s.id)).size).toBe(res.plan.segments.length);
    });

    it('removes music that is not an uploaded audio asset and mutes clips without audio', async () => {
      const plan = rawPlan({ audio: { normalizeLoudness: true, music: { assetId: 'a1', volume: 0.3, fadeOutMs: 500 } } });
      const { ai } = setup([planResponse(plan)]);
      const res = await ai.planEdit(baseInput);
      expect(res.plan.audio.music).toBeUndefined();
      expect(res.plan.segments.find((s) => s.assetId === 'a2')?.audio).toBe('mute');
    });

    it('keeps music that references an uploaded audio asset', async () => {
      const plan = rawPlan({ audio: { normalizeLoudness: true, music: { assetId: 'm1', volume: 0.3, fadeOutMs: 500 } } });
      const { ai } = setup([planResponse(plan)]);
      expect((await ai.planEdit(baseInput)).plan.audio.music?.assetId).toBe('m1');
    });

    it('records unmet requests as limitations even if the model stays silent', async () => {
      const { ai } = setup([planResponse()]);
      const brief = 'Add AI generated b-roll, trending songs from the internet, auto-captions of my speech, remove the silences and add a glitch effect';
      const res = await ai.planEdit({ ...baseInput, brief, assets: assets().filter((a) => a.kind === 'video') });
      const text = res.plan.limitations.join(' ');
      expect(text).toMatch(/B-roll/i);
      expect(text).toMatch(/Music/i);
      expect(text).toMatch(/transcription|captions/i);
      expect(text).toMatch(/speech|silences/i);
      expect(text).toMatch(/effects/i);
    });

    it('does not duplicate limitations the model already reported', async () => {
      const plan = rawPlan({ limitations: ['I cannot generate AI b-roll; only your clips are used.'] });
      const { ai } = setup([planResponse(plan)]);
      const res = await ai.planEdit({ ...baseInput, brief: 'please add AI generated b-roll' });
      expect(res.plan.limitations.filter((l) => /b-roll/i.test(l))).toHaveLength(1);
    });
  });

  describe('revisions', () => {
    it('includes the previous plan and the revision request in the prompt', async () => {
      const previousPlan = validPlan({ summary: 'PREVIOUS-PLAN-MARKER' });
      const { ai, client } = setup([planResponse()]);
      await ai.planEdit({ ...baseInput, previousPlan, revisionRequest: 'Make it faster and shorter' });
      const user = client.userText();
      expect(user).toContain('<previous_plan>');
      expect(user).toContain('PREVIOUS-PLAN-MARKER');
      expect(user).toContain('Make it faster and shorter');
      expect(user).toContain('REVISION');
    });
  });

  describe('availability and fallback', () => {
    it('no key -> AiUnavailableError without calling anything', async () => {
      const { ai, client, usage } = setup([planResponse()], makeConfig({ apiKey: null }));
      await expect(ai.planEdit(baseInput)).rejects.toBeInstanceOf(AiUnavailableError);
      expect(client.calls).toHaveLength(0);
      expect(usage.rows).toHaveLength(0);
    });

    it('no key + allowRulesFallback -> rules plan labelled source "rules"', async () => {
      const { ai, client } = setup([planResponse()], makeConfig({ apiKey: null }));
      const res = await ai.planEdit(baseInput, { allowRulesFallback: true });
      expect(res.source).toBe('rules');
      expect(client.calls).toHaveLength(0);
      expect(res.notes.join(' ')).toMatch(/no AI interpreted your brief/i);
      expect(res.notes.join(' ')).toMatch(/not configured/);
    });

    it('AI failure + allowRulesFallback -> rules plan, and the reason is in notes', async () => {
      const { ai } = setup([httpError(401)]);
      const res = await ai.planEdit(baseInput, { allowRulesFallback: true });
      expect(res.source).toBe('rules');
      expect(res.notes.join(' ')).toMatch(/API key rejected/);
    });

    it('AI failure without allowRulesFallback -> error propagates', async () => {
      const { ai } = setup([httpError(401)]);
      await expect(ai.planEdit(baseInput)).rejects.toBeInstanceOf(AiUnavailableError);
    });

    it('daily limit + allowRulesFallback -> rules plan, no API call', async () => {
      const usage = new MemoryUsageStore();
      usage.seed(60);
      const client = new FakeClient([planResponse()]);
      const ai = createAiService({ config: makeConfig(), usage, client, sleep: noSleep });
      const res = await ai.planEdit(baseInput, { allowRulesFallback: true });
      expect(res.source).toBe('rules');
      expect(client.calls).toHaveLength(0);
      await expect(ai.planEdit(baseInput)).rejects.toBeInstanceOf(AiLimitError);
    });

    it('no video assets -> AiOutputError even with fallback', async () => {
      const { ai } = setup([planResponse()]);
      await expect(ai.planEdit({ ...baseInput, assets: assets().filter((a) => a.kind === 'audio') }, { allowRulesFallback: true })).rejects.toBeInstanceOf(AiOutputError);
    });
  });
});
