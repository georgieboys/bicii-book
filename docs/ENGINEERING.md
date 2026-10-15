# Engineering guide

Owner: Abhishek Cherian George (owner); maintained by the build agent.
Last setup exercise: 2026-10-05, this machine (Linux, Node 22.22.0, npm
10.9.4, Postgres 16.14, no Docker), commit f32dc45 (application code
identical to b34bbcd, the head of PR #7); results in the tables below.

This is the one home for setup, commands and conventions. What the product
is: [PRODUCT.md](PRODUCT.md). How it is built: [ARCHITECTURE.md](ARCHITECTURE.md).
Test strategy: [TESTING.md](TESTING.md). Rules that are not negotiable and
the Next.js 16 differences (`proxy.ts`, async request APIs, Turbopack):
[AGENTS.md](../AGENTS.md).

## Prerequisites and access

- Node 22 ([`.nvmrc`](../.nvmrc); `package.json` `engines` says `>=22`) with
  npm 10.
- A Postgres 16 you can reach as a superuser (default `postgres`/`postgres`
  on 127.0.0.1:5432). The scripts create databases and the Supabase platform
  roles, so a non-superuser does not work.
- curl, tar and git. No Docker.
- The devstack binaries (PostgREST 12.2.3, Supabase Auth 2.178.0, Node 24
  for Storage, Supabase Storage 1.79.31; pinned in
  [`scripts/devstack/config.mjs`](../scripts/devstack/config.mjs)) are
  linux-x64. On macOS or Windows use the Supabase CLI with Docker instead:
  [RUNBOOK "Local Supabase with Docker (Supabase CLI)"](RUNBOOK.md#local-supabase-with-docker-supabase-cli).
- For the E2E suite, a Chromium that Playwright can launch. On your own
  machine run `npx playwright install --with-deps chromium` once (CI does
  the same in [`.github/workflows/e2e.yml`](../.github/workflows/e2e.yml);
  exercised only there, and `--with-deps` may ask for sudo on Linux).
  `PLAYWRIGHT_CHROMIUM_EXECUTABLE` points it at another Chromium instead.
  Exception: in the build agent's container Chromium is preinstalled at
  `/opt/pw-browsers` and used automatically; do not download browsers
  there.
- About 1 GB of disk for the devstack cache (`~/.cache/bicii-devstack`,
  985 MB measured on 2026-10-05).
- Variables: the app reads `.env.local`, which `npm run devstack:env`
  writes. The devstack scripts, the DB tests and Playwright read
  `DATABASE_URL` / `PG*` / `BICII_*` / `E2E_*` from the **shell only**, never
  from `.env.local`. Every name is listed in [`.env.example`](../.env.example).
  Postgres somewhere else? Set `DATABASE_URL`, or `PGHOST` / `PGPORT` /
  `PGUSER` / `PGPASSWORD` (and `PGDATABASE`, default `bicii_dev`), in the
  shell before any command. `PGDATABASE` also names the database that
  `db:reset`, the devstack services and `test:e2e` use (and drop).
- A second checkout (a `git worktree`) on the same machine runs its own
  stack beside the first by setting, in its shell before every command:
  `PGDATABASE` (its own database name), `BICII_AUTH_PORT`,
  `BICII_REST_PORT`, `BICII_STORAGE_PORT`, `BICII_GATEWAY_PORT`,
  `BICII_SMTP_PORT` and `BICII_MAIL_HTTP_PORT`, other than the first
  checkout's, and `E2E_PORT`
  (the E2E app port). Then `npm run db:reset` and `npm run devstack:start`
  in it, `npm run devstack:env` if its dev server should talk to its own
  stack, and `next dev -p <another port>`. Its devstack state lives in its
  own `.devstack/`; `check:types` and the DB tests build per-process
  throwaway databases, so the two never share one. The build agent keeps
  these exports in an untracked `.wt-env` in the second worktree (excluded
  through `.git/info/exclude`).
- No hosted service, account or credential is needed for development: all
  work runs against the local devstack with its public local demo keys.
  Never commit `.env.local`.
- Shopify (Phase 10) needs no store locally. With no `SHOPIFY_*` variable
  set, Shopify is off (webhooks answer 503, syncs wait). Add
  `SHOPIFY_ADAPTER=fake` to `.env.local` for the in-memory Shopify (one per
  dev server process; never with `SHOPIFY_ADMIN_TOKEN`, never in
  production, env.ts refuses both); add `SHOPIFY_WEBHOOK_SECRET` and
  `SHOPIFY_SHOP_DOMAIN` (any test values, e.g. the fixtures' in
  `tests/fixtures/shopify.ts`) to post signed webhooks to
  `/api/shopify/webhooks`, and `CRON_SECRET` to call
  `/api/cron/integrations` with `Authorization: Bearer <value>`. E2E sets
  all four itself (`playwright.config.mts`). The live adapter and its
  variables: [RUNBOOK "Shopify"](RUNBOOK.md#shopify).
- Stripe (Phase 14) needs no account locally. With no `STRIPE_*` variable
  set, Stripe is off (the webhook answers 503). For the in-memory Stripe
  add `STRIPE_ADAPTER=fake`, a local `STRIPE_WEBHOOK_SECRET=whsec_…` (any
  test value, e.g. `STRIPE_TEST_WEBHOOK_SECRET` in
  `tests/fixtures/stripe.ts`) and `ADMIN_ORIGIN=http://localhost:3000`
  to `.env.local`; post events signed with that file's `signStripeBody`
  to `/api/stripe/webhooks`. The fake is refused with a key and in
  production. Or use **test** keys with the Stripe CLI (`stripe listen
  --forward-to localhost:3000/api/stripe/webhooks --latest`); a live key
  keeps Stripe off outside production. Why Stripe is off is logged once
  (`stripe off`, with the reason). Details:
  [RUNBOOK "Stripe payments"](RUNBOOK.md#stripe-payments).

## Clean checkout to running application

Run in this order. The local results are from 2026-10-05 on this machine,
with the components already cached and `bicii_dev` already present.

| Step | Command | Expected result | Evidence |
|---|---|---|---|
| Install | `npm ci` | `node_modules` from `package-lock.json` | Not run locally in the retrofit; CI runs it in every job through [`.github/actions/prepare`](../.github/actions/prepare/action.yml), e.g. [PR #7 `check`](https://github.com/abhishekcheriangeorge-ops/bicii-book/actions/runs/37276827625/job/111655574607) |
| Devstack components (once per machine) | `npm run devstack:setup` | Each component "cached" (first run downloads and builds, a few minutes); ends "devstack components ready" | Local: all four "cached", 0.5 s |
| Database | `npm run db:reset` | Drops and rebuilds `bicii_dev`: roles, Auth, Storage, the migrations (44 since the email sign-in integration), seed; "database ready in …s" and the seeded logins line | Local: "database ready in 2.8s" |
| Services | `npm run devstack:start` | The mail catcher :8025 (SMTP :2525), Auth :9999, PostgREST :3001, Storage :5000 and the gateway "ready: http://127.0.0.1:54321". Builds `bicii_dev` itself if it does not exist yet | Local (2026-10-06, second worktree ports): five services started |
| Health | `npm run devstack:status` | A table with each service "running" and "ok (200)", and the gateway and mail URLs | Local: all five ok (200) |
| Configure | `npm run devstack:env` | Writes the gateway URL, the local anon and service-role keys and a placeholder public site URL into `.env.local`, keeping other lines | Local: exit 0 (contents not printed) |
| Run | `npm run dev` | Next dev server (Turbopack) on :3000; open **http://localhost:3000** and sign in | Local: `GET /login` 200, `/` redirects (307) to `/login` |

`npm run devstack:stop` stops the services. The primitives gallery is at
`/dev/ui` in the dev server.

Seeded logins (synthetic, local and CI only; never seed a hosted project,
see [RISKS R-015](RISKS.md#r-015--the-seed-has-published-logins)). Nobody
has a password (PLAN D10): enter the email on `/login`, press **Email me a
code**, then read the 6-digit code from the devstack's mail catcher and
type it in. A code is valid for 10 minutes and only the newest one works.

```sh
curl "http://127.0.0.1:${BICII_MAIL_HTTP_PORT:-8025}/messages/latest?to=admin@bicii.test"
# the "code" field is the code; or open the newest file in .devstack/mail/
```

| Email | Role | Exceptions (on top of the role, D92) |
|---|---|---|
| `admin@bicii.test` | admin (every permission) | none |
| `manager@bicii.test` | manager (every permission except `manage_staff`, D91) | none |
| `mechanic1@bicii.test` | mechanic | `view_costs` |
| `mechanic2@bicii.test` | mechanic | none |

The seed also has one customer login, `chloe.lim@example.com` (Chloe Lim,
no password either), for the public site's customer pages; the Admin does
not let customers in. A first useful result: sign in as `admin@bicii.test`
and Today opens ([USER-GUIDE.md](USER-GUIDE.md)).

The mail catcher (`scripts/devstack/mailcatcher.mjs`) receives everything
the devstack's Auth sends and keeps it in `.devstack/mail/` only; nothing
leaves the machine. It is generic (it knows nothing about staff), so the
public site's customer codes can be read the same way. Its HTTP API
(`/health`, `/messages`, `/messages/latest?to=…&after=…`, `/raw`,
`/templates`, `DELETE /messages`) is in
[TESTING.md](TESTING.md#the-devstack-mail-catcher). With the Docker CLI
stack, codes go to its Mailpit instead
([RUNBOOK](RUNBOOK.md#local-supabase-with-docker-supabase-cli)).

## Commands

| Script | What it does | Evidence (2026-10-05 unless a URL) |
|---|---|---|
| `npm run dev` | Next dev server (Turbopack) on :3000. | Local: `/login` 200 |
| `npm run build` / `npm start` | Production build / serve it. | Local: both ran inside `npm run test:e2e` (its web server is `npm run build && next start -p 3100`); CI [PR #7 `build`](https://github.com/abhishekcheriangeorge-ops/bicii-book/actions/runs/37276827625/job/111655574766) |
| `npm run check` | `next typegen` + `tsc --noEmit`, ESLint, `prettier --check`. | Local: pass (30 s); `feat/p6-consignment` Phase 6 steps 1 and 2: pass; the Phase 6 review fixes: pass; `feat/p7-purchasing` at the Phase 7 integration: pass; `feat/auth-email-otp` at its integration: pass; the merge of `main` into `feat/p8-labels`: pass; the merge of `main` into `feat/p10-shopify`: pass |
| `npm run check:types` | Regenerate the database types from a throwaway database built from the migrations and fail if `src/lib/database.types.ts` differs. | Local: pass (5 s); `feat/p6-consignment` Phase 6 step 1 (at 365bdd7) and step 2 (at 2c402b2): pass; the Phase 6 review fixes: pass; the Phase 7 integration: pass; the email sign-in integration: pass; the merge of `main` into `feat/p8-labels`: pass; the merge of `main` into `feat/p10-shopify`: pass |
| `npm test` | Every Vitest project (unit + db). | Local: 82 files, 1186 tests passed (58 s); `feat/p6-consignment` Phase 6 step 1: 86 files, 1225 tests passed (78 s); step 2: 89 files, 1298 tests passed (65 s); step 4: 92 files, 1364 tests passed (81 s); the Phase 6 review fixes: 93 files, 1384 tests passed (70 s); `feat/p7-purchasing` at the Phase 7 integration: 102 files, 1517 tests passed (105 s); its review fixes: 102 files, 1518 tests passed (83 s); `feat/auth-email-otp` at its integration with main and purchasing (2026-10-06, `BICII_REQUIRE_STACK=1`): 111 files, 1585 tests passed; `feat/p8-labels` end of Phase 8 (step 4): 108 files, 1587 tests passed; `feat/p10-shopify` Phase 10 step 3: 123 files, 1849 tests passed (unit 71 / 878), with `BICII_REQUIRE_STACK=1`; step 4: 124 files, 1873 tests passed, with `BICII_REQUIRE_STACK=1`; the merge of `main` into `feat/p8-labels` (`BICII_REQUIRE_STACK=1`): 129 files, 1900 tests passed (116 s; unit 70 / 904); the merge of `main` into `feat/p10-shopify` (`BICII_REQUIRE_STACK=1`): 146 files, 2200 tests passed (106 s) |
| `npm run test:unit` | Unit project (jsdom): pure TypeScript and synchronous components. | Local: 45 files, 512 tests passed (37 s); `feat/p6-consignment` Phase 6 step 4 (`npx vitest run --project unit`): 48 files, 579 tests passed (22 s); the Phase 7 integration: 52 files, 643 tests passed; its review fixes: 52 files, 644 tests passed (in `npm test`); the email sign-in integration: 56 files, 686 tests passed |
| `npm run test:db` | DB project: invariants, RLS and RPCs on per-file clones of a template database. Includes a live-stack smoke test when the devstack is running. | Local: 37 files, 674 tests passed (48 s) |
| `npm run test:e2e` | Playwright, Chromium, phone + iPad. Builds the app, serves it on :3100, resets `bicii_dev`, starts the devstack if needed. | Local: 106 passed (11.1 min); `feat/p6-consignment` Phase 6 step 2: 106 passed (9.7 min); step 3: 110 passed (12.4 min); step 4: 118 passed (13.3 min); the Phase 6 review fixes: 118 passed (11.8 min); the Phase 7 integration (`E2E_PORT=3200`, database `bicii_dev_wt`): 138 passed (16.8 min); its review fixes: 138 passed (15.0 min); the email sign-in integration (same worktree): 152 passed (18.2 min); `feat/p8-labels` end of Phase 8 (step 4): 146 passed, 73 per project, 0 failed, flaky or skipped (14.2 min, build inside); `feat/p10-shopify` Phase 10 step 3: 150 passed (15.0 min, with the fake Shopify env); step 4: 160 passed, 80 per project, 0 failed (15.0 min, build inside; `shopify.spec.ts` 5 × 2); the merge of `main` into `feat/p8-labels`: 190 passed, 95 per project, 0 failed, flaky or skipped (20.2 min, build inside); the merge of `main` into `feat/p10-shopify`: 200 passed, 100 per project (20.3 min, build inside) |
| `npm run format` / `npm run lint` | Prettier write / ESLint. | `lint` runs inside `check`; `format` not exercised |
| `npm run tokens:contrast` | Recompute WCAG ratios for the colour tokens; fails on a miss. | Local: 29 pairs ok |
| `npm run icons` | Regenerate the PWA icons from `brand/logo-source.png`. | Not exercised |
| `npm run devstack:setup` | Download and build the devstack components into `~/.cache/bicii-devstack` (`BICII_DEVSTACK_CACHE` moves it; idempotent; `-- --force` rebuilds). | Local: cached; `--force` not exercised |
| `npm run devstack:start` / `stop` / `status` | Run, stop, or show health of the mail catcher (HTTP :8025, SMTP :2525), Auth :9999, PostgREST :3001, Storage :5000 and the gateway :54321, started in that order; pids and logs in `.devstack/`. `start` builds the database first if it does not exist yet (as `db:reset` would), never touches an existing one, restarts services that were started against a different database, restarts a service that is unhealthy or was started with another configuration (a digest of its command, env and the files it runs, kept next to its pid as `<name>.config`; after a pull or merge changes `services.mjs`, say) together with the services started after it, and refuses to start a service whose port another process holds. Ports: `BICII_MAIL_HTTP_PORT`, `BICII_SMTP_PORT`, `BICII_AUTH_PORT`, `BICII_REST_PORT`, `BICII_STORAGE_PORT`, `BICII_GATEWAY_PORT`. | Local: all three |
| `npm run devstack:env` | Write the devstack values into `.env.local`, keeping other lines. Only the app reads `.env.local`; the scripts and tests take `DATABASE_URL` / `PG*` from the shell. | Local: exit 0 |
| `npm run db:reset` | Drop and rebuild the dev database, then seed it. The demo history is relative to the shop day of the reset: reset to move "today". | Local: 2.8 s |
| `npm run db:migrate` | Apply pending migrations without a reset. | Local: "already up to date" |
| `npm run db:types` | Regenerate `src/lib/database.types.ts` (`-- --fresh` builds a throwaway database from the migrations first; CI diffs that). | Local: wrote the file; `git diff --exit-code` clean |

## Validation

| Check | Command | What it establishes | Limits | Evidence |
|---|---|---|---|---|
| Static | `npm run check` | Types (with Next's generated route types), lint rules (including the service-role import boundary), formatting | `next build` does not lint; Markdown is not formatted (prettier ignores `*.md`) | Local pass, 2026-10-05; Phase 9 step 2: pass (58 s); Phase 9 step 3: pass; Phase 9 step 4: pass (52 s) |
| Generated types | `npm run check:types` | `database.types.ts` matches the migrations | Needs Postgres and the devstack cache | Local pass, 2026-10-05; Phase 9 step 2: pass (no diff); Phase 9 step 3: pass (no diff); Phase 9 step 4: pass (no diff) |
| Unit | `npm run test:unit` | Pure rules: money, permissions, status transitions, labels, form parsing, components | No database | Local: 45 files, 512 tests; the email sign-in integration: 56 files, 686 tests; staff roles step 4: 57 files, 737 tests; staff roles review fixes: 57 files, 738 tests; the merge of `main` into `feat/p8-labels`: 70 files, 904 tests; Phase 9 step 1: 57 files, 739 tests; Phase 9 step 2: 60 files, 776 tests; Phase 9 step 3: unchanged (60 files, 776 tests); Phase 9 step 4: 62 files, 802 tests |
| Database | `npm run test:db` (or `npm test` for both) | Invariants, RLS, RPC guards, concurrency and the API surface against real Supabase Auth and Storage schemas. Global setup builds one template from roles, Auth, Storage, the migrations and the seed; each file runs on its own clone | The live-stack smoke test skips when the gateway is down unless `BICII_REQUIRE_STACK=1` (CI sets it); concurrency blocks skip in existing-database mode | Local `npm test`: 82 files, 1186 tests (on b34bbcd); `npm run test:db`: 37 files, 674 tests; `feat/p6-consignment` Phase 6 step 4 `npm test`: 92 files, 1364 tests (unit 48 / 579, so database 44 / 785); the review fixes: 93 files, 1384 tests (unit 48 / 581, database 45 / 803); the Phase 7 integration: 102 files, 1517 tests (unit 52 / 643, database 50 / 874); its review fixes: 102 files, 1518 tests (unit 52 / 644, database 50 / 874); the email sign-in integration: 111 files, 1585 tests (unit 56 / 686, database 55 / 899); staff roles step 1: 112 files, 1632 tests (unit 56 / 689, database 56 / 943); staff roles step 4 (integration review): 113 files, 1680 tests (unit 57 / 737, database 56 / 943); staff roles review fixes: 113 files, 1686 tests (unit 57 / 738, database 56 / 948); Phase 9 step 1 (`feat/p9-reporting`, `BICII_REQUIRE_STACK=1`): 114 files, 1720 tests (unit 57 / 739, database 57 / 981); Phase 9 step 2: 118 files, 1761 tests (unit 60 / 776, database 58 / 985; 108 s); Phase 9 step 3: 120 files, 1788 tests (unit 60 / 776, database 60 / 1012; 106 s); Phase 9 step 4: 122 files, 1814 tests (unit 62 / 802, database 60 / 1012; 112 s) |
| Live stack | inside `npm run test:db` / `npm test`: `tests/db/*.stack.test.ts` | The app's own server code against the running devstack (PostgREST, Auth, Storage) on `bicii_dev`: photo moves, the label domain, the sign-in counter and staff sessions, and the Shopify service layer (`shopify.stack.test.ts`: a fresh fake Shopify per test, only its own two products' jobs by id, deltas only because `bicii_dev` persists) | Skip when the gateway is down unless `BICII_REQUIRE_STACK=1`; they write to `bicii_dev` (the Shopify test restores its products, price and stock at the end) | Local: pass, Phase 10 step 3; the merge of `main` into `feat/p8-labels`: pass (`BICII_REQUIRE_STACK=1`, no skips); the merge of `main` into `feat/p10-shopify`: pass |
| End to end | `npm run test:e2e` | The staff journeys on an iPhone 13 and an iPad viewport against a production build and the devstack | Chromium only (installed once, see [Prerequisites](#prerequisites-and-access)); resets the database `PGDATABASE` names (`bicii_dev` by default); not a required check in CI ([R-010](RISKS.md#r-010--e2e-is-not-a-required-check-and-branch-protection-is-unverified)) | Local: 106 passed in 11.1 min; the email sign-in integration: 152 passed on phone and tablet in 18.2 min; staff roles step 1: 152 passed in 14.9 min; staff roles step 4: 158 passed in 16.8 min (`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`, no dev server running); staff roles review fixes: 158 passed in 15.1 min; the merge of `main` into `feat/p8-labels`: 190 passed in 20.2 min; the merge of `main` into `feat/p10-shopify`: 200 passed in 20.3 min; CI [PR #7 e2e](https://github.com/abhishekcheriangeorge-ops/bicii-book/actions/runs/37276834195/job/111655595521); Phase 9 step 1: 158 passed in 15.4 min; Phase 9 step 2: 168 passed in 17.4 min (`reports.spec.ts` 10 of them); Phase 9 step 3: 168 passed in 17.8 min; Phase 9 step 4: 176 passed in 19.1 min (`exceptions.spec.ts` 8 of them; a first run had 1 failure, the phone Today overflow fixed in f09d72e); CI [PR #7 e2e](https://github.com/abhishekcheriangeorge-ops/bicii-book/actions/runs/37276834195/job/111655595521) |
| Contrast | `npm run tokens:contrast` | WCAG ratios of the colour token pairs | Tokens only, not rendered pages | Local: 29 pairs ok |
| Build | `npm run build` | The app compiles for production with placeholder public env | Does not contact Supabase; writes under `.next`, as `npm run dev` does; it was exercised only with no dev server running in the checkout | Local inside `test:e2e`; CI [PR #7 `build`](https://github.com/abhishekcheriangeorge-ops/bicii-book/actions/runs/37276827625/job/111655574766); Phase 9 step 2: local pass (9 s, then again inside `test:e2e`); Phase 9 step 3: local pass (32 s, then again inside `test:e2e`); Phase 9 step 4: local pass (10 s, then again inside `test:e2e`) |
| Docs links | the Vibe Code Docs Stack link checker (below) | Every relative link and heading anchor in the repository's Markdown resolves; fences are closed | Does not check external URLs or the truth of the text | Local: 0 problems at this commit (Phase 9 step 1: 38 files, 724 links; Phase 9 step 2: 38 files, 737 links; Phase 9 step 3: 38 files, 750 links; Phase 9 step 4: 38 files, 765 links) |

Strategy, the invariant list and what CI runs: [TESTING.md](TESTING.md),
in particular [Database test harness](TESTING.md#database-test-harness)
and [CI](TESTING.md#ci).

The docs link check uses the toolkit's checker without its `--root`
mode: `check_docs.py --root <app>` also runs the toolkit's own
skill-package check, which always fails on an application repository.

```sh
git clone https://github.com/abhishekcheriangeorge-ops/vibe-code-docs-stack
python3 -m venv .venv && .venv/bin/pip install -r vibe-code-docs-stack/scripts/requirements-checks.txt
PYTHONDONTWRITEBYTECODE=1 .venv/bin/python -B -c "import sys; sys.path.insert(0, 'vibe-code-docs-stack/scripts'); import check_docs; e, n, l = check_docs.check_markdown('/path/to/bicii-book'); print(*e, sep='\n'); print(f'{n} files, {l} links, {len(e)} problems'); sys.exit(1 if e else 0)"
```

Clone the toolkit and create the venv outside this repository, or the
checker would scan the toolkit's own Markdown too.

### Report volume bench

`scripts/bench/report-volume.sql` (Phase 9) generates a year of synthetic
data (about 15,000 jobs, 50,000 work-order lines, 10,000 sale lines,
100,000 movements, 2,000 receipt lines) and times the period-report RPCs
with `EXPLAIN (ANALYZE, BUFFERS)`. It is a measurement, not a test, and it
writes rows, so run it only on a throwaway clone of the worktree's
database, never on `bicii_dev` or `bicii_dev_wt` themselves (with
`PGHOST`, `PGUSER` and `PGPASSWORD` set for the local server):

```sh
createdb bicii_bench_wt
pg_dump --no-owner bicii_dev_wt | psql -q bicii_bench_wt
psql -v ON_ERROR_STOP=1 -f scripts/bench/report-volume.sql bicii_bench_wt
dropdb bicii_bench_wt
```

Targets: a month under 300 ms, a year under 1.5 s, a line-items page under
100 ms, `report_stock_value` under 300 ms. The latest timings are in
[DATA-MODEL §14](DATA-MODEL.md#14-reporting-views-schema-reporting)
(2026-10-06: every target met). Section 3 (Phase 9 step 3) adds about
3,000 unique units across their states and times the reconciliation RPCs
(target 500 ms: met), `operational_exceptions` (500 ms: met),
`report_exception_counts` and `today_dashboard` (150 ms each: missed,
[R-059](RISKS.md#r-059--today-and-the-exception-counts-are-slow-at-a-busy-years-volume)).

## Changing the system

Read [AGENTS.md](../AGENTS.md) first. Conventions that are not obvious
from the code:

- **Migrations.** One concern per file in
  [`supabase/migrations`](../supabase/migrations). They run in filename
  order, so each track has its own allocated prefix range (2026-10-06):
  `20261004…` main line (through labels, and Shopify on its branch), `20261005…`
  purchasing and staff email sign-in, `20261006000100`–`20261006000900`
  staff roles, `20261006001000` and up reporting, `20261007…` public site,
  `20261014000100`–`20261014000200` indent parts and quotes (Phase 13) and
  `20261014000300` and up Stripe payments (Phase 14; the indent follow-up
  of 2026-10-15 took `20261014000700`, closing indent items, D149a–c,
  `20261014000800` and `20261014000900`, and voiding a fitted indent
  line, D160, `20261014001000` and `20261014001100`). Main and the hosted
  project end at `20261014000900_indent_settle_and_outside_purchase.sql`
  since PR #27 (`20261014001100_indent_unfit_on_void.sql` once D160
  merges), so a
  new file must sort after the newest (hosted migrations are
  append-only; `migrate.yml` never uses `--include-all` and skips applied
  versions).
  The latest file on `feat/p9-reporting` is
  `20261006001300_operational_exceptions.sql` (Phase 9, after the staff
  roles' `20261006000100`–`20261006000300`; it applies before or after
  Phase 10's `20261004004000`, R-058). A
  migration that replaces a function another track also replaces (as
  `staff_search`) must carry both tracks' behaviour. Never edit a merged
  or applied migration; add a new one (`migrate.yml` skips a version the
  hosted project already holds, so an edit there would never run). Only a
  file that has not yet merged to `main` may still be edited in place.
- **Access.** Every object gets an explicit `revoke` and `grant`; every table
  ships with RLS and its policies in the same migration. Base tables are
  staff-only; customers reach data only through security definer `my_*`
  RPCs; anonymous users only through explicit public projections
  (`reporting.public_items` and the public schedule RPCs).
- **Functions.** Security definer functions use `set search_path = ''` and
  schema-qualified bodies, put their guards first
  (`private.require_staff`, `require_permission`, `require_admin`) and have
  `EXECUTE` revoked from `PUBLIC`.
- **Business errors.** RPCs raise `P0001` with a code as the message; add
  the code and its message to [`src/lib/db-errors.ts`](../src/lib/db-errors.ts)
  in the same change.
- **History.** A change that needs a reason passes it with
  `private.set_change_reason()`; event and history tables are append-only,
  enforced by triggers. Short IDs (`B-`, `J-`, `P-`, `U-`, …) come from
  `private.next_short_id`. Seed rows use fixed, RFC-valid version 4 UUIDs
  ([`tests/fixtures/ids.ts`](../tests/fixtures/ids.ts)).
- **After a migration:** `npm run db:reset`, `npm run db:types` and commit
  `src/lib/database.types.ts`; add every new table, view or RPC that
  `anon` or `authenticated` can reach to
  [`tests/fixtures/api-surface.ts`](../tests/fixtures/api-surface.ts) (the
  meta DB test fails otherwise). A ledger-affecting change gets its DB
  invariant test before its screen.
- **Application layers** (ADR-001 A2): RPC wrappers live in
  [`src/lib/domain`](../src/lib/domain) and import `server-only`
  (`errors.ts` and `list.ts` are shared types). Server Actions use
  `staffAction` ([`src/lib/actions.ts`](../src/lib/actions.ts)), and a
  failed form returns its typed values in `ActionResult.values` so the form
  renders them again. Money is `numeric` in Postgres and `decimal.js` in
  TypeScript; the database does the authoritative arithmetic.
- **QR URLs and labels** (Phase 8, ADR-017). Never build a QR URL from
  `NEXT_PUBLIC_PUBLIC_SITE_URL` or anywhere but
  [`src/lib/qr.ts`](../src/lib/qr.ts) (`qrUrl`, display only); printed
  payloads come from the database (`print_jobs.qr_payload`). The variable
  may be read only in `src/lib/env.ts` and `src/lib/qr.ts`
  (`tests/unit/qr-base-sources.test.ts` fails otherwise). Label text comes
  only from `print_jobs.content` or `label_preview`, parsed with
  `labelContentSchema`; one layout engine (`composeLabel`) feeds the SVG and
  the PDF. A unit test that rasterises with sharp or decodes with ZXing or
  pdf-lib declares `// @vitest-environment node`, and one that imports a
  `server-only` module mocks it (`vi.mock("server-only", () => ({}))`).
- **Shopify** (Phase 10, ADR-020). Every Shopify API call lives in
  [`src/lib/integrations/shopify`](../src/lib/integrations/shopify) behind
  the `ShopifyAdmin` interface (`graphql-admin.ts` live, `fake-admin.ts`
  in memory; `client.ts` picks one), never in a component, action, route
  or domain module; the service-role client is imported only there and in
  `src/lib/admin`. Runners take their dependencies (`IntegrationDeps`:
  service client, adapter, logger, Storage base) so tests inject them. The
  price pushed is `product_sync_state.sale_price` exactly; TypeScript never
  computes money or stock, and every status, retry and backoff is decided
  by the RPCs. Routes are thin: `src/app/api/shopify/webhooks/route.ts`
  and `src/app/api/cron/integrations/route.ts` call `handleShopifyWebhook`
  and `handleCronRequest`. The pinned Admin API version is
  `SHOPIFY_API_VERSION` in `config.ts` (upgrade:
  [RUNBOOK](RUNBOOK.md#shopify-api-version-upgrade)).
- **Stripe** (Phase 14, ADR-025). Every Stripe API call lives in
  [`src/lib/integrations/stripe`](../src/lib/integrations/stripe) behind
  the `StripeGateway` interface (`http-gateway.ts` live over fetch,
  `fake-gateway.ts` in memory; `client.ts` picks one through
  `stripeConfig`). No SDK. The API version is pinned
  (`STRIPE_API_VERSION` in `config.ts`) and `payment_method_types` is never
  sent. Routes are thin: `src/app/api/stripe/webhooks/route.ts` calls
  `handleStripeWebhook`, which takes its dependencies so tests inject
  them. TypeScript computes no money: the cents sent to Checkout come from
  Postgres, and Stripe's cents are converted back in Postgres. Payments
  change only through `record_stripe_event` and `record_stripe_read`
  (`records.ts`); the service-role client is imported only under
  `src/lib/integrations/`. Stripe modules log only correlation id, op,
  payment id, `evt_` id, event type, outcome, HTTP status, `StripeError`
  code, Stripe's error code and `payment_method_types`: never a URL (it
  carries the quote token), a token, a body, a payload, a signature header
  or a Stripe error message; the logger also redacts those keys.
- **Tests.** DB tests run on per-file clones; E2E specs run on both the
  phone and iPad projects and give every record a unique tag
  (`tagFor(testInfo)`), never counting rows in the shared database.
- **Decisions and docs.** A new business decision takes a number from
  its track's allocated range ([AGENTS.md](../AGENTS.md) item 2; D60–D66
  are purchasing's), with a row in [PLAN §6](PLAN.md#6-open-decisions-for-the-owner) and a record in
  [decisions/](decisions/README.md). Update the canonical doc that owns
  each changed fact ([README.md](../README.md#where-each-fact-lives) lists
  them), record new shortcuts in [RISKS.md](RISKS.md), and answer the
  documentation question in the
  [pull request template](../.github/pull_request_template.md).

Pull requests: CI runs `check`, `test (unit + db)` and `build` on every
pull request; add the `e2e` label to run Playwright
([RUNBOOK "CI"](RUNBOOK.md#ci)). Production runs on Vercel from `main`,
and merging migrations runs `migrate.yml` against the hosted project; the
release process is in [OPERATIONS.md](OPERATIONS.md#releases).

## Debugging and common setup failures

| Symptom | Diagnostic | Fix |
|---|---|---|
| DB tests stop with "could not build the template database on … Is Postgres running (pg_ctlcluster 16 main start) and has `npm run devstack:setup` been run?" | `pg_isready -h 127.0.0.1`; `ls ~/.cache/bicii-devstack` | Start Postgres (`pg_ctlcluster 16 main start` on this machine) or set `PG*` in the shell; run `npm run devstack:setup` |
| Sign-in fails right after `npm run db:reset` while the services were running ("Sign-in is unavailable right now. Try again in a minute.") | `npm run devstack:status` shows everything healthy; Auth answered 500 "Database error querying schema" | Observed workaround: `npm run devstack:stop` then `npm run devstack:start`. On 2026-10-05 the first sign-in after a reset failed and the next ones succeeded (then with a password; not seen with codes since); the reset drops the database with `force`, closing Auth's open connections, and the scripts reload only PostgREST (inferred cause) |
| The app shows another environment's data or rejects the keys after switching stacks | Compare `NEXT_PUBLIC_SUPABASE_URL` in `.env.local` with `npm run devstack:status` (do not print the keys) | `npm run devstack:env`, then restart `npm run dev` |
| Signed out or dev tooling misbehaving when the app is opened on `http://127.0.0.1:3000` | Check the address bar | Use `http://localhost:3000`. Auth's site URL is localhost (`scripts/devstack/services.mjs`) and the session cookie belongs to the host you signed in on. `next.config.ts` already allows `127.0.0.1` as a dev origin, and `/login` answered 200 there on 2026-10-05 |
| Today, the board and the demo appointments look a day or more old | The demo history is anchored to the shop day of the last reset | `npm run db:reset` (then restart the services, as above) |
| The Scan screen says "The camera only works over a secure connection. Open the app over HTTPS (or on localhost)." | Opened from a phone over `http://<LAN IP>:3000` | Expected; type the code instead, or follow [RUNBOOK "The camera scanner on phones and iPads"](RUNBOOK.md#the-camera-scanner-on-phones-and-ipads) |
| Playwright cannot find a browser ("Executable doesn't exist …") | Is `PLAYWRIGHT_CHROMIUM_EXECUTABLE` set? Does `/opt/pw-browsers/chromium` exist? | On your own machine: `npx playwright install --with-deps chromium` (as CI does), or set `PLAYWRIGHT_CHROMIUM_EXECUTABLE`. In the build agent's container Chromium is preinstalled at `/opt/pw-browsers` (`PLAYWRIGHT_BROWSERS_PATH`); do not download browsers there |
| `check:types` fails in CI | The job prints "Out of date. Run 'npm run db:types' …" | `npm run db:reset && npm run db:types`, commit `src/lib/database.types.ts` |
| No sign-in code arrives on the devstack | `npm run devstack:status` (is `mail` running?); `.devstack/logs/auth.log` for `over_email_send_rate_limit` (one email per address per second here) | `npm run devstack:start` (it restarts an Auth started before the mail settings); ask again after a second; the newest code is the only valid one |
| A service will not start | `npm run devstack:status`; logs in `.devstack/logs/{mail,auth,rest,storage,gateway}.log` | Free the port or set `BICII_*_PORT` in the shell ([`.env.example`](../.env.example)) |

Known gaps (no hosted environment, devstack differences from hosted
Supabase, unmerged PR stack): [RISKS.md](RISKS.md).

## Knowledge map

| Where | What |
|---|---|
| [`src/app`](../src/app) | App Router: `(auth)/login`, the `(staff)/…` screens, manifest, error pages; `src/proxy.ts` (session refresh and sign-in redirect, Next 16's middleware) and `src/instrumentation.ts` |
| [`src/lib/domain`](../src/lib/domain) | Typed, server-only wrappers over the RPCs |
| [`src/lib/auth`](../src/lib/auth) | Session, `requireStaff`, permissions, redirects, sign-in code rules (`otp.ts`), messages and limits |
| [`src/lib`](../src/lib) | Money, IDs, dates, env, logger, actions, DB error messages; `supabase/` (server, browser and restricted service-role clients); `admin/` (Auth admin API, service role); `integrations/shopify/` (the Shopify adapters, webhook and cron handlers, queue and sync runners, service role) |
| [`src/app/api`](../src/app/api) | Route handlers: the label PDF, `shopify/webhooks` (HMAC) and `cron/integrations` (bearer); the last two are outside the proxy matcher |
| [`vercel.json`](../vercel.json) | The integration cron (every 5 minutes, D87) |
| [`src/components`](../src/components) | `ui/` design-system primitives ([DESIGN.md](DESIGN.md)); `shell/` tab bar, rail, header with global search; `domain/` record components and sheets |
| [`supabase/migrations`](../supabase/migrations) | Schema, RLS and RPCs (Supabase CLI timestamp names) |
| [`supabase/seed.sql`](../supabase/seed.sql) | Demo data and test fixtures (synthetic) |
| [`supabase/devstack`](../supabase/devstack) | `roles.sql`: platform roles for plain Postgres (never a migration) |
| [`scripts/devstack`](../scripts/devstack) | Docker-free Supabase: setup, start/stop, database reset/migrate/types, gateway, the mail catcher and its client (`mail-client.mjs`) |
| [`supabase/templates`](../supabase/templates) | Auth's email templates: sign-in codes, no links (D70) |
| [`scripts`](../scripts) | Contrast and icon generators |
| [`tests/unit`](../tests/unit), [`tests/db`](../tests/db), [`tests/e2e`](../tests/e2e), [`tests/fixtures`](../tests/fixtures) | The three harnesses and shared IDs, the API-surface allow-list and the public-site fixture |
| [`.github`](../.github) | CI workflows and the shared `prepare` action |
| [`public`](../public), [`brand`](../brand) | Logo, icons, service worker (`sw.js`); the logo source for the icons |
| [`docs`](.) | This documentation set; [README.md](../README.md) lists each document |
