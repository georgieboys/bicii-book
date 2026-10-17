// @vitest-environment node
/**
 * The Customer payments reads of Reports (src/lib/domain/payment-reports.ts;
 * Phase 14 step 3; PLAN D154a–e): each calls ONE RPC through the caller's
 * client and maps its rows onto the DTOs, money as fixed-2 strings in the
 * row's currency and never added up, counts as numbers. The list pages by
 * the keyset with the cursor passed back exactly as received; the export
 * pager checks the item count against report_payment_summary's four counts
 * (integers), retries once, then refuses. The RPCs themselves (and their
 * 42501 for a caller without View financial reports) are
 * tests/db/payment-reports.test.ts.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  getAllPaymentItemsForExport,
  getPaymentItems,
  getPaymentSummary,
  getPaymentsHeld,
  toHeldJob,
  toPaymentItem,
  toPaymentSummary,
} = await import("@/lib/domain/payment-reports");
const { ExportError, EXPORT_MAX_ROWS } = await import("@/lib/domain/period-reports");
const { EXPORT_FETCHERS } = await import("@/lib/domain/report-exports");
const { DbError } = await import("@/lib/db-errors");
import type { ServerSupabase } from "@/lib/supabase/server";

const JOB = "66666666-7777-4888-9999-000000000001";
const PAY = "11111111-2222-4333-8444-000000000001";
const COUNTER = "22222222-3333-4444-8555-000000000001";

type Result = { data: unknown; error: { code: string; message: string } | null };
type Call = { name: string; args: Record<string, unknown> | undefined };

/** A client whose rpc answers from `answer(name, args)` and records each call. */
function clientWith(answer: (name: string, args?: Record<string, unknown>) => Result) {
  const calls: Call[] = [];
  const client = {
    rpc(name: string, args?: Record<string, unknown>) {
      calls.push({ name, args });
      return Promise.resolve(answer(name, args));
    },
  };
  return { supabase: client as unknown as ServerSupabase, calls };
}

/** PostgREST sends numeric as a JSON number; a string (as a driver may) maps the same. */
const SUMMARY_ROW = {
  currency: "SGD",
  online_count: 3,
  online_total: 480,
  deposit_online_total: 300,
  balance_online_total: "180.5",
  refund_count: 1,
  refund_total: 50,
  counter_count: 2,
  counter_total: "45.00",
  given_back_count: 1,
  given_back_total: 10,
  net_total: "465.5",
  other_currency_count: 0,
};

const itemRow = (n: number, over: Record<string, unknown> = {}) => ({
  at: `2026-10-${String(17 - (n % 10)).padStart(2, "0")}T03:04:05.12345${n % 10}+00:00`,
  id: `11111111-2222-4333-8444-${String(n).padStart(12, "0")}`,
  movement: "online_payment",
  work_order_id: JOB,
  job_number: "J-000007",
  customer_label: "Ana Lim",
  kind: "deposit",
  method: "stripe",
  amount: 300,
  signed_amount: 300,
  currency: "SGD",
  other_currency: false,
  recorded_at: null,
  recorded_by_name: null,
  ...over,
});

describe("the summary (report_payment_summary)", () => {
  it("maps the row: money as fixed-2 strings, counts as numbers, the period it was asked for", () => {
    expect(toPaymentSummary(SUMMARY_ROW as never, "2026-10-12", "2026-10-18")).toEqual({
      from: "2026-10-12",
      to: "2026-10-18",
      currency: "SGD",
      onlineCount: 3,
      onlineTotal: "480.00",
      depositOnlineTotal: "300.00",
      balanceOnlineTotal: "180.50",
      refundCount: 1,
      refundTotal: "50.00",
      counterCount: 2,
      counterTotal: "45.00",
      givenBackCount: 1,
      givenBackTotal: "10.00",
      netTotal: "465.50",
      otherCurrencyCount: 0,
    });
  });

  it("reads null columns as 0 and a missing currency as SGD", () => {
    const empty = Object.fromEntries(Object.keys(SUMMARY_ROW).map((k) => [k, null]));
    const s = toPaymentSummary(empty as never, "2026-10-12", "2026-10-12");
    expect(s.currency).toBe("SGD");
    expect(s.netTotal).toBe("0.00");
    expect(s.onlineCount).toBe(0);
    expect(s.otherCurrencyCount).toBe(0);
  });

  it("calls the RPC with the period, and throws without a row or on an error", async () => {
    const ok = clientWith(() => ({ data: [SUMMARY_ROW], error: null }));
    const s = await getPaymentSummary(ok.supabase, "2026-10-01", "2026-10-31");
    expect(s.netTotal).toBe("465.50");
    expect(ok.calls).toEqual([
      { name: "report_payment_summary", args: { p_from: "2026-10-01", p_to: "2026-10-31" } },
    ]);

    const none = clientWith(() => ({ data: [], error: null }));
    await expect(getPaymentSummary(none.supabase, "2026-10-01", "2026-10-02")).rejects.toThrow(
      DbError,
    );

    const denied = clientWith(() => ({
      data: null,
      error: { code: "42501", message: "permission denied" },
    }));
    await expect(
      getPaymentSummary(denied.supabase, "2026-10-01", "2026-10-03"),
    ).rejects.toMatchObject({ name: "DbError", code: "42501" });
  });
});

