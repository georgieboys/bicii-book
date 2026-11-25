import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { ExportLink, lineDate } from "@/components/domain/reports/report-sections";
import { SectionLoader, SectionSkeleton } from "@/components/domain/today/section-loader";
import { ChevronLeftIcon } from "@/components/ui/icons";
import { hasPermission } from "@/lib/auth/permissions";
import { requireStaff } from "@/lib/auth/session";
import { shopToday } from "@/lib/dates";
import { getBreakdownRow, getLineItems, getPeriodSummary } from "@/lib/domain/period-reports";
import { cn } from "@/lib/cn";
import { formatQuantity, toDecimal } from "@/lib/money";
import {
  BASES,
  DIMENSIONS,
  formatRangeLabel,
  isReportKey,
  parseReportParams,
  reportHref,
  reportParams,
  type LineCursor,
  type ReportLine,
} from "@/lib/period-reports";
import { exportHref } from "@/lib/report-exports";
import { formatSignedMoney } from "@/lib/reports";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Report lines" };

/** Lines per page. */
const LINE_ROWS = 100;

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:?\d{2})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const isNegative = (v: string | null) => v !== null && toDecimal(v).isNegative();

/**
 * The lines of one breakdown group (Phase 9; SPEC §19.2 drill-down; PLAN
 * D100–D104): the /reports parameters plus `by` and `key`, newest basis
 * date first, 100 at a time by the keyset (`after_at`, `after_id`).
 * view_financial_reports only: a real 403 without it (requireStaff runs
 * before anything streams; no loading.tsx, DESIGN "Loading"). A key that
 * fits no group of the period is the not-found screen.
 */
export default async function ReportLinesPage({ searchParams }: PageProps<"/reports/lines">) {
  const staff = await requireStaff("view_financial_reports");
  const sp = await searchParams;
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const report = parseReportParams(sp, shopToday());
  const key = first(sp.key);
  if (!key || !isReportKey(report.by, key)) notFound();

  const supabase = await createClient();
  const summary = await getPeriodSummary(supabase, report.from, report.to, report.basis);
  const group = await getBreakdownRow(
    supabase,
    report.from,
    report.to,
    report.basis,
    report.by,
    key,
    summary.currency,
    report.period,
    report.anchor,
  );
  if (!group) notFound();

  const showCosts = hasPermission(staff, "view_costs") && group.yieldTotal !== null;
  const params = reportParams(report);
  const afterAt = first(sp.after_at);
  const afterId = first(sp.after_id);
  const cursor: LineCursor | null =
    afterAt && afterId && ISO_INSTANT.test(afterAt) && UUID.test(afterId)
      ? { at: afterAt, id: afterId }
      : null;
  const here = { ...params, key };
  const c = group.currency;

  return (
    <>
      <header className="flex flex-col gap-3 pt-6 pb-2">
        <p>
          <Link
            href={`${reportHref("/reports", params)}#reports-breakdown`}
            className="inline-flex min-h-tap items-center gap-1 text-sm font-semibold underline"
          >
            <ChevronLeftIcon className="size-4" />
            Reports
          </Link>
        </p>
        <p className="eyebrow text-dust-500">
          {DIMENSIONS[report.by].label} · {formatRangeLabel(report.from, report.to)} ·{" "}
          {BASES[report.basis].label} basis
        </p>
        <h1 className="text-4xl sm:text-5xl">{group.label}</h1>
        {group.detail ? <p className="text-dust-700">{group.detail}</p> : null}
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm tabular-nums">
          <div className="flex gap-1">
            <dt className="text-dust-500">Gross</dt>
            <dd className="font-semibold">{formatSignedMoney(group.saleTotal, c)}</dd>
          </div>
          <div className="flex gap-1">
            <dt className="text-dust-500">Lines</dt>
            <dd className="font-semibold">{group.lineCount}</dd>
          </div>
          {showCosts ? (
            <>
              <div className="flex gap-1">
                <dt className="text-dust-500">Yield</dt>
                <dd
                  className={cn(
                    "font-semibold",
                    isNegative(group.yieldTotal) && "text-danger-deep",
                  )}
                >
                  {formatSignedMoney(group.yieldTotal!, c)}
                </dd>
              </div>
              <div className="flex gap-1">
                <dt className="text-dust-500">Cult Commons</dt>
                <dd className="font-semibold">{formatSignedMoney(group.cultCommons!, c)}</dd>
              </div>
            </>
          ) : null}
        </dl>
      </header>

      <section aria-labelledby="report-lines" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <h2 id="report-lines" className="text-2xl">
            Lines
          </h2>
          <ExportLink
            href={exportHref("lines", params, { key })}
            name={`every line of ${group.label}`}
          />
        </div>
        <Suspense key={cursor?.id ?? "newest"} fallback={<SectionSkeleton rows={8} />}>
          <SectionLoader
            name="report-lines"
            load={() =>
              getLineItems(supabase, {
                from: report.from,
                to: report.to,
                basis: report.basis,
                dimension: report.by,
                key,
                limit: LINE_ROWS,
                after: cursor,
              })
            }
          >
            {({ items, nextCursor }) => (
              <>
                <LineList lines={items} showCosts={showCosts} />
                <LineTable
                  lines={items}
                  showCosts={showCosts}
                  caption={`Lines of ${group.label}`}
                />
                <div className="flex flex-wrap gap-4 text-sm">
                  {cursor ? (
                    <Link
                      href={reportHref("/reports/lines", here)}
                      className="inline-flex min-h-tap items-center font-semibold underline"
                    >
                      Back to newest
                    </Link>
                  ) : null}
                  {nextCursor ? (
                    <Link
                      href={reportHref("/reports/lines", here, {
                        after_at: nextCursor.at,
                        after_id: nextCursor.id,
                      })}
                      className="inline-flex min-h-tap items-center font-semibold underline"
                    >
                      Next {LINE_ROWS}
                    </Link>
                  ) : null}
                </div>
              </>
            )}
          </SectionLoader>
        </Suspense>
      </section>
    </>
  );
}

