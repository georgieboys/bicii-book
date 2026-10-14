import "server-only";

import { mapDbError } from "@/lib/db-errors";
import type { DepositState, IncompleteCheck, PaymentStatus } from "@/lib/payments";

import { CHECKOUT_HOST, REUSE_MARGIN_SECONDS, checkoutIdempotencyKey } from "./config";
import { StripeError, type CheckoutSession } from "./gateway";
import type { StripeDeps } from "./deps";
import {
  prepareDepositCheckout,
  recordDepositCheckout,
  recordStripeRead,
  type PrepareDepositResult,
  type RecordStripeReadResult,
  type StripeRpcError,
} from "./records";

/**
 * Checkout flows (Phase 14 step 2; D151, D153, D158, D159a; ADR-025;
 * RUNBOOK "Stripe payments"). Every payment fact comes from Stripe: the
 * customer's Pay and return, and staff's Check with Stripe, only trigger a
 * read the server makes with its own key (record_stripe_read). Nothing
 * here computes money: the amount and its cents come from Postgres
 * (prepare_deposit_checkout).
 *
 *   startDepositCheckout      Pay deposit: reuse the open session, or
 *                             create one (a fresh payment id per attempt,
 *                             so a fresh Idempotency-Key), then send the
 *                             customer to Stripe's URL once its host checks
 *   confirmDepositReturn      the customer back from Stripe: re-read the
 *                             open session, never create one
 *   refreshPaymentFromStripe  staff's Check with Stripe: re-read the
 *                             session, its PaymentIntent when Checkout
 *                             completed unpaid (an asynchronous failure
 *                             shows only there), and its refunds (R-086)
 *
 * The quote token appears only in the success and cancel URLs, which are
 * built from ADMIN_ORIGIN (never from the request's Host): never in
 * metadata, an idempotency key or a log line (R-088). Logs carry the op,
 * the payment id, codes and HTTP status only.
 */

export type StartDepositResult =
  | { kind: "redirect"; url: string }
  | { kind: "paid" }
  | { kind: "processing" }
  | { kind: "refunded" }
  | { kind: "refused"; reason: string; message: string }
  | { kind: "unavailable" };

export type RefreshResult =
  | {
      kind: "checked";
      before: PaymentStatus;
      after: PaymentStatus;
      /** After the check: pending with Checkout completed (Stripe still confirming). */
      processing: boolean;
      changed: boolean;
      /**
       * Null when every read was recorded. Otherwise the session was read
       * and recorded, but its PaymentIntent or refunds could not be:
       * `permission` when Stripe refused the key (stripe_auth_failed: the
       * restricted key lacks a permission, RUNBOOK "Stripe: restricted
       * key"), `unavailable` when Stripe was not reached or was busy
       * (network error or timeout, 409, 5xx, 429), `error` when Stripe answered but BICII could
       * not use it (400, not found, a bad response). When both reads fail
       * differently the worse wins: permission, then error (neither is
       * fixed by a retry), then unavailable.
       */
      incomplete: IncompleteCheck | null;
    }
  | { kind: "unavailable" }
  | { kind: "not_found" }
  | { kind: "other_mode" }
  /** Stripe has no such Checkout under this key (another account, or the fake restarted). */
  | { kind: "session_missing" };

/**
 * What a failed Stripe read means for Check with Stripe: the key refused,
 * Stripe not reached or busy, or an answer BICII could not use.
 */
export function incompleteCheckKind(error: StripeError): IncompleteCheck {
  switch (error.code) {
    case "stripe_auth_failed":
      return "permission";
    case "stripe_unavailable":
    case "stripe_rate_limited":
      return "unavailable";
    default:
      return "error";
  }
}

/** Worse first: permission and error (a retry cannot fix them) over unavailable. */
const INCOMPLETE_ORDER: readonly IncompleteCheck[] = ["permission", "error", "unavailable"];

