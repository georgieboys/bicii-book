import { describe, expect, it } from "vitest";

import type { StaffDTO } from "@/lib/auth/permissions";
import {
  PURCHASE_ORDER_STATUSES,
  canManagePurchasing,
  canSeeProductPageSupplierCosts,
  canSeePurchaseCosts,
  costSourceHint,
  describePurchaseOrderEvent,
  eventShowsReason,
  isEditableStatus,
  isOpenStatus,
  isOverdue,
  isPurchaseOrderFilter,
  jobList,
  leadTimeText,
  normaliseWebsite,
  progressText,
  purchaseOrderStatusLabel,
  purchaseOrderStatusTone,
  waitingJobParts,
  type LinePartRequest,
} from "@/lib/purchasing";

const staff = (role: StaffDTO["role"], permissions: StaffDTO["permissions"], active = true) => ({
  role,
  active,
  permissions,
});

describe("purchase order statuses", () => {
  it("labels every status and gives each a tone (always shown with its text)", () => {
    expect(PURCHASE_ORDER_STATUSES.map(purchaseOrderStatusLabel)).toEqual([
      "Draft",
      "Submitted",
      "Partially received",
      "Received",
      "Cancelled",
    ]);
    expect(PURCHASE_ORDER_STATUSES.map(purchaseOrderStatusTone)).toEqual([
      "info",
      "waiting",
      "progress",
      "done",
      "danger",
    ]);
  });

  it("keeps received and cancelled orders closed (D61 D-PO-CANCEL, D65 D-OVERRECEIPT)", () => {
    expect(PURCHASE_ORDER_STATUSES.filter(isEditableStatus)).toEqual([
      "draft",
      "submitted",
      "partially_received",
    ]);
    expect(PURCHASE_ORDER_STATUSES.filter(isOpenStatus)).toEqual([
      "submitted",
      "partially_received",
    ]);
  });

  it("knows the list filters", () => {
    expect(["open", "draft", "closed", "all"].every(isPurchaseOrderFilter)).toBe(true);
    expect(isPurchaseOrderFilter("toString")).toBe(false);
    expect(isPurchaseOrderFilter("received")).toBe(false);
  });
});

describe("leadTimeText", () => {
  it("is singular for one day only", () => {
    expect(leadTimeText(0)).toBe("0 days lead time");
    expect(leadTimeText(1)).toBe("1 day lead time");
    expect(leadTimeText(14)).toBe("14 days lead time");
  });
});

describe("progressText", () => {
  it("says what has come and what is still to come", () => {
    expect(progressText({ ordered: 20, received: 18, outstanding: 2, cancelled: 0 })).toBe(
      "18 of 20 received · 2 to come",
    );
    expect(progressText({ ordered: 20, received: 20, outstanding: 0, cancelled: 0 })).toBe(
      "20 of 20 received",
    );
    expect(progressText({ ordered: 20, received: 0, outstanding: 20, cancelled: 0 })).toBe(
      "0 of 20 received · 20 to come",
    );
  });

  it("reports a cancelled remainder as cancelled, never as to come (D61)", () => {
    expect(progressText({ ordered: 20, received: 18, outstanding: 0, cancelled: 2 })).toBe(
      "18 of 20 received · 2 cancelled",
    );
  });

  it("says nothing is to come on a draft, which has not gone to the supplier (D66)", () => {
    const draft = { ordered: 15, received: 0, outstanding: 15, cancelled: 0 };
    expect(progressText(draft, "draft")).toBe("15 items · not submitted");
    expect(progressText({ ...draft, ordered: 1, outstanding: 1 }, "draft")).toBe(
      "1 item · not submitted",
    );
    expect(progressText(draft, "submitted")).toBe("0 of 15 received · 15 to come");
  });

  it("groups thousands", () => {
    expect(progressText({ ordered: 12000, received: 0, outstanding: 12000, cancelled: 0 })).toBe(
      "0 of 12,000 received · 12,000 to come",
    );
  });
});

