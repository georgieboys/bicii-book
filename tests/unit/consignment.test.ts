import { describe, expect, it } from "vitest";

import {
  canOverrideDeposit,
  canRecordRefund,
  canViewConsignmentMoney,
  canViewSaleCosts,
  type PermissionKey,
  type StaffRole,
} from "@/lib/auth/permissions";
import {
  CHARGE_BEARER_EXPLANATIONS,
  allocationProblems,
  autoAllocate,
  chargeBearerLabel,
  consignmentStatusPill,
  describeConsignmentEvent,
  outstandingLabel,
  outstandingTone,
  paidAtFromDate,
  readItemStatusFilter,
  remainingLabel,
} from "@/lib/consignment";

const who = (role: StaffRole, permissions: PermissionKey[] = [], active = true) => ({
  role,
  active,
  permissions,
});

describe("Phase 6 access helpers (mirror D48 SALES-ACCESS, D30, D49)", () => {
  it("an active admin sees consignment money and sale costs, and may refund", () => {
    const admin = who("admin");
    expect(canViewConsignmentMoney(admin)).toBe(true);
    expect(canViewSaleCosts(admin)).toBe(true);
    expect(canRecordRefund(admin)).toBe(true);
  });

  it("inactive staff see neither, an inactive admin included", () => {
    for (const s of [who("admin", [], false), who("mechanic", ["view_costs"], false)]) {
      expect(canViewConsignmentMoney(s)).toBe(false);
      expect(canViewSaleCosts(s)).toBe(false);
      expect(canRecordRefund(s)).toBe(false);
    }
  });

  it("manage_consignments alone sees consignment money, not sale costs", () => {
    const s = who("mechanic", ["manage_consignments"]);
    expect(canViewConsignmentMoney(s)).toBe(true);
    expect(canViewSaleCosts(s)).toBe(false);
    expect(canRecordRefund(s)).toBe(false);
  });

  it("view_costs alone sees both", () => {
    const s = who("mechanic", ["view_costs"]);
    expect(canViewConsignmentMoney(s)).toBe(true);
    expect(canViewSaleCosts(s)).toBe(true);
    expect(canRecordRefund(s)).toBe(false);
  });

  it("an active manager sees both and may refund (D94); an inactive one neither", () => {
    const manager = who("manager");
    expect(canViewConsignmentMoney(manager)).toBe(true);
    expect(canViewSaleCosts(manager)).toBe(true);
    expect(canRecordRefund(manager)).toBe(true);
    expect(canRecordRefund(who("manager", [], false))).toBe(false);
  });

  it("a mechanic holding every permission as exceptions still cannot refund (D94)", () => {
    expect(
      canRecordRefund(
        who("mechanic", [
          "view_costs",
          "manage_inventory",
          "adjust_stock",
          "manage_consignments",
          "manage_purchasing",
          "manage_staff",
          "view_financial_reports",
        ]),
      ),
    ).toBe(false);
  });

  it("view_financial_reports alone reveals neither and never authorises a refund", () => {
    const s = who("mechanic", ["view_financial_reports"]);
    expect(canViewConsignmentMoney(s)).toBe(false);
    expect(canViewSaleCosts(s)).toBe(false);
    expect(canRecordRefund(s)).toBe(false);
  });

  it("every other single permission reveals neither", () => {
    for (const p of [
      "manage_inventory",
      "adjust_stock",
      "manage_purchasing",
      "manage_staff",
    ] as const) {
      const s = who("mechanic", [p]);
      expect(canViewConsignmentMoney(s), p).toBe(false);
      expect(canViewSaleCosts(s), p).toBe(false);
      expect(canRecordRefund(s), p).toBe(false);
    }
    expect(canViewConsignmentMoney(who("mechanic"))).toBe(false);
  });
});

