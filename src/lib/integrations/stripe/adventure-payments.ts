import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";

import { StripeError } from "./gateway";
import type { StripeDeps } from "./deps";

/**
 * Adventure payments outside checkout (audit fixes, D225; A-42):
 *
 *   - expireAdventureCheckouts: before an admin cancels an unpaid booking,
 *     its open Stripe page is expired so it can no longer be paid. Best
 *     effort: a page that already ended, or Stripe being off, changes
 *     nothing, and a payment that still lands is flagged by the database.
 *   - checkStaleAdventurePayments: the cron reads back sessions whose
 *     webhook never moved their payment, and records what Stripe says.
 */

export async function expireAdventureCheckouts(
  deps: StripeDeps,
  staff: SupabaseClient<Database>,
  bookingId: string,
): Promise<number> {
  if (!deps.gateway) return 0;
  const { data, error } = await staff
    .from("adventure_payments")
    .select("id, stripe_checkout_session_id")
    .eq("booking_id", bookingId)
    .eq("status", "pending")
    .not("stripe_checkout_session_id", "is", null);
  if (error) {
    deps.log.warn({ op: "adventure.expire", code: error.code }, "could not read open payments");
    return 0;
  }
  let expired = 0;
  for (const row of data ?? []) {
    try {
      await deps.gateway.expireCheckoutSession(row.stripe_checkout_session_id as string);
      expired += 1;
    } catch (err) {
      // Already complete or expired: Stripe's own event records it.
      if (!(err instanceof StripeError && err.code === "stripe_session_not_open")) {
        deps.log.warn(
          { op: "adventure.expire", paymentId: row.id },
          "could not expire the Stripe page",
        );
      }
    }
  }
  return expired;
}

export type StalePaymentSummary = { checked: number; failed: number };

export async function checkStaleAdventurePayments(
  deps: StripeDeps,
  options: { max: number; deadlineMs: number },
): Promise<StalePaymentSummary> {
  const summary: StalePaymentSummary = { checked: 0, failed: 0 };
  if (!deps.supabase || !deps.gateway) return summary;
  const { data, error } = await deps.supabase.rpc("stale_adventure_payments", {
    max_rows: options.max,
  });
  if (error)
    throw Object.assign(new Error("stale_adventure_payments failed"), { code: error.code });
  for (const row of data ?? []) {
    if (deps.now() >= options.deadlineMs) break;
    try {
      const session = await deps.gateway.retrieveCheckoutSession(row.session_id);
      const recorded = await deps.supabase.rpc("record_adventure_stripe_read", {
        payment_id: row.payment_id,
        object: session.raw as never,
        correlation_id: deps.correlationId,
      });
      if (recorded.error)
        throw Object.assign(new Error("record failed"), { code: recorded.error.code });
      summary.checked += 1;
    } catch (err) {
      summary.failed += 1;
      deps.log.warn(
        {
          op: "adventure.stale",
          paymentId: row.payment_id,
          code: (err as { code?: string }).code ?? null,
        },
        "could not check a stale adventure payment",
      );
    }
  }
  return summary;
}
