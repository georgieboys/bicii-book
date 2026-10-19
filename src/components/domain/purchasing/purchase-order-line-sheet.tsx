"use client";

import { useActionState, useEffect, useId, useRef, useState, useTransition } from "react";

import {
  purchaseCostDefaults,
  removePurchaseOrderLine,
  setPurchaseOrderLine,
} from "@/app/(staff)/purchasing/actions";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { PlusIcon } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Sheet } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { useArmed } from "@/components/ui/use-armed";
import { useFocusFirstInvalid } from "@/components/ui/use-focus-invalid";
import type { ActionResult } from "@/lib/actions";
import { formatMoney, lineTotal, parseMoney } from "@/lib/money";
import {
  MAX_PURCHASE_QUANTITY,
  MAX_PURCHASE_UNIT_COST,
  costSourceHint,
  type PurchaseOrderStatus,
} from "@/lib/purchasing";
import { newId } from "@/lib/uuid";
import { callAction } from "@/lib/call-action";

import { ReasonConfirm } from "../reason-confirm";
import { ShortId } from "../short-id";
import { PurchaseProductPicker, type PurchaseProductOption } from "./purchase-product-picker";

/** A line as the sheet edits it (PurchaseOrderLine carries all of it). */
export type EditableLine = {
  id: string;
  product: { id: string; shortId: string; name: string; sku: string | null };
  ordered: number;
  received: number;
  expectedAt: string | null;
  notes: string | null;
  hasReceipts: boolean;
  /** manage_purchasing sees costs (D60), so an edited line always has one. */
  unitCost: string;
};

export type LineSheetOrder = {
  id: string;
  supplierId: string;
  status: PurchaseOrderStatus;
  currency: string;
  /** Products already on the order (not offered again, D62). */
  productIds: readonly string[];
};

type State = ActionResult<null> | null;

/** The smallest quantity a line may have: what has arrived, and at least 1. */
export function minimumQuantity(received: number): number {
  return Math.max(1, received);
}

/**
 * Add a line (`line` omitted) or change one, manage_purchasing on an open
 * order. Add: PurchaseProductPicker ("On hand 7 · On order 2 · P-000123"),
 * then the unit cost prefilled from purchase_cost_defaults with a hint
 * naming where it came from. Both: quantity with steppers (never below
 * what has been received, D65), unit cost 0..99,999.99 (0 is a known
 * cost, D24 as amended), the line's own expected date, notes, a live line
 * total, and once the order is submitted an optional reason kept in its
 * history. Edit adds "Remove line" (two steps; a reason unless it is a
 * draft; impossible once anything was received). The line id is the
 * idempotency key (newId() when the sheet opens to add).
 */
