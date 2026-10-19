# BICII Admin — Testing strategy

Commands: [ENGINEERING.md](ENGINEERING.md#commands); current results: [NOW.md](../NOW.md).

Maps SPEC.md §27 onto concrete harnesses. A feature is done when the tests in
its row of PLAN.md pass in CI.

## Harnesses

| Layer | Tool | Runs against | Command |
|---|---|---|---|
| Unit (pure TS) | Vitest | nothing | `npm run test:unit` |
| Database (invariants, RLS, RPCs) | Vitest + `pg` | Postgres with migrations + seed | `npm run test:db` |
| End-to-end | Playwright | `next start` + the devstack (or `supabase start` with `E2E_EXTERNAL_STACK=1`) | `npm run test:e2e` |
| Static | `next typegen` + `tsc --noEmit`, `eslint`, `prettier --check` | — | `npm run check` |
| Generated DB types | `supabase gen types` from a throwaway database built from the migrations, then `git diff --exit-code -- src/lib/database.types.ts` | Postgres (devstack cache) | `npm run check:types` |

`npm test` = unit + db. CI runs `check` (with `check:types`), `test`, then
`build` (`ci.yml`); E2E runs on a nightly schedule and on PRs labelled
`e2e` (`e2e.yml`).

## Database test harness

The DB tests run against the real Supabase schemas without Docker. Any
Postgres 16 will do (the cloud agent container's, a CI service container, a
laptop's); the Supabase parts come from the devstack cache
(`npm run devstack:setup`, once per machine):

1. **Global setup** (`tests/db/global-setup.ts`) builds one template
   database per run with the same code as `npm run db:reset`
   (`scripts/devstack/database.mjs`):
   `supabase/devstack/roles.sql` (the platform roles and schemas hosted
   Supabase already has; never a migration) → Supabase Auth v2.178.0's own
   migrations (`auth migrate`: the real `auth.users`, `auth.identities`,
   `auth.uid()`, `auth.jwt()`) → Supabase Storage v1.79.31's own migrations
   (the real `storage` schema) → `supabase/migrations/*.sql` in filename
   order, each in a transaction, recorded in
   `supabase_migrations.schema_migrations` as the Supabase CLI does →
   `supabase/seed.sql`. About one second.
2. **Per file** (`tests/db/setup.ts`): a fresh database is cloned from the
   template (`create database … template …`) and dropped afterwards, so files
   are independent and concurrency tests can open several real connections
   (`openConnections(n)`) and commit.
3. **Per test**: the `as*` helpers run their body in a transaction that is
   rolled back unless the test passes `{ commit: true }`.

Files run one at a time (`fileParallelism: false`). Connection: the server
from `DATABASE_URL` (or `PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`), taken from
the shell environment (no `.env` file is loaded), default
`postgres:postgres@127.0.0.1:5432`; the user must be able to create
databases and roles.

Acting as a user in a test (`tests/db/harness.ts`):

```ts
await asUser(conn, { sub: AUTH_USER.mechanic1, role: 'authenticated' }, async (tx) => {
  // tx has `set local role authenticated` and
  // `select set_config('request.jwt.claims', '{"sub":"…","role":"authenticated"}', true)`
});
await asStaff(conn, STAFF.mechanic1, async (tx) => { … });  // looks up the auth user
await asAnon(conn, async (tx) => { … });
await asServiceRole(conn, async (tx) => { … });
await withClaims(conn, claims, async (tx) => { … });  // claims, but stay the owner: for private.* helpers
await actAs(tx, claims);  // switch identity inside an open transaction
```

The helpers do exactly what PostgREST does, so they work unchanged against a
real Supabase database: set `BICII_TEST_DATABASE_URL` to an already migrated
and seeded database (for example `supabase start`'s) and the harness uses it
directly instead of cloning; tests that commit or move sequences skip
themselves in that mode (`isolatedDatabase()`): the staff concurrency file,
the workshop files that create jobs (`work-orders`, `work-order-lines`,
`workshop-concurrency`; job numbers come from a sequence), and every
short-ID test that calls `nextval` or `setval` (sequence values
are consumed even inside a rolled-back transaction, and short IDs are never
reused, so they would burn IDs in a database you keep).

`tests/db/stack.smoke.test.ts` goes one step further when the devstack is
running (`npm run db:reset && npm run devstack:start`): it signs in through
the gateway with supabase-js as `admin@bicii.test` the way staff do (PLAN
D10, D70: `signInWithOtp` with `shouldCreateUser: false`, the code read
from the devstack's mail catcher with `scripts/devstack/mail-client.mjs`,
`verifyOtp` with type `email`), checks the email carries our subject ("Your
BICII sign-in code") and template, calls `rpc('my_staff_profile')`, and
round-trips an object through Storage with the service key. It also pins
the code rules Auth enforces: an unknown address with `shouldCreateUser:
false` gets 422 `otp_disabled` (the Admin will show it as sent, D70),
creates no `auth.users` row and receives no email; asked again while Auth's
per-address interval is held open (`recovery_sent_at` set ahead, as the
hosted 60 s would), an address with a login gets 429
`over_email_send_rate_limit` and an unknown one 422 `otp_disabled` again,
and `classifyCodeRequestError` makes "sent" of every one of them (D70); a
code works once (the second `verifyOtp` is 403 `otp_expired`); a newer
code voids the older one; and setting a password on a session aged past
24 h is refused with `reauthentication_needed` (secure password change,
PLAN D10).
Those cases use unique throwaway `.test` logins made with the admin API and
deleted after the file. Every other live test signs in with
`tests/db/stack.ts`: `otpClient(email)` gets the code from the service-role
admin API (`auth.admin.generateLink({ type: 'magiclink' })` returns
`properties.email_otp` and sends no email) and verifies it with
`verifyOtp`; `staffClient(who)` is `otpClient` for a seeded login and
`serviceClient()` is the service-role client.
`tests/db/staff-sessions.stack.test.ts` invites a uniquely named throwaway
staff login, signs it in and deactivates it (PLAN D71); staff rows are
history and are never deleted, so it stays, deactivated, until the next
`npm run db:reset`. `tests/db/sign-in-throttle.stack.test.ts` drives the
Admin's own sign-in limits (PLAN D72) through the app's module
(`countSignInAttempt` in `src/lib/admin/sign-in-throttle.ts`) and
PostgREST with the real limits: an email past its limit is refused from
any client while other emails and its verifications are not; a client
past its limit is refused for any email while other clients are not; a
staff email reaches its limit no later than an unknown one; the anon key
and a staff session get 42501, and the anon key in the service role's
place makes `checkSignInAttempt` answer "unavailable" with the cause the
login actions log (`rpc_error`, 42501, never the email). `tests/db/photo-moves.stack.test.ts` runs the app's own
photo domain code (`src/lib/domain/attachments.ts`, loaded with
`server-only` aliased to its empty module in the db project) as mechanic2
against real Storage: moves between buckets, deletes, refused moves and
failed cleanups (a client whose Storage `remove` fails), checked by
fetching public URLs with no key; it ages objects through the devstack's
database to stand in for the sweep's 10-minute grace.
`tests/db/shopify.stack.test.ts` (Phase 10 step 3) runs the Shopify service
layer (`src/lib/integrations/shopify`) against the RPCs through PostgREST
with a service-role client (`SERVICE_ROLE_KEY` from
`scripts/devstack/config.mjs`), the admin's staff client and a fresh fake
Shopify per test seeded from what the sync rows say was last pushed. It
writes to `bicii_dev`, which persists between runs, so it asserts deltas,
uses unique order and webhook ids per run, runs only its own two
products' jobs by id (never `runDueJobs`, which would run every due job in
`bicii_dev`), and ends by unpublishing both products and restoring the
price and stock it changed. All of them use
`tests/db/stack.ts` and skip with a message when the gateway is not
reachable, unless `BICII_REQUIRE_STACK=1` (CI), where that fails the file.

Phase 1 helpers (`tests/db/customer-fixtures.ts`): `linkCustomerLogin`
gives a seeded customer an Auth login inside the test's transaction (no
customer has one in the seed), `customerClaims` acts as them, and
`putStorageObject` leaves the `storage.objects` row an upload would. Tests
that insert bikes consume `private.seq_short_id_b` and skip in
existing-database mode, like the short-ID tests.

Phase 3 helpers (`tests/db/workshop-fixtures.ts`, the shared workshop
fixture module that later phases extend; Phase 5's
`tests/db/reporting-fixtures.ts` builds on it): tests of the workshop
rules make their own records, so `makeCustomer`, `makeBike`,
`makeCustomerWithBike` and `makeService` insert as the owner inside the
test. The seed has workshop data too (nine jobs, categories, services: see
"Seed data" below), so a service or category a test creates needs a name
the seed does not use (active names are unique), and a count must be
scoped to the test's own job or customer. `createWorkOrder`, `setStatus`, `walkTo` (drives a received job to
any status through allowed moves), `addServiceLine`, `addManualLine`,
`voidLine` and `events` call the RPCs as whoever the transaction is;
`ownerMode` (`reset role`) returns to the owner mid-transaction and
`failsWith` / `tryAndUndo` run a call in a savepoint so one transaction can
check many refusals.

Phase 9 helpers (`tests/db/period-report-fixtures.ts`): `buildPeriodScenario`
builds, inside the test's transaction, the March 2025 week the period-report
tests assert (3 March 2025 is a Monday; Singapore time): jobs A–E through
Phase 5's `insertJob` (which takes an optional `leadMechanicId`, set through
a lead assignment at check-in), with their own services SV200, SV120, SV80
(cost 0.00) and a quantity product QP (50.00 / 30.00), a free 0.00 / 0.00
line, a voided line, a loss line, a cancelled job and a midnight completion;
a consigned bike received 20 February, sold as S1 on Tuesday (1,000.00 /
500.00 / 500.00 / 150.00) and settled 200.00 on Thursday, through the real
RPCs as the admin. `PERIOD_EXPECTED` holds the literal figures, worked out
by hand and never recomputed with the code under test. The scenario
consumes J-, B-, C-, P-, U- and S- sequence values, so those tests skip in
existing-database mode.

Phase 2 helpers (`tests/db/appointment-fixtures.ts`): booking tests set
the schedule they need as the owner inside their rolled-back transaction
(`standardSchedule`, `setSettings`, `setHours` replaces every weekly row
for the transaction, `addClosure`, `makeType` with a fresh name,
`insertAppointment` for any status without the booking checks), on a clear
Tuesday-Friday at least 21 days ahead (`futureDay`) unless the case is
about today (`currentSlot`: today's grid slot containing `now()`, under an
all-day custom-hours override), so the seeded settings, hours, types,
closures (within 14 days, never covering the seed day) and appointments
(at most 14 days ahead) never change a result; capacity on today's slot is set relative to
`unitsUsed`. The shared data fixtures are
`tests/fixtures/appointment-slot-cases.ts` (slot and booking-rule cases,
fixed 2031 dates) and `tests/fixtures/appointment-transitions.ts` (the
status machine); step 3's TypeScript mirror uses both. Check-in tests
(`appointment-check-in.test.ts`) build their own customer, bike, type and
appointment as the owner and call `check_in_appointment` as staff. One
customer login is seeded (`CUSTOMER_LOGIN.chloe`, Chloe Lim, no usable
password since the email sign-in integration): read-only customer checks may act as her
(`customerClaims(CUSTOMER_LOGIN.chloe.authUserId)`); tests that change a
customer's login or bookings link a fresh login to a fresh customer
(`linkCustomerLogin`), never to `CUSTOMER.chloe`.

Catalogue meta tests (`tests/db/meta.test.ts`) cover every future migration
automatically: RLS enabled on every `public` table, no function in
`public`/`private` executable by PUBLIC, security-definer functions pin
`search_path`, no money-like column is `real`/`double precision`, every
numeric table column uses a domain and every numeric domain rejects `NaN`
(`money_amount`, `rate_fraction`, `line_quantity`, `label_mm`).

**API surface** (the RLS-matrix fixture, PLAN §5): hosted Supabase grants
ALL on every new `public` table, sequence and function to `anon`,
`authenticated` and `service_role`, and the devstack's `roles.sql`
recreates those default privileges, so a migration that forgets its
explicit revoke is exposed locally exactly as it would be in production.
The meta tests then compare, for `anon` and for `authenticated`, every
function they can EXECUTE and every privilege they hold on a table, view,
materialized view or sequence in `public`/`reporting` with the allow-lists
in `tests/fixtures/api-surface.ts` (anon: empty in Phase 0; from Phase 4
SELECT on `reporting.public_items` only), and require every view an API
role can read to be `security_invoker` unless it is listed as a definer
view. anon may execute exactly `ANON_PRIVATE_FUNCTIONS` in `private`
(`private.selling_price`, which `public_items` calls as the caller) and
holds USAGE on `reporting` but never on `private`; PUBLIC holds nothing on
either schema. The service role may execute exactly
`SERVICE_ROLE_FUNCTIONS` in `public` and nothing in `private`. Phase 14
added four service-role RPCs, `record_stripe_event` and
`record_stripe_read` (step 1), `prepare_deposit_checkout(text)` and
`record_deposit_checkout(uuid, uuid, jsonb)` (step 2); to
`AUTHENTICATED_FUNCTIONS` `set_indent_deposit_percent(integer)` and
`order_part_requests` with its fifth argument, `override_reason`
(replacing the four-argument one); and to `AUTHENTICATED_RELATIONS` SELECT
on the three security-invoker views `quote_deposits`, `payment_issues`
and `work_order_payment_totals`, and on the tables `payments`,
`payment_refunds` and `stripe_events`. anon is unchanged. The owner-only
purges (`purge_integration_events`, `purge_stripe_events`),
`private.integration_exceptions` and every private function Phase 14
added (the apply paths, guards, helpers and `quotes_deposit_snapshot`)
are executable by no API role (meta.test.ts, which finds them by name).
D149a added `fit_part_bought_outside(uuid, uuid, money_amount, uuid, text)`
to `AUTHENTICATED_FUNCTIONS`; its two trigger functions
(`work_orders_require_settled_requests`, `work_orders_withdraw_open_quote`)
are executable by no API role. Phase 14 step 3 (PR A) added to
`ANON_FUNCTIONS` `balance_by_token(text)`; to `AUTHENTICATED_FUNCTIONS`
`balance_by_token`, `send_balance_link`, `record_counter_payment`,
`void_counter_payment`, `report_payment_summary`, `report_payment_items`
and `report_payments_held`; to `SERVICE_ROLE_FUNCTIONS`
`prepare_balance_checkout(text)` and
`record_balance_checkout(uuid, uuid, bigint, jsonb)`; and to
`AUTHENTICATED_RELATIONS` SELECT on `balance_links`, `counter_payments`
and `counter_payment_voids`. `reporting.payment_movements` has no grant.
Its private functions (the counter-payment guard and fingerprint, the
balance-link guard, found by name with `counter_payment` and
`balance_link` in the meta test's pattern, and the trigger function
`work_orders_withdraw_balance_link`, listed by name) are executable by no
API role. A new RPC or table
means a new line in that fixture, in the same PR.

### Devstack commands

The devstack and database commands (`devstack:setup`, `devstack:start` /
`stop` / `status`, `devstack:env`, `db:reset`, `db:migrate`, `db:types`)
are described in one place:
[ENGINEERING.md "Commands"](ENGINEERING.md#commands).

### The devstack mail catcher

Staff sign in with emailed codes (PLAN D10, D70), so the devstack runs a
mail catcher, `scripts/devstack/mailcatcher.mjs` (dependency-free; Phase 11
reuses it for customer codes). It listens on 127.0.0.1 only: SMTP on
`BICII_SMTP_PORT` (2525) and a JSON API on `BICII_MAIL_HTTP_PORT` (8025).
Supabase Auth sends to it (`GOTRUE_SMTP_*` in `scripts/devstack/services.mjs`:
no credentials, no TLS, sender `no-reply@bicii.test`) and fetches its email
templates from it (`GOTRUE_MAILER_TEMPLATES_*` point at
`/templates/<name>.html`, served from `supabase/templates`). The devstack's
Auth also gets 6-digit codes valid for 600 s (`GOTRUE_MAILER_OTP_*`), a 1 s
per-address interval and local-only rate limits of 100000
(`GOTRUE_RATE_LIMIT_EMAIL_SENT`, `_VERIFY`, `_OTP`, `_TOKEN_REFRESH`) so
E2E can sign in hundreds of times. Messages are kept in `.devstack/mail/`
as `<id>.json` (parsed) and `<id>.eml` (raw); ids keep increasing across
restarts and the newest 1000 are kept.

| Request | Answer |
|---|---|
| `GET /health` | `{ok:true}` |
| `GET /messages?to=&after=&limit=` | `{messages:[…]}`, newest first: id, receivedAt, envelopeFrom, envelopeTo, from, to, subject, code |
| `GET /messages/latest?to=&after=` | the newest full message (adds text and html) to that recipient with id > after, else 404 `{error:'not_found'}` |
| `GET /messages/:id`, `GET /messages/:id/raw` | one message as JSON, or its raw `.eml` |
| `DELETE /messages[?to=]` | `{deleted:n}` |
| `GET /templates/<name>.html` | a template file; only `^[a-z0-9_-]+\.html$`, anything else 404 |

`to` matches the envelope recipients (RCPT TO), case-insensitively. `code`
is the first standalone run of 6–10 digits in the text part, else in the
tag-stripped HTML (`scripts/devstack/mail-parse.mjs`), so templates must
not contain another run of six or more digits. By hand:
`curl "http://127.0.0.1:${BICII_MAIL_HTTP_PORT:-8025}/messages/latest?to=admin@bicii.test"`.

Tests read codes with `scripts/devstack/mail-client.mjs`: take
`mailCursor(email)` before asking for a code, then
`waitForCode({ to: email, after: cursor })` (or `waitForMessage` for the
whole message; both poll every 200 ms for up to 15 s and name the address
and mail URL when nothing arrives); `clearMail(to?)` deletes. The base URL
is `BICII_MAIL_URL`, else the devstack's. With `supabase start`
(`E2E_EXTERNAL_STACK=1`) set `BICII_MAIL_KIND=mailpit`: the client then
reads Mailpit on :54324 through its documented API (`GET
/api/v1/search?query=to:"<addr>"`, `GET /api/v1/message/<ID>`). That
adapter is written from Mailpit's documentation and has **not been run**
(no Docker here).

Verification of the mail catcher step (2026-10-05, OTP phase step 1, in
a second worktree with the ports moved by `BICII_*_PORT`):

- `npm run devstack:stop && npm run devstack:start`: mail on its HTTP and
  SMTP ports, then Auth, PostgREST, Storage, gateway; `devstack:status`
  all ok: **pass**.
- A code requested by hand (`POST /auth/v1/otp`, `create_user: false`)
  arrived with subject "Your BICII sign-in code", our template and a
  6-digit code; an unknown address got 422 `otp_disabled`: **pass**.
- 40 rapid code requests for 40 new throwaway addresses: all 200, 40
  emails, no 429: **pass**.
- `npm run check`: **pass**.
- `BICII_REQUIRE_STACK=1 npm test` with the devstack up: 71 files, 942
  tests: **pass**.
- `npm run test:e2e -- tests/e2e/auth.spec.ts` (global setup signs in with
  a generated code and needs the mail catcher; the password form is still
  the app's sign-in until the next step): 24 tests: **pass**.
- `BICII_MAIL_KIND=mailpit` with `supabase start`: **not run** (no
  Docker).

Verification of the code sign-in step (2026-10-05, OTP phase step 2: the
`/login` form asks for an emailed code, invites create no password, the
password paths are gone), same worktree and ports:

- Established on the devstack (Auth 2.178) before writing the specs: a
  login made by `auth.admin.createUser` without a password stores the
  bcrypt hash of a random secret (`$2a$10$…`, not `''` or NULL; the seed
  now writes the same shape); a wrong code leaves the real one usable; an
  email code's expiry is read from `auth.users.recovery_sent_at` (ageing
  `auth.one_time_tokens.created_at` alone left the code valid); an unknown
  email gets 422 `otp_disabled`.
- `npm run check`: **pass**.
- `BICII_REQUIRE_STACK=1 npm test` with the devstack up: 71 files, 951
  tests: **pass**.
- `npm run build`: **pass**.
- `npm run test:e2e` (phone and tablet, every spec signing in with codes
  from the mail catcher): 98 tests: **pass**.
- `BICII_MAIL_KIND=mailpit` with `supabase start`: **not run** (no
  Docker).

Verification of the deactivation step (2026-10-05, OTP phase step 3:
deactivation deletes the person's Auth sessions, PLAN D71; final sweep of
the phase), same worktree and ports:

- Established on the devstack before writing the specs: after the
  trigger deletes the sessions, Auth 2.178 answers the old access token
  with 403 `session_not_found` (supabase-js turns it into
  `AuthSessionMissingError`) and the refresh token with
  `refresh_token_not_found`; PostgREST still accepts the unexpired token
  on its own. `staff-sessions.test.ts` fails (3 of its tests) with the
  migration removed.
- `npm run devstack:status` lists mail, auth, rest, storage and gateway,
  all ok: **pass**.
- The final sweep's grep (password, temporary, `SEED_PASSWORD`,
  `signInWithPassword`, `grant_type=password`, "Change password",
  "one-time password" over `src/`, `tests/`, `scripts/`, `supabase/`,
  `docs/`, README and `.github/`) finds only generic secret handling,
  `PGPASSWORD`/`POSTGRES_PASSWORD`, the `roles.sql` service-role
  passwords, the invite's "No password needed." copy, Auth's own password
  settings in `config.toml` and the devstack (commented: unused) and
  history in these notes: **pass**.
- `npm run check`: **pass**.
- `BICII_REQUIRE_STACK=1 npm test` with the devstack up: 73 files, 960
  tests: **pass**.
- `npm run build`: **pass**.
- `npm run test:e2e` (phone and tablet): 98 tests: **pass**.
- `BICII_MAIL_KIND=mailpit` with `supabase start`: **not run** (no
  Docker).

Verification of the review fixes (2026-10-05, OTP phase: per-address
limit shown as sent, D70; the Admin's own sign-in limits, D72; the
inactive-session 403 tests, D71; secure password change; devstack
restarts on a changed configuration), same worktree and ports:

- Established on the devstack before the fix (`POST /auth/v1/otp`,
  `create_user: false`, twice in a row): an address with a login got 200
  then 429 `over_email_send_rate_limit`, an unknown one 422 `otp_disabled`
  both times.
