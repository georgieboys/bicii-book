"use client";

import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { ChevronRightIcon } from "@/components/ui/icons";
import { cn } from "@/lib/cn";
import type { PurchaseOrderLine } from "@/lib/domain/purchasing";
import { formatMoney } from "@/lib/money";
import { formatExpected } from "@/lib/purchasing";

import { ShortIdLink } from "../short-id";
import {
  PurchaseOrderLineSheet,
  type EditableLine,
  type LineSheetOrder,
} from "./purchase-order-line-sheet";
import { QuantityProgress } from "./quantity-progress";

/**
 * A purchase order's lines (SPEC §14): one row each with the product (P-
 * link, SKU, on hand), its QuantityProgress, the expected date or a danger
 * "Overdue" badge and, for cost-visible staff only (D60), unit cost and
 * line total (from purchase_order_lines_staff; the DTO has no costs
 * otherwise), and the customer jobs still waiting for a part on the line
 * that has not arrived (A-21: J- links, so a refused cancel or cut can be
 * acted on). A table once its card is 42rem wide (a container query: the
 * card's width, as LineTable; dense, tabular figures), stacked rows on a
 * phone: one DOM with explicit table roles either way. With `editable`
 * (manage_purchasing, open order) a row is a button opening
 * PurchaseOrderLineSheet.
 */
