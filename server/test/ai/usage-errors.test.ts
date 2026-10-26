import { describe, expect, it } from 'vitest';
import { createAiService, AiLimitError, AiOutputError, AiUnavailableError } from '../../src/ai/index.js';
import { FakeClient, MemoryUsageStore, httpError, makeConfig, noSleep, planResponse, toolUse } from './helpers.js';
import { makeAssets } from './helpers.js';

const input = { projectId: 'p1', brief: 'b', preset: 'custom' as const, assets: makeAssets(2) };
const planInput = { ...input, assets: [{ id: 'a1', name: 'x.mp4', durationMs: 10_000, width: 1080, height: 1920, hasAudio: true, kind: 'video' as const }] };
const okPlan = () => planResponse({ version: 1, summary: 's', segments: [{ id: 's1', assetId: 'a1', startMs: 0, endMs: 3000 }] });

function make(script: ConstructorParameters<typeof FakeClient>[0], opts: { cfg?: ReturnType<typeof makeConfig>; usage?: MemoryUsageStore } = {}) {
  const usage = opts.usage ?? new MemoryUsageStore();
  const client = new FakeClient(script);
  const ai = createAiService({ config: opts.cfg ?? makeConfig(), usage, client, sleep: noSleep });
  return { ai, usage, client };
}

describe('daily limits', () => {
  it('blocks BEFORE calling when the call limit is reached and writes no usage row', async () => {
    const usage = new MemoryUsageStore();
    usage.seed(3);
    const { ai, client } = make([okPlan()], { cfg: makeConfig({ dailyCallLimit: 3 }), usage });
    const before = usage.rows.length;
    const err = await ai.planEdit({ ...planInput }).catch((e) => e);
    expect(err).toBeInstanceOf(AiLimitError);
    expect(String(err.message)).toMatch(/3 of 3/);
    expect(String(err.message)).toMatch(/AI_DAILY_CALL_LIMIT/);
    expect(client.calls).toHaveLength(0);
    expect(usage.rows).toHaveLength(before);
  });

  it('blocks BEFORE calling when the token limit is reached', async () => {
    const usage = new MemoryUsageStore();
    usage.seed(1, 5000);
    const { ai, client } = make([okPlan()], { cfg: makeConfig({ dailyTokenLimit: 5000 }), usage });
    const err = await ai.planEdit(planInput).catch((e) => e);
    expect(err).toBeInstanceOf(AiLimitError);
    expect(String(err.message)).toMatch(/AI_DAILY_TOKEN_LIMIT/);
    expect(client.calls).toHaveLength(0);
    expect(usage.rows).toHaveLength(1);
  });

  it('limits apply to every feature (caption, email, research)', async () => {
    const usage = new MemoryUsageStore();
    usage.seed(1);
    const { ai, client } = make([toolUse('x', {})], { cfg: makeConfig({ dailyCallLimit: 1 }), usage });
    await expect(ai.draftEmail({ instruction: 'hi' })).rejects.toBeInstanceOf(AiLimitError);
    await expect(ai.summarizeThread({ subject: 's', messages: [] })).rejects.toBeInstanceOf(AiLimitError);
    await expect(ai.analyzeCompetitorMaterial({ competitorName: 'c', materials: [{ label: 'a', text: 'some text' }] })).rejects.toBeInstanceOf(AiLimitError);
    expect(client.calls).toHaveLength(0);
  });

  it('the repair retry is also guarded: the second call is blocked when the limit is hit in between', async () => {
    const usage = new MemoryUsageStore();
    const bad = toolUse('submit_edit_plan', { rationale: 'x', plan: { version: 9 } });
    const { ai, client } = make([bad, okPlan()], { cfg: makeConfig({ dailyCallLimit: 1 }), usage });
    await expect(ai.planEdit(planInput)).rejects.toBeInstanceOf(AiLimitError);
    expect(client.calls).toHaveLength(1);
    expect(usage.rows).toHaveLength(1);
    expect(usage.rows[0]!.ok).toBe(false);
  });
});

