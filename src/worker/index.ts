/**
 * Clip Worker.
 *
 * Serves the single-page client from Workers static assets and the clipboard
 * API from D1 (metadata) and R2 (file bytes). All limits are enforced here,
 * never in the browser.
 */

import { Hono } from "hono";
import type { Context } from "hono";

import { LIMITS, RATE_LIMITS } from "../shared/config";
import type { ApiErrorBody, ClipItem, ClipboardState, CreateClipboardResponse, ItemResponse, SessionResponse } from "../shared/types";
import { authenticate, clearedSessionCookie, sessionCookie } from "./auth";
import { runMaintenance } from "./cleanup";
import { maybeRunMaintenance } from "./maintenance";
import { ensureSchema } from "./schema";
import {
  clearItemRows,
  createClipboardRow,
  deleteItemRow,
  deletePendingUpload,
  findClipboardByTokenHash,
  getClipboard,
  getItemRow,
  hitRateLimit,
  insertItemRow,
  insertPendingUpload,
  listItems,
  type ClipboardRow,
  type ItemListRow,
  releaseCapacity,
  reserveCapacity,
} from "./db";
import { HttpError, clientIp, ensureSameOrigin, errorResponse, jsonResponse, readJson } from "./http";
import { contentDisposition, isInlinePreview, resolveMime, sanitizeFilename } from "./mime";
import { deleteClipboardObjects, deleteObject, itemKey, putItemObject } from "./storage";
import { CODE_RULES, generateToken, hashToken, isTokenFormat, normalizeToken, tokenFingerprint } from "./token";
import type { AppEnv, Env } from "./types";

const app = new Hono<AppEnv>();

/* ------------------------------------------------------------------ helpers */

function toPublicItem(row: ItemListRow): ClipItem {
  const isText = row.kind === "text";
  return {
    id: row.id,
    kind: row.kind,
    name: row.name ?? (isText ? "Text" : "File"),
    mime: row.mime,
    size: row.size,
    createdAt: row.created_at,
    preview: isText ? row.preview : null,
    textLength: isText ? row.text_length : null,
    inline: row.kind === "file" && isInlinePreview(row.mime),
    contentUrl: `/api/items/${row.id}/content`,
  };
}

async function buildState(db: D1Database, clipboard: ClipboardRow): Promise<ClipboardState> {
  const rows = await listItems(db, clipboard.id);
  const items = rows.map(toPublicItem);
  return {
    createdAt: clipboard.created_at,
    expiresAt: clipboard.expires_at,
    itemCount: items.length,
    usedBytes: items.reduce((total, item) => total + item.size, 0),
    items,
    limits: {
      maxItems: LIMITS.maxItems,
      maxFileBytes: LIMITS.maxFileBytes,
      maxTextBytes: LIMITS.maxTextBytes,
      maxTotalBytes: LIMITS.maxTotalBytes,
      ttlMs: LIMITS.clipboardTtlMs,
    },
  };
}

async function enforceRateLimit(
  db: D1Database,
  key: string,
  config: { limit: number; windowMs: number },
): Promise<void> {
  const result = await hitRateLimit(db, key, config.limit, config.windowMs, Date.now());
  if (!result.allowed) {
    throw new HttpError(429, "rate_limited", "Too many requests. Wait a moment and try again.", {
      "retry-after": String(result.retryAfterSeconds),
    });
  }
}

async function clipboardFor(context: Context<AppEnv>): Promise<ClipboardRow> {
  return await authenticate(context.env, context.req.raw);
}

/** Rejects a write before any storage call when the clipboard is already full. */
async function assertCapacity(db: D1Database, clipboardId: string, size: number): Promise<void> {
  const row = await getClipboard(db, clipboardId);
  if (!row) throw new HttpError(401, "invalid_token", "That access token isn't valid.");
  if (row.item_count >= LIMITS.maxItems) {
    throw new HttpError(409, "item_limit", `This clipboard holds at most ${LIMITS.maxItems} items. Delete one first.`);
  }
  if (row.used_bytes + size > LIMITS.maxTotalBytes) {
    throw new HttpError(413, "storage_limit", "This clipboard is out of storage. Delete something first.");
  }
}

/* --------------------------------------------------------------- middleware */

app.use("/api/*", async (c, next) => {
  // Managed hosts may not run the D1 migrations or a Cron Trigger, so the
  // Worker makes a fresh database usable and schedules cleanup itself.
  await ensureSchema(c.env);
  c.executionCtx.waitUntil(maybeRunMaintenance(c.env, c.executionCtx));
  await next();
});

