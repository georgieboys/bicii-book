"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";

import {
  customerContactAction,
  receiveConsignmentItemAction,
  searchShopBikesAction,
} from "@/app/(staff)/consignment/actions";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { PlusIcon } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { SearchPicker, type PickerOption } from "@/components/ui/search-picker";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Select } from "@/components/ui/select";
import { Sheet } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { useFocusFirstInvalid } from "@/components/ui/use-focus-invalid";
import type { ActionResult } from "@/lib/actions";
import { paidAtFromDate } from "@/lib/consignment";
import { lineEconomics } from "@/lib/cult-commons";
import { shopToday } from "@/lib/dates";
import { formatMoney, parseMoney } from "@/lib/money";
import { newId } from "@/lib/uuid";
import { callAction } from "@/lib/call-action";

import { ConsignorPicker } from "./consignor-picker";
import { CustomerPicker } from "./customer-picker";

/** What the intake needs from the page (loaded on the server). */
export type IntakeContext = {
  /** Active locations in sort order. */
  locations: { id: string; name: string }[];
  defaultLocationId: string | null;
  /** Product categories (kind 'product'). */
  categories: { id: string; name: string }[];
  /** view_costs (D48): shows the yield preview. */
  canViewSaleCosts: boolean;
  /** The Cult Commons rate in force (fraction), view_costs only; null otherwise. */
  ccRate: string | null;
};

type BikePick = PickerOption & { brand: string | null; serialNumber: string | null; title: string };

type Result = { id: string; shortId: string };

/**
 * "Receive item" (manage_consignments): opens ConsignmentIntakeSheet.
 * `presetConsignor` fixes the consignor (the consignor page).
 */
