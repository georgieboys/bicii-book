// @vitest-environment node
/**
 * The Checkout flows (Phase 14 step 2; D151, D153, D158, D159a; ADR-025)
 * with the in-memory Stripe and scripted RPCs: when Pay deposit creates,
 * reuses, replaces or refuses a session, where the customer may be sent,
 * that the return never creates, staff's Check with Stripe, and that logs
 * never carry the quote token or a URL. The RPCs themselves are
 * tests/db/indent-deposits.test.ts.
 */
import pino from "pino";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  PAY_DEADLINE_MS,
  confirmDepositReturn,
  refreshPaymentFromStripe,
  startDepositCheckout,
  validateRedirect,
} = await import("@/lib/integrations/stripe/checkout");

import type { StripeConfig } from "@/lib/integrations/stripe/client";
import type { StripeDeps } from "@/lib/integrations/stripe/deps";
import { createFakeStripeGateway } from "@/lib/integrations/stripe/fake-gateway";
import {
  StripeError,
  toCheckoutSession,
  type CheckoutSessionInput,
  type StripeGateway,
} from "@/lib/integrations/stripe/gateway";
import type { ServiceSupabase } from "@/lib/integrations/shopify/deps";

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde";
const ORIGIN = "http://localhost:3000";
const NOW_MS = 1_800_000_000_000;
const NOW_S = NOW_MS / 1000;
const JOB = "66666666-7777-4888-9999-000000000000";
const QUOTE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const P1 = "11111111-2222-4333-8444-000000000001";
const P2 = "11111111-2222-4333-8444-000000000002";
const P3 = "11111111-2222-4333-8444-000000000003";
const SUCCESS = `${ORIGIN}/quote/${TOKEN}?deposit=returned`;

const ON: StripeConfig = {
  state: "on",
  mode: "fake",
  livemode: false,
  origin: ORIGIN,
  webhookSecret: "whsec_biciiE2eNotARealSecret",
  secretKey: null,
};

type Row = Record<string, unknown>;
type RpcResult = { data?: unknown; error?: { code: string; message: string } };
type Handler = (args: Row) => RpcResult;

const prepared = (outcome: string, over: Row = {}): RpcResult => ({
  data: [
    {
      outcome,
      payment_id: P1,
      work_order_id: JOB,
      quote_id: QUOTE,
      job_number: "J-0042",
      amount: 120,
      amount_cents: 12000,
      currency: "SGD",
      stripe_checkout_session_id: null,
      expires_at: NOW_S + 3600,
      ...over,
    },
  ],
});

const readResult = (payment_status: string): RpcResult => ({
  data: [{ event_id: "ev-1", event_status: "applied", outcome: "x", payment_status }],
});

const refused = (message: string, code = "P0001"): RpcResult => ({ error: { code, message } });

/** A sequence of answers per RPC (the last one repeats). */
function rpcScript(script: Record<string, Array<RpcResult | Handler>>) {
  const calls: Array<{ name: string; args: Row }> = [];
  const used: Record<string, number> = {};
  const rpc = async (name: string, args: Row) => {
    calls.push({ name, args });
    const answers = script[name];
    if (!answers) throw new Error(`unexpected rpc ${name}`);
    const i = Math.min(used[name] ?? 0, answers.length - 1);
    used[name] = (used[name] ?? 0) + 1;
    const answer = answers[i];
    const r = typeof answer === "function" ? answer(args) : answer;
    return { data: r.data ?? null, error: r.error ?? null };
  };
  return { calls, rpc };
}

/** The fake on Stripe's clock at NOW_MS. */
const fakeStripe = () => createFakeStripeGateway({ now: () => NOW_MS });

/** A session made 59 minutes ago, so it now expires inside the reuse margin. */
async function nearlyExpired(paymentId: string) {
  let at = NOW_MS - 59 * 60_000;
  const gateway = createFakeStripeGateway({ now: () => at });
  const session = await gateway.createCheckoutSession(
    input(paymentId, NOW_S + 60),
    `bicii-checkout-${paymentId}`,
  );
  at = NOW_MS;
  return { gateway, session };
}

