import "server-only";

import type { Database, Json } from "@/lib/database.types";
import { mapDbError } from "@/lib/db-errors";

import type { ServiceSupabase } from "../shopify/deps";

/**
 * Typed wrappers of the Stripe service-role RPCs (DATA-MODEL §16, §19):
 * every payment, refund and Stripe event change goes through them. A
 * database error is rethrown with its SQLSTATE and the mapped reason (a
 * P0001 code or a constraint name), never its raw message in a response.
 * Phase 14 step 2 adds the Checkout RPCs (prepare_deposit_checkout,
 * record_deposit_checkout) here.
 */

type Functions = Database["public"]["Functions"];
type RecordEventArgs = Functions["record_stripe_event"]["Args"];
type RecordReadArgs = Functions["record_stripe_read"]["Args"];

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