app.use("*", async (c, next) => {
  // Opening a session carries the token in the body, so a non-browser client
  // without an Origin header is allowed. A mismatched Origin is still blocked.
  const opensSession = c.req.method === "POST" && c.req.path === "/api/session";
  ensureSameOrigin(c.req.raw, { allowMissingOrigin: opensSession });
  await next();
});

/* -------------------------------------------------------------------- routes */

app.get("/api/health", () => jsonResponse({ ok: true, service: "clip", time: Date.now() }));

/** Opens an existing clipboard and starts a session. */
app.post("/api/session", async (c) => {
  const ip = clientIp(c.req.raw);
  await enforceRateLimit(c.env.DB, `connect:${ip}`, RATE_LIMITS.connect);

  const body = await readJson<{ token?: unknown }>(c.req.raw, 4096);
  const rawToken = typeof body.token === "string" ? body.token.trim() : "";
  if (!rawToken) throw new HttpError(400, "missing_token", "Enter a code to continue.");

  const normalized = normalizeToken(rawToken);
  if (isTokenFormat(normalized)) {
    // Guessing a short code is throttled per code as well as per client.
    await enforceRateLimit(
      c.env.DB,
      `connect-code:${tokenFingerprint(await hashToken(normalized))}`,
      RATE_LIMITS.connectPerCode,
    );
  }

  const clipboard = await authenticate(c.env, new Request(c.req.url, {
    headers: { authorization: `Bearer ${normalized}` },
  }));

  const state = await buildState(c.env.DB, clipboard);
  const payload: SessionResponse = { clipboard: state };
  return jsonResponse(payload, 200, { "set-cookie": sessionCookie(normalized, c.req.raw) });
});

/** Creates a clipboard and returns its code exactly once. */
app.post("/api/clipboards", async (c) => {
  const ip = clientIp(c.req.raw);
  await enforceRateLimit(c.env.DB, `create:${ip}`, RATE_LIMITS.createClipboard);

  // The user may choose a code; otherwise a random one is generated.
  const body = await readJson<{ token?: unknown }>(c.req.raw, 4096).catch(() => ({ token: undefined }) as { token?: unknown });
  const requested = typeof body.token === "string" ? normalizeToken(body.token) : "";
  if (requested && !isTokenFormat(requested)) {
    throw new HttpError(
      400,
      "invalid_code",
      `Codes use letters, numbers, dot, dash or underscore, ${CODE_RULES.minLength}–${CODE_RULES.maxLength} characters.`,
    );
  }

  const now = Date.now();
  const token = requested || generateToken();
  const normalized = normalizeToken(token);
  const tokenHash = await hashToken(normalized);
  const clipboardId = crypto.randomUUID();

  if (requested && (await findClipboardByTokenHash(c.env.DB, tokenHash))) {
    throw new HttpError(409, "code_taken", "That code is already in use. Pick another one.");
  }

  try {
    await createClipboardRow(c.env.DB, {
      id: clipboardId,
      tokenHash,
      now,
      expiresAt: now + LIMITS.clipboardTtlMs,
    });
  } catch (error) {
    if (requested) throw new HttpError(409, "code_taken", "That code is already in use. Pick another one.");
    throw error;
  }

  const row = await getClipboard(c.env.DB, clipboardId);
  if (!row) throw new HttpError(500, "internal", "Could not create the clipboard.");

  const payload: CreateClipboardResponse = { token, clipboard: await buildState(c.env.DB, row) };
  return jsonResponse(payload, 201, { "set-cookie": sessionCookie(normalized, c.req.raw) });
});

app.delete("/api/session", (c) =>
  new Response(null, { status: 204, headers: { "set-cookie": clearedSessionCookie(c.req.raw) } }),
);

app.get("/api/clipboard", async (c) => {
  const clipboard = await clipboardFor(c);
  return jsonResponse({ clipboard: await buildState(c.env.DB, clipboard) });
});

/** Adds a text item (JSON) or a file item (multipart form data). */
app.post("/api/items", async (c) => {
  const clipboard = await clipboardFor(c);
  await enforceRateLimit(c.env.DB, `write:${clipboard.id}`, RATE_LIMITS.write);

  const contentType = c.req.header("content-type") ?? "";

  if (contentType.toLowerCase().includes("multipart/form-data")) {
    return await createFileItem(c, clipboard);
  }
  return await createTextItem(c, clipboard);
});

