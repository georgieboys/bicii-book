import "server-only";

import { getAllPaymentItemsForExport, getPaymentsHeld } from "@/lib/domain/payment-reports";
import { ExportError } from "@/lib/domain/period-reports";
import {
  getActivityByMechanic,
  getAllBreakdownForExport,
  getAllLineItemsForExport,
  getPeriodSeries,
  getPeriodSummary,
  getStockValue,
} from "@/lib/domain/period-reports";
import {
  getExceptionCounts,
  getStockReconciliation,
  getUnitReconciliation,
} from "@/lib/domain/reconciliation";
import { getOperationalExceptions } from "@/lib/domain/reports";
import { autoGrain, type ReportParams } from "@/lib/period-reports";
import { EXCEPTIONS_MAX_ROWS, RECONCILIATION_MAX_ROWS, exceptionTotal } from "@/lib/reconciliation";
import { breakdownTotalRow, type ExportKind, type ExportRows } from "@/lib/report-exports";
import type { ServerSupabase } from "@/lib/supabase/server";

/**
 * What an export reads: the report's parameters and, for `lines`, an
 * optional group; for `stock` and `units`, the reconciliation's scope
 * (`all=1` → every row, else problems only) and product.
 */
export type ExportQuery = ReportParams & {
  key: string | null;
  /** Default true (problems only). */
  onlyIssues?: boolean;
  productId?: string | null;
};

export const EXCEPTIONS_TOO_LARGE_MESSAGE = `More than ${EXCEPTIONS_MAX_ROWS} exceptions: the export lists them all or none. Fix the most urgent on the Exceptions page first.`;
export const RECONCILIATION_TOO_LARGE_MESSAGE = `This export stops at ${RECONCILIATION_MAX_ROWS.toLocaleString("en-SG")} rows. Choose Problems only or one product.`;

/** A reconciliation read that may have been cut at the RPC's cap is refused, never written short. */
function wholeReconciliation<T>(rows: T[]): T[] {
  if (rows.length >= RECONCILIATION_MAX_ROWS) {
    throw new ExportError("too_large", RECONCILIATION_TOO_LARGE_MESSAGE);
  }
  return rows;
}

/**
 * The rows of each export kind (src/lib/report-exports.ts EXPORT_KINDS).
 * Typed per kind, so a kind added there fails typecheck until it has a
 * fetcher here. Every money figure and total comes from the step 1 RPCs;
 * the breakdown's TOTAL row is report_period_summary's row. The Customer
 * payments kinds (D154) read report_payment_items (every movement of the
 * period, checked against report_payment_summary's counts) and
 * report_payments_held (now, any period).
 */
export const EXPORT_FETCHERS: {
  readonly [K in ExportKind]: (
    supabase: ServerSupabase,
    q: ExportQuery,
  ) => Promise<ExportRows[K][]>;
} = {
  async series(supabase, q) {
    // One day has no buckets on the screen; the export still writes one row.
    const grain = autoGrain(q.from, q.to) ?? "day";
    const summary = await getPeriodSummary(supabase, q.from, q.to, q.basis);
    return getPeriodSeries(supabase, { ...q, grain }, summary.currency);
  },
  async breakdown(supabase, q) {
    const { rows, summary } = await getAllBreakdownForExport(supabase, {
      ...q,
      dimension: q.by,
    });
    return [...rows, breakdownTotalRow(summary)];
  },
  async lines(supabase, q) {
    return getAllLineItemsForExport(supabase, {
      from: q.from,
      to: q.to,
      basis: q.basis,
      dimension: q.key ? q.by : null,
      key: q.key,
    });
  },
  async stock_value(supabase) {
    return getStockValue(supabase);
  },
  async mechanics(supabase, q) {
    return getActivityByMechanic(supabase, { from: q.from, to: q.to });
  },
  async exceptions(supabase) {
    // The list is capped at EXCEPTIONS_MAX_ROWS; the counts say whether
    // that cut anything, and a cut export is refused rather than written short.
    const [rows, counts] = await Promise.all([
      getOperationalExceptions(supabase, EXCEPTIONS_MAX_ROWS),
      getExceptionCounts(supabase),
    ]);
    if (exceptionTotal(counts) > rows.length && rows.length >= EXCEPTIONS_MAX_ROWS) {
      throw new ExportError("too_large", EXCEPTIONS_TOO_LARGE_MESSAGE);
    }
    return rows;
  },
  async stock(supabase, q) {
    return wholeReconciliation(
      await getStockReconciliation(supabase, {
        onlyIssues: q.onlyIssues ?? true,
        productId: q.productId ?? null,
      }),
    );
  },
  async units(supabase, q) {
    return wholeReconciliation(
      await getUnitReconciliation(supabase, {
        onlyIssues: q.onlyIssues ?? true,
        productId: q.productId ?? null,
      }),
    );
  },
  async payments(supabase, q) {
    return getAllPaymentItemsForExport(supabase, { from: q.from, to: q.to });
  },
  async payments_held(supabase) {
    return getPaymentsHeld(supabase);
  },
};
