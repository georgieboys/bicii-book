# ADR-025: Customer payments through Stripe

Date: 2026-10-14 (design, before Phase 14 is built; on
`claude/brave-clarke-kfqhgt` from `main` 511aac6). Status: proposed. The
owner decided on 2026-10-14 to take payments through Stripe, starting with
deposits on indent parts; the rules below are build defaults for the owner
to confirm
([PRODUCT question 32](../PRODUCT.md#open-assumptions-and-owner-questions)).
Decision owner: Abhishek Cherian George (owner) for business meaning;
defaults proposed by the build agent.

Status update 2026-10-14 (Phase 14 step 1, built against a fake): the
database and the adapter of D150, D153 and D155 are built, with the build
defaults D157–D159 added below. Status stays proposed until question 32
is answered.

- **Migrations.** `supabase/migrations/20261014000300_payment_enum_values.sql`
  (the job timeline types `payment_received`, `payment_refunded`,
  `payment_refund_failed`, on their own) and
  `20261014000400_stripe_payments.sql`: `stripe_events`, `payments`,
  `payment_refunds`, their guards, RLS and grants, and the service-role
  RPCs `record_stripe_event` and `record_stripe_read`
  ([DATA-MODEL §19](../DATA-MODEL.md)). Tested first by
  `tests/db/stripe-payments.test.ts`.
- **Adapter and route.** `src/lib/integrations/stripe/` (no SDK: a live
  adapter over fetch pinned to API version `2026-09-30.endive`, an
  in-memory fake, the signature check, `stripeConfig`, the RPC wrappers)
  and `POST /api/stripe/webhooks`, outside the proxy. Tested by the
  `tests/unit/stripe-*.test.ts` files ([TESTING.md](../TESTING.md)).
- **Store and apply in one transaction.** A verified delivery is stored
  and applied by one RPC before the answer; an error rolls both back and
  the route answers 500, so Stripe retries for up to 3 days, and a
  `not_recorded` row is kept as evidence. Rejected deliveries are kept
  without a body (as D88).
- **Allow-listed projection.** A stored Stripe object keeps ids, statuses,
  amounts and `bicii_*` metadata only: no customer details and no URLs
  (the return URLs carry the quote token) (D159e).
- **Verified data (D159a).** A webhook whose signature is valid on the raw
  body, or a read the server makes with the secret key, is Stripe's word
  for D153. Staff and customers only trigger a read; they never supply the
  data.
- **Provenance guard.** For every role, the owner included, a change to a
  Stripe-owned column must cite the `stripe_events` row being applied in
  the same transaction.
- **The payment row** is created once the Checkout session exists (step 2,
  `record_deposit_checkout`), with a fresh id and idempotency key per
  attempt.
- **Off until D157 holds.** Production has no Stripe variables, so Stripe
  is off there: the webhook answers 503 (kept as evidence) and nothing
  else changes.

Status update 2026-10-14 (Phase 14 step 2, built against a fake): D151
and D152 are built, and D154's job half (the Customer payments card and
the balance); Reports come with step 3. Status stays proposed until
question 32 is answered.

- **Snapshot.** `supabase/migrations/20261014000500_indent_deposits.sql`
  adds `shop_settings.indent_deposit_percent` (ships at 0, D157a; an
  admin setter with history) and the `quotes_deposit_snapshot` trigger:
  a quote stores the percent when it is sent and the amount when it is
  answered (approved part lines only, rounded in Postgres; none under
  S$0.50 or outside SGD). Either is immutable afterwards.
- **One definition of a deposit's state.** The security-invoker view
  `quote_deposits` (due, processing, paid, refunded, none) is read by the
  gate, `quote_view`, the Checkout RPCs and the screens.
- **The gate (D152).** `order_part_requests` gains `override_reason`: a
  part whose deposit is not paid is ordered only by an active admin or
  manager with a reason, recorded on the `part_ordered` timeline entry as
  `deposit_override`. Manage purchasing alone is refused; fitting is not
  gated. On screen the order sheet starts unpaid parts unticked, and only
  an admin or manager can tick them, with the reason
  (`src/components/domain/indent-card.tsx`).
- **Checkout.** The quote page's Deposit card and Pay deposit
  (`src/lib/integrations/stripe/checkout.ts`), through the service-role
  RPCs `prepare_deposit_checkout` and `record_deposit_checkout`; anon
  gains nothing.
- **Attention, derived live.** `payment_issues` (paid on a cancelled job
  or cancelled parts, paid twice, amount mismatch, refund failed or not
  counted, refund over the payment, pending unconfirmed) feeds the job's
  Customer payments card and the exception kinds `payment_attention`
  (admins and managers) and `stripe_attention` (admins), shown under
  "Customer payments" on Exceptions and in Today's count. Check with
  Stripe re-reads a payment and its refunds on demand (R-086).
- **Tests.** `tests/db/indent-deposits.test.ts`, the unit tests for the
  checkout flows, labels, exceptions and timeline, and
  `tests/e2e/payments.spec.ts` (journey 8: paid by a signed webhook, a
  replay and a forged delivery, the override with a reason, a partial
  refund, a cancelled Checkout).

Deviations of step 2 from the design spec, recorded here: the inputs
of `record_deposit_checkout` are named `p_payment_id` and `p_quote_id`
(its result has a `payment_id` column); `payment_issues` gained a
`refund_not_counted` kind (a linked refund in another currency or mode,
not deducted), which step 1's adoption path needed; and `refund_failed`
is decided by which counted refund Stripe settled last, ordered by each
refund's own decision time (below).

Status update 2026-10-14 (Phase 14 final review, one fix commit; the step
1 and 2 migration files edited in place, as neither has reached a hosted
database):

- **An asynchronous failure is recoverable from the app (R-086).** A
  session that completed unpaid and then failed looks, to a session read,
  exactly like one still processing. *Check with Stripe* now also reads
  that payment's PaymentIntent (`record_stripe_read` takes a
  `payment_intent`; `private.apply_stripe_payment_intent`):
  `requires_payment_method` or `canceled` records the payment failed and
  the deposit is due again. Reads only; paid stays the session's word.
  The restricted key gains PaymentIntents: Read, and the permission for
  listing refunds is named as Stripe names it, Charges: Read (RUNBOOK
  "Stripe: restricted key").