describe("isOverdue (display only; reporting.purchase_order_progress decides lists)", () => {
  // 10:00 in Singapore on 5 Oct 2026 (02:00 UTC); 23:30 UTC on 4 Oct is 07:30 on the 5th there.
  const now = new Date("2026-10-05T02:00:00Z");
  it("is overdue after the expected shop day with units still to come on an open order", () => {
    expect(isOverdue("2026-10-04", "submitted", 2, now)).toBe(true);
    expect(isOverdue("2026-10-04", "partially_received", 2, now)).toBe(true);
    expect(isOverdue("2026-10-05", "submitted", 2, now)).toBe(false);
    expect(isOverdue("2026-10-04", "submitted", 2, new Date("2026-10-04T15:59:00Z"))).toBe(false);
    expect(isOverdue("2026-10-04", "submitted", 2, new Date("2026-10-04T16:00:00Z"))).toBe(true);
  });

  it("is never overdue for drafts, closed orders, nothing to come or no date", () => {
    expect(isOverdue("2026-10-01", "draft", 2, now)).toBe(false);
    expect(isOverdue("2026-10-01", "received", 0, now)).toBe(false);
    expect(isOverdue("2026-10-01", "cancelled", 0, now)).toBe(false);
    expect(isOverdue("2026-10-01", "submitted", 0, now)).toBe(false);
    expect(isOverdue(null, "submitted", 2, now)).toBe(false);
  });
});

describe("purchasing permissions (D60 D-PO-COSTS)", () => {
  it("shows purchase costs to view_costs or manage_purchasing holders and admins", () => {
    expect(canSeePurchaseCosts(staff("admin", []))).toBe(true);
    expect(canSeePurchaseCosts(staff("mechanic", ["view_costs"]))).toBe(true);
    expect(canSeePurchaseCosts(staff("mechanic", ["manage_purchasing"]))).toBe(true);
    expect(canSeePurchaseCosts(staff("mechanic", ["manage_inventory"]))).toBe(false);
    expect(canSeePurchaseCosts(staff("mechanic", ["view_costs"], false))).toBe(false);
  });

  it("shows supplier last costs on the product page to view_costs holders and admins only", () => {
    expect(canSeeProductPageSupplierCosts(staff("admin", []))).toBe(true);
    expect(canSeeProductPageSupplierCosts(staff("mechanic", ["view_costs"]))).toBe(true);
    // D60: manage_purchasing alone shows costs on purchasing screens only.
    expect(canSeeProductPageSupplierCosts(staff("mechanic", ["manage_purchasing"]))).toBe(false);
    expect(canSeeProductPageSupplierCosts(staff("mechanic", ["manage_inventory"]))).toBe(false);
    expect(canSeeProductPageSupplierCosts(staff("mechanic", ["view_costs"], false))).toBe(false);
  });

  it("lets only manage_purchasing holders (and admins) write", () => {
    expect(canManagePurchasing(staff("admin", []))).toBe(true);
    expect(canManagePurchasing(staff("mechanic", ["manage_purchasing"]))).toBe(true);
    expect(canManagePurchasing(staff("mechanic", ["view_costs"]))).toBe(false);
  });

  it("a manager sees purchase costs everywhere through the role's view_costs (D91)", () => {
    const manager = staff("manager", []);
    expect(canSeePurchaseCosts(manager)).toBe(true);
    expect(canSeeProductPageSupplierCosts(manager)).toBe(true);
    expect(canManagePurchasing(manager)).toBe(true);
    expect(canSeePurchaseCosts(staff("manager", [], false))).toBe(false);
    expect(canSeeProductPageSupplierCosts(staff("manager", [], false))).toBe(false);
  });

  it("a mechanic with manage_purchasing as an exception: the D60 case is unchanged", () => {
    const buyer = staff("mechanic", ["manage_purchasing"]);
    expect(canSeePurchaseCosts(buyer)).toBe(true);
    expect(canSeeProductPageSupplierCosts(buyer)).toBe(false);
    expect(canManagePurchasing(buyer)).toBe(true);
  });
});

