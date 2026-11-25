import { formatShopDay } from "@/lib/dates";
import type { Totals } from "@/lib/domain/lines";
import { formatMoney, toDecimal } from "@/lib/money";
import { formatRateRange, lossNote, type WorkOrderYield } from "@/lib/reports";

/**
 * A job's running totals (SPEC §22: shown without obscuring the work, a
 * compact summary under the lines, not a modal). Everyone sees the sale
 * total; a view_costs holder also sees cost, yield, Cult Commons and
 * BICII's yield after it, from work_order_totals_staff (the database's
 * arithmetic, D1). `ccRate` labels the Cult Commons row when every line
 * shares one rate. While a live manual line has no cost entered (D14) the
 * cost-side figures count it at 0, so they are marked provisional.
 *
 * This is the job yield panel (PLAN Phase 5). With `report` (the job's
 * public.work_order_yield row, view_costs only, D30) it also shows the
 * Cult Commons rates the lines snapshotted ("30%", or "25–30%" when they
 * differ), a note when lines were sold at a loss (they never reduce
 * another line's Cult Commons, D1), and when the job counts in reports:
 * the shop day of its current completion (D32), "once the job is
 * completed" while it is open or after a reopen, or that it is never
 * counted once cancelled (final, D15; D32). Without view_costs the
 * page passes neither `report` nor costs, so only the sale total shows.
 *
 * D273: when the job has a paid Stripe payment, the Stripe fees (less
 * GST), what Cult Commons bears of them (never more than its share; none
 * on a cancelled job, BICII bears those), Cult Commons after them and
 * BICII's yield after both, all from the database. An open job's fees are
 * taken off when it is completed; a fee Stripe has not reported yet makes
 * the after-fees figures provisional, and while no fee is reported at all
 * the fee reads "Not reported yet" (never a known $0.00). A cancelled job
 * has no Cult Commons, so its after-fees Cult Commons reads "Not counted".
 *
 * D274: a job linked to an online build order also shows that order's
 * share of its Shopify Payments fees (less GST) and what Cult Commons bears
 * of it after the Stripe fees (one floor per job), the same way; with both
 * kinds the after-fees rows say "fees".
 */

/** The fee note for a job with fees (`which`: "Stripe fees", "Shopify fees" or "fees"): when they are deducted, and by whom. */
function feeNote(report: WorkOrderYield | null | undefined, which: string): string | null {
  if (!report) return null;
  if (report.status === "cancelled") {
    return `This job is cancelled, so BICII bears its ${which}, not Cult Commons.`;
  }
  if (!report.recognizedDay) {
    return `${which[0].toUpperCase()}${which.slice(1)} come off Cult Commons when the job is completed.`;
  }
  return null;
}
/** When the job counts in reports (D32): its completion day, never once cancelled, or later. */
function recognitionNote(report: WorkOrderYield): string {
  if (report.recognizedDay) {
    return `Counted in reports on ${formatShopDay(report.recognizedDay)} (completed)`;
  }
  if (report.status === "cancelled") return "Not counted in reports (cancelled)";
  return "Counted in reports once the job is completed";
}

