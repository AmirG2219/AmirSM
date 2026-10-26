/** Contract between the orchestrator/routes (lead) and the AI layer (AI agent). */
import type { EditPlan, StylePreset } from '../../../shared/editPlan.js';
import type { Caption, QualityReport, Role } from '../../../shared/domain.js';

export interface AiStatus {
  configured: boolean; // ANTHROPIC_API_KEY present
  primaryModel: string;
  fastModel: string;
  webSearchEnabled: boolean;
  limits: { dailyCalls: number; dailyTokens: number };
  usage: { callsToday: number; tokensToday: number };
  /** why unavailable, if so — shown verbatim in Settings */
  detail?: string;
}

export class AiUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiUnavailableError';
  }
}
export class AiLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiLimitError';
  }
}
export class AiOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiOutputError';
  }
}

export interface AssetBrief {
  id: string;
  name: string;
  durationMs: number;
  width: number;
  height: number;
  hasAudio: boolean;
  kind: 'video' | 'audio';
}

export interface PlanEditInput {
  projectId: string;
  brief: string; // owner's natural-language instructions (for revisions: the original brief)
  preset: StylePreset;
  assets: AssetBrief[]; // only these assetIds may appear in the plan
  previousPlan?: EditPlan; // set for revisions
  revisionRequest?: string; // set for revisions
  /** subtitle lines the owner supplied explicitly (never AI-generated) */
  userSubtitleLines?: string[];
}
export interface PlanEditResult {
  plan: EditPlan; // already schema-validated and clamped to asset durations
  rationale: string; // Creative Director's reasoning, owner-facing, <= ~600 chars
  source: 'ai' | 'rules'; // 'rules' = deterministic fallback planner (no LLM)
  model?: string;
  notes: string[]; // e.g. limitations, repairs applied
}

export interface CaptionInput {
  projectId: string;
  brief: string;
  preset: StylePreset;
  plan: EditPlan;
  assets: AssetBrief[];
  previousCaption?: Caption;
  feedback?: string; // revision feedback
}
export interface CaptionResult {
  caption: Caption;
  model: string;
}

export interface ReviewInput {
  brief: string;
  plan: EditPlan;
  caption?: Caption;
  deterministic: QualityReport; // from VideoEngine.verifyOutput
}

export interface UsageRecord {
  id: string;
  ts: string;
  role: Role | 'email' | 'research' | 'other';
  model: string;
  inputTokens: number;
  outputTokens: number;
  ok: boolean;
  error?: string;
  projectId?: string;
}

export interface AiService {
  status(): AiStatus;
  recentUsage(limit?: number): UsageRecord[];

  /** Creative Director + Video Editor: brief -> validated EditPlan. Falls back to the rules planner ONLY if `allowRulesFallback`. */
  planEdit(input: PlanEditInput, opts?: { allowRulesFallback?: boolean }): Promise<PlanEditResult>;
  /** Copywriter. Throws AiUnavailableError when no key. */
  writeCaption(input: CaptionInput): Promise<CaptionResult>;
  /** Quality Reviewer: deterministic report is authoritative; the AI pass may only add warn/fail checks about caption<->plan consistency. */
  reviewQuality(input: ReviewInput): Promise<QualityReport>;

  // --- Email assistant ---
  summarizeThread(thread: { subject: string; messages: { from: string; date: string; body: string }[] }): Promise<{ summary: string; actionItems: string[]; needsReply: boolean }>;
  draftEmail(input: { instruction: string; replyTo?: { subject: string; from: string; body: string }; tone?: string; senderName?: string }): Promise<{ subject: string; body: string }>;
  adjustTone(input: { text: string; tone: string }): Promise<{ text: string }>;

  // --- Research (only operates on provided material, or opt-in web search) ---
  analyzeCompetitorMaterial(input: { competitorName: string; materials: { label: string; text: string; url?: string }[]; focus?: string }): Promise<{ summary: string; patterns: string[]; hooks: string[]; ideas: string[] }>;
  /** Market Researcher. Requires AI_WEB_SEARCH_ENABLED=true and a key; otherwise throws AiUnavailableError. Citations are returned from the tool. */
  marketResearch(input: { topic: string; niche?: string }): Promise<{ summary: string; findings: { title: string; detail: string; sourceUrl?: string }[]; sources: { title: string; url: string }[] }>;
}

/** Persistence for usage accounting — implemented by the lead over SQLite; injected into createAiService. */
export interface UsageStore {
  insert(rec: UsageRecord): void;
  /** totals for the current UTC day */
  todayTotals(): { calls: number; tokens: number };
  recent(limit: number): UsageRecord[];
}

/**
 * Factory the AI agent must export from server/src/ai/index.ts:
 *   export function createAiService(deps: AiDeps): AiService
 * `client` is injectable so tests can pass a fake Anthropic client (never hit the network in tests).
 */
export interface AiDeps {
  config: import('../config.js').AppConfig;
  usage: UsageStore;
  client?: unknown; // an @anthropic-ai/sdk Anthropic instance or a test double with the same `messages.create` shape
}
