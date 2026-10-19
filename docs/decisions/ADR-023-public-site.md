# ADR-023: The public site signs customers in and reads the shared backend

Date: 2026-10-06 (Phase 11 step 1, on `claude/brave-clarke-kfqhgt` from
`main` 5f688c6). Status: D120–D125 accepted (build defaults, owner to
confirm: [PRODUCT question 30](../PRODUCT.md#open-assumptions-and-owner-questions)).
Decision owner: Abhishek Cherian George (owner) for business meaning;
defaults proposed by the build agent.

## Context

SPEC §18 adds customer-facing modules to the existing public website
(repository `bicii`): sign-in and sign-up, booking and cancelling
appointments, My Bikes, customer-visible service history, the public item
pages QR codes open, and online-buy actions that hand checkout to Shopify,
with no business rule duplicated there. Phases 1–4 already built the
customer side of the database ([ADR-003](ADR-003-customer-access.md),
[ADR-006](ADR-006-customer-and-public-visibility.md),
[ADR-013](ADR-013-appointments.md)): the `my_*` RPCs, the anonymous booking
reads and `reporting.public_items`. Three things were missing: a way for a
login to become a customer (ADR-003 "customer sign-up is not built"), a
range of bookable times for one screen (PLAN Phase 2 "`bookable_slots`"),
and a way for a customer to load their own photos, which live in the
private `media-internal` bucket that only staff could read. Supabase Auth is
shared with the Admin, whose staff sign in with emailed codes
([ADR-019](ADR-019-staff-email-sign-in.md)).

## Decision and rationale

| D | Rule (short) | Status | Implemented in |
|---|---|---|---|
| D120 | CUSTOMER-SIGNUP: customers sign in on the public site with an emailed 6-digit code, the same code-only email as staff (D10, D70), and the first code creates their login (`shouldCreateUser: true`; Auth's "Allow new users to sign up" on). No passwords. The site calls Auth from the visitor's browser, so Auth's per-IP limits count each visitor; it keeps no limits of its own | Accepted | Public site (step 2); `supabase/templates/magic_link.html` wording; RUNBOOK |
| D121 | CUSTOMER-LINK: after a code is verified, `claim_my_customer` links the login to the one non-archived customer record with the same email (case-insensitive) and no login yet, and never changes what staff recorded. Several such records: nothing is linked (`customer_link_ambiguous`) and the customer is asked to contact the shop. Archived records are never linked; a login whose own record is archived is refused (`customer_archived`). Once linked, the login keeps that record whatever either email says later | Accepted | `20261006103000_public_site.sql`; `tests/db/public-site.test.ts` |
| D122 | CUSTOMER-CREATE: signing in alone creates no customer record. The first booking of a login with no record creates one (`create_if_missing`) with a first name (required), last name and phone given on the booking form and the login's email | Accepted | `20261006103000_public_site.sql`; `tests/db/public-site.test.ts` |
| D123 | BOOKABLE-RANGE: `bookable_slots(from_day, to_day, type)` returns the bookable starts of up to 31 shop days in one call, each tagged with its shop day, by calling `private.available_slots_at` for each day with the caller's staff flag, so it equals `available_slots` day by day and D37's rules stay where they are. Everyone may call it | Accepted | `20261006103000_public_site.sql`; `tests/db/public-site.test.ts` |
| D124 | CUSTOMER-PHOTOS: a signed-in customer may read the `media-internal` objects behind exactly the photos `my_bike_attachments` and `my_work_order_attachments` return to them (storage policy `media_internal_select_customer` over `private.customer_can_read_media`), so the site shows them through short-lived signed URLs minted with the customer's own session. Public photos keep their public URLs. Nothing else in the bucket, never consignment, product or customer-record photos, never a write | Accepted | `20261006103000_public_site.sql`; `tests/db/public-site.test.ts` |
| D125 | ITEM-PAGE: the public site's `/q/[shortId]` shows exactly `reporting.public_items`. An unknown, unpublished or non-public ID (bikes, jobs, consignment items, sales, purchase orders) shows one "not listed" page, except that a signed-in customer opening their own bike's label is taken to that bike. Item pages are not indexed by search engines. The purchase action is a message to the shop on Instagram until Phase 10's Shopify sync gives an item a storefront address; a Staff link opens the Admin's own `/q` page, which requires a staff sign-in | Accepted | Public site (step 2) |
| D126 | ACCOUNT-PAYMENTS: the account shows no payments (D17 stands); each job's total reads "Job total (before payments)" and points to the bill the shop sends, and a job with no lines shows no amount in the lists (code audit U3-8, U2-12). Showing paid and still to pay waits for the owner | Open | Public site `src/app/account/jobs/[id]/page.tsx`, `src/lib/account/format.ts` (`listedJobTotal`); no schema change |

Full text: [PLAN §6](../PLAN.md#6-open-decisions-for-the-owner), rows
D120–D126.

## Alternatives actually considered

| Option | Why chosen or rejected |
|---|---|
| Staff link every website login by hand | Rejected: SPEC §18 asks for customer sign-up; staff already record emails at intake, and a verified code proves the mailbox |
| Link by email even when several records share it | Rejected: it would pick one customer's history at random; the shop resolves duplicates (D121) |
| Create a customer record at sign-in | Rejected: every sign-up, including people who never book, would add a record to the staff customer list (D122, data minimisation) |
| Phase 1's plan: signed photo URLs minted by a server that holds the service-role key (DATA-MODEL §2 as first written) | Rejected for D124: the only servers are the two Next apps, and giving the public site the service-role key would put a key that bypasses RLS into the second frontend (ADR-003 keeps it in the Admin's `src/lib/admin/`); a Storage policy limited to the same objects shows customers exactly what the server would have, and keeps the boundary in the database |
| Sign customers in from Server Actions, as the Admin does | Rejected: every visitor would share the site server's Auth bucket, which D72 had to fix with limits of its own; browser calls count each visitor |
| A Buy online button now | Rejected: Phase 10 is not merged and no item has a storefront address yet (D125) |

## Consequences

- Hosted Auth must allow new sign-ups when the public site's accounts go
  live, and the magic-link template must be re-pasted with the new wording
  ([RUNBOOK](../RUNBOOK.md#the-public-site-customer-accounts)); until then
  only addresses that already have a login can sign in on the site.
- A customer record whose email staff mistyped as someone else's address
  can be claimed by that address's owner ([R-065](../RISKS.md#r-065--a-mistyped-customer-email-lets-someone-else-claim-that-record)).
- Sign-ups create Auth logins for anyone who can read the code email;
  customer records appear only at a booking ([R-066](../RISKS.md#r-066--anyone-can-create-a-website-login)).
- The public site depends on the shapes of the `my_*` RPCs, the booking
  reads and `reporting.public_items`; changing one is a change to both
  repositories ([R-067](../RISKS.md#r-067--the-public-site-depends-on-this-repositorys-rpc-shapes)).
- Staff see no sign of a customer's website login in the Admin yet.

## Revisit trigger

Phase 10's storefront addresses (D125's purchase action), a request for
customer messages or rescheduling ([R-017](../RISKS.md#r-017--appointments-mvp-has-no-reschedule-and-no-customer-messages)),
or the owner's answer to question 30.

## Evidence and links

- Migration `supabase/migrations/20261006103000_public_site.sql`; tests
  `tests/db/public-site.test.ts`, `tests/db/meta.test.ts` (API surface),
  `tests/db/media-storage.test.ts`.
- Contracts: [DATA-MODEL §15, §16](../DATA-MODEL.md#15-row-level-security-matrix);
  the public site's own README in repository `bicii`.