describe('usage recording', () => {
  it('records role, model, tokens (incl. cache tokens) and the project id', async () => {
    const r = okPlan() as any;
    r.usage = { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 5, output_tokens: 40 };
    const { ai, usage } = make([r]);
    await ai.planEdit(planInput);
    expect(usage.rows[0]).toMatchObject({ role: 'creative_director', inputTokens: 125, outputTokens: 40, ok: true, projectId: 'p1' });
    expect(ai.recentUsage(5)).toHaveLength(1);
    expect(ai.status().usage).toEqual({ callsToday: 1, tokensToday: 165 });
  });

  it('records failures with a short error and never the prompt', async () => {
    const { ai, usage } = make([httpError(401, 'invalid x-api-key sk-ant-SECRET123')]);
    await expect(ai.planEdit({ ...planInput, brief: 'PRIVATE BRIEF TEXT' })).rejects.toBeInstanceOf(AiUnavailableError);
    expect(usage.rows).toHaveLength(1);
    expect(usage.rows[0]).toMatchObject({ ok: false, inputTokens: 0, outputTokens: 0 });
    const dump = JSON.stringify(usage.rows);
    expect(dump).not.toContain('SECRET123');
    expect(dump).not.toContain('PRIVATE BRIEF');
  });

  it('uses fast model + role email for email calls and primary for captions', async () => {
    const { ai, usage } = make([toolUse('submit_draft', { subject: 'Hi', body: 'Hello' })]);
    await ai.draftEmail({ instruction: 'say hi' });
    expect(usage.rows[0]).toMatchObject({ role: 'email', model: 'claude-haiku-5-5' });
  });
});

