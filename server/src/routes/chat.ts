/**
 * Studio chat: the owner talks to the video agent. Each owner message may start a draft or a revision.
 * With the AI available the director (Claude) decides; without it a clearly-labelled basic fallback runs.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { newId, now, parseJson, type Row } from '../db/index.js';
import type { ChatMessageDTO, ChatResponse } from '../../../shared/api.js';
import { VISION_ANALYZER_VERSION, type ClipAnalysis } from '../../../shared/analysis.js';
import type { MediaInfo } from '../../../shared/domain.js';
import { badRequest, conflict } from '../http.js';
import { getProjectRow, listAssetRows, toVersionDTO } from '../repo.js';
import { createAnalysisStore } from '../analysis-store.js';
import { ensureReferenceProfile, loadReferenceProfiles } from '../reference.js';
import { hasActiveVersion, queueVersion } from '../versions.js';
import type { DirectorClip } from '../ai/director.js';

const chatBody = z.object({ text: z.string().trim().min(1).max(4000), attachmentIds: z.array(z.string()).max(12).optional() });

export function registerChatRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db } = ctx;
  const store = createAnalysisStore(db);

  function toMessageDTO(r: Row): ChatMessageDTO {
    const ids = parseJson<string[]>(r.attachments_json, []);
    const attachments = ids
      .map((id) => db.prepare('SELECT id, original_name, role, thumb_name FROM assets WHERE id = ?').get(id) as Row | undefined)
      .filter((a): a is Row => !!a)
      .map((a) => ({ assetId: a.id, name: a.original_name, role: a.role, thumbUrl: a.thumb_name ? `/api/assets/${a.id}/thumb` : null }));
    return { id: r.id, role: r.role, text: r.text, attachments, versionId: r.version_id ?? null, createdAt: r.created_at };
  }

  const insertMessage = (projectId: string, role: 'user' | 'agent', text: string, attachments: string[] = [], versionId: string | null = null): Row => {
    const id = newId('msg');
    db.prepare('INSERT INTO chat_messages (id, project_id, role, text, attachments_json, version_id, created_at) VALUES (?,?,?,?,?,?,?)').run(id, projectId, role, text, JSON.stringify(attachments), versionId, now());
    return db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(id) as Row;
  };

  app.get('/api/projects/:id/chat', async (req) => {
    const projectId = (req.params as { id: string }).id;
    getProjectRow(db, projectId);
    return (db.prepare('SELECT * FROM chat_messages WHERE project_id = ? ORDER BY created_at, rowid').all(projectId) as Row[]).map(toMessageDTO);
  });

  app.post('/api/projects/:id/chat', async (req): Promise<ChatResponse> => {
    const projectId = (req.params as { id: string }).id;
    const project = getProjectRow(db, projectId);
    if (project.status === 'archived') throw conflict('archived', 'Unarchive the project first.');
    const body = chatBody.parse(req.body);

    const attachments: Row[] = [];
    for (const id of body.attachmentIds ?? []) {
      const a = db.prepare('SELECT * FROM assets WHERE id = ? AND project_id = ?').get(id, projectId) as Row | undefined;
      if (!a) throw badRequest('An attachment does not belong to this project.');
      attachments.push(a);
    }
    if (project.title === 'Untitled video') {
      const words = body.text.replace(/\s+/g, ' ').split(' ').slice(0, 7).join(' ');
      db.prepare('UPDATE projects SET title = ?, updated_at = ? WHERE id = ?').run((words.length > 60 ? `${words.slice(0, 57)}...` : words) || 'Untitled video', now(), projectId);
    }
    const userRow = insertMessage(projectId, 'user', body.text, attachments.map((a) => a.id));

    // learn from reference videos the owner has shown (cached; measured locally, described by Claude when available)
    const refNotes: string[] = [];
    for (const a of listAssetRows(db, projectId, 'reference').filter((x) => !x.excluded)) {
      const r = await ensureReferenceProfile(ctx, a);
      if (r.note) refNotes.push(r.note);
    }
    const references = loadReferenceProfiles(ctx, projectId);

    const footage = listAssetRows(db, projectId, 'footage').filter((a) => !a.excluded && a.kind === 'video');
    const clips: DirectorClip[] = footage.map((a) => {
      const info = parseJson<MediaInfo>(a.info_json, {} as MediaInfo);
      const w = info.displayWidth || info.width;
      const h = info.displayHeight || info.height;
      let vis: ClipAnalysis | null = null;
      try {
        vis = store.get(a.id, 'visual', VISION_ANALYZER_VERSION);
      } catch {
        vis = null;
      }
      return { name: a.original_name, durationMs: info.durationMs, orientation: h > w ? 'portrait' : w > h ? 'landscape' : 'square', hasAudio: info.hasAudio, summary: vis?.summary ?? null, tags: vis?.tags ?? [] };
    });
    const latest = db.prepare('SELECT * FROM versions WHERE project_id = ? ORDER BY number DESC LIMIT 1').get(projectId) as Row | undefined;
    const busy = hasActiveVersion(ctx, projectId);
    const history = (db.prepare('SELECT * FROM chat_messages WHERE project_id = ? ORDER BY created_at, rowid').all(projectId) as Row[]).map((m) => ({
      role: m.role as 'user' | 'agent',
      text: m.text as string,
      attached: parseJson<string[]>(m.attachments_json, [])
        .map((id) => db.prepare('SELECT original_name, role FROM assets WHERE id = ?').get(id) as Row | undefined)
        .filter((x): x is Row => !!x)
        .map((x) => `${x.original_name} (${x.role === 'reference' ? 'example/inspiration' : 'footage'})`),
    }));

    let reply = '';
    let action: 'chat' | 'generate' | 'revise' = 'chat';
    let instruction = '';
    let preset: string | undefined;
    let source: 'ai' | 'basic' = 'ai';

    if (ctx.ai.status().configured) {
      try {
        const d = await ctx.ai.directorTurn({
          projectId,
          messages: history,
          clips,
          references,
          draft: latest ? { number: latest.number, status: latest.status, summary: parseJson<{ summary?: string }>(latest.plan_json, {}).summary ?? null, hasCaption: !!latest.caption_json } : null,
          busy,
          preset: project.style_preset,
        });
        reply = d.reply;
        action = d.action;
        instruction = d.action === 'generate' ? d.brief ?? body.text : d.revision ?? body.text;
        preset = d.preset;
      } catch (e) {
        source = 'basic';
        reply = `I could not reach my AI brain just now (${(e as Error).message}). `;
      }
    } else {
      source = 'basic';
    }

    if (source === 'basic') {
      // honest no-AI fallback: it can only build a first draft from the owner's words; it cannot interpret feedback
      if (busy) reply += 'A draft is being made right now. Give it a moment.';
      else if (!footage.length) reply += 'Add some clips first, then tell me what to make.';
      else if (!latest) {
        action = 'generate';
        instruction = history.filter((m) => m.role === 'user').map((m) => m.text).join('\n');
        reply += 'The AI is not connected, so I am making a basic edit: your clips in order with the chosen style. It does not read your description or understand the footage.';
      } else {
        reply += 'Changing a draft needs the AI, which is not available right now. You can still edit the caption or approve this draft.';
      }
    }
    if (refNotes.length && source === 'ai') reply += `\n\n${refNotes[0]}`;

    let version: Row | null = null;
    if (action !== 'chat') {
      try {
        version = queueVersion(ctx, projectId, { instruction, ...(preset ? { preset } : {}) });
      } catch (e) {
        action = 'chat';
        reply += `\n\nI could not start that: ${(e as Error).message}`;
      }
    }
    const agentRow = insertMessage(projectId, 'agent', reply.trim() || 'Okay.', [], version?.id ?? null);
    return { messages: [toMessageDTO(userRow), toMessageDTO(agentRow)], version: version ? toVersionDTO(db, version) : null, source };
  });
}
