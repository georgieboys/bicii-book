"use client";

import { useState, useTransition } from "react";

import {
  checkWithStripeAction,
  voidCounterPaymentAction,
} from "@/app/(staff)/jobs/payment-actions";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PlusIcon } from "@/components/ui/icons";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { formatDate, formatDateTime } from "@/lib/dates";
import type { CounterPayment, JobPayment, JobPayments } from "@/lib/domain/payments";
import { whatsappHref } from "@/lib/indent";
import { formatMoney } from "@/lib/money";
import {
  COUNTER_METHOD_LABELS,
  COUNTER_VOID_LABELS,
  balanceMessage,
  canSendLink,
  depositBadge,
  heldOverSentence,
  incompleteCheckNote,
  linkLine,
  PAYMENT_STATUS_TONES,
  paymentStatusLabel,
  processingSentence,
  showsPaymentTotals,
  stripeDashboardHref,
  type CounterVoidKind,
} from "@/lib/payments";
import type { WorkOrderStatus } from "@/lib/workshop";

import {
  BalanceLinkSentSheet,
  SendBalanceLinkSheet,
  type BalanceLinkSent,
} from "./balance-link-sheets";
import { CounterPaymentSheet } from "./counter-payment-sheet";
import { ReasonConfirm } from "./reason-confirm";

const ZERO = "0.00";

/** The job the card belongs to, for its controls (D156, D161). */
export type PaymentsCardJob = {
  id: string;
  jobNumber: string;
  status: WorkOrderStatus;
  /** One of D15's open statuses: lines may still change. */
  open: boolean;
  currency: string;
  checkedInAt: string;
};

/**
 * A job's Customer payments (Phase 14; D151, D154-D156, D159, D161;
 * ADR-025): what Stripe confirmed and what an admin recorded at the
 * counter against this job, which every staff member sees. Not called
 * "Payments": consignor settlements use that word. Money held, not a sale
 * (D154): nothing here is revenue, and every figure comes from Postgres as
 * it computed it (public.quote_deposits, public.payment_issues,
 * public.work_order_payment_totals). Problems come first, in the sentence
 * SQL wrote (the same words as Exceptions). Check with Stripe only
 * triggers a read the server makes with its own key, and only for a
 * Stripe payment; refunds are made in Stripe (D155) and appear here on
 * their own. "Send payment link" (any staff member, while Stripe is on and
 * the bill is final) and "Record counter payment" (admins, on a job that
 * is not cancelled) sit in the header; an admin corrects a counter
 * payment by voiding it, as recorded in error or given back.
 */
