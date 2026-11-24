/** Typed D1 access. All clipboard data access goes through this module. */

export interface ClipboardRow {
  id: string;
  token_hash: string;
  created_at: number;
  updated_at: number;
  expires_at: number;
  item_count: number;
  used_bytes: number;
}

export interface ItemRow {
  id: string;
  clipboard_id: string;
  kind: "text" | "file";
  name: string | null;
  mime: string;
  size: number;
  content: string | null;
  r2_key: string | null;
  created_at: number;
}

export interface ItemListRow {
  id: string;
  kind: "text" | "file";
  name: string | null;
  mime: string;
  size: number;
  created_at: number;
  preview: string | null;
  text_length: number | null;
}

export interface PendingUploadRow {
  id: string;
  clipboard_id: string;
  r2_key: string;
  size: number;
  created_at: number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export async function createClipboardRow(
  db: D1Database,
  values: { id: string; tokenHash: string; now: number; expiresAt: number },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO clipboards (id, token_hash, created_at, updated_at, expires_at, item_count, used_bytes)
       VALUES (?, ?, ?, ?, ?, 0, 0)`,
    )
    .bind(values.id, values.tokenHash, values.now, values.now, values.expiresAt)
    .run();
}

export async function findClipboardByTokenHash(db: D1Database, tokenHash: string): Promise<ClipboardRow | null> {
  return await db.prepare(`SELECT * FROM clipboards WHERE token_hash = ?`).bind(tokenHash).first<ClipboardRow>();
}

export async function getClipboard(db: D1Database, id: string): Promise<ClipboardRow | null> {
  return await db.prepare(`SELECT * FROM clipboards WHERE id = ?`).bind(id).first<ClipboardRow>();
}

export async function listItems(db: D1Database, clipboardId: string): Promise<ItemListRow[]> {
  const result = await db
    .prepare(
      `SELECT id, kind, name, mime, size, created_at,
              CASE WHEN kind = 'text' THEN substr(content, 1, 400) END AS preview,
              CASE WHEN kind = 'text' THEN length(content) END AS text_length
       FROM items
       WHERE clipboard_id = ?
       ORDER BY created_at DESC`,
    )
    .bind(clipboardId)
    .all<ItemListRow>();
  return result.results ?? [];
}

export async function getItemRow(db: D1Database, clipboardId: string, itemId: string): Promise<ItemRow | null> {
  return await db
    .prepare(`SELECT * FROM items WHERE id = ? AND clipboard_id = ?`)
    .bind(itemId, clipboardId)
    .first<ItemRow>();
}

/**
 * Atomically claims capacity for one more item. The UPDATE only matches when
 * the clipboard is live and both limits still fit the new size, so concurrent
 * uploads cannot overshoot the quota.
 */
export async function reserveCapacity(
  db: D1Database,
  clipboardId: string,
  size: number,
  maxItems: number,
  maxTotalBytes: number,
  now: number,
): Promise<{ item_count: number; used_bytes: number } | null> {
  const row = await db
    .prepare(
      `UPDATE clipboards
       SET item_count = item_count + 1, used_bytes = used_bytes + ?, updated_at = ?
       WHERE id = ? AND expires_at > ? AND item_count < ? AND used_bytes + ? <= ?
       RETURNING item_count, used_bytes`,
    )
    .bind(size, now, clipboardId, now, maxItems, size, maxTotalBytes)
    .first<{ item_count: number; used_bytes: number }>();
  return row ?? null;
}

/** Returns capacity after a failed write, keeping counters accurate. */
export async function releaseCapacity(db: D1Database, clipboardId: string, size: number): Promise<void> {
  await db
    .prepare(
      `UPDATE clipboards
       SET item_count = MAX(item_count - 1, 0), used_bytes = MAX(used_bytes - ?, 0)
       WHERE id = ?`,
    )
    .bind(size, clipboardId)
    .run();
}

export async function insertItemRow(
  db: D1Database,
  values: {
    id: string;
    clipboardId: string;
    kind: "text" | "file";
    name: string | null;
    mime: string;
    size: number;
    content: string | null;
    r2Key: string | null;
    createdAt: number;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO items (id, clipboard_id, kind, name, mime, size, content, r2_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      values.id,
      values.clipboardId,
      values.kind,
      values.name,
      values.mime,
      values.size,
      values.content,
      values.r2Key,
      values.createdAt,
    )
    .run();
}

/** Removes an item and recalculates the clipboard counters atomically. */
export async function deleteItemRow(db: D1Database, clipboardId: string, itemId: string, now: number): Promise<number> {
  const [deleted] = await db.batch([
    db.prepare(`DELETE FROM items WHERE id = ? AND clipboard_id = ?`).bind(itemId, clipboardId),
    recomputeStatement(db, clipboardId, now),
  ]);
  return (deleted?.meta.changes ?? 0) as number;
}

/** Removes every item of a clipboard and recalculates counters atomically. */
export async function clearItemRows(db: D1Database, clipboardId: string, now: number): Promise<number> {
  const [deleted] = await db.batch([
    db.prepare(`DELETE FROM items WHERE clipboard_id = ?`).bind(clipboardId),
    recomputeStatement(db, clipboardId, now),
  ]);
  return (deleted?.meta.changes ?? 0) as number;
}

function recomputeStatement(db: D1Database, clipboardId: string, now: number): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE clipboards SET
         item_count = (SELECT COUNT(*) FROM items WHERE clipboard_id = ?),
         used_bytes = (SELECT COALESCE(SUM(size), 0) FROM items WHERE clipboard_id = ?),
         updated_at = ?
       WHERE id = ?`,
    )
    .bind(clipboardId, clipboardId, now, clipboardId);
}

