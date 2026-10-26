/**
 * Local cache of server mail: inserting messages (with threading), flag updates, deletions, thread bookkeeping.
 * Everything here is synchronous SQLite work; callers wrap it in a transaction.
 */
import type { Db, Row } from '../db/index.js';
import { newId } from '../db/index.js';
import { hasReplyPrefix, normalizeSubject, SUBJECT_MATCH_WINDOW_MS } from './threading.js';
import type { FolderRole, RemoteMessage } from './types.js';

export interface CacheAccount { id: string; address: string }

const MAX_SNIPPET = 140;
const snippetOf = (body: string) => body.replace(/\s+/g, ' ').trim().slice(0, MAX_SNIPPET);
const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(',');

function mergeThreads(db: Db, keep: string, drop: string[]) {
  for (const d of drop) {
    if (d === keep) continue;
    db.prepare('UPDATE email_messages SET thread_id = ? WHERE thread_id = ?').run(keep, d);
    db.prepare('UPDATE email_drafts SET thread_id = ? WHERE thread_id = ?').run(keep, d);
    db.prepare('DELETE FROM email_threads WHERE id = ?').run(d);
  }
  db.prepare('UPDATE email_threads SET summary_json = NULL, summary_at = NULL WHERE id = ?').run(keep);
}

function findThreadCandidates(db: Db, acc: CacheAccount, m: RemoteMessage): string[] {
  const found = new Map<string, string>(); // thread id -> last_message_at
  const add = (rows: Row[]) => { for (const r of rows) found.set(r.thread_id ?? r.id, r.last_message_at ?? ''); };

  if (m.serverThreadId) {
    add(db.prepare('SELECT id, last_message_at FROM email_threads WHERE account_id = ? AND gm_thrid = ?').all(acc.id, m.serverThreadId) as Row[]);
  }
  const parents = [...new Set([m.inReplyTo, ...m.references].filter((x): x is string => !!x))].slice(0, 40);
  if (parents.length) {
    add(db.prepare(`SELECT m.thread_id, t.last_message_at FROM email_messages m JOIN email_threads t ON t.id = m.thread_id WHERE m.account_id = ? AND m.rfc_message_id IN (${placeholders(parents.length)})`).all(acc.id, ...parents) as Row[]);
  }
  if (m.messageId) {
    // children that were synced before this message
    add(db.prepare('SELECT m.thread_id, t.last_message_at FROM email_message_refs r JOIN email_messages m ON m.id = r.message_pk JOIN email_threads t ON t.id = m.thread_id WHERE r.account_id = ? AND r.ref = ?').all(acc.id, m.messageId) as Row[]);
  }
  if (!found.size && hasReplyPrefix(m.subject)) {
    const key = normalizeSubject(m.subject);
    if (key) {
      const t = Date.parse(m.date);
      const rows = db.prepare('SELECT id, last_message_at FROM email_threads WHERE account_id = ? AND subject_key = ? ORDER BY last_message_at DESC LIMIT 5').all(acc.id, key) as Row[];
      const hit = rows.find((r) => Math.abs(Date.parse(r.last_message_at) - t) <= SUBJECT_MATCH_WINDOW_MS);
      if (hit) found.set(hit.id, hit.last_message_at);
    }
  }
  return [...found.entries()].sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0])).map(([id]) => id);
}

function saveAttachments(db: Db, messagePk: string, m: RemoteMessage) {
  db.prepare('DELETE FROM email_attachments WHERE message_id = ?').run(messagePk);
  for (const a of m.attachments) {
    db.prepare('INSERT INTO email_attachments (id, message_id, part_id, filename, mime, size, inline) VALUES (?,?,?,?,?,?,?)').run(newId('att'), messagePk, a.partId, a.filename, a.mime, a.size, a.inline ? 1 : 0);
  }
}

/** A message we sent ourselves and stored before the Sent folder copy was synced (uid IS NULL). */
function findSentPlaceholder(db: Db, acc: CacheAccount, m: RemoteMessage): Row | undefined {
  if (m.folder !== 'sent') return undefined;
  if (m.messageId) {
    const byId = db.prepare('SELECT id FROM email_messages WHERE account_id = ? AND uid IS NULL AND rfc_message_id = ?').get(acc.id, m.messageId) as Row | undefined;
    if (byId) return byId;
  }
  // Some providers rewrite the Message-ID on submission: fall back to same subject + same start of body within 15 minutes.
  const t = Date.parse(m.date);
  const rows = db.prepare("SELECT id, date, subject, body_text FROM email_messages WHERE account_id = ? AND uid IS NULL AND direction = 'out'").all(acc.id) as Row[];
  const start = m.body.slice(0, 120).trim();
  return rows.find((r) => Math.abs(Date.parse(r.date) - t) <= 15 * 60_000 && (r.subject ?? '') === m.subject && String(r.body_text).slice(0, 120).trim() === start);
}

