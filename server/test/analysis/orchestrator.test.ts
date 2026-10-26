/**
 * Orchestrator-level tests: real HTTP layer, job queue, SQLite, FFmpeg; the Anthropic client is a scripted fake.
 * Proves the "analyzing" stage, per-version analysis summary truthfulness, caching across revisions, and that analysis
 * problems never fail a draft.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { generateAnalysisFootage, type AnalysisFootage } from '../../../scripts/make-test-footage.js';
import { loadConfig } from '../../src/config.js';
import { sqliteUsageStore } from '../../src/bootstrap.js';
import { openDb } from '../../src/db/index.js';
import { createAiService } from '../../src/ai/index.js';
import { FakeClient, httpError, noSleep, toolUse } from '../ai/helpers.js';
import { makeTestApp, waitForVersion, type TestApp } from '../api/helpers.js';

let f: AnalysisFootage;
const apps: TestApp[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});
beforeAll(async () => {
  f = await generateAnalysisFootage(path.join(os.tmpdir(), 'amir-sm-an-footage-orch'), { reuse: true, only: ['cut', 'shaky'] });
}, 120_000);

const textOf = (params: any) => {
  const c = params.messages[0].content;
  return typeof c === 'string' ? c : JSON.stringify(c);
};

/** answers each tool the way a well-behaved model would, based on the ids it finds in the request */
function respondByTool(params: any) {
  const tool = params.tools.at(-1).name as string;
  const text = textOf(params);
  if (tool === 'submit_clip_analyses') {
    const ids = [...text.matchAll(/assetId: \\"([^\\"]+)\\"/g)].map((m) => m[1]!);
    return toolUse(
      tool,
      { clips: ids.map((id) => ({ assetId: id, summary: 'Test pattern frames with colour bars.', tags: ['test-pattern'], moments: [{ startMs: 1000, endMs: 3000, description: 'Colour bars.', score: 0.7, issues: [] }] })) },
      { input_tokens: 8000, output_tokens: 600 },
    );
  }
  if (tool === 'submit_edit_plan') {
    const ids = [...text.matchAll(/- id="([^"]+)" name=/g)].map((m) => m[1]!);
    return toolUse(tool, {
      rationale: 'Two clips, simple cuts.',
      plan: { version: 1, summary: 'Two clips', segments: ids.slice(0, 2).map((id, i) => ({ id: `s${i + 1}`, assetId: id, startMs: 500, endMs: 3500 })) },
    });
  }
  if (tool === 'submit_caption') return toolUse(tool, { hook: 'A quick test edit', body: 'Two clips cut together.', cta: '', hashtags: ['test'] });
  if (tool === 'submit_review') return toolUse(tool, { issues: [] });
  throw new Error(`unexpected tool ${tool}`);
}

async function appWithAi(script: ConstructorParameters<typeof FakeClient>[0], env: Record<string, string> = {}) {
  const db = openDb(':memory:');
  const config = loadConfig({ DATA_DIR: os.tmpdir(), ANTHROPIC_API_KEY: 'test-key-not-real', ...env } as NodeJS.ProcessEnv, { readDotEnv: false });
  const client = new FakeClient(script);
  const ai = createAiService({ config, usage: sqliteUsageStore(db), client, sleep: noSleep, retryBackoffMs: 0 });
  const t = await makeTestApp({ overrides: { ai, db } });
  apps.push(t);
  return { t, client, db };
}

async function newProject(t: TestApp, preset = 'high-energy') {
  const p = (await t.api('POST', '/api/projects', { title: 'Analysis test', brief: 'Fast driving edit', stylePreset: preset })).json.project.id as string;
  const up = await t.upload(p, [
    { name: 'cut.mp4', data: fs.readFileSync(f.cut) },
    { name: 'shaky.mp4', data: fs.readFileSync(f.shaky) },
  ]);
  expect(up.json.results.every((r: any) => r.ok)).toBe(true);
  return p;
}
const calls = (client: FakeClient, tool: string) => client.calls.filter((c) => c.params.tools.at(-1).name === tool);

