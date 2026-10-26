# Amir SM — honest status (v0.1.0)

Legend: **Tested** = automated tests and/or driven end-to-end in a browser by us · **Awaiting credentials** = code exists, cannot be exercised without an external account · **Partial** · **Not implemented**.

## Fully implemented and tested (no external accounts needed)
| Area | Evidence |
|---|---|
| Owner password auth, sessions, lockout, same-origin + Host checks | API tests (`auth-security.test.ts`) |
| Persistent projects, assets, versions, jobs (SQLite, migrations) | API tests; verified survives server restart |
| Upload validation (extension allow-list, ffprobe must read it, duplicates rejected, size limit, nothing left behind on rejection) | API tests |
| Source footage preserved (never modified); versioned renders; immutable approved exports (video + caption + plan + sha256) | API tests (`studio.e2e.test.ts`) |
| FFmpeg engine: probe, multi-clip trim/sequence, speed, vertical/4:5/1:1 framing (cover with focus / blurred contain), rotated phone footage, crossfade / dip-to-black / slide / cut, silence insertion for clips without audio, per-clip mute/volume, loudness normalisation, optional **owner-uploaded** music (looped, faded), titles (incl. Amharic), burned-in subtitles from owner-supplied text, look presets, fades, progress, cancel, retryable-error classification, export verification | 50 engine tests on real renders of synthetic footage; frames visually inspected |
| Job queue: retries with backoff, cancel, re-queue after restart, visible progress/stages | API tests |
| "Basic auto-edit (no AI)" rules planner, clearly labelled in the UI | tests + browser |
| Manual caption writing/editing with quality checks recomputed | API test |
| Web UI: Home, Social Studio (full journey), Library, Research, Email, Settings; responsive desktop/mobile; light/dark | driven in the in-app browser (desktop 1280, mobile 375/390), no horizontal overflow |
| Email workspace on the **local sample mailbox**: search, filters, threads, drafts, two-step approve→send gate, edit-after-approve invalidates approval, "NOT delivered" labelling | API tests + browser |
| Research workspace storage: competitors, notes, search, history; truthful disabled states | API tests + browser |
| n8n bridge (outbound events, token-guarded inbound endpoints) | API tests (inbound); outbound uses mocked fetch only |

## Implemented, awaiting credentials (never run against the real service)
| Feature | Needs | Caveat |
|---|---|---|
| AI edit planning, revisions, captions, quality-review consistency check | `ANTHROPIC_API_KEY` | 88 AI-layer tests use a **fake client**. Prompts, tool schemas and real-model behaviour are unverified. Forced `tool_choice` is not used (per current model docs); the app validates and repairs output instead. |
| Email AI: thread summary, drafting, tone adjust | API key | same |
| Competitor analysis of pasted material | API key | same |
| Market research via Anthropic web search | API key + `AI_WEB_SEARCH_ENABLED=true` (billed per search) | same |
| Sending email via Resend | `RESEND_API_KEY`, `RESEND_FROM` (verified sender) | send-only; adapter tested with mocked HTTP |
| n8n workflows (3) | n8n instance + credentials | JSON structurally validated against node schemas; **never run in n8n**. n8n Cloud cannot reach a localhost app (see docs/N8N.md). |

## Partial / limitations
- **No AI ⇒ revisions are refused** (409 with explanation); captions are not generated (write by hand).
- **No automatic transcription**: subtitles only from text the owner types; timings are spread evenly, not synced to speech. Not a bug — nothing is invented.
- The editor cannot understand footage content (no vision); AI plans from the brief, clip metadata and revision text only. Trim points are not scene-aware.
- Video: `vignette` look is ~2x slower to render; 10-bit/HDR phone footage is converted without tone-mapping (untested); loudness is single-pass; only Windows font paths exercised; multi-minute renders never tried.
- Email mailbox is a **fictional sample**. No Gmail/Outlook/IMAP reading.
- Research cannot fetch Instagram or other platforms by design (no authorised access); only pasted material, manual notes, opt-in web search, or n8n RSS feeds you list.
- UI: no drag-reorder of clips, no compare dialog verified (needs two AI-made drafts), no per-cue subtitle timing editor, research notes not editable, library capped at 300 items, no web-app automated tests.
- No video clip deletion (by design: footage is preserved; clips can be excluded, projects archived).

## Not implemented
Real mailbox providers (Gmail/Outlook/IMAP/OAuth) · speech-to-text · generative video · music library · direct posting to Instagram · multi-user accounts · public deployment/HTTPS · cost estimation in currency (only call/token counters).

## Test results
`npm run typecheck` clean. `npm test`: **164 tests passing** (AI layer 88, video engine 50, HTTP/E2E 26 — see README for how to run). Browser journey verified on a production build: set password → project → upload 3 clips + audio → draft with live progress → playable 1080x1920 H.264/AAC output → manual caption → approve → download; restart persistence.
Not verified anywhere: any path that calls the real Anthropic, Resend or n8n services; keyboard-only/screen-reader use; Firefox/Safari.

## Accounts and credentials needed
1. **Anthropic API key** — AI planning, revisions, captions, email AI, analysis (set spend limits via `AI_DAILY_*`).
2. **Resend account + verified sending domain/address** — only if you want real email delivery (and for the n8n notification workflows).
3. **A real mailbox provider decision** (Gmail / Outlook / IMAP + OAuth app or app-password) — required before real mailbox reading can be built.
4. **n8n** — self-hosted on the same machine (simplest) or Cloud with a tunnel you choose to expose.
5. Nothing else; FFmpeg and SQLite need no accounts.
