"use client";

import { useActionState, useId, useState } from "react";

import { addPartToJob } from "@/app/(staff)/jobs/actions";
import { searchParts } from "@/app/(staff)/inventory/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Field } from "@/components/ui/field";
import { BoxIcon, PlusIcon } from "@/components/ui/icons";
import { NumberInput } from "@/components/ui/number-input";
import { SearchPicker, type PickerOption } from "@/components/ui/search-picker";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Sheet } from "@/components/ui/sheet";
import { useToast } from "@/components/ui/toast";
import { useFocusFirstInvalid } from "@/components/ui/use-focus-invalid";
import type { ActionResult } from "@/lib/actions";
import type { PartOption } from "@/lib/domain/inventory";
import { overdrawWarning, signedQuantity } from "@/lib/inventory";
import { formatMoney, lineTotal, parseMoney, toDecimal } from "@/lib/money";
import { newId } from "@/lib/uuid";
import { callAction } from "@/lib/call-action";

import { NoActiveLocation } from "./no-active-location";
import { ShortId } from "./short-id";
import { StockBadge } from "./stock-badge";

type Result = {
  lineId: string;
  onHandAfter: number | null;
  locationName: string | null;
  replayed: boolean;
};
type State = ActionResult<Result> | null;
type PartPick = PickerOption & { part: PartOption };

/** "12 at Shop floor · 20 total" (a unit: "At Shop floor"). */
function stockSummary(part: PartOption, locationId: string | null): string {
  if (part.kind === "unit") return `At ${part.byLocation[0]?.name ?? "its location"}`;
  const at = part.byLocation.find((l) => l.locationId === locationId);
  const here = at ? `${signedQuantity(at.onHand).replace(/^\+/, "")} at ${at.name}` : null;
  const total = `${signedQuantity(part.onHandTotal).replace(/^\+/, "")} total`;
  return here ? `${here} · ${total}` : total;
}

/** "Consigned · Kelvin Yeo" (and the C- number for counted stock, D44). */
function consignedLabel(part: PartOption): string {
  if (!part.consigned) return "";
  const who = part.consigned.consignorName || "a consignor";
  return part.kind === "product"
    ? `Consigned · ${who} · ${part.consigned.itemShortId}`
    : `Consigned · ${who}`;
}

/** "−1" for a negative count, "37" otherwise. */
const plain = (n: number) => signedQuantity(n).replace(/^\+/, "");

/**
 * "Add part" on an open job (D15; locked like Add service once completed).
 * Opens AddPartSheet.
 */
