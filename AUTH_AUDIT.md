# One Seat authentication audit

## Bugs found in the previous build

The repository was a single static demo and had no authentication implementation. Consequently every requested auth surface was absent or broken: the four product URLs did not exist; the advertised product links could leave the site; there were no Google or email choices; no session creation, refresh, expiry, sign-out, CSRF defense, rate limiting, callback validation, return-to preservation, error/expired-link page, provider linking, user/seat provisioning, tenant boundary, or private-document authorization. There was also no way to preserve in-progress browser work or distinguish public Sample data from owner data. The only existing call to action sent visitors to the external `never86.ai`, matching the reported ChatGPT-only dead end outside this repository.

## Current security model

* Public checks parse CSV/text locally and retain drafts in origin-scoped `localStorage`. Uploading to the service happens only after explicit Save and authentication.
* Opaque 256-bit session identifiers are stored only as SHA-256 hashes server-side. Cookies are `Secure`, `HttpOnly`, `SameSite=Lax`, expire after 30 days, and sessions slide at most once per day.
* State-bound, ten-minute OAuth requests prevent login CSRF. Only a provider-verified email is accepted. A normalized verified email is the account key, so Google, ChatGPT, and email identities merge into the existing account.
* Magic links are random, hashed, single-use, expire in 15 minutes, and are limited to five requests per IP/email pair per 15 minutes. The request response does not disclose account existence.
* Mutations require a same-origin request plus a double-submit CSRF value. Sign-out revokes server state and expires the browser cookie.
* The first verified sign-in provisions one restaurant and its free owner seat. Every saved document is stamped with the restaurant ID; reads compare that ID to the authenticated user's restaurant.

## Routes

| Route | Signed out | Signed in |
|---|---|---|
| `/seat` | Full browser-only Sample mode | Same, plus save/sign-out |
| `/check/invoices` | Full browser-only invoice check | Same, plus save/sign-out |
| `/check/menu` | Full browser-only menu check | Same, plus save/sign-out |
| `/check/labor` | Full browser-only labor check | Same, plus save/sign-out |
| `/signin` | Google, email magic link, optional ChatGPT, or continue unsigned | Provider selection remains available |
| `/auth/google`, `/auth/chatgpt` | Begins state-bound OAuth | Begins account-linking sign-in by verified email |
| `/auth/magic` | Sends one-time email without account enumeration | Same |
| `/auth/signout` | CSRF-protected no-op rejection | Revokes session and returns to `/seat` |
| `/api/documents/*` | 401; browser redirects to sign-in on Save | Restaurant-scoped create/read |

## Configuration (never commit values)

Set `APP_ORIGIN` to the exact HTTPS origin. Google OAuth needs `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, with `${APP_ORIGIN}/auth/google/callback` as an authorized redirect URI. ChatGPT/OIDC needs `CHATGPT_CLIENT_ID`, `CHATGPT_CLIENT_SECRET`, `CHATGPT_AUTHORIZATION_URL`, `CHATGPT_TOKEN_URL`, and `CHATGPT_USERINFO_URL`, with `${APP_ORIGIN}/auth/chatgpt/callback` registered. Email uses `RESEND_API_KEY` and a verified `EMAIL_FROM`. `PORT` is optional. Production must set `NODE_ENV=production` so development magic-link rendering is disabled.
