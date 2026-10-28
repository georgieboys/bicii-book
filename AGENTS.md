# Agent instructions for bicii-book

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Next.js 16 specifics for this project

The managed block above is kept verbatim so `next dev` leaves this file
alone. In this project specifically: `proxy.ts` replaces `middleware.ts`;
`cookies()`, `headers()`, `params` and `searchParams` are async; Turbopack is
the default and a webpack config fails the build; `next build` does not lint;
`revalidateTag` takes a second argument (`updateTag`/`refresh` exist for
Server Actions). The docs for the installed version are in
`node_modules/next/dist/docs/`; read the relevant guide before writing
framework code and heed deprecation notices.

## Before writing code

Read [NOW.md](NOW.md) first and inspect the git state: the branch, the
worktrees (`git worktree list`) and what is pushed versus local only. Then
read, in order: `docs/SPEC.md`, `docs/PLAN.md`, `docs/ADR-001-architecture.md`,
`docs/DATA-MODEL.md`, `docs/TESTING.md`, plus the canonical doc the task
touches ([README.md](README.md#where-each-fact-lives) lists them).
Conventions and commands are in
[docs/ENGINEERING.md](docs/ENGINEERING.md).

## Rules that are not negotiable

- The brief in `docs/SPEC.md` is the requirement. Do not change business
  semantics (Cult Commons math, inventory ownership, consignment liability,
  financial snapshots, public/private boundaries, one backend / two
  frontends). If a change would, stop and surface it in the PR.
- Stock, money, settlements, unit status, publication and appointment
  capacity change only through the Postgres RPCs in DATA-MODEL.md §16.
- Every table ships with its RLS policies in the same migration.
- Money is `numeric`; authoritative arithmetic is in Postgres.
- Every ledger-affecting feature has a database test for its invariant
  before it has a screen.
- Never commit secrets. `.env.local` is ignored; `.env.example` documents
  every variable.
- Each phase ends runnable and green (`npm run check`, `npm test`).

## Documentation maintenance contract

The repository follows
[Vibe Code Docs Stack v0.2.0](https://github.com/abhishekcheriangeorge-ops/vibe-code-docs-stack)
([ADR-015](docs/decisions/ADR-015-documentation-stack.md)).

1. Orient: read NOW.md and the docs the task touches; inspect git (branch,
   worktrees, pushed versus local) before trusting any document.
2. Update the canonical docs with every meaningful change, in the same
   commit as the code:
   - behaviour or scope: `docs/PRODUCT.md` and `docs/USER-GUIDE.md`;
   - design: `docs/ARCHITECTURE.md` and a record in `docs/decisions/`;
   - schema, access, contracts: `docs/DATA-MODEL.md`;
   - setup, commands, tests: `docs/ENGINEERING.md`, `docs/TESTING.md`;
   - administration, hosting, release, recovery: `docs/OPERATIONS.md`,
     `docs/RUNBOOK.md`;
   - a new business decision: a row in
     [PLAN §6](docs/PLAN.md#6-open-decisions-for-the-owner) plus a record,
     numbered from the track's allocated range, never "the next free":
     D43–D59 main line (labels D56–D59), D60–D69 purchasing, D70–D79 staff
     email sign-in, D80–D89 Shopify, D90–D99 staff roles, D100–D119
     reporting, D120–D139 public site, D140–D149 indent parts and quotes,
     D150–D159 Stripe payments, D160+ later (D160 indent follow-up, D161
     counter payments and D162 reclassifying shop stock taken). Records: ADR-017 labels,
     ADR-018 purchasing, ADR-019 email sign-in, ADR-020 Shopify, ADR-021
     staff roles, ADR-022 reporting, ADR-023 public site, ADR-024 indent
     parts and quotes, ADR-025 Stripe payments. RISKS: R-028–R-029 labels
     (its later entries R-075–R-077), R-030–R-034 purchasing, R-035–R-039
     email sign-in, R-040–R-049 Shopify, R-050–R-054 roles, R-055–R-064
     reporting, R-065–R-074 public site, R-078–R-084 indent parts and
     quotes, R-085–R-089 Stripe payments (its later entries R-090–R-094),
     R-095+ later (R-095 reclassifying shop stock).
3. Record problems, shortcuts and uncertainty with evidence in
   `docs/RISKS.md`. There is one backlog: the PLAN phases, the RISKS next
   actions and NOW.md.
4. Update NOW.md at checkpoints and at the end of each phase: what is built,
   how it was verified, the branch, what is committed and pushed versus
   local only, and the first next action.
5. Before running a documented command, inspect its script and target:
   `npm run db:reset` drops and rebuilds `bicii_dev`, `npm run test:e2e`
   resets it, and nothing may target a hosted project without the owner's
   authorization. Record pass, fail or not run; a date is not verification.
6. Secrets and audience: the repository is public. No secrets, hosted
   values or keys, no customer data; security issues only as
   non-exploitable summaries; name configuration, never its values. Every
   pull request answers the documentation-impact question in
   [.github/pull_request_template.md](.github/pull_request_template.md).
