"use client";

import { useRouter } from "next/navigation";
import { useActionState, useId, useState } from "react";

import { splitToUnique } from "@/app/(staff)/inventory/actions";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Field } from "@/components/ui/field";
import { BoxIcon } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Sheet } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { useFocusFirstInvalid } from "@/components/ui/use-focus-invalid";
import type { ActionResult } from "@/lib/actions";
import { signedQuantity } from "@/lib/inventory";
import { newId } from "@/lib/uuid";
import { callAction } from "@/lib/call-action";

type Result = { productId: string; productShortId: string; unitId: string; unitShortId: string };
type State = ActionResult<Result> | null;

export type SplitLocation = { locationId: string; name: string; active: boolean; onHand: number };

const plain = (n: number) => signedQuantity(n).replace(/^\+/, "");

/**
 * "Split off as unique item" on a counted product, for staff with both
 * adjust_stock and manage_inventory (the RPC needs both, D28).
 */
export function SplitToUniqueButton(props: {
  sourceProductId: string;
  productName: string;
  defaultSalePrice: string | null;
  stock: SplitLocation[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Split off as unique item
      </Button>
      {open ? <SplitToUniqueSheet {...props} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/**
 * Takes one counted item out of stock as its own unique product and unit
 * (split_unit_from_stock, D28): a name (the product's to start with), the
 * location it comes from (only active locations holding stock, with their
 * counts), serial, the condition (shown publicly once published), its sale
 * price (the product's when empty) and a required reason. The new product
 * starts as a draft at the same location and carries the source's cost.
 * Both ids are made when the sheet opens, so a retry splits once. Success
 * opens the new unit.
 */
function SplitToUniqueSheet({
  sourceProductId,
  productName,
  defaultSalePrice,
  stock,
  onClose,
}: {
  sourceProductId: string;
  productName: string;
  defaultSalePrice: string | null;
  stock: SplitLocation[];
  onClose: () => void;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const formId = useId();
  const [newProductId] = useState(newId);
  const [unitId] = useState(newId);
  const holding = stock.filter((l) => l.active && l.onHand > 0);
  const [locationId, setLocationId] = useState(holding[0]?.locationId ?? "");
  const [name, setName] = useState(productName);
  const [serial, setSerial] = useState("");
  const [condition, setCondition] = useState("");
  const [price, setPrice] = useState(defaultSalePrice ?? "");
  const [reason, setReason] = useState("");
  const [state, formAction, pending] = useActionState<State, FormData>(async (prev, formData) => {
    const result = await callAction(() => splitToUnique(prev, formData), formData);
    if (result.ok) {
      toast({ title: `Split off as ${result.data.unitShortId}`, tone: "success" });
      router.push(`/units/${result.data.unitId}`);
    }
    return result;
  }, null);
  const formRef = useFocusFirstInvalid(state);
  const errors = state && !state.ok ? state.fieldErrors : undefined;

  return (
    <Sheet
      open
      onOpenChange={(next) => (next ? null : onClose())}
      dismissible={!pending}
      title="Split off as unique item"
      description={productName}
      footer={
        holding.length > 0 ? (
          <>
            <Button variant="outline" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" form={formId} pending={pending} pendingLabel="Splitting…">
              Split off
            </Button>
          </>
        ) : undefined
      }
    >
      {holding.length === 0 ? (
        <EmptyState
          icon={<BoxIcon />}
          title="Nothing to split"
          description="None of this is counted at an active location. Add stock first."
        />
      ) : (
        <form
          id={formId}
          ref={formRef}
          action={formAction}
          className="flex flex-col gap-5"
          noValidate
        >
          <input type="hidden" name="newProductId" value={newProductId} />
          <input type="hidden" name="unitId" value={unitId} />
          <input type="hidden" name="sourceProductId" value={sourceProductId} />
          {state && !state.ok ? (
            <p role="alert" className="text-sm font-medium text-danger-deep">
              {state.error}
            </p>
          ) : null}
          <p className="rounded-xl bg-sunken p-3 text-sm text-dust-700">
            One comes out of this product&apos;s count and becomes its own item with a U- number, as
            a draft at the same location, keeping this product&apos;s cost.
          </p>
          <Field label="Name" error={errors?.name?.[0]} required>
            <Input
              name="name"
              autoComplete="off"
              maxLength={200}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <div className="flex flex-col gap-2">
            <span className="font-display text-xs font-bold tracking-wide uppercase">
              Take from
            </span>
            <SegmentedControl
              label="Take from"
              name="locationId"
              value={locationId}
              onValueChange={setLocationId}
              options={holding.map((l) => ({
                value: l.locationId,
                label: `${l.name} · ${plain(l.onHand)}`,
              }))}
            />
            {errors?.locationId?.[0] ? (
              <p className="text-sm text-danger-deep">{errors.locationId[0]}</p>
            ) : null}
          </div>
          <Field label="Serial number" error={errors?.serialNumber?.[0]}>
            <Input
              name="serialNumber"
              autoComplete="off"
              autoCapitalize="characters"
              maxLength={100}
              value={serial}
              onChange={(e) => setSerial(e.target.value)}
            />
          </Field>
          <Field label="Condition (shown publicly when published)" error={errors?.condition?.[0]}>
            <Textarea
              name="condition"
              rows={2}
              maxLength={500}
              value={condition}
              onChange={(e) => setCondition(e.target.value)}
            />
          </Field>
          <Field
            label="Sale price"
            hint="What this one item sells for."
            error={errors?.salePrice?.[0]}
          >
            <NumberInput kind="money" name="salePrice" value={price} onValueChange={setPrice} />
          </Field>
          <Field
            label="Reason"
            hint="Kept in the stock history of both products."
            error={errors?.reason?.[0]}
            required
          >
            <Textarea
              name="reason"
              rows={2}
              maxLength={480}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
        </form>
      )}
    </Sheet>
  );
}
