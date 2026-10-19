"use client";

import { useState } from "react";

import { recordRefundAction, restockUnitAction } from "@/app/(staff)/sales/actions";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { NumberInput } from "@/components/ui/number-input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Sheet } from "@/components/ui/sheet";
import { formatMoney, parseMoney, toDecimal } from "@/lib/money";
import { CONSIGNED_RESTOCK_NOTE, REFUND_NOT_RESTOCK } from "@/lib/sales";
import { newId } from "@/lib/uuid";
import { callAction } from "@/lib/call-action";

import { ReasonConfirm } from "./reason-confirm";

/**
 * "Record refund" (admins and managers, D94 amending D49): opens
 * RefundSheet. The page renders it only for canRecordRefund and when
 * something is left to refund; the action and the RPC refuse anyone else.
 */
export function RecordRefundButton({
  saleId,
  saleNumber,
  refundable,
  currency,
}: {
  saleId: string;
  saleNumber: string;
  /** What is left to refund (refundableAmount), fixed-2. */
  refundable: string;
  currency: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        Record refund
      </Button>
      {open ? (
        <RefundSheet
          saleId={saleId}
          saleNumber={saleNumber}
          refundable={refundable}
          currency={currency}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

/**
 * Money back to the customer (SPEC §13; D7, D49; record_sale_refund): the
 * amount, defaulting to what is left to refund and capped at it, and a
 * reason through the two-step confirmation. It is financial only: nothing
 * goes back into stock (the sheet says so; a returned unit is restocked
 * separately). The refund id is made when the sheet opens, so a retry
 * records once.
 */
function RefundSheet({
  saleId,
  saleNumber,
  refundable,
  currency,
  onClose,
}: {
  saleId: string;
  saleNumber: string;
  refundable: string;
  currency: string;
  onClose: () => void;
}) {
  const [refundId] = useState(newId);
  const [amount, setAmount] = useState(refundable);
  const parsed = parseMoney(amount, { currency });
  const tooMuch = parsed !== null && parsed.greaterThan(toDecimal(refundable));
  const invalid = parsed === null || parsed.lessThanOrEqualTo(0) || tooMuch;
  const label = parsed && !invalid ? formatMoney(parsed, currency) : null;
  return (
    <Sheet
      open
      onOpenChange={(next) => (next ? null : onClose())}
      title="Record refund"
      description={`Money back to the customer for ${saleNumber}.`}
    >
      <div className="flex flex-col gap-5">
        <Field
          label="Amount"
          required
          hint={`Up to ${formatMoney(refundable, currency)} is left to refund.`}
          error={
            amount.trim() !== "" && invalid
              ? tooMuch
                ? `At most ${formatMoney(refundable, currency)}.`
                : "Enter an amount above 0, like 12.50."
              : undefined
          }
        >
          <NumberInput kind="money" value={amount} onValueChange={setAmount} />
        </Field>
        <p role="note" className="rounded-xl bg-info-soft p-3 text-sm text-info-deep">
          {REFUND_NOT_RESTOCK}
        </p>
        <ReasonConfirm
          startLabel={label ? `Record refund of ${label}…` : "Record refund…"}
          startVariant="solid"
          disabled={invalid}
          question="Why is it being refunded?"
          hint="Kept with the refund."
          confirmLabel={label ? `Refund ${label}` : "Refund"}
          pendingLabel="Refunding…"
          failureTitle="Refund not recorded"
          successTitle={label ? `Refund of ${label} recorded` : "Refund recorded"}
          onConfirm={async (reason) => {
            const result = await callAction(() =>
              recordRefundAction({
                refundId,
                saleId,
                amount: parsed ? parsed.toFixed(2) : amount,
                reason,
              }),
            );
            return result;
          }}
          onDone={onClose}
        >
          {`${saleNumber} stays recorded; the refund is added to it.`}
        </ReasonConfirm>
      </div>
    </Sheet>
  );
}

/**
 * Restock a unit that came back (adjust_stock; a consigned unit also
 * manage_consignments, D46; restock_unit). Always sends this line's id
 * (the replay key) and asks where it goes back (default: where it was
 * sold) and why. For a consigned unit it says the item goes back on sale
 * for the consignor and is no longer owed. The sale and its refunds stay
 * as they are (D7).
 */
export function RestockControl({
  unitId,
  unitShortId,
  saleLineId,
  consigned,
  defaultLocationId,
  locations,
}: {
  unitId: string;
  unitShortId: string;
  saleLineId: string;
  consigned: boolean;
  defaultLocationId: string | null;
  /** Active locations. */
  locations: { id: string; name: string }[];
}) {
  const [confirming, setConfirming] = useState(false);
  const [locationId, setLocationId] = useState<string | null>(
    defaultLocationId && locations.some((l) => l.id === defaultLocationId)
      ? defaultLocationId
      : (locations[0]?.id ?? null),
  );
  return (
    <div className="flex flex-col gap-2">
      {confirming && locations.length > 1 ? (
        <div className="flex flex-col gap-2">
          <span className="font-display text-xs font-bold tracking-wide uppercase">Back to</span>
          <SegmentedControl
            label={`Where ${unitShortId} goes back`}
            value={locationId ?? undefined}
            onValueChange={setLocationId}
            options={locations.map((l) => ({ value: l.id, label: l.name }))}
          />
        </div>
      ) : null}
      <ReasonConfirm
        startLabel="Restock…"
        startAccessibleName={`Restock… ${unitShortId}`}
        startSize="sm"
        question={`Why is ${unitShortId} going back into stock?`}
        confirmLabel="Restock"
        pendingLabel="Restocking…"
        failureTitle="Not restocked"
        successTitle={`${unitShortId} is back in stock`}
        onConfirmingChange={setConfirming}
        onConfirm={(reason) => restockUnitAction({ unitId, saleLineId, locationId, reason })}
      >
        {consigned
          ? `${unitShortId} is available again. ${CONSIGNED_RESTOCK_NOTE}`
          : `${unitShortId} is available again. The sale and any refund stay as they are.`}
      </ReasonConfirm>
    </div>
  );
}
