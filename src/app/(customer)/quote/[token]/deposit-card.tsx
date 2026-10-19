import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { formatMoney, toDecimal } from "@/lib/money";
import type { DepositReturn, QuoteDeposit } from "@/lib/quote-page";

import { StripePrivacyLine } from "../../stripe-privacy-line";
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
          currency={currency}
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
  currency,
  payOnline,
  returning,
}: {
  token: string;
  deposit: QuoteDeposit;
  amount: string;
  currency: string;
  payOnline: boolean;
  returning: DepositReturn;
}) {
  // U2-11: a deposit refunded in part is still paid, and says how much of
  // it came back (Postgres's figure, formatted only).
  const refunded = toDecimal(deposit.refunded).greaterThan(0)
    ? formatMoney(deposit.refunded, currency)
    : null;
  const paidText = refunded
    ? `Deposit of ${amount} paid. ${refunded} of your deposit was refunded.`
    : `Deposit of ${amount} paid. Thank you.`;
  const processingText = `Your payment of ${amount} is being confirmed by Stripe. Reload this page later to see it confirmed. You don't need to pay again.`;
  // Back from Stripe: the confirming line stays mounted and takes Stripe's
  // answer, so it is announced (U2-5).
  if (
    returning === "returned" &&
    (deposit.status === "due" || deposit.status === "paid" || deposit.status === "processing")
  ) {
    return (
      <ConfirmingPayment
        token={token}
        amountLabel={amount}
        payOnline={payOnline}
        settled={
          deposit.status === "paid"
            ? { text: paidText, tone: "done" }
            : deposit.status === "processing"
              ? { text: processingText, tone: "waiting" }
              : null
        }
      />
    );
  }
  switch (deposit.status) {
    case "paid":
      return (
        <p role="status" className="text-done-deep">
          {paidText}
        </p>
      );
    case "processing":
      return (
        <p role="status" className="text-dust-700">
          {processingText}
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
      return (
        <div className="flex flex-col gap-3">
          {deposit.parts_ordered ? (
            <p className="text-dust-700">
              The shop has already ordered your parts. If you paid the deposit another way, ask the
              shop before paying here.
            </p>
          ) : null}
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
              <StripePrivacyLine />
            </>
          ) : (
            <p className="text-dust-700">The shop will tell you how to pay the deposit.</p>
          )}
        </div>
      );
  }
}
