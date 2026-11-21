import { describe, expect, it } from "vitest";

import { lineEconomics } from "@/lib/cult-commons";
import {
  BELOW_ASKING,
  BELOW_COST,
  previewSale,
  priceWarnings,
  readSaleDay,
  readSaleRange,
  refundableAmount,
  SALE_QUANTITY_MESSAGE,
  saleDayRange,
  saleQuantity,
  saleRange,
  saleStatusLabel,
  saleStatusTone,
} from "@/lib/sales";
import { priceInput, refundSchema, restockSchema, saleSchema } from "@/lib/sales-forms";

import { LINE_FIXTURES } from "../fixtures/cult-commons";

const UNIT = "9b000000-0000-4000-8000-000000000001";
const PRODUCT = "9a000000-0000-4000-8000-000000000010";
const LOCATION = "1c000000-0000-4000-8000-000000000001";
const SALE = "5a1e0000-0000-4000-8000-000000000001";

const fixed = (e: ReturnType<typeof lineEconomics>) => ({
  sale: e.sale.toFixed(2),
  cost: e.cost.toFixed(2),
  yield: e.yield.toFixed(2),
  cc: e.ccShare.toFixed(2),
  afterCc: e.yieldAfterCc.toFixed(2),
});

describe("previewSale (D1: Cult Commons per line, the one TS mirror)", () => {
  it("Cult Commons formula reference implementation agrees with the fixture table", () => {
    const preview = previewSale(
      LINE_FIXTURES.map((f) => ({
        quantity: f.quantity,
        unitSalePrice: f.unitSalePrice,
        unitDirectCost: f.unitDirectCost,
        rate: f.rate,
      })),
    );
    preview.lines.forEach((e, i) => {
      const f = LINE_FIXTURES[i];
      expect(fixed(e), f.name).toEqual({
        sale: f.sale,
        cost: f.cost,
        yield: f.yield,
        cc: f.cc,
        afterCc: f.afterCc,
      });
    });
  });

  it.each([
    // [price, cost, yield, Cult Commons, BICII after]
    ["1000.00", "500.00", "500.00", "150.00", "350.00"], // journey 4: a consigned bike
    ["140.00", "70.00", "70.00", "21.00", "49.00"],
    ["70.00", "35.00", "35.00", "10.50", "24.50"],
    ["1000.00", "620.00", "380.00", "114.00", "266.00"],
    ["400.00", "500.00", "-100.00", "0.00", "-100.00"], // a loss: zero share
  ])("a line sold at %s costing %s yields %s and %s Cult Commons", (price, cost, y, cc, after) => {
    const { lines, total } = previewSale([
      { quantity: 1, unitSalePrice: price, unitDirectCost: cost, rate: "0.3000" },
    ]);
    expect(fixed(lines[0])).toEqual({ sale: price, cost, yield: y, cc, afterCc: after });
    expect(fixed(total)).toEqual(fixed(lines[0]));
  });

  it("sums per line: a loss-making line takes nothing from another line's share", () => {
    const { total } = previewSale([
      { quantity: 1, unitSalePrice: "1000", unitDirectCost: "500", rate: "0.3" },
      { quantity: 1, unitSalePrice: "100", unitDirectCost: "300", rate: "0.3" },
    ]);
    expect(fixed(total)).toEqual({
      sale: "1100.00",
      cost: "800.00",
      yield: "300.00",
      cc: "150.00",
      afterCc: "150.00",
    });
  });

  it("treats 0 as a known price and cost (D24)", () => {
    const { total } = previewSale([
      { quantity: 2, unitSalePrice: "0", unitDirectCost: "0", rate: "0.3" },
    ]);
    expect(fixed(total)).toEqual({
      sale: "0.00",
      cost: "0.00",
      yield: "0.00",
      cc: "0.00",
      afterCc: "0.00",
    });
  });
});

