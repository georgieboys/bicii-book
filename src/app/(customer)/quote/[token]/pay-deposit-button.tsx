"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";

import { startDepositCheckoutAction } from "./actions";

/**
 * Pay deposit (Phase 14 step 2; D158): asks the server for Stripe
 * Checkout's URL and goes there, staying busy while the browser leaves.
 * The server reuses an open session, so pressing again never charges
 * twice. When the deposit turns out paid or being confirmed, the page
 * refreshes to say so.
 */
export function PayDepositButton({ token, amountLabel }: { token: string; amountLabel: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pay = () => {
    setError(null);
    start(async () => {
      const result = await startDepositCheckoutAction({ token });
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
        Pay {amountLabel} deposit
      </Button>
      {error ? (
        <p role="alert" className="text-sm font-medium text-danger-deep">
          {error}
        </p>
      ) : null}
    </div>
  );
}