- **Refund order by the refund's own time.** `payment_refunds` gained
  `status_changed_at`, set when a refund's status changes; `refund_failed`
  orders by it, so refunds adopted by a completion keep their order, and
  `payment_issues` no longer needs the definer helper that read the
  admins-only `stripe_events` (no private function of Phase 14 is
  executable by an API role, pinned in `meta.test.ts`).
- **Screens.** The job shows "Paid online … · Still to pay …" under the
  Lines total and in the Collected confirmation (D154 at the counter);
  the quote page stops saying the parts wait for the deposit once the
  shop has ordered them (`parts_ordered`), and warns before a second
  payment; Exceptions rows give where to act under the sentence instead
  of repeating it; payment sentences print money as the screens do.
- **Adapter.** A POST's 5xx is retried only when Stripe marks it
  retryable (Stripe replays a saved result for the same key), each expire
  takes a fresh key, the Checkout expiry is checked against Stripe's
  30-minute to 24-hour window in the live adapter and the fake, the fake
  expires sessions by its clock, Pay deposit stops starting Stripe steps
  after 30 s, `ADMIN_ORIGIN` may not be a loopback host in Production, and
  the quote page treats an unreadable server environment as Stripe off.
- **Recheck of these fixes (after PR #24 merged and its migrations ran
  on the hosted project, so a new migration,
  `20261014000600_payment_exception_dedupe`).** The payment and Stripe
  sentences on Exceptions wrap in full (they are what to do; other
  kinds' subjects stay one truncated line); `stripe_attention` also
  leaves a `livemode_mismatch` about a refund to `refund_not_counted`, by
  the same test as `payment_issues`, while a failed or canceled
  mismatched refund, which `refund_not_counted` leaves out, keeps its
  `stripe_attention` row, and lists each Stripe object once per outcome
  (the earliest event in the window), however many events or reads
  repeat it; and *Check with Stripe* names the key's permissions only
  when Stripe refused the key (`stripe_auth_failed`), says Stripe could
  not be reached only for a network error or timeout, a 409, a 5xx or a
  429 (`stripe_unavailable`, `stripe_rate_limited`), and otherwise that
  BICII could not use Stripe's answer, which a retry will not fix.
- **Not changed, recorded:** a pending payment whose session Stripe
  cannot find under the current key stays pending (R-086, RUNBOOK); a
  Checkout custom domain is refused by the redirect guard (R-088,
  RUNBOOK); deposits paid at the counter are still not recorded (R-089).

## Context

Asked whether indent parts should take a deposit, the owner answered on
2026-10-14: "i want to get stripe payments done". SPEC §30 keeps building
a payment processor out of the MVP and Shopify handles online checkout
(SPEC §18). Using Stripe's hosted checkout is not building a processor,
but the Admin has never recorded a customer payment: a job has totals and
a collection date, and in-store sales record what was sold, not how it was
paid. This record adds the first customer payments, for deposits on
quotes ([ADR-024](ADR-024-indent-parts-and-customer-quotes.md)), and the
rules any later Stripe payment follows.

Stripe in Singapore offers cards and PayNow on its hosted Checkout page
(third-party summaries put PayNow at 1.3% and local cards at 3.4% plus
S$0.50; to be confirmed on Stripe's own pricing page before go-live).

## Decision and rationale

| D | Rule (short) | Status | Implemented in |
|---|---|---|---|
| D150 | PAYMENTS-PROVIDER: customers pay through Stripe's hosted Checkout (cards and PayNow, SGD). Card details never reach BICII. The secret key and the webhook secret are server-only environment variables (Production: live keys; Preview: test keys or none); every Stripe call goes through one adapter, with an in-memory fake for tests and development, as Shopify's does (D81–D88) | Owner decision 2026-10-14 (Stripe); rest build default | Phase 14 step 1 |
| D151 | DEPOSIT: a quote that includes indent parts asks for a deposit of 50% of the approved parts' total (an admin setting, `shop_settings.indent_deposit_percent`; 0 asks for none), rounded to the cent in Postgres. After answering, the customer is offered Stripe Checkout for the deposit. The approval stands whether or not they pay; staff see "Deposit due" | Build default | Phase 14 step 2 (built in step 2) |
| D152 | ORDER-AFTER-DEPOSIT: an indent part is ordered (D145) only once its quote's deposit is paid, unless an admin or manager orders it anyway with a reason, which is recorded | Build default | Phase 14 step 2 (built in step 2) |
| D153 | PAYMENT-RECORD: a payment (`payments`: job, quote, kind deposit or balance, amount, currency, status pending, paid, failed, expired, refunded or partially refunded, the refunded amount, Stripe's ids, paid at) is created when a Checkout session is started and changes only when Stripe confirms it: the webhook checks Stripe's signature on the raw body, stores every delivery once by event id (rejected ones as evidence without a body, as D88 does) and applies it through a service-role RPC. Staff never type a payment in | Build default | Phase 14 step 1 |
| D154 | PAYMENT-MEANING: a payment is money held against a job, not revenue: recognition (D3, D30–D34), job totals, yield and Cult Commons do not change. The job shows what was paid and the balance due (job total less paid, net of refunds). Reports list payments and the deposits held on open jobs separately from sales | Build default | Step 2: the job's Customer payments card and balance (built); Reports in step 3 |
| D155 | REFUNDS: refunds are made in the Stripe dashboard and recorded from Stripe's refund events; the Admin starts no refund in the first build | Build default | Phase 14 step 1 |
| D156 | BALANCE-LINK: staff can send a payment link for a job's balance due by WhatsApp or email (the same Checkout, kind balance); paying it does not collect the job | Build default | Phase 14 step 3 |
| D157 | PAYMENTS-ROLLOUT: the deposit percent ships at 0 in every database and is refused above 0 while Stripe is off. Stripe is on only when every variable is valid for the deployment: never in a Vercel Preview; a key whose mode matches (live only in Production, test only elsewhere); the webhook secret, the service-role key and `ADMIN_ORIGIN` set and well-formed; the fake only outside production. Anything else turns Stripe off with a named reason and never stops the app. Switch off by setting the percent to 0, then removing the keys | Build default, owner to confirm | Phase 14 step 1 (`stripeConfig`); step 2 (the setting) |
| D158 | DEPOSIT-RULES: the quote stores the percent when sent and the amount when answered (approved part lines only, in Postgres); SGD only; nothing asked under S$0.50 or over S$999,999.99; offered while the job is open and an approved part is still live; one 60-minute Checkout session per quote, reused until 2 minutes before expiry; partly refunded counts as paid, fully refunded as unpaid | Build default, owner to confirm | Phase 14 step 2 |
| D159 | PAYMENT-TRUTH: only verified data changes a payment (a signed webhook or the server's own read). What Stripe confirms is recorded with Stripe's amount, even when it looks wrong, and flagged; BICII never refunds on its own. Refunds per Stripe Refund, only succeeded ones count. `paid_at` is Stripe's time. Stored objects are an allow-listed projection. Disputes are not handled (R-089) | Build default, owner to confirm | Phase 14 step 1 (recording); step 2 (flags) |

Full text: [PLAN §6](../PLAN.md#6-open-decisions-for-the-owner), rows
D150–D159.

## Alternatives actually considered

| Option | Why chosen or rejected |
|---|---|
| Stripe Payment Links made by hand in the Stripe dashboard | Rejected: nothing would tie a payment to its job or quote; Checkout sessions created by the server carry the job and quote in their metadata |
| Stripe Elements (card form inside the Admin's page) | Rejected: puts card entry in BICII's pages and widens its PCI scope; hosted Checkout keeps it at Stripe and adds PayNow |
| Take the deposit through Shopify checkout | Rejected: Shopify sells catalogue products online (Phase 10); a deposit on one customer's quote is not a product, and its order would become an online sale (D80) |
| Staff record deposits taken at the counter | Not now: the owner asked for Stripe; a counter payment can be a later decision with its own record |
| Count a deposit as revenue when paid | Rejected: the part is not sold until it is fitted and the job is completed (D3); counting deposits would double the revenue in reports |
| Reuse `integration_events` and the Shopify queue for Stripe deliveries | Rejected: those tables, the job kinds and the queue runner are wired to Shopify (a provider check, a kind enum, a runner that syncs products); Stripe has its own `stripe_events`, applied in the same transaction |
| `charge.refunded` as the source of refunds | Rejected: it carries the charge, not each Refund; `refund.created`, `refund.updated` and `refund.failed` give one row per Refund with its own status, which PayNow refunds need (they can fail after succeeding) |
| The Stripe Node SDK | Rejected: four form-encoded calls do not need it; a fetch adapter pins the API version, never logs, and keeps the dependency surface small |
| A cron sweep that re-reads pending payments | Rejected: the 60-second integration cron belongs to Shopify; store and apply are synchronous, Stripe retries for 3 days, and the customer's return and staff's *Check with Stripe* re-read the session (R-086) |
| Answer 200 when applying fails, and log the bug | Rejected: Stripe would stop retrying and the money would be lost; an error rolls back, answers 500, and leaves `not_recorded` evidence |
| Store the Checkout URL | Rejected: a Pay click on an existing session re-reads it at Stripe and redirects to the URL Stripe returns, after checking its host |
| Return URLs built from the request's Host | Rejected: the anonymous Pay action hands Stripe URLs that carry the quote token, so their origin comes from `ADMIN_ORIGIN` only |

## Consequences

- New hosted secrets and a webhook endpoint to set up and rotate
  ([R-085](../RISKS.md#r-085--stripe-keys-and-the-webhook-are-new-hosted-secrets)).
- A missed or delayed webhook leaves a payment pending until Stripe
  retries ([R-086](../RISKS.md#r-086--a-payment-stays-pending-until-stripes-webhook-arrives)).
- Refunds are done by hand in Stripe
  ([R-087](../RISKS.md#r-087--refunds-are-made-by-hand-in-stripe)).
- The quote link becomes a payment capability, and the return URLs that
  carry it are stored by Stripe
  ([R-088](../RISKS.md#r-088--the-quote-link-is-a-payment-capability-that-reaches-stripe)).
- Card disputes, fees, payouts and payments outside BICII's Checkout are
  not recorded
  ([R-089](../RISKS.md#r-089--what-bicii-does-not-record-or-cannot-apply-from-stripe)).
- Design risks without an R number: step 2's deposit amount is computed by
  a trigger that relies on `answer_quote` writing item decisions before the
  quote's status (its snapshot test fails loudly if that changes); and
  these Stripe facts are unverified on a live account and on the go-live
  list: PayNow's `payment_status` at completion, `pyr_` refund ids, and
  whether Adaptive Pricing off keeps `amount_total` in SGD.
- The Admin starts holding customer money records; payments taken in the
  shop by other means are not in it.

## Revisit trigger

The owner's answer to question 32; a request for counter payments, refunds
from the Admin, or full payment at collection.

## Evidence and links

- The owner's answer of 2026-10-14 (this session).
- SPEC §18, §30; [ADR-011](ADR-011-recognition-and-financial-reporting.md)
  (D3, D30–D34); [ADR-020](ADR-020-shopify.md) (the adapter, webhook and
  delivery-evidence pattern this follows).
- Fee figures: third-party summaries of Stripe Singapore pricing
  (WorldFirst, Aspire), not Stripe's own page.
