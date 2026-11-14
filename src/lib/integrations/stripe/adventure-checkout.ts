import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { AdventureParticipation } from "@/lib/adventures";
import type { Database } from "@/lib/database.types";
import { mapDbError } from "@/lib/db-errors";

import { CHECKOUT_HOST, checkoutIdempotencyKey } from "./config";
import type { StripeDeps } from "./deps";
import { StripeError, type CheckoutSession } from "./gateway";

/**
 * Starting an adventure payment (Adventures Phase B, D167, D172; handoff
 * §10.2-10.3). The public site's Server Action calls the Admin's
 * /api/adventures/checkout with the rider's own access token; the route
 * verifies it with Supabase Auth and hands this module a client acting as
 * that rider. Here:
 *
 *   1. prepare_my_adventure_checkout runs AS THE RIDER: Postgres resolves
 *      their customer record, checks sales, terms, revision and offer, and
 *      freezes the price. Nothing here computes an amount.
 *   2. An open Checkout Session already recorded for the payment is
 *      reused (retrieved from Stripe for its URL).
 *   3. Otherwise a session is created with the payment's stable
 *      Idempotency-Key, so a retry after a lost response gets the same
 *      session back, then recorded with record_adventure_checkout (service
 *      role). A webhook that arrives first adopts the session itself.
 *   4. The URL is checked to be Stripe's Checkout host (or, for the fake,
 *      the public site's own booking page) before the rider is sent there.
 *
 * No database lock is held while Stripe is called.
 */

export type AdventureCheckoutRequest = {
  requestId: string;
  adventureSlug: string;
  kind: AdventureParticipation;
  revisionNumber: number;
  tshirtSize: string;
  finisherName: "first_name_initial" | "full_name" | "hidden" | "preferred_name";
  /**
   * The finisher board name the rider chose (D218): a name, or "" for not
   * on the board. Absent: unchanged (off the board until they choose).
   */
  boardName?: string;
  termsVersion: string;
  /** Tracker hire days (D187); absent: the rider's own device. */
  hire?: { collectOn: string; returnOn: string };
  /** The supported departure (D196). */
  departureId?: string;
};

export type AdventureCheckoutResult =
  | { ok: true; url: string; bookingId: string; reference: string }
  | { ok: false; status: number; reason: string; message: string };

type Prepared = {
  booking_id: string;
  reference: string;
  payment_id: string;
  amount_cents: number;
  expires_at: string;
  description: string;
  reused: boolean;
};

const UNAVAILABLE = {
  ok: false as const,
  status: 503,
  reason: "stripe_unavailable",
  message: "Payments are not available right now. Try again in a few minutes.",
};

/** Stripe's host for a live or test key; the public site's booking pages for the fake. */
export function validAdventureRedirect(
  url: string | null,
  mode: "live" | "test" | "fake",
  siteOrigin: string,
): url is string {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (mode === "fake") {
      return parsed.origin === siteOrigin && parsed.pathname.startsWith("/account/adventures/");
    }
    return parsed.protocol === "https:" && parsed.hostname === CHECKOUT_HOST;
  } catch {
    return false;
  }
}

/** Where Stripe sends the rider back: their booking on the public site, or the adventures page. */
export function adventureReturnUrls(
  siteUrl: string,
  bookingId: string,
): { success: string; cancel: string } {
  const base = siteUrl.replace(/\/+$/, "");
  return {
    success: `${base}/account/adventures/${bookingId}?checkout=done`,
    cancel: `${base}/adventures?checkout=cancelled`,
  };
}

function refused(error: { code?: string; message?: string }): AdventureCheckoutResult {
  if (error.code === "42501") {
    return {
      ok: false,
      status: 403,
      reason: "customer_required",
      message: "Sign in to your BICII account to buy a certified ride.",
    };
  }
  const mapped = mapDbError({ code: error.code ?? "", message: error.message ?? "" });
  return {
    ok: false,
    status: error.code === "P0001" ? 409 : 500,
    reason: mapped.reason ?? "unknown",
    message: mapped.message,
  };
}

