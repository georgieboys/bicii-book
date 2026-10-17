# ADR-025: Customer payments through Stripe

Date: 2026-10-14 (design, before Phase 14 is built; on
`claude/brave-clarke-kfqhgt` from `main` 511aac6); amended 2026-10-17
(D161, [below](#amendment-2026-10-17-the-owners-answers-to-question-32-d161));
status update 2026-10-17 (step 3's database, the build defaults D154a–e,
D156a–h and D161a–j,
[below](#status-update-2026-10-17-step-3s-database)); status update
2026-10-18 SGT (step 3's app, PR B, merged in PR #36 and in production
since 2026-10-18 SGT,
[below](#status-update-2026-10-18-step-3s-app)).
Status: accepted. The owner decided on 2026-10-14 to take payments through
Stripe, starting with deposits on indent parts, and on 2026-10-17 SGT
confirmed the build defaults below as built
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
| D151 | DEPOSIT: a quote that includes indent parts asks for a deposit of 50% of the approved parts' total (an admin setting, `shop_settings.indent_deposit_percent`; 0 asks for none), rounded to the cent in Postgres. After answering, the customer is offered Stripe Checkout for the deposit. The approval stands whether or not they pay; staff see "Deposit due" | Build default, confirmed 2026-10-17 SGT | Phase 14 step 2 (built in step 2) |
| D152 | ORDER-AFTER-DEPOSIT: an indent part is ordered (D145) only once its quote's deposit is paid, unless an admin or manager orders it anyway with a reason, which is recorded | Build default, confirmed 2026-10-17 SGT | Phase 14 step 2 (built in step 2) |
| D153 | PAYMENT-RECORD: a payment (`payments`: job, quote, kind deposit or balance, amount, currency, status pending, paid, failed, expired, refunded or partially refunded, the refunded amount, Stripe's ids, paid at) is created when a Checkout session is started and changes only when Stripe confirms it: the webhook checks Stripe's signature on the raw body, stores every delivery once by event id (rejected ones as evidence without a body, as D88 does) and applies it through a service-role RPC. Staff never type a payment in | Build default, confirmed 2026-10-17 SGT | Phase 14 step 1 |
| D154 | PAYMENT-MEANING: a payment is money held against a job, not revenue: recognition (D3, D30–D34), job totals, yield and Cult Commons do not change. The job shows what was paid and the balance due (job total less paid, net of refunds). Reports list payments and the deposits held on open jobs separately from sales | Build default, confirmed 2026-10-17 SGT | Step 2: the job's Customer payments card and balance (built); Reports in step 3 |
| D155 | REFUNDS: refunds are made in the Stripe dashboard and recorded from Stripe's refund events; the Admin starts no refund in the first build | Build default, confirmed 2026-10-17 SGT | Phase 14 step 1 |
| D156 | BALANCE-LINK: staff can send a payment link for a job's balance due by WhatsApp or email (the same Checkout, kind balance); paying it does not collect the job | Build default, confirmed 2026-10-17 SGT | Phase 14 step 3 |
| D157 | PAYMENTS-ROLLOUT: the deposit percent ships at 0 in every database and is refused above 0 while Stripe is off. Stripe is on only when every variable is valid for the deployment: never in a Vercel Preview; a key whose mode matches (live only in Production, test only elsewhere); the webhook secret, the service-role key and `ADMIN_ORIGIN` set and well-formed; the fake only outside production. Anything else turns Stripe off with a named reason and never stops the app. Switch off by setting the percent to 0, then removing the keys | Build default, confirmed 2026-10-17 SGT | Phase 14 step 1 (`stripeConfig`); step 2 (the setting) |
| D158 | DEPOSIT-RULES: the quote stores the percent when sent and the amount when answered (approved part lines only, in Postgres); SGD only; nothing asked under S$0.50 or over S$999,999.99; offered while the job is open and an approved part is still live; one 60-minute Checkout session per quote, reused until 2 minutes before expiry; partly refunded counts as paid, fully refunded as unpaid | Build default, confirmed 2026-10-17 SGT | Phase 14 step 2 |
| D159 | PAYMENT-TRUTH: only verified data changes a payment (a signed webhook or the server's own read). What Stripe confirms is recorded with Stripe's amount, even when it looks wrong, and flagged; BICII never refunds on its own. Refunds per Stripe Refund, only succeeded ones count. `paid_at` is Stripe's time. Stored objects are an allow-listed projection. Disputes are not handled (R-089) | Build default, confirmed 2026-10-17 SGT | Phase 14 step 1 (recording); step 2 (flags) |

Full text: [PLAN §6](../PLAN.md#6-open-decisions-for-the-owner), rows
D150–D159.

## Alternatives actually considered

| Option | Why chosen or rejected |
|---|---|
| Stripe Payment Links made by hand in the Stripe dashboard | Rejected: nothing would tie a payment to its job or quote; Checkout sessions created by the server carry the job and quote in their metadata |
| Stripe Elements (card form inside the Admin's page) | Rejected: puts card entry in BICII's pages and widens its PCI scope; hosted Checkout keeps it at Stripe and adds PayNow |
| Take the deposit through Shopify checkout | Rejected: Shopify sells catalogue products online (Phase 10); a deposit on one customer's quote is not a product, and its order would become an online sale (D80) |
| Staff record deposits taken at the counter | Not in the first build: the owner asked for Stripe. Decided on 2026-10-17 as D161 (an admin only), built in step 3 ([below](#status-update-2026-10-17-step-3s-database)) |
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

## Amendment 2026-10-17: the owner's answers to question 32 (D161)

**Context.** Question 32 asked the owner to confirm D151–D159, to ask the
accountant about GST on deposits, to name Stripe in the privacy notice and
to decide about payments taken at the counter, which BICII does not record
([R-089](../RISKS.md#r-089--what-bicii-does-not-record-or-cannot-apply-from-stripe)).

**The owner's answers (2026-10-17 SGT).**

- D151–D159: "all good", confirmed as built (D151's percent is 100% in
  production since 2026-10-15). "Lets build the full payments": Phase 14
  step 3 (D156's balance links and D154's Reports) is next.
- GST: "not GST". Deposits get no GST time-of-supply treatment, and step
  3's Reports add nothing for GST.
- The privacy notice names Stripe as the processor of online payments: on
  the public site's privacy text and on the Admin's customer payment
  pages.
- Counter payments: "lets keep to Stripe only. That will make things
  easier. But lets have an admin option for counter payment."

| D | Rule (short) | Status | Implemented in |
|---|---|---|---|
| D161 | COUNTER-PAYMENT: Stripe stays the only way a customer pays through BICII, and no staff member types a payment in (D153). An admin, and only an admin, can record a payment the shop took at the counter on a job (cash, card or PayNow outside BICII), so the job's paid and still to pay, and the deposit BICII asks for, count it. How it is recorded, voided and shown are build defaults | Owner decision 2026-10-17 SGT; details build defaults | Phase 14 step 3 |

**Consequences.** D153 keeps its rule for Stripe payments; D161 is the one
exception, for admins. A counter payment is money held against the job
like a Stripe payment (D154): it changes no recognition, total, yield or
Cult Commons. Its build defaults (the method list, voiding, how it meets
D152's ordering gate and the quote page, Reports) are recorded with step
3's build.

## Status update 2026-10-17: step 3's database

Phase 14 step 3 is built in two pull requests. PR A, the database, was
merged in PR #34 and is in production since 2026-10-17 SGT (`migrate.yml`
run 17; read-only afterwards, the replaced views returned the same rows
as before); PR B, the app, followed in PR #36, in production since
2026-10-18 SGT ([below](#status-update-2026-10-18-step-3s-app)). Every
choice below that the owner's
words do not settle is
a build default, recorded as a lettered clause (as D149a–c) and put to the
owner as
[PRODUCT question 35](../PRODUCT.md#open-assumptions-and-owner-questions),
its forks first. Applying PR A changes nothing a user sees: no counter
payment, balance link or balance payment exists, the replaced views keep
every column (new ones are appended) and return the same values, and the
deposit Checkout RPCs keep their signatures and behave the same while no
balance payment exists.

- **Migrations.** `20261014001200_payment_step3_enums.sql` (four timeline
  types, on their own), `20261014001300_counter_payments.sql` (D161, and
  the three replaced views), `20261014001400_balance_links.sql` (D156, and
  the two deposit Checkout RPCs replaced) and
  `20261014001500_payment_reports.sql` (D154). Every table ships with its
  RLS and grants; every definer function pins `search_path = ''`; no
  private function is executable by an API role. Lock order: the job
  first, then the quote or the link, then the payment or counter row,
  then the timeline ([DATA-MODEL §19](../DATA-MODEL.md#19-customer-payments-stripe)).
- **Tests, written first.** `tests/db/counter-payments.test.ts` (30),
  `tests/db/balance-links.test.ts` (33), `tests/db/payment-reports.test.ts`
  (18), the D154 snapshot test extended and the report-index test
  extended; each failed before its migration and passes after it.
- **One app change.** `work_order_payment_totals` now has a row for every
  job, so the job's Customer payments card shows its totals only once the
  job has a Stripe payment or a live counter payment (as before for Stripe
  payments; `tests/unit/payments-card.test.tsx`).

| D | Rule (short) | Status | Implemented in |
|---|---|---|---|
| D154a | WHAT: a Customer payments section on Reports, apart from the sales figures and not driven by the date basis: taken online, refunded online, recorded at the counter and given back at the counter in the period, by the day it moved, and what is held on jobs now; nothing for GST | Build default | Step 3 (database in PR A; screen in PR B) |
| D154b | DATES AND AMOUNTS: online by Stripe's paid time at the amount Stripe took; a refund by Stripe's created time (BICII's own time when Stripe sent none), counted as the job card counts it; counter by when it was received; a recorded-in-error void removes its payment (the day restates, D101); a given-back void keeps the payment and adds the money handed back on the void's day, or just after the payment when the payment was dated later (up to 5 minutes ahead), so it never comes before its payment | Build default | Step 3 |
| D154c | HELD NOW: three lists with no grand total: paid on open jobs; paid on jobs awaiting collection (at most the bill, still to pay beside it); paid above the bill on any job that is not open; read from the job card's totals | Build default | Step 3 |
| D154d | WHO: View financial reports (D30); nothing cost-derived; "Recorded at the counter" is only what an admin recorded, not the till's takings | Build default | Step 3 |
| D154e | OBJECTS: `reporting.payment_movements` (no API grant), `report_payment_summary`, `report_payment_items`, `report_payments_held`; sales reports never change | Build default | Step 3 |
| D156a | WHEN: sent only on a completed or ready-for-collection job; not payable once the job leaves those statuses | Build default | Step 3 |
| D156b | AMOUNT: the live balance (job total less Stripe net and live counter payments), computed in Postgres at every read and Pay; S$0.50 to S$999,999.99, SGD | Build default | Step 3 |
| D156c | LINK: a random token shown once, only its hash kept; 1–30 days (7); one live link per job; changed only to withdraw it | Build default | Step 3 |
| D156d | WITHDRAWN: on a resend, a reopen and Collected; completed to ready keeps it; completing again does not revive it | Build default | Step 3 |
| D156e | WHO SENDS: any active staff member (as D147's quotes) | Build default | Step 3 |
| D156f | THE PAGE: shop, job number, bike, first name, the bill's lines at sale prices, total, paid, balance and whether it can be paid; never costs, notes, staff, contacts, other jobs, ids, unit ids, serial numbers, Stripe ids or URLs; a withdrawn, expired or closed link shows only its status and job number | Build default | Step 3 |
| D156g | CHECKOUT: a fresh 60-minute Checkout of kind balance on each Pay; a live or confirming balance payment never sits beside another open or confirming Stripe payment on the job, and a job has at most one pending linked balance payment; a row past its expiry that Stripe has not answered yet holds up neither kind (R-092) | Build default | Step 3 |
| D156h | RPCs: `send_balance_link`, `balance_by_token`, `prepare_balance_checkout`, `record_balance_checkout`; the deposit Checkout RPCs answer `job_payment_processing` (a balance payment being confirmed), `replace` (a live one) or `existing` | Build default | Step 3 |
| D161a | WHO: an active admin by role (not a manager); every active staff member sees counter payments | Build default (reading "admin option") | Step 3 |
| D161b | METHOD: cash, card (the shop's terminal), PayNow (the shop's QR), bank transfer, other | Build default | Step 3 |
| D161c | RECORD: amount (0.01 to 999,999.99, SGD), method, when received, optional reference and note, who recorded it; append-only | Build default | Step 3 |
| D161d | VOID: the only correction, once, with a reason and a kind (recorded in error, or given back: cash handed back outside BICII, not a refund from the Admin); any job status | Build default | Step 3 |
| D161e | WHEN AND WHY: for money that reaches the shop before the bike leaves; money taken at collection need not be recorded; allowed on completed, ready and collected jobs, refused on a cancelled one; SGD only | Build default | Step 3 |
| D161f | DEPOSIT OR BALANCE: a deposit at exactly its amount while due or refunded, then paid; any other amount towards the bill, even before the work is done | Build default | Step 3 |
| D161g | STRIPE CONFIRMING: refused while Stripe is confirming a payment on the job; the open sessions it leaves are counted for the app to expire | Build default | Step 3 |
| D161h | TIME: now unless given; at most 5 minutes ahead, not before check-in (or the quote's answer for a deposit), at most 30 days back | Build default | Step 3 |
| D161i | RPCs: `record_counter_payment`, `void_counter_payment`; a retried request replays | Build default | Step 3 |
| D161j | VIEWS: `quote_deposits`, `work_order_payment_totals` (a row for every job) and `payment_issues` count counter money | Build default | Step 3 |

**A void and the deposit.** A void takes the counter deposit out of the
deposit's state, which falls back to what the Stripe payments and the
parts give it: paid, refunded, processing, due or none, as before it was
recorded. The quote page offers Pay again only when that state is due and
the job is open (D158c); D152's gate is closed again unless a Stripe
deposit is paid. `record_counter_payment` refuses a quote whose deposit is
`none`, or that asked none, with one staff-worded code, `deposit_not_due`,
where `prepare_deposit_checkout` says `deposit_parts_cancelled` for
`none`.

**Choices made in the build, beyond the design (recorded, not owner
decisions).** Times of a record, a void and a link use the transaction's
clock time (`clock_timestamp()`, as the settlement and workshop RPCs do),
so rows of one transaction keep their order and a void is never stamped
before its payment. An amount, reference or note out of range is refused
with its CHECK constraint's 23514, mapped by name. Sending a link again
also records `balance_link_withdrawn` (reason replaced) for the old one, as
`send_quote` records `quote_withdrawn`. The payment page's `shop_name` is
"BICII" (the database has no shop-name setting). `prepare_deposit_checkout`
answers `replace` for a pending balance payment only just before it would
check or create a deposit session, so a closed job still answers
`deposit_job_closed` rather than expiring the customer's balance tab, and
`prepare_balance_checkout` also replaces another link's pending row whose
session has passed its expiry (it still holds the one-pending index until
Stripe's answer is recorded). While a balance payment on the job is being
confirmed, `prepare_deposit_checkout` answers `job_payment_processing`
(its own outcome, since the deposit itself is not being confirmed), so the
quote page's Pay creates no session that the record would refuse.
`paid_above_bill` is left out beside a deposit held for cancelled parts or
for parts not fitted, as beside `paid_twice`: those already name the same
money and ask for its refund, and once that deposit is refunded or voided
what is still above the bill shows. A given-back movement is dated at the
void, or one microsecond after the payment when the payment was dated
later, so it never comes before its payment and the report list's (at,
id) keyset stays unique. The payment page shows a unit line's name cut
before its short id, or the product's current name when the line does not
carry the short id, never the rest of the description. The movements' `other_currency_count`
counts movements outside the shop currency and Stripe payments taken in
another currency (counted at the amount asked, as on the card). Held now
lists shop-currency jobs only, and a collected job's lists add up to what
it holds above its bill (a collected job paid exactly is in no list).

**Alternatives considered for step 3.**

| Option | Why chosen or rejected |
|---|---|
| Counter payments as rows in `payments`, with a source column | Rejected: `payments` has Stripe's NOT NULL session, expiry and mode, an insert-pending-only guard and Stripe-only status moves; a counter branch would open a hole in "a Stripe-owned column changes only while citing a received event, for every role" (D153, D159a). A separate append-only table, modelled on consignor settlements, keeps Stripe's provenance intact; the views read both |
| Balance link as a Stripe Checkout URL made at send time (Option B) | Rejected: a session lives at most 24 hours, freezes the amount when sent, puts a long Stripe URL in WhatsApp, and would need a record RPC accepting a 24-hour session; a BICII token page makes a 60-minute Checkout at the live balance on each Pay, as the deposit does, and stores no Stripe URL (as "Store the Checkout URL" above) |
| Token-free return URLs for the balance link (a done page by payment id) | Rejected: after expiry, withdrawal or closure the token in Stripe's stored URLs reads only `{status, job_number}`; the same token stays in WhatsApp, the email and the logs, so a done page removes one copy of several at the cost of a second anonymous route, a service-role RPC and another rate-limit bucket ([R-088](../RISKS.md#r-088--the-quote-link-is-a-payment-capability-that-reaches-stripe), [R-091](../RISKS.md#r-091--a-balance-link-is-a-payment-capability)) |
| One pending balance payment per link | Rejected: a resent link's old session, a deposit session or a payment still being confirmed could be paid beside the new one; the rule is per job, under the job lock, with a unique index as the backstop |
| Leave a voided counter payment out of Reports in every case | Rejected for money given back: cash that came in and went out would vanish from both days; a given-back void is a dated negative movement, as refunds sit beside gross (D102), while a recorded-in-error void restates (D101) |

**Consequences.** New risks
[R-090](../RISKS.md#r-090--a-counter-payment-rests-on-an-admins-word) (a
counter payment rests on an admin's word),
[R-091](../RISKS.md#r-091--a-balance-link-is-a-payment-capability) (a
balance link is a payment capability) and
[R-092](../RISKS.md#r-092--open-checkout-tabs-can-still-be-paid-for-up-to-60-minutes)
(open Checkout tabs can still be paid for up to 60 minutes); R-055,
R-087, R-088 and R-089 updated. D157a is unchanged: a deposit is asked
only while Stripe is on, though it can now be paid at the counter.

## Status update 2026-10-18: step 3's app

Phase 14 step 3's PR B, the app, was built on `claude/brave-clarke-kfqhgt`
(on `main` cb41d23, which holds PR A's database, 56bc12c) and merged in
PR #36 as ed6a08a on 2026-10-18 SGT (CI `check`, `test (unit + db)` and `build` and the full
`e2e (Playwright)` run succeeded on edd4603; Vercel's production
deployment of ed6a08a is READY); it adds no migration and changes no
SQL, so `migrate.yml` did not run. What it builds, on the build defaults
D154a–e, D156a–h and D161a–j:

- **The Stripe layer.** One Pay loop for the deposit and the balance
  (`payLoop` over a prepare/record pair in `checkout.ts`), with the
  deposit's behaviour and tests kept and its two new outcomes handled
  (`replace`: expire and record the named balance session;
  `job_payment_processing`: stop with "A payment for this job is being
  confirmed by Stripe. Try again in a few minutes."). The balance flow
  passes Postgres's cents and expiry through unchanged and reuses a
  session only while it is open and more than 120 s from expiry:
  `prepare_balance_checkout` as built returns no amount check of its own,
  and its `replace` already takes a session at another amount, so the app
  compares no money. `validateRedirect` takes each flow's own page, and
  `expireOpenCheckouts` closes the job's open sessions after a counter
  payment (that quote's deposit and any balance) and after a resend
  (balance only), best effort.
- **The payment page** `/pay/[token]` (D156f): the token shape, then a
  per-client and per-token limit, then `balance_by_token` as anon, parsed
  with its two key sets pinned; no-referrer, noindex and no-store on the
  page and its return; one check at Stripe on the return, then the page's
  own refreshes; the privacy line naming Stripe under every Pay on both
  customer pages.
- **On the job**: **Send payment link** for any staff member while Stripe
  is on and the bill is final (the link from `ADMIN_ORIGIN`, shown once,
  WhatsApp, email or Copy link); the admin's **Record counter payment**
  (a deposit at its fixed amount, or towards the bill; a confirm step
  that repeats the amount and method; warnings that never refuse) and its
  two voids, **Void (recorded in error)…** and **Given back…**; the card,
  the line under Lines and the Collected confirmation counting counter
  money and what Stripe is still confirming; the timeline's wording.
- **Reports** (D154): the Customer payments section outside Figures (the
  five figures with counts and the two notes), **Held on jobs now** in
  three lists each with its own total and no grand total,
  `/reports/payments` (100 a page, keyset, a bad cursor is not found) and
  the `payments` and `payments_held` CSVs. Each list's total is added up
  on screen from the fixed-2 amounts `report_payments_held` returns
  (exact decimals, display only, never stored or exported), because the
  function returns no totals; a later migration could return them
  ([R-055](../RISKS.md#r-055--past-report-periods-change-after-a-reopen-a-back-dated-sale-or-a-back-dated-receipt)).
- **After review** (same branch, app and docs only): while Stripe is
  confirming a payment the Collected confirmation names no amount to take
  and says to press Check with Stripe first (processing money is never in
  `balance_due`); a job paid in full says "Nothing is left to pay; take
  nothing."; a replayed counter payment also expires the open sessions
  the RPC reports; the fake's redirect check parses the URL (dot
  segments); back from Stripe, a paid return whose bill is still due
  shows Pay at the live amount; refusing Collected while a payment is
  being confirmed would be a migration, put to the owner as
  [R-093](../RISKS.md#r-093--mark-collected-is-allowed-while-stripe-is-confirming-a-payment).

Verified locally on 2026-10-18 SGT: the unit project, `npm run check`,
the payments and reports E2E specs on the phone and iPad projects against
the real RPCs and the fake Stripe with signed webhooks, and the gates in
NOW.md's row for this build. Not yet verified: a balance paid in Stripe's
test mode (RUNBOOK "Stripe: verify before go-live" steps 11 and 12);
email and WhatsApp end to end (unit-tested). Risks updated:
[R-088](../RISKS.md#r-088--the-quote-link-is-a-payment-capability-that-reaches-stripe),
[R-090](../RISKS.md#r-090--a-counter-payment-rests-on-an-admins-word),
[R-091](../RISKS.md#r-091--a-balance-link-is-a-payment-capability),
[R-092](../RISKS.md#r-092--open-checkout-tabs-can-still-be-paid-for-up-to-60-minutes),
R-093 and R-055. The public site's privacy text ("workshop quotes" to "workshop
quotes and bills") followed in georgieboys/BICII#2, merged as ea057ac
and in production since 2026-10-18 SGT: its `/contact` page reads
"Online payments for workshop quotes and bills are taken by Stripe".

In production on 2026-10-18 SGT, signed out: the payment page with a
malformed token answers the "link is not valid" page with
`Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow` and a
`Cache-Control` with `no-store`; `/reports/payments` redirects to sign
in. Read-only on the hosted project: no balance link or counter payment
exists yet, so neither has been exercised in production. Still open:
the Stripe test-mode balance rehearsal above, the owner's
[PRODUCT question 35](../PRODUCT.md#open-assumptions-and-owner-questions)
and R-093's decision.

## Revisit trigger

A request for staff other than admins to record counter payments, for
refunds from the Admin, or for full payment at collection (recording every
till payment, or requiring payment before Collected: D161 does not cover
it); a request to pay a balance link after collection; BICII becoming
GST-registered.

## Evidence and links

- The owner's answer of 2026-10-14 (this session), and their answers to
  question 32 of 2026-10-17 SGT (D161).
- SPEC §18, §30; [ADR-011](ADR-011-recognition-and-financial-reporting.md)
  (D3, D30–D34); [ADR-020](ADR-020-shopify.md) (the adapter, webhook and
  delivery-evidence pattern this follows).
- Fee figures: third-party summaries of Stripe Singapore pricing
  (WorldFirst, Aspire), not Stripe's own page.
