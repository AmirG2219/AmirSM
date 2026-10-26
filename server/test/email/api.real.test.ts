/** HTTP-level tests of the real-mailbox flow: routes -> service -> ImapSmtpProvider -> IN-PROCESS emulators. */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ImapFlow } from 'imapflow';
import { makeTestApp, type TestApp } from '../api/helpers.js';
import { IMAP_PASS, IMAP_USER, rfc822, startImap, startSmtp, type ImapEmu, type SmtpEmu } from './emulators.js';

const PDF_B64 = Buffer.from('Hello world').toString('base64');
const closers: (() => Promise<void>)[] = [];
let t: TestApp | undefined;
afterEach(async () => {
  await t?.ctx.email.idle();
  await t?.close();
  t = undefined;
  while (closers.length) await closers.pop()!();
});
afterAll(async () => { while (closers.length) await closers.pop()!(); });

async function setup(opts: { inbox?: Parameters<typeof startImap>[0]; smtp?: Parameters<typeof startSmtp>[0]; env?: Record<string, string> } = {}) {
  const imap = await startImap(opts.inbox ?? {});
  const smtp = await startSmtp(opts.smtp ?? {});
  closers.push(imap.close, smtp.close);
  t = await makeTestApp({ env: { EMAIL_AUTO_SYNC_SECONDS: '0', ...opts.env } });
  return { imap, smtp, t };
}
const connectBody = (imap: ImapEmu, smtp: SmtpEmu, over: Record<string, unknown> = {}) => ({
  presetId: 'custom', address: 'me@example.com', username: IMAP_USER, password: IMAP_PASS,
  imap: { host: '127.0.0.1', port: imap.port, security: 'none' }, smtp: { host: '127.0.0.1', port: smtp.port, security: 'none' }, ...over,
});
async function connect(imap: ImapEmu, smtp: SmtpEmu, over: Record<string, unknown> = {}) {
  const r = await t!.api('POST', '/api/email/accounts', connectBody(imap, smtp, over));
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  await t!.ctx.email.idle();
  return r.json as { id: string };
}

const INBOX = [
  { raw: rfc822({ id: 'p1@x', subject: 'Project plan', body: 'Please review the plan.', date: 'Mon, 01 Jun 2026 10:00:00 +0000' }), flags: [] },
  { raw: rfc822({ id: 'inv@x', subject: 'Invoice 7', attachment: { name: '../../evil.html', mime: 'text/html', b64: PDF_B64 }, date: 'Tue, 02 Jun 2026 10:00:00 +0000' }), flags: [] },
  { raw: rfc822({ id: 'news@x', subject: 'Newsletter', html: '<h1>Big news</h1><p>Read <a href="https://example.com/n">more</a></p><script>x()</script>', date: 'Wed, 03 Jun 2026 10:00:00 +0000' }), flags: ['\\Seen'] },
];

