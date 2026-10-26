CREATE TABLE owner (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  user_agent TEXT
);
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  brief TEXT NOT NULL DEFAULT '',
  style_preset TEXT NOT NULL DEFAULT 'calm-cinematic',
  format TEXT NOT NULL DEFAULT '9:16',
  subtitle_lines TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'draft',
  approved_version_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_projects_status ON projects(status);

CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL CHECK (kind IN ('video','audio')),
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  info_json TEXT NOT NULL,
  thumb_name TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  excluded INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_assets_project ON assets(project_id);

CREATE TABLE versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  number INTEGER NOT NULL,
  parent_version_id TEXT,
  instruction TEXT NOT NULL DEFAULT '',
  is_revision INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued',
  plan_json TEXT,
  plan_source TEXT,
  plan_rationale TEXT,
  plan_notes_json TEXT NOT NULL DEFAULT '[]',
  caption_json TEXT,
  caption_status TEXT NOT NULL DEFAULT 'none',
  caption_note TEXT,
  quality_json TEXT,
  output_name TEXT,
  output_size INTEGER,
  output_duration_ms INTEGER,
  output_width INTEGER,
  output_height INTEGER,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  command_summary_json TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  export_dir TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  approved_at TEXT,
  UNIQUE (project_id, number)
);
CREATE INDEX idx_versions_status ON versions(status);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  project_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  stage TEXT,
  progress REAL NOT NULL DEFAULT 0,
  message TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 2,
  error TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  run_after TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX idx_jobs_status ON jobs(status, run_after);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  project_id TEXT,
  version_id TEXT,
  message TEXT NOT NULL
);
CREATE INDEX idx_events_ts ON events(ts);

CREATE TABLE ai_usage (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  role TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL,
  error TEXT,
  project_id TEXT
);
CREATE INDEX idx_ai_usage_ts ON ai_usage(ts);
