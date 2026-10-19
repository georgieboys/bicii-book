"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition } from "react";

import { recordSaleAction, searchSaleableAction } from "@/app/(staff)/sales/actions";
import { Badge } from "@/components/ui/badge";
import { Button, type ButtonSize, type ButtonVariant } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { IconButton } from "@/components/ui/icon-button";
import { CloseIcon, PlusIcon } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { SearchPicker, type PickerOption } from "@/components/ui/search-picker";
import { Sheet } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { useFocusFirstInvalid } from "@/components/ui/use-focus-invalid";
import type { ActionResult } from "@/lib/actions";
import { fromShopLocal, toShopLocal } from "@/lib/dates";
import type { SaleableRow, SaleLineInput } from "@/lib/domain/sales";
import { formatMoney, lineTotal, parseMoney, sumMoney } from "@/lib/money";
import { priceWarnings, previewSale } from "@/lib/sales";
import { newId } from "@/lib/uuid";
import { callAction } from "@/lib/call-action";

import { CustomerPicker } from "./customer-picker";
import { ShortId } from "./short-id";
import { StockBadge } from "./stock-badge";

/**
 * What a "Sell" entry point starts the sheet with: the sheet searches
 * `q` (a U-, P- or C- number) and adds the first row that matches.
 */
export type SalePreset = {
  q: string;
  unitId?: string;
  productId?: string;
  locationId?: string;
  consignmentItemId?: string;
};

type SalePick = PickerOption & { row: SaleableRow };

type Line = {
  row: SaleableRow;
  /** What staff typed; prefilled with the database selling price. */
  price: string;
  quantity: string;
};

/** "U-000123", or the product's P- number. */
const shortIdOf = (row: SaleableRow) => row.unitShortId ?? row.productShortId;

/** "3 in stock at Shop floor", or "At Shop floor" for a unit. */
const stockText = (row: SaleableRow) =>
  row.kind === "unit" ? `At ${row.locationName}` : `${row.onHand} in stock at ${row.locationName}`;

const consignedText = (row: SaleableRow) =>
  row.consignment ? `Consigned · ${row.consignment.consignorName || "a consignor"}` : null;

const matches = (row: SaleableRow, p: SalePreset) =>
  (p.unitId === undefined || row.unitId === p.unitId) &&
  (p.productId === undefined || row.productId === p.productId) &&
  (p.locationId === undefined || row.locationId === p.locationId) &&
  (p.consignmentItemId === undefined || row.consignment?.itemId === p.consignmentItemId);

/** The price field's text for a row: its selling price, or empty when none is set. */
const prefill = (row: SaleableRow) => (row.unitPrice !== null ? row.unitPrice : "");

/**
 * "New sale" / "Sell": opens RecordSaleSheet, optionally preset with one
 * item (the consignment item page, the unit page, the product page).
 */
