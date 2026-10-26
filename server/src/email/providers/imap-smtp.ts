/**
 * Generic IMAP + SMTP mailbox provider (imapflow, nodemailer, mailparser).
 *
 * - One short-lived IMAP connection per operation (connect, work, logout); nothing is kept open in the background.
 * - Reads never change server state (EXAMINE / BODY.PEEK); the only writes are \Seen flag changes, an APPEND of the
 *   sent copy, and SMTP submission — each triggered by an explicit owner action.
 * - No URL or file from mail content is ever fetched; nodemailer file/url access is disabled.
 * - The password is held in memory only for the lifetime of this object and is redacted from every error message.
 */
import { Transform } from 'node:stream';
import { ImapFlow, type FetchQueryObject, type FetchMessageObject } from 'imapflow';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type { EmailConnectionTestResult, EmailProtocolTest } from '../../../../shared/api.js';
import { mapMailError } from '../errors.js';
import { attachmentsFromStructure, parseRawMessage, type StructNode } from '../parse.js';
import { headerSafe, redact } from '../sanitize.js';
import {
  ProviderError,
  type AttachmentStream, type FolderRole, type FolderSyncRequest, type FolderSyncResult, type FolderSyncState, type ImapSmtpSettings, type MailProvider, type OutgoingMail, type RemoteMessage, type SendOutcome,
} from '../types.js';

/** Per-message source we pull for body text (attachments are streamed separately, on demand). */
export const MAX_SOURCE_BYTES = 512 * 1024;
const SENT_NAME_RE = /^(\[(gmail|google mail)\]\/)?(sent( items| mail| messages)?|gesendet|gesendete elemente|envoy[ée]s?|enviados?|elementos enviados|inviata|posta inviata|verzonden( items)?)$/i;

export interface ImapSmtpOptions { timeoutMs?: number }

export class ImapSmtpProvider implements MailProvider {
  readonly kind = 'imap';
  readonly canRead = true;
  readonly canSend = true;
  private timeoutMs: number;

