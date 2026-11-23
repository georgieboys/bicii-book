"use client";

import { useActionState, useId, useState } from "react";

import { addManualLine } from "@/app/(staff)/jobs/actions";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { PlusIcon } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Sheet } from "@/components/ui/sheet";
import { useFocusFirstInvalid } from "@/components/ui/use-focus-invalid";
import type { ActionResult } from "@/lib/actions";
import type { LinePlacement } from "@/lib/domain/lines";
import type { AfterComplete } from "@/lib/workshop";
import { newId } from "@/lib/uuid";
import { callAction } from "@/lib/call-action";

import { previewTotal } from "./add-service-sheet";
import { AfterCompleteNote, useAddedToast } from "./after-complete";

type State = ActionResult<{ id: string } & LinePlacement> | null;

/**
 * "Add manual line": a free-text line (a sundry, a one-off item) with a
 * quantity and unit price, and a cost only for view_costs holders (D14).
 * Labour is usually a service line. A line added without a cost is
 * marked cost pending (its 0 is a placeholder) until someone with cost
 * access voids it and adds it again with the cost. The preview is display
 * only; the database computes the line. The sheet's line id is the
 * idempotency key. On a completed job (`afterComplete`, D269) it says
 * beforehand what will happen.
 */
export function ManualLineButton({
  workOrderId,
  viewCosts,
  currency,
  disabled = false,
  afterComplete = null,
}: {
  workOrderId: string;
  viewCosts: boolean;
  currency: string;
  disabled?: boolean;
  /** D269: the job is completed; what adding a line does. */
  afterComplete?: AfterComplete | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        icon={<PlusIcon className="size-4" />}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        Add manual line
      </Button>
      {open ? (
        <ManualLineSheet
          workOrderId={workOrderId}
          viewCosts={viewCosts}
          currency={currency}
          afterComplete={afterComplete}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

export function ManualLineSheet({
  workOrderId,
  viewCosts,
  currency,
  initialDescription = "",
  afterComplete = null,
  onClose,
}: {
  workOrderId: string;
  viewCosts: boolean;
  currency: string;
  /** Add part's "one-off" shortcut fills in what was searched for. */
  initialDescription?: string;
  /** D269: the job is completed; what adding a line does. */
  afterComplete?: AfterComplete | null;
  onClose: () => void;
}) {
  const added = useAddedToast();
  const formId = useId();
  const [lineId] = useState(newId);
  const [description, setDescription] = useState(initialDescription);
  const [quantity, setQuantity] = useState("1");
  const [price, setPrice] = useState("");
  const [cost, setCost] = useState("");
  const [state, formAction, pending] = useActionState<State, FormData>(async (prev, formData) => {
    const result = await callAction(() => addManualLine(prev, formData), formData);
    if (result.ok) {
      added(`${description.trim() || "Line"} added`, result.data);
      onClose();
    }
    return result;
  }, null);
  const formRef = useFocusFirstInvalid(state);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  const preview = previewTotal(quantity, price, currency);

  return (
    <Sheet
      open
      onOpenChange={(next) => (next ? null : onClose())}
      dismissible={!pending}
      title="Add manual line"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} pending={pending} pendingLabel="Adding…">
            Add line
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
        <input type="hidden" name="lineId" value={lineId} />
        <input type="hidden" name="workOrderId" value={workOrderId} />
        <AfterCompleteNote mode={afterComplete} />
        {state && !state.ok ? (
          <p role="alert" className="text-sm font-medium text-danger-deep">
            {state.error}
          </p>
        ) : null}
        <Field label="Description" error={errors?.description?.[0]} required>
          <Input
            name="description"
            autoComplete="off"
            maxLength={300}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <Field label="Quantity" error={errors?.quantity?.[0]} required>
          <NumberInput
            kind="quantity"
            decimals={2}
            name="quantity"
            stepper
            minValue={1}
            maxValue={9999}
            value={quantity}
            onValueChange={setQuantity}
          />
        </Field>
        <Field label="Unit price" error={errors?.unitSalePrice?.[0]} required>
          <NumberInput kind="money" name="unitSalePrice" value={price} onValueChange={setPrice} />
        </Field>
        {viewCosts ? (
          <Field
            label="Unit cost"
            hint="Enter 0 when there is no direct cost. Left empty, the line is marked cost pending."
            error={errors?.unitDirectCost?.[0]}
          >
            <NumberInput kind="money" name="unitDirectCost" value={cost} onValueChange={setCost} />
          </Field>
        ) : (
          <p className="text-sm text-dust-700">
            The line is marked cost pending until someone with cost access adds its cost.
          </p>
        )}
        <p className="flex items-baseline justify-between rounded-xl bg-sunken px-4 py-3 tabular-nums">
          <span className="text-sm text-dust-700">Line total</span>
          <output className="text-lg font-bold">{preview ?? "—"}</output>
        </p>
      </form>
    </Sheet>
  );
}
