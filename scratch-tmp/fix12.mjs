import { edit } from './edit.mjs';
edit('server/src/orchestrator.ts', [
  [`import { AiLimitError, AiUnavailableError, type AssetBrief } from './ai/types.js';`,
   `import { AiLimitError, AiUnavailableError, type AssetBrief } from './ai/types.js';
import { framesForDuration } from './ai/vision.js';
import {
  TECH_ANALYZER_VERSION,
  VISION_ANALYZER_VERSION,
  technicalToClipAnalysis,
  type ClipAnalysis,
  type VersionAnalysis,
} from '../../shared/analysis.js';
import { createAnalysisStore } from './analysis-store.js';`],
  [`const STAGES = {
  planning: [0, 0.1],
  validating: [0.1, 0.12],
  rendering: [0.12, 0.85],
  captioning: [0.85, 0.93],
  reviewing: [0.93, 1],
} as const;`,
   `const STAGES = {
  analyzing: [0.02, 0.2],
  planning: [0.2, 0.28],
  validating: [0.28, 0.3],
  rendering: [0.3, 0.86],
  captioning: [0.86, 0.93],
  reviewing: [0.93, 1],
} as const;`],
  [`      // ---- 1. plan ----
      let plan = parseJson<EditPlan | null>(version.plan_json, null);
      if (!plan) {
        job.report('planning', span('planning', 0.1), version.is_revision ? 'Interpreting your revision…' : 'Creative Director is reading your brief…');`,
   `      // ---- 0. analyse the footage (local measurements always; Claude's look at sampled stills when configured) ----
      // Never fails the draft: every problem degrades to "less is known" and is written to the version's analysis notes.
      let clipAnalyses: ClipAnalysis[] = [];
      const needPlan = !parseJson<EditPlan | null>(version.plan_json, null);
      if (needPlan || !version.analysis_json) {
        job.report('analyzing', span('analyzing', 0), 'Looking at your clips…');
        const g = await gatherAnalyses(ctx, job, rows, planAssets, briefs);
        clipAnalyses = g.analyses;
        setVersion(ctx, vid, { analysis_json: JSON.stringify(g.summary) });
        check();
      } else {
        clipAnalyses = loadAnalyses(ctx, briefs);
      }

      // ---- 1. plan ----
      let plan = parseJson<EditPlan | null>(version.plan_json, null);
      if (!plan) {
        job.report('planning', span('planning', 0.1), version.is_revision ? 'Interpreting your revision…' : 'Creative Director is reading your brief…');`],
  [`              userSubtitleLines: subtitleLines.length ? subtitleLines : undefined,
            },`,
   `              userSubtitleLines: subtitleLines.length ? subtitleLines : undefined,
              clipAnalyses,
            },`],
  [`const caption = await produceCaption(ctx, version, project, plan, briefs);`, `const caption = await produceCaption(ctx, version, project, plan, briefs, undefined, clipAnalyses);`],
  [`export async function produceCaption(ctx: AppContext, version: Row, project: Row, plan: EditPlan, briefs: AssetBrief[], feedback?: string): Promise<Caption | null> {`,
   `export async function produceCaption(ctx: AppContext, version: Row, project: Row, plan: EditPlan, briefs: AssetBrief[], feedback?: string, clipAnalyses?: ClipAnalysis[]): Promise<Caption | null> {`],
  [`      previousCaption: existing ?? parseJson<Caption | null>(parent?.caption_json, null) ?? undefined,`,
   `      previousCaption: existing ?? parseJson<Caption | null>(parent?.caption_json, null) ?? undefined,
      clipAnalyses: clipAnalyses ?? loadAnalyses(ctx, briefs),`],
]);