describe("the movements (report_payment_items)", () => {
  it("maps a Stripe row and a counter row; a give-back keeps its sign", () => {
    expect(toPaymentItem(itemRow(1))).toEqual({
      at: itemRow(1).at,
      id: itemRow(1).id,
      movement: "online_payment",
      workOrderId: JOB,
      jobNumber: "J-000007",
      jobHref: `/jobs/${JOB}`,
      customerLabel: "Ana Lim",
      kind: "deposit",
      method: "stripe",
      amount: "300.00",
      signedAmount: "300.00",
      currency: "SGD",
      otherCurrency: false,
      recordedAt: null,
      recordedByName: null,
    });
    const back = toPaymentItem(
      itemRow(2, {
        id: COUNTER,
        movement: "counter_given_back",
        kind: "balance",
        method: "cash",
        amount: "45",
        signed_amount: -45,
        recorded_at: "2026-10-16T09:00:00+00:00",
        recorded_by_name: "Sam Tan",
        customer_label: null,
      }),
    );
    expect(back).toMatchObject({
      id: COUNTER,
      movement: "counter_given_back",
      amount: "45.00",
      signedAmount: "-45.00",
      recordedAt: "2026-10-16T09:00:00+00:00",
      recordedByName: "Sam Tan",
      customerLabel: null,
    });
    expect(toPaymentItem(itemRow(3, { other_currency: true })).otherCurrency).toBe(true);
  });

  it("asks for one more than it shows and returns the last shown row's (at, id) as received", async () => {
    const rows = [itemRow(1), itemRow(2), itemRow(3)];
    const c = clientWith(() => ({ data: rows, error: null }));
    const page = await getPaymentItems(c.supabase, {
      from: "2026-10-01",
      to: "2026-10-31",
      limit: 2,
    });
    expect(page.items.map((i) => i.id)).toEqual([rows[0].id, rows[1].id]);
    expect(page.nextCursor).toEqual({ at: rows[1].at, id: rows[1].id });
    expect(c.calls[0]).toEqual({
      name: "report_payment_items",
      args: { p_from: "2026-10-01", p_to: "2026-10-31", p_max_rows: 3 },
    });
  });

  it("passes the cursor back exactly and has no next page at the end", async () => {
    const c = clientWith(() => ({ data: [itemRow(4)], error: null }));
    const after = { at: "2026-10-15T03:04:05.123456+00:00", id: PAY };
    const page = await getPaymentItems(c.supabase, {
      from: "2026-10-01",
      to: "2026-10-31",
      limit: 100,
      after,
    });
    expect(page.nextCursor).toBeNull();
    expect(c.calls[0].args).toEqual({
      p_from: "2026-10-01",
      p_to: "2026-10-31",
      p_max_rows: 101,
      p_after_at: after.at,
      p_after_id: PAY,
    });
  });
});

