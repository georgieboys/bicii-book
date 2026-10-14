# ADR-024: Indent parts and customer quotes

Date: 2026-10-14 (design, before Phase 13 is built; on
`claude/brave-clarke-kfqhgt` from `main` 511aac6); amended 2026-10-15
(D149, [below](#amendment-2026-10-15-d149-indent-close)). Status: proposed. The
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
| D149 | INDENT-CLOSE: an active admin or manager may cancel an indent request that was never fitted on a collected or cancelled job (one on a quote left open there withdraws that quote first), with a required reason recorded on the timeline; Fit stays refused on any job that is not open; collected and cancelled stay final for everything else ([amendment](#amendment-2026-10-15-d149-indent-close)) | Owner decision 2026-10-15 SGT (approved) | `20261014000700_indent_closed_jobs` |

Full text: [PLAN §6](../PLAN.md#6-open-decisions-for-the-owner), rows
D140–D149. Payments (the deposit on a quote) are
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

## Amendment 2026-10-15: D149 INDENT-CLOSE

**Context.** The owner's live test in production on 2026-10-15 SGT
(J-000002, no customer data here): an indent part was proposed, quoted,
approved and its deposit paid through Stripe; the job was then completed
and collected without the part ever being ordered or fitted. D140 held:
the part never became a line, so the bill and the yield were S$0. But
nothing said why, the deposit sat held with no flag, and on the
collected job the request could be neither fitted nor cancelled (D15:
collected and cancelled are final). The analysis is recorded in
[R-082](../RISKS.md#r-082--approved-indent-parts-can-be-left-unfitted-on-a-completed-or-collected-job).

**Decision (the owner, approved 2026-10-15 SGT).** An active admin or
manager (`private.can_record_refunds()`, the role check of D94 and D152)
may cancel a request that is not fitted on a collected or cancelled job,
with the same required reason and the same `part_request_cancelled`
timeline entry. A request still on a quote left open when the job closed
is included: nobody can answer or withdraw that quote on a closed job, so
the cancel withdraws it first (`quote_withdrawn`; its other items go back
to proposed, and can be cancelled the same way). Fit stays refused on
every job that is not open, and collected and cancelled stay final for
everything else: the job's
status, lines, people and totals do not move, and anyone else still gets
`work_order_closed`. This is the one exception to D15's "nothing changes
on a closed job except its notes", for requests only.

**Built with it (build defaults, not part of the owner's approval; no
change to money, lines, stock or Cult Commons).** Ordering refuses a job
that is not open and withdrawing a quote refuses a closed one (they had
no status check in the database). The job page
shows approved items not on the bill as a memo under the Lines total,
summed in Postgres (`work_order_unfitted_requests`) and never added to
the total, the yield or Cult Commons. A deposit held for them on a
completed, ready or collected job is the payment issue
`paid_parts_not_fitted` (naming only the share the quote's fitted parts do
not account for); an item on a quote left open on a job that is no longer
open shows "Not answered"; a closed job shows what was paid above its bill
(`work_order_payment_totals.held_over_total`); both ways to Collected
name the unfitted items; the Fit sheet warns before fitting a part never
ordered in BICII or one with no cost; the quote page says "Ask the shop
about your deposit." once the job closed without the parts (its deposit
object gains `job_closed`, D143 otherwise unchanged). The containment
covers approved and ordered requests only: a fitted request whose line
was later voided stays fitted and unflagged
([R-083](../RISKS.md#r-083--a-fitted-indent-request-whose-line-was-voided-is-stuck-and-unflagged),
owner to decide).

**Alternatives considered.** Adding approved parts to the bill when the
customer approves or pays (rejected again: it is the first alternative
above, and would also make a payment write a line, against D154); a
block on Complete until each approved item is fitted or cancelled
(Option C of the analysis) or only a warning at Complete: the owner has
not decided ("not all orders will happen via the app"), so neither is
built and the choice will take its own number from D160.

**Consequences.** A deposit for a part that was never supplied can now
be closed out: cancel the request (D149), then refund in Stripe (D155);
`paid_parts_cancelled` asks for the refund until it arrives (or, when
other parts of that quote were fitted, the closed job's "more than the
bill" shows what is left). Staff can
still complete a job without fitting; the memo, the card and the issue
make it visible rather than impossible.

## Revisit trigger

The owner's Complete decision (block or warn, R-082); the owner's answer to question 31; a request for hard reservation, for
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
