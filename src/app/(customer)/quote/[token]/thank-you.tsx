"use client";

import { useEffect, useRef, type ReactNode } from "react";

const KEY = "bicii:quote-answered";

/**
 * Called by the quote form when its answer went through: the page then
 * reloads into its answered state, and the form (and the focus it held)
 * is gone. Per tab; a failure to store only skips the focus.
 */
export function markAnswered(token: string) {
  try {
    sessionStorage.setItem(KEY, token);
  } catch {
    // Storage blocked: the status is still announced.
  }
}

/**
 * The answered quote's thank-you (U2-4): a status that takes focus when
 * this tab just sent the answer, so a screen reader reads it and keyboard
 * users continue from it rather than from the top of the page.
 */
export function ThankYou({ token, children }: { token: string; children: ReactNode }) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    try {
      if (sessionStorage.getItem(KEY) !== token) return;
      sessionStorage.removeItem(KEY);
    } catch {
      return;
    }
    ref.current?.focus();
  }, [token]);
  return (
    <p
      ref={ref}
      role="status"
      tabIndex={-1}
      className="rounded-xl bg-done-soft p-4 text-done-deep focus:outline-none focus-visible:outline-2 focus-visible:outline-ink"
    >
      {children}
    </p>
  );
}
