/**
 * File bytes live in D1.
 *
 * R2 requires a payment method even on the free plan, so uploads are stored as
 * chunked BLOBs in D1 instead. D1 caps a single BLOB at 2 MB, which is why an
 * object is split into fixed-size chunks. Object keys never contain
 * user-supplied text.
 */

/** 512 KiB per chunk: comfortably below the 2 MB per-BLOB limit. */
const CHUNK_BYTES = 512 * 1024;
/** Chunks written per D1 batch, keeping each request around 2 MB. */
const CHUNKS_PER_BATCH = 4;

export interface StoredObject {
  body: ReadableStream;
  size: number;
  httpEtag: string;
}

export function itemKey(clipboardId: string, itemId: string): string {
  return `clipboards/${clipboardId}/${itemId}`;
}

export function clipboardPrefix(clipboardId: string): string {
  return `clipboards/${clipboardId}/`;
}

export async function putItemObject(
  db: D1Database,
  key: string,
  body: ArrayBuffer,
  contentType: string,
  metadata: { clipboardId: string; itemId: string },
): Promise<void> {
  const bytes = new Uint8Array(body);
  const now = Date.now();
  const statements: D1PreparedStatement[] = [];

  // An empty object still gets one (empty) chunk so it stays retrievable.
  const chunks = Math.max(1, Math.ceil(bytes.byteLength / CHUNK_BYTES));
  for (let index = 0; index < chunks; index += 1) {
    const chunk = bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES);
    statements.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO file_chunks (object_key, chunk_index, data, mime, clipboard_id, item_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(key, index, chunk, contentType, metadata.clipboardId, metadata.itemId, now),
    );
  }

  for (let start = 0; start < statements.length; start += CHUNKS_PER_BATCH) {
    await db.batch(statements.slice(start, start + CHUNKS_PER_BATCH));
  }
}

export async function getObject(db: D1Database, key: string): Promise<StoredObject | null> {
  const result = await db
    .prepare(`SELECT data FROM file_chunks WHERE object_key = ? ORDER BY chunk_index ASC`)
    .bind(key)
    .all<{ data: ArrayBuffer }>();

  const rows = result.results ?? [];
  if (rows.length === 0) return null;

  const parts = rows.map((row) => new Uint8Array(row.data));
  const size = parts.reduce((total, part) => total + part.byteLength, 0);
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.byteLength;
  }

  return {
    body: new Blob([merged]).stream(),
    size,
    httpEtag: `"${size.toString(16)}-${key.length.toString(16)}"`,
  };
}

export async function deleteObject(db: D1Database, key: string): Promise<void> {
  try {
    await db.prepare(`DELETE FROM file_chunks WHERE object_key = ?`).bind(key).run();
  } catch (error) {
    // Deleting a missing object is a no-op; log real failures and continue so
    // metadata cleanup is never blocked by storage hiccups.
    console.warn("file delete failed", key, error instanceof Error ? error.message : String(error));
  }
}

/** Removes every chunk stored under a clipboard prefix. Returns the object count. */
export async function deleteClipboardObjects(db: D1Database, clipboardId: string): Promise<number> {
  const like = `${clipboardPrefix(clipboardId)}%`;
  const counted = await db
    .prepare(`SELECT COUNT(DISTINCT object_key) AS objects FROM file_chunks WHERE object_key LIKE ?`)
    .bind(like)
    .first<{ objects: number }>();
  const objects = counted?.objects ?? 0;
  if (objects === 0) return 0;

  await db.prepare(`DELETE FROM file_chunks WHERE object_key LIKE ?`).bind(like).run();
  return objects;
}

/** Deletes stored objects that no item or pending upload references. */
export async function sweepOrphanObjects(db: D1Database, now: number): Promise<number> {
  const cutoff = now - 60 * 60 * 1000; // never touch objects from the last hour
  const listed = await db
    .prepare(
      `SELECT object_key FROM file_chunks
       GROUP BY object_key
       HAVING MAX(created_at) < ?
         AND object_key NOT IN (SELECT r2_key FROM items WHERE r2_key IS NOT NULL)
         AND object_key NOT IN (SELECT r2_key FROM pending_uploads)
       LIMIT 200`,
    )
    .bind(cutoff)
    .all<{ object_key: string }>();

  const orphans = (listed.results ?? []).map((row) => row.object_key);
  if (orphans.length === 0) return 0;

  for (let index = 0; index < orphans.length; index += 40) {
    const chunk = orphans.slice(index, index + 40);
    const placeholders = chunk.map(() => "?").join(", ");
    await db.prepare(`DELETE FROM file_chunks WHERE object_key IN (${placeholders})`).bind(...chunk).run();
  }
  return orphans.length;
}
