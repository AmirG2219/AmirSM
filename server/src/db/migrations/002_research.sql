CREATE TABLE competitors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  handle TEXT,
  url TEXT,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE research_notes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('observation','idea','inspiration')),
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  source_url TEXT,
  source_label TEXT,
  competitor_id TEXT REFERENCES competitors(id),
  tags_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_notes_created ON research_notes(created_at);
CREATE TABLE research_runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('competitor_analysis','market_research')),
  topic TEXT NOT NULL,
  competitor_id TEXT REFERENCES competitors(id),
  input_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_runs_created ON research_runs(created_at);
