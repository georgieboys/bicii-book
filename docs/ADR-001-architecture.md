# ADR-001 — BICII Admin architecture

Status: proposed in PR #1 (open draft); implemented on the stacked branches through Phase 2; becomes accepted when PR #1 merges. Later decisions: [decisions/README.md](decisions/README.md).
Current observed design: [ARCHITECTURE.md](ARCHITECTURE.md).
Date: 2026-10-04

## Context

The build brief ([SPEC.md](./SPEC.md) §3.2) asks for a short architecture
decision record covering validation, data access, migrations, testing and the
Supabase client/server boundary before code is written. The existing public
site (`abhishekcheriangeorge-ops/bicii`) is Next.js 16.2 / React 19.2 /
Tailwind 4 / TypeScript, deployed on Vercel, static, with no backend. This repo
(`bicii-book`) becomes the staff-facing Admin PWA. Both become clients of one
Supabase project.

Facts that shaped the decisions below, taken from the Next.js 16 docs bundled
in the public site's `node_modules/next/dist/docs/` (this version differs from
older Next.js; the implementing agent must read those docs, not rely on
memory):

- `middleware.ts` is deprecated; the file is `proxy.ts` exporting `proxy()`,
  Node runtime only, and the docs say it is for optimistic checks, not
  authorization.
- `cookies()`, `headers()`, `params` and `searchParams` are all async.
- Turbopack is the default for dev and build; a webpack config fails the build.
- `next build` no longer lints; ESLint runs from its own CLI.
- Without `cacheComponents`, fetches and DB reads are uncached and any route
  that reads cookies is dynamic. That is the right default for an authenticated
  operations app.
- Server Actions are public POST endpoints; every action must authenticate and
  authorize itself. `revalidateTag` now takes a second argument; `updateTag`
  and `refresh` exist for read-your-writes in actions.
- Async Server Components cannot be unit-tested with Vitest; cover them with
  Playwright.

## Decisions

### A1. Stack

- Next.js 16.2 (App Router, Turbopack, `src/` directory, `@/*` alias),
  React 19.2, TypeScript 5 strict, Tailwind 4 CSS-first config. Same versions
  as the public site so the two repos can share conventions and, later, a
  package.
- Supabase: Postgres, Auth (email one-time codes for staff, D10; customer
  sign-in is decided in Phase 11), Storage, RLS. Migrations via the
  Supabase CLI (`supabase/migrations/*.sql`), typed client via
  `supabase gen types typescript` committed to `src/lib/database.types.ts`.
- `@supabase/ssr` for cookie-based sessions in Server Components, Server
  Actions, Route Handlers and `proxy.ts`. `@supabase/supabase-js` with the
  service-role key only inside `src/lib/admin/` (Supabase Auth admin API, e.g.
  creating a staff login) and `src/lib/integrations/`, and never in anything a
  browser can import.
- Validation: `zod` at every trust boundary (Server Action inputs, webhook
  payloads, env vars via a `src/lib/env.ts` parsed once at startup).
- Money in TypeScript: `decimal.js` (or `big.js`) for display math only.
  Authoritative totals are computed in Postgres generated columns and views.
- QR: `qrcode` for rendering; `@zxing/browser` (or the BarcodeDetector API
  where available, with that fallback) for camera scanning.
- Testing: Vitest for pure TypeScript and for database tests over `pg`;
  Playwright for end-to-end; `eslint` + `prettier` from the CLI.
- Hosting: Vercel for the Next app. No Vercel-specific APIs in application
  code; the only Vercel coupling is the deploy config.

### A2. Three layers, one direction

```
UI (Server Components, Client Components)
  │  calls
  ▼
Server Actions (src/app/**/actions.ts) and Route Handlers (src/app/api/**)
  │  authenticate + validate, then call
  ▼
Domain services (src/lib/domain/**), server-only
  │  use
  ▼
Supabase client (RLS) and Postgres RPCs (security definer, transactional)
```

- Components never import `@supabase/supabase-js` directly and never contain
  business rules. They render DTOs and call actions.
- Every Server Action is built with `staffAction()` (`src/lib/actions.ts`):
  it authorizes on one Supabase client (`authorizeStaff(client, …)`, the
  action-side twin of `requireStaff()`), parses input with zod, and the
  handler delegates to one domain function with that same client. Actions
  are thin: workflows (e.g. inviting staff: Auth login, `create_staff`,
  compensation) live in the domain module, which throws `DomainError` for a
  refused business rule; the action maps it to a safe message.
