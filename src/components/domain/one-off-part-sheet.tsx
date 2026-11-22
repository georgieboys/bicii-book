"use client";

import { useId, useState, useTransition } from "react";

import { searchConsignorsAction } from "@/app/(staff)/consignment/actions";
import { addOneOffPartToJob } from "@/app/(staff)/jobs/actions";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { SearchPicker, type PickerOption } from "@/components/ui/search-picker";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Sheet } from "@/components/ui/sheet";
import { useToast } from "@/components/ui/toast";
import type { ActionResult } from "@/lib/actions";
import { callAction } from "@/lib/call-action";
import { newId } from "@/lib/uuid";

/** What the job lets this staff member do with a one-off part (D264). */
export type OneOffOptions = {
  /** New product, Adjust stock and costs: the shop's own one-off. */
  canShop: boolean;
  /** Receive item: a consigned one-off. */
  canConsign: boolean;
  /** The consignor offered first (the one with the most items for sale). */
  defaultConsignor: { id: string; label: string } | null;
  locations: { id: string; name: string }[];
  defaultLocationId: string | null;
};

type Whose = "consigned" | "shop";

/**
 * D264: a part that isn't in the system yet, made and put on the job in one
 * step: the shop's (at its cost) or consigned (at what the consignor is
 * owed for each). It is taken into stock and used at once, so stock,
 * consignor money and revenue follow the usual rules.
 */
export function OneOffPartSheet({
  workOrderId,
  initialName,
  hasBuild,
  options,
  onClose,
}: {
  workOrderId: string;
  initialName: string;
  hasBuild: boolean;
  options: OneOffOptions;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const formId = useId();
  const [lineId] = useState(newId);
  const [name, setName] = useState(initialName);
  const [quantity, setQuantity] = useState("1");
  const [price, setPrice] = useState("");
  // Consigned first when there is someone to consign from, or when it is
  // the only mode this person may use.
  const [whose, setWhose] = useState<Whose>(
    options.canConsign && (options.defaultConsignor || !options.canShop) ? "consigned" : "shop",
  );
  const [consignor, setConsignor] = useState<PickerOption | null>(
    options.defaultConsignor
      ? { id: options.defaultConsignor.id, label: options.defaultConsignor.label }
      : null,
  );
  const [owed, setOwed] = useState("");
  const [cost, setCost] = useState("");
  const [locationId, setLocationId] = useState(
    options.defaultLocationId ?? options.locations[0]?.id ?? "",
  );
  const [extra, setExtra] = useState(false);
  const [state, setState] = useState<ActionResult<unknown> | null>(null);
  const [pending, start] = useTransition();
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  const choices = [
    ...(options.canConsign ? [{ value: "consigned" as const, label: "Consigned" }] : []),
    ...(options.canShop ? [{ value: "shop" as const, label: "The shop's" }] : []),
  ];

  const searchConsignors = async (q: string) => {
    const r = await callAction(() => searchConsignorsAction({ q }));
    if (!r.ok) throw new Error(r.error);
    return r.data;
  };

  const submit = () =>
    start(async () => {
      const result = await callAction(() =>
        addOneOffPartToJob({
          lineId,
          workOrderId,
          name,
          quantity,
          unitSalePrice: price,
          consigned: whose === "consigned",
          consignorId: whose === "consigned" ? (consignor?.id ?? "") : "",
          agreedAmountOwed: whose === "consigned" ? owed : "",
          unitCost: whose === "shop" ? cost : "",
          locationId,
          buildExtra: extra,
        }),
      );
      setState(result);
      if (!result.ok) return;
      toast({ title: `Added ${quantity} × ${name.trim()}.`, tone: "success" });
      onClose();
    });

  return (
    <Sheet
      open
      onOpenChange={(next) => (next ? null : onClose())}
      dismissible={!pending}
      title="New one-off item"
      description="A part that isn't in the system yet: it is added to stock and put on this job in one step."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={formId}
            pending={pending}
            pendingLabel="Adding…"
            disabled={choices.length === 0}
          >
            Add to job
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="flex flex-col gap-5"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {state && !state.ok ? (
          <p role="alert" className="text-sm font-medium text-danger-deep">
            {state.error}
          </p>
        ) : null}
        {choices.length === 0 ? (
          <p className="text-sm text-dust-700">
            Adding a new item needs inventory or consignment access. Ask an admin, or use Add manual
            line.
          </p>
        ) : null}
        <Field label="Name" error={errors?.name?.[0]} required>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={200}
            autoComplete="off"
          />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Quantity" error={errors?.quantity?.[0]} required>
            <NumberInput
              kind="quantity"
              stepper
              minValue={1}
              maxValue={999}
              value={quantity}
              onValueChange={setQuantity}
            />
          </Field>
          <Field label="Price each" error={errors?.unitSalePrice?.[0]} required>
            <NumberInput kind="money" value={price} onValueChange={setPrice} />
          </Field>
        </div>
        {choices.length > 1 ? (
          <div className="flex flex-col gap-2">
            <span className="font-display text-xs font-bold tracking-wide uppercase">
              Whose it is
            </span>
            <SegmentedControl
              label="Whose it is"
              value={whose}
              onValueChange={(v) => setWhose(v as Whose)}
              options={choices}
            />
          </div>
        ) : null}
        {whose === "consigned" ? (
          <>
            <Field label="Consigned from" error={errors?.consignorId?.[0]} required>
              <SearchPicker
                search={searchConsignors}
                value={consignor}
                onSelect={setConsignor}
                placeholder="Search consignors"
                emptyMessage="No consignor matches. Add them under Consignment first."
              />
            </Field>
            <Field
              label="Owed to them for each"
              hint="What they get when the job is completed. 0 is allowed."
              error={errors?.agreedAmountOwed?.[0]}
              required
            >
              <NumberInput kind="money" value={owed} onValueChange={setOwed} />
            </Field>
          </>
        ) : (
          <Field
            label="Cost each"
            hint="What each cost the shop. Enter 0 when nothing."
            error={errors?.unitCost?.[0]}
            required
          >
            <NumberInput kind="money" value={cost} onValueChange={setCost} />
          </Field>
        )}
        {options.locations.length > 1 ? (
          <div className="flex flex-col gap-2">
            <span className="font-display text-xs font-bold tracking-wide uppercase">Kept at</span>
            <SegmentedControl
              label="Kept at"
              value={locationId}
              onValueChange={setLocationId}
              options={options.locations.map((l) => ({ value: l.id, label: l.name }))}
            />
            {errors?.locationId?.[0] ? (
              <p className="text-sm text-danger-deep">{errors.locationId[0]}</p>
            ) : null}
          </div>
        ) : null}
        {hasBuild ? (
          <Checkbox
            checked={extra}
            onChange={(e) => setExtra(e.target.checked)}
            label="Charge on top of the build package"
            description="It keeps its own price and stays out of the parts budget."
          />
        ) : null}
      </form>
    </Sheet>
  );
}
