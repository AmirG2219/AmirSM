/** ImapSmtpProvider against IN-PROCESS EMULATORS (hoodiecrow-imap, smtp-server). Real imapflow/nodemailer, fake servers. */
import { afterEach, describe, expect, it } from 'vitest';
import { ImapFlow } from 'imapflow';
import { ImapSmtpProvider } from '../../src/email/providers/imap-smtp.js';
import type { FolderSyncState, ImapSmtpSettings } from '../../src/email/types.js';
import { IMAP_PASS, rfc822, settingsFor, startImap, startSmtp, type ImapEmu, type SmtpEmu } from './emulators.js';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });
const imapEmu = async (...a: Parameters<typeof startImap>) => { const e = await startImap(...a); closers.push(e.close); return e; };
const smtpEmu = async (...a: Parameters<typeof startSmtp>) => { const e = await startSmtp(...a); closers.push(e.close); return e; };
const mk = (imap: ImapEmu, smtp: SmtpEmu | { port: number }, over: Partial<ImapSmtpSettings> = {}, pass = IMAP_PASS) =>
  new ImapSmtpProvider('me@example.com', settingsFor(imap.port, smtp.port, over), pass, { timeoutMs: 4000 });

const PDF_B64 = Buffer.from('Hello world').toString('base64');
const sync = (p: ImapSmtpProvider, role: 'inbox' | 'sent', state: FolderSyncState | null = null) => p.syncFolder({ role, state, initialLimit: 200, maxNew: 500 });

describe('connection test + error mapping', () => {
  it('reports IMAP and SMTP separately and finds the Sent folder', async () => {
    const imap = await imapEmu(); const smtp = await smtpEmu();
    const r = await mk(imap, smtp).testConnection();
    expect(r).toEqual({ ok: true, imap: { ok: true, code: null, message: null }, smtp: { ok: true, code: null, message: null }, sentFolder: 'Sent Items' });
  });

  it('maps a wrong password to auth_failed on both protocols without leaking the password', async () => {
    const imap = await imapEmu(); const smtp = await smtpEmu();
    const secret = 'super-secret-WRONG-pw';
    const r = await mk(imap, smtp, {}, secret).testConnection();
    expect(r.ok).toBe(false);
    expect(r.imap.code).toBe('auth_failed');
    expect(r.smtp.code).toBe('auth_failed');
    expect(JSON.stringify(r)).not.toContain(secret);
    expect(r.imap.message).toMatch(/username or password/i);
  });

  it('maps a closed port to host_unreachable', async () => {
    const imap = await startImap(); const port = imap.port; await imap.close();
    const r = await new ImapSmtpProvider('me@example.com', settingsFor(port, port), 'x', { timeoutMs: 3000 }).testConnection();
    expect(r.imap.code).toBe('host_unreachable');
    expect(r.smtp.code).toBe('host_unreachable');
    expect(r.imap.message).toContain(`127.0.0.1:${port}`);
  });

  it('refuses an untrusted (self-signed) certificate unless explicitly allowed for localhost', async () => {
    const imap = await imapEmu({ secure: true }); const smtp = await smtpEmu();
    const tls = { imap: { host: '127.0.0.1', port: imap.port, security: 'tls' as const } };
    const strict = await mk(imap, smtp, tls).testConnection();
    expect(strict.imap.ok).toBe(false);
    expect(strict.imap.code).toBe('tls_error');
    const lenient = await mk(imap, smtp, { ...tls, allowSelfSigned: true }).testConnection();
    expect(lenient.imap.ok).toBe(true);
  });

  it('flags an encryption-setting mismatch (TLS against a plain-text port)', async () => {
    const imap = await imapEmu(); const smtp = await smtpEmu();
    const r = await mk(imap, smtp, { imap: { host: '127.0.0.1', port: imap.port, security: 'tls' } }).testConnection();
    expect(r.imap.ok).toBe(false);
    expect(['tls_mismatch', 'timeout', 'host_unreachable']).toContain(r.imap.code);
    expect(r.imap.message).toMatch(/TLS|encryption|answer|reach/i);
  });
});

