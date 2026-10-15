# ADR-024: Indent parts and customer quotes

Date: 2026-10-14 (design, before Phase 13 is built; on
`claude/brave-clarke-kfqhgt` from `main` 511aac6); amended 2026-10-15
(D149, [below](#amendment-2026-10-15-d149-indent-close)), again
2026-10-15 (D149a–c,
[below](#amendment-2026-10-15-closing-indent-items-d149a-d149b-d149c))
and a third time 2026-10-15 (D160,
[below](#amendment-2026-10-15-voiding-a-fitted-indent-line-d160)).
Status: proposed. The owner decided the workflow and three of its rules on
2026-10-14, D149, D149a–b and D160 on 2026-10-15 (and confirmed D149c the
same day); the rest are build defaults for the owner to confirm
([PRODUCT questions 31 and 34](../PRODUCT.md#open-assumptions-and-owner-questions)).
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
named the unfitted items (replaced by D149b's checklist, below); the Fit
sheet warns before fitting a part never ordered in BICII or one with no
cost; the quote page says "Ask the shop about your deposit." once the job
closed without the parts (its deposit object gains `job_closed`, D143
otherwise unchanged). The containment covers approved and ordered requests
only: a fitted request whose line was later voided stayed fitted and
unflagged
([R-083](../RISKS.md#r-083--a-fitted-indent-request-whose-line-was-voided-is-stuck-and-unflagged);
the owner chose D160, [below](#amendment-2026-10-15-voiding-a-fitted-indent-line-d160)).

**Alternatives considered.** Adding approved parts to the bill when the
customer approves or pays (rejected again: it is the first alternative
above, and would also make a payment write a line, against D154); a
block on Complete until each approved item is fitted or cancelled
(Option C of the analysis) or only a warning at Complete: the owner had
not decided then ("not all orders will happen via the app"), so neither
was built with D149; the owner chose the block the same day (D149b, in
the amendment below, with D149a for parts bought outside BICII).

**Consequences.** A deposit for a part that was never supplied can now
be closed out: cancel the request (D149), then refund in Stripe (D155);
`paid_parts_cancelled` asks for the refund until it arrives (or, when
other parts of that quote were fitted, the closed job's "more than the
bill" shows what is left). Staff could
still complete a job without fitting; the memo, the card and the issue
made it visible rather than impossible, until D149b (below).

## Amendment 2026-10-15: closing indent items (D149a, D149b, D149c)

**Context.** The owner answered the Complete question of D149 (PRODUCT
question 33, R-082): block. The owner also noted that "not all orders will
happen via the app". A part bought elsewhere could then only be fitted
from stock the shop never recorded, which would take the count below zero
(D23) and cost the line at a stale or missing product cost (D24:
`part_cost_missing` when there is none). This is analysis of the code, not
something the owner's test showed: on J-000002 the part was never ordered
or fitted (above). Built in
`20261014000800_outside_purchase_enum` and
`20261014000900_indent_settle_and_outside_purchase`.

**Bought outside BICII (D149a, owner decision 2026-10-15 SGT).** The
owner's rule: Fit gets "Bought outside BICII" for an approved indent part
never ordered through BICII purchasing; staff enter the unit cost; BICII
records it as received at that cost and fits it in one step (stock never
goes below zero; the yield uses the real cost). Parts on a BICII purchase
order are received through Purchasing, then fitted; fitting from existing
stock stays.

How it is built, with the D149c clauses it rests on marked (built as defaults, confirmed by the owner on 2026-10-15):
`fit_part_bought_outside` records the receipt as one movement of the new
type `outside_purchase` (D149c(5)): +quantity at the entered cost, linked
to the job, its `request_id` the new line's id. It sets the product's cost
to that cost as a purchase receipt does (D149c(4); D5, D63; reason "Bought
outside BICII for J-…", with where it was bought when given), and adds the
ordinary line through `add_inventory_line` at the same location in the
same transaction. Only View costs or Manage purchasing holders may record
it (D149c(3)). On-hand there is unchanged, so it never goes below zero;
the line and its yield use the real cost, and D24 ("the cost is never
overridden") holds because the line still takes the product's cost. A
part on a BICII purchase order is refused (`part_request_ordered`), so a
later receipt never counts it twice.

**Settle before closing (D149b, owner decision 2026-10-15 SGT).** The
owner's rule: Complete is blocked until every approved (or ordered,
arrived or not, and not fitted) indent part is fitted or cancelled;
Complete opens a checklist with Fit and Cancel for each. Built as: a job
cannot be completed while any of its requests is approved or ordered
(`work_order_has_unfitted_requests`, a BEFORE UPDATE OF status trigger for
every writer, after the transition, reason and live-line checks, so
`set_work_order_status` is not replaced). Complete opens a checklist of
those items with Fit (or Add to job) and Cancel item…; Complete job is
available once none is left. Proposed, quoted, declined, fitted and
cancelled items never block.

**D149c (built as defaults, confirmed by the owner on 2026-10-15 SGT, PRODUCT question 34).**
(1) The same guard covers the moves into ready for collection, collected
and cancelled, so a job completed before it is settled at Ready or
Collected, and Cancel job lists the items with Cancel only (a fitted line
would block the cancel, D16). (2) An open quote is withdrawn by an AFTER
trigger when its job leaves the open statuses (completed, ready for
collection, collected or cancelled), its quoted items going back
to proposed, so the customer's link says withdrawn instead of open; (6)
the migration withdrew those already left open on jobs that were not open.
(3) Recording an outside purchase needs View costs or Manage purchasing
(D147's rule for an expected cost, D60's for a receipt), where the owner
wrote "staff". (4) The entered cost becomes the product's cost, as a
purchase receipt's does. (5) The new ledger type `outside_purchase`
extends SPEC §12's list of eleven movement types.

**Alternatives considered.**

| Option | Outcome |
|---|---|
| A spot purchase order | Rejected: it needs a supplier, Manage purchasing and a PO number for something not bought through BICII. |
| A costed `stock_adjustment` | Rejected: every purchase would count as a manual, D33-significant correction on Today, in the daily summary and in reports. |
| A cost override on the line | Rejected: it changes D24. |
| Only a warning at Complete | Rejected by the owner (block). |
| Blocking Complete while a quote is open | Rejected: stricter than the owner's rule, and a third action on the checklist. |
| A guard inside `work_order_transition_rule` | Rejected: that function is immutable and pair-only (the app mirrors it). |

**Consequences.** No job can become closed with an approved or ordered
item; jobs closed before the guard keep D149's admin or manager cancel and
`paid_parts_not_fitted`
([R-082](../RISKS.md#r-082--approved-indent-parts-can-be-left-unfitted-on-a-completed-or-collected-job)).
A part bought outside rests on a typed cost with no supplier or document
and is missing from D105's purchase totals
([R-084](../RISKS.md#r-084--a-part-bought-outside-bicii-rests-on-a-typed-cost)).
Yield and Cult Commons formulas, inventory ownership (shop-owned only; D50
refuses the new type on consigned stock) and consignment liability are
unchanged; no snapshot changes.

## Amendment 2026-10-15: voiding a fitted indent line (D160)

**Context.** [R-083](../RISKS.md#r-083--a-fitted-indent-request-whose-line-was-voided-is-stuck-and-unflagged)
(found reviewing the R-082 containment, not seen in production): when a
fitted indent item's job line was voided, `void_line` reversed the stock
and took the line off the bill but left the request `fitted`, pointing at
the voided line. Fit and Cancel both refused it, D149b's settle guard did
not see it, the quote page counted it as ordered, and a deposit for it was
in no payment issue. The analysis offered three fixes: the void undoes the
fit; D149's cancel also accepts such a request; or a separate payment
issue for such deposits.

**Decision (the owner, 2026-10-15 SGT, the first of the three).** The void
undoes the fit. When a job line that a fitted indent request points at is
voided, the request goes back to where it was before Fit: `ordered` if it
is on a purchase order line, else `approved`. Its link to the line, who
fitted it and when, and (D149a) its link to the `outside_purchase` receipt
are cleared; the receipt itself stays, and the void's reversal puts the
part back into stock, so a re-fit takes it from stock. The job's timeline
records it (`part_request_unfitted`). The request can then be fitted again
or cancelled; D149b's checklist holds Complete, Ready, Collected and
Cancel job until it is; `paid_parts_not_fitted` flags a held deposit for
it should such a job ever close; and the quote page and the memo count it
as approved or ordered again.

How it is built (`20261014001000_part_unfitted_enum`,
`20261014001100_indent_unfit_on_void`): an AFTER UPDATE trigger on
`work_order_line_items`, for every row whose `voided_at` is set, calls
`private.unfit_part_request` in the void's own transaction and under the
job lock the void already holds. A trigger rather than a new `void_line`:
a void is a single UPDATE of `voided_at` (the line's rules allow nothing
else), so the trigger covers every writer, owner writes included, and
`void_line` (already in production) is not replaced: its checks, errors,
replay, stock reversal, unit status and publication refresh are exactly as
before. Built with it as build defaults (not part of the owner's choice):
a request is never linked to a voided line
(`job_part_requests_require_live_line`, `part_request_line_voided`), so a
stale Fit replayed with the voided line's id cannot re-link it through the
line RPCs' replay; and a one-off un-fits, once, requests already in R-083's
state (none known in production), reporting in a NOTICE how many are on
jobs no longer open and how many on a job with a live line of the same
item added after the void that no request is linked to (perhaps added
again by hand under R-083's workaround: staff check, and cancel the
request if it was).

**Alternatives considered.**

| Option | Outcome |
|---|---|
| D149's cancel also accepts a fitted request whose line is voided | Not chosen by the owner: the item could only be cancelled, never fitted again, and D149b's guard would still not see it. |
| A separate payment issue for such deposits (ignoring a job with a live line of the same item) | Not chosen by the owner: a flag after the fact, with the request still stuck. |
| Replace `void_line` with the un-fit in its body | Rejected: it covers one writer only and copies a 150-line production function; the trigger is in the same transaction and lock order. |
| Un-fit only, without the live-line guard | Rejected: `add_inventory_line` and `add_service_line` answer a voided line as a replay, so a retried Fit form would put the request back on the voided line. |

**Consequences.** A fitted request always points at a live line. Voiding
a fitted line now asks staff to settle the item again before the job
closes, and the void's confirmation says so ("Voiding puts … back to
approved: fit it again or cancel it before completing the job."). Stock
arithmetic, line totals, yield, Cult Commons, money and snapshots are
unchanged; who may void is unchanged (any active staff member on an open
job, D15).

## Revisit trigger

The owner's answer to question 31; a request for hard reservation, for
customers to see quotes on the public site, or for messages other than
quotes.

## Evidence and links

- The owner's request and answers, 2026-10-14 (this session): WhatsApp and
  email, per item, deposits through Stripe.
- R-083's options and the owner's choice of the first, 2026-10-15 SGT
  (D160); `tests/db/indent-unfit.test.ts`.
- SPEC §7.1, §30; DATA-MODEL §4 (workshop), §5 (line items), §7 (the
  movement ledger), §10 (purchasing); [ADR-010](ADR-010-stock-and-units-on-jobs.md) (D23–D25),
  [ADR-018](ADR-018-purchasing.md) (D60–D66).
- Market practice for basic service scope and indent ordering: the
  owner's research request of 2026-10-12–14 (Singapore shops' published
  service pages).
