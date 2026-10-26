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

// ---------- Email ----------
export interface EmailAccountDTO { id: string; provider: string; label: string; address: string; isFixture: boolean; canRead: boolean; canSend: boolean; statusDetail: string }
export interface EmailMessageDTO { id: string; direction: 'in' | 'out'; fromName: string | null; fromAddr: string; to: string[]; cc: string[]; date: string; body: string }
export interface EmailThreadSummary { id: string; accountId: string; subject: string; snippet: string; lastMessageAt: string; unread: boolean; needsReply: boolean; hasSummary: boolean }
export interface EmailThreadDetail extends EmailThreadSummary { messages: EmailMessageDTO[]; summary: { summary: string; actionItems: string[]; needsReply: boolean; at: string } | null }
export interface EmailDraftDTO { id: string; accountId: string; threadId: string | null; to: string[]; cc: string[]; subject: string; body: string; aiAssisted: boolean; status: 'draft' | 'approved' | 'sent' | 'failed'; approvedAt: string | null; sentAt: string | null; sendResult: { delivered: boolean; note: string } | null; createdAt: string; updatedAt: string }

// ---------- Settings ----------
export interface IntegrationStatus {
  id: 'anthropic' | 'ffmpeg' | 'email';
  label: string;
  state: 'connected' | 'not_configured' | 'fixture' | 'error';
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