/** The worse of two incomplete reads. */
function worseIncomplete(a: IncompleteCheck | null, b: IncompleteCheck): IncompleteCheck {
  if (a === null) return b;
  return INCOMPLETE_ORDER.indexOf(a) <= INCOMPLETE_ORDER.indexOf(b) ? a : b;
}

/** A pay attempt prepares at most this many times (a replaced or lost session loops once or twice). */
const MAX_ATTEMPTS = 3;

/**
 * Pay deposit starts no new Stripe step after this long, so a slow Stripe
 * (8-second timeouts, each retried once) answers "unavailable" inside the
 * quote page's 60-second maxDuration rather than being cut off.
 */
export const PAY_DEADLINE_MS = 30_000;

const QUOTE_NOT_FOUND_MESSAGE = "This link is not valid. Ask the shop for a new one.";

type Ready = {
  deps: StripeDeps & {
    supabase: NonNullable<StripeDeps["supabase"]>;
    gateway: NonNullable<StripeDeps["gateway"]>;
  };
  origin: string;
  /** Epoch milliseconds after which no new Stripe step starts (Pay only). */
  deadline: number;
};

/** Stripe on, a gateway and the service client, or null (no RPC runs). */
function ready(deps: StripeDeps, budgetMs = Number.POSITIVE_INFINITY): Ready | null {
  if (deps.config.state !== "on" || !deps.gateway || !deps.supabase) return null;
  return {
    deps: deps as Ready["deps"],
    origin: deps.config.origin,
    deadline: deps.now() + budgetMs,
  };
}

const pastDeadline = (r: Ready) => r.deps.now() > r.deadline;

function isRpcError(error: unknown): error is StripeRpcError {
  return error instanceof Error && typeof (error as StripeRpcError).code === "string";
}

/** The customer-safe sentence for an RPC refusal (src/lib/db-errors.ts). */
function refusal(error: StripeRpcError): { reason: string; message: string } {
  if (error.code === "P0002")
    return { reason: "quote_not_found", message: QUOTE_NOT_FOUND_MESSAGE };
  return {
    reason: error.reason ?? "unknown",
    message: mapDbError({ code: error.code, message: error.reason ?? "" }).message,
  };
}

/**
 * Where a customer may be sent: Stripe's own Checkout host for a live or
 * test key; for the fake, this Admin's quote page (its session url is the
 * success URL). Guards against an open redirect even if a response were
 * tampered with.
 */
export function validateRedirect(
  url: string | null,
  mode: "live" | "test" | "fake",
  origin: string,
): url is string {
  if (!url) return false;
  if (mode === "fake") return url.startsWith(`${origin}/quote/`);
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === CHECKOUT_HOST;
  } catch {
    return false;
  }
}

const PAID_GROUP: ReadonlySet<PaymentStatus> = new Set(["paid", "partially_refunded"]);

function logStripeError(deps: StripeDeps, op: string, paymentId: string, error: unknown): void {
  if (error instanceof StripeError) {
    deps.log.warn(
      {
        op,
        paymentId,
        code: error.code,
        status: error.status,
        stripeCode: error.stripeCode,
      },
      "stripe call failed",
    );
  } else if (isRpcError(error)) {
    deps.log.error({ op, paymentId, code: error.code, reason: error.reason }, "stripe rpc failed");
  } else {
    deps.log.error(
      { op, paymentId, error: error instanceof Error ? error.name : "unknown" },
      "stripe flow failed",
    );
  }
}

async function read(
  r: Ready,
  paymentId: string,
  object: CheckoutSession["raw"],
): Promise<RecordStripeReadResult> {
  return recordStripeRead(r.deps.supabase, {
    payment_id: paymentId,
    object,
    correlation_id: r.deps.correlationId,
  });
}

