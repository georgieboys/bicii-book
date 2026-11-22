import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { ChevronRightIcon } from "@/components/ui/icons";
import { formatDate } from "@/lib/dates";
import type { ProductPurchasing } from "@/lib/domain/purchasing";
import { formatMoney } from "@/lib/money";
import { formatExpected, leadTimeText } from "@/lib/purchasing";

import { ShortId } from "../short-id";
import { PurchaseOrderStatusPill } from "./purchase-order-status-pill";
import { AddSupplierProductButton } from "./supplier-product-sheet";

/**
 * The product page's "Suppliers & orders" card (Phase 7, from
 * getProductPurchasing): who supplies it (supplier SKU, lead time,
 * Preferred and, view_costs holders only, the last cost: the product page
 * is not a purchasing screen, so manage_purchasing alone shows no cost
 * here, D60 D63), what is
 * on order (reporting.product_on_order: submitted and partially received
 * orders, never drafts) and the open orders holding it. manage_purchasing
 * adds a supplier link here (SupplierProductSheet, supplier-picker mode).
 */
export function ProductPurchasingCard({
  product,
  purchasing,
  canManage,
}: {
  product: { id: string; name: string; shortId: string };
  purchasing: ProductPurchasing;
  /** manage_purchasing, on a product that can be ordered. */
  canManage: boolean;
}) {
  const preferred = purchasing.suppliers.find((s) => s.preferred)?.supplierName ?? null;
  return (
    <Card
      title="Suppliers & orders"
      actions={
        canManage ? (
          <AddSupplierProductButton product={product} preferredElsewhere={preferred} />
        ) : null
      }
    >
      <div className="flex flex-col gap-4">
        <p className="flex flex-wrap items-center gap-2">
          <span className="font-semibold tabular-nums">On order: {purchasing.onOrder}</span>
          {purchasing.nextExpectedAt && purchasing.onOrder > 0 ? (
            <span className="text-sm text-dust-700">
              next expected {formatExpected(purchasing.nextExpectedAt)}
            </span>
          ) : null}
        </p>
        {purchasing.suppliers.length === 0 ? (
          <p className="text-dust-700">
            No supplier linked yet.
            {canManage ? " Add one, or receive it on an order to link it." : ""}
          </p>
        ) : (
          <ul aria-label="Suppliers" className="-mx-2 flex flex-col">
            {purchasing.suppliers.map((s) => (
              <li key={s.supplierId}>
                <Link
                  href={`/purchasing/suppliers/${s.supplierId}`}
                  className="flex min-h-tap items-center gap-3 rounded-xl px-2 py-2 hover:bg-dust-100"
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{s.supplierName}</span>
                      {s.preferred ? <Badge tone="done">Preferred</Badge> : null}
                      {s.supplierArchived ? <Badge>Archived</Badge> : null}
                    </span>
                    <span className="text-sm text-dust-500">
                      {[
                        s.supplierSku ? `Their SKU ${s.supplierSku}` : null,
                        s.leadDays !== null ? leadTimeText(s.leadDays) : null,
                      ]
                        .filter(Boolean)
                        .join(" · ") || "No SKU or lead time"}
                    </span>
                    {s.costs ? (
                      <span className="text-sm text-dust-700 tabular-nums">
                        {s.costs.lastUnitCost !== null
                          ? `Last cost ${formatMoney(s.costs.lastUnitCost, s.costs.currency)}${
                              s.costs.lastReceivedAt
                                ? ` · ${formatDate(s.costs.lastReceivedAt)}`
                                : ""
                            }`
                          : "Not received from them yet"}
                      </span>
                    ) : null}
                  </span>
                  <ChevronRightIcon className="size-5 shrink-0 text-dust-500" />
                </Link>
              </li>
            ))}
          </ul>
        )}
        {purchasing.openOrders.length > 0 ? (
          <section aria-labelledby={`open-orders-${product.id}`} className="flex flex-col gap-1">
            <h3
              id={`open-orders-${product.id}`}
              className="font-display text-xs font-bold tracking-wide uppercase"
            >
              Open orders
            </h3>
            <ul aria-label="Open orders" className="-mx-2 flex flex-col">
              {purchasing.openOrders.map((o) => (
                <li key={o.id}>
                  <Link
                    href={`/purchasing/orders/${o.id}`}
                    className="flex min-h-tap items-center gap-3 rounded-xl px-2 py-2 hover:bg-dust-100"
                  >
                    <span className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <ShortId value={o.poNumber} />
                        <PurchaseOrderStatusPill status={o.status} />
                        {o.overdue ? (
                          <Badge tone="danger" emphasis="solid">
                            Overdue
                          </Badge>
                        ) : null}
                      </span>
                      <span className="text-sm text-dust-700">
                        {o.supplierName}
                        {o.status !== "draft" ? ` · ${o.outstanding} to come` : ""}
                      </span>
                    </span>
                    <ChevronRightIcon className="size-5 shrink-0 text-dust-500" />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </Card>
  );
}
