/**
 * Email workspace service. Provider integration is modular:
 *  - "fixture"  — local sample mailbox (readable, never delivers anything)
 * Nothing is ever sent without an explicit approve step whose content hash must match at send time.
 */
import crypto from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { Db, Row } from '../db/index.js';
import { newId, now, parseJson, tx } from '../db/index.js';
import type { EmailAccountDTO, EmailDraftDTO, EmailMessageDTO, EmailThreadDetail, EmailThreadSummary } from '../../../shared/api.js';
import { HttpError, conflict, notFound } from '../http.js';
import { FIXTURE_THREADS, SAMPLE_OWNER_ADDRESS } from './fixtures.js';

export interface OutgoingMessage { from: string; to: string[]; cc: string[]; subject: string; body: string }
export interface SendResult { delivered: boolean; note: string; externalId?: string }
export interface EmailProvider {
  id: string;
  canRead: boolean;
  canSend: boolean;
  statusDetail(): string;
  send(msg: OutgoingMessage): Promise<SendResult>;
}

class FixtureProvider implements EmailProvider {
  id = 'fixture';
  canRead = true;
  canSend = true;
  statusDetail() {
    return 'Local sample mailbox with fictional messages. Sending only records the message locally; nothing is delivered.';
  }
  async send(): Promise<SendResult> {
    return { delivered: false, note: 'Local sample mailbox: recorded locally, NOT delivered to anyone.' };
  }
}

