import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SecretBox, SecretBoxError } from '../../src/email/crypto.js';
import { decodeEntities, htmlToText } from '../../src/email/html-to-text.js';
import { mapMailError } from '../../src/email/errors.js';
import { attachmentsFromStructure, normalizeMessageId, parseRawMessage } from '../../src/email/parse.js';
import { SlidingWindowLimiter } from '../../src/email/rate-limit.js';
import { cleanLine, contentDisposition, downloadMime, headerSafe, isRiskyFilename, redact, safeFilename } from '../../src/email/sanitize.js';
import { hasReplyPrefix, normalizeSubject, replyHeaders, replySubject } from '../../src/email/threading.js';

describe('crypto (AES-256-GCM credential box)', () => {
  const key = Buffer.alloc(32, 7);
  it('roundtrips and never stores the plaintext', () => {
    const box = SecretBox.fromKey(key);
    const blob = box.encrypt('{"password":"hunter2-app-pw"}', 'account:acc_1');
    expect(blob).not.toContain('hunter2');
    expect(blob.startsWith('v1.')).toBe(true);
    expect(box.decrypt(blob, 'account:acc_1')).toBe('{"password":"hunter2-app-pw"}');
    expect(box.encrypt('x', 'a')).not.toBe(box.encrypt('x', 'a')); // fresh IV every time
  });
  it('fails on any tampering: ciphertext, tag, iv, wrong account binding, wrong key', () => {
    const box = SecretBox.fromKey(key);
    const [v, iv, tag, ct] = box.encrypt('secret', 'account:acc_1').split('.') as [string, string, string, string];
    const flip = (s: string) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
    for (const bad of [[v, iv, tag, flip(ct)], [v, iv, flip(tag), ct], [v, flip(iv), tag, ct], ['v2', iv, tag, ct], [v, iv, tag]]) {
      expect(() => box.decrypt(bad.join('.'), 'account:acc_1')).toThrow(SecretBoxError);
    }
    expect(() => box.decrypt([v, iv, tag, ct].join('.'), 'account:acc_2')).toThrow(/cannot be decrypted/);
    expect(() => SecretBox.fromKey(Buffer.alloc(32, 9)).decrypt([v, iv, tag, ct].join('.'), 'account:acc_1')).toThrow(/cannot be decrypted/);
  });
  it('creates a key file once, reuses it, and refuses a damaged one instead of replacing it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amir-key-'));
    const file = path.join(dir, 'sub', 'secret.key');
    const a = SecretBox.fromFile(file);
    const blob = a.encrypt('p', 'x');
    expect(SecretBox.fromFile(file).decrypt(blob, 'x')).toBe('p');
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o077).toBe(0);
    fs.writeFileSync(file, 'garbage');
    expect(() => SecretBox.fromFile(file)).toThrow(/damaged/);
    expect(fs.readFileSync(file, 'utf8')).toBe('garbage'); // untouched
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('html-to-text (safe conversion)', () => {
  it('drops script/style/head/iframe/svg content and comments, keeps visible text', () => {
    const t = htmlToText('<html><head><title>T</title><style>p{color:red}</style></head><body><!-- secret comment --><p>Hello</p><script>steal()</script><iframe src="http://evil/"></iframe><svg><text>hidden</text></svg><p>World</p></body></html>');
    expect(t).toBe('Hello\n\nWorld');
  });
  it('handles unterminated and uppercase script/style safely (rest is dropped, not shown)', () => {
    expect(htmlToText('ok<SCRIPT>alert(1)')).toBe('ok');
    expect(htmlToText('ok<STYLE type="text/css">body{}</STYLE>done')).toBe('okdone');
    expect(htmlToText('a<script >x</script >b')).toBe('ab');
  });
  it('never loads or follows anything: images become alt text, links print their target, unsafe schemes are not shown', () => {
    const t = htmlToText('<img src="http://tracker.example/p.gif"><img src="x" alt="Logo"><a href="https://example.com/a?b=1">click here</a> <a href="javascript:alert(1)">bad</a> <a href="data:text/html,x">d</a> <a href="mailto:a@b.com">a@b.com</a>');
    expect(t).toContain('[image]');
    expect(t).toContain('[image: Logo]');
    expect(t).toContain('click here (https://example.com/a?b=1)');
    expect(t).not.toMatch(/javascript:|data:text|tracker\.example/);
    expect(t).toMatch(/bad/);
    expect(t).not.toContain('(mailto:');
  });
  it('shows a link only once when the text already is the URL', () => {
    expect(htmlToText('<a href="https://example.com">https://example.com</a>')).toBe('https://example.com');
  });
  it('structures lists, breaks and entities; decodes once (no double decoding), bounds numeric entities', () => {
    expect(htmlToText('<ul><li>One</li><li>Two &amp; three</li></ul>a<br>b')).toBe('- One\n- Two & three\na\nb');
    expect(decodeEntities('&amp;lt;script&amp;gt;')).toBe('&lt;script&gt;');
    expect(decodeEntities('&#60;b&#x3e; &#0; &#xD800; &#99999999; &unknown;')).toBe('<b> \uFFFD \uFFFD &#99999999; &unknown;');
    expect(htmlToText('&lt;script&gt;alert(1)&lt;/script&gt;')).toBe('<script>alert(1)</script>'); // text, never markup
  });
  it('handles attribute values containing ">" and garbage tags without hanging', () => {
    expect(htmlToText('<a title="a > b" href="https://x.test">go</a> 1 < 2 <3 <div<p>x')).toContain('go (https://x.test)');
    const nasty = '<'.repeat(50_000) + 'a'.repeat(50_000) + '<div ' + 'x="'.repeat(20_000);
    const t0 = Date.now();
    htmlToText(nasty);
    htmlToText('<script>'.repeat(30_000));
    expect(Date.now() - t0).toBeLessThan(2000);
  });
  it('strips bidi/zero-width spoofing characters and control characters', () => {
    expect(htmlToText('<p>safe\u202Eexe.txt\u200B\u0007</p>')).toBe('safeexe.txt');
  });
});

