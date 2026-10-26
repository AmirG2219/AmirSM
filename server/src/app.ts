import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import type { AppContext } from './context.js';
import { AuthService, installAuthGuard, registerAuthRoutes } from './auth.js';
import { HttpError } from './http.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerChatRoutes } from './routes/chat.js';
import { registerEmailRoutes } from './routes/email.js';
import { registerSettingsRoutes } from './routes/settings.js';

export interface BuildOptions {
  logger?: boolean;
  allowedHosts?: string[];
}

export async function buildApp(ctx: AppContext, opts: BuildOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ? { level: 'info', redact: ['req.headers.cookie', 'req.headers.authorization'] } : false, bodyLimit: 2 * 1024 * 1024, trustProxy: false });

  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: ctx.config.maxUploadBytes, files: 25, fields: 20, parts: 60 } });

  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: { code: 'validation_failed', message: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '), details: err.issues } });
    }
    const e = err as Error & { statusCode?: number; code?: string };
    if (e.code === 'FST_REQ_FILE_TOO_LARGE') return reply.code(413).send({ error: { code: 'too_large', message: 'File is too large.' } });
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: { code: e.code ?? 'bad_request', message: e.message } });
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'internal_error', message: 'Something went wrong on the server.' } });
  });

  const auth = new AuthService(ctx.db);
  installAuthGuard(app, auth, { allowedHosts: opts.allowedHosts ?? [] });
  registerAuthRoutes(app, auth);
  registerProjectRoutes(app, ctx);
  registerChatRoutes(app, ctx);
  registerEmailRoutes(app, ctx);
  registerSettingsRoutes(app, ctx);

  // Built web app (production). In dev, Vite serves the UI and proxies /api here.
  const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  if (fs.existsSync(path.join(webDist, 'index.html'))) {
    await app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: { code: 'not_found', message: 'No such endpoint.' } });
      return reply.type('text/html').send(fs.createReadStream(path.join(webDist, 'index.html')));
    });
  } else {
    app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: { code: 'not_found', message: req.url.startsWith('/api/') ? 'No such endpoint.' : 'Web app is not built. Run "npm run build", or use "npm run dev".' } }));
  }
  return app;
}
