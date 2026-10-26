# Email — real inbox client (IMAP + SMTP)

**Status in one paragraph.** The Email workspace reads a connected mailbox over IMAP, sends over SMTP only after the two-step
approve -> send gate, and caches mail locally. **It has been tested only against in-process emulators and a hand-written fake
provider. It has never been run against a real Gmail / iCloud / Yahoo / Fastmail / Proton Bridge account** (no credentials
existed). Everything marked *unverified* below is research, not observation. Until you connect a mailbox and try it, treat
real-provider behaviour as unproven.

Until a real mailbox is connected the app shows a **sample mailbox with fictional messages** (`isFixture: true`, labelled
"Sample mailbox — fictional messages"). Sending from it is recorded locally and says "NOT delivered". The sample mailbox is hidden
as soon as a real account exists and reappears if you disconnect all real accounts.

## Architecture

```
routes/email.ts ──► EmailService (email/service.ts)         approve→send gate, drafts, accounts, search, read state
                       ├─ cache.ts + threading.ts + sync.ts  provider-independent: local cache, threading, incremental sync
                       ├─ crypto.ts                          AES-256-GCM credential box (key file)
                       └─ MailProvider (email/types.ts)      the seam
                            ├─ providers/imap-smtp.ts   imapflow + nodemailer + mailparser (any IMAP/SMTP server)
                            └─ providers/fixture.ts     the fictional sample mailbox
```

`MailProvider` (see `server/src/email/types.ts`): `testConnection`, `syncFolder` (incremental by UIDVALIDITY/UIDNEXT), `setSeen`,
`searchFolder`, `fetchMessages`, `openAttachment` (stream), `send`. Messages cross the seam as `RemoteMessage` (already parsed,
plain text). **Adding a Gmail-API or Microsoft-Graph (OAuth) provider** = implement `MailProvider` (map "folder/uid" to the API's
message ids), add a branch to the factory in `EmailService.providerFor`, flip the preset's `supported` to `true`, and add an OAuth
sign-in route. Sync, threading, cache, gate, routes and tests do not change. Resend is *not* a mailbox provider and is not used.

New dependencies (all runtime ones are the standard stack for this job): `imapflow` (IMAP client, same author as the others),
`mailparser` (MIME parsing), `nodemailer` (SMTP + message building). Dev only: `hoodiecrow-imap` (strict IMAP emulator by the
imapflow authors — worked first time with imapflow), `smtp-server` (SMTP test server), `@types/*`. No HTML-to-text library: our own
~190-line linear-time converter is used so that safety is fully under test.

## Which mailboxes work

Researched 2026-10-26 from vendor/community pages (not Google/Apple/Microsoft primary docs in every case, and **not tested live**).
Provider policies change; if a login is refused, the error message tells you what the server said.

