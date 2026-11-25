-- Clip: maintenance bookkeeping.
-- Used when the Worker has no Cron Trigger (for example a managed host); the
-- Worker then runs cleanup opportunistically at most every 15 minutes.

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
