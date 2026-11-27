import "server-only";

import { DbError, mapDbError, unwrap } from "@/lib/db-errors";
import { DomainError } from "@/lib/domain/errors";
import { toMoneyString } from "@/lib/money";
import {
  monthStart,
  type PayoutKind,
  type PayoutRecord,
  type PayoutSummary,
  type ServicePayRule,
} from "@/lib/payouts";
import type { ServerSupabase } from "@/lib/supabase/server";

/**
 * Month-end payouts (PLAN D276; ADR-030; DATA-MODEL §19 "Month-end payouts"). Admins only:
 * every RPC calls private.require_admin(), and the tables are admin-only
 * by RLS. Each read calls one RPC and maps its rows onto the DTOs of
 * src/lib/payouts.ts: money as fixed-2 strings, never added up here.
 */

type Fn = import("@/lib/database.types").Database["public"]["Functions"];
/** A row as the RPC really returns it: the generated types call every column non-null. */
type Nullable<T> = { [K in keyof T]: T[K] | null };

const FALLBACK_CURRENCY = "SGD";
const m = (v: number | string | null | undefined, currency: string) =>
  toMoneyString(v ?? 0, currency);

function rethrowFields(err: unknown, fields: Record<string, string>): never {
  if (err instanceof DbError) {
    const mapped = mapDbError(err);
    const field = mapped.reason ? fields[mapped.reason] : undefined;
    if (field && mapped.kind !== "unknown" && mapped.kind !== "unavailable") {
      throw new DomainError(mapped.message, { [field]: [mapped.message] });
    }
  }
  throw err;
}

/** payout_summary for the month "YYYY-MM". */
export async function getPayoutSummary(
  supabase: ServerSupabase,
  month: string,
): Promise<PayoutSummary> {
  const rows = (unwrap(await supabase.rpc("payout_summary", { p_month: monthStart(month) })) ??
    []) as Nullable<Fn["payout_summary"]["Returns"][number]>[];
  const c = rows[0]?.currency ?? FALLBACK_CURRENCY;
  const of = (party: string) => rows.filter((r) => r.party === party);
  const one = (party: string) => of(party)[0];
  const cc = one("cult_commons");
  const reserve = one("reserve");
  const consignors = one("consignors");
  const total = one("total");
  return {
    month,
    currency: c,
    mechanics: of("mechanic").map((r) => ({
      staffId: r.staff_id ?? "",
      name: r.display_name ?? "Mechanic",
      serviceRevenue: m(r.service_revenue, c),
      serviceAfterCc: m(r.service_after_cc, c),
      monthlyCap: r.monthly_cap === null ? null : m(r.monthly_cap, c),
      owed: m(r.owed, c),
      paid: m(r.paid, c),
      outstanding: m(r.outstanding, c),
      carryOver: m(r.carry_over, c),
    })),
    cultCommons: {
      owed: m(cc?.owed, c),
      paid: m(cc?.paid, c),
      outstanding: m(cc?.outstanding, c),
      carryOver: m(cc?.carry_over, c),
    },
    reserve: {
      added: m(reserve?.owed, c),
      paid: m(reserve?.paid, c),
      before: m(reserve?.carry_over, c),
      balance: m(reserve?.balance, c),
    },
    consignors: {
      total: m(consignors?.owed, c),
      count: consignors?.item_count ?? 0,
      owed: of("consignor").map((r) => ({
        id: r.consignor_id ?? "",
        name: r.display_name ?? "Consignor",
        outstanding: m(r.outstanding, c),
        items: r.item_count ?? 0,
      })),
    },
    total: m(total?.owed, c),
  };
}

