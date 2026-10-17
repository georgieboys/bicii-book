# BICII Admin — Implementation plan

This is the working plan for building the BICII Admin PWA in this repository.
It is derived from the authoritative brief in [SPEC.md](./SPEC.md); the brief
wins on any conflict. The design it implements is in
[ADR-001](./ADR-001-architecture.md) and [DATA-MODEL.md](./DATA-MODEL.md);
tests per phase are in [TESTING.md](./TESTING.md).

Read order for an implementing agent: SPEC.md → this file → ADR-001 →
DATA-MODEL.md → TESTING.md → the Next.js 16 docs in
`node_modules/next/dist/docs/` for anything touching routing, actions,
caching or proxy.

## 0. Ground truth established before planning

- Public site repo `abhishekcheriangeorge-ops/bicii`: Next.js 16.2.12,
  React 19.2.4, Tailwind 4, TypeScript, Vercel, static, no backend. Design
  tokens live in `src/app/globals.css` (`@theme`: ink/paper, red/yellow/sky/
  indigo/green accents, dust neutral ramp with documented WCAG contrast,
  Archivo display + Inter body, spring easings). Primitives: `Button`
  (44px floor, press-compress), `Section`, `Reveal`, `PageShell`,
  `SiteHeader` (sticky, sheet nav with `inert`), `.gutter`, `.eyebrow`,
  `.measure`.
- Admin repo `abhishekcheriangeorge-ops/bicii-book`: empty, no commits.
- Toolchain available to the cloud agent: Node 22, npm 10, Supabase CLI via
  `npx supabase`, Postgres 16 locally (no Docker, so no `supabase start`
  there; the Docker-free devstack in `scripts/devstack/` runs the real
  Supabase Auth, PostgREST and Storage instead; see TESTING.md).
- Next.js 16 specifics that change how code is written are listed in
  ADR-001 "Context".

## 1. Working rules for the implementing agent

1. Every phase ends with the app runnable (`npm run dev` against the local DB
   with seed), `npm run check` and `npm test` green, and a PR. No giant
   branch.
2. Schema and RPC first, then domain service, then UI. A screen that renders
   without its invariant tests is not done (SPEC §32).
3. Do not change business semantics. The items in §6 "Open decisions" are
   the ones already identified; if a new one appears, stop and surface it in
   the PR rather than improvising (SPEC §33).
4. Never commit secrets. `.env.example` lists every variable; `.env.local`
   is git-ignored.
5. Follow the Next.js 16 docs in `node_modules/next/dist/docs/`, not
   training-data conventions: `proxy.ts` not `middleware.ts`; await
   `cookies()`, `params`, `searchParams`; `revalidateTag(tag, 'max')` or
   `updateTag`; ESLint from the CLI.
6. Money arithmetic that matters happens in Postgres. TypeScript formats and
   previews only.
7. Commit messages describe the business rule the change enforces, not the
   file touched.

## 2. Phases

Phase numbers match SPEC §29. Each phase lists its deliverables, the tests
that gate it, and its PR. Estimates are in agent working sessions, not days.

### Phase 0 — Foundation (this plan's PR + the scaffold PR)

Deliverables:

- Next.js 16 scaffold: `create-next-app@latest --ts --tailwind --eslint --app
  --src-dir --import-alias "@/*"`, then prettier, `vitest.config.mts`,
  `playwright.config.mts`, `.github/workflows/ci.yml`, `.env.example`,
  `.nvmrc` (22).
- `supabase init`; `supabase/config.toml`; migration `0001_extensions_and_
  helpers.sql` (pgcrypto, citext, `private` and `reporting` schemas,
  `money_amount` domain, `set_updated_at()` trigger function,
  `private.next_short_id()` and sequences, `private.current_staff_id()` and
  the other staff helpers, `private.require_permission()`;
  `private.current_customer_id()` moves to Phase 1, with the customers table
  it reads); migration `0002_staff.sql` (staff, staff_permissions,
  permission enum, RLS) — shipped as `20261004000100_foundation.sql` and
  `20261004000200_staff.sql` (CLI timestamp names), plus staff management
  (`…0300_staff_management.sql`), `NaN`-proof money and rate domains
  (`…0400_money_not_nan.sql`) and staff history with the delegation ceiling
  (`…0500_staff_history.sql`: `staff_events`, RPC-only staff writes,
  `update_staff`, `staff_history`, D11); the Docker-free devstack (`scripts/devstack/`,
  `supabase/devstack/roles.sql`) in place of the auth shim;
  `tests/db/harness.ts` (`asUser`, `asAnon`, `asServiceRole`, rollback per
  test).
- Design tokens: copy `globals.css` theme from the public site; add
  operational tokens (status → accent mapping, surface levels, tap target
  utilities). Primitives `Button`, `Input`, `Field`, `Sheet`, `Toast`,
  `EmptyState`, `Skeleton`, `IconButton`, `SearchPicker` shell.
- App shell under `src/app/(staff)/layout.tsx`: bottom tab bar on phones
  (Today, Jobs, Scan, Inventory, More), side rail on ≥ md, persistent Scan
  button, header with global search field. `manifest.ts`, icons from the
  public site's `brand/logo-source.png`, `public/sw.js` (app-shell cache).
- Auth: `/login` (Phase 0: email + password via Supabase Auth; replaced
  by emailed one-time codes on 2026-10-05, D10, D70–D72), `proxy.ts` session
  refresh + redirect, `src/lib/auth/session.ts` with `requireStaff()`,
  `forbidden.tsx`, `unauthorized.tsx`. `experimental.authInterrupts: true`.
  Staff roles (Phase 0: admin and staff; since 2026-10-06 admin, manager
  and mechanic with per-person extra access on top, D90–D94, ADR-021):
  `src/lib/auth/permissions.ts` mirrors `private.role_implies`.
- `instrumentation.ts`, `src/lib/logger.ts`, `src/lib/env.ts`.
- `docs/RUNBOOK.md`: how to run locally with and without Docker, how to
  create the staging project, how to rotate keys.

Tests: harness runs; `staff` RLS (inactive staff sees nothing; admin has all
permissions; `require_permission` raises); staff history (one event per
change, with actor and reason) and the D11 ceiling; the API-surface meta
tests with their allow-list fixture; env schema; login E2E smoke.

### Phase 1 — Customers, bicycles, attachments

- Migrations: customers, bikes, bike_ownership_events, attachments, enums,
  RLS, storage buckets + policies (via migration on `storage.objects`);
  `private.current_customer_id()` (security definer, stable,
  `search_path = ''`; the active customers row for `auth.uid()`) with
  EXECUTE granted to `authenticated` only; the new RPCs and tables added to
  `tests/fixtures/api-surface.ts`. Shipped as `20261004000600`–`001100`
  (customers, bikes, media storage, attachments, customer access, staff
  search). "C own" is implemented as staff-only base-table RLS plus
  customer `my_*` security-definer RPCs that project customer-safe columns
  (DATA-MODEL §15 "Customer access pattern"), because staff and customers
  share the `authenticated` role; every later phase follows it.
- Domain: `customers.ts` (search by name/phone/email, create, update,
  archive), `bikes.ts` (create, link to customer, transfer ownership with
  event, search by brand/model/serial/short ID), `attachments.ts` (signed
  upload URL action, record row, change visibility = move bucket).
- UI: Customers list + detail; Bike detail with photo grid and (empty)
  service history; new-customer and new-bike sheets reachable from intake;
  camera capture component (`CaptureButton`) used everywhere photos are taken.
  Shipped (M1.2): domain modules `customers.ts`, `bikes.ts`,
  `attachments.ts`, `search.ts`; Server Actions per section; `/customers`,
  `/customers/[id]`, `/bikes`, `/bikes/[id]`, `/search` and the header
  search; the sheets open from customer and bike pages (intake reuses them
  in Phase 3). DESIGN.md "Domain components" describes the screens.

Tests: RLS customer A/B; anon denied; attachment visibility move; serial
search; ownership change preserves history; `current_customer_id()` is null
for anonymous callers and for staff without a customers row. Database side
in `customers-bikes`, `customer-access`, `attachments`, `media-storage` and
`staff-search` `.test.ts`, plus a live signed-upload round trip in
`stack.smoke.test.ts`. App side: unit tests for the pure helpers
(downscale sizing, search params, naming, recent searches, photo rules),
`display-parity.test.ts`, and E2E `customers-bikes.spec.ts` (phone + iPad).

### Phase 2 — Appointments, shop hours, capacity, check-in

Phase 2 owns the whole appointment surface: the schedule configuration,
booking, capacity, status, check-in and the customer booking RPCs that the
public site (Phase 11) consumes. Phase 11 creates none of these objects; it
adds only the public-site screens and a thin `bookable_slots` range wrapper
over `private.available_slots_at`. Built after Phases 3–5 (it depends on
Phase 3's work orders), in four steps.

- Migrations: shop_settings (single row; the time zone is fixed at
  Asia/Singapore, D35, and `private.shop_timezone()` /
  `private.shop_currency()` now read it), shop_hours, closure_overrides,
  appointment_types, schedule_events, appointments, appointment_events;
  admin RPCs `update_shop_settings`, `set_shop_hours`,
  `save_closure_override`, `delete_closure_override`,
  `save_appointment_type`; public reads `public_appointment_types`,
  `public_shop_hours`, `available_slots(date, type_id)`; staff RPCs
  `book_appointment`, `mark_appointment_status`, `cancel_appointment`,
  `update_appointment`; customer RPCs `my_appointments`,
  `book_my_appointment`, `cancel_my_appointment` (D37, D42);
  `check_in_appointment` lands in Phase 2 (step 2), built on Phase 3's
  `private.create_work_order` for a new job or linking one open, unlinked
  job (D40), with the `work_orders.appointment_id` foreign key, the
  automatic completion (D36) and the appointment counts in
  `daily_summary` (D41).
- Domain: slot generation (`private.available_slots_at`, mirrored by a TS
  pure function for the UI, step 3, proven against
  `tests/fixtures/appointment-slot-cases.ts`), booking, cancellation,
  calendar queries.
- UI: Appointments list (day view, week strip), create for walk-in-ahead
  bookings by staff, shop-hours and closures settings, appointment types
  settings, Arrived / No-show / Cancel, Check in (steps 3–4).
- Decisions D36–D42 (§6). Reschedule is cancel + rebook (no reschedule RPC);
  no customer notifications in the MVP.

Tests: capacity under concurrency; hours/closures; statuses; customer sees
only own appointments; anon sees public appointment types only.

Shipped (database, step 1): migrations `…2700_appointment_enum_values`
(the `appointment_linked` job event), `…2800_schedule`,
`…2900_appointments`, `…3000_appointment_customer_access`; the error codes
in `src/lib/db-errors.ts`; the shared fixtures
`tests/fixtures/appointment-slot-cases.ts` and
`tests/fixtures/appointment-transitions.ts`; database tests
`appointments`, `appointment-slots`, `schedule-settings`,
`appointment-customer-access` and `appointment-concurrency` (helpers in
`tests/db/appointment-fixtures.ts`).

Shipped (database, step 2): `…3100_appointment_check_in` (the
`work_orders.appointment_id` foreign key and partial unique index; the
`work_orders_appointment_rules`, `work_orders_sync_appointment_link` and
`work_orders_sync_appointment_completion` triggers; `check_in_appointment`
returning `appointment_check_in`, D36, D40; P3's null -> value-once rule is
relied on, not replaced) and `…3200_appointment_reporting`
(`reporting.appointment_daily`, `public.appointment_daily`, and
`daily_summary`'s three appointment columns filled by D41 with no RPC
change); the Phase 2 seed (settings, hours, four types, two closures,
Chloe Lim's customer login, nine appointments, Tan's appointment linked to
J-000014); database tests `appointment-check-in`, `appointment-reporting`,
`appointment-seed` and the check-in race. So the Phase 2 database is
complete: migrations `…2700`–`…3200`, every RPC above, D36–D42. Steps 3–4
build the app.

Shipped (app core, step 3): the pure mirror `src/lib/appointments/`
(`slots.ts` = `private.available_slots_at` / `appointment_slot_problem`
exactly, proven on the shared fixtures; `status.ts` actions = the status
machine; `history.ts`, `time.ts`, `format.ts`), `src/lib/domain/appointments.ts`
(`listDay`, `listWeek`, `loadSchedule`, `getAppointment`, `bookAppointment`,
`markStatus`, `cancel`, `update`, `checkIn`, `openUnlinkedJobs`;
the bike pickers reuse P3's `listIntakeBikes`), the Server Actions, `/appointments` (day/week),
`BookAppointmentSheet`, `/appointments/[id]` and its check-in, the shared
`LeadPicker`, and `appointments.spec.ts` (journey 2 and the no-show
reinstatement).

Shipped (Phase 2 as a whole, step 4 completing the app): migrations
`20261004002700_appointment_enum_values`, `…2800_schedule`,
`…2900_appointments`, `…3000_appointment_customer_access`,
`…3100_appointment_check_in` and `…3200_appointment_reporting` (Phase 5's
SQL untouched except `private.shop_timezone()` / `shop_currency()`, same
signatures, now reading `shop_settings`, D35). Routes: `/appointments`
(day/week, with a link to the schedule), `/appointments/[id]`,
`/appointments/[id]/check-in`, `/settings/schedule` and
`/settings/appointment-types` (readable by every staff member, each with
its own `loading.tsx`; edit controls for admins), plus Today's appointment
tiles with "Still expected" and the arrivals list (D41 counts, D30: every
staff member), the customer page's Appointments card with Book (customer
locked, not for archived customers) and the job's "Booked appointment"
chip and "Opened from / Linked to the appointment on …" timeline line
linking back (D40). Domain modules: `src/lib/domain/appointments.ts`
(adds `todaySummary` over `public.appointment_daily` and
`customerAppointments`) and `src/lib/domain/schedule.ts`
(`getShopSettings`, `getWeeklyHours`, `listClosures` with the bookings
each affects, `getClosure`, `listAppointmentTypes`, `affectedBySchedule`,
and the admin writes `updateShopSettings`, `setShopHours`, `saveClosure`,
`deleteClosure`, `saveAppointmentType`); the pure `src/lib/schedule.ts`
(wording and the form schemas mirroring the database checks) and
`src/lib/appointments/`. Actions: `appointments/actions.ts`,
`settings/schedule/actions.ts` and `settings/appointment-types/actions.ts`
(admin). Components: `BookAppointmentSheet` / `BookAppointmentButton`, the
appointment list, actions, edit and check-in components, `LeadPicker`,
`TodayArrivals`, `CustomerAppointmentRows`, the schedule settings sheets
and `AppointmentTypeSheet`. Decisions D36–D42 (§6) with D2, D8, D9, D12,
D18, D30 and D35. Tests: the database files `appointments`,
`appointment-slots`, `schedule-settings`, `appointment-customer-access`,
`appointment-concurrency`, `appointment-check-in`, `appointment-reporting`
and `appointment-seed`; unit tests for the slot mirror, statuses, times,
the timeline text and link, Today's appointment components and the
schedule forms; E2E `appointments.spec.ts` (journey 2 through Today and the
job, the no-show reinstatement, capacity closing a slot) and
`appointment-settings.spec.ts`. Phase 11 consumes `available_slots`,
`public_appointment_types`, `public_shop_hours`,
`my_appointments(include_past)`, `book_my_appointment` and
`cancel_my_appointment`, and wraps `private.available_slots_at` (keep its
signature) in its `bookable_slots` range RPC; Phase 8 decides whether
`shop_settings.public_site_url` or `NEXT_PUBLIC_PUBLIC_SITE_URL` is the QR
base (D9); Phase 9's activity report uses the D41 basis
(`public.appointment_daily`).

### Phase 3 — Workshop

- Migrations: work_orders, work_order_assignments, work_order_events,
  categories, services, cult_commons_rates, work_order_line_items
  (generated columns), views `work_order_totals` / `_staff`;
  RPCs `create_work_order`, `assign_staff`, `unassign_staff`,
  `set_work_order_status`, `add_service_line`, `add_manual_line`,
  `void_line` (inventory branch stubbed until Phase 4),
  `check_in_appointment`, `add_work_order_note`, `flag_approval`.
- Domain: `workshop.ts`, `lines.ts`, timeline reader with human-readable
  rendering of each event type.
- UI: Intake flow (find/create customer → find/create bike → photos →
  condition + requested work → lead mechanic → optional services → create),
  Workshop board (columns or filtered list by status; filters mechanic,
  status, date, age, customer, bike, job number), My Jobs, Job detail
  (header, status actions, assignments, timeline, photos, line table with
  running totals; cost/yield only with `view_costs`), Services settings.

Tests: status machine; completed ≠ collected; snapshot immutability;
Cult Commons fixtures through generated columns; rate effective-dating;
assignment uniqueness; customer projection has no costs; E2E journey 1
without the part line.

Scope notes (no business change; decisions D14–D22 in §6):

- Built in four steps on `feat/m1.3-workshop`: (1) database core —
  migrations `20261004001200_workshop_catalog` (categories, services,
  `services_staff`, `cult_commons_rates` with the base 0.30 row,
  `private.cult_commons_rate_at`, service and rate RPCs),
  `…1300_work_orders` (status machine, work orders, assignments, timeline,
  job photos), `…1400_work_order_lines` (lines with generated economics,
  `work_order_totals`, `work_order_totals_staff`,
  `work_order_line_items_staff`) and `…1500_workshop_rpcs`, the pure
  mirrors `src/lib/workshop.ts` and `src/lib/cult-commons.ts`, error
  mapping and database tests; (2) the customer job projection (D17), job
  search and the seed; (3)–(4) the app (intake, board, My Jobs, job detail,
  Services settings; assignments, approval, notes and details editing in
  step 4).
- `check_in_appointment` moves to Phase 2, built on
  `private.create_work_order` (the single creation path) for a new job, or
  linking an existing open, unlinked job by setting
  `work_orders.appointment_id` once: the column may go from null to a value
  exactly once and never changes or clears afterwards
  (`work_order_immutable`, enforced in `private.work_orders_enforce_rules`;
  Phase 2 adds the foreign key).
- `add_inventory_line` and the `void_line` reversal branch land in Phase 4
  (`work_order_line_items.source_product_id` / `source_inventory_unit_id`
  have no foreign keys until then; `void_line` refuses inventory lines with
  `line_type_unsupported`). Both call `private.lock_work_order` (FOR
  UPDATE), then the replay lookup, then `private.require_open_work_order`,
  keeping the lock order: the `work_orders` row before any of its line rows.
- The anonymous/customer services listing lands with Phase 11 through a
  separate customer-safe projection; until then services are staff-only.
- `flag_approval` is built as `set_approval_flag`.
- The customer job projection is built now, in step 2, for Phase 11 to
  show: `my_work_orders`, `my_work_order_lines`, `my_work_order_timeline`,
  `my_work_order_attachments` with the `customer_job_status` enum (D8, D17;
  migration `20261004001600_workshop_customer_access`). Nothing in the
  staff app calls them. Step 2 also adds the `work_order` kind to
  `staff_search` (`…1700_workshop_search`; the app shows it from step 4)
  and the Phase 3 seed (DATA-MODEL §18 "Phase 3 part").
- Intake photos are taken right after the job is created, because
  `record_attachment` requires the job row to exist.
- Shipped (M1.3): migrations `20261004001200_workshop_catalog`,
  `…1300_work_orders`, `…1400_work_order_lines`, `…1500_workshop_rpcs`,
  `…1600_workshop_customer_access` and `…1700_workshop_search`; RPCs
  `create_service`, `update_service`, `set_service_archived`,
  `schedule_cult_commons_rate`, `cancel_cult_commons_rate`,
  `create_work_order`, `set_work_order_status`, `update_work_order`,
  `add_work_order_note`, `set_approval_flag`, `assign_staff`,
  `unassign_staff`, `add_service_line`, `add_manual_line`, `void_line`,
  `work_order_timeline`, the customer projection `my_work_orders`,
  `my_work_order_lines`, `my_work_order_timeline`,
  `my_work_order_attachments`, and the `work_order` kind of `staff_search`;
  views `work_order_totals`, `work_order_totals_staff`,
  `work_order_line_items_staff`, `services_staff`. Routes: `/jobs` (the
  board and My Jobs: All / My jobs / Unassigned, group chips with counts,
  status multi-select, mechanic, customer, bike, check-in date, age and job
  number in the URL; open jobs oldest first, the newest 300 with a
  partial-counts notice past that; Closed = the last 30 days, 50 at a time),
  `/jobs/new` (intake), `/jobs/[id]` (status actions, lines and totals,
  photos, assignments, approval, notes, details editing, timeline),
  `/settings/services` (services, categories, the Cult Commons rate card),
  plus service history on `/bikes/[id]` and `/customers/[id]` and Jobs in
  `/search`. Decisions D14–D22 (§6); D15's reopen deviation (clearing
  completion stamps) awaits owner confirmation before Phase 5. Tests: the
  database files listed in TESTING.md, unit tests for `workshop.ts` (incl.
  the board filters), `workshop-timeline.ts`, `cult-commons.ts` and the
  intake draft, and E2E `workshop.spec.ts` (journey 1 without the part
  line, the intake draft) and `workshop-board.spec.ts` (board filters,
  mechanic cost boundary, search and service history, reassignment and
  notes). `check_in_appointment` moves to Phase 2 (built on
  `private.create_work_order`, or linking an existing open job by setting
  `appointment_id` once); `add_inventory_line` and the `void_line`
  reversal branch land in Phase 4 (via `private.lock_work_order`, the replay
  lookup, then `private.require_open_work_order`), and Phase 4 returns sold
  units to held_for_customer on reopen and sells them again on
  re-completion (D6, D15). The board's group for `ready_to_start`
  is labelled "Ready", as SPEC §7.2 names it. Shared helpers for later
  phases to extend, not recreate: `tests/e2e/helpers.ts`
  (`createJobViaIntake`, `nextIntakeStep`, `section`, `tagFor`),
  `tests/db/workshop-fixtures.ts` (Phase 5's `reporting-fixtures.ts` builds
  on it), `src/lib/cult-commons.ts` with the fixture table
  `tests/fixtures/cult-commons.ts`, and `OVERDUE_AFTER_DAYS` / `isOverdue`
  in `src/lib/workshop.ts` (D20).

