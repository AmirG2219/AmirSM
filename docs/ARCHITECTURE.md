# Amir SM — Architecture

**Product:** a private, local-first creative workspace (logo: አ). One owner, one machine.

## Stack and why
| Layer | Choice | Why / tradeoff |
|---|---|---|
| Runtime | Node 24 + TypeScript (tsx, `tsc --noEmit` for types) | Already installed; no build step for the server. |
| API | Fastify 5 + zod | Fast, schema validation at the boundary, multipart streaming for large uploads. |
| DB | SQLite via built-in `node:sqlite` | Zero install, no native compile, real persistence. Single-writer is fine for one owner. Swap-able later (all SQL is in `server/src/db/`). |
| Jobs | In-process SQLite-backed queue (`server/src/jobs`) | Survives restarts (stale jobs re-queued), retries with backoff, progress persisted. No Redis. |
| Video | FFmpeg (`ffmpeg-static`, `ffprobe-static`) | Free, local, deterministic. AI only produces an `EditPlan`; FFmpeg executes it. |
| AI | `@anthropic-ai/sdk`, forced tool-use for structured output, zod-validated | Usage counted & capped per UTC day (`ai_usage`). |
| Web | React 19 + Vite + react-router, plain CSS tokens | Small, no UI framework lock-in; quiet, premium design. |
| Automation | n8n workflows in `n8n/workflows/*.json` | Only for scheduled/async coordination; app works fully without n8n. |

Not chosen: Next.js (heavier than needed for a local single-user tool), Postgres (needs a service), Redis/BullMQ (needs a service), cloud storage (no unauthorised cloud).

## Process layout
```
 Browser (React) ──cookie session──► Fastify API ──► SQLite (data/amir-sm.db)
                                         │            ├─ uploads/   (preserved source footage, never modified)
                                         │            ├─ renders/   (versioned drafts  v1.mp4, v2.mp4 …)
                                         │            └─ exports/   (approved copy + caption.txt, never overwritten)
                                         ├─► Job worker ─► Orchestrator ─► AiService (plan, caption, review)
                                         │                              └► VideoEngine (probe, validate, render, verify)
                                         ├─► EmailProvider (fixture | resend-send-only | …)
                                         └─► n8n bridge (signed outbound events, token-guarded inbound endpoints)
```

## Production pipeline (one "version")
`produce_version` job: **plan** (Creative Director+Video Editor → `EditPlan`, or rules fallback) → **validate** (engine checks plan against real asset durations) → **render** (FFmpeg, progress → DB) → **caption** (Copywriter; skipped with visible reason if AI is unavailable) → **review** (deterministic ffprobe checks + optional AI consistency pass) → version `ready`. Owner may revise (creates version N+1 with the request and previous plan) or approve (copies render + caption into `exports/`, immutable).

## Directory ownership
| Path | Owner |
|---|---|
| `shared/**` contracts | lead (changes announced) |
| `server/src/video/**`, `scripts/make-test-footage.ts`, `server/test/video/**` | video agent |
| `server/src/ai/**`, `server/test/ai/**` | AI agent |
| `server/src/{index,app,config,db,auth,routes,jobs,orchestrator,email,research,integrations}/**` | lead |
| `web/**` | frontend agent |
| `server/test/{api,e2e}/**`, security review | QA agent / lead |

## Data model (SQLite; see `server/src/db/migrations`)
owner, sessions, projects, assets, versions, jobs, events (real activity feed), ai_usage, competitors, research_notes, research_runs, email_accounts, email_threads, email_messages, email_drafts, settings.

## Truthfulness rules
- Dashboard numbers come from queries only; empty state when empty.
- Integration status is computed live from config + health probes; unconfigured ⇒ "Not connected".
- Rules-based planner results are labelled "Basic auto-edit (no AI)". Missing AI ⇒ caption not generated, owner can write one manually.
- No automatic transcription ⇒ subtitles only from owner-supplied text.
- Email fixture provider is labelled "Local sample mailbox"; "sending" through it never leaves the machine and says so.

## Acceptance (v1)
Upload clips → brief → plan → playable 9:16 MP4 with progress → caption (needs API key) → review → revise → approve → download video + caption. Persistent across restarts. All states visible, including failures and retries.
