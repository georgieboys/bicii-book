"use client";

import { useRouter } from "next/navigation";
import { useActionState, useId, useState } from "react";

import { createPurchaseOrder, updatePurchaseOrder } from "@/app/(staff)/purchasing/actions";
import { Button, type ButtonSize, type ButtonVariant } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { PlusIcon } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import type { PickerOption } from "@/components/ui/search-picker";
import { Sheet } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { useFocusFirstInvalid } from "@/components/ui/use-focus-invalid";
import type { ActionResult } from "@/lib/actions";
import { newId } from "@/lib/uuid";
import { callAction } from "@/lib/call-action";

import { SupplierPicker } from "./supplier-picker";

/** The header fields an order's Edit details changes. */
export type PurchaseOrderFields = {
  id: string;
  supplier: { id: string; name: string };
  /** Draft only: the supplier is fixed once submitted. */
  supplierEditable: boolean;
  expectedAt: string | null;
  supplierReference: string | null;
  notes: string | null;
};

type State = ActionResult<unknown> | null;

/**
 * New order or Edit details, in a sheet mounted only while open. A new
 * order's id is made when the sheet opens (newId(), the idempotency key):
 * a repeated Create opens the same draft. The supplier is picked
 * (SupplierPicker) or PRESET with `supplier` (from a supplier's page, a
 * fully received order's "New order for …", step 4's receive page). Create
 * opens the draft. On edit, the supplier is fixed once the order is
 * submitted, and the sheet says why. The server sets the currency.
 */
export function PurchaseOrderSheet({
  open,
  onOpenChange,
  supplier,
  order,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** New order: preset (and fix) this supplier. */
  supplier?: { id: string; name: string };
  /** Edit this order's details; omit for a new order. */
  order?: PurchaseOrderFields;
}) {
  return open ? (
    <PurchaseOrderSheetBody onOpenChange={onOpenChange} supplier={supplier} order={order} />
  ) : null;
}

function PurchaseOrderSheetBody({
  onOpenChange,
  supplier,
  order,
}: {
  onOpenChange: (open: boolean) => void;
  supplier?: { id: string; name: string };
  order?: PurchaseOrderFields;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const formId = useId();
  const [id] = useState(() => order?.id ?? newId());
  const fixedSupplier = order
    ? order.supplierEditable
      ? null
      : order.supplier
    : (supplier ?? null);
  const [picked, setPicked] = useState<PickerOption | null>(() =>
    order ? { id: order.supplier.id, label: order.supplier.name } : null,
  );
  const [state, formAction, pending] = useActionState<State, FormData>(async (prev, formData) => {
    const result = order
      ? await callAction(
          () => updatePurchaseOrder(prev as ActionResult<null> | null, formData),
          formData,
        )
      : await callAction(
          () => createPurchaseOrder(prev as ActionResult<{ id: string }> | null, formData),
          formData,
        );
    if (result.ok) {
      if (order) {
        toast({ title: "Order details saved", tone: "success" });
        onOpenChange(false);
      } else {
        toast({ title: "Draft order created", tone: "success" });
        router.push(`/purchasing/orders/${id}`);
      }
    }
    return result;
  }, null);
  const formRef = useFocusFirstInvalid(state);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  const values = state && !state.ok ? state.values : undefined;
  const value = (key: "expectedAt" | "supplierReference" | "notes") =>
    values?.[key] ?? order?.[key] ?? "";

  return (
    <Sheet
      open
      onOpenChange={onOpenChange}
      dismissible={!pending}
      title={order ? "Edit order details" : "New order"}
      description={
        order ? undefined : "A draft: add lines, then submit it. It gets its PO- number now."
      }
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} pending={pending} pendingLabel="Saving…">
            {order ? "Save" : "Create order"}
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
        <input type="hidden" name={order ? "purchaseOrderId" : "id"} value={id} />
        {state && !state.ok ? (
          <p role="alert" className="text-sm font-medium text-danger-deep">
            {state.error}
          </p>
        ) : null}
        {fixedSupplier ? (
          <div className="flex flex-col gap-1.5">
            <span className="font-display text-xs font-bold tracking-wide uppercase">Supplier</span>
            <p className="font-medium">{fixedSupplier.name}</p>
            {order ? (
              <p className="text-sm text-dust-500">
                The supplier is fixed once the order is submitted. To order from another supplier,
                start a new order.
              </p>
            ) : null}
            <input type="hidden" name="supplierId" value={fixedSupplier.id} />
          </div>
        ) : (
          <Field label="Supplier" error={errors?.supplierId?.[0]} required>
            <SupplierPicker name="supplierId" value={picked} onSelect={setPicked} required />
          </Field>
        )}
        <Field
          label="Expected date"
          hint="When the delivery should arrive. Late orders are marked overdue."
          error={errors?.expectedAt?.[0]}
        >
          <Input type="date" name="expectedAt" defaultValue={value("expectedAt")} />
        </Field>
        <Field
          label="Supplier reference"
          hint="Their order or quote number, if they gave one."
          error={errors?.supplierReference?.[0]}
        >
          <Input
            name="supplierReference"
            autoComplete="off"
            spellCheck={false}
            defaultValue={value("supplierReference")}
          />
        </Field>
        <Field label="Notes" error={errors?.notes?.[0]}>
          <Textarea name="notes" rows={3} defaultValue={value("notes")} />
        </Field>
      </form>
    </Sheet>
  );
}

/** "New order": opens PurchaseOrderSheet, optionally preset to `supplier`. */
export function NewPurchaseOrderButton({
  supplier,
  label = "New order",
  variant = "solid",
  size = "md",
  disabled = false,
  wrap = false,
  className,
}: {
  supplier?: { id: string; name: string };
  label?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  /** A long label (a supplier's name) wraps instead of widening a phone page. */
  wrap?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant={variant}
        size={size}
        wrap={wrap}
        className={className}
        icon={<PlusIcon className={size === "sm" ? "size-4" : "size-5"} />}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        {label}
      </Button>
      <PurchaseOrderSheet open={open} onOpenChange={setOpen} supplier={supplier} />
    </>
  );
}

export function EditPurchaseOrderButton({ order }: { order: PurchaseOrderFields }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        Edit details
      </Button>
      <PurchaseOrderSheet open={open} onOpenChange={setOpen} order={order} />
    </>
  );
}
