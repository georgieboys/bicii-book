import { describe, expect, it } from "vitest";

import {
  ACTIVITY_FLOWS,
  TILE_BOARD_FILTERS,
  TILE_LINKS,
  documentHref,
  exceptionCopy,
  exceptionHref,
  exceptionKeys,
  exceptionLabel,
  exceptionsShownNote,
  formatRateRange,
  formatSignedMoney,
  groupEntries,
  lossNote,
  provisionalNote,
  stripeFeePendingNote,
  toTodayDashboard,
  weekStrip,
  type DailySummary,
  type FinancialEntry,
  type OperationalException,
  type TodayDashboardRow,
} from "@/lib/reports";
import { BOARD_GROUPS, OVERDUE_AFTER_DAYS, parseBoardFilters } from "@/lib/workshop";

/** A today_dashboard row as an admin (view_financial_reports + view_costs) sees today. */
function row(patch: Partial<TodayDashboardRow> = {}): TodayDashboardRow {
  return {
    day: "2026-10-05",
    is_today: true,
    generated_at: "2026-10-05T02:42:00Z",
    can_see_financials: true,
    can_see_costs: true,
    jobs_checked_in: 4,
    jobs_started: 2,
    jobs_completed: 1,
    jobs_ready_for_collection: 1,
    jobs_collected: 1,
    jobs_cancelled: 0,
    currency: "SGD",
    lines_recognised: 2,
    gross_sales: 165,
    cogs: 22,
    yield_total: 143,
    cult_commons_share: 42.9,
    bicii_yield_after_cc: 100.1,
    loss_lines: 0,
    loss_total: 0,
    parts_consumed_qty: 3,
    parts_consumed_lines: 3,
    parts_returned_qty: 1,
    stock_adjustments: 1,
    significant_stock_adjustments: 0,
    appointments_scheduled: null,
    appointments_arrived: null,
    appointments_no_show: null,
    consignment_sales: null,
    consignment_sales_total: null,
    new_consignor_liability: null,
    received_now: 4,
    waiting_now: 3,
    ready_to_start_now: 0,
    in_progress_now: 2,
    awaiting_collection_now: 4,
    open_jobs_now: 9,
    overdue_now: 2,
    low_stock_now: 3,
    exceptions_now: 3,
    cost_pending_lines: 0,
    stripe_fees: 0,
    stripe_fees_borne: 0,
    stripe_fee_pending_jobs: 0,
    shopify_fees: 0,
    shopify_fees_borne: 0,
    shopify_fee_pending_sales: 0,
    shopify_fee_pending_jobs: 0,
    ...patch,
  };
}

