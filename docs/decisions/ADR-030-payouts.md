# ADR-030: Month-end payouts

Date: 2026-11-28.
Status: accepted (the owner's requirements 2026-11-28 SGT; the build
defaults marked below are not yet confirmed).
Decision owner: Abhishek Cherian George (owner) for business meaning;
design by the build agent.

## Context

At month end the owner transfers money to Bobby (the mechanic) for
service, to consignors for what sold, and to Cult Commons. The owner asked
for "a simple system to tell me how much do i owe bobby for service,
consigners for stuff. cult commons etc. Then i can transfer and record the
payments."

His answers: "The first 3000 of service revenue done by him is his. After
cult commons share. example he does 5k in service revenue. amount after cc
is 3500. 3000 is owed to him. 500 goes into to services reserve. Services
reserver is used to pay ad hoc labour." It is BICII's cost after Cult
Commons, so Cult Commons, yield and every existing figure stay as they
are. Cult Commons is owed "The month's Cult Commons", net of the D273/D274
fees, and unpaid months carry over.

Consignors already have a ledger with settlements and reversals (D46, D47);
nothing new is needed for them.

## Decision (D276)

1. **Mechanic service pay.** Per shop month on the sale date basis, each
   mechanic with a pay rule is owed least(service after CC, the monthly
   cap). Service after CC is Σ (sale_total − cult_commons_share) of the
   recognised service lines on the jobs they lead, from the line
   snapshots. The rest goes to the services reserve.
2. **Services reserve.** It also takes all of the service after CC on jobs
   led by someone without a pay rule, or by nobody (build default). Ad hoc
   labour is paid out of it, to a staff member or a named person. Its
   balance may go below 0 and nothing is refused.
3. **Cult Commons owed** is the month's `cult_commons_share` from the same
   rows Reports sums (`private.report_rows`), so it equals
   `report_period_summary` for the month, fees included. No second
   figure is computed.
4. **Consignors** are listed from `reporting.consignor_ledger` and paid
   through their existing Record payment.
5. **Owed is derived live; payments are facts.** `payout_summary` derives
   every owed figure when it is read. `payouts` and `payout_reversals` are
   append-only, replay-safe by a client id with a request fingerprint, as
   consignment settlements are. A payout may exceed what is outstanding
   (operator first). Unpaid months carry over, and the page links the
   carry-over to the earliest month still owed. Tracking starts at the
   first month of the earliest pay rule (build default), so the months
   before the app was used never show as owed or in the reserve. Payouts
   never move it, so a payment recorded for an old month, or reversed,
   cannot turn settled months into carry-over.
6. **Pay rules** are append-only rows (staff, monthly cap, starting month).
   The rule in force for a month is the latest one starting on or before
   it, so a cap change never rewrites a past month. No row is seeded.
7. **Admins only** (build default). The tables are readable by admins
   (RLS `private.is_admin()`) and every RPC calls `private.require_admin()`.
   Bobby's manager role does not open the page.

Considered: storing a monthly statement when the owner pays (it would hide
a later reopen or a back-dated sale, which Reports would show; R-137);
paying the mechanic on every job he worked on, not just the jobs he led (the
data has no split of a job's labour between mechanics); a second
consignor payment path (two ways to record one payment); a configurable
start month for tracking (more to set up; the first pay rule's month marks
it well enough until the owner asks otherwise); starting at the earliest
payout too (one payment for an old month, even reversed, would turn
months settled outside the app into carry-over for every party).

## Consequences

- A reopened job, a back-dated sale or a late fee read changes a past
  month's owed figure, as it changes Reports. What was paid stays, so the
  month then shows an outstanding or "Over by" amount (R-137).
- A job's whole service revenue counts for its lead mechanic (R-137).
- This records what is owed and paid. It is not payroll: no tax, CPF or
  payslips (SPEC lists payroll as out of scope; R-137).

## Revisit trigger

The owner changes a build default (the reserve rule, the tracking start,
the admin-only visibility, build-package labour counting), a second
mechanic shares jobs, or payroll comes into scope.

## Evidence

`supabase/migrations/20261128000100_payouts.sql`;
`tests/db/payouts.test.ts` (the owner's example and every rule above);
`tests/unit/payouts.test.ts`; DATA-MODEL §19 "Month-end payouts"; PLAN
D276; R-137.
