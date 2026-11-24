# Architecture

Clip is a single Cloudflare Worker with two faces: it serves a static single-page client and exposes a small JSON API that stores metadata in D1 and file bytes in R2. A Cron Trigger keeps storage clean. There is no other infrastructure and no third-party service.

```
Browser ── HTTPS ──▶ Cloudflare (naerdev.ch zone, TLS, proxy)
                       │
                       ├─ Worker "clip"
                       │    ├─ /api/*  → D1 (metadata) + R2 (objects)
                       │    └─ /*      → env.ASSETS (built client)
                       │
                       └─ Cron */15 * * * * → scheduled() → cleanup
```

## Request lifecycle

1. `fetch()` hands every request to the Hono app, then applies security headers to whatever comes back (including error responses).
2. A middleware checks `Origin` on unsafe methods. Browser requests must be same-origin; bearer clients are exempt; `POST /api/session` may omit `Origin` because the token travels in the body.
3. API routes resolve the clipboard from the session cookie or an `Authorization: Bearer` token: normalize → SHA-256 → lookup by unique index. An expired clipboard is destroyed on access and answered with `410`.
4. Any other path is served from `env.ASSETS` with explicit cache rules: HTML `no-cache`, hashed assets `immutable` for a year.

## Data model

```sql
clipboards(id, token_hash UNIQUE, created_at, updated_at, expires_at, item_count, used_bytes)
items(id, clipboard_id, kind CHECK('text','file'), name, mime, size, content, r2_key, created_at)
pending_uploads(id, clipboard_id, r2_key, size, created_at)
rate_limits(key, window_start, count)
```

- `items.content` holds text items only; file items store `r2_key = clipboards/<clipboardId>/<itemId>`.
- `clipboards.item_count` and `used_bytes` are the authoritative quota counters. They are updated only through atomic statements and can be recomputed from `items` at any time.
- Indexes cover token lookup, clipboard listing, expiration sweeps, R2 key lookups and rate-limit windows.

## Quota enforcement

Every write goes through the same two-step claim, and both steps are single SQL statements:

```sql
UPDATE clipboards
SET item_count = item_count + 1, used_bytes = used_bytes + :size, updated_at = :now
WHERE id = :id
  AND expires_at > :now
  AND item_count < :maxItems
  AND used_bytes + :size <= :maxTotalBytes
RETURNING item_count, used_bytes;
```

- No row returned means the clipboard is at a limit; nothing was written.
- Because the predicate and the increment are one statement, parallel uploads cannot overshoot either bound. Tested with eight simultaneous writes and with a clipboard filled to exactly 20 MB.
- After a failed insert the reservation is released with a guarded decrement, and the scheduled job reconciles drift by recomputing counters from `items`.

## Upload flow (durability)

```
reserve capacity  →  insert pending_upload  →  R2 put  →  insert item + delete pending
      │                      │                    │              │
      └── fails: 4xx         └── crash: cron      └── fails:     └── fails: delete
                                 removes object       release +      the object,
                                 and reservation      delete pending release
```

- The pending row exists before the R2 write, so an upload interrupted between the two leaves a trail. The cron job deletes those objects and reservations after 30 minutes.
- A final sweep lists `clipboards/` objects older than an hour and deletes any not referenced by `items` or `pending_uploads`, covering crashes between a successful put and the metadata insert.

## Expiration

- `expires_at` is fixed at creation: `created_at + LIMITS.clipboardTtlMs` (24 h). It never slides on activity, so a clipboard cannot live longer than its configured maximum.
- Reads and writes of an expired clipboard delete its R2 prefix and its rows immediately, then return `410`.
- The Cron Trigger (`*/15 * * * *`) also deletes up to 50 expired clipboards per run, stale pending uploads, orphan objects, drifted counters, and old rate-limit windows. Every step is idempotent, so a retried or partial run is safe.

## Security decisions

| Concern | Decision |
| --- | --- |
| Token storage | 160-bit CSPRNG token; only `SHA-256("clip:v1:" + normalized)` is stored. The raw token is returned once. |
| Session | HttpOnly, `SameSite=Strict`, `Secure` on HTTPS cookie holding the token. No server-side session table, no signing key to leak. Bearer auth supported for scripts. |
| CSRF | Same-origin `Origin` check on every unsafe method, plus `SameSite=Strict`. |
| Upload execution | Active content types (HTML, SVG, XML, JS) are downgraded to `application/octet-stream`. Only PNG/JPEG/WebP/GIF are inline. Every content response carries `Content-Security-Policy: default-src 'none'; sandbox`, `nosniff` and an explicit `Content-Disposition`. |
| Filenames | Path separators, control characters and leading dots are stripped; names are bounded to 160 characters; R2 keys never contain user input. |
| Cross-clipboard access | Every item query is scoped by `clipboard_id` from the authenticated session; item IDs alone are not sufficient. |
| Headers | CSP without inline scripts, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex`, HSTS on HTTPS. |
| Rate limiting | D1 fixed windows: 12 clipboard creations/hour per IP, 40 token attempts/10 min per IP, 240 writes/minute per clipboard. |
| Logging | Only failure metadata is logged; tokens, token hashes and item content are never logged. |

## Client

The client is framework-free TypeScript built by Vite into `dist/client`, then served by the Worker.

- One module owns state (`token`, `clipboard`, `pending uploads`) and re-renders only the parts that change, so polling never clobbers the composer.
- All user content (text previews, filenames) is inserted via `textContent`; only static markup uses `innerHTML`. Uploaded content is never rendered as markup.
- Paste handling is global: files and images paste into a new item, text pastes directly into an item where possible, and pastes inside the composer stay native.
- Polling runs every 12 seconds while the tab is visible, with an immediate refresh on focus and a 30-second clock tick for expiry and relative timestamps.
- The design is a single light theme built on system fonts, hairline borders and a restrained palette; motion respects `prefers-reduced-motion`.

## Deployment topology

- Worker: `clip` (single module, `src/worker/index.ts`), compatibility date `2025-09-01`.
- Bindings: `DB` → D1 `clip-db`, `FILES` → R2 `clip-files`, `ASSETS` → `dist/client`.
- Route: `clip.naerdev.ch` as a custom domain, which Cloudflare provisions DNS and TLS for. The apex `naerdev.ch` and all other zone records are untouched.
- Cron: `*/15 * * * *`, reporting a JSON summary to Workers Logs.

## Failure modes

| Failure | Behaviour |
| --- | --- |
| R2 put fails | 502 to the client, reservation released, pending row removed. |
| Metadata insert fails after put | Object and pending row deleted, reservation released. |
| Worker crashes mid-upload | Pending row and object are cleaned within 30 minutes by cron; the orphan sweep catches anything older than an hour. |
| D1 unavailable | 500 with a generic message; no partial writes beyond a possibly released reservation, which cron reconciles. |
| Expiry while a tab is open | Next poll returns `410`, the client clears the stored token and shows the create screen. |