describe('reading', () => {
  it('syncs INBOX + Sent: parsed headers, plain text, html-converted body, attachments, seen flags', async () => {
    const imap = await imapEmu({
      inbox: [
        { raw: rfc822({ id: 'a1@x', subject: 'Plain mail', body: 'Hi there' }), flags: [] },
        { raw: rfc822({ id: 'a2@x', subject: 'HTML mail', html: '<p>Hello <b>world</b></p><script>alert(1)</script><img src="http://track/x.gif">' }), flags: ['\\Seen'] },
        { raw: rfc822({ id: 'a3@x', subject: 'Invoice', attachment: { name: 'a b.pdf', mime: 'application/pdf', b64: PDF_B64 } }), flags: [] },
      ],
      sent: [{ raw: rfc822({ id: 's1@x', subject: 'Re: Plain mail', from: 'me@example.com', to: 'alice@example.com', inReplyTo: 'a1@x', references: '<a1@x>', body: 'Thanks' }), flags: ['\\Seen'] }],
    });
    const p = mk(imap, { port: 1 });
    const inbox = await sync(p, 'inbox');
    expect(inbox.available).toBe(true);
    expect(inbox.messages.map((m) => m.subject)).toEqual(['Plain mail', 'HTML mail', 'Invoice']);
    const [plain, html, att] = inbox.messages;
    expect(plain).toMatchObject({ messageId: 'a1@x', fromAddr: 'alice@example.com', fromName: 'Alice Example', seen: false, bodySource: 'plain', body: 'Hi there' });
    expect(html).toMatchObject({ seen: true, bodySource: 'html_converted' });
    expect(html!.body).toContain('Hello world');
    expect(html!.body).not.toMatch(/alert|script|track|<img/);
    expect(att!.attachments).toEqual([{ partId: '2', filename: 'a b.pdf', mime: 'application/pdf', size: 12 /* base64 estimate: 16 chars * 3/4 */, inline: false }]);
    expect(inbox.flags).toHaveLength(3);
    expect(inbox.state).toMatchObject({ folderName: 'INBOX', windowStartUid: 1, uidNext: 4 });

    const sent = await sync(p, 'sent');
    expect(sent.state!.folderName).toBe('Sent Items');
    expect(sent.messages[0]).toMatchObject({ folder: 'sent', inReplyTo: 'a1@x', references: ['a1@x'] });
  });

  it('is incremental: only new UIDs, current flags, and a UIDVALIDITY check', async () => {
    const imap = await imapEmu({ inbox: [{ raw: rfc822({ id: 'a1@x', subject: 'One' }), flags: [] }] });
    const p = mk(imap, { port: 1 });
    const first = await sync(p, 'inbox');
    expect(first.messages).toHaveLength(1);
    // another client delivers a message and marks the first one as read
    const c = new ImapFlow({ host: '127.0.0.1', port: imap.port, secure: false, doSTARTTLS: false, auth: { user: 'testuser', pass: IMAP_PASS }, logger: false });
    c.on('error', () => {});
    await c.connect();
    await c.append('INBOX', Buffer.from(rfc822({ id: 'a2@x', subject: 'Two' })), []);
    const lock = await c.getMailboxLock('INBOX'); await c.messageFlagsAdd('1', ['\\Seen'], { uid: true }); lock.release();
    await c.logout();

    const second = await sync(p, 'inbox', first.state);
    expect(second.reset).toBe(false);
    expect(second.messages.map((m) => m.subject)).toEqual(['Two']);
    expect(second.flags).toEqual([{ uid: 1, seen: true }, { uid: 2, seen: false }]);
    expect(second.state!.uidNext).toBe(3);

    const reset = await sync(p, 'inbox', { ...second.state!, uidValidity: '999999' });
    expect(reset.reset).toBe(true);
    expect(reset.messages).toHaveLength(2);
  });

  it('sets and clears \\Seen on the server', async () => {
    const imap = await imapEmu({ inbox: [{ raw: rfc822({ id: 'a1@x', subject: 'One' }), flags: [] }] });
    const p = mk(imap, { port: 1 });
    const s0 = await sync(p, 'inbox');
    await p.setSeen('inbox', 'INBOX', [1], true);
    expect((await sync(p, 'inbox', s0.state)).flags).toEqual([{ uid: 1, seen: true }]);
    await p.setSeen('inbox', 'INBOX', [1], false);
    expect((await sync(p, 'inbox', s0.state)).flags).toEqual([{ uid: 1, seen: false }]);
  });

  it('streams an attachment on demand and enforces the size limit', async () => {
    const imap = await imapEmu({ inbox: [{ raw: rfc822({ id: 'a3@x', subject: 'Invoice', attachment: { name: 'a.pdf', mime: 'application/pdf', b64: PDF_B64 } }) }] });
    const p = mk(imap, { port: 1 });
    const a = await p.openAttachment('inbox', 'INBOX', 1, '2', 1000);
    expect(a.mime).toBe('application/pdf');
    const chunks: Buffer[] = [];
    for await (const c of a.stream as AsyncIterable<Buffer>) chunks.push(c);
    expect(Buffer.concat(chunks).toString()).toBe('Hello world');

    const tooSmall = await p.openAttachment('inbox', 'INBOX', 1, '2', 4);
    await expect((async () => { for await (const _ of tooSmall.stream as AsyncIterable<Buffer>) { /* drain */ } })()).rejects.toThrow(/larger than the download limit/);
    await expect(p.openAttachment('inbox', 'INBOX', 99, '2', 1000)).rejects.toThrow();
  });

  it('releases the server connection when the downloader goes away early (browser cancelled the download)', async () => {
    const imap = await imapEmu({ inbox: [{ raw: rfc822({ id: 'a3@x', subject: 'Invoice', attachment: { name: 'a.pdf', mime: 'application/pdf', b64: Buffer.alloc(200_000, 1).toString('base64') } }) }] });
    const p = mk(imap, { port: 1 });
    const a = await p.openAttachment('inbox', 'INBOX', 1, '2', 10_000_000);
    a.stream.destroy();
    await new Promise((r) => setTimeout(r, 300));
    // the provider is still usable afterwards and nothing crashed
    expect((await sync(p, 'inbox')).messages).toHaveLength(1);
  });

  it('server-side search finds messages; fetchMessages returns them', async () => {
    const imap = await imapEmu({ inbox: [{ raw: rfc822({ id: 'a1@x', subject: 'Budget plan', body: 'quarterly numbers' }) }, { raw: rfc822({ id: 'a2@x', subject: 'Lunch', body: 'sandwich' }) }] });
    const p = mk(imap, { port: 1 });
    expect(await p.searchFolder('inbox', 'INBOX', 'quarterly', 10)).toEqual([1]);
    expect(await p.searchFolder('inbox', 'INBOX', 'Lunch', 10)).toEqual([2]);
    const [m] = await p.fetchMessages('inbox', 'INBOX', [2]);
    expect(m!.subject).toBe('Lunch');
  });

  it('cuts huge bodies at the limit and says so', async () => {
    const imap = await imapEmu({ inbox: [{ raw: rfc822({ id: 'big@x', subject: 'Big', body: 'x'.repeat(700_000) }) }] });
    const [m] = (await sync(mk(imap, { port: 1 }), 'inbox')).messages;
    expect(m!.truncated).toBe(true);
    expect(m!.body.length).toBeLessThanOrEqual(100_000);
  });

  it('uses the server thread id when the server offers one (Gmail X-GM-THRID)', async () => {
    const imap = await imapEmu({ plugins: ['X-GM-EXT-1', 'OBJECTID'], inbox: [{ raw: rfc822({ id: 'a1@x', subject: 'One' }) }] });
    const [m] = (await sync(mk(imap, { port: 1 }), 'inbox')).messages;
    expect(m!.serverThreadId).toBeTruthy();
  });
});