- Domain services are `import 'server-only'` modules. They compose reads
  (through the RLS-scoped client) and writes (through RPCs). They return plain
  DTOs with only the fields the caller needs; cost and yield fields are only
  included when the caller has `view_costs`.
- Route Handlers are public endpoints to Next, and the `(staff)` layout
  does not run for them. The first one is the period-report CSV export
  (Phase 9, `src/app/(staff)/reports/export/route.ts`): it lives beside the
  screen it exports, not under `src/app/api/**`, relies on `proxy.ts` only
  for the signed-out browser redirect, and authorizes itself with
  `getSession()`, `getStaff()` and `hasPermission()`, answering its own
  401, 403, 400, 409 and 413 as `text/plain` (never `requireStaff`,
  `forbidden()` or `redirect()`). It reads through the domain module like
  any page and pages around PostgREST's max-rows (1,000) with keyset
  cursors, a 50,000-row cap and an integer line-count check against
  `report_period_summary` (one retry, then 409).
- Anything that mutates stock, money, settlements, unit status, publication
  state, appointments or Shopify state goes through a Postgres RPC listed in
  DATA-MODEL.md §16. Those RPCs are the invariant enforcers. Direct inserts to
  ledger tables are not granted to `authenticated`.

### A3. Authentication and authorization

- `proxy.ts` refreshes the Supabase session cookie and redirects anonymous
  requests under `/(staff)` to `/login`. That is all it does. It is an
  optimisation, not a guard.
- The guard is the data access layer: `src/lib/auth/session.ts` exports
  `getSession()` (React `cache`d per render; `cache()` does not memoise
  inside a Server Action, hence `authorizeStaff` there), `requireStaff(permission?)`,
  `requireCustomer()`. They read the session from cookies and the `staff` row
  through RLS, and throw `redirect('/login')` or `forbidden()` as appropriate.
  `experimental.authInterrupts` is on so `forbidden.tsx` / `unauthorized.tsx`
  render 403/401.
- `/login` (PLAN D10, D70, D72) calls Supabase Auth from Server Actions, so
  Auth sees the Admin's server as the caller and its per-IP limits are one
  bucket for everyone. The login actions therefore count each code request
  and verification per client address and per email before asking Auth
  (`src/lib/admin/sign-in-throttle.ts`, counters in Postgres through the
  service-role-only `note_sign_in_attempt`), and show Auth's per-address
  refusals exactly like an unknown address.
- Authorization is enforced three times and must agree: RLS policies on
  tables, `private.require_permission()` at the top of each RPC, and
  `requireStaff(permission)` in the action. The first two are what matter;
  the third gives a clean error before the round trip.
- Customers and anonymous users use the same backend through the public site
  later. Nothing in this repo's policies assumes "all authenticated users are
  staff".

### A4. Migrations

- `supabase/migrations/` is the only way schema changes happen. Numbered by
  timestamp, one concern per file, forward-only. No `supabase db reset` in
  shared environments.
- Each migration that touches a table also carries its RLS policies and
  grants, so a table never exists without its policies in the same commit.
- `supabase/seed.sql` seeds local and preview databases. It is deterministic
  (fixed UUIDs) so tests reference seeded rows by ID.
- Migration files use Supabase CLI timestamp names
  (`20261004000100_foundation.sql`) and are applied in filename order, each
  in one transaction, and recorded in
  `supabase_migrations.schema_migrations` exactly as the CLI records them, so
  the CLI and our devstack scripts agree on what has run.
- Migrations never rely on Supabase's default privileges (hosted Supabase
  grants new `public` objects to `anon`/`authenticated`; plain Postgres
  grants EXECUTE on functions to PUBLIC). Every object is revoked from
  `public, anon, authenticated, service_role` and granted exactly what it
  needs, so behaviour is identical on hosted Supabase and locally. Meta tests
  enforce it (RLS on every `public` table; no function executable by PUBLIC).
- After every migration: `npm run db:types` regenerates
  `src/lib/database.types.ts` with the Supabase CLI's own generator
  (`supabase gen types typescript --db-url`, which needs no Docker) and the
  file is committed. `npm run db:types -- --fresh` generates from a
  throwaway database built from the migrations; CI regenerates and diffs.
