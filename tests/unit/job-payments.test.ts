// @vitest-environment node
/**
 * getJobPayments (src/lib/domain/payments.ts; Phase 14 steps 2 and 3;
 * D151, D154, D156, D159b, D161): the job's Customer payments card and the
 * order sheet read seven views and tables through RLS, plus the staff
 * directory for names. Money leaves as Postgres computed it, formatted,
 * never summed; a read that fails gives null (logged by code) so the job
 * page never breaks. The views themselves are
 * tests/db/indent-deposits.test.ts and tests/db/counter-payments.test.ts.
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
const COUNTER = "22222222-3333-4444-8555-000000000001";
const COUNTER_VOIDED = "22222222-3333-4444-8555-000000000002";
const LINK = "33333333-4444-4555-8666-000000000001";
const ADMIN = "44444444-5555-4666-8777-000000000001";
const GONE = "44444444-5555-4666-8777-000000000099";

type Result = { data: unknown; error: { code: string; message: string } | null };

/**
 * A query builder per table: every filter returns the builder, which
 * resolves (await, maybeSingle) to that table's result. Records each
 * table's filters so the test can check they name the job.
 */
function supabaseWith(results: Record<string, Result>) {
  const filters: Record<string, unknown[][]> = {};
  const client = {
    rpc(name: string) {
      const result = results[`rpc:${name}`];
      if (!result) throw new Error(`unexpected rpc ${name}`);
      return Promise.resolve(result);
    },
    from(table: string) {
      const result = results[table];
      if (!result) throw new Error(`unexpected table ${table}`);
      filters[table] = [];
      const builder: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "is", "order"]) {
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
      counter_payment_id: null,
      issue: "paid_twice",
      severity: "danger",
      message: "This deposit was paid twice ($120.00 again). Refund one payment in Stripe.",
      since: "2026-10-02T02:05:00Z",
    },
    // A counter row's issue (D161j) names its counter payment, not a Stripe one.
    {
      payment_id: null,
      counter_payment_id: COUNTER,
      issue: "paid_job_cancelled",
      severity: "danger",
      message: "$45.00 taken at the counter is held but this job is cancelled.",
      since: "2026-10-03T02:00:00Z",
    },
    {
      payment_id: null,
      counter_payment_id: null,
      issue: null,
      severity: null,
      message: null,
      since: null,
    },
  ]),
  counter_payments: ok([
    {
      id: COUNTER,
      kind: "balance",
      quote_id: null,
      amount: 45,
      currency: "SGD",
      method: "cash",
      received_at: "2026-10-03T02:00:00Z",
      reference: "R-12",
      note: null,
      recorded_by: ADMIN,
      created_at: "2026-10-03T02:01:00Z",
      counter_payment_voids: null,
    },
    {
      id: COUNTER_VOIDED,
      kind: "deposit",
      quote_id: QUOTE,
      amount: "120",
      currency: "SGD",
      method: "paynow",
      received_at: "2026-10-03T03:00:00Z",
      reference: null,
      note: "At the desk",
      recorded_by: GONE,
      created_at: "2026-10-03T03:01:00Z",
      counter_payment_voids: {
        kind: "given_back",
        reason: "Paid online as well",
        voided_by: ADMIN,
        voided_at: "2026-10-04T02:00:00Z",
      },
    },
  ]),
  balance_links: ok({
    id: LINK,
    channel: "whatsapp",
    created_at: "2026-10-17T02:00:00Z",
    expires_at: "2026-10-24T02:00:00Z",
    valid_days: 7,
    amount_at_send: 180,
    sent_by: ADMIN,
  }),
  "rpc:staff_directory": ok([
    { id: ADMIN, display_name: "Sam Admin", role: "admin", active: true },
  ]),
  work_order_payment_totals: ok({
    currency: "SGD",
    paid_online: 120,
    refunded_online: 20,
    net_paid_online: 100,
    job_total: 25,
    balance_due: 0,
    paid_ahead: 75,
    held_over_total: 75,
    paid_at_counter: 45,
    net_paid: 145,
    processing_online: 0,
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
      counterPayments: [
        {
          id: COUNTER,
          kind: "balance",
          quoteId: null,
          amount: "45.00",
          currency: "SGD",
          method: "cash",
          receivedAt: "2026-10-03T02:00:00Z",
          reference: "R-12",
          note: null,
          recordedBy: "Sam Admin",
          createdAt: "2026-10-03T02:01:00Z",
          voided: null,
        },
        {
          id: COUNTER_VOIDED,
          kind: "deposit",
          quoteId: QUOTE,
          amount: "120.00",
          currency: "SGD",
          method: "paynow",
          receivedAt: "2026-10-03T03:00:00Z",
          reference: null,
          note: "At the desk",
          recordedBy: "A former colleague",
          createdAt: "2026-10-03T03:01:00Z",
          voided: {
            kind: "given_back",
            reason: "Paid online as well",
            voidedBy: "Sam Admin",
            voidedAt: "2026-10-04T02:00:00Z",
          },
        },
      ],
      link: {
        id: LINK,
        channel: "whatsapp",
        sentAt: "2026-10-17T02:00:00Z",
        expiresAt: "2026-10-24T02:00:00Z",
        validDays: 7,
        amountAtSend: "180.00",
        sentBy: "Sam Admin",
      },
      issues: [
        {
          paymentId: PAY,
          counterPaymentId: null,
          issue: "paid_twice",
          severity: "danger",
          message: "This deposit was paid twice ($120.00 again). Refund one payment in Stripe.",
          since: "2026-10-02T02:05:00Z",
        },
        {
          paymentId: null,
          counterPaymentId: COUNTER,
          issue: "paid_job_cancelled",
          severity: "danger",
          message: "$45.00 taken at the counter is held but this job is cancelled.",
          since: "2026-10-03T02:00:00Z",
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
        heldOverTotal: "75.00",
        paidAtCounter: "45.00",
        netPaid: "145.00",
        processingOnline: "0.00",
      },
    });
    for (const table of [
      "quote_deposits",
      "payments",
      "payment_issues",
      "work_order_payment_totals",
      "counter_payments",
      "balance_links",
    ])
      expect(filters[table], table).toContainEqual(["eq", "work_order_id", JOB]);
    expect(filters.payment_refunds).toContainEqual(["eq", "payments.work_order_id", JOB]);
  });

  it("reads only the live link, never its token hash, and the totals' step 3 columns", async () => {
    const { supabase, filters } = supabaseWith(ROWS);
    await getJobPayments(supabase, JOB);
    expect(filters.balance_links).toContainEqual(["is", "withdrawn_at", null]);
    const linkSelect = filters.balance_links.find((f) => f[0] === "select")![1] as string;
    expect(linkSelect).not.toContain("token");
    const totalsSelect = filters.work_order_payment_totals.find(
      (f) => f[0] === "select",
    )![1] as string;
    for (const c of ["paid_at_counter", "net_paid", "processing_online"])
      expect(totalsSelect).toContain(c);
    const counterSelect = filters.counter_payments.find((f) => f[0] === "select")![1] as string;
    expect(counterSelect).toContain("counter_payment_voids(");
    expect(counterSelect).not.toContain("request_fingerprint");
  });

  it("no counter payments and no link read as empty and null", async () => {
    const { supabase } = supabaseWith({
      ...ROWS,
      counter_payments: ok([]),
      balance_links: ok(null),
    });
    const result = await getJobPayments(supabase, JOB);
    expect(result?.counterPayments).toEqual([]);
    expect(result?.link).toBeNull();
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
    for (const failing of [
      "payment_issues",
      "counter_payments",
      "balance_links",
      "rpc:staff_directory",
    ]) {
      error.mockClear();
      const { supabase } = supabaseWith({
        ...ROWS,
        [failing]: { data: null, error: { code: "42P01", message: "relation does not exist" } },
      });
      expect(await getJobPayments(supabase, JOB), failing).toBeNull();
      expect(error).toHaveBeenCalledWith(
        { workOrderId: JOB, code: "42P01" },
        "job payments read failed",
      );
    }
  });
});