describe("consignment status pills", () => {
  it("names each status with its tone", () => {
    expect(consignmentStatusPill("active", null)).toEqual({ label: "For sale", tone: "info" });
    expect(consignmentStatusPill("returned", "0.00")).toEqual({
      label: "Returned",
      tone: "neutral",
    });
    expect(consignmentStatusPill("withdrawn", null).tone).toBe("neutral");
  });

  it("says whether a sold item is paid only when the outstanding is visible (D48)", () => {
    expect(consignmentStatusPill("sold", "500.00")).toEqual({
      label: "Sold, awaiting payment",
      tone: "waiting",
    });
    expect(consignmentStatusPill("sold", "0.00")).toEqual({ label: "Settled", tone: "done" });
    expect(consignmentStatusPill("sold", "-40.00")).toEqual({ label: "Overpaid", tone: "info" });
    expect(consignmentStatusPill("sold", null)).toEqual({ label: "Sold", tone: "done" });
  });

  it("reads the items filter, defaulting to For sale", () => {
    expect(readItemStatusFilter("sold")).toBe("sold");
    expect(readItemStatusFilter("all")).toBe("all");
    expect(readItemStatusFilter("withdrawn")).toBe("active");
    expect(readItemStatusFilter(undefined)).toBe("active");
  });
});

describe("balances (D46: never credit)", () => {
  it("labels owed, settled and overpaid", () => {
    expect(outstandingLabel("300")).toBe("$300.00 owed");
    expect(outstandingLabel("0.00")).toBe("Settled");
    expect(outstandingLabel("-40.5")).toBe("Overpaid $40.50 (consignor owes the shop)");
    for (const v of ["300", "0", "-40"]) expect(outstandingLabel(v)).not.toMatch(/credit/i);
  });

  it('says "Nothing owed yet", not "Settled", when nothing was ever owed or paid', () => {
    expect(outstandingLabel("0", "SGD", { owed: "0.00", paid: "0.00" })).toBe("Nothing owed yet");
    expect(outstandingLabel("0", "SGD", { owed: null, paid: null })).toBe("Nothing owed yet");
    expect(outstandingTone("0", { owed: "0", paid: "0" })).toBe("neutral");
    // Paid what was owed: a finished cycle.
    expect(outstandingLabel("0.00", "SGD", { owed: "500.00", paid: "500.00" })).toBe("Settled");
    expect(outstandingTone("0", { owed: "500", paid: "500" })).toBe("done");
    // Owed is never shown as nothing when money is outstanding.
    expect(outstandingLabel("35", "SGD", { owed: "35", paid: "0" })).toBe("$35.00 owed");
  });

  it("tones each balance", () => {
    expect(outstandingTone("0.01")).toBe("waiting");
    expect(outstandingTone("0")).toBe("done");
    expect(outstandingTone("-0.01")).toBe("info");
  });

  it("counts what is left of a quantity consignment", () => {
    expect(remainingLabel(3, 6)).toBe("3 of 6 left");
    expect(remainingLabel(0, 1)).toBe("0 of 1 left");
  });
});

describe("charge bearers (D4: explicit, no default)", () => {
  it("labels and explains both bearers", () => {
    expect(chargeBearerLabel("consignor")).toBe("Consignor pays");
    expect(chargeBearerLabel("shop")).toBe("Shop pays");
    expect(CHARGE_BEARER_EXPLANATIONS.consignor).toBe(
      "Consignor pays: deducted from what we owe them",
    );
    expect(CHARGE_BEARER_EXPLANATIONS.shop).toBe(
      "Shop pays: added to the cost of the sale, so it lowers yield",
    );
  });
});

