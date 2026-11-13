## Outcome

<!-- What changed for staff, operators or developers. Link the phase in docs/PLAN.md §2 and any PLAN §6 row this implements. -->

## Validation

<!-- Only checks actually run, with results; say what was not run and why. -->

- [ ] `npm run check`
- [ ] `npm test` (unit + db)
- [ ] `npm run check:types`
- [ ] E2E: `e2e` label on this PR (CI run link) or `npm run test:e2e` locally
- [ ] Docs link check (docs/ENGINEERING.md, Validation)

Not run:

## Documentation impact

<!-- For each doc: what changed, or "not affected" with a reason. -->

- NOW.md:
- docs/PRODUCT.md / docs/USER-GUIDE.md:
- docs/ARCHITECTURE.md / docs/decisions/:
- docs/DATA-MODEL.md:
- docs/ENGINEERING.md / docs/TESTING.md:
- docs/OPERATIONS.md / docs/RUNBOOK.md:
- docs/RISKS.md:
- docs/PLAN.md §6: new D-number from the track's allocated range (AGENTS.md item 2) and its record, or none
- Business semantics (AGENTS.md, "Rules that are not negotiable"): unchanged, or the change and why

## Release considerations

<!-- Nothing is deployed until docs/OPERATIONS.md says otherwise; then say what each hosted environment needs. -->

- Migrations (file names), or none:
- `tests/fixtures/api-surface.ts` and `src/lib/database.types.ts` updated, or not needed:
- Environment variables (names only; `.env.example` updated), or none:
- Hosted impact: merging deploys the Admin to production (Vercel) and, after CI is green, applies any new migration to the production database (`migrate.yml`). Say whether each migration is safe for the app version already running, or "none".
