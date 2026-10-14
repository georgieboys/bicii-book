import "server-only";

import { unwrap } from "@/lib/db-errors";
import { DomainError } from "@/lib/domain/errors";
import { logger } from "@/lib/logger";
import { toMoneyString } from "@/lib/money";
import {
  DEPOSIT_STATES,
  type DepositState,
  type PaymentStatus,
  type StripeEventStatus,
  type StripeRejectionReason,
} from "@/lib/payments";
import type { Database } from "@/lib/database.types";
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

// ---------------------------------------------------------------------------
// A job's Customer payments card (D151, D152, D154, D159b)
// ---------------------------------------------------------------------------

export type PaymentKind = Database["public"]["Enums"]["payment_kind"];

/** One answered quote that asked a deposit (public.quote_deposits). */
export type JobDeposit = {
  quoteId: string;
  sentAt: string | null;
  answeredAt: string | null;
  percent: number | null;
  /** "120.00", fixed in Postgres when the quote was answered (D158a). */
  amount: string;
  currency: string;
  state: DepositState;
  /** The quote's approved part requests (the D152 gate's subjects). */
  partRequestIds: string[];
};

/** One Checkout attempt (public.payments); every money value as Postgres stored it. */
export type JobPayment = {
  id: string;
  kind: PaymentKind;
  quoteId: string | null;
  amount: string;
  /** Stripe's own figure; null until paid, or when Stripe's currency was not the job's. */
  amountReceived: string | null;
  refundedAmount: string;
  currency: string;
  status: PaymentStatus;
  /** Checkout completed and Stripe is still confirming (PayNow). */
  processing: boolean;
  createdAt: string;
  paidAt: string | null;
  checkedAt: string | null;
  sessionExpiresAt: string;
  paymentIntentId: string | null;
  livemode: boolean;
  /** A refund Stripe has not decided yet (pending or requires_action). */
  refundPending: boolean;
};

/** One live "needs attention" condition (public.payment_issues), its sentence from SQL. */
export type PaymentIssue = {
  paymentId: string;
  issue: string;
  severity: string;
  message: string;
  since: string | null;
};

/** D154's "paid and balance due" (public.work_order_payment_totals). */
export type PaymentTotals = {
  currency: string;
  paidOnline: string;
  refundedOnline: string;
  netPaidOnline: string;
  jobTotal: string;
  /** Null once the job is collected or cancelled, or outside SGD. */
  balanceDue: string | null;
  paidAhead: string | null;
};

export type JobPayments = {
  deposits: JobDeposit[];
  payments: JobPayment[];
  issues: PaymentIssue[];
  totals: PaymentTotals | null;
};

const moneyOrNull = (v: number | string | null) => (v === null ? null : toMoneyString(v));

const depositState = (v: string | null): DepositState =>
  (DEPOSIT_STATES as readonly string[]).includes(v ?? "") ? (v as DepositState) : "none";

/**
 * Everything the job's Customer payments card and the order sheet need,
 * through RLS with the staff client (any active staff member, D154). Money
 * leaves as Postgres computed it, formatted, never summed here. A database
 * error (for example while migrate.yml is still applying step 2) is logged
 * and gives null: the job page never breaks, and the SQL gate still
 * enforces D152 whatever the screen shows.
 */
export async function getJobPayments(
  supabase: ServerSupabase,
  workOrderId: string,
): Promise<JobPayments | null> {
  const [deposits, payments, refunds, issues, totals] = await Promise.all([
    supabase
      .from("quote_deposits")
      .select(
        "quote_id, sent_at, answered_at, deposit_percent, deposit_amount, currency, state, part_request_ids",
      )
      .eq("work_order_id", workOrderId)
      .order("sent_at", { ascending: true }),
    supabase
      .from("payments")
      .select(
        "id, kind, quote_id, amount, amount_received, refunded_amount, currency, status, checkout_completed_at, created_at, paid_at, checked_at, stripe_session_expires_at, stripe_payment_intent_id, livemode",
      )
      .eq("work_order_id", workOrderId)
      .order("created_at", { ascending: true }),
    supabase
      .from("payment_refunds")
      .select("payment_id, status, payments!inner(work_order_id)")
      .eq("payments.work_order_id", workOrderId)
      .in("status", ["pending", "requires_action"]),
    supabase
      .from("payment_issues")
      .select("payment_id, issue, severity, message, since")
      .eq("work_order_id", workOrderId)
      .order("since", { ascending: true }),
    supabase
      .from("work_order_payment_totals")
      .select(
        "currency, paid_online, refunded_online, net_paid_online, job_total, balance_due, paid_ahead",
      )
      .eq("work_order_id", workOrderId)
      .maybeSingle(),
  ]);
  const failed = [deposits, payments, refunds, issues, totals].find((r) => r.error);
  if (failed?.error) {
    logger.error({ workOrderId, code: failed.error.code }, "job payments read failed");
    return null;
  }

  const refundPending = new Set((refunds.data ?? []).map((r) => r.payment_id));
  const t = totals.data;
  return {
    deposits: (deposits.data ?? [])
      .filter((d) => d.quote_id !== null && d.deposit_amount !== null)
      .map((d) => ({
        quoteId: d.quote_id!,
        sentAt: d.sent_at,
        answeredAt: d.answered_at,
        percent: d.deposit_percent,
        amount: toMoneyString(d.deposit_amount!),
        currency: d.currency ?? "SGD",
        state: depositState(d.state),
        partRequestIds: d.part_request_ids ?? [],
      })),
    payments: (payments.data ?? []).map((p) => ({
      id: p.id,
      kind: p.kind,
      quoteId: p.quote_id,
      amount: toMoneyString(p.amount),
      amountReceived: moneyOrNull(p.amount_received),
      refundedAmount: toMoneyString(p.refunded_amount),
      currency: p.currency,
      status: p.status,
      processing: p.status === "pending" && p.checkout_completed_at !== null,
      createdAt: p.created_at,
      paidAt: p.paid_at,
      checkedAt: p.checked_at,
      sessionExpiresAt: p.stripe_session_expires_at,
      paymentIntentId: p.stripe_payment_intent_id,
      livemode: p.livemode,
      refundPending: refundPending.has(p.id),
    })),
    issues: (issues.data ?? [])
      .filter((i) => i.payment_id && i.issue && i.message)
      .map((i) => ({
        paymentId: i.payment_id!,
        issue: i.issue!,
        severity: i.severity ?? "danger",
        message: i.message!,
        since: i.since,
      })),
    totals: t
      ? {
          currency: t.currency ?? "SGD",
          paidOnline: toMoneyString(t.paid_online ?? 0),
          refundedOnline: toMoneyString(t.refunded_online ?? 0),
          netPaidOnline: toMoneyString(t.net_paid_online ?? 0),
          jobTotal: toMoneyString(t.job_total ?? 0),
          balanceDue: moneyOrNull(t.balance_due),
          paidAhead: moneyOrNull(t.paid_ahead),
        }
      : null,
  };
}
