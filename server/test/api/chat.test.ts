import fs from 'node:fs';
import os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTestApp, sharedFootage, waitForVersion, type TestApp } from './helpers.js';
import { openDb } from '../../src/db/index.js';
import { loadConfig } from '../../src/config.js';
import { createAiService } from '../../src/ai/index.js';
import { sqliteUsageStore } from '../../src/bootstrap.js';
import { FakeClient, noSleep, toolUse } from '../ai/helpers.js';

const apps: TestApp[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

describe('Studio chat without AI (basic fallback)', () => {
  it('builds a first draft from the owner\'s message, labels it basic, and refuses to interpret later feedback', async () => {
    const f = await sharedFootage();
    const t = await makeTestApp();
    apps.push(t);
    const p = (await t.api('POST', '/api/projects', { title: 'Chat test' })).json.project.id as string;

    // no footage yet: the agent asks for clips instead of generating
    const none = await t.api('POST', `/api/projects/${p}/chat`, { text: 'Make a calm morning video' });
    expect(none.status).toBe(200);
    expect(none.json.version).toBeNull();
    expect(none.json.source).toBe('basic');
    expect(none.json.messages[1].text).toMatch(/clips first/i);

    // a reference video is stored as a reference, not as footage
    const ref = await t.app.inject({ method: 'GET', url: '/api/health' });
    expect(ref.statusCode).toBe(200);
    const up = await t.upload(p, [{ name: 'clip.mp4', data: fs.readFileSync(f.small.portrait) }]);
    expect(up.json.results[0].ok).toBe(true);
    expect(up.json.results[0].asset.role).toBe('footage');

    const first = await t.api('POST', `/api/projects/${p}/chat`, { text: 'Calm cinematic morning, "Slow mornings"' });
    expect(first.json.version.number).toBe(1);
    expect(first.json.messages[1].versionId).toBe(first.json.version.id);
    expect(first.json.messages[1].text).toMatch(/not connected|basic edit/i);
    const v = await waitForVersion(t, first.json.version.id, ['ready', 'failed']);
    expect(v.status).toBe('ready');
    expect(v.planSource).toBe('rules');

    const later = await t.api('POST', `/api/projects/${p}/chat`, { text: 'Make it faster' });
    expect(later.json.version).toBeNull();
    expect(later.json.messages[1].text).toMatch(/needs the AI/i);

    const history = (await t.api('GET', `/api/projects/${p}/chat`)).json;
    expect(history.map((m: any) => m.role)).toEqual(['user', 'agent', 'user', 'agent', 'user', 'agent']);
  });

  it('rejects attachments from another project and empty messages', async () => {
    const t = await makeTestApp();
    apps.push(t);
    const p = (await t.api('POST', '/api/projects', { title: 'A' })).json.project.id as string;
    expect((await t.api('POST', `/api/projects/${p}/chat`, { text: '   ' })).status).toBe(400);
    expect((await t.api('POST', `/api/projects/${p}/chat`, { text: 'hi', attachmentIds: ['ast_notmine12345'] })).status).toBe(400);
  });
});

describe('Studio chat with a scripted AI director', () => {
  it('lets the director start a draft, then a revision, and keeps reference videos out of the footage', async () => {
    const f = await sharedFootage();
    const db = openDb(':memory:');
    const config = loadConfig({ DATA_DIR: os.tmpdir(), ANTHROPIC_API_KEY: 'test-key-not-real' } as NodeJS.ProcessEnv, { readDotEnv: false });
    const seen: string[] = [];
    const client = new FakeClient([(params: any) => {
      const tool = params.tools.at(-1).name as string;
      const text = JSON.stringify(params.messages);
      if (tool === 'respond') {
        seen.push(text);
        return !/No draft exists yet/.test(text)
          ? toolUse(tool, { reply: 'Tightening the cuts.', action: 'revise', revision: 'Make the cuts faster.' })
          : toolUse(tool, { reply: 'Starting a calm cut.', action: 'generate', brief: 'A calm cinematic morning.', preset: 'calm-cinematic' });
      }
      if (tool === 'submit_clip_analyses') {
        const ids = [...text.matchAll(/assetId: \\"([^\\]+)\\"/g)].map((m) => m[1]!);
        return toolUse(tool, { clips: ids.map((id) => ({ assetId: id, summary: 'Colour bars.', tags: ['test'], moments: [] })) });
      }
      if (tool === 'submit_reference_style') return toolUse(tool, { summary: 'Colour bars.', mood: 'neutral', look: 'saturated', framing: 'full frame', techniques: [], textOnScreen: [], transitions: [] });
      if (tool === 'submit_edit_plan') {
        const ids = [...text.matchAll(/- id=\\"([^\\]+)\\" name=/g)].map((m) => m[1]!);
        return toolUse(tool, { rationale: 'ok', plan: { version: 1, summary: 'One clip', segments: [{ id: 's1', assetId: ids[0], startMs: 500, endMs: 2500 }] } });
      }
      if (tool === 'submit_caption') return toolUse(tool, { hook: 'Hook', body: 'Body', cta: '', hashtags: [] });
      if (tool === 'submit_review') return toolUse(tool, { issues: [] });
      throw new Error(`unexpected tool ${tool}`);
    }]);
    const ai = createAiService({ config, usage: sqliteUsageStore(db), client, sleep: noSleep, retryBackoffMs: 0 });
    const t = await makeTestApp({ overrides: { ai, db } });
    apps.push(t);
    const p = (await t.api('POST', '/api/projects', { title: 'Director' })).json.project.id as string;
    const clip = await t.upload(p, [{ name: 'a.mp4', data: fs.readFileSync(f.small.portrait) }]);
    const refUp = await t.app.inject({
      method: 'POST', url: `/api/projects/${p}/assets?role=reference`,
      headers: { host: 'localhost:4300', cookie: t.cookie, 'content-type': 'multipart/form-data; boundary=XX' },
      payload: Buffer.concat([Buffer.from('--XX\r\nContent-Disposition: form-data; name="files"; filename="ref.mp4"\r\nContent-Type: video/mp4\r\n\r\n'), fs.readFileSync(f.small.landscape), Buffer.from('\r\n--XX--\r\n')]),
    });
    const refAsset = JSON.parse(refUp.body).results[0].asset;
    expect(refAsset.role).toBe('reference');
    expect(clip.json.results[0].ok).toBe(true);

    const r1 = await t.api('POST', `/api/projects/${p}/chat`, { text: 'Make it like my example, calm morning', attachmentIds: [refAsset.id] });
    expect(r1.json.source).toBe('ai');
    expect(r1.json.messages[1].text).toBe('Starting a calm cut.');
    expect(r1.json.version.number).toBe(1);
    expect(r1.json.messages[0].attachments[0].role).toBe('reference');
    await waitForVersion(t, r1.json.version.id, ['ready', 'failed']);

    // only the footage clip is in the plan's assets; the reference never is
    const detail = (await t.api('GET', `/api/projects/${p}`)).json;
    expect(detail.assets.filter((a: any) => a.role === 'footage')).toHaveLength(1);
    expect(detail.versions[0].plan.segments.every((s: any) => s.assetId === clip.json.results[0].asset.id)).toBe(true);
    expect(seen[0]).toContain('reference_notes');

    const r2 = await t.api('POST', `/api/projects/${p}/chat`, { text: 'make it faster please' });
    expect(r2.json.version.number).toBe(2);
    expect(r2.json.version.isRevision).toBe(true);
  });
});