export function AddPartButton({
  workOrderId,
  viewCosts,
  disabled = false,
  hasActiveLocation,
}: {
  workOrderId: string;
  viewCosts: boolean;
  disabled?: boolean;
  /** listLocations found an active location (otherwise the sheet says to add one). */
  hasActiveLocation: boolean;
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
        Add part
      </Button>
      {open ? (
        <AddPartSheet
          workOrderId={workOrderId}
          viewCosts={viewCosts}
          hasActiveLocation={hasActiveLocation}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

/**
 * Add a part from stock to a job (SPEC §9, §12; D23, D24, D25, D27 as
 * changed by the owner, D44): consigned stock is offered, marked
 * "Consigned · <consignor>", and never goes below zero; customer-owned
 * stock never is. A
 * SearchPicker over saleable stock (each option with its P- or U- number,
 * SKU and a live StockBadge), then for a counted part a quantity and the
 * location it comes from (each segment shows its count; the default
 * location first), for a unit its own location and a quantity of 1. The
 * selling price is shown, with an optional "Price each" override for anyone
 * (D14). Cost and yield preview only for view_costs holders, for display:
 * the database snapshots the real figures. Taking more than a location
 * holds warns but never blocks (D23 NEG-CONSUMPTION). The sheet's line id
 * is the idempotency key, so a repeated submit adds one line.
 */
function AddPartSheet({
  workOrderId,
  viewCosts,
  hasActiveLocation,
  onClose,
}: {
  workOrderId: string;
  viewCosts: boolean;
  hasActiveLocation: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const formId = useId();
  const [lineId] = useState(newId);
  const [picked, setPicked] = useState<PartPick | null>(null);
  const [quantity, setQuantity] = useState("1");
  const [locationId, setLocationId] = useState<string | null>(null);
  const [price, setPrice] = useState("");
  const part = picked?.part ?? null;
  const [state, formAction, pending] = useActionState<State, FormData>(async (prev, formData) => {
    const result = await callAction(() => addPartToJob(prev, formData), formData);
    if (result.ok && part) {
      const { onHandAfter, locationName } = result.data;
      const what =
        part.kind === "unit"
          ? `Added ${part.title} (${part.shortId}).`
          : `Added ${formData.get("quantity")} × ${part.title}.`;
      const left =
        part.kind === "unit"
          ? "It is on hold for this job."
          : onHandAfter !== null && locationName
            ? `${plain(onHandAfter)} left at ${locationName}.`
            : "";
      toast({ title: `${what} ${left}`.trim(), tone: "success" });
      onClose();
    }
    return result;
  }, null);
  const formRef = useFocusFirstInvalid(state);
  const errors = state && !state.ok ? state.fieldErrors : undefined;

  const search = async (q: string): Promise<PartPick[]> => {
    const result = await callAction(() => searchParts({ q }));
    if (!result.ok) throw new Error(result.error);
    return result.data.map((p) => ({
      id: `${p.kind}:${p.unitId ?? p.productId}`,
      label: p.title,
      description: [
        p.shortId,
        p.sku,
        p.serialNumber ? `S/N ${p.serialNumber}` : null,
        p.consigned ? consignedLabel(p) : null,
      ]
        .filter(Boolean)
        .join(" · "),
      meta: p.salePrice !== null ? formatMoney(p.salePrice, p.currency) : "No price",
      part: p,
    }));
  };

  const qty = Number.parseInt(quantity, 10);
  const validQty = Number.isFinite(qty) && qty >= 1 ? qty : null;
  const chosenLocation = part?.byLocation.find((l) => l.locationId === locationId) ?? null;
  // D23 lets shop stock go below zero with a warning; consigned stock never
  // may (D44: on-hand equals what the consignors have left), so the
  // database refuses it and the sheet says so instead.
  const warning =
    part?.kind === "product" && validQty !== null && chosenLocation
      ? part.consigned
        ? validQty > chosenLocation.onHand
          ? `Only ${plain(Math.max(chosenLocation.onHand, 0))} of this consigned item at ${chosenLocation.name}. Consigned stock can't go below zero.`
          : null
        : overdrawWarning(validQty, chosenLocation.onHand, chosenLocation.name)
      : null;
  const effectivePrice = price.trim()
    ? parseMoney(price)
    : part?.salePrice
      ? toDecimal(part.salePrice)
      : null;
  const preview =
    part && validQty !== null && effectivePrice
      ? formatMoney(lineTotal(validQty, effectivePrice, part.currency), part.currency)
      : null;
  const costTotal =
    viewCosts && part?.cost && validQty !== null
      ? lineTotal(validQty, toDecimal(part.cost), part.currency)
      : null;
  const yieldTotal =
    costTotal && effectivePrice && validQty !== null
      ? lineTotal(validQty, effectivePrice, part!.currency).minus(costTotal)
      : null;

  return (
    <Sheet
      open
      onOpenChange={(next) => (next ? null : onClose())}
      dismissible={!pending}
      title="Add part"
      description="From stock. The count goes down when you add it; voiding the line puts it back."
      footer={
        hasActiveLocation ? (
          <>
            <Button variant="outline" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button
              type="submit"
              form={formId}
              pending={pending}
              pendingLabel="Adding…"
              disabled={!part}
            >
              Add part
            </Button>
          </>
        ) : undefined
      }
    >
      {hasActiveLocation ? (
        <form
          id={formId}
          ref={formRef}
          action={formAction}
          className="flex flex-col gap-5"
          noValidate
        >
          <input type="hidden" name="lineId" value={lineId} />
          <input type="hidden" name="workOrderId" value={workOrderId} />
          <input type="hidden" name="productId" value={part?.productId ?? ""} />
          <input type="hidden" name="unitId" value={part?.unitId ?? ""} />
          {state && !state.ok ? (
            <p role="alert" className="text-sm font-medium text-danger-deep">
              {state.error}
            </p>
          ) : null}
          <Field label="Part" error={errors?.productId?.[0]} required>
            <SearchPicker<PartPick>
              search={search}
              value={picked}
              onSelect={(option) => {
                setPicked(option);
                setQuantity("1");
                setPrice("");
                setLocationId(option?.part.defaultLocationId ?? null);
              }}
              placeholder="Name, SKU, P- or U- number"
              emptyMessage="No part in stock matches. Archived, inactive and customer-owned items are not offered."
              renderOption={(o) => (
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-medium break-words">{o.label}</span>
                    <span className="shrink-0 text-sm tabular-nums">{o.meta}</span>
                  </span>
                  <span className="flex flex-wrap items-center gap-2 text-sm text-dust-500">
                    <ShortId value={o.part.shortId} />
                    {o.part.sku ? <span>{o.part.sku}</span> : null}
                    {o.part.consigned ? <Badge tone="info">{consignedLabel(o.part)}</Badge> : null}
                    <StockBadge
                      onHand={o.part.kind === "unit" ? 1 : o.part.onHandAtDefault}
                      label={stockSummary(o.part, o.part.defaultLocationId)}
                    />
                  </span>
                </span>
              )}
            />
          </Field>

          {part ? (
            <>
              {part.consigned ? (
                <p className="rounded-xl bg-info-soft p-3 text-sm text-info-deep">
                  {consignedLabel(part)}
                  {part.kind === "product"
                    ? ` (${part.consigned.itemShortId}): taken from that consignment, at its asking price unless you change it.`
                    : "."}{" "}
                  The consignor is owed their agreed amount once the job is completed.
                </p>
              ) : null}
              <p className="flex flex-wrap items-center gap-2 text-sm text-dust-700">
                <ShortId value={part.shortId} />
                <StockBadge
                  onHand={part.kind === "unit" ? 1 : (chosenLocation?.onHand ?? 0)}
                  label={stockSummary(part, locationId)}
                />
              </p>
              {part.kind === "product" ? (
                <>
                  <Field label="Quantity" error={errors?.quantity?.[0]} required>
                    <NumberInput
                      kind="quantity"
                      name="quantity"
                      stepper
                      minValue={1}
                      maxValue={999}
                      value={quantity}
                      onValueChange={setQuantity}
                    />
                  </Field>
                  <div className="flex flex-col gap-2">
                    <span className="font-display text-xs font-bold tracking-wide uppercase">
                      Take from
                    </span>
                    <SegmentedControl
                      label="Take from"
                      name="locationId"
                      value={locationId ?? undefined}
                      onValueChange={setLocationId}
                      options={part.byLocation.map((l) => ({
                        value: l.locationId,
                        label: `${l.name} · ${plain(l.onHand)}`,
                      }))}
                    />
                    {errors?.locationId?.[0] ? (
                      <p className="text-sm text-danger-deep">{errors.locationId[0]}</p>
                    ) : null}
                  </div>
                  {warning ? (
                    <p
                      role="status"
                      className="rounded-xl bg-waiting-soft p-3 text-sm text-waiting-deep"
                    >
                      {warning}
                    </p>
                  ) : null}
                </>
              ) : (
                <>
                  <input type="hidden" name="quantity" value="1" />
                  <input type="hidden" name="locationId" value={part.defaultLocationId ?? ""} />
                  <p className="text-sm text-dust-700">
                    A unique item: quantity 1, from {part.byLocation[0]?.name ?? "its location"}. It
                    is held for this job and sold when the job is completed.
                  </p>
                </>
              )}
              <p className="flex items-baseline justify-between text-sm">
                <span className="text-dust-700">Selling price</span>
                <span className="font-semibold tabular-nums">
                  {part.salePrice !== null ? formatMoney(part.salePrice, part.currency) : "Not set"}
                </span>
              </p>
              <Field
                label="Price each"
                hint={
                  part.salePrice !== null
                    ? "Optional. Leave empty to charge the selling price."
                    : "This part has no selling price yet: enter what to charge."
                }
                error={errors?.unitSalePrice?.[0]}
                required={part.salePrice === null}
              >
                <NumberInput
                  kind="money"
                  name="unitSalePrice"
                  value={price}
                  onValueChange={setPrice}
                />
              </Field>
              {viewCosts ? (
                part.cost ? (
                  <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 rounded-xl bg-sunken px-4 py-3 text-sm tabular-nums">
                    <dt className="text-dust-700">Cost (staff with cost access only)</dt>
                    <dd>{costTotal ? formatMoney(costTotal, part.currency) : "—"}</dd>
                    <dt className="text-dust-700">Yield</dt>
                    <dd>{yieldTotal ? formatMoney(yieldTotal, part.currency) : "—"}</dd>
                  </dl>
                ) : (
                  <p className="rounded-xl bg-waiting-soft p-3 text-sm text-waiting-deep">
                    This part has no cost yet, so it can&apos;t be added. Set its cost on the
                    product first.
                  </p>
                )
              ) : null}
              <p className="flex items-baseline justify-between rounded-xl bg-sunken px-4 py-3 tabular-nums">
                <span className="text-sm text-dust-700">Line total</span>
                <output className="text-lg font-bold">{preview ?? "—"}</output>
              </p>
            </>
          ) : null}
        </form>
      ) : (
        <EmptyState
          icon={<BoxIcon />}
          title="Nothing to take stock from"
          description={<NoActiveLocation />}
        />
      )}
    </Sheet>
  );
}
