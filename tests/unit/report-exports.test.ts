import { describe, expect, it } from "vitest";

import { effectivePermissions, type PermissionKey } from "@/lib/auth/permissions";
import { toCsv } from "@/lib/csv";
import type { HeldJob, PaymentItem } from "@/lib/payment-reports";
import type { PeriodSummary } from "@/lib/period-reports";
import {
  BASIS_FREE_KINDS,
  EXPORT_KINDS,
  EXPORT_KIND_VALUES,
  SNAPSHOT_KINDS,
  breakdownTotalRow,
  exportColumns,
  exportFilename,
  exportHref,
  exportKindSchema,
  mayExport,
  type ExportKind,
} from "@/lib/report-exports";

const headers = (kind: ExportKind, costs: boolean) =>
  exportColumns(kind, costs).map((c) => c.header);

const canAs = (role: "admin" | "manager" | "mechanic", granted: PermissionKey[] = []) => {
  const held = effectivePermissions(role, true, granted);
  return (p: PermissionKey) => held.includes(p);
};

describe("the export kind table", () => {
  it("lists every kind once and parses only those", () => {
    expect([...EXPORT_KIND_VALUES].sort()).toEqual(Object.keys(EXPORT_KINDS).sort());
    expect(exportKindSchema.safeParse("breakdown").success).toBe(true);
    expect(exportKindSchema.safeParse("exceptions").success).toBe(true);
    expect(exportKindSchema.safeParse("everything").success).toBe(false);
    expect(exportKindSchema.safeParse(null).success).toBe(false);
  });

  it("needs view_financial_reports for every financial kind; mechanics is for any staff", () => {
    for (const kind of ["series", "breakdown", "lines", "stock_value"] as const) {
      expect(EXPORT_KINDS[kind].permission).toBe("view_financial_reports");
      expect(mayExport(kind, canAs("mechanic"))).toBe(false);
      expect(mayExport(kind, canAs("mechanic", ["view_financial_reports"]))).toBe(true);
      expect(mayExport(kind, canAs("manager"))).toBe(true);
      expect(mayExport(kind, canAs("admin"))).toBe(true);
    }
    expect(EXPORT_KINDS.mechanics.permission).toBeNull();
    expect(mayExport("mechanics", canAs("mechanic"))).toBe(true);
    // D60: manage_purchasing alone never opens a financial export.
    expect(mayExport("breakdown", canAs("mechanic", ["manage_purchasing"]))).toBe(false);
  });

  it("drops the cost-gated columns without view_costs (D30)", () => {
    expect(headers("breakdown", true)).toEqual([
      "dimension",
      "key",
      "name",
      "detail",
      "lines",
      "jobs",
      "sales",
      "quantity",
      "gross",
      "cost",
      "yield",
      "cult_commons",
      "after_cc",
      "currency",
    ]);
    expect(headers("breakdown", false)).toEqual([
      "dimension",
      "key",
      "name",
      "detail",
      "lines",
      "jobs",
      "sales",
      "quantity",
      "gross",
      "currency",
    ]);
    expect(headers("series", false)).not.toEqual(
      expect.arrayContaining(["cost", "yield", "new_consignor_liability", "settlements_paid"]),
    );
    expect(headers("series", false)).toEqual(
      expect.arrayContaining(["gross", "refunds", "consignment_sales_total"]),
    );
    expect(headers("series", true)).toEqual(
      expect.arrayContaining(["cost", "yield", "cult_commons", "after_cc", "settlements_paid"]),
    );
    expect(headers("lines", false)).toEqual([
      "date",
      "channel",
      "document_number",
      "type",
      "description",
      "quantity",
      "unit_price",
      "gross",
      "cost_pending",
      "ownership",
      "category",
      "mechanic",
      "currency",
    ]);
    expect(headers("stock_value", false)).not.toContain("value_at_cost");
    expect(headers("stock_value", true)).toContain("value_at_cost");
    expect(headers("mechanics", false)).toEqual(headers("mechanics", true));
  });

  it("writes the breakdown's TOTAL row from the summary as received", () => {
    const summary: PeriodSummary = {
      basis: "sale",
      from: "2026-10-01",
      to: "2026-10-07",
      currency: "SGD",
      lineCount: 9,
      jobCount: 4,
      saleCount: 1,
      saleTotal: "2359.99",
      costTotal: null,
      yieldTotal: null,
      cultCommons: null,
      afterCc: null,
      lossLineCount: null,
      costPendingLines: 0,
      refundsTotal: "0.00",
      refundCount: 0,
      consignmentSales: 0,
      consignmentSalesTotal: "0.00",
      newConsignorLiability: null,
      settlementsPaid: null,
      purchasesReceived: null,
      excludedForeignLineCount: 0,
    };
    const csv = toCsv(exportColumns("breakdown", false), [breakdownTotalRow(summary)]);
    expect(csv.split("\r\n")[1]).toBe("TOTAL,,TOTAL,,9,4,1,,2359.99,SGD");
  });

  it("names the file and builds the link", () => {
    expect(
      exportFilename("breakdown", { basis: "sale", from: "2026-10-05", to: "2026-10-11" }),
    ).toBe("bicii-breakdown-sale-2026-10-05_2026-10-11.csv");
    expect(exportHref("lines", { period: "day", date: "2026-10-03" }, { key: "none" })).toBe(
      "/reports/export?kind=lines&period=day&date=2026-10-03&key=none",
    );
  });
});

