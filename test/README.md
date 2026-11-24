# API tests

`local.mjs` drives the real Worker over HTTP and covers:

- health, static assets, cache and security headers
- token creation, hashing, cookie sessions, case-insensitive tokens and rejected tokens
- text, PNG, PDF and HTML uploads, inline vs. attachment responses, sandboxed content
- deletion, clearing, cross-clipboard isolation and same-origin enforcement
- all four storage limits, including concurrent writes and a human-readable total limit
- expiry on access, plus the scheduled cleanup handler (local runs only)

```bash
npm run dev            # in one terminal
npm run test:local     # in another
```

Against production:

```bash
BASE_URL=https://clip.naerdev.ch npm run test:local
```

Production runs skip the expiration tests because they rewrite `expires_at` through the local D1 CLI. Nothing in the suite touches clipboards it did not create.
