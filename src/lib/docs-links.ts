/**
 * Links from screens to this repository's docs (the operator's runbook).
 * One place for the repository's address: it moved from
 * abhishekcheriangeorge-ops/bicii-book to georgieboys/bicii-book on
 * 2026-10-06 (OPERATIONS.md).
 */
export const REPOSITORY_URL = "https://github.com/georgieboys/bicii-book";

/** A section of docs/RUNBOOK.md on main, by its heading's anchor (e.g. "stripe-payments"). */
export function runbookHref(anchor: string): string {
  return `${REPOSITORY_URL}/blob/main/docs/RUNBOOK.md#${anchor}`;
}
