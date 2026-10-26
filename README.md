# አ Amir SM

A private, local-first workspace with two jobs:

- **Social Studio** — upload clips, chat with an AI video editor about what you want (optionally attach an example video for style), review the draft, ask for changes, approve, download the video and caption.
- **Email** — a real inbox client (IMAP/SMTP) with AI summaries, drafting and tone help. Nothing is ever sent without your explicit approval.

Everything runs on your machine. FFmpeg and SQLite need no accounts. AI features use your own Anthropic API key.

> What is tested, what is not, and what needs credentials: **[docs/STATUS.md](docs/STATUS.md)**.

## Requirements
Node.js 22+ (developed on 24) and npm. FFmpeg arrives with `npm install`.

## Install & run
```bash
npm install
cp .env.example .env     # then edit (see below)
npm run build
npm start                # http://127.0.0.1:4300
```
First visit: set your owner password (10+ characters). The server listens on `127.0.0.1` only — use `127.0.0.1` (not `localhost`) in the browser.

Set `DATA_DIR` in `.env` to a folder that is **not** synced by OneDrive/Dropbox (a live SQLite database and large videos can corrupt there). Add `ANTHROPIC_API_KEY` to enable the AI editor, captions and email AI; without it the app makes a clearly-labelled basic edit.

Development with hot reload: `npm run dev` (API :4300, UI :5300).

## Using it
**Social Studio:** New video → add clips → tell the editor what you want (attach an example video with the paperclip if you have one) → watch the draft → ask for changes in the chat → Approve & download.
**Email:** Email → Connect mailbox (Gmail/iCloud/Yahoo/Fastmail with an app password, Proton Bridge, or custom IMAP). See [docs/EMAIL.md](docs/EMAIL.md).

## Data layout
`DATA_DIR/uploads` originals (never modified) · `renders` versioned drafts · `exports` approved video + caption + plan (write-protected) · `amir-sm.db` database · `secret.key` encryption key for stored mailbox credentials.

## Tests
```bash
npm run typecheck
npm test        # unit + real FFmpeg renders + HTTP end-to-end; takes a few minutes; no network
```

## Docs
[ARCHITECTURE](docs/ARCHITECTURE.md) · [API](docs/API.md) · [EMAIL](docs/EMAIL.md) · [STATUS](docs/STATUS.md)
