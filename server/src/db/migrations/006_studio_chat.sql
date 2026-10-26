-- Studio chat: the owner talks to the video agent; reference ("inspiration") videos are stored as assets with role 'reference'.
ALTER TABLE assets ADD COLUMN role TEXT NOT NULL DEFAULT 'footage' CHECK (role IN ('footage','reference'));

CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  role TEXT NOT NULL CHECK (role IN ('user','agent')),
  text TEXT NOT NULL,
  -- asset ids the owner attached to this message (reference videos, newly added clips)
  attachments_json TEXT NOT NULL DEFAULT '[]',
  -- the draft this turn started (agent messages only)
  version_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_chat_project ON chat_messages(project_id, created_at);

-- What the agent learned from a reference video (cached per asset).
CREATE TABLE reference_profiles (
  asset_id TEXT PRIMARY KEY,
  analyzer_version TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
