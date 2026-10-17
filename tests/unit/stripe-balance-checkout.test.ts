// @vitest-environment node
/**
 * The balance link's Pay and return (Phase 14 step 3; D156g, D156h;
 * ADR-025), and expiring a job's open Checkout sessions after a counter
 * payment or a resent link (D161g; step3-critique C9, C20), with the
 * in-memory Stripe and scripted RPCs: every outcome of
 * prepare_balance_checkout and record_balance_checkout, the shared
 * 3-attempt / 30-second budget, that the cents and the expiry come from
 * Postgres unchanged, that each flow redirects only to its own page, and
 * that logs never carry the token or a URL. The RPCs themselves are
 * tests/db/balance-links.test.ts.
 */
import pino from "pino";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  PAY_DEADLINE_MS,
  confirmBalanceReturn,
  expireOpenCheckouts,
  startBalanceCheckout,
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

const TOKEN = "BaLaNcEtOkEn0123456789abcdefghijklmnop-_xyz";
const ORIGIN = "http://localhost:3000";
const NOW_MS = 1_800_000_000_000;
const NOW_S = NOW_MS / 1000;
const JOB = "66666666-7777-4888-9999-000000000000";
const LINK = "cccccccc-dddd-4eee-8fff-000000000001";
const QUOTE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OTHER_QUOTE = "aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff";
const P1 = "11111111-2222-4333-8444-000000000001";
const P2 = "11111111-2222-4333-8444-000000000002";
const P3 = "11111111-2222-4333-8444-000000000003";
const RETURNED = `${ORIGIN}/pay/${TOKEN}?balance=returned`;
const CANCELLED = `${ORIGIN}/pay/${TOKEN}?balance=cancelled`;
const sessionOf = (paymentId: string) => `cs_test_fake_${paymentId.replace(/-/g, "")}`;

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

/**
 * A prepare_balance_checkout row. The money columns disagree on purpose
 * (380.00 is not 37,999 cents): the flow must pass amount_cents through as
 * Postgres computed it and never derive cents from `amount`.
 */