describe("the snapshot exports (Phase 9 step 4; D106–D108)", () => {
  it("lets any active staff member export exceptions, stock and units", () => {
    for (const kind of ["exceptions", "stock", "units"] as const) {
      expect(EXPORT_KINDS[kind].permission, kind).toBeNull();
      expect(mayExport(kind, canAs("mechanic")), kind).toBe(true);
      expect(mayExport(kind, canAs("manager")), kind).toBe(true);
      // No cost column, so nothing differs without view_costs.
      expect(headers(kind, false), kind).toEqual(headers(kind, true));
    }
    expect(SNAPSHOT_KINDS).toEqual(new Set(["exceptions", "stock", "units", "payments_held"]));
  });

  it("writes the brief's exception columns", () => {
    expect(headers("exceptions", false)).toEqual([
      "kind",
      "severity",
      "issue",
      "short_id",
      "title",
      "detail",
      "amount",
      "currency",
      "since",
    ]);
    expect(headers("stock", false)).toEqual([
      "product_short_id",
      "product",
      "tracking",
      "location",
      "ledger_on_hand",
      "units_in_stock",
      "issue",
    ]);
    expect(headers("units", false)).toContain("disposition_ref");
  });

  it("writes an exception row as received, a formula-like title as text and no amount as empty", () => {
    const csv = toCsv(exportColumns("exceptions", false), [
      {
        kind: "unsettled_consignment",
        severity: "warning",
        entityType: "consignment_item",
        entityId: "c4000000-0000-4000-8000-000000000001",
        entityLabel: "C-000007",
        subjectLabel: "=cmd · Brompton",
        days: 45,
        quantity: null,
        since: "2026-08-22T04:00:00Z",
        issue: "unsettled_consignment",
        shortId: "C-000007",
        title: "C-000007 · =cmd",
        detail: "=HYPERLINK()",
        amount: "300.00",
        currency: "SGD",
      },
      {
        kind: "overdue_job",
        severity: "warning",
        entityType: "work_order",
        entityId: "d5000000-0000-4000-8000-000000000007",
        entityLabel: "J-000017",
        subjectLabel: null,
        days: 11,
        quantity: null,
        since: null,
        issue: "overdue_job",
        shortId: "J-000017",
        title: "J-000017",
        detail: null,
        amount: null,
        currency: null,
      },
    ]);
    const lines = csv.split("\r\n");
    expect(lines[1]).toBe(
      "unsettled_consignment,warning,unsettled_consignment,C-000007,C-000007 · =cmd,'=HYPERLINK(),300.00,SGD,2026-08-22 12:00",
    );
    expect(lines[2]).toBe("overdue_job,warning,overdue_job,J-000017,J-000017,,,,");
  });

  it("names a snapshot by the day it was taken", () => {
    const params = { basis: "sale", from: "2026-10-05", to: "2026-10-11" } as const;
    expect(exportFilename("units", params, "2026-10-06")).toBe("bicii-units-2026-10-06.csv");
    expect(exportFilename("breakdown", params, "2026-10-06")).toBe(
      "bicii-breakdown-sale-2026-10-05_2026-10-11.csv",
    );
    expect(exportHref("stock", { all: "1" })).toBe("/reports/export?kind=stock&all=1");
  });
});

