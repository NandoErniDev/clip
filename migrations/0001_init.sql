-- Clip: initial schema.
-- Metadata only. File bytes live in R2, referenced by items.r2_key.

CREATE TABLE IF NOT EXISTS clipboards (
  id          TEXT PRIMARY KEY,
  token_hash  TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  item_count  INTEGER NOT NULL DEFAULT 0,
  used_bytes  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_clipboards_expires ON clipboards (expires_at);

CREATE TABLE IF NOT EXISTS items (
  id           TEXT PRIMARY KEY,
  clipboard_id TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('text', 'file')),
  name         TEXT,
  mime         TEXT NOT NULL,
  size         INTEGER NOT NULL,
  content      TEXT,
  r2_key       TEXT,
  created_at   INTEGER NOT NULL,
  FOREIGN KEY (clipboard_id) REFERENCES clipboards (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_items_clipboard ON items (clipboard_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_r2_key ON items (r2_key);

-- Uploads are recorded before the R2 write so an interrupted upload can be
-- found and removed by the scheduled cleanup.
CREATE TABLE IF NOT EXISTS pending_uploads (
  id           TEXT PRIMARY KEY,
  clipboard_id TEXT NOT NULL,
  r2_key       TEXT NOT NULL,
  size         INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pending_created ON pending_uploads (created_at);
CREATE INDEX IF NOT EXISTS idx_pending_clipboard ON pending_uploads (clipboard_id);

CREATE TABLE IF NOT EXISTS rate_limits (
  key          TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits (window_start);
