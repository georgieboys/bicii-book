"use client";

import { useActionState, useCallback, useId, useRef, useState } from "react";

import { addUnit, updateUnit, writeOffUnit } from "@/app/(staff)/inventory/actions";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { PlusIcon } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Sheet } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { useFocusFirstInvalid } from "@/components/ui/use-focus-invalid";
import type { ActionResult } from "@/lib/actions";
import { newId } from "@/lib/uuid";
import { callAction } from "@/lib/call-action";

import { UnitFields, type SheetLocationOption } from "./product-sheet";
import { ReasonConfirm } from "./reason-confirm";

/**
 * "Add unit" on a unique product (manage_inventory): AddUnitSheet with the
 * same unit fields as New product. The unit id made when the sheet opens is
 * create_unique_unit's idempotency key, so a retry registers one unit.
 */
export function AddUnitButton({
  productId,
  locations,
  defaultLocationId,
  viewCosts,
  disabled = false,
}: {
  productId: string;
  locations: SheetLocationOption[];
  defaultLocationId: string | null;
  viewCosts: boolean;
  disabled?: boolean;
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
        Add unit
      </Button>
      {open ? (
        <AddUnitSheet
          productId={productId}
          locations={locations}
          defaultLocationId={defaultLocationId}
          viewCosts={viewCosts}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

type AddState = ActionResult<{ id: string; shortId: string }> | null;

function AddUnitSheet({
  productId,
  locations,
  defaultLocationId,
  viewCosts,
  onClose,
}: {
  productId: string;
  locations: SheetLocationOption[];
  defaultLocationId: string | null;
  viewCosts: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const formId = useId();
  const [unitId] = useState(newId);
  const [state, formAction, pending] = useActionState<AddState, FormData>(
    async (prev, formData) => {
      const result = await callAction(() => addUnit(prev, formData), formData);
      if (result.ok) {
        toast({ title: `Added ${result.data.shortId || "the unit"}`, tone: "success" });
        onClose();
      }
      return result;
    },
    null,
  );
  const formRef = useFocusFirstInvalid(state);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  const values = state && !state.ok ? state.values : undefined;
  const hasActive = locations.some((l) => l.active);
  return (
    <Sheet
      open
      onOpenChange={(next) => (next ? null : onClose())}
      dismissible={!pending}
      title="Add unit"
      description="It gets its permanent U- number when you save."
      footer={
        hasActive ? (
          <>
            <Button variant="outline" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" form={formId} pending={pending} pendingLabel="Saving…">
              Add unit
            </Button>
          </>
        ) : undefined
      }
    >
      <form
        id={formId}
        ref={formRef}
        action={formAction}
        className="flex flex-col gap-5"
        noValidate
      >
        <input type="hidden" name="unitId" value={unitId} />
        <input type="hidden" name="productId" value={productId} />
        {state && !state.ok ? (
          <p role="alert" className="text-sm font-medium text-danger-deep">
            {state.error}
          </p>
        ) : null}
        <UnitFields
          locations={locations}
          defaultLocationId={defaultLocationId}
          viewCosts={viewCosts}
          errors={errors}
          values={values}
        />
      </form>
    </Sheet>
  );
}

export type UnitEditFields = {
  id: string;
  serialNumber: string | null;
  condition: string | null;
  ownSalePrice: string | null;
  /** view_costs holders only. */
  cost?: string | null;
  internalNotes: string | null;
  /**
   * A consigned unit (D45): its price and cost are the consignment's
   * asking price and agreed amount, changed with Edit terms on the item,
   * so the sheet keeps them as they are and does not offer them.
   */
  consigned?: boolean;
};

type EditState = ActionResult<null> | null;

/** "Edit details" on a unit (manage_inventory). */
export function EditUnitButton({ unit, viewCosts }: { unit: UnitEditFields; viewCosts: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Edit details
      </Button>
      {open ? (
        <EditUnitSheet unit={unit} viewCosts={viewCosts} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}

/**
 * A unit's serial, condition (public once its product is published), own
 * price, cost (view_costs only; empty keeps the current cost) and internal
 * notes. Its status, location and bike change only through stock actions.
 */
function EditUnitSheet({
  unit,
  viewCosts,
  onClose,
}: {
  unit: UnitEditFields;
  viewCosts: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const formId = useId();
  const [state, formAction, pending] = useActionState<EditState, FormData>(
    async (prev, formData) => {
      const result = await callAction(() => updateUnit(prev, formData), formData);
      if (result.ok) {
        toast({ title: "Unit saved", tone: "success" });
        onClose();
      }
      return result;
    },
    null,
  );
  const formRef = useFocusFirstInvalid(state);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  const values = state && !state.ok ? state.values : undefined;
  const value = (key: string, stored: string | null | undefined) => values?.[key] ?? stored ?? "";
  return (
    <Sheet
      open
      onOpenChange={(next) => (next ? null : onClose())}
      dismissible={!pending}
      title="Edit details"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} pending={pending} pendingLabel="Saving…">
            Save
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
        <input type="hidden" name="id" value={unit.id} />
        {state && !state.ok ? (
          <p role="alert" className="text-sm font-medium text-danger-deep">
            {state.error}
          </p>
        ) : null}
        <Field label="Serial number" error={errors?.serialNumber?.[0]}>
          <Input
            name="serialNumber"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            className="font-mono"
            defaultValue={value("serialNumber", unit.serialNumber)}
          />
        </Field>
        <Field label="Condition (shown publicly when published)" error={errors?.condition?.[0]}>
          <Textarea name="condition" rows={2} defaultValue={value("condition", unit.condition)} />
        </Field>
        {unit.consigned ? (
          <>
            <input type="hidden" name="unitSalePrice" value={unit.ownSalePrice ?? ""} />
            <p className="text-sm text-dust-700">
              Its price and cost are the consignment&apos;s asking price and amount owed: change
              them with Edit terms on the consignment item.
            </p>
          </>
        ) : (
          <Field
            label="Unit sale price"
            hint="Leave empty to sell at the product's price."
            error={errors?.unitSalePrice?.[0]}
          >
            <NumberInput
              kind="money"
              name="unitSalePrice"
              defaultValue={value("unitSalePrice", unit.ownSalePrice)}
            />
          </Field>
        )}
        {viewCosts && !unit.consigned ? (
          <Field
            label="Unit cost"
            hint="Staff with cost access only. Leave empty to keep the current cost."
            error={errors?.unitCost?.[0]}
          >
            <NumberInput kind="money" name="unitCost" defaultValue={value("unitCost", unit.cost)} />
          </Field>
        ) : null}
        <Field
          label="Internal notes"
          hint="Staff only. Never shown publicly."
          error={errors?.internalNotes?.[0]}
        >
          <Textarea
            name="internalNotes"
            rows={3}
            defaultValue={value("internalNotes", unit.internalNotes)}
          />
        </Field>
      </form>
    </Sheet>
  );
}

/**
 * "Write off…" (adjust_stock): a ReasonConfirm whose request id is made
 * when the confirmation opens, so a retry of that confirmation writes off
 * once (write_off_unit replays on it) and a later write-off is a new one.
 */
export function WriteOffUnitControl({ unitId, shortId }: { unitId: string; shortId: string }) {
  const requestId = useRef<string | null>(null);
  const onConfirmingChange = useCallback((confirming: boolean) => {
    if (confirming) requestId.current = newId();
  }, []);
  return (
    <ReasonConfirm
      startLabel="Write off…"
      startSize="sm"
      question={`Why is ${shortId} being written off?`}
      hint="Kept in the unit's history and the stock movements."
      confirmLabel="Write off"
      pendingLabel="Writing off…"
      failureTitle="Not written off"
      successTitle={`${shortId} written off`}
      onConfirmingChange={onConfirmingChange}
      onConfirm={(reason) =>
        writeOffUnit({ requestId: requestId.current ?? newId(), unitId, reason })
      }
    >
      The unit leaves stock with a damaged movement. Nothing is deleted.
    </ReasonConfirm>
  );
}