describe("toTodayDashboard", () => {
  it("maps an admin's today: flows, snapshot, money with costs as fixed-2 strings, stock", () => {
    const d = toTodayDashboard(row());
    expect(d.day).toBe("2026-10-05");
    expect(d.isToday).toBe(true);
    expect(d.generatedAt).toBe("2026-10-05T02:42:00Z");
    expect(d.workshop).toEqual({
      checkedIn: 4,
      started: 2,
      completed: 1,
      readyForCollection: 1,
      collected: 1,
      cancelled: 0,
    });
    expect(d.now).toEqual({
      received: 4,
      waiting: 3,
      readyToStart: 0,
      inProgress: 2,
      awaitingCollection: 4,
      open: 9,
      overdue: 2,
      lowStock: 3,
      exceptions: 3,
    });
    expect(d.money).toEqual({
      currency: "SGD",
      grossSales: "165.00",
      linesRecognised: 2,
      costPendingLines: 0,
      consignmentSales: { count: 0, total: "0.00" },
      costs: {
        cogs: "22.00",
        yield: "143.00",
        cultCommons: "42.90",
        biciiAfterCc: "100.10",
        lossTotal: "0.00",
        lossLines: 0,
        newConsignorLiability: "0.00",
        stripeFees: "0.00",
        stripeFeesBorne: "0.00",
        stripeFeePendingJobs: 0,
        shopifyFees: "0.00",
        shopifyFeesBorne: "0.00",
        shopifyFeePendingSales: 0,
        shopifyFeePendingJobs: 0,
      },
    });
    expect(d.stock).toEqual({
      partsConsumedQty: 3,
      partsConsumedLines: 3,
      partsReturnedQty: 1,
      adjustments: 1,
      significantAdjustments: 0,
    });
  });

  it("D273: carries the day's Stripe fees, what Cult Commons bore and the jobs still pending", () => {
    const d = toTodayDashboard(
      row({ stripe_fees: 3.76, stripe_fees_borne: 3.76, stripe_fee_pending_jobs: 2 }),
    );
    expect(d.money?.costs).toMatchObject({
      stripeFees: "3.76",
      stripeFeesBorne: "3.76",
      stripeFeePendingJobs: 2,
    });
    expect(stripeFeePendingNote(0)).toBeNull();
    expect(stripeFeePendingNote(1)).toBe(
      "Provisional: Stripe has not reported the fee on 1 job yet, so Cult Commons may still go down.",
    );
    expect(stripeFeePendingNote(2)).toMatch(/fees on 2 jobs yet/);
  });

  it("has no money without view_financial_reports (mechanic1: view_costs only)", () => {
    const d = toTodayDashboard(
      row({
        can_see_financials: false,
        can_see_costs: false,
        currency: null,
        lines_recognised: null,
        gross_sales: null,
        cogs: null,
        yield_total: null,
        cult_commons_share: null,
        bicii_yield_after_cc: null,
        loss_lines: null,
        loss_total: null,
        cost_pending_lines: null,
      }),
    );
    expect(d.money).toBeNull();
    // Operational counts stay (D30).
    expect(d.workshop.completed).toBe(1);
    expect(d.stock.adjustments).toBe(1);
    expect(d.now?.overdue).toBe(2);
  });

  it("has money without costs for view_financial_reports alone", () => {
    const d = toTodayDashboard(
      row({
        can_see_costs: false,
        cogs: null,
        yield_total: null,
        cult_commons_share: null,
        bicii_yield_after_cc: null,
        loss_lines: null,
        loss_total: null,
      }),
    );
    expect(d.money?.grossSales).toBe("165.00");
    expect(d.money?.costs).toBeNull();
  });

  it("never shows costs the flags say are hidden, even if a value came back", () => {
    expect(toTodayDashboard(row({ can_see_costs: false })).money?.costs).toBeNull();
    expect(toTodayDashboard(row({ can_see_financials: false })).money).toBeNull();
  });

  it("has no snapshot on a past day (D31)", () => {
    const d = toTodayDashboard(
      row({
        day: "2026-10-03",
        is_today: false,
        received_now: null,
        waiting_now: null,
        ready_to_start_now: null,
        in_progress_now: null,
        awaiting_collection_now: null,
        open_jobs_now: null,
        overdue_now: null,
        low_stock_now: null,
        exceptions_now: null,
      }),
    );
    expect(d.isToday).toBe(false);
    expect(d.now).toBeNull();
  });

  it("keeps the Phase 2 placeholder null until tracked; Phase 6's consignment figures are always numbers", () => {
    const d = toTodayDashboard(row());
    expect(d.appointments).toBeNull();
    // A missing value reads as zero: the database zero-fills these columns.
    expect(d.money?.consignmentSales).toEqual({ count: 0, total: "0.00" });
    expect(d.money?.costs?.newConsignorLiability).toBe("0.00");

    const lit = toTodayDashboard(
      row({
        appointments_scheduled: 5,
        appointments_arrived: 3,
        appointments_no_show: null,
        consignment_sales: 1,
        consignment_sales_total: 1200,
        new_consignor_liability: 900.5,
      }),
    );
    expect(lit.appointments).toEqual({ scheduled: 5, arrived: 3, noShow: 0 });
    expect(lit.money?.consignmentSales).toEqual({ count: 1, total: "1200.00" });
    expect(lit.money?.costs?.newConsignorLiability).toBe("900.50");
  });

  it("carries losses and cost-pending lines as the database counted them", () => {
    const d = toTodayDashboard(row({ loss_lines: 1, loss_total: -15, cost_pending_lines: 2 }));
    expect(d.money?.costs?.lossTotal).toBe("-15.00");
    expect(d.money?.costs?.lossLines).toBe(1);
    expect(d.money?.costPendingLines).toBe(2);
  });

  it("refuses a row without a day", () => {
    expect(() => toTodayDashboard(row({ day: null }))).toThrow(RangeError);
  });
});

