import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTestApp, type TestApp } from './helpers.js';

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
    expect(acc.label).toBe('Sample mailbox — fictional messages');
    expect(acc).toMatchObject({ provider: 'fixture', presetId: null, syncState: 'ok', lastError: null, imapHost: null });
    const all = (await t.api('GET', '/api/email/threads')).json;
    expect(all.length).toBeGreaterThanOrEqual(4);
    const hit = (await t.api('GET', '/api/email/threads?q=invoice')).json;
    expect(hit.length).toBe(1);
    const thread = (await t.api('GET', `/api/email/threads/${threadId}`)).json;
    expect(thread.messages.length).toBeGreaterThan(0);
  });

  it('reports the sample mailbox truthfully in Settings, lists presets, and has no attachments to download', async () => {
    const status = (await t.api('GET', '/api/settings/status')).json;
    expect(status.integrations.find((i: { id: string }) => i.id === 'email')).toMatchObject({ state: 'fixture', detail: expect.stringMatching(/fictional/) });
    expect((await t.api('GET', '/api/email/providers')).json.some((p: { id: string }) => p.id === 'gmail')).toBe(true);
    expect((await t.api('GET', '/api/email/attachments/att_nothing')).status).toBe(404);
    expect((await t.api('POST', `/api/email/accounts/${accountId}/sync`, { wait: true })).json).toMatchObject({ isFixture: true, syncState: 'ok' });
  });

  it('opening a sample thread marks it read and unread again', async () => {
    const unread = (await t.api('GET', '/api/email/threads?filter=unread')).json[0];
    expect((await t.api('POST', `/api/email/threads/${unread.id}/read`, { read: true })).json.unread).toBe(false);
    expect((await t.api('POST', `/api/email/threads/${unread.id}/read`, { read: false })).json.unread).toBe(true);
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
