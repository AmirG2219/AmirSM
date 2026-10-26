import crypto from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/index.js';
import { logEvent } from '../repo.js';

export type N8nEventName = 'ping' | 'version.ready' | 'version.failed' | 'version.approved' | 'email.draft_approved';

export interface N8nStatus {
  outbound: { configured: boolean; detail: string };
  inbound: { configured: boolean; detail: string };
}

/**
 * Server-side boundary to n8n.
 *  - Outbound: JSON POST to `${N8N_BASE_URL}/webhook/amir-sm-events` with header `x-amirsm-secret: N8N_WEBHOOK_SECRET`
 *    (the n8n Webhook node validates it with Header Auth). Use HTTPS for any non-local n8n.
 *  - Inbound: n8n calls /api/integrations/n8n/* with `Authorization: Bearer ${N8N_INBOUND_TOKEN}`.
 * Nothing here is required for the app to work; when unconfigured, emit() is a no-op.
 */
export class N8nBridge {
  constructor(private cfg: AppConfig['n8n'], private db: Db, private fetchImpl: typeof fetch = fetch) {}

  status(): N8nStatus {
    const { baseUrl, webhookSecret, inboundToken } = this.cfg;
    return {
      outbound: baseUrl
        ? { configured: !!webhookSecret, detail: webhookSecret ? `Events are posted to ${baseUrl}/webhook/amir-sm-events (not yet verified — use Test).` : 'N8N_BASE_URL is set but N8N_WEBHOOK_SECRET is missing; events are not sent.' }
        : { configured: false, detail: 'N8N_BASE_URL is not set. The app works without n8n.' },
      inbound: inboundToken
        ? { configured: true, detail: 'n8n can call /api/integrations/n8n/* with the bearer token.' }
        : { configured: false, detail: 'N8N_INBOUND_TOKEN is not set; inbound n8n endpoints reject all requests.' },
    };
  }

  verifyInbound(authHeader: string | undefined): boolean {
    const token = this.cfg.inboundToken;
    if (!token || !authHeader?.startsWith('Bearer ')) return false;
    const a = crypto.createHash('sha256').update(authHeader.slice(7)).digest();
    const b = crypto.createHash('sha256').update(token).digest();
    return crypto.timingSafeEqual(a, b);
  }

  private async post(event: N8nEventName, payload: unknown): Promise<{ ok: boolean; detail: string }> {
    const { baseUrl, webhookSecret } = this.cfg;
    if (!baseUrl || !webhookSecret) return { ok: false, detail: 'n8n outbound is not configured.' };
    const body = JSON.stringify({ event, at: new Date().toISOString(), data: payload });
    try {
      const res = await this.fetchImpl(`${baseUrl.replace(/\/+$/, '')}/webhook/amir-sm-events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-amirsm-event': event, 'x-amirsm-secret': webhookSecret },
        body,
        signal: AbortSignal.timeout(8000),
      });
      return res.ok ? { ok: true, detail: `n8n responded ${res.status}` } : { ok: false, detail: `n8n responded ${res.status} ${res.statusText}` };
    } catch (e) {
      return { ok: false, detail: `Could not reach n8n: ${(e as Error).message}` };
    }
  }

  /** Fire-and-forget; failures are recorded in the activity feed, never thrown into app flows. */
  emit(event: N8nEventName, payload: unknown, projectId?: string) {
    if (!this.cfg.baseUrl || !this.cfg.webhookSecret) return;
    void this.post(event, payload).then((r) => {
      if (!r.ok) logEvent(this.db, 'n8n.error', `n8n event ${event} not delivered: ${r.detail}`, projectId ?? null);
    });
  }

  test() {
    return this.post('ping', { message: 'Amir SM connectivity test' });
  }
}
