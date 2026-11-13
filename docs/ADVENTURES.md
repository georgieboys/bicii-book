# Adventures

The canonical home of the adventure business: what BICII sells, the rules
the system enforces, and where each part is built. Decisions are PLAN
D164–D171 ([PLAN §6](PLAN.md#6-open-decisions-for-the-owner)); the
architecture is [ADR-026](decisions/ADR-026-adventures.md); the build order
and the owner's open questions are in [ADVENTURES-PLAN.md](ADVENTURES-PLAN.md).

Source: the owner's brief of 2026-11-13 ("BICII Adventure Management",
handoff v1.0, kept outside the repository) and the owner's approval on
2026-11-13 of the plan's three starting decisions. This extends
[SPEC.md](SPEC.md), which is kept as the original requirement.

## What BICII sells (D164)

A route is free to ride: anyone may use its route link, with no account,
booking or payment ("free and easy"). From **125 km**, a rider may pay to
have a ride **certified**. There are three certified ways:

| Way | Key | What the rider buys |
|---|---|---|
| Self-supported | `self_supported` | Certification; rides when they choose |
| Self-supported group | `self_supported_group` | The same certification, plus a seat on a staff-published peer departure |
| Supported | `supported` | A fixed departure with BICII facilitators, tracker included |

- Every certified rider submits their **own recording** (a GPX/FIT file
  from their device, or the hired tracker's track) and the checkpoint
  photos the route asks for. A supported ride does not remove that.
- A **person decides** certification. Payment, a Finish click, arriving
  with a group or uploading files never certifies anyone.
- Five-minute tracker positions are acceptable evidence; riders choose
  their roads between checkpoints.
- An approved certification earns a **finisher pack** (T-shirt, patch,
  pin, sticker), a completion record and a place on the route's
  **finisher board**, which lists completions by date. There are no
  rankings, fastest times or positions.

## Prices (D165)

SGD, final prices, **no GST** (D89). With `D` the route's nominal days:

| | Price |
|---|---|
| Self-supported, solo or group | 49 + 10 × (D − 1) |
| Optional tracker hire (self-supported) | 20 per 24-hour period |
| Supported | 49 + 100 × supported days, tracker included (never the 10/day or the 20/day on top) |

The formulas are a suggestion in the editor; every offer stores the
explicit final price an admin publishes. A purchase keeps the price and
terms it was sold at.

## Rules the database enforces

- Certification offers only on routes of 125 km or more, never on a route
  still being planned, and only with published nominal days and a
  maximum time (Phase A).
- A published revision of a route, with its checkpoints and offers, never
  changes; edits make a new draft (D166).
- Phase B onward (not built yet): prices computed in Postgres from the
  sealed offer, never from the browser; one booking per paid checkout
  under retries; capacity under locks; evidence frozen when submitted;
  one certificate and one pack per approved attempt.

## Where it is built

| Phase | What | State |
|---|---|---|
| A | Catalogue: routes, revisions, checkpoints, offers, public reads; staff editor; public site from the database | Database and the staff screens (More → Adventures) built; the public site next |
| B | Paid self-supported certification with the rider's own recording | Bookings, payments and the Admin's checkout endpoint built (sales off); evidence, review, screens and the public site's journey next |
| C | Tracker hire and SPOT tracking | Not started |
| D | Group departures | Not started |
| E | Supported departures | Not started |
| F | Hardening, rider GPX export, live sharing, public rider profiles | Not started |

Data: [DATA-MODEL §20](DATA-MODEL.md#20-adventures). Nothing is sold until
Phase B ships behind its sales switch and the owner has written the
cancellation, refund and retry terms ([ADVENTURES-PLAN §6](ADVENTURES-PLAN.md#6-decisions-needed-from-the-owner)).