- Environments: local, a hosted `bicii-staging` Supabase project for
  previews, and `bicii-prod`. Branch previews on Vercel point at staging.
  Local is either `supabase start` (Docker) or the **devstack**
  (`scripts/devstack/`), which runs the real Supabase services without
  Docker: Supabase Auth v2.178.0 and PostgREST v12.2.3 as release binaries,
  Supabase Storage v1.79.31 built from source, against a plain Postgres 16,
  behind a small Node gateway on `http://127.0.0.1:54321` with Supabase's
  URL layout (`/auth/v1`, `/rest/v1`, `/storage/v1`). Auth and Storage run
  their own migrations, so the `auth` and `storage` schemas are the real
  ones, not a shim. The only devstack-specific SQL is
  `supabase/devstack/roles.sql`: the platform roles and schemas that hosted
  Supabase already has (`anon`, `authenticated`, `service_role`,
  `authenticator`, `supabase_auth_admin`, `supabase_storage_admin`, the
  `auth`/`storage`/`extensions` schemas). It is never a migration. The same
  scripts run in CI against a Postgres service container.

### A5. Client/server boundary with Supabase

| Context | Client | Key | Notes |
|---|---|---|---|
| Server Components, Actions, Route Handlers | `createServerClient` from `@supabase/ssr` with the `cookies()` store | anon key | RLS applies. The only way the UI reads data. |
| `proxy.ts` | `createServerClient` with request/response cookies | anon key | Refresh only. |
| Client Components | `createBrowserClient` | anon key | Only for realtime subscriptions (board updates) and Storage uploads from the camera. No business reads. |
| Auth admin, integration workers, webhook handlers | `createServiceClient()` (`src/lib/supabase/service.ts`) | service role | Imported only from `src/lib/admin/**` and `src/lib/integrations/**` (ESLint `no-restricted-imports`, plus `no-restricted-syntax` for a dynamic `import()` and for reading `SUPABASE_SERVICE_ROLE_KEY` elsewhere), `import 'server-only'`, never reachable from a component import graph. Staff rows are still created through `create_staff` as the inviting user, so the database checks authorization. |
| Tests | `pg` directly | DB superuser + `set local role` and `request.jwt.claims`, as PostgREST does | See TESTING.md. |
| Local development | Same clients against the devstack gateway `http://127.0.0.1:54321` (or `supabase start`) | local demo anon / service-role keys written to `.env.local` by `npm run devstack:env` | Keys are signed with the well-known local demo secret; never used outside local. |

Image delivery (revised in M1.2): Storage photos render with `next/image`
`unoptimized`, i.e. plain lazy `<img>` tags with width and height, and no
`images.remotePatterns`. Internal photos are signed URLs that live five
minutes and change on every render; passing them through the image
optimizer would cache private photos on the server under ever-new keys, and
the devstack's loopback Storage host would need
`images.dangerouslyAllowLocalIP`. See DESIGN.md "Photos and images". If
thumbnails become a bandwidth problem, Supabase Storage image
transformations (a paid hosted feature) are the place to add sizes.

