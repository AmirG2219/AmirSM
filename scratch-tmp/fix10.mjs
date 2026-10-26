import { edit } from './edit.mjs';
edit('shared/api.ts', [
  ["import type { EditPlan, OutputFormat, StylePreset } from './editPlan.js';", "import type { EditPlan, OutputFormat, StylePreset } from './editPlan.js';\nimport type { VersionAnalysis } from './analysis.js';\n\nexport type { VersionAnalysis, ClipAnalysis, Moment, TechnicalProfile } from './analysis.js';"],
  ["  stage: 'planning' | 'validating' | 'rendering' | 'captioning' | 'reviewing' | null;", "  stage: 'analyzing' | 'planning' | 'validating' | 'rendering' | 'captioning' | 'reviewing' | null;"],
  ["  thumbUrl: string | null;\n  createdAt: string;\n}\n\nexport interface VersionDTO {", `  thumbUrl: string | null;
  createdAt: string;
  /**
   * What the app knows about this clip, if anything (optional: filled where the server loads it).
   * technical = local signal measurements (no AI); visual = Claude looked at a few sampled stills.
   */
  analysis?: AssetAnalysisDTO;
}

export interface AssetAnalysisDTO {
  technical: { score: number; issues: string[] } | null;
  visual: { summary: string | null; tags: string[] } | null;
}

export interface VersionDTO {`],
  ["  warnings: string[];\n  error: string | null;\n  approved: boolean;", "  warnings: string[];\n  /**\n   * What the editor actually knew about the footage when this version was produced; null for versions made before\n   * analysis existed. \"What the editor saw\": show visual:true only as \"looked at sampled stills\", never as \"watched\".\n   */\n  analysis: VersionAnalysis | null;\n  error: string | null;\n  approved: boolean;"],
]);
