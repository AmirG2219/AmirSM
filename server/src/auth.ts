import crypto from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db, Row } from './db/index.js';
import { now } from './db/index.js';
import { HttpError } from './http.js';

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, keylen: number, opts: crypto.ScryptOptions) => Promise<Buffer>;
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

export const SESSION_COOKIE = 'amirsm_session';
const SESSION_DAYS = 30;
export const MIN_PASSWORD_LENGTH = 10;

export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}
export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, saltB64, keyB64] = stored.split('$');
  if (alg !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(pw, Buffer.from(saltB64, 'base64'), expected.length, SCRYPT);
  return crypto.timingSafeEqual(key, expected);
}

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export class AuthService {
  private attempts = new Map<string, { count: number; first: number; lockedUntil: number }>();
  constructor(private db: Db) {}

  setupRequired(): boolean {
    return !this.db.prepare('SELECT 1 FROM owner WHERE id = 1').get();
  }

  async setup(password: string) {
    if (!this.setupRequired()) throw new HttpError(409, 'already_setup', 'The owner password is already set.');
    const hash = await hashPassword(password);
    this.db.prepare('INSERT INTO owner (id, password_hash, created_at) VALUES (1, ?, ?)').run(hash, now());
  }

  private checkThrottle(key: string) {
    const a = this.attempts.get(key);
    const t = Date.now();
    if (a && a.lockedUntil > t) throw new HttpError(429, 'too_many_attempts', `Too many attempts. Try again in ${Math.ceil((a.lockedUntil - t) / 1000)}s.`);
  }
  private recordFailure(key: string) {
    const t = Date.now();
    const a = this.attempts.get(key);
    if (!a || t - a.first > 15 * 60_000) this.attempts.set(key, { count: 1, first: t, lockedUntil: 0 });
    else {
      a.count++;
      if (a.count >= 5) a.lockedUntil = t + Math.min(15 * 60_000, 30_000 * 2 ** (a.count - 5));
    }
  }

  async login(password: string, key: string, userAgent?: string): Promise<string> {
    this.checkThrottle(key);
    const row = this.db.prepare('SELECT password_hash FROM owner WHERE id = 1').get() as Row | undefined;
    if (!row) throw new HttpError(409, 'setup_required', 'Set the owner password first.');
    if (!(await verifyPassword(password, row.password_hash))) {
      this.recordFailure(key);
      throw new HttpError(401, 'invalid_credentials', 'Incorrect password.');
    }
    this.attempts.delete(key);
    const token = crypto.randomBytes(32).toString('base64url');
    const t = new Date();
    const exp = new Date(t.getTime() + SESSION_DAYS * 86_400_000);
    this.db
      .prepare('INSERT INTO sessions (id_hash, created_at, expires_at, last_seen_at, user_agent) VALUES (?,?,?,?,?)')
      .run(sha(token), t.toISOString(), exp.toISOString(), t.toISOString(), (userAgent ?? '').slice(0, 200));
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(t.toISOString());
    return token;
  }

  validate(token: string | undefined): boolean {
    if (!token) return false;
    const row = this.db.prepare('SELECT expires_at FROM sessions WHERE id_hash = ?').get(sha(token)) as Row | undefined;
    if (!row) return false;
    if (row.expires_at < now()) return false;
    return true;
  }

  logout(token: string | undefined) {
    if (token) this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(sha(token));
  }
}

export function setSessionCookie(reply: FastifyReply, token: string, secure: boolean) {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure,
    path: '/',
    maxAge: SESSION_DAYS * 86_400,
  });
}

const credsSchema = z.object({ password: z.string().min(1).max(256) });
const setupSchema = z.object({ password: z.string().min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters.`).max(256) });

export function registerAuthRoutes(app: FastifyInstance, auth: AuthService) {
  app.get('/api/auth/state', async (req) => ({
    setupRequired: auth.setupRequired(),
    authenticated: auth.validate(req.cookies[SESSION_COOKIE]),
  }));

  app.post('/api/auth/setup', async (req, reply) => {
    const { password } = setupSchema.parse(req.body);
    await auth.setup(password);
    const token = await auth.login(password, req.ip, req.headers['user-agent']);
    setSessionCookie(reply, token, req.protocol === 'https');
    return { ok: true };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const { password } = credsSchema.parse(req.body);
    const token = await auth.login(password, req.ip, req.headers['user-agent']);
    setSessionCookie(reply, token, req.protocol === 'https');
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    auth.logout(req.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });
}

/** Paths under /api that do not require the owner session. */
const PUBLIC = [/^\/api\/auth\/(state|setup|login|logout)$/, /^\/api\/health$/];

export function installAuthGuard(app: FastifyInstance, auth: AuthService, opts: { allowedHosts: string[] }) {
  app.addHook('onRequest', async (req: FastifyRequest) => {
    // DNS-rebinding defence: the Host header must be a loopback name or explicitly allowed.
    const host = (req.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
    if (!['localhost', '127.0.0.1', '::1'].includes(host) && !opts.allowedHosts.includes(host)) {
      throw new HttpError(403, 'bad_host', 'Unrecognised host header.');
    }
    const url = req.url.split('?')[0]!;
    if (!url.startsWith('/api/')) return;

    // CSRF: state-changing requests must be same-origin.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin) {
        let oh = '';
        try {
          oh = new URL(origin).host.toLowerCase();
        } catch { /* invalid */ }
        if (oh !== (req.headers.host ?? '').toLowerCase()) throw new HttpError(403, 'bad_origin', 'Cross-origin request blocked.');
      }
    }

    if (PUBLIC.some((r) => r.test(url))) return;
    if (!auth.validate(req.cookies[SESSION_COOKIE])) throw new HttpError(401, 'unauthenticated', 'Sign in required.');
  });
}