describe('provider list + connection test', () => {
  it('lists presets honestly: Outlook is unsupported with a reason; steps are plain language', async () => {
    const { t } = await setup();
    const list = (await t.api('GET', '/api/email/providers')).json as { id: string; supported: boolean; unsupportedReason: string | null; steps: string[]; imap: unknown }[];
    expect(list.map((p) => p.id)).toEqual(expect.arrayContaining(['gmail', 'icloud', 'yahoo', 'fastmail', 'protonbridge', 'outlook', 'custom']));
    const outlook = list.find((p) => p.id === 'outlook')!;
    expect(outlook.supported).toBe(false);
    expect(outlook.unsupportedReason).toMatch(/OAuth/);
    expect(list.find((p) => p.id === 'gmail')).toMatchObject({ supported: true, steps: expect.arrayContaining([expect.stringMatching(/app password/i)]) });
  });

  it('tests IMAP and SMTP separately without saving anything', async () => {
    const { t, imap, smtp } = await setup({ inbox: { inbox: INBOX } });
    const ok = await t.api('POST', '/api/email/accounts/test', connectBody(imap, smtp));
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ ok: true, imap: { ok: true }, smtp: { ok: true }, sentFolder: 'Sent Items' });
    const bad = await t.api('POST', '/api/email/accounts/test', connectBody(imap, smtp, { password: 'nope-nope' }));
    expect(bad.status).toBe(200);
    expect(bad.json).toMatchObject({ ok: false, imap: { ok: false, code: 'auth_failed' }, smtp: { ok: false, code: 'auth_failed' } });
    expect(JSON.stringify(bad.json)).not.toContain('nope-nope');
    expect((await t.api('GET', '/api/email/accounts')).json.map((a: { isFixture: boolean }) => a.isFixture)).toEqual([true]); // nothing saved
  });

  it('validates input strictly and never echoes the password', async () => {
    const { t, imap, smtp } = await setup();
    const secret = 'my-very-secret-pw';
    const cases: [Record<string, unknown>, number, string | RegExp][] = [
      [{ imap: { host: 'http://evil.example/x', port: 993, security: 'tls' } }, 400, 'validation_failed'],
      [{ imap: { host: 'a b', port: 993, security: 'tls' } }, 400, 'validation_failed'],
      [{ imap: { host: '127.0.0.1', port: 70000, security: 'none' } }, 400, 'validation_failed'],
      [{ imap: { host: '127.0.0.1', port: imap.port, security: 'ssl' } }, 400, 'validation_failed'],
      [{ address: 'not-an-address' }, 400, 'bad_request'],
      [{ password: '' }, 400, 'validation_failed'],
      [{ password: secret + '\r\nX: y' }, 400, 'validation_failed'],
      [{ unexpected: 1 }, 400, 'validation_failed'],
      [{ presetId: 'nope' }, 400, 'unknown_provider'],
      [{ presetId: 'outlook' }, 400, 'provider_not_supported'],
      [{ imap: { host: 'mail.example.com', port: 143, security: 'none' } }, 400, 'insecure_connection'],
      [{ allowSelfSigned: true, imap: { host: 'mail.example.com', port: 993, security: 'tls' } }, 400, 'insecure_connection'],
      [{ imap: undefined }, 400, 'bad_request'],
    ];
    for (const [over, status, code] of cases) {
      const r = await t.api('POST', '/api/email/accounts/test', connectBody(imap, smtp, { password: secret, ...over }));
      expect(r.status, JSON.stringify(over)).toBe(status);
      expect(r.json.error.code, JSON.stringify(over)).toBe(code);
      expect(JSON.stringify(r.json)).not.toContain(secret);
    }
  });

  it('rate-limits connection tests so the endpoint cannot be used as a scanner', async () => {
    const { t, imap, smtp } = await setup({ env: { EMAIL_CONNECT_TESTS_PER_MINUTE: '3' } });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await t.api('POST', '/api/email/accounts/test', connectBody(imap, smtp))).status);
    expect(codes).toEqual([200, 200, 200, 429, 429]);
    const r = await t.api('POST', '/api/email/accounts/test', connectBody(imap, smtp));
    expect(r.json.error).toMatchObject({ code: 'rate_limited', message: expect.stringMatching(/Try again in \d+s/) });
  });

  it('requires the owner session', async () => {
    const { t, imap, smtp } = await setup();
    const cookie = t.cookie; t.cookie = '';
    expect((await t.api('POST', '/api/email/accounts/test', connectBody(imap, smtp))).status).toBe(401);
    expect((await t.api('GET', '/api/email/attachments/att_x')).status).toBe(401);
    t.cookie = cookie;
  });
});