/** The document number, linked to its job or sale. */
function DocumentLink({ line }: { line: ReportLine }) {
  return line.documentHref ? (
    <Link href={line.documentHref} className="font-semibold underline-offset-2 hover:underline">
      {line.documentNumber}
    </Link>
  ) : (
    <span className="font-semibold">{line.documentNumber}</span>
  );
}

/**
 * D273: a completed job's Stripe fee entry (view costs only) is not a sold
 * line: it reads as the deduction, with what Cult Commons bore and the
 * part BICII bears when the fees were more than the job's share.
 */
const isFee = (l: ReportLine) => l.lineType === "stripe_fee" || l.lineType === "shopify_fee";

/** D274: an online sale's or a job's share of its order's Shopify Payments fees reads the same way. */
function feeText(l: ReportLine): string {
  const shopify = l.lineType === "shopify_fee";
  const fee = formatSignedMoney((shopify ? l.shopifyFee : l.stripeFee) ?? "0", l.currency);
  const borne = l.cultCommons === null ? null : toDecimal(l.cultCommons).negated().toFixed(2);
  const bicii = l.afterCc === null ? null : toDecimal(l.afterCc).negated().toFixed(2);
  return [
    `${shopify ? "Shopify fees" : "Stripe fees"} (less GST) ${fee}`,
    borne !== null ? `borne by Cult Commons ${formatSignedMoney(borne, l.currency)}` : null,
    bicii !== null && !toDecimal(bicii).isZero()
      ? `by BICII ${formatSignedMoney(bicii, l.currency)}`
      : null,
  ]
    .filter(Boolean)
    .join(", ");
}

