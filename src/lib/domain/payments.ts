import "server-only";

import { unwrap } from "@/lib/db-errors";
import { DomainError } from "@/lib/domain/errors";
import { logger } from "@/lib/logger";
import { toMoneyString } from "@/lib/money";
import {
  COUNTER_METHODS,
  COUNTER_VOID_KINDS,
  DEPOSIT_STATES,
  type CounterMethod,
  type CounterVoidKind,
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

/**
 * One live "needs attention" condition (public.payment_issues), its
 * sentence from SQL. A Stripe row's issue names its payment; a counter
 * row's (D161j: paid_job_cancelled, paid_parts_cancelled) its counter
 * payment, and a job-level paid_above_bill sits on one or the other.
 * Check with Stripe is offered only for a Stripe payment's issue.
 */
export type PaymentIssue = {
  paymentId: string | null;
  counterPaymentId: string | null;
  issue: string;
  severity: string;
  message: string;
  since: string | null;
};

/** How a void reads on the card: why, who and when (public.counter_payment_voids). */
export type CounterVoid = {
  kind: CounterVoidKind;
  reason: string;
  voidedBy: string;
  voidedAt: string;
};

/** Money an admin recorded at the counter (public.counter_payments, D161). */
export type CounterPayment = {
  id: string;
  kind: PaymentKind;
  /** The quote whose deposit it settled; null towards the bill. */
  quoteId: string | null;
  amount: string;
  currency: string;
  method: CounterMethod;
  /** When the shop took the money (business time, D161h). */
  receivedAt: string;
  reference: string | null;
  note: string | null;
  /** The admin who recorded it (display name). */
  recordedBy: string;
  createdAt: string;
  /** The one correction (D161d), or null while it counts. */
  voided: CounterVoid | null;
};

export type BalanceLinkChannel = Database["public"]["Enums"]["quote_channel"];

/**
 * The job's live payment link (public.balance_links, not withdrawn; D156),
 * never its token hash: a database read cannot open the pay page.
 */
export type BalanceLink = {
  id: string;
  channel: BalanceLinkChannel;
  sentAt: string;
  expiresAt: string;
  validDays: number;
  /** What was left to pay when it was sent; the page always asks the live balance. */
  amountAtSend: string;
  sentBy: string;
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
  /** Net paid online above the job total, in every status (R-082); null outside SGD. */
  heldOverTotal: string | null;
  /** Live counter payments an admin recorded (D161); "0.00" when none. */
  paidAtCounter: string;
  /** Online net plus counter money: what balance_due and paid_ahead are taken from (D161j). */
  netPaid: string;
  /**
   * Stripe payments whose Checkout completed while Stripe still confirms
   * (PayNow): never in netPaid or the balance; "0.00" when none.
   */
  processingOnline: string;
};

export type JobPayments = {
  deposits: JobDeposit[];
  payments: JobPayment[];
  /** Counter payments, voided ones included (struck through on the card), oldest first. */
  counterPayments: CounterPayment[];
  /** The live payment link, or null (none sent, or withdrawn). */
  link: BalanceLink | null;
  issues: PaymentIssue[];
  totals: PaymentTotals | null;
};

const moneyOrNull = (v: number | string | null) => (v === null ? null : toMoneyString(v));

const depositState = (v: string | null): DepositState =>
  (DEPOSIT_STATES as readonly string[]).includes(v ?? "") ? (v as DepositState) : "none";

const counterMethod = (v: string): CounterMethod =>
  (COUNTER_METHODS as readonly string[]).includes(v) ? (v as CounterMethod) : "other";

const voidKind = (v: string): CounterVoidKind =>
  (COUNTER_VOID_KINDS as readonly string[]).includes(v)
    ? (v as CounterVoidKind)
    : "recorded_in_error";

/** A staff id's display name; someone no longer listed reads as a former colleague. */
const nameOf = (names: ReadonlyMap<string, string>, id: string) =>
  names.get(id) ?? "A former colleague";

/**
 * Everything the job's Customer payments card and the order sheet need,
 * through RLS with the staff client (any active staff member, D154): the
 * deposits, the Stripe payments, the counter payments with their voids
 * (D161), the live payment link (D156; never its token hash), the issues
 * (keyed by a Stripe payment or a counter payment) and the totals with
 * the counter money in the net. Names come from staff_directory. Money
 * leaves as Postgres computed it, formatted, never summed here. A database
 * error (for example while migrate.yml is still applying step 3) is logged
 * and gives null: the job page never breaks, and the SQL gate still
 * enforces D152 whatever the screen shows.
 */
export async function getJobPayments(
  supabase: ServerSupabase,
  workOrderId: string,
): Promise<JobPayments | null> {
  const [deposits, payments, refunds, issues, totals, counter, link, directory] = await Promise.all(
    [
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
        .select("payment_id, counter_payment_id, issue, severity, message, since")
        .eq("work_order_id", workOrderId)
        .order("since", { ascending: true }),
      supabase
        .from("work_order_payment_totals")
        .select(
          "currency, paid_online, refunded_online, net_paid_online, job_total, balance_due, paid_ahead, held_over_total, paid_at_counter, net_paid, processing_online",
        )
        .eq("work_order_id", workOrderId)
        .maybeSingle(),
      supabase
        .from("counter_payments")
        .select(
          "id, kind, quote_id, amount, currency, method, received_at, reference, note, recorded_by, created_at, counter_payment_voids(kind, reason, voided_by, voided_at)",
        )
        .eq("work_order_id", workOrderId)
        .order("received_at", { ascending: true })
        .order("created_at", { ascending: true }),
      // The live link (one per job, balance_links_one_live); never token_hash.
      supabase
        .from("balance_links")
        .select("id, channel, created_at, expires_at, valid_days, amount_at_send, sent_by")
        .eq("work_order_id", workOrderId)
        .is("withdrawn_at", null)
        .maybeSingle(),
      supabase.rpc("staff_directory"),
    ],
  );
  const failed = [deposits, payments, refunds, issues, totals, counter, link, directory].find(
    (r) => r.error,
  );
  if (failed?.error) {
    logger.error({ workOrderId, code: failed.error.code }, "job payments read failed");
    return null;
  }

  const refundPending = new Set((refunds.data ?? []).map((r) => r.payment_id));
  const names = new Map((directory.data ?? []).map((d) => [d.id, d.display_name]));
  const t = totals.data;
  const l = link.data;
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
    counterPayments: (counter.data ?? []).map((c) => {
      const v = c.counter_payment_voids;
      return {
        id: c.id,
        kind: c.kind,
        quoteId: c.quote_id,
        amount: toMoneyString(c.amount),
        currency: c.currency,
        method: counterMethod(c.method),
        receivedAt: c.received_at,
        reference: c.reference,
        note: c.note,
        recordedBy: nameOf(names, c.recorded_by),
        createdAt: c.created_at,
        voided: v
          ? {
              kind: voidKind(v.kind),
              reason: v.reason,
              voidedBy: nameOf(names, v.voided_by),
              voidedAt: v.voided_at,
            }
          : null,
      };
    }),
    link: l
      ? {
          id: l.id,
          channel: l.channel,
          sentAt: l.created_at,
          expiresAt: l.expires_at,
          validDays: l.valid_days,
          amountAtSend: toMoneyString(l.amount_at_send),
          sentBy: nameOf(names, l.sent_by),
        }
      : null,
    issues: (issues.data ?? [])
      .filter((i) => (i.payment_id || i.counter_payment_id) && i.issue && i.message)
      .map((i) => ({
        paymentId: i.payment_id ?? null,
        counterPaymentId: i.counter_payment_id ?? null,
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
          heldOverTotal: moneyOrNull(t.held_over_total ?? null),
          paidAtCounter: toMoneyString(t.paid_at_counter ?? 0),
          netPaid: toMoneyString(t.net_paid ?? 0),
          processingOnline: toMoneyString(t.processing_online ?? 0),
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Payment links (D156) and counter payments (D161): writes through RPCs only
// ---------------------------------------------------------------------------

export type SentBalanceLink = {
  linkId: string;
  /** The link's token, returned this once (only its hash is stored). */
  token: string;
  /** What was left to pay when it was sent, as Postgres computed it. */
  amount: string;
  expiresAt: string;
  /** The live link this one replaced, if any: its open Checkout is expired next. */
  replacedLinkId: string | null;
};

/**
 * send_balance_link (D156h): any active staff member, on a completed or
 * ready job. The RPC decides every refusal (status, currency, S$0.50,
 * money still being confirmed); the token comes back once.
 */
export async function sendBalanceLink(
  supabase: ServerSupabase,
  input: {
    linkId: string;
    workOrderId: string;
    channel: BalanceLinkChannel;
    validDays: number;
  },
): Promise<SentBalanceLink> {
  const rows = unwrap(
    await supabase.rpc("send_balance_link", {
      p_link_id: input.linkId,
      p_work_order_id: input.workOrderId,
      p_channel: input.channel,
      p_valid_days: input.validDays,
    }),
  );
  const row = rows?.[0];
  if (!row) throw new Error("send_balance_link returned nothing");
  return {
    linkId: row.link_id,
    token: row.token,
    amount: toMoneyString(row.amount as string | number),
    expiresAt: row.expires_at,
    replacedLinkId: row.replaced_link_id ?? null,
  };
}

/**
 * record_counter_payment (D161i): an active admin only (the RPC's
 * require_admin). With `quoteId` it settles that quote's deposit at
 * exactly its amount; without, it counts towards the bill. `receivedAt`
 * null means now. Replay-safe on `id`. `openCheckouts` is how many of the
 * job's open Checkout sessions this money made stale (the action expires
 * them).
 */
export async function recordCounterPayment(
  supabase: ServerSupabase,
  input: {
    id: string;
    workOrderId: string;
    quoteId: string | null;
    amount: string;
    method: CounterMethod;
    receivedAt: string | null;
    reference: string | null;
    note: string | null;
  },
): Promise<{ counterPaymentId: string; replayed: boolean; openCheckouts: number }> {
  const rows = unwrap(
    await supabase.rpc("record_counter_payment", {
      p_id: input.id,
      p_work_order_id: input.workOrderId,
      // Null towards the bill: the parameter has no default, and the
      // generated type cannot say it is nullable.
      p_quote_id: input.quoteId as string,
      p_amount: input.amount,
      p_method: input.method,
      ...(input.receivedAt ? { p_received_at: input.receivedAt } : {}),
      ...(input.reference ? { p_reference: input.reference } : {}),
      ...(input.note ? { p_note: input.note } : {}),
    }),
  );
  const row = rows?.[0];
  if (!row) throw new Error("record_counter_payment returned nothing");
  return {
    counterPaymentId: row.counter_payment_id,
    replayed: row.replayed,
    openCheckouts: row.open_checkouts ?? 0,
  };
}

/**
 * void_counter_payment (D161d): an active admin only. `recorded_in_error`
 * (it never came in) or `given_back` (the shop handed it back outside
 * BICII), with a reason. The same kind and reason again is a replay.
 */
export async function voidCounterPayment(
  supabase: ServerSupabase,
  input: { counterPaymentId: string; kind: CounterVoidKind; reason: string },
): Promise<{ replayed: boolean }> {
  const rows = unwrap(
    await supabase.rpc("void_counter_payment", {
      p_counter_payment_id: input.counterPaymentId,
      p_kind: input.kind,
      p_reason: input.reason,
    }),
  );
  const row = rows?.[0];
  if (!row) throw new Error("void_counter_payment returned nothing");
  return { replayed: row.replayed };
}