describe('sending', () => {
  it('sends over SMTP with reply headers and appends a copy to Sent when the provider does not auto-save', async () => {
    const imap = await imapEmu(); const smtp = await smtpEmu();
    const p = mk(imap, smtp);
    const out = await p.send({ from: 'me@example.com', to: ['bob@example.com'], cc: ['carol@example.com'], subject: 'Re: Plan', body: 'Sounds good.\nBye', messageId: '<id-1@example.com>', inReplyTo: '<orig@x>', references: ['<root@x>', '<orig@x>'], date: new Date('2026-06-02T10:00:00Z') });
    expect(out).toMatchObject({ delivered: true, savedToSent: true, rejected: [] });
    expect(out.accepted.sort()).toEqual(['bob@example.com', 'carol@example.com']);
    const got = smtp.received[0]!;
    expect(got.envelope.to.sort()).toEqual(['bob@example.com', 'carol@example.com']);
    expect(got.mail.subject).toBe('Re: Plan');
    expect(got.mail.messageId).toBe('<id-1@example.com>');
    expect(got.mail.inReplyTo).toBe('<orig@x>');
    expect(got.mail.references).toEqual(['<root@x>', '<orig@x>']);
    expect(got.mail.text).toContain('Sounds good.');
    const sentCopy = await sync(p, 'sent');
    expect(sentCopy.messages).toHaveLength(1);
    expect(sentCopy.messages[0]).toMatchObject({ messageId: 'id-1@example.com', seen: true });
  });

  it('does not append to Sent when the provider saves sent mail itself', async () => {
    const imap = await imapEmu(); const smtp = await smtpEmu();
    const p = mk(imap, smtp, { autoSavesSent: true });
    const out = await p.send({ from: 'me@example.com', to: ['bob@example.com'], cc: [], subject: 'Hi', body: 'x', messageId: '<id-2@example.com>', date: new Date() });
    expect(out.savedToSent).toBeNull();
    expect((await sync(p, 'sent')).messages).toHaveLength(0);
  });

  it('neutralises header injection in the subject', async () => {
    const imap = await imapEmu(); const smtp = await smtpEmu();
    await mk(imap, smtp, { autoSavesSent: true }).send({ from: 'me@example.com', to: ['bob@example.com'], cc: [], subject: 'Hi\r\nBcc: evil@example.com', body: 'x', messageId: '<id-3@example.com>', date: new Date() });
    const got = smtp.received[0]!;
    expect(got.mail.headers.get('bcc')).toBeUndefined();
    expect(got.envelope.to).toEqual(['bob@example.com']);
  });

  it('reports partial and total recipient rejection honestly', async () => {
    const imap = await imapEmu(); const smtp = await smtpEmu({ rejectRcpt: 'bad@example.com' });
    const p = mk(imap, smtp, { autoSavesSent: true });
    const partial = await p.send({ from: 'me@example.com', to: ['bob@example.com', 'bad@example.com'], cc: [], subject: 'Hi', body: 'x', messageId: '<id-4@example.com>', date: new Date() });
    expect(partial.rejected).toEqual(['bad@example.com']);
    expect(partial.note).toMatch(/Rejected recipients: bad@example.com/);
    await expect(p.send({ from: 'me@example.com', to: ['bad@example.com'], cc: [], subject: 'Hi', body: 'x', messageId: '<id-5@example.com>', date: new Date() })).rejects.toThrow();
  });

  it('a wrong SMTP password fails with a mapped, secret-free error', async () => {
    const imap = await imapEmu(); const smtp = await smtpEmu({ pass: 'different' });
    const p = mk(imap, smtp, { autoSavesSent: true });
    const err = await p.send({ from: 'me@example.com', to: ['bob@example.com'], cc: [], subject: 'Hi', body: 'x', messageId: '<id-6@example.com>', date: new Date() }).catch((e) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/username or password/);
    expect((err as Error).message).not.toContain(IMAP_PASS);
  });
});
