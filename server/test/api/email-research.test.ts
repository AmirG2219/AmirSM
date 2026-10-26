import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTestApp, type TestApp } from './helpers.js';
import { ResendProvider } from '../../src/email/service.js';

describe('email workspace (sample mailbox)', () => {
  let t: TestApp;
  let accountId: string;
  let threadId: string;
  beforeAll(async () => {
    t = await makeTestApp();
    accountId = (await t.api('GET', '/api/email/accounts')).json[0].id;
    threadId = (await t.api('GET', '/api/email/threads?filter=needs_reply')).json[0].id;
  });
  afterAll(() => t.close());

  it('labels the mailbox as a local sample and lists/searches threads', async () => {
    const acc = (await t.api('GET', '/api/email/accounts')).json[0];
    expect(acc.isFixture).toBe(true);
    expect(acc.label).toMatch(/sample/i);
    const all = (await t.api('GET', '/api/email/threads')).json;
    expect(all.length).toBeGreaterThanOrEqual(4);
    const hit = (await t.api('GET', '/api/email/threads?q=invoice')).json;
    expect(hit.length).toBe(1);
    const thread = (await t.api('GET', `/api/email/threads/${threadId}`)).json;
    expect(thread.messages.length).toBeGreaterThan(0);
  });

  it('AI helpers fail truthfully without an API key', async () => {
    const r = await t.api('POST', `/api/email/threads/${threadId}/summarize`);
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('ai_unavailable');
    expect((await t.api('POST', '/api/email/ai/draft', { instruction: 'Say yes politely' })).status).toBe(409);
  });

  it('never sends without approval, and editing after approval invalidates it', async () => {
    const d = (await t.api('POST', '/api/email/drafts', { accountId, threadId, to: ['sam@friend.example.com'], subject: 'Re: Saturday', body: '9am works.' })).json;
    expect((await t.api('POST', `/api/email/drafts/${d.id}/send`)).json.error.code).toBe('not_approved');
    expect((await t.api('POST', `/api/email/drafts/${d.id}/approve`)).json.status).toBe('approved');
    const edited = (await t.api('PATCH', `/api/email/drafts/${d.id}`, { body: '9am works. Bring the second camera?' })).json;
    expect(edited.status).toBe('draft');
    expect((await t.api('POST', `/api/email/drafts/${d.id}/send`)).status).toBe(409);
    await t.api('POST', `/api/email/drafts/${d.id}/approve`);
    // simulate tampering in the database after approval
    t.ctx.db.prepare('UPDATE email_drafts SET body = ? WHERE id = ?').run('tampered', d.id);
    expect((await t.api('POST', `/api/email/drafts/${d.id}/send`)).json.error.code).toBe('changed_since_approval');
  });

  it('records a sample-mailbox send as NOT delivered', async () => {
    const d = (await t.api('POST', '/api/email/drafts', { accountId, threadId, to: ['sam@friend.example.com'], subject: 'Re: Saturday', body: 'See you at 9.' })).json;
    await t.api('POST', `/api/email/drafts/${d.id}/approve`);
    const sent = await t.api('POST', `/api/email/drafts/${d.id}/send`);
    expect(sent.status).toBe(200);
    expect(sent.json.status).toBe('sent');
    expect(sent.json.sendResult.delivered).toBe(false);
    expect(sent.json.sendResult.note).toMatch(/NOT delivered/);
    expect((await t.api('POST', `/api/email/drafts/${d.id}/send`)).status).toBe(409);
  });

  it('validates recipients', async () => {
    const r = await t.api('POST', '/api/email/drafts', { accountId, to: ['not-an-email'], subject: 's', body: 'b' });
    expect(r.status).toBe(400);
  });
});

describe('Resend adapter (mocked HTTP — not verified against the live API)', () => {
  it('posts the approved message and surfaces API errors', async () => {
    const calls: any[] = [];
    const ok = new ResendProvider('re_test', 'Me <me@example.com>', (async (url: string, init: any) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: 'abc' }), { status: 200 });
    }) as any);
    const r = await ok.send({ from: 'x', to: ['a@example.com'], cc: [], subject: 'S', body: 'B' });
    expect(r).toMatchObject({ delivered: true, externalId: 'abc' });
    expect(calls[0].url).toBe('https://api.resend.com/emails');
    expect(calls[0].init.headers.authorization).toBe('Bearer re_test');
    expect(JSON.parse(calls[0].init.body).to).toEqual(['a@example.com']);

    const bad = new ResendProvider('re_test', 'me@example.com', (async () => new Response(JSON.stringify({ message: 'domain not verified' }), { status: 403 })) as any);
    await expect(bad.send({ from: 'x', to: ['a@example.com'], cc: [], subject: 'S', body: 'B' })).rejects.toThrow(/domain not verified/);
  });
});

describe('research workspace', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await makeTestApp();
  });
  afterAll(() => t.close());

  it('reports unavailable capabilities truthfully without a key', async () => {
    const c = (await t.api('GET', '/api/research/capabilities')).json;
    expect(c.competitorAnalysis.available).toBe(false);
    expect(c.marketResearch.available).toBe(false);
    expect(c.marketResearch.reason).toMatch(/research source/i);
  });

  it('stores competitors and notes, searches, and refuses non-http links', async () => {
    const c = (await t.api('POST', '/api/research/competitors', { name: 'Example Creator', handle: '@example', url: 'https://example.com/creator' })).json;
    expect((await t.api('POST', '/api/research/competitors', { name: 'x', url: 'javascript:alert(1)' })).status).toBe(400);
    await t.api('POST', '/api/research/notes', { kind: 'idea', title: 'Golden-hour walk', body: 'Try a slow tracking shot', competitorId: c.id, tags: ['cinematic'] });
    const found = (await t.api('GET', '/api/research/notes?q=tracking')).json;
    expect(found.length).toBe(1);
    expect((await t.api('POST', `/api/research/competitors/${c.id}/analyze`, { materials: [{ label: 'post', text: 'caption text' }] })).json.error.code).toBe('ai_unavailable');
    expect((await t.api('POST', '/api/research/market', { topic: 'calm vlog trends' })).status).toBe(409);
    expect((await t.api('GET', '/api/dashboard')).json.recentResearch.length).toBe(1);
  });
});
