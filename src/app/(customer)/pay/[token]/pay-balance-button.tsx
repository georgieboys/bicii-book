"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";

import { startBalanceCheckoutAction } from "./actions";

/**
 * Pay on a payment link (Phase 14 step 3; D156g, D156h), as
 * PayDepositButton: asks the server for Stripe Checkout's URL and goes
 * there, staying busy while the browser leaves. The server reuses this
 * link's open session, so pressing again never charges twice. When the
 * page has moved on (being confirmed, nothing left, the link replaced or
 * stopped), the page refreshes to say so in its own words. Coming Back
 * from Stripe restores this page from the browser's back-forward cache
 * with the button still busy, so a restored page resets it (pageshow with
 * `persisted`).
 */
export function PayBalanceButton({ token, amountLabel }: { token: string; amountLabel: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) setLeaving(false);
    };
    window.addEventListener("pageshow", restored);
    return () => window.removeEventListener("pageshow", restored);
  }, []);

  const pay = () => {
    setError(null);
    start(async () => {
      const result = await startBalanceCheckoutAction({ token });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (result.data.url) {
        setLeaving(true);
        window.location.assign(result.data.url);
        return;
      }
      router.refresh();
    });
  };

  return (
    <div className="flex flex-col gap-2">
      <Button
        size="lg"
        fullWidth
        pending={pending || leaving}
        pendingLabel="Opening Stripe…"
        onClick={pay}
      >
        Pay {amountLabel}
      </Button>
      {error ? (
        <p role="alert" className="text-sm font-medium text-danger-deep">
          {error}
        </p>
      ) : null}
    </div>
  );
}
