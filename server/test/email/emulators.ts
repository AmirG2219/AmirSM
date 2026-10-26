/**
 * In-process mail server emulators (loopback only, no network):
 *  - IMAP: hoodiecrow-imap (strict RFC 3501 emulator by the imapflow authors) — real imapflow talks to it.
 *  - SMTP: smtp-server (nodemailer project) with message capture — real nodemailer talks to it.
 * NOTE: these are emulators, not Gmail/iCloud/etc. They prove the protocol code, not provider-specific behaviour.
 */
import hoodiecrow from 'hoodiecrow-imap';
import { SMTPServer } from 'smtp-server';
import { simpleParser, type ParsedMail } from 'mailparser';
import type { ImapSmtpSettings } from '../../src/email/types.js';

export const IMAP_USER = 'testuser';
export const IMAP_PASS = 'testpass';

export interface RawMsg { raw: string; flags?: string[]; internaldate?: string }

export function rfc822(o: { id: string; subject: string; from?: string; to?: string; date?: string; body?: string; inReplyTo?: string; references?: string; html?: string; extraHeaders?: string; attachment?: { name: string; mime: string; b64: string } }): string {
  const H = [
    `Message-ID: <${o.id}>`, `From: ${o.from ?? 'Alice Example <alice@example.com>'}`, `To: ${o.to ?? 'me@example.com'}`, `Subject: ${o.subject}`, `Date: ${o.date ?? 'Mon, 01 Jun 2026 10:00:00 +0000'}`, 'MIME-Version: 1.0',
  ];
  if (o.inReplyTo) H.push(`In-Reply-To: <${o.inReplyTo}>`);
  if (o.references) H.push(`References: ${o.references}`);
  if (o.extraHeaders) H.push(o.extraHeaders);
  if (o.attachment) {
    return [...H, 'Content-Type: multipart/mixed; boundary=BND', '', '--BND', 'Content-Type: text/plain; charset=utf-8', '', o.body ?? 'See attached.', '--BND',
      `Content-Type: ${o.attachment.mime}; name="${o.attachment.name}"`, `Content-Disposition: attachment; filename="${o.attachment.name}"`, 'Content-Transfer-Encoding: base64', '', o.attachment.b64, '--BND--', ''].join('\r\n');
  }
  if (o.html !== undefined) return [...H, 'Content-Type: text/html; charset=utf-8', '', o.html].join('\r\n');
  return [...H, 'Content-Type: text/plain; charset=utf-8', '', o.body ?? 'Hello there.'].join('\r\n');
}

export interface ImapEmu {
  port: number;
  close(): Promise<void>;
}
export async function startImap(opts: { inbox?: RawMsg[]; sent?: RawMsg[]; plugins?: string[]; secure?: boolean; sentName?: string } = {}): Promise<ImapEmu> {
  const server = hoodiecrow({
    plugins: ['UIDPLUS', 'SPECIAL-USE', 'ID', 'IDLE', 'NAMESPACE', 'ENABLE', 'LIST-EXTENDED', ...(opts.plugins ?? [])],
    secureConnection: !!opts.secure,
    storage: {
      INBOX: { messages: opts.inbox ?? [] },
      '': { separator: '/', folders: { [opts.sentName ?? 'Sent Items']: { 'special-use': '\Sent', messages: opts.sent ?? [] } } },
    },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

export interface SmtpEmu {
  port: number;
  received: { envelope: { from: string | false; to: string[] }; mail: ParsedMail; raw: Buffer; user: string }[];
  close(): Promise<void>;
}
export async function startSmtp(opts: { user?: string; pass?: string; rejectRcpt?: string; secure?: boolean } = {}): Promise<SmtpEmu> {
  const received: SmtpEmu['received'] = [];
  const server = new SMTPServer({
    authOptional: false,
    disableReverseLookup: true,
    allowInsecureAuth: true,
    secure: !!opts.secure,
    disabledCommands: opts.secure ? [] : ['STARTTLS'],
    onAuth(auth, _s, cb) {
      if (auth.username === (opts.user ?? IMAP_USER) && auth.password === (opts.pass ?? IMAP_PASS)) cb(null, { user: auth.username });
      else cb(new Error('Invalid login: 535 5.7.8 Authentication credentials invalid'));
    },
    onRcptTo(addr, _s, cb) {
      if (opts.rejectRcpt && addr.address === opts.rejectRcpt) return cb(Object.assign(new Error('Mailbox unavailable'), { responseCode: 550 }));
      cb();
    },
    onData(stream, session, cb) {
      const chunks: Buffer[] = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', async () => {
        const raw = Buffer.concat(chunks);
        received.push({ envelope: { from: session.envelope.mailFrom ? session.envelope.mailFrom.address : false, to: session.envelope.rcptTo.map((r) => r.address) }, mail: await simpleParser(raw), raw, user: String((session as { user?: unknown }).user ?? '') });
        cb();
      });
    },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.server.address() as { port: number }).port;
  return { port, received, close: () => new Promise<void>((r) => server.close(() => r())) };
}

export function settingsFor(imapPort: number, smtpPort: number, over: Partial<ImapSmtpSettings> = {}): ImapSmtpSettings {
  return {
    imap: { host: '127.0.0.1', port: imapPort, security: 'none' },
    smtp: { host: '127.0.0.1', port: smtpPort, security: 'none' },
    username: IMAP_USER,
    allowSelfSigned: false,
    autoSavesSent: false,
    ...over,
  };
}
