import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { HeldOnJobs, PaymentSummaryFigures } from "@/components/domain/reports/payment-sections";
import { BasisControl, ReportControls } from "@/components/domain/reports/report-controls";
import {
  ActivityFigures,
  BreakdownView,
  DimensionStrip,
  ExportLink,
  ForeignCurrencyNote,
  MechanicList,
  ReportEmpty,
  ReportSection,
  SaleBasisFigures,
  SeriesList,
  StockValueCard,
  SummaryTiles,
} from "@/components/domain/reports/report-sections";
import { SectionLoader, SectionSkeleton } from "@/components/domain/today/section-loader";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import { RowLink, RowList } from "@/components/ui/row-list";
import { ChevronRightIcon } from "@/components/ui/icons";
import { hasPermission } from "@/lib/auth/permissions";
import { requireStaff } from "@/lib/auth/session";
import { shopToday } from "@/lib/dates";
import {
  getActivity,
  getActivityByMechanic,
  getBreakdown,
  getPeriodSeries,
  getPeriodSummary,
  getStockValue,
} from "@/lib/domain/period-reports";
import {
  BASES,
  DIMENSIONS,
  autoGrain,
  emptyCopy,
  formatRangeLabel,
  parseReportParams,
  reportHref,
  reportParams,
  type BreakdownCursor,
  type ReportParams,
} from "@/lib/period-reports";
import { getPaymentSummary, getPaymentsHeld } from "@/lib/domain/payment-reports";
import { getExceptionCounts } from "@/lib/domain/reconciliation";
import { logger } from "@/lib/logger";
import { exceptionTotal } from "@/lib/reconciliation";
import { exportHref } from "@/lib/report-exports";
import { createClient, type ServerSupabase } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Reports" };

/** Breakdown groups per page. */
const BREAKDOWN_ROWS = 25;

/**
 * Reports (Phase 9; SPEC §19.2, §21, §22; PLAN D30, D100–D105; ADR-022):
 * a period (day, ISO week, month or custom range) on a date basis, with
 * its figures, buckets, breakdown, stock at cost now and activity. All
 * state is in the URL (`period, date, from, to, basis, by` and the
 * breakdown cursor `after_total, after_key`).
 *
 * No loading.tsx under /reports (DESIGN "Loading"): a loading boundary
 * commits a 200 before a child page's forbidden() runs. requireStaff()
 * runs first; each section then streams in its own Suspense boundary.
 * Financial content needs view_financial_reports; cost-derived figures
 * need view_costs, which the database enforces (NULL otherwise, D30) and
 * the layout follows. Activity is for every active staff member.
 * Customer payments (Phase 14 step 3, D154) sits in the financial part
 * but outside Figures: money held, not sales, and not driven by the basis.
 */
export default async function ReportsPage({ searchParams }: PageProps<"/reports">) {
  const staff = await requireStaff();
  const sp = await searchParams;
  const today = shopToday();
  const report = parseReportParams(sp, today);
  const financial = hasPermission(staff, "view_financial_reports");
  const showCosts = financial && hasPermission(staff, "view_costs");
  const supabase = await createClient();
  const params = reportParams(report);
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const afterTotal = first(sp.after_total);
  const afterKey = first(sp.after_key);
  const cursor: BreakdownCursor | null =
    afterTotal && afterKey && /^-?\d+(\.\d+)?$/.test(afterTotal)
      ? { saleTotal: afterTotal, key: afterKey }
      : null;
  const range = formatRangeLabel(report.from, report.to);

  return (
    <>
      <PageHeader title="Reports" />
      <ReportControls
        period={report.period}
        anchor={report.anchor}
        from={report.from}
        to={report.to}
        today={today}
        error={report.error}
      />

      {financial ? (
        <FinancialSection
          supabase={supabase}
          report={report}
          params={params}
          cursor={cursor}
          showCosts={showCosts}
          range={range}
        />
      ) : (
        <p className="text-dust-700">
          Sales, yield and Cult Commons figures need the View financial reports permission.
        </p>
      )}

      <ReportSection
        id="reports-activity"
        title="Activity"
        description={`Jobs, appointments and stock movements in ${range}.`}
      >
        <Suspense fallback={<SectionSkeleton rows={4} />}>
          <SectionLoader name="report-activity" load={() => getActivity(supabase, report)}>
            {(activity) => <ActivityFigures activity={activity} />}
          </SectionLoader>
        </Suspense>
        <div className="flex flex-wrap items-end justify-between gap-2">
          <h3 className="text-lg">By mechanic</h3>
          <ExportLink href={exportHref("mechanics", params)} name="jobs by mechanic" />
        </div>
        <Suspense fallback={<SectionSkeleton rows={3} />}>
          <SectionLoader
            name="report-mechanics"
            load={() => getActivityByMechanic(supabase, report)}
          >
            {(rows) => <MechanicList rows={rows} />}
          </SectionLoader>
        </Suspense>
      </ReportSection>

      <nav aria-label="More reports" className="mb-4">
        <RowList>
          <RowLink href="/reports/exceptions">
            <span className="flex-1 font-semibold">Exceptions</span>
            <Suspense fallback={null}>
              <ExceptionCountBadge supabase={supabase} />
            </Suspense>
            <ChevronRightIcon className="size-5 text-dust-500" />
          </RowLink>
          <RowLink href="/reports/reconciliation">
            <span className="flex-1 font-semibold">Stock reconciliation</span>
            <ChevronRightIcon className="size-5 text-dust-500" />
          </RowLink>
        </RowList>
      </nav>
    </>
  );
}