describe("the payments export pager", () => {
  const summaryWith = (counts: Partial<typeof SUMMARY_ROW>) => ({ ...SUMMARY_ROW, ...counts });

  it("pages by 1,000 with the keyset and returns every movement when the counts agree", async () => {
    const all = Array.from({ length: 1500 }, (_, n) => itemRow(n));
    const c = clientWith((name, args) => {
      if (name === "report_payment_summary") {
        return {
          data: [
            summaryWith({
              online_count: 1000,
              refund_count: 200,
              counter_count: 250,
              given_back_count: 50,
            }),
          ],
          error: null,
        };
      }
      const start = args?.p_after_id ? all.findIndex((r) => r.id === args.p_after_id) + 1 : 0;
      return { data: all.slice(start, start + Number(args?.p_max_rows)), error: null };
    });
    const rows = await getAllPaymentItemsForExport(c.supabase, {
      from: "2026-10-01",
      to: "2026-10-31",
    });
    expect(rows).toHaveLength(1500);
    const pages = c.calls.filter((x) => x.name === "report_payment_items");
    expect(pages).toHaveLength(2);
    expect(pages[0].args).toMatchObject({ p_max_rows: 1000 });
    expect(pages[0].args).not.toHaveProperty("p_after_at");
    expect(pages[1].args).toMatchObject({ p_after_at: all[999].at, p_after_id: all[999].id });
  });

  it("retries once when the count moves under it, then refuses as changed", async () => {
    let summaries = 0;
    const c = clientWith((name) => {
      if (name === "report_payment_summary") {
        summaries += 1;
        return {
          data: [
            summaryWith({
              online_count: 2,
              refund_count: 0,
              counter_count: 0,
              given_back_count: 0,
            }),
          ],
          error: null,
        };
      }
      return { data: [itemRow(1)], error: null };
    });
    const err = await getAllPaymentItemsForExport(c.supabase, {
      from: "2026-10-01",
      to: "2026-10-31",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExportError);
    expect((err as InstanceType<typeof ExportError>).reason).toBe("changed");
    expect(summaries).toBe(2);
  });

  it("succeeds on the retry when the second read agrees", async () => {
    let summaries = 0;
    const c = clientWith((name) => {
      if (name === "report_payment_summary") {
        summaries += 1;
        const online = summaries === 1 ? 2 : 1;
        return {
          data: [
            summaryWith({
              online_count: online,
              refund_count: 0,
              counter_count: 0,
              given_back_count: 0,
            }),
          ],
          error: null,
        };
      }
      return { data: [itemRow(1)], error: null };
    });
    const rows = await getAllPaymentItemsForExport(c.supabase, {
      from: "2026-10-01",
      to: "2026-10-31",
    });
    expect(rows).toHaveLength(1);
    expect(summaries).toBe(2);
  });

  it("refuses a period with more movements than an export holds, before reading them", async () => {
    const c = clientWith(() => ({
      data: [summaryWith({ online_count: EXPORT_MAX_ROWS, refund_count: 1 })],
      error: null,
    }));
    const err = await getAllPaymentItemsForExport(c.supabase, {
      from: "2026-10-01",
      to: "2026-10-31",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExportError);
    expect((err as InstanceType<typeof ExportError>).reason).toBe("too_large");
    expect(c.calls.map((x) => x.name)).toEqual(["report_payment_summary"]);
  });

  it("is the payments kind's fetcher, with the export's period", async () => {
    const c = clientWith((name) =>
      name === "report_payment_summary"
        ? {
            data: [
              summaryWith({
                online_count: 1,
                refund_count: 0,
                counter_count: 0,
                given_back_count: 0,
              }),
            ],
            error: null,
          }
        : { data: [itemRow(1)], error: null },
    );
    const rows = await EXPORT_FETCHERS.payments(c.supabase, {
      period: "custom",
      anchor: "2026-10-31",
      from: "2026-10-01",
      to: "2026-10-31",
      basis: "check_in",
      by: "job",
      key: null,
    });
    expect(rows.map((r) => r.signedAmount)).toEqual(["300.00"]);
    // The basis does not drive Customer payments (D154a): only the period is sent.
    expect(c.calls[0].args).toEqual({ p_from: "2026-10-01", p_to: "2026-10-31" });
  });
});

describe("held on jobs now (report_payments_held)", () => {
  const heldRow = (over: Record<string, unknown> = {}) => ({
    grp: "awaiting_collection",
    work_order_id: JOB,
    job_number: "J-000007",
    status: "ready_for_collection",
    customer_label: "Ana Lim",
    amount: 100,
    net_paid: 100,
    net_paid_online: 0,
    paid_at_counter: "100.00",
    job_total: 145,
    balance_due: 45,
    paid_ahead: 0,
    currency: "SGD",
    ...over,
  });

  it("maps a row, a collected job's null balance and paid ahead staying null", () => {
    expect(toHeldJob(heldRow() as never)).toEqual({
      group: "awaiting_collection",
      workOrderId: JOB,
      jobNumber: "J-000007",
      jobHref: `/jobs/${JOB}`,
      status: "ready_for_collection",
      customerLabel: "Ana Lim",
      amount: "100.00",
      netPaid: "100.00",
      netPaidOnline: "0.00",
      paidAtCounter: "100.00",
      jobTotal: "145.00",
      balanceDue: "45.00",
      paidAhead: "0.00",
      currency: "SGD",
    });
    const collected = toHeldJob(
      heldRow({
        grp: "above_bill",
        status: "collected",
        balance_due: null,
        paid_ahead: null,
      }) as never,
    );
    expect(collected).toMatchObject({ group: "above_bill", balanceDue: null, paidAhead: null });
  });

  it("keeps the RPC's order and leaves out a group it does not know", async () => {
    const c = clientWith(() => ({
      data: [
        heldRow({ grp: "open", job_number: "J-000002" }),
        heldRow({ grp: "later_group" }),
        heldRow({ grp: "above_bill", job_number: "J-000001" }),
      ],
      error: null,
    }));
    const rows = await getPaymentsHeld(c.supabase);
    expect(rows.map((r) => [r.group, r.jobNumber])).toEqual([
      ["open", "J-000002"],
      ["above_bill", "J-000001"],
    ]);
    expect(c.calls).toEqual([{ name: "report_payments_held", args: undefined }]);
    expect(await EXPORT_FETCHERS.payments_held(c.supabase, {} as never)).toHaveLength(2);
  });

  it("throws the database's refusal", async () => {
    const c = clientWith(() => ({
      data: null,
      error: { code: "42501", message: "permission denied" },
    }));
    await expect(getPaymentsHeld(c.supabase)).rejects.toMatchObject({ code: "42501" });
  });
});
