# ADR-026: Adventures in the existing backend

Date: 2026-11-13.
Status: accepted for Phase A (the catalogue); the later phases follow the
design below and amend this record as they are built.
Decision owner: Abhishek Cherian George (owner) for business meaning;
design by the build agent from the owner's brief ("BICII Adventure
Management", handoff v1.0) and [ADVENTURES-PLAN.md](../ADVENTURES-PLAN.md).

## Context

The owner wants to sell certified rides on BICII's routes
([ADVENTURES.md](../ADVENTURES.md)). The brief proposes a large module:
catalogue, bookings, a second Stripe payment subject, tracker hire with
SPOT ingestion, evidence review, certificates, finisher boards, group and
supported departures. The shop has two active staff, one real certifiable
route (the 125 km) and a few customer logins, and every merge to `main`
reaches production (migrations through `migrate.yml` after green CI,
the Admin through Vercel).

## Decision

1. **One backend.** All adventure data and rules live in this
   repository's migrations; the public site reads through anonymous and
   caller-scoped RPCs and never holds a service-role key or a provider
   secret (D164; as ADR-023 for the public site).
2. **Sealed revisions (D166).** An adventure's content, checkpoints and
   offers are edited as one draft revision; publishing seals it and makes
   it current. Sealed rows are immutable by trigger, not only by RPC.
   Bookings will reference the sealed revision they bought.
3. **Explicit prices (D165).** Offers store final prices; the owner's
   formulas exist only as `private.adventure_suggested_price` for the
   editor. Certification is offered only from 125 km, never on a planned
   route, and publishing a revision with offers requires nominal days and a
   maximum time.
4. **Separate payment domain (D167, Phase B).** Adventure payments get
   their own table; workshop `payments` (job required) and its money logic
   stay untouched. The Stripe gateway gains a discriminated checkout
   subject; the existing webhook endpoint and `stripe_events` table are
   shared, with an adventure subject column, so there is one verified
   entry point.
5. **Collection by day, no appointment changes (D168, Phase C).** A
   tracker hire has a collection day inside shop hours; staff issue it at
   the counter from a Handovers list. Workshop appointments, check-in and
   completion are not changed.
6. **Permissions (D169).** `manage_adventures`, `verify_adventures`,
   `facilitate_adventures`, through the existing role model (admin and
   manager hold them; a mechanic only as an exception).
7. **Ship dark (D170).** Each slice merges to `main` additively with its
   sales or feature switch off; turning sales off never stops webhooks,
   reviews or obligations to existing bookings.
8. **Launch scope (D171).** Certification launches on the 125 km route
   only; longer routes stay planned until each has real checkpoints and
   rules.

## Alternatives considered

| Alternative | Why not |
|---|---|
| Sell adventures as workshop jobs or Shopify products | The brief forbids fake jobs; Shopify has no place for evidence, review or capacity |
| Loosen `payments.work_order_id` to take adventures | Every workshop payment rule, report and RPC assumes a job; a separate table keeps them unchanged |
| A new appointment purpose for tracker handovers (the brief's proposal) | Changes the live workshop booking state machine for a two-minute counter task; can be added later if collections need slots |
| Mutable adventures with booking snapshots only | Works for prices, but a checkpoint list changed under a sold booking would be invisible; sealed revisions make the sold terms provable |
| A disabled Tack adapter now | No contract or API exists; the tracking interface stays provider-neutral instead |

## Consequences

- A catalogue edit is always two steps (save the draft, publish); the
  editor must make that clear.
- The seeded routes (the nine on the public site, facts only) are
  production data written by a migration; an admin edits or archives them
  through the editor.
- Until the public site reads `public_adventures`, it keeps its own
  static route list and the two can drift (R-098).

## Evidence and links

- Migrations `20261113000100_adventure_permissions.sql`,
  `20261113000200_adventure_catalogue.sql`;
  [DATA-MODEL §20](../DATA-MODEL.md#20-adventures).
- Tests: `tests/db/adventure-catalogue.test.ts`; permission tables in
  `tests/db/staff-roles.test.ts`, `tests/db/permission-helpers.test.ts`,
  `tests/unit/auth-helpers.test.ts`.