export function RecordSaleButton({
  viewCosts,
  preset,
  label = "New sale",
  variant = "solid",
  size = "md",
}: {
  viewCosts: boolean;
  preset?: SalePreset;
  label?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant={variant}
        size={size}
        icon={preset ? undefined : <PlusIcon className="size-4" />}
        onClick={() => setOpen(true)}
      >
        {label}
      </Button>
      {open ? (
        <RecordSaleSheet viewCosts={viewCosts} preset={preset} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}

/**
 * The searchable picker over saleable_stock (any staff): U-, P- and C-
 * numbers, SKU, serial and name. Each result shows its short ID, where it
 * is and how many, its price and, for consigned stock, its consignor (a
 * consigned quantity row is one consignment, D45). Choosing a result hands
 * it to `onPick` and empties the field for the next item.
 */
export function SaleablePicker({
  onPick,
  onRate,
  taken,
}: {
  onPick: (row: SaleableRow) => void;
  /** The Cult Commons rate the search returned (view_costs only). */
  onRate?: (rate: string | null) => void;
  /** Rows already on the sale (a unit can be on it once). */
  taken: ReadonlySet<string>;
}) {
  const search = async (q: string): Promise<SalePick[]> => {
    const result = await callAction(() => searchSaleableAction({ q }));
    if (!result.ok) throw new Error(result.error);
    onRate?.(result.data.rate);
    return result.data.rows.map((row) => ({
      id: row.key,
      label: row.title,
      description: [shortIdOf(row), stockText(row), consignedText(row)].filter(Boolean).join(" · "),
      meta: row.unitPrice !== null ? formatMoney(row.unitPrice) : "No price",
      disabled: row.kind === "unit" && taken.has(row.key),
      row,
    }));
  };
  return (
    <SearchPicker<SalePick>
      search={search}
      value={null}
      onSelect={(option) => {
        if (option) onPick(option.row);
      }}
      placeholder="Name, SKU, U-, P- or C- number"
      emptyMessage="Nothing in stock matches. Sold, archived, inactive and customer-owned items are not offered."
      renderOption={(o) => (
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex items-center justify-between gap-2">
            <span className="font-medium break-words">{o.label}</span>
            <span className="shrink-0 text-sm tabular-nums">{o.meta}</span>
          </span>
          <span className="flex flex-wrap items-center gap-2 text-sm text-dust-500">
            <ShortId value={shortIdOf(o.row)} />
            <StockBadge onHand={o.row.onHand} label={stockText(o.row)} />
            {o.row.consignment ? <Badge tone="info">{consignedText(o.row)}</Badge> : null}
            {o.disabled ? <span>Already on the sale</span> : null}
          </span>
        </span>
      )}
    />
  );
}

/**
 * Record an in-store sale (SPEC §13, §22; D1, D14, D24, D45, D48, D53;
 * record_retail_sale). Lines from SaleablePicker: each with its title and
 * short ID, where it is and how many ("3 in stock"), "Consigned ·
 * <consignor>" for consigned stock, a price prefilled with the database
 * selling price (any staff may change it, D53: "Below the asking price"
 * for everyone and, for view_costs holders, "Below cost: this sale loses
 * money"; it never blocks), a quantity capped at what the row holds, and
 * remove. Optional customer; "Sold earlier?" sets when it was sold (NULL,
 * so now, while closed). The footer shows the running total and, for
 * view_costs holders, a labelled preview of cost, yield and Cult Commons
 * per line and in total (display only: the database snapshots the real
 * figures). The commit names the total. The sale id is made when the sheet
 * opens and every value is held in state, so a retry records once; on an
 * error the lines stay, and a unit sold meanwhile is marked.
 */
function RecordSaleSheet({
  viewCosts,
  preset,
  onClose,
}: {
  viewCosts: boolean;
  preset?: SalePreset;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const router = useRouter();
  const formId = useId();
  const [saleId] = useState(newId);
  const [now] = useState(() => new Date());
  const [lines, setLines] = useState<Line[]>([]);
  const [rate, setRate] = useState<string | null>(null);
  const [customer, setCustomer] = useState<PickerOption | null>(null);
  const [earlier, setEarlier] = useState(false);
  const [soldAt, setSoldAt] = useState("");
  const [notes, setNotes] = useState("");
  const [adding, setAdding] = useState(false);
  const [presetState, setPresetState] = useState<"idle" | "loading" | "missing">(
    preset ? "loading" : "idle",
  );
  const [state, setState] = useState<ActionResult<{ saleId: string; saleNumber: string }> | null>(
    null,
  );
  const [pending, start] = useTransition();
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  // A refusal shows where it applies: the first marked field gets focus,
  // else the alert scrolls into view (the sheet may be scrolled down to
  // the footer button on a phone).
  const formRef = useFocusFirstInvalid(state);
  const alertRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (!state || state.ok) return;
    if (formRef.current?.querySelector('[aria-invalid="true"]')) return;
    alertRef.current?.scrollIntoView({ block: "nearest" });
    alertRef.current?.focus();
  }, [state, formRef]);

  // A "Sell" entry point: find its item once, when the sheet opens.
  useEffect(() => {
    if (!preset) return;
    let live = true;
    searchSaleableAction({ q: preset.q })
      .then((result) => {
        if (!live) return;
        const row = result.ok ? result.data.rows.find((r) => matches(r, preset)) : undefined;
        if (result.ok) setRate(result.data.rate);
        if (row) {
          setLines([{ row, price: prefill(row), quantity: "1" }]);
          setPresetState("idle");
        } else {
          setPresetState("missing");
        }
      })
      // A dropped connection or a server failure: fall back to the picker
      // instead of "Finding the item…" for good.
      .catch(() => {
        if (live) setPresetState("missing");
      });
    return () => {
      live = false;
    };
    // The preset is fixed for the sheet's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const taken = new Set(lines.map((l) => l.row.key));
  const add = (row: SaleableRow) => {
    setState(null);
    setAdding(false);
    setLines((all) => {
      const existing = all.find((l) => l.row.key === row.key);
      if (existing) {
        // The same stock twice: one line with one more (never past what it holds).
        if (row.kind === "unit") return all;
        return all.map((l) =>
          l.row.key === row.key
            ? { ...l, quantity: String(Math.min((Number(l.quantity) || 0) + 1, row.onHand)) }
            : l,
        );
      }
      return [...all, { row, price: prefill(row), quantity: "1" }];
    });
  };
  const update = (key: string, patch: Partial<Line>) =>
    setLines((all) => all.map((l) => (l.row.key === key ? { ...l, ...patch } : l)));
  const remove = (key: string) => setLines((all) => all.filter((l) => l.row.key !== key));

  const qtyOf = (l: Line) => {
    if (l.row.kind === "unit") return 1;
    const n = Number.parseInt(l.quantity, 10);
    return Number.isFinite(n) && n >= 1 ? n : null;
  };
  const priceOf = (l: Line) => (l.price.trim() === "" ? null : parseMoney(l.price));
  const priced = lines.map((l) => ({ line: l, qty: qtyOf(l), price: priceOf(l) }));
  const complete = priced.every((p) => p.qty !== null && p.price !== null);
  const overStock = priced.some(
    (p) => p.line.row.kind === "product" && p.qty !== null && p.qty > p.line.row.onHand,
  );
  const total = complete ? sumMoney(priced.map((p) => lineTotal(p.qty!, p.price!))) : null;
  const recognizedAt = earlier && soldAt ? (fromShopLocal(soldAt)?.toISOString() ?? null) : null;
  const badDate = earlier && soldAt !== "" && recognizedAt === null;
  // Set at submit (the clock moves while the sheet is open): a time after
  // now is refused here with the same words, before the server does.
  const [futureDate, setFutureDate] = useState(false);
  const dateError =
    badDate || futureDate
      ? "Enter a date and time that is not in the future."
      : errors?.recognizedAt?.[0];
  // Refusals the sheet has no field for (the lines as a whole), under the alert.
  const otherErrors = Object.entries(errors ?? {})
    .filter(([k]) => !["recognizedAt", "customerId", "notes"].includes(k) && !k.startsWith("line:"))
    .flatMap(([, v]) => v);

  const preview =
    viewCosts && rate !== null && complete && lines.every((l) => l.row.cost != null)
      ? previewSale(
          priced.map((p) => ({
            quantity: p.qty!,
            unitSalePrice: p.price!,
            unitDirectCost: p.line.row.cost!,
            rate,
          })),
        )
      : null;

  const submit = (submittedAt: number) => {
    if (!complete || lines.length === 0 || overStock || badDate) return;
    if (recognizedAt !== null && Date.parse(recognizedAt) > submittedAt) {
      setFutureDate(true);
      return;
    }
    const input: {
      saleId: string;
      lines: SaleLineInput[];
      customerId: string | null;
      recognizedAt: string | null;
      notes: string | null;
    } = {
      saleId,
      lines: priced.map(({ line, qty, price }) =>
        line.row.kind === "unit"
          ? {
              kind: "unit" as const,
              key: line.row.key,
              unitId: line.row.unitId!,
              unitSalePrice: price!.toFixed(2),
            }
          : {
              kind: "product" as const,
              key: line.row.key,
              productId: line.row.productId,
              locationId: line.row.locationId,
              quantity: qty!,
              consignmentItemId: line.row.consignment?.itemId ?? null,
              unitSalePrice: price!.toFixed(2),
            },
      ),
      customerId: customer?.id ?? null,
      recognizedAt,
      notes: notes.trim() || null,
    };
    start(async () => {
      const result = await callAction(() => recordSaleAction(input));
      setState(result);
      if (result.ok) {
        toast({ title: `${result.data.saleNumber} recorded`, tone: "success" });
        router.push(`/sales/${result.data.saleId}`);
        onClose();
      }
    });
  };

  const commitLabel = total ? `Record sale · ${formatMoney(total)}` : "Record sale";
  const showPicker = adding || (lines.length === 0 && presetState !== "loading");

  return (
    <Sheet
      open
      onOpenChange={(next) => (next ? null : onClose())}
      dismissible={!pending}
      title="New sale"
      description="An in-store sale. The stock goes down when you record it."
      footer={
        <div className="flex w-full flex-col gap-3">
          <p className="flex items-baseline justify-between tabular-nums">
            <span className="text-sm text-dust-700">Total</span>
            <output aria-label="Sale total" className="text-lg font-bold">
              {total ? formatMoney(total) : "—"}
            </output>
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button
              type="submit"
              form={formId}
              pending={pending}
              pendingLabel="Recording…"
              disabled={lines.length === 0 || !complete || overStock || badDate}
            >
              {commitLabel}
            </Button>
          </div>
        </div>
      }
    >
      <form
        ref={formRef}
        id={formId}
        className="flex flex-col gap-5"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          // The event's own clock (epoch ms), read when the form is submitted.
          submit(performance.timeOrigin + e.timeStamp);
        }}
      >
        {state && !state.ok ? (
          <div className="flex flex-col gap-1">
            <p
              ref={alertRef}
              tabIndex={-1}
              role="alert"
              className="text-sm font-medium text-danger-deep outline-none"
            >
              {state.error}
            </p>
            {otherErrors.map((e) => (
              <p key={e} className="text-sm text-danger-deep">
                {e}
              </p>
            ))}
          </div>
        ) : null}
        {presetState === "loading" ? (
          <p role="status" className="text-sm text-dust-700">
            Finding the item…
          </p>
        ) : presetState === "missing" ? (
          <p role="status" className="rounded-xl bg-waiting-soft p-3 text-sm text-waiting-deep">
            That item is no longer available to sell. Search for another below.
          </p>
        ) : null}

        {lines.length > 0 ? (
          <ul aria-label="Items on this sale" className="flex flex-col gap-3">
            {priced.map(({ line, qty, price }, index) => {
              const row = line.row;
              const stale = errors?.[`line:${row.key}`]?.[0];
              const warnings =
                price !== null
                  ? priceWarnings({
                      price,
                      referencePrice: row.unitPrice,
                      cost: viewCosts ? (row.cost ?? null) : undefined,
                    })
                  : [];
              const lineTotalText =
                qty !== null && price !== null ? formatMoney(lineTotal(qty, price)) : "—";
              const economics = preview ? preview.lines[index] : null;
              return (
                <li
                  key={row.key}
                  aria-label={row.title}
                  className={
                    stale
                      ? "flex flex-col gap-3 rounded-xl border-2 border-danger bg-danger-soft p-3"
                      : "flex flex-col gap-3 rounded-xl bg-sunken p-3"
                  }
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 flex-col gap-1">
                      <span className="font-medium break-words">{row.title}</span>
                      <span className="flex flex-wrap items-center gap-2 text-sm text-dust-700">
                        <ShortId value={shortIdOf(row)} />
                        <span>{stockText(row)}</span>
                        {row.consignment ? <Badge tone="info">{consignedText(row)}</Badge> : null}
                      </span>
                    </div>
                    <IconButton
                      aria-label={`Remove ${row.title}`}
                      icon={<CloseIcon />}
                      onClick={() => remove(row.key)}
                      disabled={pending}
                    />
                  </div>
                  {stale ? <p className="text-sm font-medium text-danger-deep">{stale}</p> : null}
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field
                      label={row.kind === "unit" ? "Price" : "Price each"}
                      required
                      hint={
                        row.unitPrice !== null
                          ? `Selling price ${formatMoney(row.unitPrice)}`
                          : "No selling price set: enter what to charge."
                      }
                      error={
                        line.price.trim() !== "" && price === null
                          ? "Enter an amount of 0 or more, like 12.50."
                          : undefined
                      }
                    >
                      <NumberInput
                        kind="money"
                        value={line.price}
                        onValueChange={(v) => update(row.key, { price: v })}
                      />
                    </Field>
                    {row.kind === "product" ? (
                      <Field
                        label="Quantity"
                        required
                        error={
                          qty !== null && qty > row.onHand
                            ? `Only ${row.onHand} at ${row.locationName}.`
                            : undefined
                        }
                      >
                        <NumberInput
                          kind="quantity"
                          stepper
                          minValue={1}
                          maxValue={row.onHand}
                          value={line.quantity}
                          onValueChange={(v) => update(row.key, { quantity: v })}
                        />
                      </Field>
                    ) : null}
                  </div>
                  {warnings.length > 0 ? (
                    <ul role="status" className="flex flex-col gap-1">
                      {warnings.map((w) => (
                        <li
                          key={w}
                          className="rounded-lg bg-waiting-soft px-3 py-2 text-sm font-medium text-waiting-deep"
                        >
                          {w}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <p className="flex items-baseline justify-between text-sm tabular-nums">
                    <span className="text-dust-700">Line total</span>
                    <span className="font-semibold">{lineTotalText}</span>
                  </p>
                  {economics ? (
                    <p className="text-sm text-dust-700 tabular-nums">
                      Preview: cost {formatMoney(economics.cost)} · yield{" "}
                      {formatMoney(economics.yield)} · Cult Commons {formatMoney(economics.ccShare)}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}

        {preview ? (
          <section
            aria-label="Preview"
            className="rounded-xl bg-sunken px-4 py-3 text-sm tabular-nums"
          >
            <h3 className="font-display text-xs font-bold tracking-wide uppercase">
              Preview (staff with cost access only)
            </h3>
            <dl className="mt-1 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
              <dt className="text-dust-700">Cost</dt>
              <dd className="text-right">{formatMoney(preview.total.cost)}</dd>
              <dt className="text-dust-700">Yield</dt>
              <dd className="text-right">{formatMoney(preview.total.yield)}</dd>
              <dt className="text-dust-700">Cult Commons</dt>
              <dd className="text-right">{formatMoney(preview.total.ccShare)}</dd>
            </dl>
          </section>
        ) : null}

        {showPicker ? (
          <Field label="Add item">
            <SaleablePicker onPick={add} onRate={setRate} taken={taken} />
          </Field>
        ) : lines.length > 0 ? (
          <div>
            <Button
              variant="outline"
              size="sm"
              icon={<PlusIcon className="size-4" />}
              onClick={() => setAdding(true)}
            >
              Add item
            </Button>
          </div>
        ) : null}

        <Field
          label="Customer"
          hint="Optional. Leave empty for a walk-in."
          error={errors?.customerId?.[0]}
        >
          <CustomerPicker value={customer} onSelect={setCustomer} allowCreate />
        </Field>

        {earlier ? (
          <Field
            label="Sold at"
            hint="Shop time. Leave empty to record it as now."
            error={dateError}
          >
            <Input
              type="datetime-local"
              max={toShopLocal(now)}
              value={soldAt}
              onChange={(e) => {
                setSoldAt(e.target.value);
                setFutureDate(false);
              }}
            />
          </Field>
        ) : (
          <div>
            <Button variant="ghost" size="sm" onClick={() => setEarlier(true)}>
              Sold earlier?
            </Button>
          </div>
        )}

        <Field label="Notes" hint="Optional. Kept with the sale." error={errors?.notes?.[0]}>
          <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </form>
    </Sheet>
  );
}
