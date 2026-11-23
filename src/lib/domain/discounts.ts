import "server-only";

import { DbError } from "@/lib/db-errors";
import { toMoneyString } from "@/lib/money";
import type { ServerSupabase } from "@/lib/supabase/server";

/**
 * Discounts and round-offs (D271): an amount taken off a job, spread over
 * its chargeable lines as new sale prices by apply_job_discount. The
 * database does the arithmetic; this only reads its plan. Money stays
 * fixed-point strings.
 */

export type DiscountLine = {
  lineId: string;
  description: string;
  lineType: string;
  quantity: string;
  fromPrice: string;
  toPrice: string;
  fromTotal: string;
  toTotal: string;
  /** A consigned part that would sell below what its consignor is owed. */
  belowConsignor: boolean;
};

export type DiscountPlan = {
  currency: string;
  totalBefore: string;
  /** What was asked for. */
  amount: string;
  /** What the lines take off: the amount, unless their quantities cannot take the last cents. */
  applied: string;
  totalAfter: string;
  /** The job is completed or ready: it is reopened and completed again. */
  reopens: boolean;
  lines: DiscountLine[];
};

export type DiscountResult = DiscountPlan & { reopened: boolean; replayed: boolean };

type Raw = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === "string" ? v : String(v ?? ""));
const money = (v: unknown): string => toMoneyString(str(v) || "0");

export function parsePlan(raw: unknown): DiscountPlan {
  const p = (raw ?? {}) as Raw;
  const lines = Array.isArray(p.lines) ? (p.lines as Raw[]) : [];
  return {
    currency: str(p.currency),
    totalBefore: money(p.total_before),
    amount: money(p.amount),
    applied: money(p.applied),
    totalAfter: money(p.total_after),
    reopens: p.reopens === true || p.reopened === true,
    lines: lines.map((l) => ({
      lineId: str(l.line_id),
      description: str(l.description),
      lineType: str(l.line_type),
      quantity: str(l.quantity),
      fromPrice: money(l.from_price),
      toPrice: money(l.to_price),
      fromTotal: money(l.from_total),
      toTotal: money(l.to_total),
      belowConsignor: l.below_consignor === true,
    })),
  };
}

export async function previewJobDiscount(
  supabase: ServerSupabase,
  workOrderId: string,
  amount: string,
): Promise<DiscountPlan> {
  const { data, error } = await supabase.rpc("preview_job_discount", {
    work_order_id: workOrderId,
    amount,
  });
  if (error) throw new DbError(error);
  return parsePlan(data);
}

export async function applyJobDiscount(
  supabase: ServerSupabase,
  input: { requestId: string; workOrderId: string; amount: string; reason: string },
): Promise<DiscountResult> {
  const { data, error } = await supabase.rpc("apply_job_discount", {
    request_id: input.requestId,
    work_order_id: input.workOrderId,
    amount: input.amount,
    reason: input.reason,
  });
  if (error) throw new DbError(error);
  const raw = (data ?? {}) as Raw;
  return { ...parsePlan(raw), reopened: raw.reopened === true, replayed: raw.replayed === true };
}
