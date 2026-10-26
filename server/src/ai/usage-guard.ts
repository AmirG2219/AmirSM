import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config.js';
import { AiLimitError, type UsageRecord, type UsageStore } from './types.js';

/** Daily call/token limits (UTC day, from config) enforced BEFORE each model call, plus usage recording. */
export class UsageGuard {
  constructor(
    private readonly cfg: AppConfig['ai'],
    private readonly store: UsageStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Throws AiLimitError (and records nothing, because no call is made) when a daily limit is already reached. */
  assertWithinLimits(): void {
    const t = this.store.todayTotals();
    if (t.calls >= this.cfg.dailyCallLimit) {
      throw new AiLimitError(
        `Daily AI call limit reached (${t.calls} of ${this.cfg.dailyCallLimit} calls used today). No call was made. The counter resets at 00:00 UTC; raise AI_DAILY_CALL_LIMIT to allow more.`,
      );
    }
    if (t.tokens >= this.cfg.dailyTokenLimit) {
      throw new AiLimitError(
        `Daily AI token limit reached (${t.tokens} of ${this.cfg.dailyTokenLimit} tokens used today). No call was made. The counter resets at 00:00 UTC; raise AI_DAILY_TOKEN_LIMIT to allow more.`,
      );
    }
  }

  record(rec: Omit<UsageRecord, 'id' | 'ts'>): void {
    try {
      this.store.insert({ id: randomUUID(), ts: this.now().toISOString(), ...rec });
    } catch {
      // A failing usage write must never turn a finished AI call into a failure.
    }
  }

  totals() {
    return this.store.todayTotals();
  }
}
