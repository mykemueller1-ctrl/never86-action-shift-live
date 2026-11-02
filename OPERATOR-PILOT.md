# Operator rollout

The application now retains reports in durable storage, makes email sign-in links single-use across instances, revokes signed-out sessions, and confirms Save only after receiving the exact retained report. These changes must be deployed and checked on the intended domain before operators are invited.

## Required hosting configuration

Use Node.js 24 LTS (minimum 22.13). Local development uses `.data/one-seat.sqlite`; that directory is ignored by Git. It survives restarts on the same persistent disk. Serverless deployments must use a shared Redis REST database; ephemeral filesystem or memory storage is rejected in production.

Local sign-in also requires a stable `SESSION_SECRET` of at least 32 bytes so a restart does not orphan that developer's restaurant identity. Set it in the local process environment or an ignored local environment file; the app does not generate a disposable signing key outside the isolated test workflow. Start with `npm start` after configuration. If using a local file, Node supports `node --env-file=.env server.js`.

Set these through the hosting provider's secure environment settings; never paste their values into chat or commit a populated environment file:

| Setting | Requirement |
| --- | --- |
| `APP_ORIGIN` | Exact HTTPS origin of the confirmed deployment, for example `https://app.never86.app`. |
| `SESSION_SECRET` | Stable random secret of at least 32 bytes, identical across replicas. Keep it unchanged during routine deploys: it also binds existing restaurant and report identities. Rotation requires a planned account/data migration. |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Shared managed database with persistence enabled. The equivalent pair `KV_REST_API_URL`, `KV_REST_API_TOKEN` is also accepted. Never mix half of one pair with half of another. |
| `RESEND_API_KEY`, `EMAIL_FROM` | Email delivery credentials and a verified sender. Failed delivery returns an error instead of claiming a link was sent. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Optional. If enabled, register `${APP_ORIGIN}/auth/google/callback`. Users need not own a ChatGPT account. |
| `DATA_NAMESPACE` | Optional stable prefix, shared by every instance of this application. |

`.env.example` documents names only. Production and Vercel preview deployments require a stable signing key and shared storage. `/api/health` returns 200 only when the required origin, signing key, email configuration and storage check pass. It returns 503 otherwise and exposes no secret values. A healthy configuration does not prove inbox delivery or Google provider setup.

## Verify before sending the link

1. Confirm this repository is the code serving the intended domain. The previously observed live Sites app had a different backend. Local code and deployment parity are separate checks.
2. Run `npm test`. For a real local Chromium acceptance check, run `npm run test:browser` with Chromium installed; set `CHROMIUM_PATH` if needed. Tests use synthetic reports and local sign-in only. Real provider delivery is not exercised.
3. Deploy through the owning project's normal workflow and require `/api/health` to return 200 on the real origin.
4. Use two independent test operator accounts. Upload CSV/text, sign in through actual delivered email, return to the same check, save and download the original. Restart/redeploy, reopen it, then verify the other operator cannot retrieve it. Sign out and confirm the old session no longer works.
5. Start with a small guided operator pilot and collect what was useful and what failed before expanding.

The owner can begin in their browser without signing in, then sign in to retain the report. The first owner seat is free forever. There is no working manager-invitation system in this build; the previous misleading invitation link now opens the owner's free seat.

## What operators can rely on in this build

CSV/text originals up to 1 MiB can be retained and downloaded exactly. Failed saves preserve the draft, retries do not duplicate the same report, and sign-out/tenant checks protect server-held originals. Successful sign-out clears product drafts from that browser; anonymous drafts survive the initial sign-in.

Generic number matches are only **Needs source review**. They are not verified financial fields, invoice OCR, cost savings, or staffing recommendations. PDF/photo extraction and the complete source-backed daily action engine are not implemented by this small One Seat app. Do not describe this rollout as validation of those capabilities or substitute fictional examples for owner data.

No invitations or live email were sent by these local checks. Actual deployment, provider configuration and live-domain verification remain release prerequisites.
