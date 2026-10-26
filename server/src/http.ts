import fs from 'node:fs';
import path from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
    this.name = 'HttpError';
  }
}
export const notFound = (what: string) => new HttpError(404, 'not_found', `${what} not found.`);
export const badRequest = (msg: string, details?: unknown) => new HttpError(400, 'bad_request', msg, details);
export const conflict = (code: string, msg: string) => new HttpError(409, code, msg);

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.aac': 'audio/aac', '.jpg': 'image/jpeg', '.txt': 'text/plain; charset=utf-8',
};
export const mimeFor = (file: string) => MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';

/** Serve a local file with HTTP Range support (needed for <video> seeking). */
export function sendFile(req: FastifyRequest, reply: FastifyReply, file: string, opts: { downloadName?: string; mime?: string } = {}) {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    throw notFound('File');
  }
  const size = stat.size;
  const type = opts.mime ?? mimeFor(file);
  reply.header('Accept-Ranges', 'bytes');
  reply.header('Content-Type', type);
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Cache-Control', 'private, max-age=0, must-revalidate');
  reply.header('Last-Modified', stat.mtime.toUTCString());
  if (opts.downloadName) {
    const safe = opts.downloadName.replace(/[^\w.\- ]+/g, '_');
    reply.header('Content-Disposition', `attachment; filename="${safe}"`);
  }
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m || (m[1] === '' && m[2] === '')) {
      reply.code(416).header('Content-Range', `bytes */${size}`);
      return reply.send();
    }
    let start: number;
    let end: number;
    if (m[1] === '') {
      const n = Number(m[2]);
      start = Math.max(0, size - n);
      end = size - 1;
    } else {
      start = Number(m[1]);
      end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
    }
    if (start >= size || start > end) {
      reply.code(416).header('Content-Range', `bytes */${size}`);
      return reply.send();
    }
    reply.code(206).header('Content-Range', `bytes ${start}-${end}/${size}`).header('Content-Length', end - start + 1);
    return reply.send(fs.createReadStream(file, { start, end }));
  }
  reply.header('Content-Length', size);
  return reply.send(fs.createReadStream(file));
}

export function slugify(s: string, max = 40): string {
  return (
    s
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, '-')
      .slice(0, max)
      .replace(/^-+|-+$/g, '') || 'project'
  );
}
