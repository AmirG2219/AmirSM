import { z } from 'zod';
import { CaptionSchema, captionToText } from '../../../shared/domain.js';
import { toToolSchema, type AiRuntime } from './client.js';
import { captionSystemPrompt, captionUserPrompt } from './prompts/caption.js';
import type { CaptionInput, CaptionResult } from './types.js';

export const CAPTION_MAX_CHARS = 2200;

const ToolCaptionSchema = CaptionSchema.refine((c) => captionToText(c).length <= CAPTION_MAX_CHARS, {
  message: `the full caption text (hook + body + cta + hashtags) must be at most ${CAPTION_MAX_CHARS} characters`,
});

/** Lenient clean-up of obvious formatting slips (leading '#', spaces) before strict validation. */
export function normalizeCaptionRaw(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const r = { ...(raw as Record<string, unknown>) };
  if (Array.isArray(r.hashtags)) {
    const seen = new Set<string>();
    const tags: string[] = [];
    for (const t of r.hashtags) {
      if (typeof t !== 'string') continue;
      const clean = t.trim().replace(/^#+/, '').replace(/\s+/g, '');
      const key = clean.toLowerCase();
      if (!clean || seen.has(key)) continue;
      seen.add(key);
      tags.push(clean);
    }
    r.hashtags = tags.slice(0, 15);
  }
  for (const k of ['hook', 'body', 'cta'] as const) if (typeof r[k] === 'string') r[k] = (r[k] as string).trim();
  return r;
}

let cachedSchema: Record<string, unknown> | null = null;

export async function writeCaption(rt: AiRuntime, input: CaptionInput): Promise<CaptionResult> {
  rt.requireAvailable('Writing a caption');
  cachedSchema ??= toToolSchema(CaptionSchema);
  const res = await rt.callStructured({
    role: 'copywriter',
    model: rt.cfg.primaryModel,
    system: captionSystemPrompt(),
    user: captionUserPrompt(input),
    toolName: 'submit_caption',
    toolDescription: 'Submit the finished Instagram caption (hook, body, call to action, hashtags without #).',
    zodSchema: ToolCaptionSchema as z.ZodType<z.infer<typeof CaptionSchema>>,
    jsonSchema: cachedSchema,
    maxTokens: 8_000,
    projectId: input.projectId,
    prepare: normalizeCaptionRaw,
  });
  return { caption: res.data, model: res.model };
}
