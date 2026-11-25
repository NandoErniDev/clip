/** Session handling: token extraction, validation and cookies. */

import { LIMITS, SESSION_COOKIE } from "../shared/config";
import { findClipboardByTokenHash, type ClipboardRow } from "./db";
import { HttpError, parseCookies } from "./http";
import { destroyClipboard } from "./cleanup";
import { hashToken, isTokenFormat, normalizeToken } from "./token";
import type { Env } from "./types";

/** Reads the token from the HttpOnly session cookie or a bearer header. */
export function readRequestToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (authorization?.toLowerCase().startsWith("bearer ")) {
    const value = authorization.slice(7).trim();
    if (value) return value;
  }

  const cookies = parseCookies(request.headers.get("cookie"));
  const cookieToken = cookies.get(SESSION_COOKIE);
  return cookieToken && cookieToken.length > 0 ? cookieToken : null;
}

/**
 * Resolves the clipboard for a request. Expired clipboards are destroyed on
 * access so a stale token cannot keep data alive.
 */
export async function authenticate(env: Env, request: Request): Promise<ClipboardRow> {
  const token = readRequestToken(request);
  if (!token) {
    throw new HttpError(401, "missing_token", "Enter an access token to continue.");
  }

  const normalized = normalizeToken(token);
  if (!isTokenFormat(normalized)) {
    throw new HttpError(401, "invalid_token", "That code doesn't exist.");
  }

  const clipboard = await findClipboardByTokenHash(env.DB, await hashToken(normalized));
  if (!clipboard) {
    throw new HttpError(401, "invalid_token", "That code doesn't exist.");
  }

  if (clipboard.expires_at <= Date.now()) {
    await destroyClipboard(env, clipboard.id);
    throw new HttpError(410, "expired", "This clipboard expired. Create a new one to continue.");
  }

  return clipboard;
}

export function sessionCookie(token: string, request: Request): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  const maxAge = Math.floor(LIMITS.clipboardTtlMs / 1000);
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

export function clearedSessionCookie(request: Request): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
}
