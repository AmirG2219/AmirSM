/** Sync / cache / threading / service logic against a hand-written FAKE provider (no protocol involved). */
import { afterEach, describe, expect, it } from 'vitest';
import { upsertRemote, recomputeThread } from '../../src/email/cache.js';
import { makeHarness, msg, type Harness } from './fake-provider.js';

let h: Harness;
afterEach(() => h?.close());
const subjects = (list: { subject: string }[]) => list.map((t) => t.subject);

describe('initial + incremental sync', () => {
  it('imports INBOX and Sent into threads, newest first, with unread/attachment/count info', async () => {
    h = makeHarness();
    h.fake.add('inbox', msg({ subject: 'Plan', messageId: 'm1@x', date: '2026-06-01T10:00:00.000Z' }));
    h.fake.add('inbox', msg({ subject: 'Lunch?', messageId: 'm2@x', date: '2026-06-03T10:00:00.000Z', seen: true, attachments: [{ partId: '2', filename: 'menu.pdf', mime: 'application/pdf', size: 100, inline: false }] }));
    h.fake.add('sent', msg({ subject: 'Re: Plan', messageId: 'm3@x', inReplyTo: 'm1@x', references: ['m1@x'], fromAddr: 'me@example.com', fromName: null, to: ['alice@example.com'], date: '2026-06-02T10:00:00.000Z', seen: true }));
    const id = await h.addAccount();
    const inbox = h.svc.listThreads({});
    expect(subjects(inbox)).toEqual(['Lunch?', 'Plan']); // newest thread first
    expect(inbox[0]).toMatchObject({ unread: false, hasAttachments: true, messageCount: 1, from: 'Alice' });
    expect(inbox[1]).toMatchObject({ unread: true, messageCount: 2 });
    expect(h.svc.listThreads({ mailbox: 'sent' }).map((t) => t.subject)).toEqual(['Plan']);
    expect(h.svc.account(id)).toMatchObject({ syncState: 'ok', lastError: null, provider: 'imap', imapHost: '127.0.0.1' });
    expect(h.svc.account(id).lastSyncAt).toBeTruthy();
    const detail = h.svc.getThread(inbox[1]!.id);
    expect(detail.messages.map((m) => m.direction)).toEqual(['in', 'out']);
    expect(h.svc.getThread(inbox[0]!.id).messages[0]!.attachments[0]).toMatchObject({ filename: 'menu.pdf', risky: false });
  });

  it('only fetches new mail on later syncs and adds replies to the existing thread', async () => {
    h = makeHarness();
    h.fake.add('inbox', msg({ subject: 'Plan', messageId: 'm1@x' }));
    const id = await h.addAccount();
    h.fake.add('inbox', msg({ subject: 'Re: Plan', messageId: 'm2@x', inReplyTo: 'm1@x', references: ['m1@x'], date: '2026-06-02T10:00:00.000Z' }));
    await h.svc.startSync(id);
    const t = h.svc.listThreads({});
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ messageCount: 2, subject: 'Plan' });
    await h.svc.startSync(id); // nothing new
    expect(h.svc.listThreads({})[0]!.messageCount).toBe(2);
  });

  it('applies server-side read changes and removes mail deleted on the server (and empty threads)', async () => {
    h = makeHarness();
    const u1 = h.fake.add('inbox', msg({ subject: 'One', messageId: 'a@x' }));
    h.fake.add('inbox', msg({ subject: 'Two', messageId: 'b@x', date: '2026-06-02T10:00:00.000Z' }));
    const id = await h.addAccount();
    expect(h.svc.listThreads({ filter: 'unread' })).toHaveLength(2);
    h.fake.setFlag('inbox', u1, true);
    h.fake.remove('inbox', 2);
    await h.svc.startSync(id);
    expect(h.svc.listThreads({})).toHaveLength(1);
    expect(h.svc.listThreads({})[0]).toMatchObject({ subject: 'One', unread: false });
  });

  it('wipes and re-imports a folder when UIDVALIDITY changes', async () => {
    h = makeHarness();
    h.fake.add('inbox', msg({ subject: 'Old', messageId: 'o@x' }));
    const id = await h.addAccount();
    h.fake.resetValidity();
    h.fake.add('inbox', msg({ subject: 'New', messageId: 'n@x' }));
    await h.svc.startSync(id);
    expect(subjects(h.svc.listThreads({}))).toEqual(['New']);
  });

  it('records sync failures honestly and recovers; settings status follows', async () => {
    h = makeHarness();
    const id = await h.addAccount();
    expect(h.svc.integrationStatus()).toMatchObject({ state: 'connected' });
    h.fake.failWith = new Error('The incoming (IMAP) server at x:993 did not answer in time.');
    await h.svc.startSync(id);
    expect(h.svc.account(id)).toMatchObject({ syncState: 'error', lastError: expect.stringContaining('did not answer') });
    expect(h.svc.integrationStatus()).toMatchObject({ state: 'error', detail: expect.stringContaining('did not answer') });
    h.fake.failWith = null;
    await h.svc.startSync(id);
    expect(h.svc.account(id)).toMatchObject({ syncState: 'ok', lastError: null });
  });

  it('joins concurrent sync requests into one run', async () => {
    h = makeHarness();
    const id = await h.addAccount();
    const before = h.fake.syncCalls;
    await Promise.all([h.svc.startSync(id), h.svc.startSync(id), h.svc.startSync(id)]);
    expect(h.fake.syncCalls - before).toBe(2); // one run = inbox + sent
  });
});

