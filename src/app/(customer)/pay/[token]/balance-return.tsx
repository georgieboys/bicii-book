"use client";

import { useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import { checkBalanceAction } from "./actions";

/** How often, and how many times, the page asks again while Stripe confirms. */
const REFRESH_MS = 5_000;
const MAX_REFRESHES = 12;

/**
 * What this render of the page shows: the bill with Pay (`due`), the bill
 * with something else (`open`: being confirmed, nothing left, too small or
 * too large), a link notice (`closed`: replaced or stopped, expired, the
 * job changed, not valid) or nothing read (`unknown`: an error or the
 * limit).
 */
export type PageState = "due" | "open" | "closed" | "unknown";

type Phase = "idle" | "confirming" | "gave_up" | "paid" | "paid_still_due" | "processing";

const PhaseContext = createContext<Phase>("idle");

/** Drops `?balance=returned` from the address, keeping the page as it is. */
function forgetReturn(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("balance")) return;
  url.searchParams.delete("balance");
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

/**
 * Back from Stripe on a payment link (`?balance=returned`, R-086), as the
 * quote page's ConfirmingPayment: while the bill still reads as due, one
 * verified re-read at Stripe (confirmBalanceReturn, recorded as Stripe's
 * word), then a refresh every 5 seconds for a minute. When the page says
 * being confirmed or nothing left, it speaks for itself. If Stripe still
 * hasn't confirmed after a minute, the customer can press Pay again: it
 * reuses the same open session, so nothing is paid twice.
 *
 * It wraps the whole page so that what the re-read found (paid, or being
 * confirmed) stays on screen across the refreshes even when the page then
 * reads as a notice (the job was collected meanwhile, which stops the
 * link; step3-critique C11): the message comes from Stripe's answer, not
 * from the link. The Pay section sits in a `ReturnSlot`, hidden while
 * confirming.
 *
 * The bill read again after the check can still be due: Stripe confirmed
 * a payment for less than what is due now (the balance went up after the
 * customer opened Stripe's page, say a counter payment was voided). The
 * page then shows Stripe's word and Pay at the live amount together
 * (`paid_still_due`). `balanceDue` (Postgres's figure, compared as text,
 * never computed) tells a read after the check from the one on arrival:
 * both say due, but a payment recorded in between changes the balance.
 * When the check found nothing but the bill was read again at another
 * amount (the webhook recorded the payment first), the page speaks for
 * itself too, with no payment claim (D153). Until then the slot shows
 * the line only, so a just-paid "Pay $X" never flashes.
 *
 * `?balance=returned` leaves the address once it has done its job (the
 * check or the page says something other than due, or the minute is up),
 * so a restored tab or a bookmark later shows the bill as it is.
 * history.replaceState changes the address without a navigation (Next.js
 * keeps its router in step).
 */
export function BalanceReturn({
  token,
  returned,
  page,
  jobNumber,
  balanceDue,
  children,
}: {
  token: string;
  /** This render's address carries `?balance=returned`. */
  returned: boolean;
  page: PageState;
  jobNumber: string | null;
  /** The bill's balance_due as read for this render (open bills), else null. */
  balanceDue: string | null;
  children: ReactNode;
}) {
  const router = useRouter();
  // Decided once, on arrival: a return from Stripe while the bill is due.
  const [confirming] = useState(() => returned && page === "due");
  // The balance on arrival, which is also the one when the check answers:
  // nothing refreshes the page before then.
  const [arrivalBalance] = useState(balanceDue);
  const [checked, setChecked] = useState(false);
  const [outcome, setOutcome] = useState<"paid" | "processing" | null>(null);
  const [gaveUp, setGaveUp] = useState(false);
  const asked = useRef(false);
  // The page now says something other than due: it speaks for itself.
  const moved = page === "open" || page === "closed";
  // The bill was read again after the check and is still due, at another
  // amount: a payment (or a change) was recorded since the arrival.
  const reread = confirming && checked && page === "due" && balanceDue !== arrivalBalance;

  // Once per visit (a ref, so a development double mount asks once).
  useEffect(() => {
    if (!confirming || asked.current) return;
    asked.current = true;
    void checkBalanceAction({ token })
      .then((r) => {
        const state = r.ok ? r.data.state : null;
        if (state === "paid" || state === "processing") setOutcome(state);
      })
      .catch(() => null)
      .finally(() => {
        setChecked(true);
        router.refresh();
      });
  }, [confirming, router, token]);

  // While the page still says due, ask again every 5 seconds for a minute.
  useEffect(() => {
    if (!confirming || !checked || outcome !== null || moved || reread || gaveUp) return;
    let refreshes = 0;
    const timer = setInterval(() => {
      refreshes += 1;
      if (refreshes > MAX_REFRESHES) {
        clearInterval(timer);
        setGaveUp(true);
        return;
      }
      router.refresh();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [confirming, checked, outcome, moved, reread, gaveUp, router]);

  // Settled one way or the other: the page now says so without the marker.
  useEffect(() => {
    if (confirming && (outcome !== null || moved || reread || gaveUp)) forgetReturn();
  }, [confirming, outcome, moved, reread, gaveUp]);

  const phase: Phase =
    outcome === "paid" && reread
      ? "paid_still_due"
      : (outcome ?? (!confirming || moved || reread ? "idle" : gaveUp ? "gave_up" : "confirming"));

  if (outcome !== null && page === "closed" && jobNumber !== null) {
    return (
      <div className="flex flex-col gap-3">
        <h1 className="text-3xl">Your bill for job {jobNumber}</h1>
        <p role="status" className="text-dust-700">
          {outcome === "paid"
            ? "Thank you. Stripe has confirmed your payment."
            : "Thank you. Your payment is being confirmed by Stripe. You don't need to pay again."}
        </p>
      </div>
    );
  }
  return <PhaseContext value={phase}>{children}</PhaseContext>;
}

/**
 * Where Pay sits on a due bill: the Pay section itself, or, back from
 * Stripe, what the return found while it checks (the section hidden), then
 * after a minute without Stripe's word the section again under a line
 * saying so. When Stripe confirmed a payment and the bill read again is
 * still due, its line names what is left (`amount`, formatted) above the
 * section.
 */
export function ReturnSlot({
  payOnline,
  amount,
  children,
}: {
  payOnline: boolean;
  /** The balance due, formatted, for the paid-but-still-due line. */
  amount?: string;
  children: ReactNode;
}) {
  const phase = useContext(PhaseContext);
  if (phase === "idle") return children;
  // One status line, first in every phase, so each change is written into
  // the same element and announced (U2-5); Pay comes after it.
  const done = phase === "paid" || phase === "paid_still_due";
  const text =
    phase === "confirming"
      ? "Thanks. We're confirming your payment with Stripe…"
      : phase === "paid"
        ? "Thank you. Stripe has confirmed your payment."
        : phase === "paid_still_due"
          ? `Thank you. Stripe has confirmed your payment.${amount ? ` ${amount} is still due on this bill.` : ""}`
          : phase === "processing"
            ? "Thank you. Your payment is being confirmed by Stripe. You don't need to pay again."
            : `Stripe hasn't confirmed your payment yet. If you paid, you don't need to pay again; it shows here soon.${
                payOnline ? " If you didn't finish, you can pay below." : ""
              }`;
  return (
    <>
      <p
        role="status"
        className={
          done
            ? "rounded-xl bg-done-soft p-4 text-done-deep"
            : "rounded-xl bg-waiting-soft p-4 text-waiting-deep"
        }
      >
        {text}
      </p>
      {phase === "paid_still_due" || phase === "gave_up" ? children : null}
    </>
  );
}
