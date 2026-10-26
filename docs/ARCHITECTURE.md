# Amir SM — architecture

Private, single-owner, local-first. Two workspaces (Social Studio, Email) plus Settings.

| Layer | Choice |
|---|---|
| Runtime | Node 24 + TypeScript (`tsx`; `tsc --noEmit` for types) |
| API | Fastify 5 + zod, cookie session, same-origin + Host checks, listens on 127.0.0.1 |
| DB | SQLite (`node:sqlite`), SQL migrations in `server/src/db/migrations` |
| Jobs | In-process SQLite-backed queue: retries, cancel, progress, re-queue after restart |
| Video | FFmpeg (`ffmpeg-static`): the AI only produces an `EditPlan`; the engine validates and renders it |
| AI | `@anthropic-ai/sdk`, tool-use structured output validated by zod, daily call/token limits, usage log |
| Mail | IMAP (imapflow) + SMTP (nodemailer) behind a `MailProvider` interface; credentials AES-256-GCM encrypted |
| Web | React 19 + Vite, plain CSS tokens (cream/slate/teal), Inter + Fraunces |

## Studio flow
```
chat message ─► directorTurn (Claude) ─► chat | generate | revise
                                              │
reference videos ─► pace (FFmpeg scene cuts) + style (Claude, sampled stills)
                                              ▼
produce_version job:  analyze clips (FFmpeg metrics + Claude stills, cached)
   ─► plan (EditPlan: Claude, or rules fallback) ─► validate ─► render (FFmpeg)
   ─► caption (Claude) ─► review (ffprobe + checks) ─► ready ─► approve ─► immutable export
```
Truthfulness: `version.analysis.visual` is true only if Claude really looked at sampled frames; the basic editor is labelled "no AI"; unsupported requests are reported in `limitations`.

## Layout
`server/src/{video,ai,email,routes,jobs}`, `shared/` (zod contracts: EditPlan, analysis, API DTOs), `web/src`, `server/test`. Files live in `DATA_DIR` (`uploads`, `renders`, `exports`, `thumbs`, `amir-sm.db`, `secret.key`).

See [API.md](API.md), [EMAIL.md](EMAIL.md), [STATUS.md](STATUS.md).
