"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import type { ActionResult } from "@/lib/actions";
import type { JobQuote, PartRequest } from "@/lib/domain/indent";
import type { JobDeposit } from "@/lib/domain/payments";
import {
  canFit,
  notFittedNote,
  quoteWithdrawNote,
  settleDescription,
  settleTitle,
  type ClosingStatus,
} from "@/lib/indent";
import { formatMoney, formatQuantity } from "@/lib/money";
import { depositStates } from "@/lib/payments";
import type { WorkOrderStatus } from "@/lib/workshop";

import { CancelSheet, DepositBadge, FitSheet } from "./indent-sheets";
import { ReasonConfirm } from "./reason-confirm";

/** What the checklist needs from the job page (D149b, D149c). */
export type SettleContext = {
  /** The job's approved and ordered requests (isUnfitted). */
  items: readonly PartRequest[];
  /** The job's latest quote (an open one is withdrawn by the move, D149c(2)). */
  quote: JobQuote | null;
  /** How many requests are on that quote, waiting for the customer. */
  quotedItems: number;
  /** View costs or Manage purchasing: Fit offers Bought outside BICII (D149a). */
  purchaseData: boolean;
  /** Manage purchasing: an ordered part links to its purchase order. */
  canOrder: boolean;
  /** Where Fit takes a part from (add_inventory_line's default). */
  defaultLocationName: string | null;
  /** Answered quotes that asked a deposit (D151): each item's deposit badge. */
  deposits: readonly JobDeposit[];
};

const CONTINUE_LABELS: Record<Exclude<ClosingStatus, "cancelled">, string> = {
  completed: "Complete job",
  ready_for_collection: "Mark ready",
  collected: "Collected…",
};

/**
 * Before a job leaves the open statuses (D149b, D149c(1)): its approved and
 * ordered indent items, each with Fit (or Add to job) and Cancel item… —
 * Cancel only when the job is being cancelled (a fitted line would block
 * that, D16), and on a job that is no longer open (completed or ready
 * before the guard, R-082's residual), where Fit needs a reopen. The move's
 * own button stays disabled until none is left; the list comes from the
 * page, so each Fit or Cancel refreshes it. An open quote is named, because
 * the move withdraws it (D149c(2)). The database refuses the move anyway
 * (work_order_has_unfitted_requests).
 */
export function SettleItemsSheet({
  jobNumber,
  jobStatus,
  target,
  settle,
  pending,
  onBack,
  onContinue,
  onCancelJob,
  onCancelled,
}: {
  jobNumber: string;
  jobStatus: WorkOrderStatus;
  target: ClosingStatus;
  settle: SettleContext;
  /** The move is running. */
  pending: boolean;
  onBack: () => void;
  /** Complete, Mark ready, or go on to the Collected confirmation. */
  onContinue: () => void;
  /** Cancel the job with this reason (target cancelled). */
  onCancelJob: (reason: string) => Promise<ActionResult<unknown>>;
  /** After the job was cancelled. */
  onCancelled: () => void;
}) {
  const [sheet, setSheet] = useState<null | { fit: PartRequest } | { cancel: PartRequest }>(null);
  const jobOpen = jobStatus !== "completed" && jobStatus !== "ready_for_collection";
  const items = settle.items;
  const settled = items.length === 0;
  const depositByRequest = useMemo(() => depositStates(settle.deposits), [settle.deposits]);
  const quoteNote = quoteWithdrawNote(settle.quote, target, settle.quotedItems);
  const close = () => setSheet(null);

  return (
    <>
      <Sheet
        open
        onOpenChange={(next) => (next ? null : onBack())}
        dismissible={!pending}
        title={settleTitle(target, jobNumber)}
        description={settleDescription(target)}
        footer={
          <>
            <Button variant="outline" onClick={onBack} disabled={pending}>
              Back
            </Button>
            {target === "cancelled" ? null : (
              <Button
                onClick={onContinue}
                disabled={!settled}
                pending={pending}
                pendingLabel="Saving…"
              >
                {CONTINUE_LABELS[target]}
              </Button>
            )}
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {settled ? (
            <p role="status" className="rounded-xl bg-done-soft p-3 text-sm text-done-deep">
              All settled.
            </p>
          ) : (
            <ul aria-label="Items to settle" className="flex flex-col divide-y divide-hairline">
              {items.map((r) => (
                <li key={r.id} aria-label={r.description} className="flex flex-col gap-2 py-3">
                  <span className="font-medium break-words">
                    {formatQuantity(r.quantity)} × {r.description} ·{" "}
                    {formatMoney(r.lineTotal, r.currency)}
                  </span>
                  <span className="flex flex-wrap items-center gap-2 text-sm">
                    {r.status === "ordered" && r.order ? (
                      <Badge tone="info">
                        Ordered · {r.order.poNumber} ·{" "}
                        {r.order.arrived ? "Arrived" : "Not arrived yet"}
                      </Badge>
                    ) : (
                      <Badge tone="done">Approved</Badge>
                    )}
                    <DepositBadge request={r} depositByRequest={depositByRequest} showPaid />
                    {r.status === "ordered" && r.order && settle.canOrder ? (
                      <Link
                        href={`/purchasing/orders/${r.order.purchaseOrderId}`}
                        className="font-medium underline"
                      >
                        Open {r.order.poNumber}
                      </Link>
                    ) : null}
                  </span>
                  {jobOpen ? null : (
                    <p className="text-sm text-danger-deep">{notFittedNote(jobStatus)}</p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {jobOpen && target !== "cancelled" && canFit(r.kind, r.status) ? (
                      <Button size="sm" onClick={() => setSheet({ fit: r })}>
                        {r.kind === "service" ? "Add to job" : "Fit"}
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Cancel item ${r.description}…`}
                      onClick={() => setSheet({ cancel: r })}
                    >
                      Cancel item…
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {quoteNote ? <p className="text-sm text-dust-700">{quoteNote}</p> : null}
          {target === "cancelled" ? (
            <ReasonConfirm
              startLabel="Cancel job…"
              question="Why is this job being cancelled?"
              hint="Kept on the job's timeline."
              confirmLabel="Cancel job"
              pendingLabel="Cancelling…"
              failureTitle="Job not cancelled"
              successTitle={`${jobNumber} cancelled`}
              dismissLabel="Keep job"
              disabled={!settled}
              onConfirm={onCancelJob}
              onDone={onCancelled}
            />
          ) : null}
        </div>
      </Sheet>
      {sheet && "fit" in sheet ? (
        <FitSheet
          request={sheet.fit}
          locationName={settle.defaultLocationName}
          purchaseData={settle.purchaseData}
          onClose={close}
        />
      ) : null}
      {sheet && "cancel" in sheet ? (
        <CancelSheet request={sheet.cancel} closed={false} onClose={close} />
      ) : null}
    </>
  );
}
