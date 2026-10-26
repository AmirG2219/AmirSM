import { edit } from './edit.mjs';
edit('server/src/ai/index.ts', [
  ["import { reviewQuality } from './review.js';", "import { reviewQuality } from './review.js';\nimport { analyzeClips } from './vision.js';"],
  ["    reviewQuality: (input) => reviewQuality(rt, input),", "    reviewQuality: (input) => reviewQuality(rt, input),\n    analyzeClips: (input) => analyzeClips(rt, input),"],
  ["export { sanitizePlan } from './sanitize.js';", "export { sanitizePlan } from './sanitize.js';\nexport { pickRanges } from './window-select.js';\nexport { framesForDuration } from './vision.js';"],
]);