/**
 * How many exceptions the caller may see (report_exception_counts, D108),
 * on the Exceptions link; nothing while it loads or if the read fails.
 */
async function ExceptionCountBadge({ supabase }: { supabase: ServerSupabase }) {
  let total: number;
  try {
    total = exceptionTotal(await getExceptionCounts(supabase));
  } catch (err) {
    logger.error({ err, section: "report-exception-count" }, "report section failed to load");
    return null;
  }
  return (
    <Badge tone={total > 0 ? "waiting" : "neutral"}>
      {total}
      <span className="sr-only">{total === 1 ? " exception" : " exceptions"}</span>
    </Badge>
  );
}

/**
 * The financial section (view_financial_reports): basis, figures, buckets,
 * breakdown, customer payments, stock value.
 */
async function FinancialSection({
  supabase,
  report,
  params,
  cursor,
  showCosts,
  range,
}: {
  supabase: ServerSupabase;
  report: ReportParams;
  params: Record<string, string>;
  cursor: BreakdownCursor | null;
  showCosts: boolean;
  range: string;
}) {
  const grain = autoGrain(report.from, report.to);
  const basisLabel = BASES[report.basis].label;
  const dimensionLabel = DIMENSIONS[report.by].label;
  return (
    <>
      <ReportSection
        id="reports-figures"
        title="Figures"
        description={`${range} on the ${basisLabel} basis.`}
      >
        <BasisControl basis={report.basis} />
        <Suspense fallback={<SectionSkeleton rows={3} />}>
          <SectionLoader
            name="report-summary"
            load={() => getPeriodSummary(supabase, report.from, report.to, report.basis)}
          >
            {(summary) => (
              <>
                <SummaryTiles summary={summary} showCosts={showCosts} />
                {report.basis === "sale" ? (
                  <SaleBasisFigures summary={summary} showCosts={showCosts} />
                ) : null}
                <ForeignCurrencyNote count={summary.excludedForeignLineCount} />
              </>
            )}
          </SectionLoader>
        </Suspense>
      </ReportSection>

      {grain ? (
        <ReportSection
          id="reports-series"
          title="Over the period"
          actions={<ExportLink href={exportHref("series", params)} name="the period by bucket" />}
        >
          <Suspense fallback={<SectionSkeleton rows={5} />}>
            <SectionLoader
              name="report-series"
              load={async () => {
                const summary = await getPeriodSummary(
                  supabase,
                  report.from,
                  report.to,
                  report.basis,
                );
                return getPeriodSeries(supabase, { ...report, grain }, summary.currency);
              }}
            >
              {(buckets) => <SeriesList buckets={buckets} grain={grain} showCosts={showCosts} />}
            </SectionLoader>
          </Suspense>
        </ReportSection>
      ) : null}

      <ReportSection
        id="reports-breakdown"
        title="Breakdown"
        actions={
          <ExportLink
            href={exportHref("breakdown", params)}
            name={`breakdown by ${dimensionLabel}`}
          />
        }
      >
        <DimensionStrip params={params} by={report.by} />
        <Suspense key={`${report.by}-${cursor?.key ?? ""}`} fallback={<SectionSkeleton rows={6} />}>
          <SectionLoader
            name="report-breakdown"
            load={async () => {
              const summary = await getPeriodSummary(
                supabase,
                report.from,
                report.to,
                report.basis,
              );
              const page =
                summary.lineCount === 0
                  ? null
                  : await getBreakdown(supabase, {
                      ...report,
                      dimension: report.by,
                      currency: summary.currency,
                      limit: BREAKDOWN_ROWS,
                      after: cursor,
                    });
              return { summary, page };
            }}
          >
            {({ page }) =>
              page === null ? (
                <ReportEmpty copy={emptyCopy(report.basis)} />
              ) : (
                <>
                  <BreakdownView
                    rows={page.items}
                    dimension={report.by}
                    showCosts={showCosts}
                    caption={`Breakdown by ${dimensionLabel}`}
                  />
                  {page.more || cursor ? (
                    <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                      <span className="text-dust-500">
                        {cursor
                          ? `Showing the next ${page.items.length}`
                          : `Showing the top ${page.items.length}`}
                      </span>
                      <span className="flex gap-4">
                        {cursor ? (
                          <Link
                            href={`${reportHref("/reports", params)}#reports-breakdown`}
                            className="inline-flex min-h-tap items-center font-semibold underline"
                          >
                            Back to the top
                          </Link>
                        ) : null}
                        {page.nextCursor ? (
                          <Link
                            href={`${reportHref("/reports", params, {
                              after_total: page.nextCursor.saleTotal,
                              after_key: page.nextCursor.key,
                            })}#reports-breakdown`}
                            className="inline-flex min-h-tap items-center font-semibold underline"
                          >
                            Show more
                          </Link>
                        ) : null}
                      </span>
                    </div>
                  ) : null}
                </>
              )
            }
          </SectionLoader>
        </Suspense>
      </ReportSection>

      <ReportSection
        id="reports-payments"
        title="Customer payments"
        description={`Money taken and given back in ${range}, by the day it moved, whatever the basis.`}
        actions={<ExportLink href={exportHref("payments", params)} name="customer payments" />}
      >
        <Suspense fallback={<SectionSkeleton rows={3} />}>
          <SectionLoader
            name="report-payments"
            load={() => getPaymentSummary(supabase, report.from, report.to)}
          >
            {(summary) => <PaymentSummaryFigures summary={summary} />}
          </SectionLoader>
        </Suspense>
        <p>
          <Link
            href={reportHref("/reports/payments", params)}
            className="inline-flex min-h-tap items-center gap-1 text-sm font-semibold underline"
          >
            See each payment
            <ChevronRightIcon className="size-4" />
          </Link>
        </p>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-2">
          <div className="flex min-w-0 flex-col gap-1">
            <h3 id="reports-payments-held" className="text-lg">
              Held on jobs now
            </h3>
            <p className="text-sm text-dust-500">
              What is held at this moment, whatever period is chosen above.
            </p>
          </div>
          <ExportLink href={exportHref("payments_held", {})} name="money held on jobs now" />
        </div>
        <Suspense fallback={<SectionSkeleton rows={4} />}>
          <SectionLoader name="report-payments-held" load={() => getPaymentsHeld(supabase)}>
            {(rows) => <HeldOnJobs rows={rows} />}
          </SectionLoader>
        </Suspense>
      </ReportSection>

      <ReportSection
        id="reports-stock"
        title="Stock at cost now"
        description="What is in stock at this moment, whatever period is chosen above."
        actions={<ExportLink href={exportHref("stock_value", params)} name="stock at cost now" />}
      >
        <Suspense fallback={<SectionSkeleton rows={2} />}>
          <SectionLoader name="report-stock-value" load={() => getStockValue(supabase)}>
            {(rows) => <StockValueCard rows={rows} showCosts={showCosts} />}
          </SectionLoader>
        </Suspense>
      </ReportSection>
    </>
  );
}
