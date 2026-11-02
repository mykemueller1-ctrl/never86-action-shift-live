# Operator readiness changes — November 2, 2026

Validated around **3:50 PM America/Chicago (CST)** in the cloud workspace. These results concern this repository, not a verified deployment of `app.never86.app`.

## Implemented

- Durable report retention: local SQLite for a persistent Node host/development, shared Redis REST for production/serverless. No silent memory fallback.
- Atomic sign-in link/OAuth-state consumption, shared rate limits and cross-instance session revocation.
- Exact-original receipts/downloads, restaurant-scoped reads, idempotent saves and truthful failure messages.
- Draft preservation through initial sign-in and failed saves; successful sign-out and account switches protect owned browser drafts.
- Raw decimal matches remain Needs source review, CSV cells no longer merge date fragments into amounts, and fictional figures remain Sample.
- Readiness endpoint, Vercel route wiring and secure rollout instructions.

## Completed checks

`npm test`: **87 passed, 0 failed, 0 skipped**. Coverage includes real SQLite file reopen, simultaneous claims from separate Node processes, two-operator HTTP isolation, all connections closing/reopening, exact-original retention, cookie revocation, lost-response retry, oversized input, provider-error handling, token boundaries and frontend save/draft behavior.

`npm run test:browser`: **6/6 acceptance stages passed in real Chromium** using local synthetic CSV data:

1. Upload remains an unverified source preview.
2. Anonymous Save reaches sign-in without losing the draft.
3. Email-link test sign-in returns to the same task, saves and downloads the exact original.
4. Browser reload retains authenticated access.
5. Sign-out rejects original access and removes private product drafts.
6. A second operator cannot retrieve the first original or browser draft.

The browser run used development links locally, not real email delivery. Redis transport tests use a mock provider; deployment-provider persistence is unverified. The initial browser run caught missing draft cleanup; that was fixed and the final run above passed. A temporary Chromium-profile cleanup race in the test harness was also corrected.

## Still required before inviting operators

Confirm which deployment project serves the domain, configure its shared database/stable signing key/verified sender, deploy the change through that project, require live `/api/health` 200, and repeat sign-in with actual delivered email and two independent operator accounts there. Current cloud requests to the app, GitHub API, Vercel API and Resend API fail with CONNECT proxy 403. Native Git transport works. Secrets configured on a hosting platform cannot be inferred from the absent local variables.

The cloud configuration draft has the required deployment API domain additions and updated startup instructions saved. Draft persistence does not apply network changes to this runtime or publish an application.

No live operator invitation, production mail, data rewrite or production deployment was performed. This One Seat app does not yet contain the complete source-backed daily action engine or PDF/photo extraction. See [the rollout guide](OPERATOR-PILOT.md) for the exact release boundary.