describe('threading', () => {
  it('uses the server thread id (X-GM-THRID) even when subjects differ', async () => {
    h = makeHarness();
    h.fake.add('inbox', msg({ subject: 'Original topic', messageId: 'a@x', serverThreadId: 'T9' }));
    h.fake.add('inbox', msg({ subject: 'Completely different words', messageId: 'b@x', serverThreadId: 'T9', date: '2026-06-02T10:00:00.000Z' }));
    h.fake.add('inbox', msg({ subject: 'Unrelated', messageId: 'c@x', serverThreadId: 'T10', date: '2026-06-02T11:00:00.000Z' }));
    await h.addAccount();
    expect(h.svc.listThreads({}).map((t) => [t.subject, t.messageCount])).toEqual([['Unrelated', 1], ['Original topic', 2]]);
  });

  it('threads by References even if the parent is synced after the reply, and merges threads a message links', async () => {
    h = makeHarness();
    const id = await h.addAccount();
    const acc = { id, address: 'me@example.com' };
    const ins = (m: ReturnType<typeof msg>, uid: number) => upsertRemote(h.db, acc, { ...m, folder: 'inbox', uid })!;
    // reply first (child before parent), then an unrelated-looking message, then the parent
    const t1 = ins(msg({ subject: 'Re: A', messageId: 'a2@x', inReplyTo: 'a1@x', references: ['a1@x'], date: '2026-06-02T10:00:00.000Z' }), 1);
    const t2 = ins(msg({ subject: 'B', messageId: 'b1@x', date: '2026-06-01T11:00:00.000Z' }), 2);
    const t3 = ins(msg({ subject: 'A', messageId: 'a1@x', date: '2026-06-01T10:00:00.000Z' }), 3);
    expect(t3).toBe(t1);
    expect(t2).not.toBe(t1);
    // a message that references both threads merges them
    const t4 = ins(msg({ subject: 'Re: B', messageId: 'x1@x', inReplyTo: 'a2@x', references: ['a1@x', 'a2@x', 'b1@x'], date: '2026-06-03T10:00:00.000Z' }), 4);
    for (const t of [t1, t2, t4]) recomputeThread(h.db, t);
    const list = h.svc.listThreads({});
    expect(list).toHaveLength(1);
    expect(list[0]!.messageCount).toBe(4);
  });

  it('falls back to the subject only for replies (Re:/Fwd:) within 30 days — never for plain repeated subjects', async () => {
    h = makeHarness();
    h.fake.add('inbox', msg({ subject: 'Hello', messageId: 'a@x', date: '2026-06-01T10:00:00.000Z' }));
    h.fake.add('inbox', msg({ subject: 'Hello', messageId: 'b@x', date: '2026-06-02T10:00:00.000Z', fromAddr: 'other@example.com' })); // plain duplicate subject: separate
    h.fake.add('inbox', msg({ subject: 'Re: Hello', messageId: 'c@x', date: '2026-06-03T10:00:00.000Z' })); // no references: joins newest "Hello"
    h.fake.add('inbox', msg({ subject: 'Re: Old topic', messageId: 'd@x', date: '2026-06-04T10:00:00.000Z' }));
    h.fake.add('inbox', msg({ subject: 'Old topic', messageId: 'e@x', date: '2026-03-01T10:00:00.000Z' })); // too old to join
    await h.addAccount();
    const list = h.svc.listThreads({});
    expect(list.map((t) => [t.subject, t.messageCount]).sort()).toEqual([['Hello', 1], ['Hello', 2], ['Old topic', 1], ['Re: Old topic', 1]].sort());
  });

  it('shows a mail you sent to yourself once (same Message-ID in Inbox and Sent)', async () => {
    h = makeHarness();
    h.fake.add('inbox', msg({ subject: 'Note to self', messageId: 'self@x', fromAddr: 'me@example.com' }));
    h.fake.add('sent', msg({ subject: 'Note to self', messageId: 'self@x', fromAddr: 'me@example.com', seen: true }));
    await h.addAccount();
    const t = h.svc.listThreads({ mailbox: 'all' });
    expect(t).toHaveLength(1);
    expect(h.svc.getThread(t[0]!.id).messages).toHaveLength(1);
  });
});

