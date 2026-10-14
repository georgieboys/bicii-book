import "server-only";

import { unwrap } from "@/lib/db-errors";
import { DomainError } from "@/lib/domain/errors";
import type { StripeEventStatus, StripeRejectionReason } from "@/lib/payments";
import type { ServerSupabase } from "@/lib/supabase/server";

/**
 * Customer payments for staff screens (Phase 14 step 2; D151, D157,
 * D159; ADR-025), read through RLS with the staff client. Writes go
 * through RPCs only: the deposit setting here (admins), payments only from
 * Stripe's data (src/lib/integrations/stripe/).
 */

/** The deposit asked on indent quotes, a whole percent 0-100 (D151, D157a; ships at 0). */
export async function getIndentDepositPercent(supabase: ServerSupabase): Promise<number> {
  const s = unwrap(
    await supabase.from("shop_settings").select("indent_deposit_percent").eq("id", 1).maybeSingle(),
  );
  if (!s) throw new DomainError("The shop's settings are missing. Ask an admin to check Settings.");
  return s.indent_deposit_percent;
}

/**
 * Admin: the deposit percent new quotes take when they are sent (0-100,
 * D158a: quotes already sent keep theirs). Replay-safe: the current value
 * again changes nothing. Returns the value now in force. Whether Stripe is
 * on (D157a) is the Server Action's check: the database can't see the
 * environment.
 */
export async function setIndentDepositPercent(
  supabase: ServerSupabase,
  percent: number,
): Promise<number> {
  return unwrap(await supabase.rpc("set_indent_deposit_percent", { p_percent: percent }))!;
}

export type StripeDelivery = {
  receivedAt: string;
  eventType: string;
  status: StripeEventStatus;
  outcome: string | null;
  rejectionReason: StripeRejectionReason | null;
  deliveryCount: number;
  workOrderId: string | null;
  jobNumber: string | null;
};

/**
 * The newest Stripe deliveries and server reads (stripe_events), for
 * Settings → Customer payments. Admins only: RLS returns nothing to
 * anyone else (D86). Ids, types and outcomes only; the stored payload is
 * not read.
 */
export async function listRecentStripeEvents(
  supabase: ServerSupabase,
  limit = 20,
): Promise<StripeDelivery[]> {
  const rows =
    unwrap(
      await supabase
        .from("stripe_events")
        .select(
          "received_at, event_type, status, outcome, rejection_reason, delivery_count, work_order_id, work_orders(job_number)",
        )
        .order("received_at", { ascending: false })
        .limit(limit),
    ) ?? [];
  return rows.map((r) => ({
    receivedAt: r.received_at,
    eventType: r.event_type,
    status: r.status,
    outcome: r.outcome,
    rejectionReason: r.rejection_reason,
    deliveryCount: r.delivery_count,
    workOrderId: r.work_order_id,
    jobNumber: r.work_orders?.job_number ?? null,
  }));
}
