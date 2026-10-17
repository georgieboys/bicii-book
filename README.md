# BICII Admin (bicii-book)

The phone-first staff app for BICII, a custom bicycle workshop in
Singapore, in production since 2026-10-12 (what is live and the latest
release: [NOW.md](NOW.md)). Built: staff sign-in with emailed one-time
codes, staff roles, intake, work orders, appointments, inventory,
consignment and in-store sales, purchasing, labels, reporting, the
Shopify boundary (no store connected), the public site's backend, indent
parts with customer quotes, and Stripe deposits. The public site's
screens (Phase 11 step 2) are merged and deployed in its own repository,
with customer accounts closed until the owner opens them.

Owner: Abhishek Cherian George (George), GitHub
[abhishekcheriangeorge-ops](https://github.com/abhishekcheriangeorge-ops).
Application: in production since 2026-10-12 ([NOW.md](NOW.md)).

It shares one Supabase backend with the public site
(`abhishekcheriangeorge-ops/bicii`), which stays the customer-facing
client: business rules live in Postgres
(RLS, constraints, RPCs), and this app and the public site are two
frontends over the same database.

## Start here

| I want to… | Read |
|---|---|
| Return after a break | [NOW.md](NOW.md) |
| Understand the purpose | [docs/PRODUCT.md](docs/PRODUCT.md) |
| Read the original brief | [docs/SPEC.md](docs/SPEC.md) |
| Understand the design | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/ADR-001-architecture.md](docs/ADR-001-architecture.md), [docs/decisions/README.md](docs/decisions/README.md), [docs/RISKS.md](docs/RISKS.md) |
| Understand the data and who may access it | [docs/DATA-MODEL.md](docs/DATA-MODEL.md) |
| Develop the application | [docs/ENGINEERING.md](docs/ENGINEERING.md), [docs/TESTING.md](docs/TESTING.md), [docs/DESIGN.md](docs/DESIGN.md) |
| Administer or operate it | [docs/OPERATIONS.md](docs/OPERATIONS.md), [docs/RUNBOOK.md](docs/RUNBOOK.md) |
| Use it | [docs/USER-GUIDE.md](docs/USER-GUIDE.md) |
| See the phases and decisions | [docs/PLAN.md](docs/PLAN.md) |
| Work as a coding agent | [AGENTS.md](AGENTS.md) |

Reading path for an engineer: [NOW](NOW.md),
[PRODUCT](docs/PRODUCT.md), [ARCHITECTURE](docs/ARCHITECTURE.md),
[DATA-MODEL](docs/DATA-MODEL.md), [RISKS](docs/RISKS.md),
[ENGINEERING](docs/ENGINEERING.md), [TESTING](docs/TESTING.md),
[AGENTS](AGENTS.md).

Reading path for an operator: [NOW](NOW.md),
[OPERATIONS](docs/OPERATIONS.md), [RUNBOOK](docs/RUNBOOK.md),
[RISKS](docs/RISKS.md), [USER-GUIDE](docs/USER-GUIDE.md).

## Where each fact lives

Each fact has one home; change it there and link to it elsewhere.

| Responsibility | Canonical home |
|---|---|
| Entry point and reading paths | [README.md](README.md) |
| Current state and next action | [NOW.md](NOW.md) |
| Agent contract | [AGENTS.md](AGENTS.md) (`CLAUDE.md` stays exactly `@AGENTS.md`) |
| Purpose, users, scope, domain rules, owner questions | [docs/PRODUCT.md](docs/PRODUCT.md) |
| Original requirement (verbatim, historical, still the requirement) | [docs/SPEC.md](docs/SPEC.md) |
| Phases and the decision index | [docs/PLAN.md §6](docs/PLAN.md#6-open-decisions-for-the-owner) |
| Architecture decision of record | [docs/ADR-001-architecture.md](docs/ADR-001-architecture.md) |
| Observed design | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Decision records | [docs/decisions/](docs/decisions/README.md) |
| Data authority, meaning, access, lifecycle and contracts | [docs/DATA-MODEL.md](docs/DATA-MODEL.md) |
| Test strategy | [docs/TESTING.md](docs/TESTING.md) |
| Design system | [docs/DESIGN.md](docs/DESIGN.md) |
| Setup, commands, conventions | [docs/ENGINEERING.md](docs/ENGINEERING.md) |
| Environments, administration, release, diagnosis, recovery | [docs/OPERATIONS.md](docs/OPERATIONS.md) |
| Operator procedures | [docs/RUNBOOK.md](docs/RUNBOOK.md) |
| Problems, shortcuts, gaps | [docs/RISKS.md](docs/RISKS.md) |
| Staff tasks | [docs/USER-GUIDE.md](docs/USER-GUIDE.md) |
| A pull request's documentation impact | [.github/pull_request_template.md](.github/pull_request_template.md) |

No issue tracker is in use: the backlog is the phases in
[PLAN §2](docs/PLAN.md#2-phases) plus the next actions in
[RISKS](docs/RISKS.md), and [NOW](NOW.md) names the next action.

## Quickstart

Node 22, a local Postgres 16 superuser, curl, tar and git; no Docker.
Set up the devstack, reset the database and run `npm run dev`, then open
http://localhost:3000 with a seeded login: every step is in
[ENGINEERING.md](docs/ENGINEERING.md#clean-checkout-to-running-application).

## Stack

Next.js 16 (App Router, Turbopack; `proxy.ts` and async request APIs, see
[AGENTS.md](AGENTS.md)), React 19, TypeScript 5, Tailwind 4, Supabase
(Postgres, Auth, Storage, RLS), zod, decimal.js, pino and `@zxing/browser`
for the QR scanner, tested with Vitest and Playwright on GitHub Actions;
Vercel is planned for hosting. Installed versions and how the parts fit:
[ARCHITECTURE.md](docs/ARCHITECTURE.md#current-system).

## Licence notice

The documentation structure adapts templates from Vibe Code Docs Stack
v0.2.0; its MIT notice is in
[LICENSES/vibe-code-docs-stack.txt](LICENSES/vibe-code-docs-stack.txt).
