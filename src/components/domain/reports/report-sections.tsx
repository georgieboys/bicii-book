import Link from "next/link";
import type { ReactNode } from "react";

import { MoneyTile, StatTile } from "@/components/domain/today/stat-tile";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { RowLink, RowList } from "@/components/ui/row-list";
import { cn } from "@/lib/cn";
import { formatShopDay, toShopLocal } from "@/lib/dates";
import { formatMoney, formatQuantity, toDecimal } from "@/lib/money";
import {
  DIMENSIONS,
  DIMENSION_VALUES,
  OWNERSHIP_LABELS,
  formatBucketLabel,
  formatDuration,
  reportHref,
  type BreakdownRow,
  type MechanicActivity,
  type PeriodActivity,
  type PeriodSummary,
  type ReportDimension,
  type ReportGrain,
  type ReportLine,
  type SeriesBucket,
  type StockValueRow,
} from "@/lib/period-reports";
import { plural } from "@/lib/plural";
import { formatSignedMoney, provisionalNote } from "@/lib/reports";

/**
 * The server-rendered parts of /reports and /reports/lines (Phase 9; SPEC
 * §19.2, §21, §22; DESIGN "Reports"). Every amount arrives as a fixed-2
 * string computed by Postgres; nothing here adds money up. A cost-derived
 * figure the database withheld (D30) is null: its tile or column is not
 * rendered at all, never shown as 0. `showCosts` (hasPermission
 * view_costs) only chooses the layout.
 */

const isNegative = (amount: string | null) => amount !== null && toDecimal(amount).isNegative();

/**
 * An "Export CSV" link (SPEC §22, ADR-001 A7). A plain <a>, never
 * next/link: Link prefetches what it shows, and a prefetch here would run
 * the export. target=_blank so the iOS standalone PWA opens the file in
 * Safari's viewer (with Share and Save to Files) instead of replacing the
 * app with it.
 */
export function ExportLink({ href, name }: { href: string; name: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener"
      aria-label={`Export CSV: ${name}`}
      className={buttonClasses({ variant: "outline", size: "sm" })}
    >
      Export CSV
    </a>
  );
}

