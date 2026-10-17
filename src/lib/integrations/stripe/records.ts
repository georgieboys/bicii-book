import "server-only";

import type { Database, Json } from "@/lib/database.types";
import { mapDbError } from "@/lib/db-errors";

import type { ServiceSupabase } from "../shopify/deps";

/**
 * Typed wrappers of the Stripe service-role RPCs (DATA-MODEL §16, §19):
 * every payment, refund and Stripe event change goes through them. A
 * database error is rethrown with its SQLSTATE and the mapped reason (a
 * P0001 code or a constraint name), never its raw message in a response.
 * The Checkout RPCs (prepare_deposit_checkout, record_deposit_checkout,
 * Phase 14 step 2; prepare_balance_checkout, record_balance_checkout,
 * step 3, D156h) are reached only from checkout.ts.
 */

type Functions = Database["public"]["Functions"];
type RecordEventArgs = Functions["record_stripe_event"]["Args"];
type RecordReadArgs = Functions["record_stripe_read"]["Args"];
type PrepareArgs = Functions["prepare_deposit_checkout"]["Args"];
type RecordCheckoutArgs = Functions["record_deposit_checkout"]["Args"];
type PrepareBalanceArgs = Functions["prepare_balance_checkout"]["Args"];
type RecordBalanceArgs = Functions["record_balance_checkout"]["Args"];

export type StripeRejectionReason = Database["public"]["Enums"]["stripe_rejection_reason"];

export type RecordStripeEventInput = {
  /** The verified event; null for a rejected delivery (never stored, D88). */
  payload: Json | null;
  headers: Record<string, string>;
  body_sha256: string;
  body_bytes: number;
  rejection_reason: StripeRejectionReason | null;
  correlation_id: string;
};

export type RecordStripeEventResult = {
  event_id: string;
  duplicate: boolean;
  event_status: Database["public"]["Enums"]["stripe_event_status"];
  outcome: string | null;
  payment_id: string | null;
};

export type RecordStripeReadInput = {
  payment_id: string;
  /** A Checkout Session or a Refund the server read with the secret key (D159a). */
  object: Record<string, Json>;
  correlation_id: string;
};

export type RecordStripeReadResult = {
  event_id: string;
  event_status: Database["public"]["Enums"]["stripe_event_status"];
  outcome: string | null;
  payment_status: Database["public"]["Enums"]["payment_status"] | null;
};

export type StripeRpcError = Error & { code?: string; reason?: string };

function rpcError(name: string, error: { message: string; code?: string }): StripeRpcError {
  return Object.assign(new Error(`${name} failed`), {
    code: error.code,
    reason: mapDbError(error).reason,
  });
}

/** Store one webhook delivery and apply it (public.record_stripe_event). */
export async function recordStripeEvent(
  supabase: ServiceSupabase,
  input: RecordStripeEventInput,
): Promise<RecordStripeEventResult> {
  const { data, error } = await supabase.rpc(
    "record_stripe_event",
    input as unknown as RecordEventArgs,
  );
  if (error) throw rpcError("record_stripe_event", error);
  const row = (data ?? [])[0];
  if (!row) throw new Error("record_stripe_event returned no row");
  return row as RecordStripeEventResult;
}

/** Store and apply an object the server read from Stripe (public.record_stripe_read). */
export async function recordStripeRead(
  supabase: ServiceSupabase,
  input: RecordStripeReadInput,
): Promise<RecordStripeReadResult> {
  const { data, error } = await supabase.rpc(
    "record_stripe_read",
    input as unknown as RecordReadArgs,
  );
  if (error) throw rpcError("record_stripe_read", error);
  const row = (data ?? [])[0];
  if (!row) throw new Error("record_stripe_read returned no row");
  return row as RecordStripeReadResult;
}

/**
 * What Pay deposit does next (public.prepare_deposit_checkout). Step 3
 * (D156h) adds `replace` (a balance session still open on the job: expire
 * and record it first) and `job_payment_processing` (a balance payment on
 * the job whose Checkout completed and Stripe is still confirming).
 */
export type PrepareDepositOutcome =
  "create" | "check" | "replace" | "processing" | "job_payment_processing" | "paid" | "refunded";

export type PrepareDepositResult = {
  outcome: PrepareDepositOutcome;
  /**
   * create: a fresh id for this attempt; otherwise the payment the outcome
   * is about (replace and job_payment_processing: the balance payment).
   * Null for `paid` when only a counter deposit paid it (D161j).
   */
  payment_id: string | null;
  work_order_id: string;
  quote_id: string;
  job_number: string;
  /** Money as Postgres printed it; display only. */
  amount: string;
  /** Stripe's minor units, computed in Postgres. */
  amount_cents: number;
  currency: string;
  /** check and replace: the session to re-read or expire at Stripe; null for create. */
  stripe_checkout_session_id: string | null;
  /** create: the new session's expiry; otherwise the payment's (epoch seconds), if any. */
  expires_at: number | null;
};

/**
 * For a quote link, decide what Pay deposit does (no locks). Raises
 * P0002 quote_not_found, or P0001 deposit_not_due, deposit_parts_cancelled
 * or deposit_job_closed.
 */
