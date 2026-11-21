import { describe, expect, it } from "vitest";

import {
  addPartSchema,
  adjustStockSchema,
  createProductSchema,
  createUniqueItemSchema,
  transferStockSchema,
  updateUnitSchema,
  writeOffUnitSchema,
} from "@/lib/inventory-forms";
import { describeProductEvent, describeUnitEvent } from "@/lib/inventory-history";
import { reopenUnitNote } from "@/lib/inventory";

const ID = "0f0e0d0c-0b0a-4908-8706-050403020100";
const ID2 = "1f0e0d0c-0b0a-4908-8706-050403020100";
const LOC = "1c000000-0000-4000-8000-000000000001";
const LOC2 = "1c000000-0000-4000-8000-000000000002";

const errorsOf = (r: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) =>
  r.success ? [] : r.error!.issues.map((i) => i.path.join("."));

describe("inventory action schemas", () => {
  it("adds a part with a whole quantity 1..999 and money as a string, never a float", () => {
    const ok = addPartSchema.parse({
      lineId: ID,
      workOrderId: ID2,
      productId: ID,
      quantity: "2",
      locationId: LOC,
      unitSalePrice: "S$1,234.5",
    });
    expect(ok.quantity).toBe(2);
    expect(ok.unitSalePrice).toBe("1234.50");
    expect(ok.unitId).toBeNull();
    const blankPrice = addPartSchema.parse({
      lineId: ID,
      workOrderId: ID2,
      productId: ID,
      quantity: "1",
      unitSalePrice: "",
      unitId: "",
      locationId: "",
    });
    expect(blankPrice.unitSalePrice).toBeNull();
    expect(blankPrice.locationId).toBeNull();
    for (const quantity of ["0", "1000", "1.5", "-1", "two"]) {
      expect(
        errorsOf(
          addPartSchema.safeParse({ lineId: ID, workOrderId: ID2, productId: ID, quantity }),
        ),
      ).toContain("quantity");
    }
    expect(
      errorsOf(
        addPartSchema.safeParse({
          lineId: ID,
          workOrderId: ID2,
          productId: ID,
          unitId: ID2,
          quantity: "2",
        }),
      ),
    ).toEqual(["quantity"]);
    expect(
      errorsOf(
        addPartSchema.safeParse({
          lineId: "x",
          workOrderId: ID2,
          productId: ID,
          quantity: "1",
          unitSalePrice: "-1",
        }),
      ),
    ).toEqual(["lineId", "unitSalePrice"]);
  });

  it("adjusts by a signed whole number, never 0, with a reason; damaged only removes", () => {
    const base = { requestId: ID, productId: ID2, locationId: LOC, reason: "  Found stock " };
    const add = adjustStockSchema.parse({ ...base, direction: "add", quantity: "10" });
    expect(add).toMatchObject({ delta: 10, type: "stock_adjustment", reason: "Found stock" });
    const remove = adjustStockSchema.parse({
      ...base,
      direction: "remove",
      quantity: "3",
      type: "damaged",
    });
    expect(remove.delta).toBe(-3);
    expect(
      errorsOf(adjustStockSchema.safeParse({ ...base, direction: "add", quantity: "0" })),
    ).toEqual(["quantity"]);
    expect(
      errorsOf(adjustStockSchema.safeParse({ ...base, direction: "add", quantity: "100001" })),
    ).toEqual(["quantity"]);
    expect(
      errorsOf(
        adjustStockSchema.safeParse({ ...base, reason: " ", direction: "add", quantity: "1" }),
      ),
    ).toEqual(["reason"]);
    expect(
      errorsOf(
        adjustStockSchema.safeParse({ ...base, direction: "add", quantity: "1", type: "damaged" }),
      ),
    ).toEqual(["type"]);
    expect(
      errorsOf(
        adjustStockSchema.safeParse({ ...base, direction: "remove", quantity: "1", unitCost: "2" }),
      ),
    ).toEqual(["unitCost"]);
    expect(
      errorsOf(
        adjustStockSchema.safeParse({
          ...base,
          reason: "x".repeat(501),
          direction: "add",
          quantity: "1",
        }),
      ),
    ).toEqual(["reason"]);
  });

  it("transfers between two different locations; a unit moves alone", () => {
    const ok = transferStockSchema.parse({
      requestId: ID,
      productId: ID2,
      fromLocationId: LOC,
      toLocationId: LOC2,
      quantity: "4",
      reason: "",
    });
    expect(ok).toMatchObject({ quantity: 4, reason: null, unitId: null });
    expect(
      errorsOf(
        transferStockSchema.safeParse({
          requestId: ID,
          productId: ID2,
          fromLocationId: LOC,
          toLocationId: LOC,
          quantity: "1",
        }),
      ),
    ).toEqual(["toLocationId"]);
  });

  it("creates products with optional money, a whole reorder point and a switch", () => {
    const p = createProductSchema.parse({
      id: ID,
      trackingType: "quantity",
      name: " Tube ",
      sku: "",
      salePrice: "12",
      cost: "",
      reorderPoint: "3",
      active: "on",
    });
    expect(p).toMatchObject({
      name: "Tube",
      sku: null,
      salePrice: "12.00",
      cost: null,
      reorderPoint: 3,
      active: true,
      categoryId: null,
    });
    expect(createProductSchema.parse({ id: ID, trackingType: "unique", name: "X" }).active).toBe(
      false,
    );
    expect(
      errorsOf(
        createProductSchema.safeParse({
          id: ID,
          trackingType: "box",
          name: "",
          reorderPoint: "-1",
        }),
      ),
    ).toEqual(["trackingType", "name", "reorderPoint"]);
    const unique = createUniqueItemSchema.parse({
      id: ID,
      unitId: ID2,
      name: "Frame",
      locationId: LOC,
      unitSalePrice: "900",
      bikeId: "",
    });
    expect(unique).toMatchObject({ unitSalePrice: "900.00", bikeId: null, unitCost: null });
    expect(errorsOf(createUniqueItemSchema.safeParse({ id: ID, unitId: ID2, name: "F" }))).toEqual([
      "locationId",
    ]);
  });

  it("edits units and writes them off with a required reason", () => {
    expect(
      updateUnitSchema.parse({
        id: ID,
        expectedUpdatedAt: "2026-11-22T02:00:00.123456+00:00",
        condition: " As new ",
        unitCost: "",
      }),
    ).toMatchObject({
      condition: "As new",
      unitCost: null,
      serialNumber: null,
    });
    expect(
      errorsOf(writeOffUnitSchema.safeParse({ requestId: ID, unitId: ID2, reason: "" })),
    ).toEqual(["reason"]);
  });
});

