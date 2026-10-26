import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { loadConfig, type AppConfig } from '../../src/config.js';
import { createContext, type Overrides } from '../../src/bootstrap.js';
import { buildApp } from '../../src/app.js';
import type { AppContext } from '../../src/context.js';
import { generateTestFootage, type TestFootage } from '../../../scripts/make-test-footage.js';

export const TEST_PASSWORD = 'correct-horse-battery';

export interface TestApp {
  app: FastifyInstance;
  ctx: AppContext;
  config: AppConfig;
  dir: string;
  cookie: string;
  api: (method: string, url: string, body?: unknown) => Promise<{ status: number; json: any; headers: Record<string, any>; raw: Buffer }>;
  upload: (projectId: string, files: { name: string; data: Buffer; type?: string }[]) => Promise<{ status: number; json: any }>;
  close: () => Promise<void>;
}

export async function makeTestApp(opts: { env?: Record<string, string>; overrides?: Overrides; login?: boolean } = {}): Promise<TestApp> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amir-sm-test-'));
  const config = loadConfig({ DATA_DIR: dir, ...opts.env } as NodeJS.ProcessEnv, { readDotEnv: false });
  // loadConfig resolves DATA_DIR against cwd; the temp dir is absolute so it stays put.
  const ctx = createContext(config, { jobOptions: { pollMs: 50, backoffMs: () => 50 }, ...opts.overrides });
  const app = await buildApp(ctx);
  await app.ready();
  ctx.jobs.start();
  const t: TestApp = {
    app, ctx, config, dir, cookie: '',
    async api(method, url, body) {
      const res = await app.inject({
        method: method as any, url, headers: { host: 'localhost:4300', ...(t.cookie ? { cookie: t.cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        payload: body !== undefined ? JSON.stringify(body) : undefined,
      });
      let json: any = null;
      try { json = JSON.parse(res.body); } catch { /* not json */ }
      return { status: res.statusCode, json, headers: res.headers, raw: res.rawPayload };
    },
    async upload(projectId, files) {
      const boundary = '----amirsm' + Math.random().toString(16).slice(2);
      const chunks: Buffer[] = [];
      for (const f of files) {
        chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${f.name}"\r\nContent-Type: ${f.type ?? 'application/octet-stream'}\r\n\r\n`), f.data, Buffer.from('\r\n'));
      }
      chunks.push(Buffer.from(`--${boundary}--\r\n`));
      const res = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/assets`, headers: { host: 'localhost:4300', cookie: t.cookie, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat(chunks) });
      return { status: res.statusCode, json: JSON.parse(res.body) };
    },
    async close() {
      await ctx.jobs.stop();
      await app.close();
      ctx.db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  if (opts.login !== false) {
    const res = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: { host: 'localhost:4300', 'content-type': 'application/json' }, payload: JSON.stringify({ password: TEST_PASSWORD }) });
    if (res.statusCode !== 200) throw new Error('setup failed ' + res.body);
    const sc = res.headers['set-cookie'];
    t.cookie = String(Array.isArray(sc) ? sc[0] : sc).split(';')[0]!;
  }
  return t;
}

let footage: TestFootage | null = null;
export async function sharedFootage(): Promise<TestFootage> {
  if (!footage) footage = await generateTestFootage(path.join(os.tmpdir(), 'amir-sm-test-footage'), { reuse: true });
  return footage;
}

export async function waitForVersion(t: TestApp, versionId: string, statuses: string[], timeoutMs = 120_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const r = await t.api('GET', `/api/versions/${versionId}`);
    if (statuses.includes(r.json.status)) return r.json;
    if (Date.now() > end) throw new Error(`timed out waiting for ${statuses}; last status ${r.json.status} (${r.json.error ?? ''})`);
    await new Promise((res) => setTimeout(res, 100));
  }
}
