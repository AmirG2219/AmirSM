import path from 'node:path';
import fs from 'node:fs';

export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  maxUploadBytes: number;
  isProd: boolean;
  ai: {
    apiKey: string | null;
    primaryModel: string;
    fastModel: string;
    dailyCallLimit: number;
    dailyTokenLimit: number;
    webSearchEnabled: boolean;
  };
  email: { provider: string; resendApiKey: string | null; resendFrom: string | null };
  n8n: { baseUrl: string | null; webhookSecret: string | null; inboundToken: string | null };
  paths: { db: string; uploads: string; renders: string; exports: string; thumbs: string; work: string };
}

/** Minimal .env loader (no dependency). Real environment variables win over the file. */
function loadDotEnv(file: string) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const key = m[1]!;
    let val = m[2]!;
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? n : d;
};
const str = (v: string | undefined) => (v && v.trim() ? v.trim() : null);

export function loadConfig(env: NodeJS.ProcessEnv = process.env, opts: { readDotEnv?: boolean } = {}): AppConfig {
  if (opts.readDotEnv !== false) loadDotEnv(path.resolve(process.cwd(), '.env'));
  const e = env === process.env ? process.env : env;
  const dataDir = path.resolve(process.cwd(), e.DATA_DIR || './data');
  return {
    host: e.HOST || '127.0.0.1',
    port: num(e.PORT, 4300),
    dataDir,
    maxUploadBytes: num(e.MAX_UPLOAD_MB, 2048) * 1024 * 1024,
    isProd: e.NODE_ENV === 'production',
    ai: {
      apiKey: str(e.ANTHROPIC_API_KEY),
      primaryModel: e.ANTHROPIC_MODEL_PRIMARY || 'claude-sonnet-5-5',
      fastModel: e.ANTHROPIC_MODEL_FAST || 'claude-haiku-5-5',
      dailyCallLimit: num(e.AI_DAILY_CALL_LIMIT, 60),
      dailyTokenLimit: num(e.AI_DAILY_TOKEN_LIMIT, 400_000),
      webSearchEnabled: e.AI_WEB_SEARCH_ENABLED === 'true',
    },
    email: { provider: e.EMAIL_PROVIDER || 'fixture', resendApiKey: str(e.RESEND_API_KEY), resendFrom: str(e.RESEND_FROM) },
    n8n: { baseUrl: str(e.N8N_BASE_URL), webhookSecret: str(e.N8N_WEBHOOK_SECRET), inboundToken: str(e.N8N_INBOUND_TOKEN) },
    paths: {
      db: path.join(dataDir, 'amir-sm.db'),
      uploads: path.join(dataDir, 'uploads'),
      renders: path.join(dataDir, 'renders'),
      exports: path.join(dataDir, 'exports'),
      thumbs: path.join(dataDir, 'thumbs'),
      work: path.join(dataDir, 'work'),
    },
  };
}
