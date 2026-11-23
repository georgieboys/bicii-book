"use client";

import Link from "next/link";
import { useTransition } from "react";

import { reviewCounterPaymentAction } from "@/app/(staff)/jobs/payment-actions";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { callAction } from "@/lib/call-action";
import { formatDate } from "@/lib/dates";
import type { CounterPaymentToReview } from "@/lib/domain/payments";
import { formatMoney } from "@/lib/money";
import { COUNTER_METHOD_LABELS } from "@/lib/payments";

/**
 * D270: counter payments recorded by someone who is not an admin, for an
 * admin to check against the till or the terminal and press Looks right.
 * Nothing waits for it: the payment already counts on the job. One that
 * was wrong is voided on the job's Customer payments card.
 */
export function CounterReviewList({
  rows,
  total,
}: {
  rows: CounterPaymentToReview[];
  total: number;
}) {
  if (rows.length === 0) return null;
  return (
    <section
      aria-labelledby="counter-review"
      className="flex flex-col gap-2 rounded-2xl bg-info-soft p-4"
    >
      <h2 id="counter-review" className="eyebrow text-info-deep">
        Counter payments to review ({total})
      </h2>
      <p className="text-sm text-info-deep">
        Recorded at the counter by staff who aren&apos;t admins. They already count on the job.
        Check each against the till or the terminal, then press Looks right; void one that is wrong
        on its job.
      </p>
      <ul className="flex flex-col gap-2">
        {rows.map((row) => (
          <CounterReviewRow key={row.id} row={row} />
        ))}
      </ul>
      {total > rows.length ? (
        <p className="text-sm text-info-deep">
          {total - rows.length} more after these, oldest first.
        </p>
      ) : null}
    </section>
  );
}

function CounterReviewRow({ row }: { row: CounterPaymentToReview }) {
  const { toast } = useToast();
  const [pending, start] = useTransition();
  const amount = formatMoney(row.amount, row.currency);
  const what = row.kind === "deposit" ? "Deposit" : "Towards the bill";
  const review = () =>
    start(async () => {
      const r = await callAction(() => reviewCounterPaymentAction({ counterPaymentId: row.id }));
      if (!r.ok) toast({ title: "Not saved", description: r.error, tone: "error" });
    });
  return (
    <li
      aria-label={`${amount} ${what.toLowerCase()} on ${row.jobNumber ?? "a job"}`}
      className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-card p-3"
    >
      <span className="flex min-w-0 flex-col">
        <span className="font-medium">
          <span className="tabular-nums">{amount}</span> · {what} ·{" "}
          {COUNTER_METHOD_LABELS[row.method]}
        </span>
        <span className="text-sm text-dust-700">
          <Link href={`/jobs/${row.workOrderId}#customer-payments`} className="underline">
            {row.jobNumber ?? "Open the job"}
          </Link>
          {" · "}paid <time dateTime={row.receivedAt}>{formatDate(row.receivedAt)}</time>
          {row.reference ? ` · Ref ${row.reference}` : ""} · recorded by {row.recordedBy}
        </span>
      </span>
      <Button size="sm" variant="outline" onClick={review} pending={pending} pendingLabel="Saving…">
        Looks right
      </Button>
    </li>
  );
}
