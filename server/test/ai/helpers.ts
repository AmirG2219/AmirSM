/** Test helpers for the AI layer. Nothing here touches the network. */
import { loadConfig, type AppConfig } from '../../src/config.js';
import type { AssetBrief, UsageRecord, UsageStore } from '../../src/ai/types.js';
import type { EditPlanInput } from '../../../shared/editPlan.js';
import { EditPlanSchema } from '../../../shared/editPlan.js';

/** In-memory UsageStore (counts records stamped with today's UTC date). */
export class MemoryUsageStore implements UsageStore {
  rows: UsageRecord[] = [];
  insert(rec: UsageRecord): void {
    this.rows.push(rec);
  }
  todayTotals() {
    const today = new Date().toISOString().slice(0, 10);
    const todays = this.rows.filter((r) => r.ts.slice(0, 10) === today);
    return { calls: todays.length, tokens: todays.reduce((n, r) => n + r.inputTokens + r.outputTokens, 0) };
  }
  recent(limit: number): UsageRecord[] {
    return [...this.rows].reverse().slice(0, limit);
  }
  /** pre-fill with n successful calls of `tokensEach` tokens */
  seed(n: number, tokensEach = 10): void {
    for (let i = 0; i < n; i++) {
      this.rows.push({ id: `seed${i}`, ts: new Date().toISOString(), role: 'other', model: 'seed', inputTokens: tokensEach, outputTokens: 0, ok: true });
    }
  }
}

export function makeConfig(over: Partial<AppConfig['ai']> = {}): AppConfig {
  // start from the real defaults so unrelated config sections (email, paths…) can evolve without breaking these tests
  const base = loadConfig({ DATA_DIR: '.' } as NodeJS.ProcessEnv, { readDotEnv: false });
  return {
    ...base,
    ai: { apiKey: 'test-key-not-real', primaryModel: 'claude-sonnet-5-5', fastModel: 'claude-haiku-5-5', dailyCallLimit: 60, dailyTokenLimit: 400_000, ...over },
  };
}

export type Scripted = Record<string, unknown> | Error | ((params: any) => Record<string, unknown> | Error);

/** Fake `@anthropic-ai/sdk` client: replays scripted responses and records every request. */
export class FakeClient {
  calls: { params: any; options: any }[] = [];
  private i = 0;
  constructor(private script: Scripted[]) {}
  messages = {
    create: async (params: any, options?: any) => {
      this.calls.push({ params, options });
      const item = this.script[Math.min(this.i++, this.script.length - 1)];
      if (item === undefined) throw new Error('FakeClient: empty script');
      const out = typeof item === 'function' ? item(params) : item;
      if (out instanceof Error) throw out;
      return out;
    },
  };
  /** first user message text of call n */
  userText(n = 0): string {
    const c = this.calls[n]?.params.messages[0].content;
    return typeof c === 'string' ? c : JSON.stringify(c);
  }
}

export function toolUse(name: string, input: unknown, usage = { input_tokens: 1000, output_tokens: 500 }): Record<string, unknown> {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_1', name, input }],
    usage,
  };
}

export function httpError(status: number, message = 'boom'): Error {
  return Object.assign(new Error(message), { status, name: 'APIError' });
}

export const noSleep = async () => {};

export function assets(): AssetBrief[] {
  return [
    { id: 'a1', name: 'morning.mp4', durationMs: 12_000, width: 1080, height: 1920, hasAudio: true, kind: 'video' },
    { id: 'a2', name: 'coffee.mp4', durationMs: 8_000, width: 1920, height: 1080, hasAudio: false, kind: 'video' },
    { id: 'm1', name: 'my-track.mp3', durationMs: 90_000, width: 0, height: 0, hasAudio: true, kind: 'audio' },
  ];
}

export function makeAssets(n: number, durationMs = 10_000): AssetBrief[] {
  return Array.from({ length: n }, (_v, i) => ({
    id: `c${i + 1}`,
    name: `clip${i + 1}.mp4`,
    durationMs,
    width: i % 2 ? 1920 : 1080,
    height: i % 2 ? 1080 : 1920,
    hasAudio: i % 3 !== 0,
    kind: 'video' as const,
  }));
}

/** A minimal valid plan input over a1 + a2 (before defaults are applied). */
export function rawPlan(over: Partial<EditPlanInput> = {}): EditPlanInput {
  return {
    version: 1,
    summary: 'Warm morning edit',
    segments: [
      { id: 's1', assetId: 'a1', startMs: 1000, endMs: 5000 },
      { id: 's2', assetId: 'a2', startMs: 0, endMs: 4000, transitionIn: { type: 'crossfade', durationMs: 500 } },
    ],
    ...over,
  };
}

export function validPlan(over: Partial<EditPlanInput> = {}) {
  return EditPlanSchema.parse(rawPlan(over));
}

export function planResponse(plan: EditPlanInput = rawPlan(), rationale = 'Warm and calm pacing.') {
  return toolUse('submit_edit_plan', { rationale, plan });
}
