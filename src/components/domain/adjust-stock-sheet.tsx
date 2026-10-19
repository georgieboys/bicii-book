"use client";

import { useActionState, useId, useState } from "react";

import { adjustStock } from "@/app/(staff)/inventory/actions";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { EmptyState } from "@/components/ui/empty-state";
import { Field } from "@/components/ui/field";
import { BoxIcon } from "@/components/ui/icons";
import { NumberInput } from "@/components/ui/number-input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Sheet } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { useFocusFirstInvalid } from "@/components/ui/use-focus-invalid";
import type { ActionResult } from "@/lib/actions";
import { adjustmentPreview, signedQuantity } from "@/lib/inventory";
import { REASON_MAX_LENGTH } from "@/lib/reasons";
import { newId } from "@/lib/uuid";
import { callAction } from "@/lib/call-action";

import { NoActiveLocation } from "./no-active-location";

type State = ActionResult<{ movementId: number; onHand: number }> | null;

export type SheetLocation = { locationId: string; name: string; active: boolean; onHand: number };

const QUICK_REASONS = [
  "Stock count correction",
  "Found stock",
  "Damaged in workshop",
  "Opening stock count",
] as const;

const plain = (n: number) => signedQuantity(n).replace(/^\+/, "");

/** "Adjust stock" (adjust_stock permission): opens AdjustStockSheet. */
export function AdjustStockButton(props: {
  productId: string;
  productName: string;
  stock: SheetLocation[];
  defaultLocationId: string | null;
  viewCosts: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Adjust stock
      </Button>
      {open ? <AdjustStockSheet {...props} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/**
 * A manual stock change with a reason (SPEC §12, §23; adjust_stock): the
 * location (the default one first), Add or Remove and how many, the type
 * (Damaged only when removing), a required reason with quick-fill chips,
 * and a unit cost for stock added (view_costs only, optional). The preview
 * reads "Shop floor: 34 → 31"; a result below zero is refused before
 * submitting (insufficient_stock: only a part used on a job may go below
 * zero, D23). The request id made when the sheet opens makes a retry
 * record once.
 */
function AdjustStockSheet({
  productId,
  productName,
  stock,
  defaultLocationId,
  viewCosts,
  onClose,
}: {
  productId: string;
  productName: string;
  stock: SheetLocation[];
  defaultLocationId: string | null;
  viewCosts: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const formId = useId();
  const [requestId] = useState(newId);
  const active = stock.filter((l) => l.active);
  const [locationId, setLocationId] = useState(
    active.some((l) => l.locationId === defaultLocationId)
      ? (defaultLocationId as string)
      : (active[0]?.locationId ?? ""),
  );
  const [direction, setDirection] = useState<"add" | "remove">("add");
  const [type, setType] = useState<"stock_adjustment" | "damaged">("stock_adjustment");
  const [quantity, setQuantity] = useState("1");
  const [reason, setReason] = useState("");
  const [cost, setCost] = useState("");
  const location = active.find((l) => l.locationId === locationId) ?? null;
  const [state, formAction, pending] = useActionState<State, FormData>(async (prev, formData) => {
    const result = await callAction(() => adjustStock(prev, formData), formData);
    if (result.ok) {
      toast({
        title: `Stock saved. ${location?.name ?? "Location"}: ${plain(result.data.onHand)}`,
        tone: "success",
      });
      onClose();
    }
    return result;
  }, null);
  const formRef = useFocusFirstInvalid(state);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  const belowZeroId = useId();

  const qty = /^\d+$/.test(quantity.trim()) ? Number(quantity) : null;
  const preview =
    location && qty !== null && qty > 0
      ? adjustmentPreview(location.onHand, direction === "add" ? qty : -qty)
      : null;

  return (
    <Sheet
      open
      onOpenChange={(next) => (next ? null : onClose())}
      dismissible={!pending}
      title="Adjust stock"
      description={productName}
      footer={
        active.length > 0 ? (
          <>
            <Button variant="outline" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button
              type="submit"
              form={formId}
              pending={pending}
              pendingLabel="Saving…"
              disabled={preview?.wouldGoNegative === true}
            >
              Save adjustment
            </Button>
          </>
        ) : undefined
      }
    >
      {active.length === 0 ? (
        <EmptyState
          icon={<BoxIcon />}
          title="Nowhere to count stock"
          description={<NoActiveLocation />}
        />
      ) : (
        <form
          id={formId}
          ref={formRef}
          action={formAction}
          className="flex flex-col gap-5"
          noValidate
        >
          <input type="hidden" name="requestId" value={requestId} />
          <input type="hidden" name="productId" value={productId} />
          {state && !state.ok ? (
            <p role="alert" className="text-sm font-medium text-danger-deep">
              {state.error}
            </p>
          ) : null}
          <div className="flex flex-col gap-2">
            <span className="font-display text-xs font-bold tracking-wide uppercase">Location</span>
            <SegmentedControl
              label="Location"
              name="locationId"
              value={locationId}
              onValueChange={setLocationId}
              options={active.map((l) => ({
                value: l.locationId,
                label: `${l.name} · ${plain(l.onHand)}`,
              }))}
            />
          </div>
          <div className="flex flex-col gap-2">
            <span className="font-display text-xs font-bold tracking-wide uppercase">Change</span>
            <SegmentedControl
              label="Add or remove"
              name="direction"
              value={direction}
              onValueChange={(next) => {
                setDirection(next);
                if (next === "add") setType("stock_adjustment");
                else setCost("");
              }}
              options={[
                { value: "add", label: "Add" },
                { value: "remove", label: "Remove" },
              ]}
            />
          </div>
          <Field label="Quantity" error={errors?.quantity?.[0]} required>
            <NumberInput
              kind="quantity"
              name="quantity"
              stepper
              minValue={1}
              maxValue={100000}
              value={quantity}
              onValueChange={setQuantity}
              aria-invalid={preview?.wouldGoNegative === true || undefined}
              aria-describedby={preview?.wouldGoNegative ? belowZeroId : undefined}
            />
          </Field>
          {/* Right under Quantity: Save is disabled while the count would go
              below zero, so the reason sits next to its cause, in view. */}
          {preview && location ? (
            preview.wouldGoNegative ? (
              <p
                id={belowZeroId}
                role="alert"
                className="rounded-xl bg-danger-soft p-3 text-sm text-danger-deep"
              >
                {location.name} has {plain(location.onHand)}. A count can&apos;t go below zero by
                hand; check the number.
              </p>
            ) : (
              <p className="flex items-baseline justify-between rounded-xl bg-sunken px-4 py-3 tabular-nums">
                <span className="text-sm text-dust-700">After saving</span>
                <output className="text-lg font-bold">
                  {location.name}: {plain(location.onHand)} → {plain(preview.after)}
                </output>
              </p>
            )
          ) : null}
          <div className="flex flex-col gap-2">
            <span className="font-display text-xs font-bold tracking-wide uppercase">Type</span>
            <SegmentedControl
              label="Type"
              name="type"
              value={type}
              onValueChange={setType}
              options={[
                { value: "stock_adjustment", label: "Adjustment" },
                { value: "damaged", label: "Damaged", disabled: direction === "add" },
              ]}
            />
            <p className="text-sm text-dust-500">
              {direction === "add"
                ? "Damaged is for stock removed."
                : "Damaged records why it left."}
            </p>
            {errors?.type?.[0] ? (
              <p className="text-sm text-danger-deep">{errors.type[0]}</p>
            ) : null}
          </div>
          <Field
            label="Reason"
            hint="Kept in the stock history."
            error={errors?.reason?.[0]}
            required
          >
            <Textarea
              name="reason"
              rows={2}
              maxLength={REASON_MAX_LENGTH}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          <div role="group" aria-label="Quick reasons" className="flex flex-wrap gap-2">
            {QUICK_REASONS.map((r) => (
              <Chip key={r} pressed={reason === r} onClick={() => setReason(r)}>
                {r}
              </Chip>
            ))}
          </div>
          {viewCosts && direction === "add" ? (
            <Field
              label="Unit cost"
              hint="Staff with cost access only. Optional: the product's cost when empty."
              error={errors?.unitCost?.[0]}
            >
              <NumberInput kind="money" name="unitCost" value={cost} onValueChange={setCost} />
            </Field>
          ) : null}
        </form>
      )}
    </Sheet>
  );
}