describe("stock history wording (never a cost)", () => {
  it("reads product events", () => {
    expect(describeProductEvent("created", { publication_status: "internal_only" })).toBe(
      "Created as internal only",
    );
    expect(describeProductEvent("details_changed", { fields: ["sku", "name"] })).toBe(
      "SKU and name changed",
    );
    expect(describeProductEvent("price_changed", { from: 9, to: "10.50" })).toBe(
      "Price changed from $9.00 to $10.50",
    );
    expect(describeProductEvent("price_changed", { from: null, to: 5 })).toBe(
      "Price changed from none to $5.00",
    );
    expect(describeProductEvent("cost_changed", {})).toBe("Cost changed");
    expect(
      describeProductEvent("publication_changed", { from: "draft", to: "internal_only" }),
    ).toBe("Publication: Draft → Internal only");
  });

  it("reads unit events, with the job behind a sale or a reopen (D25)", () => {
    expect(
      describeUnitEvent("status_changed", {
        from: "held_for_customer",
        to: "sold",
        cause: "job_completed",
        job_number: "J-000123",
      }),
    ).toBe("Sold when J-000123 was completed");
    expect(
      describeUnitEvent("status_changed", {
        from: "sold",
        to: "held_for_customer",
        cause: "job_reopened",
        job_number: "J-000123",
      }),
    ).toBe("Back on hold: J-000123 was reopened");
    expect(
      describeUnitEvent("status_changed", {
        from: "available",
        to: "held_for_customer",
        job_number: "J-000123",
      }),
    ).toBe("Put on job J-000123");
    expect(describeUnitEvent("status_changed", { from: "available", to: "written_off" })).toBe(
      "Status: Available → Written off",
    );
    expect(
      describeUnitEvent(
        "moved",
        { from_location_id: "a", to_location_id: "b" },
        {
          locationName: (id) => (id === "a" ? "Shop floor" : "Workshop store"),
        },
      ),
    ).toBe("Moved from Shop floor to Workshop store");
    expect(describeUnitEvent("cost_changed", {})).toBe("Cost changed");
  });

  it("says a reopen puts sold units back on hold", () => {
    expect(reopenUnitNote(["U-000001"])).toBe(
      "U-000001 goes back on hold for this job. To return it to stock, void its line after reopening.",
    );
    expect(reopenUnitNote(["U-000001", "U-000002"])).toMatch(
      /^U-000001 and U-000002 go back on hold/,
    );
  });
});
