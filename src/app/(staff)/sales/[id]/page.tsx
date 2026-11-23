import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { RecordRefundButton, RestockControl } from "@/components/domain/sale-controls";
import { ShortId } from "@/components/domain/short-id";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { StatusPill } from "@/components/ui/status-pill";
import {
  canRecordRefund,
  canViewConsignmentMoney,
  canViewSaleCosts,
  hasPermission,
} from "@/lib/auth/permissions";
import { requireStaff } from "@/lib/auth/session";
import { formatRate } from "@/lib/cult-commons";
import { formatDateTime } from "@/lib/dates";
import { listLocations } from "@/lib/domain/inventory";
import { getSale, type SaleLine } from "@/lib/domain/sales";
import { formatMoney, formatQuantity, lineTotal, sumMoney, toDecimal } from "@/lib/money";
import {
  BIKE_NOT_TRANSFERRED,
  REFUND_NOT_RESTOCK_CONSIGNED,
  hasConsignedQuantityLine,
  refundStockNote,
  refundableAmount,
  saleStatusLabel,
  saleStatusTone,
} from "@/lib/sales";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/uuid";

export const metadata: Metadata = { title: "Sale" };

const SOURCE_LABELS: Record<string, string> = {
  retail: "In store",
  online_shopify: "Online",
  work_order: "From a job",
};

/** Where a line's description opens: its unit, else its consignment, else its product. */
function lineHref(line: SaleLine): string {
  if (line.unit) return `/units/${line.unit.id}`;
  if (line.consignment) return `/consignment/items/${line.consignment.itemId}`;
  return `/products/${line.product.id}`;
}

/**
 * One sale (SPEC §13, §21; D1, D7, D46, D48, D49, D51): its S- number
 * large, when and where it was sold, the customer and who recorded it.
 * The lines for everyone (description linked to the unit, consignment or
 * product; quantity, price, total; "Consigned by …" and, for consignment
 * money users, what the consignor is owed, paid separately; a bike's link
 * and that ownership is not transferred automatically). Staff with View
 * costs also see each line's cost, yield and Cult Commons and the totals
 * card. Refunds are listed for everyone; Record refund is for admins and
 * managers (D94). Restock is per unit line still sold on this sale, for
 * adjust_stock holders (a consigned unit also needs manage_consignments,
 * D46).
 */
