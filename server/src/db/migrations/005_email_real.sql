-- Real mailbox support (IMAP/SMTP). The cache tables below are a LOCAL COPY of mail that lives on the
-- provider's server; disconnecting an account deletes this copy and the stored credentials, never the server mail.

-- accounts: connection settings (no secrets), encrypted credential blob, sync state
ALTER TABLE email_accounts ADD COLUMN preset_id TEXT;
ALTER TABLE email_accounts ADD COLUMN settings_json TEXT;
ALTER TABLE email_accounts ADD COLUMN credentials_enc TEXT;
ALTER TABLE email_accounts ADD COLUMN sync_state TEXT NOT NULL DEFAULT 'never';
ALTER TABLE email_accounts ADD COLUMN last_sync_at TEXT;
ALTER TABLE email_accounts ADD COLUMN last_error TEXT;
ALTER TABLE email_accounts ADD COLUMN sync_json TEXT;
UPDATE email_accounts SET label = 'Sample mailbox — fictional messages' WHERE is_fixture = 1;

-- messages: where the message lives on the server + threading headers
ALTER TABLE email_messages ADD COLUMN account_id TEXT;
ALTER TABLE email_messages ADD COLUMN folder TEXT NOT NULL DEFAULT 'inbox' CHECK (folder IN ('inbox','sent'));
ALTER TABLE email_messages ADD COLUMN uid INTEGER;
ALTER TABLE email_messages ADD COLUMN rfc_message_id TEXT;
ALTER TABLE email_messages ADD COLUMN in_reply_to TEXT;
ALTER TABLE email_messages ADD COLUMN references_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE email_messages ADD COLUMN subject TEXT;
ALTER TABLE email_messages ADD COLUMN seen INTEGER NOT NULL DEFAULT 1;
-- desired \Seen state not yet confirmed on the server (NULL = in sync)
ALTER TABLE email_messages ADD COLUMN seen_pending INTEGER;
ALTER TABLE email_messages ADD COLUMN gm_thrid TEXT;
ALTER TABLE email_messages ADD COLUMN body_source TEXT NOT NULL DEFAULT 'plain' CHECK (body_source IN ('plain','html_converted','none'));
ALTER TABLE email_messages ADD COLUMN truncated INTEGER NOT NULL DEFAULT 0;
-- 1 = same Message-ID as another cached message (e.g. a mail to yourself in Inbox and Sent); hidden from views
ALTER TABLE email_messages ADD COLUMN dup INTEGER NOT NULL DEFAULT 0;
ALTER TABLE email_messages ADD COLUMN size INTEGER;
CREATE UNIQUE INDEX idx_messages_server ON email_messages(account_id, folder, uid) WHERE uid IS NOT NULL;
CREATE INDEX idx_messages_rfcid ON email_messages(account_id, rfc_message_id);
CREATE INDEX idx_messages_gmthr ON email_messages(account_id, gm_thrid) WHERE gm_thrid IS NOT NULL;

-- every Message-ID a message points at (In-Reply-To + References), for finding its thread / its children
CREATE TABLE email_message_refs (
  message_pk TEXT NOT NULL REFERENCES email_messages(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  ref TEXT NOT NULL
);
CREATE INDEX idx_refs_lookup ON email_message_refs(account_id, ref);
CREATE INDEX idx_refs_msg ON email_message_refs(message_pk);

CREATE TABLE email_attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES email_messages(id) ON DELETE CASCADE,
  part_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  inline INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_attachments_msg ON email_attachments(message_id);

-- threads: derived columns kept up to date by the sync code
ALTER TABLE email_threads ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE email_threads ADD COLUMN has_attachments INTEGER NOT NULL DEFAULT 0;
ALTER TABLE email_threads ADD COLUMN last_from TEXT NOT NULL DEFAULT '';
ALTER TABLE email_threads ADD COLUMN subject_key TEXT;
ALTER TABLE email_threads ADD COLUMN gm_thrid TEXT;
CREATE INDEX idx_threads_subjkey ON email_threads(account_id, subject_key);

-- backfill for sample-mailbox rows created before this migration
UPDATE email_messages SET account_id = (SELECT t.account_id FROM email_threads t WHERE t.id = email_messages.thread_id);
UPDATE email_messages SET folder = CASE direction WHEN 'out' THEN 'sent' ELSE 'inbox' END;
UPDATE email_messages SET seen = CASE WHEN direction = 'in' AND (SELECT t.unread FROM email_threads t WHERE t.id = email_messages.thread_id) = 1 THEN 0 ELSE 1 END;
UPDATE email_threads SET
  message_count = (SELECT COUNT(*) FROM email_messages m WHERE m.thread_id = email_threads.id),
  last_from = COALESCE((SELECT COALESCE(NULLIF(m.from_name, ''), m.from_addr) FROM email_messages m WHERE m.thread_id = email_threads.id ORDER BY m.date DESC LIMIT 1), '');