describe("item history labels", () => {
  it("describes intake, terms and charges", () => {
    expect(
      describeConsignmentEvent("received", {
        quantity: 1,
        agreed_amount_owed: 500,
        asking_price: 1000,
      }),
    ).toEqual({ title: "Received", detail: "owed $500.00 · asking $1,000.00" });
    // A single item is owed its amount, not "each" (as on the item page).
    expect(describeConsignmentEvent("received", { agreed_amount_owed: 500 })).toEqual({
      title: "Received",
      detail: "owed $500.00",
    });
    expect(describeConsignmentEvent("received", { quantity: 3, agreed_amount_owed: 35 })).toEqual({
      title: "Received",
      detail: "3 items · owed $35.00 each",
    });
    expect(
      describeConsignmentEvent("terms_changed", {
        agreed_amount_owed: { from: 500, to: 450 },
      }),
    ).toEqual({ title: "Terms changed", detail: "Owed $500.00 → $450.00" });
    expect(
      describeConsignmentEvent("charge_added", {
        description: "Service",
        amount: 120,
        bearer: "shop",
      }),
    ).toEqual({ title: "Charge added", detail: "Service · $120.00 · Shop pays" });
    expect(
      describeConsignmentEvent("charge_voided", { amount: 45, bearer: "consignor" }).title,
    ).toBe("Charge voided");
  });

  it("describes status changes with the job or sale that caused them", () => {
    expect(
      describeConsignmentEvent("status_changed", {
        from: "active",
        to: "sold",
        job_number: "J-000123",
        cause: "job_completed",
      }).title,
    ).toBe("Sold on J-000123");
    expect(describeConsignmentEvent("status_changed", { from: "active", to: "sold" }).title).toBe(
      "Sold",
    );
    expect(
      describeConsignmentEvent("status_changed", {
        from: "sold",
        to: "active",
        cause: "job_reopened",
        job_number: "J-000123",
      }).title,
    ).toBe("Job J-000123 reopened");
    expect(
      describeConsignmentEvent("status_changed", { from: "sold", to: "active", cause: "restock" })
        .title,
    ).toBe("Restocked");
    expect(
      describeConsignmentEvent("status_changed", { from: "active", to: "returned" }).title,
    ).toBe("Returned to consignor");
    expect(describeConsignmentEvent("stock_returned", { quantity: 1 }).title).toBe(
      "1 returned to consignor",
    );
    expect(describeConsignmentEvent("stock_returned", { quantity: 2 }).title).toBe(
      "2 returned to consignor",
    );
  });
});

describe("autoAllocate (D47)", () => {
  const items = [
    { id: "newer", outstanding: "300.00", lastSaleAt: "2026-10-04T05:00:00Z" },
    { id: "older", outstanding: "100.00", lastSaleAt: "2026-10-01T05:00:00Z" },
    { id: "settled", outstanding: "0.00", lastSaleAt: "2026-09-01T05:00:00Z" },
    { id: "overpaid", outstanding: "-20.00", lastSaleAt: "2026-09-02T05:00:00Z" },
  ];

  it("allocates nothing for zero or a non-amount", () => {
    expect(autoAllocate("0", items)).toEqual({ allocations: [], unallocated: "0.00" });
    expect(autoAllocate("abc", items)).toEqual({ allocations: [], unallocated: "0.00" });
  });

  it("pays the oldest sale first and never above an item's outstanding (partial)", () => {
    expect(autoAllocate("150", items)).toEqual({
      allocations: [
        { id: "older", amount: "100.00" },
        { id: "newer", amount: "50.00" },
      ],
      unallocated: "0.00",
    });
  });

  it("allocates exactly what is owed", () => {
    expect(autoAllocate("400.00", items)).toEqual({
      allocations: [
        { id: "older", amount: "100.00" },
        { id: "newer", amount: "300.00" },
      ],
      unallocated: "0.00",
    });
  });

  it("leaves an overpayment unallocated and skips items with nothing outstanding", () => {
    const result = autoAllocate("450", items);
    expect(result.unallocated).toBe("50.00");
    expect(result.allocations.map((a) => a.id)).toEqual(["older", "newer"]);
  });

  it("keeps the given order for a tie on the sale date, and puts unsold items last", () => {
    const tied = [
      { id: "a", outstanding: "10", lastSaleAt: "2026-10-01T00:00:00Z" },
      { id: "none", outstanding: "10", lastSaleAt: null },
      { id: "b", outstanding: "10", lastSaleAt: "2026-10-01T00:00:00Z" },
    ];
    expect(autoAllocate("25", tied).allocations).toEqual([
      { id: "a", amount: "10.00" },
      { id: "b", amount: "10.00" },
      { id: "none", amount: "5.00" },
    ]);
  });
});

