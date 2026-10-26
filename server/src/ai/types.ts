/** Contract between the orchestrator/routes (lead) and the AI layer (AI agent). */
import type { EditPlan, StylePreset } from '../../../shared/editPlan.js';
import type { Caption, MediaInfo, QualityReport, Role } from '../../../shared/domain.js';
import type { ClipAnalysis, SampledFrame } from '../../../shared/analysis.js';

export interface AiStatus {
  configured: boolean; // ANTHROPIC_API_KEY present
  primaryModel: string;
  fastModel: string;
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

import type { DirectorInput, DirectorResult } from './director.js';
import type { ReferenceVisual } from '../../../shared/analysis.js';

export interface PlanEditInput {
  projectId: string;
  brief: string; // owner's natural-language instructions (for revisions: the original brief)
  preset: StylePreset;
  assets: AssetBrief[]; // only these assetIds may appear in the plan
  previousPlan?: EditPlan; // set for revisions
  revisionRequest?: string; // set for revisions
  /** subtitle lines the owner supplied explicitly (never AI-generated) */
  userSubtitleLines?: string[];
  /**
   * What is known about the clips (one entry per asset and source). 'visual' = Claude looked at sampled stills;
   * 'technical' = local signal measurements only. Optional; absent = nothing is known.
   */
  clipAnalyses?: ClipAnalysis[];
  /** style notes from reference (inspiration) videos the owner showed; see referenceStyleText() */
  referenceStyle?: string;
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
  /** same as PlanEditInput.clipAnalyses; only 'visual' entries count as things that were seen */
  clipAnalyses?: ClipAnalysis[];
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

export interface ClipToAnalyze {
  assetId: string;
  name: string;
  durationMs: number;
  /** only needed when the model should be given pictures: used by analyzeClips to size the frame budget */
  info?: Pick<MediaInfo, 'displayWidth' | 'displayHeight'>;
}

/** Persistence of finished analyses (implemented over SQLite in analysis-store.ts; injected so tests need no DB). */
export interface ClipAnalysisCache {
  get(assetId: string, kind: 'visual' | 'technical', analyzerVersion: string): ClipAnalysis | null;
  put(a: ClipAnalysis): void;
}

export interface AnalyzeClipsInput {
  projectId: string;
  clips: ClipToAnalyze[];
  /** called only for clips that are NOT already cached; must return evenly spaced stills (see video.sampleFrames) */
  getFrames: (clip: ClipToAnalyze) => Promise<SampledFrame[]>;
  cache?: ClipAnalysisCache;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, message: string) => void;
}
export interface AnalyzeClipsResult {
  /** visual analyses for the requested clips (fresh + cached) */
  analyses: ClipAnalysis[];
  fromCache: number;
  /** clips that were not analysed, each with a human-readable reason */
  skipped: { assetId: string; reason: string }[];
  /** model calls actually made */
  calls: number;
  /** stills sent to the model in this run (cache hits send none) */
  framesSent: number;
  /** estimated input tokens of the calls made (images + text) */
  estimatedInputTokens: number;
  notes: string[];
}

export interface UsageRecord {
  id: string;
  ts: string;
  role: Role | 'email' | 'vision' | 'other';
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

  /**
   * Visual clip analysis: Claude looks at a few sampled stills per clip and describes only what is visible.
   * Never throws for limits/unavailability/bad output: those clips come back in `skipped` with a reason.
   */
  analyzeClips(input: AnalyzeClipsInput): Promise<AnalyzeClipsResult>;

  // --- Studio agent ---
  directorTurn(input: DirectorInput): Promise<DirectorResult>;
  analyzeReference(input: { projectId: string; assetId: string; name: string; durationMs: number; frames: SampledFrame[] }): Promise<{ visual: ReferenceVisual; model: string }>;

  // --- Email assistant ---
  summarizeThread(thread: { subject: string; messages: { from: string; date: string; body: string }[] }): Promise<{ summary: string; actionItems: string[]; needsReply: boolean }>;
  draftEmail(input: { instruction: string; replyTo?: { subject: string; from: string; body: string }; tone?: string; senderName?: string }): Promise<{ subject: string; body: string }>;
  adjustTone(input: { text: string; tone: string }): Promise<{ text: string }>;

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