export function PurchaseOrderLines({
  lines,
  order,
  orderExpectedAt,
  editable,
  showCosts,
}: {
  lines: PurchaseOrderLine[];
  order: LineSheetOrder;
  orderExpectedAt: string | null;
  editable: boolean;
  showCosts: boolean;
}) {
  const [editing, setEditing] = useState<EditableLine | null>(null);
  const money = (v: string) => formatMoney(v, order.currency);

  return (
    <div className="@container">
      <div
        role="table"
        aria-label="Order lines"
        className="flex flex-col rounded-2xl border border-hairline bg-card @2xl:table @2xl:w-full @2xl:border-collapse"
      >
        <div role="rowgroup" className="sr-only @2xl:not-sr-only @2xl:table-header-group">
          <div
            role="row"
            className="@2xl:table-row @2xl:bg-sunken @2xl:text-left @2xl:text-dense @2xl:font-semibold @2xl:text-dust-700"
          >
            <span
              role="columnheader"
              className="@2xl:table-cell @2xl:rounded-tl-[15px] @2xl:px-4 @2xl:py-2"
            >
              Product
            </span>
            <span role="columnheader" className="@2xl:table-cell @2xl:px-3 @2xl:py-2">
              Received
            </span>
            <span role="columnheader" className="@2xl:table-cell @2xl:px-3 @2xl:py-2">
              Expected
            </span>
            {showCosts ? (
              <>
                <span
                  role="columnheader"
                  className="@2xl:table-cell @2xl:px-3 @2xl:py-2 @2xl:text-right"
                >
                  Unit cost
                </span>
                <span
                  role="columnheader"
                  className="@2xl:table-cell @2xl:rounded-tr-[15px] @2xl:px-4 @2xl:py-2 @2xl:text-right"
                >
                  Line total
                </span>
              </>
            ) : null}
          </div>
        </div>
        <div
          role="rowgroup"
          className="flex flex-col divide-y divide-hairline @2xl:table-row-group"
        >
          {lines.map((l) => {
            const expected = l.expectedAt ?? orderExpectedAt;
            const open = () =>
              setEditing({
                id: l.id,
                product: l.product,
                ordered: l.ordered,
                received: l.received,
                expectedAt: l.expectedAt,
                notes: l.notes,
                hasReceipts: l.hasReceipts,
                hasJobParts: l.hasJobParts,
                waitingJobs: l.waitingJobs,
                waitingQuantity: l.waitingQuantity,
                unitCost: l.costs?.unitCost ?? "0.00",
              });
            return (
              <div
                key={l.id}
                role="row"
                className={cn(
                  "relative grid grid-cols-[1fr_auto] gap-x-3 gap-y-2 px-4 py-3 @2xl:table-row @2xl:border-t @2xl:border-hairline",
                  editable && "hover:bg-dust-100",
                )}
              >
                <div
                  role="cell"
                  className="col-span-2 flex min-w-0 flex-col gap-1 @2xl:table-cell @2xl:px-4 @2xl:py-3 @2xl:align-top"
                >
                  {editable ? (
                    <button
                      type="button"
                      onClick={open}
                      className="flex min-h-tap items-center gap-2 text-left font-medium break-words focus-inset after:absolute after:inset-0 after:content-[''] @2xl:min-h-0"
                    >
                      <span className="sr-only">Change line: </span>
                      {l.product.name}
                      <ChevronRightIcon className="size-4 shrink-0 text-dust-500 @2xl:hidden" />
                    </button>
                  ) : (
                    <span className="font-medium break-words">{l.product.name}</span>
                  )}
                  <span className="relative z-10 flex flex-wrap items-center gap-2 text-dense text-dust-500">
                    <ShortIdLink href={`/products/${l.product.id}`} value={l.product.shortId} />
                    {l.product.sku ? <span className="font-mono">{l.product.sku}</span> : null}
                    <span className="tabular-nums">On hand {l.onHand}</span>
                  </span>
                  {l.notes ? (
                    <span className="text-dense whitespace-pre-line text-dust-700">{l.notes}</span>
                  ) : null}
                  {l.waitingJobs.length > 0 ? (
                    <span className="relative z-10 flex flex-wrap items-center gap-x-2 gap-y-1 text-dense text-waiting-deep">
                      <span>{l.waitingJobs.length === 1 ? "A job is" : "Jobs are"} waiting:</span>
                      {l.waitingJobs.map((j) => (
                        <span key={j.id} className="inline-flex items-center gap-1">
                          <ShortIdLink href={`/jobs/${j.id}`} value={j.jobNumber} />
                          <span className="tabular-nums">× {j.quantity}</span>
                        </span>
                      ))}
                    </span>
                  ) : null}
                </div>
                <div
                  role="cell"
                  className="col-span-2 @2xl:table-cell @2xl:min-w-48 @2xl:px-3 @2xl:py-3 @2xl:align-top"
                >
                  <QuantityProgress
                    label={`${l.product.name} received`}
                    ordered={l.ordered}
                    received={l.received}
                    outstanding={l.outstanding}
                    cancelled={l.cancelled}
                    status={order.status}
                  />
                </div>
                <div
                  role="cell"
                  className="text-dense @2xl:table-cell @2xl:px-3 @2xl:py-3 @2xl:align-top"
                >
                  {l.overdue ? (
                    <Badge tone="danger" emphasis="solid">
                      Overdue
                    </Badge>
                  ) : expected ? (
                    <span className="text-dust-700">
                      <span className="@2xl:sr-only">Expected </span>
                      {formatExpected(expected)}
                    </span>
                  ) : (
                    <span className="text-dust-500">
                      <span className="@2xl:sr-only">Expected: </span>No date
                    </span>
                  )}
                  {l.overdue && expected ? (
                    <span className="ml-2 text-dust-700 @2xl:ml-0 @2xl:block">
                      {formatExpected(expected)}
                    </span>
                  ) : null}
                </div>
                {showCosts && l.costs ? (
                  <>
                    <div
                      role="cell"
                      className="text-right text-dense text-dust-700 tabular-nums @2xl:table-cell @2xl:px-3 @2xl:py-3 @2xl:align-top"
                    >
                      <span className="@2xl:sr-only">{l.ordered} × </span>
                      {money(l.costs.unitCost)}
                    </div>
                    <div
                      role="cell"
                      className="col-span-2 text-right font-semibold tabular-nums @2xl:table-cell @2xl:px-4 @2xl:py-3 @2xl:align-top"
                    >
                      <span className="sr-only">Line total </span>
                      {money(l.costs.orderedTotal)}
                    </div>
                  </>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
      {editing ? (
        <PurchaseOrderLineSheet order={order} line={editing} onClose={() => setEditing(null)} />
      ) : null}
    </div>
  );
}