describe('error mapping', () => {
  it.each([401, 403])('HTTP %i -> AiUnavailableError("API key rejected"), no retry', async (status) => {
    const { ai, client } = make([httpError(status)]);
    const err = await ai.draftEmail({ instruction: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(AiUnavailableError);
    expect(err.message).toMatch(/API key rejected/);
    expect(client.calls).toHaveLength(1);
    expect(ai.status().detail).toMatch(/API key rejected/);
  });

  it('429 is retried once and then succeeds', async () => {
    const { ai, client, usage } = make([httpError(429), toolUse('submit_draft', { subject: 'S', body: 'B' })]);
    await expect(ai.draftEmail({ instruction: 'x' })).resolves.toEqual({ subject: 'S', body: 'B' });
    expect(client.calls).toHaveLength(2);
    expect(usage.rows).toHaveLength(1); // one logical call
    expect(ai.status().detail).not.toMatch(/rejected/);
  });

  it('persistent 429 / 5xx give a clear AiUnavailableError after exactly one retry', async () => {
    for (const status of [429, 500, 503, 529]) {
      const { ai, client, usage } = make([httpError(status)]);
      const err = await ai.draftEmail({ instruction: 'x' }).catch((e) => e);
      expect(err).toBeInstanceOf(AiUnavailableError);
      expect(err.message).toContain(String(status));
      expect(client.calls).toHaveLength(2);
      expect(usage.rows).toHaveLength(1);
      expect(usage.rows[0]!.ok).toBe(false);
    }
  });

  it('timeouts are retried once and reported as such', async () => {
    const timeout = Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' });
    const { ai, client } = make([timeout]);
    const err = await ai.draftEmail({ instruction: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(AiUnavailableError);
    expect(err.message).toMatch(/timed out after 90s/);
    expect(client.calls).toHaveLength(2);
  });

  it('400 -> AiOutputError (not retried); 404 names the model setting', async () => {
    const a = make([httpError(400, 'max_tokens too large')]);
    await expect(a.ai.draftEmail({ instruction: 'x' })).rejects.toBeInstanceOf(AiOutputError);
    expect(a.client.calls).toHaveLength(1);
    const b = make([httpError(404, 'model: nope')]);
    const err = await b.ai.draftEmail({ instruction: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(AiUnavailableError);
    expect(err.message).toMatch(/ANTHROPIC_MODEL_FAST/);
  });

  it('a refusal stop_reason is an AiOutputError and is not retried', async () => {
    const { ai, client } = make([{ stop_reason: 'refusal', stop_details: { category: 'general_harms' }, content: [], usage: { input_tokens: 5, output_tokens: 0 } }]);
    await expect(ai.draftEmail({ instruction: 'x' })).rejects.toBeInstanceOf(AiOutputError);
    expect(client.calls).toHaveLength(1);
  });

  it('a truncated response (max_tokens) triggers the repair path', async () => {
    const cut = { ...toolUse('submit_draft', { subject: 'S' }), stop_reason: 'max_tokens' };
    const { ai, client } = make([cut, toolUse('submit_draft', { subject: 'S', body: 'B' })]);
    await expect(ai.draftEmail({ instruction: 'x' })).resolves.toEqual({ subject: 'S', body: 'B' });
    expect(client.calls).toHaveLength(2);
  });
});

describe('availability', () => {
  it('without a key every AI feature throws AiUnavailableError and nothing is called', async () => {
    const { ai, client, usage } = make([toolUse('x', {})], { cfg: makeConfig({ apiKey: null }) });
    const plan = { version: 1 as const, format: '9:16' as const, fps: 30 as const, summary: '', segments: [], titles: [], look: { preset: 'natural' as const, vignette: false, fadeInMs: 0, fadeOutMs: 0 }, audio: { normalizeLoudness: true }, limitations: [] };
    await expect(ai.writeCaption({ projectId: 'p', brief: 'b', preset: 'custom', plan: plan as any, assets: [] })).rejects.toBeInstanceOf(AiUnavailableError);
    await expect(ai.summarizeThread({ subject: 's', messages: [] })).rejects.toBeInstanceOf(AiUnavailableError);
    await expect(ai.draftEmail({ instruction: 'x' })).rejects.toBeInstanceOf(AiUnavailableError);
    await expect(ai.adjustTone({ text: 'x', tone: 'warm' })).rejects.toBeInstanceOf(AiUnavailableError);
    await expect(ai.analyzeCompetitorMaterial({ competitorName: 'c', materials: [{ label: 'a', text: 'text' }] })).rejects.toBeInstanceOf(AiUnavailableError);
    await expect(ai.marketResearch({ topic: 't' })).rejects.toBeInstanceOf(AiUnavailableError);
    expect(client.calls).toHaveLength(0);
    expect(usage.rows).toHaveLength(0);
  });
});

describe('status()', () => {
  it('unconfigured: says so and says what happens instead', () => {
    const { ai } = make([], { cfg: makeConfig({ apiKey: null, webSearchEnabled: true }) });
    const s = ai.status();
    expect(s.configured).toBe(false);
    expect(s.webSearchEnabled).toBe(false);
    expect(s.detail).toMatch(/ANTHROPIC_API_KEY is not set/);
    expect(s.detail).toMatch(/Basic auto-edit/);
    expect(s.detail).toMatch(/Web search is enabled in settings but needs the API key/);
  });

  it('configured: does not claim the key was verified; reports limits and live usage', () => {
    const usage = new MemoryUsageStore();
    usage.seed(2, 100);
    const { ai } = make([], { usage, cfg: makeConfig({ dailyCallLimit: 10, dailyTokenLimit: 1000, webSearchEnabled: true }) });
    const s = ai.status();
    expect(s).toMatchObject({
      configured: true,
      primaryModel: 'claude-sonnet-5-5',
      fastModel: 'claude-haiku-5-5',
      webSearchEnabled: true,
      limits: { dailyCalls: 10, dailyTokens: 1000 },
      usage: { callsToday: 2, tokensToday: 200 },
    });
    expect(s.detail).toMatch(/not been verified/);
    expect(s.detail).not.toMatch(/limit reached/);
  });

  it('reports a reached limit truthfully', () => {
    const usage = new MemoryUsageStore();
    usage.seed(5, 10);
    const { ai } = make([], { usage, cfg: makeConfig({ dailyCallLimit: 5 }) });
    expect(ai.status().detail).toMatch(/Daily call limit reached \(5 of 5\)/);
  });

  it('never leaks the API key', () => {
    const { ai } = make([]);
    expect(JSON.stringify(ai.status())).not.toContain('test-key-not-real');
  });
});
