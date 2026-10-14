# Architecture and rationale

Owner: the build agent, reviewed by the product owner (Abhishek Cherian
George). Implementation inspected: `c6bf6d0` on 2026-10-05 (application code
identical to `b34bbcd`, the head of PR #7); the Phase 6 and Phase 7 rows were
added at their phases, Phase 7's at its integration with the main line on
`feat/p7-purchasing`, the staff email sign-in rows at its integration
on `feat/auth-email-otp` (2026-10-06), and the staff roles rows on
`feat/staff-roles` (2026-10-06, ADR-021).

This page describes the system as it is built. The decision of record is
[ADR-001](ADR-001-architecture.md), whose body stays as written in PR #1;
where they differ on a fact (versions, for example), this page and the code
are current.

## Current system

```mermaid
flowchart LR
  staff["Staff phone / iPad<br/>(installable PWA)"] --> app["BICII Admin: Next.js app<br/>(this repo; Vercel, project bicii-book)"]
  app --> auth
  app --> rest
  app --> storage
  subgraph supabase["Supabase (one backend)"]
    auth["Auth"]
    rest["PostgREST"]
    storage["Storage"]
    db[("Postgres<br/>RLS + RPCs")]
    rest --> db
    auth --> db
    storage --> db
  end
  public["Public site, repo bicii<br/>(Phase 11: backend built, screens in step 2)"] -.-> rest
  public -.-> auth
  public -.-> storage
  shopify["Shopify<br/>(Phase 10: built against a fake;<br/>no store connected)"] -. "webhooks (HMAC)" .-> app
  app -. "Admin API (GraphQL)" .-> shopify
  cron["Vercel cron<br/>(vercel.json, not set up)"] -. "bearer" .-> app
  printer["Label printer<br/>(browser print / PDF since Phase 8;<br/>hardware adapter Phase 12)"] --- app
  auth --> mail["Email (SMTP)<br/>sign-in codes; Resend on production"]
  customer["Customer's phone<br/>(quote link, signed out)"] --> app
  app -. "quote emails (HTTPS API,<br/>off until configured)" .-> resend["Resend"]
  stripe["Stripe Checkout<br/>(Phase 14: built against a fake;<br/>off until keys)"]
  customer -. "pays (step 2)" .-> stripe
  app -. "Stripe API (Checkout Sessions,<br/>Refunds read)" .-> stripe
  stripe -. "webhooks (signature)" .-> app
```

Dashed lines are planned or not yet connected (the Shopify and Stripe
layers are built and tested only against their in-memory fakes; Stripe is
off in production until the owner's keys exist, D157). Production runs on
Vercel (project `bicii-book`, functions in sin1) against one hosted
Supabase project (Postgres 17) since 2026-10-12; there is no staging
project ([R-001](RISKS.md#r-001--nothing-is-deployed)). Locally and in CI the
Supabase services run without Docker on the devstack
([ADR-002](decisions/ADR-002-devstack.md)): a local mail catcher on :8025
(SMTP :2525) that receives Auth's emails, Auth on :9999, PostgREST on
:3001, Storage on :5000 behind a gateway on :54321, and Postgres 16.

Installed versions (from `package.json` and `node_modules`, 2026-10-05):
`next` 16.3.8, `react` / `react-dom` 19.2.8, `@supabase/ssr` 0.12.7,
`@supabase/supabase-js` 2.117.2, `zod` 4.6.5, `decimal.js` 10.6.0, `pino`
10.4.0, `@zxing/browser` 0.2.1 (the Scan screen imports it dynamically, only
when the browser has no `BarcodeDetector` for QR codes), and for labels
(Phase 8 step 2) `qrcode` 1.5.4 (the QR matrix), `pdf-lib` 1.17.1 (the
PDF adapter, server only) and `@pdf-lib/standard-fonts` 1.0.0 (text
metrics shared by the SVG and the PDF), all MIT, bundled by Turbopack with
no webpack configuration; no printer SDK
([R-019](RISKS.md#r-019--adr-001-names-versions-the-code-does-not-use)).

## Main workflow: add a part to a job

1. On the job page (`src/app/(staff)/jobs/[id]/page.tsx`) staff open the
   part sheet (`src/components/domain/add-part-sheet.tsx`). The form carries
   a client-made line id, which is the idempotency key.
2. The form posts to the Server Action `addPartToJob` in
   `src/app/(staff)/jobs/actions.ts`, built with `staffAction`
   ([src/lib/actions.ts](../src/lib/actions.ts)): it creates the
   RLS-scoped server client, calls `authorizeStaff` (signed-out → `/login`,
   inactive or missing permission → forbidden), takes the correlation id,
   validates the form with zod (`addPartSchema`), and runs the handler.
3. The handler calls `addPartToJob` in
   [src/lib/domain/inventory.ts](../src/lib/domain/inventory.ts), which calls
   the RPC `add_inventory_line` through PostgREST as the signed-in user.
4. `public.add_inventory_line`
   ([20261004001900_inventory_jobs.sql](../supabase/migrations/20261004001900_inventory_jobs.sql),
   replaced with the same signature by
   [20261004003400_consignment_job_parts.sql](../supabase/migrations/20261004003400_consignment_job_parts.sql)
   for consigned parts, D44; security definer) runs in one transaction: `private.require_staff()`;
   `private.lock_work_order` (the job FOR UPDATE), `private.lock_stock` (a
   per-product advisory lock) and the unit FOR UPDATE, in the global lock
   order ([DATA-MODEL §7](DATA-MODEL.md#7-inventory-movement-ledger)); a
   replay of the same line id returns the existing line
   (`private.inventory_line_replay`); `private.require_open_work_order`;
   validation (quantity, product, currency, `ownership_not_saleable` for
   customer-owned stock only, location or unit); the price is the override
   or `private.selling_price`, the cost the unit's or product's, and only
   NULL is missing (`part_price_missing`, `part_cost_missing`; D24); the
   line is inserted with the price, cost and
   `private.cult_commons_rate_at(...)` snapshotted;
   `private.record_linked_movement` writes one `job_consumption` ledger row
   (for shop stock exactly what `private.record_movement` wrote before); a
   unique unit becomes `held_for_customer` (`private.set_unit_status`) and
   its product's publication is refreshed; a `stock_consumed` event is
   written to the job's timeline.
   Consigned stock (D44, the owner's D27 change): after the unit, the
   consignment item is locked (lock order step 6; for a quantity product,
   all its active items in id order, then the oldest item whose stock at
   the part's location covers the part (D54), else
   `consignment_quantity_unavailable`); the
   item must be active; the cost is the agreed amount (+ a unique item's
   shop charges), the line also stores the item and
   `consignor_payout_snapshot` (the agreed amount), consigned stock never
   goes below zero (`insufficient_stock`), the movement names the item, and
   `private.refresh_consignment_item_status` runs last. Completing the job
   later marks the unit and the item sold (`work_orders_sell_held_units`);
   the consignor liability is derived from the live line on the completed
   job ([DATA-MODEL §9](DATA-MODEL.md#9-consignment)), never stored.
5. Success: the action calls `refresh()`, the sheet shows the on-hand after
   the move, and `after()` logs `{ correlationId, actor, action, outcome }`.

Failure path: a business refusal is `P0001` with a stable snake_case code
(for example `ownership_not_saleable`). The domain module maps field-level
codes to field errors; otherwise `staffAction` maps the error with
`mapDbError` ([src/lib/db-errors.ts](../src/lib/db-errors.ts)) to a safe
message, returns `{ ok: false, error, code, values }`, and the form renders
the typed values again from `ActionResult.values`. The transaction rolls
back, so nothing partial is stored. A retry with the same line id is a
replay, never a second movement.

## Printing workflow: labels from a record

1. A record page (`src/app/(staff)/{products,units,bikes}/[id]/page.tsx`)
   calls `getLabelContext` in
   [src/lib/domain/labels.ts](../src/lib/domain/labels.ts), which reads the
   RPC `label_preview` (no write): the label text from
   `private.label_content` (price through `private.selling_price`, D58) and
   the payload from `private.qr_payload` (D9), plus the active templates
   and printers. "Printing unavailable" (archived, unique product, QR
   address not set, no template) comes back as a reason, never a throw.
2. Print label opens the print sheet
   ([print-label.tsx](../src/components/domain/print-label.tsx)): quantity
   (1–500 for a product, 1–10 for a unit or bike, D56), printer, size.
   "Print N labels" posts `createPrintJobAction`
   (`src/app/(staff)/labels/actions.ts`, `staffAction` + zod) with an id
   minted when the sheet opened.
3. `public.create_print_job`
   ([20261004003800_labels.sql](../supabase/migrations/20261004003800_labels.sql),
   security definer) guards staff, refuses archived records and P- labels
   for unique products, recomputes the content and payload in the database,
   snapshots the template and printer, and inserts a `queued` job; a replay
   of the same id returns the same job. The sheet navigates to the print
   view `/print/labels/[jobId]`.
4. The print view (`src/app/(print)/print/labels/[jobId]/page.tsx`,
   `requireStaff`) renders an open job only (`isPrintable`, D59) from its
   snapshots. Browser printer: Print calls `window.print()` first, then
   `set_print_job_status(rendered)`. PDF printer: Open PDF opens
   `GET /api/labels/[jobId]/pdf` (`authorizeStaff`; 404 unknown, 409
   finished; pdf-lib from the same snapshots, no side effects) in a new
   tab and marks the job rendered.
5. Staff confirm: "Yes, all printed" or "Something went wrong…" with a
   reason (`set_print_job_status` printed or failed). An unconfirmed job
   stays `rendered` under "To confirm" in `/labels`. A finished job is
   history; "Print again" (`reprintPath`) returns to the record with
   `?print=1&qty=N&reprint={job}` and makes a new job linked by
   `reprint_of_id`.

Failure path: business refusals are `P0001` codes mapped in
[src/lib/db-errors.ts](../src/lib/db-errors.ts) (for example
`public_site_url_invalid`, `label_unique_product_needs_unit`,
`label_quantity_out_of_range`); nothing is stored when the RPC refuses.
Journey 3 (`tests/e2e/inventory.spec.ts`) drives steps 1–5 through the PDF
printer and journey 4 (`tests/e2e/consignment-journey.spec.ts`) through
the browser printer.

## Shopify inbound flow

Built in Phase 10 step 1 as database functions and in step 3 as the
service layer (`src/lib/integrations/shopify/`: the webhook and cron
routes, the queue runners); the screens in step 4 (the admin queue,
event inspector and links under `/shopify`, Today's exception row)
([ADR-020](decisions/ADR-020-shopify.md), D80–D89).

1. **Store first.** `POST /api/shopify/webhooks` (outside the proxy;
   `handleShopifyWebhook` in `webhooks.ts`) reads the body once as bytes,
   refuses more than 1 MiB (413, not stored), verifies the HMAC on those
   raw bytes before anything is parsed, checks the shop domain, the
   Shopify headers and that the body is a JSON object, and calls
   `record_shopify_webhook` with the service-role key. Every delivery is
   stored before anything else happens: a verified one in
   `integration_events` (deduplicated on X-Shopify-Webhook-Id; a repeat only
   counts the delivery), a rejected one as evidence without its body (D88).
   A new order or refund gets a queued job in `integration_retry_queue`;
   test, POS and unhandled deliveries are stored as skipped (D89).
   The route answers 200 as soon as the event is stored (500 if it could
   not be, so Shopify retries; 401/400/503 for rejected deliveries, kept
   as evidence up to 30 a minute per instance).
2. **Queue.** `claim_integration_jobs` hands due jobs to a runner
   (`queue.ts`) with `FOR UPDATE SKIP LOCKED`, so two runners never run one
   job; a run stalled for 10 minutes is reclaimed (D87). After the
   response, in `after()`, the route runs the new event's own job
   (`runJobById`), then up to 5 due jobs; `GET /api/cron/integrations`
   (Vercel cron every 5 minutes, bearer `CRON_SECRET`) runs up to 25. A
   claimed job always runs to its end, so each runner claims a job only
   while that job's worst case (`MAX_JOB_MS`: four Shopify calls at the
   10 s timeout plus 5 s) still ends 5 s before the routes' 60 s
   `maxDuration` (`lastClaimAt` in `config.ts`). A Server Action that
   runs a job after its committed write (Publish online, Sync now, Retry,
   link) treats that run as best effort (`after-commit.ts`): if it
   throws, the action still succeeds with "Saved. The sync runs from the
   queue in a moment." and the queue runs the job.
3. **Process in one subtransaction.** `process_shopify_event` locks the
   event row (a processed event is a replay with no effect), then runs
   every business write inside one plpgsql `begin … exception … end`
   block: validate the payload, take the order's advisory lock, find an
   existing sale (`duplicate_order`), map every line by variant, insert the
   sale header, lock stock, units and consignment items in the global lock
   order, write each line through Phase 6's `private.sell_line` with
   `online_sale` (the one sale-line writer, so online and in-store
   economics are identical), refresh publication last. Any refusal rolls
   the whole block back: the event becomes `failed` with a human message
   and its job `needs_attention` (or queued with backoff when transient).
   A refund is one `sale_refunds` row and nothing else (D85).
4. **People act.** Admins see each `needs_attention` job as an
   `integration_failed` operational exception (Today's Needs attention,
   D86), then link the variant (`link_shopify_variant`) and retry, or
   refund in Shopify and dismiss with a reason. Dismissing an order closes
   the refunds waiting for it.

Failure path: business failures never raise out of the processors; they
are stored on the event and job. Unexpected errors are retried
automatically and keep their SQLSTATE in `last_error_detail` (admin only).
`tests/db/shopify-webhooks.test.ts` proves each step, including concurrent
deliveries.

## Shopify outbound flow

Built in Phase 10 step 2 as database functions
(`20261004004100_shopify_product_sync.sql`) and in step 3 as the sync
runner (`runProductSync` in `src/lib/integrations/shopify/sync.ts`); the
Publish online toggle and sync status on the product page in step 4
([ADR-020](decisions/ADR-020-shopify.md), D81, D83, D84, D86, D87).

1. **Publish.** Staff with manage_inventory call `set_publish_online`
   (public, priced, not archived, not customer-owned); it queues one
   `product_sync` job and returns its id, which the app runs right away.
2. **Queue on change.** Deferred constraint triggers on stock movements,
   product fields, units, consignment asking prices, public product photos
   and the online location call `private.enqueue_product_sync` at commit:
   one queued job per product, the row `pending`. Products only linked to a
   Shopify-made product are never queued until published. Deferred, so the
   sync row and queue are always locked last (after the products row a sale
   locks when it refreshes publication).
3. **Read the desired state.** The worker claims the job
   (`claim_integration_jobs`) and reads `product_sync_state`: the one
   online price (`private.shopify_online_price`, through
   `private.selling_price`, D58), the quantity at the online location, the
   unit price conflicts, the photos, the handle, the compare quantity and
   whether an online order is in flight (D83).
4. **Push only what changed** (`runProductSync`, never throws).
   `buildDesiredState` (pure) turns the state into the product's desired
   Shopify state and a SHA-256 hash that includes the location and the
   pinned API version: a BICII-created product is pushed in full with
   `productSet` (DRAFT at quantity 0 when not effectively online); a
   product linked to a Shopify-made product gets only its variant's price
   (`productVariantsBulkUpdate`) and inventory level, never productSet
   (D84). The price is `sale_price` as Postgres computed it. No adapter →
   failed, retried; a missing price or a unit priced differently → failed,
   a person acts; the same hash as the last push → `unchanged` with no
   Shopify call; an order in flight → `deferred` with no call. The
   absolute quantity is set with the last pushed quantity as the compare
   quantity; when Shopify's count moved the job is deferred once, then
   overwritten without a compare (BICII is the stock truth, D83). Every
   call goes through the `ShopifyAdmin` interface: `graphql-admin.ts`
   (live, pinned version, 10 s timeout, retriable vs person-must-act error
   mapping; off in a Vercel Preview unless `SHOPIFY_ALLOW_PREVIEW=true`
   marks a development store) or `fake-admin.ts` (in memory, for tests
   and E2E).
5. **Record the outcome.** `record_product_sync_result`: `pushed` (ids,
   handle, what was pushed), `unchanged`, `deferred` (two minutes, no
   attempt used) or `failed` (backoff or needs attention, D87). The status
   staff see (`reporting.shopify_sync_status`) and the public Buy-online
   link (`reporting.public_items.buy_online_url`, D84) follow it.

`tests/db/shopify-sync.test.ts` proves the database steps,
`tests/unit/shopify-sync.test.ts` and `shopify-desired-state.test.ts` the
runner, and `tests/db/shopify.stack.test.ts` the whole chain through
PostgREST with the fake Shopify.

## Stripe payment flow

Built in Phase 14 step 1: the database (`20261014000400_stripe_payments.sql`)
and the service layer (`src/lib/integrations/stripe/`, the route
`api/stripe/webhooks`); the Checkout flows, the quote page's Pay deposit
and the staff card come in step 2
([ADR-025](decisions/ADR-025-stripe-payments.md), D150, D153, D155,
D157–D159). Stripe is on only when `stripeConfig` finds every variable
right for the deployment (D157); otherwise it is off with a named reason
and the route answers 503.

1. **Verify on the raw bytes.** `POST /api/stripe/webhooks` (outside the
   proxy; `handleStripeWebhook` in `webhooks.ts`) reads the body once as
   bytes, refuses more than 1 MiB (413, not stored), and checks
   `Stripe-Signature` (`signature.ts`: HMAC-SHA256 of `${t}.${raw}`, any
   `v1` during a secret roll, 5 minutes either way) before anything is
   parsed. Then it checks the body is a JSON object, the event has an
   `evt_` id, a type and a boolean livemode, and that livemode matches the
   key's mode. Every rejection is stored as evidence without its body
   (400; 503 while Stripe is off), up to 30 a minute per instance.
2. **Store and apply in one transaction.** `record_stripe_event` (service
   role) stores the delivery, deduplicated on its `evt_` id (a repeat only
   counts the delivery), and applies it in the same transaction from an
   allow-listed projection (ids, statuses, amounts, `bicii_*` metadata; no
   customer details, no URLs, D159e). Transitions only move forward, so
   replays, duplicate Event objects and out-of-order deliveries are no-ops.
   A guard lets a payment or refund change only while the event being
   applied is cited, for every role. The route answers 200 once stored,
   duplicates included. There is no `after()`: the answer comes within the
   10 seconds Checkout waits before sending the customer back.
3. **500 means Stripe retries.** If storing or applying raises (a bug or
   an outage), everything rolls back, a `not_recorded` row is kept as
   evidence, and the route answers 500; Stripe retries for up to 3 days.
   Business problems never raise: whatever Stripe confirms is recorded
   (D159b).
4. **Server reads.** `record_stripe_read` stores and applies a Checkout
   Session or Refund the server read with the secret key
   (`http-gateway.ts`: no SDK, pinned to `2026-09-30.endive`, 8 s timeout,
   one retry with the same bytes and idempotency key, after a jittered
   250–500 ms wait when Stripe answered 409 or 429). Step 2 calls it when the
   customer presses Pay or returns, and when staff press *Check with
   Stripe*; they only trigger the read.
5. **Refunds from Refund objects only.** `refund.created`, `.updated` and
   `.failed` give one `payment_refunds` row per Stripe Refund; only
   succeeded ones in the payment's currency and mode reduce the money held
   (another currency or mode is recorded and needs attention), and a
   refund that fails after succeeding puts the amount back (D155, D159c).
6. **Attention is derived live (step 2).** Problems Stripe's data shows
   (paid on a cancelled job, a different amount, a failed refund, an
   unmatched event) are computed in views and listed on the job and in
   Exceptions, never stored as a status of their own.

`tests/db/stripe-payments.test.ts` proves the database steps, including
concurrent deliveries; `tests/unit/stripe-*.test.ts` the signature, the
configuration, the adapter, the fake and the route.

## Component map

| Responsibility | Location | Dependency | Failure consequence |
|---|---|---|---|
| Staff screens and Server Actions | `src/app/(staff)/` (`page.tsx`, `actions.ts` per area) | domain modules, `requireStaff` | the screen or action errors; data stays consistent because the database enforces the rules |
| Sign-in | `src/app/(auth)/login/` (`requestCode`, `verifyCode`), [src/lib/auth/otp.ts](../src/lib/auth/otp.ts), [sign-in-errors.ts](../src/lib/auth/sign-in-errors.ts) | Supabase Auth email codes (`signInWithOtp` without creating users, `verifyOtp`; D10, D70), SMTP | staff cannot sign in |
| Sign-in limits | [src/lib/auth/sign-in-limits.ts](../src/lib/auth/sign-in-limits.ts), [src/lib/admin/sign-in-throttle.ts](../src/lib/admin/sign-in-throttle.ts) | `note_sign_in_attempt` (service role, so `SUPABASE_SERVICE_ROLE_KEY`; D72) | sign-in says it is unavailable for everyone; the error log's `cause` says why (`no_service_role_key`, `rpc_error` with its code, `request_failed`) |
| Session revocation | trigger `staff_revoke_sessions` (`20261005005000_staff_session_revocation.sql`) | `auth.sessions`, `auth.refresh_tokens` (D71) | a deactivated device can refresh, but every guard still refuses it |
| Session refresh and redirect | [src/proxy.ts](../src/proxy.ts) | `@supabase/ssr` | stale sessions, missing `x-request-id`; it is not the guard |
| Staff guard | [src/lib/auth/session.ts](../src/lib/auth/session.ts) (`requireStaff`, `requireAdmin`, `authorizeStaff` with `permission`, `admin` or `roles`), [src/lib/auth/permissions.ts](../src/lib/auth/permissions.ts) (roles, `roleImplies`, the blockers) | `my_staff_profile` | pages and actions refuse to run |
| Action wrapper | [src/lib/actions.ts](../src/lib/actions.ts) (`staffAction`, `ActionResult`) | zod, `db-errors`, logger | inconsistent errors or lost form values |
| Domain modules (server-only) | [src/lib/domain/](../src/lib/domain/) | RLS-scoped client, RPCs | the feature fails; rules still hold in SQL |
| Consignment (Phase 6) | [src/lib/domain/consignment.ts](../src/lib/domain/consignment.ts) (consignors, items, intake, terms, charges, returns, settlements over `list_consignors`, `consignor_statement`, `consignor_payout_details` and the step 1–2 RPCs); screens `src/app/(staff)/consignment/` (`page.tsx` with `?view=consignors\|items`, `consignors/[id]`, `items/[id]`, `actions.ts`); sheets in `src/components/domain/` (consignor, intake, charge, settlement, item controls); pure rules in [src/lib/consignment.ts](../src/lib/consignment.ts) (labels, `autoAllocate`, `allocationProblems`, `paidAtFromDate`) and [consignment-forms.ts](../src/lib/consignment-forms.ts); access mirrors `canViewConsignmentMoney` / `canViewSaleCosts` / `canRecordRefund` in [permissions.ts](../src/lib/auth/permissions.ts) (D48, D49) | RLS-scoped client; the consignment RPCs and the ledger views behind them | consignors cannot be paid or items received; owed, paid and outstanding stay correct because they are derived in SQL (D46). A consignor's totals are summed in the domain module from the item rows, which is how `reporting.consignor_ledger` defines them |
| Sales (Phase 6) | [src/lib/domain/sales.ts](../src/lib/domain/sales.ts) (`listSales`, `getSale`, `saleForUnit`, `searchSaleable`, `recordRetailSale`, `restockUnit`, `recordSaleRefund` over `list_sales`, `sale_lines_detail`, `saleable_stock`, `record_retail_sale`, `restock_unit`, `record_sale_refund`); screens `src/app/(staff)/sales/` (`page.tsx`, `[id]/page.tsx`, `actions.ts`); `RecordSaleSheet` / `SaleablePicker` and `RefundSheet` / `RestockControl` in `src/components/domain/`; pure rules in [src/lib/sales.ts](../src/lib/sales.ts) (`previewSale` over `lineEconomics`, `priceWarnings`, `saleRange`, `refundableAmount`, status words) and [sales-forms.ts](../src/lib/sales-forms.ts); Sell on the consignment item, unit and product pages | RLS-scoped client; the sale RPCs; `private.sell_line` in the database is the single sale-line writer that Phase 10 reuses with `online_sale` | no sale can be recorded; stock, units, consignment and the reports stay consistent because every effect is inside `record_retail_sale` |
| Purchasing (Phase 7) | [src/lib/domain/purchasing.ts](../src/lib/domain/purchasing.ts) (orders, lines, receipts, `receivePurchase` with the lookup `findReceiptByKey`, reorder, the product page's `getProductPurchasing`) and [suppliers.ts](../src/lib/domain/suppliers.ts); screens `src/app/(staff)/purchasing/` (the `(browse)` group: orders, `orders/[id]`, suppliers, `suppliers/[id]`; outside it, manage_purchasing only with a real 403, `receive/[id]` and `reorder`); components in `src/components/domain/purchasing/`; pure rules in [src/lib/purchasing.ts](../src/lib/purchasing.ts), [purchasing-forms.ts](../src/lib/purchasing-forms.ts) and [receive-form.ts](../src/lib/receive-form.ts) (the Receive screen's idempotency state machine); cost visibility mirrors `private.can_view_purchase_costs()` (D60) | RLS-scoped client; the purchasing RPCs and `reporting.purchase_order_progress` / `product_on_order` | nothing can be ordered or received; a delivery is still recorded once per submission key and stock moves only through `receive_purchase` |
| Period reports (Phase 9) | reads in [src/lib/domain/period-reports.ts](../src/lib/domain/period-reports.ts) (summary, series, breakdown with its keyset cursor, line items, activity, by mechanic, stock value, and the export pagers `getAllBreakdownForExport` / `getAllLineItemsForExport`) and [report-exports.ts](../src/lib/domain/report-exports.ts) (one fetcher per export kind); pure period model, URL state and DTOs in [src/lib/period-reports.ts](../src/lib/period-reports.ts), the export kind table in [src/lib/report-exports.ts](../src/lib/report-exports.ts) and CSV writing in [src/lib/csv.ts](../src/lib/csv.ts); screens `src/app/(staff)/reports/` (`page.tsx`, `lines/page.tsx`) and the CSV Route Handler `reports/export/route.ts`; components in `src/components/domain/reports/` | the step 1 report RPCs (D100–D105), which gate every figure (D30) | the screens or an export fail; nothing is stored, so no figure can drift (SPEC §19.2) |
| Exceptions and stock reconciliation (Phase 9 step 4) | reads and the admin threshold in [src/lib/domain/reconciliation.ts](../src/lib/domain/reconciliation.ts) (`getStockReconciliation`, `getUnitReconciliation`, `getExceptionCounts`, `getConsignmentAlertDays`, `setConsignmentSettlementAlertDays`, `getUnitProductIds`, `getProductLabel`) and Phase 5's `getOperationalExceptions` (the one mapper, now with the appended columns); issue sentences, dispositions, sections and URL state in [src/lib/reconciliation.ts](../src/lib/reconciliation.ts); Phase 5's `ExceptionList` and the exception helpers in `src/lib/reports.ts`, extended; screens `reports/exceptions/` (with the Server Action `setSettlementAlertDays`) and `reports/reconciliation/` | the step 3 RPCs (D106–D108): `report_stock_reconciliation`, `report_unit_reconciliation`, `operational_exceptions`, `report_exception_counts`, `set_consignment_settlement_alert_days` | the screens fail; nothing is stored or fixed automatically (D106) |
| Consigned job parts (D44) | `searchParts` in [inventory.ts](../src/lib/domain/inventory.ts) (consigned units and the FIFO-head consignment of quantity stock, D45), `loadParts` in [lines.ts](../src/lib/domain/lines.ts) (a line's consignment) | `consignor_statement` for the FIFO head and the cost preview | the part sheet does not offer consigned stock; `add_inventory_line` still applies D44 |
| Labels and the QR base (Phase 8; D9, D56–D59, [ADR-017](decisions/ADR-017-labels-and-qr-base.md)) | Database (step 1): `20261004003800_labels.sql` — `private.qr_payload` (the only payload source, from `shop_settings.public_site_url`, no fallback), `private.label_content` (the only label text, price through `private.selling_price`), `label_templates`, `printer_profiles`, `print_jobs` and the five label RPCs. App (step 2): [src/lib/qr.ts](../src/lib/qr.ts) (`getQrBase`, `qrUrl`, `scanBases`: every DISPLAYED QR URL from the same column, "QR address not set" when unusable); [src/lib/printing/](../src/lib/printing/) (pure: zod schemas with the database's layout rule, `composeLabel` — the one layout engine — `LabelSvg`, the status machine, links; `adapters/`: `browser` → `LabelSheet`, `pdf` → pdf-lib, server only); [src/lib/domain/labels.ts](../src/lib/domain/labels.ts) (print job DTO from the snapshots, history, `getLabelContext`, reprint preset, admin template, printer and address writes); actions in `src/app/(staff)/labels/actions.ts` and `settings/labels/actions.ts`; the print view `src/app/(print)/print/labels/[jobId]` (outside the shell), the PDF Route Handler `src/app/api/labels/[jobId]/pdf/route.ts`, and the print history `/labels`, `/labels/[jobId]`. Screens (step 3): the record pages' Labels card and print sheet ([labels-card.tsx](../src/components/domain/labels-card.tsx), [print-label.tsx](../src/components/domain/print-label.tsx), over `getLabelContext` and `resolvePrintPreset`, which read the deep link `?print=1&qty=N&reprint={job}` from each page's awaited `searchParams`) and Settings → Labels and printers (`/settings/labels`, admins only, no `loading.tsx`, [label-settings.tsx](../src/components/domain/label-settings.tsx)). Journeys (step 4): the label steps of journeys 3 and 4. The staff view of what an anonymous scan returns is the existing `PublicPreviewPanel` over `reporting.public_items`; Phase 8 adds no anonymous RPC, client or route (Phase 11 creates `public.public_item`) | Postgres; `shop_settings.public_site_url` | nothing prints while the address is unset (`public_site_url_invalid`), and record pages say "QR address not set"; printed labels keep their address ([R-013](RISKS.md#r-013--changing-the-qr-base-leaves-printed-labels-on-the-old-address)) |
| Supabase clients | [server.ts](../src/lib/supabase/server.ts), [browser.ts](../src/lib/supabase/browser.ts), [service.ts](../src/lib/supabase/service.ts), [anon.ts](../src/lib/supabase/anon.ts) (the quote page: anon key, no session, whoever is signed in) | anon key + session; service-role key (server only) | no data access |
| Indent parts and quotes (Phase 13; D140–D147, [ADR-024](decisions/ADR-024-indent-parts-and-customer-quotes.md)) | Staff (step 2): [src/lib/domain/indent.ts](../src/lib/domain/indent.ts), `src/app/(staff)/jobs/indent-actions.ts`, [indent-card.tsx](../src/components/domain/indent-card.tsx), the product page's reserved line; pure rules in [src/lib/indent.ts](../src/lib/indent.ts). Customer (step 3): `src/app/(customer)/quote/[token]/` (page, form, `answerQuoteAction`) over `quote_by_token` and `answer_quote` as anon, [src/lib/quote-page.ts](../src/lib/quote-page.ts) (token shape, the RPC's JSON parsed with zod), its limits in [src/lib/quote-limits.ts](../src/lib/quote-limits.ts) and [src/lib/admin/quote-throttle.ts](../src/lib/admin/quote-throttle.ts). Email: [src/lib/integrations/email/](../src/lib/integrations/email/) (Resend's HTTP API, `quoteEmailEnabled`, `sendQuoteEmail`) | the step 1 RPCs; `note_sign_in_attempt` (service role) for the page's limits; Resend when `RESEND_API_KEY` and `EMAIL_FROM` are set | staff quote by WhatsApp or a copied link; without the service-role key the page is not rate-limited (it fails open, logged); a failed email keeps the quote and staff copy the link |
| Service-role use | [src/lib/admin/](../src/lib/admin/) (staff logins via the Auth admin API, created without a password; the sign-in counters) | `SUPABASE_SERVICE_ROLE_KEY` (required in every deployment) | without it, or with a wrong one, nobody can sign in (every code request and verification is counted with it first, D72; sign-in says it is unavailable and the error log names the cause) and staff cannot be invited; bypasses RLS, so imports are restricted by ESLint |
| Shopify integration layer (Phase 10 step 3; D80–D89, [ADR-020](decisions/ADR-020-shopify.md)) | [src/lib/integrations/shopify/](../src/lib/integrations/shopify/): `config.ts` (pinned API version, topics, limits), `ids.ts` (gids, handles), `hmac.ts`, `admin.ts` (the `ShopifyAdmin` interface and `ShopifyError`), `graphql-admin.ts` (live), `fake-admin.ts` / `fake-ids.ts` (in memory), `client.ts` (`getShopifyAdmin`, `shopifyConnection`), `desired-state.ts` (pure), `deps.ts` (`IntegrationDeps`), `sync.ts` (`runProductSync`), `queue.ts` (`runJob`, `runJobById`, `runDueJobs`), `webhooks.ts` (`handleShopifyWebhook`), `cron.ts` (`handleCronRequest`); routes [api/shopify/webhooks](../src/app/api/shopify/webhooks/route.ts) (POST, HMAC) and [api/cron/integrations](../src/app/api/cron/integrations/route.ts) (GET, bearer), both Node runtime with `maxDuration` 60, both outside the proxy matcher; [vercel.json](../vercel.json) cron every 5 minutes | the service-role client and the Shopify RPCs (DATA-MODEL §16); `SHOPIFY_*`, `CRON_SECRET` | webhooks are refused or not stored (Shopify retries for a while); syncs wait in the queue with a human message; no sale or stock is ever recorded outside the RPCs |
| Shopify screens (Phase 10 step 4; D84, D86) | [src/lib/domain/shopify.ts](../src/lib/domain/shopify.ts) (reads over the RLS client: `getProductOnline` for any staff, `getShopifyOverview`, `listSyncedProducts`, `listQueue`, `getQueueJob`, `listEvents`, `getEvent` for admins; writes only through the staff RPCs; `describeRun` reads back a job's result for the toast); [src/lib/shopify.ts](../src/lib/shopify.ts) (pure words and tones) and [shopify-forms.ts](../src/lib/shopify-forms.ts); Publish online and Sync now in `src/app/(staff)/inventory/actions.ts` (manage_inventory) and the admin actions in `src/app/(staff)/shopify/actions.ts`, which run only the job id an RPC returned through `runJobById` with the service-role deps; the product page's `OnlineCard`; `/shopify`, `/shopify/queue`, `/shopify/products`, `/shopify/events`, `/shopify/events/[id]` (admins only, no `loading.tsx`); components in `src/components/domain/shopify/`; Today's `integration_failed` row through `src/lib/reports.ts` | RLS-scoped client and the staff RPCs; the integration layer for running a job | the screens error; online orders keep being stored and processed by the routes and the cron |
| Stripe integration layer (Phase 14; D150–D159, [ADR-025](decisions/ADR-025-stripe-payments.md)) | [src/lib/integrations/stripe/](../src/lib/integrations/stripe/): `config.ts` (pinned API version, the 7 event types, limits, id shapes, idempotency keys), `form.ts` (the Checkout Session body), `gateway.ts` (the `StripeGateway` interface, `StripeError`, the parsers), `signature.ts`, `http-gateway.ts` (live, over fetch), `fake-gateway.ts` (in memory), `client.ts` (`stripeConfig`, `getStripeGateway`, `stripeConnection`), `deps.ts`, `records.ts` (the RPC wrappers), `webhooks.ts` (`handleStripeWebhook`), `limits.ts` (*Check with Stripe*'s counter); route [api/stripe/webhooks](../src/app/api/stripe/webhooks/route.ts) (POST, signature, Node runtime, `maxDuration` 30, outside the proxy matcher); the shared [limiter.ts](../src/lib/integrations/limiter.ts) | the service-role client and `record_stripe_event` / `record_stripe_read` (DATA-MODEL §16, §19); `STRIPE_*`, `ADMIN_ORIGIN` | Stripe off: the route answers 503 (kept as evidence). A failed store answers 500 and Stripe retries; the payment stays pending meanwhile ([R-086](RISKS.md#r-086--a-payment-stays-pending-until-stripes-webhook-arrives)) |
| Error mapping | [src/lib/db-errors.ts](../src/lib/db-errors.ts) | P0001 codes, constraint names | users see the generic error |
| Logging and server errors | [src/instrumentation.ts](../src/instrumentation.ts), [src/lib/logger.ts](../src/lib/logger.ts) | pino to stdout | no trace of failures (no retention or alerting, [R-002](RISKS.md#r-002--no-backups-monitoring-alerting-or-exercised-recovery)) |
| PWA shell | [public/sw.js](../public/sw.js), [src/app/manifest.ts](../src/app/manifest.ts) | browser | no install or offline page |
| Schema, rules, RLS, RPCs | [supabase/migrations/](../supabase/migrations/) | Postgres | the authority for every invariant ([DATA-MODEL](DATA-MODEL.md#authority-applied-state-and-implementation-status)) |
| Synthetic demo data | [supabase/seed.sql](../supabase/seed.sql) | migrations | tests and demos lose their fixtures |
| Docker-free Supabase | [scripts/devstack/](../scripts/devstack/), [supabase/devstack/roles.sql](../supabase/devstack/roles.sql), [supabase/templates/](../supabase/templates/) | pinned Auth, PostgREST, Storage binaries; a generic mail catcher (`mailcatcher.mjs`) | no local or CI backend ([R-003](RISKS.md#r-003--the-devstack-differs-from-hosted-supabase)) |
| CI | [ci.yml](../.github/workflows/ci.yml) (check, test, build), [e2e.yml](../.github/workflows/e2e.yml) (Playwright, label `e2e`, nightly, manual), [migrate.yml](../.github/workflows/migrate.yml) (`db push` to the hosted project) | GitHub Actions | regressions merge unseen ([R-010](RISKS.md#r-010--e2e-is-not-a-required-check-and-branch-protection-is-unverified)) |

## Why this design

The shop needs one operational truth that a second frontend (the public
site) can share, on phones, with a small team and no dedicated operations
staff. So the rules live in Postgres, where both frontends and every retry
meet them, and the Next.js app stays a thin, server-rendered client. That
reasoning is ADR-001's; the "small team" point is inferred.

| Decision | Record |
|---|---|
| Next.js App Router + Supabase, server-first, PWA | [ADR-001 A1](ADR-001-architecture.md#a1-stack), [A7](ADR-001-architecture.md#a7-mobile-first-pwa) |
| Three layers (screens → domain modules → database), one direction | [ADR-001 A2](ADR-001-architecture.md#a2-three-layers-one-direction) |
| Authorization in the database; the app checks again | [ADR-001 A3](ADR-001-architecture.md#a3-authentication-and-authorization), [A5](ADR-001-architecture.md#a5-clientserver-boundary-with-supabase) |
| Plain SQL migrations, RLS in the same file | [ADR-001 A4](ADR-001-architecture.md#a4-migrations) |
| Correlation ids and structured logs | [ADR-001 A8](ADR-001-architecture.md#a8-observability) |
| Docker-free devstack | [ADR-002](decisions/ADR-002-devstack.md) |
| Customers through `my_*` RPCs, anonymous through explicit projections | [ADR-003](decisions/ADR-003-customer-access.md) |
| Cult Commons per line with a rate snapshot | [ADR-004](decisions/ADR-004-cult-commons.md) |
| One shop time zone and currency in SQL | [ADR-012](decisions/ADR-012-shop-time-zone-and-currency.md) |
| Consignment and in-store sales | [ADR-016](decisions/ADR-016-consignment-and-sales.md) |
| Purchasing: cost visibility, last cost, receipts, reorder | [ADR-018](decisions/ADR-018-purchasing.md) |
| Staff sign in with emailed one-time codes; deactivation ends sessions; the Admin's own sign-in limits | [ADR-019](decisions/ADR-019-staff-email-sign-in.md) |
| Three staff roles (admin, manager, mechanic) with per-person exceptions; refunds for admins and managers | [ADR-021](decisions/ADR-021-staff-roles.md) |
| The public site signs customers in with codes, links them to their record by email, and reads only the customer RPCs, the anonymous projections and the customer Storage policy | [ADR-023](decisions/ADR-023-public-site.md) |
| Indent parts proposed on a job, quoted by a private link, answered per item, then ordered and fitted | [ADR-024](decisions/ADR-024-indent-parts-and-customer-quotes.md) |
| Customer payments through Stripe Checkout, recorded only from verified Stripe data, stored and applied in one transaction, off until the keys are right for the deployment | [ADR-025](decisions/ADR-025-stripe-payments.md) |

All records: [decisions/README.md](decisions/README.md).

## Boundaries and cross-cutting behaviour

- Browser and server: pages are Server Components; Server Actions are
  public POST endpoints, so each one authorizes itself through
  `staffAction` / `requireStaff`. The browser Supabase client is used only
  for photo uploads to Storage (`src/components/domain/photo-uploads.tsx`),
  under the same Storage policies.
- Authorization happens in three places: RLS on every table, guards in the
  RPCs (`private.require_staff`, `private.require_permission`,
  `private.require_admin`) and `requireStaff` in the app. The first two are
  the ones that matter; the app check gives friendly redirects. A person's
  permissions are what their role implies (`private.role_implies`: admin
  all, manager all but `manage_staff`, mechanic none) plus their
  exceptions; the app mirrors that rule in `roleImplies`
  (`src/lib/auth/permissions.ts`) and a database test proves the two agree.
  Rules decided by role rather than permission use `private.is_admin()`
  (admin-only settings) or `private.can_record_refunds()` (admin or
  manager), mirrored by `{ admin: true }` and `{ roles: [...] }` in the
  app's guards ([ADR-021](decisions/ADR-021-staff-roles.md)).
- Who reaches which data: staff-only base tables; customers only through
  security definer `my_*` RPCs and `claim_my_customer` (Phase 11);
  anonymous visitors only through `reporting.public_items`,
  `public_appointment_types`, `public_shop_hours`, `available_slots`,
  `bookable_slots` and, holding a quote's link, `quote_by_token` and
  `answer_quote` (Phase 13); the service role only in `src/lib/admin/`
  and `src/lib/integrations/` (Shopify, quote emails and, from Phase 14,
  the Stripe RPCs; step 2's quote page reaches the service role only
  through `src/lib/integrations/stripe/checkout.ts`, and anon gains
  nothing) ([ADR-003](decisions/ADR-003-customer-access.md),
  [DATA-MODEL §15](DATA-MODEL.md#15-row-level-security-matrix)).
- Storage: bucket `media-internal` is private (staff policies, plus a
  customer's read of their own customer-visible bike and job photos,
  D124, so the public site signs URLs with the customer's session);
  `media-public` is public by URL with no listing policy for anonymous
  users ([20261004000800_media_storage.sql](../supabase/migrations/20261004000800_media_storage.sql)).
- Money: `numeric` domains in Postgres do the authoritative arithmetic;
  `decimal.js` in [src/lib/money.ts](../src/lib/money.ts) only formats and
  previews. Customer payments (Phase 14) are money held against a job, not
  revenue: they are not a branch of recognition, totals, yield or Cult
  Commons (D154); Stripe's integer cents are converted in Postgres, and the
  amount sent to Checkout comes from Postgres too.
- Time: every shop-day computation goes through `private.shop_day()` /
  `private.shop_today()` (Asia/Singapore, D35); the TypeScript mirror is
  [src/lib/dates.ts](../src/lib/dates.ts).
- Correlation: `src/proxy.ts` sets `x-request-id`; the server client sends
  it as `x-correlation-id`; RPCs store it on event rows
  (`private.current_correlation_id()`); logs carry it
  ([ADR-001 A8](ADR-001-architecture.md#a8-observability)).
- Idempotency and concurrency: mutations take client-made ids (line, request,
  appointment ids) and replay instead of duplicating; rows are locked FOR
  UPDATE and stock, appointment days and the last-admin check use
  transaction advisory locks.
- Sales and reporting (Phase 6; the screens since step 4): every sale line,
  in-store now and Shopify in Phase 10, is written by one function,
  `private.sell_line` (the line with its snapshots, its linked
  `retail_sale` / `online_sale` movement, the unit and the consignment
  item), called by `record_retail_sale` after the request's own header
  insert and the stock, unit and item locks. Revenue reaches the reports
  through one view: `reporting.financial_lines` unions the sale lines
  with the workshop lines, and `reporting.daily_summary` sums it (plus the
  consigned entries for its consignment columns); the Phase 5 RPCs gate
  it unchanged. The consignor ledgers are views over the item position
  and the settlements, so owed, paid and outstanding are never stored
  ([DATA-MODEL §8, §9, §14](DATA-MODEL.md#8-sales-non-workshop-revenue)).
- Where each consignor's stock is (D54, from the Phase 6 review): every
  movement of a consigned product names its consignment item, so
  `private.consignment_item_on_hand(item, location)` is derived from the
  ledger like product on-hand, never stored; sales, job parts, returns,
  transfers and `saleable_stock` read it under the product's stock lock,
  so a consignor is charged only for stock that was where it was sold
  ([ADR-016](decisions/ADR-016-consignment-and-sales.md)).
- Purchasing (Phase 7): a delivery is one `receive_purchase` call with a
  client-made idempotency key per submission; a replay returns the first
  receipt, and a lost response is resolved by looking the key up
  (`purchase_receipt_by_key`) before any retry. Stock enters the ledger
  through `private.record_receipt_movement`, beside `record_movement` and
  Phase 6's `record_linked_movement`; Phase 6's movement rules still apply,
  and purchasing holds shop-owned counted products only (D62), so consigned
  stock never arrives on a PO. Lock order: the PO row, then
  `private.lock_stock` per product in ascending id, then products and
  supplier links (the header of `20261005000100_suppliers.sql`). Purchase
  costs are for `view_costs` or `manage_purchasing` through definer
  `*_staff` views ([ADR-018](decisions/ADR-018-purchasing.md)).
- The customer's quote page (Phase 13 step 3, D143): the Admin's only page
  for people who are not staff, `/quote/<token>` in its own route group
  `(customer)` (no staff shell). `isPublicPath` lets it through
  `proxy.ts`; the page and its action read and answer through
  `createAnonClient()` (anon key, no session), so a signed-in staff member
  opening a link sees and does exactly what the customer would. Only the
  token's SHA-256 is stored, so the link is shown to staff once when sent.
  `next.config.ts` sends `Referrer-Policy: no-referrer`,
  `X-Robots-Tag: noindex, nofollow` and `Cache-Control: private, no-store`
  for it, and the page counts each view and answer per client address and
  per token in `note_sign_in_attempt`'s counters (`quote-` keys, digests
  only) before calling the database, failing open because the token
  cannot be guessed and a quote is answered once
  ([R-078](RISKS.md#r-078--whoever-holds-a-quote-link-can-answer-it)).
- Outbound email (Phase 13 step 3, D144): Auth's codes go through
  Supabase's SMTP settings; the Admin's own email (quote links) goes
  through Resend's HTTP API from the send-quote action, with the quote id
  as the idempotency key, only when `RESEND_API_KEY` and `EMAIL_FROM` are
  set ([R-079](RISKS.md#r-079--email-quotes-need-the-resend-domain-and-api-key)).
- Period reports (Phase 9): every figure is a step 1 RPC over the current
  source records (`reporting.report_lines`); nothing is stored, and the
  app adds no money up. The CSV export is the app's first Route Handler,
  `src/app/(staff)/reports/export/route.ts`, beside the screen rather than
  under `src/app/api/**`. Route Handlers are public endpoints and the
  `(staff)` layout does not run for them: `proxy.ts` redirects a
  signed-out GET to `/login`, and the handler authorizes itself with
  `getSession()`, `getStaff()` and `hasPermission()` (401 without a
  session, 403 for non-staff or a missing permission, text/plain, no
  detail). It pages around PostgREST's max-rows (1,000) by keyset, stops
  at 50,000 rows (413) and checks the integer line counts against
  `report_period_summary`, retrying once before a 409
  ([R-057](RISKS.md#r-057--csv-exports-stop-at-50000-rows-and-refuse-when-figures-change-mid-export),
  [ADR-001 A2](ADR-001-architecture.md#a2-three-layers-one-direction)).
- Reconciliation and exceptions (Phase 9 step 3, D106–D108): there is no
  stock balance cache; reconciliation is three read-only `reporting` views
  over the ledger (`unit_ledger_disposition`, `unit_reconciliation`,
  `stock_reconciliation`) read through two staff RPCs, and its issues also
  flow into the ONE exceptions surface (`reporting.operational_exceptions`,
  `public.operational_exceptions`, `report_exception_counts`, Today's
  `exceptions_now`). Who sees which kind is one function,
  `private.exception_visible`, so the list, the counts and Today agree per
  caller. Fixes are links to the existing guarded RPCs, never automatic.
  Phase 10's `private.integration_exceptions()` is the integration
  extension point, created here only if absent so both merge orders work.
  The flow (step 4): the database decides each issue and who sees it; the
  app only words and links it. `/reports/exceptions` reads
  `operational_exceptions(200)` and `report_exception_counts()` in
  parallel and groups the rows by kind; `/reports/reconciliation` reads
  the two reconciliation RPCs with `p_only_issues` and `p_product_id` from
  the URL. Every row links to its record, where the existing guarded flow
  is the fix; the threshold is the only write (a Server Action, admin,
  `refresh()`). Today keeps its 20-row `ExceptionList` and links to the
  full list. The export Route Handler gained three snapshot kinds for any
  active staff member, `exceptions`, `stock` and `units` (one entry in
  `EXPORT_KINDS`, one fetcher in `EXPORT_FETCHERS` each; no cost column),
  which refuse with 413 rather than write a list cut at the RPC caps (200
  and 1,000)
  ([R-058](RISKS.md#r-058--phase-9s-exceptions-migration-must-be-re-verified-when-phase-10-merges);
  [ADR-022](decisions/ADR-022-reporting.md#2026-10-06-stock-reconciliation-and-operational-exceptions-d106d108)).
- Search: `staff_search` is one function replaced whole by each phase that
  adds a kind; the latest (`20261005000400_purchasing_search.sql`) carries
  every kind, and a DB test checks it against `SEARCH_KINDS`.
- Labels (Phase 8, [ADR-017](decisions/ADR-017-labels-and-qr-base.md)):
  the QR base is `shop_settings.public_site_url` only. The database
  computes every printed payload (`private.qr_payload` into
  `print_jobs.qr_payload`); the app never builds one for printing, and
  every QR URL it displays comes from the same column through
  `src/lib/qr.ts`. `NEXT_PUBLIC_PUBLIC_SITE_URL` is read only in
  `src/lib/env.ts` and `src/lib/qr.ts`, as an extra accepted SCAN base
  (`tests/unit/qr-base-sources.test.ts` enforces it). Label text comes only
  from `print_jobs.content` or `label_preview`, parsed by a strict schema;
  rendering a job (sheet, PDF, history preview) uses only its content,
  template and printer snapshots (`buildLabelDocument`), and only an open
  job (queued, rendered) is rendered for printing (D59): the PDF route
  answers 409 for a finished job, whose print view shows the outcome and
  "Print again" instead. The print view lives in the `(print)` route group,
  outside the staff shell, so `window.print()` prints labels only (the
  toast region is `print:hidden`); its layout calls `requireStaff()` and so
  does the page. The PDF Route Handler calls `authorizeStaff`, whose
  `redirect()` / `forbidden()` become a 307 to /login and an empty 403 in a
  Route Handler (verified in `next/dist/server/route-modules/app-route`
  and the `forbidden` API reference).
  The record pages (product, unit, bike) load the record and call
  `notFound()` first, then `getLabelContext`, which never throws for
  "printing unavailable" (archived, unique product, QR address not set, no
  template, or the record gone: `label_preview`'s P0002 maps to
  `not_found`): a misconfiguration disables Print label with the reason
  and cannot take the page down, and an unknown id is a 404 (the bike page
  asked before `notFound()` until the Phase 8 review). The print sheet is a
  client component given only the label preview, templates and printers;
  it starts a job with `createPrintJobAction` keyed by an id minted when the
  sheet opens and remembers the printer per device in `localStorage`
  (a convenience, never data). "Print again" is a link to the record with
  `?print=1&qty=N&reprint={job}`, so a reprint is always a new job created
  from the current label. The deep link is spent once: closing the sheet
  `router.replace`s the address without it, and printing from it replaces
  its history entry with the print view (a push would leave it, and Back
  would rebuild the page and reopen the sheet with a fresh job id).
  `createPrintJobAction` calls `refresh()` (ADR-001 A6), so the record's
  Recent prints are current when staff come back.
- Errors: `P0001` with a stable code, `42501` for authorization, `P0002` for
  missing rows; mapped in [src/lib/db-errors.ts](../src/lib/db-errors.ts)
  ([DATA-MODEL §16](DATA-MODEL.md#16-rpc-catalogue-security-definer-in-public)).

## Evidence and limits

| Concern | Measured fact | Assumption or unknown | Revisit trigger |
|---|---|---|---|
| Concurrency | Races are tested on separate connections: `tests/db/workshop-concurrency.test.ts`, `reporting-concurrency`, `staff-concurrency`, `appointment-concurrency`, `consignment-concurrency` (Phase 6 steps 1 and 2 and the review fixes: intake, returns, parts, completions, sales, settlements, refunds and restocks; each case proves the second call waits on a lock), `purchasing-concurrency` (Phase 7: the same receipt key twice, two keys racing for one line, a receipt against a quantity change or a job part, opposite-order receipts, racing preferred links) and the "under concurrency" block of `inventory-ledger.test.ts` (skipped in existing-database mode); all passed in `npm test` on `feat/p7-purchasing` at the Phase 7 integration (102 files, 1517 tests) and again after its review fixes (102 files, 1518 tests), every concurrency file above included | Behaviour under real shop load | First hosted use |
| Load and latency | Period reports only: `scripts/bench/report-volume.sql` on a year of synthetic data (15,021 jobs, 51,025 work-order lines, 10,004 sale lines, 101,045 movements) measured every report RPC under its target on 2026-10-06 (a month ≤ 93 ms, a year ≤ 451 ms, a line-items page ≤ 35 ms, stock value 15 ms; [DATA-MODEL §14](DATA-MODEL.md#14-reporting-views-schema-reporting)); step 3 added 3,006 unique units: reconciliation 50–88 ms and the exceptions list 390 ms (targets 500), but the exception counts 257 ms (target 150) and `today_dashboard` 8.8 s, almost all Phase 5's `daily_summary` for one day; step 4's re-run moved within the machine's noise (a year's series 522 ms, reconciliation 48–90 ms, list 402 ms, counts 259 ms, Today 9.5 s) ([R-059](RISKS.md#r-059--today-and-the-exception-counts-are-slow-at-a-busy-years-volume)); screens not measured | Single shop, a few staff; hosted latency unknown | Slow screens reported; a report query changes (re-run the bench) |
| Upload size | 20 MiB per object on both buckets (`file_size_limit` 20971520); photos are scaled to at most 2048 px and re-encoded as JPEG in the browser first (`prepare-photo.ts`) | Hosted Storage limits per plan | Hosted project created |
| Hosted behaviour | Every migration applied to the hosted production project unchanged and the owner signed in with a code (2026-10-12); no test suite has run against a hosted database | Platform roles, Auth settings and versions may differ | [R-001](RISKS.md#r-001--nothing-is-deployed), [R-003](RISKS.md#r-003--the-devstack-differs-from-hosted-supabase) |
| Labels | Payloads are exactly `{public_site_url}/q/{short_id}` on the print view and in the PDF (`tests/e2e/print-view.spec.ts`, journey 3: ten identical link URIs); the QR decodes to the payload (`tests/unit/printing/label-svg.test.tsx`, ZXing); `reporting.public_items` returns identical rows to anon and to staff (`tests/db/labels.test.ts`) | Output on a real label printer and on iOS AirPrint is untested ([R-075](RISKS.md#r-075--label-output-is-unverified-on-a-real-label-printer-and-on-ios)); print success is confirmed by hand ([R-076](RISKS.md#r-076--print-success-is-confirmed-by-hand)) | First printer purchased, or Phase 12 |
| Recovery | No backup or restore exercised | Unknown plan tier | [R-002](RISKS.md#r-002--no-backups-monitoring-alerting-or-exercised-recovery) |

## Where an incoming engineer should look

- [R-001](RISKS.md#r-001--nothing-is-deployed),
  [R-002](RISKS.md#r-002--no-backups-monitoring-alerting-or-exercised-recovery)
  and [R-003](RISKS.md#r-003--the-devstack-differs-from-hosted-supabase):
  production only (no staging), no exercised recovery, and the local
  platform is a re-creation.
- [R-009](RISKS.md#r-009--the-seven-pr-stack-is-unmerged-and-the-purchasing-track-forks-from-pr-6):
  the stack is merged; purchasing is integrated with `main` on its branch
  and waits for its PR; email sign-in is integrated on top of it
  (`feat/auth-email-otp`, PR #10, merged after #9); labels
  (`feat/p8-labels`) holds `main` at `a1aebf6` and waits for its PR;
  Shopify is on its own branch.
- [R-035](RISKS.md#r-035--logins-created-before-email-codes-keep-a-known-password-until-the-pre-deploy-reset)
  to [R-039](RISKS.md#r-039--hosted-email-delivery-and-auth-settings-are-unverified):
  what email sign-in leaves open (the pre-deploy password reset, Auth's
  password grant, hosted SMTP); the D27
  change ([R-007](RISKS.md#r-007--consigned-stock-cannot-be-a-job-part-yet))
  was built in Phase 6 step 1.
- [R-018](RISKS.md#r-018--four-sections-are-placeholder-pages):
  Reports is a placeholder by design, not a defect (consignment and sales
  were built in Phase 6, purchasing in Phase 7, labels in Phase 8).
- The lock order and the single helpers in
  [DATA-MODEL §7](DATA-MODEL.md#7-inventory-movement-ledger) before touching
  any stock path: work order → line → stock → bikes → units → consignment
  items (step 6, Phase 6) → products, after a request's own idempotency
  lock and a consignor FOR SHARE.
