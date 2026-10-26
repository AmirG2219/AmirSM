-- Clip analysis cache: one row per (asset, kind). Source files are immutable, so a row stays valid until the
-- analyzer_version changes (then it is recomputed and replaced).
--   kind 'technical' = local FFmpeg signal measurements (no AI)
--   kind 'visual'    = Claude looked at sampled still frames
CREATE TABLE clip_analyses (
  asset_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('visual','technical')),
  analyzer_version TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (asset_id, kind)
);

-- What the editor actually knew when a version was produced (shown truthfully in the UI as "What the editor saw").
ALTER TABLE versions ADD COLUMN analysis_json TEXT;
