/** Health and the (secondary) Settings status. */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import type { IntegrationStatus, SettingsStatus } from '../../../shared/api.js';
import { dirSize } from '../repo.js';

const APP_VERSION = '0.2.0';

export async function integrationStatuses(ctx: AppContext): Promise<IntegrationStatus[]> {
  const { ai, video, email } = ctx;
  const out: IntegrationStatus[] = [];

  const s = ai.status();
  out.push(
    s.configured
      ? { id: 'anthropic', label: 'Anthropic API', state: 'connected', detail: `Key present. Models: ${s.primaryModel} (editing, captions), ${s.fastModel} (email). ${s.detail ?? ''}`.trim() }
      : { id: 'anthropic', label: 'Anthropic API', state: 'not_configured', detail: s.detail ?? 'ANTHROPIC_API_KEY is not set. Video editing still works with the basic (no-AI) editor; captions, revisions and email AI are off.', action: 'Add ANTHROPIC_API_KEY to .env and restart.' },
  );

  const h = await video.health().catch((e) => ({ ok: false, detail: (e as Error).message, filters: { drawtext: false, subtitles: false, xfade: false } }) as Awaited<ReturnType<typeof video.health>>);
  out.push(
    h.ok
      ? { id: 'ffmpeg', label: 'FFmpeg video engine', state: 'connected', detail: `${h.ffmpegVersion ?? 'ffmpeg'} — titles: ${h.filters.drawtext ? 'yes' : 'NO'}, subtitles: ${h.filters.subtitles ? 'yes' : 'NO'}, transitions: ${h.filters.xfade ? 'yes' : 'NO'}` }
      : { id: 'ffmpeg', label: 'FFmpeg video engine', state: 'error', detail: h.detail ?? 'FFmpeg is not runnable.', action: 'Run npm install, or set FFMPEG_PATH / FFPROBE_PATH.' },
  );

  out.push(email.integrationStatus());
  return out;
}

export function registerSettingsRoutes(app: FastifyInstance, ctx: AppContext) {
  const { config } = ctx;

  app.get('/api/health', async () => ({ ok: true, version: APP_VERSION }));

  app.get('/api/settings/status', async (): Promise<SettingsStatus> => {
    const s = ctx.ai.status();
    return {
      integrations: await integrationStatuses(ctx),
      ai: { configured: s.configured, primaryModel: s.primaryModel, fastModel: s.fastModel, limits: s.limits, usage: s.usage, recent: ctx.ai.recentUsage(15).map((u) => ({ ts: u.ts, role: u.role, model: u.model, inputTokens: u.inputTokens, outputTokens: u.outputTokens, ok: u.ok, error: u.error })) },
      storage: { dataDir: config.dataDir, uploadsBytes: dirSize(config.paths.uploads), rendersBytes: dirSize(config.paths.renders), exportsBytes: dirSize(config.paths.exports) },
      app: { version: APP_VERSION, node: process.version, uptimeSeconds: Math.round(process.uptime()) },
    };
  });
}
