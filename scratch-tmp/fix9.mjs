import { edit } from './edit.mjs';
edit('server/src/ai/prompts/common.ts', [
  ['export const NO_VISION_NOTICE =', `/** Shown when at least one clip has a visual analysis: the model still has not watched the video. */
export const PARTIAL_VISION_NOTICE =
  'You have NOT watched the video and you cannot hear it. For some clips a <clip_analysis> block tells you what a vision model saw in a few sampled still frames (VISUAL) and/or what signal measurements found (TECHNICAL). Rely on those statements only for the clips and timestamps they cover, remember that stills are samples (no motion, no sound), and know nothing about the content of clips without a VISUAL entry. Never describe what happens in the footage beyond that, and never invent events, places, people, products, results or claims.';

export const NO_VISION_NOTICE =`],
]);
edit('server/src/ai/prompts/planner.ts', [
  ["import { fence, NO_VISION_NOTICE } from './common.js';", "import { fence, NO_VISION_NOTICE, PARTIAL_VISION_NOTICE } from './common.js';\nimport { renderClipAnalysis } from './analysis.js';\nimport type { ClipAnalysis } from '../../../../shared/analysis.js';"],
  ['- Anything that needs knowing what is in the video: you cannot see it.`;', '- Anything that needs knowing what is in the video beyond what <clip_analysis> reports (you have not watched the video).`;'],
  ['export function plannerSystemPrompt(): string {', 'export function plannerSystemPrompt(opts: { visual?: boolean } = {}): string {'],
  ['${NO_VISION_NOTICE}\n\n${ENGINE_CAPABILITIES}', '${opts.visual ? PARTIAL_VISION_NOTICE : NO_VISION_NOTICE}\n\n${ENGINE_CAPABILITIES}'],
  ['4. Do not claim anything about what is in the footage. Title text', '4. Do not claim anything about what is in the footage except what <clip_analysis> states (and only as seen in sampled stills). Title text'],
  ['Make a confident, complete edit: choose sensible trim points (the start of long clips is often the least stable footage; you cannot see them, so say you chose by duration, not content).`;',
   'Make a confident, complete edit. When <clip_analysis> is present, use it to choose trim points: prefer VISUAL moments with a high usability score and TECHNICAL stretches marked strong, avoid stretches marked too dark / blurry / shaky and avoid trimming across a hard cut unless the brief wants it, and say in the rationale which choices were based on what (sampled stills vs measurements). Clips without analysis: choose by duration and say so (the start of long clips is often the least stable footage).`;'],
  ['  userSubtitleLines?: string[];\n}\n\nexport function plannerUserPrompt', '  userSubtitleLines?: string[];\n  clipAnalyses?: ClipAnalysis[];\n}\n\nexport function plannerUserPrompt'],
  ["  parts.push(`<assets>\\n${i.assets.map(fmtAsset).join('\\n')}\\n</assets>`);", "  parts.push(`<assets>\\n${i.assets.map(fmtAsset).join('\\n')}\\n</assets>`);\n  const analysis = renderClipAnalysis(i.assets, i.clipAnalyses);\n  if (analysis) parts.push(analysis);"],
]);
edit('server/src/ai/prompts/caption.ts', [
  ["import { fence, NO_VISION_NOTICE } from './common.js';", "import { fence, NO_VISION_NOTICE, PARTIAL_VISION_NOTICE } from './common.js';\nimport { renderSeenForCaption } from './analysis.js';"],
  ['export function captionSystemPrompt(): string {', 'export function captionSystemPrompt(opts: { visual?: boolean } = {}): string {'],
  ['${NO_VISION_NOTICE}\n\nRULES', '${opts.visual ? PARTIAL_VISION_NOTICE : NO_VISION_NOTICE}\n\nRULES'],
  ["1. Base everything ONLY on the owner's brief, the edit summary and the technical asset facts you are given.", "1. Base everything ONLY on the owner's brief, the edit summary, the technical asset facts and (if present) <what_the_editor_saw> that you are given."],
  ['3. Do not claim you watched the video. Do not describe visuals you were not told about.', '3. Do not claim you watched the video. Do not describe visuals you were not told about. If <what_the_editor_saw> is present you may mention what it states (it comes from a few sampled stills, not the whole video, and says nothing about sound); anything beyond it is unknown.'],
  ["    `<assets>\\n${assetLines}\\n</assets>`,\n  ];", "    `<assets>\\n${assetLines}\\n</assets>`,\n  ];\n  const seen = renderSeenForCaption(i.plan.segments.map((s) => s.assetId), i.assets, i.clipAnalyses);\n  if (seen) parts.push(seen);"],
]);
edit('server/src/ai/planner.ts', [
  ["import { plannerSystemPrompt, plannerUserPrompt } from './prompts/planner.js';", "import { hasVisual } from './prompts/analysis.js';\nimport { plannerSystemPrompt, plannerUserPrompt } from './prompts/planner.js';"],
  ['      system: plannerSystemPrompt(),', '      system: plannerSystemPrompt({ visual: hasVisual(input.clipAnalyses) }),'],
]);
edit('server/src/ai/caption.ts', [
  ["import { captionSystemPrompt, captionUserPrompt } from './prompts/caption.js';", "import { hasVisual } from './prompts/analysis.js';\nimport { captionSystemPrompt, captionUserPrompt } from './prompts/caption.js';"],
  ['    system: captionSystemPrompt(),', '    system: captionSystemPrompt({ visual: hasVisual(input.clipAnalyses) }),'],
]);