export async function recomputeCounters(db: D1Database, clipboardId: string, now: number): Promise<void> {
  await recomputeStatement(db, clipboardId, now).run();
}

/** Fixed-window rate limiter backed by D1. */
export async function hitRateLimit(
  db: D1Database,
  key: string,
  limit: number,
  windowMs: number,
  now: number,
): Promise<RateLimitResult> {
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN rate_limits.window_start = excluded.window_start THEN rate_limits.count + 1 ELSE 1 END,
         window_start = excluded.window_start
       RETURNING count, window_start`,
    )
    .bind(key, windowStart)
    .first<{ count: number; window_start: number }>();

  if (!row) return { allowed: true, retryAfterSeconds: 0 };
  const retryAfterSeconds = Math.max(1, Math.ceil((row.window_start + windowMs - now) / 1000));
  return { allowed: row.count <= limit, retryAfterSeconds };
}

export async function listExpiredClipboardIds(db: D1Database, now: number, limit: number): Promise<string[]> {
  const result = await db
    .prepare(`SELECT id FROM clipboards WHERE expires_at <= ? ORDER BY expires_at ASC LIMIT ?`)
    .bind(now, limit)
    .all<{ id: string }>();
  return (result.results ?? []).map((row) => row.id);
}

export async function deleteClipboardRows(db: D1Database, clipboardId: string): Promise<void> {
  await db.batch([
    db.prepare(`DELETE FROM items WHERE clipboard_id = ?`).bind(clipboardId),
    db.prepare(`DELETE FROM pending_uploads WHERE clipboard_id = ?`).bind(clipboardId),
    db.prepare(`DELETE FROM clipboards WHERE id = ?`).bind(clipboardId),
  ]);
}

export async function insertPendingUpload(
  db: D1Database,
  values: PendingUploadRow,
): Promise<void> {
  await db
    .prepare(`INSERT INTO pending_uploads (id, clipboard_id, r2_key, size, created_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(values.id, values.clipboard_id, values.r2_key, values.size, values.created_at)
    .run();
}

export async function deletePendingUpload(db: D1Database, id: string): Promise<void> {
  await db.prepare(`DELETE FROM pending_uploads WHERE id = ?`).bind(id).run();
}

export async function listStalePendingUploads(
  db: D1Database,
  olderThan: number,
  limit: number,
): Promise<PendingUploadRow[]> {
  const result = await db
    .prepare(`SELECT * FROM pending_uploads WHERE created_at <= ? ORDER BY created_at ASC LIMIT ?`)
    .bind(olderThan, limit)
    .all<PendingUploadRow>();
  return result.results ?? [];
}

export async function findKnownR2Keys(db: D1Database, keys: string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const placeholders = keys.map(() => "?").join(", ");
  const itemRows = await db
    .prepare(`SELECT r2_key FROM items WHERE r2_key IN (${placeholders})`)
    .bind(...keys)
    .all<{ r2_key: string }>();
  const pendingRows = await db
    .prepare(`SELECT r2_key FROM pending_uploads WHERE r2_key IN (${placeholders})`)
    .bind(...keys)
    .all<{ r2_key: string }>();

  const known = new Set<string>();
  for (const row of itemRows.results ?? []) known.add(row.r2_key);
  for (const row of pendingRows.results ?? []) known.add(row.r2_key);
  return known;
}

export async function pruneRateLimits(db: D1Database, olderThan: number): Promise<void> {
  await db.prepare(`DELETE FROM rate_limits WHERE window_start < ?`).bind(olderThan).run();
}
