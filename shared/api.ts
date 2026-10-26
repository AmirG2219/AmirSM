/**
 * HTTP API DTOs (JSON). All routes live under /api and require the session cookie unless noted.
 * Errors: non-2xx with { error: { code: string, message: string, details?: unknown } }.
 * Timestamps are ISO-8601 strings (UTC). Ids are opaque strings.
 */
import type { Caption, MediaInfo, ProjectStatus, QualityReport, VersionStatus } from './domain.js';
import type { EditPlan, OutputFormat, StylePreset } from './editPlan.js';

export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}

// ---------- Auth ----------  (GET /api/auth/state is public)
export interface AuthState {
  setupRequired: boolean;
  authenticated: boolean;
}
// POST /api/auth/setup {password}  (only while setupRequired)   POST /api/auth/login {password}   POST /api/auth/logout

// ---------- Projects ----------
export interface JobDTO {
  id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  stage: 'planning' | 'validating' | 'rendering' | 'captioning' | 'reviewing' | null;
  progress: number; // 0..1 overall
  message: string | null;
  attempt: number;
  maxAttempts: number;
  error: string | null;
}

export interface AssetDTO {
  id: string;
  projectId: string;
  kind: 'video' | 'audio';
  originalName: string;
  mime: string;
  sizeBytes: number;
  info: MediaInfo;
  excluded: boolean;
  sortOrder: number;
  fileUrl: string; // GET (supports Range)
  thumbUrl: string | null;
  createdAt: string;
}

export interface VersionDTO {
  id: string;
  projectId: string;
  number: number;
  parentVersionId: string | null;
  instruction: string;
  isRevision: boolean;
  status: VersionStatus;
  plan: EditPlan | null;
  planSource: 'ai' | 'rules' | null;
  planRationale: string | null;
  planNotes: string[];
  caption: Caption | null;
  captionText: string | null;
  captionStatus: 'none' | 'ai' | 'manual' | 'unavailable' | 'failed';
  captionNote: string | null;
  quality: QualityReport | null;
  output: { url: string; downloadUrl: string; sizeBytes: number; durationMs: number; width: number; height: number } | null;
  warnings: string[];
  error: string | null;
  approved: boolean;
  /** present once approved: the immutable exported copy on disk (relative to the data dir) */
  exportPath: string | null;
  createdAt: string;
  finishedAt: string | null;
  approvedAt: string | null;
  job: JobDTO | null;
}

export interface ProjectDTO {
  id: string;
  title: string;
  brief: string;
  stylePreset: StylePreset;
  format: OutputFormat;
  subtitleLines: string[];
  status: ProjectStatus;
  approvedVersionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectSummary extends ProjectDTO {
  assetCount: number;
  versionCount: number;
  latestVersion: { id: string; number: number; status: VersionStatus; progress: number | null } | null;
  thumbUrl: string | null;
}

export interface ProjectDetail {
  project: ProjectDTO;
  assets: AssetDTO[];
  versions: VersionDTO[]; // newest first
}

export interface UploadResult {
  results: { name: string; ok: boolean; asset?: AssetDTO; error?: string }[];
}

// ---------- Dashboard ----------
export interface SystemStatusItem {
  id: string;
  label: string;
  state: 'ok' | 'degraded' | 'not_configured' | 'error' | 'fixture';
  detail: string;
}
export interface DashboardDTO {
  generatedAt: string;
  inProgress: ProjectSummary[];
  needsReview: ProjectSummary[];
  recentlyCompleted: ProjectSummary[];
  pendingEmail: { drafts: { id: string; subject: string; status: string; updatedAt: string }[]; needsReplyThreads: { id: string; subject: string; lastMessageAt: string }[]; provider: string; isFixture: boolean };
  recentResearch: { id: string; kind: string; title: string; createdAt: string }[];
  recentFailures: { versionId: string; projectId: string; projectTitle: string; number: number; error: string | null; at: string | null }[];
  system: SystemStatusItem[];
  queue: { queued: number; running: number };
  activity: { id: number; ts: string; kind: string; message: string; projectId: string | null }[];
}

// ---------- Library ----------
export interface LibraryItem {
  kind: 'clip' | 'draft' | 'export';
  id: string; // asset id or version id
  projectId: string;
  projectTitle: string;
  title: string; // filename or "v3 draft"
  status: string;
  thumbUrl: string | null;
  mediaUrl: string | null;
  downloadUrl: string | null;
  captionText: string | null;
  instruction: string | null;
  sizeBytes: number | null;
  durationMs: number | null;
  createdAt: string;
}

// ---------- Research ----------
export interface CompetitorDTO { id: string; name: string; handle: string | null; url: string | null; notes: string; createdAt: string }
export interface ResearchNoteDTO { id: string; kind: 'observation' | 'idea' | 'inspiration'; title: string; body: string; sourceUrl: string | null; sourceLabel: string | null; competitorId: string | null; tags: string[]; createdAt: string }
export interface ResearchRunDTO { id: string; kind: 'competitor_analysis' | 'market_research'; topic: string; competitorId: string | null; source: string; status: 'succeeded' | 'failed'; error: string | null; result: unknown; createdAt: string }
export interface ResearchCapabilities {
  competitorAnalysis: { available: boolean; reason?: string };
  marketResearch: { available: boolean; reason?: string };
}

// ---------- Email ----------
export interface EmailAccountDTO { id: string; provider: string; label: string; address: string; isFixture: boolean; canRead: boolean; canSend: boolean; statusDetail: string }
export interface EmailMessageDTO { id: string; direction: 'in' | 'out'; fromName: string | null; fromAddr: string; to: string[]; cc: string[]; date: string; body: string }
export interface EmailThreadSummary { id: string; accountId: string; subject: string; snippet: string; lastMessageAt: string; unread: boolean; needsReply: boolean; hasSummary: boolean }
export interface EmailThreadDetail extends EmailThreadSummary { messages: EmailMessageDTO[]; summary: { summary: string; actionItems: string[]; needsReply: boolean; at: string } | null }
export interface EmailDraftDTO { id: string; accountId: string; threadId: string | null; to: string[]; cc: string[]; subject: string; body: string; aiAssisted: boolean; status: 'draft' | 'approved' | 'sent' | 'failed'; approvedAt: string | null; sentAt: string | null; sendResult: { delivered: boolean; note: string } | null; createdAt: string; updatedAt: string }

// ---------- Settings / integrations ----------
export interface IntegrationStatus {
  id: 'anthropic' | 'ffmpeg' | 'email' | 'resend' | 'n8n' | 'web_search';
  label: string;
  state: 'connected' | 'not_configured' | 'awaiting_credentials' | 'fixture' | 'error';
  detail: string;
  /** what the owner needs to do, if anything */
  action?: string;
}
export interface SettingsStatus {
  integrations: IntegrationStatus[];
  ai: { configured: boolean; primaryModel: string; fastModel: string; limits: { dailyCalls: number; dailyTokens: number }; usage: { callsToday: number; tokensToday: number }; recent: { ts: string; role: string; model: string; inputTokens: number; outputTokens: number; ok: boolean; error?: string }[] };
  storage: { dataDir: string; uploadsBytes: number; rendersBytes: number; exportsBytes: number };
  app: { version: string; node: string; uptimeSeconds: number };
}