const prepared = (outcome: string, over: Row = {}): RpcResult => ({
  data: [
    {
      outcome,
      payment_id: P1,
      work_order_id: JOB,
      link_id: LINK,
      job_number: "J-0042",
      amount: 380,
      amount_cents: 37_999,
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

/** record_balance_checkout answering `created` for whatever it was given. */
const created: Handler = (args) => ({
  data: [
    {
      outcome: "created",
      payment_id: args.p_payment_id,
      stripe_checkout_session_id: (args.p_session as Row).id,
    },
  ],
});

/** record_deposit_checkout answering `created` (its session argument is `session`). */
const depositCreated: Handler = (args) => ({
  data: [
    {
      outcome: "created",
      payment_id: args.p_payment_id,
      stripe_checkout_session_id: (args.session as Row).id,
    },
  ],
});

const recorded = (
  outcome: string,
  paymentId: string | null = null,
  session: string | null = null,
) =>
  ({
    data: [{ outcome, payment_id: paymentId, stripe_checkout_session_id: session }],
  }) as RpcResult;

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

type TableResult = { data: unknown; error: { code: string; message: string } | null };

/**
 * The service client: scripted RPCs, and a payments query builder whose
 * filters are recorded and which resolves to `payments` (expireOpenCheckouts).
 */
function makeDeps(
  script: Record<string, Array<RpcResult | Handler>>,
  over: Partial<StripeDeps> & { payments?: TableResult } = {},
) {
  const { payments = { data: [], error: null }, ...rest } = over;
  const { calls, rpc } = rpcScript(script);
  const lines: string[] = [];
  const log = pino({ level: "trace" }, { write: (line: string) => void lines.push(line) });
  const queries: Array<{ table: string; filters: unknown[][] }> = [];
  const supabase = {
    rpc,
    from(table: string) {
      if (table !== "payments") throw new Error(`unexpected table ${table}`);
      const query = { table, filters: [] as unknown[][] };
      queries.push(query);
      const builder: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is", "gt", "in", "order", "limit"]) {
        builder[m] = (...args: unknown[]) => {
          query.filters.push([m, ...args]);
          return builder;
        };
      }
      builder.then = (resolve: (r: TableResult) => unknown) => resolve(payments);
      return builder;
    },
  } as unknown as ServiceSupabase;
  const gateway = createFakeStripeGateway({ now: () => NOW_MS });
  const deps: StripeDeps = {
    supabase,
    gateway,
    config: ON,
    log,
    correlationId: "req-1",
    now: () => NOW_MS,
    ...rest,
  };
  return {
    deps,
    gateway,
    calls,
    lines,
    queries,
    names: () => calls.map((c) => c.name),
  };
}

function input(paymentId: string, expiresAt = NOW_S + 3600): CheckoutSessionInput {
  return {
    paymentId,
    workOrderId: JOB,
    quoteId: null,
    kind: "balance",
    jobNumber: "J-0042",
    amountCents: 37_999,
    expiresAt,
    successUrl: RETURNED,
    cancelUrl: CANCELLED,
  };
}

function depositInput(paymentId: string, quoteId = QUOTE): CheckoutSessionInput {
  return {
    ...input(paymentId),
    quoteId,
    kind: "deposit",
    amountCents: 12_000,
    successUrl: `${ORIGIN}/quote/${TOKEN}?deposit=returned`,
    cancelUrl: `${ORIGIN}/quote/${TOKEN}?deposit=cancelled`,
  };
}

/** The fake on Stripe's clock at NOW_MS. */
const fakeStripe = () => createFakeStripeGateway({ now: () => NOW_MS });

/** An open balance session in `gateway` for this payment id. */
const openSession = (gateway: ReturnType<typeof fakeStripe>, paymentId: string) =>
  gateway.createCheckoutSession(input(paymentId), `bicii-checkout-${paymentId}`);

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

function expectCleanLogs(lines: string[]) {
  const all = lines.join("\n");
  for (const banned of [TOKEN, "/pay/", "/quote/", "http://", "https://", "balance=returned"]) {
    expect(all, banned).not.toContain(banned);
  }
}

describe("startBalanceCheckout (D156h)", () => {
  it("create: a balance session at Postgres's cents and expiry, recorded with the link, then Stripe's url", async () => {
    const { deps, gateway, calls, lines } = makeDeps({
      prepare_balance_checkout: [prepared("create")],
      record_balance_checkout: [created],
    });
    expect(await startBalanceCheckout(TOKEN, deps)).toEqual({ kind: "redirect", url: RETURNED });
    expect(gateway.calls).toEqual([{ op: "create", key: `bicii-checkout-${P1}` }]);
    expect(calls[0]).toEqual({ name: "prepare_balance_checkout", args: { p_token: TOKEN } });

    const session = gateway.sessions.get(sessionOf(P1))!;
    // Never computed in TypeScript: Postgres's cents and expiry, unchanged.
    expect(session.raw).toMatchObject({
      amount_total: 37_999,
      expires_at: NOW_S + 3600,
      client_reference_id: P1,
      metadata: { bicii_payment_id: P1, bicii_work_order_id: JOB, bicii_kind: "balance" },
    });
    // A balance session names no quote.
    expect(session.raw.metadata).not.toHaveProperty("bicii_quote_id");
    const record = calls.find((c) => c.name === "record_balance_checkout")!;
    expect(record.args).toMatchObject({
      p_payment_id: P1,
      p_link_id: LINK,
      p_amount_cents: 37_999,
    });
    expect((record.args.p_session as Row).id).toBe(sessionOf(P1));
    expect(Object.keys(record.args).sort()).toEqual(
      ["p_amount_cents", "p_link_id", "p_payment_id", "p_session"].sort(),
    );
    expectCleanLogs(lines);
  });

  it("returns to this Admin's /pay page, built from the configured origin", async () => {
    const seen: CheckoutSessionInput[] = [];
    const fake = fakeStripe();
    const gateway: StripeGateway = {
      ...fake,
      mode: fake.mode,
      livemode: fake.livemode,
      createCheckoutSession: async (i, key) => {
        seen.push(i);
        return fake.createCheckoutSession(i, key);
      },
    };
    const { deps } = makeDeps(
      { prepare_balance_checkout: [prepared("create")], record_balance_checkout: [created] },
      { gateway },
    );
    await startBalanceCheckout(TOKEN, deps);
    expect(seen).toEqual([
      {
        paymentId: P1,
        workOrderId: JOB,
        quoteId: null,
        kind: "balance",
        jobNumber: "J-0042",
        amountCents: 37_999,
        expiresAt: NOW_S + 3600,
        successUrl: RETURNED,
        cancelUrl: CANCELLED,
      },
    ]);
  });

  it("check with this link's open session: re-read at Stripe, then the same url, no new session", async () => {
    const gateway = fakeStripe();
    const open = await openSession(gateway, P1);
    gateway.calls.length = 0;
    const { deps, calls, names } = makeDeps(
      {
        prepare_balance_checkout: [prepared("check", { stripe_checkout_session_id: open.id })],
        record_stripe_read: [readResult("pending")],
      },
      { gateway },
    );
    expect(await startBalanceCheckout(TOKEN, deps)).toEqual({ kind: "redirect", url: open.url });
    expect(gateway.calls).toEqual([{ op: "retrieve", id: open.id }]);
    expect(names()).toEqual(["prepare_balance_checkout", "record_stripe_read"]);
    expect(calls[1].args).toMatchObject({ payment_id: P1, correlation_id: "req-1" });
    expect((calls[1].args.object as Row).id).toBe(open.id);
  });

  it("check within the reuse margin: expire it, record that, then a new session", async () => {
    const { gateway, session: old } = await nearlyExpired(P1);
    gateway.calls.length = 0;
    const { deps, calls, names } = makeDeps(
      {
        prepare_balance_checkout: [
          prepared("check", { stripe_checkout_session_id: old.id }),
          prepared("create", { payment_id: P2 }),
        ],
        record_stripe_read: [readResult("pending"), readResult("expired")],
        record_balance_checkout: [created],
      },
      { gateway },
    );
    expect(await startBalanceCheckout(TOKEN, deps)).toEqual({ kind: "redirect", url: RETURNED });
    expect(gateway.calls).toEqual([
      { op: "retrieve", id: old.id },
      { op: "expire", id: old.id },
      { op: "create", key: `bicii-checkout-${P2}` },
    ]);
    expect(names()).toEqual([
      "prepare_balance_checkout",
      "record_stripe_read",
      "record_stripe_read",
      "prepare_balance_checkout",
      "record_balance_checkout",
    ]);
    expect((calls[2].args.object as Row).status).toBe("expired");
    expect(gateway.sessions.get(old.id)?.status).toBe("expired");
  });

  it("check whose expire finds it no longer open: retrieve and record it again, then ask again", async () => {
    const { gateway, session: old } = await nearlyExpired(P1);
    gateway.calls.length = 0;
    gateway.failNext("expire", new StripeError("stripe_session_not_open", false, 400));
    const { deps, calls } = makeDeps(
      {
        prepare_balance_checkout: [
          prepared("check", { stripe_checkout_session_id: old.id }),
          prepared("nothing_due", { payment_id: null, amount: 0, amount_cents: 0 }),
        ],
        record_stripe_read: [readResult("pending"), readResult("paid")],
      },
      { gateway },
    );
    expect(await startBalanceCheckout(TOKEN, deps)).toEqual({ kind: "nothing_due" });
    expect(gateway.calls.map((c) => c.op)).toEqual(["retrieve", "expire", "retrieve"]);
    expect(calls.filter((c) => c.name === "record_stripe_read")).toHaveLength(2);
  });

  it("check whose read says paid, refunded, expired or failed: prepare decides what is left", async () => {
    for (const status of ["paid", "partially_refunded", "refunded", "expired", "failed"]) {
      const gateway = fakeStripe();
      const s = await openSession(gateway, P1);
      gateway.complete(s.id);
      gateway.calls.length = 0;
      const { deps, names } = makeDeps(
        {
          prepare_balance_checkout: [
            prepared("check", { stripe_checkout_session_id: s.id }),
            prepared("nothing_due", { payment_id: null, amount: 0, amount_cents: 0 }),
          ],
          record_stripe_read: [readResult(status)],
        },
        { gateway },
      );
      expect(await startBalanceCheckout(TOKEN, deps), status).toEqual({ kind: "nothing_due" });
      expect(names(), status).toEqual([
        "prepare_balance_checkout",
        "record_stripe_read",
        "prepare_balance_checkout",
      ]);
      expect(gateway.calls.map((c) => c.op)).toEqual(["retrieve"]);
    }
  });

  it("check whose Checkout completed unpaid (Stripe still confirming): processing, no redirect", async () => {
    const gateway = fakeStripe();
    const s = await openSession(gateway, P1);
    gateway.complete(s.id, { paid: false });
    const { deps } = makeDeps(
      {
        prepare_balance_checkout: [prepared("check", { stripe_checkout_session_id: s.id })],
        record_stripe_read: [readResult("pending")],
      },
      { gateway },
    );
    expect(await startBalanceCheckout(TOKEN, deps)).toEqual({ kind: "processing" });
  });

  it("check whose session Stripe cannot find: unavailable, logged, nothing created (R-086)", async () => {
    const { deps, gateway, names, lines } = makeDeps({
      prepare_balance_checkout: [
        prepared("check", { stripe_checkout_session_id: `cs_test_fake_${"0".repeat(32)}` }),
      ],
    });
    expect(await startBalanceCheckout(TOKEN, deps)).toEqual({ kind: "unavailable" });
    expect(gateway.calls.map((c) => c.op)).toEqual(["retrieve"]);
    expect(names()).toEqual(["prepare_balance_checkout"]);
    expect(lines.join("\n")).toContain("pending checkout session not found at stripe");
    expectCleanLogs(lines);
  });

  it("replace: expire the other session, record it against its own payment, then ask again", async () => {
    // A deposit session still open on the job (opened while it was open).
    const gateway = fakeStripe();
    const other = await gateway.createCheckoutSession(depositInput(P3), `bicii-checkout-${P3}`);
    gateway.calls.length = 0;
    const { deps, calls, names } = makeDeps(
      {
        prepare_balance_checkout: [
          prepared("replace", { payment_id: P3, stripe_checkout_session_id: other.id }),
          prepared("create"),
        ],
        record_stripe_read: [readResult("expired")],
        record_balance_checkout: [created],
      },
      { gateway },
    );
    expect(await startBalanceCheckout(TOKEN, deps)).toEqual({ kind: "redirect", url: RETURNED });
    expect(gateway.calls).toEqual([
      { op: "expire", id: other.id },
      { op: "create", key: `bicii-checkout-${P1}` },
    ]);
    expect(names()).toEqual([
      "prepare_balance_checkout",
      "record_stripe_read",
      "prepare_balance_checkout",
      "record_balance_checkout",
    ]);
    expect(calls[1].args).toMatchObject({ payment_id: P3, correlation_id: "req-1" });
    expect((calls[1].args.object as Row).status).toBe("expired");
    expect(gateway.sessions.get(other.id)?.status).toBe("expired");
  });

  it("replace whose session is no longer open: retrieve and record what it is now", async () => {
    const gateway = fakeStripe();
    const other = await openSession(gateway, P3);
    gateway.complete(other.id);
    gateway.calls.length = 0;
    const { deps, calls } = makeDeps(
      {
        prepare_balance_checkout: [
          prepared("replace", { payment_id: P3, stripe_checkout_session_id: other.id }),
          prepared("nothing_due", { payment_id: null, amount: 0, amount_cents: 0 }),
        ],
        record_stripe_read: [readResult("paid")],
      },
      { gateway },
    );
    expect(await startBalanceCheckout(TOKEN, deps)).toEqual({ kind: "nothing_due" });
    expect(gateway.calls).toEqual([
      { op: "expire", id: other.id },
      { op: "retrieve", id: other.id },
    ]);
    expect((calls[1].args.object as Row).status).toBe("complete");
  });

  it("replace whose session Stripe cannot find: unavailable, logged", async () => {
    const { deps, lines, names } = makeDeps({
      prepare_balance_checkout: [
        prepared("replace", {
          payment_id: P3,
          stripe_checkout_session_id: `cs_test_fake_${"0".repeat(32)}`,
        }),
      ],
    });
    expect(await startBalanceCheckout(TOKEN, deps)).toEqual({ kind: "unavailable" });
    expect(names()).toEqual(["prepare_balance_checkout"]);
    expect(lines.join("\n")).toContain("pending checkout session not found at stripe");
    expectCleanLogs(lines);
  });

  it("processing: stop, without calling Stripe", async () => {
    const { deps, gateway, names } = makeDeps({
      prepare_balance_checkout: [prepared("processing", { stripe_checkout_session_id: "cs_x" })],
    });
    expect(await startBalanceCheckout(TOKEN, deps)).toEqual({ kind: "processing" });
    expect(gateway.calls).toEqual([]);
    expect(names()).toEqual(["prepare_balance_checkout"]);
  });

  it("nothing_due with no pending session: stop, without calling Stripe", async () => {
    const { deps, gateway } = makeDeps({
      prepare_balance_checkout: [
        prepared("nothing_due", {
          payment_id: null,
          stripe_checkout_session_id: null,
          expires_at: null,
          amount: 0.3,
          amount_cents: 30,
        }),
      ],
    });
    expect(await startBalanceCheckout(TOKEN, deps)).toEqual({ kind: "nothing_due" });
    expect(gateway.calls).toEqual([]);
  });

  it("nothing_due with this link's pending session: expire and record it, then stop", async () => {
    const gateway = fakeStripe();
    const s = await openSession(gateway, P1);
    gateway.calls.length = 0;
    const { deps, calls, names } = makeDeps(
      {
        prepare_balance_checkout: [
          prepared("nothing_due", { stripe_checkout_session_id: s.id, amount: 0, amount_cents: 0 }),
        ],
        record_stripe_read: [readResult("expired")],
      },
      { gateway },
    );
    expect(await startBalanceCheckout(TOKEN, deps)).toEqual({ kind: "nothing_due" });
    expect(gateway.calls).toEqual([{ op: "expire", id: s.id }]);
    expect(names()).toEqual(["prepare_balance_checkout", "record_stripe_read"]);
    expect(calls[1].args).toMatchObject({ payment_id: P1 });
    expect(gateway.sessions.get(s.id)?.status).toBe("expired");
  });

  it("nothing_due whose expire fails: still nothing_due, logged by code", async () => {
    const gateway = fakeStripe();
    const s = await openSession(gateway, P1);
    gateway.failNext("expire", new StripeError("stripe_unavailable", true, 503));
    const { deps, lines, names } = makeDeps(
      {
        prepare_balance_checkout: [
          prepared("nothing_due", { stripe_checkout_session_id: s.id, amount: 0, amount_cents: 0 }),
        ],
      },
      { gateway },
    );
    expect(await startBalanceCheckout(TOKEN, deps)).toEqual({ kind: "nothing_due" });
    expect(names()).toEqual(["prepare_balance_checkout"]);
    expect(lines.join("\n")).toContain("stripe_unavailable");
    expectCleanLogs(lines);
  });

  it("record says existing for this very attempt (a replay): use it", async () => {
    const { deps, gateway } = makeDeps({
      prepare_balance_checkout: [prepared("create")],
      record_balance_checkout: [recorded("existing", P1, sessionOf(P1))],
    });
    expect(await startBalanceCheckout(TOKEN, deps)).toEqual({ kind: "redirect", url: RETURNED });
    expect(gateway.calls.map((c) => c.op)).toEqual(["create"]);
  });

  it("record says another session won: expire the new one, then reuse the winner's", async () => {
    const gateway = fakeStripe();
    const winner = await openSession(gateway, P3);
    gateway.calls.length = 0;
    const { deps } = makeDeps(
      {
        prepare_balance_checkout: [
          prepared("create"),
          prepared("check", { payment_id: P3, stripe_checkout_session_id: winner.id }),
        ],
        record_balance_checkout: [recorded("existing", P3, winner.id)],
        record_stripe_read: [readResult("pending")],
      },
      { gateway },
    );
    expect(await startBalanceCheckout(TOKEN, deps)).toEqual({ kind: "redirect", url: winner.url });
    expect(gateway.calls).toEqual([
      { op: "create", key: `bicii-checkout-${P1}` },
      { op: "expire", id: sessionOf(P1) },
      { op: "retrieve", id: winner.id },
    ]);
    expect(gateway.sessions.get(sessionOf(P1))?.status).toBe("expired");
  });

  it("record says stale (the balance moved): expire the new session, then a new one at the new cents", async () => {
    const { deps, gateway, calls } = makeDeps({
      prepare_balance_checkout: [
        prepared("create"),
        prepared("create", { payment_id: P2, amount: 80, amount_cents: 8_000 }),
      ],
      record_balance_checkout: [recorded("stale"), created],
    });
    expect(await startBalanceCheckout(TOKEN, deps)).toEqual({ kind: "redirect", url: RETURNED });
    expect(gateway.calls).toEqual([
      { op: "create", key: `bicii-checkout-${P1}` },
      { op: "expire", id: sessionOf(P1) },
      { op: "create", key: `bicii-checkout-${P2}` },
    ]);
    const records = calls.filter((c) => c.name === "record_balance_checkout");
    expect(records.map((c) => c.args.p_amount_cents)).toEqual([37_999, 8_000]);
    expect(gateway.sessions.get(sessionOf(P2))?.raw.amount_total).toBe(8_000);
  });

  it("record says nothing_due: expire the new session and stop", async () => {
    const { deps, gateway, names } = makeDeps({
      prepare_balance_checkout: [prepared("create")],
      record_balance_checkout: [recorded("nothing_due")],
    });
    expect(await startBalanceCheckout(TOKEN, deps)).toEqual({ kind: "nothing_due" });
    expect(gateway.calls.map((c) => c.op)).toEqual(["create", "expire"]);
    expect(names()).toEqual(["prepare_balance_checkout", "record_balance_checkout"]);
  });

  it("record says checkout_session_mismatch: expire the new session, unavailable, no retry", async () => {
    const { deps, gateway, lines, names } = makeDeps({
      prepare_balance_checkout: [prepared("create")],
      record_balance_checkout: [refused("checkout_session_mismatch")],
    });
    expect(await startBalanceCheckout(TOKEN, deps)).toEqual({ kind: "unavailable" });
    expect(gateway.calls.map((c) => c.op)).toEqual(["create", "expire"]);
    expect(names()).toEqual(["prepare_balance_checkout", "record_balance_checkout"]);
    expect(lines.join("\n")).toContain("checkout_response_mismatch");
    expectCleanLogs(lines);
  });

  it("record refuses (the link was withdrawn meanwhile): expire the new session and say so", async () => {
    const { deps, gateway } = makeDeps({
      prepare_balance_checkout: [prepared("create")],
      record_balance_checkout: [refused("balance_link_withdrawn")],
    });
    expect(await startBalanceCheckout(TOKEN, deps)).toEqual({
      kind: "refused",
      reason: "balance_link_withdrawn",
      message: "This link was replaced or withdrawn. Ask the shop for a new one.",
    });
    expect(gateway.calls.map((c) => c.op)).toEqual(["create", "expire"]);
  });

  it("a refusal from prepare is refused with the mapped sentence; an unknown link says so", async () => {
    for (const [reason, message] of [
      [
        "balance_link_withdrawn",
        "This link was replaced or withdrawn. Ask the shop for a new one.",
      ],
      ["balance_link_expired", "This link has expired. Ask the shop for a new one."],
      ["balance_link_job_closed", "This link can't be paid any more. Ask the shop."],
      ["balance_too_large", "This balance is too large to pay online. It can be paid at the shop."],
    ] as const) {
      const { deps, gateway } = makeDeps({ prepare_balance_checkout: [refused(reason)] });
      expect(await startBalanceCheckout(TOKEN, deps), reason).toEqual({
        kind: "refused",
        reason,
        message,
      });
      expect(gateway.calls).toEqual([]);
    }
    const unknown = makeDeps({
      prepare_balance_checkout: [refused("balance_link_not_found", "P0002")],
    });
    expect(await startBalanceCheckout(TOKEN, unknown.deps)).toEqual({
      kind: "refused",
      reason: "balance_link_not_found",
      message: "This link is not valid. Ask the shop for a new one.",
    });
    const broken = makeDeps({ prepare_balance_checkout: [refused("boom", "XX000")] });
    expect(await startBalanceCheckout(TOKEN, broken.deps)).toEqual({ kind: "unavailable" });
  });

  it("an unknown outcome from prepare is unavailable, logged, never a redirect", async () => {
    const { deps, gateway, lines } = makeDeps({
      prepare_balance_checkout: [prepared("something_new")],
    });
    expect(await startBalanceCheckout(TOKEN, deps)).toEqual({ kind: "unavailable" });
    expect(gateway.calls).toEqual([]);
    expect(lines.join("\n")).toContain("stripe flow failed");
  });

  it("a Stripe failure is unavailable, logged by code only", async () => {
    const { deps, gateway, lines, names } = makeDeps({
      prepare_balance_checkout: [prepared("create")],
    });
    gateway.failNext("create", new StripeError("stripe_unavailable", true, 503));
    expect(await startBalanceCheckout(TOKEN, deps)).toEqual({ kind: "unavailable" });
    expect(names()).toEqual(["prepare_balance_checkout"]);
    expect(lines.join("\n")).toContain("stripe_unavailable");
    expectCleanLogs(lines);
  });

  it("off, no gateway or no service client: unavailable, and no RPC runs", async () => {
    const script = { prepare_balance_checkout: [prepared("create")] };
    for (const { deps, names } of [
      makeDeps(script, { config: { state: "off", reason: "not_configured" } }),
      makeDeps(script, { gateway: null }),
      makeDeps(script, { supabase: null }),
    ]) {
      expect(await startBalanceCheckout(TOKEN, deps)).toEqual({ kind: "unavailable" });
      expect(names()).toEqual([]);
    }
  });

  it("live mode: only https://checkout.stripe.com is followed", async () => {
    const liveSession = (url: string) =>
      toCheckoutSession(
        {
          id: "cs_live_bal",
          object: "checkout.session",
          livemode: true,
          status: "open",
          payment_status: "unpaid",
          expires_at: NOW_S + 3600,
          amount_total: 37_999,
          currency: "sgd",
          url,
        },
        true,
      );
    for (const [url, expected] of [
      ["https://evil.example/c/pay/cs_live_bal", { kind: "unavailable" }],
      ["http://checkout.stripe.com/c/pay/cs_live_bal", { kind: "unavailable" }],
      [`https://admin.example/pay/${TOKEN}`, { kind: "unavailable" }],
      [
        "https://checkout.stripe.com/c/pay/cs_live_bal",
        { kind: "redirect", url: "https://checkout.stripe.com/c/pay/cs_live_bal" },
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
          prepare_balance_checkout: [prepared("create")],
          record_balance_checkout: [recorded("created", P1, "cs_live_bal")],
        },
        {
          gateway,
          config: { ...ON, mode: "live", livemode: true, origin: "https://admin.example" },
        },
      );
      expect(await startBalanceCheckout(TOKEN, deps), url).toEqual(expected);
      expect(expire).toHaveBeenCalledTimes(expected.kind === "unavailable" ? 1 : 0);
      expect(lines.join("\n")).not.toContain("evil.example");
    }
  });

  it("starts no Stripe step after the 30-second budget", async () => {
    // Stripe answered slowly: 31 seconds have passed by the second attempt.
    let t = NOW_MS;
    const gateway = fakeStripe();
    const s = await openSession(gateway, P1);
    gateway.expire(s.id);
    gateway.calls.length = 0;
    const { deps, names, lines } = makeDeps(
      {
        prepare_balance_checkout: [prepared("check", { stripe_checkout_session_id: s.id })],
        record_stripe_read: [
          () => {
            t = NOW_MS + PAY_DEADLINE_MS + 1_000;
            return readResult("expired");
          },
        ],
      },
      { gateway, now: () => t },
    );
    expect(await startBalanceCheckout(TOKEN, deps)).toEqual({ kind: "unavailable" });
    expect(names()).toEqual(["prepare_balance_checkout", "record_stripe_read"]);
    expect(gateway.calls.map((c) => c.op)).toEqual(["retrieve"]);
    expect(lines.join("\n")).toContain("checkout out of time");
  });

  it("replace past the budget: unavailable before any Stripe call", async () => {
    let t = NOW_MS;
    const gateway = fakeStripe();
    const other = await openSession(gateway, P3);
    gateway.calls.length = 0;
    const { deps } = makeDeps(
      {
        prepare_balance_checkout: [
          () => {
            t = NOW_MS + PAY_DEADLINE_MS + 1_000;
            return prepared("replace", { payment_id: P3, stripe_checkout_session_id: other.id });
          },
        ],
      },
      { gateway, now: () => t },
    );
    expect(await startBalanceCheckout(TOKEN, deps)).toEqual({ kind: "unavailable" });
    expect(gateway.calls).toEqual([]);
    expect(gateway.sessions.get(other.id)?.status).toBe("open");
  });

  it("gives up after three attempts", async () => {
    const { deps, gateway, names, lines } = makeDeps({
      prepare_balance_checkout: [
        prepared("create", { payment_id: P1 }),
        prepared("create", { payment_id: P2 }),
        prepared("create", { payment_id: P3 }),
      ],
      record_balance_checkout: [recorded("stale")],
    });
    expect(await startBalanceCheckout(TOKEN, deps)).toEqual({ kind: "unavailable" });
    expect(names().filter((n) => n === "prepare_balance_checkout")).toHaveLength(3);
    expect(gateway.calls.filter((c) => c.op === "create")).toHaveLength(3);
    expect(gateway.calls.filter((c) => c.op === "expire")).toHaveLength(3);
    expect(lines.join("\n")).toContain("checkout attempts exhausted");
  });
});

describe("validateRedirect: each flow's own page (C13)", () => {
  it("fake: the deposit flow accepts only /quote/, the balance flow only /pay/", () => {
    const quote = `${ORIGIN}/quote/${TOKEN}?deposit=returned`;
    const pay = `${ORIGIN}/pay/${TOKEN}?balance=returned`;
    expect(validateRedirect(quote, "fake", ORIGIN, "/quote/")).toBe(true);
    expect(validateRedirect(pay, "fake", ORIGIN, "/pay/")).toBe(true);
    expect(validateRedirect(pay, "fake", ORIGIN, "/quote/")).toBe(false);
    expect(validateRedirect(quote, "fake", ORIGIN, "/pay/")).toBe(false);
    for (const bad of [
      `${ORIGIN}/payments`,
      `${ORIGIN}/pay`,
      `${ORIGIN}/jobs/1`,
      `https://evil.example/pay/${TOKEN}`,
      "https://checkout.stripe.com/c/pay/x",
    ]) {
      expect(validateRedirect(bad, "fake", ORIGIN, "/pay/"), bad).toBe(false);
    }
  });

  it("fake: dot segments cannot reach the other flow's page (the path is resolved first)", () => {
    for (const bad of [
      `${ORIGIN}/pay/../quote/${TOKEN}`,
      // %2e%2e resolves to ".." as well.
      `${ORIGIN}/pay/%2e%2e/quote/${TOKEN}`,
      `${ORIGIN}/pay/./../quote/${TOKEN}`,
    ]) {
      expect(validateRedirect(bad, "fake", ORIGIN, "/pay/"), bad).toBe(false);
    }
    expect(validateRedirect(`${ORIGIN}/quote/../pay/${TOKEN}`, "fake", ORIGIN, "/quote/")).toBe(
      false,
    );
    expect(validateRedirect(`${ORIGIN}/quote/%2e%2e/pay/${TOKEN}`, "fake", ORIGIN, "/quote/")).toBe(
      false,
    );
    // Another origin that merely starts with this one's text.
    expect(validateRedirect(`${ORIGIN}.evil.example/pay/${TOKEN}`, "fake", ORIGIN, "/pay/")).toBe(
      false,
    );
    expect(validateRedirect("not a url", "fake", ORIGIN, "/pay/")).toBe(false);
  });

  it("live and test: checkout.stripe.com for both flows, never the Admin's own pages", () => {
    for (const prefix of ["/quote/", "/pay/"] as const) {
      expect(validateRedirect("https://checkout.stripe.com/c/pay/x", "live", ORIGIN, prefix)).toBe(
        true,
      );
      expect(validateRedirect("https://checkout.stripe.com/c/pay/x", "test", ORIGIN, prefix)).toBe(
        true,
      );
      expect(validateRedirect(`${ORIGIN}${prefix}${TOKEN}`, "live", ORIGIN, prefix)).toBe(false);
    }
  });

  it("the balance flow refuses a session that would send the customer to the quote page", async () => {
    const fake = fakeStripe();
    const gateway: StripeGateway = {
      ...fake,
      mode: fake.mode,
      livemode: fake.livemode,
      // A tampered response: the deposit flow's return page.
      createCheckoutSession: (i, key) =>
        fake.createCheckoutSession(
          { ...i, successUrl: `${ORIGIN}/quote/${TOKEN}?deposit=returned` },
          key,
        ),
    };
    const { deps, lines } = makeDeps(
      { prepare_balance_checkout: [prepared("create")], record_balance_checkout: [created] },
      { gateway },
    );
    expect(await startBalanceCheckout(TOKEN, deps)).toEqual({ kind: "unavailable" });
    expect(fake.calls.map((c) => c.op)).toEqual(["create", "expire"]);
    expect(lines.join("\n")).toContain("checkout redirect refused");
  });

  it("the deposit flow refuses a session that would send the customer to the pay page", async () => {
    const fake = fakeStripe();
    const gateway: StripeGateway = {
      ...fake,
      mode: fake.mode,
      livemode: fake.livemode,
      createCheckoutSession: (i, key) =>
        fake.createCheckoutSession({ ...i, successUrl: RETURNED }, key),
    };
    const { deps, lines } = makeDeps(
      {
        prepare_deposit_checkout: [
          {
            data: [
              {
                outcome: "create",
                payment_id: P1,
                work_order_id: JOB,
                quote_id: QUOTE,
                job_number: "J-0042",
                amount: 120,
                amount_cents: 12_000,
                currency: "SGD",
                stripe_checkout_session_id: null,
                expires_at: NOW_S + 3600,
              },
            ],
          },
        ],
        record_deposit_checkout: [depositCreated],
      },
      { gateway },
    );
    expect(await startDepositCheckout(TOKEN, deps)).toEqual({ kind: "unavailable" });
    expect(fake.calls.map((c) => c.op)).toEqual(["create", "expire"]);
    expect(lines.join("\n")).toContain("checkout redirect refused");
  });
});

describe("confirmBalanceReturn (R-086)", () => {
  it("never creates a session: create reads as due", async () => {
    const { deps, gateway, names } = makeDeps({ prepare_balance_checkout: [prepared("create")] });
    expect(await confirmBalanceReturn(TOKEN, deps)).toEqual({ state: "due" });
    expect(gateway.calls).toEqual([]);
    expect(names()).toEqual(["prepare_balance_checkout"]);
  });

  it("processing passes through without calling Stripe", async () => {
    const { deps, gateway } = makeDeps({
      prepare_balance_checkout: [prepared("processing", { stripe_checkout_session_id: "cs_x" })],
    });
    expect(await confirmBalanceReturn(TOKEN, deps)).toEqual({ state: "processing" });
    expect(gateway.calls).toEqual([]);
  });

  it("re-reads this link's pending session and says what Stripe says", async () => {
    for (const [status, complete, state] of [
      ["paid", true, "paid"],
      ["partially_refunded", true, "paid"],
      ["pending", true, "processing"],
      ["pending", false, "due"],
      ["expired", false, "due"],
      ["refunded", true, "due"],
    ] as const) {
      const gateway = fakeStripe();
      const s = await openSession(gateway, P1);
      if (complete) gateway.complete(s.id, { paid: status !== "pending" });
      gateway.calls.length = 0;
      const { deps, calls } = makeDeps(
        {
          prepare_balance_checkout: [prepared("check", { stripe_checkout_session_id: s.id })],
          record_stripe_read: [readResult(status)],
        },
        { gateway },
      );
      expect(await confirmBalanceReturn(TOKEN, deps), status).toEqual({ state });
      expect(calls.map((c) => c.name)).toEqual(["prepare_balance_checkout", "record_stripe_read"]);
      expect(calls[1].args).toMatchObject({ payment_id: P1 });
      // One read; never an expiry or a new session.
      expect(gateway.calls).toEqual([{ op: "retrieve", id: s.id }]);
    }
  });

  it("a session prepare would replace is re-read, not expired", async () => {
    const gateway = fakeStripe();
    const s = await openSession(gateway, P3);
    gateway.complete(s.id);
    gateway.calls.length = 0;
    const { deps, calls } = makeDeps(
      {
        prepare_balance_checkout: [
          prepared("replace", { payment_id: P3, stripe_checkout_session_id: s.id }),
        ],
        record_stripe_read: [readResult("paid")],
      },
      { gateway },
    );
    expect(await confirmBalanceReturn(TOKEN, deps)).toEqual({ state: "paid" });
    expect(gateway.calls).toEqual([{ op: "retrieve", id: s.id }]);
    expect(calls[1].args).toMatchObject({ payment_id: P3 });
  });

  it("nothing_due: read this link's pending session when there is one, else nothing_due", async () => {
    const none = makeDeps({
      prepare_balance_checkout: [
        prepared("nothing_due", { payment_id: null, stripe_checkout_session_id: null }),
      ],
    });
    expect(await confirmBalanceReturn(TOKEN, none.deps)).toEqual({ state: "nothing_due" });
    expect(none.gateway.calls).toEqual([]);

    // Paid online although a counter payment had already covered the bill.
    const gateway = fakeStripe();
    const s = await openSession(gateway, P1);
    gateway.complete(s.id);
    const paid = makeDeps(
      {
        prepare_balance_checkout: [prepared("nothing_due", { stripe_checkout_session_id: s.id })],
        record_stripe_read: [readResult("paid")],
      },
      { gateway },
    );
    expect(await confirmBalanceReturn(TOKEN, paid.deps)).toEqual({ state: "paid" });

    const open = fakeStripe();
    const o = await openSession(open, P1);
    const unpaid = makeDeps(
      {
        prepare_balance_checkout: [prepared("nothing_due", { stripe_checkout_session_id: o.id })],
        record_stripe_read: [readResult("pending")],
      },
      { gateway: open },
    );
    expect(await confirmBalanceReturn(TOKEN, unpaid.deps)).toEqual({ state: "nothing_due" });
    expect(open.calls.filter((c) => c.op === "expire")).toEqual([]);
  });

  it("null when refused, Stripe is unreachable or Stripe is off", async () => {
    for (const answer of [
      refused("balance_link_withdrawn"),
      refused("balance_link_job_closed"),
      refused("balance_link_not_found", "P0002"),
    ]) {
      const { deps, lines } = makeDeps({ prepare_balance_checkout: [answer] });
      expect(await confirmBalanceReturn(TOKEN, deps)).toEqual({ state: null });
      // A refusal is the page's own business, not an error.
      expect(lines.join("\n")).not.toContain("stripe");
    }

    const gateway = fakeStripe();
    const s = await openSession(gateway, P1);
    gateway.failNext("retrieve", new StripeError("stripe_unavailable", true, 503));
    const down = makeDeps(
      { prepare_balance_checkout: [prepared("check", { stripe_checkout_session_id: s.id })] },
      { gateway },
    );
    expect(await confirmBalanceReturn(TOKEN, down.deps)).toEqual({ state: null });
    expect(down.lines.join("\n")).toContain("stripe_unavailable");
    expectCleanLogs(down.lines);

    const off = makeDeps(
      { prepare_balance_checkout: [prepared("create")] },
      { config: { state: "off", reason: "preview" } },
    );
    expect(await confirmBalanceReturn(TOKEN, off.deps)).toEqual({ state: null });
    expect(off.names()).toEqual([]);
  });
});

describe("expireOpenCheckouts (D161g; C9, C20)", () => {
  /** A payments row as the service client's select returns it. */
  const pending = (id: string, kind: "balance" | "deposit", quoteId: string | null = null) => ({
    id,
    kind,
    quote_id: quoteId,
    stripe_checkout_session_id: sessionOf(id),
  });

  it("selects the job's open, unfinished Stripe sessions", async () => {
    const { deps, queries } = makeDeps({}, { payments: { data: [], error: null } });
    expect(await expireOpenCheckouts(JOB, { deps })).toEqual({ expired: 0, paid: 0, failed: 0 });
    expect(queries).toHaveLength(1);
    expect(queries[0].filters).toEqual(
      expect.arrayContaining([
        ["eq", "work_order_id", JOB],
        ["eq", "status", "pending"],
        ["is", "checkout_completed_at", null],
        ["gt", "stripe_session_expires_at", new Date(NOW_MS).toISOString()],
      ]),
    );
  });

  it("with a quote: expires every open balance session and that quote's deposit session, recording each", async () => {
    const gateway = fakeStripe();
    await openSession(gateway, P1);
    await gateway.createCheckoutSession(depositInput(P2, QUOTE), `bicii-checkout-${P2}`);
    await gateway.createCheckoutSession(depositInput(P3, OTHER_QUOTE), `bicii-checkout-${P3}`);
    gateway.calls.length = 0;
    const { deps, calls, lines } = makeDeps(
      { record_stripe_read: [readResult("expired")] },
      {
        gateway,
        payments: {
          data: [
            pending(P1, "balance"),
            pending(P2, "deposit", QUOTE),
            pending(P3, "deposit", OTHER_QUOTE),
          ],
          error: null,
        },
      },
    );
    expect(await expireOpenCheckouts(JOB, { quoteId: QUOTE, deps })).toEqual({
      expired: 2,
      paid: 0,
      failed: 0,
    });
    expect(gateway.calls).toEqual([
      { op: "expire", id: sessionOf(P1) },
      { op: "expire", id: sessionOf(P2) },
    ]);
    expect(calls.map((c) => c.args.payment_id)).toEqual([P1, P2]);
    expect(calls.every((c) => (c.args.object as Row).status === "expired")).toBe(true);
    expect(calls.every((c) => c.args.correlation_id === "req-1")).toBe(true);
    // Another quote's deposit session is not this payment's business.
    expect(gateway.sessions.get(sessionOf(P3))?.status).toBe("open");
    expectCleanLogs(lines);
  });

  it("without a quote: balance sessions only", async () => {
    for (const quoteId of [undefined, null]) {
      const gateway = fakeStripe();
      await openSession(gateway, P1);
      await gateway.createCheckoutSession(depositInput(P2, QUOTE), `bicii-checkout-${P2}`);
      gateway.calls.length = 0;
      const { deps } = makeDeps(
        { record_stripe_read: [readResult("expired")] },
        {
          gateway,
          payments: {
            data: [pending(P1, "balance"), pending(P2, "deposit", QUOTE)],
            error: null,
          },
        },
      );
      expect(await expireOpenCheckouts(JOB, { quoteId, deps })).toEqual({
        expired: 1,
        paid: 0,
        failed: 0,
      });
      expect(gateway.calls).toEqual([{ op: "expire", id: sessionOf(P1) }]);
      expect(gateway.sessions.get(sessionOf(P2))?.status).toBe("open");
    }
  });

  it("a session the customer finished first: re-read, recorded, and counted as paid", async () => {
    for (const [paid, status] of [
      [true, "paid"],
      // Checkout completed and Stripe still confirming (PayNow): money is on its way.
      [false, "pending"],
    ] as const) {
      const gateway = fakeStripe();
      const s = await openSession(gateway, P1);
      gateway.complete(s.id, { paid });
      gateway.calls.length = 0;
      const { deps, calls } = makeDeps(
        { record_stripe_read: [readResult(status)] },
        { gateway, payments: { data: [pending(P1, "balance")], error: null } },
      );
      expect(await expireOpenCheckouts(JOB, { deps }), status).toEqual({
        expired: 0,
        paid: 1,
        failed: 0,
      });
      expect(gateway.calls.map((c) => c.op)).toEqual(["expire", "retrieve"]);
      expect((calls[0].args.object as Row).status).toBe("complete");
    }
  });

  it("a session Stripe had already expired: re-read, recorded, counted as expired", async () => {
    const gateway = fakeStripe();
    const s = await openSession(gateway, P1);
    gateway.expire(s.id);
    gateway.calls.length = 0;
    const { deps, calls } = makeDeps(
      { record_stripe_read: [readResult("expired")] },
      { gateway, payments: { data: [pending(P1, "balance")], error: null } },
    );
    expect(await expireOpenCheckouts(JOB, { deps })).toEqual({ expired: 1, paid: 0, failed: 0 });
    expect(gateway.calls.map((c) => c.op)).toEqual(["expire", "retrieve"]);
    expect(calls).toHaveLength(1);
  });

  it("a failure on one session is counted, logged by code, and the others still run; never throws", async () => {
    const gateway = fakeStripe();
    await openSession(gateway, P1);
    await openSession(gateway, P2);
    await openSession(gateway, P3);
    gateway.failNext("expire", new StripeError("stripe_unavailable", true, 503));
    const { deps, lines } = makeDeps(
      {
        record_stripe_read: [
          refused("boom", "XX000"), // P2: expired at Stripe, but not recorded
          readResult("expired"),
        ],
      },
      {
        gateway,
        payments: {
          data: [pending(P1, "balance"), pending(P2, "balance"), pending(P3, "balance")],
          error: null,
        },
      },
    );
    expect(await expireOpenCheckouts(JOB, { deps })).toEqual({ expired: 1, paid: 0, failed: 2 });
    const text = lines.join("\n");
    expect(text).toContain("stripe_unavailable");
    expect(text).toContain("XX000");
    expect(text).toContain(P1);
    expectCleanLogs(lines);
  });

  it("a session Stripe cannot find is a failure, not a throw", async () => {
    const { deps } = makeDeps({}, { payments: { data: [pending(P1, "balance")], error: null } });
    expect(await expireOpenCheckouts(JOB, { deps })).toEqual({ expired: 0, paid: 0, failed: 1 });
  });

  it("the payments read failing counts as one failure, logged by code; never throws", async () => {
    const { deps, gateway, lines } = makeDeps(
      {},
      { payments: { data: null, error: { code: "42501", message: "permission denied" } } },
    );
    expect(await expireOpenCheckouts(JOB, { deps })).toEqual({ expired: 0, paid: 0, failed: 1 });
    expect(gateway.calls).toEqual([]);
    expect(lines.join("\n")).toContain("42501");

    const throwing = makeDeps({});
    (throwing.deps.supabase as unknown as { from: () => never }).from = () => {
      throw new Error("client broke");
    };
    expect(await expireOpenCheckouts(JOB, { deps: throwing.deps })).toEqual({
      expired: 0,
      paid: 0,
      failed: 1,
    });
  });

  it("Stripe off, no gateway or no service client: skipped, nothing read", async () => {
    for (const over of [
      { config: { state: "off", reason: "not_configured" } as StripeConfig },
      { gateway: null },
      { supabase: null },
    ]) {
      const { deps, queries, names } = makeDeps({}, over);
      expect(await expireOpenCheckouts(JOB, { quoteId: QUOTE, deps })).toEqual({
        expired: 0,
        paid: 0,
        failed: 0,
      });
      expect(queries).toEqual([]);
      expect(names()).toEqual([]);
    }
  });

  it("starts no Stripe step after the 30-second budget: the rest count as failed", async () => {
    let t = NOW_MS;
    const gateway = fakeStripe();
    await openSession(gateway, P1);
    await openSession(gateway, P2);
    gateway.calls.length = 0;
    const { deps } = makeDeps(
      {
        record_stripe_read: [
          () => {
            t = NOW_MS + PAY_DEADLINE_MS + 1_000;
            return readResult("expired");
          },
        ],
      },
      {
        gateway,
        now: () => t,
        payments: { data: [pending(P1, "balance"), pending(P2, "balance")], error: null },
      },
    );
    expect(await expireOpenCheckouts(JOB, { deps })).toEqual({ expired: 1, paid: 0, failed: 1 });
    expect(gateway.calls).toEqual([{ op: "expire", id: sessionOf(P1) }]);
    expect(gateway.sessions.get(sessionOf(P2))?.status).toBe("open");
  });
});
