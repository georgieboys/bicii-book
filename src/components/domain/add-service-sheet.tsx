"use client";

import { useActionState, useId, useState } from "react";

import { addServiceLine, searchServiceOptions } from "@/app/(staff)/jobs/actions";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { PlusIcon } from "@/components/ui/icons";
import { NumberInput } from "@/components/ui/number-input";
import { SearchPicker, type PickerOption } from "@/components/ui/search-picker";
import { Sheet } from "@/components/ui/sheet";
import { useToast } from "@/components/ui/toast";
import { useFocusFirstInvalid } from "@/components/ui/use-focus-invalid";
import type { ActionResult } from "@/lib/actions";
import type { ServiceOption } from "@/lib/domain/services";
import { formatMoney, lineTotal, parseMoney } from "@/lib/money";
import { newId } from "@/lib/uuid";
import { callAction } from "@/lib/call-action";

type State = ActionResult<{ id: string }> | null;
type ServicePick = PickerOption & { service: ServiceOption };

/** A preview of quantity × price, or null while either is not a valid amount yet. */
export function previewTotal(quantity: string, price: string, currency: string): string | null {
  const q = parseMoney(quantity);
  const p = parseMoney(price);
  if (!q || !p || q.lte(0)) return null;
  return formatMoney(lineTotal(q, p, currency), currency);
}

/**
 * "Add service": find an active service (SearchPicker showing price and
 * category), a quantity with steppers, the price prefilled from the
 * service and editable by anyone (D14), and, only for view_costs holders,
 * the cost. The line total previews as it is typed; the database computes
 * the real one. The sheet's line id is the idempotency key, so a repeated
 * submit adds one line.
 */
export function AddServiceButton({
  workOrderId,
  viewCosts,
  currency,
  disabled = false,
}: {
  workOrderId: string;
  viewCosts: boolean;
  currency: string;
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
        Add service
      </Button>
      {open ? (
        <AddServiceSheet
          workOrderId={workOrderId}
          viewCosts={viewCosts}
          currency={currency}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function AddServiceSheet({
  workOrderId,
  viewCosts,
  currency,
  onClose,
}: {
  workOrderId: string;
  viewCosts: boolean;
  currency: string;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const formId = useId();
  const [lineId] = useState(newId);
  const [picked, setPicked] = useState<ServicePick | null>(null);
  const [quantity, setQuantity] = useState("1");
  const [price, setPrice] = useState("");
  const [cost, setCost] = useState("");
  const [state, formAction, pending] = useActionState<State, FormData>(async (prev, formData) => {
    const result = await callAction(() => addServiceLine(prev, formData), formData);
    if (result.ok) {
      toast({ title: `${picked?.service.name ?? "Service"} added`, tone: "success" });
      onClose();
    }
    return result;
  }, null);
  const formRef = useFocusFirstInvalid(state);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  const preview = previewTotal(quantity, price, currency);

  const search = async (q: string): Promise<ServicePick[]> => {
    const result = await callAction(() => searchServiceOptions({ q }));
    if (!result.ok) throw new Error(result.error);
    return result.data.map((s) => ({
      id: s.id,
      label: s.name,
      description: s.categoryName,
      meta: formatMoney(s.salePrice, s.currency),
      service: s,
    }));
  };

  return (
    <Sheet
      open
      onOpenChange={(next) => (next ? null : onClose())}
      dismissible={!pending}
      title="Add service"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} pending={pending} pendingLabel="Adding…">
            Add service
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
        {state && !state.ok ? (
          <p role="alert" className="text-sm font-medium text-danger-deep">
            {state.error}
          </p>
        ) : null}
        <Field label="Service" error={errors?.serviceId?.[0]} required>
          <SearchPicker<ServicePick>
            name="serviceId"
            search={search}
            value={picked}
            onSelect={(option) => {
              setPicked(option);
              if (option) {
                setPrice(option.service.salePrice);
                setCost(option.service.cost ?? "");
              }
            }}
            placeholder="Search services"
            emptyMessage="No active service matches."
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
        <Field
          label="Unit price"
          hint="The service's price; change it for this job if needed."
          error={errors?.unitSalePrice?.[0]}
          required
        >
          <NumberInput kind="money" name="unitSalePrice" value={price} onValueChange={setPrice} />
        </Field>
        {viewCosts ? (
          <Field
            label="Unit cost"
            hint="Staff with cost access only. The service's cost unless you change it."
            error={errors?.unitDirectCost?.[0]}
          >
            <NumberInput kind="money" name="unitDirectCost" value={cost} onValueChange={setCost} />
          </Field>
        ) : null}
        <p className="flex items-baseline justify-between rounded-xl bg-sunken px-4 py-3 tabular-nums">
          <span className="text-sm text-dust-700">Line total</span>
          <output className="text-lg font-bold">{preview ?? "—"}</output>
        </p>
      </form>
    </Sheet>
  );
}
