# Decision records

Each consequential decision has one record here, written with the headings of
the Vibe Code Docs Stack decision template (context, decision and rationale,
alternatives actually considered, consequences, revisit trigger, evidence).
A record's status is one of: accepted (a build default the owner has not
individually confirmed), owner-confirmed, amended or changed by the owner
(with the date), proposed, superseded, or not implemented on this branch.
A record is never rewritten to change its history: a later decision gets a
new record (or a dated status change) that links the one it supersedes.
[PLAN §6](../PLAN.md#6-open-decisions-for-the-owner) stays the one-line
index of the D-numbered rows, with each row's status and record; this
directory holds the reasoning. Numbers are allocated by track (2026-10-06),
never "the next free": D43–D59 main line (labels D56–D59), D60–D69
purchasing (D60–D66 used), D70–D79 staff email sign-in, D80–D89 Shopify,
D90–D99 staff roles, D100–D119 reporting, D120–D139 public site,
D140–D149 indent parts and quotes, D150–D159 Stripe payments, D160 and
up later (D160, voiding a fitted indent line, is recorded in ADR-024);
records
ADR-017 labels, ADR-018 purchasing, ADR-019 email sign-in, ADR-020
Shopify, ADR-021 staff roles, ADR-022 reporting, ADR-023 public site,
ADR-024 indent parts and quotes, ADR-025 Stripe payments (a record lands
with its track, so a gap in the numbers here is expected).
ADR-001 stays at its original
path because code and migration comments cite it as "ADR-001".

| Record | Decisions covered | Status (2026-10-05) | Revisit trigger |
|---|---|---|---|
| [ADR-001](../ADR-001-architecture.md) | Architecture: stack, layers, auth, migrations, Supabase boundary, caching, PWA, observability, layout | Proposed in PR #1 (open draft); implemented on the stacked branches through Phase 2 | PR #1 merges (becomes accepted) |
| [ADR-002](ADR-002-devstack.md) | Docker-free devstack instead of the auth shim | Accepted (implemented, used by CI) | First hosted staging project; a pinned service version change |
| [ADR-003](ADR-003-customer-access.md) | Staff-only base tables, customer `my_*` RPCs, explicit anonymous projections | Accepted (implemented and tested); customer sign-up built by Phase 11 step 1 ([ADR-023](ADR-023-public-site.md)) under the same pattern | A new kind of customer-facing data |
| [ADR-004](ADR-004-cult-commons.md) | SPEC §10 rule, D1, D21 | SPEC §10 fixed by the brief; D1, D21 accepted | A new explicit rule for negative yield (SPEC §10) |
| [ADR-005](ADR-005-staff-sign-in-and-delegation.md) | D10 (as first built: email + password), D11 | D10 changed by the owner 2026-10-05 and superseded by ADR-019 (email codes, integrated 2026-10-06); D11 accepted, ceiling unchanged; since ADR-021 restated for roles by D93 | The owner answers question 1 or 20 (D93) |
| [ADR-006](ADR-006-customer-and-public-visibility.md) | D8, D12, D13, D17, D19, D42 | D12 owner-confirmed; others accepted | Phase 11 shows these to customers |
| [ADR-007](ADR-007-short-ids-and-qr-base.md) | D9 | Accepted; QR base decided in Phase 8 by ADR-017 | Short-ID format change |
| [ADR-008](ADR-008-work-order-lifecycle.md) | D15, D16, D18, D20, D22 | D15 owner-confirmed (with its reopen deviation); others accepted | Phase 9 reporting restates periods |
| [ADR-009](ADR-009-line-pricing-and-cost-pending.md) | D14 | Owner-confirmed with clarification | Owner picks one of the cost-pending options |
| [ADR-010](ADR-010-stock-and-units-on-jobs.md) | D6, D23–D29 | D24 amended, D27 changed (implemented by Phase 6, D44), D29 owner-confirmed; others accepted | First D29 workaround (proposed) |
| [ADR-011](ADR-011-recognition-and-financial-reporting.md) | D3, D30–D34 | D32 owner-confirmed; others accepted | Phase 9 reporting |
| [ADR-012](ADR-012-shop-time-zone-and-currency.md) | D35 | Accepted | A second shop, time zone or currency |
| [ADR-013](ADR-013-appointments.md) | D2, D36–D41 | Accepted | Phase 11 customer booking; reschedule or messaging requested |
| [ADR-014](ADR-014-defaults-for-unbuilt-phases.md) | D4, D5, D7 | Accepted defaults; D4 implemented by Phase 6, D5 by Phase 7 (refined by D63), D7 implemented for retail refunds by Phase 6 (D49) and for online refunds by Phase 10 (D85, ADR-020) | Phase 9 reports refunds (D7) |
| [ADR-015](ADR-015-documentation-stack.md) | D43 DOCS-STACK | Accepted | Toolkit version change; an issue tracker is adopted |
| [ADR-016](ADR-016-consignment-and-sales.md) | D44–D55 (consignment and in-store sales; D54 and D55 from the Phase 6 review), the implementation of the owner's D27 change, D4 | Accepted: build defaults, owner to confirm; implemented by Phase 6; D53 and D55 have open questions | Owner confirms a row; D53 or D55 answered; Phase 9 refund reporting (D49) |
| [ADR-017](ADR-017-labels-and-qr-base.md) | D9 (QR base), D56–D59 (labels) | Accepted: build defaults, not individually confirmed by the owner; built in Phase 8 (steps 1–4, `feat/p8-labels`) | Label printers inspected (Phase 12); the public address changes; owner confirms a row |
| [ADR-018](ADR-018-purchasing.md) | D60–D66 (purchasing), the implementation of D5 | D60 accepted, owner informed; since ADR-021 (staff roles, built) it covers only the exception case, a mechanic granted `manage_purchasing`, as managers see costs through their role; D61–D66 accepted: build defaults, owner to confirm; implemented by Phase 7 | Owner confirms a row or objects to the D60 exception case; purchase reports (Phase 9) |
| [ADR-019](ADR-019-staff-email-sign-in.md) | D10 (email one-time codes, the owner's change of 2026-10-05), D70–D72 | D10 owner decision, built; D70–D72 accepted: build defaults, owner to confirm; integrated with main and purchasing 2026-10-06 | Phase 11 customer sign-in; the first hosted project (the staff roles trigger was reviewed with ADR-021: sign-in unchanged) |
| [ADR-020](ADR-020-shopify.md) | D80–D89 (Shopify: online price and recognition, unique products, stock, location, publishing and catalogue, refunds, access and customer linking, retries, rejected deliveries and retention, tax basis and test/POS orders); applies D7 to online refunds | Accepted: build defaults, owner to confirm; D89's tax basis and Shopify POS OPEN for the owner; built by Phase 10 (`feat/p10-shopify`) | Owner answers D89 or confirms a row; the first real Shopify store (R-011); Phase 9's refund-reporting row |
| [ADR-021](ADR-021-staff-roles.md) | D90–D94 (staff roles admin, manager, mechanic; exceptions on top; role administration; refunds for managers, amending D49 and restating D11) | D90, D91, D94 owner decisions 2026-10-06, built (database, app, staff screens; integration-reviewed); D92 accepted, owner to confirm; D93 owner decision with a build-default part, owner to confirm (owner question 20) | The owner confirms D92/D93; a fourth role; a new permission; a hosted project before this lands |
| [ADR-023](ADR-023-public-site.md) | D120–D125 (public site: customer sign-in with codes, linking by email, records at the first booking, bookable range, customer photos, the item page) | Accepted: build defaults, owner to confirm (owner question 30); backend built in Phase 11 step 1, screens in step 2 (repository `bicii`, merged 2026-10-17 SGT; customer accounts not yet opened) | Phase 10 storefront addresses (D125); reschedule or messaging requested; the owner answers question 30 |
| [ADR-022](ADR-022-reporting.md) | D100–D105 (period reporting: date bases, restatement, refunds beside gross, mechanic attribution, shop-currency totals, purchases and stock value); D106–D108 (stock reconciliation without a balance cache, the unsettled-consignment alert, per-kind exception visibility) | Accepted: build defaults, owner to confirm (owner questions 26 and 27; D102 is the build default for question 12); database built in Phase 9 steps 1 and 3, screens in steps 2 and 4 (2026-10-06; Phase 9 complete; on `main` with Phase 10 since its merge, R-058 resolved) | The owner answers question 12, 26 or 27; a measured report slowdown (R-059) |
| [ADR-024](ADR-024-indent-parts-and-customer-quotes.md) | D140–D149 (indent parts, quotes sent by WhatsApp or email, per-item answers on an anonymous page, ordering and fitting; lifts SPEC §7.1 and §30 for quotes; D149, amended 2026-10-15: an admin or manager cancels an unfitted request on a collected or cancelled job; D149a–c, amended 2026-10-15: Fit "Bought outside BICII", no Complete, Ready, Collected or Cancel job while an item is approved or ordered, an open quote withdrawn when the job closes; D160, amended 2026-10-15: voiding a fitted indent line puts the item back to approved or ordered) | Proposed 2026-10-14: owner decisions D140 (workflow), D142 (per item), D144 (WhatsApp and email), D148 (scope), D149, D149a and D149b (approved 2026-10-15 SGT), D149c (confirmed 2026-10-15 SGT, question 34), D160 (2026-10-15 SGT, R-083's first option); others build defaults; built in Phase 13 (D149 in PR #26; D149a–c in PR #27; D160 in PR #30, in production since 2026-10-16 SGT) | PRODUCT questions 31 and 34; a disputed answer; hard reservation requested |
| [ADR-025](ADR-025-stripe-payments.md) | D150–D159 (Stripe Checkout, deposits on quotes, payments recorded from verified webhooks, refunds in Stripe, balance links, rollout, deposit rules, what changes a payment) and D161 (an admin records a counter payment, 2026-10-17) | Accepted (D151–D159 confirmed by the owner 2026-10-17 SGT, q32); steps 1 and 2 in production since 2026-10-14, step 3 next with D161 | Counter payments by staff other than admins, Admin refunds or full payment at collection requested; BICII GST-registered |