function makeDeps(
  script: Record<string, Array<RpcResult | Handler>>,
  over: Partial<StripeDeps> & { rows?: Array<Row | null> } = {},
) {
  const { rows = [], ...rest } = over;
  const { calls, rpc } = rpcScript(script);
  const lines: string[] = [];
  const log = pino({ level: "trace" }, { write: (line: string) => void lines.push(line) });
  const queued = [...rows];
  const next = async () => ({ data: queued.length > 1 ? queued.shift() : queued[0], error: null });
  const supabase = {
    rpc,
    from: (table: string) => {
      if (table !== "payments") throw new Error(`unexpected table ${table}`);
      return { select: () => ({ eq: () => ({ maybeSingle: next, single: next }) }) };
    },
  } as unknown as ServiceSupabase;
  const gateway = fakeStripe();
  const deps: StripeDeps = {
    supabase,
    gateway,
    config: ON,
    log,
    correlationId: "req-1",
    now: () => NOW_MS,
    ...rest,
  };
  return { deps, gateway, calls, lines, names: () => calls.map((c) => c.name) };
}

function input(paymentId: string, expiresAt = NOW_S + 3600): CheckoutSessionInput {
  return {
    paymentId,
    workOrderId: JOB,
    quoteId: QUOTE,
    kind: "deposit",
    jobNumber: "J-0042",
    amountCents: 12000,
    expiresAt,
    successUrl: SUCCESS,
    cancelUrl: `${ORIGIN}/quote/${TOKEN}?deposit=cancelled`,
  };
}

function expectCleanLogs(lines: string[]) {
  const all = lines.join("\n");
  for (const banned of [TOKEN, "/quote/", "http://", "https://", "deposit=returned"]) {
    expect(all, banned).not.toContain(banned);
  }
}

