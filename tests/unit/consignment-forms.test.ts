import { describe, expect, it } from "vitest";

import {
  chargeSchema,
  intakeSchema,
  RECLASSIFY_REASON_MAX,
  reclassifySchema,
  returnSchema,
  settlementSchema,
  termsSchema,
} from "@/lib/consignment-forms";

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const intake = {
  itemId: ID(1),
  consignorId: ID(2),
  newConsignor: null,
  locationId: ID(3),
  agreedAmountOwed: "500",
  askingPrice: "1000",
  productName: "Colnago Master",
  trackingType: "unique",
  quantity: "1",
  newProductId: ID(4),
  newUnitId: ID(5),
};

describe("consignment intake input", () => {
  it("accepts an agreed amount of 0 as a known amount (D24)", () => {
    const parsed = intakeSchema.parse({ ...intake, agreedAmountOwed: "0" });
    expect(parsed.agreedAmountOwed).toBe("0.00");
    expect(parsed.askingPrice).toBe("1000.00");
  });

  it("refuses a missing agreed amount", () => {
    expect(intakeSchema.safeParse({ ...intake, agreedAmountOwed: "" }).success).toBe(false);
  });

  it("needs a consignor or a new one", () => {
    expect(intakeSchema.safeParse({ ...intake, consignorId: "" }).success).toBe(false);
    const parsed = intakeSchema.parse({
      ...intake,
      consignorId: "",
      newConsignor: { id: ID(6), displayName: " Daniel Ong ", phone: "", email: "" },
    });
    expect(parsed.consignorId).toBeNull();
    expect(parsed.newConsignor).toEqual({
      id: ID(6),
      displayName: "Daniel Ong",
      phone: null,
      email: null,
      customerId: null,
    });
  });

  it("takes a single item one at a time and links a bike only to a single item (D51)", () => {
    expect(intakeSchema.safeParse({ ...intake, quantity: "2" }).success).toBe(false);
    expect(
      intakeSchema.safeParse({ ...intake, trackingType: "quantity", quantity: "3", bikeId: ID(7) })
        .success,
    ).toBe(false);
    expect(
      intakeSchema.parse({ ...intake, trackingType: "quantity", quantity: "3", newUnitId: null })
        .quantity,
    ).toBe(3);
  });
});

describe("terms, charges, returns and settlements", () => {
  it("keeps the reason optional on terms (the database asks for it when the amount changes)", () => {
    expect(termsSchema.parse({ itemId: ID(1), agreedAmountOwed: "450", reason: " " }).reason).toBe(
      null,
    );
  });

  it("needs an explicit bearer and an amount above 0 on a charge (D4)", () => {
    const charge = { chargeId: ID(1), itemId: ID(2), description: "Service", amount: "120" };
    expect(chargeSchema.safeParse(charge).success).toBe(false);
    expect(chargeSchema.safeParse({ ...charge, bearer: "shop", amount: "0" }).success).toBe(false);
    expect(chargeSchema.parse({ ...charge, bearer: "consignor" }).amount).toBe("120.00");
  });

  it("needs a reason to return, and a quantity only for counted stock", () => {
    const ret = { returnId: ID(1), itemId: ID(2) };
    expect(returnSchema.safeParse({ ...ret, reason: "  " }).success).toBe(false);
    expect(returnSchema.parse({ ...ret, reason: "Back", quantity: null }).quantity).toBeNull();
    expect(returnSchema.parse({ ...ret, reason: "Back", quantity: "2" }).quantity).toBe(2);
  });

  it("needs positive allocations and keeps an override reason (D47)", () => {
    const base = { settlementId: ID(1), consignorId: ID(2), amount: "350", paidAt: null };
    expect(settlementSchema.safeParse({ ...base, allocations: [] }).success).toBe(false);
    expect(
      settlementSchema.safeParse({ ...base, allocations: [{ itemId: ID(3), amount: "0" }] })
        .success,
    ).toBe(false);
    const parsed = settlementSchema.parse({
      ...base,
      allocations: [{ itemId: ID(3), amount: "350", overrideReason: " Agreed bonus " }],
      paidAt: "2026-10-04T04:00:00.000Z",
    });
    expect(parsed.allocations[0]).toEqual({
      itemId: ID(3),
      amount: "350.00",
      overrideReason: "Agreed bonus",
    });
    expect(parsed.paidAt).toBe("2026-10-04T04:00:00.000Z");
  });
});

describe("change owner input (D162)", () => {
  const reclassify = {
    itemId: ID(1),
    productId: ID(2),
    consignorId: ID(3),
    agreedAmountOwed: "8",
    askingPrice: "",
    receivedAt: null,
    reason: "  Entered as shop stock; the consignor's items  ",
  };

  it("parses money as fixed point, a blank asking price as none, and trims the reason", () => {
    const parsed = reclassifySchema.parse(reclassify);
    expect(parsed.agreedAmountOwed).toBe("8.00");
    expect(parsed.askingPrice).toBeNull();
    expect(parsed.receivedAt).toBeNull();
    expect(parsed.reason).toBe("Entered as shop stock; the consignor's items");
  });

  it("accepts an agreed amount of 0 as a known amount (D24)", () => {
    expect(reclassifySchema.parse({ ...reclassify, agreedAmountOwed: "0" }).agreedAmountOwed).toBe(
      "0.00",
    );
  });

  it("needs a consignor, an agreed amount and a reason", () => {
    const fails = (patch: Record<string, unknown>) =>
      reclassifySchema.safeParse({ ...reclassify, ...patch }).error?.issues[0]?.message;
    expect(fails({ consignorId: "" })).toBe("Choose the consignor.");
    expect(reclassifySchema.safeParse({ ...reclassify, agreedAmountOwed: "" }).success).toBe(false);
    expect(fails({ reason: "   " })).toBe("Say why the owner is changing.");
  });

  it("keeps the reason within what the ledger's reason holds", () => {
    const at = "x".repeat(RECLASSIFY_REASON_MAX);
    expect(reclassifySchema.safeParse({ ...reclassify, reason: at }).success).toBe(true);
    expect(reclassifySchema.safeParse({ ...reclassify, reason: `${at}x` }).success).toBe(false);
  });
});
