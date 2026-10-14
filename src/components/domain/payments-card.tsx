"use client";

import { useTransition } from "react";

import { checkWithStripeAction } from "@/app/(staff)/jobs/payment-actions";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { formatDate, formatDateTime } from "@/lib/dates";
import type { JobPayment, JobPayments } from "@/lib/domain/payments";
import { formatMoney } from "@/lib/money";
import {
  DEPOSIT_STATE_LABELS,
  DEPOSIT_STATE_TONES,
  PAYMENT_STATUS_TONES,
  paymentStatusLabel,
  stripeDashboardHref,
} from "@/lib/payments";

const ZERO = "0.00";

const INCOMPLETE_CHECK =
  "Stripe's payment or its refunds couldn't be read. An admin should check the Stripe key's permissions (RUNBOOK “Stripe: restricted key”).";

/**
 * A job's Customer payments (Phase 14 step 2; D151, D154, D155, D159;
 * ADR-025): what Stripe confirmed against this job, which every staff
 * member sees. Not called "Payments": consignor settlements use that word.
 * Money held, not a sale (D154): nothing here is revenue, and every figure
 * comes from Postgres as it computed it (public.quote_deposits,
 * public.payment_issues, public.work_order_payment_totals). Problems come
 * first, in the sentence SQL wrote (the same words as Exceptions). Check
 * with Stripe only triggers a read the server makes with its own key;
 * refunds are made in Stripe (D155) and appear here on their own.
 */
