# Amir SM — HTTP API

Types: `shared/api.ts` (DTOs), `shared/domain.ts`, `shared/editPlan.ts`. Source of truth for behaviour: `server/src/routes/*.ts`.
Same-origin cookie session (`amirsm_session`, httpOnly, SameSite=Strict). Errors: `{ error: { code, message, details? } }`.
Dev: Vite on :5300 proxies `/api` to the API on :4300. Production: API serves `web/dist`.

## Auth (public)
- `GET /api/auth/state` → `AuthState`
- `POST /api/auth/setup {password}` (≥10 chars; only while `setupRequired`; logs in) · `POST /api/auth/login {password}` · `POST /api/auth/logout`
- 429 `too_many_attempts` after repeated failures.

## Projects / Studio
- `GET /api/projects?status=&q=&includeArchived=true` → `ProjectSummary[]`
- `POST /api/projects {title, brief?, stylePreset?, format?}` → `ProjectDetail` (201)
- `GET /api/projects/:id` → `ProjectDetail` (`versions` newest first; each has `job` progress while running)
- `PATCH /api/projects/:id {title?, brief?, stylePreset?, format?, subtitleLines?}`
- `POST /api/projects/:id/archive|unarchive` (never deletes files)
- `POST /api/projects/:id/assets` multipart, field name `files` (repeat) → `UploadResult` (per-file ok/error; duplicates and non-media rejected)
- `PATCH /api/assets/:id {excluded?, sortOrder?}`; `GET /api/assets/:id/file` (Range), `/thumb`
- `POST /api/projects/:id/versions {instruction?, baseVersionId?}` → `VersionDTO` (201). First call = initial draft (instruction defaults to the project brief). Later calls = revisions (instruction required). 409 `busy` while a draft is in production.
- `GET /api/versions/:id` · `POST /api/versions/:id/cancel` · `POST /api/versions/:id/retry {replan?}` (failed or cancelled)
- `PATCH /api/versions/:id/caption {hook, body, cta, hashtags[]}` (ready only → captionStatus `manual`)
- `POST /api/versions/:id/caption/regenerate {feedback?}` (needs API key, else 409 `ai_unavailable`)
- `POST /api/versions/:id/approve` (ready only) → copies video + caption + plan into immutable `exports/…`
- `GET /api/versions/:id/video[?download=1]` (Range), `GET /api/versions/:id/caption.txt[?download=1]`
- `GET /api/jobs` → active jobs

Version lifecycle: `queued → planning → rendering → captioning → ready → approved` (or `failed`, `cancelled`, `superseded`). Revisions return 409 `ai_unavailable` when no API key is configured. Poll `GET /api/projects/:id` or `/api/versions/:id` every ~1.5s while active; `version.job.progress` is 0..1 and `job.message` is human-readable. `planSource` is `ai` or `rules` ("Basic auto-edit, no AI") — surface it. `captionStatus` `unavailable|failed` ⇒ show `captionNote`; the owner can type a caption.

## Home / Library / Settings
- `GET /api/dashboard` → `DashboardDTO` (real data only; empty arrays when empty)
- `GET /api/library?q=&kind=clip|draft|export&status=&projectId=` → `LibraryItem[]`
- `GET /api/events?limit=` · `GET /api/settings/status` → `SettingsStatus` · `POST /api/settings/n8n/test`

## Research
- `GET /api/research/capabilities` → availability + reason per capability (show reasons verbatim when unavailable)
- competitors: `GET|POST /api/research/competitors`, `PATCH|DELETE /api/research/competitors/:id`
- notes: `GET /api/research/notes?kind=&q=&competitorId=`, `POST /api/research/notes`, `DELETE /api/research/notes/:id`
- `POST /api/research/competitors/:id/analyze {materials:[{label,text,url?}], focus?}` (only analyses pasted material) → `ResearchRunDTO`
- `POST /api/research/market {topic, niche?}` (409 `ai_unavailable` unless web search is enabled)
- `GET /api/research/runs`

## Email
Real inbox client over IMAP+SMTP (see `docs/EMAIL.md`); DTOs in `shared/api.ts` (Email block). Plain text only. Credentials are never returned.

