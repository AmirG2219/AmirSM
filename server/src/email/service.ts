/**
 * Email workspace service.
 *
 *  - Real mailboxes: a modular MailProvider (generic IMAP+SMTP today) feeds a local cache (cache.ts/sync.ts); the UI reads the cache.
 *  - Sample mailbox: fictional messages, shown only while no real account is connected.
 *  - Nothing is ever sent without an explicit approve step whose content hash must match at send time.
 */
import crypto from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { Db, Row } from '../db/index.js';
import { newId, now, parseJson, tx } from '../db/index.js';
import type {
  EmailAccountDTO, EmailAttachmentDTO, EmailConnectInput, EmailConnectionTestResult, EmailDraftDTO, EmailMessageDTO, EmailProviderPreset, EmailThreadDetail, EmailThreadSummary, IntegrationStatus,
} from '../../../shared/api.js';
import { HttpError, conflict, notFound } from '../http.js';
import { insertSentLocal, recomputeThread, recomputeThreads, upsertRemote, type CacheAccount } from './cache.js';
import { SecretBox, SecretBoxError } from './crypto.js';
import { FIXTURE_THREADS, SAMPLE_LABEL, SAMPLE_OWNER_ADDRESS } from './fixtures.js';
import { findPreset, PRESETS } from './presets.js';
import { FixtureProvider } from './providers/fixture.js';
import { ImapSmtpProvider } from './providers/imap-smtp.js';
import { SlidingWindowLimiter } from './rate-limit.js';
import { cleanLine, downloadMime, isRiskyFilename, redact } from './sanitize.js';
import { pushPendingSeen, readSyncState, syncAccount } from './sync.js';
import { replyHeaders, replySubject } from './threading.js';
import { ProviderError, type AttachmentStream, type FolderRole, type ImapSmtpSettings, type MailProvider, type OutgoingMail, type ServerEndpoint } from './types.js';

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export interface ProviderFactoryInput { accountId: string; address: string; settings: ImapSmtpSettings; password: string }
export interface EmailServiceOptions {
  providerFactory?: (input: ProviderFactoryInput) => MailProvider;
  box?: SecretBox;
  /** overrides config.email.autoSyncSeconds (milliseconds; 0 = off) */
  autoSyncMs?: number;
  /** overrides the connection-test rate limit */
  connectTestsPerMinute?: number;
}