describe("priceWarnings (D53: no floor, only warnings)", () => {
  it("warns below the asking price for everyone", () => {
    expect(priceWarnings({ price: "900", referencePrice: "1000" })).toEqual([BELOW_ASKING]);
    expect(priceWarnings({ price: "1000", referencePrice: "1000" })).toEqual([]);
    expect(priceWarnings({ price: "1200", referencePrice: "1000" })).toEqual([]);
  });

  it("warns below cost only when a cost is given (view_costs holders)", () => {
    expect(priceWarnings({ price: "400", referencePrice: "1000", cost: "500" })).toEqual([
      BELOW_ASKING,
      BELOW_COST,
    ]);
    expect(priceWarnings({ price: "400", referencePrice: "1000" })).toEqual([BELOW_ASKING]);
    expect(priceWarnings({ price: "400", referencePrice: "1000", cost: null })).toEqual([
      BELOW_ASKING,
    ]);
    expect(BELOW_COST).toBe("Below cost: this sale loses money");
    expect(BELOW_ASKING).toBe("Below the asking price");
  });

  it("reads 0 as a price and a cost, and nothing without a price or a reference", () => {
    expect(priceWarnings({ price: "0", referencePrice: "12", cost: "5" })).toEqual([
      BELOW_ASKING,
      BELOW_COST,
    ]);
    expect(priceWarnings({ price: "0", referencePrice: "0", cost: "0" })).toEqual([]);
    expect(priceWarnings({ price: null, referencePrice: "12", cost: "5" })).toEqual([]);
    expect(priceWarnings({ price: "3", referencePrice: null })).toEqual([]);
  });
});

describe("sale status words", () => {
  it("names each status and gives it a tone", () => {
    expect(saleStatusLabel("recorded")).toBe("Recorded");
    expect(saleStatusLabel("partially_refunded")).toBe("Partly refunded");
    expect(saleStatusLabel("refunded")).toBe("Refunded");
    expect(saleStatusTone("recorded")).toBe("done");
    expect(saleStatusTone("partially_refunded")).toBe("waiting");
    expect(saleStatusTone("refunded")).toBe("danger");
  });
});

describe("saleRange (shop days in Singapore, D35)", () => {
  it("Today runs from Singapore midnight to the next", () => {
    // 00:30 on 5 Oct in Singapore is 16:30 UTC on 4 Oct.
    expect(saleRange("today", "2026-10-04T16:30:00Z")).toEqual({
      from: "2026-10-04T16:00:00.000Z",
      to: "2026-10-05T16:00:00.000Z",
    });
    // 23:59 on 4 Oct in Singapore is still 4 Oct.
    expect(saleRange("today", "2026-10-04T15:59:00Z")).toEqual({
      from: "2026-10-03T16:00:00.000Z",
      to: "2026-10-04T16:00:00.000Z",
    });
  });

  it("7 days and 30 days end with today and include it", () => {
    expect(saleRange("7d", "2026-10-05T04:00:00Z")).toEqual({
      from: "2026-09-28T16:00:00.000Z",
      to: "2026-10-05T16:00:00.000Z",
    });
    expect(saleRange("30d", "2026-10-05T04:00:00Z")).toEqual({
      from: "2026-09-05T16:00:00.000Z",
      to: "2026-10-05T16:00:00.000Z",
    });
  });

  it("reads ?range=, defaulting to 7 days", () => {
    expect(readSaleRange("today")).toBe("today");
    expect(readSaleRange("30d")).toBe("30d");
    expect(readSaleRange("year")).toBe("7d");
    expect(readSaleRange(undefined)).toBe("7d");
  });

  it("reads ?day= as one shop day (Today's consignment tile), midnight to midnight in Singapore", () => {
    expect(readSaleDay("2026-10-03")).toBe("2026-10-03");
    expect(readSaleDay("2026-02-31")).toBeNull();
    expect(readSaleDay("today")).toBeNull();
    expect(readSaleDay(undefined)).toBeNull();
    expect(saleDayRange("2026-10-03")).toEqual({
      from: "2026-10-02T16:00:00.000Z",
      to: "2026-10-03T16:00:00.000Z",
    });
    expect(saleDayRange("2026-12-31")).toEqual({
      from: "2026-12-30T16:00:00.000Z",
      to: "2026-12-31T16:00:00.000Z",
    });
  });
});

describe("refundableAmount (D49: capped at the total minus earlier refunds)", () => {
  it("subtracts earlier refunds and never goes below 0", () => {
    expect(refundableAmount("28.00", [])).toBe("28.00");
    expect(refundableAmount("28.00", [{ amount: "14.00" }])).toBe("14.00");
    expect(refundableAmount("28.00", [{ amount: 14 }, { amount: "14.00" }])).toBe("0.00");
    expect(refundableAmount("10.00", [{ amount: "12.00" }])).toBe("0.00");
  });
});