export async function startAdventureCheckout(
  deps: StripeDeps,
  rider: SupabaseClient<Database>,
  request: AdventureCheckoutRequest,
  siteUrl: string,
): Promise<AdventureCheckoutResult> {
  if (deps.config.state !== "on" || !deps.gateway || !deps.supabase) return UNAVAILABLE;
  const gateway = deps.gateway;
  const service = deps.supabase;

  // 1. As the rider: Postgres decides everything.
  const { data, error } = await rider.rpc("prepare_my_adventure_checkout", {
    request_id: request.requestId,
    adventure_slug: request.adventureSlug,
    kind: request.kind,
    revision_number: request.revisionNumber,
    tshirt_size: request.tshirtSize,
    finisher_name: request.finisherName,
    terms_version: request.termsVersion,
    ...(request.hire
      ? {
          recording_method: "tracker_hire" as const,
          hire_collect_on: request.hire.collectOn,
          hire_return_on: request.hire.returnOn,
        }
      : {}),
    ...(request.departureId ? { departure_id: request.departureId } : {}),
  });
  if (error) return refused(error);
  const prepared = (Array.isArray(data) ? data[0] : data) as Prepared | undefined;
  if (!prepared) {
    deps.log.error({ op: "adventure.prepare" }, "prepare returned no row");
    return UNAVAILABLE;
  }
  const log = deps.log.child({ bookingId: prepared.booking_id, paymentId: prepared.payment_id });

  // The board name is the rider's (D218), set as the rider before paying.
  if (request.boardName !== undefined) {
    const named = await rider.rpc("set_my_board_name", {
      booking_id: prepared.booking_id,
      board_name: request.boardName,
    });
    if (named.error) return refused(named.error);
  }

  try {
    // 2. A session already recorded for this payment: reuse it while open.
    const existing = await service
      .from("adventure_payments")
      .select("stripe_checkout_session_id")
      .eq("id", prepared.payment_id)
      .maybeSingle();
    if (existing.error) throw existing.error;
    let session: CheckoutSession | null = null;
    if (existing.data?.stripe_checkout_session_id) {
      session = await gateway.retrieveCheckoutSession(existing.data.stripe_checkout_session_id);
      if (session.status !== "open") {
        return {
          ok: false,
          status: 409,
          reason:
            session.status === "complete"
              ? "adventure_payment_processing"
              : "adventure_booking_closed",
          message:
            session.status === "complete"
              ? "Your payment is being confirmed. Check your booking in a few minutes."
              : "This checkout has expired. Start again.",
        };
      }
    } else {
      // 3. Create with the payment's stable key, then record it.
      const urls = adventureReturnUrls(siteUrl, prepared.booking_id);
      session = await gateway.createCheckoutSession(
        {
          subject: "adventure",
          paymentId: prepared.payment_id,
          bookingReference: prepared.reference,
          description: prepared.description,
          amountCents: Number(prepared.amount_cents),
          expiresAt: Math.floor(new Date(prepared.expires_at).getTime() / 1000),
          successUrl: urls.success,
          cancelUrl: urls.cancel,
        },
        checkoutIdempotencyKey(prepared.payment_id),
      );
      const recorded = await service.rpc("record_adventure_checkout", {
        payment_id: prepared.payment_id,
        session: session.raw,
      });
      if (recorded.error) {
        log.error(
          { op: "adventure.record", code: recorded.error.code },
          "record_adventure_checkout failed",
        );
        return refused(recorded.error);
      }
    }

    // 4. Only Stripe's own page (or the fake's return page).
    if (!validAdventureRedirect(session.url, gateway.mode, new URL(siteUrl).origin)) {
      log.error({ op: "adventure.redirect" }, "checkout url refused");
      return UNAVAILABLE;
    }
    return {
      ok: true,
      url: session.url,
      bookingId: prepared.booking_id,
      reference: prepared.reference,
    };
  } catch (err) {
    if (err instanceof StripeError) {
      log.warn(
        { op: "adventure.checkout", code: err.code, status: err.status },
        "stripe call failed",
      );
    } else {
      log.error(
        { op: "adventure.checkout", error: err instanceof Error ? err.name : "unknown" },
        "checkout failed",
      );
    }
    return UNAVAILABLE;
  }
}