// append helper functions
import fs from 'node:fs';
const file = 'server/src/orchestrator.ts';
let s = fs.readFileSync(file, 'utf8');
const crlf = s.includes('\r\n');
s = s.replace(/\r\n/g, '\n');
s += `
// ---------------------------------------------------------------------------------------------------------
// Footage analysis
// ---------------------------------------------------------------------------------------------------------

/** Cached analyses (current analyzer versions only) for these assets. Pure DB read. */
export function loadAnalyses(ctx: AppContext, briefs: AssetBrief[]): ClipAnalysis[] {
  try {
    const ids = briefs.filter((b) => b.kind === 'video').map((b) => b.id);
    return createAnalysisStore(ctx.db)
      .forAssets(ids)
      .filter((a) => (a.source === 'visual' ? a.analyzerVersion === VISION_ANALYZER_VERSION : a.analyzerVersion === TECH_ANALYZER_VERSION));
  } catch {
    return [];
  }
}

const errText = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 200);

/**
 * Technical profiles for every video clip (always, local, cached) + visual analyses for clips not yet cached (only if the
 * AI is configured and within its daily limits). Returns what was gathered and the truthful per-version summary.
 */
export async function gatherAnalyses(
  ctx: AppContext,
  job: JobContext,
  rows: Row[],
  planAssets: Map<string, PlanAsset>,
  briefs: AssetBrief[],
): Promise<{ analyses: ClipAnalysis[]; summary: VersionAnalysis }> {
  const { ai, video } = ctx;
  const store = createAnalysisStore(ctx.db);
  const notes: string[] = [];
  const videoBriefs = briefs.filter((b) => b.kind === 'video');
  const technical = new Map<string, ClipAnalysis>();
  const visual = new Map<string, ClipAnalysis>();

  // ---- technical (no AI) ----
  let done = 0;
  const techFailed: string[] = [];
  for (const b of videoBriefs) {
    if (job.signal.aborted) throw new RenderCancelled();
    const asset = planAssets.get(b.id);
    if (!asset) continue;
    try {
      let a = store.get(b.id, 'technical', TECH_ANALYZER_VERSION);
      if (!a) {
        if (typeof video.technicalProfile !== 'function') throw new Error('this video engine cannot measure clips');
        job.report('analyzing', span('analyzing', (0.5 * done) / Math.max(1, videoBriefs.length)), \`Measuring exposure, focus and camera movement: \${b.name}…\`);
        const profile = await video.technicalProfile(asset.path, asset.info, { signal: job.signal });
        a = technicalToClipAnalysis(b.id, profile);
        try {
          store.put(a);
        } catch {
          /* cache failure only costs a repeat measurement */
        }
      }
      technical.set(b.id, a);
    } catch (e) {
      if (job.signal.aborted) throw new RenderCancelled();
      techFailed.push(\`\${b.name} (\${errText(e)})\`);
    }
    done++;
  }
  if (techFailed.length) notes.push(\`Technical measurements failed for \${techFailed.length} clip(s): \${techFailed.join('; ')}.\`);

  // ---- visual (Claude, sampled stills) ----
  let framesAnalyzed = 0;
  if (videoBriefs.length > 0 && typeof ai.analyzeClips === 'function') {
    job.report('analyzing', span('analyzing', 0.5), 'Preparing sampled frames for the AI…');
    try {
      const res = await ai.analyzeClips({
        projectId: rows[0]?.project_id ?? '',
        clips: videoBriefs.map((b) => ({ assetId: b.id, name: b.name, durationMs: b.durationMs })),
        cache: store,
        signal: job.signal,
        getFrames: async (clip) => {
          const asset = planAssets.get(clip.assetId);
          if (!asset || typeof video.sampleFrames !== 'function') return [];
          return video.sampleFrames(asset.path, asset.info, { count: framesForDuration(clip.durationMs), signal: job.signal });
        },
        onProgress: (d, t, msg) => job.report('analyzing', span('analyzing', 0.5 + (0.5 * d) / Math.max(1, t)), msg),
      });
      for (const a of res.analyses) visual.set(a.assetId, a);
      framesAnalyzed = res.analyses.reduce((n, a) => n + a.framesUsed, 0);
      notes.push(...res.notes);
      if (res.fromCache > 0 && res.calls === 0 && res.skipped.length === 0) notes.push(\`Reused earlier visual analysis of \${res.fromCache} clip(s) (no new AI call).\`);
    } catch (e) {
      if (job.signal.aborted) throw new RenderCancelled();
      notes.push(\`Visual analysis failed and was skipped: \${errText(e)}\`);
    }
  } else if (videoBriefs.length > 0) {
    notes.push('Visual analysis is not available in this setup.');
  }

  job.report('analyzing', span('analyzing', 1), 'Footage analysed.');
  const analyses = [...videoBriefs.flatMap((b) => [visual.get(b.id), technical.get(b.id)]).filter((a): a is ClipAnalysis => Boolean(a))];
  const summary: VersionAnalysis = {
    visual: visual.size > 0,
    technical: technical.size > 0,
    framesAnalyzed,
    clips: videoBriefs.map((b) => {
      const v = visual.get(b.id);
      const t = technical.get(b.id)?.technical;
      return {
        assetId: b.id,
        name: b.name,
        summary: v?.summary ?? null,
        tags: v?.tags ?? [],
        moments: v?.moments ?? [],
        technicalIssues: t ? t.issues.filter((i) => i.code !== 'silent_audio' || true).map((i) => i.label) : [],
      };
    }),
    notes,
  };
  return { analyses, summary };
}
`;
if (crlf) s = s.replace(/\n/g, '\r\n');
fs.writeFileSync(file, s);