export default async function SalePage({ params }: PageProps<"/sales/[id]">) {
  const staff = await requireStaff();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const supabase = await createClient();
  const costs = canViewSaleCosts(staff);
  const money = canViewConsignmentMoney(staff);
  const canAdjust = hasPermission(staff, "adjust_stock");
  const manageConsignments = hasPermission(staff, "manage_consignments");
  const [sale, locations] = await Promise.all([getSale(supabase, id), listLocations(supabase)]);
  if (!sale) notFound();
  const c = sale.currency;
  const fmt = (v: string) => formatMoney(v, c);
  const activeLocations = locations.locations
    .filter((l) => l.active)
    .map((l) => ({ id: l.id, name: l.name }));
  const refundable = refundableAmount(sale.total, sale.refunds, c);
  const showCosts = costs && sale.lines.every((l) => l.costTotal !== null);
  const sumOf = (pick: (l: SaleLine) => string | null) =>
    fmt(sumMoney(sale.lines.map((l) => pick(l) ?? "0")).toFixed(2));
  const rates = [...new Set(sale.lines.map((l) => l.rate).filter((r): r is string => !!r))];
  const rateText = rates.length === 1 ? formatRate(rates[0]) : null;

  return (
    <>
      <header className="flex flex-col gap-4 pt-6 pb-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <h1>
              <ShortId value={sale.saleNumber} large />
            </h1>
            <StatusPill status={saleStatusTone(sale.status)}>
              {saleStatusLabel(sale.status)}
            </StatusPill>
          </div>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-dust-700">
            <time dateTime={sale.recognizedAt}>{formatDateTime(sale.recognizedAt)}</time>
            <span>{SOURCE_LABELS[sale.source] ?? sale.source}</span>
            {sale.customer ? (
              <Link href={`/customers/${sale.customer.id}`} className="font-medium underline">
                {sale.customer.label}
              </Link>
            ) : sale.shopifyCustomer?.linked ? (
              // D86: linked after this sale was recorded; the sale itself is unchanged.
              <span>
                <Link
                  href={`/customers/${sale.shopifyCustomer.linked.id}`}
                  className="font-medium underline"
                >
                  {sale.shopifyCustomer.linked.label}
                </Link>{" "}
                (linked through Shopify)
              </span>
            ) : sale.shopifyCustomer ? (
              <span>Shopify customer, not linked</span>
            ) : (
              <span>Walk-in</span>
            )}
          </p>
          {sale.recordedByName ? (
            <p className="text-sm text-dust-500">Recorded by {sale.recordedByName}</p>
          ) : null}
        </div>
        {canRecordRefund(staff) && toDecimal(refundable).greaterThan(0) ? (
          <div className="flex flex-wrap items-center gap-2">
            <RecordRefundButton
              saleId={sale.id}
              saleNumber={sale.saleNumber}
              refundable={refundable}
              currency={c}
              stockNote={refundStockNote(sale.lines)}
            />
          </div>
        ) : null}
      </header>

      <Card title="Items">
        <ul
          aria-label="Sale lines"
          className="-mx-4 flex flex-col divide-y divide-hairline sm:-mx-5"
        >
          {sale.lines.map((line) => {
            const consignedUnit = line.unit?.ownership === "consignment";
            const restockable =
              line.unit !== null &&
              line.restocked === null &&
              line.unit.soldOnLineId === line.id &&
              canAdjust &&
              (!consignedUnit || manageConsignments);
            const owed =
              money && line.payout !== null ? lineTotal(line.quantity, line.payout, c) : null;
            return (
              <li
                key={line.id}
                aria-label={line.description}
                className="flex flex-col gap-2 px-4 py-3 sm:px-5"
              >
                <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
                  <Link href={lineHref(line)} className="min-w-0 font-medium break-words underline">
                    {line.description}
                  </Link>
                  <span className="shrink-0 font-semibold tabular-nums">{fmt(line.total)}</span>
                </div>
                <p className="flex flex-wrap items-center gap-2 text-sm text-dust-700 tabular-nums">
                  <ShortId value={line.unit?.shortId ?? line.product.shortId} />
                  <span>
                    {formatQuantity(line.quantity)} × {fmt(line.unitPrice)}
                  </span>
                  {line.restocked ? <Badge tone="info">Restocked</Badge> : null}
                </p>
                {line.consignment ? (
                  <p className="text-sm text-dust-700">
                    Consigned by{" "}
                    <Link
                      href={`/consignment/consignors/${line.consignment.consignorId}`}
                      className="underline"
                    >
                      {line.consignment.consignorName}
                    </Link>{" "}
                    ·{" "}
                    <Link
                      href={`/consignment/items/${line.consignment.itemId}`}
                      className="underline"
                    >
                      {line.consignment.shortId}
                    </Link>
                    {owed ? <> · owed {fmt(owed.toFixed(2))}, paid separately</> : null}
                  </p>
                ) : null}
                {line.bike ? (
                  <p className="text-sm text-dust-700">
                    Bike{" "}
                    <Link href={`/bikes/${line.bike.id}`} className="underline">
                      {line.bike.shortId}
                    </Link>
                    . {BIKE_NOT_TRANSFERRED}
                  </p>
                ) : null}
                {line.restocked ? (
                  <p className="text-sm text-dust-500">
                    Restocked {formatDateTime(line.restocked.at)}
                    {line.restocked.byName ? ` by ${line.restocked.byName}` : ""}
                  </p>
                ) : null}
                {showCosts &&
                line.costTotal !== null &&
                line.yieldTotal !== null &&
                line.cultCommons !== null ? (
                  <p className="text-dense text-dust-700 tabular-nums">
                    Cost {fmt(line.costTotal)} · Yield {fmt(line.yieldTotal)} · Cult Commons{" "}
                    {fmt(line.cultCommons)}
                  </p>
                ) : null}
                {restockable && line.unit ? (
                  <RestockControl
                    unitId={line.unit.id}
                    unitShortId={line.unit.shortId}
                    saleLineId={line.id}
                    consigned={consignedUnit}
                    defaultLocationId={line.unit.locationId}
                    locations={activeLocations}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
        <p className="mt-3 flex items-baseline justify-between border-t border-hairline pt-3 tabular-nums">
          <span className="font-semibold">Total</span>
          <span aria-label="Sale total" className="text-lg font-bold">
            {fmt(sale.total)}
          </span>
        </p>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        {showCosts ? (
          <Card title="Yield" eyebrow="Staff with cost access only">
            <dl
              aria-label="Sale economics"
              className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 tabular-nums"
            >
              <dt>Sale</dt>
              <dd className="text-right">{fmt(sale.total)}</dd>
              <dt>Direct cost (incl. consignor payout)</dt>
              <dd className="text-right">{sumOf((l) => l.costTotal)}</dd>
              <dt>Yield</dt>
              <dd className="text-right">{sumOf((l) => l.yieldTotal)}</dd>
              <dt>Cult Commons ({rateText ?? "each line's rate"} of positive yield)</dt>
              <dd className="text-right">{sumOf((l) => l.cultCommons)}</dd>
              <dt className="border-t border-hairline pt-2 font-semibold">
                BICII after Cult Commons
              </dt>
              <dd className="border-t border-hairline pt-2 text-right font-bold">
                {fmt(
                  sumMoney(
                    sale.lines.map((l) =>
                      toDecimal(l.yieldTotal ?? "0").minus(toDecimal(l.cultCommons ?? "0")),
                    ),
                  ).toFixed(2),
                )}
              </dd>
            </dl>
            <p className="mt-2 text-sm text-dust-500">
              Snapshotted when the sale was recorded. Refunds and restocks do not change these
              figures yet.
            </p>
          </Card>
        ) : null}

        <Card title="Refunds">
          {sale.refunds.length === 0 ? (
            <p className="text-dust-700">No refunds.</p>
          ) : (
            <>
              <ul aria-label="Refunds" className="flex flex-col gap-3">
                {sale.refunds.map((r) => (
                  <li key={r.id} className="flex flex-col">
                    <span className="flex items-baseline justify-between gap-2 tabular-nums">
                      <span className="font-medium">
                        Refunded {formatMoney(r.amount, r.currency)}
                      </span>
                      <time dateTime={r.at} className="text-sm text-dust-500">
                        {formatDateTime(r.at)}
                      </time>
                    </span>
                    <span className="text-sm text-dust-700">“{r.reason}”</span>
                    {r.byName ? <span className="text-sm text-dust-500">By {r.byName}</span> : null}
                  </li>
                ))}
              </ul>
              <p className="mt-3 flex items-baseline justify-between border-t border-hairline pt-3 tabular-nums">
                <span>Left to refund</span>
                <span className="font-semibold">{fmt(refundable)}</span>
              </p>
            </>
          )}
          <p className="mt-3 text-sm text-dust-500">
            {hasConsignedQuantityLine(sale.lines)
              ? REFUND_NOT_RESTOCK_CONSIGNED
              : "A refund is money only: nothing goes back into stock unless the item is restocked."}
          </p>
        </Card>
      </div>

      {sale.notes ? (
        <Card title="Notes">
          <p className="whitespace-pre-line text-dust-700">{sale.notes}</p>
        </Card>
      ) : null}
    </>
  );
}
