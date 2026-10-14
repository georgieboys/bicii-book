# ADR-025: Customer payments through Stripe

Date: 2026-10-14 (design, before Phase 14 is built; on
`claude/brave-clarke-kfqhgt` from `main` 511aac6). Status: proposed. The
owner decided on 2026-10-14 to take payments through Stripe, starting with
deposits on indent parts; the rules below are build defaults for the owner
to confirm
([PRODUCT question 32](../PRODUCT.md#open-assumptions-and-owner-questions)).
Decision owner: Abhishek Cherian George (owner) for business meaning;
defaults proposed by the build agent.

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
| D151 | DEPOSIT: a quote that includes indent parts asks for a deposit of 50% of the approved parts' total (an admin setting, `shop_settings.indent_deposit_percent`; 0 asks for none), rounded to the cent in Postgres. After answering, the customer is offered Stripe Checkout for the deposit. The approval stands whether or not they pay; staff see "Deposit due" | Build default | Phase 14 step 2 |
| D152 | ORDER-AFTER-DEPOSIT: an indent part is ordered (D145) only once its quote's deposit is paid, unless an admin or manager orders it anyway with a reason, which is recorded | Build default | Phase 14 step 2 |
| D153 | PAYMENT-RECORD: a payment (`payments`: job, quote, kind deposit or balance, amount, currency, status pending, paid, failed, expired, refunded or partially refunded, the refunded amount, Stripe's ids, paid at) is created when a Checkout session is started and changes only when Stripe confirms it: the webhook checks Stripe's signature on the raw body, stores every delivery once by event id (rejected ones as evidence without a body, as D88 does) and applies it through a service-role RPC. Staff never type a payment in | Build default | Phase 14 step 1 |
| D154 | PAYMENT-MEANING: a payment is money held against a job, not revenue: recognition (D3, D30–D34), job totals, yield and Cult Commons do not change. The job shows what was paid and the balance due (job total less paid, net of refunds). Reports list payments and the deposits held on open jobs separately from sales | Build default | Phase 14 steps 2 and 3 |
| D155 | REFUNDS: refunds are made in the Stripe dashboard and recorded from Stripe's refund events; the Admin starts no refund in the first build | Build default | Phase 14 step 1 |
| D156 | BALANCE-LINK: staff can send a payment link for a job's balance due by WhatsApp or email (the same Checkout, kind balance); paying it does not collect the job | Build default | Phase 14 step 3 |

Full text: [PLAN §6](../PLAN.md#6-open-decisions-for-the-owner), rows
D150–D156.

## Alternatives actually considered

| Option | Why chosen or rejected |
|---|---|
| Stripe Payment Links made by hand in the Stripe dashboard | Rejected: nothing would tie a payment to its job or quote; Checkout sessions created by the server carry the job and quote in their metadata |
| Stripe Elements (card form inside the Admin's page) | Rejected: puts card entry in BICII's pages and widens its PCI scope; hosted Checkout keeps it at Stripe and adds PayNow |
| Take the deposit through Shopify checkout | Rejected: Shopify sells catalogue products online (Phase 10); a deposit on one customer's quote is not a product, and its order would become an online sale (D80) |
| Staff record deposits taken at the counter | Not now: the owner asked for Stripe; a counter payment can be a later decision with its own record |
| Count a deposit as revenue when paid | Rejected: the part is not sold until it is fitted and the job is completed (D3); counting deposits would double the revenue in reports |

## Consequences

- New hosted secrets and a webhook endpoint to set up and rotate
  ([R-085](../RISKS.md#r-085--stripe-keys-and-the-webhook-are-new-hosted-secrets)).
- A missed or delayed webhook leaves a payment pending until Stripe
  retries ([R-086](../RISKS.md#r-086--a-payment-stays-pending-until-stripes-webhook-arrives)).
- Refunds are done by hand in Stripe
  ([R-087](../RISKS.md#r-087--refunds-are-made-by-hand-in-stripe)).
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
