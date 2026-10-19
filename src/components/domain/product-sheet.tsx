"use client";

import { useRouter } from "next/navigation";
import { useActionState, useId, useState } from "react";

import {
  createProduct,
  createUniqueItem,
  searchShopBikes,
  updateProduct,
} from "@/app/(staff)/inventory/actions";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Field } from "@/components/ui/field";
import { BoxIcon, PlusIcon } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { SearchPicker, type PickerOption } from "@/components/ui/search-picker";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Select } from "@/components/ui/select";
import { Sheet } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { useFocusFirstInvalid } from "@/components/ui/use-focus-invalid";
import type { ActionResult } from "@/lib/actions";
import type { TrackingType } from "@/lib/inventory";
import { newId } from "@/lib/uuid";
import { callAction } from "@/lib/call-action";

import { NoActiveLocation } from "./no-active-location";

type State = ActionResult<unknown> | null;
type Errors = Record<string, string[]> | undefined;
type Values = Record<string, string> | undefined;

export type SheetLocationOption = { id: string; name: string; active: boolean };
export type CategoryOption = { id: string; name: string };

/** The editable fields of a product (ProductDetail has them). */
export type ProductFields = {
  id: string;
  name: string;
  sku: string | null;
  brand: string | null;
  categoryId: string | null;
  description: string | null;
  defaultSalePrice: string | null;
  /** Present for view_costs holders only. */
  cost?: string | null;
  reorderPoint: number | null;
  active: boolean;
  trackingType: TrackingType;
};

/**
 * A unit's fields, shared by New product (Unique) and Add unit: location
 * (the default one first), serial, the condition (public once published),
 * the unit's own price, its cost (view_costs only) and, optionally, the
 * shop bike it is.
 */
export function UnitFields({
  locations,
  defaultLocationId,
  viewCosts,
  errors,
  values,
  withBike = true,
}: {
  locations: SheetLocationOption[];
  defaultLocationId: string | null;
  viewCosts: boolean;
  errors: Errors;
  values: Values;
  withBike?: boolean;
}) {
  const active = locations.filter((l) => l.active);
  const [locationId, setLocationId] = useState(
    values?.locationId ?? defaultLocationId ?? active[0]?.id ?? "",
  );
  const [bike, setBike] = useState<PickerOption | null>(null);
  const searchBikes = async (q: string): Promise<PickerOption[]> => {
    const result = await callAction(() => searchShopBikes({ q }));
    if (!result.ok) throw new Error(result.error);
    return result.data.map((b) => ({
      id: b.id,
      label: b.title,
      description: b.detail ?? undefined,
      meta: b.shortId,
    }));
  };
  if (active.length === 0) {
    return (
      <EmptyState
        icon={<BoxIcon />}
        title="Nowhere to keep it"
        description={<NoActiveLocation />}
      />
    );
  }
  return (
    <>
      <div className="flex flex-col gap-2">
        <span className="font-display text-xs font-bold tracking-wide uppercase">Location</span>
        <SegmentedControl
          label="Location"
          name="locationId"
          value={locationId}
          onValueChange={setLocationId}
          options={active.map((l) => ({ value: l.id, label: l.name }))}
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
          spellCheck={false}
          className="font-mono"
          defaultValue={values?.serialNumber ?? ""}
        />
      </Field>
      <Field label="Condition (shown publicly when published)" error={errors?.condition?.[0]}>
        <Textarea name="condition" rows={2} defaultValue={values?.condition ?? ""} />
      </Field>
      <Field
        label="Unit sale price"
        hint="Optional. Leave empty to sell at the product's price."
        error={errors?.unitSalePrice?.[0]}
      >
        <NumberInput kind="money" name="unitSalePrice" defaultValue={values?.unitSalePrice ?? ""} />
      </Field>
      {viewCosts ? (
        <Field
          label="Unit cost"
          hint="Staff with cost access only. Optional: the product's cost when empty."
          error={errors?.unitCost?.[0]}
        >
          <NumberInput kind="money" name="unitCost" defaultValue={values?.unitCost ?? ""} />
        </Field>
      ) : null}
      {withBike ? (
        <Field
          label="This is a complete bike"
          hint="Optional: the shop bike this item is, so its B- number and photos follow it. Customer bikes must be transferred to the shop first."
          error={errors?.bikeId?.[0]}
        >
          <SearchPicker
            name="bikeId"
            search={searchBikes}
            value={bike}
            onSelect={setBike}
            clearable
            placeholder="Search shop bikes"
            emptyMessage="No shop bike matches. Only bikes without an owner that are not in stock yet are listed."
          />
        </Field>
      ) : null}
    </>
  );
}

