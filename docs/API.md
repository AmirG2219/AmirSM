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
- `GET /api/versions/:id` · `POST /api/versions/:id/cancel` · `POST /api/versions/:id/retry {replan?}` (failed only)
- `PATCH /api/versions/:id/caption {hook, body, cta, hashtags[]}` (ready only → captionStatus `manual`)
- `POST /api/versions/:id/caption/regenerate {feedback?}` (needs API key, else 409 `ai_unavailable`)
- `POST /api/versions/:id/approve` (ready only) → copies video + caption + plan into immutable `exports/…`
- `GET /api/versions/:id/video[?download=1]` (Range), `GET /api/versions/:id/caption.txt[?download=1]`
- `GET /api/jobs` → active jobs

Version lifecycle: `queued → planning → rendering → captioning → ready → approved` (or `failed`, `superseded`). Poll `GET /api/projects/:id` or `/api/versions/:id` every ~1.5s while active; `version.job.progress` is 0..1 and `job.message` is human-readable. `planSource` is `ai` or `rules` ("Basic auto-edit, no AI") — surface it. `captionStatus` `unavailable|failed` ⇒ show `captionNote`; the owner can type a caption.

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
- `GET /api/email/accounts` (note `isFixture`, `canRead`, `canSend`, `statusDetail`)
- `GET /api/email/threads?accountId=&q=&filter=unread|needs_reply`, `GET /api/email/threads/:id`, `POST …/:id/read {read}`, `POST …/:id/summarize`
- `POST /api/email/ai/draft {instruction, threadId?, tone?}` → `{subject, body}` · `POST /api/email/ai/tone {text, tone}` → `{text}` (nothing is sent)
- drafts: `GET|POST /api/email/drafts`, `GET|PATCH /api/email/drafts/:id` (editing resets approval)
- `POST /api/email/drafts/:id/approve` then `POST /api/email/drafts/:id/send`. Send fails 409 unless approved and unchanged. With the sample mailbox `sendResult.delivered=false` — show "recorded locally, not delivered".

## n8n (machine, bearer `N8N_INBOUND_TOKEN`, no cookie)
`GET /api/integrations/n8n/status|digest`, `POST /api/integrations/n8n/research/ingest`.
Outbound events (signed) go to `${N8N_BASE_URL}/webhook/amir-sm-events`.