- `npm run devstack:start` after the change restarted every service whose
  recorded configuration differed (here all five, none had a record yet);
  a second run left all five running; with `rest` and `auth` marked stale
  it restarted them and the services after them, gateway first: **pass**.
  (Before stopping the clients first, a restarted PostgREST failed to bind
  its port: TIME_WAIT from the gateway's connections.)
- Mutation checks: with `guard()`'s `!staff.active` removed,
  `session-guard.test.ts` (2 tests) and the E2E "hosted window" test
  fail; with the per-address code classified as before, the E2E "asking
  twice in a row" test fails: **pass** (both restored).
- `npm run check`: **pass**. `npm run check:types` (fresh database):
  **pass**.
- `BICII_REQUIRE_STACK=1 npm test` with the devstack up: 77 files, 986
  tests: **pass**.
- `npm run build`: **pass**.
- `npm run test:e2e` (phone and tablet): 102 tests: **pass**.
- Hosted steps (password reset SQL, "Secure password change", Auth's
  per-IP limits): **not run** (no hosted project; owner's step).

Verification of the integration with main and purchasing (2026-10-06,
`origin/feat/p7-purchasing` merged into `feat/auth-email-otp`; second
worktree, database `bicii_dev_wt`, `E2E_PORT=3200`):

- Before the gates: main's `tests/e2e/api.ts` `signInApi(email,
  password)` (Auth's password grant, used by `appointments.spec.ts` and
  `appointment-settings.spec.ts` for the admin and the seeded customer)
  became `signInApi(email)` with a generated code; Chloe Lim's seeded
  login got a random secret's hash. A grep over `src/`, `tests/`,
  `scripts/` and `supabase/` for `SEED_PASSWORD`, `signInWithPassword`,
  `grant_type=password` and `bicii-dev-password` finds only
  `seed-logins.test.ts`, which asserts that the former password matches
  no seeded login: **pass**.
- `npm run db:reset`: 44 migrations, `44|20261005006000`, seed applied;
  `npm run db:types`: no diff: **pass**.
- `npm run check`: **pass**. `npm run check:types` (fresh database):
  **pass**.
- `BICII_REQUIRE_STACK=1 npm test` with the devstack up: 111 files, 1585
  tests (unit 56 / 686, database 55 / 899): **pass**.
- `npm run build`: **pass**.
- `npm run test:e2e` (phone and tablet, every spec signing in with codes):
  152 passed in 18.2 min, no failures, flaky or skipped: **pass** (run
  before `seed-logins.test.ts` and the documentation were added; neither
  touches the app or the specs).
- Docs link check: **pass** (counts in [NOW.md](../NOW.md)).
- After the integration review fixes (the sign-in throttle's logged
  `cause`, the stack test's wrong-key case, docs): `npm run check`
  **pass**, `npm run check:types` **pass** (no diff),
  `BICII_REQUIRE_STACK=1 npm test` 111 files / 1585 tests **pass**,
  `npm run build` **pass**, `npm run test:e2e` 152 passed in 15.7 min
  **pass** (the first run, while the other worktree's E2E suite shared the
  CPUs, had 151 passed and 1 failed: the phone run of
  `consignment.spec.ts` "a consigned bike is received…" timed out because
  the click on "Void… the charge" right after "Charge added" did not open
  the reason field; the rerun passed unchanged), docs link check **pass**.

Verification of the staff roles (2026-10-06, step 4 of 4, the integration
review, on `feat/staff-roles` in the second worktree, database
`bicii_dev_wt`, `E2E_PORT=3200`; one command at a time):

- Review: `record_sale_refund` in
  `20261006000200_staff_role_permissions.sql` diffed against
  `20261004003500_sales.sql`: only the guard and its comment differ; no
  `staff_role` literal `'staff'` remains in `supabase/`, `src/`, `tests/`
  or `scripts/` (the `'staff'` left are `appointment_source` /
  `cancelled_via` values, historic migrations and the legacy-label tests):
  **pass**.
- `npm run check`: **pass**. `npm run check:types`: **pass** (no diff).
- `BICII_REQUIRE_STACK=1 npm test` with the devstack up: 113 files, 1680
  tests (unit 57 / 737, database 56 / 943): **pass**.
- `npm run build`: **pass**.
- `npm run test:e2e` (phone and tablet, with the new 375 px side-scroll
  checks in `roles.spec.ts`): 158 passed in 16.8 min, no failures, flaky
  or skipped: **pass**.
- Docs link check: 37 files / 690 links / 0 problems: **pass**.

## What is tested where

### Unit (SPEC §27.1)

- `money.ts`: formatting and display arithmetic in decimals; no float paths.
- Cult Commons formula reference implementation in TS (used only for display
  previews) agrees with a fixture table that is also run through the database
  generated columns: services (cost 0), parts, consignment, combined job,
  negative yield (loss, share 0), and rate change over time.
- Appointment slot generation from shop hours + closures + capacity (pure
  function mirrored from the SQL, tested against the same fixtures).
- Publication state machine transitions.
- Permission resolution (`auth-helpers.test.ts`; D91: `admin` implies
  all, `manager` all but `manage_staff`, `mechanic` none, exceptions on top;
  inactive staff has none) and the refund role check (`consignment.test.ts`;
  D94: an active admin or manager; a mechanic holding every permission as
  exceptions cannot).
- The Staff screens' role wording (`staff-roles-screens.test.ts`, D90-D93):
  `describeStaffEvent` (src/lib/staff-events.ts) reads "Added as <Role>",
  "Role changed from <From> to <To>" (the pre-D90 payload value "staff"
  reads Mechanic) and "Extra access: <Permission> granted/removed";
  `roleWithArticle` ("an Admin", "a Manager"); and `roleChangeSummary`
  (src/lib/auth/role-change.ts): which exceptions a new role includes and
  so removes (D92), which stay, and what is lost (permissions, Record
  refunds, Admin settings), for mechanic to manager, manager to mechanic,
  manager to admin and admin to manager.
- Staff sign-in codes (PLAN D10, D70): `otp.test.ts` (6 digits, 10
  minutes, 60 s cooldown; `normaliseCode` drops spaces and hyphens from a
  pasted code and refuses anything else; `resendSecondsLeft` rounds up and
  never exceeds the cooldown; the countdown text) and
  `sign-in-errors.test.ts` (asking for a code: Auth's per-address
  `over_email_send_rate_limit` counts as sent, exactly like 422
  `otp_disabled` for an unknown email and every other 4xx; per-IP
  `over_request_rate_limit`, a bare 429 and outages say so; verifying:
  every other 4xx is one invalid-code failure; the agreed messages).
- The Admin's own sign-in limits (PLAN D72, `sign-in-limits.test.ts`):
  the client address (first `x-forwarded-for` entry, else `x-real-ip`;
  IPv6 per /64, IPv4-mapped as IPv4, ports dropped, anything else null),
  buckets per client and per email holding SHA-256 digests (email
  lower-cased; no address in clear; clients without an address share one
  bucket), requests and verifications apart, the multiplier, and "over the
  limit" only past it. `env.test.ts`: `SIGN_IN_LIMIT_MULTIPLIER` defaults
  to 1 and takes whole numbers 1-100000.
- The staff guard (PLAN D71, `session-guard.test.ts`, with Next's
  `forbidden`/`redirect` and the Supabase client mocked): `authorizeStaff`,
  `requireStaff` and `requireAdmin` answer 403 for an inactive person
  whose session still verifies, even with no permission required and even
  for an inactive admin; a login with no staff row is 403, a signed-out
  caller goes to `/login`, active staff pass.
- Label rendering (Phase 8 step 2, below): the QR decodes to exactly the
  job's database payload.
- Shopify payload mapping (variant → product; unmapped → structured error):
  the mapping runs in the database, so it is proven by
  `tests/db/shopify-webhooks.test.ts` ("Unmapped variants go to the retry
  queue and nothing is partial", "Online prices equal Shopify's totals
  exactly"); the payload fixtures themselves (shapes, refund transactions
  summing to the amount, HMAC signing) by `tests/unit/shopify-fixtures.test.ts`
  (Phase 10 step 1).
- Short ID formatting and scanner URL parsing.
- Phase 1 (M1.2): photo downscale sizing (`fitWithin`: longest edge 2048,
  never upscaled, never 0px) and photo type detection by MIME type or
  extension (`images.test.ts`); list search params (`readQuery`,
  `readFlag`, `withParam`); customer naming (mirror of
  `private.customer_label`), `tel:`/`mailto:` links; search grouping and
  bike naming; recent searches in `localStorage` (dedupe, cap, malformed
  data, storage that throws); photo bucket/path/visibility rules incl.
  PLAN D13 (`attachments.test.ts`); client UUIDs without
  `crypto.randomUUID`; the upload-progress fetch (`upload-progress.test.ts`,
  fake XHR); `SegmentedControl` disabled segments and the toast action.
- Phase 3 (M1.3): the status machine mirror (`workshop.test.ts`:
  `transitionRule`, open/closed statuses, D20 overdue at exactly 7 × 24 h);
  Cult Commons previews (`cult-commons.test.ts`) over the shared fixture
  table `tests/fixtures/cult-commons.ts` (SPEC §10 examples, loss, half-up
  and per-line rounding, another rate, the D1 job); every P0001 code, and
  every named check and unique index in `supabase/migrations`, mapped in
  `db-errors.ts` (`db-errors.test.ts` reads the migrations), a check
  re-raised without its row still mapped by constraint, and 22003. Step 3:
  status labels, tones, board groups (every status in exactly one),
  `allowedTransitions` equal to `transitionRule` with reopen/cancel kinds,
  `primaryActions` only ever allowed no-reason moves (`workshop.test.ts`);
  `describeEvent` for every `work_order_event_type`
  (`workshop-timeline.test.ts`); the intake draft (de)serialiser and its
  guarded storage, and a restored draft pruned of archived services and
  inactive staff with a sentence saying so (`intake-draft.test.ts`); job
  photos never public, D19
  (`attachments.test.ts`); `CustomerSheet` / `BikeSheet` hand a new record
  to `onCreated` instead of navigating, and navigate as before without it
  (`record-sheets.test.tsx`, actions mocked). Review fixes: the status
  row disabled for 400 ms after each status change, Collected confirmed in
  a second step (job and customer named, focus on Back, confirm armed after
  400 ms), the Change status sheet with nothing pre-selected and its submit
  hidden while a cancel reason is open, "Keep job" beside "Cancel job"
  (`job-status-actions.test.tsx`, action mocked); the timeline saying when
  earlier events were left out (`job-timeline.test.tsx`); decimal
  quantities and fraction-keeping steppers (`number-input.test.tsx`);
  `ChipRadioGroup`'s single Tab stop and Arrow / Home / End
  (`chip.test.tsx`).
  Step 4: the board's filters from the URL (`workshop.test.ts`: defaults,
  every filter read, unknown views, groups, statuses, dates, ages and limits
  dropped, job numbers however typed, `boardQuery` round-trips and leaves
  defaults out), the Singapore check-in presets and the Over 3 days /
  Overdue windows (`checkedInSince`, `checkedInBefore`, the overdue window
  agreeing with `isOverdue`),
  `groupBoardJobs` and `visibleGroups`; Cult Commons rates typed as
  percentages (`cult-commons.test.ts`: `percentToRate` exact to 4 dp and
  refusing anything else, `formatRate`, `classifyRates` current / scheduled /
  past / cancelled as `private.cult_commons_rate_at` reads them);
  `shopDayStart`, `fromShopLocal`, `toShopLocal` (`dates.test.ts`); jobs in
  search (`search.test.ts`: an exact J- number puts Jobs first, `/jobs/{id}`).
- Phase 4 (M1.4) app: the stock display helpers (`inventory.test.ts`:
  `stockTone` danger at 0 or with a location below zero, waiting at the
  reorder point; `stockLabel` and `signedQuantity` with a real minus sign;
  unit status and publication labels and tones; `movementLabel` incl.
  transfer in/out and "Returned from job"; the movement filters;
  `defaultLocation` = active, sort order, then name, like
  `add_inventory_line`; `adjustmentPreview`; the D23 `overdrawWarning`);
  the action schemas and history wording (`inventory-forms.test.ts`:
  part quantities 1..999, adjustments never 0 and within ±100,000,
  Damaged only removing, a cost only on stock added, money parsed to
  fixed-point strings, required and capped reasons, transfers between two
  locations, blank optional fields to null; product and unit events read
  without ever a cost, "Sold when J-… was completed" / "Back on hold: J-…
  was reopened"; the D25 reopen note); products and units in search
  (`search.test.ts`: `/products/{id}`, `/units/{id}`, an exact SKU puts
  Products first); stock photos offer Internal and Public only
  (`attachments.test.ts`); the Inventory tab active on `/products` and
  `/units` (`auth-helpers.test.ts`); stock events in the timeline
  (`workshop-timeline.test.ts`: "Used 2 × Road inner tube (P-000003) from
  Shop floor", "Returned … to Shop floor", no cost). No product or unit
  subtitle is rebuilt in TypeScript, so `display-parity.test.ts` is
  unchanged.
- Phase 4 Step 4: `hrefForRecord` (`ids.test.ts`: B/J/P/U to their pages,
  C, PO and S null until Phases 6 and 7, every kind covered);
  `interpretScan` (`scan.test.ts`: bare IDs in any case, the public QR URL
  of each accepted base, the Admin's own /q URL, other hosts and paths,
  `http` against an `https` base, javascript:, data:, file: and Wi-Fi
  codes, empty input, all foreign; `truncateScan`); the publication card's
  buttons (`inventory.test.ts`: `publicationActions` names every manual
  move, a sold product offers only Archive listing and nothing offers
  Sold, a unique product without an available unit has no Publish;
  `publicationChecklist`, `missingRequirements`,
  `publicAvailabilityLabel`); the header jump (`search.test.ts`:
  `shortIdJump` opens an exact short ID in any case through /q, anything
  else goes to the results); the camera states (`camera.test.ts`:
  getUserMedia errors to denied / insecure / unsupported / failed, Phase
  0's messages kept).

- Phase 5 (M1.5) app: shop days for people (`dates.test.ts`: today
  flips at 16:00:00Z, `shopDayToDate` is noon Singapore time and reads back
  as the same day in any zone, `formatShopDay` "Sat, 3 Oct 2026",
  `formatShopDayLong`, `formatShopDayShort`; `parseShopDay` and
  `shiftShopDay` from step 2, plus years 0001-0099 read as themselves,
  `shiftShopDay` across the 0100/0099 boundary and refusing a result it
  could not parse back, and `EARLIEST_SHOP_DAY`); the Today DTO and wording (`reports.test.ts`:
  `toTodayDashboard` for every permission combination: no money without
  View financial reports, money without costs for it alone, costs never
  shown when the flags say hidden, no snapshot on a past day, the Phase 2/6
  placeholders null until tracked and their values once filled, losses and
  cost-pending counts carried; the loss and provisional notes
  with a real minus sign; `formatRateRange` "30%" / "25–30%";
  `exceptionCopy` for every D34 kind (overdue in the danger tone, as
  everywhere else), the overdue sentence from `OVERDUE_AFTER_DAYS`, an
  unknown kind rendered generically; `exceptionKeys` unique for a product
  below zero at two locations; `exceptionsShownNote`;
  `exceptionHref` (a line opens its job through `/q`); `weekStrip` exactly
  seven days oldest first with quiet and missing days; `TILE_LINKS` naming
  only `BOARD_GROUPS` ids and parsing back through `parseBoardFilters`;
  `groupEntries`, `documentHref`); the job yield panel
  (`totals-summary.test.tsx`: sale only without view_costs even if a report
  were passed, Phase 3's summary without a report, the rate range over the
  shared rate, the loss note, "Counted in reports on Sat, 3 Oct 2026
  (completed)", "once the job is completed" and, on a cancelled job, "Not
  counted in reports (cancelled)"); Today's components
  (`today-components.test.tsx`: StatTile's placeholder reads exactly
  `NOT_TRACKED`; MoneyTile keeps the amount on one line with the code
  free to wrap, sized by `moneySizeClass` smaller for longer amounts and
  never below 1rem; ExceptionList renders two negative_stock rows for one
  product without a duplicate key and says "Showing the N most urgent of
  M" only when capped; AdjustmentList puts significant ones first, lists
  `ADJUSTMENT_ROWS` and puts the rest behind "Show N more"). E2E
  (`today.spec.ts`) also checks that every visible box in each Money tile
  stays inside the tile's padding at the project's size, 1024 × 1366 and
  390 × 844 (the page never scrolls sideways, so nothing else catches a
  figure running into the next card), that "Right now" says "Awaiting
  collection", and that a `?day=` before `EARLIEST_SHOP_DAY` shows today.
- OTP phase, the devstack mail catcher: `mail-parse.test.ts` (pure:
  folded headers, RFC 2047 B and Q words, quoted-printable with soft
  breaks, nested multipart with base64 and iso-8859-1 parts, attachments
  skipped, raw 8-bit utf-8, `htmlToText`, `extractCode` taking only
  standalone 6–10 digit runs from the text part, else the tag-stripped
  HTML, never a colour or a digit inside a tag) and `mailcatcher.test.ts`
  (node environment, ports 0, a temp directory: two messages on one raw
  SMTP connection, pipelined and split mid-terminator, with a dot-stuffed
  line and mixed-case recipients; EHLO without STARTTLS, AUTH PLAIN and
  LOGIN, 503 / 502 / 252 replies, 552 above 10 MB with the connection kept;
  `/messages/latest` with and without `after`, `/messages`, `/raw`,
  `/templates` refusing traversal, ids continuing after a restart,
  `DELETE`, and `mail-client.mjs` cursors, `waitForCode` and its timeout
  error, `clearMail`).
- Phase 2 (appointments, step 3): the slot mirror's parity with SQL
  (`appointment-slots.test.ts`): every `slotCases` case of
  `tests/fixtures/appointment-slot-cases.ts` through `availableSlots`
  gives exactly the slots and remaining units `tests/db/appointment-slots.test.ts`
  asserts for `private.available_slots_at`, and every `problemCases` row
  through `slotProblem` the same first code, with `SLOT_PROBLEM_ORDER`
  equal to the database's order (misaligned, outside hours, closed,
  capacity); plus `ignoreCapacity`, the reinstatement's `excludeId`, the
  D2 `capacityForWindow` extension point, `windowUsage` (used over
  capacity after a settings change, windows outside the hours that still
  hold units), `openStretches` and `scheduleWarning` (closure first, grid
  ignored, D38). Status actions (`appointment-status.test.ts`):
  `availableActions` for every status against `MARK_STATUS`, `CANCEL` and
  `CHECK_IN` of `tests/fixtures/appointment-transitions.ts`, no-show only
  once started, reinstate on the appointment's own Singapore day and not
  the next (D39), staff cancel after the start (D37), never "complete"
  (D36); `primaryAction`, labels, tones, `isLate` at 15 minutes and the
  history sentences ("Reinstated as arrived by …", "Cancelled online by
  the customer", "Job J-… opened", "Linked to job J-…"). Zone helpers
  (`appointment-time.test.ts`): Singapore wall times, '24:00' as the next
  midnight, London and New York across daylight saving, `weekStart`
  (Monday), HH:MM parsing including Postgres's seconds.
- Phase 2 (appointments, step 4): `workshop-timeline.test.ts` reads
  `appointment_linked` as "Opened from the appointment on Tue 6 Oct 10:00
  (Service drop-off)" when check-in created the job and "Linked to the
  appointment on …" otherwise, with `href` `/appointments/<id>` (none for a
  malformed id, and a plain sentence for an incomplete payload, D40);
  `job-timeline.test.tsx` renders an entry with an `href` as a link.
  `today-appointments.test.tsx`: `AppointmentsSection`'s three D41 tiles
  and their wording (the placeholder only for a null row) and
  `TodayArrivals` (rows link to `/appointments/<id>` named "10:30, Hafiz
  Rahman, Service drop-off, late", "Still expected" links to the day,
  "N more expected later", "No more arrivals expected today" with Book).
  `schedule.test.ts`: the weekday order, hours, capacity and cutoff
  sentences and closure labels; `shopSettingsSchema` (slot lengths that
  divide the day, every bound of the `shop_settings` checks, no time zone,
  D35, D38), `shopHoursSchema` (four ordered intervals up to 24:00,
  overlaps, an open day needs hours, a closed day keeps them),
  `closureSchema` (whole days drop typed times, part of ONE day, short-day
  times in order, day order, reason 1–200), `deleteClosureSchema` and
  `appointmentTypeSchema` (5–480 minutes in steps of 5, units, names).

- Phase 6 step 4 (sales screens): `sales.test.ts` (unit) runs `previewSale`
  over the shared Cult Commons fixture table ("Cult Commons formula
  reference implementation agrees with the fixture table") and the cases
  1000/500 → 500/150, 140/70 → 21.00, 70/35 → 10.50, 1000/620 → 380/114
  and a loss → 0.00 share, per-line summing and 0 as a known price and
  cost (D1, D24); `priceWarnings` (D53: below asking for everyone, below
  cost only with a cost, 0 read as a price); the status words; `saleRange`
  around Singapore midnight and the 7- and 30-day spans; `readSaleRange`;
  `refundableAmount` (D49); and the `saleSchema`, `restockSchema` and
  `refundSchema` inputs. `ids.test.ts`, `search.test.ts` and
  `reports.test.ts` cover `S-` → `/sales/[id]` and the sale search group;
  `reports.test.ts` reads Today's consignment figures as numbers (a
  missing value is 0); `auth-helpers.test.ts` lists Sales after
  Consignment in More.

- Phase 6 step 3 (consignment screens): `consignment.test.ts` mirrors D48
  and D49 (`canViewConsignmentMoney`, `canViewSaleCosts`, `canRecordRefund`
  for an admin, inactive staff, each single permission and a
  `view_financial_reports`-only member, which reveals neither); the status
  pills (a sold item says paid or not only when the outstanding is
  visible); `outstandingLabel` / `outstandingTone` ("$300.00 owed",
  "Settled", "Overpaid $40.50 (consignor owes the shop)", never credit,
  D46); the bearer labels and explanations (D4); the item history titles
  ("Sold on J-…", "Job J-… reopened", "Restocked", "Returned to consignor",
  "N returned to consignor"); `autoAllocate` (zero, partial, exact, an
  overpayment left unallocated, items with nothing or a negative
  outstanding skipped, ties by date keep their order, unsold last);
  `allocationProblems` (sum mismatch named, override needs a reason, a
  negative outstanding caps at 0, zero and malformed amounts refused,
  D47); `paidAtFromDate` (null for today, noon Singapore otherwise, around
  Singapore midnight and month ends). `consignment-forms.test.ts`: an
  agreed amount of 0 is accepted (D24) and a missing one refused; a
  consignor or a new one is required; a single item is one at a time and
  only it may link a bike (D51); a charge needs an explicit bearer and an
  amount above 0 (D4); returns need a reason; settlements need positive
  allocations and keep an override reason. `attachments.test.ts`:
  `consignment_item` holds photos and offers Internal with Customer and
  Public blocked by D52's sentence. `ids.test.ts` / `search.test.ts`: `C-`
  opens `/consignment/items/{id}`; the `consignor` and `consignment_item`
  search kinds, labels and links (sales are not a search kind until their
  page exists). `segmented-control.test.tsx`: `value={null}` checks
  nothing, submits nothing and keeps one Tab stop on the first enabled
  segment.
- Period reports (Phase 9 step 2; D100–D105): `period-reports.test.ts`
  checks the vocabulary built from the generated enums and the cost-gated
  columns (D30); ISO Monday–Sunday weeks (a Sunday anchor included),
  month ends (29 February 2028), year boundaries, `shiftPeriod` by the
  first of the month (31 January → 1 February), `shiftRange`, the
  `autoGrain` thresholds (1 / 31 / 32 / 184 / 185 days), the range and
  bucket labels, `parseReportParams` defaults and fallbacks for every
  invalid value, custom ranges refused with `BUSINESS_ERRORS`'
  `report_range_invalid` / `report_range_too_long` (731 days pass, 732
  do not), a today taken at 23:30 UTC being the next Singapore day,
  `reportHref` keeping parameters but dropping cursors, and the breakdown
  row links. `csv.test.ts`: BOM, CRLF, RFC 4180 quoting, nulls as empty
  fields, the formula-injection quote on text cells only (a negative
  money cell stays `-50.00`), shop-local datetimes, unicode names.
  `report-exports.test.ts`: the export kind table (every financial kind
  needs View financial reports, `mechanics` any staff, `manage_purchasing`
  alone never opens a financial export, D60), cost-gated columns dropped
  without View costs, the TOTAL row written from the summary, the file
  name and link.
- Exceptions and reconciliation (Phase 9 step 4; D106–D108):
  `reconciliation.test.ts` reads `20261006001200_stock_reconciliation.sql`
  and proves `UNIT_ISSUE_CODES` and `STOCK_ISSUE_CODES` are exactly the
  codes of its two `… end::text as issue` expressions, in order, that
  `unsettled_consignment` is the exceptions view's own issue, that every
  code has a sentence (and no other key does), that every disposition
  the view derives has a label, and covers the reconciliation URL
  (`all=1`, a valid `product` only), the exception sections' order and
  grouping (unknown kinds under "Other"), the counts' total, the capped
  note and the threshold sentence. `exception-kinds.test.ts`: a pill
  label for every kind the view emits (Phase 5's five and Phase 9's
  three; integration_failed "Shopify needs attention", Phase 10's
  wording), an unknown kind still renders, the impossible-state and
  unsettled-consignment sentences (the database's amount, never $0.00
  when it is NULL), and `exceptionHref` for `consignment_item` and `sale`
  (and, since Shopify and reporting met on `main`, the Shopify queue on the job for `integration_job`, R-058). `report-exports.test.ts` adds the
  snapshot kinds (`exceptions`, `stock`, `units` for any staff, no cost
  column, the brief's exception columns, a formula-like detail quoted)
  and the snapshot file name. `today-components.test.tsx`: Today's
  `ExceptionList` renders a Phase 5 row with identical markup with and
  without `moreHref`, the capped note links to `/reports/exceptions`, and
  the detailed row shows Critical, the age, no repeated detail and the
  secondary link after the row's link. `reports.test.ts`' later-kind case
  now uses `purchase_overdue` (identical to Phase 10's change), since
  `integration_failed` has a label.

Phase 8 step 2 (labels and the QR base; `tests/unit/printing/`, the
files that run sharp, ZXing or pdf-lib declare `// @vitest-environment
node`):
`schemas.test.ts`: every case of `tests/fixtures/label-layouts.ts` gets the
database's verdict and sentence from `labelLayoutProblem`;
`labelTemplateInputSchema` keeps the canonical field order, reports the
layout sentence and the table's size checks; `printerConfigSchema` is
strict; `labelContentSchema` keeps a `0.00` price and refuses `cost` and
`consignor` keys and a payload for another short ID.
`compose.test.ts`: the three built-in layouts × sample, short, 120-character
name, three identity lines, null price, price `0.00`, null SKU and
everything-long contents: QR and every text inside the label before
offsets, no text over the QR, the short ID always drawn, the price drawn
exactly when not null (`$0.00` for 0.00, D24 amended; nothing for null,
D58), only layout fields; the drop order and the 1.8 mm floor; offsets
carried. `label-svg.test.tsx`: `renderToStaticMarkup(<LabelSvg pxPerMm={12}>)`
rasterised with sharp and decoded with ZXing (`QRCodeReader` over
`HybridBinarizer`, no `jsqr` needed) equals the payload exactly for P-, U-
and B- payloads, a path base (`https://bicii.sg/shop/q/P-000123`) and with
an offset; the clip path wraps the translate group; unique clip ids; one QR
path; the accessible name. `browser-adapter.test.tsx`: a 10-copy
`LabelSheet` has 10 `[data-label]` boxes of 58 × 40 mm with the same
`data-qr-payload` and page breaks between them; above 20 copies the rest are
hidden on screen with "+ 5 more identical labels". `pdf-adapter.test.ts`:
the bytes start `%PDF-`; 10 pages of 58 × 40 mm (±0.01 pt), MediaBox =
CropBox; each page's link URI is the payload; title "Labels P-000011 × 10",
creator "BICII Admin", no producer; "Café 自転車 🚲" does not throw;
`getAdapter` refuses `network_raw` and `bluetooth`. `job.test.ts`: the
status machine for all 16 pairs of `tests/fixtures/print-transitions.ts`,
labels and tones, D56's caps, `labelUnavailable`'s four codes, the links.
`metrics.test.ts`: WinAnsi replacement, Courier widths, word wrap,
ellipsis and cutting an over-long word. `qr-base.test.ts`: `isValidQrBase`
agrees with every case of `tests/fixtures/qr-bases.ts` (and the payload
base), counts characters like Postgres; `mergeScanBases` order and
de-duplication. `qr-base-sources.test.ts`: `NEXT_PUBLIC_PUBLIC_SITE_URL`
appears in code (comments stripped) only in `src/lib/env.ts` and
`src/lib/qr.ts`. `print-job-controls.test.tsx` (jsdom): Print calls
`window.print` before the "rendered" action resolves, a rendered job is not
marked again and asks at once, Open PDF links the PDF in a new tab, failed
needs a reason (the 400 ms guard first), "Yes, all printed" is armed after
400 ms and then links back to the record and the history, a one-label job
asks "Did the label print correctly?" (never "all 1 label"); a printed job
(`PrintJobOutcome`) has no Print or Open PDF and links Print again to
`reprintPath`, disabled with the archived sentence for an archived record.

Phase 8 step 3 (the print flow and the settings screens):
`template-sheet.test.tsx` (jsdom, actions mocked): a new template opens
with no error, a preview and Add template enabled; a blocked save puts
"Give the template a name." on the Name field (`aria-invalid`, its
description) and focuses it; a size out of range marks only that field
once changed; the layout's "does not fit" sentence is live under the
preview even with no name, and disables Add template.
`printing/print-sheet.test.ts`: the remembered printer (missing, malformed,
blocked or full storage), `choosePrinter` / `chooseTemplate` precedence,
`priceChanged` (Decimal compare; 0 is a price, NULL differs from every
price), `describeLabelPrice` ("no price", `$0.00`), `initialQuantity`'s D56
remainder, `printButtonLabel`, `parsePrintParams`. `print-label.test.tsx`
(jsdom, actions and router mocked): Print label disabled with the reason as
its description; the sheet with the preview, the remembered printer, the
10-label chip and the created job opening the print view; a preset opens
once as "Print again" with the price-changed note, the 500 cap and its
remainder, and closing drops the parameters; printing from a preset
replaces the deep link's history entry (`router.replace`, no push) while a
manual print pushes; the printers are a radio list (never a sideways
segmented row), each described by its hint; a 0.00 price draws `$0.00` and
a NULL price no price line; the not-public hint and a refusal kept with
its field error; a conflict mints a new id and links the record's jobs.
`number-input.test.tsx` "NumberInput decimal stepper": 0.5 steps through 0
to negatives, from empty, rounding to the step and clamping to ±5, a whole
step, no buttons without `stepper`. `printing/schemas.test.ts`:
`publicSiteUrlInputSchema` (the QR address form) accepts exactly the
`tests/fixtures/qr-bases.ts` bases the database accepts, trims, and gives
the database's sentence.

Phase 10 step 3 (the Shopify service layer, `src/lib/integrations/shopify`;
every file `// @vitest-environment node`, `server-only` mocked):
`shopify-hmac.test.ts` (Shopify's signature of the exact bytes passes; one
flipped byte, another secret, an empty secret, a missing, empty, truncated,
mis-padded, hex or garbage header fail without throwing; multibyte UTF-8 is
verified on the bytes, its Latin-1 re-encoding fails); `shopify-ids.test.ts`
(the shared gid table in `tests/fixtures/shopify-gids.ts`, numbers, unknown
kinds, `parseShopifyGid`, handles, the fake ids equal the seed's
`SHOPIFY_GID`); `shopify-desired-state.test.ts` (the full productSet input
with an escaped description, vendor and SKU fallbacks, the price passed
through unchanged including 0, DRAFT and 0 when not effective,
`variant_only` with no input for an external product, the two problems
only while effectively online, the hash stable under key order and
changing with price, quantity, photos, API version, location, mode and
status); `shopify-graphql-admin.test.ts` (mocked fetch: the pinned version
in the URL, the token header, productSet by handle on create and by id on
update with one default variant, no price when there is none,
productVariantsBulkUpdate with the price only, `changeFromQuantity`
carried or null, a stale compare → `shopify_quantity_changed`, userErrors →
not retriable with Shopify's messages, 429 / THROTTLED / 5xx / network /
timeout retriable, an aborted slow call, 401 / 403 `shopify_auth_failed`,
bad shapes `shopify_bad_response`, the first active location);
`shopify-fake-admin.test.ts` (deterministic ids, idempotent by handle,
unknown product refused unless derivable, compare enforcement and
overwrite, one idempotency key applied once, `simulateCheckout`, a
Shopify-made product's other variant untouched, `failNext` once and by
kind, `calls`, `reset`); `shopify-sync.test.ts` (stubbed RPCs and the
fake: a new product → productSet by handle + inventory and the exact
`record_product_sync_result` arguments; the location asked only when none
is stored; an unchanged hash and an order in flight call Shopify zero
times; an external product → variantsBulkUpdate + inventorySetQuantities,
never productSet, the other variant untouched; unpublishing a priceless
external product sets only its quantity; a moved count defers first and
overwrites on the next attempt; retriable and userError failures; a unit
price conflict and no adapter; a record refusal after the push → not
retriable with the mapped message; crashes recorded, never thrown);
`shopify-webhook-handler.test.ts` (injected deps: 413 by header and by
size with nothing stored; 503 secret or shop domain unset stored as
rejected; 401 bad HMAC stored with capped allow-listed headers, size and
SHA-256 but no payload, and the response never echoes it; 401 another
shop, case-insensitive match passes; 400 missing headers and non-object
bodies; the 31st rejected delivery in a minute not stored but still 401;
the sliding window; 200 new → stored with its payload and triggered-at, one
scheduled task running the event's job then 5 due jobs; 200 duplicate →
no event run; record failure → 500, nothing scheduled; a failing
follow-up is logged); `shopify-cron-route.test.ts` (503 without
`CRON_SECRET`, 401 for missing, malformed or wrong bearers, 200 with the
summary and `no-store`, the route modules' `runtime`, `maxDuration` and
exports; "the runner's time budget": a job's worst case, four Shopify
calls at the timeout plus the overhead, fits inside `maxDuration` with
the margin, the routes' `maxDuration` literals equal
`RUNNER_MAX_DURATION_MS`, and with a fake clock no job is claimed once it
could not finish before the limit); `shopify-after-commit.test.ts`
(Publish online, Sync now and Retry whose follow-up run throws after the
committed write: ok with the committed state and "Saved. The sync runs
from the queue in a moment.", `refresh()` called, the error logged; a
failing write still fails); `shopify-fake-admin.test.ts` "which Shopify a
deployment talks to" (the live adapter is off in a Vercel Preview unless
`SHOPIFY_ALLOW_PREVIEW=true`); `proxy-matcher.test.ts` (Next's matcher test helper,
`unstable_doesMiddlewareMatch` in 16.3.8: the cron, webhook, health and
static paths are not matched, `/`, `/shopify`, `/products/x` and the
label PDF route are); `env.test.ts` (the Shopify and cron variables: the
shop domain format, fake with a token or in Vercel production refused,
live needs the domain and token, blank is unset).

Phase 10 step 4 (the Shopify screens): `shopify-screens.test.tsx` (every
product sync, job and event status has a word and the agreed tone:
synced done, pending progress, error danger, unpublished and not synced
neutral; needs attention danger, queued waiting, running progress, done
done, dismissed neutral; every rejection reason and every stored outcome
has its sentence, a refund says stock was not touched and keeps shipping
and the excess apart; the event row notes; "Attempt 3 of 8 · next try
2:05 pm" in Singapore time; `parseUnmappedLines` from an event's result,
custom lines included, malformed input empty; the URL filters; why
Publish online is disabled, never for switching it off; "3 min ago"; the
action schemas: a reason to dismiss, to link a variant (both gids of the
right kind) or a customer (a gid, never an email), and to change the
test-order switch, an https storefront with its trailing slash trimmed;
`JsonView` unwrapped and capped, then wrapped and Show all, Copy);
`reports.test.ts` (`integration_failed`: "Shopify needs attention", "Fix it
in the Shopify queue" in danger, `/shopify/queue?job=<id>`; every kind the
view emits has its own label; an unknown later kind still renders);
`today-components.test.tsx` (an `integration_failed` row in
`ExceptionList` with the order, the message and the queue link);
`auth-helpers.test.ts` (Shopify in More, after Sales; ten More
destinations for admins, nine for everyone else: Shopify is admin-only);
`shopify-screens.test.tsx` also covers the Online card's offline reason
(null when listed, a sold-out unique product included; archived,
inactive, customer-owned, not public) and the queue titles (a refund's
"Refund … of #1001" keeps no repeated kind); `shopify-queue-sheet.test.tsx`
(review fixes: the queue sheet re-rendered with refreshed rows shows the
new status, attempts and reason after a Retry that did not close the
job, closes when the job closes or leaves the view, and a refund's title
has no doubled "Refund"; JobPanel stays open after a Retry that did not
close the item, and Cancel in the link form returns focus to the line's
**Link to a BICII product** button; the Online card says why a product
with Publish online on is not listed, and "Listed on the Shopify store"
when it is).

