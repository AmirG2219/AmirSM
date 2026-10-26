import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { AiLimitError, AiUnavailableError } from '../ai/types.js';
import { HttpError } from '../http.js';
import { contentDisposition } from '../email/sanitize.js';

const addrs = z.array(z.string().max(320)).max(10);
const draftCreate = z.object({
  accountId: z.string().max(64),
  threadId: z.string().max(64).nullable().optional(),
  to: addrs,
  cc: addrs.optional(),
  subject: z.string().max(300),
  body: z.string().max(50_000),
  aiAssisted: z.boolean().optional(),
});
const draftPatch = z.object({ to: addrs.optional(), cc: addrs.optional(), subject: z.string().max(300).optional(), body: z.string().max(50_000).optional(), aiAssisted: z.boolean().optional() });

// ---- connection input -------------------------------------------------------------------------------------------
// The owner supplies the host (localhost bridges must work), so private ranges are NOT blocked; the host must merely be a
// plain hostname / IP literal (no scheme, path, credentials or whitespace). Nothing here ever follows a redirect or URL.
const HOST_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*|\[?[0-9A-Fa-f:]{2,45}\]?)$/;
// eslint-disable-next-line no-control-regex
const NO_CONTROL = /^[^\u0000-\u001F\u007F]*$/;
const endpoint = z.object({
  host: z.string().trim().min(1).max(253).regex(HOST_RE, 'Enter a server name like imap.example.com (no http://, slashes or spaces).'),
  port: z.number().int().min(1).max(65535),
  security: z.enum(['tls', 'starttls', 'none']),
}).strict();
const connectInput = z.object({
  presetId: z.string().min(1).max(40),
  address: z.string().trim().min(3).max(254).regex(NO_CONTROL),
  password: z.string().min(1).max(512).regex(NO_CONTROL, 'The password contains characters that are not allowed.'),
  username: z.string().trim().max(254).regex(NO_CONTROL).optional(),
  label: z.string().max(80).optional(),
  imap: endpoint.optional(),
  smtp: endpoint.optional(),
  allowSelfSigned: z.boolean().optional(),
  autoSavesSent: z.boolean().optional(),
}).strict();

const AI_MAX_MESSAGES = 15;
const AI_MAX_BODY = 8_000;

/** Map AI-layer errors to HTTP so the UI can show a precise reason. */
function aiError(e: unknown): never {
  if (e instanceof AiUnavailableError) throw new HttpError(409, 'ai_unavailable', e.message);
  if (e instanceof AiLimitError) throw new HttpError(429, 'ai_limit', e.message);
  throw new HttpError(502, 'ai_failed', (e as Error).message);
}

const idParam = (req: { params: unknown }) => (req.params as { id: string }).id;

