"use client";

import { useActionState, useEffect, useId, useState } from "react";

import {
  applyJobDiscountAction,
  previewJobDiscountAction,
} from "@/app/(staff)/jobs/discount-actions";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { TagIcon } from "@/components/ui/icons";
import { NumberInput } from "@/components/ui/number-input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Sheet } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { useFocusFirstInvalid } from "@/components/ui/use-focus-invalid";
import type { ActionResult } from "@/lib/actions";
import { callAction } from "@/lib/call-action";
import { DISCOUNT_REASON_MAX } from "@/lib/discount-forms";
import { discountAmount, type DiscountMode } from "@/lib/discounts";
import type { DiscountPlan, DiscountResult } from "@/lib/domain/discounts";
import { formatMoney, formatQuantity } from "@/lib/money";
import { newId } from "@/lib/uuid";

type State = ActionResult<DiscountResult> | null;

/**
 * "Discount / round off" (D271): any staff member takes an amount off the
 * job, or rounds its total to a figure, with a reason. The database spreads
 * it over the job's chargeable lines as new prices; the preview shows each
 * line's new price before anything changes. A completed or ready job is
 * reopened and completed again in the same step. The sheet's request id is
 * the idempotency key.
 */
export function DiscountButton({
  workOrderId,
  currency,
  total,
}: {
  workOrderId: string;
  currency: string;
  /** The job's total now (its live lines). */
  total: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        icon={<TagIcon className="size-4" />}
        onClick={() => setOpen(true)}
      >
        Discount / round off
      </Button>
      {open ? (
        <DiscountSheet
          workOrderId={workOrderId}
          currency={currency}
          total={total}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function DiscountSheet({
  workOrderId,
  currency,
  total,
  onClose,
}: {
  workOrderId: string;
  currency: string;
  total: string;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const formId = useId();
  const [requestId] = useState(newId);
  const [mode, setMode] = useState<DiscountMode>("amount");
  const [figure, setFigure] = useState("");
  const [reason, setReason] = useState("");
  const [plan, setPlan] = useState<DiscountPlan | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const computed = discountAmount(mode, figure, total);
  const amount = computed.ok ? computed.amount : null;

  // The database's plan for this amount, a moment after typing stops.
  useEffect(() => {
    if (amount === null) return;
    let live = true;
    const timer = setTimeout(async () => {
      const result = await callAction(() => previewJobDiscountAction({ workOrderId, amount }));
      if (!live) return;
      if (result.ok) {
        setPlan(result.data);
        setPreviewError(null);
      } else {
        setPlan(null);
        setPreviewError(result.error);
      }
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [amount, workOrderId]);

  const [state, formAction, pending] = useActionState<State, FormData>(async (prev, formData) => {
    const result = await callAction(() => applyJobDiscountAction(prev, formData), formData);
    if (result.ok) {
      toast({
        title: `${formatMoney(result.data.applied, currency)} taken off`,
        description: `The job's total is now ${formatMoney(result.data.totalAfter, currency)}.`,
        tone: "success",
      });
      onClose();
    }
    return result;
  }, null);
  const formRef = useFocusFirstInvalid(state);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  const shown = amount !== null && plan !== null && plan.amount === amount ? plan : null;
  const changed = shown ? shown.lines.filter((l) => l.toPrice !== l.fromPrice) : [];

  return (
    <Sheet
      open
      onOpenChange={(next) => (next ? null : onClose())}
      dismissible={!pending}
      title="Discount / round off"
      description={`The job's total is ${formatMoney(total, currency)}. The amount is spread over its lines as new prices.`}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} pending={pending} pendingLabel="Applying…">
            Apply discount
          </Button>
        </>
      }
    >
      <form
        id={formId}
        ref={formRef}
        action={formAction}
        className="flex flex-col gap-5"
        noValidate
      >
        <input type="hidden" name="requestId" value={requestId} />
        <input type="hidden" name="workOrderId" value={workOrderId} />
        <input type="hidden" name="amount" value={amount ?? ""} />
        {state && !state.ok ? (
          <p role="alert" className="text-sm font-medium text-danger-deep">
            {state.error}
          </p>
        ) : null}
        <SegmentedControl<DiscountMode>
          label="How to discount"
          options={[
            { value: "amount", label: "Take off" },
            { value: "target", label: "Round to" },
          ]}
          value={mode}
          onValueChange={(next) => {
            setMode(next);
            setFigure("");
          }}
        />
        <Field
          label={mode === "amount" ? "Amount to take off" : "New total"}
          hint={
            mode === "amount"
              ? `At most ${formatMoney(total, currency)}, the job's total.`
              : `Below ${formatMoney(total, currency)}, the job's total now.`
          }
          error={
            (!computed.ok && figure.trim() !== "" ? computed.error : null) ?? errors?.amount?.[0]
          }
          required
        >
          <NumberInput kind="money" value={figure} onValueChange={setFigure} />
        </Field>
        <Field label="Reason" error={errors?.reason?.[0]} required>
          <Textarea
            name="reason"
            rows={2}
            maxLength={DISCOUNT_REASON_MAX}
            placeholder="Regular customer, round to 100, scratch on the frame…"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>

        {previewError && amount !== null ? (
          <p role="alert" className="text-sm font-medium text-danger-deep">
            {previewError}
          </p>
        ) : null}
        {shown ? (
          <section aria-label="New prices" className="flex flex-col gap-3">
            {shown.reopens ? (
              <p className="rounded-xl bg-waiting-soft p-3 text-sm text-waiting-deep">
                This job is completed or ready for collection. It is reopened, discounted and put
                back in one step; the reason goes on the reopen.
                {shown.withdrawsLink
                  ? " Its payment link is withdrawn: send a new one for the new total."
                  : null}
              </p>
            ) : null}
            <ul className="divide-y divide-hairline rounded-xl border border-hairline">
              {changed.map((l) => (
                <li key={l.lineId} className="flex flex-col gap-1 px-4 py-2 text-sm">
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate">
                      {formatQuantity(l.quantity)} × {l.description}
                    </span>
                    <span className="shrink-0 tabular-nums">
                      <s className="text-dust-700">{formatMoney(l.fromPrice, currency)}</s>{" "}
                      {formatMoney(l.toPrice, currency)}
                    </span>
                  </span>
                  {l.belowConsignor ? (
                    <span className="text-waiting-deep">
                      This sells {l.description} below what is owed to the consignor.
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
            {shown.applied !== shown.amount ? (
              <p className="rounded-xl bg-waiting-soft p-3 text-sm text-waiting-deep">
                The lines come in quantities that take {formatMoney(shown.applied, currency)} off,
                not exactly {formatMoney(shown.amount, currency)}.
              </p>
            ) : null}
            {shown.paidOver !== "0.00" ? (
              <p className="rounded-xl bg-waiting-soft p-3 text-sm text-waiting-deep">
                The customer has already paid {formatMoney(shown.paid, currency)}, so{" "}
                {formatMoney(shown.paidOver, currency)} of it will be above the new total. Give it
                back from Payments.
              </p>
            ) : null}
            <p className="flex items-baseline justify-between rounded-xl bg-sunken px-4 py-3 tabular-nums">
              <span className="text-sm text-dust-700">New total</span>
              <output className="text-lg font-bold">
                {formatMoney(shown.totalAfter, currency)}
              </output>
            </p>
          </section>
        ) : null}
      </form>
    </Sheet>
  );
}
