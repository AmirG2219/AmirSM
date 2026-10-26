/**
 * HTTP API DTOs (JSON). All routes live under /api and require the session cookie unless noted.
 * Errors: non-2xx with { error: { code: string, message: string, details?: unknown } }.
 * Timestamps are ISO-8601 strings (UTC). Ids are opaque strings.
 */
import type { Caption, MediaInfo, ProjectStatus, QualityReport, VersionStatus } from './domain.js';
import type { EditPlan, OutputFormat, StylePreset } from './editPlan.js';
import type { VersionAnalysis } from './analysis.js';

export type { VersionAnalysis, ClipAnalysis, Moment, TechnicalProfile } from './analysis.js';

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
  stage: 'analyzing' | 'planning' | 'validating' | 'rendering' | 'captioning' | 'reviewing' | null;
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
  /**
   * What the app knows about this clip, if anything (optional: filled where the server loads it).
   * technical = local signal measurements (no AI); visual = Claude looked at a few sampled stills.
   */
  analysis?: AssetAnalysisDTO;
}

export interface AssetAnalysisDTO {
  technical: { score: number; issues: string[] } | null;
  visual: { summary: string | null; tags: string[] } | null;
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
  /**
   * What the editor actually knew about the footage when this version was produced; null for versions made before
   * analysis existed. "What the editor saw": show visual:true only as "looked at sampled stills", never as "watched".
   */
  analysis: VersionAnalysis | null;
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
// A real inbox client over IMAP + SMTP (app passwords), plus a clearly-fictional sample mailbox that is shown only
// while no real account is connected. Mail content is plain text only: HTML mail is converted to text on the server,
// remote content is never loaded. Credentials never appear in any DTO.
export type EmailSyncState = 'never' | 'syncing' | 'ok' | 'error';
export type EmailSecurity = 'tls' | 'starttls' | 'none';
export interface EmailEndpoint { host: string; port: number; security: EmailSecurity }
export interface EmailAccountDTO {
  id: string;
  /** 'fixture' (sample mailbox) or 'imap' (real IMAP+SMTP mailbox) */
  provider: string;
  presetId: string | null;
  label: string;
  address: string;
  isFixture: boolean;
  canRead: boolean;
  canSend: boolean;
  statusDetail: string;
  imapHost: string | null;
  syncState: EmailSyncState;
  lastSyncAt: string | null;
  lastError: string | null;
}
export interface EmailProviderPreset {
  id: string;
  label: string;
  /** false = listed for honesty, cannot be connected (see unsupportedReason) */
  supported: boolean;
  unsupportedReason: string | null;
  imap: EmailEndpoint | null;
  smtp: EmailEndpoint | null;
  /** what the "password" field must contain */
  passwordKind: 'app_password' | 'bridge_password' | 'account_password';
  /** the provider already files outgoing SMTP mail in Sent (the app then does not append a copy) */
  autoSavesSent: boolean;
  /** plain-language steps to get the password */
  steps: string[];
  helpUrl: string | null;
  notes: string | null;
}
export interface EmailConnectInput {
  /** a preset id from GET /api/email/providers, or "custom" with imap + smtp */
  presetId: string;
  address: string;
  /** app password / bridge password. Sent once, stored encrypted, never returned. */
  password: string;
  /** login name if it is not the address */
  username?: string;
  label?: string;
  imap?: EmailEndpoint;
  smtp?: EmailEndpoint;
  /** custom only; accepted only for localhost servers (e.g. Proton Bridge) */
  allowSelfSigned?: boolean;
  /** custom only */
  autoSavesSent?: boolean;
}
export type EmailTestErrorCode = 'auth_failed' | 'app_password_required' | 'host_unreachable' | 'timeout' | 'tls_error' | 'tls_mismatch' | 'server_error' | 'unknown';
export interface EmailProtocolTest { ok: boolean; code: EmailTestErrorCode | null; message: string | null }
export interface EmailConnectionTestResult { ok: boolean; imap: EmailProtocolTest; smtp: EmailProtocolTest; sentFolder: string | null }
export interface EmailAttachmentDTO { id: string; filename: string; mime: string; size: number; inline: boolean; /** executable/script type: warn before opening */ risky: boolean; downloadUrl: string }
export interface EmailMessageDTO {
  id: string; direction: 'in' | 'out'; fromName: string | null; fromAddr: string; to: string[]; cc: string[]; date: string;
  /** plain text only */
  body: string;
  bodySource: 'plain' | 'html_converted' | 'none';
  /** body was cut at the size limit */
  truncated: boolean;
  unread: boolean;
  attachments: EmailAttachmentDTO[];
}
export interface EmailThreadSummary {
  id: string; accountId: string; subject: string; snippet: string; lastMessageAt: string; unread: boolean; needsReply: boolean; hasSummary: boolean;
  /** display name or address of the sender of the latest message */
  from: string; messageCount: number; hasAttachments: boolean;
}
export interface EmailThreadDetail extends EmailThreadSummary { messages: EmailMessageDTO[]; summary: { summary: string; actionItems: string[]; needsReply: boolean; at: string } | null; /** set when the read/unread change could not be pushed to the mail server yet */ serverSyncError: string | null }
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
