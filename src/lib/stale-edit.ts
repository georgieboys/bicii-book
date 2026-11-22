import "server-only";

import { refresh } from "next/cache";

import { isStaleEdit } from "@/lib/domain/errors";

/**
 * Runs an edit save inside a Server Action and, when it is refused as stale
 * (STALE_EDIT, audit A-11), refreshes the page before the refusal goes back.
 * The sheet's values and its updated_at are props from the page's server
 * render, so without this the next Edit would open with the same stale props
 * and be refused again until a browser reload. With it, the refusal arrives
 * together with the page's current data; the sheet closes on the refusal and
 * the next Edit opens current.
 */
export async function refreshWhenStale<T>(save: () => Promise<T>): Promise<T> {
  try {
    return await save();
  } catch (err) {
    if (isStaleEdit(err)) refresh();
    throw err;
  }
}