describe("allocationProblems (D47)", () => {
  const items = [
    { id: "x", outstanding: "300.00" },
    { id: "y", outstanding: "-20.00" },
  ];

  it("is clear when the lines add up and stay within what is owed", () => {
    const p = allocationProblems("200", [{ id: "x", amount: "200" }], items);
    expect(p).toEqual({
      mismatch: null,
      invalid: [],
      overrides: [],
      missingReasons: [],
      blocking: false,
    });
  });

  it("names an unallocated remainder or an excess", () => {
    expect(allocationProblems("200", [{ id: "x", amount: "150" }], items).mismatch).toBe(
      "Unallocated $50.00",
    );
    expect(allocationProblems("200", [{ id: "x", amount: "250" }], items).mismatch).toBe(
      "Over by $50.00",
    );
    expect(allocationProblems("200", [{ id: "x", amount: "150" }], items).blocking).toBe(true);
  });

  it("needs a reason above the outstanding, and accepts it with one", () => {
    const without = allocationProblems("350", [{ id: "x", amount: "350" }], items);
    expect(without.overrides).toEqual(["x"]);
    expect(without.missingReasons).toEqual(["x"]);
    expect(without.blocking).toBe(true);
    const withReason = allocationProblems(
      "350",
      [{ id: "x", amount: "350", overrideReason: "Agreed bonus" }],
      items,
    );
    expect(withReason.overrides).toEqual(["x"]);
    expect(withReason.missingReasons).toEqual([]);
    expect(withReason.blocking).toBe(false);
  });

  it("treats a negative outstanding as zero: any payment to it is an override", () => {
    const p = allocationProblems("10", [{ id: "y", amount: "10", overrideReason: " " }], items);
    expect(p.overrides).toEqual(["y"]);
    expect(p.missingReasons).toEqual(["y"]);
  });

  it("refuses a zero or missing amount and empty lines", () => {
    expect(allocationProblems("0", [{ id: "x", amount: "0" }], items).invalid).toEqual(["x"]);
    expect(allocationProblems("0", [{ id: "x", amount: "0" }], items).blocking).toBe(true);
    expect(allocationProblems("100", [], items).blocking).toBe(true);
    expect(allocationProblems("", [{ id: "x", amount: "1.234" }], items).invalid).toEqual(["x"]);
  });
});

describe("paidAtFromDate", () => {
  it("sends null for today, so the database stamps the time", () => {
    expect(paidAtFromDate("2026-10-05", "2026-10-05")).toBeNull();
  });

  it("sends noon Singapore time on an earlier day", () => {
    expect(paidAtFromDate("2026-10-04", "2026-10-05")).toBe("2026-10-04T04:00:00.000Z");
  });

  it("keeps the shop day around Singapore midnight", () => {
    // 2026-10-04 23:59 in Singapore is 15:59 UTC; the picked day stays the 3rd.
    expect(paidAtFromDate("2026-10-03", "2026-10-04")).toBe("2026-10-03T04:00:00.000Z");
    // Just after midnight, the 1st of the month: the 30th of September.
    expect(paidAtFromDate("2026-09-30", "2026-10-01")).toBe("2026-09-30T04:00:00.000Z");
  });

  it("rejects a day that is not a date", () => {
    expect(() => paidAtFromDate("not-a-day", "2026-10-05")).toThrow(RangeError);
  });
});

describe("ordering an indent part before its deposit is paid (D152, Phase 14)", () => {
  it("is an active admin or manager, by role (private.can_record_refunds)", () => {
    expect(canOverrideDeposit(who("admin"))).toBe(true);
    expect(canOverrideDeposit(who("manager"))).toBe(true);
  });

  it("is never a mechanic, even with Manage purchasing, nor inactive staff", () => {
    expect(canOverrideDeposit(who("mechanic"))).toBe(false);
    expect(canOverrideDeposit(who("mechanic", ["manage_purchasing", "view_costs"]))).toBe(false);
    expect(canOverrideDeposit(who("admin", [], false))).toBe(false);
    expect(canOverrideDeposit(who("manager", [], false))).toBe(false);
  });
});
