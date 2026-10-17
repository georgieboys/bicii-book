import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import {
  PaymentItemList,
  PaymentItemTable,
  PaymentsEmpty,
} from "@/components/domain/reports/payment-sections";
import { ExportLink } from "@/components/domain/reports/report-sections";
import { SectionLoader, SectionSkeleton } from "@/components/domain/today/section-loader";
import { ChevronLeftIcon } from "@/components/ui/icons";
import { requireStaff } from "@/lib/auth/session";
import { shopToday } from "@/lib/dates";
import { getPaymentItems, getPaymentSummary } from "@/lib/domain/payment-reports";
import {
  COUNTER_RECORDED_NOTE,
  MOVEMENT_LABELS,
  PAYMENTS_NOT_SALES_NOTE,
  PAYMENTS_SECTION_TITLE,
  movementCount,
  parsePaymentCursor,
} from "@/lib/payment-reports";
import {
  formatRangeLabel,
  parseReportParams,
  reportHref,
  reportParams,
} from "@/lib/period-reports";
import { exportHref } from "@/lib/report-exports";
import { formatSignedMoney } from "@/lib/reports";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Customer payments" };

/** Movements per page. */
const PAYMENT_ROWS = 100;

/**
 * Every movement of customer money in the period (Phase 14 step 3; PLAN
 * D154a–e): money taken online, refunded online, recorded at the counter
 * and given back at the counter, by the day it moved (not sales, not by
 * the date basis), newest first, 100 at a time by the keyset (`after_at`,
 * `after_id`, report_payment_items). Modelled on /reports/lines:
 * view_financial_reports only, a real 403 without it (requireStaff runs
 * before anything streams; no loading.tsx, DESIGN "Loading"), and a cursor
 * that is half there or malformed is the not-found screen.
 */
export default async function ReportPaymentsPage({ searchParams }: PageProps<"/reports/payments">) {
  await requireStaff("view_financial_reports");
  const sp = await searchParams;
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const report = parseReportParams(sp, shopToday());
  const cursor = parsePaymentCursor(first(sp.after_at), first(sp.after_id));
  if (cursor === "invalid") notFound();

  const supabase = await createClient();
  const summary = await getPaymentSummary(supabase, report.from, report.to);
  const params = reportParams(report);
  const c = summary.currency;
  const range = formatRangeLabel(report.from, report.to);
  const count = movementCount(summary);

  const figures: { label: string; value: string }[] = [
    { label: "Net taken", value: formatSignedMoney(summary.netTotal, c) },
    { label: MOVEMENT_LABELS.online_payment, value: formatSignedMoney(summary.onlineTotal, c) },
    { label: MOVEMENT_LABELS.online_refund, value: formatSignedMoney(summary.refundTotal, c) },
    { label: MOVEMENT_LABELS.counter_payment, value: formatSignedMoney(summary.counterTotal, c) },
    {
      label: MOVEMENT_LABELS.counter_given_back,
      value: formatSignedMoney(summary.givenBackTotal, c),
    },
  ];

  return (
    <>
      <header className="flex flex-col gap-3 pt-6 pb-2">
        <p>
          <Link
            href={`${reportHref("/reports", params)}#reports-payments`}
            className="inline-flex min-h-tap items-center gap-1 text-sm font-semibold underline"
          >
            <ChevronLeftIcon className="size-4" />
            Reports
          </Link>
        </p>
        <p className="eyebrow text-dust-500">{range} · by the day the money moved</p>
        <h1 className="text-4xl sm:text-5xl">{PAYMENTS_SECTION_TITLE}</h1>
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm tabular-nums">
          {figures.map((f) => (
            <div key={f.label} className="flex gap-1">
              <dt className="text-dust-500">{f.label}</dt>
              <dd className="font-semibold">{f.value}</dd>
            </div>
          ))}
          <div className="flex gap-1">
            <dt className="text-dust-500">Movements</dt>
            <dd className="font-semibold">{count}</dd>
          </div>
        </dl>
        <p className="text-sm text-dust-700">
          {PAYMENTS_NOT_SALES_NOTE} {COUNTER_RECORDED_NOTE}
        </p>
      </header>

      <section aria-labelledby="report-payments" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <h2 id="report-payments" className="text-2xl">
            Payments
          </h2>
          <ExportLink href={exportHref("payments", params)} name="customer payments" />
        </div>
        <Suspense
          key={cursor ? `${cursor.at}|${cursor.id}` : "newest"}
          fallback={<SectionSkeleton rows={8} />}
        >
          <SectionLoader
            name="report-payment-items"
            load={() =>
              getPaymentItems(supabase, {
                from: report.from,
                to: report.to,
                limit: PAYMENT_ROWS,
                after: cursor,
              })
            }
          >
            {({ items, nextCursor }) =>
              items.length === 0 && !cursor ? (
                <PaymentsEmpty />
              ) : (
                <>
                  <PaymentItemList items={items} />
                  <PaymentItemTable items={items} caption={`Customer payments, ${range}`} />
                  <div className="flex flex-wrap gap-4 text-sm">
                    {cursor ? (
                      <Link
                        href={reportHref("/reports/payments", params)}
                        className="inline-flex min-h-tap items-center font-semibold underline"
                      >
                        Back to newest
                      </Link>
                    ) : null}
                    {nextCursor ? (
                      <Link
                        href={reportHref("/reports/payments", params, {
                          after_at: nextCursor.at,
                          after_id: nextCursor.id,
                        })}
                        className="inline-flex min-h-tap items-center font-semibold underline"
                      >
                        Next {PAYMENT_ROWS}
                      </Link>
                    ) : null}
                  </div>
                </>
              )
            }
          </SectionLoader>
        </Suspense>
      </section>
    </>
  );
}
