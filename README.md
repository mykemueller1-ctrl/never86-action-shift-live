# Never86'd Action Shift — One Seat

Public-first CSV/text report preview and private original retention. The owner seat is free forever. Users can begin without signing in, then retain their report through email or a configured Google account.

Use Node.js 24 LTS (minimum 22.13). There are no package dependencies to install. Configure a stable `SESSION_SECRET` of at least 32 bytes, then run `npm start`. Local storage is SQLite; production/serverless hosting requires shared Redis REST storage and real email delivery configuration. See [operator rollout instructions](OPERATOR-PILOT.md) and [.env.example](.env.example).

Run `npm test`. For real local Chromium acceptance, run `npm run test:browser`; set `CHROMIUM_PATH` if Chromium is not at `/usr/bin/chromium`. Browser checks use local synthetic reports and no real email service.

Number matches require source review. This app does not implement PDF/photo extraction, manager invitations, or the complete source-backed daily action engine. Local checks do not establish that this repository serves `app.never86.app`; confirm the deployment project and real sign-in before inviting operators.