describe("the Customer payments exports (Phase 14 step 3; D154)", () => {
  const JOB = "66666666-7777-4888-9999-000000000001";
  const PAY = "11111111-2222-4333-8444-000000000001";
  const COUNTER = "22222222-3333-4444-8555-000000000001";

  it("adds payments (a period) and payments_held (a snapshot of now)", () => {
    expect(EXPORT_KIND_VALUES).toEqual(expect.arrayContaining(["payments", "payments_held"]));
    expect(exportKindSchema.safeParse("payments").success).toBe(true);
    expect(exportKindSchema.safeParse("payments_held").success).toBe(true);
    expect(SNAPSHOT_KINDS.has("payments_held")).toBe(true);
    expect(SNAPSHOT_KINDS.has("payments")).toBe(false);
    expect(BASIS_FREE_KINDS).toEqual(new Set(["payments"]));
  });

  it("needs View financial reports for both (D154d), whatever else the caller holds", () => {
    for (const kind of ["payments", "payments_held"] as const) {
      expect(EXPORT_KINDS[kind].permission, kind).toBe("view_financial_reports");
      expect(mayExport(kind, canAs("mechanic")), kind).toBe(false);
      expect(mayExport(kind, canAs("mechanic", ["view_costs"])), kind).toBe(false);
      expect(mayExport(kind, canAs("mechanic", ["manage_purchasing"])), kind).toBe(false);
      expect(mayExport(kind, canAs("mechanic", ["view_financial_reports"])), kind).toBe(true);
      expect(mayExport(kind, canAs("manager")), kind).toBe(true);
      expect(mayExport(kind, canAs("admin")), kind).toBe(true);
    }
  });

  it("writes the same columns with or without View costs: nothing is cost-derived", () => {
    expect(headers("payments", true)).toEqual([
      "date",
      "movement",
      "job_number",
      "customer",
      "kind",
      "method",
      "amount",
      "currency",
      "other_currency",
      "recorded_at",
      "recorded_by",
    ]);
    expect(headers("payments", false)).toEqual(headers("payments", true));
    expect(headers("payments_held", true)).toEqual([
      "group",
      "job_number",
      "status",
      "customer",
      "amount",
      "net_paid",
      "net_paid_online",
      "paid_at_counter",
      "job_total",
      "balance_due",
      "paid_ahead",
      "currency",
    ]);
    expect(headers("payments_held", false)).toEqual(headers("payments_held", true));
    for (const kind of ["payments", "payments_held"] as const) {
      expect(
        EXPORT_KINDS[kind].columns.some((c) => c.costs),
        kind,
      ).toBe(false);
    }
  });

  it("writes a movement signed, the counter recorder only on counter rows, a formula-like name as text", () => {
    const base: PaymentItem = {
      at: "2026-10-16T02:00:00+00:00",
      id: PAY,
      movement: "online_payment",
      workOrderId: JOB,
      jobNumber: "J-000007",
      jobHref: `/jobs/${JOB}`,
      customerLabel: "=Ana Lim",
      kind: "deposit",
      method: "stripe",
      amount: "300.00",
      signedAmount: "300.00",
      currency: "SGD",
      otherCurrency: false,
      recordedAt: null,
      recordedByName: null,
    };
    const csv = toCsv(exportColumns("payments", false), [
      base,
      {
        ...base,
        id: COUNTER,
        movement: "counter_given_back",
        kind: "balance",
        method: "cash",
        customerLabel: "Ana Lim",
        amount: "45.00",
        signedAmount: "-45.00",
        recordedAt: "2026-10-16T09:30:00+00:00",
        recordedByName: "Sam Tan",
      },
    ]);
    const lines = csv.split("\r\n");
    expect(lines[1]).toBe(
      "2026-10-16 10:00,online_payment,J-000007,'=Ana Lim,deposit,stripe,300.00,SGD,false,,",
    );
    expect(lines[2]).toBe(
      "2026-10-16 10:00,counter_given_back,J-000007,Ana Lim,balance,cash,-45.00,SGD,false,2026-10-16 17:30,Sam Tan",
    );
  });

  it("writes a held job, empty where a collected job has no balance", () => {
    const row: HeldJob = {
      group: "above_bill",
      workOrderId: JOB,
      jobNumber: "J-000007",
      jobHref: `/jobs/${JOB}`,
      status: "collected",
      customerLabel: "Ana Lim",
      amount: "20.00",
      netPaid: "165.00",
      netPaidOnline: "120.00",
      paidAtCounter: "45.00",
      jobTotal: "145.00",
      balanceDue: null,
      paidAhead: null,
      currency: "SGD",
    };
    const csv = toCsv(exportColumns("payments_held", false), [row]);
    expect(csv.split("\r\n")[1]).toBe(
      "above_bill,J-000007,collected,Ana Lim,20.00,165.00,120.00,45.00,145.00,,,SGD",
    );
  });

  it("names payments by the range only and payments_held by the day it was taken", () => {
    const params = { basis: "check_in", from: "2026-10-05", to: "2026-10-11" } as const;
    expect(exportFilename("payments", params, "2026-10-17")).toBe(
      "bicii-payments-2026-10-05_2026-10-11.csv",
    );
    expect(exportFilename("payments_held", params, "2026-10-17")).toBe(
      "bicii-payments_held-2026-10-17.csv",
    );
    // The other period kinds keep their basis in the name.
    expect(exportFilename("mechanics", params, "2026-10-17")).toBe(
      "bicii-mechanics-check_in-2026-10-05_2026-10-11.csv",
    );
    expect(exportHref("payments", { period: "week", date: "2026-10-07" })).toBe(
      "/reports/export?kind=payments&period=week&date=2026-10-07",
    );
    expect(exportHref("payments_held", {})).toBe("/reports/export?kind=payments_held");
  });
});