describe('sanitisers', () => {
  it('safeFilename blocks traversal, reserved names, controls and bounds length', () => {
    expect(safeFilename('../../etc/passwd')).toBe('passwd');
    expect(safeFilename('C:\\Windows\\evil.exe')).toBe('evil.exe');
    expect(safeFilename('..')).toBe('attachment');
    expect(safeFilename('a"b;c\r\nd.pdf')).toBe('a_b_c d.pdf');
    expect(safeFilename('con.txt')).toBe('_con.txt');
    expect(safeFilename('x'.repeat(300) + '.pdf').length).toBeLessThanOrEqual(120);
    expect(safeFilename('x'.repeat(300) + '.pdf').endsWith('.pdf')).toBe(true);
    expect(safeFilename(null)).toBe('attachment');
    expect(safeFilename('.hidden')).toBe('hidden');
  });
  it('Content-Disposition is always an attachment with an escaped name', () => {
    const cd = contentDisposition('Re"p\\ort ünï.pdf');
    expect(cd.startsWith('attachment; filename="')).toBe(true);
    expect(cd).not.toMatch(/\r|\n/);
    expect(cd).toContain("filename*=UTF-8''");
    expect(cd.split('filename="')[1]!.split('"')[0]).toBe('Re_p_ort _n_.pdf');
  });
  it('only inert content types are passed through; everything active is served as an opaque download', () => {
    for (const m of ['text/html', 'image/svg+xml', 'application/javascript', 'application/x-msdownload', 'text/xml', 'application/xhtml+xml']) expect(downloadMime(m)).toBe('application/octet-stream');
    expect(downloadMime('application/pdf')).toBe('application/pdf');
    expect(downloadMime('IMAGE/PNG; charset=x')).toBe('image/png');
    expect(isRiskyFilename('invoice.EXE')).toBe(true);
    expect(isRiskyFilename('page.html')).toBe(true);
    expect(isRiskyFilename('photo.jpg')).toBe(false);
  });
  it('header/line cleaning removes CR/LF and redact removes secrets', () => {
    expect(headerSafe('Hi\r\nBcc: x@y.z')).toBe('Hi Bcc: x@y.z');
    expect(cleanLine('a\nb\tc')).toBe('a b c');
    expect(redact('login failed for pw=abc123xyz', ['abc123xyz'])).toBe('login failed for pw=***');
  });
});

describe('threading helpers', () => {
  it('normalises subjects across languages and stacked prefixes', () => {
    expect(normalizeSubject('Re: RE: Fwd: AW: Hello  World')).toBe('hello world');
    expect(normalizeSubject('Re[2]: x')).toBe('x');
    expect(normalizeSubject('Reunion plans')).toBe('reunion plans'); // not a prefix
    expect(hasReplyPrefix('Re: x')).toBe(true);
    expect(hasReplyPrefix('Regarding x')).toBe(false);
    expect(replySubject('Plan')).toBe('Re: Plan');
    expect(replySubject('Re: Plan')).toBe('Re: Plan');
    expect(replySubject('')).toBe('Re: (no subject)');
  });
  it('builds In-Reply-To / References (bounded, no duplicates)', () => {
    expect(replyHeaders({ messageId: 'c@x', references: ['a@x', 'b@x'] })).toEqual({ inReplyTo: '<c@x>', references: ['<a@x>', '<b@x>', '<c@x>'] });
    const long = replyHeaders({ messageId: 'z@x', references: Array.from({ length: 30 }, (_, i) => `m${i}@x`) });
    expect(long.references).toHaveLength(10);
    expect(long.references.at(-1)).toBe('<z@x>');
  });
  it('normalises Message-IDs', () => {
    expect(normalizeMessageId('<ABC@Example.com>')).toBe('abc@example.com');
    expect(normalizeMessageId('  junk  ')).toBe('junk');
    expect(normalizeMessageId(null)).toBeNull();
  });
});