/** Expire a session BICII will not use (best effort; Stripe expires it in 60 minutes anyway). */
async function expireQuietly(r: Ready, paymentId: string, sessionId: string): Promise<void> {
  if (pastDeadline(r)) {
    r.deps.log.warn({ op: "expire", paymentId }, "checkout expire skipped: out of time");
    return;
  }
  try {
    await r.deps.gateway.expireCheckoutSession(sessionId);
  } catch (error) {
    logStripeError(r.deps, "expire", paymentId, error);
  }
}

type Step = { done: StartDepositResult } | { again: true };

/** `check`: re-read the pending session, then reuse it, replace it or report it. */
async function checkOpenSession(r: Ready, row: PrepareDepositResult): Promise<Step> {
  const { gateway, now } = r.deps;
  const paymentId = row.payment_id;
  let session: CheckoutSession;
  try {
    session = await gateway.retrieveCheckoutSession(row.stripe_checkout_session_id ?? "");
  } catch (error) {
    if (error instanceof StripeError && error.code === "stripe_not_found") {
      // The pending row names a session this key cannot see (another
      // Stripe account, or the fake restarted): it stays pending and blocks
      // Pay on this quote until it is resolved (RUNBOOK "Stripe: resolving
      // problems", R-086).
      r.deps.log.error({ op: "check", paymentId }, "pending checkout session not found at stripe");
      return { done: { kind: "unavailable" } };
    }
    throw error;
  }
  const result = await read(r, paymentId, session.raw);
  const status = result.payment_status;
  if (status && PAID_GROUP.has(status)) return { done: { kind: "paid" } };
  if (status === "refunded") return { done: { kind: "refunded" } };
  if (status !== "pending") return { again: true }; // expired or failed: a new attempt
  if (session.status === "complete") return { done: { kind: "processing" } };
  if (session.status !== "open") return { again: true };

  if (session.expiresAt > Math.floor(now() / 1000) + REUSE_MARGIN_SECONDS) {
    // The same session: tapping Pay twice never pays twice (D158d).
    if (validateRedirect(session.url, gateway.mode, r.origin)) {
      return { done: { kind: "redirect", url: session.url } };
    }
    r.deps.log.error({ op: "check", paymentId }, "checkout redirect refused");
    return { done: { kind: "unavailable" } };
  }

  // Too close to its expiry to finish paying: expire it and record that.
  if (pastDeadline(r)) return { done: { kind: "unavailable" } };
  try {
    const expired = await gateway.expireCheckoutSession(session.id);
    await read(r, paymentId, expired.raw);
  } catch (error) {
    if (!(error instanceof StripeError) || error.code !== "stripe_session_not_open") throw error;
    // Stripe moved it first (completed or expired): record what it is now.
    const current = await gateway.retrieveCheckoutSession(session.id);
    await read(r, paymentId, current.raw);
  }
  return { again: true };
}

