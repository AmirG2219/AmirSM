import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTestApp, TEST_PASSWORD, type TestApp } from './helpers.js';

describe('auth & request security', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await makeTestApp({ login: false });
  });
  afterAll(() => t.close());

  it('reports setup required, then blocks protected routes until signed in', async () => {
    expect((await t.api('GET', '/api/auth/state')).json).toEqual({ setupRequired: true, authenticated: false });
    expect((await t.api('GET', '/api/projects')).status).toBe(401);
  });

  it('rejects short passwords on setup', async () => {
    const r = await t.api('POST', '/api/auth/setup', { password: 'short' });
    expect(r.status).toBe(400);
  });

  it('sets the owner password once and issues an httpOnly SameSite=Strict cookie', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/setup', headers: { host: 'localhost', 'content-type': 'application/json' }, payload: JSON.stringify({ password: TEST_PASSWORD }) });
    expect(res.statusCode).toBe(200);
    const sc = String(res.headers['set-cookie']);
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/SameSite=Strict/i);
    t.cookie = sc.split(';')[0]!;
    expect((await t.api('POST', '/api/auth/setup', { password: 'another-long-password' })).status).toBe(409);
    expect((await t.api('GET', '/api/projects')).status).toBe(200);
  });

  it('locks out repeated wrong passwords', async () => {
    let last = 0;
    for (let i = 0; i < 6; i++) last = (await t.api('POST', '/api/auth/login', { password: 'wrong-wrong-wrong' })).status;
    expect(last).toBe(429);
    // even the right password is throttled during lockout
    expect((await t.api('POST', '/api/auth/login', { password: TEST_PASSWORD })).status).toBe(429);
  });

  it('blocks cross-origin state changes and unknown Host headers', async () => {
    const cross = await t.app.inject({ method: 'POST', url: '/api/projects', headers: { host: 'localhost:4300', origin: 'http://evil.example', cookie: t.cookie, 'content-type': 'application/json' }, payload: '{"title":"x"}' });
    expect(cross.statusCode).toBe(403);
    const rebinding = await t.app.inject({ method: 'GET', url: '/api/projects', headers: { host: 'attacker.example', cookie: t.cookie } });
    expect(rebinding.statusCode).toBe(403);
  });

  it('logout invalidates the session', async () => {
    await t.api('POST', '/api/auth/logout');
    expect((await t.api('GET', '/api/projects')).status).toBe(401);
  });
});
