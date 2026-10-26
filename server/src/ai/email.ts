import { z } from 'zod';
import { toToolSchema, type AiRuntime } from './client.js';
import { DRAFT_SYSTEM, SUMMARIZE_SYSTEM, TONE_SYSTEM, draftUser, summarizeUser, toneUser } from './prompts/email.js';
import type { AiService } from './types.js';

const SummarySchema = z.object({
  summary: z.string().min(1).max(1500),
  actionItems: z.array(z.string().min(1).max(300)).max(12).default([]),
  needsReply: z.boolean(),
});
const DraftSchema = z.object({ subject: z.string().min(1).max(200), body: z.string().min(1).max(8000) });
const ToneSchema = z.object({ text: z.string().min(1).max(8000) });

const cache = new Map<string, Record<string, unknown>>();
function schemaOf(key: string, s: z.ZodType) {
  let v = cache.get(key);
  if (!v) cache.set(key, (v = toToolSchema(s)));
  return v;
}

export async function summarizeThread(rt: AiRuntime, thread: Parameters<AiService['summarizeThread']>[0]) {
  rt.requireAvailable('Summarising an email thread');
  const res = await rt.callStructured({
    role: 'email',
    model: rt.cfg.fastModel,
    system: SUMMARIZE_SYSTEM,
    user: summarizeUser(thread),
    toolName: 'submit_summary',
    toolDescription: 'Submit the thread summary, action items for the owner, and whether a reply is needed.',
    zodSchema: SummarySchema,
    jsonSchema: schemaOf('summary', SummarySchema),
    maxTokens: 4_000,
  });
  return { summary: res.data.summary, actionItems: res.data.actionItems, needsReply: res.data.needsReply };
}

export async function draftEmail(rt: AiRuntime, input: Parameters<AiService['draftEmail']>[0]) {
  rt.requireAvailable('Drafting an email');
  const res = await rt.callStructured({
    role: 'email',
    model: rt.cfg.fastModel,
    system: DRAFT_SYSTEM,
    user: draftUser(input),
    toolName: 'submit_draft',
    toolDescription: 'Submit the draft email (subject and plain-text body). It is a draft for human review and is not sent.',
    zodSchema: DraftSchema,
    jsonSchema: schemaOf('draft', DraftSchema),
    maxTokens: 4_000,
  });
  return { subject: res.data.subject.trim(), body: res.data.body.trim() };
}

export async function adjustTone(rt: AiRuntime, input: Parameters<AiService['adjustTone']>[0]) {
  rt.requireAvailable('Changing the tone of a text');
  const res = await rt.callStructured({
    role: 'email',
    model: rt.cfg.fastModel,
    system: TONE_SYSTEM,
    user: toneUser(input),
    toolName: 'submit_text',
    toolDescription: 'Submit the rewritten text.',
    zodSchema: ToneSchema,
    jsonSchema: schemaOf('tone', ToneSchema),
    maxTokens: 4_000,
  });
  return { text: res.data.text.trim() };
}
