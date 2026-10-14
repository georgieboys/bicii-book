# ADR-024: Indent parts and customer quotes

Date: 2026-10-14 (design, before Phase 13 is built; on
`claude/brave-clarke-kfqhgt` from `main` 511aac6). Status: proposed. The
owner decided the workflow and three of its rules on 2026-10-14; the rest
are build defaults for the owner to confirm
([PRODUCT question 31](../PRODUCT.md#open-assumptions-and-owner-questions)).
Decision owner: Abhishek Cherian George (owner) for business meaning;
defaults proposed by the build agent.

## Context

An indent part is a part the shop does not stock and orders from a
supplier for one customer's bike. On 2026-10-14 the owner asked for
indent parts to be supported end to end: the part is added to the system,
added to the job, an approval request is sent to the customer, and once
approved the part is ordered and then fitted to the bike.

The brief left this out on purpose: SPEC §7.1 says customer approval of
extra work happens offline and an internal flag is enough, and SPEC §30
lists an automatic customer approval workflow and automated messaging as
out of the MVP. This record is the owner's change of that scope for
indent parts and the quotes that carry them. SPEC.md stays the verbatim
brief; this record and PLAN Phase 13 say what changed.

What the build had (Phases 3, 4 and 7):

- A part on a job is a `work_order_line_items` row added by
  `add_inventory_line`, which records the `job_consumption` movement in
  the same call; a quantity part may take stock below zero (D23) and needs
  a price and a cost (D24). Lines have no proposed state: they are live
  until voided.
- Purchase orders order quantity-tracked, shop-owned products (D62), one
  line per product, and receiving records `purchase_received` movements
  (D63–D65). Nothing links a purchase order to a job.
- Approval is `work_orders.approval_flag` and `approval_note`, set by
  staff (`set_approval_flag`), never seen by the customer.
- Customers have an email and a phone; the Admin sends no messages and has
  no page a customer can open without signing in.

## Decision and rationale

| D | Rule (short) | Status | Implemented in |
|---|---|---|---|
| D140 | INDENT-ITEM: an indent part is a part request on an open job (`job_part_requests`): a shop-owned, quantity-tracked, active product (an existing one, or one created from the job), a quantity, the sale price shown to the customer and, for `view_costs` holders, the expected cost and supplier. A request has a state (proposed, quoted, approved, declined, ordered, fitted, cancelled) and records no stock movement and no job line. The job's lines, totals, yield and Cult Commons are untouched until the part is fitted, which adds an ordinary part line through `add_inventory_line` with all of D15, D23 and D24 | Owner decision 2026-10-14 (the workflow); details build default | Phase 13 step 1 |
| D141 | QUOTE: staff send a quote: a snapshot of chosen proposed items (each part request, and fitting labour as a proposed service from the catalogue) with names, quantities, prices and the total, for one job, valid 7 days. One open quote per job: sending another withdraws the previous one. The quote is reached through a private link holding a 32-byte random token; only its SHA-256 is stored, so the link is shown to staff only when the quote is sent, and sending again makes a new link | Build default | Phase 13 step 1 |
| D142 | QUOTE-ANSWER: the customer approves or declines each item, types their name and submits once. Approved part requests become approved, declined ones declined; approved services can be added to the job by staff. The answer is final: a change of mind is a new quote. The answer sets the job's approval flag with a note saying what was approved online, by whom and when, and is recorded in the job timeline | Owner decision 2026-10-14 (per item); rest build default | Phase 13 step 1 |
| D143 | QUOTE-PAGE: the quote page is an anonymous page of the Admin, `/quote/[token]`: the shop's name, the job number, the bike, the customer's first name, the items with prices, the total, the expiry and (Phase 14) the deposit. Never costs, notes, staff names, the customer's contact details or other jobs. Expired, withdrawn and answered quotes say so. Not indexed; no referrer is sent; requests are rate-limited per client | Build default | Phase 13 step 3 |
| D144 | QUOTE-DELIVERY: staff send a quote by WhatsApp (a `wa.me` link to the customer's phone with the message and link filled in; an 8-digit Singapore number gets +65), by email (sent by the Admin through Resend when `RESEND_API_KEY` is set and the customer has an email), or by copying the link. The channel used is recorded | Owner decision 2026-10-14 (WhatsApp and email) | Phase 13 steps 2 and 3 |
| D145 | INDENT-ORDER: staff holding `manage_purchasing` order approved part requests: each is added to the supplier's open draft purchase order (or a new one), raising that product's line by its quantity, and linked to that purchase order line. Ordering can also move the job to Waiting on parts | Build default | Phase 13 step 1 |
| D146 | INDENT-FIT: a request is "arrived" when receipts on its purchase order line cover it, first requested first covered. Fit adds the part line from the location it was received into and marks the request fitted. Arrived stock is shown as reserved for the job on the product, but nothing stops it being sold or used elsewhere | Build default | Phase 13 steps 1 and 2 |
| D147 | INDENT-ACCESS: any active staff member proposes items and sends quotes on an open job, as any staff member adds parts; ordering needs `manage_purchasing`; costs and suppliers need `view_costs` or `manage_purchasing` (D60). Customers reach a quote only through its link; the public site shows nothing of it | Build default | Phase 13 step 1 |
| D148 | INDENT-SCOPE: SPEC §7.1's offline approval and SPEC §30's exclusion of customer approval and automated messaging are lifted for quotes only. Ordinary parts and services are still added straight to a job, with the internal approval flag as before | Owner decision 2026-10-14 | This record |

Full text: [PLAN §6](../PLAN.md#6-open-decisions-for-the-owner), rows
D140–D148. Payments (the deposit on a quote) are
[ADR-025](ADR-025-stripe-payments.md).

## Alternatives actually considered

| Option | Why chosen or rejected |
|---|---|
| Add the indent part to the job as an ordinary line at once | Rejected: the line would record a `job_consumption` movement and take stock below zero (D23) for a part nobody has approved, and would count in the job's totals, yield and Cult Commons before it exists |
| A proposed state on `work_order_line_items` | Rejected: lines are immutable except for one void (D15) and every report reads them; a separate request that becomes a normal line when fitted keeps every existing rule and report unchanged |
| Customers approve on the public site after signing in | Rejected for now: customer sign-up is not open, and a link in WhatsApp is how Singapore customers expect to answer; a signed-in view can be added later |
| Store the link token so staff can show it again | Rejected: a stored token is a password on the database; storing only its hash means a database read cannot answer a quote |
| Reserve received indent stock hard | Rejected for the first build: it needs a reservation in the stock ledger that every sale and part line would respect (D23, D25); shown as reserved instead ([R-080](../RISKS.md#r-080--arrived-indent-stock-is-not-held-for-its-job)) |
| WhatsApp Business API messages | Rejected: it needs a Meta business account, templates and fees; a `wa.me` link sent from the staff phone works today |

## Consequences

- Anyone holding a quote link can answer it until it expires
  ([R-078](../RISKS.md#r-078--whoever-holds-a-quote-link-can-answer-it)).
- Email quotes wait for the Resend domain and an API key
  ([R-079](../RISKS.md#r-079--email-quotes-need-the-resend-domain-and-api-key)).
- Arrived indent stock can be used for another job or sold
  ([R-080](../RISKS.md#r-080--arrived-indent-stock-is-not-held-for-its-job)).
- The Admin gets its first anonymous page and its first outgoing
  customer messages; both are limited to quotes.

## Revisit trigger

The owner's answer to question 31; a request for hard reservation, for
customers to see quotes on the public site, or for messages other than
quotes.

## Evidence and links

- The owner's request and answers, 2026-10-14 (this session): WhatsApp and
  email, per item, deposits through Stripe.
- SPEC §7.1, §30; DATA-MODEL §4 (workshop), §5 (line items), §7 (the
  movement ledger), §10 (purchasing); [ADR-010](ADR-010-stock-and-units-on-jobs.md) (D23–D25),
  [ADR-018](ADR-018-purchasing.md) (D60–D66).
- Market practice for basic service scope and indent ordering: the
  owner's research request of 2026-10-12–14 (Singapore shops' published
  service pages).