export function PaymentsCard({
  id,
  job,
  payments,
  canCheck,
  canOpenStripe,
  payOnline,
  canRecordCounter = false,
  customer = { firstName: null, phone: null, email: null },
  emailEnabled = false,
}: {
  /** The anchor the line under the job's total links to. */
  id?: string;
  job: PaymentsCardJob;
  payments: JobPayments;
  /** Stripe is on, so the server can read it. */
  canCheck: boolean;
  /** An admin or manager: "Open in Stripe" (D155: refunds are made there). */
  canOpenStripe: boolean;
  /** Stripe is on: the customer can pay online (a due deposit, a payment link). */
  payOnline: boolean;
  /** An active admin (D161a): Record counter payment and the void controls. */
  canRecordCounter?: boolean;
  customer?: { firstName: string | null; phone: string | null; email: string | null };
  /** RESEND_API_KEY and EMAIL_FROM are set: links can be emailed. */
  emailEnabled?: boolean;
}) {
  const { deposits, issues, totals, counterPayments, link } = payments;
  const [sheet, setSheet] = useState<null | "link" | "counter">(null);
  const [sent, setSent] = useState<BalanceLinkSent | null>(null);
  // Earlier attempts that never completed collapse into one line.
  const attempts = payments.payments.filter((p) => p.status !== "failed" && p.status !== "expired");
  const notCompleted = payments.payments.length - attempts.length;
  // Check with Stripe is for a Stripe payment's issue only, never a counter one.
  const withIssue = new Set(issues.map((i) => i.paymentId).filter((v): v is string => !!v));
  // R-082: a collected or cancelled job holding more than its bill.
  const heldOver = totals ? heldOverSentence(totals) : null;
  const currency = totals?.currency ?? job.currency;
  const sendable =
    totals !== null &&
    canSendLink({
      stripeOn: payOnline,
      jobStatus: job.status,
      currency,
      balanceDue: totals.balanceDue,
      processingOnline: totals.processingOnline,
    });
  const recordable = canRecordCounter && job.status !== "cancelled";

  return (
    <Card
      id={id}
      title="Customer payments"
      eyebrow="Online through Stripe, and at the counter"
      className="scroll-mt-4"
      actions={
        sendable || recordable ? (
          <>
            {sendable ? (
              <Button variant="outline" size="sm" onClick={() => setSheet("link")}>
                Send payment link
              </Button>
            ) : null}
            {recordable ? (
              <Button
                variant="outline"
                size="sm"
                icon={<PlusIcon className="size-4" />}
                onClick={() => setSheet("counter")}
              >
                Record counter payment
              </Button>
            ) : null}
          </>
        ) : null
      }
    >
      <div className="flex flex-col gap-4">
        {issues.length > 0 ? (
          <ul aria-label="Payment problems" className="flex flex-col gap-2">
            {issues.map((i) => (
              <li
                key={`${i.paymentId ?? i.counterPaymentId}:${i.issue}`}
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

        {link ? (
          <p aria-label="Payment link" className="rounded-xl bg-sunken px-4 py-3 text-sm">
            {linkLine(link, currency)}
          </p>
        ) : null}

        {deposits.length > 0 ? (
          <ul aria-label="Deposits" className="flex flex-col divide-y divide-hairline">
            {deposits.map((d) => {
              const badge = depositBadge(d.state, job.open);
              return (
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
                    <Badge tone={badge.tone}>{badge.label}</Badge>
                  </div>
                  {!payOnline && d.state === "due" && job.open ? (
                    <p className="text-sm text-dust-700">
                      Stripe isn&apos;t set up, so the customer can&apos;t pay online. An admin or
                      manager can order without the deposit.
                    </p>
                  ) : null}
                </li>
              );
            })}
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

        {counterPayments.length > 0 ? (
          <section aria-label="At the counter" className="flex flex-col gap-1">
            <h3 className="font-display text-xs font-bold tracking-wide uppercase">
              At the counter
            </h3>
            <ul className="flex flex-col divide-y divide-hairline">
              {counterPayments.map((c) => (
                <CounterRow key={c.id} payment={c} canVoid={canRecordCounter} />
              ))}
            </ul>
          </section>
        ) : null}

        {totals && showsPaymentTotals(payments) ? (
          <dl aria-label="Payment totals" className="flex flex-col gap-1 rounded-xl bg-sunken p-3">
            <div className="flex flex-wrap justify-between gap-2">
              <dt>Paid online</dt>
              <dd className="font-semibold tabular-nums">
                {formatMoney(totals.netPaidOnline, totals.currency)}
                {totals.refundedOnline !== ZERO
                  ? ` (${formatMoney(totals.refundedOnline, totals.currency)} refunded)`
                  : ""}
              </dd>
            </div>
            {totals.paidAtCounter !== ZERO ? (
              <div className="flex flex-wrap justify-between gap-2">
                <dt>Paid at the counter</dt>
                <dd className="font-semibold tabular-nums">
                  {formatMoney(totals.paidAtCounter, totals.currency)}
                </dd>
              </div>
            ) : null}
            {totals.processingOnline !== ZERO ? (
              <div className="flex flex-wrap justify-between gap-2 text-sm text-waiting-deep">
                <dt className="sr-only">Being confirmed by Stripe</dt>
                <dd>{processingSentence(formatMoney(totals.processingOnline, totals.currency))}</dd>
              </div>
            ) : null}
            {totals.balanceDue !== null ? (
              <>
                <div className="flex flex-wrap justify-between gap-2 text-sm text-dust-700">
                  <dt>{job.open ? "Job total so far" : "Job total"}</dt>
                  <dd className="tabular-nums">{formatMoney(totals.jobTotal, totals.currency)}</dd>
                </div>
                {totals.paidAhead !== null && totals.paidAhead !== ZERO ? (
                  job.open ? (
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
                      <dt>Paid above the bill</dt>
                      <dd className="font-semibold tabular-nums">
                        {formatMoney(totals.paidAhead, totals.currency)}
                      </dd>
                    </div>
                  )
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
            {heldOver ? (
              <div className="flex flex-wrap justify-between gap-2 text-sm">
                <dt className="sr-only">More than the bill</dt>
                <dd>{heldOver}</dd>
              </div>
            ) : null}
          </dl>
        ) : null}

        <p className="text-sm text-dust-500">
          Money held against this job, not a sale. Online refunds are made in Stripe; an admin
          corrects a counter payment by voiding it.
        </p>
      </div>

      {sheet === "link" && totals?.balanceDue ? (
        <SendBalanceLinkSheet
          workOrderId={job.id}
          stillToPay={totals.balanceDue}
          currency={currency}
          hasWhatsapp={whatsappHref(customer.phone, "x") !== null}
          emailEnabled={emailEnabled}
          emailTo={emailEnabled ? customer.email : null}
          replaces={link ? { sentAt: link.sentAt, expiresAt: link.expiresAt } : null}
          onSent={(result) => {
            setSheet(null);
            setSent(result);
          }}
          onClose={() => setSheet(null)}
        />
      ) : null}
      {sent ? (
        <BalanceLinkSentSheet
          sent={sent}
          message={balanceMessage({
            firstName: customer.firstName,
            jobNumber: job.jobNumber,
            amount: formatMoney(sent.amount, currency),
            link: sent.link,
            days: sent.validDays,
          })}
          phone={customer.phone}
          onClose={() => setSent(null)}
        />
      ) : null}
      {sheet === "counter" ? (
        <CounterPaymentSheet
          workOrderId={job.id}
          jobNumber={job.jobNumber}
          jobStatus={job.status}
          jobOpen={job.open}
          checkedInAt={job.checkedInAt}
          deposits={deposits}
          balanceDue={totals?.balanceDue ?? null}
          jobTotal={totals?.jobTotal ?? null}
          currency={currency}
          onClose={() => setSheet(null)}
        />
      ) : null}
    </Card>
  );
}

/**
 * One counter payment: what it was for, how it was paid, the amount, the
 * day, the reference and who recorded it; a voided one struck through
 * with why, who and when. An admin's two corrections on a live one, each
 * its own ReasonConfirm (D161d; step3-critique C18): "Void (recorded in
 * error)…" (it never came in) and "Given back…" (the shop handed it back
 * outside BICII). The void is replay-safe on the payment, its kind and
 * its reason, so no request id is needed.
 */
function CounterRow({ payment: c, canVoid }: { payment: CounterPayment; canVoid: boolean }) {
  const [confirming, setConfirming] = useState<CounterVoidKind | null>(null);
  const amount = formatMoney(c.amount, c.currency);
  const what = c.kind === "deposit" ? "Deposit" : "Towards the bill";
  const label = `${what} ${amount}, ${COUNTER_METHOD_LABELS[c.method]}`;
  const voidControl = (kind: CounterVoidKind) => (
    <ReasonConfirm
      key={kind}
      startLabel={kind === "recorded_in_error" ? "Void (recorded in error)…" : "Given back…"}
      startAccessibleName={`${
        kind === "recorded_in_error" ? "Void (recorded in error)…" : "Given back…"
      } ${label}`}
      startSize="sm"
      startVariant="ghost"
      question={
        kind === "recorded_in_error" ? "Why was it recorded in error?" : "Why was it given back?"
      }
      hint="Kept with the payment and on the job's timeline."
      confirmLabel={kind === "recorded_in_error" ? "Void payment" : "Record as given back"}
      pendingLabel="Voiding…"
      failureTitle="Counter payment not voided"
      successTitle={
        kind === "recorded_in_error"
          ? `${amount} voided: recorded in error`
          : `${amount} recorded as given back`
      }
      dismissLabel="Keep payment"
      onConfirmingChange={(open) =>
        setConfirming((now) => (open ? kind : now === kind ? null : now))
      }
      onConfirm={(reason) => voidCounterPaymentAction({ counterPaymentId: c.id, kind, reason })}
    >
      {kind === "recorded_in_error"
        ? `${amount} no longer counts on this job, and Reports leave it out of the day it was taken, as if it never came in. Record it again if it was only wrong.`
        : `${amount} no longer counts on this job. Reports keep it on the day it was taken and show it given back today. BICII moves no money: give it back first.`}
    </ReasonConfirm>
  );

  return (
    <li aria-label={label} className="flex flex-col gap-1 py-3 first:pt-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <span className="flex min-w-0 flex-col">
          <span className={cn("font-medium", c.voided && "text-dust-500 line-through")}>
            {what} · {COUNTER_METHOD_LABELS[c.method]}
          </span>
          <span className="text-sm text-dust-500">
            Paid <time dateTime={c.receivedAt}>{formatDate(c.receivedAt)}</time>
            {c.reference ? ` · Ref ${c.reference}` : ""} · recorded by {c.recordedBy}
          </span>
          {c.note ? <span className="text-sm text-dust-700">{c.note}</span> : null}
        </span>
        <span
          className={cn("font-semibold tabular-nums", c.voided && "text-dust-500 line-through")}
        >
          {amount}
        </span>
      </div>
      {c.voided ? (
        <p className="text-sm text-dust-700">
          {COUNTER_VOID_LABELS[c.voided.kind]}: {c.voided.reason} · {c.voided.voidedBy} ·{" "}
          <time dateTime={c.voided.voidedAt}>{formatDateTime(c.voided.voidedAt)}</time>
        </p>
      ) : canVoid ? (
        <div className="flex flex-wrap gap-2">
          {confirming !== "given_back" ? voidControl("recorded_in_error") : null}
          {confirming !== "recorded_in_error" ? voidControl("given_back") : null}
        </div>
      ) : null}
    </li>
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
  const kindLabel = p.kind === "deposit" ? "Deposit" : p.kind === "balance" ? "Balance" : "Payment";

  const check = () =>
    start(async () => {
      const r = await checkWithStripeAction({ paymentId: p.id });
      const incomplete =
        r.ok && r.data.incomplete ? incompleteCheckNote(r.data.incomplete) : undefined;
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
    <li aria-label={`${kindLabel} ${label}`} className="py-3 first:pt-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <span className="flex min-w-0 flex-col">
          <span className="font-medium">
            {kindLabel}{" "}
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
