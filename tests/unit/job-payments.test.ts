// @vitest-environment node
/**
 * getJobPayments (src/lib/domain/payments.ts; Phase 14 step 2; D151, D154,
 * D159b): the job's Customer payments card and the order sheet read five
 * views and tables through RLS. Money leaves as Postgres computed it,
 * formatted, never summed; a read that fails gives null (logged by code)
 * so the job page never breaks. The views themselves are
 * tests/db/indent-deposits.test.ts.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const error = vi.fn();
vi.mock("@/lib/logger", () => ({ logger: { error, warn: vi.fn(), info: vi.fn() } }));

const { getJobPayments } = await import("@/lib/domain/payments");
import type { ServerSupabase } from "@/lib/supabase/server";

const JOB = "66666666-7777-4888-9999-000000000000";
const QUOTE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const PAY = "11111111-2222-4333-8444-000000000001";

type Result = { data: unknown; error: { code: string; message: string } | null };

/**
 * A query builder per table: every filter returns the builder, which
 * resolves (await, maybeSingle) to that table's result. Records each
 * table's filters so the test can check they name the job.
 */
function supabaseWith(results: Record<string, Result>) {
  const filters: Record<string, unknown[][]> = {};
  const client = {
    from(table: string) {
      const result = results[table];
      if (!result) throw new Error(`unexpected table ${table}`);
      filters[table] = [];
      const builder: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "order"]) {
        builder[m] = (...args: unknown[]) => {
          filters[table].push([m, ...args]);
          return builder;
        };
      }
      builder.maybeSingle = async () => result;
      builder.then = (resolve: (r: Result) => unknown) => resolve(result);
      return builder;
    },
  };
  return { supabase: client as unknown as ServerSupabase, filters };
}

const ok = (data: unknown): Result => ({ data, error: null });

const ROWS: Record<string, Result> = {
  quote_deposits: ok([
    {
      quote_id: QUOTE,
      sent_at: "2026-10-01T02:00:00Z",
      answered_at: "2026-10-02T02:00:00Z",
      deposit_percent: 50,
      deposit_amount: 120,
      currency: "SGD",
      state: "paid",
      part_request_ids: ["r1"],
    },
    // A row RLS returned without its snapshot is left out.
    { quote_id: null, deposit_amount: null, state: "due" },
  ]),
  payments: ok([
    {
      id: PAY,
      kind: "deposit",
      quote_id: QUOTE,
      amount: 120,
      amount_received: 120,
      refunded_amount: 20,
      currency: "SGD",
      status: "partially_refunded",
      checkout_completed_at: "2026-10-02T02:05:00Z",
      created_at: "2026-10-02T02:01:00Z",
      paid_at: "2026-10-02T02:05:00Z",
      checked_at: null,
      stripe_session_expires_at: "2026-10-02T03:01:00Z",
      stripe_payment_intent_id: "pi_1",
      livemode: false,
    },
  ]),
  payment_refunds: ok([{ payment_id: PAY, status: "pending" }]),
  payment_issues: ok([
    {
      payment_id: PAY,
      issue: "paid_twice",
      severity: "danger",
      message: "This deposit was paid twice ($120.00 again). Refund one payment in Stripe.",
      since: "2026-10-02T02:05:00Z",
    },
    { payment_id: null, issue: null, severity: null, message: null, since: null },
  ]),
  work_order_payment_totals: ok({
    currency: "SGD",
    paid_online: 120,
    refunded_online: 20,
    net_paid_online: 100,
    job_total: 25,
    balance_due: 0,
    paid_ahead: 75,
  }),
};

describe("getJobPayments", () => {
  it("maps the five reads, money formatted as Postgres computed it, each filtered by the job", async () => {
    const { supabase, filters } = supabaseWith(ROWS);
    const result = await getJobPayments(supabase, JOB);
    expect(result).toEqual({
      deposits: [
        {
          quoteId: QUOTE,
          sentAt: "2026-10-01T02:00:00Z",
          answeredAt: "2026-10-02T02:00:00Z",
          percent: 50,
          amount: "120.00",
          currency: "SGD",
          state: "paid",
          partRequestIds: ["r1"],
        },
      ],
      payments: [
        {
          id: PAY,
          kind: "deposit",
          quoteId: QUOTE,
          amount: "120.00",
          amountReceived: "120.00",
          refundedAmount: "20.00",
          currency: "SGD",
          status: "partially_refunded",
          processing: false,
          createdAt: "2026-10-02T02:01:00Z",
          paidAt: "2026-10-02T02:05:00Z",
          checkedAt: null,
          sessionExpiresAt: "2026-10-02T03:01:00Z",
          paymentIntentId: "pi_1",
          livemode: false,
          refundPending: true,
        },
      ],
      issues: [
        {
          paymentId: PAY,
          issue: "paid_twice",
          severity: "danger",
          message: "This deposit was paid twice ($120.00 again). Refund one payment in Stripe.",
          since: "2026-10-02T02:05:00Z",
        },
      ],
      totals: {
        currency: "SGD",
        paidOnline: "120.00",
        refundedOnline: "20.00",
        netPaidOnline: "100.00",
        jobTotal: "25.00",
        balanceDue: "0.00",
        paidAhead: "75.00",
      },
    });
    for (const table of [
      "quote_deposits",
      "payments",
      "payment_issues",
      "work_order_payment_totals",
    ])
      expect(filters[table], table).toContainEqual(["eq", "work_order_id", JOB]);
    expect(filters.payment_refunds).toContainEqual(["eq", "payments.work_order_id", JOB]);
  });

  it("a pending payment whose Checkout completed is processing; an unknown deposit state reads none", async () => {
    const { supabase } = supabaseWith({
      ...ROWS,
      quote_deposits: ok([
        {
          quote_id: QUOTE,
          sent_at: null,
          answered_at: null,
          deposit_percent: 50,
          deposit_amount: "60.5",
          currency: null,
          state: "owed",
          part_request_ids: null,
        },
      ]),
      payments: ok([
        {
          ...(ROWS.payments.data as Record<string, unknown>[])[0],
          status: "pending",
          amount_received: null,
          refunded_amount: 0,
          paid_at: null,
        },
      ]),
      payment_refunds: ok([]),
      work_order_payment_totals: ok(null),
    });
    const result = await getJobPayments(supabase, JOB);
    expect(result?.deposits[0]).toMatchObject({
      amount: "60.50",
      currency: "SGD",
      state: "none",
      partRequestIds: [],
    });
    expect(result?.payments[0]).toMatchObject({
      processing: true,
      amountReceived: null,
      refundPending: false,
    });
    expect(result?.totals).toBeNull();
  });

  it("gives null, logged by the error's code only, when any read fails", async () => {
    const { supabase } = supabaseWith({
      ...ROWS,
      payment_issues: { data: null, error: { code: "42P01", message: "relation does not exist" } },
    });
    expect(await getJobPayments(supabase, JOB)).toBeNull();
    expect(error).toHaveBeenCalledWith(
      { workOrderId: JOB, code: "42P01" },
      "job payments read failed",
    );
  });
});
