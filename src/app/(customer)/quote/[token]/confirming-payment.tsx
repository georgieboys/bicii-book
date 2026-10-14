"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { checkDepositAction } from "./actions";
import { PayDepositButton } from "./pay-deposit-button";

/** How often, and how many times, the page asks again while Stripe confirms. */
const REFRESH_MS = 5_000;
const MAX_REFRESHES = 12;

/**
 * Back from Stripe while the deposit still reads as due (R-086): one
 * verified re-read at Stripe, then a refresh every 5 seconds for a minute.
 * When the page says paid or being confirmed it renders without this. If
 * Stripe still hasn't confirmed after a minute, the customer can press
 * Pay again: it reuses the same open session, so nothing is paid twice.
 *
 * `?deposit=returned` leaves the address once it has done its job (the
 * check says something other than due, or the minute is up), so a restored
 * tab or a bookmark later shows the deposit as it is, not "confirming".
 * history.replaceState changes the address without a navigation (Next.js
 * keeps its router in step), so this message stays on screen.
 */
/** Drops `?deposit=returned` from the address, keeping the page as it is. */
function forgetReturn(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("deposit")) return;
  url.searchParams.delete("deposit");
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

export function ConfirmingPayment({
  token,
  amountLabel,
  payOnline,
}: {
  token: string;
  amountLabel: string;
  payOnline: boolean;
}) {
  const router = useRouter();
  const [checked, setChecked] = useState(false);
  const [gaveUp, setGaveUp] = useState(false);
  const asked = useRef(false);

  // Once per visit (a ref, so a development double mount asks once).
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    void checkDepositAction({ token })
      .then((r) => {
        // Settled one way or the other: the page now says so without the marker.
        if (r.ok && r.data.state !== null && r.data.state !== "due") forgetReturn();
      })
      .catch(() => null)
      .finally(() => {
        setChecked(true);
        router.refresh();
      });
  }, [router, token]);

  useEffect(() => {
    if (!checked) return;
    let refreshes = 0;
    const timer = setInterval(() => {
      refreshes += 1;
      if (refreshes > MAX_REFRESHES) {
        clearInterval(timer);
        setGaveUp(true);
        forgetReturn();
        return;
      }
      router.refresh();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [checked, router]);

  if (!gaveUp) {
    return (
      <p role="status" className="rounded-xl bg-waiting-soft p-4 text-waiting-deep">
        Thanks. We&apos;re confirming your payment with Stripe…
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <p role="status" className="rounded-xl bg-waiting-soft p-4 text-waiting-deep">
        Stripe hasn&apos;t confirmed your payment yet. If you paid, you don&apos;t need to pay
        again; it shows here soon.{" "}
        {payOnline
          ? "If you didn't finish, you can pay below."
          : "The shop will tell you how to pay the deposit."}
      </p>
      {payOnline ? <PayDepositButton token={token} amountLabel={amountLabel} /> : null}
    </div>
  );
}