describe("sales form schemas", () => {
  it("accepts a unit line and a consigned quantity line, prices as fixed-point strings", () => {
    const parsed = saleSchema.parse({
      saleId: SALE,
      lines: [
        { kind: "unit", key: `unit:${UNIT}`, unitId: UNIT, unitSalePrice: "1,000" },
        {
          kind: "product",
          key: "p",
          productId: PRODUCT,
          locationId: LOCATION,
          quantity: 2,
          consignmentItemId: null,
          unitSalePrice: "0",
        },
      ],
    });
    expect(parsed.lines[0]).toMatchObject({ unitSalePrice: "1000.00" });
    expect(parsed.lines[1]).toMatchObject({ unitSalePrice: "0.00", quantity: 2 });
    expect(parsed.customerId).toBeNull();
    expect(parsed.recognizedAt).toBeNull();
    expect(parsed.notes).toBeNull();
  });

  it("a blank price means the database selling price", () => {
    const parsed = saleSchema.parse({
      saleId: SALE,
      lines: [{ kind: "unit", key: "u", unitId: UNIT, unitSalePrice: "" }],
    });
    expect(parsed.lines[0]).toMatchObject({ unitSalePrice: null });
  });

  it("refuses no lines, a quantity of 0, a negative price and a future date", () => {
    expect(saleSchema.safeParse({ saleId: SALE, lines: [] }).success).toBe(false);
    const product = {
      kind: "product",
      key: "p",
      productId: PRODUCT,
      locationId: LOCATION,
      quantity: 0,
      unitSalePrice: null,
    };
    expect(saleSchema.safeParse({ saleId: SALE, lines: [product] }).success).toBe(false);
    expect(
      saleSchema.safeParse({
        saleId: SALE,
        lines: [{ kind: "unit", key: "u", unitId: UNIT, unitSalePrice: "-1" }],
      }).success,
    ).toBe(false);
    expect(
      saleSchema.safeParse({
        saleId: SALE,
        lines: [{ kind: "unit", key: "u", unitId: UNIT, unitSalePrice: "1" }],
        recognizedAt: new Date(Date.now() + 3_600_000).toISOString(),
      }).success,
    ).toBe(false);
  });

  it("needs a reason to restock and a positive refund with a reason", () => {
    expect(restockSchema.safeParse({ unitId: UNIT, saleLineId: SALE, reason: "  " }).success).toBe(
      false,
    );
    expect(restockSchema.parse({ unitId: UNIT, saleLineId: SALE, reason: " Came back " })).toEqual({
      unitId: UNIT,
      saleLineId: SALE,
      locationId: null,
      reason: "Came back",
    });
    expect(
      refundSchema.safeParse({ refundId: SALE, saleId: SALE, amount: "0", reason: "x" }).success,
    ).toBe(false);
    expect(
      refundSchema.parse({ refundId: SALE, saleId: SALE, amount: "14", reason: "Wrong size" }),
    ).toMatchObject({ amount: "14.00" });
  });

  it("priceInput keeps exact cents", () => {
    expect(priceInput("1,000")).toBe("1000.00");
    expect(priceInput("0")).toBe("0.00");
    expect(priceInput("abc")).toBeNull();
  });
});

describe("saleQuantity (the sale sheet's Quantity field)", () => {
  it("reads a whole number of 1 or more, spaces around it allowed", () => {
    expect(saleQuantity("1")).toBe(1);
    expect(saleQuantity(" 12 ")).toBe(12);
    expect(saleQuantity("007")).toBe(7);
  });

  it("refuses anything that is not only digits, and 0, instead of reading a different number", () => {
    for (const text of [
      "",
      " ",
      "0",
      "00",
      "1.5",
      "2x",
      "1e3",
      "12 3",
      "-1",
      "+1",
      "1,000",
      "Infinity",
    ]) {
      expect(saleQuantity(text)).toBeNull();
    }
    expect(saleQuantity("99999999999999999999")).toBeNull();
    expect(SALE_QUANTITY_MESSAGE).toBe("Enter a whole number, like 1.");
  });
});
