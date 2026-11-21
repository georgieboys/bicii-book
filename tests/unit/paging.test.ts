// @vitest-environment node
/**
 * Reads that may exceed PostgREST's max-rows (1,000 a response) page with
 * `.range()` until a short page (src/lib/domain/paging.ts): the schedule's
 * appointments that hold capacity (holdingBetween, via getClosure), the
 * slot mirror's appointments (loadSchedule) and the money held on jobs
 * (getPaymentsHeld, whose export refuses more than EXPORT_MAX_ROWS). The
 * fake client answers like PostgREST: never more than 1,000 rows, whatever
 * the query asks for.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { READ_PAGE, readAllPages } = await import("@/lib/domain/paging");
const { getClosure } = await import("@/lib/domain/schedule");
const { loadSchedule } = await import("@/lib/domain/appointments");
const { getPaymentsHeld } = await import("@/lib/domain/payment-reports");
const { EXPORT_FETCHERS } = await import("@/lib/domain/report-exports");
const { ExportError, EXPORT_MAX_ROWS } = await import("@/lib/domain/period-reports");
import type { ServerSupabase } from "@/lib/supabase/server";

const MAX_ROWS = 1000;
type Call = [method: string, ...args: unknown[]];
type Result = { data: unknown; error: { code: string; message: string } | null };

/**
 * A PostgREST-like fake: `from(table)` and `rpc(name)` return a chainable
 * builder that records every call; awaiting it answers `rows(source)`
 * sliced by its `.range()` (else from 0) and cut at MAX_ROWS, or one row
 * for `.maybeSingle()`.
 */
function fakeClient(rows: (source: string) => unknown[] | Error) {
  const queries: { source: string; calls: Call[] }[] = [];
  const builder = (source: string) => {
    const q = { source, calls: [] as Call[] };
    queries.push(q);
    const answer = (): Result => {
      const all = rows(source);
      if (all instanceof Error)
        return { data: null, error: { code: "42501", message: all.message } };
      if (q.calls.some(([m]) => m === "maybeSingle")) return { data: all[0] ?? null, error: null };
      const range = q.calls.find(([m]) => m === "range");
      const from = range ? (range[1] as number) : 0;
      const to = range ? (range[2] as number) : Number.POSITIVE_INFINITY;
      return { data: all.slice(from, Math.min(to + 1, from + MAX_ROWS)), error: null };
    };
    const proxy: object = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") {
            return (ok: (r: Result) => unknown, fail: (e: unknown) => unknown) =>
              Promise.resolve(answer()).then(ok, fail);
          }
          return (...args: unknown[]) => {
            q.calls.push([String(prop), ...args]);
            return proxy;
          };
        },
      },
    );
    return proxy;
  };
  const client = { from: builder, rpc: (name: string) => builder(name) };
  return { supabase: client as unknown as ServerSupabase, queries };
}