/** Phones: one card row per line. */
function LineList({ lines, showCosts }: { lines: readonly ReportLine[]; showCosts: boolean }) {
  return (
    <ul
      aria-label="Lines"
      className="divide-y divide-hairline rounded-2xl border border-hairline bg-card md:hidden"
    >
      {lines.map((l) =>
        isFee(l) ? (
          <li key={l.sourceLineId} className="flex flex-col gap-0.5 px-4 py-3">
            <span className="min-w-0">{feeText(l)}</span>
            <div className="text-sm text-dust-500">
              <DocumentLink line={l} /> · {lineDate(l)}
            </div>
          </li>
        ) : (
          <li key={l.sourceLineId} className="flex flex-col gap-0.5 px-4 py-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate">{l.description}</span>
              <span className="shrink-0 font-semibold tabular-nums">
                {formatSignedMoney(l.saleTotal, l.currency)}
              </span>
            </div>
            <div className="text-sm text-dust-500">
              <DocumentLink line={l} /> · {lineDate(l)}
            </div>
            <div className="text-sm text-dust-700 tabular-nums">
              {formatQuantity(l.quantity)} × {formatSignedMoney(l.unitSalePrice, l.currency)}
              {showCosts && l.yieldTotal !== null && l.cultCommons !== null ? (
                <span className={isNegative(l.yieldTotal) ? "text-danger-deep" : undefined}>
                  {" "}
                  · Yield {formatSignedMoney(l.yieldTotal, l.currency)} · CC{" "}
                  {formatSignedMoney(l.cultCommons, l.currency)}
                </span>
              ) : null}
              {l.costPending ? <span className="text-waiting-deep"> · cost pending</span> : null}
            </div>
          </li>
        ),
      )}
    </ul>
  );
}

/** md and up: a dense table. */
function LineTable({
  lines,
  showCosts,
  caption,
}: {
  lines: readonly ReportLine[];
  showCosts: boolean;
  caption: string;
}) {
  const th = "px-3 py-2 font-semibold";
  return (
    <div className="hidden max-h-[75dvh] overflow-auto rounded-2xl border border-hairline bg-card md:block">
      <table className="w-full text-sm tabular-nums [&_thead_th]:whitespace-nowrap">
        <caption className="sr-only">{caption}</caption>
        <thead className="sticky top-0 bg-card text-left">
          <tr className="border-b border-hairline">
            <th scope="col" className={th}>
              Date
            </th>
            <th scope="col" className={th}>
              Document
            </th>
            <th scope="col" className={th}>
              Description
            </th>
            <th scope="col" className={cn(th, "text-right")}>
              Qty
            </th>
            <th scope="col" className={cn(th, "text-right")}>
              Unit price
            </th>
            <th scope="col" className={cn(th, "text-right")}>
              Gross
            </th>
            {showCosts ? (
              <>
                <th scope="col" className={cn(th, "text-right")}>
                  Cost
                </th>
                <th scope="col" className={cn(th, "text-right")}>
                  Yield
                </th>
                <th scope="col" className={cn(th, "text-right")}>
                  Cult Commons
                </th>
              </>
            ) : null}
          </tr>
        </thead>
        <tbody className="divide-y divide-hairline">
          {lines.map((l) => (
            <tr key={l.sourceLineId}>
              <td className="px-3 py-2 whitespace-nowrap">{lineDate(l)}</td>
              <td className="px-3 py-2 whitespace-nowrap">
                <DocumentLink line={l} />
              </td>
              <td className="min-w-56 px-3 py-2">
                {isFee(l) ? feeText(l) : l.description}
                {l.costPending ? <span className="text-waiting-deep"> · cost pending</span> : null}
              </td>
              <td className="px-3 py-2 text-right">
                {isFee(l) ? "—" : formatQuantity(l.quantity)}
              </td>
              <td className="px-3 py-2 text-right">
                {isFee(l) ? "—" : formatSignedMoney(l.unitSalePrice, l.currency)}
              </td>
              <td className="px-3 py-2 text-right">{formatSignedMoney(l.saleTotal, l.currency)}</td>
              {showCosts ? (
                <>
                  <td className="px-3 py-2 text-right">
                    {l.costTotal === null ? "—" : formatSignedMoney(l.costTotal, l.currency)}
                  </td>
                  <td
                    className={cn(
                      "px-3 py-2 text-right",
                      isNegative(l.yieldTotal) && "text-danger-deep",
                    )}
                  >
                    {l.yieldTotal === null ? "—" : formatSignedMoney(l.yieldTotal, l.currency)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {l.cultCommons === null ? "—" : formatSignedMoney(l.cultCommons, l.currency)}
                  </td>
                </>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
