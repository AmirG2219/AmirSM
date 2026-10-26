import { edit } from './edit.mjs';
edit('scripts/make-test-footage.ts', [
  ['export async function generateAnalysisFootage(dir: string, opts: MakeFootageOptions = {}): Promise<AnalysisFootage> {',
   "export async function generateAnalysisFootage(dir: string, opts: MakeFootageOptions & { only?: (keyof Omit<AnalysisFootage, 'dir'>)[] } = {}): Promise<AnalysisFootage> {"],
  ["  const want = async (file: string, make: () => Promise<void>) => {\n    if (opts.reuse) {\n      try {\n        if ((await fs.stat(file)).size > 0) return;\n      } catch {\n        /* generate */\n      }\n    }\n    await make();\n  };\n  await want(out.mixed,",
   "  const want = async (file: string, make: () => Promise<void>) => {\n    if (opts.only && !opts.only.some((k) => out[k] === file)) return;\n    if (opts.reuse) {\n      try {\n        if ((await fs.stat(file)).size > 0) return;\n      } catch {\n        /* generate */\n      }\n    }\n    await make();\n  };\n  await want(out.mixed,"],
]);