### Phase 4 — Inventory

- Migrations: locations, products, inventory_units, inventory_movements with
  partial unique indexes, `reporting.stock_levels`, `reporting.low_stock`,
  `supplier_products`; RPCs `add_inventory_line` (full), `void_line`
  inventory branch, `adjust_stock`, `transfer_stock`, `create_unique_unit`,
  `set_publication_status`; `reporting.public_items`.
- Domain: `inventory.ts` (products CRUD, unit lifecycle, stock queries,
  movement history), scanner URL parsing in `ids.ts`.
- UI: Products list with stock badges and search picker; Product detail
  (stock by location, movements, labels, publication); Unit detail; Stock
  adjustment sheet with mandatory reason; Movements list; Scan screen using
  the camera, deep-linking by short ID; adding a part to a job shows live
  stock.

Tests: consume once (idempotent + concurrent); reversal; unit cannot sell
twice; adjustments need reason; anon `public_items` only; publication state
machine; E2E journeys 1 (complete) and 3 (without labels).

Scope notes (decided while building; none changes business semantics):

- The database layer is built in two steps (ledger, jobs, stock RPCs and
  seed; then `set_publication_status`, `reporting.public_items`,
  `split_unit_from_stock` and product/unit search), so Phase 4 has four
  build steps.
- `supplier_products` moves to Phase 7: `suppliers` does not exist until
  then.
- `inventory_movements.request_id` replaces DATA-MODEL's
  `transfer_group_id`: it is each RPC call's idempotency key and a
  transfer's pairing key. No RPC reuses another entity's id or another
  call's key as its request_id; `create_unique_unit` and
  `split_unit_from_stock` use the client's new unit id, created for that
  one call.
- Phase 3's option "Phase 4 replaces `private.work_orders_enforce_rules`"
  is resolved with a separate AFTER trigger, `work_orders_sell_held_units`
  (`AFTER UPDATE … WHEN (old.completed_at is distinct from
  new.completed_at)`), so the Phase 3 function stays as it is.
- `reporting` is exposed to PostgREST (config.toml, devstack, type
  generation, RUNBOOK) because `reporting.public_items` is the anonymous
  surface DATA-MODEL §15 names; `private` stays unexposed.
- The inventory migration inserts the bootstrap location 'Shop floor'
  (SPEC §11: one shop), so a hosted database works without the seed.

Shipped (database, part 1): migrations `20261004001800_inventory.sql`
(enums, locations, products, inventory_units, the ledger with its
idempotency indexes and deferred unit-consistency check, product and unit
history, the cost views and `public.selling_prices`, the private helpers,
the stock-photo rule, the shop-bike guard and `adjust_stock`,
`transfer_stock`, `create_unique_unit`, `write_off_unit`),
`20261004001900_inventory_jobs.sql` (line FKs and
`work_order_line_items_unit_once`, `add_inventory_line`, the `void_line`
inventory branch, `work_orders_sell_held_units`) and
`20261004002000_inventory_reporting.sql` (`reporting.stock_levels`,
`product_stock`, `low_stock`); the Phase 4 seed; `src/lib/inventory.ts`
(state machines); tests `tests/db/inventory-ledger.test.ts` and
`tests/db/inventory-catalog.test.ts` on `tests/db/inventory-fixtures.ts`.
Decisions D23-D28.

Shipped (database, part 2): migrations
`20261004002100_inventory_publication.sql` (`set_publication_status`
returning `publication_result`, D26's manual rules on top of the products
trigger; `split_unit_from_stock` returning `split_unit_result`, D28;
`reporting.public_items`, the anonymous /q projection, with anon USAGE on
`reporting` and EXECUTE on `private.selling_price`, which the view calls as
the caller) and `20261004002200_inventory_search.sql`
(`private.search_products`, `private.search_units`, `staff_search` with the
`product` and `inventory_unit` kinds); error code `product_not_quantity`;
tests `tests/db/inventory-publication.test.ts`,
`tests/db/inventory-split.test.ts` and the Phase 4 cases of
`tests/db/staff-search.test.ts`. Until Step 3 adds product and unit pages,
the app's search asks `staff_search` for the kinds it can open
(`SEARCH_KINDS`). A public unique product whose units are all written off
stays `public` and shows `unavailable` on its page until staff unpublish it
(write-offs do not change publication; D26 has no automatic exit except
the sale).

Shipped (app core, Step 3): products and units in search
(`SEARCH_KINDS`, `/products/[id]`, `/units/[id]`); stock photos Internal or
Public only; `src/lib/domain/inventory.ts` (DTOs over RLS reads, the cost
views for view_costs only, `public.selling_prices` for every displayed
price) with the actions in `src/app/(staff)/inventory/actions.ts` and
`addPartToJob` in `jobs/actions.ts` (schemas in `src/lib/inventory-forms.ts`);
the screens `/inventory`, `/products/[id]`, `/units/[id]`,
`/inventory/movements`; the Adjust stock, Transfer, New product / Edit
details, Add unit / Edit unit and Write off sheets; Add part on the job
page with the D23 warning, part lines with their P-/U- number and stock
left, the void and D25 reopen wording, and the stock events in the
timeline; `tests/e2e/inventory.spec.ts` and journey 1's part line. Step 4
adds locations settings, the publication card, the split sheet, the
bike-page unit card, the scanner and /q, and the header short-ID jump.
Transfers and adjustments of unique products happen per unit (unit page);
the product page offers them for counted products only, as the RPCs do.

Shipped (app, Step 4): the publication card on `/products/[id]`
(`PublicationControls`: status, `publicationActions` over
`manualPublicationTargets`, the D26 checklist with Publish disabled and
naming what is missing, the QR URL with Copy, and `PublicPreviewPanel`,
the `reporting.public_items` row or "Not public. Anonymous scans show
nothing."; read-only preview and QR URL on `/units/[id]`); actions
`setPublication` and `splitToUnique` (manage_inventory, plus adjust_stock
in the handler); `SplitToUniqueSheet` (D28) on counted products for staff
with both permissions; `/settings/locations` (list for all staff with the
"Default" pill, `LocationSheet` and the `LocationActiveSwitch` for
manage_inventory; `location_has_stock` snaps the switch back) and the "No
active stock location" empty states linking to it; the bike page's
"In stock as U-… · Available" card (`getBikeStockUnit`); the scanner
(`src/components/domain/scanner.tsx`: BarcodeDetector or a lazily imported
`@zxing/browser`, `interpretScan` in `src/lib/scan.ts`, never following a
foreign code), `resolveShortId` (`src/lib/domain/scan.ts`) behind the only
Admin /q route `/q/[shortId]`, `hrefForRecord` in `src/lib/ids.ts`, and the
header short-ID jump (`shortIdJump`). The QR base comes from one server
helper, `src/lib/qr.ts` (`getQrBase`, `qrUrl`, `scanBases`), which Phase 8
points at the database QR base.

Shipped (M1.4, Phase 4 as a whole): migrations
`20261004001800_inventory`, `…1900_inventory_jobs`,
`…2000_inventory_reporting`, `…2100_inventory_publication` and
`…2200_inventory_search`; RPCs `adjust_stock`, `transfer_stock`,
`create_unique_unit`, `write_off_unit`, `add_inventory_line`, the
`void_line` stock reversal, `set_publication_status`,
`split_unit_from_stock` and the `product` and `inventory_unit` kinds of
`staff_search`; trigger `work_orders_sell_held_units` (D25); views
`public.selling_prices`, `product_costs`, `inventory_unit_costs`,
`inventory_movement_costs`, `reporting.stock_levels`, `product_stock`,
`low_stock` and the anonymous `reporting.public_items`. Routes:
`/inventory`, `/inventory/movements`, `/products/[id]`, `/units/[id]`,
`/settings/locations`, `/scan` and `/q/[shortId]`, plus Add part on
`/jobs/[id]`, the stock card on `/bikes/[id]` and Products and Units in
`/search`. Components: `StockBadge`, `AddPartSheet`, `AdjustStockSheet`,
`StockTransferSheet`, `ProductSheet`, `UnitSheet` / `WriteOffUnitControl`,
`MovementList` / `HistoryList`, `PublicationControls`,
`PublicPreviewPanel`, `CopyText`, `SplitToUniqueSheet`, the location
controls, `NoActiveLocation`, `CameraPermission` and `Scanner`. Decisions
D23-D28 (§6; D6 now ends "Refined by SOLD-AT-COMPLETION (D25)"). Tests:
the database files `inventory-ledger`, `inventory-catalog`,
`inventory-publication`, `inventory-split` and the Phase 4 cases of
`staff-search`, `work-order-lines`, `attachments` and `meta`; unit tests
for `inventory.ts`, `inventory-forms.ts`, `ids.ts` (`hrefForRecord`),
`scan.ts`, `search.ts` (`shortIdJump`) and the camera states; E2E
`inventory.spec.ts` (journey 3 without labels, one job per unit, the
permission boundary), `inventory-publish.spec.ts` (publication,
locations, split, bike link), `scan.spec.ts` (manual entry, /q, the camera
stub, foreign codes, the header jump) and journey 1 complete with its part
line. New dependency: `@zxing/browser` with its `@zxing/library` peer,
loaded only by the scanner's fallback.

### Phase 5 — Financial engine

Mostly landed inside Phases 3–4 by design (generated columns, rate table).
This phase adds `reporting.financial_lines`, `reporting.daily_summary`,
`reporting.work_order_activity`, the "Today" dashboard's financial tiles,
job-level yield panel, and the `view_financial_reports` gate. Tests: fixture
table reconciles end to end from seed; a staff user without the permission
gets no financial rows.

Shipped (M1.5, Phase 5 as a whole): migrations
`20261004002300_reporting_calendar`, `…2400_financial_lines`,
`…2500_daily_summary` and `…2600_dashboard_rpcs` (read-only: no table and
no change to a Phase 3 or 4 function); `private.shop_timezone`,
`shop_currency`, `shop_day`, `shop_today`, `shop_day_start` and
`is_significant_adjustment`; views `reporting.financial_lines`,
`work_order_activity`, `daily_summary` and `operational_exceptions`
(granted to no API role); security definer read RPCs `daily_summary`,
`today_dashboard`, `work_order_activity_on`, `stock_adjustments_on`,
`operational_exceptions`, `financial_lines` (view_financial_reports) and
`work_order_yield` (view_costs), and the error code
`report_range_invalid`. A seed spanning a week of shop days relative to
the reset day (the SPEC §10 examples, a loss line, rounding, overdue,
uncollected and cancelled jobs, stock adjustments;
`tests/fixtures/reporting.ts`). App: `src/lib/reports.ts` and
`src/lib/domain/reports.ts`; the Today dashboard at `/` (flows, the
current snapshot linked to the board, appointment and consignment
placeholders, Money, stock, low stock, what needs attention, activity and
the last 7 days; any earlier day by `?day=`); the job yield panel as an
extension of P3's `TotalsSummary` (snapshot rate range, loss note,
recognition day). Decisions D30-D35 (§6). Tests: the database files
`reporting`, `reporting-access`, `reporting-concurrency` and
`reporting-seed` plus `meta` checks; unit tests for `reports.ts`, the new
`dates.ts` helpers and `TotalsSummary`; E2E `today.spec.ts` (the
milestone journey on phone and iPad, the mechanics' boundaries, the
seeded history, low stock, adjustments and exceptions).

### Phase 6 — Consignment

- Migrations: consignors, consignment_items, consignment_item_charges,
  consignment_settlements, settlement_lines, sales, sale_lines, sale_refunds,
  `reporting.consignor_ledger`, `reporting.consignor_item_ledger`; RPCs
  `create_consignment_item`, `return_consignment_item`,
  `record_retail_sale`, `restock_unit`, `record_settlement`.
- UI: Consignors list/detail with ledger; Consignment intake (creates unit +
  label); Record sale sheet (in-store sale of a unit or quantity product);
  Settlement sheet with allocation across sold items; Sales list.

Tests: liability vs settlement; partial settlements; over-allocation;
consignment yield; unit sold once; E2E journey 4.

