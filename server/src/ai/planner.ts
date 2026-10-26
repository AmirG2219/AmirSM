import { z } from 'zod';
import { EditPlanSchema } from '../../../shared/editPlan.js';
import { toToolSchema, type AiRuntime } from './client.js';
import { plannerSystemPrompt, plannerUserPrompt } from './prompts/planner.js';
import { planWithRules } from './rules-planner.js';
import { sanitizePlan } from './sanitize.js';
import { AiLimitError, AiOutputError, AiUnavailableError, type PlanEditInput, type PlanEditResult } from './types.js';

const PlanToolSchema = z.object({
  /** Creative Director's reasoning for the owner, plain language */
  rationale: z.string().min(1),
  plan: EditPlanSchema,
});

let cachedSchema: Record<string, unknown> | null = null;
export function planToolJsonSchema(): Record<string, unknown> {
  cachedSchema ??= toToolSchema(PlanToolSchema);
  return cachedSchema;
}

export async function planEdit(
  rt: AiRuntime,
  input: PlanEditInput,
  opts: { allowRulesFallback?: boolean } = {},
): Promise<PlanEditResult> {
  if (!input.assets.some((a) => a.kind === 'video')) {
    throw new AiOutputError('There are no video clips to edit. Upload at least one video first.');
  }

  const fallback = (why: string): PlanEditResult => planWithRules(input, [why]);

  if (!rt.available) {
    if (opts.allowRulesFallback) return fallback('AI is not configured (no ANTHROPIC_API_KEY), so the Basic auto-edit was used.');
    throw new AiUnavailableError('AI planning needs the Anthropic API. Set ANTHROPIC_API_KEY in the server environment (.env) and restart, or use the Basic auto-edit.');
  }

  try {
    const res = await rt.callStructured({
      role: 'creative_director',
      model: rt.cfg.primaryModel,
      system: plannerSystemPrompt(),
      user: plannerUserPrompt(input),
      toolName: 'submit_edit_plan',
      toolDescription: 'Submit the complete edit plan (and your rationale for the owner) for the video engine to render.',
      zodSchema: PlanToolSchema,
      jsonSchema: planToolJsonSchema(),
      maxTokens: 16_000,
      projectId: input.projectId,
    });
    const { plan, notes } = sanitizePlan(res.data.plan, {
      assets: input.assets,
      brief: input.brief,
      ...(input.revisionRequest ? { revisionRequest: input.revisionRequest } : {}),
      ...(input.userSubtitleLines ? { userSubtitleLines: input.userSubtitleLines } : {}),
    });
    if (res.repairs > 0) notes.unshift('The first AI answer did not match the required format; it was corrected on a retry.');
    return {
      plan,
      rationale: res.data.rationale.replace(/\s+/g, ' ').trim().slice(0, 600),
      source: 'ai',
      model: res.model,
      notes,
    };
  } catch (err) {
    const known = err instanceof AiUnavailableError || err instanceof AiLimitError || err instanceof AiOutputError;
    if (opts.allowRulesFallback && known) {
      return fallback(`The AI planner could not be used (${err.message}) so the Basic auto-edit was used instead.`);
    }
    throw err;
  }
}
