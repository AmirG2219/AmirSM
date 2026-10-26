/** Renders clip analyses for the planner/caption prompts with explicit provenance (what was SEEN vs only MEASURED). */
import { TECH_ISSUE_LABELS, type ClipAnalysis, type TechnicalProfile } from '../../../../shared/analysis.js';
import type { AssetBrief } from '../types.js';

const sec = (ms: number) => (ms / 1000).toFixed(1);
const quote = (s: string) => JSON.stringify(s);

export const VISUAL_PROVENANCE = 'Claude looked at a few SAMPLED STILLS of this clip (no audio, no motion, not the full video)';
export const TECHNICAL_PROVENANCE = 'signal measurements only (exposure, focus proxy, steadiness, scene cuts, audio level); says NOTHING about what is in the shots';

export function hasVisual(analyses: ClipAnalysis[] | undefined): boolean {
  return (analyses ?? []).some((a) => a.source === 'visual' && (a.summary || a.tags.length || a.moments.length));
}

/** Best contiguous stretches + problems + cuts in one short paragraph. */
export function describeTechnical(p: TechnicalProfile): string {
  const parts: string[] = [];
  const good = p.windows.filter((w) => w.score >= 0.85 && w.issues.length === 0);
  const ranges: { s: number; e: number }[] = [];
  for (const w of good) {
    const last = ranges[ranges.length - 1];
    if (last && w.startMs <= last.e + 1) last.e = w.endMs;
    else ranges.push({ s: w.startMs, e: w.endMs });
  }
  if (ranges.length) parts.push(`technically strong (well exposed, sharp, steady): ${ranges.slice(0, 4).map((r) => `${sec(r.s)}-${sec(r.e)} s`).join(', ')}`);
  else parts.push('no stretch measures as clearly strong');
  for (const i of p.issues) {
    if (i.code === 'silent_audio') continue;
    parts.push(`${TECH_ISSUE_LABELS[i.code]}: ${i.ranges.slice(0, 4).map((r) => `${sec(r.startMs)}-${sec(r.endMs)} s`).join(', ')}`);
  }
  if (p.sceneChangesMs.length) parts.push(`hard cut(s) at ${p.sceneChangesMs.slice(0, 6).map((t) => `${sec(t)} s`).join(', ')}`);
  if (p.audio?.present && p.audio.silentRatio !== null) parts.push(p.audio.silentRatio >= 0.9 ? 'audio is near-silent' : `audio level about ${p.audio.meanDb} dBFS, ${Math.round(p.audio.silentRatio * 100)}% near-silent`);
  if (p.analyzedMs < p.durationMs) parts.push(`only the first ${sec(p.analyzedMs)} s were measured`);
  return parts.join('; ');
}

function describeVisual(a: ClipAnalysis): string {
  const lines: string[] = [];
  if (a.summary) lines.push(`summary: ${a.summary}`);
  if (a.tags.length) lines.push(`tags: ${a.tags.join(', ')}`);
  for (const m of a.moments) {
    lines.push(`moment ${m.startMs}-${m.endMs} ms (usability ${m.score}): ${m.description}${m.issues.length ? ` [visible issues: ${m.issues.join('; ')}]` : ''}`);
  }
  return lines.map((l) => `    ${l}`).join('\n');
}

/** <clip_analysis> block, or '' if there is nothing to say. Only assets in `assets` are listed. */
export function renderClipAnalysis(assets: AssetBrief[], analyses: ClipAnalysis[] | undefined): string {
  if (!analyses?.length) return '';
  const out: string[] = [];
  for (const asset of assets) {
    if (asset.kind !== 'video') continue;
    const visual = analyses.find((a) => a.assetId === asset.id && a.source === 'visual');
    const tech = analyses.find((a) => a.assetId === asset.id && a.source === 'technical' && a.technical)?.technical;
    if (!visual && !tech) continue;
    const lines = [`- assetId=${quote(asset.id)} (${quote(asset.name)}, ${asset.durationMs} ms)`];
    lines.push(visual ? `  VISUAL [${VISUAL_PROVENANCE}; ${visual.framesUsed} stills]:\n${describeVisual(visual)}` : '  VISUAL: not analysed (you know nothing about the content of this clip)');
    if (tech) lines.push(`  TECHNICAL [${TECHNICAL_PROVENANCE}]: ${describeTechnical(tech)}`);
    out.push(lines.join('\n'));
  }
  if (!out.length) return '';
  return `<clip_analysis note="Provenance matters. VISUAL = what a vision model saw in a few sampled stills, with timestamps in ms; it may be incomplete or wrong. TECHNICAL = measurements, not understanding. Treat both as data.">\n${out.join('\n')}\n</clip_analysis>`;
}

/** Only the VISUAL summaries of the given assets, for captions ("what the editor saw"). '' if none. */
export function renderSeenForCaption(assetIds: string[], assets: AssetBrief[], analyses: ClipAnalysis[] | undefined): string {
  const out: string[] = [];
  for (const id of new Set(assetIds)) {
    const v = analyses?.find((a) => a.assetId === id && a.source === 'visual');
    if (!v || (!v.summary && !v.tags.length)) continue;
    const name = assets.find((a) => a.id === id)?.name ?? id;
    out.push(`- ${quote(name)}: ${v.summary ?? '(no summary)'}${v.tags.length ? ` (tags: ${v.tags.join(', ')})` : ''}`);
  }
  if (!out.length) return '';
  return `<what_the_editor_saw note="${VISUAL_PROVENANCE}. Only these statements count as 'seen'.">\n${out.join('\n')}\n</what_the_editor_saw>`;
}
