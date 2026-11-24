import "server-only";

import { StripeError } from "./gateway";
import type { StripeDeps } from "./deps";
import { recordStripeRead, type RecordStripeReadResult } from "./records";

/**
 * Stripe fees (D273; ADR-025 amendment; RUNBOOK "Stripe: fees"): Cult
 * Commons of a completed job bears the fees Stripe charged on the job's
 * payments. The fee is a fact Stripe holds on the charge's balance
 * transaction; BICII reads it with its own key (the PaymentIntent with
 * latest_charge.balance_transaction expanded) and records the read through
 * record_stripe_read, whose apply stores it (public.stripe_payment_fees).
 * Nothing here computes money: Postgres converts the cents and takes the
 * GST out.
 *
 * Never inside a webhook: Stripe's balance transaction can lag the paid
 * session (cards) and PayNow has none until the async payment succeeds, so
 * a payment whose fee is not there yet stays pending and the sweep reads
 * it again with a backoff (public.stripe_fees_due). A missing key
 * permission (stripe_auth_failed) leaves every fee pending and stops the
 * run; payments are never blocked by any of this. Any other failed read
 * (Stripe refused or could not answer, the database failed, or the read
 * was stored with an outcome the sweep cannot use) is counted with
 * note_stripe_fee_read_failed, so the sweep backs off on that payment and
 * reaches the others (one permanent failure never takes every run's slots).
 */

export type FeeRead =
  { kind: "read"; outcome: string | null } | { kind: "failed"; error: StripeError };

/**
 * Read one payment's fee from Stripe and record it. Throws for a database
 * error; a Stripe error is returned (the caller decides what it means).
 */
export async function readStripeFee(
  deps: StripeDeps,
  paymentId: string,
  paymentIntentId: string,
): Promise<FeeRead> {
  if (!deps.supabase || !deps.gateway) {
    return { kind: "failed", error: new StripeError("stripe_unavailable", true) };
  }
  let raw;
  try {
    raw = (await deps.gateway.retrievePaymentIntentWithFee(paymentIntentId)).raw;
  } catch (error) {
    if (error instanceof StripeError) return { kind: "failed", error };
    throw error;
  }
  const recorded: RecordStripeReadResult = await recordStripeRead(deps.supabase, {
    payment_id: paymentId,
    object: raw,
    correlation_id: deps.correlationId,
  });
  return { kind: "read", outcome: recorded.outcome };
}

/** Count a failed fee read so stripe_fees_due backs off on it (best effort: never throws). */
async function noteFailure(deps: StripeDeps, paymentId: string, code: string): Promise<void> {
  try {
    const { error } = await deps.supabase!.rpc("note_stripe_fee_read_failed", {
      p_payment_id: paymentId,
      p_error: code,
    });
    if (error) {
      deps.log.warn({ op: "stripe_fee", paymentId, code: error.code }, "could not note a fee read");
    }
  } catch {
    deps.log.warn({ op: "stripe_fee", paymentId }, "could not note a fee read");
  }
}

export type FeeSweepSummary = {
  /** Payments whose fee was read and recorded. */
  recorded: number;
  /** Read, but Stripe has no balance transaction yet (still pending). */
  pending: number;
  /** Stripe or the database failed for one payment. */
  failed: number;
  /** The key lacks Balance: Read: the run stopped at the first refusal. */
  permission: boolean;
};

/**
 * The integration cron's step (D273): up to `max` paid payments with no fee
 * recorded, oldest first (the backfill of earlier payments is the same
 * list), none started after `deadlineMs`. Off (null) while Stripe or the
 * service client is off.
 */
export async function sweepStripeFees(
  deps: StripeDeps,
  options: { max: number; deadlineMs: number },
): Promise<FeeSweepSummary | null> {
  if (!deps.supabase || !deps.gateway) return null;
  const summary: FeeSweepSummary = { recorded: 0, pending: 0, failed: 0, permission: false };
  const { data, error } = await deps.supabase.rpc("stripe_fees_due", {
    max_rows: options.max,
    p_livemode: deps.gateway.livemode,
  });
  if (error) throw Object.assign(new Error("stripe_fees_due failed"), { code: error.code });
  for (const row of data ?? []) {
    if (deps.now() >= options.deadlineMs) break;
    try {
      const read = await readStripeFee(deps, row.payment_id, row.payment_intent_id);
      if (read.kind === "failed") {
        summary.failed += 1;
        deps.log.warn(
          { op: "stripe_fee", paymentId: row.payment_id, code: read.error.code },
          "could not read a stripe fee",
        );
        if (read.error.code === "stripe_auth_failed") {
          summary.permission = true;
          break;
        }
        await noteFailure(deps, row.payment_id, read.error.code);
        continue;
      }
      if (read.outcome === "stripe_fee_recorded" || read.outcome === "stripe_fee_unchanged") {
        summary.recorded += 1;
      } else if (read.outcome === "stripe_fee_pending") {
        summary.pending += 1;
      } else {
        summary.failed += 1;
        deps.log.warn(
          { op: "stripe_fee", paymentId: row.payment_id, outcome: read.outcome },
          "stripe fee read needs attention",
        );
        await noteFailure(deps, row.payment_id, read.outcome ?? "unknown");
      }
    } catch (err) {
      summary.failed += 1;
      deps.log.warn(
        {
          op: "stripe_fee",
          paymentId: row.payment_id,
          code: (err as { code?: string }).code ?? null,
        },
        "could not record a stripe fee",
      );
      await noteFailure(deps, row.payment_id, "database_error");
    }
  }
  if (summary.recorded + summary.pending + summary.failed > 0) {
    deps.log.info({ op: "stripe_fee", ...summary }, "stripe fees swept");
  }
  return summary;
}