describe('parseRawMessage', () => {
  it('prefers text/plain, converts html-only, reads headers, decodes charsets and encoded words', async () => {
    const raw = Buffer.from(['From: =?UTF-8?Q?Jos=C3=A9_Garc=C3=ADa?= <JOSE@Example.com>', 'To: a@x.com, "B" <b@x.com>', 'Cc: c@x.com', 'Subject: =?UTF-8?B?Q2Fmw6k=?=', 'Date: Tue, 02 Jun 2026 12:00:00 +0200', 'Message-ID: <ID1@X>', 'In-Reply-To: <p@x>', 'References: <r1@x> <p@x>', 'Content-Type: text/plain; charset=iso-8859-1', 'Content-Transfer-Encoding: quoted-printable', '', 'caf=E9 au lait'].join('\r\n'));
    const m = await parseRawMessage(raw, { folder: 'inbox', uid: 5, seen: false });
    expect(m).toMatchObject({ subject: 'Café', fromName: 'José García', fromAddr: 'jose@example.com', to: ['a@x.com', 'b@x.com'], cc: ['c@x.com'], messageId: 'id1@x', inReplyTo: 'p@x', references: ['r1@x', 'p@x'], body: 'café au lait', bodySource: 'plain', date: '2026-06-02T10:00:00.000Z' });
  });
  it('survives a hostile/garbled message and caps header junk', async () => {
    const m = await parseRawMessage(Buffer.from('Subject: ' + 'x'.repeat(5000) + '\r\nFrom: not an address\r\n\r\n'), { folder: 'inbox', uid: 1, seen: true });
    expect(m.subject.length).toBeLessThanOrEqual(500);
    expect(m.fromAddr).toBe('unknown@invalid');
    expect(m.bodySource).toBe('none');
  });
  it('lists attachments from BODYSTRUCTURE with safe names', () => {
    const list = attachmentsFromStructure({
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain', size: 10 },
        { part: '2', type: 'application/pdf', disposition: 'attachment', dispositionParameters: { filename: '../x/inv.pdf' }, size: 400, encoding: 'base64' },
        { part: '3', type: 'image/png', disposition: 'inline', parameters: { name: 'logo.png' }, size: 50 },
        { part: '4', type: 'text/html', size: 20 },
      ],
    });
    expect(list.map((a) => [a.partId, a.filename, a.inline, a.size])).toEqual([['2', 'inv.pdf', false, 300], ['3', 'logo.png', true, 50]]);
  });
});

describe('error mapping + rate limiter', () => {
  const ctx = { protocol: 'imap', host: 'imap.example.com', port: 993, security: 'tls', secrets: ['pw-secret'] } as const;
  it('maps provider-style failures to short human messages', () => {
    expect(mapMailError({ authenticationFailed: true, responseText: 'Invalid credentials' }, ctx).code).toBe('auth_failed');
    expect(mapMailError({ authenticationFailed: true, serverResponseCode: 'ALERT', responseText: 'Application-specific password required' }, ctx).code).toBe('app_password_required');
    expect(mapMailError({ code: 'EAUTH', responseCode: 535, message: 'Invalid login: 535' }, { ...ctx, protocol: 'smtp' }).code).toBe('auth_failed');
    expect(mapMailError({ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND imap.example.com' }, ctx)).toMatchObject({ code: 'host_unreachable', message: expect.stringContaining('no such server name') });
    expect(mapMailError({ code: 'ETIMEDOUT' }, ctx).code).toBe('timeout');
    expect(mapMailError({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT', message: 'self-signed certificate' }, ctx).code).toBe('tls_error');
    expect(mapMailError({ code: 'EPROTO', message: 'wrong version number' }, ctx).code).toBe('tls_mismatch');
    expect(mapMailError({ response: 'A1 NO [UNAVAILABLE] busy' }, ctx).code).toBe('server_error');
    expect(mapMailError(new Error('boom'), ctx).code).toBe('unknown');
  });
  it('never echoes secrets that a server or library put into an error', () => {
    const m = mapMailError({ response: 'NO login pw-secret rejected', message: 'x pw-secret y' }, ctx);
    expect(m.message).not.toContain('pw-secret');
    expect(mapMailError(new Error('bad pw-secret'), ctx).message).not.toContain('pw-secret');
  });
  it('rate limiter allows N per window then reports a wait', () => {
    let t = 0;
    const l = new SlidingWindowLimiter(3, 60_000, () => t);
    expect([l.hit(), l.hit(), l.hit()]).toEqual([0, 0, 0]);
    expect(l.hit()).toBeGreaterThan(0);
    t = 61_000;
    expect(l.hit()).toBe(0);
  });
});
