# One Seat authentication and operator-data audit

## Current implementation

The handler in `lib/operator-app.js` uses shared persistence for saved text originals, single-use sign-in/OAuth claims, session revocation and fixed-window rate limits. `lib/auth.js` retains an older in-memory Store for legacy unit tests; the running handler does not use it.

- Signed 30-day sessions bind a normalized verified email, deterministic restaurant namespace, owner role and random session identity. Sessions do not silently slide. A stable signing key of at least 32 bytes is required outside isolated tests. Rotation changes restaurant identities and needs a migration plan.
- OAuth uses a signed ten-minute state cookie plus a shared atomic consumption claim. Both provider HTTP responses must succeed and email verification must explicitly be true. Only configured provider choices appear on sign-in.
- Magic links have 128-bit replay identities, fifteen-minute expiry and atomic shared single-use claims. Requests are limited to five per IP/email pair in a fixed fifteen-minute window. Provider failures do not claim successful delivery. Development links never render in production or Vercel previews.
- Session cookies are Secure, HttpOnly and SameSite=Lax. Same-origin CSRF checks protect saving and sign-out. Successful sign-out records revocation through token expiry, clears the cookie and removes known product drafts from that browser. The old token is rejected by other instances and after restart.
- Signed-in documents are keyed under the server-derived restaurant identity, retain exact UTF-8 content/filename/hash and support idempotent retry. A conflicting payload cannot overwrite an earlier save. Another restaurant receives 404 and anonymous callers receive 401.
- Production/serverless mode requires shared Redis REST persistence; missing or failing storage returns 503. Local SQLite supports persistent development and restart tests. There is no silent memory fallback.
- Anonymous drafts remain local through initial sign-in. Authenticated drafts are marked with their account and hidden before matching-session verification. Sign-out clears only the four product paths' draft metadata; failed sign-out retains it. Legacy unmarked drafts cannot be retroactively assigned an owner.
- Generic decimal matches are Needs source review, never verified financial fields. No OCR, inferred savings or staffing recommendation is established by this preview.

## Routes and checks

Public entry routes are `/seat`, `/check/invoices`, `/check/menu` and `/check/labor`. `/signin` preserves the intended task. `/api/documents` creates a retained original; `/api/documents/:id` returns its owner-scoped receipt and `/api/documents/:id/original` downloads its exact text. `/api/health` exposes only readiness booleans and returns 503 for missing prerequisites.

`npm test` covers token boundaries, two-operator HTTP isolation, restart persistence, cross-worker single-use/revocation/rate limits, idempotent saves, provider errors, malformed/oversized input and browser-controller behavior. `npm run test:browser` uses real local Chromium and synthetic reports to exercise upload, initial sign-in, exact-original save/download, reload, sign-out cleanup and a second isolated operator. Real email/Google and live-domain deployment are not proven by local tests.

See OPERATOR-PILOT.md for secure configuration and deployment gates. No invitation workflow or autonomous daily action engine is implemented by this One Seat sample.
