# Current state

Updated: 2026-11-22 SGT (audit batch 3, database; branch `fix/audit-db`,
migrations `20261122000500` to `20261122001100`; merge after PRs #108 and
#109). From the 2026-11-13 audit: a non-admin can no longer reactivate
someone holding access they cannot grant (A-06); a stalled integration job
ends in needs attention after its attempts, and a deferred stock push is no
longer restarted by a newer change (A-17, A-19); booking emails use the
adventure outbox design: claim tokens, attempts counted on results,
releases, late successes kept (A-10, A-20, R-100), and the migration makes
rows given up in the last day due again; a purchase order with customer
indent parts ordered on it cannot be cancelled or cut below them (A-21); a
customer with open work cannot be archived (A-22); a customer's online
cancellation of a staff-made booking alerts the shop (A-23); staff can put
into the public bucket only copies of recorded internal photos (A-24).
Held back for the owner: A-04 (online stock held for unrecorded paid
orders changes D83).
Before that,
Updated: 2026-11-22 SGT (audit batch 2, Adventures; branch
`fix/audit-adventures`, migration `20261122000400`, merge after batch 1's
PR #108 so the migrations apply in order). An earlier tracker hire sold
after a later one is now checked through its own return and grace days; a
stale payment page on a replaced or cancelled booking is read back; a
rider's cancellation request no longer emails a false payment alert and
always counts in Health; a ride file whose result the database refuses is
marked unreadable instead of blocking the parse queue.
Before that,
Updated: 2026-11-22 SGT (backend audit, local-only `AUDIT-2026-11-22.md`;
batch 1 on branch `fix/audit-builds`, migration `20261122000300`). Build
RPCs no longer return line costs to staff without cost access; linking a
paid online build to a job that already has the package takes the price
paid; a package's own-frame and donor variants are never "unmapped" or
linkable to a product; a package on Shopify must be taken off before it is
archived; the Shopify runner's budget covers seven calls a job (90 s
routes); E2E blanks local Shopify and email keys; CI refuses a new
migration dated before main's newest. Build extras (D261, PR #107) are
live: migrations applied by `migrate.yml`, objects checked in production.
Before that,
Updated: 2026-11-22 SGT (build extras, D261, ADR-028 amendment; branch
`feat/build-extras`, migrations `20261122000100` and `20261122000200` apply
by `migrate.yml` on merge). On a job with a build package, a part (shop
stock, a unique item or a consigned item) can be charged on top: **Charge on
top** on its row in the build card, or the **Charge on top of the build
package** box in Add part. It keeps its own price (a fitted part goes back to
its shelf price), **Fit parts to budget** leaves it out, and the card lists
it under "Extras, charged on top"; it still takes stock, owes a consignor
and counts as product revenue. A one-off with no stock record is a manual
line; Add part links to one carrying the search. Verified locally:
typecheck, lint, format and unit tests (`job-build-extras.test.tsx`) pass;
the database tests (`tests/db/build-extras.test.ts`) and the types check run
in CI only, because `.env.local` points at production. First next action:
after merge and the migration, check a build job's card in the Admin.
Before that,
Updated: 2026-11-20 SGT (frame grades on Shopify and the base-price model,
D260 amendments; merged and live: bicii-book PR #105, BICII PRs #99 and
#100; migrations `20261120000200` and `20261120000300` applied by
`migrate.yml`). A grade is the frame itself, before any work done to it;
its price in `frame_grades` is a base, with work such as a disc conversion,
a repaint or kintsugi priced on top (the owner). The Admin offers the base
under Sale price with **Use it** and shows Frame grade only for frames; a
failed save keeps the grade. A graded product's Shopify title ends "· B+
frame", it is tagged "Grade B+" and its description ends with "Frame grade
B+ (C to S++, S best): the frame itself, before any work done to it. Not a
safety rating."; BICII owns the tags of products it made (R-130). In
production under the owner's admin claims, after the new Admin was live:
P-000144 Marin B, P-000145 KHS Descent B+, P-000146 KHS Comp B+. Verified:
the 5-minute integrations cron pushed all three (sync rows synced, jobs
done); the storefront's product JSON shows each title suffix, its one
"Grade" tag, the grade as the last paragraph, prices 470/490/525 unchanged
and photos 12/20/20 (none duplicated); P-000144's page on bicii.sg shows
"Frame grade B"; /builds carries the new grade wording. Before merge: two
independent reviews (no high or medium findings survived; the low ones are
fixed or recorded), CI green. Open: none for grades. Before that,
Updated: 2026-11-20 SGT (frame grades, D260, ADR-029; branch
`feat/frame-grades`, migration `20261120000200` applies on merge). A frame's
price is said as a grade, C to S++ (S best), each with a suggested price in
`frame_grades` (C S$200, C+ 250, C++ 300, B 400, B+ 500, B++ 600, A 800, A+
1,000, A++ 1,200, S 1,500, S+ 2,000, S++ 2,500). **Frame grade** on New
product and Edit details shows the suggestion under Sale price with **Use
it**; the price is never changed by itself. The grade shows on the product
page and in `reporting.public_items`; the site reads the grades with
`public_frame_grades`. Verified before merge: typecheck, lint, format and
the unit tests; the DB tests (`tests/db/frame-grades.test.ts`) run in CI.
First next action: grade the three consigned frames (P-000144 to P-000146).
Before that,
Updated: 2026-11-20 SGT (frame options and pictures on Shopify, D257-D259,
ADR-028 amendment; merged and live: bicii-book PR #101, BICII PR #93 for
the pictures; migration `20261120000100` applied by `migrate.yml`). Each
full build on Shopify has a **Frame** option: "Prepared frame from BICII"
(the original variant, so the site's cart links keep working), "My own
prepared frame (inspected first)" at the package price, and "Donor bike,
stripped and prepared (+S$185)" from the package's donor service, priced
in Postgres (`build_package_online_prices`). The description explains each
option. A package has a **Picture link**, pushed as its Shopify media; the
four use the site's `/builds/packages/<package>.png`, drawn in the site's
De Stijl grid. An order on any variant becomes a build order with its frame
option; linking a donor-bike order adds the S$185 strip as its own line and
prices the build at the rest. In production under the owner's admin claims:
each full build's donor service ("Donor bike strip and prep") and picture
set, then pushed with the Admin's push code run locally (the variant ids
recorded with `record_build_package_push`). Verified: CI green on #101
(unit, DB, types, e2e); the storefront's product JSON shows one picture and
the three options on all four (Classic S$485/485/670, Classic+ 785/785/970,
Restomod 1,075/1,075/1,260, Restomod+ 1,680/1,680/1,865); no order placed.
Open: what happens to the money when an own frame is refused (R-123, the
owner's wording); a donor price change needs Update on Shopify (R-124).
First next action: the owner's wording for a refused own frame. Before that,
Updated: 2026-11-17 SGT (build packages, D246-D256, ADR-028, merged and
live: bicii-book PRs #95 and #96, BICII PR #82, BICII PR #80 for the
hours sentence; migrations `20261117000100` to `20261117000400` applied by
`migrate.yml`). A full build (Classic S$485 since 2026-11-18, was S$390; Classic+ S$785, Restomod
S$1,075, Restomod+ S$1,680) sets a job's package: a S$180 labour line
(service revenue) and the rest as the parts budget; **Fit parts to
budget** prices the fitted parts down to it with one discount (never above
shelf price; parts under budget leave the difference to labour);
**Reprice** adjusts one part. Revenue counts at the job's completion. The
four full builds are untracked Shopify products (pushed 2026-11-17 with
the Admin's own push code, run locally because the production Admin needs
the owner's sign-in; ids recorded with `record_build_package_push`); a
frame's site page (`/q/P-000144` checked) offers each with a cart link
holding the frame and the build (checkout opened with 2 items, S$860,
nothing submitted). An order's package line becomes a build order (money
held); **Link online order** on the job's Build card puts it on the job at
the amount paid. Build-only packages (Full Send, Clean Slate from S$325,
Full Rebuild, named Strip and rebuild until 2026-11-20) are on the customer's bike page and the booking form.
Production data: service "Build package labour" (S$180, not public), service
"Donor bike strip and prep" (S$185, not public, added 2026-11-20 for a donor
bike with a full build) and
the seven packages. An independent review of PR #96 found six defects,
all fixed before merge. Open: refunds and unlinked orders (R-122); the
Marin's and the Descent's sizes are estimates awaiting the owner's
measurements. The site's opening hours already follow the Appointments
schedule; the sentence under them no longer names days. Before that,
Updated: 2026-11-16 SGT (three of the owner's frames consigned and listed,
in production under the owner's admin claims): P-000144 Marin Bolinas
Ridge (C-000029, asking 470), P-000145 KHS Montaña Descent (C-000030,
490) and P-000146 KHS Comp 13-inch (C-000031, 525), each a unique
consignment item of the owner's consignor at RV Shop floor with 200 owed
to him on sale, a researched description, the owner's photos (12, 20 and
20, uploaded to Storage and recorded with `record_attachment`), public and
published online. The Marin's description names its silver Kintsugi finish and both KHS frames their rust-converter treatment (the owner, same day). Verified by read-only queries: all three synced to Shopify at quantity 1 and the asking price after those edits. Before that,
Updated: 2026-11-15 SGT (product groups, D241-D245, ADR-027, merged:
bicii-book PR #91, BICII PR #51; migration `20261115000200` live in
production). The same day, in production under the owner's admin claims,
the shipment's colours were grouped: G-000001 Retro shock-absorbing saddle
(P-000111 to P-000115), G-000002 Vintage hollow saddle (P-000116 to
P-000119), G-000003 Jockey wheels 11T aluminium (pair) (P-000122 to
P-000126), option Colour. All are drafts, so nothing is on Shopify yet: the
first group published online is the first live group push. one
style in several colours or sizes stays one BICII product per colour
(stock, price, cost, labels, consignment unchanged) gathered in a product
group (G-######, Inventory → Groups; a product joins from its Group card).
Shopify shows each group as one product with a variant per member
(`bicii-g-<n>`); the public item page lists the group's colours. A product
already on Shopify alone keeps out of groups, and two batches of one
colour can't share a group (R-120). Verified locally: database
`tests/db/product-groups.test.ts` 6/6 (and `shopify-sync` with it), the
Shopify unit tests 19/19 in `shopify-sync`, e2e `product-groups.spec.ts`
and `inventory.spec.ts` on phone and iPad (10 passed), the site's item page
by hand with a local group. Before that,
2026-11-15 SGT (D240, PR #89, merged and live: a cancelled
purchase order's line and a cancelled or declined indent request no longer
block `reclassify_as_consignment`. The owner said the 2026-11-14 shipment
(PO-000001, new products P-000111 to P-000141) is his own goods consigned
to the shop and that every product on the site is his consignment. Done in
production that day under the owner's admin claims: PO-000001 cancelled
(its lines stay as the record of quantities and costs; take the goods in
as consignment intake when they arrive); 113 shop products reclassified to
the owner's consignor (only the Soul seatpost held stock, 1 unit); the two
with trading history moved the D45 way: the headset spacer P-000003 (19)
and the FUKC T-shirt P-000004 (8) counted out, archived with `-SHOP`
SKUs, and taken in again as P-000142 and P-000143 with their SKUs, prices
and costs as the amounts owed. P-000143 carries the T-shirt's photo (a
Storage copy), is public at `fukc-t-shirt-p-000143` and synced to Shopify
(`bicii-p-000143`, 8 at 35); P-000004's Shopify product is drafted at 0.
Every live product is now consigned. Verified by read-only queries.
Earlier, 2026-11-14 SGT (
the audit's low findings on branch
`fix/audit-low`, D232-D239: emails match their event and the rider's board
choice; late-registered devices get their positions; lock order; unused
signatures purged after 7 days; cancellation requests wait in Needs
attention; only facilitators go on dates; stale catalogue editors refused;
lists say when they're capped; waiver 2026-11-14.2 aligned and published,
closed days counting toward late fees (the owner's decisions); stale docs
corrected. Before that, PRs #86-#87 and BICII #48, the medium findings;
PR #87, evidence, names and Admin screens, D228-D231: file
reading gives back attempts that weren't the file's fault; evidence limits
hold on what arrives and unused objects leave Storage; board names refuse
hidden characters and shop words and stay locked after a take-down (the
owner's choice); no floods of repeat requests; the review radius in the
checkpoint editor; the hand-back sheet shows the late fee; sheets keep what
was typed after a refusal. Before that, PR #86, bookings and money,
D223-D227: cancelling a supported date
releases trackers, flags and tells riders, and they can be moved; stale
payments are read back from Stripe and cancelling expires the Stripe page;
trackers stay out of the pool through the grace day (the owner's choice);
returning a tracker closes a forgotten ride window; a decided ride's window
is fixed; the cancelled-booking refund line. Before that, PR #85: the five
high findings, D220-D222: a cancelled booking is never
reviewed or certified; one open checkout per rider per route, the newer
replacing the older; a supported date's trackers follow the date and its
riders are emailed; GPX read in linear time and the cron's steps isolated;
the tracker feed's watermark no longer stalls after a backlog. Verified
locally: unit 1,836, database 914, the 20 adventure e2e runs. Before that:
the owner's sales terms, D212-D219, PR #84, then BICII #47).
Riders sign a waiver before paying (typed full name, emergency contact,
five declarations; sealed versions an admin publishes; the first is
`docs/adventures/waiver-2026-11-14.md`, which needs a lawyer's review,
R-104); refundable until the ride is sent for review (D212); a tracker's
grace day, then 20 a day, recorded and settled at the shop (D213, R-105);
no retries, the pack a gift (D214); 125 km: 24 hours, no e-bikes (D216);
T-shirts S to XXL, collected from the shop (D217); the board name is the
rider's choice or none (D218); the owner's confirmations for flags, group
rides, sharing and supported rides (D219). Verified locally: `npm run
check`, unit 1,830, database 908 (7 new in `tests/db/rider-terms.test.ts`),
the 20 adventure e2e runs (phone and tablet, with the new
`adventures-terms.spec.ts`). Before that: Adventures built and checked
against the handoff's acceptance tests, every switch off in production
(PR #82, #83; BICII #45, #46; what stays partial is R-103).
**Production data changed outside a PR (2026-11-14, at the owner's
request):** BICII 125 revisions 3 and 4 were published in production by
calling the route editor's RPCs (`start_adventure_draft`,
`update_adventure_draft`, `set_adventure_offer`,
`publish_adventure_revision`) through SQL with the owner's admin claims:
maximum time 1,440 minutes (24 h, D216), 1 nominal day, and a
self-supported offer at S$49 with tracker hire at S$20 a day and the
inclusions sentence. Revision 4 is current and has no checkpoints. A
database built from migrations has none of this. Do not republish BICII
125 without starting from revision 4. Sales are still off.
Next, before any sale: the fixes from the 2026-11-14 audit, the lawyer's
review of the waiver, the 125 km checkpoints, then an admin switches sales on
([RUNBOOK](docs/RUNBOOK.md#switching-certified-ride-sales-on)).
Earlier: Adventures Phase A,
D164–D171; earlier the same day, PRs #61–#65:
Shopify connected and publishing to the Online Store, migrations only after
green CI, Next.js 16.4.6; earlier: D162 and the consigned cost in production,
PRs #50–#53, customer sign-up fixed, PRs #54–#55; no public active
appointment type yet). Earlier
evidence, 2026-10-24: `main` f120c6d; PR #45 (CI and label-run e2e green on
a666bef) merged as d30473d, `migrate.yml` run 20, the
hosted project read-only (75 migrations, the last `20261019000100`) and
Vercel's production build of f120c6d READY, all 2026-10-19; the hosted
project read-only again on 2026-10-24 (below). Earlier checkpoints with each
release's evidence:
[NOW.md at f120c6d](https://github.com/georgieboys/bicii-book/blob/f120c6d/NOW.md)
and the pull requests.

## Return in two minutes

- Purpose: the staff Admin for BICII's workshop, over one Supabase backend
  shared with the public site ([PRODUCT](docs/PRODUCT.md)).
- Current objective: booking emails (D163, the owner's request of
  2026-11-12): alerts to the shop and confirmations to the customer for
  online bookings and cancellations, queued in Postgres and sent by a
  minute cron through Resend
  ([R-096](docs/RISKS.md#r-096--booking-emails-can-fail-without-anyone-seeing)).
- Next action: merge it when CI and e2e are green, confirm `migrate.yml`
  applied `20261112000100`, set the recipients the owner named (the shop's
  mechanic and team mailbox) and check the first emails
  ([RUNBOOK](docs/RUNBOOK.md#booking-emails)). The owner: a public, active
  appointment type for online booking, the amounts owed still at 0.00,
  and the owner questions, first 38 (booking emails), 35, 36 and 30
  ([PRODUCT](docs/PRODUCT.md#open-assumptions-and-owner-questions)).
- Main blocker: no restore has been exercised and there is no staging project
  ([R-002](docs/RISKS.md#r-002--no-backups-monitoring-alerting-or-exercised-recovery),
  [R-001](docs/RISKS.md#r-001--nothing-is-deployed)).

## What is actually working

All of `main` runs in production: the Admin on Vercel (sin1), the database on
the hosted Supabase project (ap-southeast-1), migrations applied only by
`migrate.yml`. CI runs `check`, `test (unit + db)` and `build` on every pull
request; the full e2e suite runs on the `e2e` label and nightly.

| Capability | Implemented | Verified | Deployed |
|---|---|---|---|
| Staff sign-in, roles, staff | Yes | CI, e2e; codes arrive via Resend (owner, 2026-10-15) | Production |
| Customers, bikes, jobs, Today, inventory, consignment, sales, purchasing, reporting | Yes (Phases 1–9) | CI, e2e | Production |
| Labels | Yes (Phase 8) | CI, e2e; the old alias's `/q` redirect and the retired scan base by unit tests | Production; QR address https://bicii.sg since the evening of 2026-10-28. The 29 product labels printed earlier that day carry the Admin's old alias and keep working: that alias redirects `/q/*` to the public site and the Admin scanner accepts it (this change; R-013) |
| Shopify | Yes (Phase 10), fake store only | CI, e2e ([R-047](docs/RISKS.md#r-047--the-live-shopify-adapter-is-unverified-against-a-real-store)) | Off: no store, no `CRON_SECRET` |
| Public site's backend | Yes (Phase 11) | DB tests; the site's journey 6 | Live and in use since 2026-10-28: the public site (https://bicii.sg) has its variables set, sign-in is open, hours show; no public, active appointment type yet, so no online booking |
| Indent quotes and deposits | Yes (Phases 13–14) | CI, e2e; a live deposit paid and refunded | Production; deposits at 100% |
| Payment links, counter payments | Yes (Phase 14 step 3) | CI, e2e with the fake Stripe | Production; none used yet (2026-10-24), no test-mode rehearsal |
| Audit fixes | Yes (PRs #38, #43–#45) | CI and label-run e2e | Production |
| Reclassify shop stock as consigned (D162) | Database, the admin-only Change owner, the item-id fix and a consigned product's cost as its amount owed (PRs #50–#53) | CI and full e2e green on PR #51; PR #52's unit test failed before it and passed after; `consigned-product-costs.test.ts` failed first and passes | Production since 2026-10-28 SGT (the owner's 25 products reclassified, checked read-only); the cost change since 2026-10-29 (`migrate.yml` run 22, Vercel's build of e201b34 READY; the products' costs checked read-only) |
| Adventures (D164–D211) | Catalogue, bookings, review and pack screens in the Admin; checkout, evidence, review, certificates and emails in the database; the rider's journey on the public site (BICII #43) | DB tests (`adventure-*.test.ts`), unit tests, `adventures-review.spec.ts` against the local stack; checkout and webhook end to end against the local stack | Catalogue in production (9 routes); every adventure switch off (sales, tracker hire, supported sales, live sharing, public profiles) |
| Booking emails (D163) | Yes: Postgres outbox, minute cron, Settings → Booking emails | `appointment-notices.test.ts` (9), unit (11) and the settings e2e locally; CI not run yet | Not deployed |

Commands and evidence: [ENGINEERING](docs/ENGINEERING.md#commands),
[TESTING](docs/TESTING.md).

## Work location and continuation

- georgieboys/bicii-book (public), `main` 9b52589 (PR #54). Use `origin/main`.
- `claude/brave-clarke-kfqhgt`: the go-live session's branch, restarted from
  `main` after each merge; its changes go through their own pull request.
- Paused: `wip/feat/p10-shopify` (8dbe6c4, an unreviewed refund-roles
  follow-up that conflicts with D108; the owner's call).
- The public site: georgieboys/BICII, with its own NOW.md.
- Local-only, git-ignored: `.env.local`, `.devstack/`, `test-results/`.
- A new migration sorts after `20261112000100_appointment_notices`.

## Attention and links

- Risks: [R-001](docs/RISKS.md#r-001--nothing-is-deployed),
  [R-002](docs/RISKS.md#r-002--no-backups-monitoring-alerting-or-exercised-recovery),
  [R-003](docs/RISKS.md#r-003--the-devstack-differs-from-hosted-supabase),
  [R-013](docs/RISKS.md#r-013--changing-the-qr-base-leaves-printed-labels-on-the-old-address),
  [R-093](docs/RISKS.md#r-093--mark-collected-is-allowed-while-stripe-is-confirming-a-payment),
  [R-095](docs/RISKS.md#r-095--consigned-stock-entered-as-shop-stock-needs-an-admins-correction).
- Before relying on payment links: RUNBOOK "Stripe: verify before go-live"
  steps 11 and 12 in test mode.
- Before online booking: shop hours are set (shown on the public site's
  `/contact`, 2026-10-28); no public, active appointment type yet
  ([RUNBOOK](docs/RUNBOOK.md#appointments-schedule-before-go-live)).
- Customer accounts: open on the public site since 2026-10-28 (its
  variables set, redeployed); the privacy notice and PDPA contact are still
  owed (R-016; [RUNBOOK](docs/RUNBOOK.md#the-public-site-customer-accounts)).
- Costs, backups, recovery: [OPERATIONS](docs/OPERATIONS.md).
