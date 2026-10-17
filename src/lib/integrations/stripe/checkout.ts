import "server-only";

import { mapDbError } from "@/lib/db-errors";
import type { DepositState, IncompleteCheck, PaymentStatus } from "@/lib/payments";

import type { ServiceSupabase } from "../shopify/deps";
import { CHECKOUT_HOST, REUSE_MARGIN_SECONDS, checkoutIdempotencyKey } from "./config";
import { StripeError, type CheckoutSession, type CheckoutSessionInput } from "./gateway";
import type { StripeDeps } from "./deps";
import {
  prepareBalanceCheckout,
  prepareDepositCheckout,
  recordBalanceCheckout,
  recordDepositCheckout,
  recordStripeRead,
  type PrepareBalanceResult,
  type PrepareDepositResult,
  type RecordStripeReadResult,
  type StripeRpcError,
} from "./records";

/**
 * Checkout flows (Phase 14 steps 2 and 3; D151, D153, D156g-h, D158,
 * D159a, D161g; ADR-025; RUNBOOK "Stripe payments"). Every payment fact
 * comes from Stripe: the customer's Pay and return, and staff's Check with
 * Stripe, only trigger a read the server makes with its own key
 * (record_stripe_read). Nothing here computes money: the amount, its
 * cents and every comparison of amounts are Postgres's
 * (prepare_deposit_checkout, prepare_balance_checkout and the record RPCs).
 *
 *   startDepositCheckout      Pay deposit on the quote page
 *   startBalanceCheckout      Pay on a balance link's /pay page
 *                             Both run one loop (payLoop) over their
 *                             prepare/record pair: reuse the open session,
 *                             expire one that must go first (replace), or
 *                             create one (a fresh payment id per attempt,
 *                             so a fresh Idempotency-Key), then send the
 *                             customer to Stripe's URL once its host checks
 *   confirmDepositReturn      the customer back from Stripe: re-read the
 *   confirmBalanceReturn      pending session, never create or expire one
 *   expireOpenCheckouts       after a counter payment or a resent link:
 *                             expire the job's open sessions and record
 *                             Stripe's answer (best effort, never throws)
 *   refreshPaymentFromStripe  staff's Check with Stripe: re-read the
 *                             session, its PaymentIntent when Checkout
 *                             completed unpaid (an asynchronous failure
 *                             shows only there), and its refunds (R-086)
 *
 * The quote or link token appears only in the success and cancel URLs,
 * which are built from ADMIN_ORIGIN (never from the request's Host): never
 * in metadata, an idempotency key or a log line (R-088, R-091). Logs carry
 * the op, the flow, payment and job ids, codes and HTTP status only.
 */

/** Each flow's customer page: in fake mode the session's url (its success URL) must be on it. */
export type PagePrefix = "/quote/" | "/pay/";

/** What either Pay can answer. */
type PayCommon =
  | { kind: "redirect"; url: string }
  /** A payment (the deposit's, or any on the job for a balance) is being confirmed by Stripe. */
  | { kind: "processing" }
  | { kind: "refused"; reason: string; message: string }
  | { kind: "unavailable" };

type DepositOwn = { kind: "paid" } | { kind: "refunded" };
type BalanceOwn = { kind: "nothing_due" };

export type StartDepositResult = PayCommon | DepositOwn;

/** Pay on a balance link; `nothing_due`: under S$0.50 is left to pay online. */
export type StartBalanceResult = PayCommon | BalanceOwn;

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
 * Pay (either flow) and expireOpenCheckouts start no new Stripe step after
 * this long, so a slow Stripe (8-second timeouts, each retried once)
 * answers "unavailable" inside the page's 60-second maxDuration rather
 * than being cut off.
 */
export const PAY_DEADLINE_MS = 30_000;

const QUOTE_NOT_FOUND = {
  reason: "quote_not_found",
  message: "This link is not valid. Ask the shop for a new one.",
};
const LINK_NOT_FOUND = {
  reason: "balance_link_not_found",
  message: "This link is not valid. Ask the shop for a new one.",
};

/**
 * prepare_deposit_checkout's job_payment_processing (D156h): a balance
 * payment on the job is being confirmed, so no deposit session is created
 * until Stripe decides. Its own sentence: the deposit itself is still due.
 */