const appointments = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `a0000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    starts_at: "2027-03-01T02:00:00.000Z",
    ends_at: "2027-03-01T02:30:00.000Z",
    capacity_units: 1,
    status: "booked",
  }));

const SETTINGS = {
  timezone: "Asia/Singapore",
  default_currency: "SGD",
  intake_slot_minutes: 30,
  intake_capacity_units: 4,
  booking_min_notice_minutes: 0,
  booking_horizon_days: 60,
  customer_max_active_bookings: 3,
  customer_cancel_cutoff_minutes: 0,
  public_site_url: null,
  booking_alert_staff_ids: [],
  booking_alert_emails: [],
};

const pagesOf = (queries: { source: string; calls: Call[] }[], source: string) =>
  queries.filter((q) => q.source === source).map((q) => q.calls.find(([m]) => m === "range"));

describe("readAllPages", () => {
  it("reads pages of 1,000 until a short page: 1,000 then 3 is 1,003", async () => {
    const page = vi.fn(async (from: number) => ({
      data: Array.from({ length: from === 0 ? 1000 : 3 }, (_, i) => from + i),
      error: null,
    }));
    const rows = await readAllPages(page);
    expect(READ_PAGE).toBe(1000);
    expect(rows).toHaveLength(1003);
    expect(page.mock.calls).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
  });

  it("asks once more after an exactly full page, and stops past `max`", async () => {
    const full = vi.fn(async (from: number) => ({
      data: from < 2000 ? Array.from({ length: 1000 }, () => 1) : [],
      error: null,
    }));
    expect(await readAllPages(full)).toHaveLength(2000);
    expect(full).toHaveBeenCalledTimes(3);
    const endless = vi.fn(async () => ({
      data: Array.from({ length: 1000 }, () => 1),
      error: null,
    }));
    expect(await readAllPages(endless, 1500)).toHaveLength(2000);
    expect(endless).toHaveBeenCalledTimes(2);
  });

  it("throws the database's refusal", async () => {
    await expect(
      readAllPages(async () => ({ data: null, error: { code: "42501", message: "denied" } })),
    ).rejects.toMatchObject({ code: "42501" });
  });
});

describe("the schedule's appointments that hold capacity (holdingBetween)", () => {
  it("a closure counts all 1,003 appointments it closes, read in two ordered pages", async () => {
    const CLOSURE = {
      id: "c1000000-0000-4000-8000-000000000001",
      kind: "closed",
      starts_at: "2027-02-28T16:00:00.000Z",
      ends_at: "2027-03-01T16:00:00.000Z",
      opens_at: null,
      closes_at: null,
      reason: "Stocktake",
    };
    const c = fakeClient((source) =>
      source === "shop_settings"
        ? [SETTINGS]
        : source === "closure_overrides"
          ? [CLOSURE]
          : source === "appointments"
            ? appointments(1003)
            : [],
    );
    const item = await getClosure(c.supabase, CLOSURE.id);
    expect(item?.affectedAppointments).toBe(1003);
    expect(pagesOf(c.queries, "appointments")).toEqual([
      ["range", 0, 999],
      ["range", 1000, 1999],
    ]);
    const first = c.queries.find((q) => q.source === "appointments")!;
    expect(first.calls.filter(([m]) => m === "order")).toEqual([
      ["order", "starts_at"],
      ["order", "id"],
    ]);
    expect(first.calls.some(([m]) => m === "limit")).toBe(false);
  });
});

describe("the slot mirror's appointments (loadSchedule)", () => {
  it("returns all 1,003 appointments in the range", async () => {
    const c = fakeClient((source) =>
      source === "shop_settings" ? [SETTINGS] : source === "appointments" ? appointments(1003) : [],
    );
    const data = await loadSchedule(c.supabase, { from: "2027-03-01", days: 1 });
    expect(data.appointments).toHaveLength(1003);
    expect(pagesOf(c.queries, "appointments")).toEqual([
      ["range", 0, 999],
      ["range", 1000, 1999],
    ]);
  });
});

describe("money held on jobs now (report_payments_held)", () => {
  const held = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      grp: "open",
      work_order_id: `66666666-7777-4888-9999-${String(i).padStart(12, "0")}`,
      job_number: `J-${String(i).padStart(6, "0")}`,
      status: "in_progress",
      customer_label: "Ana Lim",
      amount: 10,
      net_paid: 10,
      net_paid_online: 10,
      paid_at_counter: 0,
      job_total: 20,
      balance_due: 10,
      paid_ahead: 0,
      currency: "SGD",
    }));

  it("reads every row in pages: 1,000 then 3 is 1,003, the page and the export alike", async () => {
    const all = held(1003);
    const c = fakeClient(() => all);
    expect(await getPaymentsHeld(c.supabase)).toHaveLength(1003);
    expect(await EXPORT_FETCHERS.payments_held(c.supabase, {} as never)).toHaveLength(1003);
    expect(pagesOf(c.queries, "report_payments_held")).toEqual([
      ["range", 0, 999],
      ["range", 1000, 1999],
      ["range", 0, 999],
      ["range", 1000, 1999],
    ]);
  });

  it("the export refuses more than EXPORT_MAX_ROWS rather than writing it short", async () => {
    const all = held(EXPORT_MAX_ROWS + 1);
    const c = fakeClient(() => all);
    const refused = EXPORT_FETCHERS.payments_held(c.supabase, {} as never);
    await expect(refused).rejects.toBeInstanceOf(ExportError);
    await expect(refused).rejects.toMatchObject({ reason: "too_large" });
    // It stops reading once past the ceiling.
    expect(pagesOf(c.queries, "report_payments_held")).toHaveLength(EXPORT_MAX_ROWS / 1000 + 1);
  });

  it("exactly EXPORT_MAX_ROWS is written whole", async () => {
    const all = held(EXPORT_MAX_ROWS);
    const c = fakeClient(() => all);
    expect(await EXPORT_FETCHERS.payments_held(c.supabase, {} as never)).toHaveLength(
      EXPORT_MAX_ROWS,
    );
  });
});