export function ReceiveItemButton({
  context,
  presetConsignor,
  variant = "solid",
}: {
  context: IntakeContext;
  presetConsignor?: { id: string; label: string };
  variant?: "solid" | "outline";
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant={variant}
        icon={<PlusIcon className="size-5" />}
        onClick={() => setOpen(true)}
      >
        Receive item
      </Button>
      {open ? (
        <ConsignmentIntakeSheet
          context={context}
          presetConsignor={presetConsignor}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

/**
 * Take a consigned item in (SPEC §13; D44, D45, D51; create_consignment_item):
 *
 *   1. Who: the consignor (preset, or a ConsignorPicker whose "New
 *      consignor" row reveals name, phone, email and an optional customer
 *      link; created in the same commit with its own id).
 *   2. What: one item (a bike, frame, wheelset: its own U- number, serial
 *      and condition; it may link an existing shop bike record, D51) or
 *      several identical (a quantity), the name, brand, description,
 *      category, and where it is kept.
 *   3. Money: the amount owed to the consignor per item when it sells (0
 *      is allowed, D24) and the asking price (the public, label and sale
 *      price, D45); a yield preview for view_costs holders.
 *   4. Received date (today unless changed; sent as NULL then) and notes.
 *
 * Every id (item, product, unit, new consignor) is made when the sheet
 * opens and every value is held in state as it is set, so a retry sends
 * the identical request and the database replays it.
 */
function ConsignmentIntakeSheet({
  context,
  presetConsignor,
  onClose,
}: {
  context: IntakeContext;
  presetConsignor?: { id: string; label: string };
  onClose: () => void;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const formId = useId();
  const [ids] = useState(() => ({
    itemId: newId(),
    newProductId: newId(),
    newUnitId: newId(),
    newConsignorId: newId(),
  }));
  const [today] = useState(() => shopToday());

  const [consignor, setConsignor] = useState<PickerOption | null>(presetConsignor ?? null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newCustomer, setNewCustomer] = useState<PickerOption | null>(null);

  const [kind, setKind] = useState<"unique" | "quantity">("unique");
  const [bike, setBike] = useState<BikePick | null>(null);
  const [productName, setProductName] = useState("");
  const [brand, setBrand] = useState("");
  const [description, setDescription] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [serialNumber, setSerialNumber] = useState("");
  const [condition, setCondition] = useState("");
  const [quantity, setQuantity] = useState("2");
  const [locationId, setLocationId] = useState<string | null>(
    context.defaultLocationId ?? context.locations[0]?.id ?? null,
  );
  const [agreed, setAgreed] = useState("");
  const [asking, setAsking] = useState("");
  const [receivedDay, setReceivedDay] = useState(today);
  const [agreementNotes, setAgreementNotes] = useState("");
  const [internalNotes, setInternalNotes] = useState("");

  const [state, setState] = useState<ActionResult<Result> | null>(null);
  const [pending, start] = useTransition();
  const [, startPrefill] = useTransition();
  const formRef = useFocusFirstInvalid(state);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  const err = (key: string) => errors?.[key]?.[0];

  const chooseBike = (option: BikePick | null) => {
    setBike(option);
    if (!option) return;
    // Prefill from the bike record (D51); staff can change any of it.
    setProductName((v) => v || option.title);
    setBrand((v) => v || (option.brand ?? ""));
    setSerialNumber((v) => v || (option.serialNumber ?? ""));
  };

  const chooseNewCustomer = (option: PickerOption | null) => {
    setNewCustomer(option);
    if (!option) return;
    startPrefill(async () => {
      const result = await callAction(() => customerContactAction({ customerId: option.id }));
      if (!result.ok || !result.data) return;
      const c = result.data;
      setNewName((v) => v || c.name);
      setNewPhone((v) => v || (c.phone ?? ""));
      setNewEmail((v) => v || (c.email ?? ""));
    });
  };

  const searchBikes = async (q: string): Promise<BikePick[]> => {
    const result = await callAction(() => searchShopBikesAction({ q }));
    if (!result.ok) throw new Error(result.error);
    return result.data.map((b) => ({
      id: b.id,
      label: b.title,
      title: b.title,
      description: [b.shortId, b.detail].filter(Boolean).join(" · "),
      brand: b.brand,
      serialNumber: b.serialNumber,
    }));
  };

  const submit = () => {
    const unique = kind === "unique";
    const input = {
      itemId: ids.itemId,
      consignorId: creating ? null : (consignor?.id ?? null),
      newConsignor: creating
        ? {
            id: ids.newConsignorId,
            displayName: newName,
            phone: newPhone || null,
            email: newEmail || null,
            customerId: newCustomer?.id ?? null,
          }
        : null,
      locationId: locationId ?? "",
      agreedAmountOwed: agreed,
      askingPrice: asking || null,
      productName,
      brand: brand || null,
      description: description || null,
      categoryId: categoryId || null,
      trackingType: kind,
      quantity: unique ? "1" : quantity,
      serialNumber: unique ? serialNumber || null : null,
      condition: unique ? condition || null : null,
      receivedAt: receivedDay ? paidAtFromDate(receivedDay, today) : null,
      agreementNotes: agreementNotes || null,
      internalNotes: internalNotes || null,
      newProductId: ids.newProductId,
      newUnitId: unique ? ids.newUnitId : null,
      bikeId: unique ? (bike?.id ?? null) : null,
    };
    start(async () => {
      const result = await callAction(() => receiveConsignmentItemAction(input));
      setState(result);
      if (result.ok) {
        toast({ title: `${result.data.shortId} received`, tone: "success" });
        router.push(`/consignment/items/${result.data.id}`);
      }
    });
  };

  // Labelled preview (view_costs only): the line the database would
  // snapshot if it sold at the asking price (D44: cost = agreed amount).
  const agreedValue = parseMoney(agreed);
  const askingValue = parseMoney(asking);
  const preview =
    context.canViewSaleCosts && context.ccRate && agreedValue && askingValue
      ? lineEconomics({
          quantity: 1,
          unitSalePrice: askingValue,
          unitDirectCost: agreedValue,
          rate: context.ccRate,
        })
      : null;

  const fewLocations = context.locations.length <= 4;

  return (
    <Sheet
      open
      onOpenChange={(next) => (next ? null : onClose())}
      dismissible={!pending}
      title="Receive item"
      description="Take a consigned item in. It goes on sale at its asking price; the consignor is owed the agreed amount when it sells."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} pending={pending} pendingLabel="Receiving…">
            Receive item
          </Button>
        </>
      }
    >
      <form
        id={formId}
        ref={formRef}
        className="flex flex-col gap-6"
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

        <fieldset className="flex min-w-0 flex-col gap-4">
          <legend className="mb-2 font-display text-xs font-bold tracking-wide uppercase">
            1. Consignor
          </legend>
          {presetConsignor ? (
            <p className="font-medium">{presetConsignor.label}</p>
          ) : creating ? (
            <div className="flex flex-col gap-4 rounded-xl bg-sunken p-4">
              <Field
                label="Customer record"
                hint="Optional: link the consignor to their customer record. Choosing one fills in the name, phone and email."
              >
                <CustomerPicker value={newCustomer} onSelect={chooseNewCustomer} />
              </Field>
              <Field
                label="Consignor name"
                required
                error={err("newConsignor") ?? err("consignorId")}
              >
                <Input
                  autoComplete="off"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                />
              </Field>
              <Field label="Consignor phone">
                <Input
                  type="tel"
                  inputMode="tel"
                  autoComplete="off"
                  value={newPhone}
                  onChange={(e) => setNewPhone(e.target.value)}
                />
              </Field>
              <Field label="Consignor email">
                <Input
                  type="email"
                  inputMode="email"
                  autoCapitalize="none"
                  spellCheck={false}
                  autoComplete="off"
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                />
              </Field>
              <div>
                <Button variant="ghost" size="sm" onClick={() => setCreating(false)}>
                  Choose an existing consignor instead
                </Button>
              </div>
            </div>
          ) : (
            <Field label="Consignor" required error={err("consignorId")}>
              <ConsignorPicker
                value={consignor}
                onSelect={setConsignor}
                required
                onNew={(q) => {
                  setCreating(true);
                  setConsignor(null);
                  setNewName(q);
                }}
              />
            </Field>
          )}
        </fieldset>

        <fieldset className="flex min-w-0 flex-col gap-4">
          <legend className="mb-2 font-display text-xs font-bold tracking-wide uppercase">
            2. What
          </legend>
          <SegmentedControl
            label="How many"
            value={kind}
            onValueChange={(v) => setKind(v)}
            options={[
              { value: "unique", label: "One item (bike, frame, wheelset)" },
              { value: "quantity", label: "Several identical" },
            ]}
          />
          {kind === "unique" ? (
            <Field
              label="Shop bike record"
              hint="Optional: link a bike record the shop owns. A consignor's own bike record is first transferred to the shop with Transfer on the bike's page."
              error={err("bikeId")}
            >
              <SearchPicker<BikePick>
                search={searchBikes}
                value={bike}
                onSelect={chooseBike}
                placeholder="B- number, brand, model or serial"
                emptyMessage="No shop bike matches. Only bikes without an owner that are not in stock yet are offered."
              />
            </Field>
          ) : null}
          <Field label="Name" required error={err("productName")}>
            <Input
              autoComplete="off"
              value={productName}
              onChange={(e) => setProductName(e.target.value)}
            />
          </Field>
          <Field label="Brand" error={err("brand")}>
            <Input autoComplete="off" value={brand} onChange={(e) => setBrand(e.target.value)} />
          </Field>
          <Field label="Description" error={err("description")}>
            <Textarea
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          {context.categories.length > 0 ? (
            <Field label="Category" error={err("categoryId")}>
              <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                <option value="">No category</option>
                {context.categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          {kind === "unique" ? (
            <>
              <Field label="Serial number" error={err("serialNumber")}>
                <Input
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  value={serialNumber}
                  onChange={(e) => setSerialNumber(e.target.value)}
                />
              </Field>
              <Field
                label="Condition"
                hint="Shown on the public page once the item is published."
                error={err("condition")}
              >
                <Textarea
                  rows={2}
                  value={condition}
                  onChange={(e) => setCondition(e.target.value)}
                />
              </Field>
            </>
          ) : (
            <Field label="Quantity" required error={err("quantity")}>
              <NumberInput
                kind="quantity"
                stepper
                minValue={1}
                maxValue={9999}
                value={quantity}
                onValueChange={setQuantity}
              />
            </Field>
          )}
          <div className="flex flex-col gap-2">
            <span
              id={`${formId}-location`}
              className="font-display text-xs font-bold tracking-wide uppercase"
            >
              Kept at
            </span>
            {context.locations.length === 0 ? (
              <p className="text-sm text-danger-deep">
                No active location. Add one under Settings first.
              </p>
            ) : fewLocations ? (
              <SegmentedControl
                label="Kept at"
                value={locationId ?? undefined}
                onValueChange={setLocationId}
                options={context.locations.map((l) => ({ value: l.id, label: l.name }))}
              />
            ) : (
              <Select
                aria-labelledby={`${formId}-location`}
                value={locationId ?? ""}
                onChange={(e) => setLocationId(e.target.value || null)}
              >
                {context.locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
            )}
            {err("locationId") ? (
              <p className="text-sm text-danger-deep">{err("locationId")}</p>
            ) : null}
          </div>
        </fieldset>

        <fieldset className="flex min-w-0 flex-col gap-4">
          <legend className="mb-2 font-display text-xs font-bold tracking-wide uppercase">
            3. Money
          </legend>
          <Field
            label="Amount owed to the consignor when it sells"
            hint={
              kind === "quantity"
                ? "Per item. 0 is allowed. It is the cost of each sale."
                : "0 is allowed. It is the cost of the sale."
            }
            required
            error={err("agreedAmountOwed")}
          >
            <NumberInput kind="money" value={agreed} onValueChange={setAgreed} />
          </Field>
          <Field
            label="Asking price"
            hint={
              kind === "quantity"
                ? "Per item. The public, label and sale price."
                : "The public, label and sale price."
            }
            error={err("askingPrice")}
          >
            <NumberInput kind="money" value={asking} onValueChange={setAsking} />
          </Field>
          {preview ? (
            <p
              role="status"
              className="rounded-xl bg-sunken px-4 py-3 text-sm text-dust-700 tabular-nums"
            >
              If it sells at the asking price: yield {formatMoney(preview.yield)} · Cult Commons{" "}
              {formatMoney(preview.ccShare)} · BICII keeps {formatMoney(preview.yieldAfterCc)}
              {kind === "quantity" ? " (each)" : ""}
            </p>
          ) : null}
        </fieldset>

        <fieldset className="flex min-w-0 flex-col gap-4">
          <legend className="mb-2 font-display text-xs font-bold tracking-wide uppercase">
            4. Paperwork
          </legend>
          <Field label="Received" error={err("receivedAt")}>
            <Input
              type="date"
              max={today}
              value={receivedDay}
              onChange={(e) => setReceivedDay(e.target.value || today)}
            />
          </Field>
          <Field
            label="Agreement notes"
            hint="The terms agreed with the consignor. Staff only."
            error={err("agreementNotes")}
          >
            <Textarea
              rows={2}
              value={agreementNotes}
              onChange={(e) => setAgreementNotes(e.target.value)}
            />
          </Field>
          <Field label="Internal notes" hint="Staff only." error={err("internalNotes")}>
            <Textarea
              rows={2}
              value={internalNotes}
              onChange={(e) => setInternalNotes(e.target.value)}
            />
          </Field>
          <p className="text-sm text-dust-500">
            Add listing photos and the signed agreement on the item&apos;s page after receiving it.
          </p>
        </fieldset>
      </form>
    </Sheet>
  );
}