/** The payouts recorded for the month "YYYY-MM", newest first. */
export async function listPayouts(
  supabase: ServerSupabase,
  month: string,
): Promise<PayoutRecord[]> {
  const rows = (unwrap(await supabase.rpc("list_payouts", { p_month: monthStart(month) })) ??
    []) as Nullable<Fn["list_payouts"]["Returns"][number]>[];
  return rows.map((r) => {
    const c = r.currency ?? FALLBACK_CURRENCY;
    return {
      id: r.id ?? "",
      kind: (r.kind ?? "cult_commons") as PayoutKind,
      payee: r.payee ?? "",
      amount: m(r.amount, c),
      currency: c,
      paidAt: r.paid_at ?? "",
      reference: r.reference,
      notes: r.notes,
      recordedBy: r.created_by_name,
      reversedAt: r.reversed_at,
      reversalReason: r.reversal_reason,
      reversedBy: r.reversed_by_name,
    };
  });
}

/** Every service pay rule, newest month first, with the mechanic's name. */
export async function listServicePayRules(supabase: ServerSupabase): Promise<ServicePayRule[]> {
  const [rules, staff] = await Promise.all([
    supabase
      .from("service_pay_rules")
      .select("id, staff_id, monthly_cap, effective_from, created_at")
      .order("effective_from", { ascending: false })
      .order("created_at", { ascending: false }),
    supabase.rpc("staff_directory"),
  ]);
  const names = new Map((unwrap(staff) ?? []).map((s) => [s.id, s.display_name]));
  return (unwrap(rules) ?? []).map((r) => ({
    id: r.id,
    staffId: r.staff_id,
    name: names.get(r.staff_id) ?? "Staff member",
    monthlyCap: m(r.monthly_cap, FALLBACK_CURRENCY),
    effectiveFrom: r.effective_from,
    createdAt: r.created_at,
  }));
}

/** Active staff, for the pickers (a mechanic's rule, ad hoc labour). */
export async function listPayableStaff(
  supabase: ServerSupabase,
): Promise<{ id: string; name: string }[]> {
  const rows = unwrap(await supabase.rpc("staff_directory")) ?? [];
  return rows
    .filter((s) => s.active)
    .map((s) => ({ id: s.id, name: s.display_name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function recordPayout(
  supabase: ServerSupabase,
  input: {
    id: string;
    kind: PayoutKind;
    amount: string;
    month: string | null;
    staffId: string | null;
    payeeName: string | null;
    paidAt: string | null;
    reference: string | null;
    notes: string | null;
  },
): Promise<{ replayed: boolean }> {
  let rows;
  try {
    rows = unwrap(
      await supabase.rpc("record_payout", {
        p_id: input.id,
        p_kind: input.kind,
        p_amount: input.amount,
        p_period_month: input.month ?? undefined,
        p_staff_id: input.staffId ?? undefined,
        p_payee_name: input.payeeName ?? undefined,
        p_paid_at: input.paidAt ?? undefined,
        p_reference: input.reference ?? undefined,
        p_notes: input.notes ?? undefined,
      }),
    );
  } catch (err) {
    rethrowFields(err, {
      payout_paid_in_future: "paidAt",
      payout_month_required: "month",
      payout_payee_required: "payeeName",
      payouts_amount_check: "amount",
      payouts_payee_name_check: "payeeName",
      payouts_reference_check: "reference",
      payouts_notes_check: "notes",
    });
  }
  return { replayed: rows?.[0]?.replayed === true };
}

export async function reversePayout(
  supabase: ServerSupabase,
  input: { payoutId: string; reason: string },
): Promise<void> {
  try {
    unwrap(
      await supabase.rpc("reverse_payout", { p_payout_id: input.payoutId, p_reason: input.reason }),
    );
  } catch (err) {
    rethrowFields(err, { reason_required: "reason", reason_too_long: "reason" });
  }
}

export async function setServicePayRule(
  supabase: ServerSupabase,
  input: { staffId: string; monthlyCap: string; effectiveFrom: string },
): Promise<void> {
  try {
    unwrap(
      await supabase.rpc("set_service_pay_rule", {
        p_staff_id: input.staffId,
        p_monthly_cap: input.monthlyCap,
        p_effective_from: input.effectiveFrom,
      }),
    );
  } catch (err) {
    rethrowFields(err, { service_pay_rules_monthly_cap_check: "monthlyCap" });
  }
}