/** A Reports section: an h2, a description and actions on the right. */
export function ReportSection({
  id,
  title,
  description,
  actions,
  children,
  className,
}: {
  id: string;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section aria-labelledby={id} className={cn("flex scroll-mt-32 flex-col gap-3", className)}>
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id={id} className="text-2xl leading-tight">
            {title}
          </h2>
          {description ? <p className="text-sm text-dust-500">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

const tileGrid = "grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6";

/** The period's figures (report_period_summary): gross and counts for all, costs with view_costs. */
export function SummaryTiles({
  summary,
  showCosts,
}: {
  summary: PeriodSummary;
  showCosts: boolean;
}) {
  const c = summary.currency;
  const costs = showCosts && summary.costTotal !== null;
  const provisional = provisionalNote(summary.costPendingLines);
  const feePending = summary.stripeFeePendingJobs;
  const fees =
    costs && summary.stripeFees !== null && !toDecimal(summary.stripeFees).isZero()
      ? summary.stripeFees
      : null;
  return (
    <div className="flex flex-col gap-2">
      <div role="group" aria-label="Period figures" className={tileGrid}>
        <MoneyTile label="Gross sales" amount={summary.saleTotal} currency={c} />
        <StatTile
          label="Jobs · sales · lines"
          value={`${summary.jobCount} · ${summary.saleCount} · ${summary.lineCount}`}
        />
        {costs ? (
          <>
            <MoneyTile label="Direct costs" amount={summary.costTotal!} currency={c} />
            <MoneyTile
              label="Yield"
              amount={summary.yieldTotal!}
              currency={c}
              tone={isNegative(summary.yieldTotal) ? "danger" : "neutral"}
              hint={
                isNegative(summary.yieldTotal) ? (
                  <span className="font-semibold text-danger-deep">Loss</span>
                ) : undefined
              }
            />
            <MoneyTile
              label="Cult Commons"
              amount={summary.cultCommons!}
              currency={c}
              hint={
                fees
                  ? `30% of each line's positive yield, less ${formatMoney(summary.stripeFeesBorne ?? "0", c)} of Stripe fees`
                  : "Sum of 30% of each line's positive yield"
              }
            />
            {fees ? (
              <MoneyTile
                label="Stripe fees"
                amount={fees}
                currency={c}
                hint="Borne by Cult Commons, up to each job's share"
              />
            ) : null}
            <MoneyTile label="BICII after Cult Commons" amount={summary.afterCc!} currency={c} />
          </>
        ) : null}
      </div>
      {costs ? null : (
        <p className="text-sm text-dust-700">
          Costs, yield and Cult Commons need the View costs permission.
        </p>
      )}
      {provisional ? (
        <p role="note" className="text-sm font-medium text-waiting-deep">
          {provisional}
        </p>
      ) : null}
      {costs && feePending > 0 ? (
        <p role="note" className="text-sm font-medium text-waiting-deep">
          {feePending === 1
            ? "Provisional: Stripe has not reported the fee on 1 job yet, so Cult Commons may still go down."
            : `Provisional: Stripe has not reported the fees on ${feePending} jobs yet, so Cult Commons may still go down.`}
        </p>
      ) : null}
    </div>
  );
}

/** One compact figure in the sale-basis row. */
function Figure({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-2xl border border-hairline bg-card px-4 py-3">
      <dt className="eyebrow text-dust-500">{label}</dt>
      <dd className="font-display text-xl font-extrabold tabular-nums">{value}</dd>
      {hint ? <dd className="text-sm text-dust-500">{hint}</dd> : null}
    </div>
  );
}

/**
 * The sale basis's second row (SPEC §19.1 over the period): consignment
 * sales; with view_costs new consignor liability, settlements paid and
 * purchases received (D105); refunds as their own line, never netted
 * (D102); and the foreign-currency exclusions (D104).
 */
export function SaleBasisFigures({
  summary,
  showCosts,
}: {
  summary: PeriodSummary;
  showCosts: boolean;
}) {
  const c = summary.currency;
  const m = (v: string) => formatSignedMoney(v, c);
  const count = summary.consignmentSales ?? 0;
  return (
    <div className="flex flex-col gap-2">
      <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {summary.consignmentSalesTotal !== null ? (
          <Figure
            label="Consignment sales"
            value={m(summary.consignmentSalesTotal)}
            hint={count === 1 ? "1 sale or job" : `${count} sales or jobs`}
          />
        ) : null}
        {showCosts && summary.newConsignorLiability !== null ? (
          <Figure label="New consignor liability" value={m(summary.newConsignorLiability)} />
        ) : null}
        {showCosts && summary.settlementsPaid !== null ? (
          <Figure label="Settlements paid" value={m(summary.settlementsPaid)} />
        ) : null}
        {showCosts && summary.purchasesReceived !== null ? (
          <Figure label="Received from suppliers" value={m(summary.purchasesReceived)} />
        ) : null}
      </dl>
      {summary.refundCount !== null && summary.refundCount > 0 && summary.refundsTotal !== null ? (
        <p role="note" className="text-sm font-medium">
          Refunds recorded: {m(summary.refundsTotal)} ({summary.refundCount}) — not deducted from
          the figures above
        </p>
      ) : null}
    </div>
  );
}

/** D104: lines in another currency are left out of every total, and said so. */
export function ForeignCurrencyNote({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <p role="note" className="text-sm font-medium text-waiting-deep">
      {count === 1
        ? "1 line in another currency is left out of these totals."
        : `${count} lines in another currency are left out of these totals.`}{" "}
      <Link href="/reports/exceptions" className="inline-flex min-h-tap items-center underline">
        See exceptions
      </Link>
    </p>
  );
}

/**
 * The period in buckets (report_period_series): a date label, gross with
 * a thin bar proportional to the largest bucket's gross (presentation
 * only: the ratio of two database strings), and yield with view_costs.
 * Buckets cut by the range are marked partial.
 */
export function SeriesList({
  buckets,
  grain,
  showCosts,
}: {
  buckets: readonly SeriesBucket[];
  grain: ReportGrain;
  showCosts: boolean;
}) {
  const max = buckets.reduce(
    (top, b) => (toDecimal(b.saleTotal).greaterThan(top) ? toDecimal(b.saleTotal) : top),
    toDecimal(0),
  );
  const width = (gross: string) => {
    if (max.isZero()) return "0%";
    const ratio = toDecimal(gross).dividedBy(max);
    const pct = Math.max(0, Math.min(1, ratio.toNumber())) * 100;
    return `${pct.toFixed(1)}%`;
  };
  return (
    <ol
      aria-label="By bucket"
      className="flex flex-col divide-y divide-hairline rounded-2xl border border-hairline bg-card"
    >
      {buckets.map((b) => (
        <li key={b.start} className="flex flex-col gap-1 px-4 py-2">
          <div className="flex items-baseline justify-between gap-3">
            <span className="flex items-center gap-2 text-sm font-semibold">
              {formatBucketLabel(grain, b.start, b.end)}
              {b.partial ? <Badge>partial</Badge> : null}
            </span>
            <span className="flex flex-wrap justify-end gap-x-3 text-sm tabular-nums">
              <span>{formatSignedMoney(b.saleTotal, b.currency)}</span>
              {showCosts && b.yieldTotal !== null ? (
                <span className={isNegative(b.yieldTotal) ? "text-danger-deep" : "text-dust-700"}>
                  Yield {formatSignedMoney(b.yieldTotal, b.currency)}
                </span>
              ) : null}
            </span>
          </div>
          <div aria-hidden="true" className="h-1.5 rounded-full bg-dust-100">
            <div className="h-full rounded-full bg-ink" style={{ width: width(b.saleTotal) }} />
          </div>
        </li>
      ))}
    </ol>
  );
}

/** The breakdown dimensions as a link strip (aria-current on the chosen one); a tap changes only `by`. */
export function DimensionStrip({
  params,
  by,
}: {
  params: Readonly<Record<string, string>>;
  by: ReportDimension;
}) {
  return (
    <nav
      aria-label="Break down by"
      className="-mx-4 [scrollbar-width:none] overflow-x-auto px-4 sm:mx-0 sm:px-0"
    >
      <ul className="flex gap-1">
        {DIMENSION_VALUES.map((d) => (
          <li key={d}>
            <Link
              href={reportHref("/reports", params, { by: d })}
              scroll={false}
              aria-current={d === by ? "page" : undefined}
              className={cn(
                "inline-flex min-h-tap items-center rounded-full px-4 font-display text-xs font-bold tracking-wide whitespace-nowrap uppercase",
                d === by ? "bg-ink text-paper" : "border border-hairline hover:bg-dust-100",
              )}
            >
              {DIMENSIONS[d].label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** Yield and Cult Commons in one line, a loss in danger-deep. */
function YieldLine({
  row,
}: {
  row: Pick<BreakdownRow, "yieldTotal" | "cultCommons" | "currency">;
}) {
  if (row.yieldTotal === null || row.cultCommons === null) return null;
  return (
    <span
      className={cn(
        "text-sm tabular-nums",
        isNegative(row.yieldTotal) ? "text-danger-deep" : "text-dust-700",
      )}
    >
      Yield {formatSignedMoney(row.yieldTotal, row.currency)} · CC{" "}
      {formatSignedMoney(row.cultCommons, row.currency)}
    </span>
  );
}

/**
 * One page of the breakdown: rows on phones, a dense table from md. The
 * job dimension opens the job or sale; every other group opens its lines.
 */
export function BreakdownView({
  rows,
  dimension,
  showCosts,
  caption,
}: {
  rows: readonly BreakdownRow[];
  dimension: ReportDimension;
  showCosts: boolean;
  caption: string;
}) {
  const qty = dimension === "product";
  return (
    <>
      <RowList label={caption} className="md:hidden">
        {rows.map((r) => (
          <RowLink key={r.key} href={r.href}>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex items-baseline justify-between gap-3">
                <span className="truncate font-semibold">{r.label}</span>
                <span className="shrink-0 font-semibold tabular-nums">
                  {formatSignedMoney(r.saleTotal, r.currency)}
                </span>
              </span>
              {r.detail ? <span className="truncate text-sm text-dust-500">{r.detail}</span> : null}
              {showCosts ? <YieldLine row={r} /> : null}
            </span>
          </RowLink>
        ))}
      </RowList>
      <div className="hidden max-h-[70dvh] overflow-auto rounded-2xl border border-hairline bg-card md:block">
        <table className="w-full text-sm tabular-nums [&_td]:whitespace-nowrap [&_thead_th]:whitespace-nowrap">
          <caption className="sr-only">{caption}</caption>
          <thead className="sticky top-0 bg-card text-left">
            <tr className="border-b border-hairline">
              <th scope="col" className="px-3 py-2 font-semibold">
                Name
              </th>
              <th scope="col" className="px-3 py-2 text-right font-semibold">
                Lines
              </th>
              {qty ? (
                <th scope="col" className="px-3 py-2 text-right font-semibold">
                  Qty
                </th>
              ) : null}
              <th scope="col" className="px-3 py-2 text-right font-semibold">
                Gross
              </th>
              {showCosts ? (
                <>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">
                    Cost
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">
                    Yield
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">
                    Cult Commons
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">
                    After CC
                  </th>
                </>
              ) : null}
            </tr>
          </thead>
          <tbody className="divide-y divide-hairline">
            {rows.map((r) => (
              <tr key={r.key}>
                <th scope="row" className="min-w-56 px-3 py-2 text-left font-normal">
                  <Link
                    href={r.href}
                    className="inline-flex min-h-tap flex-col justify-center underline-offset-2 hover:underline"
                  >
                    <span className="font-semibold">{r.label}</span>
                    {r.detail ? <span className="text-dust-500">{r.detail}</span> : null}
                  </Link>
                </th>
                <td className="px-3 py-2 text-right">{r.lineCount}</td>
                {qty ? (
                  <td className="px-3 py-2 text-right">
                    {r.quantity !== null ? formatQuantity(r.quantity) : "—"}
                  </td>
                ) : null}
                <td className="px-3 py-2 text-right">
                  {formatSignedMoney(r.saleTotal, r.currency)}
                </td>
                {showCosts ? (
                  <>
                    <MoneyCell value={r.costTotal} currency={r.currency} />
                    <MoneyCell value={r.yieldTotal} currency={r.currency} signed />
                    <MoneyCell value={r.cultCommons} currency={r.currency} />
                    <MoneyCell value={r.afterCc} currency={r.currency} signed />
                  </>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function MoneyCell({
  value,
  currency,
  signed = false,
}: {
  value: string | null;
  currency: string;
  /** A negative value (a loss) in danger-deep. */
  signed?: boolean;
}) {
  return (
    <td className={cn("px-3 py-2 text-right", signed && isNegative(value) && "text-danger-deep")}>
      {value === null ? "—" : formatSignedMoney(value, currency)}
    </td>
  );
}

/** The empty breakdown for a period with no lines on the basis. */
export function ReportEmpty({ copy }: { copy: string }) {
  const [first, ...rest] = copy.split(/(?<=\.) /);
  return <EmptyState title={first} description={rest.length > 0 ? rest.join(" ") : undefined} />;
}

/**
 * Stock at cost NOW (D105): quantity on hand and units per ownership, the
 * shop-owned items without a cost (not valued, D24 amended), and with
 * view_costs the shop-owned value at last cost. A figure for now, not for
 * the chosen period.
 */
export function StockValueCard({
  rows,
  showCosts,
}: {
  rows: readonly StockValueRow[];
  showCosts: boolean;
}) {
  return (
    <ul aria-label="Stock by ownership" className="grid gap-3 md:grid-cols-3">
      {rows.map((r) => (
        <li
          key={r.ownership}
          className="flex flex-col gap-1 rounded-2xl border border-hairline bg-card px-4 py-3"
        >
          <dl className="flex flex-col gap-1">
            <dt className="eyebrow text-dust-500">
              {OWNERSHIP_LABELS[r.ownership] ?? r.ownership}
            </dt>
            <dd className="tabular-nums">
              <span className="font-semibold">{r.quantityOnHand}</span> on hand ·{" "}
              <span className="font-semibold">{r.unitsInStock}</span>{" "}
              {r.unitsInStock === 1 ? "unit" : "units"} in stock
            </dd>
            {r.ownership === "shop_owned" ? (
              <>
                {showCosts && r.valueAtCost !== null ? (
                  <dd className="font-display text-2xl font-extrabold tabular-nums">
                    {formatSignedMoney(r.valueAtCost, r.currency)}{" "}
                    <span className="font-sans text-sm font-semibold text-dust-500">
                      {r.currency} at last cost
                    </span>
                  </dd>
                ) : null}
                {r.uncostedItems > 0 ? (
                  <dd className="text-sm font-medium text-waiting-deep">
                    {r.uncostedItems === 1
                      ? "1 item has no cost and is not valued"
                      : `${r.uncostedItems} items have no cost and are not valued`}
                  </dd>
                ) : null}
              </>
            ) : (
              <dd className="text-sm text-dust-500">
                Counted, not valued: not the shop&apos;s stock.
              </dd>
            )}
          </dl>
        </li>
      ))}
    </ul>
  );
}

/** The period's activity (report_activity): each job counted on its own stamp (D31). */
export function ActivityFigures({ activity }: { activity: PeriodActivity }) {
  const a = activity;
  return (
    <div className="flex flex-col gap-4">
      <div
        role="group"
        aria-label="Jobs"
        className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-7"
      >
        <StatTile label="Checked in" value={a.checkedIn} />
        <StatTile label="Started" value={a.started} />
        <StatTile label="Completed" value={a.completed} />
        <StatTile label="Ready for collection" value={a.readyForCollection} />
        <StatTile label="Collected" value={a.collected} />
        <StatTile label="Cancelled" value={a.cancelled} />
        <StatTile label="Open at end of period" value={a.openAtEnd} />
      </div>
      <p className="text-sm text-dust-500">Each counted on its own date.</p>
      <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Figure
          label="Check-in to completion"
          value={formatDuration(a.medianHoursToComplete)}
          hint="Median"
        />
        <Figure
          label="Completion to collection"
          value={formatDuration(a.medianHoursToCollect)}
          hint="Median"
        />
        <Figure
          label="Appointments"
          value={String(a.appointments.scheduled)}
          hint={`${a.appointments.arrived} arrived · ${plural(a.appointments.noShow, "no-show", "no-shows")} · ${a.appointments.cancelled} cancelled`}
        />
        <Figure
          label="Parts used"
          value={String(a.stock.partsConsumedQty)}
          hint={`${a.stock.partsReturnedQty} returned`}
        />
        <Figure
          label="Stock adjustments"
          value={String(a.stock.adjustments)}
          hint={
            a.stock.significantAdjustments > 0
              ? `${a.stock.significantAdjustments} significant`
              : undefined
          }
        />
        <Figure
          label="Deliveries received"
          value={String(a.stock.deliveries)}
          hint={a.stock.unitsReceived === 1 ? "1 unit" : `${a.stock.unitsReceived} units`}
        />
      </dl>
      <p className="text-sm text-dust-500">Appointments by the day they were booked for.</p>
    </div>
  );
}

/** Jobs per lead mechanic (D103): checked in, completed and collected in the period, open now. */
export function MechanicList({ rows }: { rows: readonly MechanicActivity[] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-dust-500">No jobs had a lead mechanic in this period.</p>;
  }
  return (
    <ul
      aria-label="By mechanic"
      className="divide-y divide-hairline rounded-2xl border border-hairline bg-card"
    >
      {rows.map((r) => (
        <li
          key={r.staffId}
          className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3"
        >
          <span className="font-semibold">
            {r.name}
            {r.active ? null : <Badge className="ml-2">Inactive</Badge>}
          </span>
          <span className="text-sm text-dust-700 tabular-nums">
            {r.checkedIn} checked in · {r.completed} completed · {r.collected} collected ·{" "}
            {r.openNow} open now
          </span>
        </li>
      ))}
    </ul>
  );
}

/** A line's basis date as a shop-local day and time ("Mon, 5 Oct 2026 14:05"). */
export function lineDate(line: Pick<ReportLine, "basisAt">): string {
  const local = toShopLocal(line.basisAt);
  return `${formatShopDay(local.slice(0, 10))} ${local.slice(11, 16)}`;
}
