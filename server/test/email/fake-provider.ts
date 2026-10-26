/**
 * A hand-written in-memory MailProvider (NO protocol code): used to test sync/threading/cache/service logic deterministically.
 * It mimics the semantics we rely on (UIDs, UIDVALIDITY, windows, flags, expunge) but proves nothing about IMAP itself —
 * that is what the emulator tests are for.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { loadConfig } from '../../src/config.js';
import { openDb, type Db } from '../../src/db/index.js';
import { EmailService, type EmailServiceOptions } from '../../src/email/service.js';
import { SecretBox } from '../../src/email/crypto.js';
import { ProviderError, type AttachmentStream, type FolderRole, type FolderSyncRequest, type FolderSyncResult, type MailProvider, type OutgoingMail, type RemoteMessage, type SendOutcome } from '../../src/email/types.js';
import type { EmailConnectInput, EmailConnectionTestResult } from '../../../shared/api.js';

export function msg(over: Partial<RemoteMessage> & { subject: string }): Omit<RemoteMessage, 'folder' | 'uid'> {
  return {
    messageId: null, inReplyTo: null, references: [], fromName: 'Alice', fromAddr: 'alice@example.com', to: ['me@example.com'], cc: [], date: '2026-06-01T10:00:00.000Z', seen: false, body: 'body of ' + over.subject, bodySource: 'plain',
    truncated: false, attachments: [], serverThreadId: null, size: 100, ...over,
  };
}

export class FakeProvider implements MailProvider {
  readonly kind = 'fake';
  readonly canRead = true;
  readonly canSend = true;
  uidValidity = '1000';
  folders: Record<FolderRole, Map<number, RemoteMessage>> = { inbox: new Map(), sent: new Map() };
  nextUid: Record<FolderRole, number> = { inbox: 1, sent: 1 };
  hasSent = true;
  syncCalls = 0;
  failWith: Error | null = null;
  failSetSeen: Error | null = null;
  failSend: Error | null = null;
  sentMails: OutgoingMail[] = [];
  seenLog: { role: FolderRole; uids: number[]; seen: boolean }[] = [];
  /** if set, the "server" stores the sent mail in Sent under this rewritten Message-ID */
  rewriteSentId: string | null = null;
  autoSaveSent = true;
  testResult: EmailConnectionTestResult = { ok: true, imap: { ok: true, code: null, message: null }, smtp: { ok: true, code: null, message: null }, sentFolder: 'Sent' };

  statusDetail() { return 'fake'; }
  async testConnection() { return this.testResult; }

  add(role: FolderRole, m: Omit<RemoteMessage, 'folder' | 'uid'>): number {
    const uid = this.nextUid[role]++;
    this.folders[role].set(uid, { ...m, folder: role, uid });
    return uid;
  }
  remove(role: FolderRole, uid: number) { this.folders[role].delete(uid); }
  setFlag(role: FolderRole, uid: number, seen: boolean) { this.folders[role].get(uid)!.seen = seen; }
  resetValidity() { this.uidValidity = String(Number(this.uidValidity) + 1); for (const r of ['inbox', 'sent'] as const) { this.folders[r].clear(); this.nextUid[r] = 1; } }

  async syncFolder(req: FolderSyncRequest): Promise<FolderSyncResult> {
    this.syncCalls++;
    await new Promise((r) => setTimeout(r, 5));
    if (this.failWith) throw this.failWith;
    if (req.role === 'sent' && !this.hasSent) return { available: false, state: null, reset: false, messages: [], flags: [] };
    const all = [...this.folders[req.role].values()].sort((a, b) => a.uid - b.uid);
    const reset = !!req.state && req.state.uidValidity !== this.uidValidity;
    const prev = reset ? null : req.state;
    let messages: RemoteMessage[];
    let windowStartUid: number;
    if (!prev) {
      messages = all.slice(-req.initialLimit);
      windowStartUid = messages[0]?.uid ?? this.nextUid[req.role];
    } else {
      messages = all.filter((m) => m.uid >= prev.uidNext).slice(-req.maxNew);
      windowStartUid = prev.windowStartUid;
    }
    const flags = all.filter((m) => m.uid >= windowStartUid).map((m) => ({ uid: m.uid, seen: m.seen }));
    return { available: true, reset, messages: structuredClone(messages), flags, state: { uidValidity: this.uidValidity, uidNext: this.nextUid[req.role], windowStartUid, folderName: req.role === 'inbox' ? 'INBOX' : 'Sent' } };
  }
  async setSeen(role: FolderRole, _f: string, uids: number[], seen: boolean) {
    if (this.failSetSeen) throw this.failSetSeen;
    this.seenLog.push({ role, uids, seen });
    for (const u of uids) this.folders[role].get(u)!.seen = seen;
  }
  async searchFolder(role: FolderRole, _f: string, q: string, limit: number) {
    return [...this.folders[role].values()].filter((m) => (m.subject + m.body).toLowerCase().includes(q.toLowerCase())).map((m) => m.uid).sort((a, b) => b - a).slice(0, limit);
  }
  async fetchMessages(role: FolderRole, _f: string, uids: number[]) {
    return structuredClone(uids.map((u) => this.folders[role].get(u)).filter((m): m is RemoteMessage => !!m));
  }
  async openAttachment(role: FolderRole, _f: string, uid: number, partId: string, maxBytes: number): Promise<AttachmentStream> {
    const m = this.folders[role].get(uid);
    if (!m?.attachments.find((a) => a.partId === partId)) throw new ProviderError('not_found', 'gone');
    return { stream: Readable.from([Buffer.from('x'.repeat(Math.min(10, maxBytes)))]), mime: 'text/html', filename: '../evil.html' };
  }
  async send(mail: OutgoingMail): Promise<SendOutcome> {
    if (this.failSend) throw this.failSend;
    this.sentMails.push(mail);
    if (this.autoSaveSent) {
      this.add('sent', msg({ subject: mail.subject, messageId: (this.rewriteSentId ?? mail.messageId).replace(/^<|>$/g, '').toLowerCase(), inReplyTo: mail.inReplyTo?.replace(/^<|>$/g, '') ?? null, references: (mail.references ?? []).map((r) => r.replace(/^<|>$/g, '')), fromAddr: mail.from, fromName: null, to: mail.to, cc: mail.cc, date: mail.date.toISOString(), seen: true, body: mail.body }));
    }
    return { delivered: true, note: 'fake accepted', accepted: [...mail.to, ...mail.cc], rejected: [], savedToSent: this.autoSaveSent ? null : false };
  }
}

export interface Harness {
  svc: EmailService;
  db: Db;
  dir: string;
  fake: FakeProvider;
  box: SecretBox;
  addAccount(over?: Partial<EmailConnectInput>): Promise<string>;
  close(): void;
}
export function makeHarness(opts: EmailServiceOptions = {}, env: Record<string, string> = {}): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amir-email-'));
  const cfg = loadConfig({ DATA_DIR: dir, EMAIL_AUTO_SYNC_SECONDS: '0', ...env } as NodeJS.ProcessEnv, { readDotEnv: false });
  const db = openDb(':memory:');
  const fake = new FakeProvider();
  const box = SecretBox.fromKey(Buffer.alloc(32, 3));
  const svc = new EmailService(cfg, db, { providerFactory: () => fake, box, autoSyncMs: 0, ...opts });
  return {
    svc, db, dir, fake, box,
    async addAccount(over = {}) {
      const acc = await svc.connect({ presetId: 'custom', address: 'me@example.com', password: 'pw-123456', imap: { host: '127.0.0.1', port: 1143, security: 'none' }, smtp: { host: '127.0.0.1', port: 1025, security: 'none' }, ...over });
      await svc.idle();
      return acc.id;
    },
    close() { db.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}