describe('connect, read, search, attachments', () => {
  it('connect: failed login is a 422 and saves nothing; success saves, hides the sample mailbox and syncs', async () => {
    const { t, imap, smtp } = await setup({ inbox: { inbox: INBOX } });
    const fail = await t.api('POST', '/api/email/accounts', connectBody(imap, smtp, { password: 'wrong-pw' }));
    expect(fail.status).toBe(422);
    expect(fail.json.error).toMatchObject({ code: 'connection_failed', details: { ok: false, imap: { code: 'auth_failed' } } });
    expect(JSON.stringify(fail.json)).not.toContain('wrong-pw');
    expect(t.ctx.db.prepare('SELECT COUNT(*) AS n FROM email_accounts WHERE is_fixture = 0').get()).toEqual({ n: 0 });

    // the sample mailbox is what we see before connecting
    expect((await t.api('GET', '/api/settings/status')).json.integrations.find((i: { id: string }) => i.id === 'email')).toMatchObject({ state: 'fixture' });
    expect((await t.api('GET', '/api/email/accounts')).json[0]).toMatchObject({ isFixture: true, label: 'Sample mailbox — fictional messages' });

    const acc = await connect(imap, smtp);
    const accounts = (await t.api('GET', '/api/email/accounts')).json;
    expect(accounts).toHaveLength(1); // sample mailbox hidden
    expect(accounts[0]).toMatchObject({ id: acc.id, isFixture: false, provider: 'imap', presetId: 'custom', address: 'me@example.com', syncState: 'ok', lastError: null, imapHost: '127.0.0.1', canRead: true, canSend: true });
    expect(accounts[0].lastSyncAt).toBeTruthy();
    const threads = (await t.api('GET', '/api/email/threads')).json;
    expect(threads.map((x: { subject: string }) => x.subject)).toEqual(['Newsletter', 'Invoice 7', 'Project plan']);
    expect(JSON.stringify(threads)).not.toMatch(/Collab idea|Photo shoot/); // no fictional messages beside a real mailbox
    expect((await t.api('GET', '/api/email/drafts')).json).toEqual([]);
    expect((await t.api('GET', '/api/settings/status')).json.integrations.find((i: { id: string }) => i.id === 'email')).toMatchObject({ state: 'connected', detail: expect.stringContaining('me@example.com') });

    // the same mailbox cannot be connected twice
    const dup = await t.api('POST', '/api/email/accounts', connectBody(imap, smtp));
    expect(dup.status).toBe(409);
    expect(dup.json.error.code).toBe('already_connected');
  });

  it('shows plain text for HTML mail (converted, no markup/script), unread state, and marks read on the server when opened', async () => {
    const { t, imap, smtp } = await setup({ inbox: { inbox: INBOX } });
    await connect(imap, smtp);
    const list = (await t.api('GET', '/api/email/threads')).json;
    const news = list.find((x: { subject: string }) => x.subject === 'Newsletter');
    const plan = list.find((x: { subject: string }) => x.subject === 'Project plan');
    expect(news.unread).toBe(false);
    expect(plan.unread).toBe(true);
    const newsBody = (await t.api('GET', `/api/email/threads/${news.id}`)).json.messages[0];
    expect(newsBody).toMatchObject({ bodySource: 'html_converted', direction: 'in' });
    expect(newsBody.body).toBe('Big news\n\nRead more (https://example.com/n)');
    expect(newsBody.body).not.toMatch(/<|script|x\(\)/);

    const opened = await t.api('POST', `/api/email/threads/${plan.id}/read`, { read: true });
    expect(opened.status).toBe(200);
    expect(opened.json).toMatchObject({ unread: false, serverSyncError: null });
    // verify on the (emulated) server with a separate IMAP session
    const c = new ImapFlow({ host: '127.0.0.1', port: imap.port, secure: false, doSTARTTLS: false, auth: { user: IMAP_USER, pass: IMAP_PASS }, logger: false });
    c.on('error', () => {});
    await c.connect();
    const lock = await c.getMailboxLock('INBOX', { readOnly: true });
    const flags: Record<number, string[]> = {};
    for await (const m of c.fetch('1:*', { uid: true, flags: true }, { uid: true })) flags[m.uid] = [...(m.flags ?? [])];
    lock.release(); await c.logout();
    expect(JSON.stringify(flags[1])).toMatch(/Seen/);
    expect((await t.api('GET', '/api/email/threads?filter=unread')).json.map((x: { subject: string }) => x.subject)).toEqual(['Invoice 7']);
  });

  it('searches the cache and, on request, the server for older mail', async () => {
    const { t, imap, smtp } = await setup({ inbox: { inbox: INBOX } });
    const acc = await connect(imap, smtp);
    expect((await t.api('GET', '/api/email/threads?q=review%20plan')).json.map((x: { subject: string }) => x.subject)).toEqual(['Project plan']);
    expect((await t.api('GET', '/api/email/threads?q=%25')).json).toEqual([]); // LIKE wildcards are escaped
    // forget the oldest message locally, then find it again through the server search
    t.ctx.db.prepare("DELETE FROM email_messages WHERE account_id = ? AND uid = 1").run(acc.id);
    t.ctx.db.prepare('DELETE FROM email_threads WHERE subject = ?').run('Project plan');
    expect((await t.api('GET', '/api/email/threads?q=review')).json).toEqual([]);
    expect((await t.api('GET', '/api/email/threads?q=review&serverSearch=true')).json.map((x: { subject: string }) => x.subject)).toEqual(['Project plan']);
    expect((await t.api('GET', '/api/email/threads?serverSearch=true')).status).toBe(400);
  });

  it('serves attachments as downloads only: sanitised name, nosniff, inert content type, size cap, auth required', async () => {
    const { t, imap, smtp } = await setup({ inbox: { inbox: INBOX } });
    await connect(imap, smtp);
    const inv = (await t.api('GET', '/api/email/threads')).json.find((x: { subject: string }) => x.subject === 'Invoice 7');
    const att = (await t.api('GET', `/api/email/threads/${inv.id}`)).json.messages[0].attachments[0];
    expect(att).toMatchObject({ filename: 'evil.html', risky: true, mime: 'text/html', inline: false });
    const r = await t.api('GET', att.downloadUrl);
    expect(r.status).toBe(200);
    expect(r.raw.toString()).toBe('Hello world');
    expect(r.headers['content-disposition']).toMatch(/^attachment; filename="evil\.html"/);
    expect(r.headers['content-type']).toBe('application/octet-stream'); // text/html is never served as html
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['content-security-policy']).toContain('sandbox');
    expect(r.headers['cache-control']).toContain('no-store');
    expect((await t.api('GET', '/api/email/attachments/att_doesnotexist')).status).toBe(404);
    t.ctx.db.prepare('UPDATE email_attachments SET size = ?').run(26 * 1024 * 1024);
    const big = await t.api('GET', att.downloadUrl);
    expect(big.status).toBe(413);
    expect(big.json.error.code).toBe('attachment_too_large');
  });
});

