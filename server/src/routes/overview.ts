/** Dashboard, library, settings/status and the machine-facing n8n endpoints. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { Row } from '../db/index.js';
import { parseJson } from '../db/index.js';
import type { DashboardDTO, IntegrationStatus, LibraryItem, SettingsStatus, SystemStatusItem } from '../../../shared/api.js';
import { captionToText, type Caption } from '../../../shared/domain.js';
import { HttpError } from '../http.js';
import { dirSize, toProjectSummary } from '../repo.js';
import { ingestNotes, researchNoteSchema } from './research.js';

const APP_VERSION = '0.1.0';

export async function integrationStatuses(ctx: AppContext): Promise<IntegrationStatus[]> {
  const { config, ai, video, email, n8n } = ctx;
  const out: IntegrationStatus[] = [];

  const aiStatus = ai.status();
  out.push(
    aiStatus.configured
      ? { id: 'anthropic', label: 'Anthropic API', state: 'connected', detail: `Key present. Models: ${aiStatus.primaryModel} (creative), ${aiStatus.fastModel} (email/light). Not yet verified with a live call until the first request is made.` }
      : { id: 'anthropic', label: 'Anthropic API', state: 'not_configured', detail: aiStatus.detail ?? 'ANTHROPIC_API_KEY is not set. Editing still works with the basic (no-AI) planner; captions, revisions, email AI and analysis are disabled.', action: 'Add ANTHROPIC_API_KEY to .env and restart.' },
  );
  out.push(
    aiStatus.webSearchEnabled && aiStatus.configured
      ? { id: 'web_search', label: 'Market research source (web search)', state: 'connected', detail: 'Anthropic web search is enabled (billed per search).' }
      : { id: 'web_search', label: 'Market research source (web search)', state: 'not_configured', detail: 'No research source connected. Competitor analysis of pasted material still works with an API key.', action: 'Set AI_WEB_SEARCH_ENABLED=true (requires the API key; billed per search).' },
  );

  const h = await video.health().catch((e) => ({ ok: false, detail: (e as Error).message, filters: { drawtext: false, subtitles: false, xfade: false } }) as Awaited<ReturnType<typeof video.health>>);
  out.push(
    h.ok
      ? { id: 'ffmpeg', label: 'FFmpeg video engine', state: 'connected', detail: `${h.ffmpegVersion ?? 'ffmpeg'} — text titles: ${h.filters.drawtext ? 'yes' : 'NO'}, subtitles: ${h.filters.subtitles ? 'yes' : 'NO'}, transitions: ${h.filters.xfade ? 'yes' : 'NO'}` }
      : { id: 'ffmpeg', label: 'FFmpeg video engine', state: 'error', detail: h.detail ?? 'FFmpeg is not runnable.', action: 'Run npm install, or set FFMPEG_PATH / FFPROBE_PATH.' },
  );

  const accounts = email.accounts();
  const fixture = accounts.find((a) => a.isFixture);
  out.push(
    fixture
      ? { id: 'email', label: 'Mailbox', state: 'fixture', detail: 'Using the local sample mailbox (fictional messages). No real Gmail/Outlook/IMAP mailbox is connected — real mailbox reading is not implemented yet.', action: 'A real mailbox needs a provider decision and credentials/OAuth.' }
      : { id: 'email', label: 'Mailbox', state: 'not_configured', detail: 'No readable mailbox is connected.' },
  );
  const resend = accounts.find((a) => a.provider === 'resend');
  out.push(
    resend
      ? { id: 'resend', label: 'Resend (sending)', state: 'awaiting_credentials', detail: 'Configured for sending only. Implemented and unit-tested with a mocked API; not verified against the live Resend API.' }
      : { id: 'resend', label: 'Resend (sending)', state: 'not_configured', detail: 'RESEND_API_KEY / RESEND_FROM not set. Replies cannot be delivered; approved sends are only recorded locally.', action: 'Create a Resend API key and verified sender, then set RESEND_API_KEY and RESEND_FROM.' },
  );

  const ns = n8n.status();
  out.push(
    ns.outbound.configured
      ? { id: 'n8n', label: 'n8n', state: 'awaiting_credentials', detail: `${ns.outbound.detail} Inbound: ${ns.inbound.detail}` }
      : { id: 'n8n', label: 'n8n', state: 'not_configured', detail: `${ns.outbound.detail} Workflow definitions are ready in n8n/workflows/.`, action: 'Import the workflows into n8n, then set N8N_BASE_URL, N8N_WEBHOOK_SECRET and N8N_INBOUND_TOKEN.' },
  );
  return out;
}

export function registerOverviewRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, config } = ctx;

  app.get('/api/health', async () => ({ ok: true, version: APP_VERSION }));

  app.get('/api/dashboard', async (): Promise<DashboardDTO> => {
    const sum = (where: string, limit = 12) =>
      (db.prepare(`SELECT * FROM projects WHERE ${where} ORDER BY updated_at DESC LIMIT ${limit}`).all() as Row[]).map((r) => toProjectSummary(db, r));
    const inProgress = sum("status = 'processing'");
    const needsReview = sum("status = 'review'");
    const recentlyCompleted = sum("status = 'approved'", 8);

    const accounts = ctx.email.accounts();
    const drafts = ctx.email.listDrafts().filter((d) => d.status === 'draft' || d.status === 'approved' || d.status === 'failed').slice(0, 8);
    const needsReplyThreads = ctx.email.listThreads({ filter: 'needs_reply' }).slice(0, 8);

    const recentNotes = (db.prepare('SELECT id, kind, title, created_at FROM research_notes ORDER BY created_at DESC LIMIT 5').all() as Row[]).map((r) => ({ id: r.id, kind: r.kind, title: r.title, createdAt: r.created_at }));
    const recentRuns = (db.prepare("SELECT id, kind, topic, created_at FROM research_runs WHERE status = 'succeeded' ORDER BY created_at DESC LIMIT 5").all() as Row[]).map((r) => ({ id: r.id, kind: r.kind, title: r.topic, createdAt: r.created_at }));
    const recentResearch = [...recentNotes, ...recentRuns].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 6);

    const recentFailures = (db.prepare(
      "SELECT v.id AS vid, v.project_id, v.number, v.error, v.finished_at, p.title FROM versions v JOIN projects p ON p.id = v.project_id WHERE v.status = 'failed' AND p.status != 'archived' AND v.created_at > datetime('now','-7 day') ORDER BY v.created_at DESC LIMIT 5",
    ).all() as Row[]).map((r) => ({ versionId: r.vid, projectId: r.project_id, projectTitle: r.title, number: r.number, error: r.error, at: r.finished_at }));

    const system: SystemStatusItem[] = [];
    const ints = await integrationStatuses(ctx);
    for (const i of ints.filter((i) => ['ffmpeg', 'anthropic', 'email', 'n8n'].includes(i.id))) {
      system.push({ id: i.id, label: i.label, state: i.state === 'connected' ? 'ok' : i.state === 'fixture' ? 'fixture' : i.state === 'error' ? 'error' : 'not_configured', detail: i.detail });
    }
    const activity = (db.prepare('SELECT id, ts, kind, message, project_id FROM events ORDER BY id DESC LIMIT 12').all() as Row[]).map((r) => ({ id: r.id, ts: r.ts, kind: r.kind, message: r.message, projectId: r.project_id }));

    return {
      generatedAt: new Date().toISOString(),
      inProgress, needsReview, recentlyCompleted,
      pendingEmail: { drafts: drafts.map((d) => ({ id: d.id, subject: d.subject || '(no subject)', status: d.status, updatedAt: d.updatedAt })), needsReplyThreads: needsReplyThreads.map((t) => ({ id: t.id, subject: t.subject, lastMessageAt: t.lastMessageAt })), provider: accounts[0]?.label ?? 'none', isFixture: !!accounts[0]?.isFixture },
      recentResearch, recentFailures, system, queue: ctx.jobs.stats(), activity,
    };
  });

  app.get('/api/library', async (req) => {
    const q = z.object({ q: z.string().max(200).optional(), kind: z.enum(['clip', 'draft', 'export']).optional(), status: z.string().optional(), projectId: z.string().optional() }).parse(req.query);
    const items: LibraryItem[] = [];
    const like = q.q ? `%${q.q}%` : null;

    if (!q.kind || q.kind === 'clip') {
      const rows = db.prepare(
        `SELECT a.*, p.title AS ptitle FROM assets a JOIN projects p ON p.id = a.project_id WHERE 1=1 ${q.projectId ? 'AND a.project_id = @pid' : ''} ${like ? 'AND (a.original_name LIKE @like OR p.title LIKE @like OR p.brief LIKE @like)' : ''} ORDER BY a.created_at DESC LIMIT 300`,
      ).all({ ...(q.projectId ? { pid: q.projectId } : {}), ...(like ? { like } : {}) }) as Row[];
      for (const r of rows) {
        const info = parseJson<{ durationMs?: number }>(r.info_json, {});
        items.push({ kind: 'clip', id: r.id, projectId: r.project_id, projectTitle: r.ptitle, title: r.original_name, status: r.excluded ? 'excluded' : 'preserved', thumbUrl: r.thumb_name ? `/api/assets/${r.id}/thumb` : null, mediaUrl: `/api/assets/${r.id}/file`, downloadUrl: `/api/assets/${r.id}/file?download=1`, captionText: null, instruction: null, sizeBytes: r.size_bytes, durationMs: info.durationMs ?? null, createdAt: r.created_at });
      }
    }
    if (!q.kind || q.kind === 'draft' || q.kind === 'export') {
      const rows = db.prepare(
        `SELECT v.*, p.title AS ptitle FROM versions v JOIN projects p ON p.id = v.project_id WHERE v.output_name IS NOT NULL ${q.projectId ? 'AND v.project_id = @pid' : ''} ${like ? 'AND (v.instruction LIKE @like OR v.caption_json LIKE @like OR p.title LIKE @like)' : ''} ORDER BY v.created_at DESC LIMIT 300`,
      ).all({ ...(q.projectId ? { pid: q.projectId } : {}), ...(like ? { like } : {}) }) as Row[];
      for (const v of rows) {
        const isExport = v.status === 'approved';
        if ((q.kind === 'export' && !isExport) || (q.kind === 'draft' && isExport)) continue;
        const cap = parseJson<Caption | null>(v.caption_json, null);
        const thumb = db.prepare("SELECT id FROM assets WHERE project_id = ? AND thumb_name IS NOT NULL ORDER BY sort_order LIMIT 1").get(v.project_id) as Row | undefined;
        items.push({ kind: isExport ? 'export' : 'draft', id: v.id, projectId: v.project_id, projectTitle: v.ptitle, title: `${v.ptitle} — v${v.number}${isExport ? ' (approved export)' : ''}`, status: v.status, thumbUrl: thumb ? `/api/assets/${thumb.id}/thumb` : null, mediaUrl: `/api/versions/${v.id}/video`, downloadUrl: `/api/versions/${v.id}/video?download=1`, captionText: cap ? captionToText(cap) : null, instruction: v.instruction, sizeBytes: v.output_size, durationMs: v.output_duration_ms, createdAt: v.created_at });
      }
    }
    const filtered = q.status ? items.filter((i) => i.status === q.status) : items;
    return filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });

  app.get('/api/events', async (req) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    return (db.prepare('SELECT id, ts, kind, message, project_id FROM events ORDER BY id DESC LIMIT ?').all(limit) as Row[]).map((r) => ({ id: r.id, ts: r.ts, kind: r.kind, message: r.message, projectId: r.project_id }));
  });

  app.get('/api/settings/status', async (): Promise<SettingsStatus> => {
    const s = ctx.ai.status();
    return {
      integrations: await integrationStatuses(ctx),
      ai: { configured: s.configured, primaryModel: s.primaryModel, fastModel: s.fastModel, limits: s.limits, usage: s.usage, recent: ctx.ai.recentUsage(15).map((u) => ({ ts: u.ts, role: u.role, model: u.model, inputTokens: u.inputTokens, outputTokens: u.outputTokens, ok: u.ok, error: u.error })) },
      storage: { dataDir: config.dataDir, uploadsBytes: dirSize(config.paths.uploads), rendersBytes: dirSize(config.paths.renders), exportsBytes: dirSize(config.paths.exports) },
      app: { version: APP_VERSION, node: process.version, uptimeSeconds: Math.round(process.uptime()) },
    };
  });

  app.post('/api/settings/n8n/test', async () => {
    if (!ctx.n8n.status().outbound.configured) throw new HttpError(409, 'not_configured', 'n8n outbound is not configured (N8N_BASE_URL and N8N_WEBHOOK_SECRET).');
    return ctx.n8n.test();
  });

  // ---------- machine endpoints for n8n (bearer token; no cookie) ----------
  const guard = (req: { headers: { authorization?: string } }) => {
    if (!ctx.n8n.verifyInbound(req.headers.authorization)) throw new HttpError(401, 'unauthorized', 'Invalid or missing bearer token.');
  };
  app.get('/api/integrations/n8n/status', async (req) => {
    guard(req);
    return { ok: true, app: 'amir-sm', version: APP_VERSION, queue: ctx.jobs.stats() };
  });
  app.get('/api/integrations/n8n/digest', async (req) => {
    guard(req);
    const review = db.prepare("SELECT p.title, v.number FROM versions v JOIN projects p ON p.id = v.project_id WHERE v.status = 'ready' ORDER BY v.created_at DESC").all() as Row[];
    const failed = db.prepare("SELECT p.title, v.number, v.error FROM versions v JOIN projects p ON p.id = v.project_id WHERE v.status = 'failed' AND v.created_at > datetime('now','-1 day')").all() as Row[];
    const drafts = ctx.email.listDrafts().filter((d) => d.status === 'draft' || d.status === 'approved');
    const needsReply = ctx.email.listThreads({ filter: 'needs_reply' });
    return {
      generatedAt: new Date().toISOString(),
      awaitingReview: review.map((r) => `${r.title} (v${r.number})`),
      failedLast24h: failed.map((r) => `${r.title} (v${r.number}): ${r.error ?? 'failed'}`),
      emailDraftsPending: drafts.length,
      threadsNeedingReply: needsReply.length,
      hasItems: review.length + failed.length + drafts.length + needsReply.length > 0,
    };
  });
  app.post('/api/integrations/n8n/research/ingest', async (req) => {
    guard(req);
    const body = z.object({ source: z.string().max(120).default('n8n'), notes: z.array(researchNoteSchema).min(1).max(50) }).parse(req.body);
    const ids = ingestNotes(ctx, body.notes, `n8n: ${body.source}`);
    return { ok: true, created: ids.length };
  });
}
