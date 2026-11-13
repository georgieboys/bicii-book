# Adventures: build plan

Draft, 2026-11-13. Source: `BICII_Adventure_Management_Claude_Code_Handoff.md` (v1.0) and its start
prompt, read against `bicii-book` `7c18f13` and `BICII` `b8381fc`. This plan keeps the handoff's
business rules and safety boundaries, and departs from its engineering proposals where they do not
fit a shop of this size; each departure is listed with its reason. Not yet approved by the owner.

## 1. The business as I understand it

BICII sells proof that you rode a long route. Anyone can ride any route free with the Strava link.
From 125 km up, a rider can pay to have the ride checked and certified, which earns a finisher pack
(T-shirt, patch, pin, sticker), a completion record and a place on that route's finisher board.
There are three ways to get certified:

| Way | What the rider buys | Price (D = nominal days) | Tracker |
|---|---|---|---|
| Self-supported | Certification; rides when they like | S$49 + S$10 × (D − 1) | Optional hire, S$20 per 24 h |
| Self-supported group | The same certification, plus a seat on a staff-published group date | Same as self-supported | Optional hire |
| Supported | A fixed departure with BICII staff riding along | S$49 + S$100 × D | Included |

Every rider submits their own recording (Garmin/Strava file, or the hired tracker's track) plus
checkpoint photos. A person decides; nothing auto-certifies. The finisher board celebrates
finishing, never speed.

What exists today: one real certifiable route (the 125 km RTI). The 250 km to 3,000 km routes on
the site are George's plans with sample details. The shop has 2 active staff and 4 customer logins
linked so far. That shapes the plan more than anything in the handoff: **launch is one route, a
handful of riders, a few trackers.** Build the full model correctly, but build the surfaces in the
order the business will use them.

## 2. Where this plan departs from the handoff, and why

| # | Handoff proposes | This plan | Why |
|---|---|---|---|
| 1 | Tax treatment "not specified" (gated) | No GST is charged; quotes say "no GST" | Already decided: D89 (owner, 2026-11-12) |
| 2 | Do not upgrade Next.js as part of this work | Upgrade the Admin to 16.4.6 **first**, as its own PR | 16.3.8 has three published critical advisories (audit A-03); the new public checkout endpoint widens the exposure |
| 3 | Start building immediately | First fix the deploy pipeline (audit batch B1): protect `main`, migrate only after green CI, DB secret behind an environment | Merging to `main` applies migrations to production within a minute and nothing waits for CI. This build adds 15+ migrations |
| 4 | "Do not apply hosted migrations without authorisation" | Ship each slice merged to `main` with sales switched off; owner approves the approach once | In this repo a merge **is** a hosted migration (migrate.yml). The alternative, a months-long branch, is worse. Needs the owner's yes (§6, decision 1) |
| 5 | Tracker collection through a new appointment purpose: change workshop appointment guards, check-in and completion | **No appointment changes.** The rider picks a collection day (inside shop hours); staff issue the tracker at the counter from a Handovers list | A pickup is a two-minute counter task. Changing the appointment state machine risks the live workshop booking flow for no business gain. Can be added later if collections need slots (§6, decision 2) |
| 6 | Separate `adventure_payments` table; extend the gateway with a subject | Agree, and reuse the existing `stripe_events` table with a new nullable `adventure_payment_id` and a subject check | Keeps one webhook entry point and one event log; leaves `payments.work_order_id NOT NULL` and all workshop money logic untouched |
| 7 | Tack placeholder adapter | Not built. The tracking interface stays provider-neutral; Tack gets added when it exists | A disabled adapter is code with no user |
| 8 | Public rider profiles `/riders/[id]` and public live-share links `/track/[token]` in scope | Built last (Phase F), behind their own switches | Nobody needs them to buy, ride or get certified. The finisher board on the route page covers recognition at launch |
| 9 | Live rides map with stale-data states | Staff see a list (rider, last fix, age) with a simple map; no public live map until Phase F | With a few trackers, a list answers "where is everyone" |
| 10 | `facilitate_adventures` per-departure scoping | Kept, but only enforced in Phase E when supported departures exist | Two staff today; no use for it before supported rides |
| 11 | Multi-time-zone departures (SG/MY/TH) | Store the IANA zone on each revision/departure from day one; build no zone UI beyond showing it | Every current route starts and finishes at 294 River Valley |
| 12 | Copy the appointment outbox pattern for adventure emails | Copy it **after** fixing its known defects (audit A-10/A-20), or build the adventure outbox with those fixes from the start | The current outbox burns retry attempts without sending when email is slow |
| 13 | Handover: supported riders may "decline the tracker" with no discount | Agree | Already the handoff's rule; noted so nobody "fixes" it |

Everything else in the handoff stands: four participation options, the 125 km threshold, the exact
price formulas with explicit per-offer final prices, manual review, immutable purchase snapshots,
Finish Ride ≠ Return Tracker, attribution by recorded time and historical assignment, no fake jobs,
no Shopify, no service-role key on the public site, policy gates instead of invented fees.

## 3. Architecture in one page

- **Database (bicii-book migrations)** owns everything: catalogue, revisions, offers, departures,
  bookings, quotes, holds, payments, attempts, evidence, tracks, reviews, certificates, packs,
  trackers. RPCs for every change; RLS on every table in the same migration; money as
  `money_amount`; one documented lock order (booking → departure → tracker pool → device).
- **Admin (app.bicii.sg)**: a new Adventures area for staff, plus three server-side endpoints:
  `POST /api/adventures/checkout` (customer bearer token, verified with Supabase, never a submitted
  customer id), and two cron workers (`adventure-tracking`, `adventure-work` for parsing, notices,
  hold expiry), both failing closed without `CRON_SECRET`.
- **Public site (bicii.sg)**: reads catalogue and finisher projections anonymously; account pages
  under `/account/adventures/*` call caller-scoped `my_adventure_*` RPCs with the rider's session.
  Checkout is a Server Action that forwards the rider's access token to the Admin endpoint and
  redirects to Stripe. Evidence uploads go straight to a private Storage path allocated by RPC.
- **Stripe**: one webhook endpoint (existing). The verified event is dispatched by subject:
  workshop (unchanged code path) or adventure. Confirmation only on a verified, matching paid event.
- **Trackers (SPOT)**: one feed polled every 5 minutes by cron, rate limits enforced in the
  database (same-feed ≥ 2.5 min). Points stored once, attributed by device + recorded time to the
  assignment that held the device then, and kept inside the attempt's Start/Finish window.
- **Switches** (database settings, not env flags): `adventure_sales_enabled`,
  `tracker_hire_enabled`, `group_departures_enabled`, `supported_sales_enabled`,
  `public_profiles_enabled`, `live_sharing_enabled`. Turning sales off never stops webhooks,
  reviews or obligations to existing bookings.

## 4. Phases

Each phase is a few PRs, each green in CI, merged with the relevant switch off. A phase is done when
its database rules, screens, tests and docs agree. Decision numbers from **D164**, risks from
**R-098**, the record is **ADR-026**, the product doc `docs/ADVENTURES.md`.

### Phase 0: prerequisites (before any adventure code)
- Audit B1: branch protection, migrate-after-CI, DB secret in a protected environment (owner clicks
  + one workflow PR).
- Audit A-03: Next 16.4.6 and zod in the Admin, full e2e.
- Local database on this Mac: Colima + `npx supabase@2.119.0 start`, so DB tests and races can run
  here instead of only in CI. `.env.local` keeps pointing at production for the running app; DB
  tests use `BICII_TEST_DATABASE_URL` (local), never production.
- Docs: `docs/ADVENTURES.md` (the brief, cleaned of the departures above), ADR-026, D164–D17x rows.

### Phase A: catalogue (no money)
DB: `adventures`, `adventure_revisions` (sealed on publish), `adventure_checkpoints`,
`adventure_offers` (explicit final price per kind; a check that certification offers need
nominal distance ≥ 125 km), media, public projections `public_adventures` / `public_adventure`.
Admin: Adventures → Catalogue list, editor (content, Strava link, rules, checkpoints, offers,
prices with a "suggested price" from the formula), preview, publish, archive, revision history.
Public site: `/adventures` and `/adventures/[slug]` from the database, keeping the current look.
Seed: the 30/50/80 km routes free-only, the 125 km route as a draft with its real Strava link, the
250+ routes as drafts. Nothing purchasable yet.
Gate tests: P01, P02, drafts invisible to anon, sealed revision immutable.

### Phase B: paid self-supported certification, own recording (the first sellable product)
DB: bookings, booking lines (snapshot), checkout attempts with request-id idempotency,
`adventure_payments`, adventure refunds, booking events, attempts, submissions (versioned,
manifest frozen on submit), evidence files, tracks/points, reviews, certificates, badge awards,
fulfilments; `quote_my_adventure`, `prepare_my_adventure_checkout`, `my_adventure_*`, upload
allocation/finalise, `submit_my_adventure_evidence`, staff review RPCs with an atomic approve
(one certificate, one pack, idempotent), `public_adventure_finishers`. New permissions
`manage_adventures`, `verify_adventures` (no approving your own ride).
Stripe: discriminated checkout subject; webhook dispatch by subject; adventure apply/refund
functions; existing workshop payment tests must stay green.
Parsing: GPX (XML parser with entities off) and FIT (one pinned, licence-checked library), in the
`adventure-work` cron with size/point limits; route-only GPX flagged.
Admin: booking list/detail, certification queue, review workspace (track on a map, checkpoints,
photos, checklist, approve / request changes / reject), fulfilment queue (size, packed, handed
over), adventure payments report (separate from workshop reports).
Public site: Buy on the 125 km page → sign in → checkout (size, recording method, terms, final
price) → Stripe → `/account/adventures/[id]` journey → evidence upload → status → certificate;
finisher board on the route page; an Adventures card on the account home.
Emails: payment confirmed, evidence received, changes requested, approved/rejected, pack ready.
Gate tests: P03, P05, P07, P08, P10, C01–C07, C12–C14, E01–E08, E12–E13, A01–A04, A06, A09–A12.
**Release gate (owner)**: cancellation/refund terms, retry policy and the 125 km rules written.

### Phase C: tracker hire
DB: `tracking_devices`, `tracking_feeds` (credentials referenced, not stored in rows),
`tracker_reservations` (pool count under lock; no overlap beyond service-ready devices),
`tracker_assignments` (no overlapping custody, replacement keeps both), `tracking_messages`
(deduplicated across feeds), attribution into attempt tracks, Start/Finish capture windows,
hire reconciliation as a staff task (no automatic late charges).
Integrations: provider interface, deterministic fake, SPOT adapter (allowlisted host, timeout,
size cap, paging within the rate limit, watermark advanced only after commit).
Admin: Trackers (inventory, readiness, custody, last message), Handovers list by collection day,
issue/return with scan and condition, live rides list.
Public site: hire dates at checkout, collection day after payment, Start Ride / Finish Ride,
"waiting for first position", progress, Return reminder.
Gate tests: P06, P09, C09–C11, S05–S07, T01–T09.
**Release gate (owner)**: a real SPOT feed and a pilot ride with two riders reusing one tracker.

### Phase D: group departures
DB: `adventure_departures` (peer kind), join/leave with expected version, capacity under lock,
participant summaries limited to consenting riders' display names.
Admin: departures calendar and manifest. Public site: dates on the route page, join/leave.
Gate tests: C08, S08, S09, peer contact details never exposed.

### Phase E: supported departures
DB: supported offers tied to a departure, seat + included tracker reserved together,
`adventure_departure_staff`, `facilitate_adventures`, facilitator observations, attendance.
Admin: phone-first departure screen (manifest, check-in, issue trackers on site, observations).
Public site: pick a date before checkout, inclusions, remaining places.
Gate tests: P04, S04, S10, A05; insurance copy stays off until the policy is confirmed.
**Release gate (owner)**: insurance, staffing ratio, emergency procedure, overrun terms.

### Phase F: hardening and the optional surfaces
GPX export for riders, public live-share links (attempt-scoped, revocable), public rider
profiles, retention jobs for off-ride telemetry, operational health page, cancellation/transfer
workflows, accessibility pass, the full e2e scenarios in handoff §20.6.

## 5. Testing approach
- Pricing, parsing, attribution and presentation: unit tests.
- Every money, capacity and ownership rule: DB tests first, including real committed races with
  the existing two-connection pattern (`tests/db/appointment-concurrency.test.ts`).
- Two-customer ownership attack tests on every `my_adventure_*` RPC and storage path.
- Legacy regressions: existing workshop payment, appointment, Shopify and sales suites unchanged.
- Playwright for the journeys, with fake Stripe and fake tracker; synthetic fixtures only (the
  repo is public).

## 6. Decisions needed from the owner

Needed before Phase 0/A starts:
1. **Ship slices to `main` with sales switched off?** Each merge applies its migrations to
   production. Recommended: yes, once audit B1 is done.
2. **Tracker collection by day, not by appointment slot?** Recommended: yes for launch.
3. **Launch scope = the 125 km route only** for certification; 250 km+ stay drafts until each has
   real checkpoints and rules. Recommended: yes.

Needed before the first paid sale (they gate selling, not building):
4. Cancellation and refund terms; whether a failed ride may be retried and at what price.
5. The 125 km rules: maximum time (the handoff's benchmark is 24 h), mandatory checkpoints and
   what each photo must show, allowed bikes (e-bikes?).
6. T-shirt sizes offered; pack collection only, or also delivery.
7. Finisher board identity: default to first name + initial, opt-in to full name?

Needed before tracker hire / supported rides:
8. Tracker deposit (amount or none), late-return and loss terms. Answered 2026-11-14: no deposit; staff settle late and lost trackers by hand (D185).
9. A SPOT feed set up on the shop's account, and how many devices. Answered 2026-11-14: none yet; build against a fake feed, hire off until devices exist (D186).
10. Supported rides: insurance policy, facilitator ratio, emergency procedure, overrun terms.

## 7. Size and order of work (estimate)
Phase 0 about a day plus owner clicks; A about 3 PRs; B is the largest (about 8 to 10 PRs across
both repos); C about 5; D about 2; E about 3; F about 4. B can be sold before C exists.