export function PurchaseOrderLineSheet({
  order,
  line,
  onClose,
}: {
  order: LineSheetOrder;
  line?: EditableLine;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const formId = useId();
  const [id] = useState(() => line?.id ?? newId());
  const [picked, setPicked] = useState<PurchaseProductOption | null>(null);
  const [quantity, setQuantity] = useState(line ? String(line.ordered) : "1");
  const [unitCost, setUnitCost] = useState(line?.unitCost ?? "");
  const [costHint, setCostHint] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [, startDefaults] = useTransition();
  const defaultsSeq = useRef(0);
  // A cost typed after picking wins over a prefill that arrives later.
  const costTouched = useRef(false);
  const product = line?.product ?? picked?.product ?? null;
  const draft = order.status === "draft";
  const minQty = minimumQuantity(line?.received ?? 0);

  const [state, formAction, pending] = useActionState<State, FormData>(async (prev, formData) => {
    const result = await callAction(() => setPurchaseOrderLine(prev, formData), formData);
    if (result.ok) {
      toast({
        title: line
          ? `${line.product.name} updated`
          : `Added ${formData.get("quantityOrdered")} × ${product?.name ?? "product"}`,
        tone: "success",
      });
      onClose();
    }
    return result;
  }, null);
  const formRef = useFocusFirstInvalid(state);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  const values = state && !state.ok ? state.values : undefined;

  const choose = (option: PurchaseProductOption | null) => {
    setPicked(option);
    setCostHint(null);
    if (!option) return;
    const seq = ++defaultsSeq.current;
    startDefaults(async () => {
      const result = await callAction(() =>
        purchaseCostDefaults({
          supplierId: order.supplierId,
          productIds: [option.id],
        }),
      );
      if (seq !== defaultsSeq.current) return;
      const found = result.ok ? result.data.find((d) => d.productId === option.id) : undefined;
      if (found) {
        if (!costTouched.current) setUnitCost(found.unitCost);
        setCostHint(costSourceHint(found.source));
      } else {
        setCostHint(costSourceHint(null));
      }
    });
  };

  const qty = /^\d+$/.test(quantity.trim()) ? Number(quantity) : null;
  const cost = unitCost.trim() ? parseMoney(unitCost, { currency: order.currency }) : null;
  const preview =
    qty !== null && qty >= 1 && cost !== null
      ? formatMoney(lineTotal(qty, cost, order.currency), order.currency)
      : null;

  return (
    <Sheet
      open
      onOpenChange={(next) => (next ? null : onClose())}
      dismissible={!pending}
      title={line ? "Change line" : "Add line"}
      description={
        line
          ? undefined
          : "One line per product. Unique items are registered one by one in Stock instead."
      }
      footer={
        removing ? undefined : (
          <>
            <Button variant="outline" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button
              type="submit"
              form={formId}
              pending={pending}
              pendingLabel="Saving…"
              disabled={!product}
            >
              {line ? "Save line" : "Add line"}
            </Button>
          </>
        )
      }
    >
      <form
        id={formId}
        ref={formRef}
        action={formAction}
        className="flex flex-col gap-5"
        noValidate
      >
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="purchaseOrderId" value={order.id} />
        <input type="hidden" name="productId" value={product?.id ?? ""} />
        {state && !state.ok ? (
          <p role="alert" className="text-sm font-medium text-danger-deep">
            {state.error}
          </p>
        ) : null}
        {line ? (
          <div className="flex flex-col gap-1">
            <span className="font-display text-xs font-bold tracking-wide uppercase">Product</span>
            <p className="font-medium">{line.product.name}</p>
            <p className="flex flex-wrap items-center gap-2 text-sm text-dust-500">
              <ShortId value={line.product.shortId} />
              {line.product.sku ? <span>{line.product.sku}</span> : null}
            </p>
          </div>
        ) : (
          <Field label="Product" error={errors?.productId?.[0]} required>
            <PurchaseProductPicker
              value={picked}
              onSelect={choose}
              required
              disabledIds={order.productIds}
            />
          </Field>
        )}
        {product ? (
          <>
            <Field
              label="Quantity"
              hint={
                line && line.received > 0
                  ? `${line.received} already received: the order can't be for fewer.`
                  : undefined
              }
              error={errors?.quantityOrdered?.[0]}
              required
            >
              <NumberInput
                kind="quantity"
                name="quantityOrdered"
                stepper
                minValue={minQty}
                maxValue={MAX_PURCHASE_QUANTITY}
                value={quantity}
                onValueChange={setQuantity}
              />
            </Field>
            <Field
              label="Unit cost"
              hint={
                costHint ??
                (line ? "What the supplier charges for one. 0 is fine for free goods." : undefined)
              }
              error={errors?.unitCost?.[0]}
              required
            >
              <NumberInput
                kind="money"
                name="unitCost"
                maxValue={Number(MAX_PURCHASE_UNIT_COST)}
                value={unitCost}
                onValueChange={(v) => {
                  costTouched.current = true;
                  setUnitCost(v);
                }}
              />
            </Field>
            <p className="flex items-baseline justify-between rounded-xl bg-sunken px-4 py-3 tabular-nums">
              <span className="text-sm text-dust-700">Line total</span>
              <output className="text-lg font-bold">{preview ?? "—"}</output>
            </p>
            <Field
              label="Expected date"
              hint="Only if this line arrives on another day than the order."
              error={errors?.expectedAt?.[0]}
            >
              <Input
                type="date"
                name="expectedAt"
                defaultValue={values?.expectedAt ?? line?.expectedAt ?? ""}
              />
            </Field>
            <Field label="Notes" error={errors?.notes?.[0]}>
              <Textarea
                name="notes"
                rows={2}
                maxLength={500}
                defaultValue={values?.notes ?? line?.notes ?? ""}
              />
            </Field>
            {!draft ? (
              <Field
                label="Reason for the change"
                hint="Optional. Kept in the order's history, e.g. “Supplier minimum is 24”."
                error={errors?.reason?.[0]}
              >
                <Textarea
                  name="reason"
                  rows={2}
                  maxLength={500}
                  defaultValue={values?.reason ?? ""}
                />
              </Field>
            ) : null}
          </>
        ) : null}
      </form>
      {line ? (
        <RemoveLine line={line} draft={draft} onRemoved={onClose} onConfirming={setRemoving} />
      ) : null}
    </Sheet>
  );
}

/**
 * Remove a line: two steps. On a draft the confirmation needs no reason
 * (its button disabled for 400 ms); once submitted a reason is required
 * (ReasonConfirm). Never once part of the line has arrived (D65): lower its
 * quantity instead.
 */
function RemoveLine({
  line,
  draft,
  onRemoved,
  onConfirming,
}: {
  line: EditableLine;
  draft: boolean;
  onRemoved: () => void;
  onConfirming: (confirming: boolean) => void;
}) {
  const { toast } = useToast();
  const [confirming, setConfirming] = useState(false);
  const [pending, start] = useTransition();
  const armed = useArmed(confirming);
  const startRef = useRef<HTMLButtonElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);

  useEffect(() => {
    onConfirming(confirming);
    const cancelled = wasConfirming.current && !confirming;
    wasConfirming.current = confirming;
    if (confirming) keepRef.current?.focus();
    else if (cancelled) startRef.current?.focus();
  }, [confirming, onConfirming]);

  if (line.hasReceipts) {
    return (
      <div className="mt-6 flex flex-col gap-2 border-t border-hairline pt-4">
        <Button variant="outline" disabled aria-describedby={`${line.id}-why`}>
          Remove line
        </Button>
        <p id={`${line.id}-why`} className="text-sm text-dust-700">
          Part of this line has been received, so it stays. Lower its quantity to what arrived
          instead.
        </p>
      </div>
    );
  }

  if (!draft) {
    return (
      <div className="mt-6 border-t border-hairline pt-4">
        <ReasonConfirm
          startLabel="Remove line…"
          question="Why is this line being removed?"
          confirmLabel="Remove line"
          pendingLabel="Removing…"
          dismissLabel="Keep line"
          failureTitle="Line not removed"
          successTitle={`${line.product.name} removed from the order`}
          onConfirmingChange={onConfirming}
          onConfirm={(reason) => removePurchaseOrderLine({ lineId: line.id, reason })}
          onDone={onRemoved}
        >
          The order was already sent to the supplier: tell them too.
        </ReasonConfirm>
      </div>
    );
  }

  const remove = () => {
    start(async () => {
      const result = await callAction(() => removePurchaseOrderLine({ lineId: line.id }));
      if (!result.ok) {
        toast({ title: "Line not removed", description: result.error, tone: "error" });
        return;
      }
      wasConfirming.current = false;
      setConfirming(false);
      toast({ title: `${line.product.name} removed from the order`, tone: "success" });
      onRemoved();
    });
  };

  return (
    <div className="mt-6 border-t border-hairline pt-4">
      {confirming ? (
        <div key="confirm" className="flex flex-col gap-3 rounded-xl bg-danger-soft p-4">
          <p className="text-sm font-medium text-danger-deep">
            Remove {line.product.name} from this draft?
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              key="keep"
              ref={keepRef}
              variant="outline"
              disabled={pending}
              onClick={() => setConfirming(false)}
            >
              Keep line
            </Button>
            <Button
              key="remove"
              variant="danger"
              disabled={!armed}
              pending={pending}
              pendingLabel="Removing…"
              onClick={remove}
            >
              Remove line
            </Button>
          </div>
        </div>
      ) : (
        <div key="start">
          <Button ref={startRef} variant="outline" onClick={() => setConfirming(true)}>
            Remove line…
          </Button>
        </div>
      )}
    </div>
  );
}

/** "Add line" on an open order (manage_purchasing). */
export function AddPurchaseOrderLineButton({ order }: { order: LineSheetOrder }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        icon={<PlusIcon className="size-4" />}
        onClick={() => setOpen(true)}
      >
        Add line
      </Button>
      {open ? <PurchaseOrderLineSheet order={order} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