| Preset | Works? | How you log in | Notes / uncertainty |
|---|---|---|---|
| Gmail / Google Workspace | supported | **App password** (needs 2-Step Verification; myaccount.google.com/apppasswords) | Google moved most apps to OAuth; sources agree app passwords still work for IMAP/SMTP but disagree on dates. Workspace admins can disable them. Gmail auto-files sent mail, so we do not append a copy. *Unverified.* |
| iCloud Mail | supported | **App-specific password** (account.apple.com) | imap.mail.me.com:993 TLS, smtp.mail.me.com:587 STARTTLS (Apple's published settings). Username: full address (Apple's docs have shown both full address and the part before `@`). iCloud does not auto-file sent mail, so the app appends a copy over IMAP. *Unverified.* |
| Yahoo Mail | supported | **App password** (Account security) | Hostnames are from memory (imap.mail.yahoo.com:993, smtp.mail.yahoo.com:465) — **not confirmed in research**. Assumed to auto-file sent mail. *Unverified.* |
| Fastmail | supported | **App password** with IMAP+SMTP scope | imap.fastmail.com:993, smtp.fastmail.com:465 (Fastmail's published settings). Sent copy appended by the app. *Unverified.* |
| Proton Mail via Bridge | supported | **Bridge-generated password** (Bridge app on this computer, paid Proton plan) | 127.0.0.1:1143 / 1025 STARTTLS, self-signed certificate accepted **for loopback hosts only**. Bridge assumed to file sent mail itself. *Unverified.* |
| Other (IMAP + SMTP) | supported | whatever your provider gives you | Plain-text connections are allowed only to servers on this computer. |
| Outlook.com / Hotmail / Microsoft 365 | **not supported** | needs Microsoft **OAuth** | Microsoft stopped accepting password/app-password logins over IMAP for personal accounts in autumn 2024 (community reports; no primary page found) and is retiring Basic Auth for SMTP in Exchange Online (Microsoft message MC786329: disabled by default end of Dec 2026, final date to be announced). Listed with `supported:false` and a reason; nothing pretends to work. |

## Connection flow (what the UI does)

1. `GET /api/email/providers` -> preset cards with plain-language `steps` for creating an app password. Unsupported presets are shown greyed out with `unsupportedReason`.
2. `POST /api/email/accounts/test` -> per-protocol result (IMAP and SMTP separately) with codes `auth_failed`, `app_password_required`, `host_unreachable`, `timeout`, `tls_error` (untrusted certificate), `tls_mismatch` (TLS vs STARTTLS vs port), `server_error`, `unknown`, each with a human message. **Always HTTP 200**; read `ok`.
3. `POST /api/email/accounts` -> runs the same test; on failure `422 connection_failed` (details = the test result); on success stores the account and starts the first sync in the background (`syncState: "syncing"`, then `ok`/`error`).
4. `POST /api/email/accounts/:id/sync` to refresh now; the thread list also triggers a background refresh when the last sync is older than `EMAIL_AUTO_SYNC_SECONDS` (default 120; `0` disables). There is no always-on background daemon: **new mail appears when you open/refresh the Email page** (or after a sync call), not while the app is idle.
5. `DELETE /api/email/accounts/:id` disconnects (see below).

Tests of the connection are rate-limited (`EMAIL_CONNECT_TESTS_PER_MINUTE`, default 6; 429 `rate_limited`) so the endpoint cannot be used as a port scanner. The owner chooses the host, so private/loopback addresses are **allowed** (Proton Bridge needs it); the host must be a plain hostname/IP (no URL, path, credentials). Nothing ever follows a redirect or a URL taken from a mail.

## Credentials

* The password is accepted once (`password` in the connect/test body), AES-256-GCM encrypted (`v1.<iv>.<tag>.<ciphertext>`, random IV, the account id as authenticated data so a blob cannot be moved to another row), and stored in `email_accounts.credentials_enc`. The 256-bit key is a random **key file** (`DATA_DIR/secret.key`, or `EMAIL_KEY_FILE`), created on first use with owner-only permissions where the OS supports it. It is never in the database, never logged, never returned by any route; error messages are scrubbed of the password. Settings (host, port, username) are stored unencrypted in `settings_json`.
* **What this protects:** a leaked/copied/backed-up database file on its own. **What it does not:** anyone or any malware that can read the whole data folder (the key sits beside the DB), or someone with your logged-in Windows account. Use disk encryption (BitLocker) for that.
* **Windows/OneDrive warning:** this repo's `data/` folder lives inside OneDrive. If `DATA_DIR` stays there, OneDrive uploads `secret.key` and the database together, which defeats the point of the key file. Move `DATA_DIR` out of OneDrive, or set `EMAIL_KEY_FILE` to a path outside it (e.g. `%LOCALAPPDATA%\amir-sm\secret.key`).
* Windows ignores POSIX file modes; the key file relies on the folder's ACL (normally your user only).
* Lose or replace the key file -> the account shows `syncState: error` with "cannot be decrypted... Reconnect"; disconnect and connect again. A corrupt key file is never silently overwritten.
* Use an **app password**, not your main password: it can be revoked at the provider without changing your login.

## Reading

* **Sync window:** newest 200 INBOX + 100 Sent messages on the first sync, then incremental (UIDs >= stored UIDNEXT). Flag changes (read/unread) and deletions on the server are picked up for the window; if the server's UIDVALIDITY changes, that folder's cache is discarded and re-imported. Lists are newest-first with unread state.
* **Views:** `mailbox=inbox` (default), `sent`, `all`. Drafts are local to this app (`/api/email/drafts`). Other folders (Archive, custom labels, Spam, Trash) are not read.
* **Threading** (first match wins): the server's own thread id when it has one (Gmail `X-GM-THRID`; servers with OBJECTID `THREADID`) -> `Message-ID` / `In-Reply-To` / `References` in both directions (a reply synced before its parent still joins; a message linking two threads merges them) -> same normalised subject, but **only for messages that carry a `Re:`/`Fwd:`-style prefix and within 30 days**, so two unrelated "Hello" mails are not merged. Mail you send to yourself (same Message-ID in Inbox and Sent) is shown once.
* **Bodies are plain text only.** `text/plain` is used when present; HTML-only mail is converted to text by our converter (`bodySource: "html_converted"`): `script/style/head/iframe/object/svg/...` contents and comments are dropped, images become `[image: alt]` and are **never fetched**, links print their real `http(s)/mailto` target after the link text and are never followed, other schemes (`javascript:`, `data:`) are dropped, entities are decoded once, bidi/zero-width spoofing characters are removed. HTML is never served or rendered by this app. Bodies are cut at 100,000 characters (`truncated: true`); only the first 512 KB of a message is downloaded for the body.
* **Opening a mail marks it read, on the server too** (standard mail-client behaviour): the UI calls `POST /api/email/threads/:id/read {read:true}` when a thread is opened, which sets `\Seen` on the server. `read:false` marks the newest incoming message unread again. If the server cannot be reached the local change is kept, `serverSyncError` explains it, and it is retried on the next sync (a sync never overwrites a not-yet-pushed local change). Nothing else on the server is modified: no deleting, moving or flagging. Syncing itself opens folders read-only and uses `BODY.PEEK`, so it does not mark anything read.
* **Search:** local cache search (`q`, all words must match subject/body/sender/recipients; wildcards escaped). `serverSearch=true` additionally runs an IMAP `SEARCH TEXT` on INBOX and Sent (max 50 hits each, rate-limited), imports the matching older messages into the cache, then searches locally. Non-ASCII server-side search is *unverified*.
* **Attachments:** listed per message (name, type, approximate size, `risky` for executable/script/HTML types). `GET /api/email/attachments/:id` streams the part from the server on demand: `Content-Disposition: attachment` with a sanitised file name (no paths, reserved characters or Windows device names, length-bounded, RFC 5987 UTF-8 name), `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cache-Control: no-store`; only an allow-list of inert content types is passed through, everything else (incl. `text/html`, `image/svg+xml`) is `application/octet-stream`. Cap: 25 MB (413 above; enforced on the stored size and again while streaming). Attachments are never executed, rendered or scanned by this app — a `risky: true` file still deserves care.

## Sending

* Only through the existing gate: create draft -> `approve` (hash of account, recipients, subject, body) -> `send` (409 `not_approved` / `changed_since_approval` otherwise). Any edit resets approval. A second simultaneous `send` for the same draft is refused (`send_in_progress`), so a double click cannot send twice.
* SMTP via nodemailer with `From` = the account address, a generated `Message-ID`, and for replies `In-Reply-To` + `References` taken from the newest message of the thread. Drafts created inside a thread get a `Re:` subject (not stacked). Subjects/addresses are stripped of CR/LF; recipients must be plain addresses (no display names, lists or quotes).
* Result honesty: `sendResult.delivered: true` means **"accepted by your provider's outgoing server"**, never "the recipient got it" (the note says so, and lists rejected recipients when only some were accepted). If *every* recipient is refused nothing is marked sent.
* **Sent copy:** if the preset does not auto-file sent mail (iCloud, Fastmail, custom by default) the exact message is appended to the Sent folder over IMAP; Gmail/Yahoo/Bridge are assumed to do it themselves (no duplicate). If the append fails the mail is still reported as sent, with a note. A locally recorded copy is adopted by the real Sent copy on the next sync (by Message-ID, falling back to same subject/body within 15 minutes in case a provider rewrites the id).
* A failed send keeps the draft (`status: failed`, real error text) and needs a fresh approval to retry.
* **Out of scope for now:** outgoing attachments, HTML mail, Bcc, signatures, scheduled send, delete/move/archive.

## Disconnect

`DELETE /api/email/accounts/:id` deletes, in one transaction, the encrypted credentials, the account's cached threads/messages/attachments/refs and its **drafts**, and returns the counts. **It never touches the mailbox on the server.** (To also revoke access, delete the app password at your provider.) The sample mailbox returns if no real account is left.

## Settings status

`EmailService.integrationStatus()` reports `fixture` (sample only), `connected` (addresses + last sync time; a note if some account has a sync error), `error` (every connected account failed its last sync, with the real reason) or `not_configured` (no accounts and the sample mailbox disabled).

## Security notes

* Every route validates input with zod (sizes, host syntax, port range, enum security, no control characters in password/username; unknown fields rejected). Validation errors never echo the password.
* `security: "none"` (plain text) and `allowSelfSigned` are accepted only for loopback hosts (`localhost`, `127.0.0.0/8`, `::1`). Certificates are otherwise verified (TLS >= 1.2).
* Mail content is untrusted: headers are control-char-stripped, subjects capped, file names sanitised, HTML reduced to text, `nodemailer` file/URL access disabled, no remote content loaded. Email text *is* sent to the Anthropic API only when you press Summarize/Draft (existing AI layer; the route now caps it to the last 15 messages x 8,000 characters). Prompt-injection hardening of that text is the AI layer's job.
* One short-lived IMAP connection per operation; nothing stays connected.

## Tests (no network, no real mailbox)

`server/test/email/`: `units.test.ts` (crypto roundtrip/tamper, HTML safety incl. pathological input, sanitisers, threading helpers, MIME parsing, error mapping, rate limiter); `imap-provider.emulator.test.ts` (real imapflow/nodemailer against `hoodiecrow-imap` and `smtp-server`: login/TLS/unreachable mapping, sync, incremental, UIDVALIDITY, flags, attachments, search, send, Sent append); `sync.fake.test.ts` (sync/threading/read-state/send logic against a hand-written fake provider); `api.real.test.ts` (HTTP flow with the emulators: connect, hidden sample, search, attachment headers, credentials never leaked, gate, disconnect). Plus `server/test/api/email.test.ts` (sample mailbox and gate). **Fake-only:** UIDVALIDITY wipes, expunge detection, pending-seen retry, thread merging/placeholder adoption (logic tests, not protocol tests). **Emulator-only:** all IMAP/SMTP behaviour. **Nothing** has touched a real provider.

## Unverified assumptions about real providers

1. Gmail, iCloud, Yahoo and Fastmail currently accept an app password for IMAP and SMTP with the hosts/ports in the presets (Yahoo's hostnames are from memory).
2. Which providers auto-file SMTP-sent mail in Sent (Gmail, Yahoo, Bridge assumed yes; iCloud, Fastmail no). A wrong guess is mild: assumed yes but really no = no copy in the server's Sent folder; assumed no but really yes = a duplicate copy there. The local view is unaffected either way.
3. Gmail preserves a client-supplied `Message-ID` on submission (otherwise the fuzzy subject/body adoption handles it).
4. Gmail's IMAP `\Sent` special-use folder (`[Gmail]/Sent Mail`) is found, and `X-GM-THRID` returned by imapflow is stable across INBOX and Sent. Same for Fastmail's OBJECTID `THREADID`.
5. imapflow's partial `BODY.PEEK[]<0.524288>` fetch and `BODYSTRUCTURE` part ids behave on big real mailboxes as in the emulator; Yahoo's requirement of the IMAP `ID` command is handled by imapflow automatically.
6. iCloud's username form (full address vs local part).
7. Error strings: the `app_password_required` detection relies on providers' wording ("Application-specific password required", "web login required"); unknown wordings fall back to `server_error` with the server's own text.
8. Server-side `SEARCH TEXT` with non-ASCII queries.
9. Behaviour with 50k+ message mailboxes, rate limits/lockouts after repeated wrong passwords at the provider (a wrong password retried often may lock the account at the provider; the app rate-limits to 6 tests/min).
10. Windows file permissions of `secret.key` (relies on folder ACL).