describe("startDepositCheckout (D158)", () => {
  it("create: a new session for this attempt's payment id, recorded, then Stripe's url", async () => {
    const { deps, gateway, calls, lines } = makeDeps({
      prepare_deposit_checkout: [prepared("create")],
      record_deposit_checkout: [
        (args) => ({
          data: [
            {
              outcome: "created",
              payment_id: args.p_payment_id,
              stripe_checkout_session_id: (args.session as Row).id,
            },
          ],
        }),
      ],
    });
    const result = await startDepositCheckout(TOKEN, deps);
    expect(result).toEqual({ kind: "redirect", url: SUCCESS });
    expect(gateway.calls).toEqual([{ op: "create", key: `bicii-checkout-${P1}` }]);
    const record = calls.find((c) => c.name === "record_deposit_checkout")!;
    expect(record.args).toMatchObject({ p_payment_id: P1, p_quote_id: QUOTE });
    const session = [...gateway.sessions.values()][0];
    // Return URLs come from the configured origin, never from the request.
    expect(session.raw).toMatchObject({ amount_total: 12000, expires_at: NOW_S + 3600 });
    expect(calls[0]).toEqual({ name: "prepare_deposit_checkout", args: { token: TOKEN } });
    expectCleanLogs(lines);
  });

  it("check with an open session: re-read at Stripe, then the same url, no new session", async () => {
    const gateway = fakeStripe();
    const open = await gateway.createCheckoutSession(input(P1), `bicii-checkout-${P1}`);
    gateway.calls.length = 0;
    const { deps, calls, names } = makeDeps({
      prepare_deposit_checkout: [prepared("check", { stripe_checkout_session_id: open.id })],
      record_stripe_read: [readResult("pending")],
    });
    deps.gateway = gateway;
    const result = await startDepositCheckout(TOKEN, deps);
    expect(result).toEqual({ kind: "redirect", url: open.url });
    expect(gateway.calls).toEqual([{ op: "retrieve", id: open.id }]);
    expect(names()).toEqual(["prepare_deposit_checkout", "record_stripe_read"]);
    expect(calls[1].args).toMatchObject({ payment_id: P1, correlation_id: "req-1" });
    expect((calls[1].args.object as Row).id).toBe(open.id);
  });

  it("check within the reuse margin: expire it, record that, then a new session", async () => {
    const { gateway, session: old } = await nearlyExpired(P1);
    gateway.calls.length = 0;
    const { deps, calls } = makeDeps({
      prepare_deposit_checkout: [
        prepared("check", { stripe_checkout_session_id: old.id }),
        prepared("create", { payment_id: P2 }),
      ],
      record_stripe_read: [readResult("pending"), readResult("expired")],
      record_deposit_checkout: [
        (args) => ({
          data: [
            {
              outcome: "created",
              payment_id: args.p_payment_id,
              stripe_checkout_session_id: (args.session as Row).id,
            },
          ],
        }),
      ],
    });
    deps.gateway = gateway;
    const result = await startDepositCheckout(TOKEN, deps);
    expect(result).toEqual({ kind: "redirect", url: SUCCESS });
    expect(gateway.calls).toEqual([
      { op: "retrieve", id: old.id },
      { op: "expire", id: old.id },
      { op: "create", key: `bicii-checkout-${P2}` },
    ]);
    expect(calls.map((c) => c.name)).toEqual([
      "prepare_deposit_checkout",
      "record_stripe_read",
      "record_stripe_read",
      "prepare_deposit_checkout",
      "record_deposit_checkout",
    ]);
    expect((calls[2].args.object as Row).status).toBe("expired");
    expect(gateway.sessions.get(old.id)?.status).toBe("expired");
  });

  it("check whose expire finds it no longer open: retrieve and record it again", async () => {
    const { gateway, session: old } = await nearlyExpired(P1);
    gateway.calls.length = 0;
    gateway.failNext("expire", new StripeError("stripe_session_not_open", false, 400));
    const { deps, calls } = makeDeps({
      prepare_deposit_checkout: [
        prepared("check", { stripe_checkout_session_id: old.id }),
        prepared("paid"),
      ],
      record_stripe_read: [readResult("pending")],
    });
    deps.gateway = gateway;
    expect(await startDepositCheckout(TOKEN, deps)).toEqual({ kind: "paid" });
    expect(gateway.calls.map((c) => c.op)).toEqual(["retrieve", "expire", "retrieve"]);
    expect(calls.filter((c) => c.name === "record_stripe_read")).toHaveLength(2);
  });

  it("check whose read says paid, refunded or completed: no redirect", async () => {
    for (const [status, complete, kind] of [
      ["paid", false, "paid"],
      ["partially_refunded", false, "paid"],
      ["refunded", false, "refunded"],
      ["pending", true, "processing"],
    ] as const) {
      const gateway = fakeStripe();
      const s = await gateway.createCheckoutSession(input(P1), `bicii-checkout-${P1}`);
      if (complete) gateway.complete(s.id, { paid: false });
      const { deps } = makeDeps({
        prepare_deposit_checkout: [prepared("check", { stripe_checkout_session_id: s.id })],
        record_stripe_read: [readResult(status)],
      });
      deps.gateway = gateway;
      expect(await startDepositCheckout(TOKEN, deps), status).toEqual({ kind });
    }
  });

  it("record says another attempt won: expire the new session, then reuse the winner's", async () => {
    const gateway = fakeStripe();
    const winner = await gateway.createCheckoutSession(input(P3), `bicii-checkout-${P3}`);
    gateway.calls.length = 0;
    const { deps } = makeDeps({
      prepare_deposit_checkout: [
        prepared("create"),
        prepared("check", { payment_id: P3, stripe_checkout_session_id: winner.id }),
      ],
      record_deposit_checkout: [
        { data: [{ outcome: "existing", payment_id: P3, stripe_checkout_session_id: winner.id }] },
      ],
      record_stripe_read: [readResult("pending")],
    });
    deps.gateway = gateway;
    expect(await startDepositCheckout(TOKEN, deps)).toEqual({ kind: "redirect", url: winner.url });
    const mine = `cs_test_fake_${P1.replace(/-/g, "")}`;
    expect(gateway.calls).toEqual([
      { op: "create", key: `bicii-checkout-${P1}` },
      { op: "expire", id: mine },
      { op: "retrieve", id: winner.id },
    ]);
    expect(gateway.sessions.get(mine)?.status).toBe("expired");
  });

  it("record says checkout_session_mismatch: expire the new session, unavailable", async () => {
    const { deps, gateway, lines } = makeDeps({
      prepare_deposit_checkout: [prepared("create")],
      record_deposit_checkout: [refused("checkout_session_mismatch")],
    });
    expect(await startDepositCheckout(TOKEN, deps)).toEqual({ kind: "unavailable" });
    expect(gateway.calls.map((c) => c.op)).toEqual(["create", "expire"]);
    expect(lines.join("\n")).toContain("checkout_response_mismatch");
    expectCleanLogs(lines);
  });

  it("record refuses (job closed) or says paid: expire the new session and say so", async () => {
    const closed = makeDeps({
      prepare_deposit_checkout: [prepared("create")],
      record_deposit_checkout: [refused("deposit_job_closed")],
    });
    expect(await startDepositCheckout(TOKEN, closed.deps)).toEqual({
      kind: "refused",
      reason: "deposit_job_closed",
      message: "This job is closed. Ask the shop about the deposit.",
    });
    expect(closed.gateway.calls.map((c) => c.op)).toEqual(["create", "expire"]);

    const paid = makeDeps({
      prepare_deposit_checkout: [prepared("create")],
      record_deposit_checkout: [
        { data: [{ outcome: "paid", payment_id: null, stripe_checkout_session_id: null }] },
      ],
    });
    expect(await startDepositCheckout(TOKEN, paid.deps)).toEqual({ kind: "paid" });
    expect(paid.gateway.calls.map((c) => c.op)).toEqual(["create", "expire"]);
  });

  it("paid, processing and refunded from prepare pass through without calling Stripe", async () => {
    for (const kind of ["paid", "processing", "refunded"] as const) {
      const { deps, gateway } = makeDeps({ prepare_deposit_checkout: [prepared(kind)] });
      expect(await startDepositCheckout(TOKEN, deps)).toEqual({ kind });
      expect(gateway.calls).toEqual([]);
    }
  });

  it("a refusal from prepare is refused with the mapped sentence; an unknown link says so", async () => {
    const closed = makeDeps({ prepare_deposit_checkout: [refused("deposit_parts_cancelled")] });
    expect(await startDepositCheckout(TOKEN, closed.deps)).toEqual({
      kind: "refused",
      reason: "deposit_parts_cancelled",
      message: "The parts this deposit was for were cancelled. Ask the shop.",
    });
    const unknown = makeDeps({
      prepare_deposit_checkout: [refused("quote_not_found", "P0002")],
    });
    expect(await startDepositCheckout(TOKEN, unknown.deps)).toEqual({
      kind: "refused",
      reason: "quote_not_found",
      message: "This link is not valid. Ask the shop for a new one.",
    });
    const broken = makeDeps({ prepare_deposit_checkout: [refused("boom", "XX000")] });
    expect(await startDepositCheckout(TOKEN, broken.deps)).toEqual({ kind: "unavailable" });
  });

  it("a Stripe failure is unavailable, logged by code only", async () => {
    const { deps, gateway, lines, names } = makeDeps({
      prepare_deposit_checkout: [prepared("create")],
    });
    gateway.failNext("create", new StripeError("stripe_unavailable", true, 503));
    expect(await startDepositCheckout(TOKEN, deps)).toEqual({ kind: "unavailable" });
    expect(names()).toEqual(["prepare_deposit_checkout"]);
    expect(lines.join("\n")).toContain("stripe_unavailable");
    expectCleanLogs(lines);
  });

  it("off, no gateway or no service client: unavailable, and no RPC runs", async () => {
    const off = makeDeps(
      { prepare_deposit_checkout: [prepared("create")] },
      { config: { state: "off", reason: "not_configured" } },
    );
    const noGateway = makeDeps(
      { prepare_deposit_checkout: [prepared("create")] },
      { gateway: null },
    );
    const noClient = makeDeps(
      { prepare_deposit_checkout: [prepared("create")] },
      { supabase: null },
    );
    for (const { deps, names } of [off, noGateway, noClient]) {
      expect(await startDepositCheckout(TOKEN, deps)).toEqual({ kind: "unavailable" });
      expect(names()).toEqual([]);
    }
  });

  it("live mode: only https://checkout.stripe.com is followed", async () => {
    const liveSession = (url: string) =>
      toCheckoutSession(
        {
          id: "cs_live_abc",
          object: "checkout.session",
          livemode: true,
          status: "open",
          payment_status: "unpaid",
          expires_at: NOW_S + 3600,
          amount_total: 12000,
          currency: "sgd",
          url,
        },
        true,
      );
    for (const [url, expected] of [
      ["https://evil.example/c/pay/cs_live_abc", { kind: "unavailable" }],
      ["http://checkout.stripe.com/c/pay/cs_live_abc", { kind: "unavailable" }],
      [
        "https://checkout.stripe.com/c/pay/cs_live_abc",
        { kind: "redirect", url: "https://checkout.stripe.com/c/pay/cs_live_abc" },
      ],
    ] as const) {
      const expire = vi.fn(async () => liveSession(url));
      const gateway: StripeGateway = {
        mode: "live",
        livemode: true,
        createCheckoutSession: async () => liveSession(url),
        retrieveCheckoutSession: async () => liveSession(url),
        expireCheckoutSession: expire,
        listRefunds: async () => [],
        retrievePaymentIntent: async () => {
          throw new StripeError("stripe_not_found", false, 404);
        },
      };
      const { deps, lines } = makeDeps(
        {
          prepare_deposit_checkout: [prepared("create")],
          record_deposit_checkout: [
            {
              data: [
                { outcome: "created", payment_id: P1, stripe_checkout_session_id: "cs_live_abc" },
              ],
            },
          ],
        },
        {
          gateway,
          config: { ...ON, mode: "live", livemode: true, origin: "https://admin.example" },
        },
      );
      expect(await startDepositCheckout(TOKEN, deps), url).toEqual(expected);
      expect(expire).toHaveBeenCalledTimes(expected.kind === "unavailable" ? 1 : 0);
      expect(lines.join("\n")).not.toContain("evil.example");
    }
  });

  it("check whose session Stripe cannot find: unavailable, logged, nothing created (R-086)", async () => {
    const { deps, gateway, names, lines } = makeDeps({
      prepare_deposit_checkout: [
        prepared("check", { stripe_checkout_session_id: `cs_test_fake_${"0".repeat(32)}` }),
      ],
    });
    expect(await startDepositCheckout(TOKEN, deps)).toEqual({ kind: "unavailable" });
    expect(gateway.calls.map((c) => c.op)).toEqual(["retrieve"]);
    expect(names()).toEqual(["prepare_deposit_checkout"]);
    expect(lines.join("\n")).toContain("pending checkout session not found at stripe");
    expectCleanLogs(lines);
  });

  it("starts no Stripe step after the deadline, so the page's maxDuration is never hit", async () => {
    // Stripe answered slowly: 31 seconds have passed by the second attempt.
    let t = NOW_MS;
    const gateway = fakeStripe();
    const s = await gateway.createCheckoutSession(input(P1), `bicii-checkout-${P1}`);
    gateway.expire(s.id);
    gateway.calls.length = 0;
    const { deps, names, lines } = makeDeps(
      {
        prepare_deposit_checkout: [prepared("check", { stripe_checkout_session_id: s.id })],
        record_stripe_read: [
          () => {
            t = NOW_MS + PAY_DEADLINE_MS + 1_000;
            return readResult("expired");
          },
        ],
      },
      { now: () => t },
    );
    deps.gateway = gateway;
    expect(await startDepositCheckout(TOKEN, deps)).toEqual({ kind: "unavailable" });
    expect(names()).toEqual(["prepare_deposit_checkout", "record_stripe_read"]);
    expect(gateway.calls.map((c) => c.op)).toEqual(["retrieve"]);
    expect(lines.join("\n")).toContain("checkout out of time");
  });

  it("gives up after three attempts", async () => {
    const gateway = fakeStripe();
    const s = await gateway.createCheckoutSession(input(P1), `bicii-checkout-${P1}`);
    gateway.expire(s.id);
    const { deps, names } = makeDeps({
      prepare_deposit_checkout: [prepared("check", { stripe_checkout_session_id: s.id })],
      record_stripe_read: [readResult("pending")],
    });
    deps.gateway = gateway;
    expect(await startDepositCheckout(TOKEN, deps)).toEqual({ kind: "unavailable" });
    expect(names().filter((n) => n === "prepare_deposit_checkout")).toHaveLength(3);
  });
});

