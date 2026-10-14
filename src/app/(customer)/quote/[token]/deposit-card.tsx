import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { formatMoney } from "@/lib/money";
import type { DepositReturn, QuoteDeposit } from "@/lib/quote-page";

import { ConfirmingPayment } from "./confirming-payment";
import { PayDepositButton } from "./pay-deposit-button";

/**
 * The deposit on an answered quote (Phase 14 step 2; D151, D153, D158):
 * the amount Postgres fixed when the customer answered, and what to do
 * next. The return from Stripe (`returning`) only chooses the words; the
 * state comes from Stripe's own data (quote_by_token's `deposit`).
 */
export function DepositCard({
  token,
  deposit,
  currency,
  payOnline,
  returning,
}: {
  token: string;
  deposit: QuoteDeposit;
  currency: string;
  payOnline: boolean;
  returning: DepositReturn;
}) {
  const amount = deposit.amount === null ? null : formatMoney(deposit.amount, currency);
  return (
    <Card title="Deposit">
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div className="flex flex-col">
            {amount ? <p className="text-3xl font-bold tabular-nums">{amount}</p> : null}
            <p className="text-sm text-dust-700">{deposit.percent}% of the parts you approved</p>
          </div>
          {deposit.status === "paid" ? <Badge tone="done">Paid</Badge> : null}
        </div>
        <DepositState
          token={token}
          deposit={deposit}
          amount={amount ?? ""}
          payOnline={payOnline}
          returning={returning}
        />
      </div>
    </Card>
  );
}

function DepositState({
  token,
  deposit,
  amount,
  payOnline,
  returning,
}: {
  token: string;
  deposit: QuoteDeposit;
  amount: string;
  payOnline: boolean;
  returning: DepositReturn;
}) {
  switch (deposit.status) {
    case "paid":
      return <p className="text-done-deep">Deposit of {amount} paid. Thank you.</p>;
    case "processing":
      return (
        <p role="status" className="text-dust-700">
          Your payment of {amount} is being confirmed by Stripe. This page shows it once it&apos;s
          confirmed. You don&apos;t need to pay again.
        </p>
      );
    case "refunded":
      return (
        <p className="text-dust-700">
          Your deposit of {amount} was refunded. Ask the shop if you have questions.
        </p>
      );
    case "on_answer":
      return null;
    case "due":
      if (returning === "returned") {
        return <ConfirmingPayment token={token} amountLabel={amount} payOnline={payOnline} />;
      }
      return (
        <div className="flex flex-col gap-3">
          {returning === "cancelled" ? (
            <p role="status" className="rounded-xl bg-sunken p-4 text-dust-700">
              Payment not finished. Nothing was charged. You can pay the deposit below whenever
              you&apos;re ready.
            </p>
          ) : null}
          {payOnline ? (
            <>
              <PayDepositButton token={token} amountLabel={amount} />
              <p className="text-sm text-dust-700">
                Pay securely by card or PayNow with Stripe. You&apos;ll come back to this page.
                Pressing again never charges you twice.
              </p>
            </>
          ) : (
            <p className="text-dust-700">The shop will tell you how to pay the deposit.</p>
          )}
        </div>
      );
  }
}
