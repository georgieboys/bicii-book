// @vitest-environment node
/**
 * The Stripe fee sweep and read (D273; src/lib/integrations/stripe/fees.ts):
 * it asks Postgres which paid payments have no fee (stripe_fees_due, in
 * the gateway's mode), reads each PaymentIntent with the balance
 * transaction expanded and hands the object to record_stripe_read; a key
 * refusal stops the run, a missing balance transaction counts as pending,
 * nothing starts past the deadline, and no amount is computed here.
 */
import pino from "pino";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { readStripeFee, sweepStripeFees } = await import("@/lib/integrations/stripe/fees");
const { createFakeStripeGateway } = await import("@/lib/integrations/stripe/fake-gateway");
const { StripeError } = await import("@/lib/integrations/stripe/gateway");

import type { StripeDeps } from "@/lib/integrations/stripe/deps";
import type { ServiceSupabase } from "@/lib/integrations/shopify/deps";

const NOW_MS = 1_800_000_000_000;
const P = ["11111111-2222-4333-8444-000000000001", "11111111-2222-4333-8444-000000000002"];

type Row = Record<string, unknown>;

async function paidIntent(gateway: ReturnType<typeof createFakeStripeGateway>, i: number) {
  const s = await gateway.createCheckoutSession(
    {
      paymentId: P[i],
      workOrderId: "66666666-7777-4888-9999-000000000000",
      quoteId: null,
      kind: "balance",
      jobNumber: "J-0042",
      amountCents: 12000,
      expiresAt: NOW_MS / 1000 + 3600,
      successUrl: "http://localhost:3000/pay/t?balance=returned",
      cancelUrl: "http://localhost:3000/pay/t?balance=cancelled",
    },
    `bicii-checkout-${P[i]}`,
  );
  gateway.complete(s.id, { paymentIntent: `pi_fee${i}` });
}

function makeDeps(outcomes: string[], due = [0, 1]) {
  const calls: Array<{ name: string; args: Row }> = [];
  const queue = [...outcomes];
  const rpc = async (name: string, args: Row) => {
    calls.push({ name, args });
    if (name === "stripe_fees_due") {
      return {
        data: due.map((i) => ({ payment_id: P[i], payment_intent_id: `pi_fee${i}` })),
        error: null,
      };
    }
    if (name === "record_stripe_read") {
      return {
        data: [
          {
            event_id: "e",
            event_status: "applied",
            outcome: queue.shift(),
            payment_status: "paid",
          },
        ],
        error: null,
      };
    }
    if (name === "note_stripe_fee_read_failed") return { data: null, error: null };
    throw new Error(`unexpected rpc ${name}`);
  };
  const lines: string[] = [];
  const gateway = createFakeStripeGateway({ now: () => NOW_MS });
  let now = NOW_MS;
  const deps: StripeDeps = {
    supabase: { rpc } as unknown as ServiceSupabase,
    gateway,
    config: { state: "on" } as never,
    log: pino({ level: "trace" }, { write: (l: string) => void lines.push(l) }),
    correlationId: "req-1",
    now: () => now,
  };
  return { deps, gateway, calls, lines, tick: (ms: number) => (now += ms) };
}