Webhook and cron routes (revised in Phase 10 step 3): the two Route
Handlers that act without a session, `api/shopify/webhooks` (POST,
authenticated by the Shopify HMAC of the raw body) and
`api/cron/integrations` (GET, `Authorization: Bearer <CRON_SECRET>`), are
excluded from the `proxy.ts` matcher, run on the Node runtime with
`maxDuration = 60`, and stay thin: each calls one handler in
`src/lib/integrations/shopify/`, which is the only code that holds the
service-role client and the only code that calls Shopify (through the
`ShopifyAdmin` adapter). Work after the webhook response runs in
`after()`. See [ARCHITECTURE "Shopify inbound flow"](ARCHITECTURE.md#shopify-inbound-flow)
and [ADR-020](decisions/ADR-020-shopify.md).

### A6. Caching

`cacheComponents` stays off. The app is authenticated and operational; every
page is dynamic because the DAL reads cookies. Reads are per-request and
deduplicated with React `cache`. After a mutation, actions call `refresh()`
(or `updateTag` for the few tagged reads such as the services catalog and shop
hours) so the user sees their write. Public product pages live in the other
repo and may cache; this app does not.

### A7. Mobile-first PWA

- `src/app/manifest.ts` exports the web manifest (name "BICII Admin",
  standalone, theme `#fbfaf7`, icons from the brand mark).
- A hand-written `public/sw.js` registered from the root layout; MVP scope is
  install + app-shell caching of static assets only. No offline mutations:
  stock and money commits require a live connection by design.
- Downloads (the report CSV exports) open in a new window
  (`target="_blank" rel="noopener"`): in the iOS standalone PWA a download
  in the app's own window replaces the app with the file, while a new
  window opens Safari's viewer with Share and Save to Files.
- Camera capture via `<input type="file" accept="image/*" capture="environment">`
  uploading straight to Storage from the client with a signed upload URL
  minted by an action; the action then records the `attachments` row.
- Layout: the public site's tokens (`src/app/globals.css` in `bicii`) are
  copied into this repo's `globals.css` verbatim as the starting point, with an
  additional `@theme` block for operational UI (status colours mapped onto the
  five brand accents, 44px minimum tap targets, dense table typography).
  Shared primitives (`Button`, `Section`, `Reveal` motion) are re-implemented
  here with the same names and props so a future shared package is a move,
  not a rewrite.

### A8. Observability

- `instrumentation.ts` with `onRequestError` forwarding to the log sink.
- `proxy.ts` sets `x-request-id` on the upstream request; the server
  Supabase client sends it on every PostgREST call as `x-correlation-id`,
  and `private.current_correlation_id()` reads it from PostgREST's
  `request.headers` (or from `set_config('app.correlation_id', …, true)`
  when an RPC sets one), so event and integration rows store it.
- Structured JSON logs (`pino`) from actions and integration code, emitted in
  `after()` so they never delay the response. Critical mutations log
  `{correlationId, actor, rpc, entityId, outcome}`.

### A9. Repository layout

```
bicii-book/
  docs/                      this plan, ADRs, data model, testing
  supabase/
    config.toml
    migrations/
    seed.sql
    devstack/roles.sql       platform roles/schemas for plain Postgres (never a migration)
  src/
    app/
      (auth)/login
      (staff)/               everything behind requireStaff
        layout.tsx           app shell: bottom nav on phone, rail on iPad
        page.tsx             Today dashboard
        jobs/ , intake/ , customers/ , bikes/ , appointments/ ,
        products/ , units/ , inventory/ , consignment/ , purchasing/ ,
        labels/ , reports/ , settings/ , scan/
      api/
        shopify/webhooks/route.ts
        cron/integrations/route.ts   (Phase 10 step 3; vercel.json schedules it)
        labels/[jobId]/pdf/route.ts  (Phase 8)
        health/route.ts              (planned; not built)
      manifest.ts
      forbidden.tsx, unauthorized.tsx, not-found.tsx, error.tsx
    components/
      ui/                    button, input, picker, sheet, toast, qr, …
      shell/                 nav, header, scan button
      domain/                job card, line table, stock badge, …
    lib/
      auth/                  session.ts, permissions.ts
      supabase/              server.ts, browser.ts, service.ts
      domain/                customers.ts, bikes.ts, workshop.ts, lines.ts,
                             inventory.ts, consignment.ts, purchasing.ts,
                             appointments.ts, reports.ts
      integrations/shopify/  client.ts, webhooks.ts, sync.ts, plus (Phase 10
                             step 3) config, ids, hmac, admin, graphql-admin,
                             fake-admin, fake-ids, desired-state, deps,
                             queue, cron
      printing/              templates.ts, adapters/{browser,pdf}.ts
      money.ts, ids.ts, env.ts, logger.ts, database.types.ts
  tests/
    unit/                    vitest
    db/                      vitest over pg
    e2e/                     playwright
    proxy.ts                 in src/ (next to app/), as the Next 16 docs require with a src dir
    instrumentation.ts       likewise
```

## Consequences

- The database is the invariant layer; the TypeScript domain layer is a
  convenience over it. This makes the public site cheap to build later: it
  gets the same RPCs and RLS for free.
- Every ledger-affecting feature costs a migration, an RPC, a policy, a DB
  test and a UI. That is the spec's definition of done, so the cost is
  deliberate.
- Running the test suite needs a Postgres 16 and the devstack cache
  (`npm run devstack:setup`, once per machine or CI cache). The DB tests
  build their databases with the real Supabase Auth and Storage migrations,
  so the only place where "not real Supabase" leaks in is
  `supabase/devstack/roles.sql` (roles and grants hosted Supabase already
  has). The test helpers work unchanged against `supabase start` or a hosted
  database (`BICII_TEST_DATABASE_URL`).
- Shopify is behind an interface from the first commit, so the first eleven
  phases do not need Shopify credentials.
