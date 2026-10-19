"use client";

import { useTransition } from "react";

import { cancelPurchaseOrder, submitPurchaseOrder } from "@/app/(staff)/purchasing/actions";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { useArmedAfter } from "@/components/ui/use-armed";

import { ReasonConfirm } from "../reason-confirm";
import { callAction } from "@/lib/call-action";

/**
 * "Submit order" on a draft: one explicit button with a pending state and
 * no confirmation (a submitted order can still be edited or cancelled).
 * It ignores presses for 400 ms after it appears, so a double tap on the
 * button above it cannot land here.
 */
export function SubmitOrderButton({
  purchaseOrderId,
  poNumber,
  disabled = false,
}: {
  purchaseOrderId: string;
  poNumber: string;
  disabled?: boolean;
}) {
  const { toast } = useToast();
  const [pending, start] = useTransition();
  const armed = useArmedAfter(purchaseOrderId);
  return (
    <Button
      pending={pending}
      pendingLabel="Submitting…"
      disabled={disabled || !armed}
      onClick={() =>
        start(async () => {
          const result = await callAction(() => submitPurchaseOrder({ purchaseOrderId }));
          toast(
            result.ok
              ? { title: `${poNumber} submitted`, tone: "success" }
              : { title: `${poNumber} not submitted`, description: result.error, tone: "error" },
          );
        })
      }
    >
      Submit order
    </Button>
  );
}

/**
 * "Cancel order…" (D61 D-PO-CANCEL): the destructive two-step pattern with
 * a required reason (ReasonConfirm: focus in the reason, the confirm in
 * another place with another key, presses ignored for 400 ms). Cancelling
 * is final; whatever already arrived stays in stock.
 */
export function CancelOrderControl({
  purchaseOrderId,
  poNumber,
  received,
}: {
  purchaseOrderId: string;
  poNumber: string;
  /** Units already received (they stay). */
  received: number;
}) {
  return (
    <ReasonConfirm
      startLabel="Cancel order…"
      question="Why is this order being cancelled?"
      hint="Kept in the order's history."
      confirmLabel="Cancel order"
      pendingLabel="Cancelling…"
      dismissLabel="Keep order"
      failureTitle={`${poNumber} not cancelled`}
      successTitle={`${poNumber} cancelled`}
      onConfirm={(reason) => cancelPurchaseOrder({ purchaseOrderId, reason })}
    >
      {received > 0
        ? `Items already received stay in stock (${received} so far). Nothing more can be received on this order, and it can't be reopened.`
        : "Items already received stay in stock. Nothing can be received on a cancelled order, and it can't be reopened."}
    </ReasonConfirm>
  );
}
