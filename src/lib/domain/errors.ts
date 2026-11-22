/**
 * A business rule the domain layer refused, with a message that is already
 * safe to show (ADR-001 A2). Server Actions turn it into
 * `{ ok: false, error, fieldErrors }` (src/lib/actions.ts); nothing else
 * about it reaches the client.
 *
 * Domain functions mirror the database's rules only to give a precise
 * message early; the RPCs remain the authority and check again.
 */
export class DomainError extends Error {
  constructor(
    message: string,
    readonly fieldErrors?: Record<string, string[]>,
    /** A stable code a client can react to (ActionResult.code), never a database message. */
    readonly code?: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

/**
 * An edit sheet's save found the row changed after the sheet opened (its
 * updated_at no longer matches), so writing every field back would undo
 * someone else's change (A-11). Nothing was written.
 *
 * The values the sheet shows are from the page's last render, so closing and
 * reopening it alone would show the same stale values and be refused again.
 * The Server Action therefore refreshes the page on this refusal
 * (src/lib/stale-edit.ts) and the sheet closes itself (STALE_EDIT_CODE): the
 * next Edit opens with the current values and the current updated_at.
 */
export const STALE_EDIT =
  "This changed since you opened it, so nothing was saved. Open Edit again to see the current values, then make your change.";

/** ActionResult.code of a STALE_EDIT refusal. */
export const STALE_EDIT_CODE = "stale_edit";

/** The refusal an edit save throws when the row moved under the sheet. */
export function staleEdit(): DomainError {
  return new DomainError(STALE_EDIT, undefined, STALE_EDIT_CODE);
}

export function isStaleEdit(err: unknown): boolean {
  return err instanceof DomainError && err.code === STALE_EDIT_CODE;
}
