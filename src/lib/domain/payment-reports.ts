import "server-only";

import { cache } from "react";

import { DbError, unwrap } from "@/lib/db-errors";
import { EXPORT_MAX_ROWS, ExportError, withOneRetry } from "@/lib/domain/period-reports";
import { hrefForRecord } from "@/lib/ids";
import { toMoneyString } from "@/lib/money";
import {
  HELD_GROUPS,
  movementCount,
  type HeldGroup,
  type HeldJob,
  type PaymentCursor,
  type PaymentItem,
  type PaymentSummary,
} from "@/lib/payment-reports";
import type { ServerSupabase } from "@/lib/supabase/server";

/**
 * Reads for the Customer payments part of Reports (Phase 14 step 3; PLAN
 * D154a–e; ADR-025): report_payment_summary, report_payment_items and
 * report_payments_held (migration 20261014001500), each through the
 * RLS-scoped client. The database checks view_financial_reports first
 * (42501 otherwise) and computes every figure; these map the rows onto the
 * DTOs of src/lib/payment-reports.ts, money as fixed-2 strings with their
 * currency, counts as numbers. A failure throws DbError (map it with
 * mapDbError). Nothing here adds money up; the export pager compares
 * INTEGER counts only, as a consistency check.
 */

/** A row as the RPC really returns it: the generated types call every column non-null. */
type Nullable<T> = { [K in keyof T]: T[K] | null };

type Fn = import("@/lib/database.types").Database["public"]["Functions"];

/** The shop currency when a row does not carry it. */
const FALLBACK_CURRENCY = "SGD";

const money = (v: number | string | null | undefined, currency: string) =>
  toMoneyString(v ?? 0, currency);
const moneyOrNull = (v: number | string | null | undefined, currency: string) =>
  v === null || v === undefined ? null : toMoneyString(v, currency);
const int = (v: number | null | undefined) => v ?? 0;

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

type SummaryRpcRow = Nullable<Fn["report_payment_summary"]["Returns"][number]>;

/** report_payment_summary's one row as the DTO (exported for the unit test of the mapping). */
export function toPaymentSummary(r: SummaryRpcRow, from: string, to: string): PaymentSummary {
  const c = r.currency ?? FALLBACK_CURRENCY;
  return {
    from,
    to,
    currency: c,
    onlineCount: int(r.online_count),
    onlineTotal: money(r.online_total, c),
    depositOnlineTotal: money(r.deposit_online_total, c),
    balanceOnlineTotal: money(r.balance_online_total, c),
    refundCount: int(r.refund_count),
    refundTotal: money(r.refund_total, c),
    counterCount: int(r.counter_count),
    counterTotal: money(r.counter_total, c),
    givenBackCount: int(r.given_back_count),
    givenBackTotal: money(r.given_back_total, c),
    netTotal: money(r.net_total, c),
    otherCurrencyCount: int(r.other_currency_count),
  };
}

async function readSummary(
  supabase: ServerSupabase,
  from: string,
  to: string,
): Promise<PaymentSummary> {
  const rows = unwrap(await supabase.rpc("report_payment_summary", { p_from: from, p_to: to })) as
    SummaryRpcRow[] | null;
  const r = rows?.[0];
  if (!r) throw new DbError({ code: "P0002", message: "report_payment_summary returned no row" });
  return toPaymentSummary(r, from, to);
}

/**
 * Customer money that moved in the shop days from..to (D154b), not sales
 * and not by the date basis. Memoised per render: the /reports section and
 * the /reports/payments header read the same row.
 */
export const getPaymentSummary = cache((supabase: ServerSupabase, from: string, to: string) =>
  readSummary(supabase, from, to),
);

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

type ItemRpcRow = Nullable<Fn["report_payment_items"]["Returns"][number]>;

/** One report_payment_items row as the DTO. */
export function toPaymentItem(r: ItemRpcRow): PaymentItem {
  const c = r.currency ?? FALLBACK_CURRENCY;
  return {
    at: r.at!,
    id: r.id!,
    movement: r.movement ?? "",
    workOrderId: r.work_order_id!,
    jobNumber: r.job_number ?? "",
    jobHref: hrefForRecord("work_order", r.work_order_id!)!,
    customerLabel: r.customer_label,
    kind: r.kind ?? "",
    method: r.method ?? "",
    amount: money(r.amount, c),
    signedAmount: money(r.signed_amount, c),
    currency: c,
    otherCurrency: r.other_currency === true,
    recordedAt: r.recorded_at,
    recordedByName: r.recorded_by_name,
  };
}