// Addresses: one plain address per entry, no display names/lists/quotes (those are how header injection and list-splitting happen).
const EMAIL_RE = /^[^\s@<>()[\],;:"\\\u0000-\u001F]+@[^\s@<>()[\],;:"'\\\u0000-\u001F.][^\s@<>()[\],;:"'\\\u0000-\u001F]*\.[^\s@<>()[\],;:"'\\\u0000-\u001F]+$/;
export function parseAddresses(list: string[], field: string): string[] {
  const out = [...new Set(list.map((s) => s.trim()).filter(Boolean))];
  if (out.length > 10) throw new HttpError(400, 'bad_request', `Too many recipients in ${field} (max 10).`);
  for (const a of out) if (a.length > 254 || !EMAIL_RE.test(a)) throw new HttpError(400, 'bad_request', `“${cleanLine(a, 60)}” is not a valid email address.`);
  return out;
}

const hashDraft = (d: { accountId: string; to: string[]; cc: string[]; subject: string; body: string }) =>
  crypto.createHash('sha256').update(JSON.stringify([d.accountId, d.to, d.cc, d.subject, d.body])).digest('hex');

export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

const SYNC_STATE_VALUES = ['never', 'syncing', 'ok', 'error'] as const;

export class EmailService {
  private fixture = new FixtureProvider();
  private syncing = new Map<string, Promise<void>>();
  private sending = new Set<string>();
  private testLimiter: SlidingWindowLimiter;
  private searchLimiter = new SlidingWindowLimiter(20, 60_000);
  private boxCache: SecretBox | null = null;
  private autoSyncMs: number;

  constructor(private cfg: AppConfig, private db: Db, private opts: EmailServiceOptions = {}) {
    this.testLimiter = new SlidingWindowLimiter(opts.connectTestsPerMinute ?? cfg.email.connectTestsPerMinute, 60_000);
    this.autoSyncMs = opts.autoSyncMs ?? cfg.email.autoSyncSeconds * 1000;
    this.seedSample();
    // a "syncing" state cannot survive a restart
    this.db.prepare("UPDATE email_accounts SET sync_state = CASE WHEN last_sync_at IS NULL THEN 'never' ELSE 'ok' END WHERE sync_state = 'syncing'").run();
  }

  // ------------------------------------------------------------------ plumbing
  private box(): SecretBox {
    if (this.opts.box) return this.opts.box;
    return (this.boxCache ??= SecretBox.fromFile(this.cfg.email.keyFile));
  }

  private seedSample() {
    if (!this.cfg.email.sampleMailbox) return;
    if (this.db.prepare("SELECT 1 FROM email_accounts WHERE provider = 'fixture'").get()) return;
    const accountId = newId('acc');
    tx(this.db, () => {
      this.db.prepare('INSERT INTO email_accounts (id, provider, label, address, is_fixture, created_at, sync_state) VALUES (?,?,?,?,1,?,?)').run(accountId, 'fixture', SAMPLE_LABEL, SAMPLE_OWNER_ADDRESS, now(), 'ok');
      for (const t of FIXTURE_THREADS) {
        const tid = newId('thr');
        const last = t.messages[t.messages.length - 1]!;
        const lastAt = new Date(Date.now() - last.hoursAgo * 3_600_000).toISOString();
        this.db.prepare('INSERT INTO email_threads (id, account_id, subject, snippet, last_message_at, unread, needs_reply, message_count, last_from) VALUES (?,?,?,?,?,?,?,?,?)').run(
          tid, accountId, t.subject, last.body.slice(0, 140), lastAt, t.unread ? 1 : 0, t.needsReply ? 1 : 0, t.messages.length, last.fromName,
        );
        for (const m of t.messages) {
          this.db.prepare('INSERT INTO email_messages (id, thread_id, direction, from_name, from_addr, to_json, cc_json, date, body_text, account_id, folder, seen, subject) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
            newId('msg'), tid, m.direction, m.fromName, m.fromAddr, JSON.stringify(m.to), '[]', new Date(Date.now() - m.hoursAgo * 3_600_000).toISOString(), m.body, accountId, m.direction === 'out' ? 'sent' : 'inbox',
            m.direction === 'in' && t.unread ? 0 : 1, t.subject,
          );
        }
      }
    });
  }

  private realRows(): Row[] {
    return this.db.prepare("SELECT * FROM email_accounts WHERE is_fixture = 0 AND provider != 'fixture' ORDER BY created_at").all() as Row[];
  }
  /** Accounts the UI may see: the sample mailbox only while no real account exists. */
  private visibleRows(): Row[] {
    const real = this.realRows();
    if (real.length) return real;
    if (!this.cfg.email.sampleMailbox) return [];
    return this.db.prepare('SELECT * FROM email_accounts WHERE is_fixture = 1').all() as Row[];
  }
  accountRow(id: string): Row {
    const r = this.visibleRows().find((x) => x.id === id);
    if (!r) throw notFound('Email account');
    return r;
  }
  private settingsOf(r: Row): ImapSmtpSettings {
    const s = parseJson<ImapSmtpSettings | null>(r.settings_json, null);
    if (!s) throw new HttpError(500, 'bad_account', 'The account has no connection settings. Disconnect and connect it again.');
    return s;
  }
  private providerFor(r: Row): MailProvider {
    if (r.is_fixture) return this.fixture;
    const settings = this.settingsOf(r);
    if (!r.credentials_enc) throw new ProviderError('no_credentials', 'No stored credentials for this account. Disconnect and connect it again.');
    let password: string;
    try {
      password = (JSON.parse(this.box().decrypt(r.credentials_enc, `account:${r.id}`)) as { password: string }).password;
    } catch (e) {
      if (e instanceof SecretBoxError) throw new ProviderError(e.code, e.message);
      throw e;
    }
    const factory = this.opts.providerFactory ?? ((a: ProviderFactoryInput) => new ImapSmtpProvider(a.address, a.settings, a.password));
    return factory({ accountId: r.id, address: r.address, settings, password });
  }
  private cacheAcc(r: Row): CacheAccount {
    return { id: r.id, address: r.address };
  }

  // ------------------------------------------------------------------ providers + connect flow
  presets(): EmailProviderPreset[] {
    return PRESETS;
  }

  private toDTO(r: Row): EmailAccountDTO {
    const fixture = !!r.is_fixture;
    const state = (SYNC_STATE_VALUES as readonly string[]).includes(r.sync_state) ? (r.sync_state as EmailAccountDTO['syncState']) : 'never';
    const s = fixture ? null : parseJson<ImapSmtpSettings | null>(r.settings_json, null);
    return {
      id: r.id,
      provider: r.provider,
      presetId: r.preset_id ?? null,
      label: fixture ? SAMPLE_LABEL : r.label,
      address: r.address,
      isFixture: fixture,
      canRead: true,
      canSend: true,
      statusDetail: fixture ? this.fixture.statusDetail() : s ? `Reads and sends mail through ${s.imap.host} (IMAP) and ${s.smtp.host} (SMTP).` : 'Connection settings missing.',
      imapHost: s?.imap.host ?? null,
      syncState: state,
      lastSyncAt: r.last_sync_at ?? null,
      lastError: r.last_error ?? null,
    };
  }
  accounts(): EmailAccountDTO[] {
    return this.visibleRows().map((r) => this.toDTO(r));
  }
  account(id: string): EmailAccountDTO {
    return this.toDTO(this.accountRow(id));
  }

  integrationStatus(): IntegrationStatus {
    const real = this.realRows();
    if (!real.length) {
      return this.cfg.email.sampleMailbox
        ? { id: 'email', label: 'Mailbox', state: 'fixture', detail: 'Showing a sample mailbox with fictional messages. No real mailbox is connected.', action: 'Connect your mailbox from the Email page.' }
        : { id: 'email', label: 'Mailbox', state: 'not_configured', detail: 'No mailbox is connected.', action: 'Connect your mailbox from the Email page.' };
    }
    const bad = real.filter((r) => r.sync_state === 'error');
    if (bad.length === real.length) {
      return { id: 'email', label: 'Mailbox', state: 'error', detail: `${bad.map((r) => r.address).join(', ')}: ${bad[0]!.last_error ?? 'sync failed'}`, action: 'Open the Email page to retry, or reconnect with a fresh app password.' };
    }
    const synced = real.map((r) => r.last_sync_at as string | null).filter((x): x is string => !!x).sort().pop();
    const names = real.map((r) => r.address).join(', ');
    return {
      id: 'email', label: 'Mailbox', state: 'connected',
      detail: `${names} — ${synced ? `last synced ${synced}` : 'first sync in progress'}.${bad.length ? ` ${bad.length} account(s) have a sync error.` : ''}`,
    };
  }

  private resolveConnection(input: EmailConnectInput): { settings: ImapSmtpSettings; preset: EmailProviderPreset; address: string } {
    const preset = findPreset(input.presetId);
    if (!preset) throw new HttpError(400, 'unknown_provider', `Unknown provider “${cleanLine(input.presetId, 40)}”.`);
    if (!preset.supported) throw new HttpError(400, 'provider_not_supported', preset.unsupportedReason ?? 'This provider is not supported yet.');
    const address = input.address.trim();
    if (!EMAIL_RE.test(address)) throw new HttpError(400, 'bad_request', 'Enter your full email address.');
    let imap: ServerEndpoint | null;
    let smtp: ServerEndpoint | null;
    let allowSelfSigned = false;
    let autoSavesSent = preset.autoSavesSent;
    if (preset.id === 'custom') {
      imap = input.imap ?? null;
      smtp = input.smtp ?? null;
      if (!imap || !smtp) throw new HttpError(400, 'bad_request', 'Enter the IMAP and SMTP server settings.');
      allowSelfSigned = !!input.allowSelfSigned;
      autoSavesSent = !!input.autoSavesSent;
    } else {
      imap = preset.imap;
      smtp = preset.smtp;
      allowSelfSigned = preset.id === 'protonbridge';
    }
    if (!imap || !smtp) throw new HttpError(400, 'bad_request', 'Missing server settings.');
    for (const [name, ep] of [['IMAP', imap], ['SMTP', smtp]] as const) {
      if (ep.security === 'none' && !isLoopbackHost(ep.host)) throw new HttpError(400, 'insecure_connection', `${name}: unencrypted connections are only allowed to servers on this computer. Choose TLS or STARTTLS.`);
    }
    if (allowSelfSigned && !(isLoopbackHost(imap.host) && isLoopbackHost(smtp.host))) {
      throw new HttpError(400, 'insecure_connection', 'Self-signed certificates are only accepted for servers on this computer (e.g. Proton Bridge).');
    }
    return { settings: { imap: { ...imap, host: imap.host.toLowerCase() }, smtp: { ...smtp, host: smtp.host.toLowerCase() }, username: (input.username?.trim() || address), allowSelfSigned, autoSavesSent }, preset, address };
  }

  private rateLimit() {
    const wait = this.testLimiter.hit();
    if (wait) throw new HttpError(429, 'rate_limited', `Too many connection attempts. Try again in ${wait}s.`);
  }

  private makeProvider(address: string, settings: ImapSmtpSettings, password: string): MailProvider {
    const factory = this.opts.providerFactory ?? ((a: ProviderFactoryInput) => new ImapSmtpProvider(a.address, a.settings, a.password));
    return factory({ accountId: 'test', address, settings, password });
  }

  /** Tries IMAP and SMTP login without saving anything. */
  async testConnection(input: EmailConnectInput): Promise<EmailConnectionTestResult> {
    const { settings, address } = this.resolveConnection(input);
    this.rateLimit();
    return this.makeProvider(address, settings, input.password).testConnection();
  }

  /** Tests, then stores the account (credentials encrypted) and starts the first sync in the background. */
  async connect(input: EmailConnectInput): Promise<EmailAccountDTO> {
    const { settings, preset, address } = this.resolveConnection(input);
    if (this.realRows().some((r) => String(r.address).toLowerCase() === address.toLowerCase())) throw conflict('already_connected', `${address} is already connected. Disconnect it first to change its settings.`);
    this.rateLimit();
    const result = await this.makeProvider(address, settings, input.password).testConnection();
    if (!result.ok) {
      const first = !result.imap.ok ? result.imap : result.smtp;
      throw new HttpError(422, 'connection_failed', `Could not connect: ${first.message ?? 'login failed'}`, result);
    }
    const id = newId('acc');
    let enc: string;
    try {
      enc = this.box().encrypt(JSON.stringify({ password: input.password }), `account:${id}`);
    } catch (e) {
      if (e instanceof SecretBoxError) throw new HttpError(500, 'key_file_error', e.message);
      throw e;
    }
    const label = cleanLine(input.label ?? '', 80) || address;
    this.db.prepare('INSERT INTO email_accounts (id, provider, label, address, is_fixture, created_at, preset_id, settings_json, credentials_enc, sync_state) VALUES (?,?,?,?,0,?,?,?,?,?)').run(
      id, 'imap', label, address, now(), preset.id, JSON.stringify(settings), enc, 'never',
    );
    void this.startSync(id);
    return this.account(id);
  }

  /** Removes the stored credentials and the local copy of the mail. The mailbox on the server is never touched. */
  disconnect(id: string): { removed: { threads: number; messages: number; drafts: number } } {
    const r = this.db.prepare('SELECT * FROM email_accounts WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw notFound('Email account');
    if (r.is_fixture) throw new HttpError(400, 'fixture_account', 'The sample mailbox cannot be disconnected. It disappears by itself once you connect a real mailbox.');
    const count = (sql: string) => Number((this.db.prepare(sql).get(id) as Row).n);
    const removed = { threads: count('SELECT COUNT(*) AS n FROM email_threads WHERE account_id = ?'), messages: count('SELECT COUNT(*) AS n FROM email_messages WHERE account_id = ?'), drafts: count('SELECT COUNT(*) AS n FROM email_drafts WHERE account_id = ?') };
    tx(this.db, () => {
      this.db.prepare('DELETE FROM email_drafts WHERE account_id = ?').run(id);
      this.db.prepare('DELETE FROM email_messages WHERE account_id = ?').run(id); // attachments + refs cascade
      this.db.prepare('DELETE FROM email_threads WHERE account_id = ?').run(id);
      this.db.prepare('DELETE FROM email_accounts WHERE id = ?').run(id);
    });
    return { removed };
  }

  // ------------------------------------------------------------------ sync
  /** Starts (or joins) a sync of one account; the returned promise settles when it is finished and never rejects. */
  startSync(id: string): Promise<void> {
    const existing = this.syncing.get(id);
    if (existing) return existing;
    const r = this.accountRow(id);
    if (r.is_fixture) return Promise.resolve();
    this.db.prepare("UPDATE email_accounts SET sync_state = 'syncing' WHERE id = ?").run(id);
    const p = (async () => {
      try {
        const provider = this.providerFor(r);
        await syncAccount(this.db, this.cacheAcc(r), provider);
        this.db.prepare("UPDATE email_accounts SET sync_state = 'ok', last_sync_at = ?, last_error = NULL WHERE id = ?").run(now(), id);
      } catch (e) {
        const msg = redact(cleanLine((e as Error).message || 'Sync failed.', 400), []);
        this.db.prepare("UPDATE email_accounts SET sync_state = 'error', last_error = ? WHERE id = ?").run(msg, id);
      } finally {
        this.syncing.delete(id);
      }
    })();
    this.syncing.set(id, p);
    return p;
  }
  /** Resolves once every running sync has finished (used when shutting down / in tests). */
  async idle(): Promise<void> {
    await Promise.all([...this.syncing.values()]);
  }
  /** Background refresh when the list is opened and the last sync is stale. */
  maybeAutoSync() {
    if (this.autoSyncMs <= 0) return;
    for (const r of this.realRows()) {
      if (this.syncing.has(r.id)) continue;
      const last = r.last_sync_at ? Date.parse(r.last_sync_at) : 0;
      if (r.sync_state === 'never' || Date.now() - last >= this.autoSyncMs) void this.startSync(r.id);
    }
  }

  // ------------------------------------------------------------------ reading
  private threadSummary(r: Row): EmailThreadSummary {
    return { id: r.id, accountId: r.account_id, subject: r.subject, snippet: r.snippet, lastMessageAt: r.last_message_at, unread: !!r.unread, needsReply: !!r.needs_reply, hasSummary: !!r.summary_json, from: r.last_from ?? '', messageCount: r.message_count ?? 0, hasAttachments: !!r.has_attachments };
  }

  listThreads(opts: { accountId?: string; q?: string; filter?: 'unread' | 'needs_reply'; mailbox?: 'inbox' | 'sent' | 'all'; limit?: number; before?: string }): EmailThreadSummary[] {
    const visible = this.visibleRows().map((r) => r.id as string);
    if (!visible.length) return [];
    const where: string[] = [`t.account_id IN (${visible.map(() => '?').join(',')})`];
    const args: (string | number)[] = [...visible];
    if (opts.accountId) { where.push('t.account_id = ?'); args.push(opts.accountId); }
    if (opts.filter === 'unread') where.push('t.unread = 1');
    if (opts.filter === 'needs_reply') where.push('t.needs_reply = 1');
    if (opts.before) { where.push('t.last_message_at < ?'); args.push(opts.before); }
    if (opts.mailbox && opts.mailbox !== 'all') {
      where.push('EXISTS (SELECT 1 FROM email_messages m WHERE m.thread_id = t.id AND m.dup = 0 AND m.folder = ?)');
      args.push(opts.mailbox);
    }
    const words = (opts.q ?? '').split(/\s+/).filter(Boolean).slice(0, 6);
    for (const w of words) {
      const like = `%${w.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
      where.push(`(t.subject LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM email_messages m WHERE m.thread_id = t.id AND m.dup = 0 AND (m.body_text LIKE ? ESCAPE '\\' OR m.from_addr LIKE ? ESCAPE '\\' OR m.from_name LIKE ? ESCAPE '\\' OR m.to_json LIKE ? ESCAPE '\\')))`);
      args.push(like, like, like, like, like);
    }
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 200);
    const rows = this.db.prepare(`SELECT t.* FROM email_threads t WHERE ${where.join(' AND ')} ORDER BY t.last_message_at DESC LIMIT ${limit}`).all(...args) as Row[];
    return rows.map((r) => this.threadSummary(r));
  }

  /** Imports older matching mail from the server into the cache so that normal (local) search finds it. */
  async importServerSearch(query: string, accountId?: string): Promise<{ imported: number }> {
    const wait = this.searchLimiter.hit();
    if (wait) throw new HttpError(429, 'rate_limited', `Too many server searches. Try again in ${wait}s.`);
    const rows = this.visibleRows().filter((r) => !r.is_fixture && (!accountId || r.id === accountId));
    let imported = 0;
    for (const r of rows) {
      const state = readSyncState(this.db, r.id);
      const provider = this.providerFor(r);
      for (const role of ['inbox', 'sent'] as FolderRole[]) {
        const st = state[role];
        if (!st) continue;
        try {
          const uids = await provider.searchFolder(role, st.folderName, query, 50);
          const known = new Set((this.db.prepare('SELECT uid FROM email_messages WHERE account_id = ? AND folder = ? AND uid IS NOT NULL').all(r.id, role) as Row[]).map((x) => x.uid as number));
          const fresh = uids.filter((u) => !known.has(u));
          if (!fresh.length) continue;
          const msgs = await provider.fetchMessages(role, st.folderName, fresh);
          tx(this.db, () => {
            const touched = new Set<string>();
            for (const m of msgs.sort((a, b) => a.date.localeCompare(b.date))) {
              const t = upsertRemote(this.db, this.cacheAcc(r), m);
              if (t) { touched.add(t); imported++; }
            }
            recomputeThreads(this.db, touched);
          });
        } catch (e) {
          throw new HttpError(502, 'server_search_failed', `Searching ${r.address} on the mail server failed: ${(e as Error).message}`);
        }
      }
    }
    return { imported };
  }

  threadRow(id: string): Row {
    const r = this.db.prepare('SELECT * FROM email_threads WHERE id = ?').get(id) as Row | undefined;
    if (!r || !this.visibleRows().some((a) => a.id === r.account_id)) throw notFound('Thread');
    return r;
  }
  getThread(id: string): EmailThreadDetail {
    const r = this.threadRow(id);
    const attRows = this.db.prepare('SELECT a.* FROM email_attachments a JOIN email_messages m ON m.id = a.message_id WHERE m.thread_id = ? ORDER BY a.rowid').all(id) as Row[];
    const attBy = new Map<string, EmailAttachmentDTO[]>();
    for (const a of attRows) {
      const list = attBy.get(a.message_id) ?? [];
      list.push({ id: a.id, filename: a.filename, mime: a.mime, size: a.size, inline: !!a.inline, risky: isRiskyFilename(a.filename), downloadUrl: `/api/email/attachments/${a.id}` });
      attBy.set(a.message_id, list);
    }
    const messages = (this.db.prepare('SELECT * FROM email_messages WHERE thread_id = ? AND dup = 0 ORDER BY date, rowid').all(id) as Row[]).map(
      (m): EmailMessageDTO => ({
        id: m.id, direction: m.direction, fromName: m.from_name, fromAddr: m.from_addr, to: parseJson(m.to_json, []), cc: parseJson(m.cc_json, []), date: m.date, body: m.body_text,
        bodySource: m.body_source ?? 'plain', truncated: !!m.truncated, unread: m.direction === 'in' && !m.seen, attachments: attBy.get(m.id) ?? [],
      }),
    );
    const s = parseJson<{ summary: string; actionItems: string[]; needsReply: boolean } | null>(r.summary_json, null);
    const pending = Number((this.db.prepare('SELECT COUNT(*) AS n FROM email_messages WHERE thread_id = ? AND seen_pending IS NOT NULL').get(id) as Row).n);
    return {
      ...this.threadSummary(r), messages, summary: s ? { ...s, at: r.summary_at } : null,
      serverSyncError: pending ? 'The read/unread change has not reached the mail server yet. It will be retried on the next sync.' : null,
    };
  }

  /** Marks a thread read/unread locally and on the server (standard mail-client behaviour: opening a mail sets \Seen there too). */
  async markRead(id: string, read: boolean): Promise<void> {
    const t = this.threadRow(id);
    const acc = this.accountRow(t.account_id);
    tx(this.db, () => {
      if (read) {
        this.db.prepare('UPDATE email_messages SET seen = 1, seen_pending = CASE WHEN uid IS NOT NULL THEN 1 ELSE NULL END WHERE thread_id = ? AND dup = 0 AND seen = 0').run(id);
      } else {
        const last = this.db.prepare("SELECT id, uid FROM email_messages WHERE thread_id = ? AND dup = 0 AND direction = 'in' ORDER BY date DESC, rowid DESC LIMIT 1").get(id) as Row | undefined;
        if (last) this.db.prepare('UPDATE email_messages SET seen = 0, seen_pending = CASE WHEN uid IS NOT NULL THEN 0 ELSE NULL END WHERE id = ?').run(last.id);
      }
      recomputeThread(this.db, id);
      // the sample mailbox keeps its thread-level flag authoritative
      if (acc.is_fixture) this.db.prepare('UPDATE email_threads SET unread = ? WHERE id = ?').run(read ? 0 : 1, id);
    });
    if (!acc.is_fixture) {
      try {
        await pushPendingSeen(this.db, this.cacheAcc(acc), this.providerFor(acc));
      } catch { /* stays pending; surfaced as serverSyncError and retried on the next sync */ }
    }
  }
  saveSummary(id: string, s: { summary: string; actionItems: string[]; needsReply: boolean }) {
    this.db.prepare('UPDATE email_threads SET summary_json = ?, summary_at = ?, needs_reply = ? WHERE id = ?').run(JSON.stringify(s), now(), s.needsReply ? 1 : 0, id);
  }

  async openAttachment(attachmentId: string): Promise<AttachmentStream & { filename: string; mime: string }> {
    const a = this.db.prepare('SELECT a.*, m.uid, m.folder, m.account_id FROM email_attachments a JOIN email_messages m ON m.id = a.message_id WHERE a.id = ?').get(attachmentId) as Row | undefined;
    if (!a) throw notFound('Attachment');
    const acc = this.accountRow(a.account_id);
    if (acc.is_fixture || a.uid == null) throw notFound('Attachment');
    if (a.size > MAX_ATTACHMENT_BYTES) throw new HttpError(413, 'attachment_too_large', `This attachment is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB, which is the limit for downloads here. Open it in your mail provider's own app.`);
    const st = readSyncState(this.db, acc.id)[a.folder as FolderRole];
    if (!st) throw conflict('not_synced', 'The mailbox has not been synced yet.');
    try {
      const s = await this.providerFor(acc).openAttachment(a.folder, st.folderName, a.uid, a.part_id, MAX_ATTACHMENT_BYTES);
      return { ...s, filename: a.filename, mime: downloadMime(a.mime) };
    } catch (e) {
      if (e instanceof ProviderError && e.code === 'not_found') throw notFound('Attachment on the mail server');
      if (e instanceof HttpError) throw e;
      throw new HttpError(502, 'attachment_failed', (e as Error).message);
    }
  }

  // ------------------------------------------------------------------ drafts
  private toDraft(r: Row): EmailDraftDTO {
    return {
      id: r.id, accountId: r.account_id, threadId: r.thread_id ?? null, to: parseJson(r.to_json, []), cc: parseJson(r.cc_json, []), subject: r.subject, body: r.body,
      aiAssisted: !!r.ai_assisted, status: r.status, approvedAt: r.approved_at ?? null, sentAt: r.sent_at ?? null, sendResult: parseJson(r.send_result_json, null), createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }
  draftRow(id: string): Row {
    const r = this.db.prepare('SELECT * FROM email_drafts WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw notFound('Draft');
    return r;
  }
  getDraft(id: string) {
    return this.toDraft(this.draftRow(id));
  }
  listDrafts(opts: { status?: string } = {}) {
    const visible = new Set(this.visibleRows().map((r) => r.id));
    const rows = (opts.status
      ? this.db.prepare('SELECT * FROM email_drafts WHERE status = ? ORDER BY updated_at DESC').all(opts.status)
      : this.db.prepare('SELECT * FROM email_drafts ORDER BY updated_at DESC LIMIT 200').all()) as Row[];
    return rows.filter((r) => visible.has(r.account_id)).map((r) => this.toDraft(r));
  }
  createDraft(input: { accountId: string; threadId?: string | null; to: string[]; cc?: string[]; subject: string; body: string; aiAssisted?: boolean }): EmailDraftDTO {
    this.accountRow(input.accountId);
    if (input.threadId && this.threadRow(input.threadId).account_id !== input.accountId) throw new HttpError(400, 'bad_request', 'The thread belongs to a different account.');
    const id = newId('drf');
    const t = now();
    const subject = cleanLine(input.threadId ? replySubject(input.subject) : input.subject, 300);
    this.db.prepare('INSERT INTO email_drafts (id, account_id, thread_id, to_json, cc_json, subject, body, ai_assisted, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
      id, input.accountId, input.threadId ?? null, JSON.stringify(parseAddresses(input.to, 'to')), JSON.stringify(parseAddresses(input.cc ?? [], 'cc')), subject, input.body, input.aiAssisted ? 1 : 0, 'draft', t, t,
    );
    return this.getDraft(id);
  }
  updateDraft(id: string, patch: Partial<{ to: string[]; cc: string[]; subject: string; body: string; aiAssisted: boolean }>): EmailDraftDTO {
    const r = this.draftRow(id);
    if (r.status === 'sent') throw conflict('already_sent', 'This draft was already sent.');
    if (this.sending.has(id)) throw conflict('send_in_progress', 'This draft is being sent right now.');
    const subject = patch.subject === undefined ? r.subject : cleanLine(r.thread_id ? replySubject(patch.subject) : patch.subject, 300);
    // Any edit invalidates a previous approval.
    this.db.prepare("UPDATE email_drafts SET to_json = ?, cc_json = ?, subject = ?, body = ?, ai_assisted = ?, status = 'draft', approved_hash = NULL, approved_at = NULL, updated_at = ? WHERE id = ?").run(
      patch.to ? JSON.stringify(parseAddresses(patch.to, 'to')) : r.to_json,
      patch.cc ? JSON.stringify(parseAddresses(patch.cc, 'cc')) : r.cc_json,
      subject, patch.body ?? r.body, patch.aiAssisted === undefined ? r.ai_assisted : patch.aiAssisted ? 1 : 0, now(), id,
    );
    return this.getDraft(id);
  }
  approveDraft(id: string): EmailDraftDTO {
    const d = this.getDraft(id);
    if (d.status === 'sent') throw conflict('already_sent', 'This draft was already sent.');
    if (this.sending.has(id)) throw conflict('send_in_progress', 'This draft is being sent right now.');
    if (!d.to.length) throw new HttpError(400, 'bad_request', 'Add at least one recipient before approving.');
    if (!d.subject.trim() || !d.body.trim()) throw new HttpError(400, 'bad_request', 'Subject and body are required.');
    this.accountRow(d.accountId);
    this.db.prepare("UPDATE email_drafts SET status = 'approved', approved_hash = ?, approved_at = ?, updated_at = ? WHERE id = ?").run(hashDraft(d), now(), now(), id);
    return this.getDraft(id);
  }

  /** Reply headers from the newest message in the thread that has a Message-ID. */
  private replyContext(threadId: string | null): { inReplyTo?: string; references?: string[] } {
    if (!threadId) return {};
    const p = this.db.prepare('SELECT rfc_message_id, references_json FROM email_messages WHERE thread_id = ? AND dup = 0 AND rfc_message_id IS NOT NULL ORDER BY date DESC, rowid DESC LIMIT 1').get(threadId) as Row | undefined;
    if (!p) return {};
    return replyHeaders({ messageId: p.rfc_message_id, references: parseJson<string[]>(p.references_json, []) });
  }

  /** Sends only an approved draft whose content is byte-identical to what was approved. */
  async sendDraft(id: string): Promise<EmailDraftDTO> {
    const r = this.draftRow(id);
    const d = this.toDraft(r);
    if (d.status !== 'approved' || !r.approved_hash) throw conflict('not_approved', 'Approve the draft before sending.');
    if (hashDraft(d) !== r.approved_hash) throw conflict('changed_since_approval', 'The draft changed after approval. Review and approve it again.');
    if (this.sending.has(id)) throw conflict('send_in_progress', 'This draft is already being sent.');
    const acc = this.accountRow(d.accountId);
    this.sending.add(id);
    let sent = false;
    try {
      const provider = this.providerFor(acc);
      if (!provider.canSend) throw conflict('cannot_send', 'This account cannot send.');
      const domain = (acc.address.split('@')[1] ?? 'localhost').replace(/[^A-Za-z0-9.-]/g, '') || 'localhost';
      const messageId = `<${crypto.randomUUID()}@${domain}>`;
      const sentAt = new Date();
      const mail: OutgoingMail = { from: acc.address, to: d.to, cc: d.cc, subject: d.subject, body: d.body, messageId, date: sentAt, ...this.replyContext(d.threadId) };
      const res = await provider.send(mail);
      const t = sentAt.toISOString();
      sent = true;
      try {
      tx(this.db, () => {
        this.db.prepare("UPDATE email_drafts SET status = 'sent', sent_at = ?, send_result_json = ?, updated_at = ? WHERE id = ?").run(t, JSON.stringify({ delivered: res.delivered, note: res.note }), t, id);
        if (acc.is_fixture) {
          if (d.threadId) {
            this.db.prepare('INSERT INTO email_messages (id, thread_id, direction, from_name, from_addr, to_json, cc_json, date, body_text, account_id, folder, seen, subject) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
              newId('msg'), d.threadId, 'out', 'You', acc.address, JSON.stringify(d.to), JSON.stringify(d.cc), t, d.body, acc.id, 'sent', 1, d.subject,
            );
            this.db.prepare('UPDATE email_threads SET needs_reply = 0, last_message_at = ?, snippet = ?, message_count = message_count + 1, last_from = ? WHERE id = ?').run(t, d.body.slice(0, 140), 'You', d.threadId);
          }
        } else {
          const ctx = this.replyContext(d.threadId);
          const threadId = insertSentLocal(this.db, this.cacheAcc(acc), {
            threadId: d.threadId, messageId: messageId.slice(1, -1).toLowerCase(), inReplyTo: ctx.inReplyTo ? ctx.inReplyTo.slice(1, -1) : null, references: (ctx.references ?? []).map((x) => x.slice(1, -1)),
            to: d.to, cc: d.cc, subject: d.subject, body: d.body, date: t,
          });
          this.db.prepare('UPDATE email_threads SET needs_reply = 0 WHERE id = ?').run(threadId);
          recomputeThread(this.db, threadId);
        }
      });
      } catch {
        // The mail IS sent; never report a failure (a retry would send it twice). Keep the minimal record.
        this.db.prepare("UPDATE email_drafts SET status = 'sent', sent_at = ?, send_result_json = ?, updated_at = ? WHERE id = ?").run(t, JSON.stringify({ delivered: res.delivered, note: res.note + ' (Local thread view could not be updated; it will catch up on the next sync.)' }), t, id);
      }
    } catch (e) {
      if (e instanceof HttpError || sent) throw e;
      const msg = (e as Error).message;
      this.db.prepare("UPDATE email_drafts SET status = 'failed', send_result_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify({ delivered: false, note: msg }), now(), id);
      throw new HttpError(502, 'send_failed', msg);
    } finally {
      this.sending.delete(id);
    }
    return this.getDraft(id);
  }
}