const JOB_PAYMENT_PROCESSING = {
  reason: "job_payment_processing",
  message: "A payment for this job is being confirmed by Stripe. Try again in a few minutes.",
};

type Ready = {
  deps: StripeDeps & {
    supabase: NonNullable<StripeDeps["supabase"]>;
    gateway: NonNullable<StripeDeps["gateway"]>;
  };
  origin: string;
  /** Epoch milliseconds after which no new Stripe step starts (Pay and expiring only). */
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

/** The flow's name on every log line of one Pay or return. */
function withFlow(deps: StripeDeps, flow: "deposit" | "balance"): StripeDeps {
  return { ...deps, log: deps.log.child({ flow }) };
}

function isRpcError(error: unknown): error is StripeRpcError {
  return error instanceof Error && typeof (error as StripeRpcError).code === "string";
}

/** Stripe has no such session under this key (another account, or the fake restarted). */
function isSessionMissing(error: unknown): boolean {
  return error instanceof StripeError && error.code === "stripe_not_found";
}

/** A column the RPC sets for this outcome; a missing one breaks its contract (logged, unavailable). */
function required<T>(value: T | null | undefined, column: string): T {
  if (value === null || value === undefined) throw new Error(`checkout row has no ${column}`);
  return value;
}

/** An outcome the RPC does not document: logged by the loop, answered as unavailable. */
function unknownOutcome(rpc: string): never {
  throw new Error(`${rpc} answered an unknown outcome`);
}

/** The customer-safe sentence for an RPC refusal (src/lib/db-errors.ts); P0002 is the flow's own. */
function refusal(
  error: StripeRpcError,
  notFound: { reason: string; message: string },
): { reason: string; message: string } {
  if (error.code === "P0002") return notFound;
  return {
    reason: error.reason ?? "unknown",
    message: mapDbError({ code: error.code, message: error.reason ?? "" }).message,
  };
}

/**
 * Where a customer may be sent: Stripe's own Checkout host for a live or
 * test key; for the fake, this Admin's page for that flow (its session
 * url is the success URL): `/quote/` for a deposit, `/pay/` for a balance,
 * so neither flow can send the customer to the other's page (the URL is
 * parsed, so its origin and resolved path are compared, never its raw
 * text). Guards against an open redirect even if a response were
 * tampered with.
 */
export function validateRedirect(
  url: string | null,
  mode: "live" | "test" | "fake",
  origin: string,
  pagePrefix: PagePrefix,
): url is string {
  if (!url) return false;
  try {
    // Parsed first, so dot segments (`/pay/../quote/…`, `%2e%2e` too) are
    // resolved before the fake's page prefix is compared.
    const parsed = new URL(url);
    if (mode === "fake") return parsed.origin === origin && parsed.pathname.startsWith(pagePrefix);
    return parsed.protocol === "https:" && parsed.hostname === CHECKOUT_HOST;
  } catch {
    return false;
  }
}

const PAID_GROUP: ReadonlySet<PaymentStatus> = new Set(["paid", "partially_refunded"]);

function logStripeError(
  deps: StripeDeps,
  op: string,
  paymentId: string | null,
  error: unknown,
): void {
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

/**
 * Expire a session BICII has just created and will not use (best effort;
 * Stripe expires it in 60 minutes anyway). It has no payment row, so
 * nothing is recorded.
 */
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

/**
 * Expire a recorded pending session at Stripe and record Stripe's answer
 * (record_stripe_read). When Stripe says it is no longer open (the
 * customer completed it, or it expired first), re-read it and record that
 * instead: the row moves to expired, or to paid when the customer won the
 * race (D159b). Throws what Stripe or the RPC threw.
 */
async function expireAndRecord(
  r: Ready,
  paymentId: string,
  sessionId: string,
): Promise<{ session: CheckoutSession; recorded: RecordStripeReadResult }> {
  let session: CheckoutSession;
  try {
    session = await r.deps.gateway.expireCheckoutSession(sessionId);
  } catch (error) {
    if (!(error instanceof StripeError) || error.code !== "stripe_session_not_open") throw error;
    session = await r.deps.gateway.retrieveCheckoutSession(sessionId);
  }
  return { session, recorded: await read(r, paymentId, session.raw) };
}

type Answer<Own> = Own | PayCommon;
type Step<Own> = { done: Answer<Own> } | { again: true };

/** The columns of a prepared row the shared loop reads (both prepare RPCs return them). */
type PreparedRow = {
  outcome: string;
  payment_id: string | null;
  work_order_id: string;
  job_number: string;
  amount_cents: number;
  stripe_checkout_session_id: string | null;
  expires_at: number | null;
};

type RecordedCheckout = {
  outcome: string;
  payment_id: string | null;
  stripe_checkout_session_id: string | null;
};

/** What one prepared row asks of the loop. */
type Route<Own> =
  /** A final answer; `retire`: first expire and record the row's pending session, best effort. */
  | { done: Answer<Own>; retire?: boolean }
  /** check: re-read this flow's pending session; replace: expire another first; create: a new one. */
  | { step: "check" | "replace" | "create" };

/**
 * One Pay flow over the shared loop: its prepare/record pair, its return
 * page and what its own outcomes mean. The attempts and the budget, the
 * re-reads, the expiries and the redirect check are payLoop's.
 */
type PayFlow<Row extends PreparedRow, Own> = {
  /** The customer page Stripe returns to: `${origin}${page}${token}?${marker}=returned|cancelled`. */
  page: PagePrefix;
  marker: "deposit" | "balance";
  kind: CheckoutSessionInput["kind"];
  prepare: (supabase: ServiceSupabase, token: string) => Promise<Row>;
  route: (row: Row) => Route<Own>;
  /** The quote a new session is for; null for a balance. */
  quoteId: (row: Row) => string | null;
  /** Record the session this attempt created, for `paymentId`. */
  record: (
    supabase: ServiceSupabase,
    row: Row,
    paymentId: string,
    session: CheckoutSession,
  ) => Promise<RecordedCheckout>;
  /** After check's read: a status this flow answers itself (the deposit's paid or refunded), or null. */
  afterRead: (status: PaymentStatus | null) => Answer<Own> | null;
  /** A recorded outcome other than created or existing (the new session is already expired). */
  afterRecord: (outcome: string) => Step<Own>;
  /** A P0002 from prepare: this flow's "not valid" answer. */
  notFound: { reason: string; message: string };
};

/** The success and cancel URLs, from ADMIN_ORIGIN; the only place the token goes to Stripe. */
function returnUrls(
  origin: string,
  flow: { page: PagePrefix; marker: string },
  token: string,
): { successUrl: string; cancelUrl: string } {
  const base = `${origin}${flow.page}${token}?${flow.marker}=`;
  return { successUrl: `${base}returned`, cancelUrl: `${base}cancelled` };
}

/**
 * `check`: re-read the pending session, then reuse it, replace it or
 * report it. Reused only while open and more than REUSE_MARGIN_SECONDS
 * from its expiry; whether its amount is still right is Postgres's call
 * (a balance session at another amount comes back as `replace`, never
 * `check`), so nothing here compares money.
 */
async function checkOpenSession<Row extends PreparedRow, Own>(
  r: Ready,
  flow: PayFlow<Row, Own>,
  row: Row,
): Promise<Step<Own>> {
  const { gateway, now } = r.deps;
  const paymentId = required(row.payment_id, "payment_id");
  let session: CheckoutSession;
  try {
    session = await gateway.retrieveCheckoutSession(row.stripe_checkout_session_id ?? "");
  } catch (error) {
    if (isSessionMissing(error)) {
      // The pending row names a session this key cannot see (another
      // Stripe account, or the fake restarted): it stays pending and blocks
      // Pay until it is resolved (RUNBOOK "Stripe: resolving problems",
      // R-086).
      r.deps.log.error({ op: "check", paymentId }, "pending checkout session not found at stripe");
      return { done: { kind: "unavailable" } };
    }
    throw error;
  }
  const result = await read(r, paymentId, session.raw);
  const status = result.payment_status;
  const own = flow.afterRead(status);
  if (own) return { done: own };
  if (status !== "pending") return { again: true }; // expired or failed: a new attempt
  if (session.status === "complete") return { done: { kind: "processing" } };
  if (session.status !== "open") return { again: true };

  if (session.expiresAt > Math.floor(now() / 1000) + REUSE_MARGIN_SECONDS) {
    // The same session: tapping Pay twice never pays twice (D158d).
    if (validateRedirect(session.url, gateway.mode, r.origin, flow.page)) {
      return { done: { kind: "redirect", url: session.url } };
    }
    r.deps.log.error({ op: "check", paymentId }, "checkout redirect refused");
    return { done: { kind: "unavailable" } };
  }

  // Too close to its expiry to finish paying: expire it and record that.
  if (pastDeadline(r)) return { done: { kind: "unavailable" } };
  await expireAndRecord(r, paymentId, session.id);
  return { again: true };
}

/**
 * `replace`: another pending session on the job must go before this
 * flow's (D156h: a live or processing balance payment never sits beside
 * another live or processing Stripe payment). Expire it, record Stripe's
 * answer against its own payment, then ask again.
 */
async function replaceSession(r: Ready, row: PreparedRow): Promise<Step<never>> {
  const paymentId = required(row.payment_id, "payment_id");
  const sessionId = required(row.stripe_checkout_session_id, "stripe_checkout_session_id");
  if (pastDeadline(r)) {
    r.deps.log.warn({ op: "replace", paymentId }, "checkout out of time");
    return { done: { kind: "unavailable" } };
  }
  try {
    await expireAndRecord(r, paymentId, sessionId);
  } catch (error) {
    if (isSessionMissing(error)) {
      r.deps.log.error(
        { op: "replace", paymentId },
        "pending checkout session not found at stripe",
      );
      return { done: { kind: "unavailable" } };
    }
    throw error;
  }
  return { again: true };
}

/** A final answer's pending session is no longer wanted (nothing_due): expire and record it, best effort. */
async function retireQuietly(r: Ready, row: PreparedRow): Promise<void> {
  const { payment_id: paymentId, stripe_checkout_session_id: sessionId } = row;
  if (!paymentId || !sessionId) return;
  if (pastDeadline(r)) {
    r.deps.log.warn({ op: "retire", paymentId }, "checkout expire skipped: out of time");
    return;
  }
  try {
    await expireAndRecord(r, paymentId, sessionId);
  } catch (error) {
    logStripeError(r.deps, "retire", paymentId, error);
  }
}

/** `create`: a new Checkout Session for this attempt's payment id, then record it. */
async function createSession<Row extends PreparedRow, Own>(
  r: Ready,
  flow: PayFlow<Row, Own>,
  row: Row,
  token: string,
): Promise<Step<Own>> {
  const { gateway, supabase, log } = r.deps;
  const paymentId = required(row.payment_id, "payment_id");
  const session = await gateway.createCheckoutSession(
    {
      paymentId,
      workOrderId: row.work_order_id,
      quoteId: flow.quoteId(row),
      kind: flow.kind,
      jobNumber: row.job_number,
      // Postgres's cents and 60-minute expiry, passed through unchanged.
      amountCents: row.amount_cents,
      expiresAt: required(row.expires_at, "expires_at"),
      ...returnUrls(r.origin, flow, token),
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

  let recorded: RecordedCheckout;
  try {
    recorded = await flow.record(supabase, row, paymentId, session);
  } catch (error) {
    await expireQuietly(r, paymentId, session.id);
    if (isRpcError(error) && error.code === "P0001") {
      if (error.reason === "checkout_session_mismatch") {
        // Stripe's echo is not what was asked: a retry would not fix it.
        log.error({ op: "record", paymentId }, "checkout_response_mismatch");
        return { done: { kind: "unavailable" } };
      }
      return { done: { kind: "refused", ...refusal(error, flow.notFound) } };
    }
    throw error;
  }

  switch (recorded.outcome) {
    case "created":
      if (validateRedirect(session.url, gateway.mode, r.origin, flow.page)) {
        return { done: { kind: "redirect", url: session.url } };
      }
      log.error({ op: "create", paymentId }, "checkout redirect refused");
      await expireQuietly(r, paymentId, session.id);
      return { done: { kind: "unavailable" } };
    case "existing":
      if (recorded.payment_id === paymentId && recorded.stripe_checkout_session_id === session.id) {
        // This very attempt was already recorded (a replay): use it.
        if (validateRedirect(session.url, gateway.mode, r.origin, flow.page)) {
          return { done: { kind: "redirect", url: session.url } };
        }
        log.error({ op: "create", paymentId }, "checkout redirect refused");
        return { done: { kind: "unavailable" } };
      }
      // Another session won (another click, or another payment on the job):
      // drop this one and ask again.
      await expireQuietly(r, paymentId, session.id);
      return { again: true };
    default:
      await expireQuietly(r, paymentId, session.id);
      return flow.afterRecord(recorded.outcome);
  }
}

/**
 * The Pay loop both flows share: prepare, then check, replace or create,
 * at most MAX_ATTEMPTS times and never starting a Stripe step after
 * PAY_DEADLINE_MS. A refusal from prepare is the flow's sentence; anything
 * unexpected is logged by code and answered "unavailable".
 */
async function payLoop<Row extends PreparedRow, Own>(
  flow: PayFlow<Row, Own>,
  token: string,
  deps: StripeDeps,
): Promise<Answer<Own>> {
  const r = ready(deps, PAY_DEADLINE_MS);
  if (!r) return { kind: "unavailable" };

  let paymentId: string | null = "";
  try {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      if (pastDeadline(r)) {
        deps.log.warn({ op: "pay", paymentId }, "checkout out of time");
        return { kind: "unavailable" };
      }
      let row: Row;
      try {
        row = await flow.prepare(r.deps.supabase, token);
      } catch (error) {
        if (isRpcError(error) && (error.code === "P0002" || error.code === "P0001")) {
          return { kind: "refused", ...refusal(error, flow.notFound) };
        }
        throw error;
      }
      paymentId = row.payment_id;

      const route = flow.route(row);
      if ("done" in route) {
        if (route.retire) await retireQuietly(r, row);
        return route.done;
      }
      let step: Step<Own>;
      switch (route.step) {
        case "check":
          step = await checkOpenSession(r, flow, row);
          break;
        case "replace":
          step = await replaceSession(r, row);
          break;
        case "create":
          step = await createSession(r, flow, row, token);
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

/** Pay deposit (D158c, d): one open Checkout per quote, for the deposit Postgres computed. */
const DEPOSIT_FLOW: PayFlow<PrepareDepositResult, DepositOwn> = {
  page: "/quote/",
  marker: "deposit",
  kind: "deposit",
  prepare: prepareDepositCheckout,
  route(row) {
    switch (row.outcome) {
      case "paid":
      case "processing":
      case "refunded":
        return { done: { kind: row.outcome } };
      case "job_payment_processing":
        return { done: { kind: "refused", ...JOB_PAYMENT_PROCESSING } };
      case "check":
      case "replace":
      case "create":
        return { step: row.outcome };
      default:
        return unknownOutcome("prepare_deposit_checkout");
    }
  },
  quoteId: (row) => row.quote_id,
  record: (supabase, row, paymentId, session) =>
    recordDepositCheckout(supabase, {
      p_payment_id: paymentId,
      p_quote_id: row.quote_id,
      session: session.raw,
    }),
  afterRead(status) {
    if (status && PAID_GROUP.has(status)) return { kind: "paid" };
    if (status === "refunded") return { kind: "refunded" };
    return null;
  },
  afterRecord(outcome) {
    switch (outcome) {
      case "paid":
      case "processing":
      case "refunded":
        return { done: { kind: outcome } };
      default:
        return unknownOutcome("record_deposit_checkout");
    }
  },
  notFound: QUOTE_NOT_FOUND,
};

/**
 * Pay on a balance link (D156g, D156h): at most one pending linked balance
 * payment per job, for the live balance Postgres computes at every Pay.
 */
const BALANCE_FLOW: PayFlow<PrepareBalanceResult, BalanceOwn> = {
  page: "/pay/",
  marker: "balance",
  kind: "balance",
  prepare: prepareBalanceCheckout,
  route(row) {
    switch (row.outcome) {
      case "processing":
        return { done: { kind: "processing" } };
      case "nothing_due":
        // Under S$0.50 left: this link's pending session, if any, goes.
        return { done: { kind: "nothing_due" }, retire: true };
      case "check":
      case "replace":
      case "create":
        return { step: row.outcome };
      default:
        return unknownOutcome("prepare_balance_checkout");
    }
  },
  quoteId: () => null,
  record: (supabase, row, paymentId, session) =>
    recordBalanceCheckout(supabase, {
      p_payment_id: paymentId,
      p_link_id: row.link_id,
      // The cents prepare gave, unchanged: record compares Stripe's echo
      // and the live balance with them (stale, mismatch).
      p_amount_cents: row.amount_cents,
      p_session: session.raw,
    }),
  // Paid, refunded, expired or failed: prepare says what is left next.
  afterRead: () => null,
  afterRecord(outcome) {
    switch (outcome) {
      case "stale":
        // The balance moved between prepare and record: ask again.
        return { again: true };
      case "nothing_due":
        return { done: { kind: "nothing_due" } };
      default:
        return unknownOutcome("record_balance_checkout");
    }
  },
  notFound: LINK_NOT_FOUND,
};

/** The customer's Pay deposit on the quote page (D158c, d). */
export async function startDepositCheckout(
  token: string,
  deps: StripeDeps,
): Promise<StartDepositResult> {
  return payLoop(DEPOSIT_FLOW, token, withFlow(deps, "deposit"));
}

/**
 * The customer's Pay on a balance link's /pay page (D156g, D156h): reuse
 * this link's open session at the live balance, replace any other open
 * session on the job first, or create one; never while a payment on the
 * job is being confirmed (processing), and not when under S$0.50 is left
 * (nothing_due).
 */
export async function startBalanceCheckout(
  token: string,
  deps: StripeDeps,
): Promise<StartBalanceResult> {
  return payLoop(BALANCE_FLOW, token, withFlow(deps, "balance"));
}

/**
 * The customer back from Stripe (`?deposit=returned`): one verified
 * re-read of the open session. It never creates a session and never marks
 * anything paid from the return itself (D153). A balance payment on the
 * job (replace, job_payment_processing) leaves the deposit due. Null when
 * it cannot tell.
 */
export async function confirmDepositReturn(
  token: string,
  rawDeps: StripeDeps,
): Promise<{ state: DepositState | null }> {
  const r = ready(rawDeps);
  if (!r) return { state: null };
  const deps = withFlow(rawDeps, "deposit");
  let paymentId: string | null = "";
  try {
    const row = await prepareDepositCheckout(r.deps.supabase, token);
    paymentId = row.payment_id;
    switch (row.outcome) {
      case "paid":
      case "processing":
      case "refunded":
        return { state: row.outcome };
      case "create":
      case "replace":
      case "job_payment_processing":
        return { state: "due" };
      case "check":
        break;
      default:
        return unknownOutcome("prepare_deposit_checkout");
    }
    const session = await r.deps.gateway.retrieveCheckoutSession(
      row.stripe_checkout_session_id ?? "",
    );
    const result = await read(r, required(row.payment_id, "payment_id"), session.raw);
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
 * What the customer's return from a balance Checkout found: `paid` (a
 * payment on the job went through), `processing` (Checkout completed and
 * Stripe is still confirming), `due` or `nothing_due` (what is left now).
 */
export type BalanceReturnState = "paid" | "processing" | "due" | "nothing_due";

/**
 * The customer back from Stripe on /pay (`?balance=returned`): one
 * verified re-read of the pending session prepare_balance_checkout names
 * (this link's, or the one it would replace), recorded as Stripe's word
 * (D159a). It never creates or expires a session and never marks anything
 * paid from the return itself (D153). Null when it cannot tell (the link
 * refused, Stripe unreachable, Stripe off).
 */
export async function confirmBalanceReturn(
  token: string,
  rawDeps: StripeDeps,
): Promise<{ state: BalanceReturnState | null }> {
  const r = ready(rawDeps);
  if (!r) return { state: null };
  const deps = withFlow(rawDeps, "balance");
  let paymentId: string | null = "";
  try {
    const row = await prepareBalanceCheckout(r.deps.supabase, token);
    paymentId = row.payment_id;
    let otherwise: BalanceReturnState;
    switch (row.outcome) {
      case "processing":
        return { state: "processing" };
      case "create":
        return { state: "due" };
      case "check":
      case "replace":
        otherwise = "due";
        break;
      case "nothing_due":
        otherwise = "nothing_due";
        break;
      default:
        return unknownOutcome("prepare_balance_checkout");
    }
    if (!row.payment_id || !row.stripe_checkout_session_id) return { state: otherwise };
    const session = await r.deps.gateway.retrieveCheckoutSession(row.stripe_checkout_session_id);
    const status = (await read(r, row.payment_id, session.raw)).payment_status;
    if (status && PAID_GROUP.has(status)) return { state: "paid" };
    if (status === "pending" && session.status === "complete") return { state: "processing" };
    return { state: otherwise };
  } catch (error) {
    if (!(isRpcError(error) && (error.code === "P0001" || error.code === "P0002"))) {
      logStripeError(deps, "return", paymentId, error);
    }
    return { state: null };
  }
}

/**
 * What expireOpenCheckouts did with the job's open sessions:
 *   expired  expired at Stripe (or found already closed with nothing paid)
 *            and recorded: no longer payable
 *   paid     the customer completed it first: recorded as paid, or as
 *            Checkout completed and Stripe still confirming; money came in
 *            online as well
 *   failed   not expired or not recorded (Stripe unreachable or out of
 *            time, the session unknown to Stripe, a database error, or the
 *            job's payments unreadable, which counts once): it may still
 *            be payable; Check with Stripe settles it
 * All three are 0 when Stripe is off (nothing can be expired).
 */
export type ExpireOpenCheckoutsResult = { expired: number; paid: number; failed: number };

/**
 * After a counter payment (D161g) or a resent link (D156h): expire, best
 * effort, the job's open Checkout sessions the new state makes wrong, so
 * the customer cannot finish an online payment for money already taken
 * (step3-critique C9, C20). Selects with the service client the job's
 * pending payments whose Checkout has not completed and whose session has
 * not expired, that are a balance, or (with `quoteId`) that quote's
 * deposit (record_counter_payment's open_checkouts); for each, expires it
 * and records Stripe's answer (record_stripe_read), re-reading it when
 * Stripe says it is no longer open. Never throws into the caller; skipped
 * while Stripe is off; logs ids and codes only.
 */
export async function expireOpenCheckouts(
  workOrderId: string,
  { quoteId = null, deps }: { quoteId?: string | null; deps: StripeDeps },
): Promise<ExpireOpenCheckoutsResult> {
  const counts: ExpireOpenCheckoutsResult = { expired: 0, paid: 0, failed: 0 };
  try {
    const r = ready(deps, PAY_DEADLINE_MS);
    if (!r) return counts;
    const { supabase, gateway, log, now } = r.deps;

    let open: Array<{ id: string; sessionId: string }>;
    try {
      const { data, error } = await supabase
        .from("payments")
        .select("id, kind, quote_id, stripe_checkout_session_id")
        .eq("work_order_id", workOrderId)
        .eq("status", "pending")
        .is("checkout_completed_at", null)
        .gt("stripe_session_expires_at", new Date(now()).toISOString());
      if (error) throw Object.assign(new Error("payments read failed"), { code: error.code });
      open = (data ?? [])
        .filter((p) => p.kind === "balance" || (quoteId !== null && p.quote_id === quoteId))
        .map((p) => ({ id: p.id, sessionId: p.stripe_checkout_session_id }));
    } catch (error) {
      log.error(
        {
          op: "expire_open",
          workOrderId,
          code: isRpcError(error) ? error.code : undefined,
          error: error instanceof Error ? error.name : "unknown",
        },
        "open checkouts unreadable",
      );
      counts.failed += 1;
      return counts;
    }

    for (const { id: paymentId, sessionId } of open) {
      if (pastDeadline(r)) {
        log.warn({ op: "expire_open", paymentId }, "checkout expire skipped: out of time");
        counts.failed += 1;
        continue;
      }
      try {
        const { session, recorded } = await expireAndRecord(r, paymentId, sessionId);
        const status = recorded.payment_status;
        const paidThrough =
          (status !== null && PAID_GROUP.has(status)) ||
          (status === "pending" && session.status === "complete");
        if (paidThrough) counts.paid += 1;
        else counts.expired += 1;
      } catch (error) {
        logStripeError(r.deps, "expire_open", paymentId, error);
        counts.failed += 1;
      }
    }
    if (open.length > 0) {
      log.info(
        { op: "expire_open", workOrderId, mode: gateway.mode, ...counts },
        "open checkouts expired",
      );
    }
    return counts;
  } catch (error) {
    logStripeError(deps, "expire_open", null, error);
    counts.failed += 1;
    return counts;
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
