/** HTTP helpers: typed errors, JSON responses, cookies and origin checks. */

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly headers: Record<string, string>;

  constructor(status: number, code: string, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

const BASE_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store, max-age=0",
  "x-content-type-options": "nosniff",
};

export function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...BASE_HEADERS, ...headers },
  });
}

export function errorResponse(error: HttpError): Response {
  return jsonResponse({ error: { code: error.code, message: error.message } }, error.status, error.headers);
}

export function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
}

/**
 * Blocks cross-site state changes. Browsers always attach an Origin header to
 * unsafe methods, so a mismatch (or a missing Origin without a bearer token)
 * is rejected. Same-origin requests and API clients using bearer auth pass.
 */
export function ensureSameOrigin(request: Request, options: { allowMissingOrigin?: boolean } = {}): void {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;

  const origin = request.headers.get("origin");
  if (!origin) {
    if (options.allowMissingOrigin) return;
    if (request.headers.get("authorization")?.startsWith("Bearer ")) return;
    throw new HttpError(403, "cross_origin", "Request origin could not be verified.");
  }

  let expected: string;
  try {
    expected = new URL(request.url).origin;
  } catch {
    throw new HttpError(400, "bad_request", "Invalid request URL.");
  }

  if (origin !== expected) {
    throw new HttpError(403, "cross_origin", "Cross-site requests are not allowed.");
  }
}

export function parseCookies(header: string | null): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) cookies.set(name, value);
  }
  return cookies;
}

export async function readJson<T>(request: Request, maxBytes = 512 * 1024): Promise<T> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > maxBytes) {
    throw new HttpError(413, "too_large", "Request body is too large.");
  }
  const text = await request.text();
  if (text.length > maxBytes) {
    throw new HttpError(413, "too_large", "Request body is too large.");
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must be valid JSON.");
  }
}