export async function prepareDepositCheckout(
  supabase: ServiceSupabase,
  token: string,
): Promise<PrepareDepositResult> {
  const { data, error } = await supabase.rpc("prepare_deposit_checkout", {
    token,
  } satisfies PrepareArgs);
  if (error) throw rpcError("prepare_deposit_checkout", error);
  const row = (data ?? [])[0];
  if (!row) throw new Error("prepare_deposit_checkout returned no row");
  return { ...row, amount: String(row.amount) } as PrepareDepositResult;
}

export type RecordDepositCheckoutInput = {
  p_payment_id: string;
  p_quote_id: string;
  /** The Checkout Session Stripe just returned, as it returned it (validated in SQL). */
  session: Record<string, Json>;
};

export type RecordDepositCheckoutResult = {
  outcome: "created" | "existing" | "processing" | "paid" | "refunded";
  /** created and existing: the pending payment; null otherwise. */
  payment_id: string | null;
  stripe_checkout_session_id: string | null;
};

/**
 * Record the Checkout Session the app has just created (the pending
 * payment row), or say why not. Raises P0001 checkout_session_mismatch,
 * checkout_session_conflict and the prepare refusals.
 */
export async function recordDepositCheckout(
  supabase: ServiceSupabase,
  input: RecordDepositCheckoutInput,
): Promise<RecordDepositCheckoutResult> {
  const { data, error } = await supabase.rpc(
    "record_deposit_checkout",
    input as unknown as RecordCheckoutArgs,
  );
  if (error) throw rpcError("record_deposit_checkout", error);
  const row = (data ?? [])[0];
  if (!row) throw new Error("record_deposit_checkout returned no row");
  return row as RecordDepositCheckoutResult;
}

/** What Pay does next on a balance link (public.prepare_balance_checkout). */
export type PrepareBalanceOutcome = "create" | "check" | "replace" | "processing" | "nothing_due";

export type PrepareBalanceResult = {
  outcome: PrepareBalanceOutcome;
  /**
   * create: a fresh id for this attempt; processing, replace and check:
   * the payment the outcome is about; nothing_due: this link's pending
   * payment, or null when it has none.
   */
  payment_id: string | null;
  work_order_id: string;
  link_id: string;
  job_number: string;
  /** Money as Postgres printed it (nothing_due: the live balance, under S$0.50); display only. */
  amount: string;
  /** Stripe's minor units, computed in Postgres (create: of the live balance). */
  amount_cents: number;
  currency: string;
  /** check, replace and nothing_due: the pending session, if any; null for create. */
  stripe_checkout_session_id: string | null;
  /** create: the new session's expiry (60 minutes); otherwise the payment's, if any (epoch seconds). */
  expires_at: number | null;
};

/**
 * For a balance link token, decide what Pay does (no locks; D156h). The
 * amount comparisons are made there, in numeric: `check` is returned only
 * for this link's pending row at the live balance (or past its expiry);
 * one at another amount is `replace`. Raises P0002 balance_link_not_found,
 * or P0001 balance_link_withdrawn, balance_link_expired,
 * balance_link_job_closed or balance_too_large.
 */
export async function prepareBalanceCheckout(
  supabase: ServiceSupabase,
  token: string,
): Promise<PrepareBalanceResult> {
  const { data, error } = await supabase.rpc("prepare_balance_checkout", {
    p_token: token,
  } satisfies PrepareBalanceArgs);
  if (error) throw rpcError("prepare_balance_checkout", error);
  const row = (data ?? [])[0];
  if (!row) throw new Error("prepare_balance_checkout returned no row");
  return { ...row, amount: String(row.amount) } as PrepareBalanceResult;
}

export type RecordBalanceCheckoutInput = {
  p_payment_id: string;
  p_link_id: string;
  /** prepare_balance_checkout's amount_cents, passed through unchanged (never computed here). */
  p_amount_cents: number;
  /** The Checkout Session Stripe just returned, as it returned it (validated in SQL). */
  p_session: Record<string, Json>;
};

export type RecordBalanceCheckoutResult = {
  /**
   * created: a pending balance payment for the link; existing: a replay of
   * this attempt, or another Stripe payment on the job is live or being
   * confirmed (its id and session); stale: the live balance is no longer
   * p_amount_cents; nothing_due: under S$0.50 is left.
   */
  outcome: "created" | "existing" | "stale" | "nothing_due";
  /** created and existing: the pending payment; null otherwise. */
  payment_id: string | null;
  stripe_checkout_session_id: string | null;
};

/**
 * Record the balance Checkout Session the app has just created, or say why
 * not (D156g, D156h). Raises P0001 checkout_session_mismatch (Stripe's echo
 * differs from what was asked, p_amount_cents included),
 * checkout_session_conflict and the prepare refusals.
 */
export async function recordBalanceCheckout(
  supabase: ServiceSupabase,
  input: RecordBalanceCheckoutInput,
): Promise<RecordBalanceCheckoutResult> {
  const { data, error } = await supabase.rpc(
    "record_balance_checkout",
    input satisfies RecordBalanceArgs,
  );
  if (error) throw rpcError("record_balance_checkout", error);
  const row = (data ?? [])[0];
  if (!row) throw new Error("record_balance_checkout returned no row");
  return row as RecordBalanceCheckoutResult;
}