async function createTextItem(c: Context<AppEnv>, clipboard: ClipboardRow): Promise<Response> {
  const body = await readJson<{ text?: unknown }>(c.req.raw, LIMITS.maxTextBytes + 4096);
  const text = typeof body.text === "string" ? body.text : "";
  if (!text.trim()) throw new HttpError(400, "empty_text", "There's nothing to save yet.");

  const size = new TextEncoder().encode(text).byteLength;
  if (size > LIMITS.maxTextBytes) {
    throw new HttpError(413, "text_too_large", `Text items can be up to ${Math.round(LIMITS.maxTextBytes / 1024)} KB.`);
  }

  await assertCapacity(c.env.DB, clipboard.id, size);
  const now = Date.now();
  const reserved = await reserveCapacity(
    c.env.DB,
    clipboard.id,
    size,
    LIMITS.maxItems,
    LIMITS.maxTotalBytes,
    now,
  );
  if (!reserved) {
    throw new HttpError(409, "item_limit", `This clipboard holds at most ${LIMITS.maxItems} items, ${LIMITS.maxTotalBytes / (1024 * 1024)} MB in total.`);
  }

  const itemId = crypto.randomUUID();
  try {
    await insertItemRow(c.env.DB, {
      id: itemId,
      clipboardId: clipboard.id,
      kind: "text",
      name: null,
      mime: "text/plain; charset=utf-8",
      size,
      content: text,
      r2Key: null,
      createdAt: now,
    });
  } catch (error) {
    await releaseCapacity(c.env.DB, clipboard.id, size);
    throw error;
  }

  const payload: ItemResponse = {
    item: toPublicItem({
      id: itemId,
      kind: "text",
      name: null,
      mime: "text/plain; charset=utf-8",
      size,
      created_at: now,
      preview: text.slice(0, 400),
      text_length: text.length,
    }),
    clipboard: await buildState(c.env.DB, clipboard),
  };
  return jsonResponse(payload, 201);
}

async function createFileItem(c: Context<AppEnv>, clipboard: ClipboardRow): Promise<Response> {
  const declaredLength = Number(c.req.header("content-length") ?? "0");
  if (declaredLength > LIMITS.maxFileBytes + 256 * 1024) {
    throw new HttpError(413, "file_too_large", "Files can be up to 5 MB.");
  }

  let form: FormData;
  try {
    form = await c.req.raw.formData();
  } catch {
    throw new HttpError(400, "invalid_upload", "The upload could not be read.");
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    throw new HttpError(400, "missing_file", "No file was attached.");
  }
  if (file.size === 0) {
    throw new HttpError(400, "empty_file", "That file is empty.");
  }
  if (file.size > LIMITS.maxFileBytes) {
    throw new HttpError(413, "file_too_large", "Files can be up to 5 MB.");
  }

  const buffer = await file.arrayBuffer();
  const size = buffer.byteLength;
  if (size > LIMITS.maxFileBytes) {
    throw new HttpError(413, "file_too_large", "Files can be up to 5 MB.");
  }

  const name = sanitizeFilename(file.name, "file");
  const mime = resolveMime(file.type, name);
  const now = Date.now();
  const itemId = crypto.randomUUID();
  const key = itemKey(clipboard.id, itemId);
  const pendingId = crypto.randomUUID();

  await assertCapacity(c.env.DB, clipboard.id, size);
  const reserved = await reserveCapacity(c.env.DB, clipboard.id, size, LIMITS.maxItems, LIMITS.maxTotalBytes, now);
  if (!reserved) {
    throw new HttpError(409, "item_limit", "This clipboard is full. Delete an item first.");
  }

  await insertPendingUpload(c.env.DB, {
    id: pendingId,
    clipboard_id: clipboard.id,
    r2_key: key,
    size,
    created_at: now,
  });

  try {
    await putItemObject(c.env.FILES, key, buffer, mime, { clipboardId: clipboard.id, itemId });
  } catch (error) {
    await deletePendingUpload(c.env.DB, pendingId).catch(() => undefined);
    await releaseCapacity(c.env.DB, clipboard.id, size);
    console.error("r2 put failed", error instanceof Error ? error.message : String(error));
    throw new HttpError(502, "storage_unavailable", "Upload failed. Please try again.");
  }

  try {
    await insertItemRow(c.env.DB, {
      id: itemId,
      clipboardId: clipboard.id,
      kind: "file",
      name,
      mime,
      size,
      content: null,
      r2Key: key,
      createdAt: now,
    });
    await deletePendingUpload(c.env.DB, pendingId);
  } catch (error) {
    await deleteObject(c.env.FILES, key);
    await deletePendingUpload(c.env.DB, pendingId).catch(() => undefined);
    await releaseCapacity(c.env.DB, clipboard.id, size);
    throw error;
  }

  const payload: ItemResponse = {
    item: toPublicItem({
      id: itemId,
      kind: "file",
      name,
      mime,
      size,
      created_at: now,
      preview: null,
      text_length: null,
    }),
    clipboard: await buildState(c.env.DB, clipboard),
  };
  return jsonResponse(payload, 201);
}

