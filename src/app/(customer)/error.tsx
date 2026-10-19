"use client";

import { Button } from "@/components/ui/button";
import { SHOP_CONTACT } from "@/lib/shop-contact";

/**
 * Unexpected errors on the customer pages (the quote and the payment link;
 * U2-2), in the customer's words: no link into the Admin, nothing for
 * staff to check. A server error arrives with only its digest, which
 * onRequestError logs too, so the shop can find it. Pay is safe to press
 * again: an open Checkout session is reused and a paid one shows as paid
 * (D158d), so the copy can say it never charges twice.
 */
export default function CustomerError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-3xl">This page couldn&apos;t be shown</h1>
      <p className="text-dust-700">
        Check your connection and try again. If you were paying, open this page again before you
        pay: pressing Pay again never charges you twice.
      </p>
      <div className="flex flex-wrap items-center gap-4">
        <Button onClick={() => retry()}>Try again</Button>
        <a
          href={SHOP_CONTACT.href}
          className="font-medium underline decoration-2 underline-offset-4"
        >
          {SHOP_CONTACT.label}
        </a>
      </div>
      {error.digest ? (
        <p className="text-sm text-dust-500">
          Reference for the shop: <code className="font-mono">{error.digest}</code>
        </p>
      ) : null}
    </div>
  );
}