describe('no API key: technical analysis only, labelled honestly', () => {
  it('measures the clips, caches them, uses them in the Basic auto-edit and says visual:false', async () => {
    const t = await makeTestApp();
    apps.push(t);
    const p = await newProject(t);
    const r = await t.api('POST', `/api/projects/${p}/versions`, {});
    const v = await waitForVersion(t, r.json.id, ['ready', 'failed']);
    expect(v.error).toBeNull();
    expect(v.status).toBe('ready');
    expect(v.planSource).toBe('rules');

    expect(v.analysis).toMatchObject({ visual: false, technical: true, framesAnalyzed: 0 });
    expect(v.analysis.clips.map((c: any) => c.name)).toEqual(['cut.mp4', 'shaky.mp4']);
    expect(v.analysis.clips.every((c: any) => c.summary === null && c.tags.length === 0 && c.moments.length === 0)).toBe(true);
    expect(v.analysis.clips.find((c: any) => c.name === 'shaky.mp4').technicalIssues).toContain('shaky camera');
    expect(v.analysis.notes.join(' ')).toMatch(/API key is not configured/);
    expect(v.planNotes.join(' ')).toMatch(/no AI interpreted your brief|does not know what is in the shots/);

    const rows = t.ctx.db.prepare('SELECT asset_id, kind, analyzer_version FROM clip_analyses ORDER BY kind').all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows.every((x) => x.kind === 'technical' && x.analyzer_version === 'tech-1')).toBe(true);
    expect(t.ctx.db.prepare('SELECT COUNT(*) AS n FROM ai_usage').get()).toMatchObject({ n: 0 });
    // the job passed through the new stage on its way (stage is overwritten later, but progress bands are persisted per report)
    const job = t.ctx.db.prepare('SELECT stage, progress FROM jobs WHERE version_id = ?').get(v.id) as any;
    expect(job.progress).toBe(1);
  });

  it('the job reports the "analyzing" stage with progress inside 0.02-0.20', async () => {
    const t = await makeTestApp();
    apps.push(t);
    const p = await newProject(t);
    const seen: { stage: string; progress: number }[] = [];
    const orig = t.ctx.db.prepare.bind(t.ctx.db);
    // observe job progress rows as they are written
    const timer = setInterval(() => {
      const row = orig('SELECT stage, progress FROM jobs ORDER BY created_at DESC LIMIT 1').get() as any;
      if (row?.stage) seen.push({ stage: row.stage, progress: row.progress });
    }, 5);
    const r = await t.api('POST', `/api/projects/${p}/versions`, {});
    await waitForVersion(t, r.json.id, ['ready', 'failed']);
    clearInterval(timer);
    const analyzing = seen.filter((s) => s.stage === 'analyzing');
    expect(analyzing.length).toBeGreaterThan(0);
    for (const s of analyzing) {
      expect(s.progress).toBeGreaterThanOrEqual(0.02);
      expect(s.progress).toBeLessThanOrEqual(0.2);
    }
    const order = ['analyzing', 'planning', 'validating', 'rendering', 'captioning', 'reviewing'];
    const idx = seen.map((s) => order.indexOf(s.stage)).filter((i) => i >= 0);
    expect(idx).toEqual([...idx].sort((a, b) => a - b)); // stages never go backwards
  });
});