const EMAIL_RE = /^[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+$/;
export function parseAddresses(list: string[], field: string): string[] {
  const out = list.map((s) => s.trim()).filter(Boolean);
  if (out.length > 10) throw new HttpError(400, 'bad_request', `Too many recipients in ${field} (max 10).`);
  for (const a of out) if (!EMAIL_RE.test(a)) throw new HttpError(400, 'bad_request', `“${a}” is not a valid email address.`);
  return out;
}

const hashDraft = (d: { accountId: string; to: string[]; cc: string[]; subject: string; body: string }) =>
  crypto.createHash('sha256').update(JSON.stringify([d.accountId, d.to, d.cc, d.subject, d.body])).digest('hex');

export class EmailService {
  private providers = new Map<string, EmailProvider>();

  constructor(private cfg: AppConfig, private db: Db, fetchImpl: typeof fetch = fetch) {
    if (cfg.email.sampleMailbox) this.providers.set('fixture', new FixtureProvider());
    this.syncAccounts();
  }

  private syncAccounts() {
    const have = new Set((this.db.prepare('SELECT provider FROM email_accounts').all() as Row[]).map((r) => r.provider as string));
    if (this.providers.has('fixture') && !have.has('fixture')) {
      const accountId = newId('acc');
      tx(this.db, () => {
        this.db.prepare('INSERT INTO email_accounts (id, provider, label, address, is_fixture, created_at) VALUES (?,?,?,?,1,?)').run(accountId, 'fixture', 'Local sample mailbox', SAMPLE_OWNER_ADDRESS, now());
        for (const t of FIXTURE_THREADS) {
          const tid = newId('thr');
          const last = t.messages[t.messages.length - 1]!;
          const lastAt = new Date(Date.now() - last.hoursAgo * 3_600_000).toISOString();
          this.db.prepare('INSERT INTO email_threads (id, account_id, subject, snippet, last_message_at, unread, needs_reply) VALUES (?,?,?,?,?,?,?)').run(tid, accountId, t.subject, last.body.slice(0, 140), lastAt, t.unread ? 1 : 0, t.needsReply ? 1 : 0);
          for (const m of t.messages) {
            this.db.prepare('INSERT INTO email_messages (id, thread_id, direction, from_name, from_addr, to_json, cc_json, date, body_text) VALUES (?,?,?,?,?,?,?,?,?)').run(
              newId('msg'), tid, m.direction, m.fromName, m.fromAddr, JSON.stringify(m.to), '[]', new Date(Date.now() - m.hoursAgo * 3_600_000).toISOString(), m.body,
            );
          }
        }
      });
    }
  }

  integrationStatus(): import('../../../shared/api.js').IntegrationStatus {
    const accounts = this.accounts();
    return accounts.some((a) => !a.isFixture)
      ? { id: 'email', label: 'Mailbox', state: 'connected', detail: 'Connected.' }
      : { id: 'email', label: 'Mailbox', state: 'fixture', detail: 'Showing a sample mailbox with fictional messages. No real mailbox is connected yet.', action: 'Connect your mailbox from the Email page.' };
  }

  provider(id: string) {
    return this.providers.get(id);
  }

  accounts(): EmailAccountDTO[] {
    return (this.db.prepare('SELECT * FROM email_accounts ORDER BY created_at').all() as Row[])
      .filter((r) => this.providers.has(r.provider))
      .map((r) => {
        const p = this.providers.get(r.provider)!;
        return { id: r.id, provider: r.provider, label: r.label, address: r.address, isFixture: !!r.is_fixture, canRead: p.canRead, canSend: p.canSend, statusDetail: p.statusDetail() };
      });
  }
  accountRow(id: string): Row {
    const r = this.db.prepare('SELECT * FROM email_accounts WHERE id = ?').get(id) as Row | undefined;
    if (!r || !this.providers.has(r.provider)) throw notFound('Email account');
    return r;
  }

  // ---------- reading ----------
  private threadSummary(r: Row): EmailThreadSummary {
    return { id: r.id, accountId: r.account_id, subject: r.subject, snippet: r.snippet, lastMessageAt: r.last_message_at, unread: !!r.unread, needsReply: !!r.needs_reply, hasSummary: !!r.summary_json };
  }
  listThreads(opts: { accountId?: string; q?: string; filter?: 'unread' | 'needs_reply' }): EmailThreadSummary[] {
    const where = ['1=1'];
    const args: string[] = [];
    if (opts.accountId) { where.push('t.account_id = ?'); args.push(opts.accountId); }
    if (opts.filter === 'unread') where.push('t.unread = 1');
    if (opts.filter === 'needs_reply') where.push('t.needs_reply = 1');
    if (opts.q) {
      where.push('(t.subject LIKE ? OR EXISTS (SELECT 1 FROM email_messages m WHERE m.thread_id = t.id AND (m.body_text LIKE ? OR m.from_addr LIKE ? OR m.from_name LIKE ?)))');
      const like = `%${opts.q}%`;
      args.push(like, like, like, like);
    }
    const rows = this.db.prepare(`SELECT t.* FROM email_threads t WHERE ${where.join(' AND ')} ORDER BY t.last_message_at DESC LIMIT 200`).all(...args) as Row[];
    const live = new Set(this.accounts().map((a) => a.id));
    return rows.filter((r) => live.has(r.account_id)).map((r) => this.threadSummary(r));
  }
  threadRow(id: string): Row {
    const r = this.db.prepare('SELECT * FROM email_threads WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw notFound('Thread');
    return r;
  }
  getThread(id: string): EmailThreadDetail {
    const r = this.threadRow(id);
    const messages = (this.db.prepare('SELECT * FROM email_messages WHERE thread_id = ? ORDER BY date').all(id) as Row[]).map(
      (m): EmailMessageDTO => ({ id: m.id, direction: m.direction, fromName: m.from_name, fromAddr: m.from_addr, to: parseJson(m.to_json, []), cc: parseJson(m.cc_json, []), date: m.date, body: m.body_text }),
    );
    const s = parseJson<{ summary: string; actionItems: string[]; needsReply: boolean } | null>(r.summary_json, null);
    return { ...this.threadSummary(r), messages, summary: s ? { ...s, at: r.summary_at } : null };
  }
  markRead(id: string, read: boolean) {
    this.threadRow(id);
    this.db.prepare('UPDATE email_threads SET unread = ? WHERE id = ?').run(read ? 0 : 1, id);
  }
  saveSummary(id: string, s: { summary: string; actionItems: string[]; needsReply: boolean }) {
    this.db.prepare('UPDATE email_threads SET summary_json = ?, summary_at = ? WHERE id = ?').run(JSON.stringify(s), now(), id);
  }

  // ---------- drafts ----------
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
    const rows = (opts.status
      ? this.db.prepare('SELECT * FROM email_drafts WHERE status = ? ORDER BY updated_at DESC').all(opts.status)
      : this.db.prepare('SELECT * FROM email_drafts ORDER BY updated_at DESC LIMIT 200').all()) as Row[];
    return rows.map((r) => this.toDraft(r));
  }
  createDraft(input: { accountId: string; threadId?: string | null; to: string[]; cc?: string[]; subject: string; body: string; aiAssisted?: boolean }): EmailDraftDTO {
    this.accountRow(input.accountId);
    if (input.threadId) this.threadRow(input.threadId);
    const id = newId('drf');
    const t = now();
    this.db.prepare('INSERT INTO email_drafts (id, account_id, thread_id, to_json, cc_json, subject, body, ai_assisted, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
      id, input.accountId, input.threadId ?? null, JSON.stringify(parseAddresses(input.to, 'to')), JSON.stringify(parseAddresses(input.cc ?? [], 'cc')), input.subject, input.body, input.aiAssisted ? 1 : 0, 'draft', t, t,
    );
    return this.getDraft(id);
  }
  updateDraft(id: string, patch: Partial<{ to: string[]; cc: string[]; subject: string; body: string; aiAssisted: boolean }>): EmailDraftDTO {
    const r = this.draftRow(id);
    if (r.status === 'sent') throw conflict('already_sent', 'This draft was already sent.');
    // Any edit invalidates a previous approval.
    this.db.prepare("UPDATE email_drafts SET to_json = ?, cc_json = ?, subject = ?, body = ?, ai_assisted = ?, status = 'draft', approved_hash = NULL, approved_at = NULL, updated_at = ? WHERE id = ?").run(
      patch.to ? JSON.stringify(parseAddresses(patch.to, 'to')) : r.to_json,
      patch.cc ? JSON.stringify(parseAddresses(patch.cc, 'cc')) : r.cc_json,
      patch.subject ?? r.subject, patch.body ?? r.body, patch.aiAssisted === undefined ? r.ai_assisted : patch.aiAssisted ? 1 : 0, now(), id,
    );
    return this.getDraft(id);
  }
  approveDraft(id: string): EmailDraftDTO {
    const d = this.getDraft(id);
    if (d.status === 'sent') throw conflict('already_sent', 'This draft was already sent.');
    if (!d.to.length) throw new HttpError(400, 'bad_request', 'Add at least one recipient before approving.');
    if (!d.subject.trim() || !d.body.trim()) throw new HttpError(400, 'bad_request', 'Subject and body are required.');
    this.db.prepare("UPDATE email_drafts SET status = 'approved', approved_hash = ?, approved_at = ?, updated_at = ? WHERE id = ?").run(hashDraft(d), now(), now(), id);
    return this.getDraft(id);
  }
  /** Sends only an approved draft whose content is byte-identical to what was approved. */
  async sendDraft(id: string): Promise<EmailDraftDTO> {
    const r = this.draftRow(id);
    const d = this.toDraft(r);
    if (d.status !== 'approved' || !r.approved_hash) throw conflict('not_approved', 'Approve the draft before sending.');
    if (hashDraft(d) !== r.approved_hash) throw conflict('changed_since_approval', 'The draft changed after approval. Review and approve it again.');
    const acc = this.accountRow(d.accountId);
    const provider = this.providers.get(acc.provider)!;
    if (!provider.canSend) throw conflict('cannot_send', 'This account cannot send.');
    try {
      const res = await provider.send({ from: acc.address, to: d.to, cc: d.cc, subject: d.subject, body: d.body });
      const t = now();
      tx(this.db, () => {
        this.db.prepare("UPDATE email_drafts SET status = 'sent', sent_at = ?, send_result_json = ?, updated_at = ? WHERE id = ?").run(t, JSON.stringify({ delivered: res.delivered, note: res.note }), t, id);
        if (d.threadId) {
          this.db.prepare('INSERT INTO email_messages (id, thread_id, direction, from_name, from_addr, to_json, cc_json, date, body_text) VALUES (?,?,?,?,?,?,?,?,?)').run(
            newId('msg'), d.threadId, 'out', 'You', acc.address, JSON.stringify(d.to), JSON.stringify(d.cc), t, d.body,
          );
          this.db.prepare('UPDATE email_threads SET needs_reply = 0, last_message_at = ?, snippet = ? WHERE id = ?').run(t, d.body.slice(0, 140), d.threadId);
        }
      });
    } catch (e) {
      this.db.prepare("UPDATE email_drafts SET status = 'failed', send_result_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify({ delivered: false, note: (e as Error).message }), now(), id);
      throw new HttpError(502, 'send_failed', (e as Error).message);
    }
    return this.getDraft(id);
  }
}
