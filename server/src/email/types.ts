/**
 * The provider seam. A mailbox provider knows how to talk to ONE kind of mail backend; everything above it
 * (sync/threading/cache, approve->send gate, routes) is provider-independent.
 *
 *   - ImapSmtpProvider (providers/imap-smtp.ts): any IMAP+SMTP server with a password / app password.
 *   - FixtureProvider  (providers/fixture.ts):    the fictional sample mailbox.
 *   - Later: a Gmail-API or Microsoft-Graph provider (OAuth) implements the same interface; only
 *     `createProvider` in service.ts and a preset entry need to change.
 *
 * Provider methods must never log or throw anything that contains the password.
 */
import type { EmailConnectionTestResult, EmailSecurity } from '../../../shared/api.js';

export type FolderRole = 'inbox' | 'sent';

export interface ServerEndpoint { host: string; port: number; security: EmailSecurity }

/** Non-secret connection settings, stored as JSON on the account row. */
export interface ImapSmtpSettings {
  imap: ServerEndpoint;
  smtp: ServerEndpoint;
  username: string;
  /** accept a self-signed certificate — only ever honoured for loopback hosts (Proton Bridge) */
  allowSelfSigned: boolean;
  /** the provider files SMTP-sent mail in Sent by itself (do not append a copy over IMAP) */
  autoSavesSent: boolean;
}

export interface RemoteAttachment { partId: string; filename: string; mime: string; size: number; inline: boolean }

/** One message as read from a server, already parsed and reduced to safe plain text. */
export interface RemoteMessage {
  folder: FolderRole;
  uid: number;
  /** Message-ID without angle brackets, lower-cased */
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  subject: string;
  fromName: string | null;
  fromAddr: string;
  to: string[];
  cc: string[];
  date: string; // ISO
  seen: boolean;
  body: string;
  bodySource: 'plain' | 'html_converted' | 'none';
  truncated: boolean;
  attachments: RemoteAttachment[];
  /** Gmail X-GM-THRID (or JMAP/OBJECTID THREADID) when the server provides one */
  serverThreadId: string | null;
  size: number | null;
}

/** Per-folder incremental sync cursor, stored on the account. */
export interface FolderSyncState {
  uidValidity: string;
  /** next UID the server will assign when we last looked: everything >= this is new */
  uidNext: number;
  /** lowest UID in the cached window; messages below it are only cached if the owner searched for them */
  windowStartUid: number;
  folderName: string;
}

export interface FolderSyncRequest {
  role: FolderRole;
  state: FolderSyncState | null;
  /** how many of the newest messages to take on a first sync / after UIDVALIDITY changed */
  initialLimit: number;
  /** safety cap for one incremental run */
  maxNew: number;
}
export interface FolderSyncResult {
  /** false when the server has no such folder (e.g. no Sent folder found) */
  available: boolean;
  state: FolderSyncState | null;
  /** true when the server's UIDVALIDITY differs from the stored one: cached mail for this folder must be discarded */
  reset: boolean;
  messages: RemoteMessage[];
  /** current \Seen state of every message >= windowStartUid; UIDs missing here were deleted on the server */
  flags: { uid: number; seen: boolean }[];
}

export interface OutgoingMail {
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  messageId: string; // with angle brackets
  inReplyTo?: string;
  references?: string[];
  date: Date;
}
export interface SendOutcome {
  /** true = accepted by the outgoing mail server (NOT proof that the recipient received it); false = recorded locally only */
  delivered: boolean;
  note: string;
  accepted: string[];
  rejected: string[];
  /** null = not applicable (provider saves it itself, or sample mailbox) */
  savedToSent: boolean | null;
}

export interface AttachmentStream {
  stream: NodeJS.ReadableStream & { destroy(err?: Error): unknown };
  mime: string;
  filename: string | null;
}

export class ProviderError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface MailProvider {
  readonly kind: string;
  readonly canRead: boolean;
  readonly canSend: boolean;
  /** shown in the account list */
  statusDetail(): string;
  /** connect + authenticate on every protocol without changing anything on the server */
  testConnection(): Promise<EmailConnectionTestResult>;
  syncFolder(req: FolderSyncRequest): Promise<FolderSyncResult>;
  /** set/clear \Seen on the server for messages of one folder */
  setSeen(role: FolderRole, folderName: string, uids: number[], seen: boolean): Promise<void>;
  /** server-side text search (UIDs, newest first) */
  searchFolder(role: FolderRole, folderName: string, query: string, limit: number): Promise<number[]>;
  fetchMessages(role: FolderRole, folderName: string, uids: number[]): Promise<RemoteMessage[]>;
  /** streams one attachment from the server; the caller must consume or destroy the stream */
  openAttachment(role: FolderRole, folderName: string, uid: number, partId: string, maxBytes: number): Promise<AttachmentStream>;
  /** SMTP send (+ copy to Sent when the provider does not do it). Throws ProviderError with a human-readable message. */
  send(msg: OutgoingMail): Promise<SendOutcome>;
}
