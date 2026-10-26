/**
 * Thin wrapper around the Anthropic SDK.
 *  - structured output via a single client tool whose input_schema is the target schema; the model is
 *    told to call it (tool_choice "auto": forced tool_choice returns HTTP 400 on claude-sonnet-5-5 /
 *    claude-opus-5-5 / fable, so we rely on the instruction + validation + ONE repair retry)
 *  - zod validation, one repair retry that feeds the validation error back
 *  - usage accounting from response.usage, daily limits enforced before every call
 *  - clean error mapping (never includes prompts, email bodies or keys)
 */
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { AiOutputError, AiUnavailableError, type AiDeps, type UsageRecord } from './types.js';
import { UsageGuard } from './usage-guard.js';

/** Minimal shape we need from the SDK (also satisfied by test doubles). */
export interface AnthropicLike {
  messages: { create(params: any, options?: any): Promise<any> };
}

/** Extra, optional dependencies (tests inject sleep/now; production uses the defaults). */
export interface AiServiceDeps extends AiDeps {
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** delay before the single retry on 429/5xx/timeout (default 2000ms) */
  retryBackoffMs?: number;
  /** per-request timeout (default 90s) */
  timeoutMs?: number;
}

export type UsageRole = UsageRecord['role'];

export interface StructuredCall<T> {
  role: UsageRole;
  model: string;
  system: string;
  user: string;
  /** full user content blocks (text + image blocks); when set it replaces `user` */
  userContent?: unknown[];
  toolName: string;
  toolDescription: string;
  zodSchema: z.ZodType<T>;
  jsonSchema: Record<string, unknown>;
  maxTokens: number;
  projectId?: string;
  /** additional tools (e.g. the web_search server tool) */
  extraTools?: unknown[];
  /** lenient normalisation of the raw tool input before zod validation */
  prepare?: (raw: unknown) => unknown;
  /** default 1 */
  maxRepairs?: number;
}

export interface StructuredResult<T> {
  data: T;
  model: string;
  /** all content blocks of every response involved (used to read web search results) */
  content: any[];
  /** number of repair retries that were needed */
  repairs: number;
}

export const DEFAULT_TIMEOUT_MS = 90_000;

interface Classified {
  error: Error;
  retryable: boolean;
  authFailure: boolean;
}

function scrub(text: string): string {
  return text.replace(/sk-ant-[A-Za-z0-9_-]+/g, '[redacted-key]').replace(/\s+/g, ' ').trim().slice(0, 200);
}

export function classifyError(err: unknown, model: string, timeoutMs: number): Classified {
  if (err instanceof AiOutputError || err instanceof AiUnavailableError) {
    return { error: err, retryable: false, authFailure: false };
  }
  const e = err as { status?: number; name?: string; message?: string; code?: string };
  const status = typeof e?.status === 'number' ? e.status : undefined;
  const name = String(e?.name ?? '');
  const message = String(e?.message ?? '');
  if (status === 401 || status === 403) {
    return {
      error: new AiUnavailableError(`API key rejected (HTTP ${status}). Check ANTHROPIC_API_KEY and that the key has access to the Messages API.`),
      retryable: false,
      authFailure: true,
    };
  }
  if (status === 404) {
    return {
      error: new AiUnavailableError(`Model "${model}" was not found or this key has no access to it. Check ANTHROPIC_MODEL_PRIMARY / ANTHROPIC_MODEL_FAST.`),
      retryable: false,
      authFailure: false,
    };
  }
  if (status === 429) {
    return { error: new AiUnavailableError('Anthropic rate limit reached (HTTP 429). Try again in a minute.'), retryable: true, authFailure: false };
  }
  if (status !== undefined && status >= 500) {
    return { error: new AiUnavailableError(`Anthropic service error (HTTP ${status}). Try again later.`), retryable: true, authFailure: false };
  }
  if (status !== undefined && status >= 400) {
    return { error: new AiOutputError(`Anthropic rejected the request (HTTP ${status}): ${scrub(message)}`), retryable: false, authFailure: false };
  }
  if (/timeout|timed out|ETIMEDOUT|AbortError/i.test(name + ' ' + message + ' ' + (e?.code ?? ''))) {
    return { error: new AiUnavailableError(`Anthropic request timed out after ${Math.round(timeoutMs / 1000)}s.`), retryable: true, authFailure: false };
  }
  if (/connection|network|ECONN|ENOTFOUND|EAI_AGAIN|fetch failed/i.test(name + ' ' + message + ' ' + (e?.code ?? ''))) {
    return { error: new AiUnavailableError('Could not reach Anthropic (network error).'), retryable: true, authFailure: false };
  }
  return { error: new AiUnavailableError(`AI call failed: ${scrub(message) || 'unknown error'}`), retryable: false, authFailure: false };
}