describe('credentials', () => {
  it('are encrypted at rest with a key file, and never appear in any API response or in the database file', async () => {
    const { t, imap, smtp } = await setup({ inbox: { inbox: INBOX } });
    const pw = IMAP_PASS;
    const acc = await connect(imap, smtp);
    const row = t.ctx.db.prepare('SELECT credentials_enc, settings_json FROM email_accounts WHERE id = ?').get(acc.id) as { credentials_enc: string; settings_json: string };
    expect(row.credentials_enc.startsWith('v1.')).toBe(true);
    expect(row.credentials_enc).not.toContain(pw);
    expect(row.settings_json).not.toContain(pw);
    const keyFile = path.join(t.dir, 'secret.key');
    expect(fs.existsSync(keyFile)).toBe(true);
    expect(fs.readFileSync(keyFile, 'utf8')).not.toContain(pw);
    const thread = (await t.api('GET', '/api/email/threads')).json[0];
    const responses = await Promise.all([
      t.api('GET', '/api/email/accounts'), t.api('GET', '/api/email/providers'), t.api('GET', '/api/email/threads'), t.api('GET', `/api/email/threads/${thread.id}`),
      t.api('GET', '/api/settings/status'), t.api('POST', `/api/email/accounts/${acc.id}/sync`, { wait: true }), t.api('GET', '/api/email/drafts'),
      t.api('POST', '/api/email/accounts/test', connectBody(imap, smtp, { password: 'other-secret-pw' })),
    ]);
    for (const r of responses) {
      const s = JSON.stringify(r.json);
      expect(s).not.toContain(row.credentials_enc);
      expect(s).not.toContain('other-secret-pw');
      expect(s).not.toMatch(/credentials_enc|"password"|settings_json|secret\.key/i);
      expect(s).not.toContain(`"${pw}"`);
    }
    // the database files on disk do not contain the password either
    t.ctx.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    for (const f of fs.readdirSync(t.dir).filter((n) => n.startsWith('amir-sm.db'))) expect(fs.readFileSync(path.join(t.dir, f)).includes(Buffer.from(pw))).toBe(false);
  });

  it('a lost/replaced key file turns into a clear sync error, not a crash, and does not leak anything', async () => {
    const { t, imap, smtp } = await setup({ inbox: { inbox: INBOX } });
    const acc = await connect(imap, smtp);
    fs.writeFileSync(path.join(t.dir, 'secret.key'), Buffer.alloc(32, 1).toString('base64url') + '\n');
    (t.ctx.email as unknown as { boxCache: null }).boxCache = null; // as after a restart
    const r = await t.api('POST', `/api/email/accounts/${acc.id}/sync`, { wait: true });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ syncState: 'error', lastError: expect.stringMatching(/cannot be decrypted/) });
    expect((await t.api('GET', '/api/settings/status')).json.integrations.find((i: { id: string }) => i.id === 'email').state).toBe('error');
  });
});