export function PaymentsCard({
  id,
  payments,
  canCheck,
  canOpenStripe,
  payOnline,
}: {
  /** The anchor the line under the job's total links to. */
  id?: string;
  payments: JobPayments;
  /** Stripe is on, so the server can read it. */
  canCheck: boolean;
  /** An admin or manager: "Open in Stripe" (D155: refunds are made there). */
  canOpenStripe: boolean;
  /** Stripe is on, so the customer can pay a due deposit online. */
  payOnline: boolean;
}) {
  const { deposits, issues, totals } = payments;
  // Earlier attempts that never completed collapse into one line.
  const attempts = payments.payments.filter((p) => p.status !== "failed" && p.status !== "expired");
  const notCompleted = payments.payments.length - attempts.length;
  const withIssue = new Set(issues.map((i) => i.paymentId));

  return (
    <Card
      id={id}
      title="Customer payments"
      eyebrow="Online, through Stripe"
      className="scroll-mt-4"
    >
      <div className="flex flex-col gap-4">
        {issues.length > 0 ? (
          <ul aria-label="Payment problems" className="flex flex-col gap-2">
            {issues.map((i) => (
              <li
                key={`${i.paymentId}:${i.issue}`}
                className={cn(
                  "rounded-xl p-3 text-sm",
                  i.severity === "danger"
                    ? "bg-danger-soft text-danger-deep"
                    : "bg-waiting-soft text-waiting-deep",
                )}
              >
                {i.message}
              </li>
            ))}
          </ul>
        ) : null}

        {deposits.length > 0 ? (
          <ul aria-label="Deposits" className="flex flex-col divide-y divide-hairline">
            {deposits.map((d) => (
              <li key={d.quoteId} className="flex flex-col gap-1 py-3 first:pt-0">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <span className="flex min-w-0 flex-col">
                    <span className="font-medium">
                      Deposit on the quote
                      {d.answeredAt ? ` answered ${formatDate(d.answeredAt)}` : ""}
                    </span>
                    <span className="text-sm text-dust-500">
                      {formatMoney(d.amount, d.currency)}
                      {d.percent !== null ? ` · ${d.percent}% of approved parts` : ""}
                    </span>
                  </span>
                  <Badge tone={DEPOSIT_STATE_TONES[d.state]}>{DEPOSIT_STATE_LABELS[d.state]}</Badge>
                </div>
                {!payOnline && d.state === "due" ? (
                  <p className="text-sm text-dust-700">
                    Stripe isn&apos;t set up, so the customer can&apos;t pay online. An admin or
                    manager can order without the deposit.
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}

        {attempts.length > 0 || notCompleted > 0 ? (
          <ul aria-label="Online payments" className="flex flex-col divide-y divide-hairline">
            {attempts.map((p) => (
              <PaymentRow
                key={p.id}
                payment={p}
                canCheck={
                  canCheck && (p.status === "pending" || p.refundPending || withIssue.has(p.id))
                }
                canOpenStripe={canOpenStripe}
              />
            ))}
            {notCompleted > 0 ? (
              <li className="py-3 text-sm text-dust-500 first:pt-0">
                {notCompleted === 1
                  ? "1 earlier checkout not completed"
                  : `${notCompleted} earlier checkouts not completed`}
              </li>
            ) : null}
          </ul>
        ) : null}

        {totals ? (
          <dl aria-label="Paid online" className="flex flex-col gap-1 rounded-xl bg-sunken p-3">
            <div className="flex flex-wrap justify-between gap-2">
              <dt>Paid online</dt>
              <dd className="font-semibold tabular-nums">
                {formatMoney(totals.netPaidOnline, totals.currency)}
                {totals.refundedOnline !== ZERO
                  ? ` (${formatMoney(totals.refundedOnline, totals.currency)} refunded)`
                  : ""}
              </dd>
            </div>
            {totals.balanceDue !== null ? (
              <>
                <div className="flex flex-wrap justify-between gap-2 text-sm text-dust-700">
                  <dt>Job total so far</dt>
                  <dd className="tabular-nums">{formatMoney(totals.jobTotal, totals.currency)}</dd>
                </div>
                {totals.paidAhead !== null && totals.paidAhead !== ZERO ? (
                  <div className="flex flex-wrap justify-between gap-2 text-sm">
                    <dt>Paid ahead</dt>
                    <dd>
                      <span className="tabular-nums">
                        {formatMoney(totals.paidAhead, totals.currency)}
                      </span>
                      . Indent parts join the job total when they&apos;re fitted.
                    </dd>
                  </div>
                ) : (
                  <div className="flex flex-wrap justify-between gap-2 text-sm">
                    <dt>Still to pay</dt>
                    <dd className="font-semibold tabular-nums">
                      {formatMoney(totals.balanceDue, totals.currency)}
                    </dd>
                  </div>
                )}
              </>
            ) : null}
          </dl>
        ) : null}

        <p className="text-sm text-dust-500">
          Money held against this job, not a sale. Refunds are made in Stripe and appear here on
          their own.
        </p>
      </div>
    </Card>
  );
}

function PaymentRow({
  payment: p,
  canCheck,
  canOpenStripe,
}: {
  payment: JobPayment;
  canCheck: boolean;
  canOpenStripe: boolean;
}) {
  const { toast } = useToast();
  const [checking, start] = useTransition();
  const label = paymentStatusLabel({
    status: p.status,
    checkoutCompletedAt: p.processing ? p.createdAt : null,
  });
  const href = canOpenStripe ? stripeDashboardHref(p.paymentIntentId, p.livemode) : null;
  const when = p.paidAt ?? p.createdAt;

  const check = () =>
    start(async () => {
      const r = await checkWithStripeAction({ paymentId: p.id });
      const incomplete = r.ok && r.data.incomplete ? INCOMPLETE_CHECK : undefined;
      if (!r.ok) {
        toast({ title: "Not checked", description: r.error, tone: "error" });
      } else if (r.data.changed) {
        // The status as the card words it: a pending payment whose Checkout
        // completed is "Being confirmed".
        const after = paymentStatusLabel({
          status: r.data.after,
          checkoutCompletedAt: r.data.processing ? "completed" : null,
        });
        toast({ title: `Stripe confirmed: ${after}`, description: incomplete, tone: "success" });
      } else {
        toast({ title: "Nothing new from Stripe.", description: incomplete, tone: "success" });
      }
    });

  return (
    <li
      aria-label={`${p.kind === "deposit" ? "Deposit" : "Payment"} ${label}`}
      className="py-3 first:pt-0"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <span className="flex min-w-0 flex-col">
          <span className="font-medium">
            {p.kind === "deposit" ? "Deposit" : "Payment"}{" "}
            <span className="tabular-nums">
              {formatMoney(p.amountReceived ?? p.amount, p.currency)}
            </span>
          </span>
          <span className="text-sm text-dust-500">
            <time dateTime={when}>{formatDateTime(when)}</time>
          </span>
          {p.status === "partially_refunded" ? (
            <span className="text-sm text-dust-700">
              of which {formatMoney(p.refundedAmount, p.currency)} refunded
            </span>
          ) : null}
          {p.refundPending ? (
            <span className="text-sm text-waiting-deep">Refund pending in Stripe</span>
          ) : null}
        </span>
        <Badge tone={PAYMENT_STATUS_TONES[p.status]}>{label}</Badge>
      </div>
      {canCheck || href ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {canCheck ? (
            <Button
              variant="outline"
              size="sm"
              onClick={check}
              pending={checking}
              pendingLabel="Checking…"
            >
              Check with Stripe
            </Button>
          ) : null}
          {href ? (
            <ButtonLink variant="ghost" size="sm" href={href} target="_blank" rel="noreferrer">
              Open in Stripe
            </ButtonLink>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