export function registerEmailRoutes(app: FastifyInstance, ctx: AppContext) {
  const { email, ai } = ctx;

  // ---- providers + accounts ----
  app.get('/api/email/providers', async () => email.presets());
  app.get('/api/email/accounts', async () => email.accounts());

  /** Tries IMAP + SMTP login; saves nothing. Always 200 with a per-protocol result (ok:false carries human-readable errors). */
  app.post('/api/email/accounts/test', async (req) => email.testConnection(connectInput.parse(req.body)));
  /** Tests, then saves (credentials encrypted) and starts the first sync. 422 connection_failed if the test fails. */
  app.post('/api/email/accounts', async (req, reply) => {
    const acc = await email.connect(connectInput.parse(req.body));
    reply.code(201);
    return acc;
  });
  /** Disconnect: removes stored credentials + the local copy of the mail. The mailbox on the server is not touched. */
  app.delete('/api/email/accounts/:id', async (req) => ({ ok: true, ...email.disconnect(idParam(req)) }));
  app.post('/api/email/accounts/:id/sync', async (req, reply) => {
    const { wait } = z.object({ wait: z.boolean().optional() }).default({}).parse(req.body ?? {});
    const id = idParam(req);
    const p = email.startSync(id);
    if (wait) await p;
    else reply.code(202);
    return email.account(id);
  });

  // ---- reading ----
  app.get('/api/email/threads', async (req) => {
    const q = z
      .object({
        accountId: z.string().max(64).optional(),
        q: z.string().trim().max(200).optional(),
        filter: z.enum(['unread', 'needs_reply']).optional(),
        mailbox: z.enum(['inbox', 'sent', 'all']).optional(),
        serverSearch: z.enum(['true', 'false']).optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
        before: z.string().max(40).optional(),
      })
      .parse(req.query);
    email.maybeAutoSync();
    if (q.serverSearch === 'true') {
      if (!q.q) throw new HttpError(400, 'bad_request', 'serverSearch needs a search text (q).');
      await email.importServerSearch(q.q, q.accountId);
    }
    return email.listThreads({ accountId: q.accountId, q: q.q, filter: q.filter, mailbox: q.mailbox ?? 'inbox', limit: q.limit, before: q.before });
  });
  app.get('/api/email/threads/:id', async (req) => email.getThread(idParam(req)));
  /** Marks read/unread locally AND on the mail server (\Seen) — the UI calls this when a thread is opened. */
  app.post('/api/email/threads/:id/read', async (req) => {
    const { read } = z.object({ read: z.boolean() }).parse(req.body);
    await email.markRead(idParam(req), read);
    return email.getThread(idParam(req));
  });

  /** Streams an attachment from the mail server on demand. Download only: never rendered or executed here. */
  app.get('/api/email/attachments/:id', async (req, reply) => {
    const a = await email.openAttachment(idParam(req));
    reply
      .header('Content-Type', a.mime)
      .header('Content-Disposition', contentDisposition(a.filename))
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Cache-Control', 'private, no-store');
    return reply.send(a.stream);
  });

  app.post('/api/email/threads/:id/summarize', async (req) => {
    const t = email.getThread(idParam(req));
    try {
      const recent = t.messages.slice(-AI_MAX_MESSAGES);
      const s = await ai.summarizeThread({ subject: t.subject, messages: recent.map((m) => ({ from: m.fromName ? `${m.fromName} <${m.fromAddr}>` : m.fromAddr, date: m.date, body: m.body.slice(0, AI_MAX_BODY) })) });
      email.saveSummary(t.id, s);
    } catch (e) {
      aiError(e);
    }
    return email.getThread(t.id);
  });

  // AI-assisted writing: returns text for the owner to review — it never creates a sent message.
  app.post('/api/email/ai/draft', async (req) => {
    const b = z.object({ instruction: z.string().trim().min(3).max(2000), threadId: z.string().max(64).optional(), tone: z.string().max(60).optional() }).parse(req.body);
    let replyTo: { subject: string; from: string; body: string } | undefined;
    if (b.threadId) {
      const t = email.getThread(b.threadId);
      const lastIn = [...t.messages].reverse().find((m) => m.direction === 'in') ?? t.messages[t.messages.length - 1];
      if (lastIn) replyTo = { subject: t.subject, from: lastIn.fromName ? `${lastIn.fromName} <${lastIn.fromAddr}>` : lastIn.fromAddr, body: lastIn.body.slice(0, AI_MAX_BODY) };
    }
    try {
      return await ai.draftEmail({ instruction: b.instruction, replyTo, tone: b.tone });
    } catch (e) {
      aiError(e);
    }
  });
  app.post('/api/email/ai/tone', async (req) => {
    const b = z.object({ text: z.string().min(1).max(20_000), tone: z.string().min(2).max(60) }).parse(req.body);
    try {
      return await ai.adjustTone(b);
    } catch (e) {
      aiError(e);
    }
  });

  // ---- drafts + the approve -> send gate ----
  app.get('/api/email/drafts', async (req) => email.listDrafts(z.object({ status: z.string().max(20).optional() }).parse(req.query)));
  app.post('/api/email/drafts', async (req, reply) => {
    reply.code(201);
    return email.createDraft(draftCreate.parse(req.body));
  });
  app.get('/api/email/drafts/:id', async (req) => email.getDraft(idParam(req)));
  app.patch('/api/email/drafts/:id', async (req) => email.updateDraft(idParam(req), draftPatch.parse(req.body)));

  /** Human review gate 1: the owner explicitly approves exactly this content. */
  app.post('/api/email/drafts/:id/approve', async (req) => email.approveDraft(idParam(req)));
  /** Gate 2: sending requires an approved draft whose content hash is unchanged. */
  app.post('/api/email/drafts/:id/send', async (req) => email.sendDraft(idParam(req)));
}
