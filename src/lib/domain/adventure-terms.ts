import "server-only";

import { unwrap } from "@/lib/db-errors";
import type { ServerSupabase } from "@/lib/supabase/server";

/**
 * The owner's sales terms in the Admin (D212-D218): published waivers, a
 * booking's signature and refund state, and tracker late fees. Every rule
 * is in Postgres; these read and call it.
 */

export type Waiver = { version: string; title: string; publishedAt: string; bodySha256: string };

export async function listWaivers(supabase: ServerSupabase): Promise<Waiver[]> {
  const rows = unwrap(
    await supabase
      .from("adventure_waivers")
      .select("version, title, published_at, body_sha256")
      .order("published_at", { ascending: false })
      .limit(50),
  );
  return (rows ?? []).map((r) => ({
    version: r.version,
    title: r.title,
    publishedAt: r.published_at,
    bodySha256: r.body_sha256,
  }));
}

/** Admin: publish a new, sealed waiver version (D215). */
export async function publishWaiver(
  supabase: ServerSupabase,
  version: string,
  title: string,
  body: string,
): Promise<void> {
  unwrap(await supabase.rpc("publish_adventure_waiver", { version, title, body }));
}

export type WaiverSignature = {
  waiverVersion: string;
  signedName: string;
  signedAt: string;
  emergencyContactName: string;
  emergencyContactPhone: string;
};

export type LateFee = {
  id: string;
  daysLate: number;
  amount: string;
  returnedOn: string;
  status: "owed" | "paid" | "waived";
  settleNote: string;
  settledAt: string | null;
};

export type BookingTerms = {
  signature: WaiverSignature | null;
  refundable: boolean;
  sentForReviewAt: string | null;
  lateFees: LateFee[];
};

export async function getBookingTerms(
  supabase: ServerSupabase,
  bookingId: string,
): Promise<BookingTerms> {
  const [signature, refund, fees] = await Promise.all([
    supabase
      .from("adventure_waiver_signatures")
      .select(
        "waiver_version, signed_name, signed_at, emergency_contact_name, emergency_contact_phone",
      )
      .eq("booking_id", bookingId)
      .maybeSingle(),
    supabase.rpc("adventure_booking_refund_state", { booking_id: bookingId }),
    supabase
      .from("tracker_late_fees")
      .select("id, days_late, amount, returned_on, status, settle_note, settled_at")
      .eq("booking_id", bookingId)
      .order("created_at"),
  ]);
  const sig = unwrap(signature);
  const state = (unwrap(refund) ?? [])[0];
  return {
    signature: sig
      ? {
          waiverVersion: sig.waiver_version,
          signedName: sig.signed_name,
          signedAt: sig.signed_at,
          emergencyContactName: sig.emergency_contact_name,
          emergencyContactPhone: sig.emergency_contact_phone,
        }
      : null,
    refundable: state?.refundable ?? false,
    sentForReviewAt: state?.sent_for_review_at ?? null,
    lateFees: (unwrap(fees) ?? []).map((f) => ({
      id: f.id,
      daysLate: f.days_late,
      amount: String(f.amount),
      returnedOn: f.returned_on,
      status: f.status,
      settleNote: f.settle_note,
      settledAt: f.settled_at,
    })),
  };
}

/** manage_adventures: take a rider's name off the finisher board (D218). */
export async function hideBoardName(
  supabase: ServerSupabase,
  bookingId: string,
  reason: string,
): Promise<void> {
  unwrap(await supabase.rpc("hide_adventure_board_name", { booking_id: bookingId, reason }));
}

/** Admin: a late fee paid at the shop, or waived with a reason (D213). */
export async function settleLateFee(
  supabase: ServerSupabase,
  feeId: string,
  outcome: "paid" | "waived",
  note: string,
): Promise<void> {
  unwrap(await supabase.rpc("settle_tracker_late_fee", { fee_id: feeId, outcome, note }));
}

/** Admin: let a rider whose board name was taken down choose another (D229). */
export async function unlockBoardName(supabase: ServerSupabase, bookingId: string): Promise<void> {
  unwrap(await supabase.rpc("unlock_adventure_board_name", { booking_id: bookingId }));
}