describe('read state', () => {
  it('opening a thread marks it read locally AND on the server; unread flips the latest incoming message back', async () => {
    h = makeHarness();
    h.fake.add('inbox', msg({ subject: 'One', messageId: 'a@x' }));
    h.fake.add('inbox', msg({ subject: 'Re: One', messageId: 'b@x', inReplyTo: 'a@x', date: '2026-06-02T10:00:00.000Z' }));
    const id = await h.addAccount();
    const tid = h.svc.listThreads({})[0]!.id;
    await h.svc.markRead(tid, true);
    expect(h.svc.getThread(tid)).toMatchObject({ unread: false, serverSyncError: null });
    expect(h.fake.seenLog).toEqual([{ role: 'inbox', uids: [1, 2], seen: true }]);
    expect(h.fake.folders.inbox.get(2)!.seen).toBe(true);
    await h.svc.markRead(tid, false);
    expect(h.svc.getThread(tid).unread).toBe(true);
    expect(h.fake.folders.inbox.get(2)!.seen).toBe(false);
    expect(h.fake.folders.inbox.get(1)!.seen).toBe(true);
    await h.svc.startSync(id);
    expect(h.svc.getThread(tid).unread).toBe(true); // sync keeps agreeing with the server
  });

  it('keeps a failed push pending, shows it, protects it from being overwritten by sync, and retries on the next sync', async () => {
    h = makeHarness();
    h.fake.add('inbox', msg({ subject: 'One', messageId: 'a@x' }));
    const id = await h.addAccount();
    const tid = h.svc.listThreads({})[0]!.id;
    h.fake.failSetSeen = new Error('server unavailable');
    await h.svc.markRead(tid, true);
    const t = h.svc.getThread(tid);
    expect(t.unread).toBe(false);
    expect(t.serverSyncError).toMatch(/not reached the mail server/);
    h.fake.failSetSeen = null;
    await h.svc.startSync(id); // server still says unread -> must NOT flip the local state back before the retry
    expect(h.svc.getThread(tid)).toMatchObject({ unread: false, serverSyncError: null });
    expect(h.fake.folders.inbox.get(1)!.seen).toBe(true);
  });
});

describe('server search import', () => {
  it('imports older matching mail outside the sync window into the cache so local search finds it', async () => {
    h = makeHarness();
    for (let i = 0; i < 5; i++) h.fake.add('inbox', msg({ subject: `Mail ${i}`, messageId: `m${i}@x`, body: i === 0 ? 'the quarterly report' : 'nothing' }));
    // simulate a small window: pretend only the newest messages were synced
    const id = await h.addAccount();
    h.db.prepare("DELETE FROM email_messages WHERE account_id = ? AND uid = 1").run(id);
    recomputeAll(h);
    expect(h.svc.listThreads({ q: 'quarterly' })).toHaveLength(0);
    const r = await h.svc.importServerSearch('quarterly');
    expect(r.imported).toBe(1);
    expect(subjects(h.svc.listThreads({ q: 'quarterly' }))).toEqual(['Mail 0']);
    expect((await h.svc.importServerSearch('quarterly')).imported).toBe(0); // idempotent
  });
});

function recomputeAll(hh: Harness) {
  for (const t of hh.db.prepare('SELECT id FROM email_threads').all() as { id: string }[]) recomputeThread(hh.db, t.id);
}