**Connect**
- `GET /api/email/providers` → `EmailProviderPreset[]` (`id, label, supported, unsupportedReason, imap, smtp, passwordKind, autoSavesSent, steps[], helpUrl, notes`). `supported:false` (Outlook/Microsoft: needs OAuth) must be shown disabled with the reason.
- `GET /api/email/accounts` → `EmailAccountDTO[]` (`id, provider 'fixture'|'imap', presetId, label, address, isFixture, canRead, canSend, statusDetail, imapHost, syncState 'never'|'syncing'|'ok'|'error', lastSyncAt, lastError`). The sample mailbox (`isFixture:true`, label "Sample mailbox — fictional messages") is listed only while no real account exists.
- `POST /api/email/accounts/test` body `EmailConnectInput` = `{presetId, address, password, username?, label?, imap?, smtp?, allowSelfSigned?, autoSavesSent?}` (`imap`/`smtp` = `{host, port, security:'tls'|'starttls'|'none'}`, required only for `presetId:"custom"`; `none`/`allowSelfSigned` only for localhost) → 200 `{ok, imap:{ok,code,message}, smtp:{ok,code,message}, sentFolder}`; codes `auth_failed|app_password_required|host_unreachable|timeout|tls_error|tls_mismatch|server_error|unknown`. Saves nothing. 400 `validation_failed|bad_request|unknown_provider|provider_not_supported|insecure_connection`; 429 `rate_limited` (default 6/min).
- `POST /api/email/accounts` same body → 201 `EmailAccountDTO` (sync starts in the background: poll `GET /api/email/accounts` for `syncState`). 422 `connection_failed` (`error.details` = the test result), 409 `already_connected`.
- `POST /api/email/accounts/:id/sync` body `{wait?: boolean}` → 202 `EmailAccountDTO` (or 200 after finishing when `wait:true`). Failures are in `syncState:'error'` + `lastError`, not an HTTP error.
- `DELETE /api/email/accounts/:id` → `{ok:true, removed:{threads, messages, drafts}}`. Deletes stored credentials + local cache + that account's drafts; never touches the server mailbox. 400 `fixture_account` for the sample mailbox.

**Read**
- `GET /api/email/threads?mailbox=inbox|sent|all (default inbox)&accountId=&q=&filter=unread|needs_reply&serverSearch=true&limit=&before=` → `EmailThreadSummary[]` newest first (`id, accountId, subject, snippet, lastMessageAt, unread, needsReply, hasSummary, from, messageCount, hasAttachments`). `serverSearch=true` (needs `q`) also searches the mail server and imports older matches (slower; 502 `server_search_failed`). Listing also triggers a background refresh if the last sync is stale.
- `GET /api/email/threads/:id` → `EmailThreadDetail` (`messages[]`: `id, direction, fromName, fromAddr, to, cc, date, body (plain text), bodySource 'plain'|'html_converted'|'none', truncated, unread, attachments[]`; `summary`; `serverSyncError`). Pure read, no side effects.
- `POST /api/email/threads/:id/read {read}` → `EmailThreadDetail`. Marks read/unread locally **and on the server (`\Seen`)**; call it when the owner opens a thread. If the server could not be updated `serverSyncError` is set and it is retried at the next sync.
- `GET /api/email/attachments/:id` (`attachments[].downloadUrl`) → streamed file: `Content-Disposition: attachment`, `nosniff`, sandbox CSP, ≤ 25 MB (413 `attachment_too_large`), 404 when gone from the server. Attachments have `risky:true` for executable/script/HTML types: warn before opening.
- `POST /api/email/threads/:id/summarize` → `EmailThreadDetail` (AI; 409 `ai_unavailable` without a key).
- `POST /api/email/ai/draft {instruction, threadId?, tone?}` → `{subject, body}` · `POST /api/email/ai/tone {text, tone}` → `{text}` (nothing is sent).

**Write / send**
- drafts: `GET /api/email/drafts?status=`, `POST /api/email/drafts {accountId, threadId?, to[], cc?, subject, body, aiAssisted?}` (201; in a thread the subject becomes `Re: …`), `GET|PATCH /api/email/drafts/:id` (editing resets approval). Recipients: plain addresses only, max 10.
- `POST /api/email/drafts/:id/approve` then `POST /api/email/drafts/:id/send` → `EmailDraftDTO`. 409 `not_approved` / `changed_since_approval` / `send_in_progress` / `already_sent`; 502 `send_failed` (message = the real provider error; draft kept as `status:'failed'`, approve again to retry). `sendResult.delivered:true` = accepted by the outgoing mail server (not proof of receipt); sample mailbox: `delivered:false`, "recorded locally, NOT delivered".
- Out of scope: outgoing attachments, Bcc, HTML mail, delete/move.

## n8n (machine, bearer `N8N_INBOUND_TOKEN`, no cookie)
`GET /api/integrations/n8n/status|digest`, `POST /api/integrations/n8n/research/ingest`.
Outbound events (signed) go to `${N8N_BASE_URL}/webhook/amir-sm-events`.
