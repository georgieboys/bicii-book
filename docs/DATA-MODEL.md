# BICII Admin — Data model

Companion to [PLAN.md](./PLAN.md) and [ADR-001](./ADR-001-architecture.md). The
authoritative requirements are in [SPEC.md](./SPEC.md); this document turns
them into tables, constraints, functions and views. Where this document adds
structure the spec did not prescribe (join tables, idempotency keys, generated
columns) that is implementation mechanics the agent is free to refine. Where a
choice would change business semantics it is listed under **Open decisions** in
PLAN.md (records in [decisions/](decisions/README.md)) and must not be changed
silently.

Conventions used throughout:

- Every table: `id uuid primary key default gen_random_uuid()`,
  `created_at timestamptz not null default now()`, and `updated_at` maintained
  by a shared trigger where the row is mutable. `updated_at` is not an audit
  log; auditable facts get their own event or ledger row.
- Money: domain `money_amount` = `numeric(12,2)`. Rates: domain
  `rate_fraction` = `numeric(5,4)` (0.3000 = 30%; tables add their own
  range checks). Both domains reject `NaN` (`check (value <> 'NaN')`):
  Postgres numeric accepts it, it poisons every sum, and it passes range
  checks because NaN sorts above every number. Every other numeric column
  uses a domain with the same check too (a meta test requires it), e.g.
  quantities on line items are domain `line_quantity` = `numeric(10,2)`
  (added with the first line-item table, Phase 3), with a check that
  inventory-backed lines are whole numbers. Quantities on stock
  are `integer`.
- Every money-bearing row carries `currency char(3) not null default 'SGD'`.
- Timestamps are `timestamptz`. Display defaults to `Asia/Singapore`.
- Soft delete is `archived_at timestamptz null`; archived rows stay readable to
  historical references and are hidden from pickers.
- Human IDs come from dedicated sequences, are never reused, and live in a
  `short_id` or `*_number` column with a unique index:
  `B-000123` bikes, `J-000456` work orders, `P-000789` products, `U-000012`
  inventory units, `PO-000034` purchase orders, `C-000056` consignment items.
- Enums are Postgres `enum` types. Adding a value is a migration; that is the
  intent, because statuses are business facts.
- Schemas: `public` holds tables, RPCs and views (exposed through PostgREST);
  `private` holds security-definer helpers that must not be callable through
  the API; `reporting` holds views only.

## Authority, applied state and implementation status

This section was added by the documentation retrofit (2026-10-05, inspected
at `c6bf6d0`). The numbered sections below are never renumbered; code and
migration comments cite them as "DATA-MODEL §n".

**Authority.** The schema source is the 71 files in
[supabase/migrations/](../supabase/migrations/), from
`20261004000100_foundation.sql` to
`20261014001500_payment_reports.sql` (Phase 6 added `20261004003300` to
`20261004003700`; Phase 8, labels, added `20261004003800_labels.sql` and
Phase 10, Shopify, `20261004003900_shopify_integration.sql`,
`20261004004000_shopify_order_processing.sql` and
`20261004004100_shopify_product_sync.sql`; Phase 7, purchasing,
integrated onto the main line on `feat/p7-purchasing`, added
`20261005000100` to `20261005000500`, which sort after every `20261004…`
file; staff email sign-in, integrated on `feat/auth-email-otp`, added
`20261005005000_staff_session_revocation` and
`20261005006000_sign_in_throttle`, which sort after purchasing's and
create only new objects: no function, view, policy, grant or trigger they
define is also defined by a main-line or purchasing migration; staff
roles added `20261006000100_staff_role_values`,
`20261006000200_staff_role_permissions` and
`20261006000300_staff_role_administration`, which sort after both and
replace, with the same signatures, `private.has_permission`,
`public.my_staff_profile`, `public.record_sale_refund`, `create_staff`,
`private.authorize_permission_change`, `grant_permission`,
`set_staff_active` and `update_staff`, D90–D94; Phase 9, reporting,
added `20261006001000_report_periods`, `20261006001100_report_stock_value`,
`20261006001200_stock_reconciliation` and
`20261006001300_operational_exceptions`, which sort after the roles ones
and replace `reporting.financial_lines` (same columns, one added
exclusion), `reporting.operational_exceptions` (Phase 5's nine columns,
then six appended), `public.operational_exceptions` (dropped and created
again with the appended columns) and `public.today_dashboard` (same
signature), add `shop_settings.consignment_settlement_alert_days` and
otherwise create new objects, D100–D108; Phase 11 step 1 added
`20261006103000_public_site`, which creates only new objects:
`claim_my_customer`, `bookable_slots`,
`private.customer_can_read_media` and the Storage policy
`media_internal_select_customer`, D120–D125; Phase 13 step 1 added
`20261014000100_indent_enum_values` (seven `work_order_event_type`
values, on their own because a new enum value cannot be used in the
transaction that adds it) and `20261014000200_indent_parts`, which
creates only new objects (§5 "Indent parts and quotes"), D140–D147;
Phase 14 step 1 added `20261014000300_payment_enum_values` (three
`work_order_event_type` values, on their own for the same reason) and
`20261014000400_stripe_payments`, which creates only new objects (§19),
D150, D153, D155, D157–D159; Phase 14 step 2 added
`20261014000500_indent_deposits`, which adds
`shop_settings.indent_deposit_percent` and `quotes.deposit_percent` and
`deposit_amount` (with the `quotes_deposit_snapshot` trigger), replaces
with the same signatures `private.quote_view`,
`private.integration_exceptions` and `private.exception_visible`, drops
and creates again `public.order_part_requests` with `override_reason`, and
otherwise creates new objects (§5 "Indent deposits", §19), D151, D152,
D154, D157, D158; the recheck of Phase 14 added
`20261014000600_payment_exception_dedupe`, which replaces
`private.integration_exceptions` again with the same signature, D159b;
and the follow-up to the owner's live test of 2026-10-15
([R-082](RISKS.md#r-082--approved-indent-parts-can-be-left-unfitted-on-a-completed-or-collected-job))
added `20261014000700_indent_closed_jobs`, which replaces with the same
signatures `public.cancel_part_request` (D149), `public.withdraw_quote`,
`public.order_part_requests` and `private.quote_view`, replaces
`public.payment_issues` (same columns, a ninth issue) and
`public.work_order_payment_totals` (one column appended), and creates
`public.work_order_unfitted_requests`; no enum value, table or column;
then the owner's decisions D149a and D149b (2026-10-15) added
`20261014000800_outside_purchase_enum` (the `movement_type` value
`outside_purchase`, on its own for the same reason) and
`20261014000900_indent_settle_and_outside_purchase`, which adds the CHECK
`inventory_movements_outside_purchase_shape`, the column
`job_part_requests.outside_purchase_movement_id` (with its CHECK, unique
index and column grant), `public.fit_part_bought_outside` and two
`work_orders` triggers (`work_orders_require_settled_requests`,
`work_orders_withdraw_open_quote`), and withdraws once the quotes left
open on jobs that were not open; it replaces no existing function (§5
"Closing indent items"); then the owner's decision D160 (2026-10-15,
[R-083](RISKS.md#r-083--a-fitted-indent-request-whose-line-was-voided-is-stuck-and-unflagged))
added `20261014001000_part_unfitted_enum` (the `work_order_event_type`
value `part_request_unfitted`, on its own for the same reason) and
`20261014001100_indent_unfit_on_void`, which adds
`private.unfit_part_request`, the triggers
`work_order_line_items_unfit_part_request` and
`job_part_requests_require_live_line` with their functions, and un-fits
once the requests left fitted on a voided line; it replaces no existing
function (§5 "Voiding a fitted indent line"); then Phase 14 step 3's
database (PR A; D154, D156, D161) added
`20261014001200_payment_step3_enums` (the `work_order_event_type` values
`balance_link_sent`, `balance_link_withdrawn`, `counter_payment_recorded`
and `counter_payment_voided`, on their own for the same reason),
`20261014001300_counter_payments` (the enums `counter_payment_method` and
`counter_void_kind`, `counter_payments`, `counter_payment_voids`, their
guard and fingerprint helper, `record_counter_payment` and
`void_counter_payment`; it replaces `public.quote_deposits` (one column
appended), `public.work_order_payment_totals` (a row for every job, three
columns appended) and `public.payment_issues` (one column appended, four
issues added)), `20261014001400_balance_links` (`balance_links`, its
guard, `payments.balance_link_id` with its CHECK and the unique index
`payments_one_open_balance`, the `work_orders` trigger
`work_orders_withdraw_balance_link`, `send_balance_link`,
`balance_by_token`, `prepare_balance_checkout` and
`record_balance_checkout`; it replaces with the same signatures
`public.prepare_deposit_checkout` and `public.record_deposit_checkout`)
and `20261014001500_payment_reports` (three indexes,
`reporting.payment_movements`, `report_payment_summary`,
`report_payment_items` and `report_payments_held`); none of them
replaces any other existing function (§19)).
The labels and Shopify
migrations sort before the purchasing, sign-in, roles, reporting and
public-site ones, and no function, view, policy, grant, trigger or type
that `20261004003800_labels.sql` or `20261004003900` to `20261004004100`
(Shopify) creates or replaces is created or replaced by any of them
(checked at the merge of `main` into `feat/p8-labels`, and again at the
merge of `feat/p8-labels` into `feat/p10-shopify`, 2026-10-06, by
matching every `create`, `create or replace`, `drop`, `alter`, `grant` and
`revoke` target of those four files against the `20261005…` and
`20261006…` files, and for `20261006103000_public_site` when labels and
then Shopify joined `main`), with one deliberate exception: Phase 9's
`20261006001300_operational_exceptions` replaces the
`reporting.operational_exceptions` view that Shopify's
`20261004004000_shopify_order_processing` last defined, and keeps its
`integration_failed` rows by reading the same
`private.integration_exceptions()`, which it creates as an empty
placeholder only where Phase 10's is absent
([R-058](RISKS.md#r-058--phase-9s-exceptions-migration-must-be-re-verified-when-phase-10-merges),
verified when reporting joined `main`). The labels migration's only
change to an existing object is `shop_settings_public_site_url_check`,
and the Shopify migrations' are new columns on `products`, `customers`
and `sales`, which no later migration touches. So the label and Shopify
guards (`private.require_staff`, `private.require_admin`,
`private.is_staff`, `private.is_admin`, `private.has_permission`) follow
the roles unchanged: every role prints labels, and label templates,
printers and the QR address stay role `admin` only (D91; a manager is not
an admin; `tests/db/labels.test.ts` proves both for a manager); a manager
holds `manage_inventory` (Publish online, Sync now) by role, while the
Shopify settings stay `require_admin` (D86, D91).
[src/lib/database.types.ts](../src/lib/database.types.ts) is generated from
them by `npm run db:types`, and CI fails when it drifts
(`npm run check:types` in [ci.yml](../.github/workflows/ci.yml)).
[tests/fixtures/api-surface.ts](../tests/fixtures/api-surface.ts) is the
allow-list of every function and privilege the API roles hold, enforced by
[tests/db/meta.test.ts](../tests/db/meta.test.ts). This document explains
meaning; where it disagrees with a migration, the migration wins and this
document is corrected.

**Applied state.**

- Local: on 2026-10-17 SGT, after `npm run db:reset` on
  `claude/brave-clarke-kfqhgt` with
  `20261014001500_payment_reports`
  (`npm run test:e2e` resets the same database),
  `psql postgresql://postgres:postgres@127.0.0.1:5432/bicii_dev -Atc "select count(*), max(version) from supabase_migrations.schema_migrations"`
  printed `71|20261014001500` (every file applied). The hosted project
  does not have `20261014001200` to `20261014001500` yet (PR A is not merged;
  `migrate.yml` applies it on merge).
- CI: the `check` job diffs the generated types against a throwaway
  database built from the migrations, and the `test` and E2E jobs run
  `npm run db:reset` (migrations, then the seed) before testing
  ([TESTING.md](TESTING.md#ci)).
- Hosted: `migrate.yml` prints the history before and after each push
  ([RUNBOOK](RUNBOOK.md#applying-migrations-to-a-hosted-project)). On
  2026-10-12 run 10 applied all 56 files to the production project; the
  Phase 13 and Phase 14 merges added the rest, and on 2026-10-14, after
  PR #24 merged, its migration history held 61 versions, the last
  `20261014000500` (read-only); PRs #25–#27 added `20261014000600` to
  `20261014000900`, and on 2026-10-15 its history held all 65 versions,
  the last `20261014000900` (read-only). PR #30 added `20261014001000`
  and `20261014001100` (D160), applied by run 16; on 2026-10-16 the
  history held all 67 versions, the last `20261014001100` (read-only).
  There is no staging project
  ([R-001](RISKS.md#r-001--nothing-is-deployed)).

**Implementation status on this branch.** Determined by matching each
section's tables, views and functions against `create table`, `create view`
and `create function` statements in the migrations (file names below drop
the `20261004` prefix; Phase 7's keep `20261005`). For planned tables, the rows of §15 and the RPCs of
§16 are design, not schema.

| Section | Status | Where, or what is missing |
|---|---|---|
| §1 Identity and authorization | Implemented | `000200_staff`, `000300_staff_management`, `000500_staff_history`; staff email sign-in: `20261005005000_staff_session_revocation` (D71) and `20261005006000_sign_in_throttle` (D72); staff roles (D90–D94): `20261006000100_staff_role_values`, `20261006000200_staff_role_permissions`, `20261006000300_staff_role_administration`, all three applied locally (`47\|20261006000300`; screens: `src/app/(staff)/settings/staff/`, `src/app/(staff)/settings/profile/`; integration-reviewed 2026-10-06) |
| §2 Customers, bikes, attachments | Implemented | `000600_customers`, `000700_bikes`, `000800_media_storage`, `000900_attachments`, `001000_customer_access`, `001100_staff_search`; Phase 11's customer link and photo policy in `20261006103000_public_site` |
| §3 Shop hours and appointments | Implemented | `002700_appointment_enum_values` to `003200_appointment_reporting` (Phase 2); `bookable_slots` in `20261006103000_public_site` (Phase 11) |
| §4 Workshop | Implemented | `001300_work_orders`, `001500_workshop_rpcs`, `001600_workshop_customer_access`, `001700_workshop_search` |
| §5 Services and line items | Implemented | `001200_workshop_catalog`, `001400_work_order_lines`, `001500_workshop_rpcs`; consigned-part columns `003300_consignment`, their rules `003400_consignment_job_parts` (D44); indent parts and quotes `20261014000100`, `20261014000200` (D140–D147), their deposits `20261014000500` (D151, D152, D158), and on completed and closed jobs `20261014000700_indent_closed_jobs` (D149's cancel, the order and withdraw guards, `work_order_unfitted_requests`, the quote page's `job_closed`; R-082); closing indent items `20261014000800_outside_purchase_enum`, `20261014000900_indent_settle_and_outside_purchase` (D149a's `fit_part_bought_outside`, D149b's settle guard, D149c's quote withdrawal); voiding a fitted indent line `20261014001000_part_unfitted_enum`, `20261014001100_indent_unfit_on_void` (D160's un-fit trigger, the live-line guard and the one-off; R-083); a counter deposit makes a deposit paid since `20261014001300_counter_payments` (D161f, §19) |
| §6 Catalog and inventory | Implemented | `001800_inventory`, `002100_inventory_publication`, `002200_inventory_search`; `003300_consignment` adds the units' consignment foreign key, ownership rules and the consignment branch of `private.selling_price`; the sale-line columns have their foreign keys since `003500_sales`; the Shopify id rules (gid checks; `shopify_product_id` no longer unique, D84) since `003900_shopify_integration`; `supplier_products` is Phase 7's (§10) |
| §7 Inventory movement ledger | Implemented | `001800_inventory`, `001900_inventory_jobs`, `002000_inventory_reporting`; `003300_consignment` adds the consignment foreign key, D50's movement rules and `private.record_linked_movement`; `003500_sales` adds the sale-line foreign keys and `inventory_movements_restock_once`; `20261005000300_purchase_receiving` adds the receipt-line foreign key, `inventory_movements_purchase_received_has_receipt_line` and `private.record_receipt_movement`; `20261014000800`, `20261014000900` add the type `outside_purchase` and `inventory_movements_outside_purchase_shape` (D149a) |
| §8 Sales | Implemented | `sales`, `sale_lines`, `sale_refunds`, `private.sell_line`, `record_retail_sale`, `restock_unit`, `record_sale_refund` (`003500_sales`; the partial unique index `sale_lines_unit_sells_once` replaces this section's plain `unique`, D46). Screens: Phase 6 step 4 (`src/app/(staff)/sales/`, `src/lib/domain/sales.ts`). Shopify orders reuse `private.sell_line` since Phase 10 step 1 (`004000_shopify_order_processing` replaces it with the same body plus `shopify_line_part`; `003900` adds the Shopify columns and `sale_lines_shopify_line_part_key`, D80) |
| §9 Consignment | Implemented | Phase 6 step 1: consignors, items, charges, item history, returns, `reporting.consignment_item_position`, consigned job parts (`003300_consignment`, `003400_consignment_job_parts`; D44–D52); step 2: settlements, reversals, the ledgers and the balance rule (`003600_consignment_settlements`; D46, D47). Screens: step 3 (`src/app/(staff)/consignment/`, `src/lib/domain/consignment.ts`); selling a consigned item in store: step 4 (Sell on the item page, `/sales`) |
| §10 Suppliers and purchasing | Implemented | Phase 7: `20261005000100_suppliers`, `…0200_purchase_orders`, `…0300_purchase_receiving`, `…0400_purchasing_search`, `…0500_purchasing_reorder` (D60–D66). Screens: `src/app/(staff)/purchasing/`, `src/lib/domain/purchasing.ts`, `src/lib/domain/suppliers.ts`. Purchases are shop-owned quantity products only (D62; consigned products are refused, `purchase_line_not_shop_owned`) |
| §11 QR identity and publication | Partly | Built: short IDs, publication rules, `reporting.public_items`, staff `/q/[shortId]`, scanner (`002100_inventory_publication`); the database QR base and payload (`private.qr_payload`, `003800_labels`, D9); the Admin's QR display and scan bases on the database base (`src/lib/qr.ts`, Phase 8 step 2). `C-` resolves to the consignment item page since Phase 6 step 3, `S-` to the sale page since step 4, `PO-` to the purchase order since Phase 7. Missing: the public `/q` route (Phase 11) |
| §12 Label printing | Partly | Database built (`003800_labels`, Phase 8 step 1: templates, printer profiles, print jobs, label content, RPCs, built-in rows); `src/lib/printing/`, `src/lib/domain/labels.ts`, the print view, the PDF route and the print history (step 2); the record pages' Labels card and the settings screens are steps 3–4; hardware adapters Phase 12 |
| §13 Shopify integration | Partly | Inbound built (Phase 10 step 1: `003900_shopify_integration`, `004000_shopify_order_processing`: settings, sync rows, events, the queue, the audit trail, webhook recording, order and refund processing, retry, dismiss and the links; D80–D89). Outbound database built (step 2: `004100_shopify_product_sync`: the online price, Publish online, Sync now, the settings RPC, the deferred enqueue triggers, the sync worker's state and result RPCs, `reporting.shopify_sync_status`, `public_items.buy_online_url`). Service layer built (step 3: `src/lib/integrations/shopify/`, the webhook and cron routes; no schema change). Screens built (step 4: the product page's Online card, `/shopify` and its queue, products, events and inspector, `src/lib/domain/shopify.ts`; no schema change). Not verified against a real store ([R-047](RISKS.md#r-047--the-live-shopify-adapter-is-unverified-against-a-real-store)) |
| §14 Reporting views | Partly | Built: `stock_levels`, `product_stock`, `low_stock`, `public_items`, `financial_lines`, `daily_summary`, `work_order_activity`, `operational_exceptions`, `appointment_daily`, and `work_order_totals` / `work_order_totals_staff` (in `public`). `consignment_item_position`, `consignor_item_ledger`, `consignor_ledger` (Phase 6; no API grant; the consignor ledgers are built and read through `list_consignors` and `consignor_statement`); `financial_lines` has its sale branch and `daily_summary` its consignment columns since `003700_consignment_reporting`. `purchase_order_progress` and `product_on_order` (Phase 7). `operational_exceptions` has its `integration_failed` rows since `004000_shopify_order_processing` (admins only, D86). `shopify_sync_status` and `public_items.buy_online_url` since `004100_shopify_product_sync` (Phase 10 step 2). `report_lines` and the period-report helpers (Phase 9 step 1, `20261006001000_report_periods`, `…1100_report_stock_value`; `financial_lines` gained only the `sa.source <> 'work_order'` exclusion). `unit_ledger_disposition`, `unit_reconciliation`, `stock_reconciliation` and the extended `operational_exceptions` (Phase 9 step 3, `…1200_stock_reconciliation`, `…1300_operational_exceptions`, which keeps Phase 10's `integration_failed` rows). `operational_exceptions` has its `payment_attention` and `stripe_attention` rows since `20261014000500_indent_deposits` (Phase 14 step 2, through `private.integration_exceptions()`, D159b). `payment_movements` since `20261014001500_payment_reports` (Phase 14 step 3, D154; no API grant; read through the three payment report RPCs). Nothing listed here is missing since reporting joined `main`; there is no `inventory_balances` cache by design (D106) |
| §15 Row-level security matrix | Partly | Rows for every built table are implemented and tested, including consignment (Phase 6 step 1), sales and settlements (step 2, D48), purchasing (Phase 7, D60), labels (Phase 8 step 1), the Shopify integration tables (Phase 10 step 1, D86), and the Stripe tables and the deposit views (Phase 14 steps 1 and 2), and the counter payments, their voids and balance links (Phase 14 step 3 PR A); the rows of later phases are design |
| §16 RPC catalogue | Partly | Rows marked "Built" exist, including the five consignment item RPCs (Phase 6 step 1) and the five sale and settlement write RPCs and six read RPCs (step 2), all with screens since steps 3 and 4 (deviations from the original rows: `record_retail_sale`, `restock_unit(unit_id, sale_line_id, location_id, reason)`, `return_consignment_item(return_id, item_id, reason, quantity, location_id)`), the fourteen purchasing RPCs (Phase 7, `receive_purchase(purchase_order_id, idempotency_key, lines, reference, received_at, notes)` among them), the five label RPCs (Phase 8 step 1), the five Shopify service-role RPCs and four staff RPCs (Phase 10 step 1), the two sync-worker RPCs and three staff RPCs of the outbound sync (step 2), the seven period-report RPCs (Phase 9 step 1: `report_period_summary`, `report_period_series`, `report_breakdown`, `report_line_items`, `report_activity`, `report_activity_by_mechanic`, `report_stock_value`), the four reconciliation and exception RPCs (Phase 9 step 3: `report_stock_reconciliation`, `report_unit_reconciliation`, `report_exception_counts`, `set_consignment_settlement_alert_days`; `operational_exceptions` gained columns) Phase 11's `claim_my_customer` and `bookable_slots`, and Phase 14's `record_stripe_event`, `record_stripe_read` (step 1), `set_indent_deposit_percent`, `prepare_deposit_checkout`, `record_deposit_checkout` and `order_part_requests` with `override_reason` (step 2), and `20261014000700_indent_closed_jobs`'s replacements with the same signatures (`cancel_part_request` with D149's admin or manager cancel on closed jobs, `withdraw_quote` refusing closed jobs, `order_part_requests` refusing jobs that are not open; R-082), and `20261014000900`'s `fit_part_bought_outside` (D149a), and Phase 14 step 3's `record_counter_payment`, `void_counter_payment`, `send_balance_link`, `balance_by_token`, `prepare_balance_checkout`, `record_balance_checkout`, `report_payment_summary`, `report_payment_items` and `report_payments_held` (PR A), with `prepare_deposit_checkout` and `record_deposit_checkout` replaced with the same signatures; the rows of later phases are design |
| §17 Sequences and short IDs | Implemented | `000100_foundation` (all seven prefixes); C is used from Phase 6 step 1 (`consignment_items`), S from step 2 (`sales`), PO from Phase 7 (`purchase_orders`) |
| §19 Customer payments (Stripe) | Partly | Step 1's database built (`20261014000300_payment_enum_values`, `20261014000400_stripe_payments`: `stripe_events`, `payments`, `payment_refunds`, the guards, the apply paths, `record_stripe_event`, `record_stripe_read`, the owner's purge; D150, D153, D155, D159), proved by `tests/db/stripe-payments.test.ts`; called by the webhook route and the adapter (`src/lib/integrations/stripe/`, step 1's second commit; no schema change). Step 2's database built (`20261014000500_indent_deposits`: the deposit setting and snapshot, `quote_deposits`, `payment_issues`, `work_order_payment_totals`, the quote page's `deposit` key, `prepare_deposit_checkout`, `record_deposit_checkout`, the D152 gate, `payment_attention` and `stripe_attention`; D151, D152, D154, D158), proved by `tests/db/indent-deposits.test.ts`. Step 2's screens built: the quote page's deposit with Pay deposit (Stripe Checkout through `checkout.ts`), Settings → Customer payments, and the job's Customer payments card with *Check with Stripe* and *Open in Stripe* and the order sheet's override (bf91ea7: `src/components/domain/payments-card.tsx`, `indent-card.tsx`, `tests/e2e/payments.spec.ts`). The final review's fixes (no new migration file; the step 1 and 2 files edited before any hosted apply): `record_stripe_read` also takes a PaymentIntent, `payment_refunds.status_changed_at`, `payment_issues` without a definer helper, the quote page's `parts_ordered`. The recheck (after the steps 1 and 2 files reached the hosted project, so a new file): `20261014000600_payment_exception_dedupe` lists each Stripe problem once on Exceptions (a refund in another currency or mode as `refund_not_counted` while it is not failed or canceled, else one `stripe_attention` row per Stripe object and outcome) and gives `currency_mismatch` its own sentence. After the owner's live test (R-082): `20261014000700_indent_closed_jobs` adds `payment_issues`' `paid_parts_not_fitted` and `work_order_payment_totals.held_over_total`, proved by `tests/db/indent-deposits.test.ts`. Step 3's database built (PR A, on `claude/brave-clarke-kfqhgt`, not merged or deployed: `20261014001200` to `20261014001500`; counter payments D161, balance links D156, payment reports D154), proved by `tests/db/counter-payments.test.ts`, `balance-links.test.ts` and `payment-reports.test.ts`; the one app change is the Customer payments card showing its totals only with a Stripe or counter payment. Missing: step 3's screens (PR B: the payment page, Send payment link, Record and Void, the Reports section) |
| §18 Seed data | Implemented | Phase 1–5, Phase 2, Phase 6, Phase 7, Phase 8 and Phase 10 parts are in `supabase/seed.sql`, in that order (Phase 10's last) |

**Access summary.** The matrix is [§15](#15-row-level-security-matrix) and
the pattern is [ADR-003](decisions/ADR-003-customer-access.md).

| Actor | Reaches | Enforced by | Test evidence |
|---|---|---|---|
| anon | `reporting.public_items`, `public_appointment_types()`, `public_shop_hours()`, `available_slots()`, `bookable_slots()` (Phase 11, D123); the quote page's `quote_by_token()` and `answer_quote()` (D142, D143) and the payment link page's `balance_by_token()` (D156f), each for whoever holds the link; objects in the public bucket `media-public` by URL, with no listing ([§2](#2-customers-bikes-attachments), [§15](#15-row-level-security-matrix)); nothing else (nothing about labels) | grants, RLS, definer projections, public bucket (`20261004000800_media_storage.sql`) | `tests/db/meta.test.ts`, `inventory-publication`, `appointment-customer-access`, `labels` |
| customer (signed in) | own rows only, through `my_*` RPCs; base tables return nothing; `claim_my_customer` links or creates their record (D121, D122); the `media-internal` objects of their own customer-visible bike and job photos (D124) | staff-only RLS, `private.current_customer_id()`, the Storage policy `media_internal_select_customer` | `customer-access`, `workshop-customer-access`, `appointment-customer-access`, `public-site` |
| staff (active) | base tables through RLS; cost columns hidden | `private.is_staff()`, column grants, `*_staff` views | `staff-rls`, `work-order-lines`, `inventory-catalog` |
| staff with a permission (by role or as an exception) | costs, inventory writes, stock changes, financial reports, staff management, consignment money, purchasing (`manage_purchasing` held as an exception also sees purchase costs on purchasing surfaces, D60). A manager holds every permission except `manage_staff` by role (D91) | `private.require_permission` / `has_permission` (through `private.role_implies`) in RPCs; `private.can_view_purchase_costs()` | `staff-roles`, `permission-helpers`, `reporting-access`, `staff-management`, `inventory-ledger`, `purchasing-access` |
| manager or admin | retail refunds (D94, a role check: `private.can_record_refunds()`) | `record_sale_refund` | `staff-roles`, `sales` |
| admin | everything above plus settings, hours, rates, roles, admin and manager staff (D93), label templates and printers, the Shopify integration's events, queue, audit trail, dismissals, links and `integration_failed` exceptions (D86), and recording and voiding counter payments (D161a, a role check: a manager is refused) | `private.require_admin()`, `private.is_admin()` | `staff-roles`, `staff-management`, `staff-history`, `schedule-settings`, `labels`, `shopify-webhooks` |
| service role | bypasses RLS; exactly the allow-listed functions (`SERVICE_ROLE_FUNCTIONS`), nothing in `private`: in `src/lib/admin/` the Auth admin API (invites without a password) and `note_sign_in_attempt` (D72); since Phase 10 the Shopify webhook, queue and sync-worker RPCs (`src/lib/integrations/shopify/`); since Phase 14 the Stripe RPCs `record_stripe_event` and `record_stripe_read`, `prepare_deposit_checkout` and `record_deposit_checkout` (step 2), and `prepare_balance_checkout` and `record_balance_checkout` (step 3), to be called only from `src/lib/integrations/stripe/` | grants (each revoked from anon and authenticated), ESLint import restriction, `server-only` | `meta` ("service_role can execute exactly the allow-listed functions"), `sign-in-throttle` (anon and staff get 42501), `shopify-webhooks`, `stripe-payments` |

**Lifecycle.**

- Customers, bikes, categories, services, products and units are archived
  (`archived_at`), not deleted; stock locations and appointment types are
  switched off (`active`). Archived rows stay readable to history and hidden
  from pickers. Work orders and appointments are never deleted; they end in
  a status.
- Exceptions that are hard-deleted, each leaving an append-only event row
  with who and when:
  - photos: `delete_attachment` (any active staff member, reason required)
    deletes the `attachments` row, kept as the payload of an
    `attachment_events` 'deleted' row, and the server then removes the
    Storage object ([§2](#2-customers-bikes-attachments)); the file
    cannot be recovered (nothing is backed up,
    [R-002](RISKS.md#r-002--no-backups-monitoring-alerting-or-exercised-recovery));
  - closures: `delete_closure_override` (admin, reason required), kept in
    `schedule_events`;
  - weekly hours: `set_shop_hours` (admin) replaces a weekday's intervals,
    the old ones kept in `schedule_events` (no reason is asked);
  - permission grants (exceptions): `revoke_permission` deletes the
    `staff_permissions` row, kept in a `permission_revoked` `staff_events`
    row (no reason is asked); a role change deletes the exceptions the new
    role implies the same way, with the role change's reason (D92).
- Event and ledger tables are append-only (triggers refuse updates and
  deletes); a correction is a linked reversal or a new event.
- Financial snapshots on lines never change after the line is written.
- Short IDs come from sequences that are never reset or reused (§17).
- No retention or deletion policy for customer personal data exists
  ([R-016](RISKS.md#r-016--no-retention-or-deletion-policy-for-customer-personal-data)).
- The seed is synthetic: fixed UUIDs, `example.com` customer and
  `bicii.test` staff addresses; it is never applied to production (§18).

**Integration contracts.**

- Public site (Phase 11; repository `bicii`): the `my_*` RPCs,
  `claim_my_customer`, the anonymous `available_slots`, `bookable_slots`,
  `public_appointment_types` and `public_shop_hours`,
  `reporting.public_items` and the customer Storage policy (§11, §15,
  §16; ADR-023). Shapes only ever gain columns at the end
  ([R-067](RISKS.md#r-067--the-public-site-depends-on-this-repositorys-rpc-shapes)).
- Errors: business refusals are `P0001` with a stable snake_case code in
  `MESSAGE`, mapped to user messages in
  [src/lib/db-errors.ts](../src/lib/db-errors.ts) (§16).
- Shopify: inbound built in §13 (Phase 10 step 1): the service-role RPCs the webhook route and cron call (`record_shopify_webhook`, `claim_integration_jobs`, `process_shopify_event`); the outbound sync and `reporting.public_items.buy_online_url` (the Buy-online rule Phase 11 reads, D84) came in step 2, and the service layer that calls them (`src/lib/integrations/shopify/`) in step 3.
- Stripe (Phase 14, §19, ADR-025): the service-role RPCs `record_stripe_event` (a webhook delivery, verified on its raw bytes by the route, or rejected as evidence) and `record_stripe_read` (an object the server read with the secret key). Stripe's API version is pinned on the endpoint; the database reads only the allow-listed projection, so new Stripe fields are ignored and a missing one becomes an outcome, never a raise. Built in step 1, with the service layer that calls them (`src/lib/integrations/stripe/`, `POST /api/stripe/webhooks`, pinned to `2026-09-30.endive`) in its second commit.

## 1. Identity and authorization

```
staff
  id uuid PK
  auth_user_id uuid not null unique  -> auth.users(id)
  display_name text not null
  email citext not null unique
  role staff_role not null default 'mechanic'
                                      -- enum: admin | manager | mechanic (D90)
  active boolean not null default true
  created_at, updated_at

staff_permissions                     -- exceptions on top of the role (D92)
  staff_id uuid -> staff(id)
  permission permission_key not null  -- enum below
  granted_by uuid -> staff(id)
  granted_at timestamptz
  PK (staff_id, permission)
  -- current state only; history is in staff_events

permission_key enum:
  view_costs | manage_inventory | adjust_stock | manage_consignments |
  manage_purchasing | manage_staff | view_financial_reports

staff_events                           -- append-only history
  id uuid PK
  staff_id uuid not null -> staff(id) on delete restrict
  event_type staff_event_type not null
    -- created | details_changed | role_changed | deactivated |
    -- reactivated | permission_granted | permission_revoked
  permission permission_key null       -- set exactly for permission_* events
  actor_staff_id uuid null -> staff(id) -- null: changed outside the app (seed, SQL editor)
  payload jsonb not null default '{}'   -- what changed: {"role": {"from","to"}},
                                        -- a revoked grant's granted_by/granted_at,
                                        -- the created row's fields
  reason text null                      -- required for deactivated (by the RPC); ≤ 500 chars
  correlation_id text null              -- the request's x-request-id (ADR-001 A8)
  created_at timestamptz not null default clock_timestamp()
  index (staff_id, created_at desc), index (actor_staff_id)
```

Rules:

- Roles (D90, D91): `admin` implies every permission; `manager` every
  permission except `manage_staff` (`view_costs`, `manage_inventory`,
  `adjust_stock`, `manage_consignments`, `manage_purchasing`,
  `view_financial_reports`); `mechanic` none. New staff default to
  `mechanic`. One SQL helper holds the rule:
  `private.role_implies(role staff_role, permission permission_key) returns
  boolean` (`language sql`, `immutable`, `search_path = ''`, EXECUTE
  revoked from every API role); `has_permission` and `my_staff_profile` use
  it, so every policy, view and RPC that calls `has_permission`,
  `require_permission` or a `can_view_*` helper follows. The app mirrors it
  in `roleImplies()` / `ROLE_PERMISSIONS`
  ([src/lib/auth/permissions.ts](../src/lib/auth/permissions.ts));
  `tests/db/staff-roles.test.ts` proves the two agree for every role and
  permission.
- Effective permissions = what the role implies plus the person's
  `staff_permissions` rows; none while inactive.
- Exceptions (D92): a `staff_permissions` row is "Extra access" for one
  person on top of their role. A row the role already implies cannot exist:
  `grant_permission` refuses it (P0001 `permission_implied_by_role`), and a
  BEFORE INSERT trigger (`staff_permissions_refuse_implied`, security
  definer, reading the person's role `for share`) refuses it for every
  writer (seed, SQL editor). When a role change makes a row implied, the
  AFTER UPDATE OF role trigger `staff_role_drop_implied_exceptions` (every
  writer; named so it fires after `staff_record_history`) deletes it in the
  same transaction, which appends one `permission_revoked` event per row
  after the `role_changed` event, with the role change's actor and reason.
  A later demotion does not bring removed rows back. The triggers guard new
  writes only, so `20261006000200` also deletes, once, the rows already
  implied when it runs (`private.drop_implied_exceptions()`, security
  definer, EXECUTE revoked from every API role): before the roles an admin
  could grant to an admin and a promotion kept its rows, so a database
  migrated step by step (`db:migrate`) could hold them. Each deletion
  appends a `permission_revoked` event with no actor (no one is signed in
  during a migration) and the reason "Staff roles (D92): their role
  already includes this permission."; a fresh build has none to delete. A
  manager can therefore carry only `manage_staff` as an exception; an
  admin none.
- Refunds (D94): `private.can_record_refunds() returns boolean` (security
  definer, EXECUTE revoked from every API role): an active admin or
  manager. A role check, not a permission: no exception grants it.
- Admin-only (D91): shop settings, hours, closures, appointment types, Cult
  Commons rates, roles, and admin and manager accounts stay behind
  `private.is_admin()` / `private.require_admin()`.
- The enum value `staff` was renamed to `mechanic` (D90,
  `20261006000100_staff_role_values.sql`, `alter type ... rename value`,
  which keeps the value's OID, so stored rows and defaults followed);
  `staff_events` payloads are append-only, so a `created` or `role_changed`
  payload written before the rename still says `"staff"`, which the app
  labels Mechanic. "Staff" still means any active person
  (`private.is_staff()`).
- An update can never leave the shop without an active admin (trigger
  `staff_keep_an_active_admin`, serialised with an advisory lock).
- "Staff" in any policy means `staff.active = true` for the calling
  `auth.uid()`. Deactivating a staff member revokes everything at once.
- Deactivation also deletes the person's Supabase Auth sessions (trigger
  `staff_revoke_sessions`, D71): when `staff.active` goes from true to
  false, through `set_staff_active` or any other writer,
  `private.revoke_auth_sessions_on_deactivation()` (security definer,
  EXECUTE revoked from every API role) deletes their `auth.sessions` rows
  (refresh tokens and MFA claims cascade) and any refresh token of theirs
  without a session, in the same transaction. A refused deactivation rolls
  back with it; replays and reactivation delete nothing. An access token
  already issued and verified without asking Auth (hosted asymmetric keys)
  lives until it expires (at most `jwt_expiry`); the inactive check above
  refuses it meanwhile. The migration
  (`20261005005000_staff_session_revocation.sql`) refuses to apply where
  its role cannot delete from `auth.sessions` and `auth.refresh_tokens`
  (RUNBOOK "Applying migrations to a hosted project").
- History over overwrites (SPEC §2, §22): every insert or update of a
  `staff` row and every insert or delete of a `staff_permissions` row
  appends one `staff_events` row, written by triggers
  (`staff_record_history`, `staff_permissions_record_history`), so no path
  (RPC, seed, the RUNBOOK's first-admin SQL) skips it. A grant's actor is
  its `granted_by`; otherwise the actor is `private.current_staff_id()`. The
  reason reaches the trigger through a transaction-local setting the RPC
  sets and clears (`private.set_staff_event_reason`). Replays that change
  nothing append nothing. `staff_events` refuses UPDATE and DELETE for
  every role (`staff_history_append_only`); API roles have no grant on it
  and read it through `staff_history()`.
- Staff rows change only through RPCs: `authenticated` and `service_role`
  have no INSERT/UPDATE/DELETE on `staff` or `staff_permissions`. A BEFORE
  trigger (`staff_enforce_rules`) holds for every writer, the owner
  included: `staff.email` must equal the Auth login's email (P0001
  `staff_email_mismatch`), and a signed-in user never deactivates their
  own row (42501).
- Delegation ceiling (PLAN D11, restated for roles by D93;
  `private.authorize_permission_change`): admins grant and revoke anything
  (except an exception the role implies, above); a `manage_staff` holder
  who is not an admin acts on mechanics only, and only permissions they
  hold themselves, never `manage_staff`, never on their own row (42501).
- Role administration (D93): only an admin invites anyone as admin or
  manager (`create_staff`), changes anyone's role (`update_staff`, promote
  or demote) and changes an admin's or a manager's row (rename, deactivate,
  reactivate, exceptions). A non-admin `manage_staff` holder invites
  mechanics only and renames, deactivates and reactivates mechanics only
  (42501). Nobody changes their own role; the last active admin cannot be
  demoted or deactivated (55000, `staff_keep_an_active_admin`). Every role
  change appends one `role_changed` event (`{"role": {"from", "to"}}`) with
  its actor and an optional reason of at most 500 characters.
- Helpers in `private`, all `security definer`, `stable`, with
  `search_path = ''`:
  - `private.current_staff_id() returns uuid`
  - `private.is_staff() returns boolean`
  - `private.is_admin() returns boolean`
  - `private.has_permission(permission_key) returns boolean`: active, and
    `role_implies(role, permission)` or a `staff_permissions` row
  - `private.can_record_refunds() returns boolean` (D94)
  - `private.role_implies(staff_role, permission_key) returns boolean`
    (`immutable`, not a definer: a pure rule)
  - `private.current_customer_id() returns uuid`: the caller's
    non-archived `customers` row (Phase 1); null for anonymous callers,
    staff without a customers row and archived customers. EXECUTE for
    `authenticated` only.
  - `private.require_permission(permission_key)` raises
    `insufficient_privilege` when the caller lacks it. Every privileged RPC
    calls this first.

Customers are not staff. A person can be both (a mechanic who owns a bike) by
having a `staff` row and a `customers` row pointing at the same
`auth_user_id`.

Sign-in attempt counters (PLAN D72; migration
`20261005006000_sign_in_throttle.sql`): the Admin's own limits on `/login`,
because its Server Actions call Supabase Auth from the server, so Auth's
per-IP limits count the server's address for everyone.

```
private.sign_in_attempts               -- counters, not history
  bucket text not null                 -- 1-200 chars: "<request|verify>:<client|email>:<sha256 hex>",
                                       -- or since Phase 13 step 3 "quote-<view|answer>:<client|token>:<sha256 hex>"
  window_start timestamptz not null    -- fixed window, aligned to its length
  hits integer not null (> 0)
  PK (bucket, window_start), index (window_start)
```

- Written only by `public.note_sign_in_attempt(buckets text[],
  window_seconds integer) returns table (bucket_key text, hit_count
  integer)` (security definer, `search_path = ''`, EXECUTE for
  `service_role` only): adds one to each named bucket (named twice: once)
  in the current window with `insert ... on conflict do update`, so
  concurrent attempts are all counted, returns the counts and deletes
  counters older than a day. 1-8 buckets of 1-200 characters and a window
  of 60-3600 s, else 22023. RLS on, no policy, no grant to any API role:
  a caller who could name any bucket could fill someone else's.
- Keys hold SHA-256 digests of the client address (IPv6 per /64) and of
  the lower-cased email, never either in clear. The app
  (`src/lib/auth/sign-in-limits.ts`, `src/lib/admin/sign-in-throttle.ts`)
  builds them, holds the limits and decides.

## 2. Customers, bikes, attachments

Phase 1 migrations: `…0600_customers`, `…0700_bikes`, `…0800_media_storage`,
`…0900_attachments`, `…1000_customer_access`, `…1100_staff_search`.

```
customers
  id uuid PK
  short_id text null unique             -- optional, for search; not printed, not assigned yet
  auth_user_id uuid null unique         -> auth.users on delete set null
  first_name, last_name text null       -- ≤ 100
  display_name text null                -- fallback: first + last, else email (private.customer_label)
  email citext null                     -- NOT a key; duplicates allowed
  phone text null
  internal_notes text null              -- staff only
  shopify_customer_id text null unique  -- durable Shopify link
  search_text text generated            -- lower(names + email), trigram GIN
  phone_digits text generated           -- digits of phone, trigram GIN
  created_at, updated_at, archived_at
  check customers_identifies_someone    -- a name, an email or a phone
  -- trigger: text trimmed, blanks stored as NULL

bikes
  id uuid PK
  short_id text not null unique         -- B-000123, printed on QR for bikes;
                                        -- assigned by trigger from next_short_id('B'), immutable
  customer_id uuid null -> customers    -- CURRENT owner; null = shop / unknown
  inventory_unit_id uuid null           -- the unit this shop bike is in stock as; FK -> inventory_units
                                        -- (Phase 4, unique), set by private.register_unit; no client grant
  brand text not null, model text not null
  variant, frame_size, colour text null
  serial_number text null               -- not unique (duplicates exist)
  description text null, internal_notes text null
  serial_key text generated             -- upper(serial) without punctuation; btree + trigram
  search_text text generated            -- lower(brand model variant colour); trigram
  created_at, updated_at, archived_at

bike_ownership_events                   -- append-only
  id, bike_id
  event_type bike_ownership_event_type  -- registered (created with an owner) | transferred
  from_customer_id null, to_customer_id null
  reason text                           -- required for transferred; ≤ 500
  actor_staff_id null, correlation_id, created_at (clock_timestamp)
  -- written by the bikes trigger; bikes.customer_id is the current owner

attachments
  id uuid PK                            -- chosen by the server before upload (it is in the path)
  entity_type attachment_entity not null  -- enum: bike | work_order | product |
                                          --   inventory_unit | customer | consignment_item
  entity_id uuid not null               -- validated by private.attachment_entity_exists
  storage_bucket text not null          -- 'media-public' iff visibility = public, else 'media-internal'
  storage_path text not null unique     -- {entity_type}/{entity_id}/{id}.{ext}, ext matches media_type
  media_type text not null              -- image/jpeg | png | webp | heic | heif
  byte_size integer                     -- from Storage's object metadata when present
  width, height integer null
  caption text null                     -- ≤ 500
  visibility attachment_visibility not null default 'internal'
                                          -- enum: internal | customer | public
  created_by uuid -> staff
  created_at, updated_at
  index (entity_type, entity_id, created_at)
  check: a `customer` entity's attachment is never `public` (PLAN D13),
         nor a `work_order` entity's (PLAN D19, Phase 3)

attachment_events                       -- append-only; outlives deleted attachments
  id, attachment_id (no FK), entity_type, entity_id
  event_type attachment_event_type      -- created | visibility_changed | caption_changed | deleted
  actor_staff_id null, payload jsonb, reason (required for deleted), correlation_id, created_at
```

Rules:

- History over overwrites. Every owner change of a bike appends a
  `bike_ownership_events` row from a trigger, so no writer skips it; an
  owner change without a reason raises `reason_required` for every writer
  (RPCs pass the reason through the transaction-local
  `private.set_change_reason`). `authenticated` has no column grant on
  `bikes.customer_id` after insert: transfers go through
  `transfer_bike_ownership`. Archived customers receive no bikes
  (`customer_archived`); archived bikes are not transferred
  (`bike_archived`).
- Attachments are created only by `record_attachment`, which checks the
  object is in `storage.objects` at the canonical path (it reads the table
  as the function owner, which bypasses RLS on hosted Supabase and
  locally), moved only by `set_attachment_visibility`, deleted only by
  `delete_attachment` (reason required, the deleted row is kept in the
  `deleted` event's payload; ids are never reused). Staff may edit a
  caption directly (recorded as `caption_changed`).
- Entity types grow by phase. `private.attachment_entity_exists` knows
  `customer`, `bike` and (Phase 3) `work_order`, returns null for the rest (`record_attachment`
  raises `attachment_entity_unsupported`); the migration that creates
  `work_orders`, `products`, `inventory_units` or `consignment_items` adds
  its branch with `create or replace`.
- Search: `pg_trgm` lives in `extensions` (as on hosted Supabase). The
  generated search columns use built-in immutable functions only, so the
  trigram indexes need no helper function.

Attachment storage: two Supabase Storage buckets, created by migration
(`insert … on conflict do nothing`), photos only (JPEG, PNG, WebP,
HEIC/HEIF) up to 20 MiB. `media-internal` is private; staff read it directly
and customers get short-lived signed URLs for the `customer`-visible rows
they are entitled to (`my_bike_attachments`, `my_work_order_attachments`).
Phase 1 planned to mint those on a server; since Phase 11 (D124) the
customer's own session mints them under a read policy limited to exactly
those objects, so no frontend holds the service-role key.
`media-public` is a public bucket: its files are served to anyone at their
public URL (`/object/public/…`, which Storage serves without RLS), and it
holds only rows with `visibility = public`. Changing visibility to or from
`public` moves the object between buckets: the server copies it to the
other bucket (same path), calls `set_attachment_visibility` with the new
location (which must exist), then removes the old object. A photo recorded
without width and height is an original the device could not decode and
uploaded as is (it may carry EXIF GPS), so it is never public
(`attachment_original_never_public`), like any photo on a customer record.
Storage policies on `storage.objects`:

- `media-internal`: select and insert for active staff. Since Phase 11
  (D124, `media_internal_select_customer`), select for a signed-in customer
  on exactly the objects of their own customer- or public-visible bike and
  job photos, the rows `my_bike_attachments` and `my_work_order_attachments`
  return them, so their session can sign URLs. Nothing for anon or inactive
  staff, no listing of anything else, no writes for customers. (Phase 1 had
  no customer policy and planned server-minted URLs; the visible set is
  unchanged.)
- `media-public`: select and insert for active staff only. No select for
  anon or customers: public URLs need none, and a select policy would let
  anyone list the bucket.
- Both: no update policy (nothing is overwritten: uploads never upsert, a
  move copies to a new bucket). Delete for active staff only of objects no
  attachment row points at (`private.attachment_object_referenced`; those
  policies are in the attachments migration), so a recorded photo leaves
  Storage only through `delete_attachment` (reason, history) or a move.

Storage and Postgres share no transaction, so a Storage cleanup can fail
after the database change (the old copy after a move, a deleted photo's
file) or a change can stop half-way. The server says so (`cleanupPending`,
"Finish" in the viewer repeats the change), and every time it shows a
record it removes that record's stray objects:
`attachment_stray_objects(entity_type, entity_id)` lists objects under the
record's folder that no row points at and are older than 10 minutes (not
part of a move still running); in `media-internal` only those whose
attachment id has history, or older than a day (an upload whose
`record_attachment` may still come). So `media-public` converges on public
photos only, whatever failed.

Object path: `{entity_type}/{entity_id}/{attachment_id}.{ext}`. Upload flow
(ADR-001 A7): the server picks the attachment id, mints a signed upload URL
for that exact path as the signed-in staff member, the phone uploads to it,
the server calls `record_attachment`.

## 3. Shop hours and appointments

Phase 2 migrations: `…2700_appointment_enum_values` (work_order_event_type
`appointment_linked`), `…2800_schedule`, `…2900_appointments`,
`…3000_appointment_customer_access` (step 1), `…3100_appointment_check_in`
(check-in, the `work_orders.appointment_id` foreign key and link triggers,
the completion trigger, D36, D40; §4) and `…3200_appointment_reporting`
(the appointment counts, D41; §14). Decisions: PLAN D2, D35, D36–D42.

```
shop_settings (single row: id smallint = 1, check shop_settings_singleton;
               inserted by the migration; never deleted: shop_settings_required)
  timezone text not null default 'Asia/Singapore'   -- fixed in the MVP (D35);
                                                    -- read via private.shop_timezone()
  default_currency text not null default 'SGD'      -- ^[A-Z]{3}$; private.shop_currency()
  intake_slot_minutes integer not null default 30   -- 5..240, divides 1440
  intake_capacity_units integer not null default 2  -- 1..50, per window (D2)
  booking_min_notice_minutes integer default 120    -- 0..10080 (D37)
  booking_horizon_days integer default 60           -- 1..365 (D37)
  customer_max_active_bookings integer default 3    -- 1..20 (D37)
  customer_cancel_cutoff_minutes integer default 120 -- 0..10080 (D37)
  public_site_url text null                         -- https?://…, ≤ 200; informational
                                                    -- until Phase 8 (D9 note)
  consignment_settlement_alert_days integer not null default 30
                                                    -- 1..365 (check
                                                    -- shop_settings_consignment_settlement_alert_days_check);
                                                    -- D107, Phase 9 step 3; written only by
                                                    -- set_consignment_settlement_alert_days (admin)
  indent_deposit_percent integer not null default 0 -- 0..100 (check
                                                    -- shop_settings_indent_deposit_percent_check);
                                                    -- D151/D157, Phase 14 step 2: the percent of a
                                                    -- quote's approved indent parts asked as a
                                                    -- deposit; 0 asks none and gates nothing (ships
                                                    -- at 0); written only by
                                                    -- set_indent_deposit_percent (admin), history in
                                                    -- schedule_events; copied onto each quote when
                                                    -- it is sent (§5)
  updated_at, updated_by -> staff                   -- updated_by = the caller's staff id

shop_hours
  id, weekday smallint (0=Sunday..6, as extract(dow)), opens_at time,
  closes_at time (≤ 24:00, after opens_at), active boolean, created_at, updated_at
  unique (weekday, opens_at)             -- several intervals per day
  no two intervals of one weekday overlap (trigger, shop_hours_overlap)

closure_overrides
  id, kind closure_kind (closed | custom_hours), starts_at, ends_at
  (≤ 366 days), opens_at/closes_at time (custom_hours only), reason text
  (1..200), created_by -> staff, created_at, updated_at
  exclude using gist (tstzrange(starts_at, ends_at)) where kind = custom_hours

appointment_types
  id, name (1..80, unique ignoring case), description (≤ 500),
  duration_minutes (5..480, multiple of 5), capacity_units (1..50),
  public boolean, active boolean, sort_order, created_at, updated_at
  -- never deleted (deactivate)

schedule_events (append-only; triggers on the four tables above)
  id bigint identity, entity (shop_settings | shop_hours | closure_override |
  appointment_type), entity_id uuid null (null for shop_settings),
  event_type (created | updated | deleted), payload jsonb (created/deleted:
  the row; updated: {"column": {"from","to"}} for changed columns only),
  reason (private.change_reason()), actor_staff_id, actor_user_id,
  correlation_id, created_at

appointments
  id uuid PK                               -- client-made: the idempotency key
  customer_id -> customers, bike_id null -> bikes, appointment_type_id -> appointment_types
  starts_at timestamptz, ends_at timestamptz -- snapshot: starts_at + duration (D38)
  capacity_units integer                   -- snapshot of the type (D38)
  status appointment_status default 'booked'
     -- booked | confirmed | arrived | checked_in | completed | cancelled | no_show
  source appointment_source                -- staff | customer ("Booked online")
  customer_note (≤ 1000; customers see it), internal_note (≤ 5000; staff only)
  confirmed_at, arrived_at, checked_in_at, completed_at, no_show_at,
  cancelled_at, cancellation_reason (≤ 500; staff only),
  cancelled_via appointment_source null    -- set exactly when cancelled (a channel)
  created_by_user_id -> auth.users, created_by_staff_id -> staff
  created_at, updated_at
  index (starts_at, ends_at) where status not in ('cancelled','no_show')

appointment_events (append-only; triggers)
  id bigint identity, appointment_id, event_type (booked | confirmed |
  arrived | checked_in | completed | cancelled | no_show | details_changed |
  work_order_linked), from_status, to_status, reason, payload jsonb,
  actor_staff_id, actor_user_id, correlation_id, created_at
  -- booked at created_at; a status event at its status stamp; a cancelled
  -- event's payload {"via"}; details_changed {"field": {"from","to"}} for
  -- bike_id, customer_note, internal_note; timelines order by (created_at, id)
```

**Time zone.** The shop's time zone is fixed at Asia/Singapore in the MVP
(D35, SPEC §24): `private.shop_timezone()` reads `shop_settings.timezone`
(fallback 'Asia/Singapore') and `private.shop_currency()` reads
`default_currency` (fallback 'SGD'); no RPC edits either. Every shop-day
computation goes through `private.shop_day()` / `shop_today()` /
`shop_day_start()`; a local wall-clock instant is
`(day + t) at time zone private.shop_timezone()` and the local time of an
instant `(ts at time zone private.shop_timezone())::time`.

**Open hours and closures (D38).** `private.shop_hours_ranges(day)` is the
open stretches of one shop-local date: the custom-hours override covering
the date if there is one (it replaces every weekly interval), else the
active weekly intervals of that weekday, merged (adjacent intervals form one
stretch; `day + time '24:00'` is the next midnight). `closed` overrides are
`[starts_at, ends_at)` (whole days or part of one day) and beat custom
hours; `custom_hours` rows always span whole shop-local days
(`save_closure_override` builds them) and never overlap each other.

**The slot grid and capacity (D2, D38).** Capacity windows are
`intake_slot_minutes` long and aligned to shop-local midnight
(`private.appointment_windows`). An appointment takes its `capacity_units`
in every window it overlaps; cancelled and no-show appointments take
nothing. A booking must start on the grid, lie wholly inside one open
stretch of one shop-local date, overlap no closed override and fit every
window: `private.appointment_slot_problem(starts_at, ends_at, units,
exclude_id)` returns the first code that fails, in the order
`appointment_slot_misaligned`, `appointment_outside_hours`,
`appointment_closed`, `appointment_capacity_exceeded` (or null).
`private.capacity_for_window(window_start, window_end)` returns
`intake_capacity_units` today; it is the D2 EXTENSION POINT (a later
migration replaces it to derive capacity from mechanic hours, leave and
skills) and nothing else reads `intake_capacity_units` for capacity.
`private.available_slots_at(day, type_id, as_of, for_staff)` lists the grid
starts of `day` that pass, with `remaining_units` (the least free capacity
over the overlapped windows before the booking); staff keep slots that
have not ended, everyone else only starts within the notice and horizon of
public active types (D37). Settings changes never move, shrink or cancel an
appointment: `ends_at` and `capacity_units` are snapshots (D38).

**Status machine (D39).** booked → confirmed | arrived | checked_in |
cancelled | no_show; confirmed → arrived | checked_in | cancelled |
no_show; arrived → checked_in | cancelled; no_show → arrived; checked_in →
completed. cancelled and completed are final. The trigger
`appointments_enforce_rules` enforces it for every writer, stamps the
status's `*_at` (a writer may provide an earlier business stamp), requires
`private.change_reason()` to cancel (it becomes `cancellation_reason`;
`cancelled_via` defaults to staff) and keeps customer, type, times, units,
source and creator immutable (`appointment_immutable`); the bike changes
only before check-in and must be the customer's and not archived. Staff
mark confirmed / arrived / no_show (`mark_appointment_status`; no_show only
after the start; no_show → arrived only on its own shop-local date, with a
capacity re-check), cancel with `cancel_appointment`, check in through
step 2's `check_in_appointment` (D40); completed follows the work order
(D36).

**Locks and keys.** Lock order, followed by every path so nothing
deadlocks: (a) the `shop_settings` row — FOR SHARE by appointment writers
that read settings, FOR UPDATE by the admin configuration RPCs (which
serialises configuration changes); (b) the per-customer advisory lock
`pg_advisory_xact_lock(hashtextextended('bicii.appointments.customer.' ||
customer_id, 0))` (`private.appointment_lock_customer`; customer
self-booking only; Phase 11 reuses it); (c) the per-day advisory lock
`hashtextextended('bicii.appointments.' || local_day, 0)`
(`private.appointment_lock_day`) and/or the appointment row FOR UPDATE —
`mark_appointment_status` takes the row, then the day lock; booking never
locks an appointment row; (d) step 2's check-in then takes the work order,
customer and bike row locks through Phase 3's path: `check_in_appointment`
holds the appointment row FOR UPDATE, then the existing work order FOR
UPDATE (when linking one), then the customer and the bike FOR SHARE (the
order `private.create_work_order` uses). The D36 completion trigger runs
under the job's row lock and then updates its appointment, but only an
appointment that is already checked in, for which check-in never locks a
work order (it returns the existing link), so no cycle forms. Bookings of one day
therefore serialise, so two bookings for the last unit cannot both succeed.
Every booking is idempotent on its client-made id (same customer, type and
start → the original row, even after the type was deactivated; otherwise
`appointment_conflict`); closures and types are saved by client-made ids
with `is_new` insert-or-replay semantics (`closure_conflict`,
`appointment_type_conflict`). Walk-ins never create an appointment.

Future-proofing (tables designed now, created when needed, no code paths in
MVP): `staff_working_hours`, `staff_leave`, `staff_skills`,
`appointment_types.required_skill`. Nothing in the booking RPC assumes a
mechanic.

## 4. Workshop

Phase 3 migrations: `…1200_workshop_catalog` (§5), `…1300_work_orders`,
`…1400_work_order_lines` (§5), `…1500_workshop_rpcs`.

```
work_orders                              -- written only through RPCs (§16)
  id uuid PK                             -- client-chosen: the check-in's idempotency key
  job_number text not null unique        -- J-000456: assigned on insert from next_short_id('J')
                                         --   whatever the caller sent (D9); immutable
  customer_id uuid not null -> customers
  bike_id uuid not null -> bikes
  appointment_id uuid null -> appointments (on delete restrict)
                                         -- unique where not null (work_orders_appointment_id_key);
                                         --   set once (insert, or null -> value), never changed or cleared;
                                         --   only to a checked_in appointment of the same customer and bike (D40)
  lead_mechanic_id uuid null -> staff    -- = the active lead assignment's staff_id (trigger-kept)
  status work_order_status not null default 'received'
     -- enum: received | diagnosing | awaiting_customer | awaiting_parts |
     --       ready_to_start | in_progress | paused | completed |
     --       ready_for_collection | collected | cancelled
  requested_work text not null           -- 1..2000
  intake_notes text null                 -- condition on arrival, ≤ 5000
  internal_notes text null               -- staff only, ≤ 10000
  completion_notes text null             -- ≤ 5000
  approval_flag boolean not null default false   -- optional internal flag (SPEC §7.1)
  approval_note text null                -- ≤ 500
  checked_in_at timestamptz not null default clock_timestamp()
  status_changed_at timestamptz not null -- time of the last status change (= checked_in_at at first)
  started_at, completed_at, ready_for_collection_at, collected_at timestamptz null
  cancelled_at timestamptz null, cancellation_reason text null (≤ 500)
  currency char(3) not null default 'SGD'
  created_by uuid -> staff, created_at, updated_at
  checks (named; every named check and unique index in the migrations is mapped in
    db-errors.ts, enforced by tests/unit/db-errors.test.ts): collected ⇔ collected_at; cancelled ⇔
    cancelled_at and cancellation_reason; completed/ready_for_collection/collected ⇔
    completed_at; ready_for_collection_at needs completed_at; ready_for_collection
    needs ready_for_collection_at; completed_at needs started_at; started_at,
    completed_at, status_changed_at ≥ checked_in_at; collected_at > completed_at
  index (status), (customer_id, checked_in_at desc), (bike_id, checked_in_at desc),
        (lead_mechanic_id), (checked_in_at), (completed_at), (collected_at)

work_order_assignments                   -- rows are closed, never edited or deleted
  id, work_order_id, staff_id, role assignment_role   -- enum: lead | additional
  assigned_by -> staff, assigned_at (clock_timestamp), unassigned_at null, unassigned_by null
  unique (work_order_id, staff_id) where unassigned_at is null      -- …_active_staff_key
  unique (work_order_id) where role = 'lead' and unassigned_at is null  -- …_one_lead_key

work_order_events  (append-only for every writer, the owner included)
  id bigint identity PK
  work_order_id uuid -> work_orders
  event_type work_order_event_type
     -- enum: checked_in | status_changed | completed | ready_for_collection |
     --       collected | cancelled | reopened | assignment_changed | note_added |
     --       diagnosis_added | details_changed | approval_flagged | photo_added |
     --       photo_removed | line_added | line_voided | stock_consumed | stock_reversed
  actor_staff_id uuid null -> staff (null = outside the app), actor_user_id uuid null (auth.uid())
  payload jsonb not null default '{}' (an object)
  correlation_id text null, created_at (clock_timestamp)
  index (work_order_id, created_at, id), (event_type, created_at), (actor_staff_id)
```

Status machine (D15, D16): `private.work_order_transition_rule(from, to)`
returns `allowed`, `reason_required` or null; `src/lib/workshop.ts`
(`transitionRule`) mirrors it and a database test compares all 121 pairs.

| From | Allowed | Reason required |
|---|---|---|
| received | diagnosing, awaiting_customer, awaiting_parts, ready_to_start, in_progress | cancelled |
| diagnosing | awaiting_customer, awaiting_parts, ready_to_start, in_progress | cancelled |
| awaiting_customer | diagnosing, awaiting_parts, ready_to_start, in_progress | cancelled |
| awaiting_parts | diagnosing, awaiting_customer, ready_to_start, in_progress | cancelled |
| ready_to_start | diagnosing, awaiting_customer, awaiting_parts, in_progress | cancelled |
| in_progress | diagnosing, awaiting_customer, awaiting_parts, paused, completed | cancelled |
| paused | diagnosing, awaiting_customer, awaiting_parts, in_progress, completed | cancelled |
| completed | ready_for_collection, collected | in_progress ("reopen") |
| ready_for_collection | collected | in_progress ("reopen") |
| collected, cancelled | — (final) | — |

The same status is not a transition: `set_work_order_status` returns the row
unchanged (a replay). Nothing returns to `received`. "Open" means before
completion (received … paused): only open jobs take or void lines (D15) or
can be cancelled (D16, and only with no live line). "Closed" means collected
or cancelled: assignments and the approval flag no longer change; details
and notes still may.

Indent items (D149b, D149c(1), `20261014000900`): a job moves into a
status that is not open (completed, ready for collection, collected,
cancelled) only while none of its `job_part_requests` is `approved` or
`ordered`. BEFORE UPDATE OF status trigger
`work_orders_require_settled_requests` (every writer; P0001
`work_order_has_unfitted_requests`), after
`work_orders_cancel_requires_no_lines` and `work_orders_enforce_rules`, so
the transition, reason and live-line refusals come first; the transition
table above is unchanged. AFTER UPDATE OF status trigger
`work_orders_withdraw_open_quote` (D149c(2)): an open quote is withdrawn
when the job leaves the open statuses. Both in §5 "Closing indent items".

Stamps. `private.work_orders_enforce_rules` (BEFORE INSERT OR UPDATE, every
writer) derives them from `status_changed_at`, which it sets to
`clock_timestamp()` unless the writer moved it forward (backfills; moving it
back is 22023): entering `in_progress` sets `started_at` only if it is null
(never cleared); `completed` sets `completed_at`; `ready_for_collection`
sets `ready_for_collection_at`; `collected` sets `collected_at`;
`cancelled` sets `cancelled_at` and `cancellation_reason` (the reason).
A reopen (completed or ready_for_collection → in_progress) clears
`completed_at` and `ready_for_collection_at`. DEVIATION, owner to confirm
before Phase 5: reopen clears completion stamps, which deviates from
DATA-MODEL §4's original "stamps exactly once, never clearing an earlier
stamp" and moves D3 recognition to the final completion. Phase 4 returns
sold units to held_for_customer on reopen (whenever `completed_at` goes from
non-null to null every unit on a non-voided inventory line of the job goes
sold → held_for_customer; whenever `completed_at` goes from null to
non-null, including re-completion after a reopen, they go
held_for_customer → sold), with no stock movement (D6, D25). Phase 3 keeps
the reopen rule in `private.work_orders_enforce_rules` (BEFORE INSERT OR
UPDATE), commented as the Phase 4 extension point; Phase 4 resolved that
extension point with a separate trigger and left the function as it is:
`work_orders_sell_held_units`, SECURITY DEFINER, `AFTER UPDATE ON
work_orders FOR EACH ROW WHEN (old.completed_at is distinct from
new.completed_at)`. It has no column list on purpose: `completed_at` is set
and cleared by the BEFORE trigger and is never in an UPDATE's target list,
so an `UPDATE OF completed_at` trigger would never fire. Under the job lock
`set_work_order_status` already holds, it takes `private.lock_stock` per
product (ascending) and the units FOR UPDATE (ascending); on completion
(including re-completion) held_for_customer units become sold with
`sold_at = completed_at` (cause `job_completed`) and
`private.refresh_unique_publication` runs per product; on reopen it first locks the linked bikes of
those units FOR UPDATE (ascending, lock order step 4) and refuses with
`bike_with_customer` when a sold unit's bike now has a customer (D29: the
bike goes back to the shop first); otherwise sold units
with no sale line go back to held_for_customer, `sold_at` null (cause
`job_reopened`), with no movement and no publication change. Stamps never change without a status change, and `job_number`,
`customer_id`, `bike_id`, `currency`, `created_by`, `created_at` and
`checked_in_at` never change (`work_order_immutable`); `lead_mechanic_id`
may only become the active lead (so only the assignments trigger moves it).
`appointment_id` is linked at most once: it is set on insert
(`private.create_work_order`) or may go from null to a value exactly once on
update, and once set it never changes and is never cleared
(`work_order_immutable`, P3's rule in `work_orders_enforce_rules`, which
Phase 2 relies on and does not replace). Phase 2 (`…3100`, D40) adds the
foreign key, the partial unique index and three triggers: BEFORE INSERT OR
UPDATE OF appointment_id `work_orders_appointment_rules` (only when a value
is SET: the appointment must exist (P0002) and be `checked_in`
(`appointment_not_checked_in`) with the job's customer and bike
(`appointment_work_order_mismatch`), for every writer); AFTER INSERT OR
UPDATE OF appointment_id `work_orders_sync_appointment_link` (named to fire
after `work_orders_record_history`, so the job's `checked_in` comes first:
the appointment's `work_order_linked` event `{work_order_id, job_number,
created}` and the job's `appointment_linked` event `{appointment_id,
starts_at, appointment_type_name, created}`, both dated
`greatest(job.checked_in_at, appointment.checked_in_at)`, the check-in
instant; customers never see it, `my_work_order_timeline` whitelists event
types); and AFTER UPDATE OF status `work_orders_sync_appointment_completion`
(D36: when a linked job first reaches completed, ready_for_collection or
collected, a `checked_in` appointment becomes `completed` at the job's
`completed_at`, with the current staff member as actor; a reopen does not
reopen it, a cancelled job leaves it checked_in). `check_in_appointment`
(§16) creates the job through `private.create_work_order` or links an open,
unlinked job this way. An insert must be `received`
with no lead and no stamps; the customer and the bike must exist and not be
archived (`work_order_customer_archived`, `work_order_bike_archived`), and
the customer must own the bike or the bike must have no owner (D18,
`bike_owner_mismatch`). `completed_at` and `collected_at` are different
events and different timestamps (SPEC §23); reports use `completed_at` as
the job's recognition date (D3).

Timeline. Triggers write the events, so no writer skips them, through
`private.record_work_order_event(work_order_id, event_type, payload, at)`
(actor = `current_staff_id()`, `auth.uid()`, correlation from the request);
`created_at` is the row's own business timestamp, so backfills stay
consistent. One event per action:

| Event | When | Payload |
|---|---|---|
| `checked_in` | job inserted, at `checked_in_at` | `job_number, customer_id, bike_id, requested_work` |
| `status_changed` / `completed` / `ready_for_collection` / `collected` / `cancelled` / `reopened` | each status change, at `status_changed_at` (exactly one event, typed by the target; `reopened` for completed/ready → in_progress) | `from, to, note` (+ `started: true` when it stamped `started_at`) |
| `details_changed` | requested work or notes edited | `{field: {from, to}}` per changed field |
| `approval_flagged` | flag or note changed | `flagged, note` |
| `assignment_changed` | assignment inserted / closed, at `assigned_at` / `unassigned_at` | `action (assigned/unassigned), staff_id, role` |
| `note_added` / `diagnosis_added` | `add_work_order_note` | `note_id, body` (`note_id`, the client's key, unique: `work_order_events_note_id_key`) |
| `photo_added` / `photo_removed` | job attachment recorded (at its `created_at`) / deleted | `attachment_id, visibility` / `attachment_id, reason` |
| `line_added` / `line_voided` | line inserted (at `created_at`) / voided (at `voided_at`) | `line_id, line_type, description, quantity, unit_sale_price, sale_total, currency` / `line_id, description, quantity, sale_total, reason` |
| `stock_consumed` / `stock_reversed` | `add_inventory_line` / the `void_line` inventory branch (Phase 4) | `line_id, movement_id, product_id, product_short_id, inventory_unit_id, unit_short_id, location_id, location_name, quantity, on_hand_after` / `line_id, movement_id, reversal_of_id, product_short_id, unit_short_id, location_name, quantity, on_hand_after` |

Payloads never contain cost, yield, rate or Cult Commons values: every
staff member reads the timeline, with or without `view_costs` (a test walks
every key and value). DATA-MODEL originally said "status_changed plus the
specific event"; one event per status change is the as-built rule. Nothing
is written for no-ops (same status, unchanged details, an existing
assignment, a replayed check-in or line).

Assignments (D22): any active staff member assigns or unassigns anyone
active (`staff_inactive`) on a job that is not closed (`work_order_closed`).
A new lead closes the previous lead's row (they leave the job; not demoted);
switching someone's role closes their row and opens one in the new role.
The AFTER trigger keeps `work_orders.lead_mechanic_id` equal to the active
lead.

Photos (D19): `private.attachment_entity_exists` knows `work_order`. Photos
on a job are `internal` or `customer`, never `public`
(`attachment_work_order_never_public` from a trigger for
`record_attachment` and `set_attachment_visibility`; CHECK
`attachments_work_order_never_public` as the backstop).

Lock order. Every RPC that touches a work order and its lines locks the
`work_orders` row FOR UPDATE (`private.lock_work_order`, which raises P0002
when the job is absent and checks no status) before any of its line rows
FOR UPDATE, so concurrent calls on one job serialise in one order;
`private.require_open_work_order` takes the same lock and then refuses a job
that is not open (`work_order_locked`). The line triggers' FOR SHARE on the
job follows the same order for direct writers. Phase 4's
`add_inventory_line` and `void_line` replacement call
`private.lock_work_order`, then the replay lookup (so a replay after
completion returns the original), then `private.require_open_work_order`;
§7 extends the order to stock, units and products.

Customers (D17) never read these tables (staff-only RLS); they read their
own jobs through the `my_work_order*` RPCs (§15 "Customer job projection",
§16; migration `20261004001600_workshop_customer_access`). Staff find a job
by its number through `staff_search` (`work_order` kind, migration
`…1700_workshop_search`).

## 5. Services and line items

```
categories
  id, kind category_kind (service | product), name (1..80, trimmed), parent_id null
  (unused by MVP screens), sort_order, created_at, updated_at, archived_at
  unique (kind, lower(name)) where archived_at is null   -- categories_active_name_key

services                                 -- written only through RPCs (§16)
  id, name (1..120, trimmed), description (≤ 2000), category_id null -> categories
  (a service category: category_kind_mismatch),
  default_sale_price money_amount not null (≥ 0),
  default_direct_cost money_amount not null default 0 (≥ 0)   -- no column grant (view_costs)
  currency char(3) default 'SGD', active, public, sort_order
  created_at, updated_at, archived_at
  unique (lower(name)) where archived_at is null    -- services_active_name_key

services_staff (view)                    -- every column incl. the cost; rows only for view_costs

cult_commons_rates                       -- append-only except cancelling a future rate (D21)
  id, rate rate_fraction not null (0..1), effective_from timestamptz not null,
  created_by null -> staff, created_at (clock_timestamp),
  cancelled_at null, cancelled_by null -> staff
  unique (effective_from) where cancelled_at is null
  -- base row cc000000-…-000000000001: 0.3000 from 1970-01-01, in the migration (not the seed)

work_order_line_items                    -- immutable except voiding; never deleted
  id uuid PK                             -- client-chosen: the add's idempotency key
  work_order_id uuid -> work_orders
  line_type line_type not null           -- enum: service | inventory | manual
  source_service_id uuid null -> services
  source_product_id uuid null -> products            -- FK added in Phase 4
  source_inventory_unit_id uuid null -> inventory_units  -- FK added in Phase 4;
     -- partial unique index work_order_line_items_unit_once (live lines only)
  description_snapshot text not null     -- 1..300
  quantity line_quantity not null        -- numeric(10,2), NaN-free domain; 0 < q ≤ 9999
  unit_sale_price_snapshot money_amount not null (≥ 0)
  unit_direct_cost_snapshot money_amount not null (≥ 0)
  cost_pending boolean not null default false
                                         -- a manual line added with no cost (D14): the 0
                                         -- above is a placeholder; check cost_pending_shape
  cult_commons_rate_snapshot rate_fraction not null (0..1)
  currency char(3) not null              -- the job's
  -- generated, stored, typed money_amount (each expression written out:
  -- a generated column cannot reference another):
  sale_total         = round(q × price, 2)
  cost_total         = round(q × cost, 2)
  yield_total        = round(q × price, 2) − round(q × cost, 2)
  cult_commons_share = round(greatest(round(q × price, 2) − round(q × cost, 2), 0) × rate, 2)
  created_by, created_at (clock_timestamp)
  voided_at null, voided_by null, void_reason null (1..500; set together)
  consignment_item_id uuid null -> consignment_items   -- Phase 6 (D44): a consigned part's item
  consignor_payout_snapshot money_amount null (≥ 0)    -- per unit, owed to the consignor;
                                         -- no column grant (work_order_line_items_staff only)
  checks: service lines name a service and nothing else; manual lines no source;
    inventory lines a product, whole quantities; a unique unit has quantity 1;
    work_order_line_items_consignment_shape: (consignment_item_id is null) =
    (consignor_payout_snapshot is null); _consignment_inventory_only: only an
    inventory line names an item
  index (work_order_id, created_at), (source_service_id), (source_product_id),
    (consignment_item_id)
```

Consigned parts (Phase 6 step 1; the owner's D27 change, D44). A consigned
part's line snapshots `unit_direct_cost_snapshot` = the item's agreed amount
(+ a unique item's non-voided shop-borne charges, D4) and
`consignor_payout_snapshot` = the agreed amount, and names its
`consignment_item_id`; both new columns are immutable (`line_immutable`).
The BEFORE INSERT OR UPDATE trigger `work_order_line_items_consignment_rules`
(definer, every writer; Phase 3's `work_order_line_items_enforce_rules` is
not replaced) refuses a customer-owned source product or unit
(`ownership_not_saleable`), requires a consigned source to name its own item
and a payout (`line_consignment_mismatch`) and a shop-owned one to name
neither. `authenticated` may read `consignment_item_id`, never the payout.

The arithmetic lives in generated columns so no application code can produce
a different number (`src/lib/cult-commons.ts` copies it for previews only;
a shared fixture table runs through both). A line snapshots its economics
when it is added: the description (service name unless overridden), unit
sale price and cost (service defaults unless overridden, D14) and the Cult
Commons rate from `private.cult_commons_rate_at(clock_timestamp())` (the
non-cancelled row with the latest `effective_from` ≤ that time;
`cult_commons_rate_missing` if none). Editing, archiving or deactivating a
service, or scheduling a new rate, never changes an existing line. Lines are
listed by `created_at` (there is no `sort_order`).

Rates (D21): only admins schedule (`schedule_cult_commons_rate`, now or
later, `rate_backdated` otherwise) or cancel (`cancel_cult_commons_rate`,
only while `effective_from` is in the future, `cult_commons_rate_in_effect`
otherwise) a rate; for every writer the rows are append-only
(`cult_commons_rates_append_only`) except setting `cancelled_at`/
`cancelled_by` once on a rate that has not started.

Totals per work order: `work_order_totals` (security invoker: job, currency,
live `line_count`, `sale_total`) for every staff member;
`work_order_totals_staff` adds `cost_total`, `yield_total`,
`cult_commons_share` (Σ line shares, D1), `bicii_yield_after_cc =
yield_total − cult_commons_share` and `cost_pending_count` (live lines with
no cost entered, D14: while it is above 0 the cost-side figures count those
lines at 0 and are provisional; the job page says so, and later reports
must too); `work_order_line_items_staff` returns every line column. Both `_staff` views are security-barrier definer views
that return rows only when `private.has_permission('view_costs')`;
`authenticated` holds SELECT on `work_order_line_items` only for the sale
side (no unit cost, rate, cost, yield or Cult Commons columns; `cost_pending`
is granted, since it says only that a cost is missing) and on `services` for
every column except `default_direct_cost`. The security definer writers to
those two tables re-raise a check or not-null violation through
`private.raise_without_row` (§16): Postgres would otherwise put the whole
row, hidden columns included, in the error's DETAIL.

Cult Commons: `cult_commons_share = max(yield, 0) × rate` per line, where
`yield = sale − direct cost` and the consignor payout is direct cost.
Negative yield reports a loss and never produces a negative share, nor
offsets another line (D1).

Lines change only while the job is open (D15, `work_order_locked`), checked
by the BEFORE trigger for every writer (it locks the job `for share`), and
are voided with a reason (`void_line`); a job is not cancelled while it has
a live line (D16, `work_order_has_lines`, trigger
`private.work_orders_cancel_requires_no_lines`). That is the single
cancel-with-lines rule; it covers Phase 4's inventory lines too, so Phase 4
adds no separate parts rule or code. The line RPCs follow the lock order in
§4: the `work_orders` row FOR UPDATE (`private.lock_work_order`) before any
line row FOR UPDATE.

Deviations from this document's earlier draft, each for a reason:

- (a) Lines are immutable except voiding and have no `sort_order`; the
  earlier draft allowed `sort_order` and `description_snapshot` typo fixes.
  Void and re-add keeps the evidence and matches the Phase 4 stock ledger.
- (b) `add_service_line`, `add_manual_line`, `void_line` and the service
  RPCs return ids, not rows (§16 says RPCs return the affected row): rows
  carry cost columns, and an RPC result is not column-gated.
- (c) `work_orders` and `services` are written only through RPCs (§15's
  earlier "S" insert/update for work orders and "A / P(manage_inventory)"
  for services are stricter now).
- (d) The anonymous/customer services listing in §15 arrives with Phase 11
  through a separate customer-safe projection.
- (e) The Cult Commons base rate ships in the migration, not the seed.
- (f) A manual line added without a cost is stored with cost 0 and
  `cost_pending` (D14, owner to confirm), rather than a nullable cost, so
  the generated arithmetic stays one expression; it is corrected by voiding
  and re-adding it with the cost.

### Indent parts and quotes (Phase 13)

`20261014000200_indent_parts` (D140–D147,
[ADR-024](decisions/ADR-024-indent-parts-and-customer-quotes.md)). An
indent part is ordered for one job: proposed, quoted, answered by the
customer, ordered, received and fitted. Nothing here changes a line, a
movement or a total until the fit, which adds an ordinary line through
`add_inventory_line` or `add_service_line` (D15, D23, D24 unchanged).

```
job_part_requests
  id uuid pk                       -- the app's form id (propose replay key)
  work_order_id uuid fk work_orders
  kind part_request_kind           -- part | service (fitting labour)
  product_id uuid null fk products -- part: shop-owned, quantity, active (D62)
  service_id uuid null fk services -- service
  description text                 -- the name when proposed (≤ 200)
  quantity line_quantity           -- part: whole 1–999; service: > 0, ≤ 999
  unit_sale_price money_amount     -- shown to the customer
  currency char(3)
  line_total money_amount generated (round(quantity × price, 2))
  expected_unit_cost money_amount null  -- D60: no column grant; job_part_requests_staff
  supplier_id uuid null fk suppliers    -- D60: no column grant; job_part_requests_staff
  status part_request_status       -- proposed | quoted | approved | declined |
                                   -- ordered | fitted | cancelled
  purchase_order_line_id uuid null fk purchase_order_lines  -- set when ordered
  work_order_line_item_id uuid null unique fk work_order_line_items  -- set when fitted
  outside_purchase_movement_id bigint null unique fk inventory_movements
                                   -- D149a: the receipt of a part fitted as bought outside BICII
  cancel_reason text null          -- required when cancelled (≤ 500)
  created_by, created_at, updated_at, decided_at,
  ordered_at, ordered_by, fitted_at, fitted_by, cancelled_at, cancelled_by

quotes
  id uuid pk                       -- send_quote's form id
  work_order_id uuid fk work_orders  -- unique where status = 'open' (one open quote per job)
  token_hash bytea unique          -- SHA-256 of the 43-character link token; never granted
  status quote_status              -- open | answered | withdrawn (expired is open past expires_at)
  channel quote_channel            -- whatsapp | email | link (D144)
  currency char(3), total money_amount   -- snapshot
  expires_at timestamptz           -- sent_at + 1–30 days (7 by default)
  sent_by, sent_at, answered_at, answered_name (1–100), withdrawn_at, withdrawn_by
  deposit_percent integer null     -- Phase 14 step 2 (D158a): the shop's percent when
                                   -- sent (0 unless SGD, the shop currency); null for a
                                   -- quote sent before step 2; never changes
  deposit_amount money_amount null -- D151, D158a/b: set when answered; null = no deposit
                                   -- asked, no D152 gate
  checks: quotes_deposit_percent_check (0..100), quotes_deposit_amount_check
    (0.50..999,999.99), quotes_deposit_shape (an amount ⇒ answered, percent 1..100, SGD)
  -- quotes_deposit_snapshot (BEFORE INSERT OR UPDATE, every role): quote_deposit_immutable

quote_items
  id uuid pk, quote_id fk quotes, part_request_id fk job_part_requests
  position smallint                -- order on the page
  kind, description, quantity, unit_sale_price, line_total  -- snapshot when sent
  decision text null               -- approved | declined, set once by answer_quote
```

State changes, all through the RPCs in §16: proposed → quoted
(`send_quote`; back to proposed when the quote is withdrawn or replaced) →
approved or declined (`answer_quote`) → ordered (`order_part_requests`,
parts only) → fitted (`fit_part_request`, from approved or ordered) →
back to ordered or approved when its line is voided (D160, "Voiding a
fitted indent line" below); any
state but quoted and fitted → cancelled (`cancel_part_request`, with a
reason; on a collected or cancelled job an admin or manager also cancels
a quoted one, which withdraws its quote first, D149). Which job statuses allow each step is in "Indent parts on
completed and closed jobs" below (D149). A request has arrived when the receipts on its purchase order
line cover it, the line's requests first requested first covered
(`private.part_request_arrival_rows`, D146); arrived, unfitted quantities
are shown as reserved (`indent_reservations`) but held nowhere
([R-080](RISKS.md#r-080--arrived-indent-stock-is-not-held-for-its-job)).

The answer sets `work_orders.approval_flag` when anything is approved and
replaces `approval_note` with "Quote answered online by {name} on {date}:
{n} of {m} items approved." (the history trigger records it as
`approval_flagged`). Timeline events: `part_requested`,
`part_request_cancelled`, `quote_sent`, `quote_withdrawn`,
`quote_answered`, `part_ordered`, `part_fitted` and, from D160,
`part_request_unfitted` (payloads carry names,
quantities, counts and purchase order numbers, never a price or cost;
`my_work_order_timeline` lists its own types, so customers see none of
them). Lock order: the job (`private.lock_work_order`) before its requests
and quotes; `order_part_requests` locks every job in id order, then calls
the purchasing RPCs, which lock purchase orders and never jobs.

### Indent deposits (Phase 14 step 2)

`20261014000500_indent_deposits` (D151, D152, D157, D158,
[ADR-025](decisions/ADR-025-stripe-payments.md); the payments themselves
are §19).

**The snapshot (D158a, b).** The `quotes_deposit_snapshot` trigger copies
`shop_settings.indent_deposit_percent` onto a quote when it is inserted
(`send_quote`), or 0 when the quote is not in SGD, the shop currency. When
the quote moves from open to answered (`answer_quote`, which writes the
items' decisions before the quote's status) it computes `deposit_amount =
round(sum(line_total of the approved part items) × deposit_percent / 100,
2)` in Postgres: services and declined items are excluded, and an amount
under S$0.50 (Stripe's minimum) or over S$999,999.99 is not asked (null;
never rounded up). Otherwise neither column changes, for every role
(`quote_deposit_immutable`). So a later change of the setting never moves a
sent or answered quote, and quotes sent before step 2 (percent null) ask
nothing. Worked figures (`tests/db/indent-deposits.test.ts`): 2 × 120.00
plus a 25.00 service at 50% → 120.00; 33.33 → 16.67; 0.99 → 0.50; 0.80 →
none.

**`public.quote_deposits`** (security invoker; staff through RLS; the
definer RPCs read it as owner) is the one definition of a deposit's state,
one row per answered quote with a `deposit_amount`: `paid` (a deposit
payment paid or partly refunded, D158e, or, since `20261014001300`, a live
counter deposit, D161f), else `refunded` (fully refunded:
unpaid again and never offered again), else `processing` (Checkout complete,
Stripe still confirming), else `due` (an approved part of the quote is still
approved, ordered or fitted), else `none` (every approved part cancelled);
with `part_request_ids`, the approved parts, and, appended by
`20261014001300`, `counter_payment_id`: the quote's live counter deposit
(not voided; the newest by `created_at`, then id, so the pick is
deterministic; `record_counter_payment` keeps at most one live under the
quote lock). A void takes the counter deposit out of the state, which
falls back to what the Stripe payments and the parts give it: paid,
refunded, processing, due or none, as before it was recorded. The quote
page offers Pay again only when that is `due` and the job is open (D158c),
and the D152 gate is closed again unless a Stripe deposit is paid.

**The quote page** (`private.quote_view`, through `quote_by_token` and
`answer_quote`) gains a twelfth key, `deposit`: null, or `{percent,
amount, status}` with status `on_answer` (open, the percent only, when the
quote has a part), or, once answered, `{percent, amount, status,
parts_ordered, job_closed}` with status `due` (only while the job is open, D158c),
`processing`, `paid` or `refunded`, and `parts_ordered` true once every
approved part still approved, ordered or fitted is ordered or fitted (an
admin or manager ordered before the deposit was paid, D152: the page then
stops saying the order waits for the deposit, while the deposit stays
`due`); `job_closed` since `20261014000700` (below). No Stripe id or URL
reaches the page.

**The D152 gate.** `order_part_requests` (dropped and created again with
`override_reason text = null`) checks, under the job locks it already
holds and after `part_request_not_approved`, every requested part whose
answered quote is in `quote_deposits` with a state other than `paid`.
Without a non-blank reason: `deposit_unpaid`. With one, the caller must be
an active admin or manager (`private.can_record_refunds()`, a role check:
`manage_purchasing` as extra access does not include it; 42501), and the
trimmed reason (`reason_too_long` over 500) is recorded on each affected
job's `part_ordered` entry as `deposit_override {reason, quote_ids}`, with
the event's `actor_staff_id`. A reason given when nothing is unpaid is
ignored. The replay of an ordered set comes before the gate, so it returns
the purchase order even after a refund. **Fitting is not gated**
(`fit_part_request` is unchanged): an approved part already in stock can be
fitted before its deposit is paid. Every writer of `payments` and of
`counter_payments` and `counter_payment_voids` holds the job's lock, so
ordering, applying a payment and recording or voiding a counter deposit
serialise (`tests/db/counter-payments.test.ts`: an order waits for a
counter deposit, then orders; waits for its void, then `deposit_unpaid`).

### Indent parts on completed and closed jobs (R-082, D149)

`20261014000700_indent_closed_jobs`, after the owner's live test of
2026-10-15 ([R-082](RISKS.md#r-082--approved-indent-parts-can-be-left-unfitted-on-a-completed-or-collected-job)):
a request reaches the bill only when it is fitted (D140), so an approved
part a job is completed or collected without is in no total, yield,
Cult Commons or report, by design; this file makes that visible and lets
an admin or manager close it out. It changes no money, line, stock or
recognition rule.

What each RPC allows by the job's status (open: received to paused;
completed and ready for collection: not open; collected and cancelled:
closed, D15):

| RPC | Open | Completed, ready | Collected, cancelled |
|---|---|---|---|
| `propose_part`, `propose_service`, `send_quote`, `fit_part_request` | Any staff member | `work_order_locked` | `work_order_locked` |
| `answer_quote` (anyone holding the link) | Yes | `quote_not_open` | `quote_not_open` |
| `order_part_requests` (`manage_purchasing`) | Yes | `work_order_locked` (after the replay, which still returns an ordered set's purchase order) | `work_order_locked` (same) |
| `withdraw_quote` | Any staff member | Any staff member | `work_order_closed` (after the replay of a withdrawn quote) |
| `cancel_part_request` | Any staff member | Any staff member | D149 INDENT-CLOSE: an active admin or manager (`private.can_record_refunds()`, a role check: extra access never grants it), any request that is not fitted, a quoted one included (the open quote is withdrawn first); anyone else `work_order_closed`. The replay of a cancelled request answers anyone |

D149's cancel is the ordinary one: the same reason rule (`reason_required`,
`reason_too_long`), fitted requests still refused (`part_request_fitted`),
the same `part_request_cancelled` event `{request_id, description, reason,
was}` with the actor, and an ordered part stays on its purchase order. The
job does not move: it stays collected or cancelled, with no line, movement
or total changed. A quote still open when its job closed can be neither
answered (`answer_quote` needs an open job) nor withdrawn
(`withdraw_quote`: `work_order_closed`), so cancelling one of its items
withdraws it first (`private.withdraw_open_quote`, under the job lock
already held: the quote becomes withdrawn, its link answers `{status:
'withdrawn', job_number}`, `quote_withdrawn` is recorded and its other
quoted items go back to proposed, which the same cancel then accepts);
`was` stays `quoted`, and any refusal after it (a missing reason) rolls the
withdrawal back. No money is held for quoted items (a deposit is asked only
once a quote is answered). On an open, completed or ready job a quoted
request is still `part_request_quoted`: withdraw the quote first (the job
page offers Withdraw only while the job is open).

The containment covers approved and ordered requests only. Until D160 a
fitted request whose line was later voided stayed `fitted`, pointing at
the voided line, in no memo or payment issue, with Fit and Cancel both
refusing it
([R-083](RISKS.md#r-083--a-fitted-indent-request-whose-line-was-voided-is-stuck-and-unflagged));
since `20261014001100` the void puts it back to approved or ordered
("Voiding a fitted indent line" below), so all of the above sees it.

**`public.work_order_unfitted_requests`** (security invoker; any active
staff member through `job_part_requests`' RLS and column grants;
customers 0 rows; anon no grant): per job and currency, `item_count` and
`quoted_total` (the sum of `line_total`, computed in Postgres) of the live
requests in `approved` or `ordered` (the enum has no arrived state:
arrival is derived, D146). Fitted, declined and cancelled requests are
not in it, and it has no cost column. The job page shows it under the
Lines total as a memo, never added to the total, the yield or Cult
Commons.

**The quote page** (`private.quote_view`): an answered quote's deposit
object gains `job_closed`, true once the job is completed, ready for
collection, collected or cancelled, so `{percent, amount, status,
parts_ordered, job_closed}`; the open quote's `{percent, amount, status}`
and the 12 top-level keys are unchanged, and nothing about costs, staff
or contact details is added (D143). With `job_closed` and the parts not
ordered or fitted, the page says "Ask the shop about your deposit."
instead of "the shop will order your parts".

The payment side (`payment_issues`' `paid_parts_not_fitted` and
`work_order_payment_totals.held_over_total`) is §19. Lock order is
unchanged: each RPC locks the job (`private.lock_work_order`) before its
requests and quotes; `order_part_requests` locks every job in id order,
then its requests, answers a replay, then checks each job is open (the
re-lock waits for nothing) before it touches a purchase order.

### Closing indent items (D149a, D149b, D149c)

`20261014000800_outside_purchase_enum` and
`20261014000900_indent_settle_and_outside_purchase` (owner decisions
D149a, D149b of 2026-10-15; D149c, confirmed by the owner the same day; ADR-024 amendment
"Closing indent items"). Nothing here replaces an existing function.

**`job_part_requests.outside_purchase_movement_id`** (`bigint null`,
foreign key to `inventory_movements`, `on delete restrict`): the
`outside_purchase` movement recorded when the part was fitted as bought
outside BICII. CHECK `job_part_requests_outside_purchase_shape` (null, or a
`part` that is `fitted`); unique partial index
`job_part_requests_outside_purchase_key` (one request per receipt). Granted
to `authenticated` like the request's other links: it is not a cost (the
cost is on the movement, read through `inventory_movement_costs`).

The request state machine gains one path: `approved → fitted` through
`fit_part_bought_outside` (parts never ordered only). `part_fitted`'s
payload gains `bought_outside: true` and `reference` (the trimmed "Bought
from" text or null) on that path; it never carries a cost.

**`fit_part_bought_outside(request_id, line_id, unit_cost, location_id =
null, reference = null) → uuid`** (D149a; §16): view_costs or
manage_purchasing (`private.can_view_purchase_costs()`, checked before
anything is read; 42501). In order: the job (`private.lock_work_order`),
the request `for update`; the replay (a request fitted as bought outside
with this `line_id` returns it, any other fitted request is
`part_request_fitted`); `outside_purchase_part_only` for a service,
`part_request_ordered` for an ordered part (received in Purchasing, then
fitted), `part_request_not_approved` for anything else not approved;
`work_order_locked` unless the job is open; `outside_purchase_cost_invalid`
outside 0–99,999.99; `outside_purchase_reference_too_long` over 100
characters; `part_request_conflict` when a line with `line_id` already
exists; `private.lock_stock(product)`, then the products row `for no key
update` (§7 step 7, always, so no direct cost edit lands between this read
and `add_inventory_line`'s) and its checks (archived, inactive, not
shop-owned quantity: `indent_product_invalid`; another currency:
`currency_mismatch`); the location (`location_id`, or
`add_inventory_line`'s default: the active one with the lowest sort order
and name; `location_required`, `location_inactive`). Then, in one
transaction: one `outside_purchase` movement (+quantity at the location,
`unit_cost_snapshot` = `unit_cost`, `request_id` = `line_id`,
`work_order_id` = the job, reason "Bought outside BICII for J-…" with the
reference in brackets); the product's `default_direct_cost` set to
`unit_cost` when it differs (§6; `cost_changed` with that reason and an
empty payload); `add_inventory_line(line_id, job, product, quantity,
location, null, the quoted price)`, whose `job_consumption` takes the same
quantity back out at the same cost (D24: the line takes the product's
cost); the request `fitted` with its line and movement; `part_fitted`.
On-hand at the location never changes, so it never goes below zero; any
refusal rolls everything back.

**The settle guard (D149b, D149c(1)).** Trigger
`work_orders_require_settled_requests` (BEFORE UPDATE OF `status`, when the
status changes; every writer): a job cannot move into a status that is not
open (`completed`, `ready_for_collection`, `collected`, `cancelled`) while
any of its requests is `approved` or `ordered` (an arrived, unfitted part
is ordered): P0001 `work_order_has_unfitted_requests`, detail "Fit or
cancel each approved or ordered item first." (or, into cancelled, "Cancel
the job's approved and ordered items before cancelling it."). It sorts
after `work_orders_cancel_requires_no_lines` and
`work_orders_enforce_rules`, so an invalid move
(`work_order_transition_invalid`), a missing reason (`reason_required`)
and a cancel with live lines (`work_order_has_lines`) report first;
`set_work_order_status` checks those three before its UPDATE.
`private.work_order_transition_rule` (and the app's `transitionRule`) are
unchanged: the guard depends on data, not on the pair. Reopen, every move
into an open status (`order_part_requests`' move to awaiting_parts
included) and changes to requests never meet it, so D149's admin or
manager cancel on a collected or cancelled job is unaffected. Every
writer of a request's status takes the job's lock first, and the status
UPDATE holds the job row, so the read cannot race.

**An open quote when the job closes (D149c(2), (6)).** Trigger
`work_orders_withdraw_open_quote` (AFTER UPDATE OF `status`, when it
changes; it sorts after `work_orders_record_history`): when the job enters
a status that is not open, its open quote is withdrawn
(`private.withdraw_open_quote`, actor `private.current_staff_id()`, null
for an owner write): the quote becomes `withdrawn`, its quoted items go
back to `proposed`, and `quote_withdrawn` follows the status entry on the
timeline. Answered quotes and their deposits are untouched; a reopen does
not revive the link. The migration withdrew once, the same way (no actor),
every quote still open on a job that was no longer open.

Jobs that changed status before these triggers may still hold approved or
ordered items: on a completed or ready job the next move is refused until
each is fitted (after a reopen) or cancelled; on a collected or cancelled
job D149's admin or manager cancel is the only way
([R-082](RISKS.md#r-082--approved-indent-parts-can-be-left-unfitted-on-a-completed-or-collected-job);
RUNBOOK "Indent items on jobs closed before the guard").

### Voiding a fitted indent line (D160)

`20261014001000_part_unfitted_enum` and `20261014001100_indent_unfit_on_void`
(owner decision D160 of 2026-10-15, the first of R-083's options; ADR-024
amendment "Voiding a fitted indent line"). Nothing here replaces an
existing function: `void_line` is unchanged, and so are its stock reversal
(§7), the line totals, yield, Cult Commons and who may void (D15).

**The un-fit.** `private.unfit_part_request(line_id) → uuid` (owner only):
when `line_id` is a voided line and a `fitted` request points at it, the
request goes back to where it was before Fit: `ordered` when its
`purchase_order_line_id` is set (only `order_part_requests` sets it, with
`ordered`), else `approved` (a fitted service, a part fitted from stock
without an order, a part bought outside BICII, D149a). In one UPDATE
`work_order_line_item_id`, `fitted_at`, `fitted_by` and
`outside_purchase_movement_id` are cleared (`decided_at`, `ordered_at`,
`ordered_by` and the purchase order link stay), so
`job_part_requests_fitted_has_line` and
`job_part_requests_outside_purchase_shape` hold. Then
`part_request_unfitted` is recorded on the request's job: `{request_id,
line_id, description, quantity, status, bought_outside}` (`status` the one
it went back to; `bought_outside` true when the fit was D149a's), with the
caller as actor (null from the migration), never a price or cost. Returns
the request id, or null when there is nothing to undo (a live line, a line
no request points at).

Trigger `work_order_line_items_unfit_part_request` (AFTER UPDATE on
`work_order_line_items`, for each row `when (old.voided_at is null and
new.voided_at is not null)`; no column list) calls it for every writer of
a void, in the void's transaction: `void_line` (the only RPC) and owner
writes. It sorts after `work_order_line_items_record_history`, so a void
of a fitted part reads `line_voided`, `part_request_unfitted`, then
`void_line`'s `stock_reversed`. A replayed void (the line already voided)
writes nothing, and a void of any other line (an ordinary part, service or
manual line, the same part added by hand) changes no request.

What follows from the request's status, unchanged: D149b's guard holds
Complete, Ready, Collected and Cancel job until the item is fitted again
(a new line: `fit_part_request` from stock, from where an ordered part was
received; or `fit_part_bought_outside` for a new purchase) or cancelled;
`work_order_unfitted_requests` counts it; the quote page's `parts_ordered`
is false again for an approved part; `paid_parts_not_fitted` (§19) counts
it as unfitted should such a job ever close; an ordered part keeps its
place in its purchase order line's queue (`part_request_arrival_rows`), so
it is arrived and reserved again (`indent_reservations`) only if that
line's receipts cover it: one fitted before its order was received (Fit
allows it, with a warning) is not arrived until they do. A part bought
outside BICII keeps its `outside_purchase`
movement (its `request_id` stays the voided line's id); the void's
reversal puts the quantity back at the fit's location at its cost, so
after the void it is in stock and a re-fit takes it from there.

**The live-line guard.** Trigger `job_part_requests_require_live_line`
(BEFORE INSERT OR UPDATE on `job_part_requests`, every writer): a new or
changed `work_order_line_item_id` must not be a voided line (P0001
`part_request_line_voided`, "That line was voided. Reload the job and fit
the item again."). `add_inventory_line` and `add_service_line` answer an
existing line id as a replay even when the line is voided, so without it a
Fit retried with the voided line's id would re-link the request to that
line. `fit_part_bought_outside` already refuses a taken line id
(`part_request_conflict`).

**One-off.** The migration un-fits, once, every `fitted` request whose
line is already voided: each job is locked (`private.lock_work_order`, in
id order) before `private.unfit_part_request`, with no actor. Requests on
jobs that are no longer open are included: D149b holds the next move of a
completed or ready job, D149's admin or manager cancel closes them on a
collected or cancelled job (RUNBOOK "Indent items on jobs closed before
the guard" lists them). A NOTICE says how many it un-fitted, how many on
jobs that are not open, and how many on a job with a live line of the same
product or service that was added after the void and that no request is
linked to (perhaps added again by hand under R-083's workaround: staff
check, and cancel the request if it was). A line from before the void or
another request's own fit is not counted. Running it again finds nothing.

Lock order: `void_line` locks the job (`private.lock_work_order`), then the
line; the trigger then locks the line's request, before `void_line`'s
stock, bike and unit locks (§7). Every writer of a request takes its job's
lock first, and a direct writer of a void holds the job FOR SHARE
(`work_order_line_items_enforce_rules`), so the un-fit never interleaves
with a fit, a cancel or a status change of the same job.

## 6. Catalog and inventory

Built in Phase 4 (`20261004001800_inventory.sql`). Money columns are
`money_amount`, quantities `integer`. Every table has RLS: staff read;
`manage_inventory` writes locations and products; customers and anonymous
visitors read nothing (the anonymous surface is `reporting.public_items`,
§11, built in `20261004002100_inventory_publication.sql`).

```
locations
  id uuid PK
  name text not null (≤ 80, trimmed, non-blank), constraint locations_name_key unique
  kind location_kind not null default 'shop_floor'
     -- enum: shop_floor | workshop | storage | offsite
  active boolean not null default true
  sort_order integer not null default 0
  created_at, updated_at
  -- The DEFAULT location is the active one with the lowest (sort_order,
  -- name); there is no flag. The migration inserts the one-shop bootstrap
  -- 'Shop floor' (1c000000-…-000000000001, sort 10), so a hosted database
  -- works without the seed (SPEC §11). Deactivating a location whose
  -- ledger on-hand is non-zero for any product raises location_has_stock.

products
  id uuid PK                               -- client-supplied by the form id
  short_id text not null unique            -- P-######, assigned by trigger, immutable
  sku text null (≤ 64)
  sku_key text generated                   -- upper(sku) without punctuation;
                                           -- unique index products_sku_key_unique
  name text not null (≤ 200), description text (≤ 5000), brand text (≤ 100)
  category_id uuid null -> categories      -- kind must be 'product' (category_kind_mismatch)
  tracking_type tracking_type not null     -- enum: quantity | unique; immutable
  ownership_type ownership_type not null default 'shop_owned'
     -- enum: shop_owned | consignment | customer_owned; not client-writable;
     -- immutable once the product has a unit or a movement
     -- (products_ownership_rules: product_ownership_immutable, D45)
  publication_status publication_status not null default 'draft'
     -- enum: draft | internal_only | public | sold | archived (§11, D26)
  public_slug text null unique             -- set at first publish, never changes
  default_sale_price money_amount null ≥ 0
  default_direct_cost money_amount null ≥ 0  -- no column grant: product_costs
     -- written by staff with view_costs, by receive_purchase (D5, D63)
     -- and by fit_part_bought_outside (D149a: the entered cost, always)
  currency char(3) not null default 'SGD'
  reorder_point integer null ≥ 0           -- low stock: on_hand <= reorder_point
  shopify_product_id text null, shopify_variant_id text null unique  -- Phase 10 (D84)
     -- gids (products_shopify_product_id_format / _variant_id_format);
     -- shopify_product_id is NOT unique (index products_shopify_product_id_idx):
     -- several BICII products may link variants of one Shopify product
     -- (a justified deviation from this section's first draft, D84). No
     -- UPDATE grant: links change only through link_shopify_variant (§16)
     -- and step 2's sync.
  active boolean not null default true
  search_text text generated (name, brand, sku; trigram index)
  created_by uuid null -> staff, created_at, updated_at, archived_at
  -- products_enforce_rules (definer, every writer): trims, assigns the
  -- short ID, keeps short_id and tracking_type immutable, enforces the
  -- publication machine and requirements (§11), assigns the slug, refuses
  -- archiving while public (product_published) or while any location's
  -- ledger is non-zero or a unit is available/reserved/held
  -- (product_has_stock).

inventory_units   (one row per physical unique item; created only by RPCs)
  id uuid PK
  short_id text not null unique            -- U-######, assigned by trigger, immutable
  product_id uuid not null -> products     -- unique-tracked (product_not_unique); immutable
  location_id uuid not null -> locations
  serial_number text null (≤ 100), serial_key generated (btree + trigram)
  condition text null (≤ 500)              -- PUBLIC once the product is published
  ownership_type ownership_type not null default 'shop_owned'
  consignment_item_id uuid null -> consignment_items  -- deferrable initially deferred
                                           -- (the intake inserts the unit first);
                                           -- inventory_units_consignment_shape: required when
                                           -- ownership = consignment;
                                           -- inventory_units_consignment_item_ownership: only then
  bike_id uuid null unique -> bikes        -- when the unit is a complete bike
  status unit_status not null default 'available'
     -- enum: available | reserved | sold | returned_to_consignor |
     --       written_off | held_for_customer
  sale_price money_amount null ≥ 0         -- overrides product default
  direct_cost money_amount null ≥ 0        -- no column grant: inventory_unit_costs
  sold_sale_line_id uuid null unique       -- no FK until Phase 6
  sold_at timestamptz null                 -- check (status = 'sold') = (sold_at is not null)
  internal_notes text (≤ 10000)
  created_by, created_at, updated_at, archived_at
  -- archived only when sold, written_off or returned_to_consignor (unit_in_stock)
  -- inventory_units_consignment_rules (Phase 6): consignment_item_id and
  -- ownership_type never change (consignment_item_immutable); a consigned
  -- unit is never written off (consignment_unit_write_off_blocked, D50)

product_events / inventory_unit_events   (append-only, written by triggers)
  id, product_id | unit_id, event_type, actor_staff_id, payload jsonb,
  reason (private.change_reason()), correlation_id, created_at
```

Unit status transitions (`private.unit_status_transition_allowed`,
mirrored in `src/lib/inventory.ts`; same-state pairs are false):

| From | To |
|---|---|
| available | reserved, held_for_customer, sold, returned_to_consignor, written_off |
| reserved | available, held_for_customer, sold |
| held_for_customer | available, sold |
| sold | available, held_for_customer (the latter only on a job reopen, D25) |
| written_off | available |
| returned_to_consignor | (none) |

History payloads are exact and never carry a cost (no cost column name or
value appears in any product, unit or work-order event, nor in any RPC
return). Product: `created {short_id, name, tracking_type,
publication_status}`, `details_changed {fields: [names]}` (names only),
`price_changed {from, to}`, `cost_changed {}`, `publication_changed {from,
to}`, `archived {}` / `unarchived {}`. Unit: `created {short_id,
product_id, location_id, status, ownership_type}`, `status_changed {from,
to}` merged with the event context (`{work_order_id, job_number, line_id}`
or `{work_order_id, job_number, cause: 'job_completed' | 'job_reopened'}`,
set through `private.set_event_context` and read by
`private.event_context()`), `moved {from_location_id, to_location_id}`,
`details_changed {fields}`, `price_changed {from, to}`, `cost_changed {}`,
`archived {}` / `unarchived {}`.

Cost gating uses Phase 3's mechanism: `authenticated` has no column grant on
`products.default_direct_cost`, `inventory_units.direct_cost` or
`inventory_movements.unit_cost_snapshot` (so `select *` fails; callers list
columns), and reads them through the definer `security_barrier` views
`product_costs`, `inventory_unit_costs` and `inventory_movement_costs`
(rows only for `view_costs`), which also give expected yield and expected
Cult Commons with exactly Phase 3's generated expression for quantity 1
(D1). `public.selling_prices` gives every active staff member the
effective selling price of each product (unit null) and unit. Direct API
writes of a cost column by a caller without `view_costs` are refused (42501)
whatever the value (an UPDATE naming the column is refused even when it
equals the stored cost, so the refusal is never an equality oracle on a
hidden cost) by two SECURITY INVOKER triggers, `products_cost_write_guard` and
`inventory_units_cost_write_guard` (invoker because inside a definer
function `current_user` is the owner; definer RPCs check `view_costs`
themselves). Definer writes to these tables re-raise check and not-null
violations without the row (`private.raise_without_row`).

Consigned stock (Phase 6 step 1, D45): consigned units are created only by
`create_consignment_item` (through `private.register_unit`), on dedicated
consignment-owned products. `private.selling_price` (replaced with the same
signature, attributes and grants) returns, for a unit with a consignment
item, `coalesce(item.asking_price, unit.sale_price, product.default_sale_price)`;
for a consignment-owned product with no unit given, the asking price of its
FIFO-head item (status `active` with `remaining_qty > 0` in
`reporting.consignment_item_position`, ordered by `received_at`, `short_id`)
coalesced with the product default; otherwise Phase 4's body unchanged.

Photos on stock (`product`, `inventory_unit`) are internal or public, never
customer (`attachment_stock_never_customer`, backstop CHECK
`attachments_stock_never_customer`; D13 extended, D19's pattern).

A shop bike linked to a unit that is available, reserved or
held_for_customer cannot be given to a customer or archived:
`bikes_guard_stock_link` (BEFORE UPDATE … WHEN customer_id or archived_at
changes) raises `bike_in_stock`. The other direction (D29): a unit whose
linked bike has a customer never goes back into stock; the reopen trigger
and `void_line` refuse with `bike_with_customer`, and
`private.assert_unit_consistent` is the backstop. `bikes.inventory_unit_id`
has its FK and a unique index; `private.register_unit` sets it.

`supplier_products` (Phase 7, §10): several suppliers per product, PK
(supplier_id, product_id), `supplier_sku`, `lead_days` 0..365, at most one
`preferred` per product (`supplier_products_one_preferred`), and the
supplier's `last_unit_cost` / `last_received_at`, written only by
`receive_purchase` (D63). `last_unit_cost` is a purchase cost (D60): no
column grant; read through `supplier_products_staff`. Links are written by
`set_supplier_product` / `remove_supplier_product` (manage_purchasing).

Quantity products print one QR (`P-...`) any number of times. Unique units
print their own (`U-...`). A bulk unit that becomes special is
`split_unit_from_stock` (Phase 4, D28; §16): a `stock_adjustment` of −1
on the source plus a new draft unique product and its available unit at
the same location, both carrying the source's default direct cost, and the
unit's +1 `stock_adjustment`; both movements have request_id = the new
unit id.

## 7. Inventory movement ledger

```
inventory_movements  (append-only for every writer; inserted only through private.record_movement,
                      its Phase 6 twin private.record_linked_movement, or Phase 7's
                      private.record_receipt_movement for purchase_received)
  id bigint identity PK
  product_id uuid not null -> products
  inventory_unit_id uuid null -> inventory_units
  location_id uuid not null -> locations
  quantity_delta integer not null check (<> 0 and |delta| <= 100000)
  movement_type movement_type not null
     -- enum: purchase_received | outside_purchase | job_consumption | retail_sale |
     --       online_sale | stock_adjustment | damaged | return | consignment_received |
     --       consignment_returned | transfer | reversal
     -- (outside_purchase since 20261014000800, D149a: twelve, SPEC §12's eleven extended)
  work_order_id uuid null -> work_orders
  work_order_line_item_id uuid null -> work_order_line_items
  sale_line_id uuid null                   -- FK in Phase 6
  purchase_receipt_line_id uuid null -> purchase_receipt_lines   -- FK since Phase 7
  consignment_item_id uuid null -> consignment_items   -- FK since Phase 6 step 1
  request_id uuid null                     -- the calling RPC's per-call key;
                                           -- a transfer's two rows share it
  reversal_of_id bigint null unique -> inventory_movements
  unit_cost_snapshot money_amount null ≥ 0 -- no column grant: inventory_movement_costs
  currency char(3) not null default 'SGD'  -- the product's
  reason text null                         -- non-blank, ≤ 500
  created_by uuid null -> staff, correlation_id text, created_at (clock_timestamp)
  check inventory_movements_unit_delta: inventory_unit_id is null or abs(quantity_delta) = 1
  check inventory_movements_reason_required: stock_adjustment/damaged need a reason
  check inventory_movements_reversal_shape: (type = reversal) = (reversal_of_id is not null)
  check inventory_movements_job_consumption_shape: job_consumption needs the job and line, delta < 0
  check inventory_movements_damaged_negative, inventory_movements_transfer_request
  check inventory_movements_purchase_received_has_receipt_line (Phase 7):
        movement_type <> 'purchase_received' or purchase_receipt_line_id is not null
  check inventory_movements_outside_purchase_shape (D149a, 20261014000900):
        movement_type <> 'outside_purchase' or (delta > 0, work_order_id, request_id and
        unit_cost_snapshot set; no unit, line, sale line, receipt line or consignment item)
```

`outside_purchase` (D149a, D149c(5)) is the receipt of an indent part
bought outside BICII, written only by `fit_part_bought_outside` (§5
"Closing indent items") through `private.record_movement`: +quantity at
the entered cost, `request_id` = the new job line's id, `work_order_id` =
the job, reason "Bought outside BICII for J-…". The same transaction's
`job_consumption` (through `add_inventory_line`) takes the quantity back
out at the same place and cost, so on-hand never moves. Its lock order is
the job (step 1), the request, `private.lock_stock(product)` (step 3), then
the products row `for no key update` (step 7), taken always, before the
cost is read and whether or not the cost changes: a direct cost edit (the
product page) waits, so the receipt, the line and its `job_consumption`
carry one cost. `add_inventory_line` takes the job and the stock again,
which the transaction already holds. It is not an adjustment
(D33's `private.is_significant_adjustment`, `daily_summary`,
`stock_adjustments_on` and `report_activity` read only `stock_adjustment`
and `damaged`) and not a purchase receipt (no receipt line; D105's
purchases leave it out, R-084). D50's movement rules refuse it on consigned
stock (`consignment_stock_adjust_blocked`); the RPC accepts shop-owned
quantity products only. Voiding the line writes the ordinary `reversal` of
its `job_consumption`, so the part goes back into stock at its cost and the
receipt row stays.

`request_id` replaces the original `transfer_group_id`: it is each call's
idempotency key, generated by the client for that one call. No RPC reuses
another entity's id or another call's key as its request_id, except that
`create_unique_unit` and `split_unit_from_stock` use the client's new unit
id, and `fit_part_bought_outside` (D149a) uses the client's new job line id
on its `outside_purchase` row; each is created for that one call.

The partial unique indexes are the idempotency guarantees. Phases 6, 7 and
10 rely on these exact predicates:

| Index | Predicate |
|---|---|
| `inventory_movements_job_consumption_once` | unique (work_order_line_item_id) where movement_type = 'job_consumption' |
| `inventory_movements_sale_line_once` | unique (sale_line_id) where movement_type in ('retail_sale','online_sale') |
| `inventory_movements_receipt_line_once` | unique (purchase_receipt_line_id) where movement_type = 'purchase_received' |
| `inventory_movements_request_once` | unique (request_id, product_id, location_id) where request_id is not null |
| `inventory_movements_reversal_of_id_key` | unique (reversal_of_id) |
| `inventory_movements_restock_once` | unique (sale_line_id) where movement_type = 'return' and sale_line_id is not null (Phase 6 step 2: a sale line is restocked at most once) |

Phase 6 step 2 (`20261004003500_sales.sql`) gave `inventory_movements.sale_line_id`
and `inventory_units.sold_sale_line_id` their foreign keys to `sale_lines`
(`on delete restrict`); `inventory_movements_sale_line_once` is unchanged.

Plus btree indexes on (product_id, location_id, id), (inventory_unit_id,
id), work_order_id, work_order_line_item_id, created_by and (id desc).

Phase 7 added only the foreign key
`inventory_movements_purchase_receipt_line_id_fkey` (→
`purchase_receipt_lines`, on delete restrict) and the check
`inventory_movements_purchase_received_has_receipt_line`; uniqueness per
receipt line is Phase 4's `inventory_movements_receipt_line_once`, and no
second index was added. Movements keep record time in `created_at` (there
is no effective-date column): a `purchase_received` movement's reason
carries the delivery time in shop time (`'PO-000034 received 25 Sep 2026
10:42'`), and purchasing reports and the last-cost order use
`purchase_receipts.received_at` (D64 D-RECEIPT-TIME).

`inventory_movements_enforce_rules` (BEFORE INSERT) requires a unit for a
unique product and forbids one for a quantity product, checks the unit's
product, requires a reversal to undo exactly one non-reversal movement
(same product, unit, location, opposite delta; `movement_invalid`), and
fills created_by and correlation_id. UPDATE and DELETE raise
`movement_append_only` for every writer.

CONS-STOCK-MOVES (D50; Phase 6 step 1): `inventory_movements_consignment_rules`
(BEFORE INSERT, definer, every writer; it runs before
`inventory_movements_enforce_rules`). For a consignment-owned product only
these are allowed: `consignment_received` (+, item set), `consignment_returned`
(−, item set), `retail_sale` / `online_sale` (−, sale line and item set),
`return` (+, sale line set), `job_consumption` (−, item set, D44),
`transfer`, and a `reversal` of a `transfer` or `job_consumption` (a NULL
item is copied from the original, so Phase 4's unchanged `void_line`
reversal stays linked). A listed type with the wrong shape is
`movement_invalid`; anything else (adjustments, damage, purchase receipts,
`create_unique_unit`, `split_unit_from_stock`) is
`consignment_stock_adjust_blocked`. For every product, a set
`consignment_item_id` must name an item of the same product and unit, and
`consignment_received` / `consignment_returned` on a non-consigned product
is `movement_invalid`. So on-hand of a consigned product always equals the
consignors' remaining quantity. An AFTER INSERT trigger writes a
`stock_returned` item event for each `consignment_returned` movement.

CONS-ITEM-LOCATION (D54; the Phase 6 review): the same trigger copies a
unit's `consignment_item_id` onto a consigned unit's movement that has
none (a transfer, a restock), and then refuses any movement of a
consignment-owned product without an item (`movement_invalid`). So
`private.consignment_item_on_hand(item_id, location_id)` (stable, definer,
no grant) = Σ quantity_delta of the item's movements at that location is
each consignor's stock per location; summed over locations it equals the
item's `remaining_qty`, and at every location the items' on-hand sums to
the product's (`tests/db/consignment-locations.test.ts`). Phase 4's
`transfer_stock` is replaced in `003300_consignment` (same signature and
grants): a transfer of consigned quantity stock writes its two rows
through `private.record_linked_movement` naming one item, the oldest
active item (`received_at`, `short_id`) with the whole quantity at the
source location, else `consignment_quantity_unavailable` (one consignor's
stock at a time: `inventory_movements_request_once` allows one row per
request, product and location).

Stock on hand is `reporting.stock_levels` (§14): the sum of quantity_delta
per product and location. A cached `inventory_balances` table may be added
later as a projection; `reporting.stock_reconciliation` (Phase 9) compares
the two.

Unique-unit invariant, proved by the database: two DEFERRABLE INITIALLY
DEFERRED constraint triggers named `inventory_unit_ledger_consistent` (on
inventory_movements after insert of a unit row; on inventory_units after
insert or a change of status, location or bike) call
`private.assert_unit_consistent(unit_id)` at commit: while available or
reserved the unit's ledger nets to 1 at its own location and 0 elsewhere; in
every other status it nets to 0 at every location; a linked bike points
back and, while the unit is available, reserved or held_for_customer, has no
customer (D29). Otherwise `unit_ledger_inconsistent`. held_for_customer ↔ sold (job
completion and reopen, D25) needs no movement.

**Global lock order** (binding for Phase 4 and every later phase that
touches stock):

1. the work_orders row FOR UPDATE, always through `private.lock_work_order`
   (never FOR SHARE on a work order before FOR UPDATE in one transaction);
2. the work_order_line_items row FOR UPDATE;
3. `private.lock_stock(product_id)` (a transaction advisory lock); several
   products in ascending product_id;
4. the bikes row FOR UPDATE (`create_unique_unit`, before `register_unit`
   links the bike; `void_line` and the reopen branch of
   `work_orders_sell_held_units`, before the unit, for the D29 owner check);
   several bikes in ascending id;
5. the inventory_units row FOR UPDATE; several units in ascending id;
6. (Phase 6) the consignment_items row FOR UPDATE; several in ascending id;
7. the products row FOR UPDATE (only `private.refresh_unique_publication`,
   `set_publication_status`, which takes `lock_stock(product)` first, and
   `return_consignment_item`'s archive; FOR NO KEY UPDATE by
   `fit_part_bought_outside` (D149a), after `lock_stock(product)`, and by
   the purchasing paths below).

Phase 6 step 2 paths: `record_retail_sale` inserts its header (0), then
3 (every product on the sale, units' products read unlocked, ascending) →
5 (units, ascending) → 6 (the units' items, any named item and every
active item of each consigned quantity product, ascending) → 7
(`refresh_unique_publication` per unique product sold, ascending).
`restock_unit` takes 0b (a consigned unit's consignor FOR SHARE) → 3 → 4
(its bike) → 5 → 6 → 7; a job reopen (`work_orders_sell_held_units`, under
1) takes the consignors of its consigned lines FOR SHARE before 6, which
is safe because nothing holding a consignor lock waits on 1–5.
`record_settlement`
inserts its header (0), then the consignor FOR SHARE (0b) and its items
FOR UPDATE (6); `reverse_settlement` locks its settlement row, then the
consignor FOR SHARE; `record_sale_refund` locks only its sale row.
Archiving a consignor (a plain UPDATE of 0b) takes its items FOR SHARE
(6) in its trigger, so an in-flight sale, restock or completion finishes
first and the balance check sees it.

Stripe paths (Phase 14, §19): the `stripe_events` row is inserted with no
FK value set (it locks no job), then
`private.lock_stripe_payment_intent(pi)` (a transaction advisory lock taken
only by the Stripe apply paths, always before the job, so no cycle with
any other path), then 1 (`private.lock_work_order`), then the payment row
FOR UPDATE, `payment_refunds` rows, `work_order_events` inserts and last
the `stripe_events` decision UPDATE (its FK KEY SHARE on the job comes
after the FOR UPDATE). `record_stripe_read`'s mismatch path takes 1
without the advisory lock and takes none after it. Step 2's
`record_deposit_checkout` takes 1, then the quote FOR UPDATE, then inserts
the payment (no advisory lock); `prepare_deposit_checkout` takes no lock;
`order_part_requests`' D152 gate reads `payments` under the job locks it
already holds. Step 3 (§19 "Lock order, step 3") takes no Stripe advisory
lock: `record_counter_payment` takes 1, answers a replay, then takes the
quote FOR UPDATE (by id and job), then inserts; `void_counter_payment`
takes 1, then the `counter_payments` row FOR UPDATE; `send_balance_link`
takes 1, then withdraws the live link and inserts; `record_balance_checkout`
takes 1, then the `balance_links` row FOR UPDATE, then inserts the payment;
the `work_orders_withdraw_balance_link` trigger updates the live link under
1 (the status UPDATE's row lock), after whatever that path already holds,
which is safe because every other `balance_links` writer takes 1 first. The
D152 gate now reads `quote_deposits`, so `payments`, `counter_payments` and
`counter_payment_voids`, under the same job locks.

Phase 6 adds, outside and before this order: step 0, the request's own
idempotency lock (`create_consignment_item`'s
`pg_advisory_xact_lock(hashtextextended('bicii.consignment_item:' || item_id, 0))`;
step 2's sale and settlement header inserts), and step 0b, the `consignors`
row FOR SHARE (intake checks it is not archived; archiving is a plain UPDATE
that takes nothing else). A path that starts from an item reads its
immutable `product_id` and `inventory_unit_id` without a lock, then takes
3 → 5 → 6 and re-reads it (`private.lock_consignment_item`).

Every RPC takes its locks before its replay check and any other read;
functions that lock and then read stay VOLATILE.

Private extension points (security definer, no grants):

| Function | Contract |
|---|---|
| `private.record_movement(product, unit, location, delta, type, reason, unit_cost_snapshot, request_id, work_order_id, line_id, reversal_of_id)` | THE single insert path; currency from the product; refuses an inactive location except for a reversal |
| `private.record_linked_movement(…the same eleven…, sale_line_id, consignment_item_id)` | Phase 6's twin with exactly the same rules (P0002 for a missing product or location, `location_inactive` unless a reversal, check and not-null violations without the row) that also writes `sale_line_id` and `consignment_item_id`; `record_movement` is unchanged (the purchasing track added its own twin the same way). No grants |
| `private.record_receipt_movement(product, location, quantity, unit_cost_snapshot, purchase_receipt_line_id, reason)` | Phase 7: the purchase twin of `record_movement` (which has no receipt-line parameter and is left alone). Same rules: currency from the product, P0002 for a missing product or location, `location_inactive`, check/not-null violations re-raised without the row; movement_type `purchase_received`; Phase 6's D50 trigger refuses it on a consigned product (`consignment_stock_adjust_blocked`), and D62 keeps such products off every PO. Called only by `receive_purchase` |
| `private.register_unit(unit_id, product, location, ownership, serial, condition, sale_price, direct_cost, bike_id, consignment_item_id)` | THE single unit-creation path, plus the bike link; Phase 6 creates consigned units through it |
| `private.selling_price(product_id, unit_id)` | THE single selling-price source: unit.sale_price, else product.default_sale_price. Phase 6 step 1 replaced it (same signature, `language sql stable security definer`, grants re-stated) to return the consignment asking price (§6, D45); Phase 8 labels and Phase 10 Shopify use it unchanged. EXECUTE for authenticated and anon, because the cost views and `reporting.public_items` call it as the caller (`create or replace` keeps the grants) |
| `private.lock_stock(product_id)` | the per-product stock lock |
| `private.stock_on_hand(product_id, location_id)` | ledger on-hand |
| `private.refresh_unique_publication(product_id)` | public → sold when no unit is in stock and one is sold; sold → public when a unit is available again (skips requirements). Every path that makes a unit available calls it after the unit change: `void_line`, `create_unique_unit` (a new unit on a sold product), and `restock_unit` (Phase 6) |
| `private.publication_transition_allowed`, `private.unit_status_transition_allowed`, `private.publication_requirements_met` | the state machines and publication requirements |
| `private.set_event_context(jsonb)`, `private.event_context()` | transaction-local extra keys for unit history |

## 8. Sales (non-workshop revenue)

Built in Phase 6 step 2 (`20261004003500_sales.sql`; PLAN D1, D7, D9,
D14, D24, D26, D29, D44–D46, D48, D49, D53). Workshop revenue is recorded
on `work_order_line_items`. Everything else that sells stock
(over-the-counter, Shopify in Phase 10, a consigned bike sold in store) is
a `sale`:

```
sales                                      -- immutable except status; never deleted
  id uuid PK                               -- client-supplied: the sale's idempotency key
  sale_number text not null unique         -- S-######, by trigger, immutable (D9)
  source sale_source not null default 'retail'
     -- enum: retail | online_shopify | work_order (Phase 6 writes retail;
     --   work_order reserved)
  customer_id uuid null -> customers
  work_order_id uuid null -> work_orders   -- reserved, no UI
  shopify_order_id text null unique, shopify_order_name text null   -- Phase 10
     -- gid Order (sales_shopify_order_id_format)
  shopify_customer_id text null            -- Phase 10: the order's Shopify customer (gid);
                                           --   customer_id only when already linked (D86)
  integration_event_id uuid null -> integration_events   -- Phase 10: the event that recorded it
  -- sales_shopify_shape: an online_shopify sale has a shopify_order_id; any
  --   other sale carries none of the three Shopify columns
  recognized_at timestamptz not null       -- recognition (§14); past allowed
                                           --   (D55: never before the stock was
                                           --   with the shop), never > now() + 5 min
  status sale_status not null default 'recorded'
     -- enum: recorded | partially_refunded | refunded | voided
     --   (voided reserved: never written, excluded by every view)
  currency char(3) not null, notes text null (≤ 2000)
  request_fingerprint text null            -- never granted
  created_by, created_at, updated_at
  -- sales_enforce_rules: number on insert; afterwards only status and
  --   updated_at change (sale_immutable, sale_number_immutable); no DELETE

sale_lines                                 -- written only by private.sell_line
  id uuid PK default gen_random_uuid()
  sale_id -> sales, line_number smallint (unique per sale, ≥ 1)
  product_id -> products, inventory_unit_id null -> inventory_units,
  consignment_item_id null -> consignment_items
  description_snapshot text (1..300)
  quantity line_quantity (> 0, integral)
  unit_sale_price_snapshot, unit_direct_cost_snapshot money_amount (≥ 0;
     0 is a known value, D14/D24)
  consignor_payout_snapshot money_amount null (≥ 0, per unit; consigned only)
  cult_commons_rate_snapshot rate_fraction (the rate at recognized_at)
  currency char(3)
  sale_total, cost_total, yield_total, cult_commons_share   -- generated as in §5
  shopify_line_item_id text null          -- gid LineItem; written only at insert (Phase 10);
                                           --   record_retail_sale refuses the key
  shopify_line_part smallint null          -- D80: 1 / 2 for a split uneven quantity line;
                                           --   needs a line id (sale_lines_shopify_line_part_check)
  restocked_at timestamptz null, restocked_by null -> staff   -- once, by restock_unit
  created_at
  checks: sale_lines_unit_quantity_one, sale_lines_consignment_payout
    ((consignment_item_id is null) = (consignor_payout_snapshot is null)),
    sale_lines_restock_unit_only, sale_lines_restock_shape
  unique index sale_lines_unit_sells_once (inventory_unit_id)
    where inventory_unit_id is not null and restocked_at is null
  unique index sale_lines_shopify_line_part_key
    (shopify_line_item_id, inventory_unit_id, shopify_line_part) nulls not distinct
    where shopify_line_item_id is not null   -- replaces the single-column unique
    (Phase 10, D80): one sale line per unit, or two parts, per Shopify line
  -- sale_lines_immutable: only restocked_at / restocked_by change, once,
  --   from null; no DELETE

sale_refunds                               -- append-only (sale_refund_immutable)
  id uuid PK (client id), sale_id -> sales, shopify_refund_id text null unique (gid Refund),
  amount money_amount (> 0), currency, reason text (1..500),
  restocked boolean not null default false -- always false: Phase 10 keeps Shopify's
                                           --   restock claims in the event result (D85);
                                           --   a refund never moves stock (D7)
  recorded_by (null for a Shopify refund), integration_event_id null -> integration_events,
  created_at
```

Deviation from the original design (D46): `sale_lines.inventory_unit_id` is
not a plain `unique`. The partial unique index `sale_lines_unit_sells_once`
allows at most one live (not restocked) line per unit, so a unit is sold
again only after `restock_unit` marked its previous line restocked.

A unit line snapshots cost = `coalesce(unit.direct_cost,
product.default_direct_cost)` for shop stock, or the item's agreed amount
plus its live shop-borne charges for consigned stock (payout = the agreed
amount, D4/D44). A quantity line snapshots `product.default_direct_cost`, or
for consigned stock the agreed amount of the one item it draws from (the
named one, else the FIFO head whose remaining quantity covers it, D45). The
price defaults to `private.selling_price` (a consigned quantity line: its own
item's asking price, else the product default) and any staff member may
override it (D53). NULL price → `sale_price_required`; NULL cost →
`sale_cost_missing`. A retail sale never takes stock below zero
(`insufficient_stock`).

A refund is a financial fact (D7, D49). It does not touch stock or units;
reports do not net it (Phase 6, and Phase 10 for online refunds, D85). Putting a unique item back on the floor
is a separate staff action (`restock_unit`) that writes a `return` movement
linked to the sale line, marks the line restocked and flips the unit back to
`available`, with a reason.

## 9. Consignment

Built in Phase 6 step 1 (`20261004003300_consignment.sql`,
`20261004003400_consignment_job_parts.sql`; PLAN D4, D44–D52, ADR-016) and
step 2 (settlements, reversals and the ledgers:
`20261004003600_consignment_settlements.sql`; D46, D47).

```
consignors
  id uuid PK default gen_random_uuid()      -- the app supplies it (idempotent create)
  customer_id uuid null -> customers       -- unique where not null (consignors_customer_id_key)
  display_name text not null (trimmed, 1..200)
  email citext null (customers' shape), phone text null (≤ 40)
  payout_details text null (≤ 2000)        -- manage_consignments only: no column grant
  internal_notes text null (≤ 10000)
  search_text, phone_digits generated (trigram indexes)
  created_by null -> staff, created_at, updated_at, archived_at
  -- consignors_normalize trims and nulls blanks; consignors_enforce_rules:
  -- created_by, customer_archived on linking an archived customer,
  -- consignor_has_open_items when archiving with an active item, and
  -- consignor_has_balance when its ledger outstanding is not exactly 0
  -- (step 2, D47; the detail gives the amount and, when overpaid, D46's
  -- remedies)

consignment_items                          -- rows only from create_consignment_item
  id uuid PK                               -- client-supplied: the intake's idempotency key
  short_id text not null unique            -- C-######, by trigger, immutable (D9)
  consignor_id -> consignors, product_id -> products   -- immutable
  inventory_unit_id uuid null unique -> inventory_units   -- unique items; immutable
  quantity integer not null default 1 (1..9999)        -- 1 for a unique item; immutable
  received_at timestamptz not null         -- immutable
  agreed_amount_owed money_amount not null (≥ 0; per unit; 0 is known, D24)
                                           -- consignment money: no column grant
  asking_price money_amount null (≥ 0)
  currency char(3) not null                -- the product's; immutable
  status consignment_status not null default 'active'
     -- enum: active | sold | returned | withdrawn (withdrawn reserved, never written)
  sold_at, returned_at timestamptz null, return_reason text null (≤ 500)
  agreement_notes (≤ 2000), internal_notes (≤ 10000)
  request_fingerprint text null            -- the intake's; never granted; immutable
  created_by, created_at, updated_at
  checks: consignment_items_unit_quantity_one, _returned_has_date,
    _sold_has_date ((status = 'sold') = (sold_at is not null))
  -- consignment_items_enforce_rules: consignment_item_immutable,
  -- consignment_item_short_id_immutable, reason_required for a new agreed
  -- amount without private.change_reason()

consignment_item_charges                   -- D4; voided, never edited or deleted
  id uuid PK (client id), consignment_item_id -> consignment_items,
  description text (trimmed, 1..200), amount money_amount (> 0), currency,
  bearer charge_bearer not null            -- enum: consignor | shop; NO default (D4)
  work_order_id uuid null -> work_orders   -- the job that did the work, optional
  created_by, created_at, voided_at, voided_by, void_reason (≤ 500)
  check consignment_charges_void_has_reason; trigger consignment_charges_immutable
  -- consignor: deducted from what is owed (step 2's ledger)
  -- shop: added to the item's direct cost; unique items only, while the unit
  --   is available (D45)

consignment_item_events                    -- append-only (consignment_history_append_only)
  id, consignment_item_id, event_type consignment_item_event_type,
  payload jsonb (object), reason (≤ 500), actor_staff_id, correlation_id, created_at
  -- written only by definer triggers:
  --   received {quantity, agreed_amount_owed, asking_price, product_id,
  --             inventory_unit_id, bike_id}            (item insert)
  --   terms_changed {field: {from, to}}, reason       (agreed / asking change)
  --   status_changed {from, to} || event context, reason   (status change)
  --   charge_added {charge_id, description, amount, bearer}
  --   charge_voided {same}, the void reason
  --   stock_returned {movement_id, quantity, location_id, inventory_unit_id},
  --             the movement's reason          (each consignment_returned movement)
```

`reporting.consignment_item_position` (security_invoker, granted to no API
role; read by definer functions) is the ONLY derivation of an item's
quantities and liability. Per item: `consignment_item_id, consignor_id,
product_id, inventory_unit_id, quantity, sold_qty, restocked_qty,
job_held_qty, job_sold_qty, returned_qty, remaining_qty, owed_qty,
liability, last_sale_at, last_returned_at, consignor_charges, shop_charges`.

- `job_held_qty` / `job_sold_qty`: Σ quantity of live job lines naming the
  item whose job has no `completed_at` / has one (D44).
- `returned_qty` = −Σ `quantity_delta` of the item's `consignment_returned`
  movements; `last_returned_at` their latest time.
- `sold_qty` = Σ quantity of the item's sale lines on sales that are not
  voided; `restocked_qty` = Σ of those with `restocked_at` (step 2 replaced
  the view body, same columns, same order).
- `remaining_qty = quantity − (sold_qty − restocked_qty) − job_held_qty −
  job_sold_qty − returned_qty`; `owed_qty = (sold_qty − restocked_qty) +
  job_sold_qty`.
- `liability = round(Σ quantity × consignor_payout_snapshot, 2)` over live,
  non-restocked sale lines and the job-sold lines; `last_sale_at` = the
  latest of those sales' `recognized_at` and those jobs' `completed_at`.
- `consignor_charges` / `shop_charges` = Σ non-voided charges by bearer.

Item status (`private.refresh_consignment_item_status(item_id)`, the caller
holding the item lock): `remaining_qty < 0` → `consignment_quantity_negative`
(an internal guard); `withdrawn` stays; `remaining_qty > 0 or job_held_qty >
0` → `active`; else `owed_qty > 0` → `sold` (`sold_at = last_sale_at`); else
`returned` (`returned_at = now()`, `return_reason = change_reason()`). It
updates only on a real change, so one `status_changed` event per change.

Consigned parts (D44): the item is sold, and its liability exists, exactly
while its line is live and the job has a `completed_at`. A reopen returns the
item to `active` and removes the liability until the job is completed again;
a repeated completion or a replay never adds a second liability, because
nothing is stored. A void on the open job writes Phase 4's linked reversal,
which the D50 trigger links to the item. A consigned part goes back to the
consignor by reopen + void + `return_consignment_item`, never by
`restock_unit`. A reopen of a job with a consigned part of an archived
consignor is refused (`consignor_archived`, D47: an archived consignor
keeps no stock with the shop and a balance of 0), as is a restock of a
consigned unit whose consignor is archived.

Bikes (D51): a unique intake may link a shop bike record (not archived, no
owner, not already a unit: `bike_archived`, `bike_has_owner`,
`bike_already_linked`); a consignor's own bike is first transferred to the
shop with `transfer_bike_ownership` and a reason. The link is two-way
(`private.register_unit`), is not transferred on sale and stays after a
return, so that bike record cannot be consigned again
([R-020](RISKS.md#r-020--a-bike-record-consigned-once-cannot-be-consigned-again)).

Photos (D52): `consignment_item` is an attachable entity
(`private.attachment_entity_exists` gained the branch); its photos are
internal only: trigger `attachments_consignment_item_internal_only` raises
`attachment_consignment_internal_only` for `customer` or `public`, and the
CHECK of the same name is the backstop. Listing photos go on the product or
unit.

Settlements (step 2, D47), all three append-only (`settlement_immutable`
for every writer):

```
consignment_settlements
  id uuid PK                               -- client-supplied: the idempotency key
  consignor_id -> consignors
  amount money_amount not null (> 0)       -- = Σ its allocations exactly
  currency char(3), paid_at timestamptz not null (never > now() + 5 min)
  reference text null (≤ 200), notes text null (≤ 2000)   -- trimmed
  request_fingerprint text null            -- never granted
  created_by, created_at

settlement_lines
  id uuid PK default gen_random_uuid(), settlement_id, consignment_item_id,
  amount_applied money_amount (> 0)
  override_reason text null (non-blank, ≤ 500)   -- required above max(outstanding, 0)
  unique (settlement_id, consignment_item_id)

consignment_settlement_reversals
  id uuid PK (client id), settlement_id uuid not null unique,
  reason text (1..500), created_by, created_at
```

The ledgers (security_invoker views, granted to no API role, read by the
definer RPCs; nothing below is stored):

- `reporting.consignor_item_ledger`: every column of
  `consignment_item_position`, the item's `short_id, status, received_at,
  sold_at, returned_at, return_reason, agreed_amount_owed, asking_price,
  currency`, and `owed = liability − consignor_charges`, `paid` = Σ
  `amount_applied` of settlements that are not reversed, `outstanding =
  owed − paid`, `last_settlement_at` (latest `paid_at` of those).
- `reporting.consignor_ledger`: per consignor `consignor_id, display_name,
  customer_id, archived_at, currency, items_total, active_items,
  awaiting_settlement_items` (outstanding > 0), `returned_items`,
  `sold_items` (status sold), Σ
  `liability, consignor_charges, owed, paid, outstanding`, `last_sale_at,
  last_settlement_at`; it equals the sum of its item rows.

Per D46: liability counts live, non-restocked consigned sale lines and live
consigned job lines of completed jobs; a restock removes a sale line's
liability, a reopen a job line's. Outstanding may go negative (money paid
stays paid): shown as "Overpaid $x (consignor owes the shop)", never
"credit", and cleared only by a later sale, by voiding a consignor charge or
by reversing a settlement. A refund alone does not change the liability
(D7). Selling an item does not create a settlement: liability and
settlement are separate facts. A settlement replay with the same
fingerprint returns it even after the outstanding changed. A consignor is
archived only with no active item and an outstanding of exactly 0.

Overdue consignor money (Phase 9 step 3, D107): an item with
`outstanding > 0` whose latest sale (`last_sale_at`) is more than
`shop_settings.consignment_settlement_alert_days` shop days ago (default
30, 1..365, admin only through `set_consignment_settlement_alert_days`) is
an `unsettled_consignment` operational exception (§14), visible only to
consignment money viewers (D48, D108). It is computed live and clears when
the item is settled, restocked or returned.

## 10. Suppliers and purchasing

Built in Phase 7 (migrations `20261005000100_suppliers`,
`20261005000200_purchase_orders`, `20261005000300_purchase_receiving`;
PLAN D5, D9, D24 as amended, D60–D65). Every table is staff-readable
(RLS `private.is_staff()`), has no DELETE grant, and is written only
through the §16 RPCs, except `suppliers` (column grants, manage_purchasing
policies).

```
suppliers                                   -- soft delete only; no `active` column
  id uuid PK (client-supplied on create, like customers)
  name text not null                        -- trimmed, non-blank, ≤ 200; unique among
                                            -- active rows: suppliers_name_active_key on lower(name)
  contact_name ≤ 200, email citext (customers' shape check), phone ≤ 40,
  website ≤ 300 matching ^https?://\S+$, account_reference ≤ 100
  (BICII's account number at the supplier), notes ≤ 10000   -- blanks stored as NULL
  search_text (generated: lower name, contact, email, account ref),
  phone_digits (generated, as customers)    -- both trigram GIN
  created_at, updated_at, archived_at
  BEFORE UPDATE suppliers_guard_open_orders: archiving with a draft, submitted or
  partially_received PO raises supplier_has_open_orders

supplier_products                           -- §6; several suppliers per product
  PK (supplier_id, product_id), both on delete restrict; index (product_id)
  supplier_sku ≤ 100, lead_days 0..365, preferred boolean (unique index
  supplier_products_one_preferred on (product_id) where preferred)
  last_unit_cost money_amount ≥ 0 null      -- D60: no column grant; supplier_products_staff
  currency char(3) not null (no default)    -- the product's on link, the PO's on receipt
  last_received_at timestamptz null, created_at, updated_at

purchase_orders
  id uuid PK (client-supplied; create is replay-safe by id)
  po_number text unique, ^PO-[0-9]{6}$       -- always assigned by the BEFORE INSERT
                                            -- trigger from private.next_short_id('PO'),
                                            -- immutable (purchase_order_number_immutable)
  supplier_id -> suppliers (changes only while draft: purchase_order_supplier_locked;
                            an archived supplier is refused: supplier_archived)
  status purchase_order_status default 'draft'
     -- draft | submitted | partially_received | received | cancelled
  expected_at date, supplier_reference ≤ 100 (the supplier's order/quote no.),
  currency char(3) not null                 -- private.shop_currency() at creation (D62)
  notes ≤ 2000, created_by/at, updated_at
  submitted_at/by, received_at (when fully received), cancelled_at/by,
  cancellation_reason (non-blank, ≤ 500)
  checks: (status = draft) = (submitted_at is null) or cancelled;
          (status = received) = (received_at is not null);
          (status = cancelled) = (cancelled_at and cancellation_reason are set)
  indexes (supplier_id, created_at desc), (status, expected_at)

purchase_order_lines
  id uuid PK, purchase_order_id, product_id (restrict)
  quantity_ordered integer 1..100000
  unit_cost money_amount 0..99999.99        -- D60: no column grant; 0 is valid (D24 amended)
  currency char(3)                          -- copied from the PO
  ordered_total generated round(quantity_ordered × unit_cost, 2)   -- no column grant
  expected_at date (overrides the PO's), notes ≤ 500, created_by/at, updated_at
  unique purchase_order_lines_product_once (purchase_order_id, product_id)
  -- quantity received is derived from purchase_receipt_lines

purchase_order_events                       -- append-only (purchase_order_history_append_only)
  id, purchase_order_id, event_type purchase_order_event_type
     -- created | details_changed | line_added | line_changed | line_removed |
     -- submitted | received | status_changed | cancelled
  purchase_order_line_id uuid (no FK: removed lines keep their events),
  purchase_receipt_id -> purchase_receipts, payload jsonb object (may carry costs),
  reason ≤ 500, actor_staff_id, correlation_id, created_at clock_timestamp()

purchase_receipts                           -- immutable (purchase_receipt_immutable)
  id uuid PK, purchase_order_id
  idempotency_key uuid not null, unique purchase_receipts_idempotency_key_key
  reference ≤ 100 (delivery note; NOT unique: suppliers reuse it for split deliveries)
  received_at timestamptz not null (D64), received_by -> staff, notes ≤ 2000,
  correlation_id, created_at clock_timestamp(); index (purchase_order_id, received_at)

purchase_receipt_lines                      -- immutable
  id uuid PK, purchase_receipt_id, purchase_order_line_id, product_id (copied
  from the PO line), location_id, line_number smallint (1-based input order,
  unique per receipt), quantity_received 1..100000,
  unit_cost_actual money_amount 0..99999.99 not null   -- D60; never NULL
  currency (the PO's), received_total generated round(qty × cost, 2)  -- D60
```

**History.** Triggers write `purchase_order_events` through
`private.record_purchase_order_event` (actor `private.current_staff_id()`,
correlation `private.current_correlation_id()`): INSERT on a PO →
`created {supplier_id, expected_at}`; UPDATE → `details_changed
{field: {from, to}}` for supplier_id, expected_at, supplier_reference and
notes (nothing changed → no event), draft→submitted → `submitted`, any move
to cancelled → `cancelled` with the cancellation reason, any other status
change → `status_changed {from, to}`; changes to created_at, submitted_at or
received_at alone write nothing. Lines: `line_added {product_id,
quantity_ordered, unit_cost, expected_at}`, `line_changed {field: {from,
to}}` (quantity_ordered, unit_cost, expected_at, notes) with
`private.change_reason()`, `line_removed` with the deleted row and the
reason. `receive_purchase` writes `received` itself.

**Receiving** (`receive_purchase(purchase_order_id, idempotency_key, lines
jsonb, reference, received_at, notes)`), in this order:

1. `manage_purchasing`; nulls 22004; `lines` must be a JSON array of at most
   200 objects (22023); empty → `purchase_receipt_empty`.
2. Fast path: a receipt with this key on this PO whose lines match
   (`private.purchase_receipt_matches`: same element count, same set of
   (purchase_order_line_id, location_id) keys with the same quantities; a
   supplied `unit_cost_actual` must equal the stored cost, an omitted one
   matches on the rest; never the PO line's current cost) is returned and
   NOTHING is written. Any other receipt with the key →
   `purchase_receipt_key_reused`.
3. Lock the PO FOR UPDATE (P0002), then repeat step 2.
4. draft → `purchase_order_not_submitted`; received or cancelled →
   `purchase_order_closed` (D65).
5. Parse each element: quantity a whole number 1..100000
   (`purchase_receipt_quantity_invalid`); the line on this PO
   (`purchase_receipt_line_foreign`); cost 0..99999.99
   (`purchase_receipt_cost_invalid`), absent or null → the PO line's
   `unit_cost` (0 is valid); the location exists (P0002) and is active
   (`location_inactive`); a (line, location) pair once
   (`purchase_receipt_line_duplicate`; one line split across locations is
   fine). The product's active/archived state is not re-checked (the goods
   arrived; SPEC §23).
6. Over-receipt per PO line under the PO lock: received + this call ≤
   ordered, else `purchase_over_receipt` (DETAIL names the product and the
   ordered, received and attempted quantities); nothing is written.
7. `effective = coalesce(received_at, now())`: > now() + 5 min →
   `purchase_receipt_in_future`; < now() − 30 days → `purchase_receipt_too_old`;
   < the PO's submitted_at → `purchase_receipt_before_submission` (D64).
8. Insert the receipt; a `unique_violation` on the key (a concurrent call on
   another PO) gives step 2's answer.
9. `private.lock_stock(product)` for each product, ascending, before any
   receipt line or movement.
10. Receipt lines in input order, then one `purchase_received` movement per
    receipt line through `private.record_receipt_movement` (ordered by
    product, location, line_number): quantity, `unit_cost_snapshot =
    unit_cost_actual`, `purchase_receipt_line_id`, reason `'PO-000034
    received 25 Sep 2026 10:42'` (effective, in `private.shop_timezone()`).
    No stock check (receiving only adds).
11. Last cost (D5 as refined by D63): with the change reason `'Received on
    PO-000034 (delivery note DN-5531)'` set, for each product in ascending id
    the candidate is the cost of its highest line_number line in this
    receipt (0 included). `products.default_direct_cost` takes it when it
    differs and no receipt line of that product belongs to another receipt
    that is later by (received_at, created_at, id); Phase 4's
    `products_record_history` writes the `cost_changed` event with the
    reason. Then `supplier_products (po.supplier_id, product)` is upserted:
    `last_unit_cost` by the same rule restricted to that supplier's POs (a new
    link takes the candidate), `last_received_at = greatest(existing,
    effective)`, currency = the PO's. No snapshot (`work_order_line_items`,
    existing movements) is touched.
12. The `received` event `{reference, received_at, units, lines:
    [{purchase_order_line_id, product_id, quantity_received, location_id}]}`.
13. `private.refresh_purchase_order_status(po, effective)`: acts only on
    submitted / partially_received; every line received in full → `received`
    with `received_at = effective`; else any receipt → `partially_received`;
    else `submitted`. Its `status_changed` event therefore follows `received`.
14. Return the receipt. `purchase_receipt_by_key(key)` finds it after a lost
    response.

Interaction with Phase 4: the movement insert fires
`inventory_movements_enforce_rules` (fills created_by = the caller's staff
id and the correlation id; a quantity product never names a unit); the
products update fires `products_enforce_rules` and `products_record_history`;
`products_cost_write_guard` is SECURITY INVOKER and does not fire inside the
definer RPC (current_user is the owner), which is intended: the RPC's own
guard is manage_purchasing (D60). `inventory_movements_receipt_line_once` is
the ledger backstop for "one movement per receipt line".

**Global purchasing lock order** (extends §7's): (1) the purchase_orders row
FOR UPDATE; (2) that PO's lines, read or changed only under the PO lock;
(3) `private.lock_stock(product_id)` for every product a receipt touches,
ascending, before any receipt line or movement (§7 step 3); (4) products
rows, updated in ascending id (§7 step 7, the last inventory lock); (5)
supplier_products rows in ascending product id. `set_supplier_product`
holds no PO: it locks the products row FOR NO KEY UPDATE, then
supplier_products (4 then 5), which serialises concurrent preference changes
even before a link exists. Purchasing RPCs never lock work orders, bikes or
units.

**D60 D-PO-COSTS (cost gating).** `private.can_view_purchase_costs()` =
view_costs OR manage_purchasing (security definer, EXECUTE to authenticated
for policies and views). authenticated has no column grant on
`supplier_products.last_unit_cost`, `purchase_order_lines.unit_cost` /
`ordered_total` or `purchase_receipt_lines.unit_cost_actual` /
`received_total`; they are read through the definer, security_barrier views
`supplier_products_staff`, `purchase_order_lines_staff` (+ received_value),
`purchase_receipt_lines_staff` and `purchase_order_totals_staff` (ordered,
received and outstanding value; outstanding only while submitted or
partially received), each filtered by that function. `purchase_order_events`
rows are visible to staff who pass it (payloads carry costs). manage_purchasing
opens no Phase 3/4/5 cost, yield or financial surface.

**Currency (D62).** A PO's currency is `private.shop_currency()` at
creation; lines and receipt lines copy it; a line's product must have the
same currency (`purchase_currency_mismatch`). A PO orders quantity-tracked
(`purchase_line_unique_product`), shop-owned (`purchase_line_not_shop_owned`),
active, non-archived (`purchase_line_product_inactive`) products, once per
PO (`purchase_line_duplicate_product`). Since Phase 6 a product's ownership
can be `consignment` (D45); such products are never purchased: the PO line,
`create_purchase_order_from_low_stock` and `set_supplier_product` (no
supplier link on a non-shop-owned product, added at the Phase 7
integration) refuse them with `purchase_line_not_shop_owned`,
`purchase_cost_defaults` and `reorder_suggestions` leave them out
(`reorder_suggestions` joins `public.products` and keeps
`ownership_type = 'shop_owned'`, because `reporting.low_stock` keeps
consigned products too), and
Phase 6's D50 trigger would refuse a `purchase_received` movement on one
(`consignment_stock_adjust_blocked`). `tests/db/purchasing.test.ts`
("Phase 6's consigned stock is never purchased") proves it on the seeded
jerseys.

## 11. QR identity and publication

- Every product, inventory unit and bike has a `short_id`. The QR payload is
  the URL `{shop_settings.public_site_url}/q/{short_id}` and nothing else
  (D9, decided in Phase 8: [ADR-017](decisions/ADR-017-labels-and-qr-base.md)).
  - `private.qr_payload(short_id)` is the only payload source for
    printing and `private.label_content` (§12) the only source of label
    text. The payload is `rtrim(public_site_url, '/') || '/q/' ||
    short_id` (one slash before `q`, also under a path base such as
    `https://bicii.sg/shop`). There is NO fallback: a missing row, a null
    or a malformed address raises P0001 `public_site_url_invalid` and
    nothing prints until an admin sets it (Settings → Labels and printers,
    `/settings/labels`, through `update_shop_settings`). A short ID that is
    not `(PO|B|J|P|U|C|S)-` + 6 digits is 22023.
  - `shop_settings_public_site_url_check` was tightened by
    `20261004003800_labels.sql` to exactly the rule `qr_payload` applies:
    `public_site_url ~ '^https?://[^/?#[:space:]]+(/[^?#[:space:]]*)?$'`
    and at most 200 characters (http or https, a host, an optional path,
    no query, no fragment, no whitespace); the cases are
    `tests/fixtures/qr-bases.ts`, shared with the TypeScript validator
    (`isValidQrBase` / `QR_BASE_PATTERN` in `src/lib/ids.ts`,
    `tests/unit/qr-base.test.ts`). The column has no default.
  - The app side (Phase 8 step 2, `src/lib/qr.ts`, server only): the app
    never builds a payload for printing (the job carries the database's
    `qr_payload`). What it DISPLAYS comes from the same column:
    `getQrBase()` reads `shop_settings.public_site_url` (row 1) with the
    request's RLS client once per render and returns it without trailing
    slashes when `isValidQrBase`, else null, with no environment fallback;
    `qrUrl(shortId)` is `{base}/q/{shortId}` or null, shown as "QR address
    not set" (`QrLabelUrl`, `src/components/domain/qr-label-url.tsx`) on
    the product and unit pages. `NEXT_PUBLIC_PUBLIC_SITE_URL` is read only
    in `src/lib/env.ts` and `src/lib/qr.ts` (`tests/unit/qr-base-sources.test.ts`)
    and is only an extra accepted scan base: `scanBases()` =
    `mergeScanBases(database base, environment base)` (`src/lib/scan.ts`),
    so labels printed against it keep scanning.
  - Labels of published products and units resolve publicly: a unit's
    label is its U- ID, and `reporting.public_items` has a row per
    published unit (D57). A bike tag (B-) resolves to "not found"
    publicly. The staff panel "What the public sees" (`PublicPreviewPanel`
    in `src/components/domain/public-preview.tsx`, read by
    `publicPreview()` in `src/lib/domain/inventory.ts`) reads the same
    view, which returns identical rows to anon and to staff for the same
    short ID (tested in `tests/db/labels.test.ts`), so it is exactly what
    an anonymous scan gets. Phase 8 adds no anonymous function, no
    `public.public_item` (Phase 11 creates it) and no anon client.
- The public site route `/q/[shortId]` resolves the ID through
  `reporting.public_items` (built in Phase 4, `20261004002100_inventory_publication.sql`;
  below). Unknown or unpublished IDs are simply absent from it, so they
  404 identically and the URL space leaks nothing.
- `reporting.public_items` is the ONLY anonymous inventory surface (§15)
  and Phase 11's contract. A definer view `with (security_barrier)` that
  reads the staff-only tables as its owner and filters itself; SELECT for
  anon and authenticated. Columns, exactly and in this order: `kind`
  (`product` | `unit`), `short_id`, `slug` (the product's `public_slug`,
  also on unit rows), `name`, `description`, `brand`, `category` (the
  category's name), `condition` (null for products), `sale_price`,
  `currency`, `availability` (`available` | `sold_out` | `sold` |
  `unavailable`), `photos` (jsonb), `updated_at` (a unit row's is the later
  of the unit's and the product's). Never a cost, serial number, internal
  note, location, ownership, consignor or SKU.
  - Rows: products whose `publication_status` is `public` or `sold` and
    `archived_at` is null; units of such products that are not archived
    and not `written_off` or `returned_to_consignor`. A product archived
    after its sale (sold → archived) shows neither itself nor its units.
  - `sale_price` = `private.selling_price(product_id, null)` for a product
    row and `private.selling_price(product_id, unit_id)` for a unit row, so
    Phase 6's replacement (the consignment asking price) flows through.
    A view's functions run as the caller, so anon and authenticated have
    EXECUTE on `private.selling_price`; anon has no USAGE on `private`, so
    the view is its only way to it (meta test).
  - `availability`: a quantity product is `sold` if its publication is
    sold, else `available` when its ledger on-hand (all locations) is above
    zero, else `sold_out`; a unique product is `available` when any unit is
    available, else `sold` if its publication is sold, else `unavailable`
    (its units are on a job, reserved or written off); a unit is
    `available`, `sold`, or `unavailable` for any other status.
  - `photos`: an array of `{bucket, path, width, height, caption}` (from
    `storage_bucket`, `storage_path`, `width`, `height`, `caption`) built
    only from `visibility = 'public'` attachments. A product row has the
    product's photos, oldest first; a unit row has the unit's, then the
    product's, then its linked bike's, each oldest first, the bike's
    limited to those created before the earlier of `unit.sold_at` and the
    bike's first transfer to a customer at or after the unit's creation
    (`bike_ownership_events`; `infinity` when neither exists), so a photo
    taken after the bike passed to its buyer never appears, even if a later
    reopen and re-completion moved `sold_at` (D29).
- The Admin also answers `/q/{shortId}` for staff (Phase 4,
  `src/app/(staff)/q/[shortId]/page.tsx`), its only /q route: after
  `requireStaff()` it resolves the ID with `resolveShortId`
  (`src/lib/domain/scan.ts`; the prefix picks the table, read through RLS,
  archived records included) and redirects to the staff page
  (`hrefForRecord`: B → `/bikes/[id]`, J → `/jobs/[id]` by `job_number`,
  P → `/products/[id]`, U → `/units/[id]`); an unknown ID shows "No record
  with P-999999" with Scan again and Search. C- and S- (Phase 6) and PO-
  (Phase 7) return nothing until their phases extend `resolveShortId`;
  Phase 11 verifies every prefix resolves. Later phases extend that
  function, never add routes.
- The Admin scanner (`interpretScan`, `src/lib/scan.ts`) recognises the QR
  URL on every accepted public base (`scanBases()` in `src/lib/qr.ts`:
  the database QR base when usable, then the environment's
  `NEXT_PUBLIC_PUBLIC_SITE_URL`), a `/q/{shortId}` URL on the Admin's own origin,
  or a bare short ID in any case, and opens `/q/{shortId}`. Anything else
  is shown as "Not a BICII label" and never followed.
- Publication state machine on `products.publication_status` (D26,
  `private.publication_transition_allowed`, mirrored in
  `src/lib/inventory.ts`): draft → internal_only, archived; internal_only →
  public, archived; public → internal_only, sold, archived; sold → public,
  archived; archived → internal_only. `sold` is entered only by a sale path
  (job completion; Phases 6 and 10) and only for unique products; `sold →
  public` is the system restore of `private.refresh_unique_publication`,
  which skips the requirements so a void is never blocked. Any other entry
  into `public` needs a selling price (`private.selling_price`), at least
  one `public` photo on the product, a unit or a unit's bike, and for a
  unique product an available unit (`publication_requires_price`,
  `publication_requires_photo`, `publication_requires_available_unit`);
  the products trigger enforces it for every writer. A new product starts
  draft or internal_only (`publication_initial_invalid`). `public_slug` is
  assigned at the first publish (name slug + `-` + lower(short_id), 'item'
  when the name has no letters or digits) and never changes
  (`product_slug_immutable`), through unpublish, rename and republish.
  Inventory rows are never public by default. By hand, publication changes
  only through `set_publication_status` (§16; authenticated has no column
  grant on `publication_status`), which adds D26's manual rules: `sold` is
  never chosen by hand, and a sold product leaves `sold` by hand only for
  `archived` (`publication_sold_by_sale`); its accepted targets equal
  `manualPublicationTargets` in `src/lib/inventory.ts` for every state
  (tested). A public unique product whose units are all written off stays
  public (showing `unavailable`) until staff unpublish it.

## 12. Label printing

Built by `20261004003800_labels.sql` (Phase 8 step 1; decisions D9, D56–D59
in [ADR-017](decisions/ADR-017-labels-and-qr-base.md)). The TypeScript side
is Phase 8 step 2 (below, "The app side"); the record pages' Labels card
and the settings screens are steps 3–4; a hardware adapter is Phase 12.

Types: `label_kind` (`product`, `unit`, `bike`); `printer_adapter`
(`browser`, `pdf`, `network_raw`, `bluetooth`; the last two exist for
Phase 12 and `printer_profiles_adapter_available` keeps them unusable);
`print_status` (`queued`, `rendered`, `printed`, `failed`); domain
`label_mm` = `numeric(5,1)` without NaN (`label_mm_not_nan`).

```
label_templates
  id uuid PK, name text (btrim, 1..80, unique label_templates_name_key),
  kind label_kind (never changes: label_template_kind_immutable),
  width_mm label_mm (20..150), height_mm label_mm (15..150),
  layout jsonb (layout v1), is_default boolean, active boolean,
  created_by -> staff (set by the trigger), created_at, updated_at
  label_templates_default_is_active: not is_default or active
  label_templates_one_default_per_kind: unique (kind) where is_default

printer_profiles
  id uuid PK, name text (btrim, 1..80, unique printer_profiles_name_key),
  adapter printer_adapter (never changes: printer_profile_adapter_immutable;
    browser | pdf only: printer_profiles_adapter_available),
  config jsonb default '{}' (config v1), is_default, active,
  sort_order integer, created_by -> staff, created_at, updated_at
  printer_profiles_one_default: unique ((true)) where is_default
  (a profile carries no template)

print_jobs
  id uuid PK (the client's id: create_print_job's idempotency key)
  label_kind, product_id -> products, inventory_unit_id -> inventory_units,
  bike_id -> bikes (exactly the one matching label_kind:
    print_jobs_entity_matches_kind; on delete restrict)
  short_id, qr_payload, content jsonb (private.label_content at creation)
  quantity integer (1..500; at most 10 unless product: D56)
  printer_profile_id -> printer_profiles, profile_snapshot {name, adapter,
    config}, adapter
  label_template_id -> label_templates, template_snapshot {name, kind,
    width_mm, height_mm, layout}
  status print_status default 'queued', rendered_at, completed_at,
  error (exactly when failed; 1..500 characters), status_changed_by -> staff,
  reprint_of_id -> print_jobs, requested_by -> staff, correlation_id,
  created_at, updated_at
```

Every foreign key has an index; `print_jobs` also has `(created_at desc)`,
one `(entity, created_at desc)` index per typed key and a partial index of
open jobs (`status in ('queued', 'rendered')`).

**Layout v1** (`label_templates.layout`, snake_case jsonb), exactly these
keys: `version` (1), `qr_mm` (number), `padding_mm` (0.5..6),
`qr_position` (`left` | `right`), `fields` (1..6 distinct of `name`,
`price`, `short_id`, `sku`, `identity`, `serial_number`; must include
`short_id`: every label shows its human-readable short ID), `name_lines`
(integer 1..3), `text_mm` (1.8..6). Geometry: 10 ≤ `qr_mm` ≤
least(width, height) − 2 × `padding_mm`, and width − `qr_mm` − 3 ×
`padding_mm` ≥ 15 (the text column). `private.label_layout_problem(layout,
width_mm, height_mm)` returns null or one sentence about the first problem
(for example "The QR code does not fit: at most 36.0 mm on this label.");
it never raises on a malformed shape. The trigger raises P0001
`label_layout_invalid` with that sentence as DETAIL, for every writer. Field
order is free in the database; the template editor (`TemplateSheet`, step 3) uses the fixed
canonical order `name`, `identity`, `price`, `serial_number`, `short_id`,
`sku`. Cases: `tests/fixtures/label-layouts.ts` (shared with step 2's zod
schema).

**Config v1** (`printer_profiles.config`, browser and pdf): an object whose
only keys are `offset_x_mm` and `offset_y_mm`, each optional, a number in
[−5, 5]; `private.printer_config_problem(adapter, config)`; P0001
`printer_config_invalid`.

**Defaults.** One default template per kind and one default printer
profile, moved only by `set_default_label_template` /
`set_default_printer_profile` (admin; authenticated has no column grant on
`is_default`); the default cannot be switched off
(`label_template_default_required`, `printer_profile_default_required`).
Built-in rows, inserted by the migration because production needs them
(`on conflict (id) do nothing`), all 58 × 40 mm with layout
`{"version": 1, "qr_mm": 28, "padding_mm": 2, "qr_position": "left",
"name_lines": 2, "text_mm": 3, "fields": [...]}`:

| id | name | kind / adapter | fields / config | default |
|---|---|---|---|---|
| `1ab00000-0000-4000-8000-000000000001` | Product 58 × 40 | product | name, price, short_id, sku | yes |
| `1ab00000-0000-4000-8000-000000000002` | Unit 58 × 40 | unit | name, identity, price, short_id | yes |
| `1ab00000-0000-4000-8000-000000000003` | Bike tag 58 × 40 | bike | name, identity, serial_number, short_id | yes |
| `a8000000-0000-4000-8000-000000000001` | This device (browser print) | browser | `{}`, sort 0 | yes |
| `a8000000-0000-4000-8000-000000000002` | PDF download | pdf | `{}`, sort 1 | no |

**Label text** (`private.label_content(kind, entity_id)`, the only source;
stable, security definer). Returns exactly `kind`, `short_id`,
`qr_payload` (`private.qr_payload`), `name`, `price`, `currency`, `sku`,
`identity` (a JSON array of lines, possibly empty) and `serial_number`;
strings trimmed, `name` at most 120 characters, each identity line at most
80, blank values dropped (null). P0002 for an unknown record; P0001
`label_entity_archived` for an archived product, an archived unit or a unit
whose product is archived, or an archived bike; P0001
`label_unique_product_needs_unit` for kind `product` on a unique product
(D57).

- product: `name` = `products.name` (the public view's expression);
  `price` = `selling_price(id, null)`; `currency` = `products.currency`;
  `sku`; `identity` = [brand] when the brand is set and not already in the
  name (case-insensitive), else []; `serial_number` null.
- unit: its product's `name`, `currency` and `sku`; `price` =
  `selling_price(product_id, unit_id)`; `serial_number` = the unit's, else
  its bike's; `identity` = the bike's "Size {frame_size} · {colour}" line
  when the unit is linked to a bike and either is set, then the first line
  of the unit's `condition` (which `public_items` exposes) when not blank.
- bike: `name` = brand, model, variant joined by single spaces, skipping
  blank parts (equal to `bikeTitle()` in `src/lib/bikes.ts` for every
  seeded bike, tested; a name over 120 characters is cut on a label but not
  by `bikeTitle`); `price` null; `currency` = `private.shop_currency()`;
  `sku` null; `identity` = the size/colour line; `serial_number` =
  `bikes.serial_number`.

**The label-text rule.** Label text is a subset of `reporting.public_items`'
fields (name, brand, price, currency, a unit's condition) plus identifiers
(short ID, SKU, a bike's size/colour line, serial number). Never a cost,
direct cost, yield, Cult Commons, consignor, ownership type, owner or
customer name, or internal note: `private.label_content` never reads those
columns (its source mentions none of `consignment_items`, `direct_cost`,
`ownership_type`, `internal_note`, tested), and `print_jobs_content_keys`
is the database whitelist of content keys (an extra key is 23514 for every
writer).

**The price (D58).** Exactly `private.selling_price(product_id,
inventory_unit_id)`, the function `reporting.public_items`, the in-store
sale default (`private.sell_line`), `add_inventory_line` and Shopify use;
never reproduced. Rendered with two decimals (`to_char(p,
'FM9999999999990.00')`); NULL → JSON null (no price line, never "0.00");
0 → "0.00" (D24 as amended: 0 is a known price). A consigned price reaches
the label only through that function.

**Snapshots.** `content`, `template_snapshot`, `profile_snapshot`,
`short_id` and `qr_payload` are written once by `create_print_job`; catalog,
template and printer edits never change a job (tested). Record pages warn
when the current price differs from the last printed label's (the Labels
card, step 3; only `printed` jobs count).

**Status machine (D59).** `private.print_job_transition_allowed`: queued →
rendered, printed, failed; rendered → printed, failed; printed and failed
are final; nothing returns to queued (cases:
`tests/fixtures/print-transitions.ts`). `rendered` is set when the labels
were sent for printing (the print view's Print or Open PDF, step 2), `printed`
or `failed` (with what went wrong) when staff confirm. Checks keep the
stamps consistent: `print_jobs_error_check` (error exactly when failed),
`print_jobs_completed_check` (completed_at exactly when printed or failed),
`print_jobs_rendered_check` (no rendered_at while queued). The trigger
`print_jobs_enforce_rules` lets only `status`, `rendered_at`,
`completed_at`, `error`, `status_changed_by` and `updated_at` change
(`print_job_immutable`) and only along the machine
(`print_job_transition_invalid`), for every writer; deleting a job is
`print_job_immutable` for every role. "Print again" is a new job with
`reprint_of_id` (same kind and record: `print_job_reprint_mismatch`).
Archived records keep their jobs readable (SPEC §23).

**The app side (Phase 8 step 2).**

- `src/lib/printing/` (pure, no Supabase): `types.ts` (camelCase DTOs:
  `LabelContent`, `LabelLayout`, `LabelTemplate`, `PrinterProfile`,
  `PrintJob`); `schemas.ts` (zod: `labelContentSchema` strict, so an
  unknown key such as `cost` fails before it can reach a label;
  `labelLayoutSchema`, `printerConfigSchema`; `labelLayoutProblem` mirrors
  `private.label_layout_problem` sentence for sentence and
  `labelTemplateInputSchema` applies it with the table's size checks,
  tested on `tests/fixtures/label-layouts.ts`); `compose.ts`
  (`composeLabel`, the ONE layout engine for SVG and PDF, from standard-font
  metrics in `metrics.ts`; a 0.00 price prints `$0.00`, a null price
  nothing; the short ID and price are never cut); `label-svg.tsx`;
  `document.ts` (`buildLabelDocument(job)`: the job's template, content and
  printer config snapshots only); `job.ts` (the status machine mirror,
  `isPrintable`, D56's `maxLabelQuantity`); `availability.ts`
  (`labelUnavailable` for the four "printing unavailable" codes);
  `links.ts`; `adapters/` (`browser` → `LabelSheet`, `pdf` → pdf-lib,
  server only; `network_raw` / `bluetooth` throw `AdapterUnavailableError`).
- `src/lib/domain/labels.ts` (server only): `getPrintJob` (the DTO, every
  jsonb parsed; `entityArchived` from the record and, for a unit, its
  product), `listPrintJobs` (all, open = queued + rendered, failed; a short
  ID matched exactly, else part of `content->>name`; newest first with a
  `(created_at, id)` cursor), `listJobsFor`, `getLabelContext` (never
  throws for the four unavailable codes, nor for `label_preview`'s P0002 on
  a record that does not exist, reason `not_found`; a unique product's P- label is
  refused without calling `label_preview`), `getReprintPreset`,
  `createPrintJob`, `setPrintJobStatus`, and the admin writes
  (`saveTemplate` / `saveProfile` with the client id, `setDefaultTemplate`,
  `setDefaultProfile`, `setPublicSiteUrl` through `update_shop_settings`).
- Rendering a job is allowed only while it is open (D59): the print view
  shows the controls and prints the sheet only for queued and rendered
  jobs, and `GET /api/labels/{id}/pdf` answers 409 for a printed or failed
  job. "Print again" is always a link to the record
  (`?print=1&qty={n}&reprint={id}`), which makes a new job.

## 13. Shopify integration

Inbound built in Phase 10 step 1 (`20261004003900_shopify_integration.sql`,
`20261004004000_shopify_order_processing.sql`; PLAN D80–D89, ADR-020);
the outbound product sync is step 2, the service layer step 3 (built:
`src/lib/integrations/shopify/`, no schema change), the screens step 4
(`src/lib/domain/shopify.ts` reads these tables and views through RLS and
writes only through the staff RPCs; no schema change). This replaces the first draft (bigint ids, a `dead` job status,
Shopify ids on the sync row): ids are uuids, a job a person must act on is
`needs_attention`, and Shopify product and variant ids live ONLY on
`products` (§6). Every Shopify id is stored as a gid
(`gid://shopify/<Kind>/<digits>`, `private.shopify_gid`, checked on every
column).

```
shopify_settings      (single row id = 1; seeded, never by a migration)
  online_location_id uuid not null -> locations     -- D83: the online stock
  shopify_location_id text null (gid Location)      -- filled by the first sync
  storefront_url text null (https://…, ≤ 200)       -- read only through buy_online_url (step 2)
  accept_test_orders boolean not null default false -- D89; true in the dev/E2E seed only
  updated_at, updated_by -> staff

shopify_product_sync  (one row per product BICII publishes or links)
  product_id uuid PK -> products
  publish_online boolean not null default false
  sync_status shopify_sync_status not null default 'not_synced'
     -- enum: not_synced | pending | synced | error | unpublished
  shopify_origin text null ('bicii' | 'external', D84)
  shopify_inventory_item_id text null unique (gid InventoryItem)
  shopify_handle text null                 -- bicii-<short id>; null when external
  last_pushed_at, last_checked_at, last_pushed_quantity (≥ 0), last_pushed_price,
  desired_hash (sha-256 hex; the API version is part of it), api_version,
  last_error_code, last_error (≤ 1000), publish_changed_by/at, created_at, updated_at

integration_events    (every inbound webhook, stored before processing)
  id uuid PK, provider 'shopify', topic (≤ 100)
  external_event_id text (≤ 200)           -- X-Shopify-Webhook-Id; 'missing:' || sha for
                                           --   a rejected delivery without one
  shopify_event_id, shop_domain, api_version, triggered_at (X-Shopify-Triggered-At)
  subject (≤ 200)                          -- '#1042'; 'Refund <id> of #1042' (the name of
                                           --   the order's delivery), else 'Refund <id> of order <id>'
  shopify_order_gid (gid Order)            -- the order an event is about; never raises
  test_delivery boolean                    -- payload test or header X-Shopify-Test (D89)
  payload jsonb null                       -- null when rejected or purged (D88)
  payload_purged_at, headers jsonb (capped: 16 lower-cased keys, ≤ 512 chars,
     'x-bicii-truncated' when cut), body_sha256 (hex), body_bytes (≥ 0)
  hmac_valid boolean, rejection_reason integration_rejection_reason null
     -- enum: hmac_invalid | webhook_secret_missing | shop_not_configured |
     --   shop_domain_mismatch | missing_headers | body_not_json
  received_at, delivery_count (≥ 1), last_delivered_at
  status integration_event_status   -- pending | processed | skipped | failed | rejected
  attempts, processed_at
  outcome text (sale_recorded | duplicate_order | refund_recorded | duplicate_refund |
     no_money_refunded | refund_not_allocated | topic_not_handled | test_order |
     pos_order | order_not_recorded | earlier_delivery_skipped | dismissed)
  result jsonb                             -- the sale and lines, a refund's amounts, or
                                           --   unmapped_lines (admin only)
  last_error_code, last_error (the human message), last_error_detail (SQLSTATE: message
     of an unexpected error), sale_id -> sales, correlation_id, created_at, updated_at
  checks: integration_events_rejected_shape (rejected ⇔ a reason; a reason ⇒ no
    payload; no reason ⇒ hmac_valid), integration_events_payload_present
  unique index integration_events_external_id_key (provider, external_event_id)
    where rejection_reason is null         -- D88: a forgery never squats the key
  unique index integration_events_rejected_body_key (rejection_reason, body_sha256)
    where rejection_reason is not null     -- one row per bad body
  -- integration_events_guard (every role, the owner too): only the processing
  --   columns change; DELETE and clearing a payload only under
  --   private.purge_integration_events (integration_event_immutable)

integration_retry_queue   (the visible queue, SPEC §26)
  id uuid PK, kind integration_job_kind (shopify_event | product_sync)
  integration_event_id null -> integration_events, product_id null -> products
     (exactly one, by kind)
  status integration_job_status   -- queued | running | done | needs_attention | dismissed
  attempts (claims), max_attempts (default 8, 1..50), next_attempt_at, locked_at,
  last_error_code, last_error, last_retried_by/at, resolved_at, resolved_by,
  resolution_reason (≤ 500; required when an admin dismisses), created_at, updated_at
  unique: one open job per event; one queued and one running product sync per product

integration_audit_events  (append-only: integration_history_append_only)
  id, event_type integration_audit_type (publish_online_changed | sync_requested |
  variant_linked | customer_linked | job_retried | job_dismissed | settings_changed),
  product_id, customer_id, job_id, integration_event_id, actor_staff_id, reason,
  payload ({from, to} …), correlation_id, created_at
```

**Recording** (`record_shopify_webhook`, service role). A rejected
delivery is stored without its body and never queued (D88). A verified one
is inserted `on conflict (provider, external_event_id)`: a repeat only
counts the delivery. A new event is skipped at once (no job) when its topic
is not `orders/paid` or `refunds/create` (`topic_not_handled`), when it is
a test delivery and test orders are not accepted (`test_order`), or when it
is a POS order (`pos_order`, D89); otherwise it gets a queued
`shopify_event` job.

**Processing an order** (`process_shopify_order_paid`, through
`process_shopify_event`), one transaction:

1. Lock the event row; a processed, skipped or rejected event only closes
   its job and returns what it stored. Count the attempt.
2. Inside one plpgsql subtransaction: validate the REST payload
   (`shopify_payload_invalid` names the field); take the advisory lock
   'bicii.shopify.order:' ‖ order gid; if a sale with that
   `shopify_order_id` exists the outcome is `duplicate_order` (and the
   order's other open deliveries close the same way); if another
   `orders/paid` event of the order is `skipped` (dismissed, test or POS)
   the event is skipped / `earlier_delivery_skipped`: a dismissal is final
   for the order (D87), whatever the webhook id. Check the
   settings, the shop currency (D35) and the tax basis (D89). Map every
   line `variant_id → products.shopify_variant_id`; any unmapped or custom
   line is one `shopify_variant_unmapped`. Insert the sale header (lock
   order 0; `recognized_at` = the payload's `processed_at`, else the
   trigger time, else receipt, D80; the customer only through a linked
   `customers.shopify_customer_id`, D86), then `lock_stock` per product,
   the oldest available units of each unique product at the online location
   FOR UPDATE in id order (D81), their items and every active item of each
   consigned quantity product, and the on-hand of each quantity product
   (D82). Write the lines through `private.sell_line(sale, n, line,
   'online_sale')`, priced by `private.shopify_split_amount` so they sum to
   Shopify's discounted line totals (D80); refresh unique products'
   publication last (D26).
3. On success the event is `processed` (`sale_recorded`, `result` = the
   sale and its lines), its job `done`, the order's other `pending` or
   `failed` deliveries (another webhook id) `processed` / `duplicate_order`
   with the sale and their jobs `done`
   (`private.shopify_close_order_siblings`, id order, SKIP LOCKED), so the
   queue and Today keep no failure for a recorded order, and any refund
   job waiting for the order is queued now (D87). On failure nothing of step 2 survives: the
   event is `failed` with the code and a human message (`result` keeps the
   unmapped lines), and its job (created if none) is `needs_attention`, or
   `queued` with `private.integration_backoff` for a transient code
   (`shopify_unexpected_error`, `shopify_refund_order_unknown`,
   `shopify_settings_missing`) until `max_attempts`.

Event codes and their messages are stored on the event and its job (staff
read them): `shopify_variant_unmapped`, `shopify_unit_unavailable`,
`shopify_insufficient_stock`, `shopify_currency_mismatch`,
`shopify_tax_basis_unsupported`, `shopify_payload_invalid`,
`shopify_settings_missing`, `shopify_refund_order_unknown`,
`shopify_sale_refused` (a `sell_line` refusal, its detail quoted) and
`shopify_unexpected_error` (retried; SQLSTATE in `last_error_detail`).

**Processing a refund** (`process_shopify_refund`): the same lock, replay,
test and subtransaction pattern; the order's advisory lock, then the sale
FOR UPDATE. A known refund id (a `sale_refunds.shopify_refund_id`, or
another delivery of the same refund id that is `processed`) is
`duplicate_refund`; another delivery of the same refund id that is
`skipped` makes it skipped / `earlier_delivery_skipped` (a dismissal is
final, D87; matched on the stored payloads' refund id, so it holds until
the owner purges them, R-040). No sale: a skipped
`orders/paid` event of that order (dismissed, test or POS) makes it
`order_not_recorded`; otherwise `shopify_refund_order_unknown` (retried, and
queued again when the order is recorded). The amount (D85) is the
line-attributable refund (Σ `private.shopify_refund_line_amount` of the
refund lines, else Σ successful refund transactions), never above the
transactions or the sale's remaining total; 0 money is `no_money_refunded`,
0 allocated `refund_not_allocated`. One `sale_refunds` row (recorded_by
null, restocked false), the sale `refunded` or `partially_refunded` as
`record_sale_refund` decides; shipping, the excess and per-line details
stay in `result`. No movement, unit, item, line or settlement changes (D7).

Delivering a webhook ten times yields one event; processing it ten times
yields one sale and one movement per line (`inventory_movements_sale_line_once`).

**Staff side** (§16): `retry_integration_job`, `dismiss_integration_job`
(dismissing an order is final for it: unless a sale exists, its other
open deliveries and its waiting refunds close too), `link_shopify_variant`
(mapping only, D84) and `link_shopify_customer` (never by email; recorded
sales are never edited, D86), each with an `integration_audit_events` row.
The service layer (`src/lib/integrations/shopify/`, step 3) owns every
Shopify API call and is the only caller of the service-role RPCs:
`handleShopifyWebhook` calls `record_shopify_webhook`, the queue runners
call `claim_integration_jobs` (one job at a time; by id for the job an RPC
returned), `process_shopify_event`, `product_sync_state` and
`record_product_sync_result`. Nothing in a component or route handler
talks to Shopify directly.

**Outbound product sync** (step 2, `20261004004100_shopify_product_sync.sql`;
D81, D83, D84, D86, D87):

- **The online price** is `private.shopify_online_price(product_id)`:
  `private.selling_price` (D58) for the oldest (created_at, id) available,
  non-customer-owned, non-archived unit at the online location of a unique
  product (no unit when there is none), or for no unit for a quantity
  product (a consigned one's FIFO item asking price, D45, else the
  default). The publish check, `product_sync_state` and so Shopify read it;
  nothing reads `default_sale_price` for an online price. NULL is missing;
  0 is a price (D24 as amended).
- **Effectively online** (`private.shopify_effective_online`): Publish
  online on, product active, not archived, not customer-owned, and public,
  or a unique product whose publication is `sold` (pushed at quantity 0).
- **Publish online** (`set_publish_online`, manage_inventory) refuses an
  archived product (`shopify_product_archived`), a customer-owned one
  (`shopify_not_saleable`), one that is not public
  (`shopify_requires_public`) or without an online price
  (`shopify_price_missing`). It upserts the sync row (`publish_online`,
  `publish_changed_by/at`; never the handle) and queues the product; it
  returns the queued job's id so the app runs exactly that job (non-admins
  never read the queue). Unpublishing a product never pushed is
  `not_synced` and dismisses its queued job; a pushed one is queued to be
  drafted (BICII-created) or set to quantity 0 (external).
- **Queueing** (`private.enqueue_product_sync`): nothing unless the sync row
  is published, was pushed before (`last_pushed_at`), or has a push
  running; so a product only linked to a variant of a Shopify-made product
  is never pushed until staff publish it. Otherwise it dismisses the
  product's `needs_attention` sync jobs ("Superseded by a newer change"),
  inserts a queued `product_sync` job `on conflict do nothing` on the
  one-queued-per-product index, marks the row `pending` and returns the
  queued job's id.
- **What queues a product** (deferred constraint triggers, run at commit;
  `private.shopify_enqueue_product_change`): every `inventory_movements`
  insert; a change of `products` name, description, brand, SKU, default
  price, publication, active or archived; an `inventory_units` insert or a
  change of status, location, price, ownership or archived; a
  `consignment_items.asking_price` change (`update_consignment_terms`); a
  public product photo inserted, deleted or changing visibility or entity.
  `shopify_settings.online_location_id` changing queues every published or
  pushed product at once (an immediate trigger). The triggers are
  deferred, not the brief's statement-level trigger, because a sale writes
  its movements before `refresh_unique_publication` locks the product (lock
  order 7): an immediate trigger taking the sync row there would invert
  the order against a product edit or `set_publish_online` and deadlock.
  Inside one transaction the job appears at commit (tests:
  `set constraints all immediate`).
- **Sync now** (`request_product_sync`, manage_inventory): needs a published
  or pushed product (`shopify_not_published`); clears `desired_hash` so the
  next run pushes in full, and returns the queued job, due now.
- **The worker's input** (`product_sync_state`, service role): name,
  description, brand, SKU, the online price, `effective_online`, the
  available quantity at the online location floored at 0 (the ledger for a
  quantity product; available, non-customer-owned, non-archived units for a
  unique one), `unit_price_conflicts` (short IDs of those units whose own
  selling price differs from the online price: the worker refuses, D81),
  the public product photo paths oldest first, the handle
  (`bicii-<short id>` unless the origin is `external`), the Shopify ids,
  inventory item and location, the last hash and pushed quantity (the
  compare quantity, D83), and `orders_in_flight` (an orders/paid event
  received in the last 10 minutes that is pending, or failed with its job
  queued or running).
- **The worker's result** (`record_product_sync_result`, service role):
  `pushed` stores the Shopify product and variant ids on `products` when
  missing (reason "Created in Shopify by the BICII sync"; different ids, or
  a BICII-created Shopify product another product carries, →
  `shopify_ids_conflict`; a variant on another product →
  `products_shopify_variant_id_key`), origin `bicii` unless already
  `external`, the inventory item, the handle (BICII-created only), the
  pushed quantity, price, hash and API version, clears the errors, fills
  `shopify_settings.shopify_location_id` when missing and finishes the job;
  `unchanged` records the check and clears the errors. Both settle the
  status: `pending` when another sync is queued, `synced` when effectively
  online, `not_synced` when never pushed, else `unpublished`; and dismiss
  older `needs_attention` syncs ("Resolved by a later sync"). `deferred`
  (D83) re-queues the job two minutes out without consuming an attempt;
  `failed` (D87) sets `error` with the human message and re-queues with
  `private.integration_backoff` when retriable and attempts remain, else
  `needs_attention`. When another job is already queued for the product, a
  re-queue dismisses this job and pushes the queued one's next attempt out
  instead (one queued per product). `job_id` may be NULL; a job closed
  meanwhile is left closed; an unknown outcome is 22023.
- **Settings** (`set_shopify_settings`, admin): the only editor of the row
  and of `storefront_url` (https or NULL, trailing slashes trimmed);
  creates the row when absent; the online location must exist (P0002) and,
  when it changes, be active (`location_inactive`); changing
  `accept_test_orders` needs a reason (D89, `reason_required`); same values
  change nothing; one `settings_changed` audit row `{from, to}`.

Lock order (extends the consignment migration's header): `shopify_settings`
FOR UPDATE, when taken, before 7 (products); then 8, the `shopify_product_sync`
rows (ascending product id when several), then the product's
`integration_retry_queue` rows.

## 14. Reporting views (schema `reporting`)

All views are plain SQL over source tables. None are maintained by hand.

From Phase 4 the `reporting` schema is exposed to PostgREST
(`supabase/config.toml` `[api] schemas`, the devstack's `db-schemas`, type
generation with `--schema public,reporting`, RUNBOOK "Hosted Supabase"),
because `reporting.public_items` is the anonymous surface (§15).
`authenticated` has USAGE; `anon` has USAGE (never CREATE) for
`public_items` only, the one reporting view granted to it. The stock views
are security_invoker, so the base tables' staff-only RLS applies;
`public_items` is a definer view that filters itself (§11). `private` is
never exposed.

| View | Purpose |
|---|---|
| `financial_lines` | Built (Phase 5, D32 RECOGNITION). One row per recognised ENTRY, columns in this order: `entry_key` text ('wol:' ‖ line id, unique), `source` text, `entry_kind` text ('line'), `source_line_id` uuid, `document_id` uuid, `document_number` text, `channel` text, `recognized_at` timestamptz, `recognized_day` date (`private.shop_day`), `line_type` text, `service_id`, `product_id`, `inventory_unit_id`, `category_id` (the service's or product's), `ownership_type` text (inventory lines: the unit's, else the product's; null otherwise), `consignment_item_id` (the line's consigned item; work-order lines carry it since Phase 6 step 2, D44), `customer_id`, `bike_id`, `lead_mechanic_id`, `description` text, `quantity`, `unit_sale_price`, `unit_direct_cost`, `cult_commons_rate`, `sale_total`, `cost_total`, `yield_total`, `cult_commons_share`, `bicii_yield_after_cc` (all plain numeric), `is_loss` boolean (yield < 0), `currency` text, `cost_pending` boolean. Pinned vocabulary: `source` ∈ ('work_order','sale'); `channel` ∈ ('workshop','retail','online'); `document_id` = work_orders.id or sales.id; `document_number` = the J- job number or the S- sale number; `entry_kind` = 'line'. Recognition (D3 as modified by D15, refined by D32): every non-voided line of a job with a current `completed_at` (completed, ready for collection or collected; never open or cancelled), on the shop day of that `completed_at`. Lines are frozen once completed, so the only correction is a reopen, which removes the whole job from its earlier day until it is completed again (past days can change; no reversal entries for workshop lines). Amounts come only from the line's snapshots and generated columns; each entry's Cult Commons is the line's own share (≥ 0, D1), so no negative Cult Commons payment arises; `cost_pending` lines (D14) are recognised at cost 0 and flagged. Sale branch (Built, Phase 6 step 2, `…3700_consignment_reporting`): one entry per line of a sale whose status is not `voided`, `union all` with every column in this order: `entry_key` 'sl:' ‖ line id, `source` 'sale', `entry_kind` 'line', `source_line_id` the line, `document_id` / `document_number` the sale and its S- number, `channel` 'retail' (source retail) or 'online' (online_shopify), `recognized_at` the sale's `recognized_at` on `private.shop_day` of it, `line_type` 'inventory', `service_id` null, the line's `product_id` and `inventory_unit_id`, the product's `category_id`, `ownership_type` the unit's else the product's, the line's `consignment_item_id`, the sale's `customer_id`, `bike_id` and `lead_mechanic_id` null, the description, quantity, price, cost, rate and four totals from the line's snapshots, `bicii_yield_after_cc = yield_total − cult_commons_share`, `is_loss = yield_total < 0`, the currency, `cost_pending` false. Refunds are not subtracted and restocked lines stay (D49: netting and Cult Commons claw-back are Phase 9's refund-reporting row). A consigned entry's cost already includes the consignor payout (D44, D46). Phase 9 (`20261006001000_report_periods`) appended NO column (every column the period reports need exists, and synonyms are never added); its only change is the explicit `sa.source <> 'work_order'` in the sale branch's WHERE: a 'work_order' sale is reserved and never written (no RPC inserts one; Phase 10 writes 'online_shopify' only), its lines would double-count the job's own lines, and any NEW `sale_source` value reaches the channel CASE without an arm (a NULL channel), which the channel-partition test in `period-reports.test.ts` catches. |
| `report_lines` | Built (Phase 9 step 1, D100, `20261006001000_report_periods`). Every non-voided line that carries money on any date basis. Branch 1 is `financial_lines` (all of it, `recognised = true`, so the sale basis is `financial_lines` by construction), left-joined to `work_orders` for workshop rows; branch 2 is the work in progress: the live lines of jobs with `completed_at` NULL and status not cancelled, with the same expressions as `financial_lines`' work-order branch, `recognized_at` / `recognized_day` NULL and `recognised = false` (a job reopened under D15 is back here until completed again). Columns: the 32 `financial_lines` columns in order, then `checked_in_at`, `completed_at`, `collected_at` (the job's current stamps; NULL on sale rows) and `recognised` boolean. security_invoker, granted to no API role; read only through `private.report_rows` and the §16 report RPCs. |
| `daily_summary` | Built (Phase 5). One row per shop day from the earliest activity day (check-in, recognised entry or movement; today when none) to `private.shop_today()`, zero-filled; columns fixed in this order: 1 `day`; 2–7 `jobs_checked_in`, `jobs_started`, `jobs_completed`, `jobs_ready_for_collection`, `jobs_collected`, `jobs_cancelled` (flows: jobs whose CURRENT stamp falls that day, D31); 8 `currency` (`private.shop_currency()`); 9 `lines_recognised`; 10–14 `gross_sales`, `cogs`, `yield_total`, `cult_commons_share` (Σ entry shares, D1), `bicii_yield_after_cc` (shop-currency `financial_lines` by `recognized_day`); 15 `loss_lines`, 16 `loss_total` (≤ 0); 17 `parts_consumed_qty`, 18 `parts_consumed_lines`, 19 `parts_returned_qty` (reversals of job consumptions); 20 `stock_adjustments`, 21 `significant_stock_adjustments` (D33); 22 `appointments_scheduled`, 23 `appointments_arrived`, 24 `appointments_no_show` (Built, Phase 2 `…3200`, D41: `appointment_daily`'s `booked`, `arrived` and `no_shows` of that day, 0 when none; the series also starts at the earliest appointment's shop day and still ends at `private.shop_today()`); 25 `consignment_sales` integer, 26 `consignment_sales_total` numeric, 27 `new_consignor_liability` numeric (Built, Phase 6 step 2, zero-filled: over that day's shop-currency `financial_lines` entries with a `consignment_item_id`, i.e. sale lines and completed jobs' lines that sold consigned stock: the number of distinct documents, Σ their `sale_total`, and Σ round(quantity × the source line's `consignor_payout_snapshot`, 2)). Retail sales reach the money columns 9–16 through `financial_lines`; the reconcile invariants hold (the day's money columns are its entries' sums). Integer counts and numeric money with explicit casts; Phase 9 appends new measures only after column 27. |
| `appointment_daily` | Built (Phase 2, D41 APPT-COUNTS). One row per shop day that has appointments, by SCHEDULED day (`private.shop_day(starts_at)`) and CURRENT status: `day`, `booked` (not cancelled), `expected` (booked or confirmed), `arrived` (arrived, checked_in or completed), `checked_in` (checked_in or completed), `no_shows`, `cancelled`, all integer. security_invoker, granted to no API role (it calls `private.shop_day`); read through `public.appointment_daily` (zero-filled) and daily_summary's columns 22–24. Phase 9's activity report reads it. |
| `work_order_activity` | Built (Phase 5). One row per job: `work_order_id`, `job_number`, `status` (enum), `customer_id`, `bike_id`, `lead_mechanic_id`, `appointment_id`, `currency` text; the CURRENT stamps `checked_in_at`, `started_at`, `completed_at`, `ready_for_collection_at`, `collected_at`, `cancelled_at` and their shop days `checked_in_day`, `started_day`, `completed_day`, `ready_day`, `collected_day`, `cancelled_day`; `is_open`; `is_overdue` (D20: open and `now() - checked_in_at > interval '7 days'`); `age_days` (open: today − check-in day; else completion or cancellation day − check-in day); `days_to_start`, `days_to_complete`; `days_awaiting_collection` (completed/ready: today − completion day; collected: collection day − completion day); `time_to_complete` interval. Integer days and intervals only. A reopened job's completion stamps are its latest ones (D15). |
| `operational_exceptions` | Built (Phase 5, D34; extended by Phase 9 step 3, D106–D108, `20261006001300_operational_exceptions`). Columns in order: Phase 5's nine, unchanged: `kind`, `severity` ('danger' \| 'warning'), `entity_type` ('work_order', 'product', 'inventory_unit', 'work_order_line'; Phase 9 adds 'sale' and 'consignment_item'; Phase 10 'integration_job'), `entity_id`, `entity_label` (job number, P-/U-/C- short ID or S- sale number), `subject_label` (customer · bike, or the product name, with the location for negative stock), `days`, `quantity`, `since`; then appended by Phase 9: `issue` text (the kind, or the reconciliation code; `negative_on_hand` for negative_stock), `short_id` text, `title` text, `detail` text (one plain sentence), `amount` numeric (unsettled_consignment's outstanding, else NULL), `currency` text. Phase 5's branches keep their rows and values and fill short_id = entity_label, title = entity_label, detail = subject_label. Kinds: `overdue_job` (warning, which only orders it after danger rows: the UI shows Overdue in the danger tone, as everywhere else; exactly D20, 7 = `OVERDUE_AFTER_DAYS`, strictly more than 7 × 24 h), `uncollected_job` (warning; completed or ready, completed ≥ 7 shop days ago), `negative_stock` (danger; `stock_levels.on_hand < 0`, quantity = on-hand), `unit_hold_stale` (danger; a held_for_customer unit with no live inventory line on an open job; since = its last status change), `currency_mismatch` (danger; a would-be-recognised workshop line not in the shop currency, entity `work_order_line`; since Phase 9 also every line of a sale that is not voided (nor of the reserved source work_order) in another currency, entity `sale`, since = `recognized_at`: exactly the lines the period reports exclude on the sale basis, D104), `unit_state_mismatch` (danger, D106: one row per `unit_reconciliation` issue, entity `inventory_unit`, detail = `issue_detail`, since = last movement; one per `stock_reconciliation` issue `unit_count_mismatch` or `unique_movement_without_unit`, entity `product`; never for `negative_on_hand`, which is `negative_stock`, and not for a held unit that `unit_hold_stale` lists), `unsettled_consignment` (warning, D107: `consignor_item_ledger.outstanding > 0` and `private.shop_today() − private.shop_day(last_sale_at)` > `shop_settings.consignment_settlement_alert_days`; entity `consignment_item`, label and short_id the C- ID, subject and title with the consignor's display name, days since that sale, amount = outstanding, currency the item's), `integration_failed` (the rows of `private.integration_exceptions()`, built by Phase 10 step 1 in `…4000_shopify_order_processing` in Phase 5's nine-column shape: one row (danger, `entity_type` 'integration_job', the job id, the event subject or the product's short ID, `subject_label` = the human message ≤ 300, days since the job was created) per `needs_attention` job, for admins only, D86; this view fills the six appended columns for those rows itself, `issue` = the kind, `title` = `entity_label`, `detail` = `subject_label`, so the function keeps nine columns, [R-043](RISKS.md#r-043--phase-9-must-widen-the-integration-exceptions-function) resolved, [R-058](RISKS.md#r-058--phase-9s-exceptions-migration-must-be-re-verified-when-phase-10-merges)), and since Phase 14 step 2 (`20261014000500_indent_deposits`, D159b) two more kinds from the same function, mapped the same way: `payment_attention` (one row per `public.payment_issues` row: its severity, entity `work_order`, label the job number, subject = the issue's sentence ≤ 300, since = the issue's time; for active admins and managers, `private.can_record_refunds()`) and `stripe_attention` (danger: a `stripe_events` row left `needs_attention` in the last 30 days, except a `currency_mismatch` or `livemode_mismatch` about a refund whose row `payment_attention` lists as `refund_not_counted` (linked, not failed or canceled, in another currency or stored mode: the same test as `payment_issues`), so a mismatched refund is listed once; a failed or canceled one, which `refund_not_counted` leaves out, and an event in the other mode about a refund stored in the payment's mode (counted) keep their `stripe_attention` row; one row per Stripe object and outcome, the earliest such event in the window, so a refund's created and failed events and each *Check with Stripe* read of it are one row (`20261014000600_payment_exception_dedupe`), or a `not_recorded` rejection last delivered in the last 3 days that no stored retry of the same body (same `body_sha256`, not rejected) has cleared; entity the job when the event names one, else `stripe_event` (the event id, label "Stripe"); subject = a sentence per outcome; admins only, D86). Not filtered per caller: the RPCs apply `private.exception_visible(kind)` (D108, §15). Computed live, never stored or dismissed. |
| `work_order_totals` / `work_order_totals_staff` | Running totals per job; the staff variant includes cost and yield. |
| `stock_levels` | Built (Phase 4): on-hand (`sum(quantity_delta)`) and `last_movement_at` per product and location from the ledger. security_invoker, SELECT to authenticated (staff rows only through RLS). |
| `product_stock` | Built (Phase 4): every product with on-hand across locations (0 when none), available and held units, `negative_locations` (locations below zero) and `below_reorder` (quantity product, reorder point set, on_hand <= reorder_point). security_invoker. |
| `unit_ledger_disposition` | Built (Phase 9 step 3, D106, `20261006001200_stock_reconciliation`). One row per unique unit from its own movements: `unit_id`, `ledger_on_hand` (total net), `ledger_location_id` (the single location whose net is +1, else NULL), `location_nets` jsonb (location id → net), `location_out_of_range` (a location's net not in {0, 1}), `last_movement_at`, `disposition` and `disposition_ref` (the S- or J- number), `disposition_movement_id`. Disposition, from the unit's LATEST non-transfer movement (`created_at`, `id`; a transfer only moves the location): +1 of any type `in_stock`; −1 retail_sale/online_sale `sold_by_sale`; −1 job_consumption on a live line whose job has a `completed_at` `sold_by_job`, on an open job `held_by_job`, on a cancelled job or a voided line without its reversal `held_on_closed_job`; −1 consignment_returned `returned`; −1 damaged or stock_adjustment `written_off`; any other −1 (no RPC writes one) `unexplained_out`; no movement `none`. A refund writes no movement (D7): a refunded unit stays `sold_by_sale` until `restock_unit`'s +1 'return'. security_invoker, no API grant. |
| `unit_reconciliation` | Built (Phase 9 step 3, D106). One row per unit: `unit_id`, `unit_short_id`, `product_id`, `status`, `location_id`, `ledger_on_hand`, `ledger_location_id`, `expected_on_hand` (`private.unit_expected_on_hand(status)`: 1 for available and reserved, 0 otherwise, exactly `assert_unit_consistent`'s rule), `disposition`, `disposition_ref`, `last_movement_at`, `issue`, `issue_detail` (one plain sentence, e.g. "Status available; the ledger says sold by S-000123."). `issue` is NULL when consistent, else the FIRST failing check: 1 `ledger_out_of_range` (total net, or a location's net, not in {0, 1}); 2 `sale_without_sold_status` (sold_by_sale or sold_by_job, status ≠ sold); 3 `sold_without_sale` (status sold, disposition neither of those, or `sold_at` NULL); 4 `held_without_open_job` (held_for_customer, disposition ≠ held_by_job); 5 `in_stock_without_ledger` (expected 1, net 0); 6 `ledger_without_stock_status` (expected 0, net 1); 7 `location_mismatch` (expected 1, ledger location ≠ `location_id`); 8 `consignment_status_mismatch` (item sold ↔ unit sold, item returned ↔ unit returned_to_consignor, item active ↔ unit available, reserved or held). security_invoker, no API grant. |
| `stock_reconciliation` | Built (Phase 9 step 3, D106; replaces the earlier "cached balance when the cache exists" plan: there is no `inventory_balances` cache). One row per (product, location) with a movement or a unit: `product_id`, `location_id`, `tracking_type`, `ledger_on_hand` (`stock_levels`, summed once), `units_in_stock` (unique products: units there whose status implies on-hand 1; NULL for quantity products), `last_movement_at`, `issue`, the first of `negative_on_hand` (ledger < 0), `unique_movement_without_unit` (a unique-product movement there naming no unit; the root cause, so it comes before the count it also shifts) and `unit_count_mismatch` (unique: ledger ≠ units_in_stock), else NULL. security_invoker, no API grant. |
| `low_stock` | Built (Phase 4): active, non-archived quantity products AT OR BELOW their reorder point (`on_hand <= reorder_point`), or below zero in total or at any location regardless of reorder point (D23); `shortfall = coalesce(reorder_point, 0) - on_hand`, largest first. security_invoker. |
| `consignor_ledger` / `consignor_item_ledger` | Built (Phase 6 step 2, D46, D47): per consignor / per item liability, consignor charges, owed, paid (settlements not reversed), outstanding, counts and dates; derived, never stored; no API grant ([§9](#9-consignment)). |
| `purchase_order_progress` | Built (Phase 7). One row per PO line: `purchase_order_id`, `po_number`, `supplier_id`, `po_status`, `purchase_order_line_id`, `product_id`, `quantity_ordered`, `quantity_received` (sum of receipt lines, 0 when none), `quantity_outstanding` (ordered − received, ≥ 0, for draft/submitted/partially_received, else 0), `quantity_cancelled` (the same remainder when cancelled, D61), `expected_at` (the line's, else the PO's), `last_received_at` (latest receipt `received_at`), `is_overdue` (submitted/partially_received, outstanding > 0 and expected_at < `private.purchasing_shop_today()`). security_invoker, SELECT to authenticated, no cost column. `private.purchasing_shop_today()` is a security definer wrapper of Phase 5's `private.shop_today()` (EXECUTE to authenticated), not a competing calendar helper: authenticated has no EXECUTE on the Phase 5 helpers. |
| `product_on_order` | Built (Phase 7). Per product with something outstanding on submitted or partially received POs (never drafts, D66): `product_id`, `quantity_on_order`, `open_purchase_orders`, `next_expected_at`. security_invoker, SELECT to authenticated. |
| `low_stock` + `product_on_order` → `public.reorder_suggestions` | Built (Phase 7, D66 D-REORDER). Not a view: the staff RPC in §16 joins `low_stock` (the products, kept only when `products.ownership_type = 'shop_owned'`, D62), `product_on_order` (on order, submitted and partially received only) and `supplier_products`, and computes `private.suggested_reorder_quantity(reorder_point, on_hand, on_order)` = max(2 × reorder_point − on_hand − on_order, 0), NULLs as 0 (immutable SQL, no grant). No cost column. |
| `shopify_sync_status` | Built (Phase 10 step 2, D86). One row per product with a sync row: `product_id`, `short_id`, `name`, `tracking_type`, `publication_status`, `publish_online`, `shopify_origin`, `sync_status`, `last_pushed_at`, `last_pushed_quantity`, `last_error_code`, `last_error`, `shopify_product_id`, `shopify_variant_id`, and the open sync job (`open_job_id`, `open_job_status`, `open_job_next_attempt_at`: running, else queued, else needs_attention). security_invoker, SELECT to authenticated: active staff read the rows; the job columns are NULL for non-admins (the queue's RLS); customers and anon read nothing. |
| `public_items` | Built (Phase 4): the only thing anon can read about inventory, Phase 11's /q contract. Published (public or sold) products and their units with exactly `kind, short_id, slug, name, description, brand, category, condition, sale_price, currency, availability, photos, updated_at, buy_online_url`; price from `private.selling_price`; public photos only. `buy_online_url` (Phase 10 step 2, D84; the single Buy-online rule Phase 11 reads) = `shopify_settings.storefront_url ‖ '/products/' ‖ shopify_product_sync.shopify_handle`, only when the row's own `availability` is `available`, `publish_online`, `sync_status = 'synced'`, the origin is `bicii` with a handle, and the storefront is set, and the row is what Shopify sells (D81, D58): a unit row only when it is the unit an online order takes (the oldest available, non-customer-owned, non-archived unit at `online_location_id`, as `private.shopify_online_price`), a product row only when its `sale_price` is not distinct from the online price (for a unique product, `selling_price` of that unit); otherwise NULL (an external-origin product never has one). It exposes no Shopify id, sync state, cost or payload. Definer view (it reads the sync row and settings as its owner), security_barrier, SELECT for anon and authenticated. Rules in §11. |
| `payment_movements` | Built (Phase 14 step 3, D154b, D154e, `20261014001500_payment_reports`). Customer payments as money moved, never sales: one row per movement, columns `at`, `id`, `movement` (`online_payment`, `online_refund`, `counter_payment`, `counter_given_back`), `work_order_id`, `kind` (deposit or balance), `method` (counter rows), `amount` (positive), `signed_amount` (negative for a refund or money given back), `currency`, `other_currency`, `recorded_at`, `recorded_by` (counter rows only). security_invoker; granted to no API role; read through `report_payment_summary` and `report_payment_items` (§16). Rules below |

Materialise `daily_summary` only if measured to be slow; refresh then runs
`after()` completion/sale mutations.

**Phase 5 reporting rules (PLAN D30–D35).**

- `financial_lines`, `daily_summary`, `work_order_activity` and
  `operational_exceptions` are security_invoker views that are granted to
  NO API role, although `reporting` is exposed (the explicit revoke is
  tested). The app reads them only through the §16 RPCs, plus Phase 4's
  granted `reporting.low_stock`.
- The RPCs select view columns BY NAME and pass the `daily_summary`
  placeholders through un-coalesced, so Phases 2 and 6 replace only the
  views (create or replace, same leading columns) and the RPC results
  follow.
- Shop days (D35): every day computation goes through
  `private.shop_day(ts)`, `private.shop_today()` and
  `private.shop_day_start(day)`, never `current_date` or `ts::date`. They
  read `private.shop_timezone()` ('Asia/Singapore') and totals use
  `private.shop_currency()` ('SGD'); Phase 2 replaces those two bodies with
  the same signatures to read `shop_settings` (timezone, default_currency)
  with these fallbacks. All five are `stable`, `language sql`, not
  definer, with no API grants. The TypeScript mirror is `SHOP_TIME_ZONE` /
  `shopDateKey` in `src/lib/dates.ts`.
- "Recognised once" needs no lock of its own: `set_work_order_status` takes
  the job FOR UPDATE (`private.lock_work_order`) before its same-status and
  transition checks, so concurrent completions serialise and a repeat
  returns the row unchanged with no event; `financial_lines` has one entry
  per live line of a job with a `completed_at`
  (`reporting-concurrency.test.ts`).
- Significant adjustment (D33) lives in one replaceable function,
  `private.is_significant_adjustment(movement_type, quantity_delta,
  is_unit, unit_cost)`: a `stock_adjustment` or `damaged` movement with
  |delta| ≥ 5, on a unique unit, or |delta| × unit cost ≥ 100.00 (unit
  cost = `unit_cost_snapshot`, else `products.default_direct_cost`, else 0).
  An `outside_purchase` (D149a) is never one: neither it nor the adjustment
  views (`stock_adjustments_on`, `daily_summary`, `report_activity`) count
  it; its fit counts as a part used on a job like any `job_consumption`.

**Phase 9 period-report rules (PLAN D100–D105, [ADR-022](decisions/ADR-022-reporting.md)).**

- Date bases (D100, enum `report_date_basis`): `sale` (default) counts
  `financial_lines` (workshop lines at the job's CURRENT `completed_at`,
  sales at `recognized_at`); `check_in`, `completion` and `collection`
  count workshop lines only, dated by the job's `checked_in_at`,
  `completed_at` or `collected_at`; `check_in` includes work in progress.
  Cancelled jobs carry no money. Activity counts use each job's own stamps
  (D31) on any basis; appointments are by scheduled day and current status
  (D41). Weeks are ISO (Monday), months calendar months; a range is at most
  731 days (`report_range_too_long`), a reversed or NULL bound is
  `report_range_invalid`.
- `private.report_rows(p_from, p_to, p_basis, p_after_at, p_after_id,
  p_limit = null, p_foreign = false)` returns the `report_lines` columns
  plus `basis_at`, one query per basis, shop currency only (or, with
  `p_foreign`, every other currency, which `private.report_foreign_rows`
  counts for `excluded_foreign_line_count`, D104). The half-open instant
  range is computed once (`private.shop_day_start(p_from)` ..
  `private.shop_day_start(p_to + 1)`) and filters the raw timestamptz
  columns, so their indexes are used. The keyset cursor
  `(basis_at, source_line_id) < (p_after_at, p_after_id)` and the page
  limit go inside each per-basis query; with a limit, the bound "the
  basis instant of the p_limit-th newest document with a counted line
  before the cursor" lets the query read a few documents instead of the
  range (each such document has at least one line on the page side).
- Bucketing (D35): after filtering, rows are bucketed inline with
  `(ts at time zone v_tz)::date`, `v_tz = private.shop_timezone()` read
  once; this is `private.shop_day`'s own definition (a test proves they
  agree at the boundary instants). Measured on the bench: bucketing 58,759
  `financial_lines` rows with `private.shop_day` took 1,235 ms, inline
  76 ms, because the helper re-reads `shop_settings` per row.
- Gating (D30): the financial RPCs require `view_financial_reports`;
  every cost-derived column (cost, yield, Cult Commons, yield after CC,
  loss counts, consignor liability, settlements paid, purchases received,
  stock value) is NULL without `view_costs`. Gross figures, counts,
  refunds and the consignment sales count and total are always returned.
  `manage_purchasing` never shows a cost in a report (D60). The activity
  RPCs need an active staff member and return no money.
- Breakdown keys (`private.report_key`, one inline CASE): job =
  `document_id`; product = `product_id` or `none`; category =
  `category_id` or `none`; service = `service_id`, `products` (inventory
  and sale lines) or `manual`; mechanic = the current lead (D103),
  `unassigned` or `not_workshop`; ownership = `shop_owned`,
  `consignment`, `customer_owned` or `service`; channel = `workshop`,
  `retail` (sale_source retail) or `online` (online_shopify). Every line
  is in exactly one group. The order `sale_total desc, key asc` (collation
  C) is the keyset; it uses gross only, so paging reveals no cost.
- Refunds (D102) are `sale_refunds` by `created_at` in the shop currency,
  sale basis only, beside gross and never netted; settlements paid are
  `consignment_settlements` by `paid_at`, not reversed; purchases received
  are `purchase_receipt_lines.received_total` of receipts by
  `received_at` (D105), so a part bought outside BICII (D149a, no receipt)
  is not in them (RISKS R-084). Nothing is stored: a reopen, a back-dated
  sale or a back-dated receipt restates past periods (D101, RISKS R-055).
- Stock value (D105, `20261006001100_report_stock_value`): NOW, per
  ownership type; quantity products Σ max(on-hand per location, 0) at
  `products.default_direct_cost` (the last cost, D5/D63, and since D149a
  the cost of a part bought outside BICII; RISKS R-056);
  available or reserved units at their own cost, else the product's; a
  NULL cost (or a product in another currency) is not valued and counts in
  `uncosted_items`; 0 is valued; consigned and customer-owned stock is
  counted, never valued.

Report timings (`scripts/bench/report-volume.sql` on a throwaway clone of
`bicii_dev_wt`, 2026-10-06: 15,021 jobs, 51,025 work-order lines, 10,004
sale lines, 101,045 movements, 2,003 receipt lines; EXPLAIN ANALYZE
execution time, ms; targets: month < 300, year < 1,500, a line-items page
< 100, stock value < 300; all met):

| Call | Month | Year |
|---|---|---|
| `report_period_summary` sale / check_in / completion / collection | 76 / 88 / 47 / 93 | 284 / 266 / 227 / 234 |
| `report_period_series` sale by day; check_in by month | 55 | 451; 304 |
| `report_breakdown` job (sale); product (completion), mechanic (collection), category (check_in) | 36 | 447; 243, 246, 280 |
| `report_line_items` first page; a page 40,000 lines deep; a month's workshop channel | — | 10; 35; 26 (month) |
| `report_activity`; `report_activity_by_mechanic` | 31 | 316; 20 |
| `report_stock_value` (now) | 15 | — |

Re-run at the end of Phase 9 (step 4, 2026-10-06, same bench and data
shape on a fresh clone; the machine is shared, so ±20% is noise): summary
month 53–97 / year 259–297; series 59 (month), 522 (year by day), 337
(year by month); breakdown 37 (month), 502 job, 312 product, 407
mechanic, 310 category (year); line items 8, 56, 42; activity 46 / 318,
by mechanic 23; stock value 18. Every target is still met; the moves are
within the noise (step 4 changed no SQL).

**Phase 9 reconciliation and exception rules (PLAN D106–D108, [ADR-022](decisions/ADR-022-reporting.md#2026-10-06-stock-reconciliation-and-operational-exceptions-d106d108)).**

- No `inventory_balances` cache (D106): the ledger sum is the stock. A
  future cache must be a trigger-maintained projection that these views
  also check (SPEC §12, §26).
- Reconciliation is read-only. Phase 4's deferred
  `inventory_unit_ledger_consistent` trigger already refuses most unit
  drift at commit, so an issue means the triggers were bypassed (owner SQL
  in replica mode, a restore, a hand fix) or a check the trigger does not
  make failed (disposition versus status, a hold without an open job,
  consignment item versus unit). The fix is an existing guarded flow
  (adjust stock with a reason, restock, settle, void, return); an issue
  that persists after it is an RPC defect.
- Every RPC-reachable unit path reconciles after every step
  (`tests/db/stock-reconciliation.test.ts`): hold, void, sell at
  completion, reopen (D25), retail sale, refund (D7), restock, transfer,
  cancel (D16), consigned job part (D44), consignment return, write-off.
  No RPC defect was found.
- One exceptions surface: `reporting.operational_exceptions` and
  `public.operational_exceptions(max_rows)`; no enum of kinds, no second
  view, no second list RPC. `public.report_exception_counts()` counts the
  same rows per kind and severity.
- The Phase 10 extension point: `private.integration_exceptions()` has
  Phase 10's nine-column signature (`kind, severity, entity_type,
  entity_id, entity_label, subject_label, days, quantity, since`). On this
  branch `20261006001300` creates it only if absent, as a placeholder with
  no rows; after Phase 10's `20261004004000` (which sorts first) Phase
  10's body is kept, and the extended view maps the six appended columns
  itself (`issue` = kind, `title` = entity_label, `detail` =
  subject_label, the rest NULL). Re-verify on the integrated branch
  (RISKS R-058).
- The reconciliation and exception RPCs run with `jit = off`: on the bench
  JIT compilation added 100–250 ms per call to these wide plans and saved
  nothing. The currency_mismatch branches read the shop currency once per
  query (`(select private.shop_currency())`), not once per line.
- No new index: the latest-movement lookup per unit uses
  `inventory_movements_unit_idx` (`inventory_unit_id, id`) and sorts a
  unit's few rows (about 4 µs per unit on the bench), so an
  `(inventory_unit_id, created_at)` index is not needed;
  `settlement_lines(consignment_item_id)` exists, and
  `consignment_items(status, sold_at)` would not help (the ledger reads
  every item).

Reconciliation and exception timings (the same bench, section 3, 2026-10-06:
3,006 unique units, 4,808 unit movements, about 110,000 movements in all,
15,021 jobs of which 1,503 are overdue or uncollected; EXPLAIN ANALYZE
execution time, ms):

| Call | Target | Measured |
|---|---|---|
| `report_stock_reconciliation()` issues only; all (627 rows) | < 500 | 50; 62 |
| `report_unit_reconciliation()` issues only; all (1,000 of 3,006) | < 500 | 67; 88 |
| `operational_exceptions(200)` (1,503 rows before the cap) | < 500 | 390 (973 before the two fixes above) |
| `report_exception_counts()` | < 150 | 257 (585 before); missed, R-059 |
| `today_dashboard(null)` | < 150 | 8,837: `public.daily_summary(d, d)` alone takes 6,400–8,400 (Phase 5's view, unchanged here); missed, R-059 |

Step 4's re-run (2026-10-06, 3,008 units): stock reconciliation 48
(issues) and 59 (all, 629 rows), unit reconciliation 62 and 90 (all, the
1,000-row cap of 3,008), `operational_exceptions(200)` 402,
`report_exception_counts()` 259 (still missed), `today_dashboard(null)`
9,512 (still missed, R-059). The Exceptions screen calls the list and the
counts in parallel; the `/reports` count Badge calls the counts in its own
Suspense boundary.

**Phase 14 step 3 payment-report rules (PLAN D154a–e,
[ADR-025](decisions/ADR-025-stripe-payments.md#status-update-2026-10-17-step-3s-database)).**

- Money held, not sales (D154): `payment_movements` is not a branch of
  `financial_lines`, `report_lines` or `daily_summary`, and the sales
  reports, the daily summary and job totals read the same before and after
  any payment, refund, counter payment, void or balance payment
  (`tests/db/stripe-payments.test.ts` "D154", `payment-reports.test.ts`).
- Branches (D154b), each dated by its own indexed column:
  `online_payment` (a payment in the paid group, at `paid_at`, amount
  `coalesce(amount_received, amount)`, `other_currency` when Stripe took
  another currency); `online_refund`, written as two branches with the
  same predicate as one OR: a refund Stripe dated, at
  `stripe_created_at`, and one it did not, at BICII's `created_at`; both
  count only refunds `private.payment_refund_total` counts (succeeded, the
  payment's currency, the payment's mode or none) of payments in the paid
  group; `counter_payment` (at `received_at`, left out when voided as
  recorded in error, so its day restates, D101); `counter_given_back` (a
  given-back void, at `voided_at`, or the payment's `received_at` plus one
  microsecond if that is later (a payment dated up to 5 minutes ahead and
  given back at once: never before its payment, the same shop day, and
  (at, id) stays unique for the keyset), negative, with the counter
  payment's id, the void's own time as `recorded_at` and who voided it).
- The identity, pinned per job in `payment-reports.test.ts`: over all time,
  online payments less refunds plus counter payments less money given
  back equals `work_order_payment_totals.net_paid`.
- The three RPCs are security definer with `search_path = ''`, call
  `private.require_permission('view_financial_reports')` first (D154d,
  D30), the period ones then `private.report_require_range`; the range is
  half-open shop days (`private.shop_day_start`); totals in the shop
  currency only (D104), other currencies counted in
  `other_currency_count`. `report_payments_held()` reads
  `work_order_payment_totals` for jobs with a paid-group Stripe payment, a
  live counter payment, or a completed or ready status, so its figures
  equal the job card; shop-currency jobs only; its three groups are
  disjoint, and a job's amounts add up to `net_paid` until it is collected
  and to `held_over_total` after.
- Indexes (`period-reports.test.ts` "Report queries are indexed"):
  `payments_paid_at_idx` (`paid_at`, where set),
  `payment_refunds_stripe_created_idx` (`stripe_created_at`),
  `payment_refunds_created_fallback_idx` (`created_at` where
  `stripe_created_at` is null), and from `20261014001300`
  `counter_payments_received_at_idx` and
  `counter_payment_voids_voided_at_idx`.

Payment report timings (an ad hoc measurement in a rolled-back
transaction on `bicii_dev`, 2026-10-17; `scripts/bench/report-volume.sql`
has no payments section yet and was not re-run): a one-day range of the
movements over 20,000 payments, 20,000 refunds (1% without Stripe's
created time) and 20,000 counter payments returned 4,320 movements in
5.5 ms, every branch on its own index; `report_payments_held()` with
20,000 jobs (50 with a payment) took 30–38 ms, because
`work_order_totals` is aggregated for every job when joined. On the dev
seed plus one payment and one counter payment per job: held 16 ms,
summary 7 ms, items 11 ms (first calls).

## 15. Row-level security matrix

`S` = active staff (any), `P(x)` = active staff holding permission x (by
role or as an exception), `M` = the manager role, `A` = the admin role,
`C` = authenticated customer on own rows, `anon` = anonymous. RPC = only via
security-definer function. Blank = no access. Since the staff roles
(D90–D94), every `P(x)` other than `P(manage_staff)` is also satisfied by
`M` (D91), and every `P(x)` by `A`; rows below that matter for roles are
written out, e.g. `A, M or P(view_costs)`.

| Table | select | insert | update | delete |
|---|---|---|---|---|
| staff | S (own row + names of others); A full; A or P(manage_staff) via `staff_roster()` (M only with the `manage_staff` exception) | RPC `create_staff` (A any role; P(manage_staff) not A: mechanics only, D93) | RPC `update_staff` (role: A only, never own; rename: A, or P(manage_staff) on mechanics), `set_staff_active` (A, or P(manage_staff) on mechanics, never self) | — |
| staff_permissions (exceptions, D92) | A, own | RPC `grant_permission` (A, or P(manage_staff) on mechanics within D11, D93; never a permission the role implies: `permission_implied_by_role`, also a trigger for every writer) | — | RPC `revoke_permission` (same reach); trigger `staff_role_drop_implied_exceptions` on a role change |
| staff_events | A or P(manage_staff) via `staff_history()` | triggers only | never | never |
| private.sign_in_attempts (D72) | nobody (RLS on, no policy, no grant) | service role via RPC `note_sign_in_attempt` | the same RPC (counts) | the same RPC (counters older than a day) |
| customers | S; C own via `my_customer_profile()` | S (no `auth_user_id`, `shopify_customer_id`); C via RPC `claim_my_customer` (Phase 11: links the one unlinked record with the login's email, D121, or creates one at the first booking, D122) | S (same columns, `archived_at`); C own name/phone via `update_my_profile()` | — (archive) |
| bikes | S; C own current, non-archived via `my_bikes()` | S (no `short_id`: server-assigned) | S (no `short_id`, `customer_id`, `inventory_unit_id`); owner via RPC `transfer_bike_ownership` | — (archive) |
| bike_ownership_events | S | trigger only | never | never |
| attachments | S; C `customer`/`public` rows of own bikes via `my_bike_attachments()` and of own jobs via `my_work_order_attachments()` | RPC `record_attachment` (S) | S caption only; visibility via RPC `set_attachment_visibility` (S) | RPC `delete_attachment` (S, reason) |
| attachment_events | S | triggers only | never | never |
| storage `media-internal` | S; C the objects of their own customer- or public-visible bike photos (current, non-archived bikes) and job photos (jobs not cancelled), policy `media_internal_select_customer` over `private.customer_can_read_media` (Phase 11, D124) | S | — | S, only objects no attachment points at |
| storage `media-public` | S (everyone else only by public URL; nobody lists it) | S | — | S, only objects no attachment points at |
| shop_settings | S; nobody else (anon/C read none of it) | — (one row, inserted by the migration) | RPC `update_shop_settings` (A); `consignment_settlement_alert_days` only through RPC `set_consignment_settlement_alert_days` (A, D107; authenticated has no UPDATE on the table, so a direct write is 42501 even for an admin); `indent_deposit_percent` only through RPC `set_indent_deposit_percent` (A, D151, D157) | never (`shop_settings_required`) |
| shop_hours | S; anon/C active weekly rows via `public_shop_hours()` | RPC `set_shop_hours` (A) | RPC `set_shop_hours` (A) | RPC `set_shop_hours` (A) |
| closure_overrides | S (anon/C: never listed; `available_slots` leaves closures out) | RPC `save_closure_override` (A) | RPC `save_closure_override` (A) | RPC `delete_closure_override` (A, reason) |
| appointment_types | S; anon/C active + public types (no capacity units) via `public_appointment_types()` | RPC `save_appointment_type` (A) | RPC `save_appointment_type` (A) | — (deactivate) |
| schedule_events | S | triggers only | never | never |
| appointments | S; C own via `my_appointments()` (D42 projection); anon/C bookable times via `available_slots()` (D37) | RPC `book_appointment` (S), `book_my_appointment` (C, D37) | RPC `mark_appointment_status`, `cancel_appointment`, `update_appointment`, `check_in_appointment` (S, D40); `cancel_my_appointment` (C, D37); completed only by the D36 work-order trigger | — |
| appointment_events | S | triggers only | never | never |
| work_orders | S; C own, not cancelled, via `my_work_orders()` (D17) | RPC `create_work_order` | RPC (`set_work_order_status`, `update_work_order`, `set_approval_flag`; `lead_mechanic_id` by the assignments trigger) | — |
| work_order_assignments | S | RPC `assign_staff` (S, D22) | RPC `unassign_staff` (closes the row) | — |
| work_order_events | S; C own job's check-in, customer-status changes and customer-visible photos via `my_work_order_timeline()` (D8, D17) | triggers and `add_work_order_note` only | never | never |
| job_part_requests | S, except `expected_unit_cost` and `supplier_id` (D60, D147: `job_part_requests_staff`, view_costs or manage_purchasing); `outside_purchase_movement_id` (D149a) is granted like the other links (not a cost) | RPC `propose_part`, `propose_service` (S; a cost or supplier needs view_costs or manage_purchasing) | RPC `send_quote`, `answer_quote`, `order_part_requests` (manage_purchasing; open jobs only), `fit_part_request` (open jobs only), `fit_part_bought_outside` (view_costs or manage_purchasing; open jobs only, D149a), `cancel_part_request` (S until the job is collected or cancelled; then A or M only, D149) | never |
| quotes | S, except `token_hash` (never granted; `deposit_percent` and `deposit_amount` granted since Phase 14 step 2); anyone holding a link reads one quote's customer view through `quote_by_token` (D143) | RPC `send_quote` (S) | RPC `withdraw_quote` (S; not on a collected or cancelled job), `answer_quote` (anyone with the link, once); the deposit columns only by the `quotes_deposit_snapshot` trigger (`quote_deposit_immutable`) | never |
| quote_items | S | RPC `send_quote` | RPC `answer_quote` (the decision, once) | never |
| categories | S | P(manage_inventory) (A included) | P(manage_inventory) | — (archive) |
| services | S, every column except `default_direct_cost`; P(view_costs) everything via `services_staff`; anon/C listing in Phase 11 through a separate projection | RPC `create_service` (P(manage_inventory); a cost needs P(view_costs)) | RPC `update_service`, `set_service_archived` (same) | — (archive) |
| cult_commons_rates | P(view_costs) | RPC `schedule_cult_commons_rate` (A) | RPC `cancel_cult_commons_rate` (A, future rates only) | never |
| work_order_line_items | S sale columns only, plus `consignment_item_id` (Phase 6); P(view_costs) everything, including `consignor_payout_snapshot`, via `work_order_line_items_staff`; C own job's live lines (description, quantity, unit price, total) via `my_work_order_lines()` | RPC `add_service_line`, `add_manual_line` (cost needs P(view_costs)), `add_inventory_line` (S; shop-owned or consigned stock, D44); trigger `work_order_line_items_consignment_rules` for every writer | RPC `void_line` (voided_* only) | never |
| work_order_totals / work_order_totals_staff (views) | S sale totals / P(view_costs) cost, yield, Cult Commons | — | — | — |
| locations | S | P(manage_inventory) (id, name, kind, active, sort_order) | P(manage_inventory) (name, kind, active, sort_order; `location_has_stock`) | — (deactivate) |
| products | S, every column except `default_direct_cost`; anon/C via `public_items` only | P(manage_inventory) (no short_id, publication, slug, ownership or Shopify ids; a cost needs P(view_costs): `products_cost_write_guard`); RPC `split_unit_from_stock` (P(adjust_stock) and P(manage_inventory)) | P(manage_inventory) (sku, name, description, brand, category, prices, reorder point, active, archived_at; cost guard as insert); publication via RPC `set_publication_status` | — (archive) |
| inventory_units | S, every column except `direct_cost` | RPC `create_unique_unit` (P(manage_inventory); cost needs P(view_costs)) | P(manage_inventory) serial, condition, prices, notes, archived_at (cost guard); status, location, bike, ownership only by RPCs and triggers | — (archive) |
| inventory_movements | S, every column except `unit_cost_snapshot` | RPCs only (`private.record_movement`, `private.record_linked_movement`, Phase 7's `private.record_receipt_movement`; D50 trigger for consigned products) | never (`movement_append_only`) | never |
| product_events, inventory_unit_events | S | triggers only | never | never |
| product_costs, inventory_unit_costs, inventory_movement_costs (definer views) | P(view_costs): costs, expected yield and Cult Commons | — | — | — |
| selling_prices (definer view) | S: effective selling price per product and unit (`private.selling_price`) | — | — | — |
| reporting.stock_levels, product_stock, low_stock | S (security_invoker over staff-only RLS) | — | — | — |
| sales, sale_lines, sale_refunds | Built (Phase 6 step 2, D48): rows to S; `sales` every column except `request_fingerprint`; `sale_lines` every column except `unit_direct_cost_snapshot`, `consignor_payout_snapshot`, `cost_total`, `yield_total`, `cult_commons_rate_snapshot`, `cult_commons_share` (no column grant to anyone: P(view_costs) reads cost, yield, rate and Cult Commons, and P(manage_consignments) or P(view_costs) the payout, through `list_sales` / `sale_lines_detail`); `sale_refunds` every column. P(view_financial_reports) alone reveals no cost | RPC `record_retail_sale` (S); `record_sale_refund` (A or M by role, D94 amends D49; no permission or exception grants it) | RPC `restock_unit` (`restocked_*` once; P(adjust_stock), a consigned unit also P(manage_consignments)); refunds change `sales.status` | never |
| consignors | Built (Phase 6 step 1, D48): S every column except `payout_details` (P(manage_consignments) only, via step 3's RPCs; no column grant) | P(manage_consignments) (id, customer, name, email, phone, payout details, notes) | P(manage_consignments) (same plus `archived_at`; `consignor_has_open_items`) | — (archive) |
| consignment_items | Built: S every column except `agreed_amount_owed` and `request_fingerprint` | RPC `create_consignment_item` (P(manage_consignments)) | P(manage_consignments) notes only; terms, status and returns by RPCs and triggers | — |
| consignment_item_charges | Built: S with P(manage_consignments) or P(view_costs) (`private.can_view_consignment_money()`, rows) | RPC `add_consignment_charge` (P(manage_consignments)) | RPC `void_consignment_charge` (void columns once) | never |
| consignment_item_events | Built: as charges (payloads carry amounts) | triggers only | never | never |
| reporting.consignment_item_position, consignor_item_ledger, consignor_ledger | no grants; read by definer functions | — | — | — |
| consignment_settlements, settlement_lines, consignment_settlement_reversals | Built (Phase 6 step 2, D48): rows with P(manage_consignments) or P(view_costs) (`private.can_view_consignment_money()`); settlements every column except `request_fingerprint` | RPC `record_settlement`, `reverse_settlement` (P(manage_consignments)) | never (`settlement_immutable`; corrected by whole-settlement reversal, D47) | never |
| suppliers | S | P(manage_purchasing) (id, name, contact_name, email, phone, website, account_reference, notes) | P(manage_purchasing) (same columns + archived_at; `supplier_has_open_orders`) | — (archive) |
| supplier_products | S, every column except `last_unit_cost` | RPC `set_supplier_product` (P(manage_purchasing); shop-owned products only, `purchase_line_not_shop_owned`); `receive_purchase` | same | RPC `remove_supplier_product` |
| purchase_orders | S | RPC `create_purchase_order` (P(manage_purchasing)) | RPCs (`update_purchase_order`, `submit_purchase_order`, `cancel_purchase_order`, `receive_purchase`) | never |
| purchase_order_lines | S, every column except `unit_cost`, `ordered_total` | RPC `set_purchase_order_line` (P(manage_purchasing)) | same | RPC `remove_purchase_order_line` |
| purchase_order_events | S with P(view_costs) or P(manage_purchasing) (D60: payloads carry costs) | triggers only | never | never |
| purchase_receipts | S | RPC `receive_purchase` (P(manage_purchasing)) | never (`purchase_receipt_immutable`) | never |
| purchase_receipt_lines | S, every column except `unit_cost_actual`, `received_total` | RPC `receive_purchase` | never | never |
| supplier_products_staff, purchase_order_lines_staff, purchase_receipt_lines_staff, purchase_order_totals_staff (definer views) | P(view_costs) or P(manage_purchasing) (D60 cost set: last, line, actual costs and totals) | — | — | — |
| reporting.purchase_order_progress, product_on_order | S (security_invoker over staff-only RLS; no cost columns) | — | — | — |
| label_templates, printer_profiles | Built (Phase 8 step 1): S; C and anon none | A (RLS `*_insert_admin`; column grants: templates id, name, kind, width_mm, height_mm, layout, active; profiles id, name, adapter, config, active, sort_order; never `is_default` or `created_by`) | A (column grants: templates name, width_mm, height_mm, layout, active; profiles name, config, active, sort_order); `is_default` only via RPC `set_default_label_template` / `set_default_printer_profile` (A) | never (switch off) |
| print_jobs | Built (Phase 8 step 1): S; C and anon none | RPC `create_print_job` (S) | RPC `set_print_job_status` (S; status columns only, D59) | never (`print_job_immutable`) |
| integration_events, integration_retry_queue, integration_audit_events | A (D86: payloads and messages name customers); service role SELECT | RPC only: `record_shopify_webhook` (service role); jobs also `claim_integration_jobs`, the processors, `retry_integration_job`, `dismiss_integration_job`; audit rows by the staff RPCs | RPC only; events immutable except processing columns (`integration_event_immutable`), audit append-only | never (events: only `private.purge_integration_events`, owner by hand, rejected rows ≥ 30 days old, D88) |
| stripe_events (Phase 14, D86) | A (delivery evidence); C and anon none | RPC only: `record_stripe_event`, `record_stripe_read` (service role) | RPC only; immutable except the delivery count and, while `received`, the decision (`stripe_event_immutable`) | never (only `private.purge_stripe_events`, owner by hand, rejected rows ≥ 30 days old, D88) |
| payments (Phase 14, D153, D154) | S (what was paid on a job); service role SELECT; C and anon none | RPC only: `record_deposit_checkout` (service role, step 2) and `record_balance_checkout` (service role, step 3, D156g); the guard allows only a pending row | RPC only, citing the Stripe event being applied (`payment_immutable`) | never (`payment_immutable`) |
| payment_refunds (Phase 14, D155) | S for rows matched to a payment; A also unmatched rows (another sale of the Stripe account); C and anon none | RPC only (the apply paths) | RPC only; status only up in rank (`payment_refund_immutable`) | never (`payment_refund_immutable`) |
| work_order_unfitted_requests (R-082; security invoker view; no cost column) | S, through the RLS and column grants of `job_part_requests`; C reads 0 rows; anon none | — | — | — |
| quote_deposits, payment_issues, work_order_payment_totals (Phase 14 step 2, D151, D154, D159b; security invoker views; replaced in step 3, D161j) | S, through the RLS of `quotes`, `quote_items`, `job_part_requests`, `payments`, `payment_refunds`, `counter_payments`, `counter_payment_voids` and `work_orders` (`payment_issues` reads the refund-failure time from each refund's own `status_changed_at`, so it needs no definer helper and no access to `stripe_events`); `work_order_payment_totals` has a row for every job since `20261014001300`; C reads 0 rows; anon none | — | — | — |
| counter_payments, counter_payment_voids (Phase 14 step 3, D161) | S (`counter_payments`: every column but `request_fingerprint`, never granted); service role none; C and anon none | RPC only: `record_counter_payment`, `void_counter_payment` (an active admin by role, D161a: a manager or mechanic 42501) | never (`counter_payment_immutable`, every role, the owner too) | never (`counter_payment_immutable`) |
| balance_links (Phase 14 step 3, D156) | S, every column but `token_hash` (never granted); whoever holds a link reads its page through `balance_by_token` (D156f, anon and signed in); C and anon none | RPC only: `send_balance_link` (S) | only the withdrawal, each column once from null: `withdrawn_at`, `withdrawn_reason`, `replaced_by`, by `send_balance_link` and the trigger `work_orders_withdraw_balance_link` (`balance_link_immutable` otherwise, every role) | never (`balance_link_immutable`) |
| reporting.payment_movements and the payment report RPCs (Phase 14 step 3, D154) | the view: no grants (admins included, 42501); `report_payment_summary`, `report_payment_items`, `report_payments_held`: A, M or P(view_financial_reports) (42501 otherwise, even for view_costs alone); C 42501; anon no EXECUTE | — | — | — |
| shopify_settings, shopify_product_sync | S (sync status and the online location, D86); service role SELECT | seed; RPC `set_shopify_settings` (A; creates the row when absent), `set_publish_online` (P(manage_inventory)), `link_shopify_variant` (A) | RPC `set_shopify_settings` (A; `accept_test_orders` only with a reason, D89), `set_publish_online`, `request_product_sync` (P(manage_inventory)), `record_product_sync_result` (service role), the deferred enqueue triggers (`sync_status` pending) | never |
| reporting.shopify_sync_status | S (security_invoker; job columns admins only through the queue's RLS) | — | — | — |
| reporting.* financial views (financial_lines, daily_summary, work_order_activity, operational_exceptions) | no grants (not even SELECT to authenticated); via RPCs: S for counts; P(view_financial_reports) for money rows; cost columns P(view_costs) (FIN-ACCESS D30) | — | — | — |
| reporting.report_lines and the Phase 9 report RPCs (D100–D105) | the view: no grants; `report_period_summary`, `report_period_series`, `report_breakdown`, `report_line_items` and `report_stock_value`: A, M or P(view_financial_reports) (42501 otherwise), every cost-derived column also A, M or P(view_costs), NULL otherwise (D30; `manage_purchasing` alone never shows a cost here, D60); `report_activity` and `report_activity_by_mechanic`: S, no money; C and anon: none (no EXECUTE for anon; 42501 for a customer) | — | — | — |
| reporting.unit_ledger_disposition, unit_reconciliation, stock_reconciliation and the operational exceptions (D106–D108) | the views: no grants; `report_stock_reconciliation`, `report_unit_reconciliation`: S (stock is staff-visible; no cost column); `operational_exceptions`, `report_exception_counts` and `today_dashboard.exceptions_now`: S, each row filtered by `private.exception_visible(kind)` (D108): Phase 5's kinds and unit_state_mismatch S, unsettled_consignment A, M or P(manage_consignments) or P(view_costs) (`private.can_view_consignment_money()`, D48), integration_failed A (`private.is_admin()`, D86), payment_attention A or M (`private.can_record_refunds()`, D159b), stripe_attention A (D86, D159b); C and anon: none | — | `set_consignment_settlement_alert_days` A (42501 otherwise, even with manage_consignments) | — |
| reporting.public_items | everyone: anon and authenticated (definer view, published rows and public columns only; the only anonymous inventory surface; anon has USAGE on `reporting` for it and EXECUTE on `private.selling_price`, which it calls) | — | — | — |

**Customer access pattern (Phase 1, binding for every later phase).** Staff
and signed-in customers share the `authenticated` role, so a column grant
cannot show `internal_notes` to staff and hide it from customers, and RLS
can only hide whole rows. Therefore "C own" never means a customer policy on
a base table. Base tables that hold anything staff-only (customers, bikes,
attachments, and later appointments, work orders, events, line items) have
RLS policies for active staff only (`private.is_staff()`); a customer
selecting them gets zero rows. Customers read and write through
`security definer` RPCs named `my_*` (or verbs on "my" data) that resolve
the caller with `private.current_customer_id()`, never accept a customer id
from the caller, and return an explicit list of customer-safe columns (a
named composite type or `returns table`). Asking for a record that is not
theirs returns nothing rather than an error. EXECUTE goes to `authenticated`
only; anonymous access is a separate, explicitly public projection
(`reporting.public_items`, public appointment types). Each such RPC is
listed in `tests/fixtures/api-surface.ts` and tested for: own rows only,
no staff-only column in the result keys, another customer's id returns
nothing, anon is refused (`customer-access.test.ts` is the template).

**Customer job projection (Phase 3, shown in Phase 11; PLAN D8, D17).**
The four `my_work_order*` RPCs follow the pattern above. Which jobs: those
where the caller is `work_orders.customer_id`, whoever owns the bike now (a
new owner does not see the previous owner's jobs; the previous owner keeps
theirs) and whether or not the bike was archived since; cancelled jobs are
hidden everywhere. What of them: a coarse `customer_job_status`
(`private.customer_job_status`: received/diagnosing/ready_to_start →
`received`, in_progress/paused → `in_progress`, the rest as they are,
cancelled → null), the bike's short ID and title, the check-in,
completion, ready and collection times, and the live lines' sale total;
lines show description, quantity, unit price and total only; the timeline
shows check-in, changes of the customer status and customer-visible photos
that still exist. Requested work, intake/internal/completion notes,
approval, assignments, actors, event payloads and every cost, yield, rate
or Cult Commons value are never returned. Job photos follow D17 (the job's
customer), not the bike-photo rule of D12.

Column-level gating of cost/yield for staff without `view_costs` is done with
views (`*_staff` views include the columns; base tables revoke `select` on
those columns from `authenticated` via column grants). Customers never read
`internal_notes`, costs, yield, consignor or Cult Commons data; this is tested
(see TESTING.md).

## 16. RPC catalogue (security definer, in `public`)

Read RPCs that some callers may run but not see every column of return
gated columns as NULL, never omitted and never an error (Phase 5's D30
reports; Phase 6's sale costs, `private.can_view_sale_costs()`, and
consignment money, `private.can_view_consignment_money()`, D48).

Each RPC begins with `private.require_permission(...)` or `private.is_staff()`
as appropriate, runs in a single transaction, locks the rows it mutates, and
returns the created/affected row (except where a row would carry cost columns
an RPC result cannot gate: the line and service RPCs return the id, §5
deviation (b)). Idempotent ones accept an idempotency key or rely on a unique
index and return the existing row on replay.

Business errors an RPC raises on purpose use SQLSTATE `P0001` with `MESSAGE`
set to a stable snake_case code (for example `staff_email_mismatch`) and
`DETAIL` set to an explanation. `src/lib/db-errors.ts` maps known codes to
user-facing messages; unknown codes become a generic error. Authorization
failures are `42501`, missing rows `P0002`, the last-admin guard `55000`.
Unique (`23505`) and check (`23514`) violations are mapped by constraint name.
A security definer function that writes a table with columns its callers
may not read (`services`, `work_order_line_items`) catches
`check_violation` and `not_null_violation` around the write and re-raises
them with `private.raise_without_row(sqlstate, constraint, table, schema,
column, message)`: same SQLSTATE, constraint and message, no DETAIL. The
DETAIL ("Failing row contains (…)") is built with the definer's privileges
and would print the hidden columns (costs) to any caller through PostgREST.

| RPC | Guard | Effects |
|---|---|---|
| `update_shop_settings(intake_slot_minutes = null, intake_capacity_units = null, booking_min_notice_minutes = null, booking_horizon_days = null, customer_max_active_bookings = null, customer_cancel_cutoff_minutes = null, public_site_url = null)` → `shop_settings` | A | Built (Phase 2). `shop_settings` FOR UPDATE; null keeps a field, `public_site_url` '' clears it; no time zone or currency parameter (D35); `shop_capacity_below_type` when an active type takes more units; checks 23514 by name; unchanged → the row, no event. Never moves appointments (D38). |
| `set_shop_hours(weekday smallint, intervals jsonb, active = true)` → `setof shop_hours` | A | Built (Phase 2). Replaces one weekday's rows atomically from a JSON array of 0..4 `{"opens_at","closes_at"}` ("HH:MM", closes_at up to "24:00"); weekday outside 0..6 or malformed JSON → 22023; an inverted interval → 23514 `shop_hours_interval_check`; overlaps → `shop_hours_overlap`; the same intervals and flag → the existing rows, no events. |
| `save_closure_override(closure_id, is_new, kind closure_kind, first_day date, last_day date, reason, from_time time = null, to_time time = null)` → `closure_overrides` | A | Built (Phase 2, D38). closed without times: whole days; closed with both times: part of one day; custom_hours: times required, whole days. `closure_invalid_range` (last before first, over 366 days, one time only, times on several days, start not before end), `reason_required`, 23514 `closure_overrides_reason_check` (> 200), `closure_custom_hours_overlap` (exclusion constraint as backstop, 23P01). is_new: insert, identical row → replay (no event), different row → `closure_conflict`; not is_new: P0002 when missing, else update (no event when unchanged). |
| `delete_closure_override(closure_id, reason)` → `closure_overrides` | A | Built (Phase 2). `reason_required` / `reason_too_long` first; deletes and returns the row (its `deleted` schedule event keeps the row and the reason); null when already gone. |
| `save_appointment_type(appointment_type_id, is_new, name, description, duration_minutes, capacity_units, public, active, sort_order = 0)` → `appointment_types` | A | Built (Phase 2). Same insert-or-replay semantics (`appointment_type_conflict`, P0002); an active type above the intake capacity → `appointment_type_capacity_too_large`; 23505 `appointment_types_name_key` (ignoring case); existing appointments keep their snapshot (D38). |
| `public_appointment_types()` → `id, name, description, duration_minutes` | everyone (anon, authenticated) | Built (Phase 2). Active and public types by sort_order, name; never capacity units. |
| `public_shop_hours()` → `weekday, opens_at, closes_at` | everyone | Built (Phase 2). Active weekly rows by weekday, opens_at; closures are not listed. |
| `available_slots(day date, appointment_type_id uuid)` → `slot_start, slot_end, remaining_units` | everyone (D37; Phase 11 must not revoke anon) | Built (Phase 2). `private.available_slots_at(day, type, now(), private.is_staff())`; `remaining_units` NULL for non-staff; null arguments → 22004. Phase 11's `bookable_slots` range wrapper calls `private.available_slots_at`. |
| `bookable_slots(from_day date, to_day date, appointment_type_id uuid)` → `slot_day, slot_start, slot_end` | everyone (D123) | Built (Phase 11). For each day from `from_day` to `to_day` (at most 31 days: `slot_range_too_long`; reversed: `slot_range_invalid`; null arguments → 22004), `private.available_slots_at(day, type, now(), private.is_staff())`, ordered by start; equal to `available_slots` day by day. |
| `book_appointment(appointment_id, customer_id, appointment_type_id, starts_at timestamptz, bike_id = null, customer_note = null, internal_note = null)` → `appointments` | S | Built (Phase 2). `private.book_appointment_core(…, 'staff')`, in order: 22004 on nulls; `shop_settings` FOR SHARE; the day lock; replay by id (same customer, type and start → the row, no event; else `appointment_conflict`); P0002 / `appointment_type_unavailable` (inactive); P0002 / `customer_archived`; bike P0002 / `appointment_bike_archived` / `appointment_bike_not_owned`; `appointment_in_past` (ends_at ≤ now); `private.appointment_slot_problem` (misaligned, outside hours, closed, capacity); insert with the snapshots. |
| `mark_appointment_status(appointment_id, status, reason = null)` → `appointments` | S | Built (Phase 2, D39). `shop_settings` FOR SHARE, the row FOR UPDATE (P0002); targets confirmed / arrived / no_show only (`appointment_use_check_in`, `appointment_use_cancel`, `appointment_transition_invalid` for booked/completed); same status → replay; `appointment_transition_invalid`; `appointment_not_started`; no_show → arrived only on its own shop-local date, then the day lock and `appointment_capacity_exceeded`. One event with the optional reason. |
| `cancel_appointment(appointment_id, reason)` → `appointments` | S | Built (Phase 2). `reason_required` / `reason_too_long` first; the row FOR UPDATE (P0002); already cancelled → the row (no event); only booked, confirmed or arrived (`appointment_transition_invalid`); `cancelled_via` = staff. |
| `update_appointment(appointment_id, bike_id = null, clear_bike = false, customer_note = null, internal_note = null)` → `appointments` | S | Built (Phase 2). The row FOR UPDATE (P0002); null keeps, '' clears a note, `clear_bike` removes the bike; bike rules from the trigger (before check-in, the customer's, not archived); the customer's note only while not cancelled/completed/no_show (`appointment_immutable`); unchanged → no update, no event; one `details_changed` event otherwise. |
| `my_appointments(include_past = false)` → `setof my_appointment` | authenticated (C) | Built (Phase 2, D42; consumed by Phase 11). The caller's appointments not yet over, soonest first; `include_past` adds the past ones after them, latest first. Bike fields only while the bike is still theirs and not archived (D12). |
| `book_my_appointment(appointment_id, appointment_type_id, starts_at, bike_id = null, customer_note = null)` → `my_appointment` | C (42501 otherwise) | Built (Phase 2, D37). The booking core with the caller's customer id and source customer: active public types, `appointment_too_soon`, `appointment_too_far_ahead`, `appointment_customer_limit` (per-customer lock), then hours, closures, capacity; a bike that is not theirs (or unknown) → `appointment_bike_not_owned` with nothing about the bike. |
| `cancel_my_appointment(appointment_id, reason = null)` → `my_appointment` | C (42501 otherwise) | Built (Phase 2, D37). `reason_too_long`; `shop_settings` FOR SHARE; the caller's row FOR UPDATE, else NULL (no error); already cancelled → it (no event); booked/confirmed before `customer_cancel_cutoff_minutes` ahead of the start, else `appointment_not_cancellable`; reason defaults to 'Cancelled by the customer'; `cancelled_via` = customer. |
| `check_in_appointment(appointment_id uuid, bike_id uuid, work_order_id uuid, link_existing boolean = false, requested_work text = null, intake_notes text = null, lead_mechanic_id uuid = null)` → `appointment_check_in (appointment_id uuid, appointment_status appointment_status, work_order_id uuid, job_number text, created boolean)` | S | Built (Phase 2, D40). In order: 22004 on null ids; the appointment FOR UPDATE (P0002); checked_in or completed → its existing link with `created` false, whatever `work_order_id` was passed (replay, second device); not booked/confirmed/arrived → `appointment_transition_invalid`; `link_existing`: that job FOR UPDATE (P0002), same customer and bike, open (`private.work_order_status_is_open`) and unlinked, else `appointment_work_order_mismatch`; customer then bike FOR SHARE; bike P0002 / `appointment_bike_archived` / `appointment_bike_not_owned` (shop bikes too); the appointment → bike set, `checked_in` (stamps checked_in_at, arrived_at). New job: `private.create_work_order(actor, work_order_id, customer, bike, coalesce(nullif(btrim(requested_work), ''), customer_note), intake_notes, lead_mechanic_id, '{}', '[]', appointment_id)` (job number, `checked_in` event, D18, lead as for a walk-in; blank work and no note → `requested_work_required`), then `work_order_conflict` unless the returned job carries this appointment (an older job under that id). Existing job: `appointment_id` null → this appointment. Both link events from the triggers (§4). One transaction; `created` = not `link_existing`. |
| `appointment_daily(from_day date = null, to_day date = null)` → `day, booked, expected, arrived, checked_in, no_shows, cancelled` | S | Built (Phase 2, D41). Operational counts, no permission needed (D30). `reporting.appointment_daily` zero-filled one row per day; daily_summary's range rules (null bound = the other, both null = today, ≤ 366 days, else `report_range_invalid`); future days allowed (upcoming appointments). |
| `create_work_order(work_order_id, customer_id, bike_id, requested_work, intake_notes = null, lead_mechanic_id = null, additional_staff_ids uuid[] = '{}', services jsonb = '[]')` → `work_orders` | S | Calls `private.create_work_order(actor, …, appointment_id)`. Replay first: an existing id returns the row as it is now when customer and bike match (no check, assignment or line re-run, no number burned), else `work_order_conflict`. Then FOR SHARE on customer and bike (D18 against a concurrent transfer), insert (trigger: J- number, `work_order_customer_archived`, `work_order_bike_archived`, `bike_owner_mismatch`), lead, ≤ 10 distinct additional staff, ≤ 20 services `{line_id, service_id, quantity}` (malformed 22023) through `private.insert_service_line`. One transaction. `requested_work_required`; 22004 for missing ids. |
| `set_work_order_status(work_order_id, status, note = null)` → `work_orders` | S | Locks the job; same status → row unchanged (no event); `work_order_transition_invalid`; `reason_required` for cancel/reopen; `work_order_has_lines` when cancelling with live lines. Triggers stamp the time and write one event; since `20261014000900` (D149b, D149c) the trigger `work_orders_require_settled_requests` raises `work_order_has_unfitted_requests` for any move into a status that is not open while a request is approved or ordered (after the three checks above), and after such a move `work_orders_withdraw_open_quote` withdraws the job's open quote (`quote_withdrawn`). |
| `update_work_order(work_order_id, requested_work = null, intake_notes = null, internal_notes = null, completion_notes = null)` → `work_orders` | S | Null keeps, '' clears (requested work cannot be cleared: `requested_work_required`); no-op when unchanged; one `details_changed` event. Any status. |
| `add_work_order_note(note_id, work_order_id, kind work_order_note_kind, body)` → `work_order_events` | S | Locks the job; replay by `note_id` first (same job → that event; else `note_conflict`); `note_added` / `diagnosis_added` with `{note_id, body}` (1..5000; `note_required`, `note_too_long`). Any status. |
| `set_approval_flag(work_order_id, flagged, note = null)` → `work_orders` | S | Internal flag (SPEC §7.1); note null keeps the stored one, '' clears it; `work_order_closed`; replay no-op; `approval_flagged` event. |
| `propose_part(request_id, work_order_id, product_id, quantity int = 1, unit_sale_price = null, expected_unit_cost = null, supplier_id = null)` → uuid | S (cost or supplier: view_costs or manage_purchasing, else 42501) | D140: locks the job; replay by `request_id` (another job, kind or product → `part_request_conflict`); open job; `quantity_invalid` (1–999); `product_archived`, `product_inactive`, `indent_product_invalid` (not shop-owned and quantity-tracked, D62), `currency_mismatch`; price defaults to `private.selling_price` (`part_price_missing`); `supplier_unavailable`; event `part_requested`. No movement, no line |
| `propose_service(request_id, work_order_id, service_id, quantity line_quantity = 1, unit_sale_price = null)` → uuid | S | D140: as above for a catalogue service (`service_unavailable`); price defaults to the service's |
| `cancel_part_request(request_id, reason)` → uuid | S; on a collected or cancelled job A or M (D149) | Locks the job; replay: a cancelled request is returned (any job, anyone); on a collected or cancelled job `work_order_closed` unless an active admin or manager (`private.can_record_refunds()`; `20261014000700`), for whom a quoted request first withdraws the job's open quote (event `quote_withdrawn`, its other items → proposed); otherwise `part_request_quoted` (withdraw the quote first); `part_request_fitted`; `reason_required`, `reason_too_long` (a refusal withdraws nothing); an ordered part stays on its purchase order; event `part_request_cancelled` `{request_id, description, reason, was}` (`was` the status before any withdrawal). Never moves the job, so D149b's guard does not apply; on a job that leaves the open statuses the AFTER trigger has already withdrawn any open quote (`20261014000900`) |
| `send_quote(quote_id, work_order_id, request_ids uuid[], channel quote_channel, valid_days int = 7)` → text | S | D141: locks the job; `quote_already_sent` for a known id (the token cannot be shown again); open job; `quote_validity_invalid` (1–30), `quote_items_invalid` (1–50 distinct); withdraws the job's open quote first; `part_request_not_proposed`; returns the 43-character base64url token of 32 random bytes and stores only its SHA-256; items snapshot; requests → quoted; event `quote_sent` |
| `withdraw_quote(quote_id)` → uuid | S | Locks the job; replay: withdrawn returned; `quote_answered`; `work_order_closed` on a collected or cancelled job (`20261014000700`); items → proposed; event `quote_withdrawn`. Since `20261014000900` a quote is also withdrawn by trigger when its job leaves the open statuses (D149c(2)), so an open quote on a job that is not open exists only from before it |
| `quote_by_token(token)` → jsonb | anon, S, C | D143: null for anything that is not a known token; withdrawn or expired → `{status, job_number}` only; otherwise status, job number, bike, the customer's first name, currency, total, sent, expires, answered at and by, the items with their decisions, and (Phase 14 step 2, D151, D158) `deposit`: null, `{percent, amount: null, status: on_answer}` (open), or `{percent, amount, status, parts_ordered, job_closed}` with status `due` (job open), `processing`, `paid` or `refunded` (§5 "Indent deposits"; `job_closed` since `20261014000700`, §5 "Indent parts on completed and closed jobs"). Never costs, notes, staff, contact details or any Stripe id or URL |
| `answer_quote(token, decisions jsonb, name)` → jsonb | anon, S, C | D142: `quote_not_found` (P0002); locks the job, then the quote; `quote_not_open` (answered, withdrawn or the job closed), `quote_expired`, `quote_name_required` (1–100), `quote_answer_incomplete` (exactly one `{item_id, approve boolean}` per item); requests → approved or declined; quote answered (the snapshot trigger fixes `deposit_amount`, Phase 14 step 2); the job's approval flag and note; event `quote_answered`; returns the page's data, its `deposit` key included |
| `order_part_requests(request_ids uuid[], supplier_id, purchase_order_id, move_to_waiting boolean = true, override_reason text = null)` → uuid | manage_purchasing; a part whose deposit is not paid also A or M with a reason | D145: locks the jobs in id order; replay when all are ordered (their purchase order, whatever the jobs' status); `order_items_invalid`; `work_order_locked` unless every job is open (`20261014000700`, R-082); `part_request_not_approved` (approved parts only); the D152 gate (Phase 14 step 2, dropped and created again with `override_reason`): a part whose quote's deposit is not `paid` in `quote_deposits` → `deposit_unpaid` without a non-blank reason, 42501 unless an active admin or manager (`private.can_record_refunds()`), `reason_too_long`; then `supplier_unavailable`; the supplier's newest draft or `create_purchase_order(purchase_order_id, supplier_id)`; each product's line raised through `set_purchase_order_line` (cost: the line's, else the expected cost, else `purchase_cost_defaults`, else 0; a new line notes "For J-…"); requests → ordered and linked; event `part_ordered` (with `deposit_override {reason, quote_ids}` on each job the reason covered); optionally `set_work_order_status(…, 'awaiting_parts')` where allowed |
| `part_request_arrivals(work_order_id)` → table(request_id, arrived, location_id, purchase_order_id, po_number) | S | D146: the job's ordered and fitted requests; arrived when receipts on the line cover it, first requested first covered; location of the line's latest receipt |
| `indent_reservations(product_id)` → table(work_order_id, job_number, quantity) | S | D146: arrived, unfitted quantities by job (reserved, not held) |
| `fit_part_request(request_id, line_id, location_id = null)` → uuid | S | D140, D146: locks the job, then the request; replay by `line_id`; `part_request_fitted`, `part_request_not_approved` (approved, or ordered for a part); open job; a part through `add_inventory_line(line_id, …, quantity, location_id ?? where it arrived, null, quoted price)` (D23, D24), a service through `add_service_line`; request → fitted; event `part_fitted`. D160: `part_request_line_voided` when `line_id` is a voided line (a stale retry after the void; `job_part_requests_require_live_line`) |
| `fit_part_bought_outside(request_id, line_id, unit_cost money_amount, location_id = null, reference = null)` → uuid | view_costs or manage_purchasing (42501, checked first) | D149a (`20261014000900`): 22004; P0002; locks the job, then the request; replay by `line_id` when fitted as bought outside, else `part_request_fitted`; `outside_purchase_part_only`; `part_request_ordered`; `part_request_not_approved`; `work_order_locked`; `outside_purchase_cost_invalid` (0..99,999.99); `outside_purchase_reference_too_long` (100); `part_request_conflict` (the line id is taken); `lock_stock`, then the products row `for no key update` (always, §7 step 7); `product_archived`, `product_inactive`, `indent_product_invalid`, `currency_mismatch`; `location_required`, `location_inactive`; then one `outside_purchase` movement (+quantity, the entered cost, `request_id` = `line_id`, the job), the product's cost (D5, D63 extended; `cost_changed` with the reason), `add_inventory_line` at the same location and the quoted price, request → fitted with `outside_purchase_movement_id`; event `part_fitted` `{…, bought_outside: true, reference}`. Never returns or records a cost outside the movement and the line |
| `assign_staff(work_order_id, staff_id, role assignment_role = 'additional')` → `work_order_assignments` | S (D22) | Locks the job; `work_order_closed`; P0002 / `staff_inactive`; same role → the active row (no event); other role → close and reopen; a new lead closes the previous lead's row. Trigger syncs `lead_mechanic_id`, writes `assignment_changed`. |
| `unassign_staff(work_order_id, staff_id)` → `work_order_assignments` | S | Closes the active row and returns it; null when none (no event). `work_order_closed`. |
| `add_service_line(line_id, work_order_id, service_id, quantity line_quantity = 1, unit_sale_price = null, unit_direct_cost = null, description = null)` → `uuid` | S; a cost needs P(view_costs) (D14) | Locks the job, then `private.insert_service_line`: replay by line id first (same job, type and service → id; else `line_conflict`), then `work_order_locked`, P0002 / `service_unavailable`, snapshots (description, price, cost, `cult_commons_rate_at(now)`), insert. Returns the id only. |
| `add_manual_line(line_id, work_order_id, description, unit_sale_price, quantity line_quantity = 1, unit_direct_cost = null)` → `uuid` | S; a cost needs P(view_costs) (D14) | Same order (replay, `work_order_locked`); cost null → 0 with `cost_pending` (D14). Returns the id only. |
| `void_line(line_id, reason)` → `uuid` | S | `reason_required` / `reason_too_long`; locks the job, then the line; already voided → id (no event); `work_order_locked`. Sets `voided_*`; never deletes. Phase 4 replaced it (same signature, order and wrapper) with the inventory branch below. |
| `work_order_timeline(work_order_id, max_rows = 200)` | S | Events newest first with actor and (assignment events) subject display names; 1..2000 rows (the job page asks one more than it shows, to say older events exist). |
| `create_service(service_id, name, default_sale_price, description = null, category_id = null, default_direct_cost = null, is_active = true, is_public = false)` → `uuid` | P(manage_inventory); a cost needs P(view_costs) | Replay by id with the same name → id; else `service_conflict`; `category_kind_mismatch`; 23505 `services_active_name_key`. |
| `update_service(service_id, name, default_sale_price, description = null, category_id = null, is_active = true, is_public = false, default_direct_cost = null)` → `uuid` | same | Replaces every field; cost null keeps it. P0002. |
| `set_service_archived(service_id, archived)` → `uuid` | P(manage_inventory) | Replay-safe. |
| `schedule_cult_commons_rate(rate_id, rate, effective_from = null)` → `cult_commons_rates` | A | Replay by `rate_id` first (same rate → the row as it is now; else `rate_conflict`). Null = now; earlier than now → `rate_backdated` (D21); 23505 on a taken start time. |
| `cancel_cult_commons_rate(rate_id)` → `cult_commons_rates` | A | Only before it starts (`cult_commons_rate_in_effect`); replay returns the row. |
| `add_inventory_line(line_id, work_order_id, product_id, quantity integer = 1, location_id = null, inventory_unit_id = null, unit_sale_price money_amount = null)` → `inventory_line_result (line_id, movement_id, location_id, on_hand_after, replayed)` | S | Built (Phase 4); replaced in Phase 6 step 1 (`…003400`, same signature, return type, guard and step order) for the owner's D27 change (D44): only a customer-owned product or unit is `ownership_not_saleable`. A consigned unit: its item FOR UPDATE after the unit (lock order 6), `consignment_item_not_active`, cost = agreed + shop charges, payout = agreed, price default = `private.selling_price`. A consigned quantity product: its active items FOR UPDATE in id order, then the FIFO item (`received_at`, `short_id`) whose `remaining_qty` covers the part (`consignment_quantity_unavailable`); on-hand at the location must cover it (`insufficient_stock`, no negative consigned stock); cost = payout = the item's agreed amount; price default = item asking price, else the product default. The line stores `consignment_item_id` and `consignor_payout_snapshot`; the movement goes through `private.record_linked_movement` with the item (shop-owned parts write exactly Phase 4's values); then `refresh_consignment_item_status`. D24: 0 is a known price or cost. Phase 4's description:  22004 on null ids/quantity. Order: `private.lock_work_order` (P0002); `private.lock_stock(product)` and the unit FOR UPDATE (P0002); replay by line id before the open check (same job, inventory, product, unit, quantity → the line, its job_consumption movement and current on-hand, `replayed = true`; else `line_conflict`); `work_order_locked` (D15); `quantity_invalid` (1..999; unique: 1); P0002 / `product_archived` / `product_inactive`; `currency_mismatch`; `ownership_not_saleable` (product or unit not shop_owned, D27). Quantity: `unit_product_mismatch` if a unit is given; default location (lowest active sort_order, name) or `location_required`; `location_inactive`; on-hand may go negative (D23). Unique: `unit_required`, `unit_product_mismatch`, `unit_not_available`, `unit_location_mismatch`. `part_price_missing` / `part_cost_missing` (D24). Inserts the line (snapshots price, cost, rate; `cost_pending` false; description = name, or name · U-… · S/N …), the `job_consumption` movement (−quantity, cost snapshot), unit → held_for_customer and publication refresh, `stock_consumed`. Never returns a cost. |
| `void_line(line_id, reason)` inventory branch | S | Built (Phase 4, create or replace keeping Phase 3's signature, guard, reason rules, error order, effects, lock order and wrapper; `line_type_unsupported` is gone; unchanged by D160, whose trigger on the void puts a fitted indent request on the line back to approved or ordered with `part_request_unfitted`, §5): already voided → id before the open check; `work_order_locked` (reopen first, D25); after `voided_*`: `lock_stock`, the unit's bike FOR UPDATE (if any), the unit FOR UPDATE, `bike_with_customer` when that bike has a customer (D29), one `reversal` of the line's job_consumption (`reversal_of_id`, same product, unit, location and cost snapshot; allowed at a location deactivated since), held unit → available, `refresh_unique_publication` (sold → public, no requirement check), `stock_reversed`. Concurrent voids serialise on the job; the unique `reversal_of_id` is the backstop. |
| `adjust_stock(request_id, product_id, location_id, quantity_delta integer, movement_type, reason, unit_cost money_amount = null)` → `table(movement_id bigint, on_hand integer)` | P(adjust_stock) | Built (Phase 4). `movement_type_not_manual` (only stock_adjustment ±, damaged −), `reason_required` / `reason_too_long`, `quantity_invalid`; a unit cost needs P(view_costs) (42501) and a positive delta (22023). `lock_stock`, then replay by request_id (same product, location, delta, type → that row; else `request_conflict`); P0002; `product_unit_tracked`; `product_archived`; `location_inactive`; `insufficient_stock` if a negative delta leaves the location below zero. Snapshot = unit_cost else the product default. Records actor and time (SPEC §23). |
| `transfer_stock(request_id, product_id, from_location_id, to_location_id, quantity integer, reason = null, inventory_unit_id = null)` → `table(movement_id bigint, location_id uuid, quantity_delta integer)` | P(manage_inventory) | Built (Phase 4; replaced with the same signature in Phase 6 for D54). `transfer_same_location`; `lock_stock` and the unit FOR UPDATE; replay by request_id (both rows; else `request_conflict`); `location_inactive`; `product_archived`. Quantity: `quantity_invalid`, `insufficient_stock`; a consigned product moves one item's stock, the oldest active item with the whole quantity at the source (`consignment_quantity_unavailable` otherwise), and both rows name it. Unique: `unit_required`, quantity 1, `unit_not_available` (available or reserved only), `unit_location_mismatch`; moves `location_id` (unit `moved` event; a consigned unit's rows take its item). Two `transfer` rows sharing request_id. |
| `create_unique_unit(unit_id, product_id, location_id, serial_number = null, condition = null, sale_price = null, direct_cost = null, bike_id = null, reason = null)` → `unique_unit_result (unit_id, short_id)` | P(manage_inventory); a cost needs P(view_costs) | Built (Phase 4). `lock_stock` before the replay (unit id exists with the same product → it; else `unit_conflict`); `product_not_unique`, `product_archived`, `product_inactive`, `location_inactive`; a bike is locked FOR UPDATE and must exist, not be archived (`bike_archived`), have no owner (`bike_has_owner`) and no unit (`bike_already_linked`). `private.register_unit` (shop_owned, D27), then a +1 `stock_adjustment` (reason default "Registered as a unique item", request_id = unit id), then `refresh_unique_publication` (a sold product with a new available unit is public again, D26). |
| `write_off_unit(request_id, unit_id, reason)` → `unit_status_result (unit_id, status)` | P(adjust_stock) | Built (Phase 4). `reason_required`; P0002; `lock_stock`, the unit FOR UPDATE; replay: a damaged movement with this request_id for this unit → current state, the key used for anything else → `request_conflict`; already written off → no-op; available or reserved → written_off plus a `damaged` −1; else `unit_not_available`. |
| `set_publication_status(product_id, status, reason = null)` → `publication_result (product_id, publication_status, public_slug)` | P(manage_inventory) | Built (Phase 4). 22004 on null ids; `reason_too_long` (> 500); `lock_stock(product)`, then the product FOR UPDATE (P0002). A target of `sold`, or leaving `sold` for anything but `archived` → `publication_sold_by_sale`. Same status → the row, no event. Otherwise the products trigger: `publication_transition_invalid`, `publication_requires_price` / `_photo` / `_available_unit`, slug at the first publish, `publication_changed {from, to}` with the reason. Phase 10 hooks the Shopify sync onto publication changes by trigger. |
| `split_unit_from_stock(new_product_id, unit_id, source_product_id, location_id, name, reason, serial_number = null, condition = null, sale_price = null)` → `split_unit_result (product_id, product_short_id, unit_id, unit_short_id)` | P(adjust_stock) and P(manage_inventory) | Built (Phase 4, D28). 22004 on null ids; `reason_required`, `reason_too_long` (> 480: the movements' reason is "Split to U-######: " + reason). `lock_stock(source)`, then replay (unit id on new_product_id → the same result; the unit id or new_product_id used otherwise → `unit_conflict`); P0002; `product_not_quantity`, `product_archived`, `ownership_not_saleable` (D27); P0002 / `location_inactive`; `insufficient_stock` (on-hand at the location < 1). Inserts a draft unique product (name; description, brand, category, currency from the source; price = sale_price else the source's; default cost = the source's), `private.register_unit` (shop_owned, cost = the source's default cost) and two `stock_adjustment` movements (−1 source, +1 unit) with the reason, cost snapshot and request_id = unit id. Writes the carried cost for a caller without P(view_costs) (definer path; the invoker cost-write guards still refuse that caller's direct writes); never returns a cost. 23514 checks re-raised without the row. |
| `daily_summary(from_day date = null, to_day date = null)` → table of the 27 `reporting.daily_summary` columns | S | Built (Phase 5). A null bound takes the other; both null = shop today; `report_range_invalid` when from > to or the range exceeds 366 days. One zero-filled row per day (`generate_series` left join the view), future and pre-history days as zero rows; placeholders passed through. D30: without view_financial_reports `currency`, `lines_recognised`, `gross_sales`, `consignment_sales`, `consignment_sales_total` and every cost column are NULL; with it but without view_costs `cogs`, `yield_total`, `cult_commons_share`, `bicii_yield_after_cc`, `loss_lines`, `loss_total`, `new_consignor_liability` are NULL. By day. |
| `today_dashboard(on_day date = null)` → `day, is_today, generated_at, can_see_financials, can_see_costs`, daily_summary columns 2–27, `received_now, waiting_now, ready_to_start_now, in_progress_now, awaiting_collection_now, open_jobs_now, overdue_now, low_stock_now, exceptions_now, cost_pending_lines` | S | Built (Phase 5). Null = today; a future day → `report_range_invalid`. Reads `public.daily_summary(d, d)` (gating in one place). The `*_now` snapshot (D31; BOARD_GROUPS: received+diagnosing, awaiting_customer+awaiting_parts+paused, ready_to_start, in_progress, completed+ready_for_collection, open, D20 overdue, `reporting.low_stock` rows, `operational_exceptions` rows the caller may see: since Phase 9 step 3 (D108) the count is filtered by `private.exception_visible(kind)`, so it equals the length of `operational_exceptions(200)` for each caller below the cap; re-bodied with `create or replace`, same signature, return type and grants, nothing else changed) only when d is today, else NULL. `cost_pending_lines` = d's shop-currency entries with `cost_pending` (D14), NULL without view_financial_reports. |
| `work_order_activity_on(on_day date = null)` → `work_order_id, job_number, status, customer_id, customer_label, bike_id, bike_title, lead_mechanic_name, checked_in_at, started_at, completed_at, ready_for_collection_at, collected_at, cancelled_at, checked_in_on_day, started_on_day, completed_on_day, ready_on_day, collected_on_day, cancelled_on_day, is_open, is_overdue, age_days, sale_total, currency` | S | Built (Phase 5). Jobs with at least one current stamp on that shop day (null = today), by job number; `customer_label` = `private.customer_label`, `bike_title` = brand model variant (bikeTitle rule), `sale_total` sale only (`work_order_totals`). |
| `stock_adjustments_on(on_day date = null)` → `movement_id, created_at, movement_type, product_id, product_short_id, product_name, inventory_unit_id, unit_short_id, location_name, quantity_delta, reason, actor_name, significant, value_at_cost, currency` | S; value_at_cost P(view_costs) | Built (Phase 5). `stock_adjustment` and `damaged` movements of that shop day (null = today), newest first; `significant` per D33 for every staff member; `value_at_cost` = \|delta\| × coalesce(snapshot, product default, 0), NULL without view_costs (D30). |
| `operational_exceptions(max_rows integer = 50)` → `kind, severity, entity_type, entity_id, entity_label, subject_label, days, quantity, since` | S | Built (Phase 5, D34). Danger first, then oldest `since`; max_rows clamped to 1..200. Phase 9 drops and recreates it with appended columns. Since Phase 10 step 1 the view also carries `integration_failed` rows, for admins only (D86); since Phase 14 step 2 `payment_attention` (admins and managers) and `stripe_attention` (admins only) rows (D159b, §14). |
| `operational_exceptions(max_rows integer = 50)` → `kind, severity, entity_type, entity_id, entity_label, subject_label, days, quantity, since, issue, short_id, title, detail, amount, currency` | S | Built (Phase 5, D34); dropped and recreated by Phase 9 step 3 (`…1300_operational_exceptions`, D106–D108) with the same name, argument, default, ordering and clamp and the six appended columns: Danger first, then oldest `since`, then kind, entity_label, entity_id; max_rows clamped to 1..200; only the kinds `private.exception_visible` allows the caller (D108). `jit = off`. |
| `report_exception_counts()` → `kind, severity, count` | S | Built (Phase 9 step 3, D108). The same visible rows counted per kind and severity, danger first, then kind; their sum is what `operational_exceptions` returns below its cap. `jit = off`. |
| `report_stock_reconciliation(p_only_issues boolean = true, p_product_id uuid = null, p_max_rows integer = 500)` → `product_id, product_short_id, product_name, tracking_type, location_id, location_name, ledger_on_hand, units_in_stock, issue` | S | Built (Phase 9 step 3, D106). `reporting.stock_reconciliation` with names; issues first, then product name, location name; max_rows clamped to 1..1000. Read-only, no cost column, `jit = off`. |
| `report_unit_reconciliation(p_only_issues boolean = true, p_product_id uuid = null, p_max_rows integer = 500)` → `unit_id, unit_short_id, product_id, product_name, status, location_id, location_name, ledger_on_hand, ledger_location_id, ledger_location_name, expected_on_hand, disposition, disposition_ref, issue, issue_detail, last_movement_at` | S | Built (Phase 9 step 3, D106). `reporting.unit_reconciliation` with names; issues first, then product name, location name, unit short ID; max_rows clamped to 1..1000. Read-only, no cost column, `jit = off`. |
| `set_consignment_settlement_alert_days(p_days integer)` → integer | A | Built (Phase 9 step 3, D107). 1..365, else `alert_days_out_of_range` (null too); the current value again changes nothing (no history row) and returns it; a change updates `shop_settings` (its triggers stamp `updated_by`/`updated_at` and append `schedule_events`). |
| `set_indent_deposit_percent(p_percent integer)` → integer | A | Built (Phase 14 step 2, D151, D157). 0..100, else `deposit_percent_out_of_range` (null too); the current value again changes nothing (no history row) and returns it; a change updates `shop_settings` (history in `schedule_events` as `{indent_deposit_percent: {from, to}}`). The Admin refuses a value above 0 while Stripe is off (the database cannot see the environment). |
| `financial_lines(from_day date, to_day date)` → the 32 `reporting.financial_lines` columns in order | P(view_financial_reports) (42501 otherwise) | Built (Phase 5). Null bounds as daily_summary; at most 31 days inclusive (`report_range_invalid`); PostgREST returns ≤ 1000 rows, so callers page with `.range()`. Without view_costs `unit_direct_cost`, `cult_commons_rate`, `cost_total`, `yield_total`, `cult_commons_share`, `bicii_yield_after_cc`, `is_loss` are NULL. By recognized_at, document_number, source_line_id. |
| `work_order_yield(target_work_order_id uuid)` → `work_order_id, job_number, status, currency, line_count, sale_total, cost_total, yield_total, cult_commons_share, bicii_yield_after_cc, loss_line_count, loss_total, cult_commons_rates numeric[], recognized_at, recognized_day, cost_pending_count` | P(view_costs) (42501 otherwise) | Built (Phase 5). The job's live lines whether or not it is completed (running economics; equals `work_order_totals_staff`); rates = distinct snapshot rates ascending; recognized_at = `completed_at` (NULL while open, cancelled or reopened, D32). Unknown job P0002. |
| `report_period_summary(p_from date, p_to date, p_basis report_date_basis = 'sale')` → `basis, from_date, to_date, currency, line_count, job_count, sale_count, loss_line_count*, sale_total, cost_total*, yield_total*, cult_commons_share*, yield_after_cc*, cost_pending_lines, refunds_total, refund_count, consignment_sales, consignment_sales_total, new_consignor_liability*, settlements_paid_total*, purchases_received_total*, excluded_foreign_line_count` (one row) | P(view_financial_reports); * also P(view_costs), NULL otherwise | Built (Phase 9 step 1, D100–D105). Guard first, then `report_range_invalid` (NULL bound, from > to) / `report_range_too_long` (> 731 days); NULL basis = sale. Totals over `private.report_rows` in the shop currency (D104); Cult Commons = Σ line shares (D1); `yield_after_cc` = Σ yield − Σ share. job_count / sale_count = distinct documents. Sale basis only (NULL otherwise): `refunds_total` / `refund_count` (D102, `sale_refunds.created_at`, never netted), `consignment_sales` / `consignment_sales_total` / `new_consignor_liability` (daily_summary's definitions), `settlements_paid_total` (not reversed), `purchases_received_total` (D105). Zeros (0.00) when empty. |
| `report_period_series(p_from, p_to, p_basis = 'sale', p_grain report_grain = 'day')` → `bucket_start, bucket_end, partial, line_count, job_count, sale_count, sale_total, cost_total*, yield_total*, cult_commons_share*, yield_after_cc*, loss_line_count*, refunds_total, consignment_sales, consignment_sales_total, new_consignor_liability*, settlements_paid_total*` | as above | Built (Phase 9 step 1). One row per day, ISO week or month overlapping the range (`generate_series`, zeros when empty), clipped to the range with `partial` = clipped; the summary's definitions per bucket; refunds, consignment and settlements on the sale basis only. ≤ 731 rows (under PostgREST max-rows). Same range errors. |
| `report_breakdown(p_from, p_to, p_basis = 'sale', p_dimension report_dimension = 'job', p_max_rows = 200, p_key text = null, p_after_sale_total numeric = null, p_after_key text = null)` → `key, entity_type, entity_id, label, detail, line_count, job_count, sale_count, quantity, sale_total, cost_total*, yield_total*, cult_commons_share*, yield_after_cc*, first_at, last_at` | as above | Built (Phase 9 step 1). Groups by `private.report_key` (§14); every line in exactly one group. Order and keyset `sale_total desc, key asc` (collation C): the cursor returns groups with sale_total < v, or = v and key > k; `p_key` returns that one group (drill-down header). `p_max_rows` clamped 1..500 (callers ask for one more than they show). `report_key_invalid`: half a cursor, a cursor with `p_key`, or a key that is neither a uuid nor a pseudo key of the dimension (ownership and channel keys are pseudo keys only). Labels by name (archived and inactive included, SPEC §23); `quantity` only for the product dimension. |
| `report_line_items(p_from, p_to, p_basis = 'sale', p_dimension = null, p_key = null, p_max_rows = 100, p_after_at timestamptz = null, p_after_id uuid = null)` → `source_line_id, source, channel, basis_at, document_id, document_number, line_type, description, quantity, unit_sale_price, sale_total, cost_total*, yield_total*, cult_commons_share*, cost_pending, ownership_type, category_name, mechanic_name, currency` | as above | Built (Phase 9 step 1). Keyset `basis_at desc, source_line_id desc` (the cursor is the last row's pair, applied inside `private.report_rows`); `p_max_rows` clamped 1..1000. `report_key_invalid` when exactly one of dimension/key is given, the key does not fit the dimension, or only half a cursor. A 0.00 price or cost comes back as 0.00 (D24 as amended). Never a voided line. |
| `report_activity(p_from, p_to)` → `jobs_checked_in, jobs_started, jobs_completed, jobs_ready_for_collection, jobs_collected, jobs_cancelled, jobs_open_at_end, median_hours_to_complete, median_hours_to_collect, appointments_scheduled, appointments_arrived, appointments_no_show, appointments_cancelled, parts_consumed_qty, parts_consumed_lines, parts_returned_qty, stock_adjustments, significant_stock_adjustments, purchase_receipts, purchase_units_received` | S | Built (Phase 9 step 1). No money. Job flows by each job's own current stamps in range (D31); open at end = checked in before the range end and neither completed nor cancelled before it; medians in hours, 1 decimal (`percentile_cont(0.5)` of the intervals of jobs completed / collected in range); appointments Σ `reporting.appointment_daily` (D41); parts and adjustments with daily_summary's definitions (D33); receipts and units by `received_at` (D105). Same range errors. |
| `report_activity_by_mechanic(p_from, p_to)` → `staff_id, display_name, active, jobs_checked_in, jobs_completed, jobs_collected, jobs_open_now` | S | Built (Phase 9 step 1, D103). Per current lead mechanic, plus `staff_id` NULL 'Unassigned'; inactive staff by name; all-zero rows omitted; `jobs_completed desc`, then name. |
| `report_stock_value()` → `ownership_type, quantity_on_hand, units_in_stock, uncosted_items, value_at_cost*, currency` (3 rows: shop_owned, consignment, customer_owned) | P(view_financial_reports); * also P(view_costs) | Built (Phase 9 step 1, D105, `…1100_report_stock_value`). NOW, not a period. Valuation in §14; `value_at_cost` NULL for consigned and customer-owned rows for everyone. |
| `record_retail_sale(sale_id uuid, lines jsonb, customer_id uuid = null, recognized_at timestamptz = null, notes text = null)` → `sale_result (sale_id, sale_number, status, recognized_at, replayed)` | S (D48) | Built (Phase 6 step 2). Deviates from the original row `record_retail_sale(lines[], customer_id, recognized_at, idempotency_key)`: the client's `sale_id` is the idempotency key. (1) Shape: null `sale_id` 22004; `lines` a JSON array of 1–50 (`sale_lines_required`, `sale_too_many_lines`); a unit twice `sale_duplicate_unit`; unknown customer P0002; `recognized_at` > now() + 5 min `sale_recognized_in_future` (past allowed, down to the stock's arrival: `private.sell_line`'s `sale_before_stock`, D55); a line with a `shopify_line_item_id` key `sale_line_invalid` (only Phase 10 writes one); the request fingerprint (`private.sale_request_fingerprint`: lines in order as {unit, product, location, quantity, price as money_amount text, item, shopify}, customer, recognized_at as given in UTC, trimmed notes; 22P02 / 23514 from its casts). (2) Header insert `on conflict (id) do nothing` (lock order 0; `recognized_at = coalesce(arg, now())`, shop currency): a replay with the same fingerprint returns the sale with `replayed` true (after the customer was archived or the unit sold by it, too), another payload `sale_conflict`. (3) `customer_archived`. (4) Locks: stock of every product (ascending), units, items. (5) `private.sell_line(sale, i, line, 'retail_sale')` per line in order. (6) `refresh_unique_publication` per unique product sold. Never returns a cost. |
| `private.sell_line(p_sale sales, p_line_number integer, p_line jsonb, p_movement_type movement_type)` → `sale_lines` | no grants | Built (Phase 6 step 2): THE single sale-line writer; Phase 10 calls it with `'online_sale'` and may replace it with the same signature to read more keys. The caller holds every lock. `p_line` is `{inventory_unit_id, unit_sale_price?, shopify_line_item_id?}` or `{product_id, location_id, quantity, consignment_item_id?, unit_sale_price?, shopify_line_item_id?}`; anything else `sale_line_invalid`. Unit: P0002; `unit_already_sold` (sold), `unit_not_available` (any other status or archived), `ownership_not_saleable` (customer-owned), `currency_mismatch`; consigned: `consignment_item_not_active`, cost = agreed + live shop charges, payout = agreed. Quantity: P0002, `product_archived`, `product_inactive`, `sale_product_is_unique`, `ownership_not_saleable`, `currency_mismatch`, `sale_quantity_invalid` (integer 1..999), `location_id` 22004, location P0002 / `location_inactive`, `insufficient_stock` (never below zero); consigned: the named item (P0002, `sale_line_invalid` for another product's, `consignment_item_not_active`, `consignment_quantity_unavailable` when its stock at that location is short) or the FIFO head with the quantity at that location (D54; `consignment_quantity_unavailable`), price `coalesce(arg, item asking, product default)`, cost = payout = agreed; shop: price `coalesce(arg, selling_price)`, cost the product default. D55: the sale's `recognized_at` before a consigned item's `received_at` or a unit's latest restock is `sale_before_stock`. NULL price `sale_price_required`, NULL cost `sale_cost_missing` (0 is valid, D24). Rate at `recognized_at`. Writes the line, one movement through `private.record_linked_movement` (−qty, the sale line, the item, cost snapshot), a unit → `sold` at `recognized_at` with `sold_sale_line_id`, and the item's status. Phase 10 step 1 replaced it (`…4000_shopify_order_processing`) with the same signature and body except: `shopify_line_part` joins both key allow-lists and is written to `sale_lines.shopify_line_part` (D80); no other change. |
| `restock_unit(unit_id uuid, sale_line_id uuid, location_id uuid = null, reason text = null)` → `unit_status_result` | P(adjust_stock); a consigned unit also P(manage_consignments) (D46) | Built (Phase 6 step 2). Deviates from the original row `restock_unit(unit_id, location_id, reason)`: it names the sale line, which is also the replay key. Null ids 22004; `reason_required` / `reason_too_long`. Locks: a consigned unit's consignor FOR SHARE (0b), `lock_stock` (the unit's product, read unlocked), its bike, the unit, its item. Line P0002; another unit's line `restock_line_mismatch`; an already restocked line returns the unit's status with no write (even if it was sold again since); the consigned-unit permission (42501); an archived consignor `consignor_archived` (D47); status ≠ sold `unit_not_sold`; `sold_sale_line_id` ≠ the line `restock_line_mismatch` (a unit sold through a job is never restocked, D44); a customer-owned bike `bike_with_customer` (D29); location P0002 / `location_inactive`. With the reason: the line `restocked_at/by`; a `return` +1 movement linked to the line (and item), cost = the line's cost snapshot; the unit `available` at that location with `sold_sale_line_id` null; the item's status (sold → active, event with the reason); `refresh_unique_publication` (sold → public). The sale and refunds are untouched (D7). |
| `record_sale_refund(refund_id uuid, sale_id uuid, amount money_amount, reason text)` → `sale_refunds` | A or M (D94 amends D49: `private.can_record_refunds()`, a role check; 42501 otherwise, whatever permissions or exceptions the caller holds) | Built (Phase 6 step 2; guard replaced in `20261006000200_staff_role_permissions`, body unchanged). 22004 on nulls; replay by refund id (same sale, amount and trimmed reason → the row, else `sale_refund_conflict`); `reason_required` / `reason_too_long`; the sale FOR UPDATE (P0002); `sale_voided`; amount > sale total − earlier refunds `refund_exceeds_sale`; `restocked` false; status `refunded` when refunds reach the total, else `partially_refunded`. No movement, no unit change (D7). |
| `create_consignment_item(item_id, consignor_id, location_id, agreed_amount_owed, asking_price = null, product_id = null, product_name = null, brand = null, description = null, category_id = null, tracking_type = 'unique', quantity integer = 1, serial_number = null, condition = null, received_at = null, agreement_notes = null, internal_notes = null, new_product_id = null, new_unit_id = null, bike_id = null, new_consignor jsonb = null)` → `consignment_item_result (item_id, short_id, status, product_id, inventory_unit_id)` | P(manage_consignments) | Built (Phase 6 step 1; `new_consignor` from the Phase 6 review). `new_consignor` `{display_name, phone?, email?, customer_id?}` (other keys 22023) creates the consignor `consignor_id` inside the intake's transaction, so a refused intake leaves none and a retry stores edited details; its normalised fields join the fingerprint; an existing consignor with that id and other details is `consignor_conflict`; the consignors table's checks and `consignors_customer_id_key` apply. (a) 22004 on null ids or agreed amount; `consignment_quantity_invalid`, `consignment_unique_quantity_one`, `consignment_received_in_future` (> 5 minutes ahead), `consignment_bike_requires_unique`. (b) The request's advisory lock, then replay by item id with a fingerprint of consignor, location, product, lower(trimmed name), tracking, quantity, agreed and asking (as text: "500" = "500.00") and bike: a match returns the item as it is now (even after the consignor was archived), else `consignment_item_conflict`. (c) The consignor FOR SHARE (P0002, `consignor_archived`); location P0002 / `location_inactive`; an existing product must be active, not archived, consignment-owned (`product_not_consignment`) and of that tracking (`consignment_tracking_mismatch`); none needs a name (`consignment_product_required`). (d) `lock_stock(product)`; a new draft consignment-owned product (price = asking, no default cost, shop currency); a bike FOR UPDATE with Phase 4's rules (D51); a unique item's unit through `private.register_unit` (consignment, sale price = asking, cost = agreed, the bike, the item); the item; one `consignment_received` movement (+quantity, cost snapshot = agreed, request_id = item id, the item); `refresh_unique_publication` for an existing unique product. |
| `update_consignment_terms(item_id, agreed_amount_owed = null, asking_price = null, reason = null)` → `consignment_item_result` | P(manage_consignments) | Built. `reason_too_long`; `private.lock_consignment_item` (stock, unit, item); null keeps a value, identical values are a no-op; `consignment_item_not_active`; a new agreed amount needs a reason (`reason_required`); a unique item's unit follows (cost = agreed, sale price = asking); lines already on a job keep their snapshots; one `terms_changed` event. |
| `add_consignment_charge(charge_id, item_id, description, amount, bearer charge_bearer, work_order_id = null)` → `consignment_item_charges` | P(manage_consignments) | Built (D4, D45). 22004 on nulls; `charge_bearer_required`; locks as above; replay by charge id (same item, trimmed description, amount, bearer, job → the row; else `consignment_charge_conflict`); unknown job P0002; `shop`: `consignment_item_not_active`, `shop_charge_unique_only`, `shop_charge_unit_not_available`; `consignor`: any status. 23514 by name (amount > 0, description ≤ 200). |
| `void_consignment_charge(charge_id, reason)` → `consignment_item_charges` | P(manage_consignments) | Built. `reason_required` / `reason_too_long`; P0002; locks as above, then the charge; already voided → the row unchanged; a shop charge only while the item is active and its unit available (same codes). |
| `return_consignment_item(return_id, item_id, reason, quantity integer = null, location_id = null)` → `consignment_item_result` | P(manage_consignments) | Built (D50, D51); DATA-MODEL's original row was `return_consignment_item(item_id, reason)`: `return_id` is the client's per-call key, stored as the movement's `request_id` (movement ids are an identity column). 22004 on null ids; `reason_required` / `reason_too_long`; locks (stock, unit, item); replay: a movement with that request_id that is this item's `consignment_returned` (and matches quantity / location when given) → the item unchanged; any other → `consignment_return_conflict`; `consignment_item_not_active`. Unique: the unit must be available (`unit_not_available`; void it from its job first), `unit_location_mismatch`; −1 `consignment_returned`, unit → `returned_to_consignor` (the bike link stays, D51), then (lock order 7) a unique product with no unit left in stock and publication draft, internal_only or public → `archived`. Quantity: `location_id` required (22004); qty = given (1..remaining, `consignment_return_quantity_invalid`) or all of this item's stock there; the item's own stock there ≥ qty (D54; `insufficient_stock`, never another consignor's); −qty. Then the item status (returned when nothing is left or owed). |
| `record_settlement(settlement_id uuid, consignor_id uuid, amount money_amount, allocations jsonb, paid_at timestamptz = null, reference text = null, notes text = null)` → `settlement_result (settlement_id, consignor_id, amount, paid_at, replayed)` | P(manage_consignments) (D47) | Built (Phase 6 step 2). (1) 22004 on null ids or amount; unknown consignor P0002; `settlement_paid_in_future` (> 5 min ahead); allocations a non-empty array of `{consignment_item_id, amount > 0, override_reason?}` (`settlement_allocations_required`); `settlement_duplicate_item`; unknown item P0002; `settlement_item_wrong_consignor`; Σ ≠ amount `settlement_allocation_mismatch`; the fingerprint (amount and allocation amounts as money_amount text, allocations sorted by item, paid_at as given, trimmed reference, notes and override reasons). (2) Header insert `on conflict (id) do nothing` (`paid_at = coalesce(arg, now())`): a matching replay returns it with `replayed` true even after the outstanding changed, else `settlement_conflict`. (3) Consignor FOR SHARE (`consignor_archived`); items FOR UPDATE ascending. (4) Per allocation the item's outstanding from `reporting.consignor_item_ledger`: above `max(outstanding, 0)` without an override reason `settlement_exceeds_outstanding` (detail: short ID and outstanding). |
| `reverse_settlement(reversal_id uuid, settlement_id uuid, reason text)` → `consignment_settlement_reversals` | P(manage_consignments) (D47) | Built (Phase 6 step 2). 22004; `reason_required` / `reason_too_long`; replay by reversal id (same settlement → the row, else `settlement_reversal_conflict`); the settlement FOR UPDATE (P0002), then the consignor FOR SHARE; reversed under another id `settlement_already_reversed`; `consignor_archived`. The settlement and its lines stay; the ledger stops counting them. |
| `list_consignors(q = null, include_archived = false, max_rows = 50)` → `id, display_name, customer_id, customer_label, email, phone, archived_at, active_items, sold_items, awaiting_settlement_items, returned_items, owed, paid, outstanding, last_sale_at, last_settlement_at` | S | Built (Phase 6 step 2; `sold_items` and the gate on `awaiting_settlement_items` from the review). From `reporting.consignor_ledger`; `q`: every word of name or email, or phone digits with or without +65; `include_archived` true lists archived consignors only; by name then id; clamp 1..200. `awaiting_settlement_items` (items with outstanding > 0), owed, paid, outstanding NULL without consignment money access (D48); `sold_items` (status sold) for everyone. |
| `consignor_statement(target_consignor_id = null, target_item_id = null)` → `item_id, short_id, consignor_id, consignor_name, status, quantity, sold_qty, restocked_qty, job_held_qty, job_sold_qty, returned_qty, remaining_qty, received_at, sold_at, returned_at, return_reason, asking_price, last_sale_at, last_settlement_at, product_id, product_short_id, product_name, inventory_unit_id, unit_short_id, unit_status, bike_id, bike_short_id, agreed_amount_owed, liability, consignor_charges, shop_charges, owed, paid, outstanding` | S | Built (Phase 6 step 2). The arguments are `target_*` because PL/pgSQL refuses an argument named like a result column (the brief's `consignor_id` / `item_id`). Exactly one argument (22023); active first, then `last_sale_at` desc nulls last, then `received_at` desc. The last seven columns NULL without consignment money access (D48). |
| `consignor_payout_details(consignor_id)` → text | P(manage_consignments) | Built (Phase 6 step 2). P0002 for an unknown consignor. |
| `list_sales(from_at = null, to_at = null, q = null, max_rows = 50)` → `id, sale_number, source, status, recognized_at, customer_id, customer_label, line_count, first_description, has_consignment, restocked_lines, sale_total, refunded_total, cost_total, yield_total, cult_commons_share` | S | Built (Phase 6 step 2). `[from_at, to_at)`; `q`: sale number ignoring case and dash (exact or contained), customer name words, or line description words; voided excluded; newest first then id; clamp 1..200. The last three NULL without view_costs (D48). |
| `sale_lines_detail(sale_id)` → `id, line_number, description_snapshot, quantity, unit_sale_price_snapshot, sale_total, restocked_at, restocked_by_name, product_id, product_short_id, inventory_unit_id, unit_short_id, unit_status, unit_sold_sale_line_id, unit_ownership_type, bike_id, bike_short_id, consignment_item_id, consignment_short_id, consignor_id, consignor_name, unit_direct_cost_snapshot, cost_total, yield_total, cult_commons_rate_snapshot, cult_commons_share, consignor_payout_snapshot` | S | Built (Phase 6 step 2). Line order; an unknown sale returns no rows. Cost, yield, rate and Cult Commons NULL without view_costs; the payout NULL without consignment money access (D48). |
| `saleable_stock(q, max_results = 20)` → `kind, product_id, product_short_id, inventory_unit_id, unit_short_id, title, subtitle, location_id, location_name, on_hand, unit_price, ownership_type, consignment_item_id, consignment_short_id, consignor_name, rank` | S | Built (Phase 6 step 2). `unit`: available shop-owned and consigned units (item active), `unit_price = private.selling_price(product, unit)`; `product`: shop-owned active quantity products per location with on-hand > 0 (`selling_price(product)`), and consigned quantity products per active item with remaining > 0 and each location where that item has stock (D54), `on_hand = least(item on-hand there, location on-hand, remaining)`, `unit_price = coalesce(item asking, product default)`. Rank: exact U-/P-/C- ID, SKU or serial 1.0; ID containing the key (≥ 3) 0.6; every word in name/brand/consignor 0.45 + 0.4 × word similarity. Blank q nothing; clamp 1..50. No cost. |
| `label_preview(kind label_kind, entity_id uuid)` → `jsonb` | S | Built (Phase 8 step 1). Stable; `private.require_staff()`, then `private.label_content(kind, entity_id)` (§12): 22004 on nulls, P0002 unknown record, `label_entity_archived`, `label_unique_product_needs_unit`, `public_site_url_invalid`. Writes nothing. |
| `create_print_job(job_id uuid, kind label_kind, entity_id uuid, quantity integer, printer_profile_id uuid = null, label_template_id uuid = null, reprint_of_id uuid = null)` → `print_jobs` | S | Built (Phase 8 step 1, D56–D59). 22004 when job_id, kind, entity_id or quantity is null. Replay first: an existing `job_id` with the same kind, record and quantity, and the same printer / template / reprint for each one the caller passes non-null, returns the job; anything else `print_job_conflict`. Quantity 1..500 for a product, 1..10 for a unit or bike (`label_quantity_out_of_range`, D56). Content from `private.label_content` (its codes above). Printer: the one named, else the default, FOR SHARE (P0002; `printer_profile_inactive`); template: the one named, else the kind's default, FOR SHARE (`label_template_missing`, `label_template_inactive`, `label_template_kind_mismatch`); a default moved by a concurrent `set_default_*` is re-read in a new statement. `reprint_of_id` must exist (P0002) and be for the same kind and record (`print_job_reprint_mismatch`). Inserts status `queued` with the snapshots, `requested_by` = caller, `correlation_id` = `private.current_correlation_id()`, `on conflict (id) do nothing`; when a concurrent call with the same id committed first, re-reads the row in a new statement and applies the replay comparison (tested with forced overlap). |
| `set_print_job_status(job_id uuid, status print_status, error text = null)` → `print_jobs` | S | Built (Phase 8 step 1, D59). 22004; the job FOR UPDATE (P0002); the current status again → the row unchanged (a failed job keeps its first error); `queued` or a move the machine refuses → `print_job_transition_invalid`; `failed` needs a non-blank error (`print_job_error_required`; over 500 characters `reason_too_long`), other statuses ignore it. rendered: `rendered_at` = now; printed: `rendered_at` = coalesce(rendered_at, now), `completed_at` = now; failed: `completed_at` = now, `error` trimmed; `status_changed_by` = caller. Printed and failed at once: one wins, the other is refused (tested). |
| `set_default_label_template(template_id uuid)` → `label_templates` | A | Built (Phase 8 step 1). 22004; P0002; every template of the target's kind FOR UPDATE in id order, then the target re-read; `label_template_inactive`; already default → the row; else clears `is_default` on the others of that kind first, then sets it on the target (the partial unique index is not deferrable). Two admins at once: one default, the second call's target (tested). |
| `set_default_printer_profile(profile_id uuid)` → `printer_profiles` | A | Built (Phase 8 step 1). The same pattern over every profile (`printer_profile_inactive`). |
| `create_purchase_order(id, supplier_id, expected_at = null, supplier_reference = null, notes = null)` → `purchase_orders` | P(manage_purchasing) | Built (Phase 7). 22004 for null ids; replay by id first, FOR UPDATE (same supplier → the row unchanged, no event; another → `purchase_order_conflict`); P0002 / `supplier_archived`; insert in the shop currency (D62) catching a `purchase_orders_pkey` race. Never ON CONFLICT (the number trigger would burn a PO number per replay). |
| `update_purchase_order(purchase_order_id, supplier_id, expected_at, supplier_reference, notes)` → `purchase_orders` | P(manage_purchasing) | Sets all four exactly (null clears); locks the PO; `purchase_order_closed`; `purchase_order_supplier_locked` outside draft; identical → no update, no event. |
| `submit_purchase_order(purchase_order_id)` → `purchase_orders` | P(manage_purchasing) | Already submitted or further → unchanged; cancelled → `purchase_order_closed`; `purchase_order_needs_lines`; `supplier_archived`; else submitted_at/by. |
| `cancel_purchase_order(purchase_order_id, reason)` → `purchase_orders` | P(manage_purchasing) | D61. `reason_required` / `reason_too_long`; cancelled → unchanged; received → `purchase_order_closed`; receipts, movements and stock stay. |
| `set_purchase_order_line(id, purchase_order_id, product_id, quantity_ordered, unit_cost, expected_at = null, notes = null, reason = null)` → `purchase_order_lines` | P(manage_purchasing) | Upsert by id under the PO lock. Closed → `purchase_order_closed` (D65); existing: `purchase_line_conflict`, `purchase_line_below_received`, identical → unchanged; new: P0002, `purchase_line_unique_product`, `purchase_line_not_shop_owned`, `purchase_line_product_inactive`, `purchase_currency_mismatch`, `purchase_line_duplicate_product` (D62). 0 is a valid cost. Refreshes the status (a cut to the received total completes the PO). |
| `remove_purchase_order_line(line_id, reason = null)` → setof `purchase_order_lines` | P(manage_purchasing) | Unknown → no row. Locks the PO; `purchase_order_closed`; `purchase_line_has_receipts`; after submission `reason_required` and never the last line (`purchase_order_needs_lines`). Refreshes the status. |
| `receive_purchase(purchase_order_id, idempotency_key, lines jsonb, reference = null, received_at = null, notes = null)` → `purchase_receipts` | P(manage_purchasing) | Built (Phase 7); the 14 steps in §10 (replay, over-receipt, D64 dating, lock_stock, one movement per receipt line, D63 last cost, `received` event, status). |
| `purchase_receipt_by_key(idempotency_key)` → setof `purchase_receipts` | P(manage_purchasing) | Zero or one row, after a lost response. |
| `purchase_cost_defaults(supplier_id, product_ids uuid[])` → `table(product_id, unit_cost, source)` | P(manage_purchasing) | ≤ 200 ids (22023); only products a PO can hold (quantity-tracked, shop-owned, active, not archived; any other id is omitted like an unknown one, so it never reveals a unique or consigned product's cost, D60); per such product the supplier's last cost (`supplier_last`), else the product's (`product`, 0 included), else 0 (`none`). The PO line sheet's prefill (D60, D66). |
| `set_supplier_product(supplier_id, product_id, supplier_sku = null, lead_days = null, preferred = false)` → `supplier_products` | P(manage_purchasing) | Locks the product row, then upserts the link (never the last cost; a new link takes the product's currency); `preferred` clears the product's other preferred row. P0002 / `purchase_line_not_shop_owned` (a consigned or customer-owned product, D62) / `supplier_archived`. |
| `remove_supplier_product(supplier_id, product_id)` → setof `supplier_products` | P(manage_purchasing) | Deletes the link; no row on a replay. |
| `reorder_suggestions(supplier_id = null)` → `table(product_id, short_id, sku, name, on_hand, reorder_point, on_order, suggested_quantity, supplier_linked, preferred_supplier_id, supplier_sku, draft_po_numbers text[])` | S | Built (Phase 7, D66 D-REORDER; `20261005000500_purchasing_reorder.sql`). The shop-owned `reporting.low_stock` products (a consigned product below its reorder point is never listed, D62); `on_order` from `reporting.product_on_order` (submitted and partially received POs, never drafts); `suggested_quantity` = max(2 × reorder_point − on_hand − on_order, 0); `supplier_linked` / `supplier_sku` relative to the given supplier (false / null without one); `preferred_supplier_id` whatever was asked; `draft_po_numbers` the draft POs (any supplier) already holding the product, ascending, `{}` when none. Ordered by supplier_linked desc, suggested_quantity desc, name. No cost column (D60). |
| `create_purchase_order_from_low_stock(id, supplier_id, product_ids uuid[])` → `purchase_orders` | P(manage_purchasing) | Built (Phase 7, D66). 22004 for a null id/supplier or a null element; null or empty selection → `reorder_nothing_selected`; more than 100 ids → 22023. Replay by id with `create_purchase_order`'s mechanism (FOR UPDATE first, insert only when absent, `purchase_orders_pkey` unique_violation fallback, never ON CONFLICT): the same supplier returns the PO unchanged with no line added and the PO sequence untouched; another supplier → `purchase_order_conflict`. Else `supplier_archived` / P0002, a draft in `private.shop_currency()`, then one line per DISTINCT product in ascending id with `set_purchase_order_line`'s checks (P0002, `purchase_line_unique_product`, `purchase_line_not_shop_owned`, `purchase_line_product_inactive`, `purchase_currency_mismatch`, `purchase_line_duplicate_product`): quantity max(suggestion computed now, 1), capped at the line limit 100000; unit cost `private.default_purchase_unit_cost` (supplier last cost, else product cost incl. 0, else 0). `line_added` events come from the trigger, without a reason. Locks only the new PO row; products and stock are read unlocked. |
| `record_shopify_webhook(topic, webhook_id, shopify_event_id, shop_domain, api_version, triggered_at, headers jsonb, payload jsonb, body_sha256, body_bytes, hmac_valid, rejection_reason, correlation_id)` → `event_id, duplicate, event_status, job_id` | service role only | Built (Phase 10 step 1, D88, D89). 22004 / 22023 on shape; headers capped (16 lower-cased keys, ≤ 512 characters, `x-bicii-truncated`); rejected → one row per (reason, body sha) with no payload and no job; verified → dedupe on the webhook id (a repeat counts the delivery, no new job); a new event is skipped (`topic_not_handled`, `test_order`, `pos_order`) or gets a queued `shopify_event` job (`job_id`). |
| `claim_integration_jobs(max_jobs integer, only_job_id uuid = null)` → setof `integration_retry_queue` | service role only | Built (Phase 10 step 1, D87). Dismisses a running product sync stalled 10 minutes when its product has a queued one; claims up to clamp(max_jobs, 1, 50) jobs: queued and due (or the one named, even before it is due) or running and stalled 10 minutes, oldest due first, `FOR UPDATE SKIP LOCKED`, one product sync per product and never beside a fresh running one; each → running, `locked_at` now, attempts + 1. |
| `process_shopify_order_paid(event_id)` / `process_shopify_refund(event_id)` / `process_shopify_event(event_id)` → `event_status, outcome, sale_id, error_code, error_message` | service role only | Built (Phase 10 step 1, D80–D82, D85, D87, D89): §13's algorithm; `process_shopify_event` dispatches by topic (others → skipped `topic_not_handled`). P0002 unknown event; 22023 wrong topic. Business failures never raise: they return `failed` with the code and the human message and leave the job `needs_attention` (or queued with backoff when transient). |
| `retry_integration_job(job_id)` → `integration_retry_queue` | A; P(manage_inventory) for product-sync jobs only (42501 otherwise) | Built (Phase 10 step 1, D86, D87). The job FOR UPDATE (P0002); done/dismissed → `integration_job_closed`; running → unchanged; else queued now with `max_attempts` ≥ attempts + 3, `last_retried_by/at`; audit `job_retried`. |
| `dismiss_integration_job(job_id, reason)` → `integration_retry_queue` | A | Built (Phase 10 step 1, D86, D87). `reason_required` / `reason_too_long` (`private.require_reason`); running → `integration_job_running`; done/dismissed → `integration_job_closed`; dismissed with the reason; a `shopify_event` job's event → skipped / `dismissed` (keeps its last error); an `orders/paid` event of an order with no sale is final for the order (D87): every `orders/paid` event of the order is locked in id order, its other open deliveries' queued or needs_attention jobs are dismissed ('Another delivery of this order was dismissed: ' ‖ reason; their events skipped / `dismissed`), and the order's waiting refund jobs close ('The order was dismissed: ' ‖ reason; their events skipped / `order_not_recorded`); a later delivery of the order is `earlier_delivery_skipped`. audit `job_dismissed` {closed_refund_job_ids, closed_order_job_ids}. |
| `link_shopify_variant(product_id, shopify_product_id, shopify_variant_id, reason)` → `shopify_product_sync` | A | Built (Phase 10 step 1, D84). Numeric ids or gids (`shopify_gid_invalid`); reason required; the product FOR UPDATE; another variant already on it, or a Shopify product BICII created for another product → `shopify_ids_conflict`; a variant on another product → 23505 `products_shopify_variant_id_key`; sets the two product columns with the reason (P4's history records `details_changed`); upserts the sync row as `external` (unless `bicii`), no handle, Publish online untouched; same ids → no-op; audit `variant_linked` {from, to}. |
| `link_shopify_customer(customer_id, shopify_customer_id, reason)` → `shopify_customer_link_result (customer_id, shopify_customer_id, earlier_online_sales)` | A | Built (Phase 10 step 1, D86). A composite result (a `returns table` would clash with the argument names). Reason required; the customer FOR UPDATE; a different id already linked → `shopify_customer_already_linked`; an id on another customer → 23505 `customers_shopify_customer_id_key`; never by email; recorded sales are never edited (`earlier_online_sales` counts the online sales of that Shopify customer still without a customer); same id → no-op; audit `customer_linked`. |
| `private.integration_exceptions()` → P5's nine exception columns | no API role | Built (Phase 10 step 1, D86): §14. |
| `record_stripe_event(payload jsonb, headers jsonb, body_sha256 text, body_bytes integer, rejection_reason stripe_rejection_reason, correlation_id text)` → `event_id, duplicate, event_status, outcome, payment_id` | service role only | Built (Phase 14 step 1, D153, D159; §19). 22004 without the SHA or size; 22023 on a bad SHA, a negative size or non-object headers; headers capped as Shopify's. Rejected → one row per (reason, body sha), no payload, no event id. Verified → 22023 unless `payload` has an `evt_` id, a type and a boolean livemode; dedupe on the `evt_` id (a repeat counts the delivery and returns the stored decision); a new one is stored as its projection and applied in the same transaction (§19's tables); an error rolls everything back. |
| `record_stripe_read(payment_id uuid, object jsonb, correlation_id text)` → `event_id, event_status, outcome, payment_status` | service role only | Built (Phase 14 step 1, D159a; §19). 22004 on nulls; 22023 unless a `checkout.session` (`cs_` id), a `refund` (`re_`/`pyr_` id) or a `payment_intent` (`pi_` id; since the final review, R-086); P0002 for an unknown payment. Stores an `api_read` row, applies it like a webhook (or `read_mismatch` when the id is not the payment's: a PaymentIntent must be the one the payment already carries) and stamps `checked_at`. Not deduplicated. |
| `prepare_deposit_checkout(token text)` → `outcome, payment_id, work_order_id, quote_id, job_number, amount, amount_cents, currency, stripe_checkout_session_id, expires_at` | service role only | Built (Phase 14 step 2, D151, D158; §19). No locks. `quote_not_found` (P0002) for a malformed or unknown token; `deposit_not_due` unless answered with a `deposit_amount`; `paid`, `refunded` or `processing` (the newest such payment); `deposit_parts_cancelled` (state none); `deposit_job_closed`; `check` with the pending payment and its session; else `create` with a fresh `payment_id`, the amount and `amount_cents` computed here, `SGD` and `expires_at` = now (to the second) + 60 minutes as Unix seconds. Replaced in `20261014001400` with the same signature (D156h): after the deposit's own answers and refusals and before `check` and `create`, a balance payment on the job whose Checkout completed and Stripe is still confirming answers `job_payment_processing` (its id; no session or expiry: nothing to create, try again shortly; not `processing`, which is the deposit's own), then a pending balance payment on the job with a live session answers `replace` with its id and session, for the app to expire; nothing else changes. |
| `record_deposit_checkout(p_payment_id uuid, p_quote_id uuid, session jsonb)` → `outcome, payment_id, stripe_checkout_session_id` | service role only | Built (Phase 14 step 2, D153, D158d; §19). 22004 on nulls; P0002 for an unknown quote; locks the job, then the quote. A known payment id: `existing` with the same session for the same quote (a deposit), else `checkout_session_conflict`. Then `deposit_not_due`; `paid`, `refunded` or `processing` (no row; the app expires the new session); `deposit_parts_cancelled`; `deposit_job_closed`; another pending deposit → `existing` with its id and session. `checkout_session_mismatch` unless Stripe's echo is a `checkout.session` with a `cs_` id, status open, `amount_total` = the deposit in cents, currency sgd, `bicii_payment_id`, `bicii_quote_id` and `client_reference_id` matching, a boolean `livemode` and an `expires_at` in the future and at most 61 minutes ahead (prepare asks 60); `checkout_session_conflict` when another payment has the session. Inserts the pending payment: `created`. No timeline entry. The input names carry `p_` because the result has a `payment_id` column. Replaced in `20261014001400` with the same signature (D156g): a pending balance payment on the job that is live or processing answers `existing` with its id and session, inserting nothing; nothing else changes. |
| `record_counter_payment(p_id uuid, p_work_order_id uuid, p_quote_id uuid, p_amount money_amount, p_method counter_payment_method, p_received_at timestamptz = null, p_reference text = null, p_note text = null)` → `counter_payment_id, replayed, open_checkouts` | A (by role, `private.require_admin()` first; 42501 for a manager or mechanic) | Built (Phase 14 step 3, D161; §19). Before the lock: 22004 on a null id, job, amount or method; 23514 by constraint for the amount (0.01 to 999,999.99), the reference (200) and the note (2,000); `counter_payment_in_future` (more than 5 minutes ahead). The fingerprint is of the request as given (a NULL time stays NULL; "200" and "200.00" match). Locks the job (P0002); the same id with the same fingerprint → `replayed` (with the current `open_checkouts`) before any other check, a different one `counter_payment_conflict`; a deposit locks its quote by id and job (`counter_payment_quote_mismatch`, never a lock on another job's quote); then `work_order_cancelled`, `counter_payment_currency`, `counter_payment_before_job` (before check-in, or the quote's answer for a deposit), `counter_payment_too_old` (more than 30 days back); a deposit: `deposit_not_due` (none, or no deposit asked), `deposit_already_paid`, `deposit_processing`, `counter_deposit_amount` (not exactly the deposit); `counter_payment_stripe_processing` while a Stripe payment on the job is completed and unconfirmed. Inserts `on conflict (id) do nothing` (the same id on another job: `counter_payment_conflict`) and records `counter_payment_recorded` `{counter_payment_id, kind, quote_id, amount, method, received_at}` (never the reference or note). `open_checkouts`: the job's open Stripe sessions (not completed, not expired) of a balance or this quote's deposit, for the app to expire. |
| `void_counter_payment(p_counter_payment_id uuid, p_kind counter_void_kind, p_reason text)` → `counter_payment_id, replayed` | A (by role) | Built (D161d). 22004 on nulls; `reason_required`, `reason_too_long` (500); `counter_payment_not_found` (P0002); locks the job, then the counter row FOR UPDATE; the same kind and reason again → `replayed`, otherwise `counter_payment_already_voided`; any job status; records `counter_payment_voided` `{counter_payment_id, kind, quote_id, amount, method, void_kind, reason}`. |
| `send_balance_link(p_link_id uuid, p_work_order_id uuid, p_channel quote_channel, p_valid_days integer = 7)` → `link_id, token, amount, expires_at, replaced_link_id` | S | Built (D156; §19). 22004 on nulls; `balance_link_validity_invalid` (1 to 30); locks the job (P0002); a used id `balance_link_already_sent` (no replay: the token is shown once); `balance_link_not_ready` (not completed or ready), `balance_link_currency`; the live balance: `balance_too_small` (under 0.50, nothing left or paid ahead), `balance_too_large` (over 999,999.99); `balance_payment_processing` while a Stripe payment on the job is completed and unconfirmed; withdraws the live link (`replaced`, `replaced_by` the new id, `balance_link_withdrawn`), stores only the token's SHA-256 and records `balance_link_sent` `{link_id, channel, valid_days, amount}`; returns the 43-character token once and the replaced link's id (for the app to expire its open session). |
| `balance_by_token(p_token text)` → jsonb | anon, S, C | Built (D156f). Stable, no locks. Null for an unknown or malformed token; only `{status, job_number}` when the link is withdrawn, then expired, then its job is not completed or ready (`closed`); otherwise twelve keys: `status` (open), `shop_name`, `job_number`, `bike` (brand, model, variant), `first_name`, `currency`, `lines` (`[{description, quantity, line_total}]`, live lines by `created_at`, id; a unit line's description cut before ` · <short id>`, or the product's current name (else `Part`) whenever the snapshot does not carry it after its first character, so the rest of it never shows), `job_total`, `paid` (net paid), `paid_ahead`, `balance_due` and `payment` (`due`, `processing`, `too_small`, `nothing_due` or `too_large`). Never costs, notes, staff, contact details, other jobs, ids, unit ids, serial numbers, Stripe ids or URLs. |
| `prepare_balance_checkout(p_token text)` → `outcome, payment_id, work_order_id, link_id, job_number, amount, amount_cents, currency, stripe_checkout_session_id, expires_at` | service role only | Built (D156g, D156h). No locks. `balance_link_not_found` (P0002), `balance_link_withdrawn`, `balance_link_expired`, `balance_link_job_closed`, `balance_too_large`; then, over the job's pending Stripe payments: `processing` (one completed and unconfirmed), `replace` (a live deposit session, another link's pending row, or this link's at an amount that is no longer the balance: that payment's id and session, to expire and record), `check` (this link's pending row at the live amount), `nothing_due` (under 0.50, with this link's pending row if any), else `create` (a fresh payment id, the live balance and its cents computed here, an expiry 60 minutes ahead in whole seconds). |
| `record_balance_checkout(p_payment_id uuid, p_link_id uuid, p_amount_cents bigint, p_session jsonb)` → `outcome, payment_id, stripe_checkout_session_id` | service role only | Built (D156g). 22004 on nulls; 22023 for cents outside 50 to 99,999,999; P0002 for an unknown link; locks the job, then the link. Replay (the same id, session, link and cents) → `existing`, else `checkout_session_conflict`; `balance_link_withdrawn`, `balance_link_expired`, `balance_link_job_closed`; another live or processing Stripe payment on the job, or a pending linked balance → `existing` (nothing inserted); Stripe's echo checked as the deposit's, with `bicii_kind` balance, `bicii_work_order_id` the link's job, no `bicii_quote_id` and `amount_total` = `p_amount_cents` (`checkout_session_mismatch`); then the live balance under the locks: under 0.50 `nothing_due`, cents that differ `stale`, else the pending payment (kind balance, the link, amount the live balance) → `created`. No timeline entry. |
| `report_payment_summary(p_from date, p_to date)` → `currency, online_count, online_total, deposit_online_total, balance_online_total, refund_count, refund_total, counter_count, counter_total, given_back_count, given_back_total, net_total, other_currency_count` | A, M or P(view_financial_reports) | Built (Phase 14 step 3, D154a–e; §14). Stable definer; `report_range_invalid`, `report_range_too_long` after the permission check; half-open shop days; the shop currency's movements; `net_total` = online − refunds + counter − given back. Never a sales figure. |
| `report_payment_items(p_from date, p_to date, p_max_rows integer = 100, p_after_at timestamptz = null, p_after_id uuid = null)` → `at, id, movement, work_order_id, job_number, customer_label, kind, method, amount, signed_amount, currency, other_currency, recorded_at, recorded_by_name` | A, M or P(view_financial_reports) | Built (D154e). The period's movements, newest first by (at, id); a page clamped to 1..1,000 rows; half a cursor `report_key_invalid`; `recorded_at` and the recorder's name on counter rows only (the void's time and who voided it on a given-back row). |
| `report_payments_held()` → `grp, work_order_id, job_number, status, customer_label, amount, net_paid, net_paid_online, paid_at_counter, job_total, balance_due, paid_ahead, currency` | A, M or P(view_financial_reports) | Built (D154c). As of now, from `work_order_payment_totals`: `open` (an open job with net paid above 0; amount net paid, paid ahead as a memo), `awaiting_collection` (completed or ready; amount the lesser of net paid and the job total, still to pay beside it; a job with nothing paid but something due included), `above_bill` (held above the bill on any job that is not open); disjoint, ordered by group and job number; shop-currency jobs only. |
| `private.purge_stripe_events(older_than interval)` → integer | owner only, by hand (no API role, no cron) | Built (Phase 14 step 1, D88). 22023 when null or under 30 days; deletes rejected deliveries last delivered before then. |
| `private.purge_integration_events(older_than interval)` → `rejected_deleted, payloads_purged` | owner only, by hand (no API role, no cron) | Built (Phase 10 step 1, D88). 22023 under 30 days; deletes rejected rows last delivered before then; clears the payload of processed/skipped events processed before then (`payload_purged_at`), never failed, pending or open-job events. |
| `set_publish_online(product_id, publish)` → `shopify_publish_result (product_id, publish_online, sync_status, job_id)` | P(manage_inventory) | Built (Phase 10 step 2, D84, D86). A composite result (a `returns table` cannot reuse the argument name). Locks the product (P0002). Publishing: `shopify_product_archived`, `shopify_not_saleable` (customer-owned), `shopify_requires_public`, `shopify_price_missing` (`private.shopify_online_price` NULL; 0 is a price), in that order. Same value: the current state, `job_id` NULL, no job, no audit. Otherwise upserts the sync row and queues the product; `job_id` is the queued job this call created or reused (the app runs exactly that one); unpublishing a never-pushed product is `not_synced`, its queued job dismissed, `job_id` NULL. One `publish_online_changed {from, to}` audit row. |
| `request_product_sync(product_id)` → uuid | P(manage_inventory) | Built (Phase 10 step 2, D86). Sync now: `shopify_not_published` unless published or pushed before; clears `desired_hash` (a full push), returns the queued job (created or reused), due now. One `sync_requested` audit row per call. |
| `set_shopify_settings(online_location_id, storefront_url, accept_test_orders, reason)` → `shopify_settings` | A | Built (Phase 10 step 2, D83, D84, D89). 22004 without a location or `accept_test_orders`; the location must exist (P0002) and be active when it changes (`location_inactive`); storefront https or NULL (`shopify_settings_storefront_url_check`), trailing slashes trimmed; a reason is required when `accept_test_orders` changes (`reason_required`), optional otherwise; creates the row when absent; same values: unchanged, no audit. A new online location queues every published or pushed product. One `settings_changed {from, to}` audit row. |
| `product_sync_state(product_id)` → `shopify_product_sync_state` (§13's fields) | service role only | Built (Phase 10 step 2, D81, D83, D84). The sync worker's input (§13). P0002 unknown product; `shopify_settings_missing`. Never a cost. |
| `record_product_sync_result(product_id, job_id, outcome, shopify_product_id, shopify_variant_id, shopify_inventory_item_id, shopify_location_id, pushed_quantity, pushed_price, desired_hash, api_version, error_code, error_message, retriable)` → `shopify_product_sync` | service role only | Built (Phase 10 step 2, D83, D84, D87). Outcomes `pushed`, `unchanged`, `deferred`, `failed` (§13); 22023 for another; 22004 when a push lacks its ids or quantity or a failure its message; `shopify_ids_conflict`; lock order settings → product → sync row → job. |
| `private.shopify_online_price(product_id)` → money_amount; `private.enqueue_product_sync(product_id)` → uuid | no API role | Built (Phase 10 step 2): §13. |
| `grant_permission(target_staff_id, permission)` / `revoke_permission(…)` | A, or P(manage_staff) on a mechanic within the D11 ceiling (D93: a non-admin's target must be a mechanic, never themselves; never `manage_staff`; only permissions they hold) | Exception rows (`granted_by` = caller); replay-safe (no row change, no event). `grant_permission` refuses a permission the target's role implies (P0001 `permission_implied_by_role`, D92) before inserting; revoking a row that does not exist returns null. One `permission_granted` / `permission_revoked` event; the revoke event keeps the removed row's `granted_by`/`granted_at`. |
| `set_staff_active(target_staff_id, active, reason)` | A, or P(manage_staff) on a mechanic (D93) | Deactivating needs a reason (P0001 `reason_required`; `reason_too_long` over 500). Nobody deactivates themselves; only an admin changes an admin's or a manager's status (42501); the last active admin stays (55000). One `deactivated`/`reactivated` event with the reason; replaying the current state is a no-op. Deactivation also deletes the person's Supabase Auth sessions (trigger `staff_revoke_sessions`, D71). |
| `note_sign_in_attempt(buckets, window_seconds)` | service role only (the Admin's login actions, and since Phase 13 step 3 the quote page's limits, `src/lib/admin/quote-throttle.ts`, with `quote-` keys) | Counts one sign-in attempt in each bucket for the current fixed window and returns the counts (PLAN D72, §1 "Sign-in attempt counters"); 22023 for malformed arguments. Not callable with the anon key or a user session. |
| `update_staff(target_staff_id, display_name, role, reason, expected_role)` | A or P(manage_staff); role changes A only (D93) | Null leaves a field as it is. `expected_role` (optional) is the role the caller's confirmation showed: checked against the row locked `for update`, a different current role raises P0001 `staff_role_changed` and nothing changes (the Admin always sends it, so a stale page cannot make a change its sheet did not describe). Nobody changes their own role; only an admin renames an admin or a manager (a non-admin renames mechanics only); the last active admin cannot be demoted (55000). `role_changed` (with the reason, ≤ 500 characters) / `details_changed` events; a role change also deletes the exceptions the new role implies, one `permission_revoked` event each with the same actor and reason (D92). Email is not editable (it must stay the login's email). |
| `staff_history(target_staff_id, max_rows)` | A or P(manage_staff) | `staff_events` for one person, newest first, with the actor's display name (≤ 500 rows, default 100). |
| `my_staff_profile()` | authenticated | Caller's staff row + effective permissions in enum order: what the role implies (`private.role_implies`: admin all, manager all but `manage_staff`, mechanic none) plus exceptions; inactive → none; zero rows for non-staff. |
| `create_staff(auth_user_id, display_name, email, role = 'mechanic')` | A or P(manage_staff); only A creates `admin` or `manager` (D93; 42501) | Links an existing Auth login (created server-side with the service-role admin API) to a new active staff row. Email must equal the login's email (`P0001 staff_email_mismatch`); duplicate email → 23505 `staff_email_key`. |
| `staff_roster()` | A or P(manage_staff) | Every staff row with its *granted* permissions (the exceptions on top of the role, D92), for Staff settings (a manage_staff holder could otherwise grant but not see permissions, §15). |
| `staff_directory()` | S | `id, display_name, role, active` of every staff member: how staff see colleagues' names (§15) without reading the `staff` table. |
| `transfer_bike_ownership(bike_id, to_customer_id, reason)` | S | `to_customer_id` null = the shop. Reason required (P0001 `reason_required`, `reason_too_long` over 500). Locks the bike; one `transferred` event with actor and reason (by trigger); replaying the current owner is a no-op. P0002 unknown bike/customer; `customer_archived`, `bike_archived`. Returns the bike. |
| `record_attachment(attachment_id, entity_type, entity_id, storage_bucket, storage_path, media_type, byte_size, width, height, caption, visibility)` | S | Entity must exist (P0002; `attachment_entity_unsupported` for a type without a table, none since Phase 6 added `consignment_item`); a `consignment_item` photo is internal only (`attachment_consignment_internal_only`, D52); bucket must match visibility (`attachment_bucket_mismatch`); path must be `{entity_type}/{entity_id}/{attachment_id}.{ext}` with ext matching the type (`attachment_path_mismatch`); photo types only (`attachment_media_type_unsupported`); the object must be in `storage.objects` (`attachment_object_missing`) with a matching mimetype (`attachment_media_type_mismatch`); Storage's size wins. Replay returns the same row; an id used for another file (`attachment_conflict`) or deleted (`attachment_deleted`) is refused; customer records are never public (`attachment_customer_never_public`), nor is a photo without width and height (an undecoded original, `attachment_original_never_public`). `created` event. |
| `set_attachment_visibility(attachment_id, visibility, new_bucket, new_path)` | S | internal ↔ customer stays in `media-internal`; to/from `public` the object must already be at the new location (copied by the server). Never public for a customer record or an undecoded original (`attachment_original_never_public`). Locks the row; `visibility_changed` event; replay is a no-op. |
| `delete_attachment(attachment_id, reason)` | S | Reason required. Deletes the row, `deleted` event with actor, reason and the row as payload. Returns a set: the deleted row (the server then removes the object), or no row on replay (PostgREST: `[]`). |
| `attachment_stray_objects(entity_type, entity_id)` | S | Objects under `{entity_type}/{entity_id}/` in either photo bucket that no attachment points at and that are safe to remove now (older than 10 minutes; in `media-internal`, with history or older than a day), at most 100. The server removes them when it shows the record. |
| `staff_search(q, kinds, max_results, archived)` | S | Typed hits `(kind, id, title, subtitle, short_id, rank)` across customers (name words in any order, email, phone digits with or without +65), bikes (short ID and serial ignoring case/spaces/dashes, brand/model/variant/colour plus owner name) and, from Phase 3, jobs (`work_order`: job number ignoring case/spaces/dashes, exact 1.0, contains ≥ 3 characters 0.6; title the bike, subtitle the customer · the first 80 characters of the requested work, short_id the job number; every status) and, from Phase 4, products (`product`: exact P- ID or SKU key, i.e. upper-cased without punctuation, 1.0; SKU key containing q's key, ≥ 3 characters, 0.7; every word of q in name/brand/SKU 0.45 + 0.4 × word similarity; title the name, subtitle `SKU · brand · N in stock` with N the ledger on-hand across locations, or `Unique item`, plus `Inactive` for an inactive product, which is still found) and units (`inventory_unit`: exact U- ID or serial key 1.0; serial key containing q's key, ≥ 3 characters, 0.7; every word of q in the product's name 0.45 + 0.4 × word similarity; title the product's name, subtitle `status · location · S/N serial` with status Available, Reserved, On a job, Sold, Written off or Returned to consignor). Exact short ID, serial, SKU or job number rank 1.0, exact email/phone 0.95, fuzzy below. Archived rows excluded, or (`archived` true) searched alone with the same matching, for the Archived lists (jobs are never archived, so none then; a unit by its own `archived_at`); `kinds` null = all, unknown kind 22023; `max_results` clamped to 1..100 (callers ask for one more than they show, to know the list is cut off). Phase 6 step 2 adds `consignor` (every word in name/email 0.5 + 0.4 × word similarity, phone digits contained 0.6, exact email or phone 0.95; title the name, subtitle email · phone; archived consignors only with `archived` true), `consignment_item` (exact C- ID 1.0, C- ID containing the key ≥ 3 0.6, every word in product name/brand and consignor name 0.45 + 0.4 × word similarity; title the product name, subtitle `consignor · status · U-…` or `Qty n`; never archived) and `sale` (exact S- number 1.0, number containing the key ≥ 3 0.6; title `S-… · $total`, subtitle the customer or `Walk-in` · the shop day; never archived; voided left out). From Phase 7 (`20261005000400_purchasing_search.sql`), suppliers (`supplier`: every word of q in name/contact/email/account reference 0.5 + 0.4 × word similarity, exact email or exact phone (with or without +65) 0.95, phone digits contained 0.6; title the name, subtitle `contact · phone · email`, no short_id; archived suppliers only with `archived`) and purchase orders (`purchase_order`: exact PO number key — `PO-000002`, `po 000002`, `PO000002` — 1.0, exact supplier reference key 0.95, PO number containing the key (≥ 3 characters) 0.6, every word of q in the supplier's search text 0.4 + 0.4 × word similarity; title the supplier's name, short_id the PO number, subtitle `status · expected 12 Oct 2026 · R of N received` (the date only when set, the count only when the PO has lines); POs are never archived, so none with `archived`; cancelled and received POs are found). **Merge hazard:** each phase's migration replaces the whole function, so the latest definition must contain every branch; the merged line's latest is `20261005000400_purchasing_search.sql`, which carries Phase 6's three kinds and Phase 7's two. `tests/db/staff-search.test.ts` checks that staff_search accepts every `SEARCH_KINDS` entry of `src/lib/search.ts`, which the app asks for by default. Later phases add a `private.search_<kind>` function and a branch. |
| `my_customer_profile()` | authenticated (C) | The caller's own `customer_profile` (id, names, email, phone, created_at); zero rows for non-customers. |
| `update_my_profile(first_name, last_name, display_name, phone)` | C | Own row only; null keeps a field, '' clears it; 42501 without a customers row. |
| `claim_my_customer(create_if_missing = false, first_name = null, last_name = null, phone = null)` → `setof customer_profile` | authenticated (any login; 42501 for anon) | Built (Phase 11, D121, D122). Refuses a login without a confirmed email (`customer_email_unconfirmed`); an advisory lock per address; the login's own record if it has one (archived: `customer_archived`); else the one non-archived record with that email (citext) and no login, linked without changing its fields; two or more: `customer_link_ambiguous`; none: nothing, or with `create_if_missing` a new record with the login's email (`customer_name_required`, `customer_name_too_long`, `customer_phone_too_long`). |
| `my_bikes()` | authenticated (C) | The caller's current, non-archived bikes without internal notes. |
| `my_bike_attachments(bike_id)` | authenticated (C) | `customer`/`public` attachments of one of the caller's own bikes; empty for anyone else's. |
| `my_work_orders()` | authenticated (C) | The caller's jobs (not cancelled), newest first: `id, job_number, bike_id, bike_short_id, bike_title, status customer_job_status, checked_in_at, completed_at, ready_for_collection_at, collected_at, currency, sale_total` (live lines). D17: by `work_orders.customer_id`, whatever the bike's owner or archived state now. |
| `my_work_order_lines(work_order_id)` | authenticated (C) | Live lines of one of the caller's non-cancelled jobs, in `created_at` order: `id, description, quantity, unit_sale_price, sale_total, currency`. Empty for anyone else's job. |
| `my_work_order_timeline(work_order_id)` | authenticated (C) | Oldest first `id, kind, status, attachment_id, created_at`: `checked_in` (status `received`); `status` for a status_changed/completed/ready_for_collection/collected/reopened event whose customer status differs from the previous entry's; `photo` for a `photo_added` whose attachment still exists and is customer-visible. No actors, notes, payloads, lines, assignments or costs. |
| `my_work_order_attachments(work_order_id)` | authenticated (C) | `customer`/`public` attachments of one of the caller's non-cancelled jobs (job photos are never public, D19), same columns as `my_bike_attachments`. |

## 17. Sequences and short IDs

`private.next_short_id(prefix text) returns text` reads a per-prefix sequence
(`private.seq_short_id_b`, `private.seq_short_id_j`, …, `maxvalue 999999 no
cycle`, so exhaustion raises rather than truncating) and zero-pads to six
digits. Unknown prefixes raise SQLSTATE 22023. Sequences
are never reset. The UUID is the primary key everywhere; short IDs are for
humans and QR codes.

## 18. Seed data (`supabase/seed.sql`)

Realistic and deterministic (fixed UUIDs so tests can reference them):
4 staff logins (D90–D94): Asha Admin (`admin@bicii.test`, admin), Kavya
Menon (`manager@bicii.test`, manager, no exceptions; auth
`a0000000-…-000000000004`, identity `a1000000-…-000000000004`, staff
`5a000000-…-000000000004`), Marcus Tan (`mechanic1@bicii.test`, mechanic,
`view_costs` as an exception granted by the admin) and Nur Aisyah
(`mechanic2@bicii.test`, mechanic, no exceptions), each an Auth login with
a random-secret bcrypt hash and no known password (`AUTH_USER`, `STAFF`,
`STAFF_EMAIL` in `tests/fixtures/ids.ts`), 6 customers with
10 bikes, shop hours Tue–Sun, 4 appointment types, 9 appointments, 1 customer login, 9 services, 2 locations,
12 quantity products with stock, 3 unique shop-owned bikes, 2 consigned bikes
(one sold, unsettled) and consigned kit, 4 in-store sales, 2 suppliers, 1 PO partially received, 9 work orders
spread across statuses and the last 9 days, settlements. (The Cult Commons
base rate is not seed data: the workshop catalog migration ships it, D21.)
The seed is applied to the local database and to a fresh preview
project; never to production. Phase 9 step 1 (period reports) adds no seed
rows: its tests build their own March 2025 scenario
(`tests/db/period-report-fixtures.ts`) and read the existing seed's last
week.

Phase 1 part (done): customers `c1000000-…-00000000000N` (`CUSTOMER` in
`tests/fixtures/ids.ts`; only Chloe Lim has a login, added in the Phase 2
part) and bikes
`b1000000-…-0000000000NN` (`BIKE`, short IDs `B-000001`…`B-000010` in insert
order, `BIKE_SHORT_ID`; Phase 4 adds B-000011…B-000013 and Phase 5
B-000014…B-000017), one shop bike without an owner and one bike
transferred between customers (two ownership events). No attachments.

Phase 3 part (done): service categories `ca000000-…-00000000000N`
(`CATEGORY`: Servicing, Wheels & tyres, Brakes, Builds, Labour, sort 1–5),
services `5e000000-…-0000000000NN` (`SERVICE`; SGD price / default direct
cost): Basic Service 80/0, Full Service 200/0, Wheel True 35/0 (per wheel),
Tyre Installation 15/0 (per tyre), Brake Bleed 45/8 (per brake),
Drivetrain Service 90/5, Bike Build 250/0, Custom Labour 60/0 (per hour,
not public) and Suspension Fork Service 120/25 (inactive, archived 30 days
ago). Nine jobs `f1000000-…-00000000000N` (`WORK_ORDER`, job numbers
`J-000001`…`J-000009` in insert order, `JOB_NUMBER`), lines
`f2000000-…-0000000000NN` (`LINE`, all at rate 0.3000) and assignments
`f3000000-…-0000000000NN`. Times are relative to the shop day the seed
runs: `pg_temp.seed_at(N, '10:00')` plus the same minute/hour offsets (one
base local time per job, all between 08:00 and 18:00 Singapore time; see
"Phase 5 part"); d = shop days before the reset day, h = hours:

| Job | Customer, bike | Status | What it demonstrates |
|---|---|---|---|
| J-000001 | Tan, Tarmac | collected | The full walk: checked in −9d, in progress −8d, completed −7d, ready −7d+1h, collected −6d; lead Marcus; Full Service + Brake Bleed ×2: sale 290.00, cost 16.00, yield 274.00, Cult Commons 82.20; intake and completion notes. |
| J-000002 | Priya, Domane | ready_for_collection | Money the E2E tests assert: Basic Service, Tyre Installation ×2 and a manual "Continental GP5000 700×28c tyre" ×2 at 95.00 (cost 62.00): sale 300.00, cost 124.00, yield 176.00, CC 52.80, BICII after CC 123.20; approval flag with one `approval_flagged` event (Asha, −5d+1h); lead Nur. |
| J-000003 | Hafiz, Brompton | completed | Started −1d 10:00, completed −1d 16:00, not yet ready; lead Marcus with Nur as additional staff; Drivetrain Service. |
| J-000004 | Chloe, Giant | in_progress | Diagnosing −3d+1h then in progress −1d (a received → diagnosing step the customer never sees); Wheel True ×2. |
| J-000005 | Chloe, Surly | awaiting_parts | A note (Nur, −5d−1h) before waiting for the customer's part; Custom Labour ×1.5. |
| J-000006 | Daniel, Cannondale | awaiting_customer | Phase 3's one overdue job (D20: open, checked in −8d; Phase 5's H7 is the other); a diagnosis (Marcus, −8d+2h); no lines. |
| J-000007 | Nurul, Bianchi | received | Just checked in, unassigned, no lines: checked in at seed time, after the Bianchi's sale from Daniel. |
| J-000008 | Tan, Brompton | cancelled | Cancelled an hour after check-in with a reason (hidden from the customer, D17). |
| J-000009 | Priya, Tern | diagnosing | A voided line: Asha quoted a bottom bracket (45.00, cost 28.00), Nur voided it at −1d+3h; live total 80.00. |

So that every seeded timeline reads true (`workshop-seed.test.ts`):
(a) intake/completion notes and the approval flag are given in the
`work_orders` INSERT (the insert trigger writes only `checked_in`), and the
backdated `note_added`, `diagnosis_added` and `approval_flagged` events are
inserted by hand with their own time and actor; those columns are never
updated in the seed (that would stamp an event at seed time); (b) before
each block of writes `request.jwt.claims` names the staff member acting,
so every trigger-written actor equals the row's own `created_by` /
`assigned_by` / `voided_by` (Asha checks in and assigns; Marcus and Nur
walk their own jobs' statuses; lines with a cost are added by Asha or
Marcus, D14); (c) each job is inserted `received` with an explicit
`checked_in_at`, gets its assignments and lines while open, then walks its
statuses one UPDATE at a time with an explicit `status_changed_at`, times
strictly increasing and no line change after completion; (d) J-000007's
`checked_in_at` is `clock_timestamp()` at its insert, after the Bianchi's
`transferred` event. Still no attachments. (The seeded bikes themselves are
registered at seed time, after the backdated check-ins; only the jobs'
timelines are backdated.)

Phase 4 part (done, step 1): the 'Shop floor' location
(`1c000000-…-000000000001`, sort 10) comes from the inventory migration's
one-shop bootstrap; the seed re-inserts it with `on conflict do nothing` and
adds 'Workshop store' (`…0002`, workshop, sort 20) (`LOCATION`). Product
categories `ca000000-…-000000000006`…`…012` (kind product: Brakes, Tyres &
tubes, Drivetrain, Cables & hoses, Care, Cockpit, Bikes; `PRODUCT_CATEGORY`).
Products `9a000000-…-0000000000NN` (`PRODUCT`, `PRODUCT_SHORT_ID`) are
inserted directly as the owner with `request.jwt.claims` naming the admin
(so `created_by` and the history name an actor), in order, giving
`P-000001`…`P-000016`, dated −30d 07:00. The opening stock and the units
are dated −30d (from 08:00, a minute apart): owner statements writing
exactly the rows `adjust_stock` and `create_unique_unit` write (same request
ids, quantities, movement type, reason, cost snapshot, currency, actor), so
they never show as today's adjustments; history events written by triggers
(product and unit `created`, the bikes' stock link) keep seed time. The
inventory job goes through the real RPCs as the admin, at seed time (today),
every request id used once.

| Short ID | Product | Price / cost | Reorder | On hand after the seed |
|---|---|---|---|---|
| P-000001 | Road disc brake pads, resin (pair) | 28.00 / 13.50 | 10 | 34 Shop floor |
| P-000002 | Grand Prix 5000 700x25c tyre | 89.00 / 52.00 | 4 | 12 Shop floor |
| P-000003 | Road inner tube 700x23-28c Presta 60mm | 9.00 / 3.80 | 20 | 40 Shop floor + 20 Workshop store |
| P-000004 | Marathon Racer 16x1.35 tyre | 55.00 / 30.00 | 3 | 6 Shop floor (one consumed by J-000010, then reversed) |
| P-000005 | Inner tube 16in Schrader | 14.00 / 6.00 | 6 | 12 Shop floor (15 opening, one on J-000010, two sold on Phase 6's S-000002) |
| P-000006 | X11 11-speed chain | 45.00 / 24.00 | 5 | 26 Shop floor (8 opening + 18 received on Phase 7's PO-000002) |
| P-000007 | 105 CS-R7000 11-34 cassette (draft) | 109.00 / 68.00 | 2 | 7 Shop floor (3 opening + 4 received on Phase 7's PO-000001) |
| P-000008 | Pro brake cable kit | 35.00 / 16.00 | 4 | 2 Shop floor (low) |
| P-000009 | SM-BH90 hydraulic hose 1000mm | 28.00 / 12.00 | 5 | 1 Shop floor (low) |
| P-000010 | Dry chain lube 120ml | 16.00 / 7.00 | 6 | 18 Shop floor (28 after Phase 7's PO-000002) |
| P-000011 | DSP 3.2mm bar tape | 49.00 / 26.00 | 4 | 7 Shop floor |
| P-000012 | Tubeless sealant 237ml | 32.00 / 17.00 | 3 | 1 Shop floor + 1 Workshop store (low) |
| P-000013 | Colnago C64 Disc 52s (pre-owned), unique | 6800.00 / 4200.00 | — | unit U-000001 (bike B-000011) |
| P-000014 | Brompton C Line Explore (ex-demo), unique | 1950.00 / 1400.00 | — | unit U-000002 (bike B-000012) |
| P-000015 | Surly Bridge Club 27.5 M (new old stock), unique | 1650.00 / 1100.00 | — | unit U-000003 (bike B-000013) |
| P-000016 | X10 10-speed chain (discontinued), archived | 35.00 / 18.00 | — | none |

All are internal_only except P-000007 (draft); none is public and there are
no attachments. Opening stock is written as `adjust_stock` would, with request ids
`9c000000-…-0000000000NN` per product at its first location and
`9c000000-…-0000000001NN` for the Workshop store rows of P-000003 and
P-000012 ("Opening stock count"). Three shop bikes without an owner,
`b1000000-…-000000000011`…`…013` (`BIKE.shopColnago`, `shopBrompton`,
`shopSurly`; B-000011…B-000013), are in stock as units
`9b000000-…-00000000000N` (`UNIT`, U-000001…U-000003, written as
`create_unique_unit` would: shop-owned at the Shop floor, bike linked, a +1
'Registered as a unique item' movement at the unit's direct cost).
`reporting.low_stock` lists exactly P-000009, P-000008 and P-000012.

The inventory job `9e000000-…-000000000001` (`INVENTORY_JOB`, J-000010) is
Hafiz's Brompton (D18; his only other job, J-000003, is completed), lead
Asha, left `received`: line `9d000000-…-000000000001` is one Inner tube 16in
Schrader from the Shop floor (live), and line `…0002`, one Marathon Racer
tyre, was voided ("Customer brought their own tyre"), so the ledger shows a
`job_consumption` and its linked `reversal` (`SEED_LINE`). It is kept out of
`WORK_ORDER` / `JOB_NUMBER`, which list Phase 3's nine jobs.

Phase 5 part (done): **history relative to the reset day.** Every Phase 3,
4 and 5 timestamp is written through the session-temporary
`pg_temp.seed_at(days_ago integer, local_time time) returns timestamptz`,
defined before the first Phase 3 statement: for `days_ago > 0` it is
`((private.shop_today() - days_ago) + local_time) at time zone
'Asia/Singapore'`; for day 0 it maps `local_time` proportionally into the
part of today that has already passed (`shop_day_start(today) + (now() −
shop_day_start(today)) × local_time / 24 h`), so today's rows keep their
order and are never in the future at any time of day. The seed runs in one
session and one transaction (`now()` is the same everywhere); Singapore has
no DST, so `seed_at(n, t) − seed_at(m, t)` is exactly (m − n) × 24 h. Phase
3 keeps its day offsets (not moved to days 7–13, which would make every
open Phase 3 job overdue); J-000007 and J-000010 stay at seed time; Phase
4's opening stock and units are at day 30; trigger-written history events
keep their own (seed) time where the seed does not write them by hand.
No migration was needed: no Phase 3/4 trigger overwrites an owner's
timestamps.

Eleven jobs `d5000000-…-0000000000NN` (`REPORT_JOB`, J-000011…J-000021 in
insert order, `REPORT_JOB_NUMBER`), lines `d5100000-…` (`REPORT_LINE`, all at
rate 0.3000), assignments `d5200000-…`, written as Phase 3's are (owner
inserts, explicit times, claims naming whoever acts; a part from stock is
the line, one `job_consumption` movement at the line's time with −quantity
and cost snapshot = the line's unit cost, and a hand-written
`stock_consumed` event one second later). d = shop days before the reset
day; times are Singapore time. Four more customers' bikes
`b1000000-…-000000000014`…`17` (B-000014…B-000017: Chloe's Specialized
Diverge, Daniel's Canyon Endurace, Priya's Cervelo R5, Hafiz's Dahon Mu;
`BIKE.chloeDiverge`, `danielEndurace`, `priyaCervelo`, `hafizDahon`) are
inserted before H1 so that, as seed realism (the schema allows it), no
bike has two jobs open at once and none is collected while another job on
it is open (`reporting-seed.test.ts`). A bike awaiting collection may take
a newer job (J-000003 then J-000010; H6 then J-000009):

| Case | Job | Customer, bike, lead | Timeline | Lines (qty × sale / cost) → sale / cost / yield / CC / after CC |
|---|---|---|---|---|
| H1 service only (SPEC §10 ex. 1) | J-000011 | Tan, Brompton, Marcus | in d6 09:30, start d6 10:15, done d6 16:40, ready 16:45, collected d5 11:10 | Full Service 1 × 200.00 / 0.00 → 200 / 0 / 200 / 60.00 / 140.00 |
| H2 parts (ex. 2) | J-000012 | Chloe, Diverge (B-000014), Nur | in d5 10:00, start d5 13:00, done d4 15:30, ready 15:35, collected d3 10:20 | wheelset 1 × 800.00 / 400.00 → 800 / 400 / 400 / 120.00 / 280.00 |
| H3 combined (ex. 3) | J-000013 | Daniel, Endurace (B-000015), Marcus | in d4 09:45, start d4 11:00, done d3 17:10, ready 17:15, collected d2 12:00 | Full Service 200.00 + wheelset 800.00 / 400.00 → 1000 / 400 / 600 / 180.00 / 420.00 |
| H4 loss line (D1) | J-000014 | Tan, Tarmac, Marcus | in d3 10:30, start d3 14:00, done d2 15:00, ready 15:05, collected d1 09:40 | Wheel True 1 × 40.00 / 0.00 + tyre 1 × 20.00 / 35.00 (yield −15.00, CC 0) → 60 / 35 / 25 / 12.00 (not 7.50) / 13.00 |
| H5 rounding | J-000015 | Tan, Brompton, Nur (Asha prices) | in d2 10:00, start d2 15:00, done d1 14:00, ready 14:05 | manual 3 × 33.33 / 10.00 (CC 21.00) + 1 × 12.05 / 12.00 (CC 0.02, 0.015 half up) → 112.04 / 42.00 / 70.04 / 21.02 / 49.02 |
| H6 uncollected (D34) | J-000016 | Priya, Tern, Nur | in d12 09:00, start d11 10:00, done d9 16:00, ready d9 16:05 | Custom Labour 1 × 120.00 |
| H7 overdue (D20) | J-000017 | Priya, Cervelo R5 (B-000016), Marcus | in d11 11:00, start d10 10:00, awaiting parts d10 15:00 | Bike Build 1 × 150.00 (open, never recognised) |
| H8 cancelled (D16) | J-000018 | Hafiz, Dahon (B-000017), Nur | in d2 11:30, cancelled d2 12:15 "Customer declined the quote" | none |
| T1 in progress today | J-000019 | Daniel, Endurace, Marcus | in d0 09:00, start d0 09:30 | Drivetrain Service 1 × 90.00 / 10.00 (open) |
| T2 collected today | J-000020 | Chloe, Diverge, Marcus | in d1 17:00, start d0 09:15, done 11:30, ready 11:35, collected 12:10 | Drivetrain Service 1 × 120.00 / 0.00 + chain 1 × 45.00 / 22.00 → 165 / 22 / 143 / 42.90 / 100.10 |
| T3 received today (the anchor) | J-000021 | Chloe, Diverge (after T2's collection), Nur | in d0 13:00 | none |

Six quantity products `d5300000-…-00000000000N` (`REPORT_PRODUCT`,
`REPORT_PRODUCT_SHORT_ID`, P-000017…P-000022) in a new product category
'Wheels' (`ca000000-…-000000000013`, sort 8) and the existing ones, with
opening stock at the Shop floor at d30 08:30 (request ids
`d5400000-…-00000000000N`), so Phase 4's figures are untouched: Carbon disc
wheelset 700c, 45mm (Hunt, 849.00 / 400.00, reorder 1, 4 → 2 after H2, H3),
Corsa Pro 700x28c tyre (Vittoria, 95.00 / 35.00, reorder 2, 6 → 5), SLA-110
11-speed chain (YBN, 45.00 / 22.00, reorder 3, 10 → 9), Disc 34 RS brake
pads (SwissStop, 32.00 / 15.00, reorder 5, 20 → 19), Butyl inner
700x25-32c, Presta 48mm (Panaracer, 12.00 / 5.00, reorder 10, 30 → 24) and
CO2 cartridge 25g, threaded (Genuine Innovations, 6.00 / 3.00, no reorder
point, 10 → 12). None is low: `reporting.low_stock` still lists exactly
P-000008, P-000009 and P-000012. Stock adjustments by Asha (request ids
`d5400000-…-00000000001N`): A1 d2 11:00, brake pads −1 `stock_adjustment`
"Damaged packaging, written off" (not significant); A2 d1 16:30, inner −6
`damaged` "Water damage in storage" (significant, D33: ≥ 5 units; 30.00 at
cost); A3 d0 (08:30 scaled), CO2 +2 `stock_adjustment` "Recount found two in
the workshop drawer" (not significant). No open job is checked in on d7, so
which jobs are overdue never depends on the time of day the reset ran.

At the anchor the snapshot is received 4 (J-000007, J-000009, J-000010,
T3), waiting 3 (J-000005, J-000006, H7), ready to start 0, in progress 2
(J-000004, T1), awaiting collection 4 (J-000002, J-000003, H5, H6), open 9,
overdue 2 (J-000006, H7), low stock 3 and exceptions 3 (overdue J-000006 and
H7, uncollected H6). The per-day figures for d0…d6 (Phase 3/4 rows
included) are `SEED_DAYS` in `tests/fixtures/reporting.ts`, written by hand
together with `SPEC_EXAMPLE_JOBS`, `SEED_SNAPSHOT`, `SEED_EXCEPTIONS` and
`SEED_ADJUSTMENTS`; `tests/db/reporting-seed.test.ts` proves the views
reproduce them exactly.

**The anchor rule.** The seed is anchored to the shop day `db:reset` ran,
which need not be today (the DB test template is built once per run, an
existing database keeps its seed, a run can cross Singapore midnight).
Tests read the anchor from T3's check-in without the functions under test
(`seedToday()` in `tests/db/reporting-fixtures.ts`; `E2E_SEED_ANCHOR`, set
by `tests/e2e/global-setup.mts`, with `seedAnchor()` / `anchorDay(n)` in
`tests/e2e/helpers.ts`), count days back from it, and skip with a message
the assertions that need the anchor to be today. Reset (`npm run
db:reset`) to move the demo's "today".

Phase 2 part (done): **the schedule and appointments**, written as the
owner after every job exists (the owner bypasses the booking rules; the
triggers still enforce the status machine, stamps, bike ownership,
history and the work-order link), acting as Asha Admin (Marcus for
J-000014's completion, Chloe for her own bookings). IDs in
`tests/fixtures/ids.ts` (`SHOP_HOURS`, `APPOINTMENT_TYPE`, `CLOSURE`,
`APPOINTMENT`, `CUSTOMER_LOGIN`).

- Settings: slot 30, capacity 2, notice 120, horizon 60, limit 3, cancel
  cutoff 120 (D37's defaults), `public_site_url` `http://localhost:4000`
  (the local public site; D9 note).
- Weekly hours `e3000000-…-00000000000N`: Tue–Fri 10:00–19:00; Sat
  09:00–12:30 and 13:30–18:00; Sun 09:00–13:00; Monday one INACTIVE
  10:00–19:00 row (closed, hours remembered).
- Types `e1000000-…-00000000000N`: Service drop-off (30 min, 1 unit,
  public), Repair assessment (30, 1, public), Custom build consultation
  (60, 2, public), Warranty inspection (30, 1, staff-only).
- Closures `e4000000-…-00000000000N`: closed all day on the first
  Wednesday ≥ 7 days ahead ("Team at the Taipei Cycle show"); custom hours
  12:00–16:00 on the first Thursday ≥ 8 days ahead ("Short day for
  stocktake"); both within 14 days, whole shop-local days as
  `save_closure_override` stores them.
- Chloe Lim's customer login: Auth user
  `a0000000-…-000000000101` (chloe.lim@example.com, no usable password: the bcrypt hash of a random
  secret, as for the seeded staff; D10, R-035),
  identity `a1000000-…-000000000101`, linked to `CUSTOMER.chloe`.
- Appointments `e2000000-…-00000000000N`, each inserted `booked` a day or
  more before its start and walked one update at a time with explicit
  stamps: (1) d3 10:00 Repair assessment, Tan's Tarmac, checked in at
  J-000014's check-in, linked to J-000014 (both link events dated then, so
  its timeline reads checked_in, appointment_linked, …) and completed at
  J-000014's completed_at (D36, D40); (2) d1 11:00 Daniel's Cannondale,
  no-show (11:20); (3) today 10:00 Priya's Domane, arrived; (4) today 10:30
  Hafiz's Brompton, confirmed (J-000010 is open on it); (5) today 15:00
  Chloe's Giant, booked online with a note; (6) today 16:00 Nurul's
  Bianchi, booked; (7) first Tue–Fri ≥ tomorrow 11:00 Tan's Brompton,
  confirmed; (8) first Tue–Fri ≥ 3 days ahead 10:00 Priya's Tern,
  cancelled by staff ("Customer travelling"); (9) first Tue–Fri ≥ 5 days
  ahead 14:00 Chloe's Surly, Custom build consultation booked online.
  Today's and yesterday's rows ignore the weekly hours on a Monday or
  Sunday; future rows avoid Mondays and the closures; nothing is more than
  14 days ahead (tests book on clear days ≥ 21 days ahead). Daniel has no
  upcoming booked/confirmed appointment; Chloe at most two upcoming online
  bookings; today at most three expected arrivals.
- D41 counts per seeded day (`SEED_DAYS`): d3 scheduled 1, arrived 1; d1
  scheduled 1, no-show 1; d0 scheduled 4, arrived 1; other days 0.
  `tests/db/appointment-seed.test.ts` proves the rest.

Phase 6 part (done, step 2): **consignment and sales**, at the end of the
seed. The three consignors are inserted directly as the owner (like
customers); everything else goes through the RPCs as the admin
(`request.jwt.claims` set, then reset to `''`), so every rule and trigger
runs. Intake dates, sale `recognized_at` and settlement `paid_at` use
`pg_temp.seed_at(days_ago, local_time)` so the history lands on the Phase 5
fixture days; movements, charges, item events and the refund carry seed
time. Fixed-UUID prefixes: `6a` consignors, `6b` items, `6c` intake
products, `6d` intake units, `6e` charges, `6f` sales, `7a` refunds, `7b`
settlements, `7c` reversals, `7e` returns (`CONSIGNOR`, `CONSIGNMENT_ITEM`,
`CONSIGNMENT_PRODUCT`, `CONSIGNMENT_UNIT`, `CONSIGNMENT_CHARGE`, `SALE`,
`SALE_REFUND`, `SETTLEMENT`, `SETTLEMENT_REVERSAL`, `CONSIGNMENT_RETURN` in
`tests/fixtures/ids.ts`).

- Consignors: Kelvin Yeo (no customer record, PayNow), Daniel Ong
  (`CUSTOMER.daniel`), Chloe Lim (`CUSTOMER.chloe`, bank transfer,
  internal notes).
- Items (on a fresh build C-000001…C-000004, products P-000023…P-000026,
  units U-000004…U-000006): C-000001 Kelvin's Colnago C64 Disc, unique,
  agreed 2400.00, asking 4200.00, d20, a 120.00 shop-borne charge, unsold;
  C-000002 Daniel's Cervélo R3, unique, 500.00 / 1000.00, d18, a 45.00
  consignor-borne charge; C-000003 Chloe's six Rapha jerseys, quantity,
  35.00 / 70.00, d15; C-000004 Kelvin's Dura-Ace crankset, unique, 300.00 /
  520.00, d12, returned to him at seed time.
- Sales (`record_retail_sale`): S-000001 d5 11:20 Priya, 2 jerseys naming
  C-000003 (140.00 / cost 70.00 / yield 70.00 / Cult Commons 21.00);
  S-000002 d4 15:05 walk-in, 2 × P-000005 Inner tube 16in Schrader
  (shop-owned, 14.00 / 6.00: 28.00 / 12.00 / 16.00 / 4.80), with a 14.00
  refund (one tube); S-000003 d3 16:40 Hafiz, the Cervélo at its selling
  price (SPEC §10's consignment example: 1000.00 / 500.00 / 500.00 /
  150.00); S-000004 today 10:30 walk-in, 1 jersey by FIFO from C-000003
  (70.00 / 35.00 / 35.00 / 10.50).
- Settlements: Chloe 30.00 paid d3 18:00 (PayNow 2991), reversed ("Wrong
  amount; the transfer was $40."); Chloe 40.00 paid d2 12:00 (PayNow 3002).
- Ledgers (`EXPECTED_CONSIGNOR_LEDGER`): Kelvin owed 0.00, outstanding
  0.00, 1 active, 1 returned; Daniel liability 500.00, consignor charges
  45.00, owed 455.00, paid 0.00, outstanding 455.00; Chloe liability
  105.00 (3 sold, 3 left), paid 40.00 (the reversed 30.00 excluded),
  outstanding 65.00. Lines: `EXPECTED_SALE`. Daily consignment columns
  (`SEED_DAYS`): d5 1 / 140.00 / 70.00, d3 1 / 1000.00 / 500.00, d0 1 /
  70.00 / 35.00, other days 0. `tests/db/consignment-reporting.test.ts`
  proves them.

Phase 7 part (done): **purchasing, built through the RPCs.** A section
after the Phase 6 part of `supabase/seed.sql` (before Phase 8's print jobs
and Phase 10's Shopify part), run with `request.jwt.claims` naming Asha
Admin (reset to '' afterwards), so PO history, the `purchase_received`
movements and the supplier last costs are what the app writes. It runs after
the Phase 6 part and creates no products, units, bikes or customers, so
Phase 6's short IDs (P-000023 .. P-000026, U-000004 .. U-000006) are
unchanged: it uses Phase 4's products (`PRODUCT`) and the Shop floor
(`LOCATION.shopFloor`). Ids use the `d7` prefix
(`tests/fixtures/ids.ts`):

- Suppliers `d7000000-…-00000000000N` (`SUPPLIER`), inserted directly
  (suppliers have no create RPC; the app inserts them under RLS), dated
  −20d: `veloParts` Velo Parts Asia Pte Ltd (Kenneth Lim,
  sales@veloparts.test, +65 6123 4501, https://veloparts.test, account
  BICII-0042, "Order by Thursday noon for Monday delivery."), `tropicTyre`
  Tropic Tyre & Tube Co (Siti Rahman, orders@tropictyre.test, +65 6234
  5502, account TT-1187) and `oldSpoke` Old Spoke Trading (archived −15d;
  no links, no POs).
- Links (`set_supplier_product`, SKU, lead days, preferred): Velo Parts
  supplies the cassette, chainX11, chainLube, cableKit, hydraulicHose
  (preferred) and the GP5000 tyre (not preferred); Tropic Tyre the GP5000
  tyre and roadTube (preferred). The low-stock sealant has no supplier.
- POs `d7100000-…-00000000000N` (`PURCHASE_ORDER`, `PO_NUMBER`
  PO-000001…PO-000005 in creation order), lines
  `d7200000-…-0000000000NN` (`PURCHASE_ORDER_LINE`), receipt idempotency
  keys `d7300000-…-00000000000N` (`RECEIPT_KEY`). Every line's unit cost is
  the product's current cost:

| PO | Supplier | Lines (qty × cost) | Dates (d = shop days before the reset day, Singapore time) | State |
|---|---|---|---|---|
| PO-000001 | Velo Parts, ref SO-7702 | cassette 4 × 68.00 | expected d9; created d12 10:00, submitted d11 09:30, received d9 14:00 at the Shop floor (DN-5402) | received; cassette 3 → 7 |
| PO-000002 | Velo Parts, ref SO-7781 | chainX11 20 × 24.00, chainLube 10 × 7.00 | expected d1; created d6 10:00, submitted d5 09:30; one receipt d3 11:30, DN-5531: 18 chains + 10 lubes | partially received (SPEC §14: 20 ordered, 18 received, 2 outstanding), overdue; chainX11 8 → 26, chainLube 18 → 28 |
| PO-000003 | Tropic Tyre | gp5000Tyre 6 × 52.00 | expected in 3 days; created d2 10:00, submitted d2 10:20 | submitted, nothing received; 6 on order |
| PO-000004 | Velo Parts | cableKit 6 × 16.00, hydraulicHose 9 × 12.00 (their D66 suggestions) | created d1 09:00 | draft ("In draft PO-000004" on the reorder screen) |
| PO-000005 | Tropic Tyre | roadTube 20 × 3.80 | created d1 15:00, submitted d1 15:10, cancelled at seed time | cancelled, "Supplier out of stock until next quarter"; 20 cancelled |

On order after the seed (`reporting.product_on_order`): GP5000 tyre 6,
chainX11 2. Supplier last costs: Velo Parts cassette 68.00, chainX11
24.00, chainLube 7.00 (the receipts upsert the links).

Chronology (D64 D-RECEIPT-TIME): each PO is created and submitted through
the RPCs, then, BEFORE it is received, its `created_at` and `submitted_at`
are back-dated with a plain UPDATE as the owner (those columns write no PO
event; `pg_temp.seed_at`), and `receive_purchase` records the receipt with
its past `received_at`. The `purchase_received` movements keep seed time
(Phase 4's ledger is append-only with no effective date; their reason
carries the delivery date, e.g. "PO-000002 received 2 Oct 2026 11:30").
PO events are moved to the moment each stands for, so an order's History
agrees with its Details and Receipts: created at `created_at`, lines a
minute apart after it, submitted at `submitted_at`, received at the
receipt's `received_at` (its status change a second later); PO-000005's
cancellation stays at seed time. The append-only trigger is disabled for
that one seed-only UPDATE and re-enabled straight after
(`purchasing-seed.test.ts` checks the chronology).

Fences on the earlier phases: (1) every receipt cost equals the product's
current `default_direct_cost`, so D63 changes no cost and writes no
`cost_changed` event; (2) receipts touch only the cassette, chainX11 and
chainLube, none of them low stock or with an on-hand figure a test pins
(the brief's suggested brake pads for PO-000001 were swapped for the
cassette because `staff-search.test.ts` pins "34 in stock"), and each stays
above its reorder point, so `reporting.low_stock` still lists exactly
P-000008, P-000009 and P-000012 and Today and `tests/fixtures/reporting.ts`
are unchanged; (3) the draft's products are low-stock products no receipt
touches; (4) Phase 5's daily summary and Today count only
`job_consumption`, `reversal`, `stock_adjustment` and `damaged` movements,
never `purchase_received`. `tests/db/purchasing-seed.test.ts` checks the
state.

Phase 8 part (done, step 1): **print jobs**, after the Phase 7 part. The
built-in templates (`1ab00000-…`, `LABEL_TEMPLATE`) and printer profiles
(`a8000000-…`, `PRINTER_PROFILE`) come from the labels migration, not the
seed. Five jobs (`a9000000-…`, `PRINT_JOB` in `tests/fixtures/ids.ts`) are
inserted as the owner by `pg_temp.seed_print_job`, which builds the
content with `private.label_content` and the snapshots from the built-in
rows exactly as `create_print_job` does, so their QR payloads use the
seeded `public_site_url` `http://localhost:4000` (`SHOP.publicSiteUrl`, the
database QR base; E2E's `E2E_PUBLIC_SITE_URL` in
`tests/fixtures/public-site.ts` is the environment's scan-only base).
Times use `pg_temp.seed_at`. No product is published by the Phase 8 part
(publishing needs a public photo); tests build published fixtures in their
own transactions. Since Phase 10 the seed publishes exactly one product
(below), listed in `SEEDED_PUBLIC_PRODUCT_SHORT_IDS`.

- `productPrinted`: P-000011 bar tape × 10, browser, printed; requested
  and confirmed by Marcus (mechanic1); created d2 11:00, rendered 11:01,
  completed 11:02.
- `unitFailed`: U-000001 (the Colnago, bike B-000011) × 1, PDF, failed
  "Label roll ran out halfway through"; Asha (admin); d1 15:00.
- `unitReprint`: the same unit × 1, PDF, `reprint_of_id` = unitFailed,
  printed; Asha; d1 15:10.
- `bikeUnconfirmed`: B-000001 (Tan's Tarmac) tag × 1, browser, rendered and
  not confirmed; Nur (mechanic2); today 09:30.
- `productQueued`: P-000011 × 10, PDF, queued; Marcus; today 10:00 (E2E
  renders and downloads it read-only; nothing changes its status).

Phase 10 part (step 1): **Shopify**, at the very end of the seed (fixed
ids `d1000000-…`, exported from `tests/fixtures/ids.ts` as
`SHOPIFY_PRODUCT`, `SHOPIFY_PRODUCT_SHORT_ID`, `SHOPIFY_GID`,
`SHOPIFY_SETTINGS`, `SHOPIFY_WEBHOOK_ID`, `SHOPIFY_ORDER`). The seed runs
without a signed-in staff member, so it writes the settings, products,
stock, photo, Shopify ids and sync row directly as the owner (the products
as Phase 4's, with the admin in `request.jwt.claims`) and sends the
webhooks through the real service-role RPCs (`record_shopify_webhook`, then
`process_shopify_event`), as the webhook route will.

- `shopify_settings`: online location Shop floor, Shopify location
  `gid://shopify/Location/9300000001`, storefront
  `https://shop.bicii.example`, `accept_test_orders` true (dev/E2E only;
  production never runs the seed).
- Products P-000027 … P-000033, shop-owned, quantity-tracked, opening stock
  at the Shop floor 30 days back: `syncedTyre` (Pirelli P Zero Race,
  95.00 / 55.00, 12; the only PUBLIC seeded product, with one public product
  photo row that has no Storage object; linked to
  `gid://shopify/Product/9000000027` / `ProductVariant/9100000027`),
  `e2ePhone` / `e2eTablet` (20 each, journey 5), `e2eLinkPhone` /
  `e2eLinkTablet` (20 each, no ids; the unmapped-variant journey), `stack`
  and `stackExternal` (50 each; step 3's live-stack test).
- Webhooks: `seed-webhook-0001` orders/paid #1001, 1 × syncedTyre at 95.00,
  processed 8 shop days back at 14:20 (outside `SEED_DAYS` 0–6, so the
  daily fixtures are unchanged) → S-000005 (online, customer null, Shopify
  customer `7200000001`), one `online_sale` −1; `seed-webhook-0002`
  refunds/create 5.00 on #1001 → one `sale_refunds` row, S-000005
  `partially_refunded`, no movement; `seed-webhook-0003` orders/paid #1002
  for the unmapped variant `9199999999` "BICII cotton cap" → failed, its job
  `needs_attention` (one admin-only `integration_failed` exception, so an
  admin's `exceptions_now` is 4: `SEED_SNAPSHOT`); `seed-webhook-0004` a
  rejected delivery (`hmac_invalid`, no payload).
- Last, syncedTyre's sync row: published, `synced`, origin `bicii`, handle
  `bicii-p-000027`, inventory item `9200000027`, pushed a day ago at its
  on-hand (11) and selling price (95.00), `desired_hash` NULL so the first
  real sync pushes it once. The seed is one transaction and step 2's
  enqueue triggers are deferred to commit, so the seed fires them
  (`set constraints all immediate`) before inserting the row, while no
  product has one; they queue nothing, and any product-sync job is closed.
  syncedTyre's `public_items.buy_online_url` is
  `https://shop.bicii.example/products/bicii-p-000027`.
- `tests/db/shopify-webhooks.test.ts` "Seeded integration data is
  consistent" and `tests/db/shopify-sync.test.ts` "Seeded sync data is
  consistent" prove them.

## 19. Customer payments (Stripe)

Phase 14 (PLAN Phase 14, D150–D159, [ADR-025](decisions/ADR-025-stripe-payments.md)).
Step 1 is built in `20261014000300_payment_enum_values.sql` (the three
payment timeline types, in their own file) and
`20261014000400_stripe_payments.sql`: the tables, the guards, the apply
paths and the two service-role RPCs below, called by the Stripe adapter
and the signed webhook route (`src/lib/integrations/stripe/`). Step 2's
database is built in `20261014000500_indent_deposits.sql`: the deposit
setting and the quote snapshot, `quote_deposits` and the D152 gate (§5
"Indent deposits"), the views and the Checkout RPCs below, and the
exception kinds (§14). The quote page's deposit and Pay deposit (through
`prepare_deposit_checkout`, Stripe and `record_deposit_checkout`, in
`src/lib/integrations/stripe/checkout.ts`), Settings → Customer
payments (the deposit setting, Stripe's state, recent deliveries), the
job's Customer payments card and ordering without the deposit on screen
were built in step 2. The final review (2026-10-14) edited the step 1 and
2 files in place, as none had reached a hosted database: the PaymentIntent
read, `payment_refunds.status_changed_at`, `payment_issues` without a
definer helper and in screen money, the quote page's `parts_ordered`, and
two tighter checks in `record_deposit_checkout`. Step 3's database (PR A;
D154, D156, D161) is built in `20261014001200` to `20261014001500`:
counter payments and balance links (below, "Step 3"), the three replaced
views, and the payment reports (§14).

**Money held, not revenue (D154).** A payment is money the shop holds for
a job. It is not a branch of `financial_lines`, `report_lines` or
`daily_summary`; nothing here writes a job line, a sale, a total, a job
status or a completion stamp. The apply locks the job and appends
`work_order_events` only (`tests/db/stripe-payments.test.ts` "D154").

```
stripe_events   (every webhook delivery and every server read; admins only, D86)
  id uuid PK, source stripe_event_source (webhook | api_read)
  stripe_event_id text null      -- evt_…, verified webhooks only: the dedupe key
  event_type text (1..100)       -- the Stripe type; 'read.checkout.session' |
                                 --   'read.refund' | 'read.payment_intent' for a
                                 --   read; 'unknown' when rejected
  api_version (≤ 40), livemode boolean null, stripe_created_at (the event's created)
  object_type (≤ 60), object_id (≤ 255)   -- data.object.object / .id
  payload jsonb null             -- private.stripe_event_projection(): the allow-listed
                                 --   copy (D159e); null when rejected (D88)
  headers jsonb (capped: 16 lower-cased keys, ≤ 512 chars, 'x-bicii-truncated')
  body_sha256 (hex), body_bytes (≥ 0)     -- webhooks only
  rejection_reason stripe_rejection_reason null
     -- stripe_off | signature_invalid | signature_expired | body_not_json |
     --   event_shape_invalid | livemode_mismatch | not_recorded
  status stripe_event_status   -- received (only inside the recording transaction) |
                               --   applied | ignored | needs_attention | rejected
  outcome text null (the list below), payment_id null -> payments,
  work_order_id null -> work_orders, received_at, delivery_count (≥ 1),
  last_delivered_at, processed_at, correlation_id (≤ 128)
  checks: stripe_events_rejected_shape (rejected ⇔ a reason; a reason ⇒ a webhook
    with no payload, event id, outcome, payment or job), _event_id_shape (an event id
    ⇔ a verified webhook), _payload_check, _evidence_check (a webhook ⇔ sha and
    size), _decided_check (applied | ignored | needs_attention ⇔ outcome and
    processed_at), _outcome_check, and the length and format checks
  unique index stripe_events_event_id_key (stripe_event_id) where not null
                                 -- D88: a forgery never takes the key
  unique index stripe_events_rejected_body_key (rejection_reason, body_sha256)
    where rejection_reason is not null     -- one row per bad body
  -- stripe_events_guard (every role, the owner too): only delivery_count and
  --   last_delivered_at move; the decision columns once, while 'received';
  --   DELETE only of a rejected row under private.purge_stripe_events
  --   (stripe_event_immutable)
  -- stripe_events_settled, a DEFERRABLE INITIALLY DEFERRED constraint
  --   trigger (after insert or update, when the new status is 'received'):
  --   at commit, a row still 'received' refuses the commit
  --   (stripe_event_immutable), so no committed row can be cited later as
  --   the event being applied; SET CONSTRAINTS … IMMEDIATE only raises
  --   sooner

payments        (one row per Checkout session; active staff read it)
  id uuid PK                     -- generated before Checkout (step 2); also Stripe's
                                 --   client_reference_id, metadata[bicii_payment_id]
                                 --   and the Idempotency-Key suffix
  work_order_id -> work_orders, quote_id null -> quotes (deposit ⇔ a quote)
  kind payment_kind (deposit | balance)    -- balance: step 3 (D156)
  amount money_amount (0.50..999,999.99)   -- what BICII asked, computed in Postgres
  amount_cents bigint generated ((amount * 100)::bigint)
                                 -- Checkout's unit_amount and the match against
                                 --   amount_total (D158)
  currency char(3) = 'SGD'
  status payment_status          -- pending | paid | failed | expired |
                                 --   partially_refunded | refunded
  amount_received money_amount null       -- Stripe's amount_total / 100 when paid;
                                          --   null when not SGD or unreadable
  refunded_amount money_amount (private.payment_refund_total: succeeded refunds
                                 --   in the payment's currency and mode, D155, D159c)
  stripe_checkout_session_id (cs_test_… | cs_live_…, unique),
  stripe_session_expires_at, stripe_payment_intent_id null (pi_…), livemode
  checkout_completed_at, paid_at (Stripe's time, D159d), failed_at, expired_at,
  checked_at (the last server read)
  last_event_id null -> stripe_events     -- provenance
  created_at, updated_at
  balance_link_id null -> balance_links   -- step 3 (D156g): the link a balance
                                          --   payment was made from; set on insert
                                          --   only (payments_guard keeps it), no backfill
  checks: payments_kind_quote, _balance_link_kind (a link ⇒ kind balance),
    _amount_check, _currency_check, _paid_shape (the
    paid group ⇔ paid_at), _closed_shape (failed ⇒ failed_at, expired ⇒
    expired_at), the id formats; no refunded_amount ≤ amount check (an
    over-refund is recorded, never refused)
  unique index payments_one_open_deposit (quote_id) where deposit and pending
                                 -- D158d: one open Checkout per quote
  unique index payments_one_open_balance (work_order_id) where kind balance,
    pending and balance_link_id not null  -- D156g: one pending linked balance per job
  -- payments_guard (every role, the owner too): payment_immutable

payment_refunds (one row per Stripe Refund; matched rows: active staff;
                 unmatched rows: admins only)
  id uuid PK, stripe_refund_id (re_… | pyr_…, unique), stripe_payment_intent_id (pi_…)
  payment_id null -> payments    -- null until a payment carries the payment intent
  amount money_amount (> 0), currency (upper-case, as Stripe sent it)
  livemode boolean null          -- the mode of the event that first recorded it (a
                                 --   Refund object has none); null when a read did
  status stripe_refund_status
     -- pending | requires_action | succeeded | failed | canceled
  status_changed_at timestamptz (clock_timestamp() when the apply recorded
                                 --   the current status; linking an unmatched
                                 --   refund leaves it: payment_issues' refund_failed)
  reason (≤ 60), failure_reason (≤ 120), stripe_created_at (refund.created)
  last_event_id -> stripe_events, created_at, updated_at
  -- payment_refunds_guard (every role, the owner too): payment_refund_immutable
```

**Cents.** Stripe's amounts are integers in minor units. They are read by
`private.stripe_int`, which accepts only a JSON number of up to 12 digits
(never a float, a string or a negative number), and turned into money in
Postgres (`cents / 100`). TypeScript never computes money.

**The projection (D159e).** The stored copy of an object keeps `id, object,
livemode, status, payment_status, amount_total, amount, currency,
expires_at, created, client_reference_id, reason, failure_reason` when they
are scalars, `payment_intent` and `charge` as ids, and `metadata` keys
matching `^bicii_[a-z_]{1,32}$` with string values up to 100 characters.
Customer details, emails, addresses, `url`, `success_url` and `cancel_url`
are never stored. An event keeps its `id, type, livemode, created,
api_version` and the projected `data.object`. The apply reads the stored
projection, so what is stored is exactly what was applied.

**Provenance (D153, D159a).** Only Stripe's word moves a payment: a webhook
whose signature was verified on the raw bytes, or the server's own read
with the secret key. Staff and customers only trigger a read. The guards
apply to every role, including the owner:

- `payments_guard`: a payment starts pending (no Stripe-owned value on
  insert); it is never deleted; its job, quote, kind, amount, currency,
  session, expiry and mode never change; a Stripe-owned column (`status`,
  `amount_received`, `refunded_amount`, the four timestamps,
  `stripe_payment_intent_id`) changes only when the same UPDATE moves
  `last_event_id` to a `stripe_events` row in status `received` (the one
  being applied now). `checked_at` alone may change. A payment intent,
  once set, never changes. Status edges: pending to anything; failed or
  expired only into the paid group (Stripe's money wins); the paid group
  only within itself.
- `payment_refunds_guard`: never deleted; the amount, currency, mode,
  reason and dates never change; the payment is linked once; the status only moves up
  in rank, and `status_changed_at` moves only with it; every insert and
  change cites a `received` event.
- `stripe_events_guard` and the deferred `stripe_events_settled`: see the
  table above. Status `received` exists only inside the recording
  transaction, so citing it is proof that the event is being applied now
  (`tests/db/stripe-payments.test.ts` "A received event never outlives its
  transaction", with a committed transaction).

**Recording.** `record_stripe_event` stores a delivery and applies it in
one transaction. A rejected delivery is evidence only (D88). A verified
one is inserted `on conflict (stripe_event_id)`: a repeat only counts the
delivery and returns the stored decision. Any error (a bug, a lock
timeout, a serialisation failure) rolls the whole call back, so nothing
is stored, the route answers 500 and Stripe retries; a stored event is
never left unapplied. `record_stripe_read` stores an `api_read` row for
an object the server read (not deduplicated, so a repair read always
applies) and applies it the same way; a read of an id the payment does
not carry is `needs_attention` / `read_mismatch`. It takes a Checkout
Session, a Refund, or (Check with Stripe on a Checkout that completed
unpaid) a PaymentIntent, which must be the one the payment carries.

**Applying a PaymentIntent** (`private.apply_stripe_payment_intent`,
reads only; R-086). An asynchronous payment that fails leaves its session
`complete` and `unpaid`, the same shape as one still processing, so only
`async_payment_failed` or the PaymentIntent can say it failed. (1) Not a
`payment_intent` with a `pi_` id and one of Stripe's seven statuses:
`object_invalid`. (2) The advisory lock, the payment carrying the intent,
the job lock, the payment FOR UPDATE; another mode is
`livemode_mismatch`. (3) The paid group or expired: `stale`; failed:
`already_failed`; pending with Checkout not completed: `still_open`. (4)
Pending and completed: `requires_payment_method` or `canceled` → failed
(`failed_at`, citing the read: `payment_failed`, so the deposit is due
again); anything else is `already_processing` (paid stays the session's
word, for its `amount_total`).

**Applying a Checkout Session** (`private.apply_stripe_session`; it never
raises for Stripe data). (1) Not a `checkout.session` with a `cs_` id:
`needs_attention` / `object_invalid`. (2) No uuid in
`metadata.bicii_payment_id` or `client_reference_id`: `ignored` /
`not_ours`. (3) A malformed payment intent: `object_invalid`; otherwise
`private.lock_stripe_payment_intent(pi)`. (4) No such payment:
`payment_not_found`, needing attention only when Stripe says paid. (5) The
job lock, then the payment FOR UPDATE. (6) Identity, checked in this
order (the first failure wins; each needs attention and changes nothing):
another session id is `session_mismatch`; the object's boolean `livemode`
differing from the payment's is `livemode_mismatch`; a payment intent
differing from the one the payment already carries is
`session_mismatch`. (7) The target:
`async_payment_failed` → failed; `payment_status` paid → paid;
`no_payment_required` → `unexpected_payment_status`; status `expired` →
expired; `complete` (unpaid) → processing; `open` → open. (8) The
transition, one UPDATE citing the event:

| current \ target | paid | processing | failed | expired | open |
|---|---|---|---|---|---|
| pending, not completed | **→ paid**: `payment_paid`, or `paid_amount_mismatch` when `amount_received` differs from `amount` | set `checkout_completed_at` and the payment intent: `payment_processing` | **→ failed**: `payment_failed` | **→ expired**: `payment_expired` | `still_open` |
| pending, completed (processing) | **→ paid** | `already_processing` | **→ failed** | `stale` | `stale` |
| paid, partially_refunded, refunded | `already_paid` | `stale` | `stale` | `stale` | `stale` |
| failed | **→ paid**: `paid_after_failed` | `stale` | `already_failed` | `stale` | `stale` |
| expired | **→ paid**: `paid_after_expired` (`expired_at` kept) | `stale` | `stale` | `already_expired` | `stale` |

**→ paid** adopts refunds that arrived first (`payment_refunds` with this
payment intent and no payment), sums the ones that count
(`private.payment_refund_total`, below), and in one
UPDATE sets the paid-group status, `paid_at` (the event's `created`, or the
read time, D159d), `amount_received` (Stripe's cents / 100 when the
currency is SGD, else null), `refunded_amount`, the payment intent and
`checkout_completed_at`. Then `payment_received` `{payment_id, kind,
quote_id, amount, asked, currency}` and, when refunds were adopted,
`payment_refunded`. A cancelled or closed job, cancelled parts, a second
paid deposit and an amount or currency mismatch are all recorded as paid
(D159b); step 2's `payment_issues` flags them.

**Applying a Refund** (`private.apply_stripe_refund`). (1) Not a `refund`
with a `re_` or `pyr_` id, one of the five statuses, an integer amount of
1 to 99,999,999,999 and a three-letter currency: `object_invalid`. (2) No
payment intent: `ignored` / `not_ours` (not BICII's Checkout); otherwise
the advisory lock. (3) The payment carrying the intent, then the job lock
and the payment FOR UPDATE. (4) The refund row FOR UPDATE: inserted at
first sight (amount, currency, the event's `livemode` and `created`
fixed), or moved to a higher rank, or linked to the payment. (5) No
payment: `ignored` / `refund_unmatched` (the row waits). (6)
`private.settle_payment`. (7) Mode and currency: when the event's
`livemode` (a webhook's; a read's is null for a Refund) or the row's stored
`livemode` differs from the payment's, `needs_attention` /
`livemode_mismatch`; else when the row's currency is not the payment's
(`SGD`), `needs_attention` / `currency_mismatch`. The row is kept and
linked to the payment but never netted, on this event and every later
one. A mismatched refund that arrived before its payment is adopted by the
completion without a flag on that event, so step 2's `payment_issues`
also lists linked refunds whose currency or mode differs from the
payment's (`refund_not_counted`, below).
(8) Otherwise `refund_recorded` when the row or the payment changed,
else `refund_unchanged`.

**Refund ranks.** pending 0 < requires_action 1 < succeeded 2 < failed =
canceled 3. A row moves only to a higher rank, so succeeded → failed (a
PayNow refund that fails after succeeding) is allowed and nothing leaves
rank 3. `settle_payment` is a pure function of the payment's refund rows:
`refunded_amount` is `private.payment_refund_total(payment)`, the sum of
its succeeded refunds whose currency equals the payment's and whose
`livemode` is null or the payment's (the same function the → paid path
uses), and the status is paid
(0), partially_refunded (below `coalesce(amount_received, amount)`) or
refunded. A rise records `payment_refunded` `{payment_id, kind, refunded,
refunded_total, currency, full}`; a fall `payment_refund_failed`
`{payment_id, kind, amount, refunded_total, currency}`.

| Refund event or read | The row | The payment (only in the paid group) |
|---|---|---|
| `refund.created` (pending) | inserted pending | none (only succeeded refunds count) |
| `refund.updated` (succeeded), even before `created` | → succeeded; a later pending is a lower rank: `refund_unchanged` | `refunded_amount` rises; partially_refunded or refunded; `payment_refunded` |
| `refund.failed` from pending | → failed | none |
| `refund.failed` after succeeded | → failed | `refunded_amount` falls; back to paid or partially_refunded; `payment_refund_failed` |
| succeeded after failed (a stale snapshot) | unchanged (rank) | none |
| canceled | → canceled | as failed |

Other event types (`charge.refunded`, `charge.dispute.*`, …) are stored as
a projection and `ignored` / `type_not_handled`: `charge.refunded` carries
only a running total, and disputes are a known gap (D159f, R-089).

**Duplicates and out-of-order delivery** (each row is a test in
`tests/db/stripe-payments.test.ts`):

| Situation | Result |
|---|---|
| The same `evt_` twice | The second is `duplicate`, `delivery_count` 2, nothing applied again |
| Two Event objects for one change | The second is `already_paid` (or `already_*`, `refund_unchanged`); no second timeline entry |
| `async_payment_succeeded` before `completed` (unpaid) | paid, then `stale` |
| `expired` after paid | `stale` |
| `completed` (unpaid), then `async_payment_failed` | processing, then failed |
| `async_payment_failed`, then `completed` (unpaid) | failed, then `stale` |
| `completed` (unpaid), `async_payment_failed` lost, then *Check with Stripe* | the session read stays `already_processing`; the PaymentIntent read (`requires_payment_method` or `canceled`) moves it to failed (R-086) |
| A refund before `checkout.session.completed` | stored unmatched (`refund_unmatched`); the completion adopts it in the same UPDATE and records both timeline entries |
| A webhook and a read of the same session at once | serialised by the advisory lock, then the job lock; the second is `already_paid` |

**Lock order.** (1) The `stripe_events` row, inserted with no FK value set,
so it locks no job (a concurrent duplicate waits on the unique index
only). (2) `private.lock_stripe_payment_intent(pi)`, a transaction
advisory lock (`hashtextextended('bicii.stripe.payment_intent:' || pi)`),
taken only on the apply paths and always before the job. (3)
`private.lock_work_order(job)`. (4) The `payments` row FOR UPDATE (step 2:
the quote FOR UPDATE before it). (5) `payment_refunds` rows, then
`work_order_events` inserts, then the `stripe_events` decision UPDATE,
whose FK KEY SHARE locks come after the FOR UPDATEs. `record_stripe_read`
takes the job lock without the advisory lock only on its mismatch path, and
no advisory lock after it.

**Purge.** `private.purge_stripe_events(older_than)` (owner only, by hand,
at least 30 days) deletes rejected deliveries last delivered before then.
Verified events and reads hold no personal data and are kept.

**Starting Checkout (step 2; service role only, anon gains nothing).** The
quote page reaches the database's payment side only through
`src/lib/integrations/stripe/`. `prepare_deposit_checkout(token)` takes no
locks and decides what Pay does: `create` (a fresh payment id, the amount
and its cents computed in Postgres, an expiry 60 minutes ahead as Unix
seconds), `check` (the one pending deposit payment, to re-read at Stripe),
or `paid`, `refunded` or `processing`; it refuses `quote_not_found`,
`deposit_not_due`, `deposit_parts_cancelled` and `deposit_job_closed`.
`record_deposit_checkout(p_payment_id, p_quote_id, session)` records the
session Stripe has just created: under the job lock, then the quote FOR
UPDATE, it re-checks the deposit, answers `existing` for a replay (the
same payment id, session and quote; anything else for a known payment id
is `checkout_session_conflict`) or when another attempt won
(`payments_one_open_deposit` backs it), refuses an echo that does not
match what was asked (`checkout_session_mismatch`: object, `cs_` id,
open, `amount_total` in cents, `sgd`, the `bicii_*` metadata,
`client_reference_id`, a boolean `livemode`, an `expires_at` in the
future and at most 61 minutes ahead) and inserts the pending payment
(`created`). It writes no
timeline entry (anon can repeat it); only Stripe's data moves the row
afterwards (the step 1 guard).

**The views (step 2; security invoker, staff through RLS, customers 0
rows, anon no grant).**

- `quote_deposits`: §5 "Indent deposits" (a live counter deposit counts
  as paid since step 3, with `counter_payment_id` appended).
- `payment_issues` (D159b): the payment conditions needing an admin or
  manager, derived live and never stored, so each clears when its cause
  clears. Columns `payment_id, work_order_id, quote_id, issue, severity,
  since, message`; the message is the sentence the job card and
  Exceptions show, money as the screens print it (`$1,234.50`, formatted
  in SQL with `to_char`; payments are SGD only). Issues
  (danger unless stated): `paid_job_cancelled` (paid or partly refunded,
  the job cancelled), `paid_parts_cancelled` (a deposit paid or partly
  refunded, the job not cancelled, no approved part of its quote still
  approved, ordered or fitted), `paid_parts_not_fitted` (since
  `20261014000700`, R-082, D149: a deposit paid or partly refunded whose
  quote has an approved part still approved or ordered (since D160 also
  one whose fitted line was voided, which goes back to one of them), on a completed,
  ready or collected job, while what it holds is more than its fitted
  parts' share; dated from the later of the completion and the payment;
  "$… is held for parts that are not on this job. Reopen the job to fit
  them, or cancel them and refund in Stripe." while completed or ready,
  "$… is held for parts that never went on this job. Cancel them and
  refund in Stripe, or agree with the customer how it counts." once
  collected. When some of the quote's approved parts were fitted (or more
  was received than asked) the sentence names the unfitted share second:
  "$120.00 is held; $60.00 of it is for parts that are not on this job. …
  refund that share in Stripe." (or "…that never went on this job…"). The
  share, computed in the view: the net held, no more than was asked, less
  the fitted approved parts' share at the quote's percent rounded as the
  deposit was (`round(sum(line_total) × deposit_percent / 100, 2)`), never
  negative, so a refund is taken from the unfitted share first. It clears
  when the part is fitted after a reopen, or cancelled
  (`paid_parts_cancelled` takes over if no approved part is left), or when
  refunds leave nothing beyond the fitted parts' share; a cancelled job
  has `paid_job_cancelled` instead; it is per payment, so with two paid
  quotes only the one with an unfitted part is flagged), `paid_twice` (a later second paid deposit
  of the same quote), `amount_mismatch` (paid, `amount_received` not the
  amount asked, or null: another currency), `refund_failed` (not fully
  refunded, and the counted refund whose outcome Stripe reported last
  failed: a failure stands until a later refund succeeds; ordered by each
  refund's `status_changed_at`, so refunds decided before the completion
  adopted them keep their order; read through `payment_refunds`' RLS, with
  no definer helper), `refund_not_counted` (a linked refund, not failed or canceled, in
  another currency or mode than the payment), `refund_exceeds_payment`
  (`refunded_amount` above what was received) and `pending_unconfirmed`
  (warning: still pending 15 minutes after the session expired; "Press
  Check with Stripe" before Checkout completed, and after it also "look
  the payment up in the Stripe Dashboard"). Replaced in `20261014001300`
  (D161j), the columns kept and `counter_payment_id` appended (null on a
  Stripe row), with four issues, all danger: `paid_online_and_counter` (on
  the Stripe deposit row: the quote's deposit is paid online and also has
  a live counter deposit), counter `paid_job_cancelled` (no `payment_id`;
  a live counter payment on a cancelled job, since it was received),
  counter `paid_parts_cancelled` (a live counter deposit whose quote has
  no approved part still approved, ordered or fitted, the job not
  cancelled) and `paid_above_bill` (a completed, ready or collected job
  holding at least S$0.50 above its bill, on its newest paid-group Stripe
  payment or, without one, its newest live counter payment; only when the
  job has a paid-group balance payment or a live counter payment, so a
  database with neither reads as before; left out beside `paid_twice`,
  `paid_online_and_counter` or a deposit held for cancelled parts
  (`paid_parts_cancelled`, Stripe or counter) or for parts not fitted
  (`paid_parts_not_fitted`), which name the same money and ask for its
  refund; once that deposit is refunded or voided, what is still above
  the bill shows). No counter version of
  `paid_parts_not_fitted`: since D149b a job cannot close while a part is
  approved or ordered, and counter deposits start after that guard. Every row still reaches Exceptions as
  `payment_attention` (admins and managers), unchanged; voiding a counter
  payment is an admin's (R-090).
- `work_order_payment_totals` (D154): per job (a row for every job since
  `20261014001300`; before it only jobs with a payment), `paid_online`
  (Stripe's amounts of the paid group), `refunded_online`,
  `net_paid_online`, `job_total` (the live-lines sale total, as
  `work_order_totals`), and while the job is not collected or cancelled
  and in SGD, `balance_due` and `paid_ahead`, never negative (null
  otherwise: money taken at collection need not be recorded, D161e); then,
  appended by `20261014000700` (R-082), `held_over_total`: net paid above
  `job_total` in every status (SGD only, never negative), so a collected
  or cancelled job still shows what was taken beyond its bill; then,
  appended by `20261014001300` (D161j), `paid_at_counter` (live counter
  payments), `net_paid` (`net_paid_online` + `paid_at_counter`, which
  `balance_due`, `paid_ahead` and `held_over_total` now use) and
  `processing_online` (Stripe payments completed but still being
  confirmed; in neither `net_paid` nor `balance_due`). Indent parts join
  the job total only once fitted (D140), so a paid deposit usually shows
  as paid ahead. `report_payments_held` reads it (§14), and so do the job
  card, the balance link and its page, so they agree. The card shows its
  totals only once the job has a Stripe payment or a live counter payment
  (PR A's one app change).

**Lock order, step 2.** `record_deposit_checkout`: the job
(`private.lock_work_order`), the quote FOR UPDATE, then the payment insert,
whose FK KEY SHARE locks come after those FOR UPDATEs.
`prepare_deposit_checkout` takes none. `order_part_requests` reads
`quote_deposits` (so `payments`) under the job locks it already holds;
`answer_quote`, `cancel_part_request`, `order_part_requests` and
`fit_part_request` take job locks and never a Stripe advisory lock;
`20261014000700` keeps that order (§5 "Indent parts on completed and
closed jobs").

**Step 3 (PR A; D156, D161; `20261014001300`, `20261014001400`).**
Counter payments are kept out of `payments`, so D153's provenance for
Stripe rows is untouched; they follow consignor settlements (a
client-chosen id with a fingerprint, append-only, a separate void row).

```
counter_payments       (D161c; money the shop took itself, an admin's record)
  id uuid PK (client-chosen; replay key), work_order_id -> work_orders,
  quote_id null -> quotes, kind payment_kind (deposit ⇔ a quote:
    counter_payments_kind_quote), amount money_amount (> 0, ≤ 999,999.99),
  currency char(3) = 'SGD', method counter_payment_method
    (cash | card | paynow | bank_transfer | other),
  received_at (business time), reference (≤ 200) null, note (≤ 2,000) null,
  request_fingerprint (never granted), recorded_by -> staff,
  created_at (clock time of the call)
  indexes: (work_order_id, received_at), (received_at), (quote_id) where set,
    (recorded_by)
  -- counter_payment_immutable (every role, the owner too): no UPDATE or
  --   DELETE; an INSERT of a deposit whose quote is not on the job refused

counter_payment_voids  (D161d; the only correction, one per payment)
  counter_payment_id PK -> counter_payments,
  kind counter_void_kind (recorded_in_error | given_back),
  reason (1..500), voided_by -> staff, voided_at
  indexes: (voided_at), (voided_by); append-only as above

balance_links          (D156c; a bearer link to pay a job's balance)
  id uuid PK (client-chosen; a used id is refused, never replayed),
  work_order_id -> work_orders, token_hash bytea (32 bytes, unique, never
    granted: SHA-256 of a 43-character base64url token, quote_token_hash's
    format), channel quote_channel, valid_days (1..30, 7), expires_at,
  amount_at_send money_amount (0.50..999,999.99; the staff record only),
  sent_by -> staff, created_at, withdrawn_at null,
  withdrawn_reason null (replaced | reopened | collected; with withdrawn_at),
  replaced_by null -> balance_links (DEFERRABLE INITIALLY DEFERRED; exactly
    when the reason is replaced)
  unique index balance_links_one_live (work_order_id) where not withdrawn
  -- balance_links_guard (every role): no DELETE; on UPDATE only the three
  --   withdrawal columns, each from null to a value, once
  --   (balance_link_immutable)
  -- work_orders_withdraw_balance_link (AFTER UPDATE OF status on
  --   work_orders): leaving completed or ready_for_collection for any other
  --   status withdraws the live link (reopened, or collected) and records
  --   balance_link_withdrawn; completed to ready keeps it
```

- **Access.** Staff read all three tables (`private.is_staff()`), without
  `request_fingerprint` and `token_hash`; customers and anon read nothing;
  no API role writes; the service role reads neither counter table. Only
  an active admin records or voids (D161a); any active staff member sends
  a link (D156e); the link page is `balance_by_token` (anon and signed
  in), and its Checkout runs through the service-role
  `prepare_balance_checkout` and `record_balance_checkout`, called only
  from `src/lib/integrations/stripe/` (PR B).
- **Timeline.** `counter_payment_recorded`, `counter_payment_voided`,
  `balance_link_sent` and `balance_link_withdrawn` carry amounts, methods,
  kinds, the link's channel and validity and the void's reason, never a
  reference, note, token or cost; the customer timeline's whitelist
  leaves them out.
- **The balance invariant (D156g).** A live (unexpired, Checkout not
  completed) or processing balance payment never sits beside any other
  live or processing Stripe payment on the same job, and a job has at most
  one pending linked balance payment (`payments_one_open_balance`). A row
  past its expiry whose answer from Stripe is not yet recorded does not
  block the other kind; a session paid just before it expired is R-092's
  accepted case, recorded by D159b and flagged `paid_above_bill`.
  `record_balance_checkout` checks it under the job lock and answers
  `existing`; `prepare_balance_checkout` answers `processing` or
  `replace`; `prepare_deposit_checkout` answers `job_payment_processing`
  (a balance payment being confirmed: nothing to create, try again
  shortly) or `replace` (a live one), and `record_deposit_checkout`
  answers `existing` for either. A session already open at Stripe can
  still be paid until it expires; what Stripe confirms is recorded (D159b)
  and flagged (`paid_above_bill`, `paid_online_and_counter`;
  [R-092](RISKS.md#r-092--open-checkout-tabs-can-still-be-paid-for-up-to-60-minutes)).
- **The live balance (D156b).** `work_order_totals.sale_total` less
  `net_paid`, in numeric, at every send, page read, prepare and record;
  `amount_at_send` is never used to charge.
- **Lock order, step 3.** The job (`private.lock_work_order`) first, then
  the quote (a counter deposit, by id and job together, so another job's
  quote is never locked) or the link (`record_balance_checkout`), then the
  payment or counter row, then the timeline. `record_counter_payment`:
  lock the job, answer a replay, lock the quote, check, insert;
  `void_counter_payment`: the job, then the counter row FOR UPDATE;
  `send_balance_link`: the job, then the used-id check, the old link's
  withdrawal and the insert; `record_balance_checkout`: the job, then the
  link FOR UPDATE, then the payment insert. The AFTER UPDATE OF status
  trigger `work_orders_withdraw_balance_link` withdraws the live link
  under the `work_orders` row lock of the status UPDATE, after whatever
  that path already holds, which is safe because every other
  `balance_links` writer takes the job lock first (§7). None takes the
  Stripe advisory lock, and
  `prepare_balance_checkout` takes no lock. The D152 gate reads
  `quote_deposits`, and so the counter tables, under the job locks it
  already holds.
