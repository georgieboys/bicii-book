# ADR-020: Shopify integration

Date: 2026-10-06 (Phase 10, `feat/p10-shopify`). Status: per row below;
D80–D88 are "Accepted: build default, owner to confirm"; D89's tax basis
and Shopify POS points are OPEN for the owner. Decision owner: Abhishek
Cherian George (owner) for business meaning; defaults proposed by the build
agent and the orchestrator's Phase 10 brief. Numbering: the orchestrator's
allocation of 2026-10-06 gives Phase 10 exactly D80–D89 and this record;
the brief's fifteen working labels are merged into these ten rows
(RECOGNITION into D80, CATALOG into D84, CUSTOMER into D86, RETENTION into
D88, TAX and TEST into D89). Applies D7 to online refunds
([ADR-014](ADR-014-defaults-for-unbuilt-phases.md)).

Status update 2026-10-06 (the merge of `main` into `feat/p10-shopify`):
D86 reads unchanged under the staff roles
([ADR-021](ADR-021-staff-roles.md), D91). "Admin" in D86 is the role
`admin` (`private.is_admin()` / `require_admin()`, which the roles kept
for admin-only things): a manager is not an admin, so the Shopify
screens, the queue, the event inspector, the links and the settings stay
admin-only; a manager holds `manage_inventory` by role, so Publish online,
Sync now and product-sync retries are a manager's too; a mechanic needs
`manage_inventory` as extra access for them. The service role's allow-list
gained `note_sign_in_attempt` (email sign-in, D72) beside the Shopify
RPCs. No Shopify migration, RPC or test changed in the merge.

Status update 2026-10-06 (Phase 10 step 1): the inbound database side of
D80, D82, D85–D89 is built and tested
(`supabase/migrations/20261004003900_shopify_integration.sql`,
`20261004004000_shopify_order_processing.sql`,
`tests/db/shopify-webhooks.test.ts`): webhook recording, the queue, order
and refund processing through Phase 6's `private.sell_line`, the
retry/dismiss/link RPCs and the admin-only `integration_failed` exception.
Step 2 builds the outbound sync's database side (D81's sync side, D83,
D84's publish rules and `buy_online_url`) in
`20261004004100_shopify_product_sync.sql`, tested by
`tests/db/shopify-sync.test.ts`; the service layer is step 3; the screens
step 4.

Status update 2026-10-06 (Phase 10 step 3): the service layer is built
(`src/lib/integrations/shopify/`, the routes `api/shopify/webhooks` and
`api/cron/integrations`, `vercel.json`) and tested against a mocked fetch,
an in-memory fake Shopify and, end to end, the live devstack
(`tests/db/shopify.stack.test.ts`). No new business decision: the step
implements D83, D84, D87 and D88 in TypeScript where the database cannot
(the HMAC, the Shopify calls, the per-instance rejected limit, the cron).
Its design choices are below ("Service layer").

Status update 2026-10-06 (Phase 10 step 4, built): the screens are built
and the phase is complete on `feat/p10-shopify`: the product page's Online
card (D84, D86), the admin-only `/shopify` overview and settings, queue
(retry, link a variant then retry, dismiss with a reason), products and
events with the inspector and the customer link (D86), and Today's
`integration_failed` row opening the queue. No new decision; the app runs
only the job id an RPC returned. E2E journey 5 (`tests/e2e/shopify.spec.ts`)
proves the replay rule, the unmapped-variant link, the rejected delivery
and the refund on phone and iPad. D80–D88 remain "build default, owner to
confirm"; D89's tax basis and Shopify POS points remain OPEN.

## Context

SPEC §17 asks for Shopify as the online channel: BICII is the operational
truth for products, stock and sales; webhooks are verified, stored and
processed idempotently (a replay has one business effect, SPEC §23); an
unmapped variant goes to a visible retry queue with nothing partial (SPEC
§17.1, §26); refunds are recorded (D7 decided they are financial only);
customers link to Shopify customers only by a durable id, a matching email
being a candidate (SPEC §17.2). The brief does not say what price an
online line carries when Shopify discounts it, when an online sale is
recognised, how a unique bike is represented online, what happens when the
ledger cannot fulfil a paid order, which stock is online, what a refund
records when it includes shipping, who may administer the integration,
how retries work, what is kept of a delivery that fails verification, or
how tax, test and POS orders are treated.

