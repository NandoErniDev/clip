/**
 * Expiration and storage cleanup.
 *
 * Runs from the Cron Trigger every 15 minutes and opportunistically whenever an
 * expired clipboard is touched. Each step is idempotent, so an interrupted run
 * is safe to repeat.
 */

import { LIMITS } from "../shared/config";
import {
  deleteClipboardRows,
  deletePendingUpload,
  findKnownR2Keys,
  listExpiredClipboardIds,
  listStalePendingUploads,
  pruneRateLimits,
  recomputeCounters,
} from "./db";
import { deleteClipboardObjects, deleteObject, sweepOrphanObjects } from "./storage";
import type { Env } from "./types";

export interface MaintenanceStats {
  expiredClipboards: number;
  expiredObjects: number;
  staleUploads: number;
  orphanObjects: number;
  rateLimitRowsPruned: boolean;
  durationMs: number;
}

export async function destroyClipboard(env: Env, clipboardId: string): Promise<void> {
  await deleteClipboardObjects(env.FILES, clipboardId);
  await deleteClipboardRows(env.DB, clipboardId);
}

export async function runMaintenance(env: Env, options: { maxClipboards?: number } = {}): Promise<MaintenanceStats> {
  const startedAt = Date.now();
  const now = startedAt;
  const stats: MaintenanceStats = {
    expiredClipboards: 0,
    expiredObjects: 0,
    staleUploads: 0,
    orphanObjects: 0,
    rateLimitRowsPruned: false,
    durationMs: 0,
  };

  // 1. Expired clipboards: remove objects first, then metadata.
  const expiredIds = await listExpiredClipboardIds(env.DB, now, options.maxClipboards ?? 50);
  for (const id of expiredIds) {
    stats.expiredObjects += await deleteClipboardObjects(env.FILES, id);
    await deleteClipboardRows(env.DB, id);
    stats.expiredClipboards += 1;
  }

  // 2. Uploads that never completed (interrupted between reservation and write).
  const staleUploads = await listStalePendingUploads(env.DB, now - LIMITS.pendingUploadTtlMs, 50);
  for (const upload of staleUploads) {
    await deleteObject(env.FILES, upload.r2_key);
    await deletePendingUpload(env.DB, upload.id);
    await recomputeCounters(env.DB, upload.clipboard_id, now);
    stats.staleUploads += 1;
  }

  // 3. Safety net for objects whose metadata vanished in an interrupted run.
  stats.orphanObjects = await sweepOrphanObjects(env.FILES, (keys) => findKnownR2Keys(env.DB, keys), now);

  // 4. Drop counters that drifted because of an interrupted multi-step write.
  await env.DB.prepare(
    `UPDATE clipboards SET
       item_count = (SELECT COUNT(*) FROM items WHERE items.clipboard_id = clipboards.id),
       used_bytes = (SELECT COALESCE(SUM(items.size), 0) FROM items WHERE items.clipboard_id = clipboards.id)
     WHERE id IN (
       SELECT c.id FROM clipboards c
       WHERE c.expires_at > ?
         AND (c.item_count <> (SELECT COUNT(*) FROM items i WHERE i.clipboard_id = c.id)
           OR c.used_bytes <> (SELECT COALESCE(SUM(i.size), 0) FROM items i WHERE i.clipboard_id = c.id))
       LIMIT 100
     )`,
  )
    .bind(now)
    .run();

  // 5. Old rate-limit windows.
  await pruneRateLimits(env.DB, now - 60 * 60 * 1000);
  stats.rateLimitRowsPruned = true;

  stats.durationMs = Date.now() - startedAt;
  return stats;
}