describe("sweepStripeFees (D273)", () => {
  it("reads each due payment's expanded intent and records it as Stripe's word", async () => {
    const { deps, gateway, calls } = makeDeps(["stripe_fee_recorded", "stripe_fee_pending"]);
    await paidIntent(gateway, 0);
    await paidIntent(gateway, 1);
    gateway.setFee("pi_fee0", { feeCents: 410, taxCents: 34 });
    gateway.calls.length = 0;
    expect(await sweepStripeFees(deps, { max: 5, deadlineMs: NOW_MS + 20_000 })).toEqual({
      recorded: 1,
      pending: 1,
      failed: 0,
      permission: false,
    });
    expect(calls[0]).toEqual({ name: "stripe_fees_due", args: { max_rows: 5, p_livemode: false } });
    expect(gateway.calls).toEqual([
      { op: "retrieve_pi_fee", id: "pi_fee0" },
      { op: "retrieve_pi_fee", id: "pi_fee1" },
    ]);
    const first = calls[1].args;
    expect(first).toMatchObject({ payment_id: P[0], correlation_id: "req-1" });
    // The object as Stripe returned it, cents and all: Postgres converts.
    expect((first.object as Row).latest_charge).toMatchObject({
      balance_transaction: { fee: 410 },
    });
  });

  it("a key without Balance: Read stops the run at the first refusal", async () => {
    const { deps, gateway, calls, lines } = makeDeps([]);
    await paidIntent(gateway, 0);
    await paidIntent(gateway, 1);
    gateway.failNext("retrieve_pi_fee", new StripeError("stripe_auth_failed", false, 403));
    expect(await sweepStripeFees(deps, { max: 5, deadlineMs: NOW_MS + 20_000 })).toEqual({
      recorded: 0,
      pending: 0,
      failed: 1,
      permission: true,
    });
    expect(calls.map((c) => c.name)).toEqual(["stripe_fees_due"]);
    expect(lines.join("\n")).toContain("stripe_auth_failed");
  });

  it("a read needing attention counts as failed; one Stripe error does not stop the run", async () => {
    const { deps, gateway } = makeDeps(["stripe_fee_currency_mismatch", "stripe_fee_unchanged"]);
    await paidIntent(gateway, 0);
    await paidIntent(gateway, 1);
    expect(await sweepStripeFees(deps, { max: 5, deadlineMs: NOW_MS + 20_000 })).toEqual({
      recorded: 1,
      pending: 0,
      failed: 1,
      permission: false,
    });
    const other = makeDeps(["stripe_fee_recorded"]);
    await paidIntent(other.gateway, 1);
    // pi_fee0 is unknown to this fake: not found, then the next one is read.
    expect(await sweepStripeFees(other.deps, { max: 5, deadlineMs: NOW_MS + 20_000 })).toEqual({
      recorded: 1,
      pending: 0,
      failed: 1,
      permission: false,
    });
  });

  it("each failed read is noted so the work list backs off on it (never the key refusal)", async () => {
    const { deps, gateway, calls } = makeDeps(["stripe_fee_currency_mismatch"]);
    await paidIntent(gateway, 0);
    // pi_fee1 is unknown to this fake: Stripe answers not found.
    await sweepStripeFees(deps, { max: 5, deadlineMs: NOW_MS + 20_000 });
    expect(calls.filter((c) => c.name === "note_stripe_fee_read_failed")).toEqual([
      {
        name: "note_stripe_fee_read_failed",
        args: { p_payment_id: P[0], p_error: "stripe_fee_currency_mismatch" },
      },
      {
        name: "note_stripe_fee_read_failed",
        args: { p_payment_id: P[1], p_error: "stripe_not_found" },
      },
    ]);
  });

  it("starts nothing past the deadline, and is off without Stripe", async () => {
    const { deps, gateway } = makeDeps(["stripe_fee_recorded"]);
    await paidIntent(gateway, 0);
    gateway.calls.length = 0;
    expect(await sweepStripeFees(deps, { max: 5, deadlineMs: NOW_MS })).toEqual({
      recorded: 0,
      pending: 0,
      failed: 0,
      permission: false,
    });
    expect(gateway.calls).toEqual([]);
    expect(await sweepStripeFees({ ...deps, gateway: null }, { max: 5, deadlineMs: NOW_MS })).toBe(
      null,
    );
    const off = await readStripeFee({ ...deps, supabase: null }, P[0], "pi_fee0");
    expect(off).toMatchObject({ kind: "failed" });
  });

  it("a database error on the work list throws (the cron logs the step)", async () => {
    const { deps } = makeDeps([]);
    deps.supabase = {
      rpc: async () => ({ data: null, error: { code: "42501", message: "denied" } }),
    } as unknown as ServiceSupabase;
    await expect(sweepStripeFees(deps, { max: 5, deadlineMs: NOW_MS + 1 })).rejects.toMatchObject({
      code: "42501",
    });
  });
});
