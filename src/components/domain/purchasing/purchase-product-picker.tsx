"use client";

import { searchPurchasableProducts } from "@/app/(staff)/purchasing/actions";
import { SearchPicker, type PickerOption } from "@/components/ui/search-picker";
import type { PurchasableProduct } from "@/lib/domain/purchasing";
import { callAction } from "@/lib/call-action";

import { ShortId } from "../short-id";

export type PurchaseProductOption = PickerOption & { product: PurchasableProduct };

/** "On hand 7 · On order 2 · P-000123" */
export function purchaseProductMeta(p: Pick<PurchasableProduct, "onHand" | "onOrder" | "shortId">) {
  return `On hand ${p.onHand} · On order ${p.onOrder} · ${p.shortId}`;
}

/**
 * Products a purchase order may order (D62: quantity-tracked, shop-owned,
 * active, not archived), by name, SKU or P- number, each with what is on
 * hand and already on order. A SearchPicker over the
 * searchPurchasableProducts action; wrap in <Field> for its label.
 */
export function PurchaseProductPicker({
  value,
  onSelect,
  required,
  disabled,
  disabledIds,
}: {
  value?: PurchaseProductOption | null;
  onSelect?: (option: PurchaseProductOption | null) => void;
  required?: boolean;
  disabled?: boolean;
  /** Shown but not choosable, e.g. products already on the order. */
  disabledIds?: readonly string[];
}) {
  const search = async (q: string): Promise<PurchaseProductOption[]> => {
    const result = await callAction(() => searchPurchasableProducts({ q }));
    if (!result.ok) throw new Error(result.error);
    return result.data.map((p) => ({
      id: p.id,
      label: p.name,
      description: purchaseProductMeta(p),
      meta: disabledIds?.includes(p.id) ? "On this order" : undefined,
      disabled: disabledIds?.includes(p.id),
      product: p,
    }));
  };
  return (
    <SearchPicker<PurchaseProductOption>
      search={search}
      value={value}
      onSelect={onSelect}
      required={required}
      disabled={disabled}
      placeholder="Name, SKU or P- number"
      minChars={1}
      debounceMs={250}
      emptyMessage="No product to order matches. Unique, consigned, inactive and archived products are not ordered on a purchase order."
      renderOption={(o) => (
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex items-center justify-between gap-2">
            <span className="font-medium break-words">{o.label}</span>
            {o.meta ? <span className="shrink-0 text-sm text-dust-500">{o.meta}</span> : null}
          </span>
          <span className="flex flex-wrap items-center gap-2 text-sm text-dust-500">
            <span className="tabular-nums">
              On hand {o.product.onHand} · On order {o.product.onOrder}
            </span>
            <ShortId value={o.product.shortId} />
            {o.product.sku ? <span>{o.product.sku}</span> : null}
          </span>
        </span>
      )}
    />
  );
}