/** `create`: a new Checkout Session for this attempt's payment id, then record it. */
async function createSession(r: Ready, row: PrepareDepositResult, token: string): Promise<Step> {
  const { gateway, supabase, log } = r.deps;
  const paymentId = row.payment_id;
  const session = await gateway.createCheckoutSession(
    {
      paymentId,
      workOrderId: row.work_order_id,
      quoteId: row.quote_id,
      kind: "deposit",
      jobNumber: row.job_number,
      amountCents: row.amount_cents,
      expiresAt: row.expires_at,
      successUrl: `${r.origin}/quote/${token}?deposit=returned`,
      cancelUrl: `${r.origin}/quote/${token}?deposit=cancelled`,
    },
    checkoutIdempotencyKey(paymentId),
  );
  // The response's payment methods (names only), so go-live can confirm PayNow is offered.
  const methods = session.raw.payment_method_types;
  log.info(
    {
      op: "create",
      paymentId,
      paymentMethodTypes: Array.isArray(methods)
        ? methods.filter((m): m is string => typeof m === "string")
        : null,
    },
    "checkout session created",
  );

  let recorded;
  try {
    recorded = await recordDepositCheckout(supabase, {
      p_payment_id: paymentId,
      p_quote_id: row.quote_id,
      session: session.raw,
    });
  } catch (error) {
    await expireQuietly(r, paymentId, session.id);
    if (isRpcError(error) && error.code === "P0001") {
      if (error.reason === "checkout_session_mismatch") {
        log.error({ op: "record", paymentId }, "checkout_response_mismatch");
        return { done: { kind: "unavailable" } };
      }
      return { done: { kind: "refused", ...refusal(error) } };
    }
    throw error;
  }

  switch (recorded.outcome) {
    case "created":
      if (validateRedirect(session.url, gateway.mode, r.origin)) {
        return { done: { kind: "redirect", url: session.url } };
      }
      log.error({ op: "create", paymentId }, "checkout redirect refused");
      await expireQuietly(r, paymentId, session.id);
      return { done: { kind: "unavailable" } };
    case "existing":
      if (recorded.payment_id === paymentId && recorded.stripe_checkout_session_id === session.id) {
        // This very attempt was already recorded (a replay): use it.
        if (validateRedirect(session.url, gateway.mode, r.origin)) {
          return { done: { kind: "redirect", url: session.url } };
        }
        return { done: { kind: "unavailable" } };
      }
      // Another click won: drop this session and re-read the winner's.
      await expireQuietly(r, paymentId, session.id);
      return { again: true };
    case "paid":
    case "processing":
    case "refunded":
      await expireQuietly(r, paymentId, session.id);
      return { done: { kind: recorded.outcome } };
  }
}

/**
 * The customer's Pay deposit (D158c, d): one open Checkout per quote,
 * reused until REUSE_MARGIN_SECONDS before it expires.
 */
export async function startDepositCheckout(
  token: string,
  deps: StripeDeps,
): Promise<StartDepositResult> {
  const r = ready(deps, PAY_DEADLINE_MS);
  if (!r) return { kind: "unavailable" };

  let paymentId = "";
  try {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      if (pastDeadline(r)) {
        deps.log.warn({ op: "pay", paymentId }, "checkout out of time");
        return { kind: "unavailable" };
      }
      let row: PrepareDepositResult;
      try {
        row = await prepareDepositCheckout(r.deps.supabase, token);
      } catch (error) {
        if (isRpcError(error) && (error.code === "P0002" || error.code === "P0001")) {
          return { kind: "refused", ...refusal(error) };
        }
        throw error;
      }
      paymentId = row.payment_id;

      let step: Step;
      switch (row.outcome) {
        case "paid":
        case "processing":
        case "refunded":
          return { kind: row.outcome };
        case "check":
          step = await checkOpenSession(r, row);
          break;
        case "create":
          step = await createSession(r, row, token);
          break;
      }
      if ("done" in step) return step.done;
    }
    deps.log.warn({ op: "pay", paymentId }, "checkout attempts exhausted");
    return { kind: "unavailable" };
  } catch (error) {
    logStripeError(deps, "pay", paymentId, error);
    return { kind: "unavailable" };
  }
}

/**
 * The customer back from Stripe (`?deposit=returned`): one verified
 * re-read of the open session. It never creates a session and never marks
 * anything paid from the return itself (D153). Null when it cannot tell.
 */
export async function confirmDepositReturn(
  token: string,
  deps: StripeDeps,
): Promise<{ state: DepositState | null }> {
  const r = ready(deps);
  if (!r) return { state: null };
  let paymentId = "";
  try {
    const row = await prepareDepositCheckout(r.deps.supabase, token);
    paymentId = row.payment_id;
    if (row.outcome === "paid" || row.outcome === "processing" || row.outcome === "refunded") {
      return { state: row.outcome };
    }
    if (row.outcome === "create") return { state: "due" };
    const session = await r.deps.gateway.retrieveCheckoutSession(
      row.stripe_checkout_session_id ?? "",
    );
    const result = await read(r, paymentId, session.raw);
    const status = result.payment_status;
    if (status && PAID_GROUP.has(status)) return { state: "paid" };
    if (status === "refunded") return { state: "refunded" };
    if (status === "pending" && session.status === "complete") return { state: "processing" };
    return { state: "due" };
  } catch (error) {
    if (!(isRpcError(error) && (error.code === "P0001" || error.code === "P0002"))) {
      logStripeError(deps, "return", paymentId, error);
    }
    return { state: null };
  }
}