describe("placeholders and notes", () => {
  it("writes losses with a real minus sign and says they don't offset other lines (D1)", () => {
    expect(formatSignedMoney("-15.00", "SGD")).toBe("−$15.00");
    expect(lossNote(0, "0.00", "SGD")).toBeNull();
    expect(lossNote(1, "-15.00", "SGD")).toBe(
      "1 line sold at a loss: −$15.00. Losses don't reduce Cult Commons on other lines.",
    );
    expect(lossNote(2, "-20.50", "SGD")).toMatch(/^2 lines sold at a loss: −\$20\.50\./);
  });

  it("marks the cost side provisional while lines have no cost (D14)", () => {
    expect(provisionalNote(0)).toBeNull();
    expect(provisionalNote(1)).toBe(
      "Provisional: 1 line has no cost entered, so cost, yield and Cult Commons count it at 0.",
    );
    expect(provisionalNote(3)).toMatch(/^Provisional: 3 lines have no cost entered/);
  });

  it("labels the snapshot rates as one rate or a range", () => {
    expect(formatRateRange([])).toBeNull();
    expect(formatRateRange(["0.3000"])).toBe("30%");
    expect(formatRateRange(["0.3000", "0.2500"])).toBe("25–30%");
    expect(formatRateRange(["0.1225", "0.3000", "0.2000"])).toBe("12.25–30%");
  });
});

const exception = (patch: Partial<OperationalException>): OperationalException => ({
  kind: "overdue_job",
  severity: "warning",
  entityType: "work_order",
  entityId: "d5000000-0000-4000-8000-000000000007",
  entityLabel: "J-000017",
  subjectLabel: "Priya Ramasamy · Cervelo R5",
  days: 11,
  quantity: null,
  since: "2026-09-24T02:00:00Z",
  ...patch,
});

