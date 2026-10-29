# Current state

Updated: 2026-10-29 SGT (D162 in production: PRs #50, #51 and #52, the
owner's 25 products reclassified; a consigned product's page shows the
amount owed as its cost in its own pull request; no public active
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
- Current objective: a consigned product's cost is its amount owed (the
  owner's question of 2026-10-29): `product_costs.effective_cost` and the
  product page, so Edit terms moves both
  ([R-095](docs/RISKS.md#r-095--consigned-stock-entered-as-shop-stock-needs-an-admins-correction)).
  The item-id fix (PR #52) is in production.
- Next action: merge it when CI is green (`migrate.yml` applies
  `20261029000100`). The owner sets the amount owed on the eleven
  reclassified items left at 0.00. After that, the owner's answers to the
  [owner questions](docs/PRODUCT.md#open-assumptions-and-owner-questions),
  first 35 (payment links, counter payments, Reports), 36 (payments in the
  public account, D126) and 30 (the public site's defaults), and the QR
  address ([R-013](docs/RISKS.md#r-013--changing-the-qr-base-leaves-printed-labels-on-the-old-address)).
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
| Reclassify shop stock as consigned (D162) | Database, the admin-only Change owner and the item-id fix (PRs #50–#52); a consigned product's cost as its amount owed in its pull request | CI and full e2e green on PR #51; PR #52's unit test failed before it and passed after; `consigned-product-costs.test.ts` failed first and passes | Production since 2026-10-28 SGT (the owner's 25 products reclassified, checked read-only; PR #52's build of 0aa580a READY); the cost change not yet |

Commands and evidence: [ENGINEERING](docs/ENGINEERING.md#commands),
[TESTING](docs/TESTING.md).

## Work location and continuation

- georgieboys/bicii-book (public), `main` 0aa580a (PR #52). Use `origin/main`.
- `claude/brave-clarke-kfqhgt`: the go-live session's branch, restarted from
  `main` after each merge; its changes go through their own pull request.
- Paused: `wip/feat/p10-shopify` (8dbe6c4, an unreviewed refund-roles
  follow-up that conflicts with D108; the owner's call).
- The public site: georgieboys/BICII, with its own NOW.md.
- Local-only, git-ignored: `.env.local`, `.devstack/`, `test-results/`.
- A new migration sorts after `20261029000100_consigned_product_costs`.

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