/**
 * Staff's Check with Stripe (D159a; R-086): re-read the payment's session,
 * then, when Checkout completed unpaid, its PaymentIntent (an asynchronous
 * failure whose webhook was lost shows only there), then its refunds,
 * recording each through record_stripe_read. Staff supply only the payment
 * id; every value comes from Stripe. Once the session is recorded, a
 * failure to read the intent or the refunds is reported as `incomplete`
 * (with its kind: the key's permission, an answer BICII could not use, or
 * Stripe not reached; the worse when both reads fail), not as the whole
 * check failing.
 */
export async function refreshPaymentFromStripe(
  paymentId: string,
  deps: StripeDeps,
): Promise<RefreshResult> {
  const r = ready(deps);
  if (!r) return { kind: "unavailable" };
  const { supabase, gateway, log } = r.deps;
  const select =
    "id, status, refunded_amount, stripe_checkout_session_id, stripe_payment_intent_id, livemode";
  try {
    const { data: row, error } = await supabase
      .from("payments")
      .select(select)
      .eq("id", paymentId)
      .maybeSingle();
    if (error) throw Object.assign(new Error("payments read failed"), { code: error.code });
    if (!row) return { kind: "not_found" };
    if (row.livemode !== gateway.livemode) {
      log.warn({ op: "refresh", paymentId }, "payment in the other stripe mode");
      return { kind: "other_mode" };
    }

    let session: CheckoutSession;
    try {
      session = await gateway.retrieveCheckoutSession(row.stripe_checkout_session_id);
    } catch (error) {
      if (error instanceof StripeError && error.code === "stripe_not_found") {
        log.error({ op: "refresh", paymentId }, "checkout session not found at stripe");
        return { kind: "session_missing" };
      }
      throw error;
    }
    const recorded = await read(r, paymentId, session.raw);
    let incomplete: IncompleteCheck | null = null;
    const pi = session.paymentIntent ?? row.stripe_payment_intent_id;
    if (
      pi &&
      recorded.payment_status === "pending" &&
      session.status === "complete" &&
      session.paymentStatus === "unpaid"
    ) {
      try {
        const intent = await gateway.retrievePaymentIntent(pi);
        await read(r, paymentId, intent.raw);
      } catch (error) {
        if (!(error instanceof StripeError)) throw error;
        logStripeError(deps, "refresh_intent", paymentId, error);
        incomplete = worseIncomplete(incomplete, incompleteCheckKind(error));
      }
    }
    if (pi) {
      try {
        for (const refund of await gateway.listRefunds(pi)) {
          await read(r, paymentId, refund.raw);
        }
      } catch (error) {
        if (!(error instanceof StripeError)) throw error;
        logStripeError(deps, "refresh_refunds", paymentId, error);
        incomplete = worseIncomplete(incomplete, incompleteCheckKind(error));
      }
    }

    const { data: after, error: afterError } = await supabase
      .from("payments")
      .select("status, refunded_amount, checkout_completed_at")
      .eq("id", paymentId)
      .single();
    if (afterError) {
      throw Object.assign(new Error("payments read failed"), { code: afterError.code });
    }
    return {
      kind: "checked",
      before: row.status,
      after: after.status,
      processing: after.status === "pending" && Boolean(after.checkout_completed_at),
      changed:
        after.status !== row.status ||
        String(after.refunded_amount) !== String(row.refunded_amount),
      incomplete,
    };
  } catch (error) {
    logStripeError(deps, "refresh", paymentId, error);
    return { kind: "unavailable" };
  }
}