  constructor(private address: string, private settings: ImapSmtpSettings, private password: string, opts: ImapSmtpOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  statusDetail() {
    return `Reads and sends mail through ${this.settings.imap.host} (IMAP) and ${this.settings.smtp.host} (SMTP).`;
  }

  // ---------------------------------------------------------------- plumbing
  private ctx(protocol: 'imap' | 'smtp') {
    const ep = protocol === 'imap' ? this.settings.imap : this.settings.smtp;
    return { protocol, host: ep.host, port: ep.port, security: ep.security, secrets: [this.password] } as const;
  }
  private fail(e: unknown, protocol: 'imap' | 'smtp'): ProviderError {
    if (e instanceof ProviderError) return e;
    const m = mapMailError(e, this.ctx(protocol));
    return new ProviderError(m.code, m.message);
  }

  private async connect(): Promise<ImapFlow> {
    const s = this.settings.imap;
    const client = new ImapFlow({
      host: s.host,
      port: s.port,
      secure: s.security === 'tls',
      doSTARTTLS: s.security === 'starttls' ? true : false,
      auth: { user: this.settings.username, pass: this.password },
      logger: false, // imapflow would otherwise be able to log protocol traffic
      tls: { rejectUnauthorized: !this.settings.allowSelfSigned, minVersion: 'TLSv1.2' },
      connectionTimeout: this.timeoutMs,
      greetingTimeout: this.timeoutMs,
      socketTimeout: 120_000,
      disableAutoIdle: true,
      clientInfo: { name: 'Amir SM' },
    });
    client.on('error', () => { /* surfaced through the failing command; an unhandled 'error' event would crash the process */ });
    try {
      await client.connect();
    } catch (e) {
      client.close();
      throw this.fail(e, 'imap');
    }
    return client;
  }

  private async withClient<T>(fn: (c: ImapFlow) => Promise<T>): Promise<T> {
    const client = await this.connect();
    try {
      return await fn(client);
    } catch (e) {
      throw this.fail(e, 'imap');
    } finally {
      await closeClient(client);
    }
  }

  private async withFolder<T>(folderName: string, readOnly: boolean, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
    return this.withClient(async (c) => {
      const lock = await c.getMailboxLock(folderName, { readOnly });
      try {
        return await fn(c);
      } finally {
        lock.release();
      }
    });
  }

  private async findSentFolder(c: ImapFlow): Promise<string | null> {
    const list = await c.list();
    const special = list.find((l) => l.specialUse === '\\Sent');
    if (special) return special.path;
    const byName = list.find((l) => !l.flags?.has('\\Noselect') && (SENT_NAME_RE.test(l.path) || SENT_NAME_RE.test(l.name)));
    return byName?.path ?? null;
  }

  // ---------------------------------------------------------------- test
  async testConnection(): Promise<EmailConnectionTestResult> {
    const [imap, smtp] = await Promise.all([this.testImap(), this.testSmtp()]);
    return { ok: imap.test.ok && smtp.ok, imap: imap.test, smtp, sentFolder: imap.sentFolder };
  }
  private async testImap(): Promise<{ test: EmailProtocolTest; sentFolder: string | null }> {
    try {
      const sent = await this.withClient((c) => this.findSentFolder(c));
      return { test: { ok: true, code: null, message: null }, sentFolder: sent };
    } catch (e) {
      const pe = this.fail(e, 'imap');
      return { test: { ok: false, code: pe.code as EmailProtocolTest['code'], message: pe.message }, sentFolder: null };
    }
  }
  private async testSmtp(): Promise<EmailProtocolTest> {
    const t = this.transport();
    try {
      await t.verify();
      return { ok: true, code: null, message: null };
    } catch (e) {
      const pe = this.fail(e, 'smtp');
      return { ok: false, code: pe.code as EmailProtocolTest['code'], message: pe.message };
    } finally {
      t.close();
    }
  }

  // ---------------------------------------------------------------- reading
  private fetchQuery(c: ImapFlow): FetchQueryObject {
    const q: FetchQueryObject = { uid: true, flags: true, bodyStructure: true, size: true, source: { maxLength: MAX_SOURCE_BYTES } as never };
    if (c.capabilities.has('X-GM-EXT-1') || c.capabilities.has('OBJECTID')) q.threadId = true;
    return q;
  }

  private async toRemote(role: FolderRole, m: FetchMessageObject): Promise<RemoteMessage | null> {
    if (!m.source) return null;
    const flags = m.flags ?? new Set<string>();
    const seen = flags.has('\\Seen') || flags.has('Seen');
    try {
      return await parseRawMessage(m.source, {
        folder: role,
        uid: m.uid,
        seen,
        size: m.size ?? null,
        serverThreadId: m.threadId ? String(m.threadId) : null,
        attachments: m.bodyStructure ? attachmentsFromStructure(m.bodyStructure as StructNode) : undefined,
        sourceTruncated: !!m.size && m.size > MAX_SOURCE_BYTES,
      });
    } catch {
      return null; // one unparsable message must not break the whole sync
    }
  }

  private async collect(c: ImapFlow, role: FolderRole, range: string, byUid: boolean): Promise<RemoteMessage[]> {
    const raws: FetchMessageObject[] = [];
    for await (const m of c.fetch(range, this.fetchQuery(c), { uid: byUid })) raws.push(m);
    const out: RemoteMessage[] = [];
    for (const m of raws) {
      const r = await this.toRemote(role, m);
      if (r) out.push(r);
    }
    return out;
  }

  async syncFolder(req: FolderSyncRequest): Promise<FolderSyncResult> {
    return this.withClient(async (c) => {
      const folderName = req.state?.folderName ?? (req.role === 'inbox' ? 'INBOX' : await this.findSentFolder(c));
      if (!folderName) return { available: false, state: null, reset: false, messages: [], flags: [] };
      let lock;
      try {
        lock = await c.getMailboxLock(folderName, { readOnly: true });
      } catch (e) {
        if (req.state) throw e;
        return { available: false, state: null, reset: false, messages: [], flags: [] };
      }
      try {
        const mb = c.mailbox;
        if (!mb) throw new ProviderError('server_error', 'The server did not open the folder.');
        const uidValidity = String(mb.uidValidity);
        const uidNext = Number(mb.uidNext);
        const reset = !!req.state && req.state.uidValidity !== uidValidity;
        const prev = reset ? null : req.state;
        let messages: RemoteMessage[] = [];
        let windowStartUid: number;
        if (!prev) {
          if (mb.exists > 0) {
            const from = Math.max(1, mb.exists - req.initialLimit + 1);
            messages = await this.collect(c, req.role, `${from}:*`, false);
            windowStartUid = messages.length ? Math.min(...messages.map((m) => m.uid)) : uidNext;
          } else {
            windowStartUid = uidNext;
          }
        } else {
          windowStartUid = prev.windowStartUid;
          const found = await c.search({ uid: `${prev.uidNext}:*` }, { uid: true });
          const fresh = (found || []).filter((u) => u >= prev.uidNext).slice(-req.maxNew);
          if (fresh.length) messages = await this.collect(c, req.role, fresh.join(','), true);
        }
        const flags: { uid: number; seen: boolean }[] = [];
        if (mb.exists > 0 && windowStartUid < uidNext) {
          for await (const m of c.fetch(`${windowStartUid}:*`, { uid: true, flags: true }, { uid: true })) {
            if (m.uid >= windowStartUid) flags.push({ uid: m.uid, seen: !!m.flags && (m.flags.has('\\Seen') || m.flags.has('Seen')) });
          }
        }
        const state: FolderSyncState = { uidValidity, uidNext, windowStartUid, folderName };
        return { available: true, state, reset, messages, flags };
      } finally {
        lock.release();
      }
    });
  }

  async setSeen(_role: FolderRole, folderName: string, uids: number[], seen: boolean): Promise<void> {
    if (!uids.length) return;
    await this.withFolder(folderName, false, async (c) => {
      const set = uids.join(',');
      if (seen) await c.messageFlagsAdd(set, ['\\Seen'], { uid: true });
      else await c.messageFlagsRemove(set, ['\\Seen'], { uid: true });
    });
  }

  async searchFolder(_role: FolderRole, folderName: string, query: string, limit: number): Promise<number[]> {
    return this.withFolder(folderName, true, async (c) => {
      const found = await c.search({ text: query }, { uid: true });
      return (found || []).sort((a, b) => b - a).slice(0, limit);
    });
  }

  async fetchMessages(role: FolderRole, folderName: string, uids: number[]): Promise<RemoteMessage[]> {
    if (!uids.length) return [];
    return this.withFolder(folderName, true, (c) => this.collect(c, role, uids.join(','), true));
  }

  async openAttachment(_role: FolderRole, folderName: string, uid: number, partId: string, maxBytes: number): Promise<AttachmentStream> {
    const client = await this.connect();
    let lock: Awaited<ReturnType<ImapFlow['getMailboxLock']>> | null = null;
    let cleaned = false;
    const cleanup = async () => {
      if (cleaned) return;
      cleaned = true;
      try { lock?.release(); } catch { /* ignore */ }
      await closeClient(client);
    };
    try {
      lock = await client.getMailboxLock(folderName, { readOnly: true });
      const dl = await client.download(String(uid), partId, { uid: true, maxBytes: maxBytes + 1 });
      if (!dl || !dl.content) throw new ProviderError('not_found', 'The attachment is no longer on the mail server.');
      const content = dl.content;
      let total = 0;
      const limiter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          total += chunk.length;
          if (total > maxBytes) cb(new Error('Attachment is larger than the download limit.'));
          else cb(null, chunk);
        },
      });
      content.on('error', (e: Error) => limiter.destroy(e));
      limiter.on('close', () => {
        content.destroy();
        void cleanup();
      });
      content.pipe(limiter);
      return { stream: limiter, mime: dl.meta?.contentType || 'application/octet-stream', filename: dl.meta?.filename ?? null };
    } catch (e) {
      await cleanup();
      throw this.fail(e, 'imap');
    }
  }

  // ---------------------------------------------------------------- sending
  private transport() {
    const s = this.settings.smtp;
    return nodemailer.createTransport({
      host: s.host,
      port: s.port,
      secure: s.security === 'tls',
      requireTLS: s.security === 'starttls',
      ignoreTLS: s.security === 'none',
      auth: { user: this.settings.username, pass: this.password },
      tls: { rejectUnauthorized: !this.settings.allowSelfSigned, minVersion: 'TLSv1.2' },
      connectionTimeout: this.timeoutMs,
      greetingTimeout: this.timeoutMs,
      socketTimeout: 60_000,
      logger: false,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  }

  async send(msg: OutgoingMail): Promise<SendOutcome> {
    const composer = new MailComposer({
      from: headerSafe(msg.from),
      to: msg.to.map(headerSafe),
      cc: msg.cc.length ? msg.cc.map(headerSafe) : undefined,
      subject: headerSafe(msg.subject),
      text: msg.body,
      messageId: msg.messageId,
      date: msg.date,
      inReplyTo: msg.inReplyTo ? headerSafe(msg.inReplyTo) : undefined,
      references: msg.references?.length ? msg.references.map(headerSafe) : undefined,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    const raw: Buffer = await composer.compile().build();
    const t = this.transport();
    let accepted: string[];
    let rejected: string[];
    try {
      const info = await t.sendMail({ envelope: { from: msg.from, to: [...msg.to, ...msg.cc] }, raw });
      accepted = (info.accepted ?? []).map(String);
      rejected = (info.rejected ?? []).map(String);
    } catch (e) {
      throw this.fail(e, 'smtp');
    } finally {
      t.close();
    }
    if (!accepted.length) throw new ProviderError('server_error', `The outgoing server refused every recipient (${rejected.join(', ') || 'none accepted'}). Nothing was sent.`);

    let savedToSent: boolean | null = null;
    let sentNote = '';
    if (!this.settings.autoSavesSent) {
      try {
        const ok = await this.withClient(async (c) => {
          const folder = await this.findSentFolder(c);
          if (!folder) return false;
          await c.append(folder, raw, ['\\Seen'], msg.date);
          return true;
        });
        savedToSent = ok;
        if (!ok) sentNote = ' A copy could not be saved to the Sent folder (no Sent folder found on the server).';
      } catch (e) {
        savedToSent = false;
        sentNote = ` A copy could not be saved to the Sent folder: ${redact((e as Error).message, [this.password])}`;
      }
    }
    const note =
      `Accepted by ${this.settings.smtp.host} for ${accepted.length} recipient${accepted.length === 1 ? '' : 's'}; this does not guarantee it reached their inbox.` +
      (rejected.length ? ` Rejected recipients: ${rejected.join(', ')}.` : '') + sentNote;
    return { delivered: true, note, accepted, rejected, savedToSent };
  }
}

async function closeClient(client: ImapFlow): Promise<void> {
  try {
    await Promise.race([client.logout(), new Promise((_, rej) => setTimeout(() => rej(new Error('logout timeout')), 3000))]);
  } catch {
    client.close();
  }
}