/**
 * Streams item content. Images are served inline with a sandboxing CSP; every
 * other type is an attachment, so uploads can never be rendered as a document.
 */
app.get("/api/items/:id/content", async (c) => {
  const clipboard = await clipboardFor(c);
  const itemId = c.req.param("id");
  const item = await getItemRow(c.env.DB, clipboard.id, itemId);
  if (!item) throw new HttpError(404, "not_found", "That item no longer exists.");

  const wantDownload = c.req.query("download") === "1";
  const headers = new Headers({
    "cache-control": "private, no-store, max-age=0",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "referrer-policy": "no-referrer",
  });

  if (item.kind === "text") {
    headers.set("content-type", "text/plain; charset=utf-8");
    headers.set("content-disposition", contentDisposition("attachment", `clip-${item.id.slice(0, 8)}.txt`));
    return new Response(item.content ?? "", { status: 200, headers });
  }

  if (!item.r2_key) throw new HttpError(404, "not_found", "That item no longer exists.");

  const object = await c.env.FILES.get(item.r2_key);
  if (!object) {
    // Metadata without content: drop the row so the list self-heals.
    await deleteItemRow(c.env.DB, clipboard.id, item.id, Date.now());
    throw new HttpError(404, "missing_content", "The stored file is no longer available.");
  }

  headers.set("content-type", item.mime);
  headers.set(
    "content-disposition",
    contentDisposition(isInlinePreview(item.mime) && !wantDownload ? "inline" : "attachment", item.name ?? "file"),
  );
  headers.set("etag", object.httpEtag);
  if (object.size) headers.set("content-length", String(object.size));

  return new Response(object.body, { status: 200, headers });
});

app.delete("/api/items/:id", async (c) => {
  const clipboard = await clipboardFor(c);
  await enforceRateLimit(c.env.DB, `write:${clipboard.id}`, RATE_LIMITS.write);

  const item = await getItemRow(c.env.DB, clipboard.id, c.req.param("id"));
  if (!item) throw new HttpError(404, "not_found", "That item no longer exists.");

  await deleteItemRow(c.env.DB, clipboard.id, item.id, Date.now());
  if (item.r2_key) await deleteObject(c.env.FILES, item.r2_key);

  return jsonResponse({ clipboard: await buildState(c.env.DB, clipboard) });
});

app.delete("/api/clipboard/items", async (c) => {
  const clipboard = await clipboardFor(c);
  await enforceRateLimit(c.env.DB, `write:${clipboard.id}`, RATE_LIMITS.write);

  await clearItemRows(c.env.DB, clipboard.id, Date.now());
  // Remove every object for the clipboard, including any orphaned upload.
  await deleteClipboardObjects(c.env.FILES, clipboard.id);

  return jsonResponse({ clipboard: await buildState(c.env.DB, clipboard) });
});

/* ----------------------------------------------------------------- storage */

async function serveAsset(request: Request, env: Env): Promise<Response> {
  const response = await env.ASSETS.fetch(request);
  const headers = new Headers(response.headers);
  const path = new URL(request.url).pathname;

  if ((headers.get("content-type") ?? "").includes("text/html")) {
    headers.set("cache-control", "no-cache, must-revalidate");
  } else if (path.startsWith("/assets/")) {
    headers.set("cache-control", "public, max-age=31536000, immutable");
  }

  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

app.notFound(async (c) => {
  if (c.req.path.startsWith("/api/")) {
    throw new HttpError(404, "not_found", "Unknown endpoint.");
  }
  return await serveAsset(c.req.raw, c.env);
});

app.onError((error, c) => {
  if (error instanceof HttpError) {
    return errorResponse(error);
  }
  console.error("unhandled error", c.req.method, c.req.path, error instanceof Error ? error.stack : String(error));
  return jsonResponse(
    { error: { code: "internal", message: "Something went wrong. Please try again." } } satisfies ApiErrorBody,
    500,
  );
});

/* -------------------------------------------------------------- HTTP layer */

const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "x-robots-tag": "noindex, nofollow",
};

function withSecurityHeaders(response: Response, requestUrl: string): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (!headers.has(name)) headers.set(name, value);
  }
  if (new URL(requestUrl).protocol === "https:") {
    headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const response = await app.fetch(request, env, ctx);
    return withSecurityHeaders(response, request.url);
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    await ensureSchema(env);
    ctx.waitUntil(
      runMaintenance(env)
        .then((stats) => console.log("clip:maintenance", JSON.stringify(stats)))
        .catch((error) => console.error("clip:maintenance failed", error instanceof Error ? error.stack : String(error))),
    );
  },
} satisfies ExportedHandler<Env>;