describe("validateRedirect", () => {
  it("live and test: https on checkout.stripe.com only; fake: this Admin's quote page", () => {
    expect(validateRedirect("https://checkout.stripe.com/c/pay/x", "live", ORIGIN)).toBe(true);
    expect(validateRedirect("https://checkout.stripe.com/c/pay/x", "test", ORIGIN)).toBe(true);
    for (const bad of [
      null,
      "",
      "not a url",
      "https://checkout.stripe.com.evil.example/x",
      "https://user@evil.example/x",
      "javascript:alert(1)",
    ]) {
      expect(validateRedirect(bad, "live", ORIGIN), String(bad)).toBe(false);
    }
    expect(validateRedirect(`${ORIGIN}/quote/${TOKEN}?deposit=returned`, "fake", ORIGIN)).toBe(
      true,
    );
    expect(validateRedirect("https://checkout.stripe.com/c/pay/x", "fake", ORIGIN)).toBe(false);
    expect(validateRedirect(`${ORIGIN}/jobs/1`, "fake", ORIGIN)).toBe(false);
  });
});

describe("confirmDepositReturn (R-086)", () => {
  it("never creates a session", async () => {
    const { deps, gateway } = makeDeps({ prepare_deposit_checkout: [prepared("create")] });
    expect(await confirmDepositReturn(TOKEN, deps)).toEqual({ state: "due" });
    expect(gateway.calls).toEqual([]);
  });

  it("re-reads the open session and says what Stripe says", async () => {
    for (const [status, complete, state] of [
      ["paid", true, "paid"],
      ["refunded", true, "refunded"],
      ["pending", true, "processing"],
      ["pending", false, "due"],
      ["expired", false, "due"],
    ] as const) {
      const gateway = fakeStripe();
      const s = await gateway.createCheckoutSession(input(P1), `bicii-checkout-${P1}`);
      if (complete) gateway.complete(s.id, { paid: status === "paid" });
      const { deps, calls } = makeDeps({
        prepare_deposit_checkout: [prepared("check", { stripe_checkout_session_id: s.id })],
        record_stripe_read: [readResult(status)],
      });
      deps.gateway = gateway;
      expect(await confirmDepositReturn(TOKEN, deps), status).toEqual({ state });
      expect(calls.map((c) => c.name)).toEqual(["prepare_deposit_checkout", "record_stripe_read"]);
      expect(gateway.calls.filter((c) => c.op === "create")).toHaveLength(1);
    }
  });

  it("passes paid, processing and refunded through; null when refused or unavailable", async () => {
    for (const kind of ["paid", "processing", "refunded"] as const) {
      const { deps } = makeDeps({ prepare_deposit_checkout: [prepared(kind)] });
      expect(await confirmDepositReturn(TOKEN, deps)).toEqual({ state: kind });
    }
    const closed = makeDeps({ prepare_deposit_checkout: [refused("deposit_job_closed")] });
    expect(await confirmDepositReturn(TOKEN, closed.deps)).toEqual({ state: null });
    const off = makeDeps(
      { prepare_deposit_checkout: [prepared("create")] },
      { config: { state: "off", reason: "preview" } },
    );
    expect(await confirmDepositReturn(TOKEN, off.deps)).toEqual({ state: null });
    expect(off.names()).toEqual([]);
  });
});

