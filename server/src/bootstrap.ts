import fs from 'node:fs';
import type { AppConfig } from './config.js';
import { openDb, type Db, type Row } from './db/index.js';
import type { AiService, UsageRecord, UsageStore } from './ai/types.js';
import type { VideoEngine } from './video/types.js';
import { createAiService } from './ai/index.js';
import { createVideoEngine, resolveBinaries } from './video/index.js';
import { JobRunner } from './jobs/runner.js';
import { N8nBridge } from './integrations/n8n.js';
import { EmailService } from './email/service.js';
import { createProduceHandler } from './orchestrator.js';
import type { AppContext } from './context.js';

/** SQLite-backed AI usage accounting (also the source of the daily call/token limits). */
export function sqliteUsageStore(db: Db): UsageStore {
  return {
    insert(rec) {
      db.prepare('INSERT INTO ai_usage (id, ts, role, model, input_tokens, output_tokens, ok, error, project_id) VALUES (?,?,?,?,?,?,?,?,?)').run(
        rec.id, rec.ts, rec.role, rec.model, rec.inputTokens, rec.outputTokens, rec.ok ? 1 : 0, rec.error?.slice(0, 500) ?? null, rec.projectId ?? null,
      );
    },
    todayTotals() {
      const day = new Date().toISOString().slice(0, 10);
      const r = db.prepare("SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens FROM ai_usage WHERE substr(ts, 1, 10) = ?").get(day) as Row;
      return { calls: Number(r.calls), tokens: Number(r.tokens) };
    },
    recent(limit) {
      return (db.prepare('SELECT * FROM ai_usage ORDER BY ts DESC LIMIT ?').all(limit) as Row[]).map(
        (r): UsageRecord => ({ id: r.id, ts: r.ts, role: r.role, model: r.model, inputTokens: r.input_tokens, outputTokens: r.output_tokens, ok: !!r.ok, error: r.error ?? undefined, projectId: r.project_id ?? undefined }),
      );
    },
  };
}

export interface Overrides {
  ai?: AiService;
  video?: VideoEngine;
  db?: Db;
  fetchImpl?: typeof fetch;
  jobOptions?: ConstructorParameters<typeof JobRunner>[1];
}

export function createContext(config: AppConfig, overrides: Overrides = {}): AppContext {
  for (const dir of Object.values(config.paths)) if (!dir.endsWith('.db')) fs.mkdirSync(dir, { recursive: true });
  const db = overrides.db ?? openDb(config.paths.db);
  const usage = sqliteUsageStore(db);
  const ai = overrides.ai ?? createAiService({ config, usage });
  const video = overrides.video ?? createVideoEngine(resolveBinaries());
  const jobs = new JobRunner(db, overrides.jobOptions);
  const n8n = new N8nBridge(config.n8n, db, overrides.fetchImpl);
  const email = new EmailService(config, db, overrides.fetchImpl);
  const ctx: AppContext = { config, db, ai, video, jobs, n8n, email };
  jobs.register('produce_version', createProduceHandler(ctx));
  // Leftover scratch from an interrupted run is ours to clear (work/ only ever holds temp render files).
  fs.rmSync(config.paths.work, { recursive: true, force: true });
  fs.mkdirSync(config.paths.work, { recursive: true });
  return ctx;
}