export function TotalsSummary({
  totals,
  ccRate,
  report,
}: {
  totals: Totals;
  ccRate?: string | null;
  report?: WorkOrderYield | null;
}) {
  const money = (v: string) => formatMoney(v, totals.currency);
  const feePending = totals.costs?.stripeFeePendingCount ?? 0;
  const shopifyPending = totals.costs?.shopifyFeePendingCount ?? 0;
  const hasStripe =
    Boolean(totals.costs) &&
    (feePending > 0 || !toDecimal(totals.costs?.stripeFees ?? "0").isZero());
  // D274: the build order's share of its Shopify order's fees.
  const hasShopify =
    Boolean(totals.costs) &&
    (shopifyPending > 0 || !toDecimal(totals.costs?.shopifyFees ?? "0").isZero());
  const hasFees = hasStripe || hasShopify;
  const which = hasStripe && hasShopify ? "fees" : hasStripe ? "Stripe fees" : "Shopify fees";
  const rows: { label: string; value: string; strong?: boolean }[] = [
    { label: "Total", value: money(totals.saleTotal), strong: true },
  ];
  if (totals.costs) {
    const rates = report ? formatRateRange(report.ccRates) : null;
    const shared = ccRate ? `${Number((Number(ccRate) * 100).toFixed(2))}%` : null;
    const rate = rates ?? shared;
    rows.push(
      { label: "Cost", value: money(totals.costs.costTotal) },
      { label: "Yield", value: money(totals.costs.yieldTotal) },
      { label: `Cult Commons${rate ? ` (${rate})` : ""}`, value: money(totals.costs.ccShare) },
    );
    if (hasFees) {
      const cancelled = report?.status === "cancelled";
      const feeRows = (label: string, fees: string, borneBy: string) => {
        const noneReported = toDecimal(fees).isZero();
        rows.push({ label, value: noneReported ? "Not reported yet" : money(fees) });
        if (!noneReported && !cancelled) {
          rows.push({
            label: `${label} borne by Cult Commons`,
            value: toDecimal(borneBy).isZero() ? money(borneBy) : `−${money(borneBy)}`,
          });
        }
      };
      if (hasStripe) feeRows("Stripe fees", totals.costs.stripeFees, totals.costs.stripeFeesBorne);
      if (hasShopify) {
        feeRows("Shopify fees", totals.costs.shopifyFees, totals.costs.shopifyFeesBorne);
      }
      rows.push(
        {
          label: `Cult Commons after ${which}`,
          value: cancelled ? "Not counted (cancelled)" : money(totals.costs.ccAfterFees),
        },
        {
          label: `BICII yield after Cult Commons and ${which}`,
          value: money(totals.costs.yieldAfterFees),
        },
      );
    } else {
      rows.push({
        label: "BICII yield after Cult Commons",
        value: money(totals.costs.yieldAfterCc),
      });
    }
  }
  const pending = totals.costs?.costPendingCount ?? 0;
  const loss =
    totals.costs && report
      ? lossNote(report.lossLineCount, report.lossTotal, report.currency)
      : null;
  const recognition = totals.costs && report ? recognitionNote(report) : null;
  return (
    <div className="flex flex-col border-t border-hairline bg-sunken px-4 py-3 sm:px-5">
      <dl aria-label="Totals" className="flex flex-col gap-1 text-dense tabular-nums">
        {rows.map((r) => (
          <div key={r.label} className="flex items-baseline justify-between gap-4">
            <dt className={r.strong ? "text-sm font-semibold" : "text-dust-700"}>{r.label}</dt>
            <dd className={r.strong ? "text-lg font-bold" : "font-medium"}>{r.value}</dd>
          </div>
        ))}
      </dl>
      {loss ? (
        <p role="note" className="mt-2 text-sm font-medium text-danger-deep">
          {loss}
        </p>
      ) : null}
      {pending > 0 ? (
        <p role="note" className="mt-2 text-sm font-medium text-waiting-deep">
          {pending === 1
            ? "Provisional: 1 line has no cost entered, so cost, yield and Cult Commons count it at 0. Void it and add it again with its cost."
            : `Provisional: ${pending} lines have no cost entered, so cost, yield and Cult Commons count them at 0. Void each and add it again with its cost.`}
        </p>
      ) : null}
      {feePending > 0 ? (
        <p role="note" className="mt-2 text-sm font-medium text-waiting-deep">
          {feePending === 1
            ? "Provisional: Stripe has not reported the fee on 1 payment yet, so Cult Commons after Stripe fees may still go down."
            : `Provisional: Stripe has not reported the fee on ${feePending} payments yet, so Cult Commons after Stripe fees may still go down.`}
        </p>
      ) : null}
      {shopifyPending > 0 ? (
        <p role="note" className="mt-2 text-sm font-medium text-waiting-deep">
          Provisional: Shopify has not reported the fee on this job&apos;s online order yet, so Cult
          Commons after {which} may still go down.
        </p>
      ) : null}
      {hasFees && feeNote(report, which) ? (
        <p className="mt-2 text-sm text-dust-700">{feeNote(report, which)}</p>
      ) : null}
      {recognition ? <p className="mt-2 text-sm text-dust-700">{recognition}</p> : null}
    </div>
  );
}