async function itemPage(
  supabase: ServerSupabase,
  q: { from: string; to: string },
  maxRows: number,
  after: PaymentCursor | null,
): Promise<ItemRpcRow[]> {
  return (unwrap(
    await supabase.rpc("report_payment_items", {
      p_from: q.from,
      p_to: q.to,
      p_max_rows: maxRows,
      // The keyset goes back exactly as it came (microseconds kept).
      ...(after ? { p_after_at: after.at, p_after_id: after.id } : {}),
    }),
  ) ?? []) as ItemRpcRow[];
}

/** One page of the movements, newest first, and the cursor for the next page (null at the end). */
export async function getPaymentItems(
  supabase: ServerSupabase,
  q: { from: string; to: string; limit: number; after?: PaymentCursor | null },
): Promise<{ items: PaymentItem[]; nextCursor: PaymentCursor | null }> {
  const rows = await itemPage(supabase, q, q.limit + 1, q.after ?? null);
  const more = rows.length > q.limit;
  const shown = rows.slice(0, q.limit);
  const last = shown.at(-1);
  return {
    items: shown.map(toPaymentItem),
    nextCursor: more && last ? { at: last.at!, id: last.id! } : null,
  };
}

/** report_payment_items' p_max_rows ceiling (and PostgREST's max-rows). */
const ITEM_EXPORT_PAGE = 1000;

/**
 * Every movement of the period (pages of 1,000 by the keyset, at most
 * 50,000). Their number must equal the summary's four counts added up
 * (online + refunds + counter + given back, integers; PR A pins it);
 * otherwise it retries once, then refuses (ExportError 'changed').
 */
export async function getAllPaymentItemsForExport(
  supabase: ServerSupabase,
  q: { from: string; to: string },
): Promise<PaymentItem[]> {
  return withOneRetry(async () => {
    const expected = movementCount(await readSummary(supabase, q.from, q.to));
    if (expected > EXPORT_MAX_ROWS) throw new ExportError("too_large");
    const raw: ItemRpcRow[] = [];
    let after: PaymentCursor | null = null;
    for (;;) {
      const page = await itemPage(supabase, q, ITEM_EXPORT_PAGE, after);
      raw.push(...page);
      if (raw.length > EXPORT_MAX_ROWS) throw new ExportError("too_large");
      if (page.length < ITEM_EXPORT_PAGE) break;
      const last = page[page.length - 1];
      after = { at: last.at!, id: last.id! };
    }
    if (raw.length !== expected) return "mismatch";
    return raw.map(toPaymentItem);
  });
}

// ---------------------------------------------------------------------------
// Held on jobs now
// ---------------------------------------------------------------------------

type HeldRpcRow = Nullable<Fn["report_payments_held"]["Returns"][number]>;

const isHeldGroup = (v: string | null): v is HeldGroup =>
  v !== null && (HELD_GROUPS as readonly string[]).includes(v);

/** One report_payments_held row as the DTO, or null for a group this app does not know. */
export function toHeldJob(r: HeldRpcRow): HeldJob | null {
  if (!isHeldGroup(r.grp)) return null;
  const c = r.currency ?? FALLBACK_CURRENCY;
  return {
    group: r.grp,
    workOrderId: r.work_order_id!,
    jobNumber: r.job_number ?? "",
    jobHref: hrefForRecord("work_order", r.work_order_id!)!,
    status: r.status ?? "",
    customerLabel: r.customer_label,
    amount: money(r.amount, c),
    netPaid: money(r.net_paid, c),
    netPaidOnline: money(r.net_paid_online, c),
    paidAtCounter: money(r.paid_at_counter, c),
    jobTotal: money(r.job_total, c),
    balanceDue: moneyOrNull(r.balance_due, c),
    paidAhead: moneyOrNull(r.paid_ahead, c),
    currency: c,
  };
}

/**
 * Customer money held on jobs NOW (D154c), whatever period is chosen: the
 * three groups in report_payments_held's order (group, then job number),
 * from the job card's own totals.
 */
export async function getPaymentsHeld(supabase: ServerSupabase): Promise<HeldJob[]> {
  const rows = (unwrap(await supabase.rpc("report_payments_held")) ?? []) as HeldRpcRow[];
  return rows.map(toHeldJob).filter((r): r is HeldJob => r !== null);
}