describe('sending (approve -> send gate) through a real provider', () => {
  it('is enforced for real accounts, uses the approved text only, threads the reply, saves a Sent copy and never claims more than SMTP acceptance', async () => {
    const { t, imap, smtp } = await setup({ inbox: { inbox: INBOX } });
    const acc = await connect(imap, smtp);
    const thread = (await t.api('GET', '/api/email/threads')).json.find((x: { subject: string }) => x.subject === 'Project plan');
    const d = (await t.api('POST', '/api/email/drafts', { accountId: acc.id, threadId: thread.id, to: ['alice@example.com'], subject: 'Project plan', body: 'Looks good.' })).json;
    expect(d.subject).toBe('Re: Project plan');
    expect((await t.api('POST', `/api/email/drafts/${d.id}/send`)).json.error.code).toBe('not_approved');
    expect(smtp.received).toHaveLength(0);
    await t.api('POST', `/api/email/drafts/${d.id}/approve`);
    t.ctx.db.prepare('UPDATE email_drafts SET body = ? WHERE id = ?').run('tampered body', d.id);
    expect((await t.api('POST', `/api/email/drafts/${d.id}/send`)).json.error.code).toBe('changed_since_approval');
    expect(smtp.received).toHaveLength(0);
    await t.api('PATCH', `/api/email/drafts/${d.id}`, { body: 'Looks good.' });
    await t.api('POST', `/api/email/drafts/${d.id}/approve`);

    const sent = await t.api('POST', `/api/email/drafts/${d.id}/send`);
    expect(sent.status, JSON.stringify(sent.json)).toBe(200);
    expect(sent.json).toMatchObject({ status: 'sent', sendResult: { delivered: true } });
    expect(sent.json.sendResult.note).toMatch(/does not guarantee/);
    expect(smtp.received).toHaveLength(1);
    const mail = smtp.received[0]!;
    expect(mail.mail.subject).toBe('Re: Project plan');
    expect(mail.mail.inReplyTo).toBe('<p1@x>');
    expect(mail.mail.text).toContain('Looks good.');
    expect((await t.api('POST', `/api/email/drafts/${d.id}/send`)).status).toBe(409);

    const detail = (await t.api('GET', `/api/email/threads/${thread.id}`)).json;
    expect(detail.messages.map((m: { direction: string }) => m.direction)).toEqual(['in', 'out']);
    await t.ctx.email.startSync(acc.id); // picks up the Sent copy appended over IMAP, without duplicating
    expect((await t.api('GET', `/api/email/threads/${thread.id}`)).json.messages).toHaveLength(2);
    expect((await t.api('GET', '/api/email/threads?mailbox=sent')).json.map((x: { subject: string }) => x.subject)).toEqual(['Project plan']);
  });

  it('keeps the draft and returns the real error when SMTP refuses', async () => {
    const { t, imap, smtp } = await setup({ smtp: { rejectRcpt: 'nobody@example.com' } });
    const acc = await connect(imap, smtp);
    const d = (await t.api('POST', '/api/email/drafts', { accountId: acc.id, to: ['nobody@example.com'], subject: 'Hi', body: 'x' })).json;
    await t.api('POST', `/api/email/drafts/${d.id}/approve`);
    const r = await t.api('POST', `/api/email/drafts/${d.id}/send`);
    expect(r.status).toBe(502);
    expect(r.json.error.code).toBe('send_failed');
    expect(r.json.error.message).toMatch(/550 Mailbox unavailable/);
    expect((await t.api('GET', `/api/email/drafts/${d.id}`)).json).toMatchObject({ status: 'failed', body: 'x' });
  });

  it('sample-mailbox sends remain "recorded locally — NOT delivered" and are hidden once a real account exists', async () => {
    const { t, imap, smtp } = await setup();
    const sample = (await t.api('GET', '/api/email/accounts')).json[0];
    const d = (await t.api('POST', '/api/email/drafts', { accountId: sample.id, to: ['sam@friend.example.com'], subject: 'Hi', body: 'x' })).json;
    await t.api('POST', `/api/email/drafts/${d.id}/approve`);
    const sent = await t.api('POST', `/api/email/drafts/${d.id}/send`);
    expect(sent.json.sendResult).toMatchObject({ delivered: false, note: expect.stringMatching(/NOT delivered/) });
    expect(smtp.received).toHaveLength(0);
    await connect(imap, smtp);
    expect((await t.api('GET', '/api/email/drafts')).json).toEqual([]);
    expect((await t.api('GET', `/api/email/drafts/${d.id}`)).status).toBe(200); // still readable by id, but not listed
    expect((await t.api('POST', '/api/email/drafts', { accountId: sample.id, to: ['a@b.com'], subject: 's', body: 'b' })).status).toBe(404);
  });
});

