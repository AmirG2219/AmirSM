import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { AiLimitError, AiUnavailableError } from '../ai/types.js';
import { HttpError } from '../http.js';
import { logEvent } from '../repo.js';

const addrs = z.array(z.string().max(320)).max(10);
const draftCreate = z.object({
  accountId: z.string(),
  threadId: z.string().nullable().optional(),
  to: addrs,
  cc: addrs.optional(),
  subject: z.string().max(300),
  body: z.string().max(50_000),
  aiAssisted: z.boolean().optional(),
});
const draftPatch = z.object({ to: addrs.optional(), cc: addrs.optional(), subject: z.string().max(300).optional(), body: z.string().max(50_000).optional(), aiAssisted: z.boolean().optional() });

/** Map AI-layer errors to HTTP so the UI can show a precise reason. */
function aiError(e: unknown): never {
  if (e instanceof AiUnavailableError) throw new HttpError(409, 'ai_unavailable', e.message);
  if (e instanceof AiLimitError) throw new HttpError(429, 'ai_limit', e.message);
  throw new HttpError(502, 'ai_failed', (e as Error).message);
}

export function registerEmailRoutes(app: FastifyInstance, ctx: AppContext) {
  const { email, ai, db } = ctx;

  app.get('/api/email/accounts', async () => email.accounts());

  app.get('/api/email/threads', async (req) => {
    const q = z.object({ accountId: z.string().optional(), q: z.string().max(200).optional(), filter: z.enum(['unread', 'needs_reply']).optional() }).parse(req.query);
    return email.listThreads(q);
  });
  app.get('/api/email/threads/:id', async (req) => email.getThread((req.params as { id: string }).id));
  app.post('/api/email/threads/:id/read', async (req) => {
    const { read } = z.object({ read: z.boolean() }).parse(req.body);
    email.markRead((req.params as { id: string }).id, read);
    return email.getThread((req.params as { id: string }).id);
  });

  app.post('/api/email/threads/:id/summarize', async (req) => {
    const t = email.getThread((req.params as { id: string }).id);
    try {
      const s = await ai.summarizeThread({ subject: t.subject, messages: t.messages.map((m) => ({ from: m.fromName ? `${m.fromName} <${m.fromAddr}>` : m.fromAddr, date: m.date, body: m.body })) });
      email.saveSummary(t.id, s);
    } catch (e) {
      aiError(e);
    }
    return email.getThread(t.id);
  });

  // AI-assisted writing: returns text for the owner to review — it never creates a sent message.
  app.post('/api/email/ai/draft', async (req) => {
    const b = z.object({ instruction: z.string().trim().min(3).max(2000), threadId: z.string().optional(), tone: z.string().max(60).optional() }).parse(req.body);
    let replyTo: { subject: string; from: string; body: string } | undefined;
    if (b.threadId) {
      const t = email.getThread(b.threadId);
      const lastIn = [...t.messages].reverse().find((m) => m.direction === 'in') ?? t.messages[t.messages.length - 1];
      if (lastIn) replyTo = { subject: t.subject, from: lastIn.fromName ? `${lastIn.fromName} <${lastIn.fromAddr}>` : lastIn.fromAddr, body: lastIn.body };
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

  app.get('/api/email/drafts', async (req) => email.listDrafts(z.object({ status: z.string().optional() }).parse(req.query)));
  app.post('/api/email/drafts', async (req, reply) => {
    reply.code(201);
    return email.createDraft(draftCreate.parse(req.body));
  });
  app.get('/api/email/drafts/:id', async (req) => email.getDraft((req.params as { id: string }).id));
  app.patch('/api/email/drafts/:id', async (req) => email.updateDraft((req.params as { id: string }).id, draftPatch.parse(req.body)));

  /** Human review gate 1: the owner explicitly approves exactly this content. */
  app.post('/api/email/drafts/:id/approve', async (req) => {
    const d = email.approveDraft((req.params as { id: string }).id);
    logEvent(db, 'email.draft_approved', `Approved email draft “${d.subject}” for sending.`);
    return d;
  });
  /** Gate 2: sending requires an approved draft whose content hash is unchanged. */
  app.post('/api/email/drafts/:id/send', async (req) => {
    const d = await email.sendDraft((req.params as { id: string }).id);
    logEvent(db, 'email.sent', `${d.sendResult?.delivered ? 'Sent' : 'Recorded (not delivered)'} email “${d.subject}”.`);
    return d;
  });
}
