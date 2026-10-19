"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { createPurchaseOrderFromLowStock } from "@/app/(staff)/purchasing/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/ui/empty-state";
import { Field } from "@/components/ui/field";
import { BoxIcon } from "@/components/ui/icons";
import { useToast } from "@/components/ui/toast";
import type { ReorderSuggestion } from "@/lib/domain/purchasing";
import { formatMoney } from "@/lib/money";
import { newId } from "@/lib/uuid";
import { callAction } from "@/lib/call-action";

import { ShortId } from "../short-id";
import { SupplierPicker } from "./supplier-picker";

const COST_SOURCES: Record<string, string> = {
  supplier_last: "this supplier's last cost",
  product: "the product's cost",
};

/**
 * Reorder from low stock (D66 D-REORDER): pick the supplier (required to
 * create; changing it reloads the list for that supplier), tick the
 * shop-owned products below their reorder point (consigned stock is never
 * purchased, D62, so it never appears here), and "Create draft order (N
 * products)" makes one draft with them (create_purchase_order_from_low_stock;
 * quantity = the suggestion, at least 1; cost = the supplier's last cost,
 * else the product's, else 0). The id is made when the list mounts, so a
 * double tap opens the same draft. Rows linked to the chosen supplier with
 * a suggestion above 0 start ticked. Quantities and costs are edited on the
 * draft before it is submitted. Mount it keyed by the supplier.
 */
export function ReorderList({
  supplier,
  items,
  currency,
}: {
  supplier: { id: string; name: string } | null;
  items: ReorderSuggestion[];
  currency: string;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [id] = useState(() => newId());
  const [checked, setChecked] = useState<Set<string>>(
    () =>
      new Set(
        supplier
          ? items.filter((i) => i.supplierLinked && i.suggested > 0).map((i) => i.productId)
          : [],
      ),
  );
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);

  const selected = items.filter((i) => checked.has(i.productId));
  const n = selected.length;

  async function create() {
    if (inFlight.current || !supplier || n === 0) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await callAction(() =>
        createPurchaseOrderFromLowStock({
          id,
          supplierId: supplier.id,
          productIds: selected.map((i) => i.productId),
        }),
      );
      if (result.ok) {
        toast({
          title: "Draft order created. Check quantities and costs, then submit it.",
          tone: "success",
        });
        router.push(`/purchasing/orders/${result.data.id}`);
        return;
      }
      setError(result.error);
    } catch {
      setError("We could not reach the server. Try again: it will not make a second order.");
    }
    inFlight.current = false;
    setPending(false);
  }

  return (
    <div className="flex flex-col gap-4 pb-4">
      <Field
        label="Supplier"
        required
        hint="The draft order is for this supplier. Products linked to it start ticked."
        className="max-w-xl"
      >
        <SupplierPicker
          value={supplier ? { id: supplier.id, label: supplier.name } : null}
          onSelect={(option) =>
            router.replace(
              option
                ? `/purchasing/reorder?supplier=${encodeURIComponent(option.id)}`
                : "/purchasing/reorder",
              { scroll: false },
            )
          }
        />
      </Field>

      <section aria-labelledby="below-reorder-point" className="flex flex-col gap-2">
        <h2 id="below-reorder-point" className="eyebrow text-dust-500">
          Below reorder point
        </h2>
        {items.length === 0 ? (
          <EmptyState
            icon={<BoxIcon />}
            title="Nothing is below its reorder point."
            description="Shop-owned counted products at or below their reorder point appear here. Consigned stock is never reordered."
          />
        ) : (
          <ul
            aria-label="Below reorder point"
            className="flex flex-col divide-y divide-hairline rounded-2xl border border-hairline bg-card px-4"
          >
            {items.map((i) => {
              const preferredHere = supplier !== null && i.preferredSupplier?.id === supplier.id;
              return (
                <li key={i.productId}>
                  <Checkbox
                    checked={checked.has(i.productId)}
                    disabled={pending}
                    onChange={(e) => {
                      const next = new Set(checked);
                      if (e.target.checked) next.add(i.productId);
                      else next.delete(i.productId);
                      setChecked(next);
                    }}
                    className="py-3"
                    label={
                      <span className="flex flex-col gap-1">
                        <span className="font-medium break-words">{i.name}</span>
                        <span className="flex flex-wrap items-center gap-2 text-dense font-normal text-dust-500">
                          <ShortId value={i.shortId} />
                          {i.sku ? <span className="font-mono">{i.sku}</span> : null}
                          {i.supplierSku ? (
                            <span>
                              Their SKU <span className="font-mono">{i.supplierSku}</span>
                            </span>
                          ) : null}
                        </span>
                      </span>
                    }
                    description={
                      <span className="flex flex-col gap-1">
                        <span className="flex flex-wrap gap-x-3 tabular-nums">
                          <span>
                            On hand {i.onHand} / reorder at {i.reorderPoint}
                          </span>
                          <span>On order {i.onOrder}</span>
                          <span className="font-semibold text-ink">
                            {i.suggested > 0
                              ? `Suggested ${i.suggested}`
                              : "Covered by open orders"}
                          </span>
                        </span>
                        {i.defaultCost ? (
                          <span className="tabular-nums">
                            Draft cost {formatMoney(i.defaultCost.unitCost, currency)} (
                            {COST_SOURCES[i.defaultCost.source] ?? "no earlier cost"})
                          </span>
                        ) : null}
                        <span className="flex flex-wrap gap-1.5">
                          {i.preferredSupplier ? (
                            preferredHere ? (
                              <Badge tone="done">Preferred</Badge>
                            ) : (
                              // A long supplier name is cut, never widening the page.
                              <Badge className="max-w-full">
                                <span className="truncate">
                                  Preferred supplier: {i.preferredSupplier.name}
                                </span>
                              </Badge>
                            )
                          ) : null}
                          {i.draftPoNumbers.map((po) => (
                            <Badge key={po} tone="info">
                              In draft {po}
                            </Badge>
                          ))}
                        </span>
                      </span>
                    }
                  />
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {error ? (
        <p role="alert" className="rounded-2xl bg-danger-soft p-4 font-medium text-danger-deep">
          {error}
        </p>
      ) : null}

      {items.length > 0 ? (
        <div
          data-sticky-footer
          className="sticky bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-20 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-hairline bg-paper/95 p-3 backdrop-blur md:bottom-4"
        >
          <p className="text-sm text-dust-700">
            {supplier ? `For ${supplier.name}` : "Choose a supplier first."}
          </p>
          <Button
            size="lg"
            wrap
            className="w-full sm:w-auto"
            pending={pending}
            pendingLabel="Creating…"
            disabled={!supplier || n === 0}
            onClick={create}
          >
            Create draft order ({n} {n === 1 ? "product" : "products"})
          </Button>
        </div>
      ) : null}
    </div>
  );
}