function usageOf(resp: any): { input: number; output: number } {
  const u = resp?.usage ?? {};
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    input: n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens),
    output: n(u.output_tokens),
  };
}

function formatZodIssues(error: z.ZodError): string {
  const parts = error.issues.slice(0, 8).map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`);
  return parts.join('; ').slice(0, 900);
}

export interface RuntimeState {
  /** last call in this process was rejected with 401/403 */
  authRejected: boolean;
  /** at least one call has succeeded in this process since the last rejection */
  verified: boolean;
}

export class AiRuntime {
  readonly guard: UsageGuard;
  readonly state: RuntimeState = { authRejected: false, verified: false };
  private client: AnthropicLike | null = null;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly backoffMs: number;
  readonly timeoutMs: number;

  constructor(private readonly deps: AiServiceDeps) {
    this.guard = new UsageGuard(deps.config.ai, deps.usage, deps.now);
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.backoffMs = deps.retryBackoffMs ?? 2000;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get cfg(): AppConfig['ai'] {
    return this.deps.config.ai;
  }

  /** Configured = an API key is present (the key itself is never validated until a call is made). */
  get available(): boolean {
    return Boolean(this.cfg.apiKey);
  }

  requireAvailable(what: string): void {
    if (!this.available) {
      throw new AiUnavailableError(`${what} needs the Anthropic API. Set ANTHROPIC_API_KEY in the server environment (.env) and restart.`);
    }
  }

  private getClient(): AnthropicLike {
    if (this.client) return this.client;
    if (this.deps.client) {
      this.client = this.deps.client as AnthropicLike;
    } else {
      this.client = new Anthropic({ apiKey: this.cfg.apiKey ?? undefined, timeout: this.timeoutMs, maxRetries: 0 }) as unknown as AnthropicLike;
    }
    return this.client;
  }

  /** One guarded HTTP call (limits checked first; ONE retry on 429/5xx/timeout). Does not record usage itself. */
  private async send(model: string, params: Record<string, unknown>): Promise<any> {
    this.guard.assertWithinLimits();
    const client = this.getClient();
    const { __role, ...apiParams } = params;
    let attempt = 0;
    for (;;) {
      try {
        const resp = await client.messages.create({ model, ...apiParams }, { timeout: this.timeoutMs });
        this.state.authRejected = false;
        return resp;
      } catch (err) {
        const c = classifyError(err, model, this.timeoutMs);
        if (c.authFailure) {
          this.state.authRejected = true;
          this.state.verified = false;
        }
        if (c.retryable && attempt === 0) {
          attempt++;
          await this.sleep(this.backoffMs);
          continue;
        }
        // record the failed call (no tokens known)
        this.guard.record({ role: (__role as UsageRole) ?? 'other', model, inputTokens: 0, outputTokens: 0, ok: false, error: scrub(c.error.message) });
        throw c.error;
      }
    }
  }

  async callStructured<T>(o: StructuredCall<T>): Promise<StructuredResult<T>> {
    this.requireAvailable('This feature');
    const maxRepairs = o.maxRepairs ?? 1;
    const messages: any[] = [{ role: 'user', content: o.userContent ?? o.user }];
    const tool = { name: o.toolName, description: o.toolDescription, input_schema: o.jsonSchema };
    const system = `${o.system}\n\nOUTPUT FORMAT: respond by calling the tool "${o.toolName}" exactly once with your complete answer. Do not answer in plain text.`;
    const allContent: any[] = [];
    let repairs = 0;
    let pauses = 0;
    let lastError = '';

    for (;;) {
      const resp = await this.send(o.model, {
        __role: o.role,
        max_tokens: o.maxTokens,
        system,
        messages,
        tools: [...(o.extraTools ?? []), tool],
        tool_choice: { type: 'auto' },
      });
      const content: any[] = Array.isArray(resp?.content) ? resp.content : [];
      allContent.push(...content);
      const u = usageOf(resp);
      const base = { role: o.role, model: o.model, inputTokens: u.input, outputTokens: u.output, ...(o.projectId ? { projectId: o.projectId } : {}) };

      if (resp?.stop_reason === 'pause_turn' && pauses < 3) {
        pauses++;
        this.guard.record({ ...base, ok: true });
        messages.push({ role: 'assistant', content });
        continue;
      }
      if (resp?.stop_reason === 'refusal') {
        const msg = `The model declined this request${resp?.stop_details?.category ? ` (${resp.stop_details.category})` : ''}.`;
        this.guard.record({ ...base, ok: false, error: msg });
        throw new AiOutputError(msg);
      }

      const verdict = this.extract(resp, content, o);
      if (verdict.ok) {
        this.guard.record({ ...base, ok: true });
        return { data: verdict.data, model: o.model, content: allContent, repairs };
      }
      lastError = verdict.error;
      this.guard.record({ ...base, ok: false, error: `invalid output: ${scrub(verdict.error)}` });
      if (repairs >= maxRepairs) {
        throw new AiOutputError(`The AI response did not match the required format${repairs ? ' even after a retry' : ''}: ${scrub(lastError)}`);
      }
      repairs++;
      const toolUse = content.find((b) => b?.type === 'tool_use' && b?.name === o.toolName);
      const fix = `Your previous answer was rejected: ${verdict.error}\nCall the tool "${o.toolName}" again with a corrected, complete answer that satisfies the schema.`;
      messages.push({ role: 'assistant', content });
      messages.push({
        role: 'user',
        content: toolUse ? [{ type: 'tool_result', tool_use_id: toolUse.id, is_error: true, content: fix }] : fix,
      });
    }
  }

  private extract<T>(resp: any, content: any[], o: StructuredCall<T>): { ok: true; data: T } | { ok: false; error: string } {
    const block = content.find((b) => b?.type === 'tool_use' && b?.name === o.toolName);
    if (!block) {
      return {
        ok: false,
        error: resp?.stop_reason === 'max_tokens' ? 'the response was cut off (max_tokens) before the tool was called' : `you did not call the tool "${o.toolName}"`,
      };
    }
    let raw: unknown = block.input;
    if (typeof raw === 'string') {
      try {
        raw = JSON.parse(raw);
      } catch {
        return { ok: false, error: 'the tool input was not valid JSON' };
      }
    }
    if (resp?.stop_reason === 'max_tokens') return { ok: false, error: 'the response was cut off (max_tokens); keep the answer shorter' };
    try {
      if (o.prepare) raw = o.prepare(raw);
    } catch {
      return { ok: false, error: 'the tool input could not be normalised' };
    }
    const parsed = o.zodSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: formatZodIssues(parsed.error) };
    return { ok: true, data: parsed.data };
  }
}

/** Convert a zod schema to a JSON Schema usable as an Anthropic tool input_schema. */
export function toToolSchema(schema: z.ZodType): Record<string, unknown> {
  const js = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (k === '$schema' || k === 'pattern') continue; // regexes are validated locally by zod
        out[k] = strip(val);
      }
      return out;
    }
    return v;
  };
  const cleaned = strip(js) as Record<string, unknown>;
  if (cleaned.type !== 'object') throw new Error('tool schema must be an object schema');
  return cleaned;
}