describe('disconnect', () => {
  it('removes credentials and the local cache, leaves the server mailbox alone, and brings the sample mailbox back', async () => {
    const { t, imap, smtp } = await setup({ inbox: { inbox: INBOX } });
    const acc = await connect(imap, smtp);
    const thread = (await t.api('GET', '/api/email/threads')).json[0];
    await t.api('POST', '/api/email/drafts', { accountId: acc.id, to: ['a@b.com'], subject: 's', body: 'b' });
    const r = await t.api('DELETE', `/api/email/accounts/${acc.id}`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, removed: { threads: 3, messages: 3, drafts: 1 } });
    const db = t.ctx.db;
    for (const q of [
      ['SELECT COUNT(*) AS n FROM email_accounts WHERE is_fixture = 0', 0], ['SELECT COUNT(*) AS n FROM email_attachments', 0], ['SELECT COUNT(*) AS n FROM email_message_refs', 0],
      ['SELECT COUNT(*) AS n FROM email_messages WHERE account_id = ?', 0], ['SELECT COUNT(*) AS n FROM email_threads WHERE account_id = ?', 0], ['SELECT COUNT(*) AS n FROM email_drafts WHERE account_id = ?', 0],
    ] as const) {
      const row = (q[0].includes('?') ? db.prepare(q[0]).get(acc.id) : db.prepare(q[0]).get()) as { n: number };
      expect(row.n, q[0]).toBe(q[1]);
    }
    expect((await t.api('GET', `/api/email/threads/${thread.id}`)).status).toBe(404);
    expect((await t.api('GET', '/api/email/accounts')).json[0]).toMatchObject({ isFixture: true });
    expect((await t.api('DELETE', `/api/email/accounts/${acc.id}`)).status).toBe(404);
    expect((await t.api('DELETE', `/api/email/accounts/${(await t.api('GET', '/api/email/accounts')).json[0].id}`)).json.error.code).toBe('fixture_account');
    // the mailbox on the server still has its mail
    const c = new ImapFlow({ host: '127.0.0.1', port: imap.port, secure: false, doSTARTTLS: false, auth: { user: IMAP_USER, pass: IMAP_PASS }, logger: false });
    c.on('error', () => {});
    await c.connect();
    const st = await c.status('INBOX', { messages: true });
    await c.logout();
    expect(st && st.messages).toBe(3);
    // reconnect works again
    await connect(imap, smtp);
    expect((await t.api('GET', '/api/email/threads')).json).toHaveLength(3);
  });
});
