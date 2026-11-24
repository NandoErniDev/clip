# API tests

`local.mjs` drives a running Worker over HTTP and covers:

- health, static assets, cache headers and security headers
- clipboard creation, token format, cookie sessions, case-insensitive tokens, rejected tokens
- text, PNG, PDF and HTML uploads; inline vs. attachment responses; sandboxed content
- deletion, clearing, cross-clipboard isolation and same-origin enforcement
- all four storage limits, including eight concurrent writes and the total quota
- disconnect

```bash
npm run dev            # in one terminal
npm run test:local     # in another
```

Against production:

```bash
BASE_URL=https://clip.naerdev.ch npm run test:local
```

Expiration and the Cron Trigger cleanup need local D1 fixtures, so they are checked separately while developing with `wrangler dev --test-scheduled` and `wrangler d1 execute --local`. Nothing in the suite touches clipboards it did not create.
