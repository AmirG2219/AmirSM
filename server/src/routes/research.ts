import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { newId, now, parseJson, type Row } from '../db/index.js';
import type { CompetitorDTO, ResearchCapabilities, ResearchNoteDTO, ResearchRunDTO } from '../../../shared/api.js';
import { AiLimitError, AiUnavailableError } from '../ai/types.js';
import { HttpError, notFound } from '../http.js';
import { logEvent } from '../repo.js';

const toCompetitor = (r: Row): CompetitorDTO => ({ id: r.id, name: r.name, handle: r.handle, url: r.url, notes: r.notes, createdAt: r.created_at });
const toNote = (r: Row): ResearchNoteDTO => ({ id: r.id, kind: r.kind, title: r.title, body: r.body, sourceUrl: r.source_url, sourceLabel: r.source_label, competitorId: r.competitor_id, tags: parseJson(r.tags_json, []), createdAt: r.created_at });
const toRun = (r: Row): ResearchRunDTO => ({ id: r.id, kind: r.kind, topic: r.topic, competitorId: r.competitor_id, source: r.source, status: r.status, error: r.error, result: parseJson(r.result_json, null), createdAt: r.created_at });

const httpUrl = z.string().url().max(500).refine((u) => /^https?:\/\//i.test(u), 'Only http(s) links are allowed');
const competitorBody = z.object({ name: z.string().trim().min(1).max(100), handle: z.string().trim().max(100).nullable().optional(), url: httpUrl.nullable().optional().or(z.literal('').transform(() => null)), notes: z.string().max(3000).optional() });
const noteBody = z.object({
  kind: z.enum(['observation', 'idea', 'inspiration']),
  title: z.string().trim().min(1).max(160),
  body: z.string().max(5000).optional(),
  sourceUrl: httpUrl.nullable().optional().or(z.literal('').transform(() => null)),
  sourceLabel: z.string().max(120).nullable().optional(),
  competitorId: z.string().nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
});

export function ingestNotes(ctx: AppContext, notes: z.infer<typeof noteBody>[], defaultSource?: string) {
  const ids: string[] = [];
  for (const n of notes) {
    const id = newId('rsn');
    ctx.db.prepare('INSERT INTO research_notes (id, kind, title, body, source_url, source_label, competitor_id, tags_json, created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(
      id, n.kind, n.title, n.body ?? '', n.sourceUrl ?? null, n.sourceLabel ?? defaultSource ?? null, n.competitorId ?? null, JSON.stringify(n.tags ?? []), now(),
    );
    ids.push(id);
  }
  return ids;
}
export { noteBody as researchNoteSchema };

export function registerResearchRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, ai } = ctx;

  app.get('/api/research/capabilities', async (): Promise<ResearchCapabilities> => {
    const s = ai.status();
    return {
      competitorAnalysis: s.configured ? { available: true } : { available: false, reason: 'Needs an Anthropic API key. You can still save competitors, notes and pasted material.' },
      marketResearch: !s.configured
        ? { available: false, reason: 'No research source is connected. Needs an Anthropic API key and AI_WEB_SEARCH_ENABLED=true (billed per search).' }
        : s.webSearchEnabled ? { available: true } : { available: false, reason: 'Web search is switched off. Set AI_WEB_SEARCH_ENABLED=true to allow Anthropic web search (billed per search).' },
    };
  });

  // ----- competitors -----
  app.get('/api/research/competitors', async () => (db.prepare('SELECT * FROM competitors ORDER BY created_at DESC').all() as Row[]).map(toCompetitor));
  app.post('/api/research/competitors', async (req, reply) => {
    const b = competitorBody.parse(req.body);
    const id = newId('cmp');
    db.prepare('INSERT INTO competitors (id, name, handle, url, notes, created_at) VALUES (?,?,?,?,?,?)').run(id, b.name, b.handle ?? null, b.url ?? null, b.notes ?? '', now());
    reply.code(201);
    return toCompetitor(db.prepare('SELECT * FROM competitors WHERE id = ?').get(id) as Row);
  });
  app.patch('/api/research/competitors/:id', async (req) => {
    const id = (req.params as { id: string }).id;
    const r = db.prepare('SELECT * FROM competitors WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw notFound('Competitor');
    const b = competitorBody.partial().parse(req.body);
    db.prepare('UPDATE competitors SET name = ?, handle = ?, url = ?, notes = ? WHERE id = ?').run(b.name ?? r.name, b.handle === undefined ? r.handle : b.handle, b.url === undefined ? r.url : b.url, b.notes ?? r.notes, id);
    return toCompetitor(db.prepare('SELECT * FROM competitors WHERE id = ?').get(id) as Row);
  });
  app.delete('/api/research/competitors/:id', async (req) => {
    // Removes only the saved competitor entry; notes and past runs keep their text but lose the link.
    const id = (req.params as { id: string }).id;
    db.prepare('UPDATE research_notes SET competitor_id = NULL WHERE competitor_id = ?').run(id);
    db.prepare('UPDATE research_runs SET competitor_id = NULL WHERE competitor_id = ?').run(id);
    const r = db.prepare('DELETE FROM competitors WHERE id = ?').run(id);
    if (!r.changes) throw notFound('Competitor');
    return { ok: true };
  });

  // ----- notes -----
  app.get('/api/research/notes', async (req) => {
    const q = z.object({ kind: z.string().optional(), q: z.string().max(200).optional(), competitorId: z.string().optional() }).parse(req.query);
    const where = ['1=1'];
    const args: string[] = [];
    if (q.kind) { where.push('kind = ?'); args.push(q.kind); }
    if (q.competitorId) { where.push('competitor_id = ?'); args.push(q.competitorId); }
    if (q.q) { where.push('(title LIKE ? OR body LIKE ? OR tags_json LIKE ?)'); args.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`); }
    return (db.prepare(`SELECT * FROM research_notes WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 300`).all(...args) as Row[]).map(toNote);
  });
  app.post('/api/research/notes', async (req, reply) => {
    const b = noteBody.parse(req.body);
    const [id] = ingestNotes(ctx, [b], 'Manual');
    reply.code(201);
    return toNote(db.prepare('SELECT * FROM research_notes WHERE id = ?').get(id!) as Row);
  });
  app.delete('/api/research/notes/:id', async (req) => {
    const r = db.prepare('DELETE FROM research_notes WHERE id = ?').run((req.params as { id: string }).id);
    if (!r.changes) throw notFound('Note');
    return { ok: true };
  });

  // ----- runs (history) -----
  app.get('/api/research/runs', async () => (db.prepare('SELECT * FROM research_runs ORDER BY created_at DESC LIMIT 100').all() as Row[]).map(toRun));

  const aiHttp = (e: unknown): never => {
    if (e instanceof AiUnavailableError) throw new HttpError(409, 'ai_unavailable', e.message);
    if (e instanceof AiLimitError) throw new HttpError(429, 'ai_limit', e.message);
    throw new HttpError(502, 'ai_failed', (e as Error).message);
  };
  const saveRun = (kind: 'competitor_analysis' | 'market_research', topic: string, competitorId: string | null, input: unknown, source: string, result: unknown, error?: string) => {
    const id = newId('rsr');
    db.prepare('INSERT INTO research_runs (id, kind, topic, competitor_id, input_json, result_json, source, status, error, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(
      id, kind, topic, competitorId, JSON.stringify(input), result ? JSON.stringify(result) : null, source, error ? 'failed' : 'succeeded', error ?? null, now(),
    );
    return toRun(db.prepare('SELECT * FROM research_runs WHERE id = ?').get(id) as Row);
  };

  /** Competitor Analyst — works ONLY on material the owner pasted in (public posts they copied, captions, notes). */
  app.post('/api/research/competitors/:id/analyze', async (req) => {
    const id = (req.params as { id: string }).id;
    const c = db.prepare('SELECT * FROM competitors WHERE id = ?').get(id) as Row | undefined;
    if (!c) throw notFound('Competitor');
    const b = z.object({
      materials: z.array(z.object({ label: z.string().trim().min(1).max(120), text: z.string().trim().min(1).max(8000), url: httpUrl.optional() })).min(1).max(12),
      focus: z.string().max(300).optional(),
    }).parse(req.body);
    try {
      const result = await ai.analyzeCompetitorMaterial({ competitorName: c.name, materials: b.materials, focus: b.focus });
      logEvent(db, 'research.analysis', `Analysed material for competitor “${c.name}”.`);
      return saveRun('competitor_analysis', c.name, id, { materialCount: b.materials.length, focus: b.focus }, 'user-provided material', result);
    } catch (e) {
      if (!(e instanceof AiUnavailableError)) saveRun('competitor_analysis', c.name, id, { materialCount: b.materials.length }, 'user-provided material', null, (e as Error).message);
      return aiHttp(e);
    }
  });

  /** Market Researcher — only with an authorized source (opt-in Anthropic web search). */
  app.post('/api/research/market', async (req) => {
    const b = z.object({ topic: z.string().trim().min(3).max(200), niche: z.string().trim().max(120).optional() }).parse(req.body);
    try {
      const result = await ai.marketResearch(b);
      logEvent(db, 'research.market', `Market research on “${b.topic}”.`);
      return saveRun('market_research', b.topic, null, b, 'anthropic web search', result);
    } catch (e) {
      if (!(e instanceof AiUnavailableError)) saveRun('market_research', b.topic, null, b, 'anthropic web search', null, (e as Error).message);
      return aiHttp(e);
    }
  });
}