/**
 * Insert one server message (or update the existing cached row) and attach it to the right thread.
 * Returns the thread id that needs recomputing, or null when nothing changed.
 */
export function upsertRemote(db: Db, acc: CacheAccount, m: RemoteMessage): string | null {
  const existing = db.prepare('SELECT id, thread_id FROM email_messages WHERE account_id = ? AND folder = ? AND uid = ?').get(acc.id, m.folder, m.uid) as Row | undefined;
  if (existing) return null;

  const direction = m.folder === 'sent' ? 'out' : 'in';
  const cols = {
    refs: JSON.stringify(m.references),
  };

  const placeholder = findSentPlaceholder(db, acc, m);
  if (placeholder) {
    const row = db.prepare('SELECT thread_id FROM email_messages WHERE id = ?').get(placeholder.id) as Row;
    db.prepare('UPDATE email_messages SET uid = ?, folder = ?, seen = ?, seen_pending = NULL, rfc_message_id = COALESCE(?, rfc_message_id), size = ?, gm_thrid = ? WHERE id = ?').run(m.uid, m.folder, m.seen ? 1 : 0, m.messageId, m.size, m.serverThreadId, placeholder.id);
    saveAttachments(db, placeholder.id as string, m);
    return row.thread_id as string;
  }

  const dupOf = m.messageId
    ? (db.prepare('SELECT id, thread_id FROM email_messages WHERE account_id = ? AND rfc_message_id = ? AND dup = 0 LIMIT 1').get(acc.id, m.messageId) as Row | undefined)
    : undefined;

  let threadId: string;
  if (dupOf) {
    threadId = dupOf.thread_id as string;
  } else {
    const cands = findThreadCandidates(db, acc, m);
    if (cands.length) {
      threadId = cands[0]!;
      if (cands.length > 1) mergeThreads(db, threadId, cands.slice(1));
    } else {
      threadId = newId('thr');
      db.prepare('INSERT INTO email_threads (id, account_id, subject, snippet, last_message_at, unread, needs_reply, subject_key, gm_thrid) VALUES (?,?,?,?,?,?,?,?,?)').run(
        threadId, acc.id, m.subject || '(no subject)', snippetOf(m.body), m.date, 0, 0, normalizeSubject(m.subject), m.serverThreadId,
      );
    }
  }
  const pk = newId('msg');
  db.prepare(
    `INSERT INTO email_messages (id, thread_id, direction, from_name, from_addr, to_json, cc_json, date, body_text, account_id, folder, uid, rfc_message_id, in_reply_to, references_json, subject, seen, gm_thrid, body_source, truncated, dup, size)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    pk, threadId, direction, m.fromName, m.fromAddr, JSON.stringify(m.to), JSON.stringify(m.cc), m.date, m.body, acc.id, m.folder, m.uid, m.messageId, m.inReplyTo, cols.refs, m.subject, m.seen ? 1 : 0,
    m.serverThreadId, m.bodySource, m.truncated ? 1 : 0, dupOf ? 1 : 0, m.size,
  );
  const refIds = [...new Set([m.inReplyTo, ...m.references].filter((x): x is string => !!x))].slice(0, 40);
  for (const r of refIds) db.prepare('INSERT INTO email_message_refs (message_pk, account_id, ref) VALUES (?,?,?)').run(pk, acc.id, r);
  saveAttachments(db, pk, m);
  return threadId;
}

/** Local record of a message we just sent (uid NULL until the Sent copy is synced). */
export function insertSentLocal(db: Db, acc: CacheAccount, input: { threadId: string | null; messageId: string; inReplyTo: string | null; references: string[]; to: string[]; cc: string[]; subject: string; body: string; date: string }): string {
  let threadId = input.threadId;
  if (!threadId) {
    threadId = newId('thr');
    db.prepare('INSERT INTO email_threads (id, account_id, subject, snippet, last_message_at, unread, needs_reply, subject_key) VALUES (?,?,?,?,?,?,?,?)').run(
      threadId, acc.id, input.subject, snippetOf(input.body), input.date, 0, 0, normalizeSubject(input.subject),
    );
  }
  const pk = newId('msg');
  db.prepare(
    `INSERT INTO email_messages (id, thread_id, direction, from_name, from_addr, to_json, cc_json, date, body_text, account_id, folder, uid, rfc_message_id, in_reply_to, references_json, subject, seen, body_source, dup)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
  ).run(pk, threadId, 'out', 'You', acc.address, JSON.stringify(input.to), JSON.stringify(input.cc), input.date, input.body, acc.id, 'sent', null, input.messageId, input.inReplyTo, JSON.stringify(input.references), input.subject, 1, 'plain');
  return threadId;
}

