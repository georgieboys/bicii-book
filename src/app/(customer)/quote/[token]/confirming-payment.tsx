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
 */
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
        again; it shows here soon. If you didn&apos;t finish, you can pay below.
      </p>
      {payOnline ? <PayDepositButton token={token} amountLabel={amountLabel} /> : null}
    </div>
  );
}
