/**
 * AI layer entry point.
 *   const ai = createAiService({ config, usage, client? })
 * Nothing here talks to the network unless a key is configured (or a client is injected AND a key is present).
 */
import { AiRuntime, type AiServiceDeps } from './client.js';
import { writeCaption } from './caption.js';
import { adjustTone, draftEmail, summarizeThread } from './email.js';
import { planEdit } from './planner.js';
import { analyzeCompetitorMaterial, marketResearch } from './research.js';
import { reviewQuality } from './review.js';
import type { AiService, AiStatus } from './types.js';

export * from './types.js';
export type { AiServiceDeps } from './client.js';
export { planWithRules } from './rules-planner.js';
export { sanitizePlan } from './sanitize.js';

export function createAiService(deps: AiServiceDeps): AiService {
  const rt = new AiRuntime(deps);

  const status = (): AiStatus => {
    const cfg = deps.config.ai;
    const configured = Boolean(cfg.apiKey);
    const t = deps.usage.todayTotals();
    const details: string[] = [];
    if (!configured) {
      details.push('ANTHROPIC_API_KEY is not set, so AI planning, captions, email help and research are unavailable. Video plans use the Basic auto-edit (no AI).');
      if (cfg.webSearchEnabled) details.push('Web search is enabled in settings but needs the API key.');
    } else {
      if (rt.state.authRejected) details.push('The last AI call was rejected (API key rejected). Check ANTHROPIC_API_KEY.');
      else if (rt.state.verified) details.push('API key present; the last AI call succeeded.');
      else details.push('API key present; it has not been verified yet (the first AI call will confirm it).');
      if (t.calls >= cfg.dailyCallLimit) details.push(`Daily call limit reached (${t.calls} of ${cfg.dailyCallLimit}); AI calls are paused until 00:00 UTC.`);
      if (t.tokens >= cfg.dailyTokenLimit) details.push(`Daily token limit reached (${t.tokens} of ${cfg.dailyTokenLimit}); AI calls are paused until 00:00 UTC.`);
      if (!cfg.webSearchEnabled) details.push('Web research is off (AI_WEB_SEARCH_ENABLED is not true).');
    }
    return {
      configured,
      primaryModel: cfg.primaryModel,
      fastModel: cfg.fastModel,
      webSearchEnabled: cfg.webSearchEnabled && configured,
      limits: { dailyCalls: cfg.dailyCallLimit, dailyTokens: cfg.dailyTokenLimit },
      usage: { callsToday: t.calls, tokensToday: t.tokens },
      detail: details.join(' '),
    };
  };

  return {
    status,
    recentUsage: (limit = 50) => deps.usage.recent(limit),
    planEdit: (input, opts) => planEdit(rt, input, opts),
    writeCaption: (input) => writeCaption(rt, input),
    reviewQuality: (input) => reviewQuality(rt, input),
    summarizeThread: (thread) => summarizeThread(rt, thread),
    draftEmail: (input) => draftEmail(rt, input),
    adjustTone: (input) => adjustTone(rt, input),
    analyzeCompetitorMaterial: (input) => analyzeCompetitorMaterial(rt, input),
    marketResearch: (input) => marketResearch(rt, input),
  };
}
