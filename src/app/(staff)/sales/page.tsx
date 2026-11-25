import type { Metadata } from "next";

import { RecordSaleButton } from "@/components/domain/record-sale-sheet";
import { saleShopifyFeeLine } from "@/components/domain/sale-shopify-fees";
import { SearchField } from "@/components/domain/search-field";
import { ShortId } from "@/components/domain/short-id";
import { LinkSegments } from "@/components/domain/workshop-board";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { ChevronRightIcon, ReceiptIcon } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/page-header";
import { RowLink, RowList } from "@/components/ui/row-list";
import { StatusPill } from "@/components/ui/status-pill";
import { canViewSaleCosts } from "@/lib/auth/permissions";
import { requireStaff } from "@/lib/auth/session";
import { formatDayShort, formatShopDay, formatTime } from "@/lib/dates";
import { listSales } from "@/lib/domain/sales";
import { formatMoney } from "@/lib/money";
import {
  SALE_RANGES,
  readSaleDay,
  readSaleRange,
  saleDayRange,
  saleRange,
  saleStatusLabel,
  saleStatusTone,
} from "@/lib/sales";
import { readQuery, withParam } from "@/lib/search-params";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Sales" };

/**
 * In-store sales (SPEC §13, §21; list_sales). A range as links (Today, 7
 * days, the default, and 30 days: shop days in Singapore time, D35; or one
 * shop day with `?day=YYYY-MM-DD`, from Today's consignment tile) and a
 * search (S- number, customer, item words; a search looks across every
 * date). Each row: the S- number and time, the customer or "Walk-in", the
 * first item and how many more, the total, Refunded / Partly refunded and
 * Restocked; staff with View costs also see yield and Cult Commons (D48).
 * Every active staff member may record a sale (New sale).
 */
export default async function SalesPage({ searchParams }: PageProps<"/sales">) {
  const staff = await requireStaff();
  const params = await searchParams;
  const q = readQuery(params.q);
  const range = readSaleRange(params.range);
  // ?day=: one shop day, as Today's consignment tile links to it.
  const day = readSaleDay(params.day);
  const costs = canViewSaleCosts(staff);
  const bounds = q ? { from: null, to: null } : day ? saleDayRange(day) : saleRange(range);
  const { items, more } = await listSales(await createClient(), {
    ...bounds,
    q,
    viewCosts: costs,
  });

  return (
    <>
      <PageHeader title="Sales" actions={<RecordSaleButton viewCosts={costs} />} />
      <div className="flex flex-col gap-3">
        <SearchField
          label="Search sales"
          hint="S- number, customer or item"
          placeholder="Search sales"
        />
        <LinkSegments
          label="Sales period"
          options={SALE_RANGES.map((r) => ({
            key: r.key,
            text: r.label,
            href: `/sales${withParam(r.key === "7d" ? "" : `range=${r.key}`, "q", q)}`,
            current: !q && !day && range === r.key,
          }))}
        />
      </div>
      <section aria-labelledby="sale-results" className="flex flex-col gap-2">
        <h2 id="sale-results" className="eyebrow text-dust-500">
          {q
            ? `${items.length} ${items.length === 1 ? "match" : "matches"}, every date`
            : day
              ? formatShopDay(day)
              : (SALE_RANGES.find((r) => r.key === range)?.label ?? "Sales")}
        </h2>
        {more ? (
          <p className="text-sm text-dust-700">
            Showing the latest {items.length}. Search by S- number or customer to find an older one.
          </p>
        ) : null}
        {items.length === 0 ? (
          <EmptyState
            icon={<ReceiptIcon />}
            title={q ? `No sale matches “${q}”` : "No sales in this period"}
            description={
              q
                ? "Try the S- number on the receipt, the customer's name or an item."
                : "Sales recorded in the shop appear here, newest first."
            }
          />
        ) : (
          <RowList label="Sales">
            {items.map((s) => {
              const more = s.lineCount > 1 ? ` +${s.lineCount - 1} more` : "";
              const refunded = s.status === "refunded" || s.status === "partially_refunded";
              return (
                <RowLink key={s.id} href={`/sales/${s.id}`}>
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <ShortId value={s.saleNumber} />
                      <span className="text-sm text-dust-500">
                        <time dateTime={s.recognizedAt}>
                          {formatDayShort(s.recognizedAt)}, {formatTime(s.recognizedAt)}
                        </time>
                      </span>
                      {refunded ? (
                        <StatusPill status={saleStatusTone(s.status)}>
                          {saleStatusLabel(s.status)}
                        </StatusPill>
                      ) : null}
                      {s.restockedLines > 0 ? <Badge tone="info">Restocked</Badge> : null}
                      {s.hasConsignment ? <Badge>Consigned</Badge> : null}
                    </span>
                    <span className="font-medium break-words">
                      {s.firstDescription}
                      {more}
                    </span>
                    <span className="text-sm text-dust-500">
                      {s.customer ? s.customer.label : "Walk-in"}
                    </span>
                    {costs && s.yieldTotal !== null && s.cultCommons !== null ? (
                      <span className="text-dense text-dust-700 tabular-nums">
                        Yield {formatMoney(s.yieldTotal)} · Cult Commons{" "}
                        {formatMoney(s.cultCommons)}
                      </span>
                    ) : null}
                    {costs && s.shopifyFees ? (
                      // D274: an online sale's Shopify fees and net Cult Commons.
                      <span className="text-dense text-dust-700 tabular-nums">
                        {saleShopifyFeeLine(s.shopifyFees)}
                      </span>
                    ) : null}
                  </span>
                  <span className="shrink-0 font-semibold tabular-nums">
                    {formatMoney(s.saleTotal)}
                  </span>
                  <ChevronRightIcon className="size-5 shrink-0 text-dust-500" />
                </RowLink>
              );
            })}
          </RowList>
        )}
      </section>
    </>
  );
}
