import type { Json } from "@/lib/database.types";

import { METADATA_KEYS } from "./config";
import { checkoutSessionParams, formEncode } from "./form";
import {
  StripeError,
  toCheckoutSession,
  toPaymentIntent,
  type CheckoutSession,
  type CheckoutSessionInput,
  type StripeGateway,
  type StripePaymentIntent,
  type StripeRefundObject,
} from "./gateway";

/**
 * The in-memory Stripe (STRIPE_ADAPTER=fake: local development, CI and
 * E2E; env.ts refuses it with a key or in production). Pure and
 * deterministic, with test drivers.
 *
 * A session's id is `cs_test_fake_` plus the payment id without dashes, so
 * each Checkout attempt has its own. Its url is the success URL itself:
 * in fake mode Pay deposit returns straight to the quote page. There is no
 * fake Checkout page and no route that signs webhooks: E2E posts signed
 * events to /api/stripe/webhooks itself (tests/fixtures/stripe.ts), and
 * the fake's own copy of the session stays open, which is harmless because
 * applying only moves forward. Like Stripe, a session reads as expired once
 * its expires_at has passed (by the injected clock), and create refuses an
 * expiry outside Stripe's 30-minute to 24-hour window (form.ts).
 */

export type FakeCall = {
  op: "create" | "retrieve" | "expire" | "list" | "retrieve_pi";
  key?: string;
  id?: string;
};

type Op = FakeCall["op"];

export type FakeStripeGateway = StripeGateway & {
  readonly calls: FakeCall[];
  readonly sessions: Map<string, CheckoutSession>;
  /** Stripe completing the session: paid (default) or unpaid (an async method still processing). */
  complete(
    sessionId: string,
    options?: { paid?: boolean; paymentIntent?: string },
  ): CheckoutSession;
  /** Stripe expiring the session on its own. */
  expire(sessionId: string): CheckoutSession;
  /**
   * An asynchronous payment failing after Checkout completed unpaid: the
   * session stays complete and unpaid, the intent returns to
   * requires_payment_method (R-086).
   */
  failAsyncPayment(sessionId: string): StripePaymentIntent;
  addRefund(
    paymentIntent: string,
    refund: { id?: string; amountCents: number; status: string },
  ): StripeRefundObject;
  /** The next call of `op` throws `error` (once). */
  failNext(op: Op, error: StripeError): void;
  reset(): void;
};