Phase 6 already built the one sale-line writer (`private.sell_line`), the
refund cap and status rule (`record_sale_refund`, D49) and a reporting
rule that nets no refund (D49). Those are reused unchanged in meaning.

## Decision and rationale

| D | Rule (short) | Status | Implemented in |
|---|---|---|---|
| D80 SHOP-PRICE | An online line's price = Shopify line price × effective quantity − the line's discount allocations, in shop money, split exactly so Σ sale_total = Shopify's discounted line totals (uneven quantity → two lines, parts 1 and 2; unique units one line each, the last absorbing the remainder); 0 is a price; shipping, tips, duties and order adjustments are not lines; `recognized_at` = the payload's `processed_at`, else X-Shopify-Triggered-At, else `received_at`; the rate follows `recognized_at` | Accepted: build default, owner to confirm | `private.shopify_split_amount`, `process_shopify_order_paid` (step 1) |
| D81 SHOP-UNIQUE | A unique product is one Shopify variant; online quantity = available, non-customer-owned, non-archived units at the online location; price = `private.selling_price` of the oldest such unit (D58); sync refuses when such units' prices differ; orders sell the oldest available unit(s) | Accepted: build default, owner to confirm | Orders: `process_shopify_order_paid` (step 1); sync: step 2 |
| D82 SHOP-STOCK | When the ledger cannot fulfil a paid order (no unit, on-hand below the quantity at the online location, no single consignment covering a consigned quantity line, a NULL cost, any `sell_line` refusal) nothing is recorded; the event needs attention with a human reason; staff fix and retry, or refund in Shopify and dismiss with a reason | Accepted: build default, owner to confirm | `process_shopify_order_paid`'s subtransaction and failure branch (step 1) |
| D83 SHOP-LOCATION | One online BICII location mapped to one Shopify location; BICII pushes its absolute ledger quantity, defers while an order is in flight, pushes with a compare quantity and overwrites a moved count after one 2-minute deferral | Accepted: build default, owner to confirm | `shopify_settings.online_location_id` (step 1); the push is step 2–3 |
| D84 SHOP-PUBLISH | Publish online needs public, a selling price, not archived, not customer-owned; only BICII-created Shopify products get the full productSet and are drafted at 0 when unpublished; products linked to Shopify-made products get price and inventory only and no Buy-online link; `products.shopify_product_id` not unique, `shopify_variant_id` unique; `buy_online_url` only when available, published online, synced, with a handle and a storefront URL, and only on the row Shopify sells (the unit an online order takes; a product row whose price is the online price) | Accepted: build default, owner to confirm | Columns, constraints and `link_shopify_variant` (step 1); publishing and `buy_online_url` step 2 |
| D85 SHOP-REFUND | One `sale_refunds` row = the line-attributable refund, never above the money refunded, capped at the remaining total; shipping and excess in the event result; status as `record_sale_refund`; reports net nothing (D49); stock, units, consignment and lines never change (D7); netting and claw-back stay owner question 12 / R-021 for Phase 9; `orders/cancelled` not subscribed | Accepted: build default, owner to confirm | `process_shopify_refund`, `private.shopify_refund_line_amount` (step 1) |
| D86 SHOP-ACCESS | Integration administration (inspector, queue, dismiss, links, settings, integration exception rows) admin-only (payloads hold PII); `manage_inventory` publishes, syncs and retries product-sync jobs; all staff see sync status; customers linked only by an admin with a reason, never by email; a link applies to later orders | Accepted: build default, owner to confirm | RLS and RPC guards, `link_shopify_customer`, `private.integration_exceptions` (step 1) |
| D87 SHOP-RETRY | Transient failures back off 1 minute doubling to 6 hours, at most 8 attempts, then needs attention; business failures need attention at once; a waiting refund re-queues when its order lands and closes when the order is dismissed; recording an order closes its other open deliveries (`duplicate_order`); a dismissal is final for the order or refund (its other deliveries close with it, a later delivery under any webhook id is `earlier_delivery_skipped`); a 5-minute cron behind `CRON_SECRET` plus a few due jobs after each webhook, each runner claiming a job only while its worst case fits `maxDuration` | Accepted: build default, owner to confirm | `private.integration_backoff`, `claim_integration_jobs`, the processors and `dismiss_integration_job` (step 1); cron and route step 3 |
| D88 SHOP-REJECTED | Rejected deliveries kept as evidence (capped headers, size, SHA-256; never the body), never in the dedupe key, one row per bad body with a count; not stored above 30/min/instance; 413 over 1 MiB; purged only by the owner-only `private.purge_integration_events` (≥ 30 days), never failed or pending events, no cron | Accepted: build default, owner to confirm | `record_shopify_webhook`, `integration_events` constraints and immutability trigger, the purge function (step 1); rate limit and 413 in the route (step 3) |
| D89 SHOP-TAX-TEST | Tax-inclusive prices recorded when `taxes_included`; tax-exclusive orders with tax refused; test deliveries stored but skipped unless `accept_test_orders` (admin + reason + audit; dev/E2E seed only); `source_name` 'pos' orders skipped | OPEN for the owner: tax basis and Shopify POS ([PRODUCT questions 23 and 24](../PRODUCT.md#open-assumptions-and-owner-questions)); the rest accepted | `process_shopify_order_paid`, `record_shopify_webhook` (step 1) |

Full text: [PLAN §6](../PLAN.md#6-open-decisions-for-the-owner).

Rationale:

- D80: Shopify charged the customer the discounted line total; recording
  anything else would make BICII's sales disagree with the money received.
  Splitting the remainder onto one line keeps every line's price a cent
  amount and the sale total exact. The order's `processed_at` is the same
  in every delivery, so a replay can never move a sale to another day
  (inferred from Shopify's documented payload; verified in Step 3 against a
  real store before go-live).
- D81: the oldest unit sells first because it has waited longest
  (inferred); one price function keeps the label, the public page, the
  in-store default and Shopify in agreement (D58).
- D82: a sale never takes stock below zero outside job parts (D23) and a
  unit never sells twice (SPEC §23); recording part of an order would be
  wrong in a way staff cannot see, so the whole order waits for a person.
- D83: BICII is the stock truth (SPEC §17); one location keeps the mapping
  explainable to staff.
- D84: pushing a full product into a product someone built in Shopify
  would overwrite their work; linking a variant is a mapping only. The
  Buy-online link sits only on a row whose item and price are what the
  link sells (D58/D81): another unit of a unique product, or a product
  row showing a different price, would sell a different bike or charge
  another price than the page shows.
- D85: D7 and D49 already decide that a refund is a financial fact capped
  at the sale; shipping was never a sale line, so its refund cannot be
  either.
- D86: payloads hold names, addresses and emails of customers; only admins
  read them. A matching email is not proof of identity (SPEC §17.2), and a
  recorded sale is immutable (Phase 6), so a link cannot rewrite history.
- D87: transient failures (a network error, a refund before its order)
  resolve themselves; business failures do not, and retrying them only
  hides them. An admin dismisses an order after refunding it in Shopify
  or recording it by hand, so recording it later would count it twice:
  a dismissal is final, and a replay has one business effect whatever
  its webhook id.
- D88: a delivery that fails verification may be an attack or a
  misconfiguration; its evidence is useful, its body is not trustworthy and
  may be large.
- D89: BICII never invents or drops tax; the owner must confirm the store's
  configuration before go-live.

### Service layer (step 3)

- One `ShopifyAdmin` interface (`admin.ts`) with two implementations: the
  live GraphQL adapter at the pinned `SHOPIFY_API_VERSION` and an
  in-memory fake with the seed's deterministic ids. `SHOPIFY_ADAPTER=fake`
  selects the fake; env.ts refuses it in production and together with a
  live token. Every runner receives its dependencies (`IntegrationDeps`),
  so unit tests stub the RPCs and the stack test brings its own fake.
- The webhook route stores before it answers and processes after it
  answers (`after()`): its own event's job by id, then a few due jobs; the
  Vercel cron runs the rest every 5 minutes behind `CRON_SECRET` (D87).
  The HMAC is checked on the raw bytes before parsing; rejected deliveries
  are counted by an in-process sliding window (D88,
  [R-048](../RISKS.md#r-048--the-rejected-delivery-limit-is-per-server-instance)).
- The sync is hash-driven: no Shopify call when the desired state (which
  includes the location and the API version) equals the last push.
  Problems (no price, a unit priced differently) block a product only
  while it is meant to be live, so unpublishing always drafts it or sets
  its quantity to 0.
- The inventory write's idempotency key is a UUID-shaped SHA-256 of the
  inventory item, desired hash, job id and phase (compare or overwrite),
  not `${productId}:${hash}`: with the brief's key, a Sync now or the
  overwrite after a moved count would repeat a key Shopify had already
  applied and be replayed instead of applied.
- Unverified against a real store (field names, error codes, the
  idempotency directive):
  [R-047](../RISKS.md#r-047--the-live-shopify-adapter-is-unverified-against-a-real-store)
  and [RUNBOOK "Verify before go-live"](../RUNBOOK.md#shopify-verify-before-go-live).

## Alternatives actually considered

| Option | Why chosen or rejected |
|---|---|
| Record the catalogue selling price on online lines | Rejected: disagrees with what Shopify charged after discounts |
| Spread a line's remainder one cent at a time over several lines | Rejected: more lines for no gain; one remainder line keeps Σ exact |
| `recognized_at` = processing time | Rejected: a retried or replayed order would land on a later day |
| Sell what is available and leave the rest for later (partial orders) | Rejected: partial records hide the problem (SPEC §17.1 "nothing partial") |
| Allow online sales to take stock below zero (as job parts may, D23) | Rejected: D23 covers parts that were physically used; an online order is a promise, not a fact |
| A second sale-line writer for online lines (`private.write_sale_line`) | Rejected: one writer keeps the economics identical; `sell_line` is extended only to persist `shopify_line_part` |
| Link Shopify customers by email automatically | Rejected: SPEC §17.2; emails are shared and change |
| Backfill `customer_id` on earlier online sales after a link | Rejected: sales are immutable except status (Phase 6, `sales_enforce_rules`) |
| Net refunds in reports now | Not decided here: owner question 12 / R-021 belong to Phase 9 (D100–D119), for retail and online together |
| Store rejected bodies | Rejected: untrusted, possibly large, possibly PII; the hash and size identify a repeat |
| A purge cron | Rejected for the MVP: deletion of evidence stays a deliberate owner action |
| Enqueue product syncs from an immediate, statement-level trigger on `inventory_movements` | Rejected in step 2: a sale writes its movements before `refresh_unique_publication` locks the product, so taking the sync row there inverts the lock order against a product edit or `set_publish_online` (deadlock); deferred constraint triggers run at commit, after every business lock |
| Store the online price on the sync row | Rejected: a second price would drift from the label and public page; `private.shopify_online_price` derives it from `private.selling_price` (D58) every time |
| Process webhooks synchronously before answering Shopify | Rejected in step 3: Shopify expects a fast answer and retries slow ones; storing first and processing in `after()` keeps one business effect per delivery either way |
| A Shopify SDK (`@shopify/shopify-api`) | Rejected in step 3: four GraphQL calls and an HMAC do not justify the dependency; plain `fetch` keeps the adapter testable with a mocked fetch |
| Rate-limit rejected deliveries in the database | Deferred in step 3: an in-process window is enough until hosted logs show bursts (R-048) |

## Consequences

- An online order BICII cannot fulfil records nothing and appears to admins
  as an `integration_failed` operational exception until someone acts.
- Earlier online sales stay without `customer_id` after a customer link;
  the screens show the link through `sales.shopify_customer_id`
  ([RISKS R-042](../RISKS.md#r-042--earlier-online-sales-keep-no-customer-after-a-shopify-customer-is-linked)).
- Webhook payloads hold customer personal data until the owner purges them
  by hand ([RISKS R-040](../RISKS.md#r-040--shopify-webhook-payloads-hold-customer-personal-data-until-purged-by-hand)).
- A consigned quantity line larger than any single consignment at the
  online location fails (D45's one item per line)
  ([RISKS R-041](../RISKS.md#r-041--an-online-order-for-more-consigned-stock-than-one-consignment-holds-fails)).
- Phase 9 must widen `private.integration_exceptions()` when it appends its
  columns to `reporting.operational_exceptions`
  ([RISKS R-043](../RISKS.md#r-043--phase-9-must-widen-the-integration-exceptions-function)).
- An order edited after payment with a discounted line may be recorded
  below what Shopify charged until verified on a development store
  ([RISKS R-044](../RISKS.md#r-044--an-edited-order-with-a-discounted-line-records-a-lower-price)).
- `products.shopify_product_id` is no longer unique (DATA-MODEL §6
  deviation).
- The Buy-online link follows the item's overall availability, not its
  stock at the online location
  ([RISKS R-045](../RISKS.md#r-045--the-buy-online-link-follows-overall-availability-not-online-stock)).
- The in-flight check is shop-wide and pushed-but-unpublished products are
  re-checked on every stock change, so the sync queue is coarse
  ([RISKS R-046](../RISKS.md#r-046--the-product-sync-queue-is-coarse)).
- The live adapter is written from Shopify's documentation only
  ([RISKS R-047](../RISKS.md#r-047--the-live-shopify-adapter-is-unverified-against-a-real-store));
  the rejected-delivery limit is per server instance
  ([R-048](../RISKS.md#r-048--the-rejected-delivery-limit-is-per-server-instance));
  queued jobs wait for the cron, a webhook or a staff action, and Vercel's
  Hobby plan refuses to deploy the 5-minute cron (a daily schedule plus
  an external scheduler is the Hobby fallback; the plan is chosen before
  the first deployment)
  ([R-049](../RISKS.md#r-049--queued-integration-jobs-wait-for-a-trigger)).
- A Preview deployment must never hold the live store's credentials: the
  staging database's handles repeat production's. The live adapter is off
  in Preview unless `SHOPIFY_ALLOW_PREVIEW=true` marks a development
  store ([R-047](../RISKS.md#r-047--the-live-shopify-adapter-is-unverified-against-a-real-store)).
- A dismissal is final: an order or refund an admin dismissed is never
  recorded later, even when Shopify (or anyone holding a signed body)
  delivers it again under a new webhook id. The refund match reads the
  stored payload, so it holds until the owner purges that payload
  ([R-040](../RISKS.md#r-040--shopify-webhook-payloads-hold-customer-personal-data-until-purged-by-hand)).

## Amendment 2026-11-12: a Dev Dashboard app's client ID and secret

Shopify no longer lets a store create the admin-made custom app this record
assumed, the one that shows a fixed Admin API token. A new app is made in
the Dev Dashboard and has a client ID and secret. When the app and the store
belong to the same Shopify organization, a server exchanges them for an Admin
API token with the client credentials grant. That token lasts 24 hours.

The Admin now takes `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET` in place
of `SHOPIFY_ADMIN_TOKEN`. It fetches the token itself, keeps it in the server
process and fetches a new one 10 minutes before it expires. After a 401 it
fetches a new token once and retries
(`src/lib/integrations/shopify/access-token.ts`). A refused exchange is
`shopify_auth_failed`, which a person must fix (D87). `SHOPIFY_ADMIN_TOKEN`
still works for a legacy app and, when set, is used instead of the client ID
and secret. Nothing else changes: the scopes, webhooks and sync rules
(D80–D89) stay the same. The exchange is unit-tested against Shopify's
documented request and response
(`tests/unit/shopify-access-token.test.ts`), not yet against the live store
([R-047](../RISKS.md#r-047--the-live-shopify-adapter-is-unverified-against-a-real-store)).

## Revisit trigger

The owner answers D89 or confirms a row; the first real Shopify store or
development store is connected (R-011); Phase 9 decides refund netting;
Shopify changes its webhook payloads or API version.

## Evidence and links

- [PLAN Phase 10](../PLAN.md#phase-10--shopify), [PLAN §6](../PLAN.md#6-open-decisions-for-the-owner) rows D7, D80–D89.
- [DATA-MODEL §13](../DATA-MODEL.md#13-shopify-integration), §6, §8, §14–§16, §18.
- `supabase/migrations/20261004003900_shopify_integration.sql`,
  `supabase/migrations/20261004004000_shopify_order_processing.sql`,
  `tests/db/shopify-webhooks.test.ts`, `tests/fixtures/shopify.ts`;
  step 3: `src/lib/integrations/shopify/`, `tests/unit/shopify-*.test.ts`,
  `tests/db/shopify.stack.test.ts`, `tests/db/shopify-gid-parity.test.ts`,
  [RUNBOOK "Shopify"](../RUNBOOK.md#shopify).
- [ARCHITECTURE "Shopify inbound flow"](../ARCHITECTURE.md#shopify-inbound-flow);
  risks [R-011](../RISKS.md#r-011--shopify-is-not-built-and-will-be-fixture-tested-only),
  [R-021](../RISKS.md#r-021--reports-overstate-net-sales-after-a-refund-or-restock),
  R-040 to R-049.