describe('with a (fake) model: visual analysis reaches the planner and the caption, revisions reuse the cache', () => {
  it('first draft: one vision call, analyses persisted, planner + caption prompts carry them with provenance', async () => {
    const { t, client, db } = await appWithAi([respondByTool]);
    const p = await newProject(t);
    const r = await t.api('POST', `/api/projects/${p}/versions`, {});
    const v = await waitForVersion(t, r.json.id, ['ready', 'failed']);
    expect(v.error).toBeNull();
    expect(v.status).toBe('ready');
    expect(v.planSource).toBe('ai');

    expect(calls(client, 'submit_clip_analyses')).toHaveLength(1);
    expect(v.analysis.visual).toBe(true);
    expect(v.analysis.technical).toBe(true);
    expect(v.analysis.framesAnalyzed).toBeGreaterThanOrEqual(8); // 2 clips x >= 4 stills
    expect(v.analysis.clips.every((c: any) => c.summary === 'Test pattern frames with colour bars.' && c.tags[0] === 'test-pattern')).toBe(true);
    expect(v.analysis.clips[0].moments[0]).toMatchObject({ startMs: expect.any(Number), endMs: expect.any(Number), score: 0.7 });

    // images really went out, sampled by the real engine
    const visionReq = calls(client, 'submit_clip_analyses')[0]!.params;
    const images = (visionReq.messages[0].content as any[]).filter((b) => b.type === 'image');
    expect(images.length).toBe(v.analysis.framesAnalyzed);
    expect(Buffer.from(images[0].source.data, 'base64').subarray(0, 3).toString('hex')).toBe('ffd8ff');

    const planReq = textOf(calls(client, 'submit_edit_plan')[0]!.params);
    expect(planReq).toContain('<clip_analysis');
    expect(planReq).toMatch(/VISUAL \[Claude looked at a few SAMPLED STILLS/);
    expect(planReq).toMatch(/TECHNICAL \[signal measurements only/);
    expect(planReq).toContain('Test pattern frames with colour bars.');
    const capReq = textOf(calls(client, 'submit_caption')[0]!.params);
    expect(capReq).toContain('<what_the_editor_saw');
    expect(capReq).toContain('Test pattern frames with colour bars.');
    expect(capReq).not.toMatch(/technically strong|shaky camera/); // measurements are never "seen"

    const usage = db.prepare("SELECT role, ok FROM ai_usage ORDER BY ts").all() as any[];
    expect(usage.map((u) => u.role)).toContain('vision');
    expect(db.prepare('SELECT COUNT(*) AS n FROM clip_analyses WHERE kind = ?').get('visual')).toMatchObject({ n: 2 });
  });

  it('a revision reuses both caches: no new vision call, no new frames, analysis still reports visual:true', async () => {
    const { t, client } = await appWithAi([respondByTool]);
    const p = await newProject(t);
    const v1 = await waitForVersion(t, (await t.api('POST', `/api/projects/${p}/versions`, {})).json.id, ['ready', 'failed']);
    expect(v1.status).toBe('ready');
    const visionBefore = calls(client, 'submit_clip_analyses').length;
    const tracked = t.ctx.video.sampleFrames;
    let sampled = 0;
    t.ctx.video.sampleFrames = (...a: Parameters<typeof tracked>) => {
      sampled++;
      return tracked.apply(t.ctx.video, a);
    };
    const r2 = await t.api('POST', `/api/projects/${p}/versions`, { instruction: 'Make the first shot shorter' });
    expect(r2.status).toBe(201);
    const v2 = await waitForVersion(t, r2.json.id, ['ready', 'failed']);
    expect(v2.status).toBe('ready');
    expect(calls(client, 'submit_clip_analyses')).toHaveLength(visionBefore);
    expect(sampled).toBe(0);
    expect(v2.analysis.visual).toBe(true);
    expect(v2.analysis.framesAnalyzed).toBe(v1.analysis.framesAnalyzed);
    // and the revision's planner prompt still carries the analyses
    const lastPlan = textOf(calls(client, 'submit_edit_plan').at(-1)!.params);
    expect(lastPlan).toContain('<clip_analysis');
    expect(lastPlan).toContain('<revision_request>');
  });
});

describe('analysis problems never fail a draft', () => {
  it('daily call limit reached: draft succeeds with technical-only analysis and a visible reason', async () => {
    const { t, client } = await appWithAi([respondByTool], { AI_DAILY_CALL_LIMIT: '0' });
    const p = await newProject(t);
    const v = await waitForVersion(t, (await t.api('POST', `/api/projects/${p}/versions`, {})).json.id, ['ready', 'failed']);
    expect(v.status).toBe('ready');
    expect(v.planSource).toBe('rules'); // planning fell back too (limit), still labelled
    expect(client.calls).toHaveLength(0);
    expect(v.analysis).toMatchObject({ visual: false, technical: true, framesAnalyzed: 0 });
    expect(v.analysis.notes.join(' ')).toMatch(/call limit is reached/);
  });

  it('a rejected key during vision analysis: technical-only, reason recorded, draft still renders', async () => {
    const { t } = await appWithAi([httpError(401)]);
    const p = await newProject(t);
    const v = await waitForVersion(t, (await t.api('POST', `/api/projects/${p}/versions`, {})).json.id, ['ready', 'failed']);
    expect(v.status).toBe('ready');
    expect(v.analysis.visual).toBe(false);
    expect(v.analysis.technical).toBe(true);
    expect(v.analysis.notes.join(' ')).toMatch(/API key rejected/);
  });

  it('malformed vision output (twice): technical-only, planner still runs and receives no visual claims', async () => {
    const bad = toolUse('submit_clip_analyses', { garbage: 1 });
    const script = [(params: any) => (params.tools.at(-1).name === 'submit_clip_analyses' ? bad : respondByTool(params))];
    const { t, client } = await appWithAi(script);
    const p = await newProject(t);
    const v = await waitForVersion(t, (await t.api('POST', `/api/projects/${p}/versions`, {})).json.id, ['ready', 'failed']);
    expect(v.status).toBe('ready');
    expect(v.analysis.visual).toBe(false);
    expect(v.analysis.notes.join(' ')).toMatch(/could not be used/);
    expect(calls(client, 'submit_clip_analyses')).toHaveLength(2); // original + one repair
    const planReq = textOf(calls(client, 'submit_edit_plan')[0]!.params);
    expect(planReq).toMatch(/VISUAL: not analysed/);
    expect(planReq).not.toContain('Test pattern frames');
    expect(textOf(calls(client, 'submit_caption')[0]!.params)).not.toContain('what_the_editor_saw');
  });

  it('a clip that cannot be measured is reported, the other clips still are, and the draft renders', async () => {
    const t = await makeTestApp();
    apps.push(t);
    const p = await newProject(t);
    const orig = t.ctx.video.technicalProfile;
    t.ctx.video.technicalProfile = async (file, info, o) => {
      if (file.includes('shaky') || (await fs.promises.stat(file)).size < 500_000) throw new Error('measurement exploded');
      return orig.call(t.ctx.video, file, info, o);
    };
    const v = await waitForVersion(t, (await t.api('POST', `/api/projects/${p}/versions`, {})).json.id, ['ready', 'failed']);
    expect(v.status).toBe('ready');
    expect(v.analysis.notes.join(" ")).toMatch(/Technical measurements failed for \d+ clip/);
    expect(v.analysis.technical).toBe(true);
  });

  it('versions created before analysis existed expose analysis: null', async () => {
    const t = await makeTestApp();
    apps.push(t);
    const p = await newProject(t);
    const v = await waitForVersion(t, (await t.api('POST', `/api/projects/${p}/versions`, {})).json.id, ['ready', 'failed']);
    t.ctx.db.prepare('UPDATE versions SET analysis_json = NULL WHERE id = ?').run(v.id);
    expect((await t.api('GET', `/api/versions/${v.id}`)).json.analysis).toBeNull();
    t.ctx.db.prepare("UPDATE versions SET analysis_json = '{not json' WHERE id = ?").run(v.id);
    expect((await t.api('GET', `/api/versions/${v.id}`)).json.analysis).toBeNull();
  });
});