describe('sending through a real-account provider', () => {
  async function draftIn(thread: string | null, id: string, over: Record<string, unknown> = {}) {
    const d = h.svc.createDraft({ accountId: id, threadId: thread, to: ['alice@example.com'], subject: 'Plan', body: 'Sounds good', ...over });
    return d;
  }

  it('adds Re: and correct reply headers, only after approve; stores the sent mail in the thread; the Sent copy is adopted (no duplicate)', async () => {
    h = makeHarness();
    h.fake.add('inbox', msg({ subject: 'Plan', messageId: 'p1@x', references: ['root@x'] }));
    const id = await h.addAccount();
    const tid = h.svc.listThreads({})[0]!.id;
    const d = await draftIn(tid, id);
    expect(d.subject).toBe('Re: Plan');
    await expect(h.svc.sendDraft(d.id)).rejects.toMatchObject({ code: 'not_approved' });
    h.svc.approveDraft(d.id);
    const sent = await h.svc.sendDraft(d.id);
    expect(sent).toMatchObject({ status: 'sent', sendResult: { delivered: true, note: 'fake accepted' } });
    const mail = h.fake.sentMails[0]!;
    expect(mail).toMatchObject({ from: 'me@example.com', subject: 'Re: Plan', inReplyTo: '<p1@x>', references: ['<root@x>', '<p1@x>'] });
    expect(mail.messageId).toMatch(/^<[0-9a-f-]+@example\.com>$/);
    let t = h.svc.getThread(tid);
    expect(t.messages.map((m) => m.direction)).toEqual(['in', 'out']);
    await h.svc.startSync(id); // the Sent copy arrives
    t = h.svc.getThread(tid);
    expect(t.messages).toHaveLength(2);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM email_messages WHERE uid IS NULL AND account_id = ?').get(id)).toEqual({ n: 0 });
  });

  it('adopts the Sent copy even when the provider rewrites the Message-ID', async () => {
    h = makeHarness();
    h.fake.rewriteSentId = 'rewritten-by-provider@mail.example';
    const id = await h.addAccount();
    const d = await draftIn(null, id, { subject: 'Fresh topic' });
    h.svc.approveDraft(d.id);
    await h.svc.sendDraft(d.id);
    expect(h.svc.listThreads({ mailbox: 'sent' })).toHaveLength(1); // new thread created locally
    await h.svc.startSync(id);
    const sent = h.svc.listThreads({ mailbox: 'sent' });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.messageCount).toBe(1);
  });

  it('keeps the draft and shows the real error when sending fails; a retry needs a new approval', async () => {
    h = makeHarness();
    const id = await h.addAccount();
    const d = await draftIn(null, id, { subject: 'Hi' });
    h.svc.approveDraft(d.id);
    h.fake.failSend = new Error('The outgoing (SMTP) server at smtp.x:465 rejected the username or password.');
    await expect(h.svc.sendDraft(d.id)).rejects.toMatchObject({ status: 502, code: 'send_failed', message: expect.stringContaining('rejected the username or password') });
    const after = h.svc.getDraft(d.id);
    expect(after).toMatchObject({ status: 'failed', body: 'Sounds good', sendResult: { delivered: false } });
    h.fake.failSend = null;
    await expect(h.svc.sendDraft(d.id)).rejects.toMatchObject({ code: 'not_approved' });
    h.svc.approveDraft(d.id);
    expect((await h.svc.sendDraft(d.id)).status).toBe('sent');
  });

  it('sends exactly once when "send" is triggered twice at the same time', async () => {
    h = makeHarness();
    const id = await h.addAccount();
    const d = await draftIn(null, id, { subject: 'Once' });
    h.svc.approveDraft(d.id);
    const results = await Promise.allSettled([h.svc.sendDraft(d.id), h.svc.sendDraft(d.id)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(h.fake.sentMails).toHaveLength(1);
  });

  it('refuses to reply into a thread of another account and rejects malformed recipients', async () => {
    h = makeHarness();
    const id = await h.addAccount();
    expect(() => h.svc.createDraft({ accountId: id, to: ['a@b.com,c@d.com'], subject: 's', body: 'b' })).toThrow(/not a valid email/);
    expect(() => h.svc.createDraft({ accountId: id, to: ['Eve <eve@x.com>'], subject: 's', body: 'b' })).toThrow(/not a valid email/);
    expect(() => h.svc.createDraft({ accountId: id, to: ['a@b.com\r\nBcc: x@y.z'], subject: 's', body: 'b' })).toThrow(/not a valid email/);
    expect(h.svc.createDraft({ accountId: id, to: ['a@b.com', 'a@b.com'], subject: 'Hi\r\nBcc: x@y.z', body: 'b' })).toMatchObject({ to: ['a@b.com'], subject: 'Hi Bcc: x@y.z' });
  });
});