describe("exceptions (D34)", () => {
  it("words every Phase 5 kind", () => {
    expect(exceptionCopy("overdue_job", exception({}))).toEqual({
      text: `Open 11 days — over the ${OVERDUE_AFTER_DAYS}-day limit`,
      tone: "danger",
    });
    expect(exceptionCopy("uncollected_job", exception({ days: 9 })).tone).toBe("waiting");
    expect(exceptionCopy("uncollected_job", exception({ days: 9 })).text).toBe(
      "Waiting for collection 9 days",
    );
    expect(exceptionCopy("uncollected_job", exception({ days: 1 })).text).toBe(
      "Waiting for collection 1 day",
    );
    expect(
      exceptionCopy(
        "negative_stock",
        exception({
          severity: "danger",
          entityType: "product",
          subjectLabel: "Road inner tube · Shop floor",
          quantity: -2,
          days: null,
        }),
      ),
    ).toEqual({ text: "Below zero at Shop floor: −2", tone: "danger" });
    expect(exceptionCopy("unit_hold_stale", exception({ severity: "danger", days: 3 }))).toEqual({
      text: "Held for a customer, but no open job uses it (3 days)",
      tone: "danger",
    });
    expect(exceptionCopy("currency_mismatch", exception({ severity: "danger" })).tone).toBe(
      "danger",
    );
    expect(exceptionLabel("overdue_job")).toBe("Overdue");
    expect(exceptionLabel("negative_stock")).toBe("Below zero");
  });

  it("keys a product below zero at two locations as two rows", () => {
    const at = (subjectLabel: string) =>
      exception({
        kind: "negative_stock",
        severity: "danger",
        entityType: "product",
        entityId: "c2000000-0000-4000-8000-000000000001",
        subjectLabel,
      });
    const keys = exceptionKeys([
      at("Road inner tube · Shop floor"),
      at("Road inner tube · Workshop store"),
      at("Road inner tube · Workshop store"),
      exception({}),
    ]);
    expect(new Set(keys).size).toBe(4);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("says how many exceptions a capped list leaves out", () => {
    expect(exceptionsShownNote(20, 45)).toBe("Showing the 20 most urgent of 45");
    expect(exceptionsShownNote(20, 20)).toBeNull();
    expect(exceptionsShownNote(3, 3)).toBeNull();
  });

  it("uses OVERDUE_AFTER_DAYS rather than a fixed 7", () => {
    expect(exceptionCopy("overdue_job", exception({ days: 8 })).text).toContain(
      `${OVERDUE_AFTER_DAYS}-day limit`,
    );
  });

  it("renders a kind from a later phase without throwing", () => {
    const copy = exceptionCopy(
      "purchase_overdue",
      exception({ severity: "danger", entityLabel: "PO-000004", subjectLabel: "Supplier order" }),
    );
    expect(copy).toEqual({ text: "Check PO-000004 · Supplier order", tone: "danger" });
    expect(exceptionLabel("purchase_overdue")).toBe("Needs attention");
    expect(
      exceptionCopy("mystery", exception({ entityLabel: null, subjectLabel: null })).text,
    ).toBe("Something needs checking");
  });

  it("links each exception to its record", () => {
    const id = "9a000000-0000-4000-8000-000000000003";
    expect(exceptionHref(exception({ entityId: id }))).toBe(`/jobs/${id}`);
    expect(exceptionHref(exception({ entityType: "product", entityId: id }))).toBe(
      `/products/${id}`,
    );
    expect(exceptionHref(exception({ entityType: "inventory_unit", entityId: id }))).toBe(
      `/units/${id}`,
    );
    // A line is named by its job's number; /q opens the job.
    expect(
      exceptionHref(exception({ entityType: "work_order_line", entityLabel: "J-000017" })),
    ).toBe("/q/J-000017");
    expect(
      exceptionHref(exception({ entityType: "work_order_line", entityLabel: null })),
    ).toBeNull();
    expect(exceptionHref(exception({ entityType: "consignor" }))).toBeNull();
  });

  it("says a Shopify failure needs fixing in the queue, and opens that job there (Phase 10, D86)", () => {
    const row = exception({
      kind: "integration_failed",
      severity: "danger",
      entityType: "integration_job",
      entityId: "e3000000-0000-4000-8000-000000000001",
      entityLabel: "#1002",
      subjectLabel: 'Order #1002: "BICII cotton cap" (Shopify variant 9199999999) is not linked',
    });
    expect(exceptionLabel("integration_failed")).toBe("Shopify needs attention");
    expect(exceptionCopy("integration_failed", row)).toEqual({
      text: "Fix it in the Shopify queue",
      tone: "danger",
    });
    // Even if a later view sent it as a warning, a stuck integration is danger.
    expect(exceptionCopy("integration_failed", { ...row, severity: "warning" }).tone).toBe(
      "danger",
    );
    expect(exceptionHref(row)).toBe("/shopify/queue?job=e3000000-0000-4000-8000-000000000001");
  });

  it("has a pill label for every kind the database emits", () => {
    for (const kind of [
      "overdue_job",
      "uncollected_job",
      "negative_stock",
      "unit_hold_stale",
      "currency_mismatch",
      "integration_failed",
    ]) {
      expect(exceptionLabel(kind), kind).not.toBe("Needs attention");
    }
  });
});

const summary = (day: string, patch: Partial<DailySummary> = {}): DailySummary => ({
  day,
  jobsCheckedIn: 0,
  jobsStarted: 0,
  jobsCompleted: 0,
  jobsReadyForCollection: 0,
  jobsCollected: 0,
  jobsCancelled: 0,
  currency: "SGD",
  linesRecognised: 0,
  grossSales: "0.00",
  cogs: "0.00",
  yield: "0.00",
  cultCommons: "0.00",
  biciiAfterCc: "0.00",
  lossLines: 0,
  lossTotal: "0.00",
  partsConsumedQty: 0,
  stockAdjustments: 0,
  significantAdjustments: 0,
  ...patch,
});

describe("weekStrip", () => {
  it("is exactly the 7 days ending at the day shown, oldest first, quiet days kept", () => {
    const rows = [
      summary("2026-10-05", { jobsCompleted: 1 }),
      summary("2026-09-29"),
      summary("2026-10-02", { grossSales: "1000.00" }),
    ];
    const strip = weekStrip(rows, "2026-10-05");
    expect(strip.map((d) => d.day)).toEqual([
      "2026-09-29",
      "2026-09-30",
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
      "2026-10-04",
      "2026-10-05",
    ]);
    expect(strip[0].summary?.jobsCompleted).toBe(0);
    expect(strip[3].summary?.grossSales).toBe("1000.00");
    expect(strip[6].summary?.jobsCompleted).toBe(1);
    expect(strip[1].summary).toBeNull();
  });

  it("crosses a year end", () => {
    expect(weekStrip([], "2027-01-02").map((d) => d.day)[0]).toBe("2026-12-27");
  });
});

describe("TILE_LINKS", () => {
  it("names only board groups that exist", () => {
    const ids = new Set(BOARD_GROUPS.map((g) => g.id));
    for (const f of Object.values(TILE_BOARD_FILTERS)) {
      if (f.group) expect(ids.has(f.group)).toBe(true);
    }
  });

  it("opens the board filtered to the tile's jobs, and parses back", () => {
    const parse = (href: string) => {
      const url = new URL(href, "http://x");
      expect(url.pathname).toBe("/jobs");
      const params: Record<string, string | string[]> = {};
      for (const key of new Set(url.searchParams.keys())) {
        const all = url.searchParams.getAll(key);
        params[key] = all.length > 1 ? all : all[0];
      }
      return parseBoardFilters(params);
    };
    expect(TILE_LINKS.received).toBe("/jobs?group=received");
    expect(parse(TILE_LINKS.received).group).toBe("received");
    expect(parse(TILE_LINKS.waiting).group).toBe("waiting");
    expect(parse(TILE_LINKS.ready_to_start).group).toBe("ready");
    expect(parse(TILE_LINKS.in_progress).group).toBe("in_progress");
    expect(parse(TILE_LINKS.awaiting_collection).statuses).toEqual([
      "completed",
      "ready_for_collection",
    ]);
    expect(parse(TILE_LINKS.awaiting_collection).group).toBeNull();
    expect(parse(TILE_LINKS.overdue).age).toBe("overdue");
  });

  it("gives every flow a distinct activity anchor", () => {
    expect(new Set(ACTIVITY_FLOWS.map((f) => f.anchor)).size).toBe(ACTIVITY_FLOWS.length);
  });
});

describe("financial entries", () => {
  const entry = (key: string, doc: string, number: string): FinancialEntry => ({
    entryKey: key,
    source: "work_order",
    documentId: doc,
    documentNumber: number,
    channel: "workshop",
    recognizedAt: "2026-10-05T03:00:00Z",
    lineType: "service",
    description: "Basic Service",
    quantity: "1.00",
    unitSalePrice: "80.00",
    saleTotal: "80.00",
    costTotal: null,
    yield: null,
    cultCommons: null,
    ccRate: null,
    isLoss: null,
    costPending: false,
    currency: "SGD",
    entryKind: "line",
    stripeFee: null,
    stripeFeePending: false,
    shopifyFee: "0.00",
    shopifyFeePending: false,
  });

  it("groups by job in arrival order and links workshop jobs", () => {
    const groups = groupEntries([
      entry("a", "j1", "J-000020"),
      entry("b", "j2", "J-000021"),
      entry("c", "j1", "J-000020"),
    ]);
    expect(groups.map((g) => [g.documentNumber, g.entries.map((e) => e.entryKey)])).toEqual([
      ["J-000020", ["a", "c"]],
      ["J-000021", ["b"]],
    ]);
    expect(documentHref(groups[0])).toBe("/jobs/j1");
    expect(documentHref({ source: "sale", documentId: "s1" })).toBe("/sales/s1");
    expect(documentHref({ source: "other", documentId: "x1" })).toBeNull();
  });
});
