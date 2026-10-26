# አ Amir SM

A private, local-first creative workspace: turn raw clips into an Instagram-ready vertical video with an AI-assisted edit plan and caption, research content ideas, and manage email with human review before anything is sent.

Runs entirely on your machine. Needs no paid video tools. AI features need your own Anthropic API key (optional — the app still edits video without it).

> Honest status of every feature (what is tested, what awaits credentials, what is not built): **[docs/STATUS.md](docs/STATUS.md)**.

## Requirements
- Node.js 22+ (developed on Node 24; uses the built-in `node:sqlite`)
- npm. FFmpeg is installed automatically by `npm install` (`ffmpeg-static`, `ffprobe-static`) — nothing to install system-wide.

## Install & run
```bash
npm install
cp .env.example .env        # then edit; every value is optional to start
npm run build               # builds the web app (once, and after UI changes)
npm start                   # http://127.0.0.1:4300
```
First visit asks you to **set the owner password** (≥10 characters). Only you can sign in; the server listens on `127.0.0.1` only.

Development with hot reload: `npm run dev` (API on :4300, UI on http://localhost:5300).

**Important:** set `DATA_DIR` in `.env` to a folder that is *not* synced by OneDrive/Dropbox (e.g. `C:\AmirSM\data`). Syncing a live SQLite database and large videos can corrupt data. The app warns at startup if it detects this.

## What lives where
`DATA_DIR/uploads` your original clips (never modified) · `renders` versioned drafts · `exports` approved video + caption + plan (write-protected, never overwritten) · `amir-sm.db` projects, versions, jobs, research, email.

## Using it
1. **Social Studio → New project**, drop in clips, describe the video, pick a style, **Create draft**.
2. Watch progress, play the draft, read the caption, **Request changes** (needs the API key) or **Approve**.
3. Approving writes an immutable export you can download (video + caption).

## Tests
```bash
npm run typecheck
npm test                    # unit + real FFmpeg renders + HTTP end-to-end (takes a few minutes)
```
Tests use synthetic footage generated with FFmpeg (`scripts/make-test-footage.ts`) and fake AI clients; they never call the network.

## Configuration
See `.env.example`. Nothing secret is ever committed (`.env` is git-ignored).

## Connecting external services (when you are ready)
See the list in [docs/STATUS.md](docs/STATUS.md#accounts-and-credentials-needed). n8n workflows to import are in `n8n/workflows/`; setup notes in [docs/N8N.md](docs/N8N.md).

## Architecture & API
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/API.md](docs/API.md)
