# Amir SM — status

Legend: **Verified** = automated tests and/or driven for real · **Emulator-tested** = tested against fake servers only · **Not verified** · **Not built**.

## Social Studio
| Capability | Status |
|---|---|
| Upload clips (validated with ffprobe, duplicates rejected, originals preserved), reference/example videos kept separate from footage | Verified |
| Chat with the video agent: it decides to chat, make a first draft, or revise the current draft; shows its reasoning in plain language | **Verified live** with the real Anthropic API (one end-to-end run: director → reference analysis → clip analysis → plan → render → caption → review → revision) |
| FFmpeg engine: trim/sequence, speed, 9:16 reframing, blur-fill, crossfade/dip/slide/cut, titles, look presets, fades, loudness, progress, cancel, retry; versioned drafts; approved exports are immutable | Verified (50 engine tests + real renders) |
| Visual understanding: Claude looks at a few sampled still frames per clip (and per reference video) and reports only what is visible | Verified live on **synthetic test-pattern footage only**; quality on your real footage is unknown |
| Local analysis (no AI): exposure, sharpness, shake, scene cuts; used by the basic editor to avoid bad stretches | Verified (real FFmpeg tests) |
| No-AI fallback ("Basic auto-edit"), clearly labelled; revisions need the AI | Verified |
| Caption (Claude), manual edit, approve & download video + caption | Verified |

Limits: the editor sees stills, not motion or sound (no transcription, no music, no generated footage); it cannot do effects the engine lacks (zoom, speed ramps, stickers, beat sync). Reference videos influence pacing/look/framing/text style, not content. The first AI generation took ~13 s to start and a render adds time; a vignette look renders slower. HDR/10-bit phone video and multi-minute edits are untested.

## Email
| Capability | Status |
|---|---|
| Approve→send gate (content hash), edit-after-approve resets approval, sample mailbox clearly labelled | Verified |
| Real IMAP/SMTP provider: connect flow, encrypted credentials, sync, threading, search, attachments, reply/compose | **Emulator-tested only** — never run against a real mailbox |
| AI summarize / draft / tone | Tested with a fake AI; not run live |
| Gmail / iCloud / Yahoo / Fastmail / Proton Bridge presets | Not verified against real providers (Yahoo hosts from memory) |
| Outlook / Microsoft 365 | Not built (needs Microsoft OAuth); shown as unsupported |
| Outgoing attachments, Bcc, folders other than Inbox/Sent | Not built |

## Needs from you
1. Gmail (or other) **app password** entered in Email → Connect mailbox (Gmail: 2-Step Verification + https://myaccount.google.com/apppasswords).
2. Keep `ANTHROPIC_API_KEY` in `.env` (rotate it if it was ever shared).

## Out of scope by decision
Research/competitor tools, dashboards, content calendar, analytics, auto-posting to Instagram, multi-user, n8n/Resend.

## Tests
`npm run typecheck`; `npm test` (see the repo for the current count). Browser checks done on production builds in the in-app browser (desktop + mobile widths); not done: keyboard-only/screen-reader, Firefox/Safari.
