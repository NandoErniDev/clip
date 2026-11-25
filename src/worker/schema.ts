/**
 * Schema bootstrap.
 *
 * Production deployments run the SQL in `migrations/` through Wrangler. When
 * the Worker is deployed somewhere that cannot run Wrangler (for example a
 * managed Workers host), the same idempotent DDL is applied once per isolate,
 * so a fresh database is always usable.
 */

import type { Env } from "./types";

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS clipboards (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    item_count INTEGER NOT NULL DEFAULT 0,
    used_bytes INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_clipboards_expires ON clipboards (expires_at)`,
  `CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    clipboard_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('text', 'file')),
    name TEXT,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    content TEXT,
    r2_key TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (clipboard_id) REFERENCES clipboards (id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_items_clipboard ON items (clipboard_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_items_r2_key ON items (r2_key)`,
  `CREATE TABLE IF NOT EXISTS pending_uploads (
    id TEXT PRIMARY KEY,
    clipboard_id TEXT NOT NULL,
    r2_key TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pending_created ON pending_uploads (created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_pending_clipboard ON pending_uploads (clipboard_id)`,
  `CREATE TABLE IF NOT EXISTS rate_limits (
    key TEXT PRIMARY KEY,
    window_start INTEGER NOT NULL,
    count INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits (window_start)`,
  `CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
];

let ready: Promise<void> | null = null;

/** Applies the schema once per isolate. Safe to call on every request. */
export async function ensureSchema(env: Env): Promise<void> {
  if (!ready) {
    ready = env.DB.batch(STATEMENTS.map((sql) => env.DB.prepare(sql)))
      .then(() => undefined)
      .catch((error: unknown) => {
        ready = null;
        throw error;
      });
  }
  await ready;
}