describe("normaliseWebsite", () => {
  it("adds https:// to a bare address and keeps a typed scheme", () => {
    expect(normaliseWebsite("veloparts.test")).toBe("https://veloparts.test");
    expect(normaliseWebsite("  www.veloparts.test/b2b ")).toBe("https://www.veloparts.test/b2b");
    expect(normaliseWebsite("http://veloparts.test")).toBe("http://veloparts.test");
    expect(normaliseWebsite("HTTPS://veloparts.test")).toBe("HTTPS://veloparts.test");
    expect(normaliseWebsite("  ")).toBeNull();
    expect(normaliseWebsite(null)).toBeNull();
  });
});

describe("describePurchaseOrderEvent", () => {
  const sgd = { currency: "SGD", showCosts: true };
  const hidden = { currency: "SGD", showCosts: false };
  const ev = (
    type: Parameters<typeof describePurchaseOrderEvent>[0]["type"],
    payload: Record<string, unknown> = {},
    extra: Partial<Parameters<typeof describePurchaseOrderEvent>[0]> = {},
  ) => ({ type, payload, reason: null, actor: "Asha Admin", ...extra });

  it("reads a line added with its cost in the order's currency, or without it (D60)", () => {
    const added = ev(
      "line_added",
      { product_id: "x", quantity_ordered: 20, unit_cost: 12 },
      { productName: "Road disc brake pads" },
    );
    expect(describePurchaseOrderEvent(added, sgd)).toBe(
      "Asha Admin added Road disc brake pads × 20 at $12.00",
    );
    expect(describePurchaseOrderEvent(added, hidden)).toBe(
      "Asha Admin added Road disc brake pads × 20",
    );
    expect(describePurchaseOrderEvent(added, { currency: "EUR", showCosts: true })).toContain(
      "€12.00",
    );
    // A zero cost is a known cost (D24 as amended), shown like any other.
    expect(
      describePurchaseOrderEvent({ ...added, payload: { quantity_ordered: 1, unit_cost: 0 } }, sgd),
    ).toBe("Asha Admin added Road disc brake pads × 1 at $0.00");
  });

  it("reads submit, receive, status and cancel", () => {
    expect(describePurchaseOrderEvent(ev("submitted"), sgd)).toBe("Asha Admin submitted the order");
    expect(
      describePurchaseOrderEvent(ev("received", { units: 18, reference: "DN-5531" }), sgd),
    ).toBe("Asha Admin received 18 items (delivery note DN-5531)");
    expect(describePurchaseOrderEvent(ev("received", { units: 1, reference: null }), sgd)).toBe(
      "Asha Admin received 1 item",
    );
    expect(
      describePurchaseOrderEvent(
        ev("status_changed", { from: "submitted", to: "partially_received" }),
        sgd,
      ),
    ).toBe("Status changed to Partially received");
    const cancelled = ev("cancelled", { from: "submitted" }, { reason: "Supplier closed" });
    expect(describePurchaseOrderEvent(cancelled, sgd)).toBe(
      "Asha Admin cancelled: Supplier closed",
    );
    expect(eventShowsReason(cancelled)).toBe(false);
    expect(describePurchaseOrderEvent(ev("created", {}, { actor: null }), sgd)).toBe(
      "Someone outside the app created the order",
    );
  });

  it("names what changed and hides cost changes' amounts without cost access", () => {
    const changed = ev(
      "line_changed",
      {
        quantity_ordered: { from: 20, to: 24 },
        unit_cost: { from: 12, to: 11.5 },
      },
      { productName: "Chain", reason: "Supplier minimum" },
    );
    expect(describePurchaseOrderEvent(changed, sgd)).toBe(
      "Asha Admin changed Chain: quantity 20 → 24, unit cost $12.00 → $11.50",
    );
    expect(describePurchaseOrderEvent(changed, hidden)).toBe(
      "Asha Admin changed Chain: quantity 20 → 24, unit cost",
    );
    expect(describePurchaseOrderEvent(changed, hidden)).not.toContain("$");
    expect(eventShowsReason(changed)).toBe(true);
    expect(
      describePurchaseOrderEvent(
        ev("details_changed", {
          expected_at: { from: null, to: "2026-10-12" },
          supplier_reference: { from: null, to: "SO-1" },
        }),
        sgd,
      ),
    ).toBe("Asha Admin changed the expected date to 12 Oct 2026 and supplier reference");
    expect(
      describePurchaseOrderEvent(
        ev("line_removed", { quantity_ordered: 6 }, { productName: "Cable kit" }),
        sgd,
      ),
    ).toBe("Asha Admin removed Cable kit × 6");
  });
});