Shipped (Phase 6 as a whole, on `feat/p6-consignment`): migrations
`20261004003300_consignment`, `…3400_consignment_job_parts`,
`…3500_sales`, `…3600_consignment_settlements` and
`…3700_consignment_reporting`. Tables `consignors`, `consignment_items`,
`consignment_item_charges`, the append-only `consignment_item_events`,
`sales`, `sale_lines`, `sale_refunds`, `consignment_settlements`,
`settlement_lines` and `consignment_settlement_reversals`, each with its
RLS policies (D48). RPCs `create_consignment_item`,
`update_consignment_terms`, `add_consignment_charge`,
`void_consignment_charge`, `return_consignment_item(item_id, return_id,
reason, quantity, location_id)`, `record_retail_sale(sale_id, lines,
customer_id, recognized_at, notes)`, `restock_unit(unit_id, sale_line_id,
location_id, reason)`, `record_sale_refund`, `record_settlement`,
`reverse_settlement`, the read RPCs `list_consignors`,
`consignor_statement`, `consignor_payout_details`, `list_sales`,
`sale_lines_detail` and `saleable_stock`, and the `consignor`,
`consignment_item` and `sale` kinds of `staff_search`;
`add_inventory_line` keeps its signature and accepts consigned stock
(Phase 6 implemented the owner's D27 change through D44). Private
helpers: `private.sell_line`, the single sale-line writer Phase 10 calls
with `online_sale`; `private.record_linked_movement`, the twin of
`private.record_movement` that writes `sale_line_id` and
`consignment_item_id`; `private.can_view_sale_costs` and
`private.can_view_consignment_money`; a replaced `private.selling_price`
(D45). Views `reporting.consignment_item_position`,
`consignor_item_ledger` and `consignor_ledger`; `reporting.financial_lines`
gains a sale branch and `daily_summary` / `today_dashboard` fill
`consignment_sales`, `consignment_sales_total` and
`new_consignor_liability`. Scope notes: at most one live sale line per
unit is a partial unique index (`sale_lines_unit_sells_once`) that
replaces DATA-MODEL §8's plain `unique` (D46); `restock_unit` and
`return_consignment_item` deviate from DATA-MODEL §16's original
signatures (the sale line, and a return id, are the replay keys); no new
exception kind (D34). Seed: consignors, consigned items and S-000001 to
S-000004. Routes: `/consignment` (consignors and items),
`/consignment/consignors/[id]`, `/consignment/items/[id]`, `/sales` and
`/sales/[id]`; Sell on the consignment item, unit and product pages,
"Sold on S-…" with Restock on the unit page, consigned stock in Add part,
`C-` and `S-` in `/q` and `/search`, Sales in the More menu and the
Today consignment tiles linked to the sales and consignment pages.
Components: `ConsignorSheet`, `ConsignorPicker`,
`ConsignmentIntakeSheet`, `ChargeSheet`, `SettlementSheet`, the
consignment item controls, `ConsignmentItemRow`, `RecordSaleSheet`,
`SaleablePicker`, `RefundSheet` and `RestockControl`. Decisions D44-D55
(§6; D54 and D55 came from the Phase 6 review), with D4 implemented, D7
implemented for retail and D27 changed. The review also replaced
`transfer_stock` (same signature, D54), gave `create_consignment_item` a
`new_consignor` argument (a new consignor is created in the intake's own
transaction) and added `sold_items` to `list_consignors`.
Tests: the database files `consignment`, `consignment-access`,
`consignment-concurrency`, `consignment-job-parts`,
`consignment-locations` (the review, D54), `sales`,
`settlements` and `consignment-reporting`, plus the Phase 6 cases of
`inventory-ledger`, `reporting`, `staff-search`, `attachments` and
`work-orders`; unit tests for `consignment.ts`, `consignment-forms.ts`,
`sales.ts` and `sales-forms.ts`; E2E `consignment.spec.ts`,
`sales.spec.ts` and `consignment-journey.spec.ts` (journey 4 without the
label step, which is Phase 8).

### Phase 7 — Purchasing

- Migrations: suppliers, purchase_orders, lines, receipts, receipt lines,
  `reporting.purchase_order_progress`; RPC `receive_purchase`.
- UI: Suppliers; PO create/edit; Receive screen (per-line received qty,
  actual cost, location) with idempotency key per submission; PO progress.

Tests: partial receipt; duplicate receipt idempotent; over-receipt raises;
cost update per decision D5; E2E journey 3 receiving step.

Shipped (Phase 7 as a whole, built on `feat/p7-purchasing` from Phase 5's
head and integrated with the main line, Phases 2 and 6 included, by merging
`main` into that branch): migrations `20261005000100_suppliers`,
`…0200_purchase_orders`, `…0300_purchase_receiving`,
`…0400_purchasing_search` and `…0500_purchasing_reorder`, which sort after
every `20261004…` migration (no earlier table or function changed except
`staff_search`, replaced with every existing branch, Phase 6's
`consignor`, `consignment_item` and `sale` included, plus `supplier` and
`purchase_order`; see the note in that file). Tables `suppliers`, `supplier_products`, `purchase_orders`,
`purchase_order_lines`, `purchase_order_events` (append-only),
`purchase_receipts` and `purchase_receipt_lines` (immutable), all with RLS
in their migration; cost-gated definer views `supplier_products_staff`,
`purchase_order_lines_staff`, `purchase_receipt_lines_staff` and
`purchase_order_totals_staff`; reporting views
`reporting.purchase_order_progress` and `reporting.product_on_order`.
RPCs: `set_supplier_product`, `remove_supplier_product`,
`create_purchase_order`, `update_purchase_order`, `set_purchase_order_line`,
`remove_purchase_order_line`, `submit_purchase_order`,
`cancel_purchase_order`, `purchase_cost_defaults`, `receive_purchase`
(replay-safe by idempotency key; stock through Phase 4's ledger under
`private.lock_stock`; last cost per D63), `purchase_receipt_by_key`,
`reorder_suggestions` and `create_purchase_order_from_low_stock`. App:
`src/lib/purchasing.ts`, `purchasing-forms.ts`, `receive-form.ts` (the
Receive screen's idempotency state machine) and the domain modules
`suppliers.ts` and `purchasing.ts`; routes `/purchasing` (orders),
`/purchasing/orders/[id]`, `/purchasing/suppliers`,
`/purchasing/suppliers/[id]` (the `(browse)` group with its loading
skeletons), and, manage_purchasing only with a real 403,
`/purchasing/receive/[id]` and `/purchasing/reorder`; the product page's
"Suppliers & orders" card; Reorder links on the Inventory low-stock filter
and Today's low-stock tile. Decisions D60-D66 (§6, record
[ADR-018](decisions/ADR-018-purchasing.md); D60 as amended by the owner's
staff-roles decision of 2026-10-06). At the integration with Phase 6,
consignment-owned products are never purchased: `set_supplier_product`
also refuses them (`purchase_line_not_shop_owned`), as the PO line and the
low-stock draft already did. Tests: database files `purchasing`, `purchasing-access`,
`purchasing-concurrency`, `purchasing-reorder` and `purchasing-seed`; unit
tests for the pure modules, the forms and `receive-form.ts`; E2E
`purchasing.spec.ts` (suppliers and orders, journey 3's receiving step with
a double tap, a lost response and a lost request, the closed receive page,
reorder, and the permission boundary, on phone and iPad). Not built here:
the receive screen's label-print shortcut, which waits for Phase 8.

### Phase 8 — QR and labels

- Migrations: label_templates, printer_profiles, print_jobs; seed a default
  58×40 mm template and a browser profile.
- `src/lib/printing/`: `LabelTemplate` renderer (SVG → print page / PDF via
  the browser print path), `PrinterAdapter` interface, `browser` and `pdf`
  adapters, `PrintJob` lifecycle.
- UI: Print Label flow (quantity, profile), bulk N identical labels, unique
  label with identity lines, print job history.
- The QR base: replace the body of `getQrBase()` in `src/lib/qr.ts` with
  the database QR base (`shop_settings.public_site_url`, as `label_preview`
  reads it) and add it to `scanBases()`, keeping the environment's base so
  earlier labels still scan. Every QR shown (publication card, unit page)
  and every scan goes through that file.

Tests: QR payload equals public URL; N labels same payload; unique label
distinct; E2E journey 3 labels step.

Shipped (Phase 8 as a whole, on `feat/p8-labels`, stacked on
`feat/p6-consignment`): migration `20261004003800_labels`
(`label_templates`, `printer_profiles`, `print_jobs` with three typed
foreign keys and content, template and profile snapshots, written only by
RPCs and never deleted; `private.qr_payload`, `private.label_content`;
RPCs `label_preview`, `create_print_job`, `set_print_job_status`,
`set_default_label_template`, `set_default_printer_profile`; the built-in
58 × 40 mm template per kind and the browser and PDF profiles are inserted
by the migration) and the seed's five print jobs. Modules: `src/lib/qr.ts`
on the database base (`getQrBase()`, `qrUrl()`, `scanBases()`,
`environmentScanBase()`), `src/lib/printing/` (schemas, `composeLabel`,
`LabelSvg`, the browser and PDF adapters, the job status machine, links,
`print-sheet.ts`), `src/lib/domain/labels.ts` (with `resolvePrintPreset`),
the label and settings Server Actions, and the components
`PrintLabelButton` / `PrintLabelSheet`, `LabelsCard`,
`HeaderPrintLabel`, `PrintJobControls`, `PrintJobConfirm`,
`PrintJobOutcome`, `QrLabelUrl` and the label settings forms. Routes:
`/labels`, `/labels/[jobId]`, `/settings/labels` (admins), the print view
`/print/labels/[jobId]` and `GET /api/labels/[jobId]/pdf`, plus Print
label and the Labels card on the product, unit and bike pages
(`?print=1&qty=N&reprint=…`). Decisions: D9 (the QR base:
`shop_settings.public_site_url`, no fallback) and D56–D59
([ADR-017](decisions/ADR-017-labels-and-qr-base.md)). Tests: the database
files `labels.test.ts` and `labels-concurrency.test.ts`, the stack test
`labels-domain.stack.test.ts`, the unit tests in `tests/unit/printing/`,
`print-label.test.tsx`, `print-job-controls.test.tsx`, `qr-base.test.ts`
and `qr-base-sources.test.ts`, and E2E `print-view.spec.ts`,
`labels.spec.ts` and the label steps of journey 3 (ten identical labels
through the PDF adapter, `inventory.spec.ts`) and journey 4 (one U- label
for the consigned bike, `consignment-journey.spec.ts`). The anonymous half
of SPEC §31 (a scan opens the public page) is proven at the database:
`labels.test.ts` reads `reporting.public_items` as anon and as staff and
gets identical rows for the same short ID. Staff see that row through the
existing "What the public sees" panel until Phase 11 serves
`/q/[shortId]` on the public site and creates `public.public_item`; this
phase adds no anonymous RPC, client or route. Built at the merge of
`main` into `feat/p8-labels` (2026-10-06): the purchase order's receipts
offer "Print N labels" per received line, the product's print sheet at
the received count, since receiving returns to the order
([RISKS R-029](RISKS.md#r-029--the-purchase-receive-screen-has-no-print-n-labels-shortcut-yet),
resolved; journey 3 in `tests/e2e/purchasing.spec.ts`).

### Phase 9 — Reporting and reconciliation

- Views finalised; optional `inventory_balances` cache + `stock_reconciliation`
  if measurements warrant; period report pages (day/week/month/custom,
  drill-down by job, product/category, service, mechanic, ownership type),
  explicit date-basis selector (check-in / completion / collection / sale).
- Operational exceptions panel: negative stock, units in impossible states,
  unsettled consignments older than N days, failed integrations.

Tests: daily_summary reconciles with financial_lines for seed; date-basis
switch changes counts as expected.

Shipped (Phase 9, four steps, 2026-10-06, on `feat/p9-reporting` from
`feat/staff-roles` 5c9fbc7; local, not pushed; decisions D100–D108,
[ADR-022](decisions/ADR-022-reporting.md)). Migrations
`20261006001000_report_periods` (enums `report_date_basis`,
`report_grain`, `report_dimension`; `reporting.financial_lines` with the
explicit `sa.source <> 'work_order'` exclusion; the view
`reporting.report_lines`; `private.report_rows`, `report_foreign_rows`,
`report_key`, `report_key_valid`, `report_require_range`; the RPCs
`report_period_summary`, `report_period_series`, `report_breakdown`,
`report_line_items`, `report_activity`, `report_activity_by_mechanic`; six
indexes), `…1100_report_stock_value` (`report_stock_value`),
`…1200_stock_reconciliation` (`private.unit_expected_on_hand`; the views
`reporting.unit_ledger_disposition`, `unit_reconciliation`,
`stock_reconciliation`; the RPCs `report_stock_reconciliation`,
`report_unit_reconciliation`) and `…1300_operational_exceptions`
(`shop_settings.consignment_settlement_alert_days` and the admin RPC
`set_consignment_settlement_alert_days`; `private.exception_visible`; the
Phase 10 placeholder `private.integration_exceptions()`; Phase 5's
`reporting.operational_exceptions` extended with six columns and the kinds
unit_state_mismatch, unsettled_consignment and integration_failed, and
currency_mismatch on sale lines; `public.operational_exceptions`
recreated; `report_exception_counts`; Today's `exceptions_now` per caller).
No seed rows; `daily_summary` and `today_dashboard` keep their signatures.
Routes: `/reports` (period and date basis in the URL, figures, buckets,
the breakdown by seven dimensions, stock at cost now, activity, jobs by
mechanic, the Exceptions link with the caller's count), `/reports/lines`,
`/reports/exceptions` (grouped exceptions, the admin's threshold sheet),
`/reports/reconciliation` (Problems only / Everything, a product filter,
products by location and unique items, links to the guarded fix) and the
CSV Route Handler `/reports/export` (kinds `series`, `breakdown`, `lines`,
`stock_value`, `mechanics`, `exceptions`, `stock`, `units`; cost columns
only with View costs; refused rather than cut short, R-057). Phase 5's
`ExceptionList` and exception helpers were extended, not rewritten; Today
gained "See all exceptions" and a linked capped note; Inventory gained
"Reconcile stock" and the product page "Check against the ledger". No
`inventory_balances` cache: the bench measured the ledger fast enough
(reconciliation 48–90 ms on 3,008 units), while Today and the exception
counts miss their targets at a busy year's volume (R-059). Code:
`src/lib/period-reports.ts`, `csv.ts`, `report-exports.ts`,
`reconciliation.ts`, `src/lib/domain/period-reports.ts`,
`report-exports.ts`, `reconciliation.ts`,
`src/components/domain/reports/`. Tests: database
`period-reports.test.ts`, `period-report-exports.stack.test.ts`,
`stock-reconciliation.test.ts`, `operational-exceptions.test.ts`; unit
`period-reports.test.ts`, `csv.test.ts`, `report-exports.test.ts`,
`reconciliation.test.ts`, `exception-kinds.test.ts`,
`today-components.test.tsx`; E2E `reports.spec.ts` and
`exceptions.spec.ts`; bench `scripts/bench/report-volume.sql`
(DATA-MODEL §14). Gate results in
[ENGINEERING](ENGINEERING.md#validation) and [NOW](../NOW.md). Owner
questions 12, 26 and 27 stay open.

### Phase 10 — Shopify

Decisions: D80–D89 in [§6](#6-open-decisions-for-the-owner), recorded in
[ADR-020](decisions/ADR-020-shopify.md); D7 applies to online refunds (D85).
Built in four steps: (1) the inbound database (webhook recording, queue,
order and refund processing through `private.sell_line`), (2) the outbound
product-sync database, (3) the service layer, (4) the screens.

Shipped so far: step 1 (`feat/p10-shopify`): `20261004003900_shopify_integration.sql`
and `20261004004000_shopify_order_processing.sql`, the Phase 10 seed,
`tests/db/shopify-webhooks.test.ts` and `tests/fixtures/shopify.ts`; step 2:
`20261004004100_shopify_product_sync.sql` (the online price, Publish online,
Sync now, the settings RPC, the deferred enqueue triggers, the sync
worker's state and result RPCs, `reporting.shopify_sync_status`,
`reporting.public_items.buy_online_url`) and
`tests/db/shopify-sync.test.ts`; step 3: `src/lib/integrations/shopify/`
(the live GraphQL and fake adapters, HMAC, desired state, the sync,
queue, webhook and cron handlers), the routes `api/shopify/webhooks` and
`api/cron/integrations`, `vercel.json`, the Shopify and cron environment
variables, the unit tests, `tests/db/shopify-gid-parity.test.ts` and
`tests/db/shopify.stack.test.ts`, and [RUNBOOK "Shopify"](RUNBOOK.md#shopify).

Shipped (Phase 10 as a whole, on `feat/p10-shopify`, stacked on
`feat/p8-labels`): migrations `20261004003900_shopify_integration`
(settings, sync rows, events, the queue, the audit trail, webhook
recording, the gid and backoff helpers, the owner-only purge),
`20261004004000_shopify_order_processing` (`private.sell_line` with
`shopify_line_part`, order and refund processing, retry, dismiss, the
variant and customer links, `private.integration_exceptions` in
`reporting.operational_exceptions`) and
`20261004004100_shopify_product_sync` (the online price, Publish online,
Sync now, the settings RPC, the deferred enqueue triggers, the worker's
state and result RPCs, `reporting.shopify_sync_status`,
`public_items.buy_online_url`), and the Phase 10 seed. Modules:
`src/lib/integrations/shopify/` (the GraphQL and in-memory adapters, HMAC,
desired state, the sync, queue, webhook and cron handlers),
`src/lib/domain/shopify.ts`, `src/lib/shopify.ts` (words and tones) and
`src/lib/shopify-forms.ts`. Routes: `POST /api/shopify/webhooks`, `GET
/api/cron/integrations` (Vercel cron every 5 minutes, `CRON_SECRET`), and
the admin-only screens `/shopify` (connection, settings, tiles),
`/shopify/queue` (Needs attention / Waiting / Recent: Retry, Link to a
BICII product, Dismiss with a reason), `/shopify/products`,
`/shopify/events` and `/shopify/events/[id]` (the event inspector with the
customer link); the product page's Online (Shopify) card for every staff
member (Publish online and Sync now with manage_inventory, which run only
the job id the RPC returned); Today's `integration_failed` exception row
("Shopify needs attention", opening the queue on that job, admins only);
an online sale recorded before its customer was linked shows that customer
on its page; Shopify in More. Decisions: D80–D89
([ADR-020](decisions/ADR-020-shopify.md)); D80–D88 are build defaults for
the owner to confirm, and D89's tax basis (is the store tax-inclusive?)
and Shopify POS (does the shop sell through it?) stay OPEN (owner
questions 23–25). Refund netting and the Cult Commons claw-back stay
owner question 12 /
[R-021](RISKS.md#r-021--reports-overstate-net-sales-after-a-refund-or-restock)
for Phase 9's refund-reporting row (in D100–D119): online refunds are
financial only and net nothing yet (D7, D49, D85). Tests: the database
files `shopify-webhooks.test.ts`, `shopify-sync.test.ts`,
`shopify-gid-parity.test.ts` and `shopify.stack.test.ts`; the unit tests
of the service layer and `shopify-screens.test.tsx`, `reports.test.ts`,
`today-components.test.tsx`; E2E `shopify.spec.ts` (journey 5 with a
replay under a new webhook id, the unmapped-variant link on its own
product, Today's exception row, the rejected delivery, the refund that
moves no stock, the access boundaries and the overview). Not verified
against a real Shopify store
([R-011](RISKS.md#r-011--shopify-is-not-built-and-will-be-fixture-tested-only),
[R-047](RISKS.md#r-047--the-live-shopify-adapter-is-unverified-against-a-real-store)).

- Migrations: integration_events, shopify_product_sync,
  integration_retry_queue; RPCs `process_shopify_order_paid`,
  `process_shopify_refund`.
- `src/lib/integrations/shopify/`: Admin API client (GraphQL), HMAC
  verification, webhook route handler that only persists then enqueues,
  processor, outbound sync (create/update product + variant + inventory
  level), mapping tables.
- UI: Sync status per product, publish-online toggle, error queue with
  retry, event inspector.

Tests: duplicate webhook one effect; unmapped variant goes to queue, nothing
partial; refund creates no stock movement; E2E journey 5 with a signed
fixture payload.

### Phase 11 — Public-site integration (in the `bicii` repo)

SPEC §18 in two steps, one per repository. The public site (repository
`georgieboys/BICII`) is a second client of this database: it calls only
the customer `my_*` RPCs, the anonymous booking reads,
`reporting.public_items` and the step 1 objects below, and holds no
business rule (decisions D120–D125, record
[ADR-023](decisions/ADR-023-public-site.md)). Migrations sort after
everything live (the go-live rule: hosted migrations are only appended).

**Step 1, this repository: the missing backend.** Migration
`20261006103000_public_site`:

- `claim_my_customer(create_if_missing, first_name, last_name, phone)`:
  links a confirmed login to its customer record by email (D121), or makes
  one at the first booking (D122); `setof customer_profile`, EXECUTE for
  authenticated, an advisory lock per address.
- `bookable_slots(from_day, to_day, appointment_type_id)`: the range
  wrapper over `private.available_slots_at` PLAN Phase 2 reserved (D123);
  anon and authenticated, at most 31 days.
- Storage policy `media_internal_select_customer` with
  `private.customer_can_read_media(name)`: customers read the objects of
  their own customer-visible bike and job photos (D124).
- The magic-link email says "the BICII sign-in screen" (customers receive
  it too).

Tests: `tests/db/public-site.test.ts` (claim: anon refused, unconfirmed
refused, nothing without a booking, create once with a name, links one
match in any case and keeps staff data, refuses two matches, skips
archived and taken records, refuses an archived own record, keeps the link
after email changes, a two-connection race makes one record; slots: equals
`available_slots` day by day for anon, a customer and staff, D37's public
types, the 31-day limit and bad bounds; photos: exactly the caller's
customer-visible bike and job photos, gone when the bike is archived or the
job cancelled, nothing for anon or a login without a record, no writes;
and every short-ID prefix the Admin's `/q` resolves, which closes this
phase's "every prefix resolves" check), the API surface fixture and the
generated types.

**Step 2, repository `bicii`: the screens.** Supabase clients and a
`proxy.ts` session refresh limited to the account, booking and item
routes, so the marketing pages stay static. `/sign-in` (email, then the
6-digit code, from the browser, D120; then `claim_my_customer`), `/account`
(profile, upcoming and past appointments with Cancel until D37's cutoff,
bikes, jobs), `/account/bikes/[id]` (photos and service history, D12, D17),
`/account/jobs/[id]` (status, lines, timeline and photos, D8, D17), `/book`
(type, two weeks of times from `bookable_slots`, an optional bike and
note; the first booking asks for a name and creates the record, D122;
replay-safe client ids, D37) and `/q/[shortId]` (D125). Unit tests for the
helpers, and E2E journey 6 (SPEC §27.3: a customer signs in and sees only
their own appointments, bikes and history) against this repository's
devstack, in that repository's CI. Its pull request merges only once the
Admin is live on the same hosted database. Merged at the owner's request
on 2026-10-17 SGT (georgieboys/BICII#1, 12ee59e; its CI `check` and
journey 6 green against this repository's `main`) and served by the
public site's production deployment; customer accounts stay closed (its sign-in page says online accounts aren't open yet) until RUNBOOK "The public site: customer accounts" steps 2, 3 and 6 are done.

Not in Phase 11: Buy online (waits for Phase 10's storefront addresses,
D125), a services listing for anonymous visitors (no screen needs one;
DATA-MODEL §5 (d) stays open), rescheduling and customer messages
([R-017](RISKS.md#r-017--appointments-mvp-has-no-reschedule-and-no-customer-messages)),
and any sign in the Admin that a customer has a website login.

### Phase 12 — Hardware label adapter

After the printer models are known. Adds one adapter behind the existing
interface; no changes elsewhere.

### Phase 13 — Indent parts and customer quotes

The owner's addition of 2026-10-14 (D140–D148,
[ADR-024](decisions/ADR-024-indent-parts-and-customer-quotes.md)): a part
the shop does not stock is proposed on a job, quoted to the customer, who
approves or declines each item from a private link, then ordered, received
and fitted. It lifts SPEC §7.1's offline approval and SPEC §30's exclusions
for quotes only (D148). Migrations sort after everything live.

**Step 1, database.** `job_part_requests` (D140: product, quantity, price
shown, expected cost and supplier, state; no movement, no line until fit),
`quotes` and `quote_items` (D141: snapshot, 7-day expiry, SHA-256 of a
32-byte token, one open quote per job), RPCs `propose_part`,
`propose_service`, `cancel_part_request`, `send_quote` (returns the token
once), `withdraw_quote`, `order_part_requests` (D145, `manage_purchasing`:
the supplier's draft purchase order, linked lines), `fit_part_request`
(D146: `add_inventory_line` from the receiving location) and, for anon by
token only, `quote_by_token` and `answer_quote` (D142, D143: per-item
answers once, the job's approval flag and note, timeline events). RLS on
every table in the same migration; costs only to `view_costs` or
`manage_purchasing` (D147). Tests first: no movement or line before fit;
totals unchanged until fit; a token answers once, only its own quote,
never after expiry or withdrawal, and the hash alone answers nothing;
anon reads nothing else; ordering raises the right purchase order line;
arrival follows receipts first requested first covered; fit records one
`job_consumption` movement through D23 and D24; a two-connection race
answers once.

**Step 2, staff screens.** On the job: an Indent parts card (propose an
existing product or a new one, cancel), Send quote (WhatsApp, email when
configured, copy link, D144), the quote's state and answers, Order (with
Waiting on parts) and Fit. The product page shows quantities reserved for
jobs. E2E: propose, send, answer, order, receive, fit on phone and iPad.

**Step 3, the quote page and email.** `/quote/[token]` (D143), outside
the staff routes: items, total, per-item answers, name, the deposit when
Phase 14 is on; not indexed, no referrer, rate-limited. Email through
Resend's API (`RESEND_API_KEY`, `EMAIL_FROM`), off until both are set.

**Follow-up after the owner's live test (2026-10-15, D149,
[R-082](RISKS.md#r-082--approved-indent-parts-can-be-left-unfitted-on-a-completed-or-collected-job)).**
`20261014000700_indent_closed_jobs`: an admin or manager cancels an
unfitted request on a collected or cancelled job with a reason (D149),
one still on a quote left open there included (the cancel withdraws that
quote); build defaults with it: ordering refuses a job that is not open and withdrawing refuses a closed
one; `work_order_unfitted_requests` (the memo under the Lines total),
`payment_issues`' `paid_parts_not_fitted`,
`work_order_payment_totals.held_over_total` and the quote page's
`job_closed`. On screen: the memo, "Not fitted" items with what to do on a
job that is no longer open, both ways to Collected naming them (since
replaced by D149b's settle checklist), the Fit sheet's warnings (never
ordered in BICII; no cost).

**Closing indent items (2026-10-15, D149a, D149b; D149c confirmed by the owner the same day).**
The owner chose to block Complete (PRODUCT question 33) and to let Fit
record a part bought outside BICII.
`20261014000800_outside_purchase_enum` (the ledger type) and
`20261014000900_indent_settle_and_outside_purchase`:
`fit_part_bought_outside` (View costs or Manage purchasing: one
`outside_purchase` movement at the entered unit cost and the ordinary fit
at the same location; the product's cost becomes that cost), the settle
guard (no move into completed, ready for collection, collected or
cancelled while a request is approved or ordered), an open quote withdrawn
when its job leaves the open statuses, and a one-off withdrawal of open
quotes on jobs already not open. On screen: Complete, Ready, Collected and
Cancel job open a checklist with Fit and Cancel item… (Cancel only for
Cancel job); the Fit sheet's "Bought outside BICII". Tests first
(`tests/db/indent-close.test.ts`).

**Voiding a fitted indent line (2026-10-15, D160,
[R-083](RISKS.md#r-083--a-fitted-indent-request-whose-line-was-voided-is-stuck-and-unflagged)).**
The owner chose the first of R-083's three options: the void undoes the
fit. `20261014001000_part_unfitted_enum` (the timeline type) and
`20261014001100_indent_unfit_on_void`: a trigger on every void of a job
line puts the fitted request that points at it back to ordered (on a
purchase order line) or approved, unlinked, with `part_request_unfitted`
on the timeline; a request is never linked to a voided line again; a
one-off un-fits those already left that way. The void's stock reversal,
the totals, yield and Cult Commons are unchanged. On screen: the void's
confirmation says the item goes back to approved (or ordered); the indent
card shows it with Fit and Cancel and says its line was voided. Tests
first (`tests/db/indent-unfit.test.ts`).

Not in Phase 13: hard reservation of arrived stock
([R-080](RISKS.md#r-080--arrived-indent-stock-is-not-held-for-its-job)),
quotes on the public site, messages other than quotes.

### Phase 14 — Customer payments through Stripe

The owner's decision of 2026-10-14 (D150–D156,
[ADR-025](decisions/ADR-025-stripe-payments.md)), with the build defaults
D157–D159 (rollout, deposit rules, what changes a payment): deposits on
quotes first, then balance links. Needs the owner's Stripe account
(Singapore, PayNow on) and keys; built and tested against an in-memory
fake first, and off in production until D157's conditions hold.

**Step 1, database and adapter (built).** Migrations
`20261014000300_payment_enum_values.sql` (the three timeline types on
their own) and `20261014000400_stripe_payments.sql`: `payments` (D153),
`stripe_events` (every delivery once by event id and every server read,
rejected ones without a body), `payment_refunds` (one row per Stripe
Refund, D155), and the service-role RPCs `record_stripe_event` and
`record_stripe_read` that store and apply in one transaction (D159).
`src/lib/integrations/stripe/` (the adapter over fetch, no SDK; the fake;
`stripeConfig`, which keeps Stripe off with a reason unless every variable
is right for the deployment, D157) and `POST /api/stripe/webhooks`
(signature on the raw body; 500 so Stripe retries when storing fails).
Checkout session creation with the job and quote in metadata is in the
adapter; the flows that call it come with step 2. Tests: a payment changes
only from a verified event; a replayed event changes nothing; amounts are
numeric and equal Stripe's in cents; refunds and partial refunds; nothing
in job totals or reports' sales changes (D154); the signature, the
configuration matrix, the adapter's requests and errors, and the route.

**Step 2, deposits (built, against the fake).** Migration
`20261014000500_indent_deposits.sql`: `shop_settings.indent_deposit_percent`
(D151, admin; ships at 0, D157), the deposit snapshotted on the quote when
sent and answered (D158), the deposit on the quote page and Checkout after
answering, Settings → Customer payments, the job's Customer payments card
with Check with Stripe and "Deposit due", ordering after the deposit or an
override with a reason (D152; the order sheet starts unpaid parts
unticked), and "needs attention" issues on the job and in Exceptions
(D159). Tests: `tests/db/indent-deposits.test.ts`, the unit tests and
`tests/e2e/payments.spec.ts` (journey 8).

**Step 3, balance links and reporting.** Send a payment link for the
balance (D156); payments and deposits held in Reports (D154).

## 3. First milestone — the vertical slice (SPEC §35)

The first milestone is Phase 0 plus the minimum of Phases 1, 3 and 4 needed
to prove the architecture, delivered as a sequence of small PRs on this
repo:

| # | PR | Contents | Gate |
|---|---|---|---|
| M1.0 | `plan` (this PR) | docs | review |
| M1.1 | `scaffold` | Next 16 app, tokens, shell, CI, env, harness, migrations 0001–0002, login, `requireStaff` | check + db tests + login E2E |
| M1.2 | `customers-bikes` | migrations, domain, Customers + Bike screens, camera upload | RLS tests |
| M1.3 | `workshop-core` | work orders, assignments, events, services, line items, status RPC, intake flow, board, job detail | status/snapshot/CC tests |
| M1.4 | `inventory-core` | locations, products (quantity only), movements, `add_inventory_line`, `void_line`, stock badge in job | consume-once + reversal tests |
| M1.5 | `today` | daily_summary view, Today dashboard, seed data for several days | reconcile test, E2E journey 1 |

Exit criteria for the milestone (all from SPEC §31 and §35): a staff user on
a phone can create a customer and bike, check a bike in with a photo, assign
a lead mechanic, add one service and one part, see the part's stock decrement
exactly once, see correct sale/cost/yield/Cult Commons on the job (admin) and
sale only (mechanic without `view_costs`), move the job to completed and then
collected with distinct timestamps, and see all of it on Today.

## 4. Environment and secrets

| Variable | Where | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | app | public |
| `SUPABASE_SERVICE_ROLE_KEY` | `src/lib/admin/**` (staff invites, the sign-in counters of D72) and integrations | never in client bundles; every staff sign-in needs it |
| `DATABASE_URL` | tests, type-gen | local Postgres or staging |
| `NEXT_PUBLIC_PUBLIC_SITE_URL` | app | QR base; also stored in `shop_settings` |
| `SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_ADMIN_TOKEN`, `SHOPIFY_WEBHOOK_SECRET` | Vercel Production (Phase 10); Preview only a separate development store's | token and secret Sensitive; never the live store's in Preview (staging handles collide with production's) |
| `SHOPIFY_ALLOW_PREVIEW` | Vercel Preview, only with a development store's values | `true` lets the live adapter run in Preview; unset, Shopify is off there |
| `SHOPIFY_ADAPTER` | unset in Production and Preview | `fake` only locally, in CI and in E2E (env.ts refuses it in production) |
| `CRON_SECRET` | Vercel (Production, Preview) | Sensitive; the bearer of `/api/cron/integrations` (D87); unset = the route answers 503 |
| `RESEND_API_KEY`, `EMAIL_FROM` | Vercel Production (Phase 13 step 3) | quote emails through Resend's API (D144); the key Sensitive; either unset = no Email option |
| `STRIPE_SECRET_KEY` | Vercel Production only (Phase 14): a restricted live key, Sensitive; Preview **unset** (D157); locally a test key or unset | Checkout Sessions write, Refunds read; a test key in Production or a live key elsewhere keeps Stripe off |
| `STRIPE_WEBHOOK_SECRET` | the same placement as the key | the endpoint's signing secret (`whsec_…`), Sensitive; unset = Stripe off and `/api/stripe/webhooks` answers 503 |
| `STRIPE_ADAPTER` | unset in Production and Preview | `fake` only locally, in CI and in E2E (env.ts refuses it with a key or in production) |
| `ADMIN_ORIGIN` | Vercel Production `https://<admin host>`; locally `http://localhost:3000` | not secret; where Stripe returns customers (never the request's Host); invalid or unset = Stripe off |
| `LOG_LEVEL` | app (optional) | `info` in Production, `debug` in Preview |
| `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` | Vercel | stable across instances |

Supabase projects: `bicii-staging` (previews, E2E) and `bicii-prod`. The
owner creates them and places keys in Vercel and GitHub secrets; the agent
never sees production keys.

## 5. Risks and mitigations

This is the planning-time list. Live risks, with status, evidence and next
actions, are in [RISKS.md](RISKS.md); update them there.

- **Docker-less environments cannot run `supabase start`.** Mitigated by the
  devstack (`scripts/devstack/`): the real Supabase Auth, PostgREST and
  Storage on a plain Postgres 16 behind a local gateway, so DB tests and
  login E2E run against real Supabase services without Docker or staging
  credentials.
- **Turbopack + PWA tooling.** Serwist needs webpack; a hand-written service
  worker avoids it. Offline is out of MVP scope anyway.
- **RLS and column-level grants are easy to get subtly wrong.** The RLS
  matrix test enumerates every table for anon and customer; it fails if a
  new table appears without a policy row in the matrix fixture. Its first
  half exists from Phase 0: the devstack recreates hosted Supabase's default
  grants on `public`, and the API-surface meta tests compare everything
  `anon` and `authenticated` can execute or touch with
  `tests/fixtures/api-surface.ts`. Phase 1 adds the customer rows.
- **Shopify API versions move quarterly.** The client pins a version
  constant and the sync records `api_version` per event.
- **iOS camera and PWA quirks.** `capture="environment"` input, not
  `getUserMedia`, for photos; `BarcodeDetector` with ZXing fallback for scan;
  install instructions screen for Safari (no `beforeinstallprompt`).
- **Public site integration drift.** Shared RPC and view contracts are
  documented in DATA-MODEL.md; the public site consumes `public_items` and
  the appointment RPCs only.

## 6. Open decisions for the owner

These are the places where the plan had to choose something the brief does
not state and the choice touches business meaning. Each has a default the
build proceeds with; confirm or change before the phase that uses it.
Status (2026-10-05) says whether the owner has confirmed, amended or changed
each default, and Record links its decision record in
[decisions/](decisions/README.md). Numbers are allocated by track (the
orchestrator's allocation of 2026-10-06), never "the next free": D43–D59
main line (Phase 6 D44–D55, labels D56–D59), D60–D69 purchasing (Phase 7),
D70–D79 staff email sign-in, D80–D89 Shopify (Phase 10), D90–D99 staff
roles, D100–D119 reporting (Phase 9), D120–D139 public site (Phase 11),
D140–D149 indent parts and quotes (Phase 13), D150–D159 Stripe payments
(Phase 14), D160 and up later. Decision records follow the same plan:
ADR-017 labels, ADR-018 purchasing, ADR-019 email sign-in, ADR-020
Shopify, ADR-021 staff roles, ADR-022 reporting, ADR-023 public site,
ADR-024 indent parts and quotes, ADR-025 Stripe payments. A phase uses
only its own range.

| ID | Decision | Default in plan | Used from | Status (2026-10-05) | Record |
|---|---|---|---|---|---|
| D1 | Rate of Cult Commons when a line has negative yield within a job whose total yield is positive | Per-line: share is computed per line with `max(yield, 0)`; a loss-making line contributes 0, it does not offset other lines. Job total CC = Σ line CC. | Phase 3 | Accepted: build default, not individually confirmed by the owner | [ADR-004](decisions/ADR-004-cult-commons.md) |
| D2 | Appointment capacity unit | One `intake_capacity_units` pool per `intake_slot_minutes` window across the shop; appointment types consume `capacity_units` for their whole duration. | Phase 2 | Accepted: build default, not individually confirmed by the owner | [ADR-013](decisions/ADR-013-appointments.md) |
| D3 | Recognition date for workshop revenue in reports | `work_orders.completed_at` (not collected_at, not check-in). Reports also offer check-in and collection as alternative bases. | Phase 5 | Accepted: build default, not individually confirmed by the owner; refined by D32 | [ADR-011](decisions/ADR-011-recognition-and-financial-reporting.md) |
| D4 | Consignment charges (services done on a consigned bike before sale) | Entered per charge with an explicit bearer: `consignor` (deducted at settlement) or `shop` (added to direct cost). No default bearer; the UI requires a choice. | Phase 6 | Accepted: build default, not individually confirmed by the owner; implemented by Phase 6 (`consignment_item_charges.bearer` has no default, `charge_bearer_required`; D44, D45, D46) | [ADR-014](decisions/ADR-014-defaults-for-unbuilt-phases.md), [ADR-016](decisions/ADR-016-consignment-and-sales.md) |
| D5 | What a purchase receipt does to `products.default_direct_cost` | Sets it to the latest actual unit cost received (last-cost). No averaging. | Phase 7 | Accepted: build default, not individually confirmed by the owner; implemented by Phase 7 as refined by D63 | [ADR-014](decisions/ADR-014-defaults-for-unbuilt-phases.md) |
| D6 | Unique unit added to a job as a part | Unit becomes `held_for_customer` on add, `sold` when the job is completed; voiding before completion returns it to `available`. Interacts with D15 (reopen): the unit follows `completed_at`, with no stock movement — whenever `completed_at` goes from non-null to null (a reopen) every unit on a non-voided inventory line of the job goes sold -> held_for_customer, and whenever it goes from null to non-null (including re-completion after a reopen) they go held_for_customer -> sold. Refined by SOLD-AT-COMPLETION (D25). | Phase 4 | Accepted: build default, not individually confirmed by the owner | [ADR-010](decisions/ADR-010-stock-and-units-on-jobs.md) |
| D7 | Refund of an online sale | Financial `sale_refunds` row only; stock and unit status untouched until staff runs `restock_unit`. | Phase 10 | Accepted: build default, not individually confirmed by the owner; implemented for retail refunds by Phase 6 (`record_sale_refund` never moves stock; `restock_unit` is separate; D49) and for online refunds by Phase 10 (`process_shopify_refund` writes one `sale_refunds` row and nothing else; D85) | [ADR-014](decisions/ADR-014-defaults-for-unbuilt-phases.md), [ADR-020](decisions/ADR-020-shopify.md) |
| D8 | Customer-visible timeline | Customers (later, public site) see status changes, completion, collection and `customer`/`public` photos; never notes, lines' costs, or assignments. | Phase 11 | Accepted: build default, not individually confirmed by the owner | [ADR-006](decisions/ADR-006-customer-and-public-visibility.md) |
| D9 | Short ID format and QR base URL | `B-/J-/P-/U-/C-/PO-/S-` + 6 digits; QR = `{public_site_url}/q/{short_id}`. The Admin also answers `/q/{short_id}` for staff and redirects to the record (`resolveShortId`, Phase 4); it is the only Admin /q route. Phase 2 stores `shop_settings.public_site_url` (nullable, informational): Phase 8 decides whether it or `NEXT_PUBLIC_PUBLIC_SITE_URL` is the QR base; until then the env var is. | Phase 1 | Accepted: build default, not individually confirmed by the owner; 2026-10-05: QR base decided in Phase 8: shop_settings.public_site_url, no fallback (ADR-017) | [ADR-007](decisions/ADR-007-short-ids-and-qr-base.md), [ADR-017](decisions/ADR-017-labels-and-qr-base.md) |
| D10 | Staff login method | Supabase email one-time codes (owner decision 2026-10-05, replacing email + password). /login asks for the email and Supabase Auth emails a 6-digit code (`signInWithOtp` with `shouldCreateUser: false`, so signing in never creates an account); the person types the code (`verifyOtp`, type `email`). Codes only, no clickable magic links: a link would open in the mail app's browser, not in the installed Admin. The Admin has no password anywhere: no password sign-in, no password change and no temporary passwords. Supabase Auth itself still accepts a password grant for a login that has a password (the Email provider serves codes and passwords alike), so no staff login may have a known one: the seed and invites store the hash of a random secret nobody holds, logins created before the switch must have theirs replaced the same way before the code release is deployed (RUNBOOK, a required step; [R-035](RISKS.md#r-035--logins-created-before-email-codes-keep-a-known-password-until-the-pre-deploy-reset)), and setting a password needs reauthentication once a session is a day old ([R-036](RISKS.md#r-036--auths-password-grant-and-password-change-stay-reachable)) (`secure_password_change` in the devstack and config.toml, "Secure password change" on hosted projects). Logins are created only by invitation from Staff settings (an admin, or a `manage_staff` holder within D11): the Auth user is created without a password through the service-role admin API and linked by `create_staff`, and the invitee signs in with a code. Code rules, messages and residual risk: D70. Deactivation: D71. | Phase 0 (password); email codes from 2026-10-05 | Owner decision 2026-10-05 (changed from email + password, the owner's note "D11 changed"); built on `feat/auth-email-otp` and integrated with main and purchasing (2026-10-06) | [ADR-019](decisions/ADR-019-staff-email-sign-in.md), [ADR-005](decisions/ADR-005-staff-sign-in-and-delegation.md) |
| D11 | What a `manage_staff` holder who is not an admin may change (SPEC §4.2 asks for granular permissions but does not say who may grant them) | Delegation ceiling (unchanged): they may grant or revoke only permissions they hold themselves, never `manage_staff` (admins only), never on their own row and never on an admin's or a manager's row; they may invite mechanics only and deactivate or reactivate mechanics only (D93). Admins are unrestricted. The owner confirmed only the sign-in method (D10's move to email codes, 2026-10-05), not this ceiling. Since that move, the former residual risk (the inviter saw the new login's temporary password and could keep a second login) is gone for every login invited from then on, because an invite creates no password and only the invited mailbox receives codes; for logins created before the switch it is gone only once RUNBOOK's required password reset has run on the hosted project (Auth's password grant would otherwise still accept the old temporary password). What remains is that whoever controls the invited mailbox controls that login. A manage_staff holder who invites an address they control gets a mechanic login with no extra access until someone grants them, within this ceiling. Every invite is recorded in `staff_events` with the inviter as actor. | Phase 0 | Accepted: build default, not individually confirmed by the owner (as ADR-005 and PRODUCT owner question 1 record). Ceiling unchanged in code; the 2026-10-05 note "D11 changed" was the sign-in method (D10 here), as the orchestrator's owner-decision list records; the temporary-password residual risk is closed for new invites and, for pre-switch logins, once RUNBOOK's required reset has run ([R-035](RISKS.md#r-035--logins-created-before-email-codes-keep-a-known-password-until-the-pre-deploy-reset)). The staff roles of 2026-10-06 restate who may invite and on whose rows (D93, built on `feat/staff-roles`). | [ADR-005](decisions/ADR-005-staff-sign-in-and-delegation.md), [ADR-019](decisions/ADR-019-staff-email-sign-in.md) |
| D12 | Who sees a bike's customer-visible photos after it changes hands (SPEC §5 "Ownership changes preserve history" does not say what a new or previous owner sees) | The current owner sees every `customer`/`public` photo of the bike, including ones taken before they owned it; a previous owner stops seeing the bike and its photos once it is transferred (`my_bikes`, `my_bike_attachments` read current ownership). Staff history (`bike_ownership_events`) keeps every owner. Alternative to confirm before Phase 11: limit each owner to photos taken during their ownership. | Phase 1 (enforced), Phase 11 (shown) | Owner-confirmed 2026-10-05 | [ADR-006](decisions/ADR-006-customer-and-public-visibility.md) |
| D13 | Can a photo on a customer record be public? (SPEC §8 allows `public` visibility without saying for which records) | Never: attachments whose `entity_type = customer` may be `internal` or `customer` only (check constraint and RPC error `attachment_customer_never_public`). Bike photos may be public (shop and consigned bikes for sale need them); staff choose per photo. | Phase 1 | Accepted: build default, not individually confirmed by the owner | [ADR-006](decisions/ADR-006-customer-and-public-visibility.md) |
| D14 | Line pricing | Any active staff member may set or override a line's unit sale price (>= 0) when adding it; entering or overriding a unit direct cost (service-line override or manual-line cost) requires `view_costs` (42501 otherwise); no negative-price or discount lines in MVP (a discount is a lower unit price on the line). A manual line added without a cost (always, for staff without `view_costs`) is stored with unit cost 0 and marked `cost_pending`. **Consequence for Cult Commons, owner to confirm:** until it is corrected, that line's yield is its whole sale and its Cult Commons share is 30% of the whole sale, so the job's cost is understated and its yield and Cult Commons overstated (SPEC §10 deducts direct cost first). Safe default: the line shows "Cost pending" to every staff member, `work_order_totals_staff.cost_pending_count` counts such live lines and the job's totals are labelled provisional for `view_costs` holders; the correction is that a `view_costs` holder voids the line and adds it again with the cost (snapshots stay immutable; reopen first if the job is completed). Nothing blocks completion. Labour belongs on a service line (which snapshots the service's cost); parts become inventory lines in Phase 4. Options for the owner: block completing a job with a pending cost, let a `view_costs` holder enter a pending cost once, or have Phase 5 reports exclude or flag pending lines. | Phase 3 | Owner-confirmed 2026-10-05, clarified: a line's totals use the line's own cost, including 0; zero-price lines are valid (free parts) | [ADR-009](decisions/ADR-009-line-pricing-and-cost-pending.md) |
| D15 | Work order status machine | Transitions follow the table in DATA-MODEL §4; completed only from in_progress or paused; collected only from completed or ready_for_collection; collected and cancelled are final; nothing returns to received; reopening (completed or ready_for_collection -> in_progress) requires a reason and clears completed_at and ready_for_collection_at (started_at is kept; the timeline keeps the earlier `completed` event); lines can be added or voided only while the job is open (before completed). DEVIATION, owner to confirm before Phase 5: reopen clears completion stamps, which deviates from DATA-MODEL §4's original "stamps exactly once, never clearing an earlier stamp" and moves D3 recognition to the final completion. Phase 4 returns sold units to held_for_customer on reopen (whenever completed_at goes from non-null to null every unit on a non-voided inventory line of the job goes sold -> held_for_customer; whenever completed_at goes from null to non-null, including re-completion after a reopen, they go held_for_customer -> sold), with no stock movement (D6). Phase 3 keeps the reopen rule in `private.work_orders_enforce_rules` (commented as the Phase 4 extension point) so Phase 4 can create or replace it starting from Phase 3's body, or add its own `work_orders` trigger. | Phase 3 | Owner-confirmed 2026-10-05, including the reopen deviation | [ADR-008](decisions/ADR-008-work-order-lifecycle.md) |
| D16 | Cancelling a job | Only from an open status, reason required, refused while any non-voided line exists with P0001 `work_order_has_lines` (void lines first, which in Phase 4 writes the stock reversals). This is the single cancel-with-lines rule: it already covers inventory lines, so Phase 4 adds no separate parts rule or code. | Phase 3 | Accepted: build default, not individually confirmed by the owner | [ADR-008](decisions/ADR-008-work-order-lifecycle.md) |
| D17 | Which jobs a customer sees | The jobs where they are `work_orders.customer_id`, regardless of who owns the bike now (a new owner does not see the previous owner's jobs) and regardless of whether the bike is archived (the job is the customer's history); cancelled jobs are hidden; status is shown as a coarse customer status (received, awaiting_customer, awaiting_parts, in_progress, completed, ready_for_collection, collected); lines show description, quantity, unit price and total only; requested work, notes, approval, assignments, actors and all costs are never shown. Enforced by Phase 3 RPCs (built in step 2), shown in Phase 11. | Phase 3 | Accepted: build default, not individually confirmed by the owner | [ADR-006](decisions/ADR-006-customer-and-public-visibility.md) |
| D18 | A job's customer and the bike's owner | A job's customer must be the bike's current owner, or the bike must have no owner (shop bike); otherwise staff transfer the bike first (P0001 `bike_owner_mismatch`). Checked under FOR SHARE locks on the customer and bike, so it holds against a concurrent transfer. | Phase 3 | Accepted: build default, not individually confirmed by the owner | [ADR-008](decisions/ADR-008-work-order-lifecycle.md) |
| D19 | Can a photo on a work order be public? | Photos on a work order may be internal or customer, never public (P0001 `attachment_work_order_never_public`, CHECK `attachments_work_order_never_public` as backstop; the app refuses before copying anything to media-public), mirroring D13. | Phase 3 | Accepted: build default, not individually confirmed by the owner | [ADR-006](decisions/ADR-006-customer-and-public-visibility.md) |
| D20 | Overdue | A job is overdue while it is open (before completed: received … paused) and `now() - checked_in_at > interval '7 days'` (7 × 24 hours) (board badge and age filter; `OVERDUE_AFTER_DAYS = 7` and `isOverdue` exported from `src/lib/workshop.ts`; Phase 5's overdue_job exception and Today tile and Phase 9 reporting import or reuse exactly this rule). | Phase 3 | Accepted: build default, not individually confirmed by the owner | [ADR-008](decisions/ADR-008-work-order-lifecycle.md) |
| D21 | Cult Commons rate changes | Admin only, effective now or in the future (never backdated); rate rows are append-only except that an admin may cancel a rate whose effective_from is still in the future (`cancel_cult_commons_rate` sets cancelled_at/cancelled_by; cancelled rows are ignored by `private.cult_commons_rate_at`); every line snapshots the rate in force when it is added, so history never changes. The base 0.30 row (effective 1970-01-01) ships in the migration, not the seed. | Phase 3 | Accepted: build default, not individually confirmed by the owner | [ADR-004](decisions/ADR-004-cult-commons.md) |
| D22 | Assignments | Any active staff member may assign or unassign anyone on a job that is not collected or cancelled; making someone lead removes the previous lead from the job (not demoted to additional); only active staff can be assigned. | Phase 3 | Accepted: build default, not individually confirmed by the owner | [ADR-008](decisions/ADR-008-work-order-lifecycle.md) |
| D23 | NEG-CONSUMPTION: can a job part take stock below zero? | Yes: adding a quantity part to a job may take a location's ledger on-hand below zero, because the part was physically used; the UI warns. Negative balances show in `reporting.low_stock` and `reporting.product_stock.negative_locations` regardless of reorder_point. Manual adjustments and transfers may never leave a location below zero (`insufficient_stock`). | Phase 4 | Accepted: build default, not individually confirmed by the owner | [ADR-010](decisions/ADR-010-stock-and-units-on-jobs.md) |
| D24 | PART-PRICE-COST: a part with no known price or cost | A part can be added to a job only when its sale price (default `private.selling_price`: the unit price, else the product default; any staff may override it, as D14 allows for every line) and its direct cost (the unit cost, else the product default; never overridden) are known. Missing values raise `part_price_missing` or `part_cost_missing`, because a silent zero cost would overstate yield and Cult Commons (SPEC §10). Inventory lines are therefore never `cost_pending` (D14's `cost_pending` is for manual lines only). | Phase 4 | Amended by the owner 2026-10-05: 0 is a known price or cost; only NULL counts as missing. The code already behaves this way; no test proves it yet (RISKS R-006) | [ADR-010](decisions/ADR-010-stock-and-units-on-jobs.md) |
| D25 | SOLD-AT-COMPLETION (refines D6): when a unit on a job is sold | A unit on a job is `held_for_customer` on add and becomes `sold` whenever `work_orders.completed_at` goes from null to set, including re-completion after a reopen (trigger `work_orders_sell_held_units`, AFTER UPDATE WHEN completed_at changes). On reopen (completed_at cleared) every unit on the job's non-voided inventory lines goes sold -> held_for_customer, with inventory_unit_events and no stock movement; the product's publication stays 'sold' until the line is voided (`private.refresh_unique_publication` then restores public) or the job completes again. `add_inventory_line` and `void_line` refuse on a job that is not open (D15, `work_order_locked`); to return a part from a completed job, reopen it, then void the line. Both lock the work order FOR UPDATE through `private.lock_work_order`, so completion, reopen and cancellation cannot race an add or a void. Cancelling a job with parts follows D16. | Phase 4 | Accepted: build default, not individually confirmed by the owner | [ADR-010](decisions/ADR-010-stock-and-units-on-jobs.md) |
| D26 | PUBLICATION-MACHINE: publication states | Transitions draft -> internal_only, archived; internal_only -> public, archived; public -> internal_only, sold, archived; sold -> public, archived; archived -> internal_only. 'sold' is set only by sale paths (job completion now; Phases 6 and 10 later), never manually, and only for unique products; leaving 'sold' manually is allowed only to archived. sold -> public is a system restore by `refresh_unique_publication` that skips the requirements, so a void is never blocked. Any other entry into public requires a name, a selling price (`private.selling_price`), at least one public photo (product, unit or linked bike) and, for unique products, an available unit; the products trigger enforces this for every writer. `public_slug` is assigned at first publish (name slug + short ID, with an 'item' fallback) and never changes. low_stock means on_hand <= reorder_point, or any negative stock. | Phase 4 | Accepted: build default, not individually confirmed by the owner | [ADR-010](decisions/ADR-010-stock-and-units-on-jobs.md) |
| D27 | SHOP-OWNED-ONLY: whose stock can be a job part | Whose stock can be a job part: consignment stock may be a job part; customer_owned never (`ownership_not_saleable`); consigned units are created only by `create_consignment_item` | Phase 4 | Changed by the owner 2026-10-05; implemented in Phase 6 (D44) | [ADR-010](decisions/ADR-010-stock-and-units-on-jobs.md), [ADR-016](decisions/ADR-016-consignment-and-sales.md) |
| D28 | SPLIT-COST: turning one counted item into a unique item | One RPC, `split_unit_from_stock` (Phase 4 step 2). It decrements the source by one (a `stock_adjustment` with a reason) and creates a new draft unique product and unit at the same location; the new unit's direct cost is the source's `default_direct_cost`. | Phase 4 | Accepted: build default, not individually confirmed by the owner | [ADR-010](decisions/ADR-010-stock-and-units-on-jobs.md) |
| D29 | BIKE-WITH-CUSTOMER: a sold shop bike after it reached its buyer | Once `transfer_bike_ownership` has given a sold unit's bike to a customer, the unit never goes back into stock while the bike has a customer. Reopening the job that sold it is refused with `bike_with_customer` (the reopen would hold the unit again, clear `sold_at` and let a void make a customer's bike available and public); `void_line` refuses the same state, and `private.assert_unit_consistent` fails an available, reserved or held_for_customer unit whose bike has a customer. Safe default: to correct that job, transfer the bike back to the shop (with a reason), reopen, correct, complete, transfer again. `reporting.public_items` cuts a unit's bike photos at the earlier of `sold_at` and the bike's first transfer to a customer after the unit was registered. | Phase 4 | Owner-confirmed 2026-10-05 ("confirmed, revisit later"; no revisit trigger set) | [ADR-010](decisions/ADR-010-stock-and-units-on-jobs.md) |
| D30 | FIN-ACCESS: who sees financial reports | Financial report ROWS (`financial_lines`, the money columns of `daily_summary` / `today_dashboard`, Today's Money section) need `view_financial_reports` (`financial_lines` raises 42501 without it). Every cost-derived figure in them also needs `view_costs`; without it the figure comes back NULL and the UI says it is hidden: COGS, unit cost, yield, Cult Commons share and rate, BICII yield after CC, losses and loss counts, value at cost and (Phase 6) consignor liability. The job-level yield panel (P3's totals summary on the job page, `work_order_yield`) needs `view_costs` only (job costing, SPEC §4.2/§22). Operational counts (jobs, parts used, adjustments and whether one is significant, low stock, exceptions) are visible to all active staff. Adopted by every later phase (P6 sales/consignment, P9 reports). | Phase 5 | Accepted: build default, not individually confirmed by the owner | [ADR-011](decisions/ADR-011-recognition-and-financial-reporting.md) |
| D31 | TODAY-TILES: Today's job tiles | Checked in, started, completed, ready for collection, collected and cancelled are FLOWS: the jobs whose CURRENT stamp falls on that shop day (a reopened job leaves its earlier Completed/Ready flow until it is completed again, D15). Received (received + diagnosing), waiting (awaiting_customer + awaiting_parts + paused), ready to start, in progress, awaiting collection (completed + ready_for_collection) and overdue (D20) are the CURRENT SNAPSHOT, from status, returned only for today and grouped as P3's `BOARD_GROUPS`; past-day snapshots would need status replay (Phase 9 may add it). | Phase 5 | Accepted: build default, not individually confirmed by the owner | [ADR-011](decisions/ADR-011-recognition-and-financial-reporting.md) |
| D32 | RECOGNITION: workshop revenue recognition (refines D3 as modified by D15; **owner to confirm, with D15**) | A workshop line is recognised when it is not voided and its job has a `completed_at`, on the shop day of the job's CURRENT `work_orders.completed_at`: completed, ready-for-collection and collected jobs count, open and cancelled jobs never do. Phase 3 freezes a job's lines once it is completed (no add, no void), so the only correction is a reopen: it removes the whole job from its earlier completion day until it is completed again, when its then-current live lines are recognised on the new completion day. Past days CAN change after a reopen; there are no reversal entries for workshop lines. Each entry's Cult Commons share is the line's own share (≥ 0), so a day's and a job's Cult Commons are always ≥ 0 and no negative Cult Commons payment arises (SPEC §10); gross sales ≥ 0 (D14 forbids negative prices); `loss_total` ≤ 0. Lines with `cost_pending` (D14) are recognised as stored (cost 0) and FLAGGED, never excluded or estimated (`financial_lines.cost_pending`, `today_dashboard.cost_pending_lines`, `work_order_yield.cost_pending_count`), so the UI can label the figures provisional (D14's safe default). Phase 9 reports restate earlier periods the same way. | Phase 5 | Owner-confirmed 2026-10-05, with D15 | [ADR-011](decisions/ADR-011-recognition-and-financial-reporting.md) |
| D33 | SIGNIFICANT-ADJ: significant stock adjustment | A `stock_adjustment` or `damaged` movement is significant when \|quantity_delta\| ≥ 5, or it is on a unique unit, or \|quantity_delta\| × unit cost ≥ 100.00 SGD; unit cost = `unit_cost_snapshot`, else `products.default_direct_cost`, else 0. One function, `private.is_significant_adjustment`, holds the rule; Phase 9 or shop settings may replace it. The flag is shown to all staff (it reveals only that a value reached the threshold, never the value); the value at cost needs `view_costs`. | Phase 5 | Accepted: build default, not individually confirmed by the owner | [ADR-011](decisions/ADR-011-recognition-and-financial-reporting.md) |
| D34 | EXCEPTIONS: operational exception rules (the Phase 5 set) | `overdue_job`: exactly D20 (`private.work_order_status_is_open(status)` and `now() - checked_in_at > interval '7 days'`, 7 = `OVERDUE_AFTER_DAYS`; exactly 7 × 24 h is not yet overdue). `uncollected_job`: status completed or ready_for_collection and completed ≥ 7 shop days ago. `negative_stock`: any product/location with on-hand < 0. `unit_hold_stale`: a `held_for_customer` unit with no non-voided inventory line on an OPEN job referencing it (D6/D25). `currency_mismatch`: a line that would be recognised but whose currency is not the shop currency; such entries are excluded from totals. Kinds are text; Phases 6, 9 and 10 add kinds (unit_state_mismatch, unsettled_consignment, integration_failed) by create or replace of the view, keeping these columns first. | Phase 5 | Accepted: build default, not individually confirmed by the owner; extended by Phase 9 (D106–D108): unit_state_mismatch, unsettled_consignment, integration_failed; currency_mismatch covers sale lines | [ADR-011](decisions/ADR-011-recognition-and-financial-reporting.md) |
| D35 | SHOP-TZ: shop time zone and currency before Phase 2 | `private.shop_timezone()` returns 'Asia/Singapore' and `private.shop_currency()` returns 'SGD'; Phase 2 replaces both bodies (create or replace, same signatures) to read `shop_settings` (timezone, default_currency) with those fallbacks, and Phases 7 and 9 call these functions and create no alternatives. Every shop-day computation in SQL goes through `private.shop_day()` / `private.shop_today()` / `private.shop_day_start()`: never `current_date`, never `ts::date` without `at time zone`; the app lets the database decide which day is today. Totals sum the shop currency only. | Phase 5 | Accepted: build default, not individually confirmed by the owner | [ADR-012](decisions/ADR-012-shop-time-zone-and-currency.md) |
| D36 | APPT-COMPLETION: when an appointment is completed | An appointment becomes `completed` automatically when its linked work order first reaches completed, ready_for_collection or collected (a trigger on `work_orders`, Phase 2 step 2); staff never mark `completed` by hand (`mark_appointment_status` refuses it); reopening the job does not reopen the appointment; a cancelled job leaves the appointment `checked_in`. | Phase 2 | Accepted: build default, not individually confirmed by the owner | [ADR-013](decisions/ADR-013-appointments.md) |
| D37 | APPT-SELF-BOOKING: customer booking and cancelling rules (final; Phase 11 references this row and defines no booking or cancel rules of its own) | Customers book only active AND public types; `starts_at >= now() + booking_min_notice_minutes` (default 120); `starts_at <= now() + booking_horizon_days` (default 60); at most `customer_max_active_bookings` (default 3) upcoming (`starts_at > now()`) booked/confirmed appointments with `source = 'customer'` per customer, enforced under a per-customer advisory lock (staff-made bookings never count). A customer may cancel their own booked/confirmed appointment (whoever booked it) until `customer_cancel_cutoff_minutes` (default 120) before its start; after that they contact the shop. `appointments.cancelled_via` records whether staff or the customer cancelled. Staff bookings are exempt from notice, horizon, limit, the public flag and the cutoff, never from hours, closures or capacity, and cannot book an appointment that has already ended (`appointment_in_past`); staff may cancel any booked/confirmed/arrived appointment at any time with a reason. Available slots are readable anonymously (no sign-in needed to see times). | Phase 2 | Accepted: build default, not individually confirmed by the owner | [ADR-013](decisions/ADR-013-appointments.md) |
| D38 | APPT-GRID: the slot grid and what settings changes do | Capacity windows are aligned to shop-local midnight in steps of `intake_slot_minutes`; a booking starts on the grid; the whole `[starts_at, ends_at)` lies inside one continuous open stretch of one shop-local date; a `custom_hours` override replaces ALL weekly intervals on each date it covers; a `closed` override blocks any overlapping appointment and beats custom hours. Settings changes (hours, closures, slot length, capacity, type duration/units) never move, shrink or cancel existing appointments (appointments snapshot `ends_at` and `capacity_units`; screens flag the affected ones). | Phase 2 | Accepted: build default, not individually confirmed by the owner | [ADR-013](decisions/ADR-013-appointments.md) |
| D39 | APPT-LATE-ARRIVAL: the status machine's edges | `no_show -> arrived` is allowed only on the appointment's own shop-local date and re-checks capacity; cancelled and completed are final (rebook instead); `arrived -> cancelled` is allowed with a reason (left before check-in); `no_show` only once `starts_at` has passed (`appointment_not_started`). | Phase 2 | Accepted: build default, not individually confirmed by the owner | [ADR-013](decisions/ADR-013-appointments.md) |
| D40 | APPT-CHECK-IN: what check-in needs and does | Check-in needs a bike owned by the appointment's customer (transfer it first otherwise; shop bikes refused); it either creates a new work order (through Phase 3's `private.create_work_order`) or links one existing OPEN work order (`private.work_order_status_is_open`, i.e. before completed) of the same customer and bike that has no appointment; `work_orders.appointment_id` goes null -> value once and never changes afterwards. Built in Phase 2 step 2. | Phase 2 | Accepted: build default, not individually confirmed by the owner | [ADR-013](decisions/ADR-013-appointments.md) |
| D41 | APPT-COUNTS: how Today and reports count appointments | Today and report counts of appointments, arrivals and no-shows are by the appointment's scheduled shop-local date and its CURRENT status (not by when staff tapped): `appointments_scheduled` = non-cancelled appointments starting that shop day; `appointments_arrived` = of those, currently arrived/checked_in/completed; `appointments_no_show` = of those, currently no_show. The basis of `daily_summary`'s appointment columns (Phase 2 step 2) and of Phase 9's activity report. Operational counts: every active staff member sees them (D30). | Phase 2 | Accepted: build default, not individually confirmed by the owner | [ADR-013](decisions/ADR-013-appointments.md) |
| D42 | APPT-CUSTOMER-FIELDS: what customers see of their appointments (extends D8) | Type name, times, status, their bike (short ID + brand/model) only while it is still theirs and not archived (D12), their own note, `cancelled_at`, `cancelled_via` (a channel, never a person) and whether they may cancel online (`can_cancel`). Never `internal_note`, `cancellation_reason`, capacity units, source or who acted (D8). One projection (`public.my_appointment`) serves `my_appointments`, `book_my_appointment` and `cancel_my_appointment`. | Phase 2 | Accepted: build default, not individually confirmed by the owner | [ADR-006](decisions/ADR-006-customer-and-public-visibility.md) |
| D43 | DOCS-STACK: documentation standard | Follow Vibe Code Docs Stack v0.2.0 (owner directive 2026-10-05) keeping the existing document names: one canonical home per responsibility (README, NOW, AGENTS, docs/PRODUCT, SPEC as the historical requirement, PLAN with this index, ADR-001 at its path, docs/ARCHITECTURE, docs/decisions/, DATA-MODEL as the DATA document, TESTING, DESIGN, docs/ENGINEERING, docs/OPERATIONS with RUNBOOK for procedures, docs/RISKS, docs/USER-GUIDE). New main-line rows take D43–D59; D60 and up belong to the purchasing track. No issue tracker: the backlog is the §2 phases plus the RISKS next actions, and NOW names the next action. | Docs retrofit (after Phase 2) | Accepted (owner directive 2026-10-05) | [ADR-015](decisions/ADR-015-documentation-stack.md) |
| D44 | CONS-JOB-PART: how consigned stock is used as a job part (implements the owner's D27 change) | `add_inventory_line` keeps its signature and now accepts consignment stock; customer_owned stays refused with `ownership_not_saleable`. A consigned unit's line snapshots `unit_direct_cost` = the item's `agreed_amount_owed` + its non-voided shop-borne charges (D4); a consigned quantity line snapshots the item's `agreed_amount_owed` (shop charges exist only on unique items, D45). The line also stores `consignment_item_id` and `consignor_payout_snapshot` = the agreed amount per unit. A quantity part draws from exactly one item, chosen FIFO (the oldest active item of the product by `received_at`, then `short_id`, whose remaining quantity covers the part; none → `consignment_quantity_unavailable`); its default price is that item's asking price, else the product default, and any staff member may override it (D14). Consigned stock never goes below zero (`insufficient_stock`): D23 does not apply, because on-hand must equal the consignors' remaining quantity (D50). The unit is held on add and sold at completion (D6/D25). The item counts as sold, and the consignor liability (quantity × payout snapshot) exists, exactly while the line is live and its job has a `completed_at`: a reopen removes both until the job is completed again; a void (open job) returns the stock through Phase 4's linked reversal. Liability is derived, never stored, so a replay or a repeated completion never creates a second liability. A consigned part is returned by reopen + void, never by `restock_unit` (which needs a sale line; D6 interplay). Alternative considered: keep refusing consigned parts and record them as retail sales (the default before the owner's change). | Phase 6 | Accepted: build default, owner to confirm; implemented by Phase 6 | [ADR-016](decisions/ADR-016-consignment-and-sales.md) |
| D45 | CONS-QTY-FIFO: quantity consignment and the single selling price | Consigned quantity stock lives on dedicated consignment-owned products: a product is never mixed shop-owned and consigned, and its `ownership_type` cannot change once it has a unit or a movement. `remaining = quantity − (sold on live sale lines − restocked) − quantity on live job lines − returned`. Each sale line draws from exactly one item: the one named, else FIFO as in D44; a line is priced at its own item's asking price unless overridden, so two consignors' items on one product each sell at their own price. `private.selling_price` stays the single selling price (public page, labels, Shopify, sale and part defaults): for a consigned unit, its item's asking price; for a consigned quantity product, the asking price of the FIFO-head item (the oldest active item with remaining > 0), else the product default; a line drawn from a later item sells at that item's asking price. Shop-borne charges are allowed only on unique items, and only while the unit is available (its cost is snapshotted when it goes on a job or a sale). | Phase 6 | Accepted: build default, owner to confirm; implemented by Phase 6 | [ADR-016](decisions/ADR-016-consignment-and-sales.md) |
| D46 | CONS-RESTOCK: liability, restock and overpayment | Liability = Σ quantity × `consignor_payout_snapshot` over live, non-restocked consigned sale lines plus live consigned job lines of completed jobs; owed = liability − non-voided consignor charges; paid = Σ settlement allocations of settlements that are not reversed; outstanding = owed − paid. Nothing stores owed, paid or outstanding. `restock_unit` reverses a sale line's liability; for a consigned unit it needs `manage_consignments` as well as `adjust_stock`. A unit may be sold again only after `restock_unit` marks its previous line restocked: at most one live (non-restocked) sale line per unit, a partial unique index that replaces DATA-MODEL §8's plain `unique` (a recorded deviation). A unit sold through a job is not restocked (D44). Restock refuses a unit whose bike a customer now owns (`bike_with_customer`, D29). Money already paid stays paid, so outstanding can go negative: it is shown as "Overpaid $x (consignor owes the shop)", never "credit", and is cleared only by a later sale, by voiding a consignor charge or by reversing a settlement, never recovered automatically. A refund alone does not change the liability (D7). | Phase 6 | Accepted: build default, owner to confirm; implemented by Phase 6 | [ADR-016](decisions/ADR-016-consignment-and-sales.md) |
| D47 | SETTLEMENT-RULES | A settlement's amount equals the sum of its allocations (each > 0, one per item, all items of that consignor). An allocation may exceed the item's current `max(outstanding, 0)` only with an override reason; every caller holds `manage_consignments`. Mistakes are corrected by reversing the whole settlement with a reason (`consignment_settlement_reversals`), never by editing or deleting it. A consignor can be archived only with no active item (`consignor_has_open_items`) and an outstanding of exactly 0 (`consignor_has_balance`; the detail names the remedies of D46). | Phase 6 | Accepted: build default, owner to confirm; implemented by Phase 6 | [ADR-016](decisions/ADR-016-consignment-and-sales.md) |
| D48 | SALES-ACCESS (follows D30) | Any active staff member may record an in-store sale and see sale headers, lines, quantities, prices and sale totals. Sale cost, yield, Cult Commons, rate and payout snapshots need `view_costs` (`private.can_view_sale_costs()`). Consignment money (agreed amount owed, charges, item events, liability, ledger, settlements, a job line's payout snapshot) needs `manage_consignments` or `view_costs` (`private.can_view_consignment_money()`). `view_financial_reports` alone reveals neither. Payout details (bank, PayNow) need `manage_consignments` only. It revises these DATA-MODEL §15 rows: `sales, sale_lines, sale_refunds` (was P(view_financial_reports) or P(view_costs) per row; now rows to all staff with the cost columns gated by `view_costs`); `consignors, consignment_items, charges` (charges and the new events table are row-gated by the money helper); `consignment_settlements, settlement_lines` (was P(manage_consignments); now readable with `manage_consignments` or `view_costs`, written with `manage_consignments`). | Phase 6 | Accepted: build default, owner to confirm; implemented by Phase 6 | [ADR-016](decisions/ADR-016-consignment-and-sales.md) |
| D49 | RETAIL-REFUND | Retail refunds are recorded by admins only (`view_financial_reports` is a read permission and does not authorise money going out), capped at the sale total minus earlier refunds, and financial only (D7). Phase 6 reports every sale line at its snapshot and nets neither refunds nor restocks out of `reporting.financial_lines` or `daily_summary`; refunds and restocks show on the sale, the Sales list and the consignor ledger. Refund netting and Cult Commons claw-back are decided by Phase 9's refund-reporting row (working name DR5), the single PLAN row for retail and online refunds; Phase 6 adds no separate row or open question for them. | Phase 6 | Accepted: build default, owner to confirm; implemented by Phase 6. Amended by D94: admins and managers. Refund reporting decided by D102 (Phase 9 build default) | [ADR-016](decisions/ADR-016-consignment-and-sales.md), [ADR-021](decisions/ADR-021-staff-roles.md) |
| D50 | CONS-STOCK-MOVES | Stock of a consignment-owned product moves only through intake (`consignment_received`), return to the consignor (`consignment_returned`), sale (`retail_sale` / `online_sale` with a sale line), restock (`return` with a sale line), job consumption (D44) and the reversal that voiding it writes, and transfers (and the reversal of a transfer). `adjust_stock` (adjustment, damaged), write-off, `create_unique_unit`, `split_unit_from_stock` and purchase receipts are refused (`consignment_stock_adjust_blocked`; a write-off also raises `consignment_unit_write_off_blocked`), so on-hand of a consigned product always equals the consignors' remaining quantity. Damaged or lost consigned stock and customer returns of consigned quantity lines are out of MVP: staff return the item to the consignor or sell it. | Phase 6 | Accepted: build default, owner to confirm; implemented by Phase 6 | [ADR-016](decisions/ADR-016-consignment-and-sales.md) |
| D51 | CONS-BIKE-LINK | A consigned complete bike keeps its bike record. Intake of a unique item may link an existing bike under Phase 4's rules for stock bikes: not archived (`bike_archived`), no owner (`bike_has_owner`), not already a unit (`bike_already_linked`). A bike registered to the consignor's customer record is first transferred to the shop with `transfer_bike_ownership` and a reason (for example "Consigned by Daniel Ong"), because a unit whose bike a customer owns cannot be in stock (D29). Unit and bike are linked both ways (`private.register_unit`). Ownership is not transferred on sale: staff transfer it to the buyer, as for a sold shop bike. On return to the consignor the link stays (as for any unit that left stock) and staff transfer the bike back to the consignor's customer record; that bike record cannot be consigned a second time (`bike_already_linked`), a known limitation recorded in RISKS. | Phase 6 | Accepted: build default, owner to confirm; implemented by Phase 6 | [ADR-016](decisions/ADR-016-consignment-and-sales.md) |
| D52 | CONS-PHOTOS-INTERNAL (the D13/D19 pattern) | Photos on a consignment item (`entity_type = 'consignment_item'`: the signed agreement, ID or condition notes showing terms and amounts) are internal only: trigger `attachments_consignment_item_internal_only` raises P0001 `attachment_consignment_internal_only` for `customer` or `public`, and a CHECK of the same name is the backstop. Listing photos belong to the product or unit and may be public (D26). | Phase 6 | Accepted: build default, owner to confirm; implemented by Phase 6 | [ADR-016](decisions/ADR-016-consignment-and-sales.md) |
| D53 | PRICE-OVERRIDE | Any active staff member may change a sale line's price (as D14 allows for job lines), with no database floor. The sale sheet warns "Below the asking price" when the price is under the database selling price and, for `view_costs` users, "Below cost: this sale loses money". Open question for the owner: should a price below the agreed amount plus shop charges on a consigned item need `manage_consignments`? | Phase 6 | Accepted: build default, owner to confirm; implemented by Phase 6 | [ADR-016](decisions/ADR-016-consignment-and-sales.md) |
| D54 | CONS-ITEM-LOCATION: where each consignor's quantity stock is | Every movement of a consignment-owned product names its consignment item (a unit's movement takes its unit's item; `movement_invalid` otherwise), so `private.consignment_item_on_hand(item, location)` derives each item's stock per location, and at every location the items' on-hand sums to the product's. A sale or a job part with no item named draws FIFO (D44, D45) only among the items that have the whole quantity at that location; a named item must have it there (`consignment_quantity_unavailable`). A return gives back only that item's stock at that location (by default all of it). `transfer_stock` keeps its signature; a transfer of consigned quantity stock moves one item's stock, the oldest active item with the whole quantity at the source location (`consignment_quantity_unavailable`: move one consignor's stock at a time); staff cannot pick which consignor's stock moves (a recorded limitation). `saleable_stock` offers each item only where it has stock. Found by the Phase 6 review: without it, a sale at one location could be charged to a consignor whose stock was at another, putting the liability on the wrong consignor. Alternative considered: one location per consigned quantity item (transfers refused). | Phase 6 | Accepted: build default, owner to confirm; implemented by Phase 6 (review fixes) | [ADR-016](decisions/ADR-016-consignment-and-sales.md) |
| D55 | SALE-DATE: how far back an in-store sale may be dated | Any active staff member may date a sale in the past ("Sold earlier?"), never more than 5 minutes ahead (`sale_recognized_in_future`) and never before its stock was with the shop: a consigned item's `received_at`, a unit's latest restock (`sale_before_stock`, in `private.sell_line`, so Phase 10's online sales follow it too). Shop-owned stock has no other lower bound, because its registration date is when it was entered, not when it arrived. A backdated sale is recognised on its own shop day and takes the Cult Commons rate in force then (D21, D32). There is no period lock (none exists in the brief), so a backdated sale changes a past day's figures. Open question for the owner: should backdating beyond a window (for example 7 days) need a permission such as `view_financial_reports` or admin? | Phase 6 | Accepted: build default, owner to confirm; open question below; implemented by Phase 6 (review fixes) | [ADR-016](decisions/ADR-016-consignment-and-sales.md), [RISKS R-027](RISKS.md#r-027--a-sale-can-be-backdated-without-limit-by-any-staff-member) |
| D56 | LABEL-QUANTITY: label quantity per print job | One job prints 1–500 labels of a quantity-tracked product, or 1–10 of a unit or bike (default 1). A per-job cap, not a limit on labels (SPEC §31 "arbitrary quantity"): more labels = another job, and the sheet says how many remain (`label_quantity_out_of_range`). | Phase 8 | Accepted: build default, not individually confirmed by the owner | [ADR-017](decisions/ADR-017-labels-and-qr-base.md) |
| D57 | UNIQUE-LABELS: labels for unique items | Unique-tracked products are labelled per unit (U-); `reporting.public_items` exposes published units as their own U- rows, so a U- label resolves publicly once published; a P- label for a unique product is refused (`label_unique_product_needs_unit`); a unit linked to a bike shows the bike's size/colour as an identity line and keeps its U- QR; a bike tag (B-) may be printed for any non-archived bike and resolves to "not found" publicly. | Phase 8 | Accepted: build default, not individually confirmed by the owner | [ADR-017](decisions/ADR-017-labels-and-qr-base.md) |
| D58 | LABEL-PRICE: the price on a label | Exactly `private.selling_price(product_id, inventory_unit_id)`, the single function `reporting.public_items`, the in-store sale default (`private.sell_line`), `add_inventory_line` and later Shopify use (latest definition `20261004003300_consignment.sql`: consigned unit, the item's asking price, else the unit price, else the product default; consigned quantity product, the FIFO item's asking price; shop stock, the unit price, else the product default); never reproduced inline. NULL → no price line (never "$0.00" for a missing price); 0 → "0.00" (D24 as amended: 0 is a known price). The printed price is a snapshot; record pages warn when the current price differs from the last printed label's. | Phase 8 | Accepted: build default, not individually confirmed by the owner | [ADR-017](decisions/ADR-017-labels-and-qr-base.md) |
| D59 | PRINT-CONFIRMED: when a print counts as printed | Browsers cannot report printer success, so staff confirm each job as printed, or failed with a reason; unconfirmed jobs stay `rendered` and are listed under "To confirm". Only open jobs (queued/rendered) can be rendered for printing (print view, PDF route); printed and failed jobs are history, and "Print again" always creates a new job linked by `reprint_of_id` from the record page with a fresh preview. D59 is the last main-line number ([RISKS R-028](RISKS.md#r-028--the-main-line-decision-range-d43d59-is-exhausted)). | Phase 8 | Accepted: build default, not individually confirmed by the owner | [ADR-017](decisions/ADR-017-labels-and-qr-base.md) |
| D60 | D-PO-COSTS: who sees purchase costs | Purchase costs (PO line unit costs and totals, receipt actual costs and totals, supplier last costs, cost defaults and PO history) are visible to staff holding `view_costs` OR `manage_purchasing` (`private.can_view_purchase_costs()`). A buyer must see costs to order and receive; because by D5 a receipt's actual cost becomes the product's cost, `manage_purchasing` therefore implies seeing purchase and product unit costs ON PURCHASING SURFACES, and only for products a PO can hold (D62: quantity-tracked, shop-owned, active, not archived) — `purchase_cost_defaults` omits any other id, so a unique bike's or a consigned item's cost never reaches a buyer without `view_costs`. It does not reveal yield, margins or Cult Commons figures, and it does not open the Phase 3/4/5 cost surfaces (`products.default_direct_cost`, `product_costs`, `inventory_unit_costs`, `inventory_movement_costs` and `inventory_movements.unit_cost_snapshot`, `services_staff`, `work_order_line_items_staff`, `work_order_totals_staff`, `work_order_yield`, `financial_lines` and the money in `daily_summary` / `today_dashboard`), which stay `view_costs` / `view_financial_reports` only. The product page (a Phase 4 screen) is not a purchasing surface: its "Suppliers & orders" card shows each supplier's last cost to `view_costs` holders only. Other active staff see suppliers, PO quantities, statuses and dates only. Every supplier/PO write and receiving require `manage_purchasing`. | Phase 7 | Accepted: build default, owner informed, no objection; implemented by Phase 7. Until the staff roles it covered every non-admin holding `manage_purchasing`. Since D90-D94 managers see costs through their role; D60's purchasing-screens-only cost visibility applies only to a person granted manage_purchasing as an exception, i.e. a mechanic | [ADR-018](decisions/ADR-018-purchasing.md), [ADR-021](decisions/ADR-021-staff-roles.md) |
| D61 | D-PO-CANCEL: cancelling a purchase order | A PO may be cancelled from draft, submitted or partially_received with a mandatory reason (≤ 500 characters). Stock already received, its receipts and its movements stay. The unreceived remainder is reported as cancelled, not outstanding. A received PO cannot be cancelled. Cancelled is final: there is no reopen. | Phase 7 | Accepted: build default, owner to confirm; implemented by Phase 7 | [ADR-018](decisions/ADR-018-purchasing.md) |
| D62 | D-PO-SCOPE: what a purchase order orders | A PO orders quantity-tracked, shop-owned products only, with at most one line per product per PO. A PO's currency is the shop currency (`private.shop_currency()`, D35) at creation; its lines and receipts are in the PO's currency, which must equal the product's currency. Unique items bought from a supplier are registered with Phase 4's `create_unique_unit` and their cost; a unique-unit purchase flow is future work. | Phase 7 | Accepted: build default, owner to confirm; implemented by Phase 7 (consignment-owned products refused, checked against Phase 6 at the integration) | [ADR-018](decisions/ADR-018-purchasing.md) |
| D63 | D-LASTCOST: which receipt sets the last cost (refines D5) | 'Latest' means latest by receipt `received_at`. A receipt changes `products.default_direct_cost` only when no receipt line for that product belongs to another receipt with a later `received_at` (equal `received_at`: the receipt recorded later, by `created_at` then id, wins); within one receipt the highest `line_number` per product wins. `supplier_products.last_unit_cost` follows the same rule restricted to receipts on that supplier's POs; `last_received_at` = greatest(existing, `received_at`); receiving upserts the supplier link. An actual cost of 0 (free goods) is a KNOWN cost (D24 as amended by the owner on 2026-10-05: only NULL is missing) and becomes the last cost like any other value; receipt line costs are never NULL (an omitted cost is the PO line's cost). A product cost change records Phase 4's `cost_changed` product event with the reason 'Received on PO-000034 (delivery note DN-5531)'. Nothing else changes: no snapshot (`work_order_line_items`, `inventory_movements`) is ever touched. | Phase 7 | Accepted: build default, owner to confirm (refines D5; 0 is a known cost per D24 as amended); implemented by Phase 7 | [ADR-018](decisions/ADR-018-purchasing.md) |
| D64 | D-RECEIPT-TIME: when a delivery happened | `received_at` defaults to now; it may be back-dated up to 30 days (late paper delivery notes), never more than 5 minutes ahead, and never before the PO's `submitted_at`. Phase 4's `inventory_movements` has no effective-date column, so `purchase_received` movements keep record time in `created_at`, their reason records the delivery time in shop time ('PO-000034 received 25 Sep 2026 10:42', formatted with `private.shop_timezone()`), and purchasing reports and the last-cost order use `purchase_receipts.received_at`. The seed receives through the RPC, so its movements carry seed time while its receipts carry their back-dated `received_at`. | Phase 7 | Accepted: build default, owner to confirm; implemented by Phase 7 | [ADR-018](decisions/ADR-018-purchasing.md) |
| D65 | D-OVERRECEIPT: more than ordered, closed orders and corrections | Receiving more than is outstanding is refused (`purchase_over_receipt`). On an open PO (submitted or partially_received) staff accept extra units by first raising the line's `quantity_ordered`, recorded in PO history with an optional reason. A fully received PO is closed: it cannot be edited, reopened or received against; extra or late units are ordered and received on a new PO for the same supplier. Receipts are immutable; a wrong count is corrected with a reasoned Phase 4 stock adjustment (plus the PO line if the supplier will send more); a ledger-reversing reverse-receipt RPC is deferred. The idempotency key covers retries of one submission; against two staff recording the same delivery note the guard is soft and lives in the Receive screen (recent receipts listed; a matching delivery-note reference must be acknowledged); there is no database uniqueness on reference (free text, reused by suppliers for split deliveries). Ledger-level uniqueness per receipt line is Phase 4's index `inventory_movements_receipt_line_once`. | Phase 7 | Accepted: build default, owner to confirm; implemented by Phase 7 | [ADR-018](decisions/ADR-018-purchasing.md) |
| D66 | D-REORDER: suggested reorder quantities | Suggested quantity = max(2 × reorder_point − on_hand − on_order, 0) over Phase 4's `reporting.low_stock` products; on_order counts submitted and partially_received POs only, never drafts. A selected product whose suggestion is 0 is ordered at 1. A draft line's cost defaults to the supplier's last cost, else the product's cost (0 included), else 0. Staff edit quantities and costs on the draft before submitting. | Phase 7 | Accepted: build default, owner to confirm; implemented by Phase 7 | [ADR-018](decisions/ADR-018-purchasing.md) |
| D70 | STAFF-OTP: sign-in code rules | 6 digits, valid for 10 minutes (Auth `otp_expiry` 600 s in the devstack, in config.toml and on hosted projects). Each new code replaces the previous one, and a code works once. "Send a new code" unlocks 60 s after the last send (`RESEND_COOLDOWN_SECONDS`, matching the hosted per-address email interval). Wrong, expired, used and superseded codes all get one message. An unknown email gets exactly the same "Check your email" screen as a staff email, and no account is created (Auth's 422 `otp_disabled` is treated as sent), however often it is asked: Auth's per-address refusal (`over_email_send_rate_limit`: the per-address interval and the hourly email cap, which only an address with a login can reach) is also shown as sent, and the code sent earlier still works. Outages and the limits that do not depend on the address (Auth's per-IP `over_request_rate_limit`, a 429 without a code, the Admin's own limits, D72) say what they are ("Too many attempts. Wait a minute and try again."), with no field marked invalid. After a code is accepted, the Admin admits only active staff (`my_staff_profile`); anyone else is signed out at once and told "This email doesn't have access to BICII Admin. Ask an admin to invite or reactivate you." (a deactivated colleague is reactivated on their staff page; inviting an existing login fails). Residual risk, accepted for MVP: Auth's own `/otp` endpoint tells a direct API caller whether an address has a login ([R-037](RISKS.md#r-037--auths-otp-endpoint-reveals-whether-an-address-has-a-login)); the Admin's screens never show it. Local devstack rate limits are raised so E2E can sign in repeatedly; hosted limits are set per RUNBOOK. | OTP phase (2026-10-05) | Accepted: build default within the owner's D10 change, not individually confirmed by the owner | [ADR-019](decisions/ADR-019-staff-email-sign-in.md) |
| D71 | STAFF-DEACTIVATION: deactivation and live sessions | Deactivating someone (staff.active true -> false, through `set_staff_active` or any other writer) deletes their Supabase Auth sessions in the same transaction (trigger `staff_revoke_sessions` -> `private.revoke_auth_sessions_on_deactivation()`; refresh tokens cascade), so no device can refresh. Where JWTs are verified without asking Auth (hosted asymmetric keys), an access token already issued stays valid until it expires (at most `jwt_expiry`, 1 h). For that window every page, action and RPC refuses it because the person is inactive (requireStaff -> 403, RLS and RPC guards; tested by `tests/unit/session-guard.test.ts` and by an E2E that keeps the session alive past deactivation). On the local devstack (HS256, getClaims asks Auth), the session ends at once (`session_not_found`). A deactivated person can still be emailed a code, because Auth does not know about staff, but the Admin signs them out straight after verification (D70). Reactivation restores access at their next sign-in. The migration refuses to apply where its role cannot delete from `auth.sessions` (RUNBOOK). The hosted window is [R-039](RISKS.md#r-039--hosted-email-delivery-and-auth-settings-are-unverified). | OTP phase (2026-10-05) | Accepted: build default, not individually confirmed by the owner | [ADR-019](decisions/ADR-019-staff-email-sign-in.md) |
| D72 | STAFF-SIGNIN-LIMITS: the Admin's own sign-in limits | The login Server Actions call Supabase Auth from the Admin's server, so Auth's per-IP limits (code requests and verifications per 5 minutes) count the server's address: one bucket for every staff member and every visitor, which one visitor posting bogus emails or wrong codes could keep full. So the Admin counts every code request and every verification itself, BEFORE asking Auth, per client address and per email, in fixed 5-minute windows: requests 10 per client and 5 per email, verifications 20 per client and 10 per email (`src/lib/auth/sign-in-limits.ts`; counters in Postgres, `public.note_sign_in_attempt`, service role only, DATA-MODEL §1). Past a limit the screen says "Too many attempts. Wait a minute and try again." alike for every email, with or without a login (D70). The client address is the first `x-forwarded-for` entry (Vercel sets it and overwrites what the client sent), IPv6 per /64. Counting failures say sign-in is unavailable. Hosted Auth's per-IP limits are then the shared ceiling and are sized well above these (RUNBOOK). Residual risk, accepted for MVP: a visitor who knows a staff email can keep its owner waiting, and many client addresses together can still fill Auth's shared per-IP limit ([R-038](RISKS.md#r-038--a-visitor-who-knows-a-staff-email-can-delay-its-sign-in)). Tests set `SIGN_IN_LIMIT_MULTIPLIER` (E2E: 1000). | OTP phase (2026-10-05) | Accepted: build default, not individually confirmed by the owner | [ADR-019](decisions/ADR-019-staff-email-sign-in.md) |
| D80 | SHOP-PRICE: the price and recognition of an online sale line | An online line's price is Shopify's line price × effective quantity minus that line's discount allocations, in shop money, split exactly so that the sale's Σ `sale_total` equals Shopify's discounted line totals: an uneven quantity line becomes two sale lines (qty−1 at trunc(total/qty, 2), `shopify_line_part` 1, and 1 absorbing the remainder, part 2); a unique product's units get one line each, the last absorbing the remainder (`private.shopify_split_amount`). A line total of 0 is a known price and is recorded (D24 as amended). Shipping, tips, duties and order-level adjustments are not sale lines; they stay in the stored payload. `recognized_at` = the order's `processed_at` (identical for every delivery), else X-Shopify-Triggered-At, else the event's `received_at`, never the processing time; the Cult Commons rate snapshot follows it. Tax per D89 | Phase 10 | Accepted: build default, owner to confirm | [ADR-020](decisions/ADR-020-shopify.md) |
| D81 | SHOP-UNIQUE: a unique product online | A unique product sells online as one Shopify variant. Its online quantity is the count of available, non-customer-owned, non-archived units at the online location; its price is `private.selling_price(product, oldest such unit)` (D58), so a consigned unit sells online at its asking price; sync refuses (needs attention) when another such unit has a different selling price. An online order sells the oldest available unit(s) at the online location | Phase 10 | Accepted: build default, owner to confirm | [ADR-020](decisions/ADR-020-shopify.md) |
| D82 | SHOP-STOCK: an online order BICII's ledger cannot fulfil | When no unit is available at the online location, on-hand there is below the ordered quantity (a sale never takes stock below zero; D23 is for job parts only), no single consignment covers a consigned quantity line there (D45/D54), a cost is missing (D24) or `private.sell_line` refuses anything else, nothing is recorded: the event goes to the queue as needs attention with a human-readable reason. Staff fix the stock and retry, or refund in Shopify and dismiss with a reason. A unit is never sold twice | Phase 10 | Accepted: build default, owner to confirm | [ADR-020](decisions/ADR-020-shopify.md) |
| D83 | SHOP-LOCATION: which stock is online | One configured BICII location (`shopify_settings.online_location_id`; the seed uses the Shop floor) mapped to one Shopify location. BICII pushes the absolute available quantity from its ledger and is the stock truth; it never overwrites Shopify's count while an online order is in flight (an orders/paid event received in the last 10 minutes that is pending, or failed with its job queued or running), pushes with Shopify's compare quantity = the last pushed quantity, and when Shopify's count moved waits one 2-minute deferral for the order webhook before overwriting | Phase 10 | Accepted: build default, owner to confirm | [ADR-020](decisions/ADR-020-shopify.md) |
| D84 | SHOP-PUBLISH: what Publish online needs and pushes (with the catalogue rules) | Publish online needs publication `public`, a selling price (`private.selling_price`; 0 is a price), not archived and not customer-owned. Only Shopify products BICII created (handle `bicii-<short id lower-cased>`, `shopify_origin` 'bicii') are pushed in full (title, vendor = brand or 'BICII', a plain-text description, the public photos, one variant; the pinned Admin API version is part of the sync hash) and drafted at quantity 0 when unpublished, keeping their IDs. A product linked by `link_shopify_variant` to a product made in Shopify (`shopify_origin` 'external') is never pushed until staff publish it, then only that variant's price and inventory level; it has no BICII handle and no Buy-online link. Several BICII products may link to variants of one Shopify product, so `products.shopify_product_id` is no longer unique (a DATA-MODEL §6 deviation); `shopify_variant_id` stays unique. `reporting.public_items.buy_online_url` = storefront URL + `/products/` + handle only when the row is available, published online, synced, with a handle and a storefront URL, and the row is what Shopify sells (review amendment, D81/D58): a unit row only for the unit an online order takes (the oldest available, non-customer-owned, non-archived unit at the online location), a product row only when its shown price is not distinct from `private.shopify_online_price`: the single Buy-online rule Phase 11 reads | Phase 10 | Accepted: build default, owner to confirm | [ADR-020](decisions/ADR-020-shopify.md) |
| D85 | SHOP-REFUND: what a Shopify refund records | One `sale_refunds` row and nothing else (D7): amount = the line-attributable refund (Σ refund line subtotals in shop money, or Σ successful refund transactions when there are no refund lines), never more than the money refunded, capped at the sale's remaining unrefunded total (D49's cap). Shipping and any excess stay in the event result, as do per-line details and Shopify's restock claims; `restocked` is written false. The sale becomes `refunded` when Σ refunds ≥ Σ sale_total, else `partially_refunded`, exactly as `record_sale_refund`. Reports exclude only voided sales and net no refunds (D49); stock, units, consignment items and lines never change (staff restock with `restock_unit`). Netting and Cult Commons claw-back are owner question 12 / R-021, for Phase 9's refund-reporting row (D100–D119); no row here. `orders/cancelled` is not subscribed | Phase 10 | Accepted: build default, owner to confirm | [ADR-020](decisions/ADR-020-shopify.md) |
| D86 | SHOP-ACCESS: who administers the integration (with customer linking) | The event inspector, the queue, dismissing, linking variants and customers, the Shopify settings and the integration rows of the operational exceptions are admin-only, because payloads hold customer personal data. `manage_inventory` may toggle Publish online, run Sync now and retry product-sync jobs (the app runs only the job id the RPC returned). Every active staff member sees a product's sync status. Shopify customers link to BICII customers only by an admin action with a reason (`link_shopify_customer`), never by email (a matching email is a candidate); a link applies to orders recorded after it, because a recorded sale is immutable: earlier online sales keep `customer_id` null and are shown linked through their `sales.shopify_customer_id` | Phase 10 | Accepted: build default, owner to confirm | [ADR-020](decisions/ADR-020-shopify.md) |
| D87 | SHOP-RETRY: retries | Transient failures retry automatically with exponential backoff (1 minute doubling, capped at 6 hours), at most 8 attempts, then needs attention. Business failures that need a person (unmapped variant, unavailable unit, insufficient stock, currency mismatch, tax basis, unreadable payload, a `sell_line` refusal) need attention at once. A refund waiting for its order is re-queued as soon as the order is recorded and closed when the order is dismissed. Recording an order closes its other open deliveries (another webhook id) as `duplicate_order`. A dismissal is final for that order or refund (review amendment): its other open deliveries close with it, and a later delivery of it under any webhook id is skipped (`earlier_delivery_skipped`), never recorded. A Vercel cron runs due jobs every 5 minutes behind `CRON_SECRET`, and each webhook runs a few due jobs after responding; a runner claims a job only while that job's worst case still ends inside the function's `maxDuration`. Vercel Hobby refuses to deploy a sub-daily cron, so the plan is chosen before the first deployment; the Hobby fallback (a daily schedule plus an external scheduler) is in the RUNBOOK | Phase 10 | Accepted: build default, owner to confirm | [ADR-020](decisions/ADR-020-shopify.md) |
| D88 | SHOP-REJECTED: rejected deliveries and retention | Rejected deliveries (bad or missing HMAC, secret or shop not configured, wrong shop, missing headers, non-JSON) are kept as evidence with capped headers (16 keys, 512 characters per value), body size and SHA-256 only, never the body; they never occupy the dedupe key, and one bad body is one row with a delivery count. Above 30 rejected deliveries per minute per server instance they are logged but not stored; bodies over 1 MiB are refused with 413 and not stored. Rejected events and the payloads of processed or skipped events are purged only by hand through the owner-only `private.purge_integration_events(older_than)` (at least 30 days); failed and pending events are never purged; no purge cron in the MVP | Phase 10 | Accepted: build default, owner to confirm | [ADR-020](decisions/ADR-020-shopify.md) |
| D89 | SHOP-TAX-TEST: tax basis, test orders and POS orders | Sale lines record Shopify's tax-inclusive price when the order has `taxes_included` true; an order with `taxes_included` false and tax > 0 is refused (`shopify_tax_basis_unsupported`, needs attention): BICII never silently adds or ignores tax. Test deliveries (payload `test` true or header X-Shopify-Test true) are stored but skipped (`test_order`) unless `shopify_settings.accept_test_orders` is true (default false, changed only by an admin with a reason and an audit row; true in the dev/E2E seed only). Orders whose `source_name` is 'pos' are skipped (`pos_order`) because in-store sales are recorded in BICII | Phase 10 | OPEN for the owner: tax basis and Shopify POS (owner questions 23 and 24); the rest accepted as a build default | [ADR-020](decisions/ADR-020-shopify.md) |
| D90 | STAFF-ROLES | Three roles admin \| manager \| mechanic (enum public.staff_role). The former value 'staff' is renamed to 'mechanic' with `alter type public.staff_role rename value 'staff' to 'mechanic'` (safe: nothing is hosted, R-001; the rename keeps the enum value's OID, so stored rows, the column default and create_staff's parameter default follow; no function body compares a staff_role with the literal 'staff'). 'manager' is added after 'admin' in the same enum migration and used only from the next migration (a new enum value cannot be used in the transaction that adds it; every migration runs in its own transaction). New staff default to mechanic. "Staff" keeps meaning any active person (private.is_staff()). staff_events payloads are append-only, so any written before the rename keep the text "staff"; the app labels it Mechanic. | Staff roles (2026-10-06): `20261006000100_staff_role_values` | Owner decision 2026-10-06; built | [ADR-021](decisions/ADR-021-staff-roles.md) |
| D91 | ROLE-PERMISSIONS | admin implies every permission; manager implies every permission except manage_staff (view_costs, manage_inventory, adjust_stock, manage_consignments, manage_purchasing, view_financial_reports); mechanic implies none. Effective permissions = what the role implies plus the person's staff_permissions rows; none while inactive. One SQL helper, private.role_implies(role public.staff_role, permission public.permission_key) returns boolean (immutable), used by private.has_permission and public.my_staff_profile, so every RLS policy, view and RPC that calls has_permission / require_permission / can_view_* follows; the app mirrors it in roleImplies() (src/lib/auth/permissions.ts) and a database test proves the two agree for every role x permission. Admin-only things stay admin-only through private.is_admin() / private.require_admin(): shop settings, hours, closures, appointment types, Cult Commons rates, roles, and admin or manager accounts. | Staff roles (2026-10-06): `20261006000200_staff_role_permissions` | Owner decision 2026-10-06; built | [ADR-021](decisions/ADR-021-staff-roles.md) |
| D92 | ROLE-EXCEPTIONS | A staff_permissions row is an "Extra access" exception for one person on top of their role (already built; history in staff_events). A row the person's role already implies cannot exist: grant_permission refuses it with P0001 permission_implied_by_role, and a BEFORE INSERT trigger on staff_permissions refuses it for every writer (seed, SQL editor). When a role change makes a row implied, the trigger staff_role_drop_implied_exceptions (AFTER UPDATE OF role on staff, every writer) deletes it in the same transaction, which appends one permission_revoked event per row with the role change's actor and reason. A later demotion does not bring removed rows back. Rows already implied when the roles migration runs (written before the roles: an admin's grant to an admin, a promotion that kept its rows) are deleted once by that migration (private.drop_implied_exceptions(), one permission_revoked event each, no actor), so the rule also holds for a database migrated step by step. A manager can therefore carry only manage_staff as an exception (granted by an admin); an admin carries none. | Staff roles (2026-10-06): `20261006000200_staff_role_permissions`, `20261006000300_staff_role_administration` | Accepted: build default within the owner's decision; owner to confirm ([PRODUCT owner question 20](PRODUCT.md#open-assumptions-and-owner-questions), [R-053](RISKS.md#r-053--the-staff-roles-build-defaults-d92-and-d93-are-unconfirmed)); built | [ADR-021](decisions/ADR-021-staff-roles.md) |
| D93 | ROLE-ADMINISTRATION (restates D11 for roles) | Only an admin invites anyone as admin or manager, changes anyone's role (promote or demote, update_staff role), and changes an admin's or a manager's row (rename, deactivate, reactivate, exceptions). A manage_staff holder who is not an admin invites mechanics only and acts on mechanics' rows only, within the unchanged D11 ceiling: only permissions they hold themselves, never manage_staff, never their own row. Nobody changes their own role; the last active admin cannot be demoted or deactivated (staff_keep_an_active_admin unchanged). Every role change appends one staff_events role_changed row ({"role": {"from", "to"}}) with its actor and an optional reason of at most 500 characters. A role change from the Admin is confirmed against the role its sheet showed (update_staff expected_role; staff_role_changed when someone changed it meanwhile). | Staff roles (2026-10-06): `20261006000300_staff_role_administration` | Owner decision 2026-10-06 for "only admins manage admins and managers"; the mechanics-only reach of a non-admin manage_staff holder over rename/deactivate is a build default, owner to confirm ([PRODUCT owner question 20](PRODUCT.md#open-assumptions-and-owner-questions), [R-053](RISKS.md#r-053--the-staff-roles-build-defaults-d92-and-d93-are-unconfirmed)); built | [ADR-021](decisions/ADR-021-staff-roles.md), [ADR-005](decisions/ADR-005-staff-sign-in-and-delegation.md) |
| D94 | REFUND-ROLES (amends D49) | Retail refunds are recorded by an active admin or manager (private.can_record_refunds(), a role check, not a permission: view_financial_reports is still never enough and no exception grants it). The cap (sale total minus earlier refunds), the mandatory reason, the replay by refund id and the financial-only effect (D7: no stock or unit change) are unchanged. | Staff roles (2026-10-06): `20261006000200_staff_role_permissions` | Owner decision 2026-10-06; built | [ADR-021](decisions/ADR-021-staff-roles.md) |
| D120 | CUSTOMER-SIGNUP: how customers sign in on the public site | With an emailed 6-digit code, the same code-only email as staff (D10, D70); the first code creates the login (`shouldCreateUser: true`; Auth's "Allow new users to sign up" on). No passwords. Auth is called from the visitor's browser, so its per-IP limits count each visitor; the site keeps no limits of its own | Phase 11 | Accepted: build default, owner to confirm | [ADR-023](decisions/ADR-023-public-site.md) |
| D121 | CUSTOMER-LINK: which customer record a website login gets | `claim_my_customer` links the login to the one non-archived customer with the same email (case-insensitive) and no login yet, without changing what staff recorded. Several such records: nothing is linked (`customer_link_ambiguous`), the customer contacts the shop. Archived records are never linked; a login whose own record is archived is refused (`customer_archived`). Once linked, the link stays whatever either email says later | Phase 11 | Accepted: build default, owner to confirm | [ADR-023](decisions/ADR-023-public-site.md) |
| D122 | CUSTOMER-CREATE: when a website customer gets a record | Not at sign-in: at the first booking of a login with no record, with a first name (required), last name and phone from the booking form and the login's email | Phase 11 | Accepted: build default, owner to confirm | [ADR-023](decisions/ADR-023-public-site.md) |
| D123 | BOOKABLE-RANGE: bookable times for a range of days | `bookable_slots(from_day, to_day, type)`: up to 31 shop days per call, each start tagged with its shop day, equal to `available_slots` day by day (D37's rules stay there); everyone may call it | Phase 11 | Accepted: build default, owner to confirm | [ADR-023](decisions/ADR-023-public-site.md) |
| D124 | CUSTOMER-PHOTOS: how customers see their photos | A customer reads the `media-internal` objects behind exactly the photos `my_bike_attachments` and `my_work_order_attachments` return to them (a Storage policy), through short-lived signed URLs from their own session; public photos keep public URLs; never a write, a listing of others or any other entity's photos | Phase 11 | Accepted: build default, owner to confirm | [ADR-023](decisions/ADR-023-public-site.md) |
| D125 | ITEM-PAGE: what the public `/q/[shortId]` shows | Exactly `reporting.public_items`; any other ID shows one "not listed" page, except a signed-in customer's own bike, which opens in their account. Not indexed. Purchase action: a message to the shop on Instagram until Phase 10 gives items a storefront address; a Staff link to the Admin's own `/q` | Phase 11 | Accepted: build default, owner to confirm | [ADR-023](decisions/ADR-023-public-site.md) |
| D100 | REPORT-BASES | Which date a report counts a line on; four bases, chosen on the report. `sale` (the default; the financial figure) is exactly `reporting.financial_lines`: workshop lines count on the shop day of their job's CURRENT `completed_at` (D3 as modified by D15, refined by D32), retail and online sale lines on the sale's `recognized_at`. `check_in`, `completion` and `collection` cover workshop lines only: every non-voided line of a job is dated by that job's `checked_in_at`, `completed_at` or `collected_at`; `check_in` includes jobs not completed yet (work in progress). Retail and online sales appear only on the sale basis. Cancelled jobs carry no money on any basis (D16). Activity counts (checked in, started, completed, ready for collection, collected, cancelled) always count each job on its own current stamp (D31), whatever the basis; appointment counts use the scheduled shop day and current status (D41). Days are shop days (D35), weeks start on Monday (ISO), months are calendar months; a range is at most 731 days. | Phase 9 (2026-10-06): `20261006001000_report_periods`, `…1100_report_stock_value` | Accepted: build default, owner to confirm | [ADR-022](decisions/ADR-022-reporting.md) |
| D101 | REPORT-RESTATEMENT | Reports always reflect the current source records. A reopen (D15) removes a job from its earlier completion day until it is completed again (D32); a back-dated sale (D55) or receipt (D64) adds to the past day it is dated; a refund counts on the day it was recorded (D102). There is no period locking or closing and no stored report total in the MVP (SPEC §19.2); a general ledger is out of scope (SPEC §30). An exported CSV is a snapshot taken at export time. | Phase 9 (2026-10-06): `20261006001000_report_periods`, `…1100_report_stock_value` | Accepted: build default, owner to confirm | [ADR-022](decisions/ADR-022-reporting.md) |
| D102 | REPORT-REFUNDS | The single refund-reporting row for retail and online refunds (D49 and Phase 10's online refunds, D85 on `feat/p10-shopify`, point here). Refunds are reported as their own figure, `refunds_total`: Σ `sale_refunds.amount` recorded (`sale_refunds.created_at`) in the range, in the shop currency, on the sale basis only. They change nothing in the original sale's gross, cost, yield or Cult Commons, and restocked sale lines stay in the figures (D46, D49). Reports show gross sales and, beside them, "refunds recorded", never a netted figure. Cult Commons is not clawed back for a refund. Netting or a claw-back would be a new decision. | Phase 9 (2026-10-06): `20261006001000_report_periods`, `…1100_report_stock_value` | Accepted: build default for owner question 12, owner to confirm | [ADR-022](decisions/ADR-022-reporting.md) |
| D103 | REPORT-MECHANIC | Mechanic attribution in reports: a workshop line counts for its job's CURRENT lead mechanic (`work_orders.lead_mechanic_id` = `financial_lines.lead_mechanic_id`). A job without a lead counts as "Unassigned", retail and online lines as "Not workshop". Additional staff are not credited. Inactive staff still appear by name. | Phase 9 (2026-10-06): `20261006001000_report_periods`, `…1100_report_stock_value` | Accepted: build default, owner to confirm | [ADR-022](decisions/ADR-022-reporting.md) |
| D104 | REPORT-CURRENCY | Report totals are in the shop currency only (`private.shop_currency()`, SGD). Lines, refunds, settlements and receipts in another currency are left out of the totals. Excluded lines are counted (`excluded_foreign_line_count`) and are raised as the Phase 5 `currency_mismatch` exception (D34; Phase 9 step 3 extends it to sale lines), so nothing disappears silently. | Phase 9 (2026-10-06): `20261006001000_report_periods`, `…1100_report_stock_value` | Accepted: build default, owner to confirm | [ADR-022](decisions/ADR-022-reporting.md) |
| D105 | REPORT-PURCHASES-STOCK-VALUE | Purchasing in reports. Purchase receipts count on the shop day of `purchase_receipts.received_at` (D64 allows back-dating up to 30 days): `purchase_receipts` and `purchase_units_received` (Σ `quantity_received`) are operational counts for every active staff member; `purchases_received_total` (Σ `purchase_receipt_lines.received_total` in the shop currency) is a cost figure and needs `view_financial_reports` AND `view_costs` (`manage_purchasing` alone never shows it: D60 is purchasing screens only). Stock value at cost is a figure for NOW, not for a period, and counts shop-owned stock only: quantity products Σ over (product, location) of max(ledger on-hand, 0) × `products.default_direct_cost`, the last cost (D5/D63); unique units with status available or reserved at their `inventory_units.direct_cost`, else the product's `default_direct_cost`. A NULL cost is not valued: it is counted as "without a cost" (D24 as amended); 0 is a known cost and is valued at 0. Locations below zero are not valued (they are already the negative_stock exception, D34). Consigned and customer-owned stock is counted, never valued (not the shop's asset; consignment money follows D48). The rows need `view_financial_reports` and the values `view_costs` (NULL otherwise, D30). | Phase 9 (2026-10-06): `20261006001000_report_periods`, `…1100_report_stock_value` | Accepted: build default, owner to confirm | [ADR-022](decisions/ADR-022-reporting.md) |
| D106 | STOCK-RECONCILIATION | There is no `inventory_balances` cache in the MVP: the movement ledger sum (`reporting.stock_levels`) is the stock, and Phase 9 measured it fast enough (DATA-MODEL §14). Reconciliation compares the ledger with the state the database caches today: each unique unit's status and location (through the disposition of its latest non-transfer movement), each consignment item's status, and unit counts per product and location. It is read-only. The fix is always an existing guarded flow (adjust stock with a reason, restock, settle, void, return), reached by a link, never an automatic fix; an issue that persists after the right fix is an RPC defect, reported with the unit's movement history. A future cache must be a trigger-maintained projection added to these views (SPEC §12, §26). | Phase 9 (2026-10-06): `20261006001200_stock_reconciliation`, `…1300_operational_exceptions` | Accepted: build default, owner to confirm | [ADR-022](decisions/ADR-022-reporting.md) |
| D107 | UNSETTLED-CONSIGNMENT-ALERT | When a consignor's money is overdue: a consignment item is listed when its outstanding amount is above 0 (`reporting.consignor_item_ledger`: owed − paid, D46) and its LATEST sale (`last_sale_at`) is more than N shop days ago. N = `shop_settings.consignment_settlement_alert_days`, default 30, 1–365. Only an admin may change it, through `set_consignment_settlement_alert_days`; the column is never directly writable, and the change is recorded in the schedule history like other shop settings. Exceptions are computed live, never stored or dismissed, and clear when the cause is fixed (settled, restocked or returned). | Phase 9 (2026-10-06): `20261006001200_stock_reconciliation`, `…1300_operational_exceptions` | Accepted: build default, owner to confirm | [ADR-022](decisions/ADR-022-reporting.md) |
| D108 | EXCEPTION-VISIBILITY | Who sees which operational exception. One function, `private.exception_visible(kind)`, decides it for the list, the counts and Today's `exceptions_now` alike. Phase 5's kinds (overdue_job, uncollected_job, negative_stock, unit_hold_stale, currency_mismatch) and unit_state_mismatch: every active staff member (stock and jobs are staff-visible, D30 operational counts). unsettled_consignment: `private.can_view_consignment_money()`, which is manage_consignments or view_costs (D48). integration_failed: admins only (`private.is_admin()`, the same rule as Phase 10's D86). | Phase 9 (2026-10-06): `20261006001200_stock_reconciliation`, `…1300_operational_exceptions` | Accepted: build default, owner to confirm | [ADR-022](decisions/ADR-022-reporting.md) |
| D140 | INDENT-ITEM: what an indent part is on a job | A part request on an open job (`job_part_requests`): a shop-owned, quantity-tracked, active product (existing or created from the job), quantity, the sale price shown to the customer and, for `view_costs` holders, expected cost and supplier; state proposed, quoted, approved, declined, ordered, fitted or cancelled. No stock movement and no job line until fitted; fitting adds an ordinary part line through `add_inventory_line` (D15, D23, D24), so totals, yield and Cult Commons change only then | Phase 13 | Owner decision 2026-10-14 (workflow); details build default | [ADR-024](decisions/ADR-024-indent-parts-and-customer-quotes.md) |
| D141 | QUOTE: what a quote is | A snapshot of chosen proposed items (part requests and catalogue services for fitting) for one job, with names, quantities, prices and total, valid 7 days; one open quote per job (sending another withdraws it); reached by a link holding a 32-byte random token whose SHA-256 alone is stored, shown to staff only when sent | Phase 13 | Build default | [ADR-024](decisions/ADR-024-indent-parts-and-customer-quotes.md) |
| D142 | QUOTE-ANSWER: how the customer answers | Per item approve or decline, a typed name, submitted once and final (a change is a new quote); approved part requests become approved, declined ones declined; approved services are added by staff; the job's approval flag is set with a note of what was approved online, by whom and when, and the timeline records it | Phase 13 | Owner decision 2026-10-14 (per item); rest build default | [ADR-024](decisions/ADR-024-indent-parts-and-customer-quotes.md) |
| D143 | QUOTE-PAGE: what the anonymous quote page shows | `/quote/[token]` in the Admin: shop name, job number, bike, the customer's first name, items, prices, total, expiry and (Phase 14) the deposit; never costs, notes, staff names, contact details or other jobs; not indexed, no referrer, rate-limited per client | Phase 13 | Build default | [ADR-024](decisions/ADR-024-indent-parts-and-customer-quotes.md) |
| D144 | QUOTE-DELIVERY: how a quote reaches the customer | WhatsApp (`wa.me` to the customer's phone with message and link; an 8-digit Singapore number gets +65), email sent by the Admin through Resend when `RESEND_API_KEY` is set and the customer has an email, or a copied link; the channel is recorded | Phase 13 | Owner decision 2026-10-14 | [ADR-024](decisions/ADR-024-indent-parts-and-customer-quotes.md) |
| D145 | INDENT-ORDER: how approved parts are ordered | `manage_purchasing` holders add them to the supplier's open draft purchase order (or a new one), raising that product's line, each request linked to the line; optionally moving the job to Waiting on parts | Phase 13 | Build default | [ADR-024](decisions/ADR-024-indent-parts-and-customer-quotes.md) |
| D146 | INDENT-FIT: when a part has arrived and how it is fitted | Arrived when receipts on its purchase order line cover it, first requested first covered; Fit adds the part line from the receiving location and marks it fitted; arrived stock shows as reserved for the job but is not held | Phase 13 | Build default | [ADR-024](decisions/ADR-024-indent-parts-and-customer-quotes.md) |
| D147 | INDENT-ACCESS: who does what | Any active staff member proposes and sends quotes on an open job; ordering needs `manage_purchasing`; costs and suppliers need `view_costs` or `manage_purchasing` (D60); customers reach a quote only by its link | Phase 13 | Build default | [ADR-024](decisions/ADR-024-indent-parts-and-customer-quotes.md) |
| D148 | INDENT-SCOPE: what changes in the brief | SPEC §7.1's offline approval and SPEC §30's exclusion of customer approval and automated messaging are lifted for quotes only; ordinary parts and services are still added straight to jobs with the internal flag | Phase 13 | Owner decision 2026-10-14 | [ADR-024](decisions/ADR-024-indent-parts-and-customer-quotes.md) |
| D149 | INDENT-CLOSE: an indent request on a collected or cancelled job; D149a–c: closing indent items | An active admin or manager (`private.can_record_refunds()`) may cancel a request that was never fitted on a collected or cancelled job, with a required reason recorded on the timeline (`part_request_cancelled`), so a deposit held for it can be refunded or settled; a request still on a quote left open there (nobody can answer or withdraw it on a closed job) is cancelled the same way, which withdraws that quote first; Fit stays refused on any job that is not open, and collected and cancelled stay final for everything else (D15). Built with it as build defaults (not part of the owner's approval; no change to money, lines, stock or Cult Commons): ordering refuses a job that is not open and withdrawing a quote refuses a closed one; the job page shows approved items not on the bill as a memo (never in the total), a deposit held for them is flagged (`paid_parts_not_fitted`) and a closed job shows what was paid above its bill ([R-082](RISKS.md#r-082--approved-indent-parts-can-be-left-unfitted-on-a-completed-or-collected-job)). **D149a INDENT-FIT-OUTSIDE:** Fit gets "Bought outside BICII" for an approved indent part never ordered through BICII purchasing: staff enter the unit cost; BICII records it as received at that cost and fits it in one step (stock never goes below zero; the yield uses the real cost). Parts on a BICII purchase order are received through Purchasing, then fitted; fitting from existing stock stays. **D149b INDENT-SETTLE-BEFORE-COMPLETE:** Complete is blocked until every approved (or ordered, arrived or not, and not fitted) indent part is fitted or cancelled; Complete opens a checklist with Fit and Cancel for each. **D149c (build defaults, owner to confirm):** (1) the same block on Ready for collection, Collected and Cancel job (Cancel only), including the next move of a job completed or made ready before the guard; (2) an open quote is withdrawn when its job leaves the open statuses (completed, ready for collection, collected or cancelled); (3) recording an outside purchase needs View costs or Manage purchasing; (4) the entered cost becomes the product's cost as a purchase receipt's does (D5, D63), so the line takes it (D24 unchanged); (5) it is recorded as one movement of a new ledger type, `outside_purchase` (+q at that cost, SPEC §12 extended), and the ordinary fit (−q) at the same location; (6) a one-off withdrawal of open quotes on jobs already not open. (1) and (6): [R-082](RISKS.md#r-082--approved-indent-parts-can-be-left-unfitted-on-a-completed-or-collected-job); (3)–(5): [R-084](RISKS.md#r-084--a-part-bought-outside-bicii-rests-on-a-typed-cost) | Phase 13 follow-up (`20261014000700_indent_closed_jobs`; D149a–c `20261014000800_outside_purchase_enum`, `20261014000900_indent_settle_and_outside_purchase`) | D149: owner decision 2026-10-15 SGT (approved: the cancel on collected and cancelled jobs), the guards and screens built with it build defaults; D149a, D149b: owner decision 2026-10-15 SGT (PRODUCT question 33 answered: block); D149c: owner confirmed 2026-10-15 SGT (PRODUCT question 34, all as built); D149 in PR #26, D149a–c in PR #27, both in production since 2026-10-15 | [ADR-024](decisions/ADR-024-indent-parts-and-customer-quotes.md#amendment-2026-10-15-closing-indent-items-d149a-d149b-d149c) |
| D150 | PAYMENTS-PROVIDER: how customers pay | Stripe's hosted Checkout (cards and PayNow, SGD); no card data in BICII; secret key and webhook secret server-only (Production live, Preview test or none); one adapter with an in-memory fake for tests | Phase 14 | Owner decision 2026-10-14 (Stripe); rest build default; Preview amended by D157: none until a staging project exists; built in step 1 | [ADR-025](decisions/ADR-025-stripe-payments.md) |
| D151 | DEPOSIT: the deposit on a quote | 50% of the approved indent parts' total (admin setting `indent_deposit_percent`, 0 for none), rounded to the cent in Postgres, offered through Checkout after the customer answers; the approval stands unpaid, shown as "Deposit due" | Phase 14 | Build default (50%), confirmed by the owner 2026-10-17 SGT (question 32); built in step 2; owner set 100% in production 2026-10-15 SGT | [ADR-025](decisions/ADR-025-stripe-payments.md) |
| D152 | ORDER-AFTER-DEPOSIT: ordering before the deposit | Only once the deposit is paid, unless an admin or manager orders anyway with a recorded reason | Phase 14 | Build default, confirmed by the owner 2026-10-17 SGT (question 32); built in step 2 | [ADR-025](decisions/ADR-025-stripe-payments.md) |
| D153 | PAYMENT-RECORD: how a payment is recorded | A `payments` row created with the Checkout session and changed only by Stripe's verified webhook (signature on the raw body, each event stored once by id, rejected deliveries kept without a body) through a service-role RPC; staff never type one | Phase 14 | Build default, confirmed by the owner 2026-10-17 SGT (question 32); built in step 1 | [ADR-025](decisions/ADR-025-stripe-payments.md) |
| D154 | PAYMENT-MEANING: what a payment changes | Nothing in recognition, totals, yield or Cult Commons; the job shows paid and balance due (total less paid, net of refunds); reports list payments and deposits held on open jobs apart from sales | Phase 14 | Build default, confirmed by the owner 2026-10-17 SGT (question 32); built in step 2 (the job's Customer payments card: paid online, still to pay, paid ahead; and under the Lines total and in the Collected confirmation); Reports in step 3 | [ADR-025](decisions/ADR-025-stripe-payments.md) |
| D155 | REFUNDS: how refunds happen | In the Stripe dashboard, recorded from Stripe's refund events; none started in the Admin | Phase 14 | Build default, confirmed by the owner 2026-10-17 SGT (question 32); built in step 1 | [ADR-025](decisions/ADR-025-stripe-payments.md) |
| D156 | BALANCE-LINK: paying the rest | Staff send a Checkout link for the balance due by WhatsApp or email; paying it does not collect the job | Phase 14 | Build default, confirmed by the owner 2026-10-17 SGT (question 32); to be built in Phase 14 step 3 | [ADR-025](decisions/ADR-025-stripe-payments.md) |
| D157 | PAYMENTS-ROLLOUT: when Stripe and deposits switch on | `shop_settings.indent_deposit_percent` ships at 0 in every database (no deposit asked, nothing gated) and is refused above 0 while Stripe is off; an admin raises it in Settings → Customer payments. Stripe is on only when every variable is valid for the deployment: never in a Vercel Preview; a `sk_`/`rk_` key whose mode matches (live only when `VERCEL_ENV=production`, test only outside it); `STRIPE_WEBHOOK_SECRET`, `SUPABASE_SERVICE_ROLE_KEY` and `ADMIN_ORIGIN` set and well-formed; the fake only outside production. A missing, malformed or wrong-mode value turns Stripe off and names the reason, never stopping the app. Switching off: the percent to 0 first, then remove the keys | Phase 14 steps 1-2 | Build default, confirmed by the owner 2026-10-17 SGT (question 32); built in steps 1–2 (`stripeConfig`, the setting and its rollout guard) | [ADR-025](decisions/ADR-025-stripe-payments.md) |
| D158 | DEPOSIT-RULES: which quotes ask a deposit, how much, how Checkout is offered | The quote stores the shop percent when sent and the amount when answered (`round(approved part lines × percent / 100, 2)` in Postgres; services and declined items excluded; later setting changes never move it; quotes sent before Phase 14 ask nothing). Only SGD quotes; under S$0.50 or over S$999,999.99 nothing is asked (never rounded up). Offered online only while the job is open and an approved part is still approved, ordered or fitted. One Checkout session per quote at a time, 60 minutes, reused until 2 minutes before it expires. Paid or partly refunded counts as paid for D152; fully refunded counts as unpaid and is never offered again | Phase 14 step 2 | Build default, confirmed by the owner 2026-10-17 SGT (question 32); built in step 2 | [ADR-025](decisions/ADR-025-stripe-payments.md) |
| D159 | PAYMENT-TRUTH: what changes a payment, and disagreements | Only verified data: a webhook whose signature is valid on the raw body, or the server's own read with the secret key (customers and staff only trigger it). Whatever Stripe confirms is recorded with Stripe's own amount, even on a cancelled job or part, a second payment or a different amount or currency, and flagged as needing attention; BICII never refunds on its own (D155). Refunds per Stripe Refund; only succeeded ones count, and one that fails after succeeding puts the amount back. `paid_at` is Stripe's time. Stored Stripe objects are an allow-listed projection without customer details or URLs. Card disputes are not handled (a known gap, R-089) | Phase 14 steps 1-2 | Build default, confirmed by the owner 2026-10-17 SGT (question 32); built in step 1 (recording) and step 2 (flags) | [ADR-025](decisions/ADR-025-stripe-payments.md) |
| D160 | INDENT-UNFIT-ON-VOID: voiding a fitted indent line ([R-083](RISKS.md#r-083--a-fitted-indent-request-whose-line-was-voided-is-stuck-and-unflagged)) | When a job line that a fitted indent request points at is voided, by any way a line is voided, the request goes back to where it was before Fit: ordered if it is on a purchase order line, else approved; its link to the line, who fitted it and when, and its link to a D149a outside purchase are cleared; the job's timeline records it (`part_request_unfitted`). It can then be fitted again or cancelled: D149b's checklist holds Complete, Ready, Collected and Cancel job until it is, `paid_parts_not_fitted` flags a deposit held for it should such a job ever close, and the memo and the quote page count it as approved or ordered again. The void's stock reversal is unchanged (a part bought outside BICII keeps its receipt and is back in stock, so a re-fit takes it from there); no change to line totals, yield, Cult Commons or who may void. Built with it as build defaults (not part of the owner's choice): a request is never linked to a voided line (`part_request_line_voided`: a stale Fit with the voided line's id is refused), and a one-off un-fits once the requests already in that state, with a NOTICE | Phase 13 follow-up (`20261014001000_part_unfitted_enum`, `20261014001100_indent_unfit_on_void`) | Owner decision 2026-10-15 SGT (the first of R-083's three options); the live-line guard and the one-off are build defaults; in PR #30, in production since 2026-10-16 SGT (the one-off changed nothing there) | [ADR-024](decisions/ADR-024-indent-parts-and-customer-quotes.md#amendment-2026-10-15-voiding-a-fitted-indent-line-d160) |
| D161 | COUNTER-PAYMENT: money taken at the counter | Stripe stays the only way a customer pays through BICII: no staff member types a payment in (D153). An admin, and only an admin, can record a payment the shop took at the counter (cash, card or PayNow outside BICII) on a job, so the job's paid and still to pay, and the deposit BICII asks for, count it. How it is recorded, voided and shown are build defaults for Phase 14 step 3 | Phase 14 step 3 | Owner decision 2026-10-17 SGT (question 32: "keep to Stripe only… but have an admin option for counter payment"); the details are build defaults; not built | [ADR-025](decisions/ADR-025-stripe-payments.md#amendment-2026-10-17-the-owners-answers-to-question-32-d161) |

## 7. Out of scope (restated from SPEC §30)

Changed by the owner on 2026-10-14: customer approval and messages for
quotes (Phase 13, D148) and customer payments through Stripe (Phase 14,
D150) are now in scope; the rest stands.

Payments other than Stripe Checkout (D150), accounting ledger, automated
customer approval, Shopify SSO, customer mechanic selection, labour time
clock, bulk→unique conversion machinery, multi-location optimisation,
native apps, hard-coded Bluetooth printing, marketing CRM.
