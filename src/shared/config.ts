/**
 * Central configuration for Clip.
 *
 * Every limit is enforced server-side in the Worker. The browser imports the
 * same values so the interface can communicate limits before a request fails,
 * but the server never trusts the client.
 */
export const LIMITS = {
  /** Maximum number of items (text, image or file) per clipboard. */
  maxItems: 20,
  /** Maximum size of a single uploaded file: 5 MB. */
  maxFileBytes: 5 * 1024 * 1024,
  /** Maximum size of a single pasted text item: 256 KB. */
  maxTextBytes: 256 * 1024,
  /** Maximum total bytes stored per clipboard: 20 MB. */
  maxTotalBytes: 20 * 1024 * 1024,
  /** Hard lifetime of a clipboard: 24 hours, counted from creation. */
  clipboardTtlMs: 24 * 60 * 60 * 1000,
  /** An upload that never completes is considered abandoned after 30 minutes. */
  pendingUploadTtlMs: 30 * 60 * 1000,
  /** Longest accepted filename, in characters. */
  maxNameLength: 160,
} as const;

/** Server-side rate limits. Windows are fixed and keyed per client. */
export const RATE_LIMITS = {
  createClipboard: { limit: 12, windowMs: 60 * 60 * 1000 },
  connect: { limit: 40, windowMs: 10 * 60 * 1000 },
  write: { limit: 240, windowMs: 60 * 1000 },
  read: { limit: 600, windowMs: 60 * 1000 },
} as const;

export const SESSION_COOKIE = "clip_session";

/** Human-readable storage label used in the UI. */
export const STORAGE_LABEL = "20 MB";
