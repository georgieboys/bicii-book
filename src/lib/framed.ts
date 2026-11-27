"use client";

import { useSyncExternalStore } from "react";

/**
 * True when this page is inside another page's frame, such as Apps → BICII
 * Admin in the Shopify admin (D275, R-136). Comparing the two windows is
 * allowed across origins; a top that cannot be read counts as framed.
 */
export function isFramed(win: Pick<Window, "self" | "top"> = window): boolean {
  try {
    return win.self !== win.top;
  } catch {
    return true;
  }
}

const subscribe = () => () => {};

/** isFramed for a component; false while rendering on the server. */
export function useIsFramed(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => isFramed(),
    () => false,
  );
}
