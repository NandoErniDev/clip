/** R2 object helpers. Object keys never contain user-supplied text. */

export function itemKey(clipboardId: string, itemId: string): string {
  return `clipboards/${clipboardId}/${itemId}`;
}

export function clipboardPrefix(clipboardId: string): string {
  return `clipboards/${clipboardId}/`;
}

export async function putItemObject(
  bucket: R2Bucket,
  key: string,
  body: ArrayBuffer,
  contentType: string,
  metadata: { clipboardId: string; itemId: string },
): Promise<void> {
  await bucket.put(key, body, {
    httpMetadata: { contentType },
    customMetadata: {
      clipboardId: metadata.clipboardId,
      itemId: metadata.itemId,
    },
  });
}

export async function deleteObject(bucket: R2Bucket, key: string): Promise<void> {
  try {
    await bucket.delete(key);
  } catch (error) {
    // Deleting a missing object is a no-op; log real failures and continue so
    // metadata cleanup is never blocked by storage hiccups.
    console.warn("r2 delete failed", key, error instanceof Error ? error.message : String(error));
  }
}

export async function deleteClipboardObjects(bucket: R2Bucket, clipboardId: string): Promise<number> {
  const prefix = clipboardPrefix(clipboardId);
  let cursor: string | undefined;
  let deleted = 0;

  do {
    const listed = await bucket.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
    const keys = listed.objects.map((object) => object.key);
    if (keys.length > 0) {
      await bucket.delete(keys);
      deleted += keys.length;
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  return deleted;
}

/** Deletes R2 objects that no item or pending upload references. */
export async function sweepOrphanObjects(bucket: R2Bucket, findKnownKeys: (keys: string[]) => Promise<Set<string>>, now: number): Promise<number> {
  const cutoff = now - 60 * 60 * 1000; // never touch objects from the last hour
  const listed = await bucket.list({ prefix: "clipboards/", limit: 500 });
  const candidates = listed.objects
    .filter((object) => object.uploaded.getTime() < cutoff)
    .map((object) => object.key);

  if (candidates.length === 0) return 0;

  let deleted = 0;
  for (let index = 0; index < candidates.length; index += 40) {
    const chunk = candidates.slice(index, index + 40);
    const known = await findKnownKeys(chunk);
    const orphans = chunk.filter((key) => !known.has(key));
    if (orphans.length > 0) {
      await bucket.delete(orphans);
      deleted += orphans.length;
    }
  }
  return deleted;
}