describe("costSourceHint", () => {
  it("names where a prefilled cost came from", () => {
    expect(costSourceHint("supplier_last")).toMatch(/supplier's last cost/);
    expect(costSourceHint("product")).toMatch(/product's cost/);
    expect(costSourceHint("none")).toMatch(/No earlier cost/);
  });
});

describe("waitingJobParts (A-21: the jobs a purchase order line is held for)", () => {
  const LINE_A = "d7200000-0000-4000-8000-00000000000a";
  const LINE_B = "d7200000-0000-4000-8000-00000000000b";
  const JOB_1 = "e0000000-0000-4000-8000-000000000001";
  const JOB_2 = "e0000000-0000-4000-8000-000000000002";
  const JOB_3 = "e0000000-0000-4000-8000-000000000003";
  const request = (
    n: number,
    over: Partial<LinePartRequest> & Pick<LinePartRequest, "workOrderId">,
  ): LinePartRequest => ({
    id: `f0000000-0000-4000-8000-00000000000${n}`,
    lineId: LINE_A,
    status: "ordered",
    quantity: 1,
    orderedAt: `2026-11-2${n}T02:00:00+00:00`,
    createdAt: "2026-11-20T01:00:00+00:00",
    ...over,
  });

  it("covers requests first ordered first; the rest wait", () => {
    // 3 arrived: the first request (2) and the fitted one (1) are covered.
    const waiting = waitingJobParts(
      [
        request(3, { workOrderId: JOB_3, quantity: 2 }),
        request(1, { workOrderId: JOB_1, quantity: 2 }),
        request(2, { workOrderId: JOB_2, status: "fitted" }),
      ],
      new Map([[LINE_A, 3]]),
    );
    expect(waiting.get(LINE_A)).toEqual({
      quantity: 5,
      jobs: [{ workOrderId: JOB_3, quantity: 2 }],
    });
  });

  it("names every waiting job once, with what it waits for, per line", () => {
    const waiting = waitingJobParts(
      [
        request(1, { workOrderId: JOB_1 }),
        request(2, { workOrderId: JOB_2, quantity: 2 }),
        request(3, { workOrderId: JOB_1 }),
        request(4, { workOrderId: JOB_3, lineId: LINE_B }),
        // Proposed, approved and cancelled requests are not in the queue.
        request(5, { workOrderId: JOB_3, status: "cancelled" }),
      ],
      new Map([[LINE_B, 1]]),
    );
    expect(waiting.get(LINE_A)).toEqual({
      quantity: 4,
      jobs: [
        { workOrderId: JOB_1, quantity: 2 },
        { workOrderId: JOB_2, quantity: 2 },
      ],
    });
    // Line B's part arrived: nobody waits there.
    expect(waiting.has(LINE_B)).toBe(false);
  });

  it("has nothing for a line with no ordered part", () => {
    expect(waitingJobParts([], new Map()).size).toBe(0);
    expect(
      waitingJobParts([request(1, { workOrderId: JOB_1, status: "fitted" })], new Map()).size,
    ).toBe(0);
  });

  it("lists job numbers in words", () => {
    expect(jobList([])).toBe("");
    expect(jobList(["J-000101"])).toBe("J-000101");
    expect(jobList(["J-000101", "J-000102"])).toBe("J-000101 and J-000102");
    expect(jobList(["J-000101", "J-000102", "J-000103"])).toBe("J-000101, J-000102 and J-000103");
  });
});
