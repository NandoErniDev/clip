# Clip

A private, temporary clipboard between your devices.

Open `clip.naerdev.ch` on one machine, enter an access token, paste text or drop a file. Open it on another machine, enter the same token, and everything is there. No accounts, no email, no extensions — and everything is deleted automatically within 24 hours.

```
Production   https://clip.naerdev.ch
Stack        Cloudflare Workers · D1 · R2 · static assets · Cron Triggers
Language     TypeScript (strict)
```

## How it works

- **Access tokens** are 160-bit random values from the platform CSPRNG, written as `CLIP-XXXX-…`. The server stores only their SHA-256 hash. The token is the only key: whoever holds it can read the clipboard.
- **Metadata** (clipboard, token hash, item name/type/size, timestamps, expiration, usage counters) lives in **D1**.
- **File bytes** live in **R2**, keyed by opaque IDs. Text items are stored in D1 and count toward the same quota.
- **The Worker** serves the single-page client from Workers static assets and the `/api/*` endpoints from the same origin, so the session cookie is `HttpOnly`, `SameSite=Strict` and never readable by JavaScript.
- **A Cron Trigger** runs every 15 minutes to delete expired clipboards, abandoned uploads and orphaned objects.

## Limits

All limits are defined in [`src/shared/config.ts`](src/shared/config.ts) and enforced server-side:

| Limit | Value |
| --- | --- |
| Items per clipboard | 20 |
| Single file | 5 MB |
| Single text item | 256 KB |
| Total per clipboard | 20 MB |
| Clipboard lifetime | 24 hours (hard, from creation) |
| Abandoned upload cleanup | 30 minutes |

The interface uses the same constants so it can explain limits before a request fails, but the Worker is always the authority.

## Features

- Create a clipboard with a generated token, or open an existing one with a token.
- Paste text (⌘V / Ctrl+V) anywhere on the page, or type it in the composer and press ⌘↵.
- Paste images straight from the system clipboard.
- Upload files with the file picker or drag and drop.
- Inline image previews, one-click text copy, file download, per-item delete, clear-all.
- Live usage: storage used and remaining, item count, time until expiration.
- Automatic refresh across devices (polling while the tab is visible, plus refresh on focus).
- Disconnect clears the local token and the session cookie.

## Security model

- Only SHA-256 token hashes are stored; the raw token is returned exactly once, at creation.
- Every `/api/*` clipboard endpoint requires the session cookie or `Authorization: Bearer <token>`; unknown and expired tokens are rejected.
- Uploads are never executed or interpreted: HTML, SVG, XML and script MIME types are stored and served as `application/octet-stream` attachments. Only PNG/JPEG/WebP/GIF are served inline, with `Content-Security-Policy: default-src 'none'; sandbox`.
- All responses carry `nosniff`, `no-referrer`, `X-Frame-Options: DENY`, HSTS over HTTPS, and a restrictive CSP.
- State-changing requests are rejected unless `Origin` matches the request origin (bearer clients excepted).
- Rate limits are enforced in D1 per IP for token attempts and clipboard creation, and per clipboard for writes.
- Quota claims are atomic (`UPDATE … RETURNING` with all predicates), so concurrent uploads cannot exceed 20 items or 20 MB.
- Interrupted uploads are recorded before the R2 write, so the cron job can remove both the object and the reservation.

## Local development

```bash
npm install
npx wrangler d1 migrations apply clip-db --local
npm run dev          # builds the client, serves everything on http://127.0.0.1:8787
npm run test:local   # end-to-end API checks against the running Worker
```

`npm run dev` runs local Miniflare with local D1 and R2 state under `.wrangler/state`. No Cloudflare account is needed for local development.

Useful commands:

```bash
npm run typecheck                     # strict TS for client and Worker
npm run build                         # Vite client build into dist/client
npm run db:migrate:local              # apply D1 migrations locally
npm run db:migrate:remote             # apply D1 migrations to production
npx wrangler dev --test-scheduled     # enables /__scheduled to trigger the cron
```

## Deployment

Prerequisites: a Cloudflare account with the `naerdev.ch` zone, and an API token with:

- Account: Workers Scripts Edit, Workers R2 Storage Edit, D1 Edit
- Zone `naerdev.ch`: Workers Routes Edit, DNS Edit, Zone Read

```bash
export CLOUDFLARE_API_TOKEN=…          # never commit this
export CLOUDFLARE_ACCOUNT_ID=…

npx wrangler d1 create clip-db         # put the returned id in wrangler.jsonc
npx wrangler r2 bucket create clip-files
npm run db:migrate:remote
npm run deploy                         # builds the client and deploys the Worker
```

`wrangler.jsonc` binds `DB` (D1), `FILES` (R2) and `ASSETS` (static client), defines the 15-minute cron, and declares the custom domain route `clip.naerdev.ch`. Deploying with that route makes Cloudflare create the DNS record and certificate for the hostname. No secrets are required at runtime: tokens are hashed, and sessions are signed by the token itself.

## Configuration

| Where | What |
| --- | --- |
| `src/shared/config.ts` | Item, size, lifetime and rate limits |
| `wrangler.jsonc` | Bindings, cron schedule, custom domain, compatibility date |
| `migrations/` | D1 schema migrations |
| `.env.example` | Deployment environment variables (token, account id) |

## Project layout

```
src/
  client/          Single-page client (Vite, vanilla TypeScript, one stylesheet)
    api.ts         Typed fetch wrapper
    main.ts        Views, paste/drop handling, uploads, polling
    styles.css     Design system
  shared/          Limits, types and error copy shared by client and Worker
  worker/          Cloudflare Worker
    index.ts       Hono routes, static assets, security headers, scheduled handler
    auth.ts        Token extraction, validation, session cookies
    db.ts          D1 queries, atomic quota claims, rate limiting
    storage.ts     R2 object access and orphan sweeping
    cleanup.ts     Expiration, abandoned uploads, counter reconciliation
    mime.ts        Content-type allow/deny handling, filename sanitisation
    token.ts       Token generation, normalisation, hashing
migrations/        D1 schema
test/local.mjs     End-to-end API test suite
docs/ARCHITECTURE.md
```

## Testing

`npm run test:local` exercises the real Worker and real local D1/R2: session creation, token validation, cross-token isolation, text/image/PDF/HTML uploads, download headers, deletion, clearing, origin protection, all four quota limits, concurrent writes, expiration, and scheduled cleanup.

Set `BASE_URL=https://clip.naerdev.ch npm run test:local` to run the same read/write checks against production (expiry manipulation is skipped because it needs local D1 access).

## License

Private project. All rights reserved.
