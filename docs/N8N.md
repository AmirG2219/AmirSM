# n8n integration

The app never depends on n8n. It uses n8n only where scheduling or outbound coordination adds value:

| Workflow file | Trigger | What it does |
|---|---|---|
| `amir-sm-event-notifier.json` | Webhook from the app (`version.ready`, `version.failed`) | Emails you via Resend when a draft is ready or failed. |
| `amir-sm-daily-digest.json` | Schedule, 08:00 daily | Pulls `/api/integrations/n8n/digest`; emails you only if something needs attention. |
| `amir-sm-research-feeds.json` | Schedule, Mondays 09:00 | Reads public RSS feeds **you list** and saves them as research notes via `/api/integrations/n8n/research/ingest`. |

All three are imported **inactive**. They were structurally validated (node types/versions checked against n8n's schema, connections checked) but **have not been run on a live n8n instance**.

## Setup
1. In n8n: Workflows → Import from file → each JSON in `n8n/workflows/`.
2. Create credentials (Header Auth): 
   - *Amir SM webhook secret* — header `x-amirsm-secret`, value = `N8N_WEBHOOK_SECRET` from `.env`.
   - *Amir SM inbound token* — header `Authorization`, value `Bearer <N8N_INBOUND_TOKEN>`.
   - *Resend API key* — header `Authorization`, value `Bearer re_…` (only for the email-sending workflows).
3. Edit placeholders: sender/recipient addresses in the Resend nodes, the feed list in "Feeds to read", and the app URL (`http://localhost:4300`) if n8n isn't on the same machine.
4. In `.env`: `N8N_BASE_URL`, `N8N_WEBHOOK_SECRET`, `N8N_INBOUND_TOKEN`; restart. Settings → "Test n8n" sends a `ping`.

## Reachability note
Amir SM listens on localhost only. **n8n Cloud cannot reach it** without you exposing it (tunnel/reverse proxy) — a deliberate decision this project does not make for you. A self-hosted n8n on the same machine works as-is. The outbound webhook (app → n8n) works with either.