/**
 * New product or Edit details, in a sheet (manage_inventory). New starts
 * with Quantity / Unique (fixed afterwards: tracking_type is read-only once
 * created); Unique asks for the first unit on the same sheet and creates
 * both (product first, then the unit; both idempotent by their form ids).
 * The cost field only for view_costs holders (on edit, empty keeps the
 * current cost); the reorder point for counted stock only. Creating opens
 * the new product. If the unit is refused the product still exists, and
 * its page offers Add unit.
 */
export function ProductSheet({
  open,
  onOpenChange,
  product,
  categories,
  locations,
  defaultLocationId,
  viewCosts,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Edit this product; omit for a new one. */
  product?: ProductFields;
  categories: CategoryOption[];
  locations: SheetLocationOption[];
  defaultLocationId: string | null;
  viewCosts: boolean;
}) {
  return open ? (
    <ProductSheetBody
      onOpenChange={onOpenChange}
      product={product}
      categories={categories}
      locations={locations}
      defaultLocationId={defaultLocationId}
      viewCosts={viewCosts}
    />
  ) : null;
}

function ProductSheetBody({
  onOpenChange,
  product,
  categories,
  locations,
  defaultLocationId,
  viewCosts,
}: {
  onOpenChange: (open: boolean) => void;
  product?: ProductFields;
  categories: CategoryOption[];
  locations: SheetLocationOption[];
  defaultLocationId: string | null;
  viewCosts: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const formId = useId();
  const [id] = useState(() => product?.id ?? newId());
  const [unitId] = useState(newId);
  const [tracking, setTracking] = useState<TrackingType>(product?.trackingType ?? "quantity");
  const [active, setActive] = useState(product?.active ?? true);
  const [state, formAction, pending] = useActionState<State, FormData>(async (prev, formData) => {
    if (product) {
      const result = await callAction(
        () => updateProduct(prev as ActionResult<null> | null, formData),
        formData,
      );
      if (result.ok) {
        toast({ title: "Product saved", tone: "success" });
        onOpenChange(false);
      }
      return result;
    }
    if (tracking === "unique") {
      const result = await callAction(() => createUniqueItem(null, formData));
      if (result.ok) {
        if (result.data.unitError) {
          toast({
            title: "Product saved, unit not added",
            description: `${result.data.unitError} Add the unit from the product's page.`,
            tone: "error",
          });
        } else {
          toast({ title: `Added ${result.data.unit?.shortId ?? "the unit"}`, tone: "success" });
        }
        router.push(`/products/${id}`);
      }
      return result;
    }
    const result = await callAction(() => createProduct(null, formData));
    if (result.ok) {
      toast({ title: "Product added", tone: "success" });
      router.push(`/products/${id}`);
    }
    return result;
  }, null);
  const formRef = useFocusFirstInvalid(state);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  const values = state && !state.ok ? state.values : undefined;
  const value = (key: string, stored: string | number | null | undefined) =>
    values?.[key] ?? (stored === null || stored === undefined ? "" : String(stored));
  // A new unique item needs somewhere to keep its unit; with no active
  // location the unit fields show an empty state instead, so the save could
  // never succeed (AddUnitSheet hides its footer for the same reason).
  // Quantity stays available.
  const cannotPlaceUnit = !product && tracking === "unique" && !locations.some((l) => l.active);

  return (
    <Sheet
      open
      onOpenChange={onOpenChange}
      dismissible={!pending}
      title={product ? "Edit details" : "New product"}
      description={
        product
          ? undefined
          : "It gets its permanent P- number when you save, and starts as a draft."
      }
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={formId}
            pending={pending}
            pendingLabel="Saving…"
            disabled={cannotPlaceUnit}
          >
            {product ? "Save" : "Add product"}
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
        <input type="hidden" name="id" value={id} />
        {state && !state.ok ? (
          <p role="alert" className="text-sm font-medium text-danger-deep">
            {state.error}
          </p>
        ) : null}
        {product ? (
          <p className="text-sm text-dust-700">
            {product.trackingType === "unique"
              ? "Unique: each item is its own unit with a U- number."
              : "Counted by quantity."}{" "}
            This can&apos;t change after creation.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            <span className="font-display text-xs font-bold tracking-wide uppercase">
              How it is counted
            </span>
            <SegmentedControl
              label="How it is counted"
              name="trackingType"
              value={tracking}
              onValueChange={setTracking}
              options={[
                { value: "quantity", label: "Quantity" },
                { value: "unique", label: "Unique" },
              ]}
            />
            <p className="text-sm text-dust-500">
              {tracking === "quantity"
                ? "Many identical items counted together (tubes, pads, chains)."
                : "One of a kind (a complete bike, a used frame): each gets its own U- number."}
            </p>
          </div>
        )}
        <Field label="Name" error={errors?.name?.[0]} required>
          <Input name="name" autoComplete="off" defaultValue={value("name", product?.name)} />
        </Field>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="SKU" error={errors?.sku?.[0]}>
            <Input
              name="sku"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              className="font-mono"
              defaultValue={value("sku", product?.sku)}
            />
          </Field>
          <Field label="Brand" error={errors?.brand?.[0]}>
            <Input name="brand" autoComplete="off" defaultValue={value("brand", product?.brand)} />
          </Field>
        </div>
        <Field
          label="Category"
          error={errors?.categoryId?.[0]}
          hint={
            categories.length === 0 ? "Add categories in Settings → Product categories." : undefined
          }
        >
          <Select name="categoryId" defaultValue={value("categoryId", product?.categoryId)}>
            <option value="">No category</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Description" error={errors?.description?.[0]}>
          <Textarea
            name="description"
            rows={2}
            defaultValue={value("description", product?.description)}
          />
        </Field>
        <Field
          label="Sale price"
          hint={tracking === "unique" ? "Optional when the unit has its own price." : undefined}
          error={errors?.salePrice?.[0]}
        >
          <NumberInput
            kind="money"
            name="salePrice"
            defaultValue={value("salePrice", product?.defaultSalePrice)}
          />
        </Field>
        {viewCosts ? (
          <Field
            label="Cost"
            hint={
              product
                ? "Staff with cost access only. Leave empty to keep the current cost."
                : "Staff with cost access only. A part needs a cost before it can go on a job."
            }
            error={errors?.cost?.[0]}
          >
            <NumberInput kind="money" name="cost" defaultValue={value("cost", product?.cost)} />
          </Field>
        ) : null}
        {tracking === "quantity" ? (
          <Field
            label="Reorder point"
            hint="Listed under Low stock at or below this count."
            error={errors?.reorderPoint?.[0]}
          >
            <NumberInput
              kind="quantity"
              name="reorderPoint"
              defaultValue={value("reorderPoint", product?.reorderPoint)}
            />
          </Field>
        ) : null}
        <Switch
          label="Active"
          description="Inactive products are not offered on jobs."
          name="active"
          checked={active}
          onCheckedChange={setActive}
        />
        {!product && tracking === "unique" ? (
          <section
            aria-label="First unit"
            className="flex flex-col gap-5 border-t border-hairline pt-5"
          >
            <h3 className="font-display text-xs font-bold tracking-wide uppercase">First unit</h3>
            <input type="hidden" name="unitId" value={unitId} />
            <UnitFields
              locations={locations}
              defaultLocationId={defaultLocationId}
              viewCosts={viewCosts}
              errors={errors}
              values={values}
            />
          </section>
        ) : null}
      </form>
    </Sheet>
  );
}

export function NewProductButton(props: {
  categories: CategoryOption[];
  locations: SheetLocationOption[];
  defaultLocationId: string | null;
  viewCosts: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="solid" icon={<PlusIcon className="size-5" />} onClick={() => setOpen(true)}>
        New product
      </Button>
      <ProductSheet open={open} onOpenChange={setOpen} {...props} />
    </>
  );
}

export function EditProductButton(props: {
  product: ProductFields;
  categories: CategoryOption[];
  viewCosts: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Edit details
      </Button>
      <ProductSheet
        open={open}
        onOpenChange={setOpen}
        locations={[]}
        defaultLocationId={null}
        {...props}
      />
    </>
  );
}