describe("refreshPaymentFromStripe (Check with Stripe)", () => {
  const row = (over: Row = {}): Row => ({
    id: P1,
    status: "paid",
    refunded_amount: "0.00",
    stripe_checkout_session_id: `cs_test_fake_${P1.replace(/-/g, "")}`,
    stripe_payment_intent_id: null,
    livemode: false,
    ...over,
  });

  it("re-reads the session and every refund of its payment, then says what changed", async () => {
    const gateway = fakeStripe();
    const s = await gateway.createCheckoutSession(input(P1), `bicii-checkout-${P1}`);
    gateway.complete(s.id, { paymentIntent: "pi_t1" });
    gateway.addRefund("pi_t1", { id: "re_1", amountCents: 5000, status: "succeeded" });
    gateway.addRefund("pi_t1", { id: "re_2", amountCents: 1000, status: "pending" });
    gateway.calls.length = 0;
    const { deps, calls } = makeDeps(
      { record_stripe_read: [readResult("partially_refunded")] },
      { rows: [row(), { status: "partially_refunded", refunded_amount: "50.00" }] },
    );
    deps.gateway = gateway;
    expect(await refreshPaymentFromStripe(P1, deps)).toEqual({
      kind: "checked",
      before: "paid",
      after: "partially_refunded",
      processing: false,
      changed: true,
      incomplete: false,
    });
    expect(gateway.calls).toEqual([
      { op: "retrieve", id: s.id },
      { op: "list", id: "pi_t1" },
    ]);
    expect(calls.map((c) => (c.args.object as Row).id)).toEqual([s.id, "re_1", "re_2"]);
    expect(calls.every((c) => c.args.payment_id === P1)).toBe(true);
  });

  it("unchanged when Stripe has nothing new", async () => {
    const gateway = fakeStripe();
    await gateway.createCheckoutSession(input(P1), `bicii-checkout-${P1}`);
    const { deps } = makeDeps(
      { record_stripe_read: [readResult("pending")] },
      { rows: [row({ status: "pending" }), { status: "pending", refunded_amount: "0.00" }] },
    );
    deps.gateway = gateway;
    expect(await refreshPaymentFromStripe(P1, deps)).toEqual({
      kind: "checked",
      before: "pending",
      after: "pending",
      processing: false,
      changed: false,
      incomplete: false,
    });
  });

  it("Checkout completed unpaid: also reads the PaymentIntent, which records a lost async failure", async () => {
    const gateway = fakeStripe();
    const s = await gateway.createCheckoutSession(input(P1), `bicii-checkout-${P1}`);
    gateway.complete(s.id, { paid: false, paymentIntent: "pi_async1" });
    gateway.failAsyncPayment(s.id);
    gateway.calls.length = 0;
    const { deps, calls } = makeDeps(
      { record_stripe_read: [readResult("pending"), readResult("failed")] },
      {
        rows: [
          row({ status: "pending", stripe_payment_intent_id: "pi_async1" }),
          { status: "failed", refunded_amount: "0.00", checkout_completed_at: null },
        ],
      },
    );
    deps.gateway = gateway;
    expect(await refreshPaymentFromStripe(P1, deps)).toEqual({
      kind: "checked",
      before: "pending",
      after: "failed",
      processing: false,
      changed: true,
      incomplete: false,
    });
    expect(gateway.calls).toEqual([
      { op: "retrieve", id: s.id },
      { op: "retrieve_pi", id: "pi_async1" },
      { op: "list", id: "pi_async1" },
    ]);
    const intent = calls[1].args.object as Row;
    expect(intent).toMatchObject({
      id: "pi_async1",
      object: "payment_intent",
      status: "requires_payment_method",
    });
  });

  it("still being confirmed: processing, and no PaymentIntent read for a paid or open session", async () => {
    const gateway = fakeStripe();
    const s = await gateway.createCheckoutSession(input(P1), `bicii-checkout-${P1}`);
    gateway.complete(s.id, { paid: false, paymentIntent: "pi_async2" });
    gateway.calls.length = 0;
    const { deps } = makeDeps(
      { record_stripe_read: [readResult("pending")] },
      {
        rows: [
          row({ status: "pending", stripe_payment_intent_id: "pi_async2" }),
          {
            status: "pending",
            refunded_amount: "0.00",
            checkout_completed_at: "2027-01-15T08:00:00Z",
          },
        ],
      },
    );
    deps.gateway = gateway;
    expect(await refreshPaymentFromStripe(P1, deps)).toMatchObject({
      kind: "checked",
      processing: true,
      changed: false,
    });
    expect(gateway.calls.map((c) => c.op)).toEqual(["retrieve", "retrieve_pi", "list"]);

    // Paid: the session is the authority; no intent read.
    const paid = fakeStripe();
    const ps = await paid.createCheckoutSession(input(P1), `bicii-checkout-${P1}`);
    paid.complete(ps.id, { paymentIntent: "pi_paid" });
    paid.calls.length = 0;
    const second = makeDeps({ record_stripe_read: [readResult("paid")] }, { rows: [row()] });
    second.deps.gateway = paid;
    await refreshPaymentFromStripe(P1, second.deps);
    expect(paid.calls.map((c) => c.op)).toEqual(["retrieve", "list"]);
  });

  it("the session recorded but the intent or refunds unreadable (a key permission): incomplete, not unavailable", async () => {
    for (const op of ["list", "retrieve_pi"] as const) {
      const gateway = fakeStripe();
      const s = await gateway.createCheckoutSession(input(P1), `bicii-checkout-${P1}`);
      gateway.complete(s.id, { paid: false, paymentIntent: "pi_perm" });
      gateway.failNext(op, new StripeError("stripe_auth_failed", false, 403));
      const { deps, lines } = makeDeps(
        { record_stripe_read: [readResult("pending")] },
        {
          rows: [
            row({ status: "pending", stripe_payment_intent_id: "pi_perm" }),
            {
              status: "pending",
              refunded_amount: "0.00",
              checkout_completed_at: "2027-01-15T08:00:00Z",
            },
          ],
        },
      );
      deps.gateway = gateway;
      expect(await refreshPaymentFromStripe(P1, deps), op).toMatchObject({
        kind: "checked",
        incomplete: true,
      });
      expect(lines.join("\n")).toContain("stripe_auth_failed");
      expectCleanLogs(lines);
    }
  });

  it("not_found, other_mode and unavailable", async () => {
    const missing = makeDeps({}, { rows: [null] });
    expect(await refreshPaymentFromStripe(P1, missing.deps)).toEqual({ kind: "not_found" });

    const live = makeDeps({}, { rows: [row({ livemode: true })] });
    expect(await refreshPaymentFromStripe(P1, live.deps)).toEqual({ kind: "other_mode" });
    expect(live.gateway.calls).toEqual([]);

    const off = makeDeps({}, { gateway: null, rows: [row()] });
    expect(await refreshPaymentFromStripe(P1, off.deps)).toEqual({ kind: "unavailable" });

    // The session is unknown to Stripe (the fake holds none): its own result, logged.
    const lost = makeDeps({}, { rows: [row()] });
    expect(await refreshPaymentFromStripe(P1, lost.deps)).toEqual({ kind: "session_missing" });
    expect(lost.lines.join("\n")).toContain("checkout session not found at stripe");
    expectCleanLogs(lost.lines);

    // Stripe unreachable for the session itself: unavailable.
    const down = makeDeps({}, { rows: [row()] });
    down.gateway.failNext("retrieve", new StripeError("stripe_unavailable", true, 503));
    expect(await refreshPaymentFromStripe(P1, down.deps)).toEqual({ kind: "unavailable" });
  });
});
