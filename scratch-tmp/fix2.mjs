import fs from 'node:fs';
let h = fs.readFileSync('server/test/ai/helpers.ts','utf8');
const a = h.indexOf('export function makeConfig');
const b = h.indexOf('export type Scripted');
h = h.slice(0,a) + `export function makeConfig(over: Partial<AppConfig['ai']> = {}): AppConfig {
  // start from the real defaults so unrelated config sections (email, paths…) can evolve without breaking these tests
  const base = loadConfig({ DATA_DIR: '.' } as NodeJS.ProcessEnv, { readDotEnv: false });
  return {
    ...base,
    ai: { apiKey: 'test-key-not-real', primaryModel: 'claude-sonnet-5-5', fastModel: 'claude-haiku-5-5', dailyCallLimit: 60, dailyTokenLimit: 400_000, ...over },
  };
}

` + h.slice(b);
h = h.replace("import type { AppConfig } from '../../src/config.js';", "import { loadConfig, type AppConfig } from '../../src/config.js';");
fs.writeFileSync('server/test/ai/helpers.ts', h);
