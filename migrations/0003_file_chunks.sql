-- Clip: file bytes move from R2 into D1.
--
-- R2 requires a payment method even on the free plan, so uploads are stored as
-- chunked BLOBs instead. D1 caps a single BLOB at 2 MB, so one object is split
-- into 512 KiB rows that are concatenated on read. items.r2_key and
-- pending_uploads.r2_key keep their names: they now reference file_chunks.

CREATE TABLE IF NOT EXISTS file_chunks (
  object_key  TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  data        BLOB NOT NULL,
  mime        TEXT NOT NULL,
  clipboard_id TEXT NOT NULL,
  item_id     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (object_key, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_file_chunks_created ON file_chunks (created_at);