export function deleteMessages(db: Db, where: string, args: (string | number)[]): string[] {
  const rows = db.prepare(`SELECT id, thread_id FROM email_messages WHERE ${where}`).all(...args) as Row[];
  if (!rows.length) return [];
  for (const r of rows) db.prepare('DELETE FROM email_messages WHERE id = ?').run(r.id);
  return [...new Set(rows.map((r) => r.thread_id as string))];
}

/** Rebuilds the derived columns of a thread from its (non-duplicate) messages; deletes the thread when it has none. */
export function recomputeThread(db: Db, threadId: string) {
  const msgs = db.prepare('SELECT m.id, m.direction, m.from_name, m.from_addr, m.date, m.body_text, m.subject, m.seen, m.gm_thrid, (SELECT COUNT(*) FROM email_attachments a WHERE a.message_id = m.id AND a.inline = 0) AS att FROM email_messages m WHERE m.thread_id = ? AND m.dup = 0 ORDER BY m.date, m.rowid').all(threadId) as Row[];
  if (!msgs.length) {
    db.prepare('UPDATE email_drafts SET thread_id = NULL WHERE thread_id = ?').run(threadId);
    db.prepare('DELETE FROM email_threads WHERE id = ?').run(threadId);
    return;
  }
  const first = msgs[0]!;
  const last = msgs[msgs.length - 1]!;
  const t = db.prepare('SELECT subject, message_count, needs_reply FROM email_threads WHERE id = ?').get(threadId) as Row | undefined;
  if (!t) return;
  const subject = (first.subject as string | null)?.trim() || (t.subject as string) || '(no subject)';
  const unread = msgs.some((m) => m.direction === 'in' && !m.seen) ? 1 : 0;
  const gm = msgs.find((m) => m.gm_thrid)?.gm_thrid ?? null;
  const grew = msgs.length !== t.message_count && t.message_count > 0;
  db.prepare(
    `UPDATE email_threads SET subject = ?, subject_key = ?, snippet = ?, last_message_at = ?, unread = ?, message_count = ?, has_attachments = ?, last_from = ?, gm_thrid = COALESCE(?, gm_thrid),
       needs_reply = CASE WHEN ? = 'out' THEN 0 ELSE needs_reply END
       ${grew ? ', summary_json = NULL, summary_at = NULL' : ''}
     WHERE id = ?`,
  ).run(subject, normalizeSubject(subject), snippetOf(last.body_text), last.date, unread, msgs.length, msgs.some((m) => m.att > 0) ? 1 : 0, (last.from_name as string) || (last.from_addr as string), gm, last.direction, threadId);
}

export function recomputeThreads(db: Db, ids: Iterable<string>) {
  for (const id of new Set(ids)) recomputeThread(db, id);
}

/** Apply the server's current \Seen flags (skipping messages with a not-yet-pushed local change). Returns touched threads. */
export function applyFlags(db: Db, acc: CacheAccount, role: FolderRole, flags: { uid: number; seen: boolean }[]): string[] {
  const touched = new Set<string>();
  const upd = db.prepare('UPDATE email_messages SET seen = ? WHERE account_id = ? AND folder = ? AND uid = ? AND seen_pending IS NULL AND seen != ? RETURNING thread_id');
  for (const f of flags) {
    for (const r of upd.all(f.seen ? 1 : 0, acc.id, role, f.uid, f.seen ? 1 : 0) as Row[]) touched.add(r.thread_id);
  }
  return [...touched];
}

/** Remove cached messages (in the synced window) that no longer exist on the server. */
export function removeVanished(db: Db, acc: CacheAccount, role: FolderRole, windowStartUid: number, uidNext: number, presentUids: number[]): string[] {
  const rows = db.prepare('SELECT id, uid, thread_id FROM email_messages WHERE account_id = ? AND folder = ? AND uid IS NOT NULL AND uid >= ? AND uid < ?').all(acc.id, role, windowStartUid, uidNext) as Row[];
  const present = new Set(presentUids);
  const touched = new Set<string>();
  for (const r of rows) {
    if (present.has(r.uid)) continue;
    db.prepare('DELETE FROM email_messages WHERE id = ?').run(r.id);
    touched.add(r.thread_id);
  }
  return [...touched];
}
