CREATE TABLE email_accounts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  label TEXT NOT NULL,
  address TEXT NOT NULL,
  is_fixture INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE email_threads (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES email_accounts(id),
  external_id TEXT,
  subject TEXT NOT NULL,
  snippet TEXT NOT NULL DEFAULT '',
  last_message_at TEXT NOT NULL,
  unread INTEGER NOT NULL DEFAULT 0,
  needs_reply INTEGER NOT NULL DEFAULT 0,
  summary_json TEXT,
  summary_at TEXT
);
CREATE INDEX idx_threads_account ON email_threads(account_id, last_message_at);
CREATE TABLE email_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES email_threads(id),
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  from_name TEXT,
  from_addr TEXT NOT NULL,
  to_json TEXT NOT NULL DEFAULT '[]',
  cc_json TEXT NOT NULL DEFAULT '[]',
  date TEXT NOT NULL,
  body_text TEXT NOT NULL
);
CREATE INDEX idx_messages_thread ON email_messages(thread_id, date);
CREATE TABLE email_drafts (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES email_accounts(id),
  thread_id TEXT REFERENCES email_threads(id),
  to_json TEXT NOT NULL DEFAULT '[]',
  cc_json TEXT NOT NULL DEFAULT '[]',
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  ai_assisted INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','sent','failed')),
  approved_hash TEXT,
  approved_at TEXT,
  sent_at TEXT,
  send_result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