Indent parts and quotes (Phase 13 step 2, D140–D147):
`tests/unit/indent.test.ts` covers the words and links the job page shares
with the coming quote page (`src/lib/indent.ts`): `whatsappNumber` adds 65
to an 8-digit Singapore number however it is spaced, keeps a number given
with `+` or `00`, and gives null for anything WhatsApp could not use (no
button then); `quoteMessage` greets by first name (or "Hi,"), names the
job and carries the link and validity ("1 day", "7 days"); `whatsappHref`
encodes the message for `wa.me`; every database `part_request_status` has
a label; `canFit` allows approved items and ordered parts only, and
`CANCELLABLE` never holds quoted or fitted items. After the owner's live
test (R-082, D149): `isUnfitted` is approved and ordered only (the
statuses `work_order_unfitted_requests` counts); `unfittedMemo` reads
"Approved, not on the bill yet: 1 item, $2.00. Fit it to bill it." (and
the plural) while open, "Approved but never fitted: $2.00 (not billed)."
after, nothing for none; `notFittedNote` has a sentence for exactly
completed, ready, collected and cancelled; `canCancelRequest` over every
job status and request status (anyone until collected or cancelled, then
only `canCancelClosed`, who may also cancel a quoted item there, never a
fitted one); `requestBadge` ("Not fitted" danger for approved and ordered,
"Not answered" neutral for quoted, on a job that is not open; the status
otherwise); `unansweredQuoteNote` has a sentence for exactly completed,
ready, collected and cancelled; `neverOrderedNote` names the location (or "the
default location") and, from D149a, points cost and purchasing holders at
Bought outside BICII and everyone else at who can; `COST_MISSING_NOTE`,
`COST_MISSING_BUY_NOTE`, `COST_MISSING_SWITCH_NOTE` and
`COST_SET_ON_RECEIPT_NOTE` their words. D149a–c: `canBuyOutside` over kind
× status × ordered or not × permission (an approved part never ordered,
for cost or purchasing holders only); `settleNeeded` over the 11 job
statuses × 7 request statuses mirrors the trigger (a move out of the open
statuses with an approved or ordered item); `settleTitle`,
`settleDescription` and `quoteWithdrawNote` (open and expired quotes only,
the item count's words). `tests/unit/job-status-actions.test.tsx`: Complete
with items reads **Complete…**, opens "Before completing J-…" and calls
nothing; **Complete job** is disabled until the page's list is empty, then
completes; Change status opens the same checklist; Cancel job offers only
**Cancel item…** (an ordered part's PO link for Manage purchasing) and its
own **Cancel job…** waits; a job completed before the guard lists its
items with "Reopen the job…" on Collected; after the checklist Collected…
still asks for the confirmation; the open-quote note; a stale
`work_order_has_unfitted_requests` toasts, refreshes and opens the
checklist; a stale Cancel job, from Change status or from the checklist's
own, says "Cancel the job's approved and ordered items before cancelling
it." and never "Fit or cancel"; the Change status note reaches the move
after the checklist (Complete job) and after the Collected confirmation,
and Back drops it. The Collected confirmation's sentence is the paid-online one
only (`collectedNotes` in `payments.test.ts`). `tests/unit/indent-sheets.test.tsx`
(the Fit sheet): **Bought outside BICII** only for `canBuyOutside`, the
cost prefilled from the expected cost with its hint and the total; never
for an ordered part, a service or without the permission; **Record and
fit** sends the cost and "Bought from"; a cost holder with no product cost
can still record; a stock fit refused with `part_cost_missing` switches to
Bought outside and focuses **Cost each**, or for an ordered part says to
receive it first; a stale `part_request_ordered` refreshes; after a void
(D160) a part bought outside BICII says it went back into stock, to fit
from stock, instead of the never-ordered note.
`inventory.test.ts` labels `outside_purchase` "Bought outside BICII" and
puts it in the Jobs filter; `workshop-timeline.test.ts` the `part_fitted`
detail and `part_request_unfitted` ("<part> back to approved: its line was
voided", or ordered; the bought-outside detail); `indent.test.ts` D160's
`unfitStatus`, `fittedIndentLines` (fitted items with a line only) and the
plain-words notes; `void-line-control.test.tsx` the void confirmation: a
part line's stock sentence alone, a fitted indent line's "Voiding puts
<part> back to approved: fit it again or cancel it before completing the
job." before it, "back to ordered" for an ordered item, and the toast
"<item> is back to ordered"; `sheet.test.tsx` that a sheet over another puts the outer sheet's
toast inset back when it closes.

The customer's quote page and quote emails (Phase 13 step 3, D142–D144):
`tests/unit/quote-page.test.ts` checks `isQuoteToken` (43 base64url
characters only), `parseQuoteView` (open and answered quotes with money
as strings; withdrawn and expired as state and job only; null for an
unknown token, a missing field, an unknown status or decision),
`approvedSummary`, `quoteBuckets` (per client and per token, views and
answers apart, an unknown client shared, SHA-256 digests only and never
the address or the token, the multiplier), `quoteEmail` (the WhatsApp
words, HTML-escaped name and link) and `sendEmail` against a stubbed
`fetch` (one POST to Resend with the bearer, the sender and the
idempotency key; 4xx rejected, 429, 5xx and a thrown fetch unavailable,
never Resend's message; off unless both variables are set);
`env.test.ts` the two variables (optional, blank unset, the sender's
shape); `auth-helpers.test.ts` that `/quote/<token>` is public and
`/quote`, `/quotes/…` and `/jobs/quote/…` are not.

Phase 14 step 1 (the Stripe service layer, `src/lib/integrations/stripe`;
every file `// @vitest-environment node`, `server-only` mocked, fetch,
clock, dependencies and loggers injected; no Stripe account, no key):
`stripe-signature.test.ts` (the exact bytes pass, multibyte UTF-8
included, and a re-serialised body fails; one flipped byte, another
secret, an empty secret, a missing, empty, garbled or oversized header, two
timestamps, an upper-case or non-hex `v1` and a `v0` alone are `invalid`;
either `v1` passes during a secret roll; 301 s in the past or ahead is
`expired`, 300 s passes; a genuine header with a NaN or infinite clock is
`expired` and a non-finite tolerance falls back to 300 s, never `ok`; a
forged stale header stays `invalid`; 500 random headers never throw); `stripe-form.test.ts` (the exact Checkout Session
body for a deposit, with literal brackets, `unit_amount=12000`, `sgd`,
both metadata blocks with `bicii_*` ids only, `expires_at` and encoded
URLs, in a fixed order; a balance's name and no null quote; never
`payment_method_types`, `allowed_payment_method_types`, `customer_email`,
`ui_mode` or `locale`; 49 cents, 100,000,000 cents, 120.5, a fractional
expiry and a 251-character name throw); `stripe-http-gateway.test.ts`
(the URL, method and headers: Bearer key, `Stripe-Version:
2026-09-30.endive`, `Idempotency-Key: bicii-checkout-<id>`, the form
content type, `redirect: "error"`, `no-store` and a timeout signal; one
retry with identical bytes and key after a network error, a 409, a 429,
a GET's 5xx or a 5xx marked `Stripe-Should-Retry: true`, and none for a
POST's other 5xx (Stripe would replay the saved 500 for the same key) or
a non-retriable error; after a 409 or a 429 one injected wait of
250–500 ms (jittered, between the two requests), and none otherwise; an
expiry outside 30 minutes to 24 hours refused before any call; every
row of the error table, including a livemode mismatch and a wrong object
→ `stripe_bad_response`; Stripe's code kept, its message and param and
the key never in the error; retrieve and expire validate and encode the
id, expire sends `bicii-expire-<id>-<nonce>`, a fresh key per call kept
by its own retry, and maps any 400 to `stripe_session_not_open`; list
refunds validates the payment intent and keeps refund objects only;
`retrievePaymentIntent` validates the id and checks the object and its
mode); `stripe-fake-gateway.test.ts` (on an injected clock: ids from the
payment id, the same key and body → the same session and another body →
a conflict, `url === successUrl`, unknown ids not found, `complete`,
`expire`, a session read as expired once its time has passed, an expiry
Stripe would refuse, a PaymentIntent per completed session that
`failAsyncPayment` returns to `requires_payment_method`, `addRefund`,
`listRefunds`, `failNext`, `calls` and `reset`); `stripe-form.test.ts`
also refuses an `expires_at` outside Stripe's 30-minute to 24-hour window
against the caller's clock;
`stripe-config.test.ts` (the full `stripeConfig` matrix: on in test mode
locally and live in production, the fake with livemode false; off for
preview, no key, a malformed key, a test key in production, a live key
locally or in development, a missing or malformed webhook secret, no
service-role key, and an origin with a path, query, hash, credentials, a
non-https scheme or http other than localhost, or a loopback host in
production; the reasons in their listed order; no key or secret in an
off result; `stripeCheckBucket` never holds the payment id;
`stripeIsOn()` answers false, logging the error's name only, when the
server environment does not parse); `env.test.ts` "Stripe variables (Phase
14)" (all optional, blanks unset; the fake with a key and the fake in
production refused; a malformed key, a live key outside production and a
malformed origin parse, because `stripeConfig` turns Stripe off instead);
`stripe-webhook-handler.test.ts` (413 by header and by size and 400
unreadable, none stored; 503 while off, stored as `stripe_off` without the
body; 400 `signature_invalid`, `signature_expired`, `body_not_json`,
`event_shape_invalid` and `livemode_mismatch`, each stored with only
allow-listed header names (every stored key is in
`WEBHOOK_HEADER_ALLOWLIST`) and the `stripe-signature` exactly as sent,
size and SHA-256 and no payload; the 31st rejection in a minute
not stored; 200 new with the payload and 200 `duplicate: true`; 500 when
storing fails, followed by a `not_recorded` evidence call with the same
SHA-256, and still 500 when that fails too; responses carry `no-store`
and never the payer's details; captured logs never contain
`stripe-signature`, `whsec_`, `/quote/`, `cs_test_`, `v1=` or the
payload); `stripe-limits.test.ts` (`noteStripeCheck`, with the env, the service
client and the logger mocked: one `note_sign_in_attempt` call with the
hashed `stripeCheckBucket` and a 300 s window, never the payment id in
clear; ok up to `STRIPE_CHECK_LIMIT`, limited above it, the multiplier
raising it; ok without the service-role key (no call), on an RPC error or
no data, and when the call throws, logging the code or the error's class
only); `stripe-webhook-route.test.ts` (exports exactly `POST`,
`maxDuration` and `runtime`; `nodejs`; 30 s); `stripe-fixtures.test.ts`
(the fixtures' shapes, and the adapter's verifier, parsers and
`stripeConfig` accept them); `proxy-matcher.test.ts`
(`/api/stripe/webhooks` is outside the proxy); `logger.test.ts` (with the
production options on a captured stream, `url`, `successUrl`,
`cancelUrl`, `checkoutUrl`, `secretKey`, `webhookSecret` and
`headers["stripe-signature"]` are `[redacted]` at the top level and one
level down, and the earlier paths still are); the Shopify webhook handler
test still imports `SlidingWindowLimiter` from `shopify/webhooks.ts`,
which re-exports it from `src/lib/integrations/limiter.ts`.

Phase 14 step 2, the quote page's deposit and Settings → Customer
payments: `stripe-checkout.test.ts` (the Checkout flows with the
in-memory Stripe and scripted RPCs through a stub service client:
`create` records the new session and redirects to the validated success
URL, with `bicii-checkout-<payment id>` as the key and the return URLs
from the configured origin; `check` re-reads an open session and reuses
its URL with no new session; within the 2-minute margin it expires and
records the old session, then creates; an expire Stripe answers "not
open" is followed by a retrieve and a read; a read that says paid, partly
refunded, refunded or completed returns that instead of a redirect;
`existing` from the record expires the new session and reuses the
winner's; `checkout_session_mismatch` expires it and is unavailable;
`deposit_job_closed` and `paid` from the record expire it too; paid,
processing and refunded from prepare never call Stripe; prepare's
refusals map to their sentences and an unknown link to "This link is not
valid…"; a Stripe failure, Stripe off, no gateway or no service client
are unavailable, the last three with no RPC; in live mode only
`https://checkout.stripe.com` is followed (`validateRedirect`, with the
fake's own rule); three attempts at most; a pending session Stripe
cannot find is unavailable with no new session (logged); no Stripe step
starts after `PAY_DEADLINE_MS`; `confirmDepositReturn` never
creates and reports Stripe's state; `refreshPaymentFromStripe` re-reads
the session, the PaymentIntent only when Checkout completed unpaid (a
lost async failure is recorded from it), and each listed refund, says
whether anything changed and whether it is still being confirmed,
reports an unreadable intent or refund list as `incomplete` with its kind
(`permission` for `stripe_auth_failed`; `unavailable` for
`stripe_unavailable` and `stripe_rate_limited` (a network error or
timeout, a 409, a 5xx, a 429); `error` for a 400, a not found or a bad
response; when
both reads fail differently the worse wins, `permission`, then `error`,
then `unavailable`), and covers
`not_found`, `other_mode`, `session_missing` and `unavailable`; logs
never carry the token, a URL or `/quote/`); `quote-page.test.ts` (the
`deposit` key absent, null and in every status with `parts_ordered` and
`job_closed` (false when absent), unknown statuses, percents and flags
refused, `answeredNext`'s sentence per status with and without the parts
ordered, and "Ask the shop about your deposit." once the job closed
without them (R-082; not for a refunded deposit), `depositReturn`, and the
`quote-pay:` buckets at 10 per client and per token; the payment page's
`balance-view:` (60) and `balance-pay:` (10) buckets are in
`balance-page.test.ts`, step 3 below);
`deposit-components.test.tsx` (Pay deposit resets on a `pageshow` from
the back-forward cache; the return drops `?deposit=returned` once the
check settles it or the minute is up, and its last sentence depends on
whether Stripe is on); `job-payments.test.ts` (`getJobPayments` over a
stub client: the five reads filtered by the job, money formatted as
Postgres sent it, `heldOverTotal` included, processing, unknown states
and a missing totals row, and null with the error's code logged when a
read fails); `unfitted-summary.test.ts` (R-082: `getUnfittedSummary` over
a stub client returns Postgres's count and total for the job, null for
none, and null with the error's code logged when the read fails);
`docs-links.test.ts` (the runbook link is `georgieboys/bicii-book` and
names headings the runbook has); `job-status-actions.test.tsx` (the
Collected button's confirmation says what was paid online and what to
take, and nothing about payments when there were none; Change status warns
that Collected is final when it is picked. Neither names approved items
not on the bill any more (R-082): since D149b the settle checklist comes
first, below);
`payments.test.ts` (every payment, refund and event status,
rejection reason and deposit state has words and a tone where shown;
every outcome `stripe_events_outcome_check` allows has words; each
Stripe off reason has a sentence that names no value; the connection and
percent labels; `depositBlockedIds`, the SQL gate's mirror: due,
processing, refunded and none block, paid and unknown do not;
`depositStates` (a request on a paid and a due quote is due, either
order); `depositPercentRefusal` (D157a: above 0 refused while Stripe is
off, 0 always allowed); `paidSummary` (then `paidOnlineSummary`, renamed
in step 3; paid online, still to pay,
paid ahead, nothing when the net is 0; `moreThanBill` only on a closed
job with `heldOverTotal` above 0); `collectedNotes` (one item, three
items, still to pay, none) and `heldOverSentence` (closed and above 0
only); and `stripeDashboardHref` in
live and test mode and for a non-`pi_` id; `incompleteCheckNote`: the key's
permissions named only for `permission`, "Stripe could not be reached;
try again" only for `unavailable`, "could not use Stripe's answer" and the
RUNBOOK for `error`). Step 2's third commit also
extends `exception-kinds.test.ts` (`payment_attention` "Customer payment"
with a fixed "Open the job's Customer payments" under the database's
sentence, so the row never repeats it, and its tone, `stripe_attention`
"Stripe needs attention" always danger with "Check Stripe deliveries in
Settings → Customer payments", a
`stripe_event` row linking to Settings → Customer payments' deliveries,
`exceptionSubjectIsSentence`: true for those two kinds only, whose
subject is the actionable sentence and wraps in full, while every other
kind's subject stays one truncated line, and the "Customer payments"
section after Shopify's in `groupExceptions`), `reconciliation.test.ts` (the section order and
kinds), `workshop-timeline.test.ts` (`part_ordered` with
`deposit_override`: "Ordered before the deposit was paid: <reason>",
waiting; a malformed override is ignored) and `consignment.test.ts`
(`canOverrideDeposit`: active admins and managers only, never a mechanic
with Manage purchasing, D152).

Phase 14 step 3's database (PR A; D154, D156, D161) changes the app in
one place and adds these unit tests: `payments-card.test.tsx` (new: the
job's Customer payments card hides its totals on a job with a deposit
asked and nothing paid, although `work_order_payment_totals` now returns
a row for every job, shows them once there is a Stripe payment, as
before, or only a counter payment, with the wording unchanged, and stays
hidden without a totals row; the test fails with the guard removed);
`payments.test.ts` (`showsPaymentTotals`); `job-payments.test.ts`
(`paid_at_counter` read and mapped); `db-errors.test.ts` (every new P0001
and P0002 code, CHECK and unique index of `20261014001300` and
`20261014001400` has a message, and a sample of them maps as written);
and `workshop-timeline.test.ts` (the four new timeline types: a payment
link sent by channel and amount, withdrawn with its reason, a counter
payment or deposit recorded with its method, a void given back or
recorded in error with its reason).

Phase 14 step 3's app (PR B; D154, D156, D161; merged in PR #36, whose
CI and full E2E run passed on edd4603). New files:
`stripe-balance-checkout.test.ts` (48 tests, the in-memory Stripe and
scripted RPCs: `startBalanceCheckout` for every `prepare_balance_checkout`
outcome (create passes Postgres's cents and expiry through, the row's
`amount` disagreeing with its cents on purpose; check reused only while
open and more than 120 s from expiry; replace expires and records the
named session; processing stops; nothing_due expires a returned session)
and every `record_balance_checkout` outcome (created, existing for this
and another payment, stale, nothing_due, mismatch with no retry), the
refusals and their sentences, Stripe off, live mode, the 30 s budget and
three attempts; `validateRedirect` refusing the other flow's page, dot
segments and `%2e%2e` included;
`confirmBalanceReturn` never creating or expiring; `expireOpenCheckouts`'
filters (that quote's deposit and any balance; balance only without a
quote), its paid, expired and failed counts, and that it never throws);
`balance-page.test.ts` (the token shape, the two pinned key sets with
extra keys dropped, money kept as strings, every notice and payment note,
`?balance=`, and the `balance-view` and `balance-pay` buckets: prefixes,
the 200-character cap, nothing in clear, the salt apart from the quote
page's); `customer-headers.test.ts` (Next's own
`unstable_getResponseFromNextConfig`: `/pay/<token>`, its
`?balance=returned|cancelled` and `/quote/<token>` get no-referrer,
noindex and `private, no-store`; staff paths keep only the catch-all);
`pay-page.test.tsx` (the async page: shape before the count, the count
before the read, each state's words, no Pay or privacy line on a closed
link, due with Stripe on and off, cancelled and returned);
`balance-components.test.tsx` (`PayBalanceButton` resets on `pageshow`;
`BalanceReturn` and `ReturnSlot`: one check, 1 + 12 refreshes, the
outcome kept over a later notice, the marker dropped; paid but read again
still due at another balance shows the line and Pay together, and only
the line before that read; a check that found nothing stops confirming
once the bill is read again at another balance);
`balance-actions.test.ts` (the token checked, then the limit, then
Stripe; each outcome mapped; the token never logged);
`link-throttle.test.ts` (both pages' keys, window, fail-open and log
lines); `payment-actions.test.ts` (send link: any staff, ADMIN_ORIGIN +
`/pay/`, refused while Stripe is off, the email rules, expiry only when a
link was replaced; counter: admin only, works with Stripe off, expiry
with the quote whenever `open_checkouts` is above 0, a replay included,
and none with nothing open, the two notes; void: admin only,
nothing expired); `payment-sheets.test.tsx` (`SendBalanceLinkSheet`'s
channels and replaces line, live or already expired,
`BalanceLinkSentSheet`'s alerts, `CounterPaymentSheet`'s choices, fixed
deposit amount, prefill, warnings, two-step commit and dates, the cap
before the confirm step and focus on the first invalid field after a
refusal); `payment-step3.test.ts` (labels, warnings,
notes, `linkLine`, `payPath`, `canSendLink`, the message and email,
`counterReceivedAt`, `depositBadge`); `balance-email.test.ts` (the key
`balance-<link id>`, off sends nothing, the failure log holds no token,
address or amount); `payment-reports.test.ts` (labels, copy,
`movementCount`, `heldGroups`' order and exact display totals, the cursor);
`payment-report-readers.test.ts` (the mappers, the RPC arguments, the
keyset page, the export pager's count check and retry, too_large before
any page); `payment-sections.test.tsx` (the tiles, notes, held regions
and the list and table cells). Extended: `stripe-checkout.test.ts` (the
deposit flow's `replace` and `job_payment_processing`), `logger.test.ts`
(`link` redacted, `linkId` kept), `proxy-matcher.test.ts` and
`auth-helpers.test.ts` (`/pay/` public), `deposit-components.test.tsx`
(the privacy line), `job-payments.test.ts` (counter payments, voids,
names, the live link without its hash, counter issues),
`payments.test.ts` (`paidSummary`, the renamed `paidOnlineSummary`, for
counter-only, mixed and processing jobs, and `nothingLeft` only when
balance_due is 0 with nothing paid ahead; `collectedNotes`, with "Nothing
is left to pay; take nothing." and no "Take only" while Stripe is
confirming a payment, also when nothing else is paid);
`heldOverSentence` by source), `payments-card.test.tsx` (the render rule,
header actions, totals, the link line, "Part of the balance", issue keys,
both voids and Keep payment), `job-status-actions.test.tsx`,
`workshop-timeline.test.ts`, `consignment.test.ts`
(`canRecordCounterPayment`), `staff-roles-screens.test.ts` and
`report-exports.test.ts` (the `payments` and `payments_held` kinds,
permissions, headers, rows and file names).

The audit's week-one fixes (2026-10-18 SGT, PR #38) add
`admin-origin.test.ts` (a quote link or the Shopify webhook address is
built on a valid `ADMIN_ORIGIN` and ignores `x-forwarded-host`; the
request's origin only when `ADMIN_ORIGIN` is unset or invalid, and never
an http or loopback origin in production) and extend `logger.test.ts`
(the `err` serializer keeps type, message, code and stack, never a
PostgREST `details` row or `hint`, for an Error and a plain object;
`loggablePath` masks the token of `/quote/` and `/pay/` and drops every
query) and `customer-headers.test.ts` (every page's `Permissions-Policy`:
the camera for the Admin only, microphone, geolocation, payment, USB and
screen capture refused; no `X-Powered-By`). The audit's efficiency items
add `photo-urls.test.ts` (`listPhotos`: without `STORAGE_IMAGE_TRANSFORMS`
the grid gets the original and nothing more is signed; with it a private
photo's thumbnail is a 480 px signed rendition, one request per photo, a
public one a render URL with none, the viewer keeps the original, and a
rendition Storage cannot sign falls back to the original). The audit's
database and security items add `quote-answer-action.test.ts` (a mapped
business reason comes back as `code`, an unmapped P0001's database text
never does) and `cookie-options.test.ts` (session cookies Secure on Vercel
only), and extend `link-throttle.test.ts` (the client's bucket is counted
first and alone; a client past its limit adds no per-token row),
`env.test.ts` (production ignores `SIGN_IN_LIMIT_MULTIPLIER`),
`auth-helpers.test.ts` (`newRequestId` mints a fresh id each time),
`shopify-webhook-handler.test.ts` (the stored correlation id is fresh, not
the incoming `x-request-id`) and the stack test `stack.smoke.test.ts`
(staff cannot upload to either photo bucket outside an attachment's own
path).

### Database (SPEC §27.2 and §23)

Each invariant from SPEC §23 has at least one test, named after it:

| Invariant | Test |
|---|---|
| Unique unit cannot be sold twice | `record_retail_sale` twice on one unit → second raises; one `sold` movement. Built in Phase 6 step 2: `sales.test.ts` "A unique inventory unit cannot be sold twice" (`unit_already_sold`, one `retail_sale` movement, an owner insert of a second live line → 23505 `sale_lines_unit_sells_once`, resale only after `restock_unit`) and `consignment-concurrency.test.ts` "…, concurrently". |
| Stock-consuming line consumes once | call `add_inventory_line` with the same idempotency key twice → one line, one movement; concurrent calls (two connections) → one movement. |
| Void creates reversal, never deletes | `void_line` → original movement intact, one `reversal` row with `reversal_of_id`; second `void_line` → no-op. |
| Duplicate Shopify webhook has one effect | Built in Phase 10 step 1: `shopify-webhooks.test.ts` "Duplicate Shopify webhook has one effect": `record_shopify_webhook` twice with one webhook id → one event (`on conflict` on the partial unique `integration_events_external_id_key`, `delivery_count` 2), one job; `process_shopify_event` twice → one sale, one `online_sale` movement per line, stock down once, and the replay closes a reclaimed job; the same order under a second webhook id → `duplicate_order` with the same sale; two webhook ids of one order that both fail, then one recorded → the other `duplicate_order` with the sale and its job done, nothing on Today; dismissing one delivery closes the order's other open deliveries and its waiting refunds, and a later delivery records nothing; a dismissed order delivered again under a new webhook id → `earlier_delivery_skipped`, no sale and no movement; a dismissed refund delivered again under a new webhook id records nothing, a processed one → `duplicate_refund`. Concurrent (committed, each proven to wait on a lock): the same event processed at once, two deliveries of one order (the order's advisory lock) and the same webhook id recorded at once. |
| Snapshots do not change with catalog edits | add service line, update `services.default_sale_price` → line totals unchanged. Phase 3: `update_service` price, cost and name → the earlier line keeps 180.00/20.00/"Full Service", the next one uses the new values. |
| Sale liability ≠ settlement | sell a consigned bike → `consignor_ledger.outstanding = agreed_amount_owed`, `paid = 0`. Built in Phase 6 step 2: `settlements.test.ts` "Consignment sale liability and consignment settlement are separate facts" and "Consignment outstanding balance and partial settlements" (200.00 then 300.00 → 0.00). |
| Settlement cannot exceed owed | `record_settlement` over-allocating without override → raises; with override by `manage_consignments` → succeeds and stores reason. Built in Phase 6 step 2: `settlements.test.ts` "Settlement allocations cannot exceed the amount owed without an explicit override" (600.00 against 500.00 → `settlement_exceeds_outstanding`; with a reason it stores the trimmed reason and leaves −100.00; an unsold item needs one too) and the concurrent case in `consignment-concurrency.test.ts`. |
| Customers cannot read internal data | as customer A: select from `work_order_line_items`, `products`, `inventory_movements`, `customers.internal_notes` → zero rows or column permission error; `work_order_totals` returns no cost columns. |
| completed_at ≠ collected_at | status walk → both stamped at different times; `collected` cannot precede `completed`. |
| Booking cannot exceed capacity | fill a slot to capacity → next `book_appointment` raises; two concurrent bookings for the last unit → exactly one succeeds. Also: outside hours, inside closure → raise. Built in Phase 2: `appointments.test.ts` "SPEC §23 Booking cannot exceed capacity (D2)" (a full window → `appointment_capacity_exceeded`; a 60-minute type blocked by either window; a 2-unit type needs two free units in every window; cancelled and no-show appointments free their units) and `appointment-concurrency.test.ts` (committed, real connections: two bookings for the last unit, a 60- and a 30-minute booking racing for their shared window, a staff and a customer booking racing, the same id twice → one row and one `booked` event, a no-show reinstated as arrived racing a booking for its freed unit, one customer booking two days at once with one booking left → exactly one each; the used units equal the capacity afterwards; and two concurrent check-ins of one appointment → one work order, the second returning `created` false with the same `work_order_id`). |
| Bookings respect shop hours and closures (Phase 2, D38) | `appointments.test.ts`: before opening, at closing, crossing closing time, crossing a lunch gap and an inactive weekday → `appointment_outside_hours`; a whole-day and a partial closed override → `appointment_closed`; custom hours shorter and longer than the weekly hours; a start off the grid (or with seconds) → `appointment_slot_misaligned`. `appointment-slots.test.ts` runs every case of `tests/fixtures/appointment-slot-cases.ts` through `private.available_slots_at` (exact local slots and remaining units: split days, adjacent intervals, inactive Monday, closures, custom hours with and without a closure, 2-unit types, cancelled/no-show freeing units, 10:15 opening, 15-minute grid, staff mid-day, public notice and horizon, non-public and inactive types, 24:00 closing) and every `problemCases` row through `private.appointment_slot_problem` (each code and their order); `public.available_slots` as anon and as a customer returns remaining_units NULL and public types only, staff see the units. Step 3's TypeScript mirror runs the same cases. |
| Self-booking rules (Phase 2, D37) | `appointments.test.ts`: inactive type → `appointment_type_unavailable`; staff `appointment_in_past` for an appointment that is over, but a started one may be booked, without notice or the public flag; customers (`book_my_appointment`): `appointment_too_soon`, `appointment_too_far_ahead`, a non-public type; the per-customer limit (precondition asserted; a staff booking first does not count; customer bookings up to the limit; the next → `appointment_customer_limit`; a replay is not a new booking; a staff booking still succeeds; cancelling frees a place); bike not owned / archived / unknown, archived or unknown customer. `appointment-customer-access.test.ts`: cancel cutoff (inside it, after the start, once arrived → `appointment_not_cancellable` and `can_cancel` false; outside it `can_cancel` true; the cutoff follows `customer_cancel_cutoff_minutes`), the default reason 'Cancelled by the customer' in `cancellation_reason` and the event, `cancelled_via` customer, a replay adds no event, a staff-made appointment is theirs to cancel; staff without a customers row → 42501. |
| Booking is idempotent; snapshots never move (Phase 2, SPEC §2, D38) | `appointments.test.ts`: the same id and arguments → the same row and one `booked` event; another start, customer, type or day under the id → `appointment_conflict`; a replay after the type is deactivated (and the day closed) returns the original row with no event, and a customer's replay after the type stops being public too; changing the type's duration and units, the slot length and the hours leaves `ends_at`, `capacity_units` and the status as booked, and `ends_at` is immutable for the owner. `schedule-settings.test.ts`: slot length, hours, a closure and a type edit leave a booked appointment untouched (same `updated_at`). |
| Appointment status machine (Phase 2, D39) | `appointments.test.ts`, table-driven from `tests/fixtures/appointment-transitions.ts`: `mark_appointment_status` for all 49 pairs (ok with one event, replay without, or the code: `appointment_use_check_in`, `appointment_use_cancel`, `appointment_transition_invalid`); `appointment_not_started` before the start; no_show → arrived on its own date refused while its place is taken (`appointment_capacity_exceeded`) and allowed once a unit frees, on another date `appointment_transition_invalid`; the trigger refuses the same off-diagonal pairs for the owner and needs a reason to cancel; `cancel_appointment` from every status; reason first (`reason_required` even for an unknown id, `reason_too_long`), P0002, `cancelled_via` staff, a replay returns the row without an event. |
| Appointment changes leave history (Phase 2, SPEC §2, §22) | `appointments.test.ts`: booking, confirming and each bike or note change append exactly one `appointment_events` row with actor staff, auth user, reason and the request's correlation ID; replays and no-op updates append none; `details_changed` payloads carry only the changed fields; the bike changes only before check-in and stays the customer's; the customer's note freezes once the appointment is over; `appointment_events` refuse UPDATE/DELETE for the owner (`appointment_history_append_only`); mechanic2 (no permissions) books, marks, updates and cancels; customers and anon get 42501 from the staff RPCs and nobody writes the tables directly. |
| Check-in creates or links exactly one work order (Phase 2, D36, D40) | `appointment-check-in.test.ts`: check-in creates a job with `appointment_id`, the job number, P3's `checked_in` then `appointment_linked` (created true) then the lead's assignment, actor the caller (mechanic2, no permissions); the appointment is checked_in with `checked_in_at`, `arrived_at` and the bike, its history `booked, checked_in, work_order_linked`; requested work defaults to the customer's note, blank both → `requested_work_required` with the appointment unchanged; a replay with the same or another `work_order_id` returns the same link (created false) and creates nothing; another job's id → `work_order_conflict`, appointment unchanged; `link_existing` to an open unlinked job of the same customer and bike sets only `appointment_id` and writes `appointment_linked` (created false); another customer's or bike's job, a completed / ready / collected / cancelled job or an already linked one → `appointment_work_order_mismatch`, an unknown one P0002; changing or clearing a set link → `work_order_immutable` (P3's detail); from cancelled or no_show → `appointment_transition_invalid`, from checked_in or completed → the existing link; someone else's bike or a shop bike → `appointment_bike_not_owned`, archived → `appointment_bike_archived`; nulls 22004, unknown appointment P0002; an owner insert or `private.create_work_order` with an appointment not checked in → `appointment_not_checked_in`, of another customer or bike → `appointment_work_order_mismatch`, the same on the null → value update; a second job for one appointment → 23505 `work_orders_appointment_id_key`; walk-ins unaffected; D36: completing the job completes the appointment once at the job's `completed_at` with the actor, ready and collected add nothing, a reopen and re-completion leave it, a cancelled job leaves it checked_in; customers never see `appointment_linked` in `my_work_order_timeline`; customers and anon 42501. `work-orders.test.ts` (P3's link-once case) uses real checked_in appointments. |
| Appointment counts (Phase 2, D30, D41) | `appointment-reporting.test.ts`: `public.appointment_daily` over the seeded days (anchor −10 … +21) equals the counts the appointments table implies by scheduled shop day and current status, zero-filled, and `reporting.appointment_daily` (owner) holds exactly the days with appointments; `daily_summary`'s three appointment columns equal its booked / arrived / no_shows for every seeded day; `today_dashboard(null)` gives mechanic2 the same counts as the admin; customers (Chloe's login) and anon 42501; the range rules match `daily_summary`; booking, arriving, a no-show and a cancel today move today's counts exactly, and a no-show marked now on an older appointment counts on its own day; every checked_in or completed appointment has exactly one work order with its customer and bike. `reporting.test.ts` checks the columns against `appointment_daily` on test days with appointments; `reporting-access.test.ts` lists the RPC and the view. |
| Seeded schedule and appointments (Phase 2) | `appointment-seed.test.ts` (reads only, days from the anchor): settings, the eight weekly rows (inactive Monday, split Saturday), the four types (one staff-only; anon sees the three public ones in order), the two closures as whole days within 14 days; each appointment's customer, bike, type snapshot, day, time, status and source as in `ids.ts`, booked ahead; nothing beyond 14 days, upcoming days Tuesday–Friday off the closures; Daniel has no upcoming booked/confirmed appointment, Chloe at most two upcoming online bookings, today at most three expected arrivals; Tan's appointment linked to J-000014 and completed at its completion, J-000014's timeline `checked_in, appointment_linked, …`; each status reached one update at a time; Chloe's login linked and `my_appointments()` exactly her upcoming rows with the D42 keys. |
| Schedule configuration (Phase 2, D35, D38) | `schedule-settings.test.ts`: only admins call `update_shop_settings`, `set_shop_hours`, `save_closure_override`, `delete_closure_override`, `save_appointment_type` (mechanic1, mechanic2, anon → 42501); no time zone or currency parameter and an owner write of an unknown time zone → `shop_timezone_invalid`; null keeps, values round-trip (`customer_cancel_cutoff_minutes`; 10081 → `shop_settings_cancel_cutoff_check`; a slot length not dividing 1440 → `shop_settings_slot_minutes_check`); `shop_capacity_below_type` (inactive types ignored); the row cannot be deleted; `set_shop_hours` replaces atomically, rejects overlaps (also for the owner), bad JSON and weekdays (22023) and inverted intervals, a replay appends nothing; closure shapes store the documented Singapore instants; `closure_custom_hours_overlap`; `closure_invalid_range` and reason rules; is_new replays, `closure_conflict` / `appointment_type_conflict` after an edit (the edit survives), P0002 for a missing edit; deletion needs a reason and is kept in `schedule_events`; `appointment_type_capacity_too_large`, names unique ignoring case; one `schedule_events` row per real change with its actor, append-only. `appointments.test.ts`: `private.shop_timezone()` / `shop_currency()` follow the settings row. |
| Duplicate receipt cannot double stock | Phase 7, proven at every layer. Database (`purchasing.test.ts`, `purchasing-concurrency.test.ts`): `receive_purchase` with the same idempotency key twice → the first receipt back, one receipt, one line, one movement, stock +18 once and the cost set once; the same key with other lines or on another PO → `purchase_receipt_key_reused` and nothing written; a replay that omits the cost matches the stored cost (an omitted cost is the PO line's); the same key from two connections at once → one receipt, stock added once; `purchase_receipt_by_key` returns that receipt (zero or one row). Ledger backstop: Phase 4's unique index `inventory_movements_receipt_line_once` (one `purchase_received` movement per receipt line, the only unique index on the column). App: `receive-form.test.ts` (the key is kept across reloads and refusals, an unknown outcome locks the form until the lookup, a retry reuses the key and the values, a new key only with fresh values). E2E (`purchasing.spec.ts`): a double-clicked "Receive 18 items" makes one receipt and one `Received +18` movement; a lost response (server committed, connection dropped) is found by the lookup and shown as recorded, one receipt, stock +6 once; a lost request (never sent) is checked, not recorded, and retried with the same key, one new receipt. |
| Partial receipt adds the right stock (Phase 7) | 18 of 20 → `partially_received`, on hand +18, outstanding 2 in `reporting.purchase_order_progress`; the remaining 2 → `received` with `received_at`; quantities reduced to what arrived complete the PO; seeded PO-000002 is SPEC §14's 20/18/2, overdue (`purchasing.test.ts`, `purchasing-seed.test.ts`; E2E "18 of 20 received · 2 to come"). |
| Over-receipt is refused and a received PO is closed (D65) | more than outstanding (summed per PO line across a receipt's locations) → `purchase_over_receipt`, nothing written; draft → `purchase_order_not_submitted`; received or cancelled → `purchase_order_closed`; two racing keys each receiving 18 of 20 → one succeeds, one over-receipt; receipts and their lines refuse UPDATE/DELETE (`purchase_receipt_immutable`). App: typing more than is to come shows "Only 2 still to come. Raise the ordered quantity on the order first." and blocks the commit; the receive page of a received PO shows the closed state with "Start a new order for this supplier" (E2E). |
| Last cost by received_at; 0 is a known cost; snapshots untouched (D5, D63, D24 as amended) | a receipt sets `products.default_direct_cost` and the supplier link's `last_unit_cost` only when no later-received receipt holds the product (a back-dated receipt entered after a newer one changes no cost; ties by created_at then id; within a receipt the highest line number); `last_received_at` is the greatest; receiving upserts the supplier link; a 0 line cost and a 0 actual cost are accepted and become the last cost; the cost change is Phase 4's `cost_changed` event with "Received on PO-… (delivery note …)"; earlier `work_order_line_items` and `inventory_movements` snapshots are unchanged (`purchasing.test.ts`, concurrency file for racing receipts). E2E: received at $12.50 → the product's supplier shows "Last cost $12.50". Unit: `buildReceiptLines` keeps "0.00", `receivePurchaseSchema` accepts 0. |
| Back-dated receipt dating (D64) | `received_at` defaults to now; up to 30 days back accepted, older → `purchase_receipt_too_old`; more than 5 minutes ahead → `purchase_receipt_in_future`; before `submitted_at` → `purchase_receipt_before_submission`; the movement's reason carries the shop-time delivery date. Unit: `receivedAtBounds` and `receivedAtForSubmit` (sent only when changed, from shop time); the three codes land on the Received field (reducer test). |
| Purchase cost visibility (D60) | `purchasing-access.test.ts`: mechanic2 reads suppliers, PO quantities, statuses and dates, but no cost column (42501 on the base tables' cost columns, 0 rows from the four `*_staff` views, no history) and writes nothing; mechanic1 (view_costs) reads costs and history but writes nothing; a manage_purchasing-only holder reads purchase costs and writes, gets the `purchase_cost_defaults` prefill only for an orderable product (a unique, consigned, customer-owned, inactive or archived product's id returns no row), and the Phase 3/4/5 cost surfaces stay closed to them (`products.default_direct_cost`, `product_costs`, `inventory_unit_costs`, `inventory_movement_costs`, `inventory_movements.unit_cost_snapshot`, `services_staff`, `work_order_line_items_staff`, `work_order_totals_staff`, `work_order_yield`, `financial_lines`, the money in `daily_summary` / `today_dashboard`). E2E: mechanic2's PO page has no "$", no Totals or History, no Receive link; the receive and reorder routes are a real 403. |
| Purchase history is append-only (Phase 7) | every PO change appends one `purchase_order_events` row with actor, correlation ID and reason (cancel and line changes after submission need one); replays append none; UPDATE/DELETE refused for the owner too (`purchase_order_history_append_only`). |
| Reorder suggestions (D66) | `purchasing-reorder.test.ts`: `suggested_reorder_quantity` = max(2 × reorder point − on hand − on order, 0); `reorder_suggestions` lists shop-owned `reporting.low_stock` products only, on order counts submitted and partially received POs (never drafts), names drafts holding the product, carries no cost; `create_purchase_order_from_low_stock` makes one draft, a 0 suggestion ordered at 1, cost = supplier last cost, else product cost (0 included), else 0, replay by id adds nothing; manage_purchasing only. E2E: after receiving 18 of 20 and using 1, the product is pre-ticked with on order 2 and suggestion 21, and the draft has it × 21 at $12.50. |
| Consigned stock is never purchased (Phase 7 integration with Phase 6, D45, D62) | `purchasing.test.ts` "Phase 6's consigned stock is never purchased": the seeded consignment-owned jerseys (counted, active, in stock) are refused as a PO line, in `create_purchase_order_from_low_stock` and as a supplier link (`purchase_line_not_shop_owned`), and `purchase_cost_defaults` returns no row for them. For `reorder_suggestions` the test first gives the jersey a reorder point above its stock and proves it is in `reporting.low_stock`, then that the suggestions (with and without a supplier) still return no row: only its ownership keeps it out. |
| Manual adjustment records actor/time/reason | `adjust_stock` without reason → raises; with reason → row has `created_by`, `reason`. |
| Public QR exposes only published | `public_items` as anon: draft/internal rows absent; public row shows no cost; sold unique shows `sold`. Built in Phase 4: `inventory-publication.test.ts` (row below). |
| Archived entities stay referenceable | archive a service used on a historical job → job line still joins. Phase 3: the service, the job's bike and its customer archived → the line still joins the service and the job its bike and customer; the archived service is refused for new lines. |
| Money is numeric | information_schema check that no money column is `real`/`double precision`; money and rate domains reject `NaN` (23514). |
| Staff changes leave history (SPEC §2, §22) | each grant, revoke, deactivation, reactivation, creation, role change and rename appends exactly one `staff_events` row with its actor; replays append none; deactivation without a reason raises `reason_required`; `staff_events` refuses update/delete (`staff-history.test.ts`). |
| Staff rules hold for every writer | no direct staff writes for API roles; staff.email must equal the login's email even for the owner; nobody signed in deactivates their own row; a manage_staff holder grants only permissions they hold, never manage_staff, never on themselves or admins (PLAN D11). |
| Three staff roles (D90–D94) | `staff-roles.test.ts`. The enums are `admin \| manager \| mechanic` and the seven permissions in the app's order; `private.role_implies` equals `roleImplies()` from `src/lib/auth/permissions.ts` for every role × permission (parity), a null role implies nothing, and no API role may execute `role_implies` or `can_record_refunds`; `staff.role` and `create_staff`'s role default to `mechanic`. The role × permission matrix: for the admin, the seeded manager, the manager with a `manage_staff` exception, mechanic2, mechanic1 (`view_costs` exception), a throwaway mechanic granted each single permission in turn, a mechanic holding all seven as exceptions, an inactive manager and an inactive admin, `private.has_permission` and `my_staff_profile().permissions` give exactly the expected set, plus `can_record_refunds` and `is_admin`. One gate per family, called as each of them (42501 for refused callers, anything else for allowed ones with bogus ids): `work_order_yield`, rows of `product_costs` and `services_staff` (view_costs); `create_service` and a `categories` insert under RLS (manage_inventory); `adjust_stock`, `write_off_unit`; `consignor_payout_details`, `create_consignment_item`; `create_purchase_order`, `purchase_cost_defaults`; `financial_lines`; `staff_roster`, `staff_history`, `grant_permission`, `create_staff`, `set_staff_active`, `update_staff` (manage_staff); `record_sale_refund` (admin and manager only); `update_shop_settings`, `schedule_cult_commons_rate` (admin only). Exceptions (D92): granting a permission the role implies (manager + any of six, admin + any) is `permission_implied_by_role`, also for a direct superuser insert; an admin grants `manage_staff` to a manager, who then holds all seven; promoting a mechanic with `view_costs` + `manage_purchasing` to manager deletes both rows and appends `role_changed` then two `permission_revoked` events with the admin and the reason; a replayed role change appends nothing; demoting brings nothing back; promoting to admin drops every row, and a role change by SQL drops implied rows too; after the migrations and the seed no row is implied by its person's role; the roles migration's one-time clean-up (`private.drop_implied_exceptions()`, run by `20261006000200`) removes implied rows written before the roles (built with triggers off: an admin's `view_costs`, a manager's `adjust_stock`), each with a `permission_revoked` event with no actor and the fixed reason, keeps real exceptions (the manager's `manage_staff`, Marcus's `view_costs`), and a later demotion brings nothing back. `staff-concurrency.test.ts` (two committed connections, its own database): a direct insert that waits on a concurrent promotion is refused (`permission_implied_by_role`) once it commits, and a promotion that waits on a concurrent direct insert deletes that row once it commits (`permission_granted`, `role_changed`, `permission_revoked`, in that order); both fail if the refusal trigger's `FOR SHARE` is weakened to `FOR KEY SHARE` (checked once by hand). Administration (D93): only an admin invites a manager or an admin (a mechanic and a manager holding `manage_staff` invite mechanics only); a non-admin `manage_staff` holder grants only what they hold to a mechanic and is refused (42501) on a manager's or an admin's row for grant, revoke, rename, deactivate and role change, and on their own row; the admin renames, deactivates, reactivates and demotes a manager; nobody changes their own role; the last active admin cannot be demoted (55000); a role change whose `expected_role` is not the current role (a stale confirmation) is `staff_role_changed`, changes nothing and appends no event, and goes through with the current role; a role-change reason over 500 characters is `reason_too_long`. `sales.test.ts`: a manager records a refund; mechanics, with `view_financial_reports` or all seven exceptions, are refused (D94). `staff-history.test.ts`: promoting Marcus to admin appends `role_changed`, then the `permission_revoked` of his `view_costs` with the same actor and reason, then the rename. |
| The Admin's sign-in limits (PLAN D72) | `sign-in-throttle.test.ts`: `note_sign_in_attempt` adds one per bucket per call (a bucket named twice counts once) and returns the counts; a new window starts a new count, windows are aligned, counters older than a day are deleted; 6 concurrent committed calls count 6; anon and staff get 42501 on the function and the table, the service role on the table; malformed arguments (no, 0 or 9 buckets, an empty, null or 201-character key, a window under 60 s, over 3600 s or null) are 22023. Live: `sign-in-throttle.stack.test.ts` (above). |
| No seeded login has a usable password (PLAN D10) | `seed-logins.test.ts`: every seeded staff login and the seeded customer login store a bcrypt hash (cost 10) that is not the shared local password the seed used before email codes, and no two share a hash. |
| Deactivation ends Auth sessions (PLAN D71) | `staff-sessions.test.ts`, with sessions and refresh tokens inserted for mechanic1 and mechanic2: the admin deactivating mechanic2 (with a reason) deletes mechanic2's sessions and refresh tokens (with and without a session) and leaves mechanic1's; a replayed deactivation (with or without a reason) neither errors nor deletes; reactivation deletes nothing; a `manage_staff` holder who is not an admin deactivating a non-admin has the same effect; a refused deactivation (P0001 `reason_required`) leaves the sessions intact; a direct superuser `update staff set active = false` revokes too (false over false and updates of other columns do not); the migration's first statement passes for the migration role and fails, naming RUNBOOK, for a role without DELETE on `auth.sessions`. Live (`staff-sessions.stack.test.ts`): a throwaway staff login (admin API without a password, then `create_staff` as the admin) signs in with a code and is deactivated by the admin; Auth then answers its access token with 403 `session_not_found` (supabase-js: `AuthSessionMissingError`), its refresh token gets `refresh_token_not_found`, PostgREST still accepts the unexpired token but `my_staff_profile` says `active = false` (the hosted window), and a fresh code still verifies at Auth while `my_staff_profile` says `active = false`, which the Admin's `verifyCode` and `requireStaff` refuse. |
| RLS: customer A cannot read B | bikes, appointments, work orders, attachments. Phase 1 (`customer-access.test.ts`): a signed-in customer reads zero rows from every base table; `my_customer_profile`, `my_bikes`, `my_bike_attachments` return only their own rows, never `internal_notes` or `internal` photos; another customer's bike id returns nothing; PLAN D12: after a transfer the new owner sees photos taken before it and the previous owner none (also on the seeded sale), and an archived bike's photos disappear. Phase 3: a signed-in customer reads nothing of their own job (job, assignments, events, lines, line and totals views, services, categories, rates) and cannot call the workshop RPCs (42501); their projection is tested in `workshop-customer-access.test.ts` (row below). Phase 2 (`appointment-customer-access.test.ts`): a signed-in customer with their own booking reads zero rows from `appointments`, `appointment_events`, `appointment_types`, `shop_hours`, `closure_overrides`, `shop_settings` and `schedule_events`; `my_appointments()` returns only their own upcoming rows soonest first and `my_appointments(true)` the past ones after them, latest first, with exactly the `my_appointment` keys (D42: never `internal_note`, `cancellation_reason`, capacity units, source or actors); after the bike is archived or transferred (D12) its fields are NULL for them; `book_my_appointment` books for themselves only (source customer, their login), another customer's or an unknown bike → `appointment_bike_not_owned` with a neutral detail; `cancel_my_appointment` on someone else's id → NULL and nothing changes. Since the audit (2026-10-18 SGT, `20261018000100`): `update_my_profile` with an over-long phone, first, last or display name fails with 23514 and its constraint and no DETAIL, never the row's internal notes (all four failed with "Failing row contains (…)" before the migration). |
| Ownership changes preserve history (SPEC §5) | `transfer_bike_ownership` appends one event with actor, reason and correlation ID and leaves earlier events untouched; empty/blank reason → `reason_required`; replay → no event; plain updates of `customer_id` refused (42501 for staff, `reason_required` for the owner); events append-only; concurrent transfers form one chain (`customers-bikes.test.ts`). |
| Stable physical identity | bike short IDs are server-assigned `B-######`, increasing, unique, never client-supplied (42501) and immutable (`bike_short_id_immutable`). |
| Storage enforces visibility (SPEC §8) | `media-internal`: anon, customers and inactive staff read/write nothing, active staff read and add; `media-public`: only active staff read or list it through the API, only staff add; nobody overwrites; staff delete only objects no attachment points at (`media-storage.test.ts`); live signed-upload round trip with anon download refused, a bare Storage remove of a recorded photo refused, `delete_attachment` replay is `[]` (`stack.smoke.test.ts`). |
| Attachment visibility move (PLAN Phase 1) | The app's own domain code against real Storage (`photo-moves.stack.test.ts`): internal → public → internal → deleted, a stranger's fetch of the public URL succeeding only while public and the original removed each time; refused moves (customer record, undecoded original) copy nothing; a failed cleanup reports `cleanupPending`, Finish removes the leftover, and a leftover nobody finishes is swept when the record is shown. E2E does the same through the viewer. |
| Lists and search name records alike | `customerLabel` (TypeScript, used by table-backed lists) equals `private.customer_label` for every fallback case, and `bikeTitle`/`bikeSubtitle` equal `staff_search`'s title and subtitle for every seeded bike (`display-parity.test.ts`). |
| Attachments describe real objects | `record_attachment` rejects a path that is not `{entity_type}/{entity_id}/{id}.{ext}`, a missing object, the wrong bucket, a non-photo, an unknown entity; replay-safe; delete needs a reason and is kept in `attachment_events`; an undecoded original (no dimensions) is never public; `attachment_stray_objects` lists only what no row points at and is old enough (`attachments.test.ts`). |
| Anonymous cannot read costs/notes | every table in the RLS matrix: anon select returns 0 rows or is denied. |
| Public site backend (Phase 11 step 1; D121–D124; SPEC §4.1, §4.2, §18, §23) | `public-site.test.ts`: `claim_my_customer` refuses anon (42501) and an unconfirmed login (`customer_email_unconfirmed`); without a booking it returns nothing and creates nothing; at the first booking it creates one record with the login's email, trimmed name and phone, and a repeat returns that row; a first name is required and names and phone have length limits; it links the one unlinked record with the same email in any case without changing staff data or returning `internal_notes`; two such records link nothing (`customer_link_ambiguous`); archived records and records with another login are never linked; a login whose own record is archived is refused (`customer_archived`); a linked login keeps its record after either email changes; two simultaneous first bookings by one login (two committed connections) make one record. `bookable_slots` equals `available_slots` day by day for anon, a customer and staff over eight days, tags each start with its shop day, follows D37 for non-public types, takes at most 31 days and refuses reversed or null bounds. The customer Storage policy lists exactly the caller's customer-visible bike and job photos in `media-internal` (not internal ones, other customers', the customer record's or the public bucket), drops them when the job is cancelled or the bike archived, gives anon and a login without a record nothing, and lets customers write nothing. Every short-ID column the Admin's `/q` resolves holds well-formed, unique IDs readable by staff. |
| Indent parts and quotes (Phase 13 step 1; D140–D147) | `indent-parts.test.ts`: proposing a part or service adds a request with no movement and no line (the job's lines and the product's movements unchanged), at the product's selling price, replay-safe, and refuses unique, inactive and unpriced products, a zero quantity, a conflicting replay and a completed job; any staff member proposes, but a cost or supplier needs view_costs or manage_purchasing (42501 for mechanic2). Staff read requests and quotes but not `expected_unit_cost`, `supplier_id` or `token_hash` (42501); `job_part_requests_staff` returns the cost only to view_costs; anon reads no table and no staff RPC, and `quote_by_token` returns null for unknown or malformed tokens. `send_quote` returns a 43-character token, stores exactly its SHA-256 and nowhere the token, refuses a replayed id (`quote_already_sent`), foreign or non-proposed items, duplicates and validity over 30 days; a second quote withdraws the first (its link shows only `{status: withdrawn, job_number}` and cannot be answered; its items return to proposed). The page shows exactly twelve keys (`deposit` since Phase 14 step 2, null at the shipped 0%) and no cost, supplier, email, phone, note, Stripe id or URL; the helpers are shared with the deposit tests through `tests/db/indent-fixtures.ts`; an expired quote shows `expired` and refuses answers. `answer_quote` records each item once, sets the job's approval flag and note (not the flag when all are declined), refuses a second answer, incomplete, duplicated, foreign, non-boolean and malformed answers, a blank name, an unknown token and a closed job; two committed connections answering at once give one answer and one `quote_not_open`. `order_part_requests` needs manage_purchasing (mechanic1 refused; mechanic2 with the grant allowed) and approved parts; it creates the supplier's draft at the expected cost with "For J-…", links the request, moves the job to Waiting on parts and replays to the same order; a second job's request raises the same line. Receiving two of three covers the first job's two and not the later one; `indent_reservations` shows them until fitted. Fitting adds one inventory line at the quoted price with one `job_consumption` movement, replay-safe; an approved service fits as a service line; proposed items cannot be fitted. Cancelling needs a reason and refuses quoted and fitted items. **Completed and closed jobs (R-082, D149, `20261014000700`):** on a collected job mechanic1 and mechanic2 (with Manage purchasing) get `work_order_closed` from `cancel_part_request`, and everyone `work_order_locked` from Fit; the manager gets `reason_required` (blank, null) and `reason_too_long`, then cancels with a trimmed reason; the admin cancels the service; both `part_request_cancelled` events carry the reason, `was: approved` and the actor; the job stays collected with no line or movement; a replay answers a mechanic. A cancelled job's ordered part is cancelled by the admin (mechanic2 refused) and stays on its order; a fitted request on a collected job is `part_request_fitted`. A quote left open when the job was collected (as the admin) or cancelled (as the manager): mechanic1 gets `work_order_closed`, a blank reason is `reason_required` and withdraws nothing (still quoted, quote open), then the cancel withdraws the quote (its link answers `{status: withdrawn, job_number}`), returns the service to proposed, records `quote_withdrawn` then `part_request_cancelled` with `was: quoted` and the actor, leaves the job's status alone, and the proposed service is cancelled the same way; on a completed job a quoted request is still `part_request_quoted`. A manager deactivated by the owner gets 42501 on a collected job, and the request stays approved with no `part_request_cancelled`. On completed and ready jobs mechanics still cancel. Ordering a completed, ready, collected or cancelled job's part (or a set mixing an open and a completed job) is `work_order_locked` and leaves it approved, while the replay of an ordered set returns its order after completion. Withdrawing works on completed jobs and is `work_order_closed` on collected and cancelled ones (mechanic and admin), except the replay of a quote withdrawn earlier. `work_order_unfitted_requests` is empty while proposed or quoted, 2 items $265.00 once approved and once ordered (as mechanic1 and mechanic2), unchanged by a declined item, 1 item $240.00 after the service is fitted, empty after the part is cancelled; its columns are exactly `work_order_id, currency, item_count, quoted_total`; customers read 0 rows and anon 42501. With the migration moved out (checked by hand on 2026-10-15 after the review fixes), every new test here fails except the two that pin unchanged behaviour (completed and ready jobs; an inactive manager), as do `indent-deposits.test.ts`' new and re-pinned tests: 17 failures in all. |
| Stripe payments are Stripe's word only (Phase 14 step 1; D150, D153, D155, D157–D159; DATA-MODEL §19) | `stripe-payments.test.ts`, with pending payments inserted as the owner (step 2's Checkout RPCs stand in later) and events from `tests/fixtures/stripe.ts`. **Who can reach it:** anon, a mechanic, the manager and the admin get 42501 from `record_stripe_event` and `record_stripe_read`; the admin cannot insert, update or delete any of the three tables; a mechanic reads payments and matched refunds but not unmatched refunds or events, the admin reads all three, a linked customer reads none and anon is refused. **Provenance (D153):** a rejected delivery of a paid body leaves the payment pending, stores no payload and no event id; a verified call without an `evt_` id, a boolean livemode or an object body is 22023. **The guards, for the owner too:** marking a payment paid, changing its amount, deleting it, inserting it paid, citing an already decided event or moving the citation alone are `payment_immutable`, while `checked_at` alone changes; a refund cannot be deleted, change its amount, go down in rank (even citing a received event) or be inserted without a received event (`payment_refund_immutable`). **Paid in exact cents:** a completed paid session sets paid, `paid_at` = the event's `created`, `amount_received` 120.00, the payment intent and `checkout_completed_at`, cites the event, and writes one `payment_received`; `amount_cents` is 12000, 12001, 99999999 and 50 for 120.00, 120.01, 999,999.99 and 0.50, and 0.49 and 1,000,000.00 are refused. **Mismatch recorded, never refused (D159b):** 11999 cents, `usd`, 12000.5 and the string "12000" are each paid with `paid_amount_mismatch` and `amount_received` 119.99 or null, and each is flagged `amount_mismatch` by step 2's `payment_issues`. **Replays:** the same `evt_` twice is a duplicate with `delivery_count` 2 and no change; a second Event object for the same change is `already_paid`, with one timeline entry. **Out of order:** async succeeded before completed (unpaid), expired after paid, completed (unpaid) then async failed (processing, then failed), async failed then completed, paid after expired (`expired_at` kept) and after failed, an open read (`still_open`), and `refund.updated` (succeeded) before `refund.created` (pending). **Refunds (D155, D159c):** pending counts nothing; succeeded 50.00 → partially refunded; a second 70.00 → refunded (full); the first failing afterwards → partially refunded, 70.00, `payment_refund_failed` and the `refund_failed` issue (none before it), which neither a canceled refund nor a stale snapshot clears; canceled never counts; a stale succeeded after failed changes nothing; each row keeps Stripe's `created`. A refund before its payment is kept unmatched (admins only) and adopted by the completion in the same update, with both timeline entries; an over-refund (130.00 of 120.00) is recorded and flagged `refund_exceeds_payment`. A refund whose event is in live mode for a test payment (`livemode_mismatch`, also on its later `refund.failed`) or whose currency is USD (`currency_mismatch`) needs attention, is kept and linked, and is never netted (the payment stays paid at 0.00 and cites its completion until an SGD 20.00 refund makes it partially refunded); a USD and an SGD refund that arrive before their payment are both adopted by the completion, and only the SGD one counts (40.00); in both cases the uncounted USD refund is flagged `refund_not_counted`. **Identity:** unknown payment (attention when paid, ignored otherwise), another session, another mode, not ours, `charge.refunded` and `charge.dispute.created` (stored as projections), `no_payment_required`, malformed sessions and refunds, and a refund without a payment intent change nothing; the checks run in the order of spec 2.5 step 6: another session wins over another mode and payment intent (`session_mismatch`), another mode over another payment intent (`livemode_mismatch`), and another payment intent alone is `session_mismatch`. **Projection (D159e):** customer details, emails, URLs with the quote token and foreign metadata are never stored; ids, amounts and `bicii_*` metadata are, with the raw body's SHA-256. **Evidence (D88):** one row per bad body with a delivery count, 17 headers capped to 16 plus the marker, a later verified delivery of the same id accepted, events immutable for the owner, no row left `received`; with a committed transaction, the owner's commit of a row still `received` is refused by the deferred `stripe_events_settled` (`stripe_event_immutable`) and leaves nothing, `SET CONSTRAINTS … IMMEDIATE` raises at once, and a row decided in the same transaction passes; the purge refuses under 30 days and deletes only aged rejected rows. **Reads (D159a):** a read pays a pending payment at the read time (`paid_at` between the database clock read just before and just after the call, D159d) with an `api_read` row; a second read is `already_paid` with new evidence and a later `checked_at`; a refund read records the refund; another session or payment intent is `read_mismatch`; a non-session, a bad id, an unknown payment and a null object are refused; a PaymentIntent read (R-086) of a payment completed unpaid, after its session read stays `already_processing`, records `processing` as nothing new and `requires_payment_method` or `canceled` as `payment_failed` (a `read.payment_intent` row whose stored copy drops `last_payment_error`), then `already_failed`, and `stale` once a later paid event wins; an open Checkout's payment (no intent), another intent and the other mode are `read_mismatch`, an unknown intent status `object_invalid`, and a malformed id 22023. A refund's `status_changed_at` moves only with its status (`payment_refund_immutable`). **D154:** a paid, partly, fully and failed-refunded balance payment on a completed job with a service and a part line leaves `financial_lines`, `report_lines`, both totals views, `work_order_yield`, `daily_summary`, `report_period_summary` for every basis, the job's status and stamps and the line, sale and refund counts unchanged. **Concurrency** (committed, its own database; each case holds the first call's locks in an open transaction and proves the second waits on a lock in `pg_stat_activity` before committing the first, `tests/db/lock-race.ts`): the same `evt_` on two connections (the second waits on the dedupe key: one applied, one duplicate, one timeline entry); a refund and the completion in either order (waits on the payment intent's advisory lock; partially refunded, 50.00); a webhook and a read of the same session in either order (one transition, `payment_paid` then `already_paid`); a paid webhook and cancelling the job in either order (waits on the job; both commit, the money is recorded and flagged `paid_job_cancelled`). |
| Closing indent items (D149a, D149b, D149c; `20261014000900`; DATA-MODEL §5 "Closing indent items") | `indent-close.test.ts` (24; the first 23 were written first and all fail with `20261014000800` and `20261014000900` moved out; the cost race below, added after review, fails when the product is read without its row lock). **Bought outside BICII:** an approved, never-ordered part (2 × 45.00, cost 70.00) bought at 30.00 at a new location with a reference writes exactly two movements there, +2 `outside_purchase` (30.00, `request_id` = the line id, the job, reason "Bought outside BICII for J-… (Bike Hub receipt 4471)", the admin) and −2 `job_consumption` (30.00, the line); on-hand stays 0; one line at price 45.00, cost 30.00, `cost_pending` false, yield 30.00 and Cult Commons by the usual formula; the request fitted and linked to the movement; the product's cost 30.00 with one `cost_changed` (`{}`, that reason, the admin); `part_fitted` with `bought_outside: true` and the reference; no event payload or movement reason holds 30.00 or 60.00. A product at 25.00 with an earlier line at 25.00: the new cost 30.00, the new line 30.00, the old line and its movement still 25.00. No product cost: Fit from stock is `part_cost_missing`, bought outside sets it. The same cost writes no `cost_changed`; 0.00 is a cost (yield 90.00). Replay by line id writes nothing (the cost passed is ignored); another line id, or a request fitted from stock, is `part_request_fitted`; a line id already used is `part_request_conflict` and writes nothing. Refusals write no movement, line, event or cost: ordered (not arrived and arrived) `part_request_ordered`; an approved service `outside_purchase_part_only`; proposed, quoted, declined and cancelled `part_request_not_approved`; a job completed before the guard `work_order_locked`; −0.01 and 100000.00 `outside_purchase_cost_invalid`; 101 characters `outside_purchase_reference_too_long`; null cost 22004; an unknown request P0002; an inactive location `location_inactive`; inactive and archived products. mechanic2 gets 42501 (even for an unknown request), mechanic1 (view_costs) and mechanic2 with Manage purchasing record; anon has no EXECUTE. **Reconciliation:** `report_stock_reconciliation` and `operational_exceptions` report nothing for the product; `stock_adjustments_on`, `daily_summary`'s adjustment counts and `report_activity`'s adjustments and purchase counts are unchanged while parts consumed rise by 2; `is_significant_adjustment` is false for the type; the control fit from stock at 0 gives `negative_on_hand` and one `negative_stock`. Voiding the line: a +2 `reversal` at 30.00, on-hand 2, the receipt kept, the request approved again with its line and receipt link cleared (D160; it read "still fitted" before `20261014001100`). **Backstops (owner inserts):** a negative, jobless or costless `outside_purchase` is 23514 `inventory_movements_outside_purchase_shape`; on a consigned product `consignment_stock_adjust_blocked`; the link on an approved request 23514 `job_part_requests_outside_purchase_shape`, on a second request 23505 `job_part_requests_outside_purchase_key`. **Access:** mechanic2 reads the link but not `unit_cost_snapshot` (42501) and nothing in `inventory_movement_costs`; mechanic1 and the admin read 30.00 there; anon 42501. **Concurrency** (committed, `lock-race.ts`): bought outside then ordering waits and gets `part_request_not_approved`; ordering then bought outside waits and gets `part_request_ordered`; never both a PO line and a receipt; a stock fit then bought outside gives one line and no receipt; bought outside at the stored cost (30.00) then a direct cost edit to 35.00 (the admin's UPDATE, as the product page) waits on the products row, leaving the receipt, the `job_consumption` and the line at 30.00 and the product at 35.00, and the edit first makes bought outside wait, read 35.00 and set 30.00, with all three at 30.00 (without the row lock the line and its consumption took 35.00 against a 30.00 receipt). **The guard:** for each of the 11 statuses an approved request inserted as the owner after `walkTo`, all 110 pairs through `set_work_order_status` (mechanic2) and as direct owner UPDATEs: invalid pairs still `work_order_transition_invalid`, blank reasons `reason_required`, moves into open statuses succeed and the 12 moves into completed, ready, collected and cancelled are `work_order_has_unfitted_requests`. Complete is refused for approved and ordered (not arrived and arrived) parts and an approved service, with "Fit or cancel each approved or ordered item first.", and allowed for proposed, quoted, declined, fitted and cancelled. A live line and an approved item cancel as `work_order_has_lines`, a blank reason as `reason_required`, and without lines the cancel's own sentence; Waiting on parts, back and ordering's move are allowed; a job completed before the guard still reports the invalid cancel as such and reopens. Completed before the guard: Ready and Collected refused until mechanic2 cancels both items, then Collected; or reopen, fit both and complete. Collected before the guard (J-000002): the manager cancels both and the job stays collected. **The quote:** Complete (as mechanic2) withdraws the open quote (`withdrawn_by` mechanic2), both items back to proposed, `completed` then `quote_withdrawn` on the timeline, the link `{status: withdrawn, job_number}` and an answer built before `quote_not_open`; a reopen leaves it withdrawn and a new quote can be sent; Cancel job withdraws it (the admin); an answered quote and a job with none are untouched; an owner UPDATE with no session leaves `withdrawn_by` null; the migration's one-off block, read from the file and run again, withdraws the quotes left open on jobs completed and collected before the guard (no actor, items to proposed) and leaves an open job's. **Race** (committed): the answer first makes Complete wait and refuse; Complete first makes the answer wait and get `quote_not_open`; never a completed job with an approved or ordered item. `indent-parts.test.ts` and `indent-deposits.test.ts` build the jobs that closed with approved or ordered items, or with an open quote, before the guard through `beforeTheGuard` (`tests/db/indent-fixtures.ts`: the two triggers off for the transaction); the open-job paths (`paid_job_cancelled`, the payment totals once closed) now cancel the items first. |
| Voiding a fitted indent line undoes the fit (D160; `20261014001000`, `20261014001100`; DATA-MODEL §5 "Voiding a fitted indent line"; R-083) | `indent-unfit.test.ts` (17: 15 written first, before either file existed, when 14 failed; 2 added in review; with `20261014001100` moved out 16 fail and only the negative case passes). **The un-fit:** a part fitted from stock (2 × 45.00, cost 70.00) and voided by mechanic2 goes back to approved with its line, `fitted_at`, `fitted_by` and `outside_purchase_movement_id` null; the product's movements are the void's ordinary `job_consumption` −2 and its linked `reversal` +2 at 70.00, on-hand 2, the job's live total 0.00; the timeline after the void reads `line_voided`, `part_request_unfitted`, `stock_reversed`, the new entry `{request_id, line_id, description, quantity 2, status approved, bought_outside false}` by mechanic2, no price or cost in any payload. Fitted again from stock it bills 90.00 again (a new line, cost 70.00); voided again and cancelled, the job completes. An ordered part (received at a new location) goes back to ordered with its purchase order line and `ordered_at`, arrived there and reserved for the job again, and Fit takes it from there. An ordered part fitted from the shop floor's stock before its order was received goes back to ordered and not arrived (`part_request_arrivals` `arrived` false with no location, no `indent_reservations` row) until the order is received, then arrived there and reserved. A part bought outside BICII goes back to approved without its receipt link; the `outside_purchase` row stays (its `request_id` the voided line), the reversal leaves 2 in stock, the product's cost stays 30.00, and a re-fit adds only a −2 `job_consumption` at 30.00 (on-hand 0). A fitting service goes back to approved with no movement and is added again. **Negative:** voiding the same part added by hand, a manual line and a service line changes no request (rows equal, `updated_at` included) on this job or another, and writes only `line_voided` and `stock_reversed`. **Replays:** a second void returns the line and writes nothing; a stale Fit with the voided line's id is `part_request_line_voided` and bought outside with it `part_request_conflict`, both writing nothing; after a re-fit, the first void replayed leaves the new fit alone and a Fit replay with the new line still answers it; an owner UPDATE linking a request to a voided line, or an owner INSERT of a request already linked to one, is `part_request_line_voided`. **Every writer:** a void written directly by the owner (an UPDATE of `voided_at`, no `void_line`) un-fits too: with the admin's session the part goes back to approved with its line, `fitted_at`, `fitted_by` and `outside_purchase_movement_id` null, the full payload with the admin as actor, the timeline reads `line_voided`, `part_request_unfitted`, and no stock movement is written (only `void_line` reverses stock); with no session an ordered part goes back to ordered with its purchase order line, and no actor. **What sees it:** Complete and Cancel job are `work_order_has_unfitted_requests` after the void (the RPC and an owner UPDATE) until it is fitted again or cancelled; the memo counts it (any staff member; anon 42501); the quote page's `parts_ordered` is false again for an approved part and stays true for an ordered one; with a paid deposit and the job completed anyway (guard off), `paid_parts_not_fitted` reads "$45.00 is held for parts that are not on this job…", cleared by reopening and fitting. **Who:** mechanic2 un-fits a bought-outside fit by voiding it; a signed-in non-staff user and anon get 42501 from `void_line` and the request stays fitted; the manager cannot write a request (42501); no API role executes the three new private functions. **The one-off** (the migration's block run again, the trigger off to build the old state): an open job with the part added again by hand, a completed job with a paid deposit (unflagged before) and a collected job with an ordered part are un-fitted with no actor, a live fit is untouched, and an open job with two requests for the same part (the first fitted and voided before D160, the second fitted after the void) and that part on a line from before the void has its first request un-fitted but is not counted as added by hand (each of the two exclusions, a line from before the void and another request's line, is needed: without either the count is 2); the NOTICE reads "D160 one-off: 4 fitted indent request(s) whose line was voided went back to approved or ordered; 2 of them on jobs that are not open, 1 on a job with a live line of the same item added after the void (check whether it was added by hand)."; the completed job is then flagged, in the memo, and Ready and Collected wait until it is cancelled; the collected job's ordered part is closed by D149's cancel (the manager; a mechanic gets `work_order_closed`); run again it reports 0 and writes nothing. **Races (committed):** a void against Complete (the void first: Complete waits and is refused; Complete first: the void waits and gets `work_order_locked`) and a void against cancelling the item (the cancel waits, then cancels the approved item), never leaving a fitted request on a voided line or a closed job with an approved item. |
| Indent deposits in Postgres (Phase 14 step 2; D151, D152, D154, D157, D158, D159b; DATA-MODEL §5 "Indent deposits", §19) | `indent-deposits.test.ts`, with quotes from `tests/db/indent-fixtures.ts` at a percent set as the owner, deposit payments created through `record_deposit_checkout` as the service role and moved only by Stripe events (`tests/fixtures/stripe.ts`). **The setting:** 0 by default; the admin's setter returns 0, 50, 100 and 37, the same value writes no `schedule_events` row and a change writes one `{indent_deposit_percent: {from, to}}`; -1, 101 and null are `deposit_percent_out_of_range`; the manager, mechanic2 and anon get 42501, and so does a direct UPDATE as the admin. **The snapshot:** sent at 50% keeps 50 after the setting moves to 30; answering 2 × 120.00 plus a 25.00 service gives 120.00 (not 132.50); a declined part, percent 0 and only services give none; 33.33 → 16.67, 0.99 → 0.50, 0.80 → none; a USD quote gets percent 0 and no amount; a quote with a null percent (sent before step 2) answers with none and is ordered freely; an owner update of either column after answering is `quote_deposit_immutable`. **The quote page:** twelve keys; `on_answer` while open, then `due` 120.00 with `parts_ordered` false, `processing` (completed unpaid), `paid`, still `paid` when partly refunded, `refunded`; `parts_ordered` true once an admin orders the part with a reason (still `due`) and once it is fitted; no cost, contact, Stripe id or URL; null on a cancelled job, when every part is cancelled and at 0%; withdrawn and expired quotes keep two keys. **`prepare_deposit_checkout`:** service role only (anon, the admin and a mechanic 42501); unknown and malformed tokens `quote_not_found`; open and depositless quotes `deposit_not_due`; `create` with 120.00, 12000 cents, SGD, a fresh payment id per call and an expiry about an hour ahead; then `check` with the recorded session, `processing`, `paid` and `refunded`; `deposit_job_closed` and `deposit_parts_cancelled`. **`record_deposit_checkout`:** service role only; `created` with a pending row (amount, cents, mode, session, expiry); a replay `existing`; the same id with another session, or the same id and session replayed for another quote, `checkout_session_conflict`; another attempt while one is pending `existing` with the first; no timeline entry; a direct second pending deposit is 23505 `payments_one_open_deposit`; 13250 cents, `usd`, a wrong payment, quote or client reference, a complete or expired session, an expiry more than 61 minutes ahead, a string `livemode` and a malformed id are `checkout_session_mismatch` and leave no row; a paid quote answers `paid` and records nothing. **The D152 gate:** with the deposit due, the admin without a reason or with blanks gets `deposit_unpaid`; mechanic2 with manage_purchasing gets 42501 with a reason and `deposit_unpaid` without; 501 characters are `reason_too_long`; the manager orders with a reason, recorded trimmed as `deposit_override {reason, quote_ids}` with the manager as actor, and a replay returns the order; paid and partly refunded deposits order without a reason and record nothing, fully refunded and processing ones are `deposit_unpaid`; 0% is never gated and an unneeded reason is not recorded; a replay after a full refund still returns the order; an unapproved request is `part_request_not_approved` first; ordering a paid and an unpaid job together records the override on the unpaid job only; an approved part in stock is fitted while its deposit is due. **The views:** a mechanic reads `quote_deposits` (state, part ids); a linked customer reads none of the three views and anon is refused; `payment_issues` raises and clears `paid_job_cancelled` (cleared by a full refund), `paid_parts_cancelled` (its sentence with the amount held as the screens print money, $120.00 then $70.00), `paid_twice` (an expired session paid after another; cleared by refunding it), `amount_mismatch` ("Stripe received $119.99, not the $120.00 asked."), `refund_failed` (cleared by a later succeeded refund; also raised when refunds pending, succeeded and then one failed were all decided before the completion adopted them, ordered by each refund's own `status_changed_at`), `refund_exceeds_payment` and `pending_unconfirmed` (warning, "Press Check with Stripe" before Checkout completed and "look the payment up in the Stripe Dashboard" after it; cleared when Stripe expires it); `work_order_payment_totals` shows 120.00 paid ahead with a 0.00 job total (equal to `work_order_totals`) and no balance once collected or cancelled. **Exceptions (D108):** an amount mismatch is one `payment_attention` row (job number, the sentence) for the admin and the manager, none for mechanic2; a `payment_not_found` event and a `not_recorded` delivery are `stripe_attention` for the admin only, and the second clears once the retry of the same body is stored; `report_exception_counts` and `today_dashboard(null).exceptions_now` agree with the list per caller; a full refund clears the payment row; a linked refund in another currency is one `payment_attention` row (`refund_not_counted`) and no `stripe_attention`; so is a succeeded refund from the other mode (`livemode_mismatch`), while a failed refund in another currency, a canceled one from the other mode and an other-mode event about a refund stored in the payment's mode (counted) are each one `stripe_attention` row and no payment issue, and a pending refund in another currency moves from `payment_attention` to `stripe_attention` when it fails, one row for its created and failed events and a *Check with Stripe* read of it (three events needing attention; listed once, never dropped); and three events about one failed refund backdated 40, 10 and 2 days give one row dated from the 10-day one (the earliest in the 30-day window: not the newest, and not hidden by the one outside it; the test fails if the comparison is reversed or the window is dropped from the dedupe, checked once by hand). **Concurrency** (committed, its own database; each case proves the second call waits on a lock before the first commits, `tests/db/lock-race.ts`): two `record_deposit_checkout` calls for one quote (the second waits on the job: one created, one existing with the first's id, one pending row); ordering without a reason while a paid webhook still holds the job waits and then orders (a gate read before the lock would refuse it); a paid webhook while an override order holds the job waits and is then recorded, with one `deposit_override`; `record_deposit_checkout` and cancelling the part in either order (created then cancelled, or cancelled then `deposit_parts_cancelled`). `operational-exceptions.test.ts` counts `integration_failed` rows by kind and checks the visibility of the two kinds (admin both, manager `payment_attention` only, mechanic2 neither); `customer-access.test.ts` adds the three views to the customer's zero-row list. **Parts never fitted (R-082, D149, `20261014000700`):** a paid deposit raises nothing while the job is open; completing gives `paid_parts_not_fitted` (danger, "$120.00 is held for parts that are not on this job. Reopen the job to fit them, or cancel them and refund in Stripe.", the same when ready, dated from the later of completion and payment); reopening clears it, and fitting then completing leaves none (job total 240.00, balance due 120.00, `held_over_total` 0.00). An ordered part on a collected job reads "…that never went on this job. Cancel them and refund in Stripe, or agree with the customer how it counts.", following a partial refund ($70.00); the manager's D149 cancel turns it into `paid_parts_cancelled`, and the rest of the refund clears it. On a completed job a mechanic's cancel and a full refund clear it; a cancelled job has `paid_job_cancelled` only; a refunded deposit raises nothing. One quote at 100% approving two parts at $60.00 ($120.00 paid), one fitted: "$120.00 is held; $60.00 of it is for parts that are not on this job. Reopen the job to fit them, or cancel them and refund that share in Stripe." with job total 60.00 and paid ahead 60.00, "…never went on this job… refund that share…" once collected (`held_over_total` 60.00); the manager's cancel of the unfitted part clears it without `paid_parts_cancelled`; on a second such job refunds of $30.00 give "$90.00 is held; $30.00 of it…" and then nothing, the part still approved. Two quotes on one job, each with a paid $120.00 part, the first fitted: only the second payment has the issue, until its part is fitted after a reopen. `held_over_total`: 120.00 open (with paid ahead), 120.00 once collected while `balance_due` and `paid_ahead` are null, 70.00 then 0.00 after refunds, 120.00 on a cancelled job, readable by a mechanic. The quote page's `job_closed` is false while open, true once completed (`{percent, amount, status, parts_ordered, job_closed}`), still 12 keys, no cost, and an open quote's deposit keeps three keys; the earlier deposit-key tests now pin `job_closed: false`. Exceptions list the collected job's issue once as `payment_attention` for the admin and the manager (not mechanic2), with the count agreeing, until the cancel and refund clear it. |
| Counter payments are an admin's record, append-only, and count (Phase 14 step 3; D161a–j; `20261014001200`, `20261014001300`; DATA-MODEL §5 "Indent deposits", §19) | `counter-payments.test.ts` (34: 30 written first, all 30 failed before the migrations with `type counter_payment_method does not exist`; 4 added by the review, two failing before its fix and two pinning built behaviour, mutation-checked). **Who:** an active admin records and voids; the manager, a mechanic and a customer get 42501, anon cannot execute; staff read both tables but not `request_fingerprint`, customers 0 rows, anon 42501; no API role writes, and the owner cannot update or delete a row (`counter_payment_immutable`). **The record:** the row, trimming, the timeline payload's keys (no reference or note); a NULL time replays and is fingerprinted as NULL, not as the stamped time, and the stamped instant conflicts; "200", "200.0" and "200.00" replay; any other change, or the same id on another job, is `counter_payment_conflict`; a replay is answered before every other check. **Refusals:** 22004, 23514 by constraint, 22P02, P0002; cancelled, USD; completed, ready and collected allowed; the 5-minute, check-in, quote-answer and 30-day bounds. **Deposits:** a counter deposit makes the deposit paid with its id, opens D152's gate, and the quote page and both deposit Checkout RPCs say paid; another job's quote, a random quote, no deposit, an open quote, none, processing, paid online or at the counter, and a wrong amount are refused; each void kind puts it back to due (Pay offered, the gate closed); a Stripe-refunded deposit goes paid, then refunded again after the void. **Stripe:** `open_checkouts` counts only open sessions of a balance or this quote's deposit; `counter_payment_stripe_processing` while Stripe is confirming. **Views:** `work_order_payment_totals` for every job (staff), none for a customer, anon 42501; every new `payment_issues` kind derives live and clears, reaches admins and managers (not mechanics) once as `payment_attention`; `paid_above_bill` sits on the newest paid Stripe payment when Stripe alone took more than the bill once a balance payment is paid (a refund clears it; a balance still pending opens nothing), and is left out beside `paid_twice`, `paid_online_and_counter` and a deposit held for cancelled parts (Stripe or counter, with a Stripe balance or counter money beside it) or unfitted parts (a job closed before D149b), until that deposit is refunded or given back; "the database reads as before": the merged 0500/0700 view text loaded as temporary views equals the new views on every pre-existing column, both ways. **Races** (`tests/db/lock-race.ts`, committed connections): a replayed id for a balance and a deposit (one row, one event, the second `replayed`); two deposits on one quote (the second `deposit_already_paid`); another job's quote refused without waiting on its locks; an order waiting for a counter deposit, then for its void; the same void twice; the same id for two jobs at once (the second waits on the first's row, then `counter_payment_conflict`, nothing written). Mutation checks: three in the build (one combining replay-after-checks with a fingerprint of the resolved time) and eight in the review (no skip beside a cancelled-parts deposit, in either branch; none beside unfitted parts; the gate without its balance half, or counting a balance in any status; not only the newest payment; no `on conflict` (23505); NULL resolved to the minute), each caught. |
| Balance links pay the live balance, once per job (Phase 14 step 3; D156a–h; `20261014001400`; DATA-MODEL §19) | `balance-links.test.ts` (36: 33 written first, all 33 failed before the migration; 3 added by the review). **Who:** any active staff member sends; a customer 42501; anon and the service role cannot send; staff read every column but `token_hash`; customers 0 rows; no API role writes; the guard refuses a delete and any change but each withdrawal column once; the three shape CHECKs and the deferred self-reference. **Send:** a 43-character token whose SHA-256 is stored, the live amount net of counter money, 7 days, the sender and payload keys; ready allowed; validity, nulls, P0002, not ready (received, in progress, collected, cancelled), USD, a used id on the same and another job, too small at 0.40, 0 and paid ahead, too large, processing. **Withdrawal:** a resend (replaced, `replaced_by`, `replaced_link_id`, the timeline sent, withdrawn, sent), ready keeps it, Collected and a reopen withdraw it, completing again does not revive it. **The page:** twelve keys and every value pinned, the line keys pinned, live at every read, the two-key form for withdrawn, expired and closed links, null for unknown, malformed, empty and null tokens, and the leak test (no serial, unit short id, bike serial, voided line, uuid, Stripe id or URL); a unit line whose description does not carry its short id shows the product's current name, never the rest. **Prepare and record:** every outcome (`processing`, `replace` for a live deposit session, another link and an old amount, `check`, `nothing_due`, `create`), replay and conflicts, seventeen echo variants refused as `checkout_session_mismatch`, `stale` after a counter payment, the reverse direction (a live balance makes the deposit RPCs answer `replace` and `existing`; one Stripe is confirming, `job_payment_processing` and `existing`, after `deposit_job_closed` while the job is closed; a linked row past its expiry holds up nothing). **Races:** two records on one job (one created, one existing), the same link id twice, a send or a reopen against a record, a record against a counter payment, the same link id for two jobs at once (the second `balance_link_already_sent`, its job's live link untouched). Mutation checks: eight in the build and four in the review (no `on conflict` (23505), no `job_payment_processing`, the deposit replacing a row past its expiry, the old cut), each caught. |
| Payment reports are money moved, never sales (Phase 14 step 3; D154a–e; `20261014001500`; DATA-MODEL §14) | `payment-reports.test.ts` (19: 18 written first, all 18 failed before the migration; 1 added by the review, failing before its fix). **Access:** definer, `search_path`, no float, EXECUTE for authenticated only; the view readable by no API role; admin and manager read all three with pinned columns; mechanics, a customer, anon and inactive staff 42501; a mechanic granted View financial reports reads them; range refusals after the permission check. **Dates:** edges of the shop day on both sides for online and counter rows; pending, processing, expired and failed payments are not movements; refunds counted as the card counts them, on Stripe's day or BICII's when Stripe sent none; voids recorded in error restate, given back adds a negative movement on the void's day, or one microsecond after its payment when the void is stamped before it (the same shop day; pages of one row still meet). **The identity:** per job over all time, online − refunds + counter − given back = `net_paid`, across partial and full refunds, a refund without Stripe's time, both void kinds, Stripe taking another currency, a short payment and a balance paid by Checkout. **Summary, items, held now:** every figure, the item count equal to the summary's counts, keyset pages that meet exactly, the three disjoint held groups equal to the job card. **Not sales:** the period summary on all four bases, the daily summary and job totals unchanged. Also extended: `stripe-payments.test.ts` "D154" (the sales snapshot is unchanged after a counter payment, a void of each kind and a balance paid by Checkout, and `report_payment_summary` for the day), `period-reports.test.ts` "Report queries are indexed" (the five payment date columns), `customer-access.test.ts` (the three new tables read 0 rows; the counter, link and payment-report RPCs 42501 for a customer) and `meta.test.ts` (above). Mutation checks: twelve in the build and two in the review (the give-back at `voided_at`; at its payment's own instant, which ties the keyset), each caught. |
| Anonymous sees public appointment types only (PLAN Phase 2, D37) | `appointment-customer-access.test.ts`: as anon, `public_appointment_types()` lists active public types only, with exactly `id, name, description, duration_minutes` (no capacity units); `public_shop_hours()` the active weekly rows in order; `available_slots` works for a public type and is empty for a non-public one; every staff, admin and my_* appointment RPC and every appointment and schedule table → 42501. |
| Mechanic permission boundaries | staff without `view_costs` cannot select cost columns; without `adjust_stock` cannot call `adjust_stock`; admin can. Phase 3: mechanic2 `select cost_total` / `unit_direct_cost_snapshot` / `cult_commons_share` / `*` on `work_order_line_items` → 42501, `work_order_line_items_staff` and `work_order_totals_staff` → 0 rows, `work_order_totals` → sale columns only; mechanic1 sees costs, yield and Cult Commons. |
| Consignment sale yields correctly | $1,000 sale, $500 owed → yield 500, CC 150. Built in Phase 6 step 2: `sales.test.ts` "Consignment sale creates correct liability and yield" (cost 500.00, yield 500.00, CC 150.00, payout 500.00, liability 500.00, item sold with one active→sold event, no settlement written; a 120.00 shop charge → 620.00 / 380.00 / 114.00; a 45.00 consignor charge leaves the line and lowers owed) and the seeded S-000003 in `consignment-reporting.test.ts`. |
| Cult Commons rate snapshot | insert a new rate effective tomorrow; lines today use 0.30, lines after use the new rate; old lines unchanged. Phase 3 (`work-order-lines.test.ts`): a rate scheduled for tomorrow leaves today's lines at 0.30; an owner-inserted 0.25 rate effective now gives the next line 0.25 while the earlier line keeps 0.30. |
| Cult Commons is 30% of positive yield after direct costs (SPEC §10, D1) | every row of `tests/fixtures/cult-commons.ts` through `add_manual_line` equals the generated columns (rates other than 0.30 through an owner-inserted rate row), and both job fixtures equal `work_order_totals_staff` (the D1 job: 180.00, not 171.00); the same table runs through `src/lib/cult-commons.ts` in the unit project. |
| Cult Commons rates are effective-dated and append-only (D21) | `workshop-catalog.test.ts`: the base 0.3000 row from 1970 ships with the migration; `cult_commons_rate_at` at, just before and before any rate (`cult_commons_rate_missing`); UPDATE/DELETE refused for the owner too; schedule/cancel admin only (view_costs is not enough), never backdated (`rate_backdated`), duplicate start 23505; cancelling a future rate restores the previous one, replays, frees its start time; a rate in effect cannot be cancelled (`cult_commons_rate_in_effect`), not even by the owner, and nobody un-cancels. |
| Services' costs are gated (SPEC §4.2, D14) | mechanic2: `select default_direct_cost` / `select *` from `services` → 42501, `services_staff` → 0 rows; mechanic1 and admin read costs; create/update/archive need manage_inventory; a cost needs view_costs (null on update keeps it); a manage_inventory holder without view_costs making `update_service` fail a check (negative price, blank or long name, long description) gets 23514 with the constraint and no DETAIL, never the stored cost; replay by id, `service_conflict`, `category_kind_mismatch`, active-name uniqueness and reuse after archive; categories: staff read, manage_inventory writes. |
| Work order status machine (D15, D16) | `work-orders.test.ts`: `private.work_order_transition_rule` equals `transitionRule` (src/lib/workshop.ts) for all 121 pairs; `set_work_order_status` accepts exactly the allowed 110 off-diagonal pairs (a fresh job driven to each from-state, each move tried in a rolled-back savepoint) and refuses the rest with `work_order_transition_invalid`; reason-required moves refuse a blank note; the trigger alone (the owner's direct UPDATE, which the RPC's own checks never reach) refuses the same 110 pairs the same way and a reopen or cancel without `private.set_change_reason` (`reason_required`); the 11 same-status calls are replay no-ops (row unchanged, no event); reopen needs a reason, clears completed_at/ready_for_collection_at, keeps started_at and the earlier `completed` event; cancel needs a reason and no live line (`work_order_has_lines`, also for the owner); stamps, number, customer, bike, check-in time and lead are immutable without the proper path (`work_order_immutable`); `appointment_id` is linked at most once (D40, with real checked_in appointments: null → a value succeeds once with nothing else changed and exactly one `appointment_linked` event (created false), leaving it equal is a no-op, another appointment, a random id or null → `work_order_immutable`, also when `private.create_work_order` stored it at check-in with `checked_in` then `appointment_linked` (created true)); backwards `status_changed_at` is 22023. |
| Check-in is atomic and replay-safe (SPEC §2, §7.1) | `create_work_order` writes the job (J-######, increasing), `checked_in`, assignment and `line_added` events in that order with actor, auth user and the request's correlation ID; a bad service line rolls everything back and the burned number is never reused; replay by id returns the same row with no new event, line or assignment, even after the bike changed hands, the customer was archived and the job completed (and burns no number); another bike under the same id → `work_order_conflict`; archived customer/bike, D18 `bike_owner_mismatch` (shop bikes accepted), blank requested work, customers and inactive staff refused; no direct writes. |
| Timeline events carry no costs (SPEC §7.3, §4.2) | one event per action with its documented payload; no-ops write nothing; `add_work_order_note` replays on its note id (same event back, `note_conflict` on another job); `set_approval_flag` with a null note keeps the stored note, '' clears it; after a full scenario with a manual line costing 62.00 (sold at 95.00), a recursive walk of every payload finds no key matching /cost\|yield\|cult\|commons\|rate/i and no value equal to 62, while 95 appears; `work_order_events` refuses UPDATE/DELETE for the owner (`work_order_history_append_only`); `work_order_timeline` names actors and assignment subjects, newest first, clamps max_rows to 1..2000. |
| Assignments (D22) | one active lead per job; a new lead closes the previous lead's row (not demoted); additional → lead switch; replay no-op; unassign returns null on replay; `staff_inactive`; `work_order_closed` on collected/cancelled jobs; `lead_mechanic_id` equals the active lead after every operation; rows are immutable except closing once (`assignment_immutable`). |
| Job photos are never public (D19) | `record_attachment` on a job writes `photo_added`; `delete_attachment` writes `photo_removed` with the reason; unknown job P0002; `product` and `inventory_unit` accepted from Phase 4 and `consignment_item` from Phase 6 (unknown → P0002); public via `record_attachment` or `set_attachment_visibility` → `attachment_work_order_never_public`; CHECK `attachments_work_order_never_public` exists. |
| Lines (D14, D15) | `work-order-lines.test.ts`: sale-price overrides by anyone, cost overrides only with view_costs (42501); a manual line with no cost (mechanic2's always, an admin's left empty) is `cost_pending` with cost 0 while one with cost 0 entered is not, `work_order_totals_staff.cost_pending_count` counts the live ones and drops a voided one once it is re-added with its cost, the flag is immutable for the owner and the CHECK keeps it to costless manual lines; mechanic2's bad quantity or price on `add_service_line` / `add_manual_line` / `create_work_order` services gets 23514 with the constraint and no DETAIL (the service's cost never appears); inactive/archived service `service_unavailable`; quantity 0/10000/negative price 23514, NaN quantity refused, overflowing totals 22003; lines locked once completed (`work_order_locked` for a new add and for void) and unlocked after reopen; replays of add_* after completion return the original id with no new event; void needs a reason, keeps the row, replays without a second event and leaves the totals; owner edits, un-voids and deletes → `line_immutable`; Phase 4: voiding an inventory line writes its linked reversal and restores stock (`line_type_unsupported` is gone); same line id on another job or type → `line_conflict`; line and service RPCs return ids only. |
| Workshop concurrency (SPEC §25, D18, D22) | `workshop-concurrency.test.ts` (committed, real connections): same-id check-ins → one job, one `checked_in`; a check-in waiting on a bike being transferred fails with `bike_owner_mismatch`; a transfer is still pending (and waiting on a lock in `pg_stat_activity`) while a check-in holds the bike, and succeeds once it commits; two leads at once → one active lead mirrored on the job; a line racing completion is either before `completed_at` or refused with `work_order_locked` (both orders and a free race); same line id twice → one line, one event; two collections → one `collected`; two voids → one `line_voided`. |
| Customer job projection (SPEC §4.2, §23; D8, D17, D19) | `workshop-customer-access.test.ts`, on the seeded jobs: a signed-in customer reads 0 rows from `work_orders`, `work_order_assignments`, `work_order_events`, `work_order_line_items`, `services`, `categories`, `cult_commons_rates`, `work_order_totals` and the three `_staff` views; `my_work_orders` returns exactly their non-cancelled jobs newest first (Tan: J-000001, not the cancelled J-000008) with exactly the documented keys and the coarse status (Priya's diagnosing J-000009 reads `received`, its voided line out of the total); `private.customer_job_status` maps all 11 statuses; `my_work_order_lines` has exactly description, quantity, unit price, total, currency and id, live lines only; `my_work_order_timeline` is check-in plus customer-status changes only (received → diagnosing, notes, approvals, assignments, lines and in_progress ↔ paused add nothing; completing and reopening do) plus customer photos still on the job (internal, re-hidden and deleted ones absent); `my_work_order_attachments` never internal; cancelled jobs and another customer's job return nothing; D17: after a transfer the previous owner keeps the job and the new owner does not see it (also on the seeded Bianchi sale), a job on a bike archived afterwards is still listed; staff without a customers row and archived customers get nothing; anon is refused (42501). |
| Jobs in staff search (SPEC §7.2, §20) | `staff-search.test.ts`: "J-000004", "j000004", "J000004" rank 1.0 with Chloe's Giant as title, "customer · requested work" as subtitle and the job number as short_id; "000004" contains-match at 0.6; at least three characters; cancelled and collected jobs found; the kinds filter keeps jobs in or out; `archived = true` returns no jobs; an unknown kind is 22023 (`supplier` since Phase 4 made `product` known). |
| The seed's timelines read true (TESTING "Seed data") | `workshop-seed.test.ts`: J-000001…J-000009 with their customer, bike, status, lead (= the active lead assignment) and stamps at their exact offsets from check-in; J-000001/J-000002 totals exactly as documented through `work_order_totals_staff`; J-000009's voided line out of its total; exactly one D20-overdue job at seed time (J-000006, through `isOverdue` with `now` pinned to J-000007's check-in, so an existing seeded database that has aged still passes); for every job: events in id order strictly increasing in time, exactly the expected events by type, nothing but J-000007 stamped within 30 minutes of the seed, every trigger-written actor equal to the row's `created_by` / `assigned_by` / `voided_by` and every status change by the job's lead, costed lines added by a view_costs holder, no line event after completion; J-000007 checked in after the Bianchi's `transferred` event. |
| Stock-consuming line consumes once (Phase 4) | `inventory-ledger.test.ts` "a stock-consuming work-order line cannot consume inventory twice": a replay of `add_inventory_line` → one line, one `job_consumption`, stock decremented once, `replayed = true`, also after completion; the same line id with other arguments or on another job → `line_conflict`; concurrent (committed) for a quantity part and a unique unit → one line and one movement, the second call `replayed = true`. |
| Void creates reversal, never deletes (Phase 4) | `inventory-ledger.test.ts`: original intact, one `reversal` with `reversal_of_id`, stock restored, `stock_reversed` and `line_voided` once each, second void a no-op, two concurrent voids one reversal; "voiding is never blocked by publication rules" (photo removed and price cleared after the sale, then reopen and void → unit available, product public). `work-order-lines.test.ts` proves the same through Phase 3's void path. |
| Unique unit cannot be consumed or sold twice (Phase 4) | `inventory-ledger.test.ts`: a unit on a line, written off or held → `unit_not_available`; one unit on two jobs at once → exactly one succeeds; ledger sum per unit in {0, 1}; owner forgeries (a second +1, a location change without a movement, +1/−1 across locations for a sold unit, a linked bike that does not point back, an in-stock unit whose bike a customer owns) → `unit_ledger_inconsistent` at `set constraints all immediate`. Every ledger test ends with `assertLedgerConsistent`. |
| Parts on jobs (D23-D25, D27, D15, D16) | `inventory-ledger.test.ts`: consumption may go negative and shows in `low_stock` with `negative_locations` (also when the total stays positive), manual changes never go below zero; `part_price_missing`, `part_cost_missing`, the default price is `private.selling_price` (unit over product), an override wins, `cost_pending` false; customer-owned stock → `ownership_not_saleable` ("customer-owned stock is never a job part"; consigned parts are `consignment-job-parts.test.ts` since the owner's D27 change); held on add, available after a void, sold at completion with `sold_at = completed_at` (cause `job_completed`); adds and voids on completed or ready jobs → `work_order_locked`; complete → reopen → void (held, no movement, product stays sold, then reversal and public); complete → reopen → re-complete (sold again, one consumption); complete → `transfer_bike_ownership` to the buyer → reopen refused with `bike_with_customer` (unit stays sold, `sold_at` kept, product sold), after the bike returns to the shop reopen → void works (D29); `void_line` on a unit whose bike has a customer (forged) → `bike_with_customer`; cancel with a live part → `work_order_has_lines`, after the void it succeeds; committed races: add vs complete, add vs cancel, two jobs selling a product's last two units at once → `sold`. |
| A consigned unit cannot exist without its consignment item (Phase 6, D9, D45, D50) | `consignment.test.ts`: a unique intake creates a `C-` item, an available consigned `U-` unit (cost = agreed, price = asking), a draft consignment product and one `consignment_received` +1 movement (item, `request_id`, cost snapshot = agreed) and one `received` event; quantity intake (+6, a second item reuses the product); validation (`product_not_consignment`, `consignment_unique_quantity_one`, `consignment_quantity_invalid`, `consignment_tracking_mismatch`, `consignment_received_in_future`, `consignment_product_required`, `consignor_archived`, P0002, 23514 for negative and NaN amounts, 22004, mechanic2 42501); D24: 0 agreed and asking stored as 0; a replayed intake ("500" then "500.00") → one item, unit and movement, other terms → `consignment_item_conflict`, a replay after the consignor is archived returns the item; review fix "intake with a new consignor: one transaction": an intake with `new_consignor` refused (`location_inactive`) leaves no consignor, the retry with the edited name stores the edited name, a double tap returns the same item, another new consignor under the same item id is `consignment_item_conflict`, and an existing consignor with that id and other details is `consignor_conflict` (the same details, email in any case, are accepted); owner inserts fail `inventory_units_consignment_shape`, `inventory_units_consignment_item_ownership` and the deferred FK; ownership and item are immutable. |
| Consigned stock moves only by its own paths (D50, D45) | `consignment.test.ts`: after two items on one product, a job part, a partial return and a transfer keep Σ on-hand = Σ `remaining_qty`; `adjust_stock` (+, −, damaged), an owner `purchase_received` and `create_unique_unit` → `consignment_stock_adjust_blocked`; `write_off_unit` → `consignment_unit_write_off_blocked`; `product_ownership_immutable`; `inventory-split.test.ts` refuses splitting an intake-created product (`ownership_not_saleable`). |
| One selling price (D45) | `consignment.test.ts`: a consigned unit's `private.selling_price` = its asking price before and after `update_consignment_terms`, and `reporting.public_items` shows the same after publishing; a quantity product returns the older item's price, then the newer one's after the older is returned; shop-owned prices unchanged. |
| Terms, charges and history (D4, D45) | `consignment.test.ts`: a new agreed amount needs a reason and writes `terms_changed` with from/to; the unit's cost and price follow; `consignment_item_not_active` after a return; `charge_bearer_required`, `shop_charge_unique_only`, `shop_charge_unit_not_available` while the unit is on a job (add and void), a consignor charge on a sold item, replay by id and `consignment_charge_conflict`, void needs a reason and is idempotent, no other update or delete (`consignment_charges_immutable`), `charge_added` / `charge_voided` events; item identity, short ID and history are immutable. |
| Consignors (D47, D48) | `consignment.test.ts`: mechanic2 cannot insert; a `manage_consignments`-only member can, and archives one with no active item by a plain UPDATE; `consignor_has_open_items`; `payout_details` 42501; 23505 `consignors_customer_id_key`; `customer_archived`; `consignors_display_name_check`. |
| Agreement photos are internal only (D52) | `consignment.test.ts`: internal works on `consignment_item`; customer or public → `attachment_consignment_internal_only` from `record_attachment` and `set_attachment_visibility`; an owner update with triggers off fails the CHECK; D13 and D19 still hold. |
| Consigned bikes (D51, D29) | `consignment.test.ts` "a consigned bike links a shop bike record both ways; a customer's, archived or already linked bike is refused": link both ways and `bike_id` in the `received` payload; `bike_has_owner`, `bike_archived`, `bike_already_linked`, P0002, `consignment_bike_requires_unique`; `bike_in_stock` while in stock; after a return the link stays, the bike can go to the consignor, and the same record is refused again (RISKS R-020). |
| Partial returns are recorded once (D50) | `consignment.test.ts`: a unique return writes one `consignment_returned` −1 with its `request_id`, unit `returned_to_consignor`, item `returned` with date and reason, `stock_returned` and `status_changed` events, product `archived`; replay no-op; `consignment_item_not_active`, `consignment_return_conflict`, `reason_required`; 2 of 6 replayed → one movement and event, remaining and on-hand 4, item active; `consignment_return_quantity_invalid`, 22004 without a location, `insufficient_stock` at the location; a unit on a job → `unit_not_available` until its line is voided. |
| Consigned job parts (D44, the owner's D27 change; D1, D4, D6/D25, D24) | `consignment-job-parts.test.ts`: a consigned unit is held on add with cost = payout = agreed, item active and nothing owed; completion sells unit and item (`status_changed` with the job context), liability 500.00, line 1000.00 / 500.00 / 500.00 / CC 150.00, BICII after CC 350.00; a 120.00 shop charge → cost 620.00, yield 380.00, CC 114.00, a consignor charge changes nothing; a loss line has CC 0.00; reopen → held, active, liability 0.00; re-completion → 500.00 once; void on the open job → a linked reversal carrying the item, unit available, item active; replayed add → one movement; quantity parts FIFO across two consignors at each item's asking price, an override wins, `consignment_quantity_unavailable`, `insufficient_stock` (no negative consigned stock); customer-owned unit and product refused by `add_inventory_line` and the backstop trigger; `line_consignment_mismatch`; `line_immutable`; D24 zeros accepted, not `cost_pending` (RISKS R-006). Review fixes: a part at a location where the only item with enough stock is elsewhere is `consignment_quantity_unavailable` (D54); a completed job whose consigned part's consignor was settled and archived is not reopened (`consignor_archived`; the job stays completed and the item sold) until the consignor is unarchived (D47). |
| Consignment access (SPEC §23 "Customers cannot read internal notes, costs, yield, consignor or Cult Commons data"; D48, D30) | `consignment-access.test.ts`: a linked customer (also the consignor) reads 0 rows from the four tables and gets 42501 from the five RPCs and the position view; anon has no privilege; mechanic2 reads consignors, items and a line's `consignment_item_id` but gets 42501 on `payout_details`, `agreed_amount_owed`, `request_fingerprint` and `consignor_payout_snapshot`, and 0 charges, events and `work_order_line_items_staff` rows; `can_view_sale_costs` / `can_view_consignment_money` are true/true for mechanic1, false/true for a `manage_consignments`-only member, false/false for `view_financial_reports`-only and mechanic2, with charges and history visible exactly when the second is true; view_costs cannot read payout details. |
| Consignment concurrency (SPEC §25; D44, D50) | `consignment-concurrency.test.ts` (committed, real connections; each case proves the second call waits on a lock in `pg_stat_activity`): a replayed intake → one item, unit, movement and event; a replayed partial return → one movement and one `stock_returned`; one consigned unit on two jobs → one wins (`unit_not_available`); a job part racing a return, either way round → exactly one succeeds; two completions → one liability and one `status_changed`; a shop-owned part waits on an `adjust_stock` of the same product (shared stock lock). Step 2: a sale of one unit on two connections → one sale; the last quantity → one sale, the other `insufficient_stock`; a replayed sale id → one sale; a sale racing a return and a sale racing a job part of the same unit → exactly one succeeds; two 300.00 settlements against 500.00 owed → the second `settlement_exceeds_outstanding`; a replayed settlement id → one settlement. Review fixes: two refunds of one sale whose sum exceeds its total → the second waits on the sale row and is `refund_exceeds_sale` (refunded ≤ total); a replayed refund id → one row; two restocks of one sale line → one `return` movement; a restock racing a new sale of the same unit → the sale waits and sells the restocked unit, one live line. |
| Each consignor's stock where it is (D54, the Phase 6 review) | `consignment-locations.test.ts` (per-file clone), two consignors' items of one product, the older at the Workshop store and the newer on the Shop floor: `saleable_stock` offers each only where its stock is (10 offered against 10, never 20); a sale on the Shop floor with no item named is the newer consignor's at their price and payout, naming the older there is `consignment_quantity_unavailable`; a job part draws FIFO among the items at its location; a transfer moves the oldest item with the whole quantity at the source and both rows name it, then a sale there takes it, and a quantity no single consignor has there is `consignment_quantity_unavailable`; a return gives back only that consignor's stock at that location (by default all of it) and never another's; a consigned unit's transfer takes its item; an owner-inserted consigned movement without an item is `movement_invalid`; after every case the items' on-hand sums to the product's at every location and no movement lacks its item. |
| In-store sales (Phase 6 step 2; D9, D24, D26, D45, D48, D53) | `sales.test.ts` (per-file clone): a shop-owned unit sale (an `S-` number, price = `selling_price`, cost and generated totals, one linked `retail_sale` −1, the unit `sold` with `sold_sale_line_id` and `sold_at = recognized_at`, a public unique product → `sold`, `shopify_line_item_id` immutable); quantity sales (on-hand drops, `insufficient_stock` here and at another location, `sale_product_is_unique`, `ownership_not_saleable`, `product_inactive`, `sale_price_required`, an override supplying it, `sale_cost_missing`); D24: price 0 and cost 0 snapshot as 0; D45 FIFO across two consignors (oldest that covers it at its own price = `selling_price`, a named item at its own price, `consignment_quantity_unavailable` when no single item covers the line, `consignment_item_not_active`); a partly sold, partly returned item stays `sold` either way round; "Historical line price/cost/yield snapshots do not change with catalog edits" (product price and cost, new terms, a rate from tomorrow); a backdated sale takes the rate then in force; idempotency ("1000", 1000, "1000.00" one request; replay after the customer is archived and after the unit was sold by it; `sale_conflict`); validation (`sale_lines_required`, `sale_too_many_lines`, `sale_duplicate_unit`, `sale_recognized_in_future`, NaN 23514, malformed 22P02, negative price 23514, `sale_line_invalid`, `sale_quantity_invalid`, 22004, P0002); mechanic2 sells, a customer and anon 42501; immutability. Review fixes: "when a sale may be dated (D55)": mechanic2's sale of a consigned unit dated 400 days back, or an hour before its intake, is `sale_before_stock` and leaves the item active, at the intake instant it is recorded; a consigned quantity line (named or FIFO) before its item's intake is refused; a restocked unit cannot be sold again before its restock, while a shop unit registered now may still be sold two days back; mechanic2 cannot put a `shopify_line_item_id` on an in-store sale (quantity or unit → `sale_line_invalid`, no line stored). |
| Restocks and refunds (Phase 6 step 2; D7, D29, D44, D46, D49) | `sales.test.ts`: `restock_unit` needs `adjust_stock` (mechanic2 42501) and a reason; a `return` +1 movement linked by `sale_line_id` beside the line's `retail_sale`; the unit available at the chosen location, the product sold → public, the line restocked, the sale untouched; a replay writes nothing; "A delayed restock never restocks a later sale"; `restock_line_mismatch` (another unit's line, a unit sold by a job); `unit_not_sold`; a consigned unit also needs `manage_consignments`, then the item is active again with the reason and liability 0.00 and sells again; `bike_with_customer`; review fix "an archived consignor (D47)": a restock of a consigned unit whose consignor was settled and archived is `consignor_archived` (item and unit stay sold) and goes through after unarchiving. "Refunds are financial only (D7, D49)": partially refunded then refunded, movements and units untouched, `refund_exceeds_sale`, reason required, mechanic1, mechanic2 and a `view_financial_reports`-only member 42501, replay and `sale_refund_conflict`. |
| Settlements and the ledgers (Phase 6 step 2; D4, D44, D46, D47) | `settlements.test.ts` (per-file clone): separate facts; partial settlements; consignor charges reduce owed and voiding one restores it; the override rule; a consigned job part's liability settled the same way and removed by a reopen (overpaid) until re-completion; validation codes; mechanic1 and mechanic2 42501, a `manage_consignments`-only member records and reverses; `consignor_archived`; replay ("200" vs "200.00", allocations reordered, after the outstanding changed, `settlement_conflict`; NULL `paid_at` records now() and a NULL replay matches); reversal (paid drops, rows stay, replay, `settlement_already_reversed`, `settlement_reversal_conflict`, reason rules) and `settlement_immutable`; D46 (a restock after a settlement → −500.00, a resale → 0.00); "Owed, paid and outstanding are derived, never stored" (no base-table column of those names); consignor ledger = Σ item ledgers; archiving (`consignor_has_balance` owed or overpaid; at 0 a `manage_consignments`-only member archives and the ledgers and old lines still join: "Archived entities remain available to historical references"). |
| Sales and consignment in the reports (Phase 6 step 2; D1, D30, D44, D46, D48, D49) | `consignment-reporting.test.ts` (reads the seed; one block on a per-file clone): "Cult Commons is 30% of positive yield after the consignor payout": each seeded sale's `financial_lines` entry equals `EXPECTED_SALE` on its shop day (S-000003: source sale, channel retail, its document, line, `recognized_at`, null lead mechanic, ownership consignment); refunds not netted; `entry_key` unique; work-order entries carry their line's item; the reading path (admin costs; a `view_financial_reports`-only member with cost columns and `new_consignor_liability` NULL; mechanics as in Phase 5); `daily_summary`'s consignment columns on S-000004's and S-000003's days by Phase 5's day bucket, equal to the consigned entries' sums on every day, and `today_dashboard` agreeing; a consigned job part counts on its completion day; the seeded ledger = `EXPECTED_CONSIGNOR_LEDGER` = Σ items; `list_consignors` (since the review its awaiting-payment count is NULL without consignment money access and `sold_items` is for everyone), `consignor_statement` (22023), `list_sales`, `sale_lines_detail`, `saleable_stock`, `consignor_payout_details` with the D48 gating per role (NULL, never omitted); a customer and anon refused all six; snapshots survive catalogue edits. |
| Consigned stock and sales in staff search (Phase 6 step 2) | `staff-search.test.ts`: `C-000002`, `c000002`, `C 000002` → the item at 1.0; product and consignor words find items; `kelvin`, phone digits and the exact email find consignors; `S-000003`, `s000003` → the sale at 1.0 with "Hafiz Rahman · date" (a walk-in reads "Walk-in"); archived consignors only with `archived` true; items and sales never. |
| Manual adjustment records actor/time/reason (Phase 4) | `inventory-ledger.test.ts` "every manual stock adjustment records actor, timestamp and reason": null/blank reason → `reason_required`; `created_by`, trimmed reason, `created_at`; damaged positive → `quantity_invalid`; other types → `movement_type_not_manual`; `insufficient_stock`; request-id replay and `request_conflict`, concurrent same request → one movement; mechanics 42501, admin succeeds; a unit cost needs view_costs. Write-off replays by request id, no-op when already written off, again after a restore; transfers pair rows by request id, `insufficient_stock`, `transfer_same_location`, concurrent draining → one succeeds, unit transfers move the unit (`moved`), held units refused. |
| Current stock is derivable from the ledger (Phase 4) | `inventory-ledger.test.ts`: `reporting.stock_levels` equals the per-product/location movement sums after transfers, parts, voids and damage; seeded `low_stock` is P-000009, P-000008, P-000012 by shortfall; `product_stock` totals. Snapshots do not change when product and unit prices and costs change; the ledger and both histories are append-only for the owner too; an archived product keeps its movements and lines. |
| Catalog, cost gating and boundaries (Phase 4) | `inventory-catalog.test.ts`: P-/U- IDs server-assigned, increasing, immutable; `tracking_type` immutable; SKU unique ignoring case and punctuation; manage_inventory needed for products and locations; mechanic2 cannot select any cost column (42501), the cost views return nothing to them and rows to mechanic1/admin (product 02: yield 37.00, Cult Commons 11.10); the invoker cost-write guards refuse direct cost writes without view_costs, including a write of the stored value or null (no equality oracle), and let mechanic1 and the owner through; publication requirements, slug and `item` fallback; archive rules (`product_published`, `product_has_stock`, `unit_in_stock`, `location_has_stock`); `bike_in_stock` for transfer and archive until the unit is written off, `bike_has_owner`, `bike_already_linked`; anon denied and customers read zero rows on every stock table and view; event payloads exact, with actor, never a cost key or value (product, unit and work-order events); the publication and unit-status matrices equal `src/lib/inventory.ts` for all 25 and 36 pairs. `attachments.test.ts`: product and unit photos internal/public, never customer (`attachment_stock_never_customer`, CHECK backstop). |
| Public QR pages expose only explicitly published records (Phase 4, SPEC §23) | `inventory-publication.test.ts` "public QR pages expose only explicitly published records": as anon, `reporting.public_items` has no draft, internal_only or archived product and no unit of an unpublished product (unknown and unpublished short IDs equally absent); its columns equal the documented list exactly (no cost, serial, SKU, internal note or location; a unit's cost and serial never appear in the rows); `sale_price` equals `private.selling_price` for product and unit rows and follows a price change; a product row shows only its public photos, oldest first, as `{bucket, path, width, height, caption}`; a unit row shows the unit's, then the product's, then the bike's; held units and their product read `unavailable`, a sold unit and its product `sold`, a quantity product without stock `sold_out`; a written-off unit and every unit of a sold-then-archived product are absent; a linked bike's photos created before `sold_at` appear and those at or after it never do; a bike photo taken after the first handover to a buyer stays hidden after the bike returns to the shop and the job is reopened and completed again (D29); signed-in customers and staff see the same rows; anon calling `private.selling_price` directly gets 42501. |
| Publication by hand (Phase 4, D26) | `inventory-publication.test.ts` "set_publication_status": for quantity products and unique products with and without an available unit, from every state, the targets the RPC accepts equal `manualPublicationTargets` and every refusal has its code (`publication_transition_invalid`, `publication_sold_by_sale`, `publication_requires_available_unit`); a manual `sold` and sold → public/internal_only refused, sold → archived allowed; a unit registered on a sold product restores it to public (`publication_changed` {sold → public}, both rows `available` to anon), so 'sold' with an available unit is unreachable and skipped in the matrix; same status is a no-op without an event; `publication_requires_photo` (none, or internal only) and `publication_requires_price` (a unique product with no price on product or unit); the slug is assigned once and survives unpublish, rename, archive and republish, `item-p-…` for a name without letters or digits; `publication_changed` events carry `{from, to}`, the actor and the trimmed reason; `reason_too_long`; mechanic1, mechanic2 and anon 42501; unknown product P0002. |
| Split to a unique item (Phase 4, D28) | `inventory-split.test.ts`: the source loses one at the location and a draft unique product (name, description, brand, category and currency from the source; price from the source unless given) gets an available shop-owned unit there, both costs equal the source's default cost (read through the cost views as the admin), one `stock_adjustment` each side with "Split to U-…: reason", cost snapshot and request_id = unit id, `created` event with actor and reason; replay with the same ids returns the same result with one pair of movements, a reused unit or product id is `unit_conflict`; `insufficient_stock` (empty or other location), `location_inactive`, `product_not_quantity`, `product_archived`, `ownership_not_saleable`, `reason_required`, `reason_too_long` (> 480), a blank name 23514 without DETAIL; needs both adjust_stock and manage_inventory (42501 otherwise, anon too); mechanic2 with both but no view_costs splits and the carried costs equal the source's while their direct cost UPDATEs on the new product and unit are 42501; committed concurrency: the same unit id twice → one result, one pair of movements; two splits racing for the last item → one succeeds, the other `insufficient_stock`. |
| Products and units in staff search (Phase 4) | `staff-search.test.ts`: the SKU typed as "shi l05a rf", "shil05arf" or in mixed case finds P-000001 at rank 1.0 with subtitle "SHI-L05A-RF · Shimano · 34 in stock"; SKU contains (≥ 3 characters) 0.7; exact P- and U- IDs rank 1.0 with or without the dash; name and brand words 0.45-0.85; on-hand from the ledger across locations (road tube 60), "Unique item" for unique products, "Inactive" appended for an inactive product; units by exact serial (1.0), part of it (0.7) and product-name words, subtitle "Available · Shop floor · S/N …"; the shop Brompton's serial finds both the bike and its unit at 1.0; the archived chain and an archived unit are left out and are the only hits with `archived = true`; "brompton" across all kinds adds products P-000005, P-000014 and unit U-000002 (the bike assertion is scoped to `['bike']`); 'product' and 'inventory_unit' are known kinds. |
| Cult Commons end to end (Phase 5; SPEC §10, §31; D1) | `reporting.test.ts` "Cult Commons is 30% of positive yield after direct costs, per line": every `LINE_FIXTURES` row on its own job completed on its own isolated `TEST_DAY` equals the line's generated columns, its `financial_lines` entry (owner) and `daily_summary(day, day)` (admin); every `JOB_FIXTURES` row equals `work_order_yield` and the day's totals; the seeded loss-line job's Cult Commons is 12.00, not 7.50 (the Phase 5 fixture rows run through `cult-commons.test.ts` and `work-order-lines.test.ts` too). |
| Negative yield never pays negative Cult Commons (Phase 5; SPEC §10; D32) | `reporting.test.ts`: as owner, every `financial_lines` entry's share is ≥ 0 and equals its line's share, `is_loss` matches the line's yield; every `daily_summary` row has `cult_commons_share` ≥ 0 and `loss_total` ≤ 0; a day with two loss lines and a 40.00 line: CC 12.00, yield −5.00, loss −45.00. |
| Reports derived, never a second truth (Phase 5; SPEC §19.2) | `reporting.test.ts`: `reporting` holds views only (also `meta.test.ts`); over three test days with service, part, voided-part, collected, cancelled and open jobs, `daily_summary` money equals Σ `financial_lines` by day (both admin RPCs), each job's entries equal `work_order_totals_staff` and `work_order_yield`, the `jobs_*` counts equal the `work_order_activity_on` rows with the matching `*_on_day` flag, parts consumed/returned equal ledger sums, an empty day is a zero row, the appointment columns equal `appointment_daily` (d1 two scheduled and one no-show, d3 one arrived, 0 elsewhere) and the consignment placeholders are NULL; catalog price/cost edits and archiving the service leave the days and entries unchanged (snapshots). |
| Only completed jobs recognised; reopen restates (D32) | `reporting.test.ts`: open jobs, cancelled jobs (lines voided first, D16) and voided lines have no entry; a line added on one day of a job completed on the next is recognised on the completion day; 23:59 vs 00:01 SGT land on consecutive days; adds and voids on completed, ready and collected jobs → `work_order_locked` (RPC and owner); complete → reopen (the earlier day drops by exactly the job, no entry left) → void one line, add another → complete: the new day has exactly the current live lines once each, `started_at` kept, two `completed` events and one `reopened`. |
| Completion recognised once (replay, concurrency) (Phase 5) | `reporting.test.ts`: a second `set_work_order_status(…, 'completed')` returns the row unchanged, no event, one entry per line. `reporting-concurrency.test.ts` (committed): two connections complete the same job; the second waits on the row lock and gets the unchanged row; one `completed_at`, one `completed` event, one entry per line, today's sales rise by the job's sale once; a third reader before the commit sees the old totals. |
| Shop-day boundaries (D35) | `reporting.test.ts`: `completed_at` 2025-06-01 15:59:59Z → 2025-06-01, 16:00:00Z → 2025-06-02; `daily_summary` inclusive on both ends; identical results under `set local timezone` UTC and America/Los_Angeles; `shop_today()` = Singapore's date of `now()`; no reporting view or Phase 5 function contains `current_date`. |
| Financial reports gated (D30) | `reporting-access.test.ts` "Mechanic permission boundaries" and "Customers cannot read internal data": mechanic2 → `financial_lines` / `work_order_yield` 42501, counts with every money column NULL (`can_see_financials` false), `value_at_cost` NULL; mechanic1 (view_costs) → `financial_lines` 42501, `work_order_yield` works, summary money NULL; mechanic2 + view_financial_reports → rows and gross sales with every cost column NULL (`can_see_costs` false); admin → everything; customers, anon and inactive staff → 42501 from all seven RPCs; selecting the four Phase 5 reporting views as anon or authenticated → 42501. |
| Today flows vs snapshot (D31) | `reporting.test.ts`: inserting a job with today's check-in, start, line and completion raises today's flows by exactly those milestones and the money by its line; the `*_now` counts equal direct status counts grouped as `BOARD_GROUPS`, D20 overdue via `isOverdue` and `low_stock` rows; a past day has `is_today` false and every `*_now` NULL; tomorrow → `report_range_invalid`. Range rules: `daily_summary` from > to and 367 days raise, 366 pass; `financial_lines` 31 pass, 32 and from > to raise; null bounds mean today. |
| Significant adjustments (D33) | `reporting.test.ts`: `private.is_significant_adjustment` cases (−6, +5, −1, 4 × 24.99 vs 4 × 25.00, a unit, 2 × 60.00, non-adjustment types false); `stock_adjustments_on(TEST_DAY)` over owner-inserted movements returns the day's six (00:00 and 23:59:59 in, the neighbouring days out), newest first, with `significant`, `actor_name` and `reason` for mechanic2 and `value_at_cost` NULL; the admin sees \|delta\| × unit cost (snapshot, else product default, else 0). |
| Operational exceptions incl. 7-day overdue boundary (D34, D20) | `reporting.test.ts`: an open job checked in exactly `OVERDUE_AFTER_DAYS` days ago is not `overdue_job`, one second earlier is; a collected job checked in 30 days ago is neither; `work_order_activity.is_overdue` equals `isOverdue` for the same rows; a ready job completed 7 shop days ago is `uncollected_job`, 6 days ago not; a forced negative on-hand is `negative_stock` (danger, all danger rows first); an owner-held unit with no live line is `unit_hold_stale`, a unit held by `add_inventory_line` on an open job is not; a completed USD job's line is `currency_mismatch` and out of the day's totals; `exceptions_now` equals the row count; max_rows clamped to 1..200. Phase 9 step 3 appended six columns to the RPC's result (a documented contract change): `OPERATIONAL_EXCEPTIONS_COLUMNS` in `reporting-fixtures.ts` lists them after Phase 5's nine, and every other Phase 5 assertion is unchanged. |
| Seeded history reconciles (Phase 5; SPEC §10 examples, SEED_DAYS) | `reporting-seed.test.ts` (reads only; days counted back from the seed's anchor, `seedToday()`): H1–H4 (and H5's rounding) through `work_order_yield` (admin) and Σ `financial_lines(anchor−6, anchor)` per job equal `SPEC_EXAMPLE_JOBS` / `ROUNDING_JOB`, recognised on their days, H4's CC 12.00 not 7.50; `daily_summary(anchor−n, anchor−n)` equals `SEED_DAYS[n]` exactly for n = 0…6 (every column: the D41 appointment counts, consignment placeholders NULL); Σ entries by `recognized_day` equal each day's money columns; every completed seeded job (Phase 3, 4, 5) has entries equal to `work_order_totals_staff` and `work_order_yield` on its completion day, open and cancelled ones none; parts consumed/returned and adjustment counts equal the ledger's sums; every seeded entry's share ≥ 0 and equals its line's (H4's tyre a loss at 0); `stock_adjustments_on(anchor−n)` gives A1–A3 as `SEED_ADJUSTMENTS` (A2 significant, `value_at_cost` NULL for mechanic2, 30.00 for the admin). When the anchor is the shop's today (else skipped with a message): `today_dashboard(null)` is the anchor, `is_today`, flows = `SEED_DAYS[0]`, the `*_now` snapshot equals direct counts and `SEED_SNAPSHOT` (exactly in a fresh per-file database, at least otherwise); `operational_exceptions` has `SEED_EXCEPTIONS` and not H5, J-000002, J-000003 or J-000005. `display-parity.test.ts`: `private.shop_timezone()` = `SHOP_TIME_ZONE`, and `work_order_activity_on`'s `bike_title` / `customer_label` equal `bikeTitle()` / `customerLabel()` for every seeded job of days 0–6. |
| Seeded ledger consistent (Phase 5) | `reporting-seed.test.ts` "The seeded ledger is consistent": every seeded inventory line has exactly one `job_consumption` movement (−quantity, cost snapshot = the line's unit cost), at the line's own time for the Phase 5 lines (J-000010's, written by `add_inventory_line`, just after); no line created at or after its job's completion; no stock level below zero and the Phase 5 products' on-hand as documented; no seeded job, line, event, assignment or movement later than `now()`, and no Phase 5 row later than J-000007's seed-time check-in. |
| Cost-pending lines flagged (D14) | `reporting.test.ts`: a `cost_pending` manual line on a completed job is recognised at cost 0 with `cost_pending` true; `today_dashboard(day).cost_pending_lines` and `work_order_yield.cost_pending_count` count it. |
| No float money in function results (Phase 5) | `meta.test.ts`: no money-named OUT/TABLE argument of a function in `public` or `private` is `real` or `double precision`; every reporting RPC compiles and answers with exactly its documented columns (`reporting.test.ts`). |
| QR payload equals the public URL (Phase 8; SPEC §15; D9) | `labels.test.ts` "QR payload (D9)": for a product, a unit and a bike the payload is exactly `` `${SHOP.publicSiteUrl}/q/${short_id}` `` (`label_preview` and the job); every valid base of `tests/fixtures/qr-bases.ts` gives one slash before `q` (a trailing slash, a path base `https://bicii.sg/shop`); every invalid one violates `shop_settings_public_site_url_check` (23514); with the check dropped in the transaction, each invalid base, null and a deleted settings row make `create_print_job` and `label_preview` raise `public_site_url_invalid` (no fallback). The same case list drives step 2's TypeScript validator (parity). |
| N labels carry one payload; per-job caps (Phase 8; SPEC §16, §31; D56) | `labels.test.ts`: quantity 10 → one row, one `qr_payload`; product 0, 501, −1 → `label_quantity_out_of_range`, 500 ok; unit 11 and bike 11 out, unit 10 and bike 1 ok; owner inserts past the caps → `print_jobs_quantity_check` / `print_jobs_unique_quantity_check`. |
| Unique labels are per unit (Phase 8; SPEC §16; D57) | `labels.test.ts`: two units of one unique product get distinct U- payloads, distinct from the product's P- address; kind `product` on a unique product → `label_unique_product_needs_unit` (job and preview). |
| A printed label resolves publicly, as staff see it (Phase 8; SPEC §15, §23; D57) | `labels.test.ts`: the jobs of a published quantity product, a published shop unit and a published consigned unit each return exactly one `reporting.public_items` row as anon; a draft product's, an unknown ID and a bike tag return none; `public_items` returns identical rows to anon, mechanic2 and the admin for the same short IDs (so the staff "What the public sees" panel is the anonymous scan). |
| The label price is the one selling price (Phase 8; D58, D24 amended) | `labels.test.ts`: for the three published fixtures the label price equals `private.selling_price` and the view's `sale_price` as anon (and the currency); a consigned unit sold without a price (rolled back) snapshots the label's price; after `update_consignment_terms` the preview follows the new asking price; unit price, else product default; product price 0 → "0.00"; NULL → JSON null (never "0.00"); 12.5 → "12.50"; a bike tag has no price. |
| Labels never carry cost, consignor, ownership or notes (Phase 8; SPEC §15, §23) | `labels.test.ts`: content keys = the whitelist; content text contains no direct cost (20.00, 380.00, 400.00, 2400.00), not the consignor's name, not "consign", "internal" or "shop_owned"; an owner insert with an extra `cost` key → 23514 `print_jobs_content_keys`; the source of `private.label_content` mentions none of `consignment_items`, `direct_cost`, `ownership_type`, `internal_note`, `customer`. Label text is a subset of the public row plus identifiers: name = the view's name as anon; identity lines are the brand, the size/colour line or the condition's first line. Every seeded bike's tag name equals `bikeTitle()`. |
| Print jobs are snapshots, history and RPC-only (Phase 8; SPEC §2, §23) | `labels.test.ts`: renaming and repricing the product leaves the job's content unchanged while `label_preview` shows the new values; template and printer snapshots; a replay with the same id → the same row and one row, another quantity, record or printer → `print_job_conflict`, a replay without a printer after the default moved → the original job; staff insert/update/delete → 42501; owner update of quantity or content and delete → `print_job_immutable`; archived product, unit (and a unit whose product is archived) and bike keep their jobs readable while new jobs, previews and reprints → `label_entity_archived`; a reprint of another record → `print_job_reprint_mismatch`. |
| Print job status machine (Phase 8; D59) | `labels.test.ts`, table-driven from `tests/fixtures/print-transitions.ts`: `private.print_job_transition_allowed` for all 16 pairs; `set_print_job_status` from each status to each: allowed moves stamp `rendered_at` / `completed_at` and `status_changed_by` = the caller, same status is a no-op (a failed job keeps its first error), the rest `print_job_transition_invalid` (also for the owner, by the trigger); failed without, with a blank or with a 501-character error → `print_job_error_required` / `reason_too_long`. |
| Templates and printers: staff read, admins write (Phase 8) | `labels.test.ts`: mechanic2 reads the three built-in templates and two profiles, insert → 42501, update affects 0 rows, `set_default_*` → 42501; the admin inserts and renames (trimmed, `created_by` set); `is_default` and delete → 42501; switching off a default → `*_default_required`; `set_default_*` leaves one default per kind / one printer and refuses an inactive target; inactive printer or template and a template of another kind refused by `create_print_job`; no default for a kind → `label_template_missing`; kind / adapter changes → `*_immutable`; `bluetooth` and `network_raw` → 23514 `printer_profiles_adapter_available`; config v1; width / height checks; `label_mm` rejects NaN. Layout v1 from `tests/fixtures/label-layouts.ts` (shared with step 2's zod schema): every case through `private.label_layout_problem`, and every invalid one through an admin insert → `label_layout_invalid` with the sentence as DETAIL. |
| A manager prints labels but is not a labels admin (Phase 8 under the staff roles; D91) | `labels.test.ts` "a manager prints labels but writes no template, printer or QR address (D91)": the seeded manager creates a print job (`requested_by` = the manager) and marks it printed, reads the three templates, and gets 42501 inserting a template or a printer, 0 rows renaming a template, 42501 from both `set_default_*` RPCs and from `update_shop_settings(public_site_url)`; the merge of `main` into `feat/p8-labels` added it |
| Customers and anonymous visitors read nothing about labels (Phase 8; SPEC §4.2) | `labels.test.ts`: a linked customer reads 0 rows from `label_templates`, `printer_profiles`, `print_jobs` and gets 42501 from the five label RPCs; anon has no privilege on the tables and cannot execute the functions (also `meta.test.ts`'s allow-lists). |
| Labels under concurrency (Phase 8; SPEC §25) | `labels-concurrency.test.ts` (committed, real connections; each case proves the second call waits on a lock): the same print job from two devices → one job, the second returns the first's row; another quantity → `print_job_conflict`, one row; two admins making different templates (and printers) default → exactly one default, the second's target, no 23505; printed and failed at once → one wins, the other `print_job_transition_invalid`; a print naming no printer (no template) while an admin moves the default waits on `set_default_*`'s row locks and then uses the NEW default (adapter `pdf`; the new template's snapshot), which only `create_print_job`'s two-attempt `for share` read makes pass (checked by cutting the loop to one attempt: both cases fail). |
| The labels domain module against the devstack (Phase 8 step 2) | `labels-domain.stack.test.ts` (skips without the devstack unless `BICII_REQUIRE_STACK=1`): `getPrintJob` maps the seeded queued job from its snapshots (payload `${SHOP.publicSiteUrl}/q/P-000011`, PDF printer, 58 × 40 template, requester), keeps the failed job's reason and the reprint link; `listPrintJobs` filters To confirm, Failed, a short ID (any case) and a name, and pages by `(created_at, id)` without gaps; `listJobsFor` returns two jobs the test creates (and confirms) on `BIKE.tanTarmac` newest first, and the seeded unit's two jobs in order within a limit of 50: nothing assumes the seeded jobs are a record's newest, so jobs that E2E runs leave in `bicii_dev` cannot turn it red (they did, until the Phase 8 review); `getLabelContext` offers the counted product (default template and printer first, last printed price), and returns `unique_product`, `archived` and, for an id that does not exist, `not_found` without throwing, and `publication: null` for a bike; `getReprintPreset` only for the same record (with the reprinted job's price); `resolvePrintPreset` turns `?print=1&qty=…&reprint=…` into the sheet's preset (null without `print=1`; another record's job opens the sheet without the link); one job created replay-safely as mechanic2, marked rendered then printed, and refused failed afterwards. |
| Unmapped variants go to the retry queue, nothing partial (Phase 10; SPEC §17.1, §26) | `shopify-webhooks.test.ts`: one mapped and one unmapped line → no sale, line or movement, stock unchanged, the event `failed` `shopify_variant_unmapped` with a message naming the line and variant and `result.unmapped_lines` exactly that line, the job `needs_attention`; a custom line likewise (variant null); `link_shopify_variant` + `retry_integration_job` + claim + process → one sale with both lines. |
| Online sales use the shared sale-line writer (Phase 10; P6 `sell_line`) | `shopify-webhooks.test.ts`: an online line's description, price, cost, payout, rate and totals equal `record_retail_sale`'s for the same product, price and instant; `online_sale` vs `retail_sale` movements; no `private.write_sale_line`; an in-store line with a Shopify line id → `sale_line_invalid`, with a part but no line id → 23514 `sale_lines_shopify_line_part_check`. P6's `sales.test.ts` is unchanged and green. |
| Zero is a known price and cost online (Phase 10; D24 amended) | `shopify-webhooks.test.ts`: a fully discounted line at 0.00 with Cult Commons 0.00; a product costing 0 recorded at 0.00; a NULL cost → `shopify_sale_refused` quoting `sale_cost_missing`'s message, nothing written. |
| A unique unit sells once online (Phase 10; SPEC §23, D26, D81) | `shopify-webhooks.test.ts`: the oldest available unit at the online location is sold (then the next), the product becomes `sold` when none is left; a unit sold in store → `shopify_unit_unavailable`, nothing written; units at another location and customer-owned units are never chosen; concurrent `record_retail_sale` and online processing of one unit → one sale line. |
| Online consignment sale (Phase 10; SPEC §10, §13, D4, D45, D46) | `shopify-webhooks.test.ts`: 1,000.00 for a consigned unit owed 500 → cost 500, yield 500, Cult Commons 150, item sold, liability 500, no settlement rows; a shop-borne 40.00 charge → cost 540; a consigned quantity line draws one consignment, more than one holds → `shopify_insufficient_stock`. |
| Online prices and recognition (Phase 10; D80) | `shopify-webhooks.test.ts`: 3 × 40.00 − 20.00 → 2 × 33.33 (part 1) + 1 × 33.34 (part 2); an even split one line, part null; `current_quantity` wins, 0 is ignored; a unique product × 3 → three unit lines summing to the total; `private.shopify_split_amount` and `private.shopify_gid` table tests; `recognized_at` = the payload's `processed_at` whatever the deliveries' trigger times (else the trigger time), reported `online` on that shop day. Snapshots unchanged by catalogue edits. |
| Tax, test and POS orders (Phase 10; D89) | `shopify-webhooks.test.ts`: tax-inclusive recorded; `taxes_included` false with tax → `shopify_tax_basis_unsupported` (needs attention, nothing written), without tax recorded; with `accept_test_orders` false a payload `test` and a header `X-Shopify-Test` → skipped `test_order` with no job, sale or movement; `source_name` 'pos' → `pos_order`; an unhandled topic → `topic_not_handled`; with the flag true a test order is recorded, switched off before processing it is skipped. |
| Online stock follows the ledger (Phase 10; D82, D35) | `shopify-webhooks.test.ts`: too little at the online location (stock elsewhere does not count) → `shopify_insufficient_stock` with its message; another currency → `shopify_currency_mismatch`; an unreadable payload → `shopify_payload_invalid` naming the field; missing settings → `shopify_settings_missing`, queued with backoff. |
| Refunds are financial only (Phase 10; D7, D85, D49) | `shopify-webhooks.test.ts`: one `sale_refunds` row (recorded_by null, restocked false), sale `partially_refunded`, no movement, unit and item still sold, lines and `reporting.financial_lines` identical; a full refund with shipping → the sale total, `refunded`, shipping and the excess in the result; amount-only → the transactions total capped at what is left, then `refund_not_allocated`, `no_money_refunded`; replay and a second webhook id → one row; a refund before its order → queued with backoff, re-queued when the order lands (also from needs_attention) and then recorded; a dismissed order's refunds → `order_not_recorded`, and dismissing an order closes its waiting refunds; a refund of a test order (`accept_test_orders` false, the refund itself unflagged) and of a POS order → skipped `order_not_recorded`, no open job, no `sale_refunds` row, no `integration_failed` exception. |
| Rejected deliveries and evidence (Phase 10; D88) | `shopify-webhooks.test.ts`: rejected → no payload (even when one is passed), no job; the same bad body twice → one row, `delivery_count` 2; headers capped at 16 lower-cased keys and 512 characters with `x-bicii-truncated`; processing a rejected event is a no-op; a later valid delivery with the same webhook id is processed; updates of payload, headers, topic, id or verification and deletes → `integration_event_immutable` even for the owner; audit rows → `integration_history_append_only`; `private.purge_integration_events` (owner) deletes old rejected rows and clears old processed payloads, refuses < 30 days, leaves failed events, and no API role may run it. |
| Retry policy and the queue (Phase 10; D87) | `shopify-webhooks.test.ts`: backoff 1, 2, 4 … 64 minutes, capped at 6 hours, needs attention after 8 attempts; claim skips jobs not yet due unless named, reclaims runs stalled 10 minutes, dismisses a stalled product sync beside a queued one and never runs two syncs of one product; two concurrent claimers share no job (committed); dismiss needs an admin and a reason, closes the job, skips the event, writes an audit row; closed jobs → `integration_job_closed`, running → `integration_job_running`; `manage_inventory` retries product-sync jobs only. |
| Integration failures are exceptions (Phase 10; SPEC §26, D86) | `shopify-webhooks.test.ts`: a needs_attention job is an `integration_failed` danger row for admins (label = the order, subject = the message); mechanics see none and otherwise the same rows; `today_dashboard.exceptions_now` differs by exactly the failing jobs; retrying to done removes it. P5's kinds and tests are untouched. |
| Customer and variant links (Phase 10; SPEC §17.2, D84, D86) | `shopify-webhooks.test.ts`: a matching email links nothing; `link_shopify_customer` needs an admin and a reason, reports earlier online sales, never edits them, refuses a different id and a taken one, replays as a no-op; a later order gets the customer; `link_shopify_variant` likewise, two products may link two variants of one Shopify product, a BICII-created Shopify product belongs to its product, the change is in the product's history. |
| Who reaches the integration (Phase 10; DATA-MODEL §15, D86) | `shopify-webhooks.test.ts`: anon and authenticated (admin included) get 42501 from the five service RPCs; admins read events, queue and audit, mechanics none of them but the settings and sync rows; a signed-in customer reads zero rows of every new table; anon cannot select them; nothing is writable through the API; products' and customers' Shopify columns are not updatable. `meta.test.ts`: the service role executes exactly `SERVICE_ROLE_FUNCTIONS` and nothing in `private`; no API role executes `private.integration_exceptions` or `private.purge_integration_events`. |
| Seeded integration data (Phase 10) | `shopify-webhooks.test.ts` "Seeded integration data is consistent": #1001 one sale (S-000005, online, 8 shop days back) and one movement, its refund one row and no movement; #1002 failed with its job needing attention and no sale; the rejected delivery has no body; syncedTyre public, linked and synced at its on-hand (11) and price. |
| Publish online (Phase 10 step 2; D84, D86, D24 amended) | `shopify-sync.test.ts` (per-file clone): mechanic2 gets 42501 from `set_publish_online` and `request_product_sync`; a staff member with only manage_inventory publishes (one `publish_online_changed` audit row with actor and `{from, to}`); the returned `job_id` is the single queued job and the row is `pending` with no handle; a replay returns `job_id` null with no second job or audit; not public → `shopify_requires_public`, customer-owned → `shopify_not_saleable`, archived → `shopify_product_archived`, NULL price → `shopify_price_missing` (no sync row left); a price of 0 publishes, is the online price and pushes at 0.00 × 0; unpublishing a never-pushed product → `not_synced`, its job dismissed, later stock changes queue nothing; unpublishing a pushed one queues a push that settles `unpublished`; Sync now refuses an unpublished product (`shopify_not_published`), returns the queued job due now, clears the hash, reuses the job when repeated |
| Changes queue one sync per product (Phase 10 step 2; D84, D87) | `shopify-sync.test.ts`: two stock movements, a price edit, a public photo (an internal one queues nothing), a unit write-off, a unit price edit, an asking-price change through `update_consignment_terms` (the online price follows it) and an online sale each leave exactly one queued job and a `pending` row; a change supersedes a `needs_attention` sync job; a product only linked by `link_shopify_variant` is never queued until published. The triggers are deferred: the tests fire them with `set constraints all immediate` |
| Shopify-made products (Phase 10 step 2; D84) | `shopify-sync.test.ts`: two BICII products link two variants of one Shopify product (origin `external`, handle null); once published the sync state is external with no handle and a push keeps it so; a variant of a BICII-created Shopify product cannot be linked to another product (`shopify_ids_conflict`) |
| What the sync worker reads (Phase 10 step 2; D81, D83, D45, D58) | `shopify-sync.test.ts`: a quantity product's quantity is the ledger at the online location (stock elsewhere ignored), 0 when a job part took it below zero; a unique product counts available units there (not written-off or elsewhere), its price is the oldest unit's own price and a unit at another price is a conflict, or the product default; a consigned unit at its asking price, not the product default; a consigned quantity product at its FIFO item's asking price; `effective_online` false when unpublished, not public or archived; `orders_in_flight` true while a recent orders/paid event is pending |
| What a sync records (Phase 10 step 2; D83, D84, D87) | `shopify-sync.test.ts`: pushed stores the ids on the product (with the product-history reason), origin `bicii`, the handle and inventory item, clears errors, finishes the job and fills the missing Shopify location; pushed while another job is queued → `pending`; different ids or a BICII-created Shopify product another product carries → `shopify_ids_conflict`; an unknown outcome → 22023; deferred → queued 2 minutes out, attempts back to 0, the row unchanged; failed and retriable → queued 1 minute out, `error` with the message; failed and not retriable → `needs_attention` |
| Shopify settings (Phase 10 step 2; D83, D86, D89) | `shopify-sync.test.ts`: mechanic1 gets 42501; same values write no audit; changing test orders without a reason → `reason_required`, with one → one audit row `{from, to}` with the reason; the storefront trims a trailing slash, refuses http (`shopify_settings_storefront_url_check`) and may be cleared; an unknown location → P0002, an inactive one → `location_inactive`; a new online location queues every published product (the seeded one too) but no link-only product |
| Buy online link (Phase 10 step 2; D84, Phase 11's rule) | `shopify-sync.test.ts`: as anon, `buy_online_url` = storefront + `/products/` + handle on a published, synced, available product row and on a unique product's product and unit rows; `public_items` has exactly the 14 public columns and no Shopify id or sync state; null when a change is pending, the last sync failed, unpublished, external origin, sold out (synced again), and with no storefront; a written-off unit leaves the list. "links only what Shopify sells" (D81): a second, newer unit at the online location and a unit at another location get no link (only the oldest online unit does), and a unique product whose online unit is priced differently from its default shows no link on its product row. `inventory-publication.test.ts`'s exact column list gains `buy_online_url`; `labels.test.ts` still sees identical anon and staff rows |
| Who reaches the outbound sync (Phase 10 step 2; DATA-MODEL §15, D86) | `shopify-sync.test.ts`: anon and authenticated (admin included) get 42501 from `product_sync_state` and `record_product_sync_result`; anon cannot publish or read `reporting.shopify_sync_status`; an admin reads the open job there, mechanic2 the same row with the job columns null; `meta.test.ts` checks the grants against `tests/fixtures/api-surface.ts` |
| Shopify gid parity (Phase 10 step 3) | `shopify-gid-parity.test.ts`: one shared table (`tests/fixtures/shopify-gids.ts`) through `private.shopify_gid` (as owner) and `toShopifyGid`: the same gid, the same null and a refusal on both sides (spaces trimmed, a tab, newline or non-ASCII digit refused); an unknown kind is 22023 / RangeError; `shopifyHandle` = `private.shopify_handle` |
| The Shopify service layer on the live stack (Phase 10 step 3; SPEC §23, D83, D84, D87) | `shopify.stack.test.ts` (skips without the devstack unless `BICII_REQUIRE_STACK=1`): (a) publishing the stack product → one productSet and one inventory write for its handle at `product_sync_state`'s price, ids on the product, `synced`; a stock change at another location → its job calls Shopify zero times; Sync now pushes in full; a price change → one productSet at the new price; a retriable failure → `error` with the message and the job queued, then userErrors → `needs_attention` with Shopify's message; Sync now supersedes it and the anonymous `buy_online_url` is the storefront's `/products/<handle>`; (b) a signed orders/paid through `handleShopifyWebhook` (after-work run synchronously): the same webhook id twice and a new id once → one sale, online stock down once, `delivery_count` 2, the second id `duplicate_order`; the sale's sync defers once (`shopify_quantity_changed`) and then pushes the ledger quantity; (c) a Shopify-made product linked by its second variant → variantsBulkUpdate and inventorySetQuantities only, the first variant untouched, origin `external`, no Buy-online link; restore: both unpublished and run (DRAFT at 0 with ids kept; the variant at 0), nothing left in the queue |
| Seeded sync data (Phase 10 step 2) | `shopify-sync.test.ts` "Seeded sync data is consistent": no open product-sync job after the seed, syncedTyre `synced`, its Buy-online link the storefront's `/products/bicii-p-000027` |
| Period reports are built from source records only (Phase 9; SPEC §19.2; D100) | `period-reports.test.ts` "Reports are built from source records only": every day of the March 2025 scenario (`period-report-fixtures.ts`) and of the seed's last week, each `daily_summary` column equals its counterpart in `report_period_summary(d, d, 'sale')` (money, consignment) or `report_activity(d, d)` (job flows, appointments, parts, adjustments), and the job flows equal independent counts over the jobs' own stamps (`loss_total` equals the loss lines of `report_line_items`); the series summed by day, week and month over the week, March 2025 and the seed's week equals the summary on every basis; `report_lines`' recognised rows are exactly `financial_lines` and its work-in-progress money equals the lines' generated columns; `entry_kind` is only 'line', no `financial_lines` row has a NULL channel and no sale has source `work_order` |
| The date basis decides the day (Phase 9; SPEC §19.2, §23; D100, D35, D1) | `period-reports.test.ts`: each day and the week on all four bases equal `PERIOD_EXPECTED` (check-in 800.00 / 4 jobs, completion 680.00 / 3, collection 300.00 / 1, sale 1,680.00 / 710.00 / 970.00 / Cult Commons 306.00 / after 664.00); retail only on sale, work in progress only on check-in, the cancelled job nowhere; completion equals the workshop channel of the sale basis for any range; 23:59:30 counts Friday and 00:00:00 Saturday; ISO weeks and clipped, flagged month buckets; inline bucketing equals `private.shop_day` at the boundaries; job B's Cult Commons is 60.00, not 45.00, and a loss-only day shows −50.00 and 0.00 |
| Every breakdown partitions its period (Phase 9; D100, D103) | `period-reports.test.ts`: for every dimension and basis, on the scenario week and the seed's last 7 days, paging at `p_max_rows` 2 with the (sale_total, key) cursor covers every group once and the groups sum to the summary; channel keys are derived from `pg_enum`'s `sale_source` values (a new value fails the test); job rows equal `work_order_totals_staff`; `p_key` returns the same row; a key's line items (keyset, 2 per page) sum to its row and never include a voided line; line items without a key page through every line once past tied instants and a document without a counted line; the free line and the services' 0.00 cost come back as 0.00 (D14, D24 as amended) |
| Snapshots, restatement, refunds, currency, mechanic (Phase 9; SPEC §23; D21, D101–D104) | `period-reports.test.ts`: new catalogue prices and costs and a 50% Cult Commons rate leave March 2025 unchanged, archived services, products and staff appear by name; reopening job B, voiding its loss line and completing it on 11 March moves it (200.00 / 0.00 / 200.00 / 60.00); a manager's refund counts on its recording day in `refunds_total` / `refund_count` and changes no gross, cost, yield or Cult Commons (restocked line kept), NULL on other bases; a USD line is excluded and counted in `excluded_foreign_line_count`; the by-mechanic breakdown and `report_activity_by_mechanic` credit the lead, 'unassigned' and 'not_workshop'; `report_activity` for the week |
| Purchases and stock value (Phase 9; D105, D60) | `period-reports.test.ts`: a receipt today adds 1 receipt, 4 units and 30.00 purchases (deltas); `report_stock_value` adds 50.00 for +4 at 12.50, counts a NULL-cost product as uncosted and does not value it, values a 0.00 cost at 0, ignores a location below zero, counts a consigned unit and never values it |
| Report arguments and access (Phase 9; D30, D91, D92) | `period-reports.test.ts`: reversed or NULL bounds `report_range_invalid`, 732 days `report_range_too_long` (731 pass) on all six ranged RPCs; bad keys, keys of another dimension and half or conflicting cursors `report_key_invalid`; a mechanic with only `view_financial_reports` as an exception (granted by the admin) gets gross, counts, refunds and consignment counts with every cost column NULL, full figures with `view_costs` added, as do a manager and the admin; mechanic1 (view_costs only) and mechanic2 get 42501 from the financial RPCs and may read activity; a customer gets 42501 from all seven; anon has no EXECUTE; no report RPC returns a float; each period-report column leads a valid index |
| The app's report reads and export pagers (Phase 9 step 2; D30, D100) | `period-report-exports.stack.test.ts` (through PostgREST on the devstack, as the app calls it): walking `report_breakdown` two groups at a time with the cursor passed back as received visits every group once, in one page's order (job, product and mechanic); the breakdown export's groups add up to the summary's `line_count` and end with the summary's own TOTAL row; the lines export of the period and of J-000013 number their counts, newest first; mechanic1 (View costs only) and mechanic2 get 42501 from the summary; the by-mechanic rows are for any staff, the lead-less one "Unassigned" |
| Stock reconciles with the ledger (Phase 9 step 3; SPEC §12, §23, §26; D106) | `stock-reconciliation.test.ts`: the seed has no unit or stock issue (no seeded negative_on_hand) and every unit's ledger equals the on-hand its status implies; running both RPCs and the exceptions writes nothing (movement, unit, unit-event and consignment row counts and stamps unchanged); the exact columns, none a cost, the 1..1000 clamp. Every RPC-reachable unit state reconciles after EVERY step, with the expected disposition: unit 1 held (`add_inventory_line`), voided back to available, held again, sold at completion, reopened to held (D25), sold again; unit 2 sold by `record_retail_sale`, refunded (still sold_by_sale, D7), restocked (in_stock while the old sale line still names it), transferred (ledger location = the new one); unit 3 held, voided, job cancelled (D16); unit 4 a consigned unit sold on a job (D44, item sold); unit 5 consigned and returned; unit 6 written off; none of them is an exception, and Phase 4's deferred check agrees. Each corruption, written as the owner with `session_replication_role = replica` and rolled back, gives exactly its code and the same `issue` in `operational_exceptions` (as the admin): an extra +1 at a second location `ledger_out_of_range`; a sold unit set available `sale_without_sold_status`; a sold unit given a later +1 `sold_without_sale`; a held unit whose job is cancelled without a void `held_without_open_job`, listed once as Phase 5's `unit_hold_stale`; an available unit given −1 `in_stock_without_ledger`; set written_off without a movement `ledger_without_stock_status`; location changed without movements `location_mismatch`; the item set sold while its unit is available `consignment_status_mismatch`; a quantity product below zero `negative_on_hand`, mirrored by exactly one `negative_stock` row; a unitless unique-product movement `unique_movement_without_unit` (the unit itself still clean); a moved unit `unit_count_mismatch` at both locations. `unit_expected_on_hand` equals `assert_unit_consistent`'s rule for all six statuses (consistent at net 1 exactly when it says 1, at net 0 exactly when it says 0). Access: every seeded staff member may call both RPCs; a customer gets 42501, anon has no EXECUTE, no API role selects the three views; a mechanic without `view_costs` reads the same unit row as the admin. |
| Operational exceptions, extended (Phase 9 step 3; D34, D104, D107, D108) | `operational-exceptions.test.ts`: with one row of each Phase 5 kind, the first nine columns of `reporting.operational_exceptions` for Phase 5's kinds equal exactly what Phase 5's own view body (read from `20261004002500_daily_summary.sql`) returns, and the appended columns are `issue` (the kind; `negative_on_hand` for negative_stock), `short_id` = `title` = `entity_label`, `detail` = `subject_label`, `amount` and `currency` NULL; the RPC returns `OPERATIONAL_EXCEPTIONS_COLUMNS` (Phase 5's nine, then the six appended). D107: an item received 60 and sold 45 shop days ago is raised for the admin with amount 300.00, currency SGD, days 45, since = the sale and the consignor's name in subject and title; the threshold hides it at 60 and 45 and shows it at 44 and 30; the current value again writes no `schedule_events` row and a change writes one with `{from, to}`; 0, 366 and NULL are `alert_days_out_of_range`; a direct UPDATE as the admin is 42501 and changes nothing; a mechanic with `manage_consignments`, mechanic2, mechanic1 and the manager get 42501; a partial settlement leaves 200.00, a full one clears it, a restock clears another item, and a sale 5 days ago is not raised. D108: the admin, the manager, mechanic1 (`view_costs`) and a mechanic with `manage_consignments` see the unsettled row, a mechanic with only `view_financial_reports` and mechanic2 do not; everyone sees a `unit_state_mismatch`; for each of the six, `report_exception_counts` per kind equals the list per kind and `today_dashboard(null).exceptions_now` its length. `private.integration_exceptions()` has exactly Phase 10's nine-column signature (from the catalogue), is definer, stable, `search_path=""`, executable by no API role, and is Phase 10's body (since reporting joined `main`): the admin sees each seeded `needs_attention` job once, as `integration_failed` with `issue`, `title` and `detail` filled by the view, and mechanic2 sees none (R-058); `exception_visible` gives the per-kind rule for the admin, the manager and mechanic2 (since Phase 14 step 2 also `payment_attention` and `stripe_attention`; the integration count is by kind). D104: an owner-written USD work-order line and a two-line USD sale are listed (`work_order_line` and `sale`, with S- number, description · USD and since = `recognized_at`), and they are exactly the documents `private.report_rows(…, true)` returns and `excluded_foreign_line_count` counts (1, 2 and 3). |

### End-to-end (SPEC §27.3)

Harness (`playwright.config.mts`, `tests/e2e/`): Chromium only, two projects
— `phone` (iPhone 13, 390 px: bottom tab bar) and `tablet` (iPad gen 7,
810 px: side rail). `webServer` runs `npm run build && next start -p $E2E_PORT`
(default 3100) with the devstack URL and local demo keys passed explicitly
(so `.env.local` does not matter). `tests/e2e/global-setup.mts` resets and
seeds the dev database, `PGDATABASE` (default `bicii_dev`; `E2E_RESET=0`
skips), starts the devstack if needed, and waits until the
seeded admin can sign in through the gateway and call `my_staff_profile`
(with an email code: the service-role admin API generates it, Auth
verifies it, no email is sent) and the mail catcher answers `GET /health`
(skipped for `E2E_EXTERNAL_STACK=1` unless `BICII_MAIL_KIND` is set).
Tests run serially (one shared database). The browser is
`PLAYWRIGHT_CHROMIUM_EXECUTABLE` when set, else `/opt/pw-browsers/chromium`
when it exists (the build agent's container, where browsers are never
downloaded), else Playwright's own Chromium, installed once with
`npx playwright install --with-deps chromium`
([ENGINEERING.md](ENGINEERING.md#prerequisites-and-access)).

```sh
npm run test:e2e                       # build + start on E2E_PORT (3100), reset PGDATABASE (bicii_dev), run
E2E_REUSE_SERVER=1 npm run test:e2e    # reuse an app already on E2E_PORT (3100)
E2E_RESET=0 npm run test:e2e           # keep the dev database as it is
```

A second checkout (README "Postgres somewhere else?") sets its own
`PGDATABASE`, `BICII_*_PORT` and `E2E_PORT` first, so its E2E run resets
only its own database and serves on its own port.

The seed's history is relative to the day it was reset (DATA-MODEL §18
"Phase 5 part"). Global setup reads that anchor day once, from the seeded
T3 job's check-in, into `E2E_SEED_ANCHOR` ('YYYY-MM-DD'; the workers
inherit it); specs use `seedAnchor()` and `anchorDay(n)` from
`tests/e2e/helpers.ts`, never the wall clock, because with `E2E_RESET=0`,
`E2E_EXTERNAL_STACK=1` or a run across Singapore midnight the anchor is not
today.

Signing in (PLAN D10, D70; `tests/e2e/helpers.ts`): every spec signs in
through the real `/login` form with an emailed code. `signIn(page, who,
next?)` and `signInOnForm(page, who)` (seeded staff) and `signInAs(page,
email, next?)` / `signInOnFormAs(page, email)` (any login) all end off
`/login`. Underneath, `requestCodeOnForm(page, email)` takes a mail cursor
(`mailCursor`) BEFORE pressing "Email me a code", expects "Check your
email" and returns `waitForCode({ to, after: cursor })` from the mail
catcher, so an older email to the same address is never used. Auth sends
at most one email per address per second (`max_frequency` 1s, kept in the
devstack and config.toml) and the Admin shows a refusal there as "Check
your email" (D70), so the helper waits until 1.1 s have passed since this
worker last asked for that address, and if no email arrives within 5 s it
goes back with "Use a different email", waits again and asks again, up to
5 times. The app runs with `SIGN_IN_LIMIT_MULTIPLIER=1000`
(`playwright.config.mts`): the suite signs in hundreds of times from one
address, past the Admin's own limits (D72), which the unit and stack
tests cover. Specs reach the mail client through
`tests/e2e/mail.ts` (a dynamic import: Playwright compiles specs to
CommonJS) and the database through `tests/e2e/db.ts` (`sql()` on
`devDatabaseUrl()`, for the two assertions no screen can make).

Phase 0 specs (`auth.spec.ts`, `staff.spec.ts`): signed-out `/` redirects to
`/login`; `?next=` deep links survive sign-in and cannot leave the origin
(absolute, `//host`, `/\host`, dot segments such as `/.//host`, including
the server-side redirect a signed-in visit to `/login` makes); an unknown
email (`e2e-unknown-<project>-<time>@bicii.test`) gets exactly the "Check
your email" text a staff email gets (compared with the address
substituted), no `auth.users` row and no email within 2 s; a wrong code
(a six-digit value that differs from the real one) gets the one
invalid-code message, keeps the email, is not echoed and puts focus back
on Code, and the real code (pasted as "123 456") then signs in (Auth
2.178 does NOT void a code after a wrong attempt); an expired code is
refused (the spec moves `auth.users.recovery_sent_at` back 11 minutes:
for an email code to an existing confirmed login Auth 2.178 times the
code from `recovery_sent_at` and ignores `auth.one_time_tokens.created_at`,
established on the devstack by ageing each separately); a used code is
refused in a second browser context that asked for a newer code; "Send a
new code" is disabled with a live countdown ("Send a new code in 0:59"),
"Use a different email" returns to the email step with the email kept
and focused, and after the countdown (the page clock fast-forwarded)
"Send a new code" announces "We've sent a new code.", restarts the
countdown, and only the newest code works; a confirmed login with no
staff row gets the not-staff message after its code and keeps no session;
the admin lands on Today with the tab bar (phone) or rail (iPad);
sign-out ends the session; mechanic2 gets a real 403 on
`/settings/staff`; asking twice in a row ("Use a different email", then
the same address) gives an address with a login and an unknown address
the same "Check your email" screen both times (the main region's markup
compared with the address, React ids and countdown digits normalised,
plus the focused field), while Auth's per-address interval is held open
for the login (`recovery_sent_at` set ahead; a direct `/otp` call then
gets 429 `over_email_send_rate_limit`, D70); a permission the admin grants shows on mechanic2's
profile and in the staff history (then is revoked), and on a phone the
confirmation toast leaves the Scan tab tappable; a rejected invite keeps
the typed name and email; the invite's success view says how to sign in
and shows no credential; the invited colleague (unique per project and
run) signs in with an emailed code as active staff with no granted
permissions (Today opens; `/settings/staff` is 403), and when the admin
deactivates them (a reason is required and shows in their history) their
open session ends at once (PLAN D71: the deactivation deleted their Auth
sessions, and on the devstack's HS256 keys `getClaims` asks Auth, so their
next navigation lands on `/login?next=…`); they can still ask for a code
and see the same "Check your email" screen, but after typing the emailed
code they stay on `/login` with the not-staff message, and `/` still
redirects to `/login`. The hosted window of D71 is driven too: a second
invited colleague signs in, is deactivated with `staff_revoke_sessions`
disabled inside that one transaction (`sqlTransaction` in
`tests/e2e/db.ts`), so their session still verifies at Auth, and `/` and
`/settings/profile` (no permission needed) show the 403 page ("403 · No
access", "You can't open this") and none of their data. The HTTP status
is not asserted there: a page whose shell has started streaming keeps
200 (Next's `forbidden()` docs).

Period reports spec (`reports.spec.ts`, Phase 9 step 2, D30,
D100–D105; read-only, on the seeded Phase 5 history counted from the seed's
anchor with `anchorDay(n)`, asserting J-000013's membership, never
emptiness or totals): **an admin** opens Reports from More (phone) or the
rail (iPad) on Week and Sale date with a Gross sales amount and a Yield
tile; on `?period=day&date=anchorDay(4)` steps Previous day and Next day
once each, and the page has no horizontal scroll; J-000013 is in the Job /
sale breakdown only under Check-in on anchorDay(4), under Completed and
Sale date on anchorDay(3) and under Collected on anchorDay(2), each basis
change keeping `period` and `by` in the URL; the Custom sheet refuses a
reversed range in place (values kept), then 2020-01-01 to 2020-01-07 on
Completed shows both empty-state sentences. **The drill-down**: the
J-000013 row opens `/jobs/<id>`; Product then the wheelset row opens
`/reports/lines` with a J-000013 line and a back link keeping the basis.
**The export**: the breakdown's Export CSV link has `target=_blank` and
`rel=noopener`; `page.request.get` returns 200, `text/csv`,
`attachment; filename="bicii-breakdown-completion-<day>_<day>.csv"` and
`no-store`; the body starts with the BOM, its header includes `cost`, and
it has the J-000013 row and a TOTAL row. **A manager** sees Yield and Cult
Commons (the role implies View costs, D91). **mechanic2** sees Activity
and the permission sentence, no Gross sales and no basis control; the
breakdown export answers 403 "Forbidden", `/reports/lines` the 403 screen
with a 403 status (no `loading.tsx` above it), and `kind=mechanics` a
200 CSV; since Phase 14 step 3 also no "Customer payments" heading, a 403
on `/reports/payments` and 403 on both payment exports. **Customer
payments** (Phase 14 step 3, D154): the test makes its own data as the
admin through `signInApi` and the real RPCs, on today's shop day
(`shopToday()`, not the seed's anchor, since the payments are dated now):
a customer and three bikes inserted through RLS (`insert` in
`tests/e2e/api.ts`), three jobs of one Wheel True ($35.00) through
`create_work_order`, $50.00 and $10.00 cash on the open one (the $10.00
then `void_counter_payment` given back), $20.00 PayNow on one completed
through `set_work_order_status`, $50.00 by card on one then collected.
Other specs record payments on the same day, so it reads Recorded at the
counter, Given back at the counter and Net taken before and after, and
asserts the change: +$130.00 and 4 payments, +$10.00 and 1, +$120.00;
then the two notes, no basis control in the section, the basis sentence,
each held list's "Total $… · n jobs", the open job under Paid on open
jobs ($50.00, "Paid at the counter · Paid ahead $15.00"), the completed
one under awaiting collection ($20.00, "Still to pay $15.00"), the
collected one under Paid above the bill ($15.00, "Paid $50.00 of a
$35.00 bill"), each in its own list only, no horizontal scroll; the
payments CSV (`bicii-payments-<day>_<day>.csv`, its header, the open
job's three movements `counter_payment` 50.00 and 10.00 and
`counter_given_back` -10.00, the collected job's one `card,50.00,SGD`)
and the held CSV (`bicii-payments_held-<day>.csv`, its header, the three
jobs' groups and statuses); **See each payment** opens
`/reports/payments` with h1 "Customer payments", the open job's three
rows in the list (the table is hidden below 1024 px; both projects are
below it), the give-back as −$10.00 and "Recorded …", no horizontal
scroll, and the back link returns to `#reports-payments`. Passes with
`E2E_RESET=0` too.

Exceptions and reconciliation spec (`exceptions.spec.ts`, Phase 9 step 4,
D106–D108; phone and iPad). Setup in `beforeAll`, as the admin through
`signInApi` and the real RPCs: a consignor (`new_consignor`) and a
consigned unique item received 60 shop days ago with a tagged name
(`tagFor`) and 300.00 agreed, sold with `record_retail_sale` 45 days ago
(D55); `afterAll` settles it with `record_settlement` and restores the
threshold to 30. **The admin** opens Today, which must have no
horizontal scroll (a full run found the Activity and Stock grids widened
by long tagged names from earlier specs, zooming the phone page out so
taps missed; fixed with `grid-cols-1` and `min-w-0`), follows its "See
all exceptions" link
(href `/reports/exceptions`), reads "Alert unsettled consignments after
30 days", finds the item's C- ID under Unsettled consignments with
"$300.00 outstanding" (no horizontal scroll), opens
`/consignment/items/<id>`, changes the threshold to 60 in the sheet
(toast; the item disappears) and back to 30 (it returns), and the
exceptions CSV has the header and the item's row; a `finally` restores
30 through `set_consignment_settlement_alert_days`, so a failure never
leaves 60 behind. **mechanic2** sees the threshold as text, no Change
button and no Unsettled consignments section (no all-clear is asserted:
Phase 5's job kinds are visible to all staff). **The admin** opens Stock
reconciliation from Reports' More reports and from Inventory's "Reconcile
stock"; under Problems only Unique items says "Every item reconciles
with the ledger" (after every earlier spec's RPCs in the serial run, so
a drift is a bug to fix); Everything (`all=1`) lists U-000001 with the
ledger on hand and expected values `report_unit_reconciliation` returns
(phone rows, iPad table); the products-by-location Export CSV has
`target=_blank`, `rel=noopener` and the header line. **Signed out**, a
fresh request context's `GET /reports/export?kind=exceptions` is
redirected to `/login?next=…` by the proxy; **mechanic2**'s is a 200 CSV
with no `unsettled_consignment` row.

Staff roles spec (`roles.spec.ts`, D90-D94; every record it creates
carries `tagFor(testInfo)`, seeded records are only read): **a manager**
(the seeded Kavya Menon) sees the Money section on Today and the seeded
job J-000002's Cost and Cult Commons, has no Staff row in Settings and a
403 on `/settings/staff`, creates and stocks a product (manage_inventory,
adjust_stock), sells it with the cost preview, records a partial refund
with a reason ("Refund of $6.00 recorded"), and their profile shows the
Manager badge, View costs, View financial reports and Record refunds but
not Manage staff or Admin settings. **A mechanic** (mechanic2) sees no
Money, no cost on J-000002, no Record refund on the seeded S-000004, a 403
on `/settings/staff`, and a profile reading Mechanic and "Workshop access
only". **An admin** finds their own row's role picker disabled with "You
can't change your own role." and nothing extra to grant; invites a
colleague (unique per project and run) with the Role picker offering
Admin, Manager, Mechanic and Mechanic chosen; grants Extra access "Manage
purchasing" (seven switches for a mechanic); changes the role to Manager
through the sheet (it names the extra access the role includes, and
focus starts on Cancel) with a reason; then sees "<name> is now a Manager", the Manager badge, one switch
left (Manage staff) under "Included in the Manager role: …", and in
History one "Role changed from Mechanic to Manager" with the admin and the
reason and "Extra access: Manage purchasing removed" with the same reason;
the list row reads "Every permission except Manage staff"; the colleague
signs in and their profile shows Manager and Record refunds; the admin
then deactivates them so no extra active staff remain. On the phone
project that test runs at 375 px wide (an iPhone SE) and checks that the
admin's own row, the invite form, the colleague's page and the change-role
sheet do not scroll sideways (`expectNoSideScroll`); on the iPad at its own
width. `staff.spec.ts`'s
invite test also checks "They join as a Mechanic." and "Set extra access".

Phase 1 spec (`customers-bikes.spec.ts`; every record it creates carries a
tag made of the project name and a timestamp, so the phone and iPad runs and
repeated runs never see each other's data): the admin creates two
customers in sheets (the contact card dials `tel:`), adds a bike from one
customer's page (owner preset; it gets a B- number and a `registered`
history entry), uploads the fixture JPEG (`tests/e2e/fixtures/bike-photo.jpg`)
with `setInputFiles` and sees the thumbnail load (640px wide: downscaling
leaves small photos alone), opens it and shares it with the customer
(badge on the tile, still set after a reload), makes it public (a fetch of
its public URL with no session succeeds; the private original's signed
link stops working) and internal again (the public URL stops working),
deletes it with a reason after checking Cancel returns focus (its signed
link stops working), finds the bike from the
header search by its serial number typed lower-case with spaces for dashes
and by its B- number, transfers it to the other customer with a reason (the
history shows both names, the reason and the actor), archives the first
customer (Add bike disabled; gone from search, listed under Archived);
mechanic2, with no permissions, creates a customer, adds a photo to the
customer record whose Public option is disabled with the D13 explanation
(and looks it: muted colour, not-allowed cursor), and registers a shop bike
with no customer. A search test slows every `/customers` result by 700 ms:
what is typed while "tan" loads is kept ("tan wei", not "tani"), and opening
a result while a search is still waiting to be sent keeps the record open.

Phase 3 E2E helpers live in `tests/e2e/helpers.ts`, not a workshop
module, because later phases' specs create jobs too: `tagFor(testInfo)`,
`section(page, title)` (the Card headed `title`),
`nextIntakeStep(page, expectStep)` and
`createJobViaIntake(page, {tag, requestedWork?, lead?, additional?, services?})`
→ `{id, jobNumber}` (a tagged customer and bike from the intake's sheets,
the wizard walked to Create job, intake photos skipped; signs nobody in).
`workshop-board.spec.ts` creates its job with it.

Phase 3 spec (`workshop.spec.ts`, `tagFor` from `helpers.ts`): SPEC §27.3
journey 1 (its part line came with Phase 4, below), as the admin: /jobs → New job → a new
customer and a new bike from the intake's sheets → requested work and
condition → Marcus Tan lead, Nur Aisyah additional → Full Service →
Review → Create job; the job opens on its J- number with the Intake photos
card, the fixture photo uploads and shows, Done drops `?intake`; People
lists both; Wheel True × 2 gives $270.00, cost $0.00, yield $270.00, Cult
Commons $81.00, after Cult Commons $189.00; a manual "Valve core" 1 × $5.00
costing $2.00 (after Phase 4's part line) gives $284.00 and $83.46; voiding
it with "Not needed" (two steps, 400 ms guard) brings $279.00 back and the voided line shows its
reason; Start work → Complete (Add service now disabled with the lock
explanation) → Ready for collection → Collected, with Completed and
Collected as separate dated rows; the timeline lists check-in, both
assignments, the photo, the four lines, the part's stock use, the void and its reason, work
started, completed, ready for collection and collected. Collected is the
second step of "Collected…" (the job named, focus on Back). A reload mid-intake
offers the draft back (Continue restores step and customer; Discard starts
afresh). mechanic2 (no view_costs) opens J-000002 and sees its $300.00 total
but no cost, yield or Cult Commons, and the page's data holds no cost key.

Phase 4 (`inventory.spec.ts`, phone and iPad, every record tagged and
stock asserted on the test's own product): journey 3 without receiving
(the label step was added by Phase 8 step 4, below): the admin creates a counted product (tag in name and SKU,
$12.00, cost $5.00, reorder point 3), records 10 opening stock at the Shop
floor with the "Opening stock count" chip (preview "Shop floor: 0 → 10"),
finds it by SKU on /inventory with "10 in stock", adds 1 to a walk-in job
from Add part (the option reads "10 at Shop floor · 10 total"; toast
"Added 1 × …. 9 left at Shop floor."), the line shows the P- number and
"9 left at Shop floor", the product 9, the movements list "Used on job"
with the J- link; voiding the line (the confirmation says it returns 1 to
the Shop floor) toasts "Returned to stock", the timeline shows "Used 1 × …
(P-…) from Shop floor" and "Returned 1 × … to Shop floor", stock is 10
again and "Returned from job" links "Reverses #n" to the original's
"Reversed by #m"; adding it again gives 9. A tagged unique item with its
first unit goes on job A ("It is on hold for this job"), the unit page
says "On job J-…" and job B's picker offers nothing. mechanic2 sees the
road tube's stock with no Adjust stock, Transfer, Edit details, Add unit,
Archive, cost, yield or Cult Commons (and no "3.80" in the page), and still
adds 1 to a job. Journey 1 (`workshop.spec.ts`) now adds 1 × the seeded
road tube (P-000003) after Wheel True: the toast's count is the picker's
Shop floor count minus 1 (relative, the database is shared), totals
$279.00 / cost $3.80 / yield $275.20 / Cult Commons $82.56 / after $192.64,
and the timeline shows the line and its `stock_consumed` entry.

Product categories (`inventory.spec.ts`, added 2026-10-12, phone and iPad):
the admin opens Settings → Product categories, adds a tagged category
(toast "<name> added", listed under Categories) that Settings → Services
does not show; New product offers it and the new product's header shows
it; archived (toast "<name> archived", listed under Archived categories),
the product keeps it (Edit details selects "<name> (archived)") and New
product no longer offers it. No database test is new: the categories
table, its per-kind unique name and its RLS are Phase 3's and Phase 4's
(`workshop-catalog.test.ts`, `inventory-catalog.test.ts`).

Phase 4 Step 4 (`inventory-publish.spec.ts` and `scan.spec.ts`, phone and
iPad). Publication: the admin creates a tagged counted product with stock
and a price and makes it internal; Publish is disabled with "Still needed:
A public photo." and the checklist marks the photo missing and the price
done, the preview reads "Not public. Anonymous scans show nothing." and
the QR URL ends in `/q/P-…`; a photo through "Choose photos" made Public in
the viewer (which offers no Customer level on stock) enables Publish; once
published the pill reads Public and the preview shows the name, $25.00,
Available and "1 public photo"; Unpublish brings "Not public" back.
Locations: a tagged location with sort order 900 is added from
/settings/locations (Shop floor keeps the "Default" pill), is offered in
the Adjust stock sheet, and once its switch is off it reads Inactive and is
no longer offered. Split: one of a tagged product's 5 is split off with a
reason; the new unit page shows its U- number and Available, and the
source reads 4. Bike link: B-000011's page reads "In stock as U-000001 ·
Available", archiving it toasts the `bike_in_stock` message, and the link
opens the unit. Scanning: typing P-000001 opens the product, `b-000001`
the bike, "hello" gives "Enter a code like P-000123", P-999999 shows "No
record with P-999999" whose "Scan again" returns to /scan, and
`/q/U-000001` (also lower case) redirects to the unit. The camera is
stubbed in an init script with the permission granted:
`navigator.mediaDevices.getUserMedia` returns `canvas.captureStream(10)` of
a canvas repainted every 100 ms in alternating colours (so the video
really plays and `requestVideoFrameCallback` fires), and
`window.BarcodeDetector` is a fake class whose `getSupportedFormats`
resolves `['qr_code']` and whose `detect` resolves the chosen
`rawValue`; `navigator.permissions.query` reports camera granted. With
`${E2E_PUBLIC_SITE_URL}/q/U-000001` (`tests/fixtures/public-site.ts`, the
same value `playwright.config.mts` gives the web server: since Phase 8 the
environment's scan-only base, `http://localhost:4001` by default) scanning
lands on the unit; with `https://example.com/phish` the page shows "Not a BICII
label" with the text, keeps detecting, stays on /scan and links nothing on
example.com, and typing a code still works. The header search finds
"shi-l05a-rf" as P-000001 with "N in stock", and `p-000001` + Enter opens
the product directly (`customers-bikes.spec.ts` and
`workshop-board.spec.ts` now expect the same jump for a B- or J- number,
and still check the results page for an exact J- number).

Phase 3 step 4 (`workshop-board.spec.ts`, read-only on the seeded jobs so
the phone and iPad runs share one database): as mechanic2 (Nur Aisyah, no
view_costs) My jobs lists J-000002, J-000003 (as additional), J-000005 and
J-000009 and not Marcus's J-000004, with group counts and no money on the
board; Unassigned lists J-000007; the Overdue age filter lists J-000006
with its Overdue badge (D20) and not J-000002 (ready for collection, so
never overdue however old the seed is, as with `E2E_RESET=0`); the status filter "Waiting on parts" lists
J-000005 and not J-000006 and its chip removes it; "j000004" in the job
number box finds J-000004. On J-000002 she sees Total $300.00 and no
"Cost", "Yield" or "Cult Commons" anywhere; on /settings/services prices
but no cost, no New service, no Edit and no Cult Commons card. mechanic1
sees Cult Commons $52.80 and BICII yield after Cult Commons $123.20 on
J-000002 and the 30% rate (without Schedule). The admin's header search
for "j-000004" opens J-000004 directly (Phase 4's short-ID jump), /search
for it lists Jobs first and opens J-000004, which Chloe's Giant's
Service history also lists. On a tagged service and job: the service
created in settings is offered in the job's Add service; the lead is
reassigned from Marcus Tan to Nur Aisyah in the Assign sheet (which says
Marcus leaves the job); a note, the approval switch and a details edit
(a blank requested work refused with the typed internal note kept); the
timeline shows both lead assignments, "Marcus Tan removed from the job",
the note, "Marked customer-approved" and the details change; the board
finds the job by number with Nur as lead.

Phase 5 (`today.spec.ts`, phone and iPad; today's values asserted as
deltas read just before acting, past days only from `seedAnchor()` /
`anchorDay(n)`, seeded jobs found by `REPORT_JOB_NUMBER`; Today tiles read
with `readCount` / `readMoney` from `helpers.ts`, which find a tile's
`<dt>` and read its `<dd>`). "Milestone M1.5" is a serial describe whose
job is kept per project: (1a) PLAN §3's exit criteria on a phone: as the
admin, Today's Checked in, Completed, Collected, Gross sales, Yield and
Cult Commons; a tagged customer and bike checked in through the intake with
the fixture photo, condition, requested work and Nur Aisyah as lead
(`createJobViaIntake` with `photo` and `condition`); a tagged product
(`createProduct`, moved here from `inventory.spec.ts` unchanged, as was
`pickPart`) with opening stock 10; Basic Service and one part added, the
line and product reading 9 before and after a reload; the totals panel
equal to `jobEconomics` over the two lines; start → complete → ready →
collected with separate Completed and Collected timeline entries and
stamps and "Counted in reports on <today> (completed)"; Today then reads
+1 checked in, completed and collected and gross, yield and Cult Commons
up by exactly the job's (summed with Decimal); the job under Activity →
Completed and Collected, its row opening the job; `/?entries=open` listing
its lines. (1b) mechanic2 sees the job's sale total and no cost, yield,
Cult Commons or recognition text, and on Today the workshop tiles and the
job in Activity but no Money section; mechanic1 (view_costs) sees the full
panel and no Money section. "Several days of history reconcile":
`/?day=anchorDay(3)` flows and money equal `SEED_DAYS[3]` (1000.00 /
400.00 / 600.00 / 180.00 / 420.00) with the past-day note and no "Right
now" or "Needs attention"; Previous / Next move one day; anchorDay(2)
shows the loss note with −$15.00 and Cult Commons $12.00; Last 7 days from
anchorDay(1) has seven rows, days 1–6 with the seeded completed,
collected, gross, yield and Cult Commons, the shown day `aria-current`;
`?day=garbage` is today. "Low stock and the day's significant adjustment":
P-000009, P-000008 and P-000012 listed and linking to their pages, "See
all" → `/inventory?filter=low`; A2 (P-000021 −6, "Water damage in
storage", Significant, Damaged) on anchorDay(1). "What needs attention"
(skipped with a message unless the seed's anchor is the live day, since
exceptions are relative to it): J-000017 overdue and J-000016 waiting for
collection, each opening its job.

Phase 2 spec (`appointments.spec.ts`, step 3; API helpers in
`tests/e2e/api.ts`: `signInApi(email)` signs in with an email code
without sending email (the service-role admin API generates it, Auth
verifies it, as `tests/db/stack.ts` `otpClient` does; it tells the UI
helper the address just had a code, so the next form request waits out
Auth's per-address interval), `rpc(token, name, args)` and
`select(token, pathAndQuery)` through PostgREST as that user, throwing
with PostgREST's error; global setup hands them the gateway URL and keys
as `E2E_GATEWAY_URL`, `E2E_ANON_KEY` and `E2E_SERVICE_ROLE_KEY`, because
specs load as CommonJS and cannot import `scripts/devstack/config.mjs`.
Until the email sign-in integration (2026-10-06) it used Auth's password
grant with the shared seed password; no password path remains). These tests use the live shop day
(`shopToday()`), not the seed's anchor: a customer books ahead of now.
`beforeAll`, as the admin through the API and idempotent for the second
project or a retry, sets the online notice to 0 and the capacity to 4,
opens today 00:00–24:00 with custom hours under the fixed id
`e4000000-0000-4000-8000-0000000000e2` (inserted with `is_new` when
missing, else saved again), and cancels today's leftovers from earlier
runs (customer note "Gears skipping…" or internal note "E2E no-show…",
still booked, confirmed or arrived; this also keeps Chloe under her three
online bookings, D37). `afterAll` always restores notice 120 and capacity
2 and deletes the custom hours with a reason. Journey 2: Chloe (her
seeded login) reads `available_slots` for today (remaining units null for
her) and books the first one with `book_my_appointment` on her Giant with
a tagged note; if no slot is left (the last half hour of the Singapore
day) the test is skipped with that reason, the only allowed skip;
`my_appointments()` lists it without internal fields. The admin opens
today's list and clicks the row by its href (Chloe has a seeded booking
today too), sees "Booked online", taps Arrived (pill and toast), Check
in: the Giant preselected, the note as requested work, Marcus Tan as lead,
"Check in and open job" lands on the new job with a J- number (and the
toast); the job's timeline shows "Checked in as J-…" and the link
"Opened from the appointment on … <time> (Service drop-off)" to the
appointment, and the job's chip "Booked appointment · … · Service
drop-off" links back too; back on the appointment: Checked in, the job card linking
to the job, history "Booked online by the customer", "Marked as arrived
by Asha Admin", "Checked in by Asha Admin", "Job J-… opened". "No-show
and late arrival" makes its own data: the admin books Daniel through the
API at now rounded down to the 30-minute grid (staff may book a slot that
has not ended), marks it a no-show, and in the UI "Reinstate as arrived"
turns the pill to Arrived with "Reinstated as arrived by Asha Admin" in
the history. Walk-ins and every earlier spec are unaffected; Today's spec
reads deltas, so the extra appointment today changes nothing it asserts.

Step 4 adds to journey 2, before the staff list: Today (`/`) shows the
booking in "Arrivals" as a link with href `/appointments/<id>` whose
accessible name starts with the booked time and Chloe Lim, "Still
expected" is at least 1, and Arrived is read; after check-in Today's
Arrived is exactly one higher (read before and after with `readCount`,
never absolute counts, D41) and the booking left the arrivals list. Chloe
Lim (`CUSTOMER_LOGIN.chloe`, signed in with `signInApi`, an email code) is the one
seeded customer login, used here and in the customer-access tests. "Staff
book for a customer and capacity closes the slot": mechanic2 (no
permissions), on the first Tuesday at least 21 days after `shopToday()`
(+7 on the tablet project, `clearDay`), with the capacity set to 2 through
the API at the start (4 again in `finally`, the spec's `beforeAll` value),
books Tan and Priya into 11:00 "Service drop-off" from each customer's
page (the Book sheet with the customer preset and locked) with a tagged
internal note; a third booking (Daniel) is not offered 11:00 (11:30 is);
both are cancelled through "Cancel appointment…" with a reason and 11:00
is offered again; `finally` also cancels the test's own tagged bookings.
`appointment-settings.spec.ts` (each day +7 on the tablet; `afterEach`
restores, through the replay-safe admin RPCs, Sunday's seeded
09:00–13:00, deletes the test's closures by their tagged reason with
"E2E cleanup" and deactivates its own type, so a failure never leaks):
an admin adds a whole-day closure on the first Wednesday at least 35 days
ahead → the day view says "Closed: <reason>", the Book sheet has no
times and "Next day with free times" moves on → deleting it (ReasonConfirm
with a reason) brings 10:00 back; a short day 12:00–16:00 on the first
Thursday at least 35 days ahead offers exactly 12:00–15:30 for the
30-minute type, then is deleted; a staff-only "E2E fit <tag>" (45 min, 1
unit) appears in the Book sheet with "Staff only" until it is deactivated,
and stays listed as Inactive; Sunday gets 14:00–16:00 (listed, and offered
on a Sunday at least 21 days ahead), then the seeded hours are restored in
the UI; mechanic2 reads both settings pages (Singapore time, the D2
sentence, the week, the types with Public / Staff only) without any Edit,
Add, New type or Delete control. Helpers: `clearDay`, `openBookSheet`
(the phone's floating Book or the md+ button) and `pickTime` (taps a time
chip) in `tests/e2e/helpers.ts`.

Phase 6 step 3 (`consignment.spec.ts`, phone and tablet, every record
tagged): an admin creates "Consignor <tag>" with a phone; receives one item
"Colnago Master <tag>" (serial, owed 500, asking 1000) → the item page
shows a `C-` number, a `U-` link and "For sale"; an agreement photo is
uploaded and its viewer has Internal checked with Customer and Public
`aria-disabled` and D52's sentence; a 120.00 charge cannot be added until
"Shop pays" is chosen (D4), then is voided with a reason, and the
"Timeline" shows Received, Charge added and Charge voided; a job made
through `createJobViaIntake` (lead Marcus Tan) takes the consigned bike
from Add part (the option reads "Consigned · Consignor <tag>" and
$1,000.00) and is started and completed → the item reads "Sold, awaiting
payment" with "Job J-…" and "Sold on J-…", and the consignor's Balance
reads Outstanding $500.00 with the item under Awaiting payment (D44);
mechanic2, in a second context, sees the consignor's item under Sold but
no "Outstanding", "Owed", "Paid", "$500.00", Record payment, Show payout
details or Receive item, and on the item page the asking price but no
Money card, no Timeline and no "$500.00" (D48); the admin records $200.00
with "PayNow <tag>" → Outstanding $300.00 and the payment listed; 350
against $300.00 reveals "Why pay more than is owed?" and keeps "Record
payment of $350.00" disabled until it is answered (D47); 300 is then
recorded → Outstanding $0.00, "Settled", and the item reads "Settled". A
second test receives "Several identical" (3) for a consignor created from
the picker's "New consignor" row, sees "3 of 3 left", returns 1 with a
reason → "2 of 3 left" and "1 returned to consignor" with the reason in
the Timeline. Review fixes: the Receive item sheet has no fieldset, input,
textarea or radiogroup past its right edge, on open and after "Several
identical" (phone and iPad); before anything sells the consignor's Balance
reads "Nothing owed yet", not "Settled"; mechanic2's consignor list row
reads "1 sold" and never "awaiting payment", the admin's "1 awaiting
payment".

Phase 6 step 4 (phone and tablet, every created record tagged, stock
asserted relative to a reading taken first):
`consignment-journey.spec.ts` is journey 4 below (its label step was added
by Phase 8 step 4, above): an admin creates "Consignor <tag>", receives
"Colnago Master <tag>" (owed 500, asking 1000; `C-`, `U-` link, "For
sale"), uploads a listing photo and makes it Public while the agreement
photo offers no Public (D52), makes the product internal and publishes
it, and "What the public sees" shows it Available at $1,000.00 with no
"$500.00" (D45); Sell on the item page prefills 1000.00 and records
"S-…"; the sale page shows $1,000.00, Direct cost (incl. consignor payout)
$500.00, Yield $500.00, Cult Commons (30% of positive yield) $150.00 and
BICII after Cult Commons $350.00 with "owed $500.00, paid separately"; the
public preview then reads Sold (D26); the consignor shows Outstanding
$500.00 with the item under Awaiting payment; mechanic2 sees $1,000.00 but
no "Yield", "Cult Commons", "Direct cost" or "$500.00" on the sale, and no
"Outstanding", "Owed", "$500.00", Record payment or Show payout details on
the consignor (D48); $200.00 ("PayNow <tag>") leaves $300.00 and $300.00
settles it ("Settled", D47); Today's "Consignment sales" tile is at least
$1,000.00, says "sales or jobs with consigned items", and opens
`/sales?day=<today>`, which lists the sale. `sales.spec.ts`: an
admin sells one "Dry chain lube 120ml" through New sale and the picker
(price 16.00, a Preview with the $9.00 yield) → the product has one less
in stock; a $5.00 partial refund with a reason marks it Partly refunded
on the sale and in the list and leaves the stock unchanged (D7, D49); a
tagged unique "Frameset <tag>" made in New product is sold from its unit
page (450 warns "Below the asking price" and "Below cost: this sale loses
money", D53; "Sold earlier?" with a time next year marks Sold at with
"Enter a date and time that is not in the future." and aria-invalid and
records nothing), the unit reads "Sold on S-…", and Restock… with a reason
from the sale line → "Restocked" and the unit Available again (D46);
mechanic2 sells one "DSP 3.2mm bar tape" (only "Below the asking price"
warns; no Preview, cost, yield or Cult Commons in the sheet or on the
sale, no "$26.00", no Record refund) and the stock drops by one.

Phase 7 (`purchasing.spec.ts`, phone and iPad; suppliers, products and
orders tagged with `tagFor`, the seeded orders `PURCHASE_ORDER` only read;
helpers in `tests/e2e/purchasing-helpers.ts`: `createSupplier`,
`startOrderFromSupplier`, `addOrderLine`, `submitOrder`,
`createSubmittedOrder`, `openReceive`, `receiveLine` and
`interceptReceiveActions`, which drops the receive page's Server Action
POSTs (`next-action` header) on purpose). Suppliers and orders: a buyer
adds a supplier (tel: and https links), orders from it with the supplier
preset, changes a line, submits and finds the PO from the header search
however typed; mechanic2 follows PO-000002 (18 of 20, Overdue, DN-5531)
without any cost or control; a cancel needs a reason and keeps it in the
history; a received PO is closed. Journey 3's receiving step: a counted
product (reorder point 20, cost 12.00) and a tagged supplier; an order of
20 × $12.00 submitted and received: the line defaults to 20, 18 at an
actual cost of $12.50 ("Differs"), the default location, the commit
button DOUBLE-CLICKED; the order shows the toast "Received 18 items. 2
still to come.", Partially received and "18 of 20 received · 2 to come"
with one receipt, whose line's "Print 18 labels" opens the product's
print sheet at 18 (closed without printing; R-029); the product shows 18
in stock before and after a reload,
exactly one `Received +18` movement, the supplier with "Last cost $12.50"
and "On order: 2"; one part used on a job → 17; `/purchasing/reorder` for
the supplier lists it ticked with on order 2 and "Suggested 21", and
Create draft order opens a draft with it × 21 at $12.50. Lost response:
the receive POST reaches the server and the connection is then reset →
the error toast, the form read-only while checking, then "This delivery
was recorded … (6 items)" with no Retry; one receipt, stock +6 once;
"Receive another delivery" shows 4 to come with an empty delivery note,
and typing the same note (any case) shows the duplicate warning with the
commit disabled until "This is a different delivery" is ticked. Lost
request: the next POST is reset before it leaves → checking → "It was not
recorded. Retrying is safe…" → Retry → "Order fully received.", exactly
two receipts, 10 in stock. The receive page of PO-000001 shows the closed
state; mechanic2 gets a real 403 on `/purchasing/receive/<PO-000002>` and
`/purchasing/reorder` and sees no Receive or Reorder link; the admin sees
Receive on an open PO, "Submit the order before receiving" on a draft,
and Reorder on the Inventory low-stock filter. Phase 4's journey-3 spec
still seeds its stock by an opening count and prints its labels from the
product page.

E2E residue and Today's low-stock list (found merging `main` into labels,
first on `feat/p10-shopify`): `bicii_dev` is reset once per run, and Today lists
only the first five low-stock products by shortfall, where
`today.spec.ts` expects the seeded hydraulic hose, cable kit and sealant.
`createProduct` (`tests/e2e/helpers.ts`) therefore sets a reorder point
only when a test passes one: the purchasing spec's two products need
theirs (one per project, shortfall 3); the labels spec's product no
longer has one. With both, the tablet run's Today list had seven
candidates and dropped the sealant (the first gate run on that merged
tree: 199 passed, 1 failed).

Phase 8 step 2 (`print-view.spec.ts`, phone and iPad, READ-ONLY on the
seeded print jobs: it never clicks Print, Open PDF or a confirmation).
`payload` is `${SHOP.publicSiteUrl}/q/P-000011` (the database base,
`http://localhost:4000`) and every payload assertion is exact equality:
the queued job's print view has 10 `[data-label]` boxes whose
`data-qr-payload` all equal it; the "Open PDF" href (read, not clicked)
fetched with the page's session is 200 `application/pdf`, `no-store`,
`inline; filename="labels-P-000011-x10.pdf"`, and pdf-lib reads 10 pages of
58 × 40 mm with 10 link URIs equal to the payload; under print media the
toolbar, captions and the toast region are hidden and every rendered text
element is inside a label; the printed job shows "Printed … by Marcus
Tan", a Print again link equal to `reprintPath`, no Print or Open PDF,
and its PDF is 409 (a malformed id 404); `/labels` lists the five seeded
jobs, Failed shows the failed job (its reason on the detail page, the
label as an image) and not the queued one, the reprint's detail links
"Reprint of" to it, To confirm shows the rendered bike tag and not the
printed job; `/scan` manual entry opens the product from the payload and
from `${E2E_PUBLIC_SITE_URL}/q/P-000011` (the environment base, asserted
different); the product page's "QR label URL" equals the payload.
`inventory-publish.spec.ts` now expects the new product's QR URL on
`SHOP.publicSiteUrl`.

Phase 8 step 3 (`labels.spec.ts`, phone and iPad; `window.print` stubbed
with a counter; `base` is `SHOP.publicSiteUrl` and payload assertions are
exact equality; it never changes the shop's public address or a seeded
job's status): a tagged product printed ×10 on the browser printer (chip
10) gives 10 `[data-label]` boxes with `${base}/q/P-…`, Print calls
`window.print` once, "Yes, all printed" → "Marked as printed" and the job
reads Printed (and appears in the record's Labels card); a unit of a
tagged unique product the spec creates (unique data: E2E prints on no
seeded unit, so its jobs never crowd a seeded record's latest jobs) shows
"Not public" under "What the public sees", its sheet says "Not public
yet…" and caps at 10, its one label carries `${base}/q/U-…`, its condition
line and its short ID, the print view asks "Did the label print
correctly?", and that payload typed into /scan opens the unit (the bike
size line of a bike-linked unit is covered by `labels.test.ts`); a tagged
bike's tag marked failed (reason required after the 400 ms guard; the
print view's sticky toolbar is under a quarter of the viewport and **Mark
as failed** is in the viewport on the phone) is listed under Failed with
the reason, and its Print again opens the bike page's sheet "Print again ·
B-…" with quantity 1 and makes a new job, after which Back returns to the
failed job's print view with no sheet open, and the new job's page links
"An earlier print job"; mechanic2 prints a bike tag,
sees no Labels and printers row and gets a 403 at `/settings/labels`; the
admin's "{tag} 50 × 30" template shows "does not fit" with Save disabled
for a 30 mm QR, saves with 24 mm, prints 2 labels with `@page` 50.0 × 30.0
mm and is switched off; a signed-out context ends on /login for a print view
and a PDF (that is proxy.ts); the seeded customer login (Chloe), signed in
(her session cookies made by `sessionCookiesFor` in `tests/e2e/api.ts`
through `@supabase/ssr`, because the login form signs anyone who is not
staff out straight after the code, D70), gets a 403 from the PDF route (not `application/pdf`, no `%PDF`) and a 403
"You can't open this" print view with no label: the handlers' own staff
checks; `/bikes/{random uuid}` shows "Nothing here", not the error page.
Two cases still print on seeded records (mechanic2 on `BIKE.priyaTern`, the
admin's template on `PRODUCT.barTape`): the stack test reads neither
record's newest jobs, only that the bar tape has some and a printed price; an archived tagged bike's page renders with "That record is
archived…" and Print label disabled; Labels and printers shows `base`, and
the bar tape's Labels card and "QR label URL" both equal `${base}/q/P-000011`,
never the environment base.

Phase 8 step 4 (the journeys' label steps, phone and iPad; shared helpers
`QR_BASE`, `qrPayloadFor`, `labelPayloads` and `pdfLinkUris` in
`tests/e2e/label-helpers.ts`, also used by `print-view.spec.ts` and
`labels.spec.ts`; payload assertions are exact equality on the database
base). Journey 3 (`inventory.spec.ts`), after the opening count and before
the job: the product's Print label, chip 10, "PDF download", "Print 10
labels" → 10 `[data-label]` boxes all `${base}/q/{P-…}`; the "Open PDF"
href is `/api/labels/{job}/pdf`, fetched as 200 `application/pdf` with 10
pages whose 10 link URIs equal the payload; clicking Open PDF opens a tab
(closed) and "Did all 10 labels print correctly?" → "Yes, all printed" →
"Marked as printed"; `/labels?q={P-…}` lists the job as Printed, 10 ×; the
product still has 10 in stock (printing moves no stock) and the journey
continues unchanged. Journey 4 (`consignment-journey.spec.ts`), after the
product is published: the bike's unit page → Print label (heading "Print
labels · U-…", quantity 1, browser printer, `window.print` stubbed) → one
label `${base}/q/{U-…}` whose accessible name is "Label: Colnago Master
<tag>, $1,000.00, U-…" and whose text has no "$500", cost, consign or
internal; its price field reads $1,000.00 (D58); "Yes, all printed"; the
unit page's "What the public sees" shows the name, the same price and
Available, and nothing matching /cost|consign|internal|\$500/i. The
anonymous half (an anonymous scan reads the same row) is the database
test in `labels.test.ts` ("reporting.public_items returns identical rows to
anon and to staff"). The suite's run counts are recorded with the
command in [ENGINEERING.md](ENGINEERING.md#commands).

Phase 10 step 4 (`shopify.spec.ts`, phone and iPad; Shopify is the
in-memory fake, `playwright.config.mts` sets the fixtures' secret and shop;
every order id and name, refund id and webhook id carries the project and
a timestamp; the Playwright `request` fixture POSTs to
`/api/shopify/webhooks` with `webhookHeaders()` from
`tests/fixtures/shopify.ts`). Journey 5 on the project's own
`SHOPIFY_PRODUCT.e2ePhone` / `e2eTablet`: the product is made public (a
public photo, Publish) unless it already is; on-hand N is read; **Publish
online** → toast "Published online", the card shows Synced and "Online
quantity N at Shop floor"; the variant and product gids are read from
"Shopify details"; an `orders/paid` for 1 × that variant (with a Shopify
customer) is POSTed → 200, the identical delivery again → 200, the same
order under a new webhook id → 200; the page is reloaded until on-hand is
N−1, then again after 2 s (still N−1), and the recent movements show
exactly one more "Sold online"; `/shopify/events?q=<order name>` shows the
first event Processed, "Delivered 2×", "Recorded as S-…" and the second
"Already recorded (S-…)"; the event's Summary links the sale and its
Customer card says "Not linked" with **Link to a BICII customer**; a
`refunds/create` (one line, one transaction, 5.00) → 200, its event says
"Refund of $5.00 recorded; stock untouched", and on-hand is still N−1 (D7,
D85). The database is reset only once per run, so a CI retry that finds
the product already published (or, below, the variant already linked)
fails with a message saying so rather than skip the publish or link
assertions; run `npm run test:e2e` again. Unmapped variant on `e2eLinkPhone` / `e2eLinkTablet`: an order for
`gid://shopify/ProductVariant/9800000001` (phone) or `…02` (tablet) → the
queue's Needs attention row names the line ("… is not linked to a BICII
product"); Today's Needs attention lists "Shopify needs attention" with
"Fix it in the Shopify queue" and opens `/shopify/queue?job=…` with the
job's sheet; **Link to a BICII product** → the product SearchPicker by
P- number, a reason, **Link and retry** → toast "Recorded as S-…", on-hand
M−1, and the product card shows the variant and "Linked to a product made
in Shopify". Bad signature: a POST signed with another secret →
401; the Rejected filter finds it by webhook id with "Signature did not
match"; its page shows the signature Invalid and "Body not stored…" with
no JSON; on-hand unchanged. Boundaries: mechanic2's More list and iPad
rail have no Shopify entry (Sales is listed), and mechanic2 gets a real 403 on
`/shopify` and `/shopify/queue`, sees the product's sync status with the
switch disabled and "Needs Manage inventory" and no Sync now; an anonymous
GET of `/api/cron/integrations` is 401, not a redirect. Overview: More →
Shopify (the link in the More list; on the iPad the admin's rail lists
Shopify too); the test-orders warning, Connection "Test (fake)" and the webhook
address, the Needs attention tile; switching the test-order setting and
saving without a reason shows the field error and saves nothing;
`/shopify/products` lists P-000027 Synced; `/shopify/queue?view=recent`
marks Recent.

Indent parts (`indent.spec.ts`, Phase 13 step 2; D140–D147, ADR-024), on a
phone and an iPad: the admin creates a supplier, a product and a job (its
own supplier, because ordering adds to the supplier's newest draft, D145,
and the seeded draft PO-000004 belongs to `purchasing.spec.ts` and
`today.spec.ts`), proposes 2 of the part from that supplier and the seeded
Wheel True service (nothing reaches
the job's lines), sends the quote (the total $275.00; the link is
`/quote/` plus 43 characters, the message names the job; the card then
offers **Send again (2 items)**). The customer opens the link in a new,
signed-out browser context: the response carries `Referrer-Policy:
no-referrer`, `X-Robots-Tag: noindex` and `Cache-Control: no-store`; the
page greets "Hi Intake", shows the job number and both items and not the
supplier; sending with nothing chosen says "Approve or decline every item
(2 still need an answer)."; approving both shows "You approve $275.00";
with a name the answer is thanked ("You approved 2 of 2 items"), and a
reload shows the answer with no form; a 43-character link that is no
quote's says "This link is not valid" (not the sign-in page). The card
shows "Quote answered by …" and Approved; **Order approved
parts** adds the part to the supplier's draft and the job's header shows
Waiting on parts; the order is submitted and received in SQL as the admin
(`receive_purchase`), the part shows Arrived and the product page lists
it as "Reserved for jobs" (the job number, × 2), **Fit** ($240.00) puts it
on the job and **Add to job** the service: both are then in Lines, and the
product page no longer lists it as reserved. From the answer until both
are fitted, Lines shows the memo "Approved, not on the bill yet: 2 items,
$275.00. Fit them to bill them." (R-082), which is gone once they are.
Test 2, "Complete settles first: a part bought outside BICII" (D149a,
D149b): a product (cost 70.00) proposed with **Expected cost each** 28.00,
quoted and approved through the quote page's own RPC
(`answerQuoteByLink`, `tests/e2e/db.ts`); **Start work**, then
**Complete…** opens "Before completing J-…" with the part ("1 × <part> ·
$120.00") and **Complete job** disabled; **Fit** → **Bought outside
BICII** shows **Cost each** prefilled 28.00; 30.00 and "Bike Hub receipt
4471", "The stock count there doesn't change", "Cost 1 × $30.00 =
$30.00", **Record and fit**, the toast "<part> is on the job (bought
outside BICII)."; the checklist says "All settled.", **Complete job**
completes the job, the part is in Lines and the timeline reads "Bought
outside BICII · Bike Hub receipt 4471"; the product's Recent movements
are exactly "Bought outside BICII +1" and "Used on job". Test 3, "Cancel
job lists the approved items with Cancel only, and withdraws the open
quote" (D149c): Wheel True approved on one quote, Basic Service on a
second, open one; **Change status** says to cancel the approved and
ordered indent items too, and its **Cancel job…** opens "Before cancelling
J-…" ("Cancel each approved or ordered item first…", "Cancelling the job
withdraws the quote sent …", "its item goes back to Proposed.") with no
**Add to job** and its own **Cancel job…** disabled; **Cancel item…**
with a reason, then "All settled.", **Cancel job…** with a reason (after
the 400 ms confirm guard), the toast "J-… cancelled", the header
Cancelled, the quote line "The last quote was withdrawn." and Basic
Service back to Proposed. Test 4, "Voiding a fitted indent part puts it
back to approved, with Fit and Cancel (D160)": a part proposed, quoted
and approved, fitted as **Bought outside BICII** at 30.00 (Fitted, no
**Fit**); **Void…** on its row in Lines says "Voiding puts <part> back to
approved: fit it again or cancel it before completing the job.", and with
a reason and **Void line** the toast reads "<part> is back to approved";
the item is Approved again with **Fit**, **Cancel** and "Its line was
voided, so it is not on the bill. The part bought outside BICII went back
into stock: fit it from stock, or cancel it.", the memo reads "Approved,
not on the bill yet: 1 item, $120.00. Fit it to bill it." and the
timeline "<part> back to approved: its line was voided"; **Complete…**
lists it with **Complete job** disabled (**Back** closes it); **Fit** says
"It went back into stock when its line was voided" and **Fit part** fits
it from stock ("<part> is on the job."), after which it is Fitted and the
memo is gone.

Customer payments (`payments.spec.ts`, Phase 14 step 2; D151–D159,
ADR-025), on a phone and an iPad, against the in-memory Stripe
(`STRIPE_ADAPTER=fake`, above). Every spec shares the one reset database,
so the spec sets the deposit back to 0 straight after each quote is sent
(the quote already holds its 50% snapshot, D158a) and again in
`afterEach`: `indent.spec.ts` and the rest never see a deposit. Ids carry
`tagFor(testInfo)` and the project name. Test 1, "deposit: asked, paid
through Stripe (fake) and a signed webhook, then ordered": the admin opens
Settings → Customer payments ("Fake Stripe (development and tests only)",
the `/api/stripe/webhooks` endpoint) and sets 50% (the toast "Customers
pay 50% of the approved indent parts after answering"); a supplier,
product (120.00) and job, 2 × the part and Wheel True proposed and quoted;
the customer, signed out, sees "a deposit of 50% of the parts you
approve", approves both and gets the Deposit card ($120.00, "50% of the
parts you approved", **Pay $120.00 deposit**: the part only, not the
fitting). On the job, Customer payments says Deposit due, the part row
has the Deposit due badge, and the order sheet lists it unticked as
"(deposit not paid)" with **Add to order** disabled; ticking it shows
"Why order before the deposit is paid?" and **Order without deposit**.
Pay returns at once (the fake's session URL is the success URL) to
`?deposit=returned` with `Referrer-Policy: no-referrer` and
`Cache-Control: private, no-store`, showing "We're confirming your payment
with Stripe…"; SQL shows one pending payment of 12000 cents. A
`checkout.session.completed` for that session, signed with the fixtures'
secret (`tests/fixtures/stripe.ts`) and carrying customer details and a
success URL, is posted twice (200 `duplicate: false`, then `duplicate:
true`) and once signed with another secret (400 `signature_invalid`); SQL
shows the payment paid, exactly one `payment_received`, and a stored
payload without `customer_details`, `success_url` or the email. The
customer's page then reads "Deposit of $120.00 paid. Thank you." and
"Your deposit is paid, so the shop will order your parts."; the job shows
Deposit paid, "Paid online" $120.00 with "Paid ahead", the timeline "Deposit
of $120.00 paid online", and the order sheet lists the part ticked with
no callout: **Add to order** orders it with no override on the timeline.
A signed `refund.updated` (succeeded, 5000) shows "Partly refunded", "of
which $50.00 refunded" and "$50.00 refunded in Stripe". Test 2, "an admin
orders before the deposit is paid, with a reason": the sheet's callout
says "The customer hasn't paid the deposit for 1 of these parts.", **Order
without deposit** with no reason asks for one, and with "Customer is
paying at the counter" it orders ("…without the deposit"); the timeline
shows "Parts ordered on PO-…" with "Ordered before the deposit was paid:
Customer is paying at the counter", and the deposit is still due; the
customer's page then reads "The shop has ordered your parts. Ask the shop
if you still need to pay the deposit." (not "…once the deposit is
paid"), the Deposit card warns "If you paid the deposit another way, ask
the shop before paying here." and still offers Pay. Test 3,
"a cancelled Checkout can be paid later with the same session":
`?deposit=cancelled` says "Payment not finished. Nothing was charged.";
Pay again returns to the same URL and SQL still has the one pending
payment with the same session; the job shows "Checkout open" and **Check
with Stripe** toasts "Nothing new from Stripe."; a signed completion for
11999 cents then shows "Stripe received $119.99, not the $120.00 asked."
as the card's problem, a "Paid $119.99" link under the Lines
total, and on Exceptions one row for the job whose sentence appears once,
in full (not clipped by an ellipsis; on the phone it wraps to more than
one line), with "Open the job's Customer payments" under it. Test 4, "a
deposit for parts not fitted" (R-082, D149, D149b): the deposit paid
through the fake and a signed completion; the Lines memo reads "Approved,
not on the bill yet: 2 items, $275.00. Fit them to bill them." beside
"Paid $120.00" and "Paid ahead $120.00"; **Start work**, then
**Complete…** opens "Before completing J-…" listing "2 × <part> ·
$240.00" with **Deposit paid** and Wheel True, **Complete job** disabled;
**Back** leaves the job in progress. The job is then completed and
collected before the guard, as production's J-000002 was
(`closeBeforeTheGuard` in `tests/e2e/db.ts`: `set_work_order_status` as
the admin with 20261014000900's two triggers off for that one
transaction; no screen can do it now): "· $120.00 more than the bill"
under the total, "Approved but never fitted: $275.00 (not billed).", the
collected problem "…that never went on this job…", the card's "$120.00 was
paid online above this job's bill of $0.00…", the row's "Not fitted",
"Deposit paid", "it can no longer be fitted" and no Fit; the customer's
page says "Ask the shop about your deposit." (not "the shop will order
your parts"); mechanic1, in their own context, sees "Not fitted" and no
**Cancel**; the admin's **Cancel** sheet says to refund any deposit in
Stripe, the reason cancels it (the row goes, the job stays Collected, the
problem becomes "…every part it was for is cancelled…"), and a signed full
refund clears the problem and the "Paid …" line under the Lines total, so later specs see
no new exception. Test 5, "a quote left unanswered on a job closed before
the guard" (D149): the job completed and collected the same way with
both triggers off, so its quote stays open: "…so the customer can't
answer it.", the part "Not answered" (never "Waiting for the customer");
the quote line says "An admin or manager can cancel its items, which
withdraws it.", the admin's **Cancel** sheet says cancelling it withdraws
that quote, the toast reads "<part> cancelled. The quote was withdrawn.",
the quote line "The last quote was withdrawn.", Wheel True is back to
"Proposed", the job stays Collected, and the customer's link says "The
shop replaced or withdrew this quote." Test 6 (Phase 14 step 3, D156),
"a payment link: sent on a completed job, the bill without serials, paid
through Stripe (fake) and a signed webhook, and Collected takes nothing":
a unique frame with a serial ($100.00, New product → Unique) is added to
a job with Wheel True; the staff row shows the serial; **Start work**,
**Complete**; **Send payment link** shows "Still to pay $135.00" and
**Copy link** chosen (the intake customer has no mobile number: "No
WhatsApp: …"); **Create link** gives a `/pay/<43 characters>` link and
"It asks $135.00 now and works until …"; the card's link line and the
timeline "Payment link for $135.00 sent". The customer, signed out: the
document answers with no-referrer, noindex and `private, no-store`, the
title "Your bill · BICII", "Job J-…", "Hi Intake, here is your bill", two
lines, Job total, Paid so far $0.00 and Balance due $135.00, never the
serial, the unit's U- number or "S/N", and the privacy line; **Pay
$135.00** returns at once to `?balance=returned` with the same headers
and "Thanks. We're confirming your payment with Stripe…"; SQL shows one
pending `balance` payment of 13500 cents with no quote; a signed
`checkout.session.completed` (`kind: "balance"`, no quote) answers
`duplicate: false`; the page's own refreshes then read "Nothing is left
to pay. Thank you.", Paid so far $135.00, Balance due $0.00, no Pay, and
the address drops the marker. The job: "Balance Paid", Paid online
$135.00, Still to pay $0.00, no **Send payment link**, the Lines link
"Paid $135.00", the timeline "Balance of $135.00 paid online"; **Ready
for collection**, **Collected…** says "$135.00 was paid online. Nothing
is left to pay; take nothing." and never "Take only"; Mark collected; the timeline "Payment link stopped (collected)"
and the customer's page "This payment link was replaced or stopped. Ask
the shop for a new one." without the bill. Test 7 (D161), "an admin
records a deposit taken at the counter, the part can be ordered, and the
money is recorded as given back": on a 50% quote answered by the customer
(Deposit due), **Record counter payment** first warns, towards the bill,
"The customer's quote page still asks the full $120.00 deposit online.
…"; choosing "Record the $120.00 deposit for the quote answered …" fixes
the amount and clears the warning; PayNow and a reference; **Record
$120.00 by PayNow…**, then the group "Record $120.00 by PayNow?" (focus
on Back, "as the deposit on J-…?") and **Record $120.00**; the toast;
Deposit paid, the "At the counter" row "Deposit $120.00, PayNow" with
"Ref …" and "recorded by", Paid at the counter $120.00, the timeline
"Deposit of $120.00 taken at the counter (PayNow)"; the part no longer
"Deposit due" and the order sheet lists it ticked with **Add to order**
enabled and no callout (cancelled without ordering); the customer's page
"Deposit of $120.00 paid. Thank you." with no Pay. **Given back…** hides
the other void, says "BICII moves no money: give it back first.", and
with a reason and **Record as given back** toasts "$120.00 recorded as
given back"; the row reads "Given back: …" with no buttons, the timeline
"Counter payment of $120.00 voided (given back)", the deposit and the
part are Deposit due again and the customer's page offers **Pay $120.00
deposit** again. `E2E_REUSE_SERVER=1`
reuses a server started elsewhere, so `playwright.config.mts`'s Stripe
variables do not apply to it: start that server with the same
`STRIPE_ADAPTER`, `STRIPE_WEBHOOK_SECRET` and `ADMIN_ORIGIN`, or
`payments.spec.ts` fails.

Critical journeys, added with the phases that build them, against the seeded
database, signed in as the seeded admin and mechanic:

1. Walk-in: new customer + bike → intake photo (fixture image upload) → job →
   add service + part → stock badge decrements → complete → ready → collected;
   timeline shows every step; Today shows the job and its money (complete
   with M1.5: `workshop.spec.ts` for the timeline, `today.spec.ts` for the
   milestone run ending on Today).
2. Appointment: book (as seeded customer via RPC) → appears on Today → arrive →
   check in → work order linked (`appointments.spec.ts`: Today's arrivals
   list and counts, the appointments list, check-in, the job's link back).
3. Bulk product: create → receive PO (partial) → print 10 labels (PDF adapter
   produces 10 identical QR payloads) → consume one on a job → stock −1
   (`inventory.spec.ts`: the label step since Phase 8 step 4, after an
   opening stock count; the receiving step waits for Phase 7, on the
   parallel track).
4. Consignment: create consignor + unique bike → label → public page (hitting
   `public_items` through the app's preview route) → record sale → yield and
   CC shown to admin, hidden from mechanic → consignor outstanding → partial
   settlement → full settlement → outstanding 0 (`consignment-journey.spec.ts`
   since Phase 6 step 4, with the label step since Phase 8 step 4; the public
   page is the staff "What the public sees" panel over `public_items`, and
   anon's identical read is the database test, until Phase 11 serves
   `/q/[shortId]` on the public site).
5. Shopify (`shopify.spec.ts` since Phase 10 step 4, below): publish
   online → signed `orders/paid` POSTs (twice under one webhook id, once
   under another) → stock −1 once → the events show one recorded sale and
   one duplicate → a refund moves no stock.
6. (Later, in the public-site repo) customer sign-in sees only own data.
7. Indent part (`indent.spec.ts` since Phase 13 step 2): propose a part and
   its fitting → send the quote → the customer approves on the quote page,
   signed out (step 3) → order onto the supplier's draft (job Waiting on
   parts) → receive → fit → both are job lines; Complete… settles a part
   bought outside BICII first (D149a, D149b: recorded at the cost entered,
   the stock count unchanged); Cancel job cancels the approved items first
   and withdraws the open quote (D149c); voiding a fitted part's line puts
   it back to approved with Fit and Cancel, and it is fitted again from
   stock (D160).
8. Stripe deposit (`payments.spec.ts` since Phase 14 step 2): the deposit
   set to 50% → quote → the customer answers and pays through Stripe
   Checkout (the fake) → a signed webhook marks it paid (a replay changes
   nothing; a forged signature is refused) → the job shows it paid and
   paid ahead → the part orders without a reason → a partial refund shows;
   an admin orders an unpaid part with a reason, on the timeline; Complete…
   lists a paid part not fitted with its deposit (D149b); on a job
   collected with it before the guard (built in SQL) it is shown as not
   billed, an admin cancels it and the refund clears its problem (R-082,
   D149); a quote left unanswered on such a job is withdrawn by the
   admin's cancel of its item (D149). Phase 14 step 3 adds: on a completed
   job staff send a payment link (Copy link) → the customer's page shows
   the bill without the unit's serial or number, under no-referrer,
   noindex and no-store (and its return URL) → Pay through the fake and a
   signed webhook → the card shows the balance paid, Collected says take
   nothing, Collected stops the link (D156); an admin records a counter
   deposit on a due quote → the order sheet no longer holds the part back
   → the admin records it as given back and the deposit is due again
   (D161); Reports shows the Customer payments figures and the money held
   on jobs now, each payment and both CSVs (`reports.spec.ts`, D154).

## Seed data

`supabase/seed.sql` is both the demo dataset and the test fixture. Fixed
UUIDs are exported from `tests/fixtures/ids.ts` so tests never query by name.
Four staff logins (D90): `admin` (role admin), `manager` (Kavya Menon, role
manager, no exceptions), `mechanic1` (role mechanic, `view_costs` as an
exception) and `mechanic2` (role mechanic, none); tests that list or count
staff expect all four.
What each seeded record demonstrates is in DATA-MODEL.md §18. Tests that
create their own workshop rows pick service and category names the seed
does not use (active names are unique) and scope counts to their own job or
customer; the seed's own shape and timelines are pinned by
`workshop-seed.test.ts`.

Since Phase 5 the seed is a week of shop history **relative to the shop day
`db:reset` ran** (the anchor): every Phase 3, 4 and 5 timestamp goes through
the session-temporary `pg_temp.seed_at(days_ago, local_time)`. The figures
it must produce are written by hand in `tests/fixtures/reporting.ts`
(`SEED_DAYS` for days 0–6, `SPEC_EXAMPLE_JOBS`, `SEED_SNAPSHOT`,
`SEED_EXCEPTIONS`, `SEED_ADJUSTMENTS`) and the Phase 5 rows' ids in
`tests/fixtures/ids.ts` (`REPORT_JOB`, `REPORT_JOB_NUMBER`, `REPORT_LINE`,
`REPORT_PRODUCT`, `REPORT_PRODUCT_SHORT_ID`). The anchor rule: the anchor
need not be today (the DB test template is built once per run,
existing-database mode keeps an old seed, a run can cross Singapore
midnight), so seed assertions read it with `seedToday()`
(`tests/db/reporting-fixtures.ts`, from T3's check-in, not through the
functions under test) and use explicit days `anchor − n`, never
`shop_today()` or null bounds; assertions that need anchor = today
(`today_dashboard(null)`, `is_today`, the `*_now` snapshot, the exceptions)
compare the two first and skip with a message when they differ; tests that
take a short ID or sequence value skip when `isolatedDatabase()` is false.
E2E reads the same anchor in global setup (`E2E_SEED_ANCHOR`). Tests that
list a seeded customer's jobs list the Phase 5 jobs too
(`workshop-customer-access.test.ts`). Seed realism, which the schema does
not enforce, is pinned in `reporting-seed.test.ts`: no bike has two seeded
jobs open at once (check-in to completion or cancellation) and none is
collected while another job on it is open; the bikes that carry more than
one job are listed (a bike awaiting collection may take a newer job).

Since Phase 2 the seed also holds the shop's schedule (settings, weekly
hours with an inactive Monday and a split Saturday, four appointment types
with one staff-only, two closures within 14 days), **one customer login**
(Chloe Lim, `CUSTOMER_LOGIN.chloe`: chloe.lim@example.com, no usable
password like every seeded login, `seed-logins.test.ts`; linked to `CUSTOMER.chloe`, for E2E journey 2 and read-only
customer checks) and nine appointments from three days back to at most 14
days ahead (`APPOINTMENT`; Tan's linked to J-000014 and completed with it).
`SEED_DAYS` carries their D41 counts. Guarantees other tests rely on,
pinned in `appointment-seed.test.ts`: nothing seeded beyond 14 days (tests
book on clear Tuesday–Fridays ≥ 21 days ahead), no seeded closure covers
the anchor day, Daniel has no upcoming booked/confirmed appointment, Chloe
at most two upcoming online bookings (under the limit of 3), today at most
three expected arrivals.

Since Phase 6 step 2 the seed ends with **consignment and sales** written
through the RPCs: three consignors (`CONSIGNOR`), four items C-000001…
C-000004 (`CONSIGNMENT_ITEM`, `CONSIGNMENT_ITEM_SHORT_ID`), their products
and units, two charges, four sales S-000001…S-000004 on days 5, 4, 3 and 0
(`SALE`, `SALE_NUMBER`), a return, a reversed settlement and its
replacement and a refund. The figures are written by hand in
`tests/fixtures/ids.ts` (`EXPECTED_CONSIGNOR_LEDGER`, `EXPECTED_SALE`,
`EXPECTED_JERSEYS_POSITION`) and in `SEED_DAYS` (sales in the money
columns; real consignment columns, 0 on days without). Two Phase 4
assertions that read shared seed rows were made robust rather than the seed
changed: the Brompton tube's on-hand counts S-000002 (`inventory-ledger`),
and the "colnago" product search picks the shop's Colnago by id because the
consigned Colnago now matches too (`staff-search`). Phase 6 helpers live in
`tests/db/consignment-fixtures.ts` (`recordSale`, `saleLines`, `restock`,
`refund`, `settle`, `reverseSettlement`, `itemLedger`, `consignorLedger`,
plus step 1's intake, charge, return and position helpers); `saleLines`,
`itemLedger` and `consignorLedger` read as the owner because costs, payouts
and the ledger views have no API grant.

Since Phase 8 step 1 the seed ends with **five print jobs** (`PRINT_JOB`:
printed, failed, its printed reprint, a rendered bike tag not yet
confirmed, and a queued job E2E renders read-only) on the built-in
templates and printers, which the labels migration inserts
(`LABEL_TEMPLATE`, `PRINTER_PROFILE`). Their payloads use the seeded
`shop_settings.public_site_url`, exported as `SHOP.publicSiteUrl`
(`http://localhost:4000`), the database QR base payload assertions compare
against exactly; `E2E_PUBLIC_SITE_URL` (`tests/fixtures/public-site.ts`) is
the environment's scan-only base. No seeded product is published (other
specs rely on the seed's publication states); label tests publish their
own fixtures inside rolled-back transactions (`publishedFixtures` in
`tests/db/label-fixtures.ts`). None of the earlier seed tests enumerates
every table, so the new rows change none of their assertions.

Since Phase 10 step 1 the seed ends with **Shopify**: the settings (test
orders accepted, dev/E2E only), seven products P-000027… (`SHOPIFY_PRODUCT`)
with stock at the Shop floor, one of them (syncedTyre) PUBLIC, linked and
synced, and four webhooks sent through the real service-role RPCs
(`SHOPIFY_WEBHOOK_ID`): an order recorded as S-000005 eight shop days back,
its 5.00 refund, an order waiting on an unmapped variant and a rejected
delivery. The order sits outside `SEED_DAYS` (days 0–6), so the daily
fixtures are unchanged; an admin's `SEED_SNAPSHOT.exceptions_now` is 4
(the waiting order is an admin-only `integration_failed` row; mechanics
still see `SEED_EXCEPTIONS`). Two Phase 4 publication tests now expect the
seed's published product (`SEEDED_PUBLIC_PRODUCT_SHORT_IDS`) besides their
own rows, exactly. Shopify tests build their own fixtures with
`tests/fixtures/shopify.ts` and fresh Shopify ids. Since step 2 the enqueue
triggers are deferred to commit; the seed (one transaction) fires them
before it writes syncedTyre's sync row, so it leaves no product-sync job,
and DB tests that check the queue inside a rolled-back transaction fire
them with `set constraints all immediate`.

## CI

GitHub Actions, `.github/workflows/ci.yml` (setup shared through
`.github/actions/prepare`: Node from `.nvmrc` with the npm cache, `npm ci`,
and the devstack components restored from `actions/cache`, keyed on their
pinned versions, or built by `npm run devstack:setup`). Every job that needs
a database gets a `postgres:16` service container and reaches it through
`PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`; the scripts need only a superuser
login (no sudo, no `pg_ctlcluster`, no particular superuser name, SSL off is
fine).

- `check` (every PR and push to `main`): `npm run check` (typegen + `tsc`,
  `eslint`, `prettier --check`), `npm run tokens:contrast`, then
  `npm run check:types` (`db:types --fresh` from a throwaway database built
  from the migrations, and `git diff --exit-code -- src/lib/database.types.ts`).
- `test` (every PR and push): `npm run db:reset` and `npm run
  devstack:start`, then `npm test` (unit + db; the db project builds its own
  template: roles → Auth → Storage → migrations → seed). With
  `BICII_REQUIRE_STACK=1` the live-stack tests fail instead of skipping if
  the gateway is down.
- `build` (every PR and push): `next build` with placeholder public env.
- `e2e` (its own workflow, `e2e.yml`: manual dispatch, nightly at 02:23
  Singapore time, and PRs labelled `e2e`; `ci.yml` never runs on `labeled`,
  so a label can never post skipped required checks): `npx playwright install --with-deps chromium`, the devstack on the
  service database, then `npm run test:e2e` (production build on :3100,
  phone + iPad projects, one retry in CI). On failure the HTML report,
  traces, devstack logs and the mail catcher's messages (`.devstack/mail/`,
  local codes only) are uploaded as an artifact. `devstack:start` brings the
  mail catcher up in both workflows; `ci.yml`'s "Devstack logs" step prints
  `mail.log` with the others.

Secrets in CI: none. E2E runs against the devstack (real Supabase Auth,
PostgREST and Storage with the local demo keys), not staging, so it works
on forks and needs no staging credentials. Stripe likewise never gets a
key: CI's unit and database jobs set no Stripe variable (the unit tests
inject the fake and the fixtures' signing secret directly), and
`playwright.config.mts` gives the E2E server `STRIPE_ADAPTER=fake`, the
fixtures' signing secret (`whsec_biciiE2eNotARealSecret`, never a real
value), `ADMIN_ORIGIN` = the E2E base URL and a blank `STRIPE_SECRET_KEY`
(so a key in `.env.local` never meets the fake: env.ts refuses the fake
together with a key). Stripe is therefore on, as the fake, in every E2E
spec; the deposit still ships at 0 in every database the tests build (the
owner's 100% is production's setting only), so only `payments.spec.ts`
sees one.
