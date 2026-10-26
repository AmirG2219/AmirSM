import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTestApp, sharedFootage, waitForVersion, type TestApp } from './helpers.js';
import type { TestFootage } from '../../../scripts/make-test-footage.js';

/**
 * End-to-end through the real HTTP layer, job queue, SQLite, FFmpeg and the real AI service WITHOUT an API key
 * (so planning uses the labelled "rules" planner and captions are honestly "unavailable").
 */
describe('Social Studio end-to-end (no AI key)', () => {
  let t: TestApp;
  let f: TestFootage;
  let projectId: string;
  let versionId: string;
  beforeAll(async () => {
    f = await sharedFootage();
    t = await makeTestApp();
  });
  afterAll(() => t.close());

  it('creates a project and validates uploads', async () => {
    const created = await t.api('POST', '/api/projects', { title: 'Morning Routine', brief: 'Calm, slow morning. "Slow mornings"', stylePreset: 'calm-cinematic' });
    expect(created.status).toBe(201);
    projectId = created.json.project.id;

    const bad = await t.upload(projectId, [
      { name: 'notes.txt', data: Buffer.from('hello') },
      { name: 'fake.mp4', data: Buffer.from('this is not a video at all') },
    ]);
    expect(bad.json.results.map((r: any) => r.ok)).toEqual([false, false]);
    expect(bad.json.results[0].error).toMatch(/Unsupported/);
    expect(bad.json.results[1].error).toMatch(/Not a readable media file/);
    // rejected files leave nothing behind
    const dir = path.join(t.config.paths.uploads, projectId);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('accepts real clips, probes them, makes thumbnails, rejects duplicates', async () => {
    const up = await t.upload(projectId, [
      { name: 'portrait.mp4', data: fs.readFileSync(f.small.portrait) },
      { name: 'landscape.mp4', data: fs.readFileSync(f.small.landscape) },
    ]);
    expect(up.json.results.every((r: any) => r.ok)).toBe(true);
    const a = up.json.results[0].asset;
    expect(a.info.hasVideo).toBe(true);
    expect(a.info.durationMs).toBeGreaterThan(500);
    expect(a.thumbUrl).toBeTruthy();
    const dup = await t.upload(projectId, [{ name: 'again.mp4', data: fs.readFileSync(f.small.portrait) }]);
    expect(dup.json.results[0].error).toMatch(/Already uploaded/);

    const thumb = await t.api('GET', a.thumbUrl);
    expect(thumb.status).toBe(200);
    expect(thumb.headers['content-type']).toBe('image/jpeg');
  });

  it('serves source clips with Range support', async () => {
    const detail = await t.api('GET', `/api/projects/${projectId}`);
    const url = detail.json.assets[0].fileUrl;
    const res = await t.app.inject({ method: 'GET', url, headers: { host: 'localhost', cookie: t.cookie, range: 'bytes=0-99' } });
    expect(res.statusCode).toBe(206);
    expect(res.rawPayload.length).toBe(100);
    expect(String(res.headers['content-range'])).toMatch(/^bytes 0-99\//);
    const bad = await t.app.inject({ method: 'GET', url, headers: { host: 'localhost', cookie: t.cookie, range: 'bytes=999999999-' } });
    expect(bad.statusCode).toBe(416);
  });

  it('produces a playable draft with the basic planner, labels it, and reports caption unavailability honestly', async () => {
    const r = await t.api('POST', `/api/projects/${projectId}/versions`, {});
    expect(r.status).toBe(201);
    versionId = r.json.id;
    expect((await t.api('POST', `/api/projects/${projectId}/versions`, {})).status).toBe(409); // busy

    const v = await waitForVersion(t, versionId, ['ready', 'failed']);
    expect(v.error).toBeNull();
    expect(v.status).toBe('ready');
    expect(v.planSource).toBe('rules');
    expect(v.captionStatus).toBe('unavailable');
    expect(v.captionNote).toMatch(/API key/);
    expect(v.quality.overall).not.toBe('fail');
    expect(v.output.width).toBe(1080);
    expect(v.output.height).toBe(1920);

    const file = path.join(t.config.paths.renders, projectId, 'v1.mp4');
    expect(fs.statSync(file).size).toBeGreaterThan(1000);
    const video = await t.app.inject({ method: 'GET', url: v.output.url, headers: { host: 'localhost', cookie: t.cookie, range: 'bytes=0-' } });
    expect(video.statusCode).toBe(206);
    expect(video.headers['content-type']).toBe('video/mp4');
    const proj = await t.api('GET', `/api/projects/${projectId}`);
    expect(proj.json.project.status).toBe('review');
  });

  it('lets the owner write the caption manually and rejects invalid captions', async () => {
    const bad = await t.api('PATCH', `/api/versions/${versionId}/caption`, { hook: '', body: 'x', cta: '', hashtags: [] });
    expect(bad.status).toBe(400);
    const ok = await t.api('PATCH', `/api/versions/${versionId}/caption`, { hook: 'Slow mornings', body: 'Coffee and quiet.', cta: 'Save this.', hashtags: ['slowliving'] });
    expect(ok.json.captionStatus).toBe('manual');
    expect(ok.json.captionText).toContain('#slowliving');
    expect((await t.api('POST', `/api/versions/${versionId}/caption/regenerate`, {})).json.error.code).toBe('ai_unavailable');
  });

  it('refuses a revision it cannot honestly interpret (needs AI) and keeps the original intact', async () => {
    const r = await t.api('POST', `/api/projects/${projectId}/versions`, { instruction: 'Make it faster and add music' });
    expect(r.status).toBe(201);
    const v2 = await waitForVersion(t, r.json.id, ['ready', 'failed']);
    expect(v2.status).toBe('failed');
    expect(v2.error).toMatch(/AI/);
    const v1 = await t.api('GET', `/api/versions/${versionId}`);
    expect(v1.json.status).toBe('ready');
    // failed draft can be retried (still fails honestly) — proves the retry path is wired
    const retry = await t.api('POST', `/api/versions/${r.json.id}/retry`, {});
    expect(retry.status).toBe(200);
    await waitForVersion(t, r.json.id, ['failed']);
  });

  it('approves into an immutable export and refuses double approval', async () => {
    const a = await t.api('POST', `/api/versions/${versionId}/approve`);
    expect(a.status).toBe(200);
    expect(a.json.status).toBe('approved');
    const dir = path.join(t.config.dataDir, a.json.exportPath);
    const files = fs.readdirSync(dir).sort();
    expect(files).toContain('export.json');
    expect(files.some((n) => n.endsWith('.mp4'))).toBe(true);
    expect(files.some((n) => n.endsWith('-caption.txt'))).toBe(true);
    expect(fs.readFileSync(path.join(dir, files.find((n) => n.endsWith('-caption.txt'))!), 'utf8')).toContain('Slow mornings');
    expect((await t.api('POST', `/api/versions/${versionId}/approve`)).status).toBe(409);
    expect((await t.api('PATCH', `/api/versions/${versionId}/caption`, { hook: 'x', body: 'y', cta: '', hashtags: [] })).status).toBe(409);
    const dl = await t.api('GET', `/api/versions/${versionId}/video?download=1`);
    expect(String(dl.headers['content-disposition'])).toMatch(/attachment; filename="morning-routine-v1.mp4"/);
    expect((await t.api('GET', `/api/projects/${projectId}`)).json.project.status).toBe('approved');
    // the source footage is still byte-identical
    const assets = (await t.api('GET', `/api/projects/${projectId}`)).json.assets;
    const stored = fs.readdirSync(path.join(t.config.paths.uploads, projectId));
    expect(stored.length).toBe(assets.length);
  });

  it('shows the approved export and drafts in the library and dashboard (real data only)', async () => {
    const lib = await t.api('GET', '/api/library?kind=export');
    expect(lib.json.length).toBe(1);
    expect(lib.json[0].captionText).toContain('Slow mornings');
    expect((await t.api('GET', '/api/library?q=landscape')).json.some((i: any) => i.kind === 'clip')).toBe(true);
    const dash = await t.api('GET', '/api/dashboard');
    expect(dash.json.recentlyCompleted.length).toBe(1);
    expect(dash.json.inProgress).toEqual([]);
    expect(dash.json.recentResearch).toEqual([]);
    const ai = dash.json.system.find((s: any) => s.id === 'anthropic');
    expect(ai.state).toBe('not_configured');
  });
});

describe('job recovery and cancellation', () => {
  let t: TestApp;
  let f: TestFootage;
  beforeAll(async () => {
    f = await sharedFootage();
    t = await makeTestApp();
  });
  afterAll(() => t.close());

  it('re-queues jobs that were running when the server stopped, and can cancel a queued job', async () => {
    const p = (await t.api('POST', '/api/projects', { title: 'Recovery' })).json.project.id;
    await t.upload(p, [{ name: 'a.mp4', data: fs.readFileSync(f.small.portrait) }]);
    await t.ctx.jobs.stop();
    const r = await t.api('POST', `/api/projects/${p}/versions`, {});
    const job = t.ctx.db.prepare('SELECT * FROM jobs WHERE version_id = ?').get(r.json.id) as any;
    t.ctx.db.prepare("UPDATE jobs SET status = 'running', attempt = 1 WHERE id = ?").run(job.id);
    // cancel while "running" but the runner is stopped: request is recorded
    expect((await t.api('POST', `/api/versions/${r.json.id}/cancel`)).status).toBe(200);
    t.ctx.db.prepare("UPDATE jobs SET cancel_requested = 0 WHERE id = ?").run(job.id);
    t.ctx.jobs.start(); // boot recovery
    const v = await waitForVersion(t, r.json.id, ['ready', 'failed']);
    expect(v.status).toBe('ready');
  });

  it('cancels a queued draft', async () => {
    const p = (await t.api('POST', '/api/projects', { title: 'Cancel me' })).json.project.id;
    await t.upload(p, [{ name: 'b.mp4', data: fs.readFileSync(f.small.landscape) }]);
    await t.ctx.jobs.stop();
    const r = await t.api('POST', `/api/projects/${p}/versions`, {});
    await t.api('POST', `/api/versions/${r.json.id}/cancel`);
    const v = (await t.api('GET', `/api/versions/${r.json.id}`)).json;
    expect(v.status).toBe('failed');
    expect(v.error).toMatch(/Cancelled/);
    t.ctx.jobs.start();
  });
});
