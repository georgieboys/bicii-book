import type { ActionResult } from "@/lib/actions";
import { STALE_EDIT_CODE } from "@/lib/domain/errors";

/**
 * True when an edit save was refused because the row changed after the sheet
 * opened (STALE_EDIT, audit A-11). The Server Action has already refreshed
 * the page, so the sheet closes and says so in a toast: the next Edit opens
 * with the current values instead of the stale ones this sheet still shows.
 */
export function isStaleRefusal(result: ActionResult<unknown>): boolean {
  return !result.ok && result.code === STALE_EDIT_CODE;
}

/** The toast an edit sheet shows as it closes on a stale refusal. */
export const STALE_TOAST = {
  title: "Not saved: this changed while you had it open",
  description: "Open Edit again to see the current values, then make your change.",
  tone: "error",
} as const;