export function createFakeStripeGateway({
  now = Date.now,
}: {
  /** Epoch milliseconds (Stripe's clock for expiry; injected by tests). */
  now?: () => number;
} = {}): FakeStripeGateway {
  const calls: FakeCall[] = [];
  const sessions = new Map<string, CheckoutSession>();
  const intents = new Map<string, StripePaymentIntent>();
  const bodies = new Map<string, { body: string; sessionId: string }>();
  const refunds = new Map<string, StripeRefundObject[]>();
  const failures = new Map<Op, StripeError>();
  let refundSeq = 0;

  function failIfAsked(op: Op): void {
    const error = failures.get(op);
    if (error) {
      failures.delete(op);
      throw error;
    }
  }

  function store(raw: Record<string, Json>): CheckoutSession {
    const session = toCheckoutSession(raw, false);
    sessions.set(session.id, session);
    return session;
  }

  /** The stored session, expired by Stripe's clock once its time has passed. */
  function existing(id: string): CheckoutSession {
    const session = sessions.get(id);
    if (!session) throw new StripeError("stripe_not_found", false, 404);
    if (session.status === "open" && session.expiresAt <= Math.floor(now() / 1000)) {
      return store({ ...session.raw, status: "expired", url: null });
    }
    return session;
  }

  function storeIntent(id: string, status: string, amountCents: number): StripePaymentIntent {
    const intent = toPaymentIntent(
      {
        id,
        object: "payment_intent",
        livemode: false,
        status,
        amount: amountCents,
        currency: "sgd",
        created: Math.floor(now() / 1000),
        metadata: {},
      },
      false,
    );
    intents.set(id, intent);
    return intent;
  }

  const cents = (session: CheckoutSession) =>
    typeof session.raw.amount_total === "number" ? session.raw.amount_total : 0;

  return {
    mode: "fake",
    livemode: false,
    calls,
    sessions,

    async createCheckoutSession(input: CheckoutSessionInput, idempotencyKey: string) {
      calls.push({ op: "create", key: idempotencyKey });
      failIfAsked("create");
      // The same bytes Stripe would get; the same key with other bytes is a conflict.
      const body = formEncode(checkoutSessionParams(input, Math.floor(now() / 1000)));
      const seen = bodies.get(idempotencyKey);
      if (seen) {
        if (seen.body !== body) throw new StripeError("stripe_idempotency_conflict", false, 400);
        return existing(seen.sessionId);
      }
      const id = `cs_test_fake_${input.paymentId.replace(/-/g, "")}`;
      const metadata: Record<string, string> = {
        [METADATA_KEYS.payment]: input.paymentId,
        [METADATA_KEYS.job]: input.workOrderId,
        [METADATA_KEYS.kind]: input.kind,
      };
      if (input.quoteId !== null) metadata[METADATA_KEYS.quote] = input.quoteId;
      bodies.set(idempotencyKey, { body, sessionId: id });
      return store({
        id,
        object: "checkout.session",
        livemode: false,
        mode: "payment",
        status: "open",
        payment_status: "unpaid",
        amount_total: input.amountCents,
        amount_subtotal: input.amountCents,
        currency: "sgd",
        client_reference_id: input.paymentId,
        metadata,
        payment_intent: null,
        payment_method_types: ["card", "paynow"],
        url: input.successUrl,
        expires_at: input.expiresAt,
        created: Math.floor(now() / 1000),
      });
    },

    async retrieveCheckoutSession(id: string) {
      calls.push({ op: "retrieve", id });
      failIfAsked("retrieve");
      return existing(id);
    },

    async expireCheckoutSession(id: string) {
      calls.push({ op: "expire", id });
      failIfAsked("expire");
      const session = existing(id);
      if (session.status !== "open") throw new StripeError("stripe_session_not_open", false, 400);
      return store({ ...session.raw, status: "expired", url: null });
    },

    async listRefunds(paymentIntentId: string) {
      calls.push({ op: "list", id: paymentIntentId });
      failIfAsked("list");
      return [...(refunds.get(paymentIntentId) ?? [])];
    },

    async retrievePaymentIntent(id: string) {
      calls.push({ op: "retrieve_pi", id });
      failIfAsked("retrieve_pi");
      const intent = intents.get(id);
      if (!intent) throw new StripeError("stripe_not_found", false, 404);
      return intent;
    },

    complete(sessionId, { paid = true, paymentIntent } = {}) {
      const session = existing(sessionId);
      const pi = paymentIntent ?? `pi_fake_${sessionId.slice("cs_test_fake_".length)}`;
      storeIntent(pi, paid ? "succeeded" : "processing", cents(session));
      return store({
        ...session.raw,
        status: "complete",
        payment_status: paid ? "paid" : "unpaid",
        payment_intent: pi,
        url: null,
      });
    },

    expire(sessionId) {
      const session = existing(sessionId);
      return store({ ...session.raw, status: "expired", url: null });
    },

    failAsyncPayment(sessionId) {
      const session = existing(sessionId);
      if (
        session.status !== "complete" ||
        session.paymentStatus !== "unpaid" ||
        !session.paymentIntent
      ) {
        throw new Error("failAsyncPayment needs a session completed unpaid");
      }
      return storeIntent(session.paymentIntent, "requires_payment_method", cents(session));
    },

    addRefund(paymentIntent, { id, amountCents, status }) {
      refundSeq += 1;
      const refundId = id ?? `re_fake_${refundSeq}`;
      const refund: StripeRefundObject = {
        id: refundId,
        raw: {
          id: refundId,
          object: "refund",
          amount: amountCents,
          currency: "sgd",
          status,
          payment_intent: paymentIntent,
          created: Math.floor(now() / 1000),
          metadata: {},
        },
      };
      refunds.set(paymentIntent, [...(refunds.get(paymentIntent) ?? []), refund]);
      return refund;
    },

    failNext(op, error) {
      failures.set(op, error);
    },

    reset() {
      calls.length = 0;
      sessions.clear();
      intents.clear();
      bodies.clear();
      refunds.clear();
      failures.clear();
      refundSeq = 0;
    },
  };
}
