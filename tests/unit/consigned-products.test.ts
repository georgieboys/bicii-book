import { describe, expect, it } from "vitest";

import { canReceiveOntoProduct, intakeProductArgs } from "@/lib/consignment";
import { intakeSchema } from "@/lib/consignment-forms";
import {
  REFUND_NOT_RESTOCK,
  REFUND_NOT_RESTOCK_CONSIGNED,
  hasConsignedQuantityLine,
  refundStockNote,
} from "@/lib/sales";

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("Receive consigned stock on a product's page", () => {
  const product = { ownershipType: "consignment", active: true, archived: false };

  it("is offered on an active, unarchived consignment product to manage_consignments", () => {
    expect(canReceiveOntoProduct(product, true)).toBe(true);
    expect(canReceiveOntoProduct(product, false)).toBe(false);
    expect(canReceiveOntoProduct({ ...product, active: false }, true)).toBe(false);
    expect(canReceiveOntoProduct({ ...product, archived: true }, true)).toBe(false);
    expect(canReceiveOntoProduct({ ...product, ownershipType: "shop_owned" }, true)).toBe(false);
    expect(canReceiveOntoProduct({ ...product, ownershipType: "customer_owned" }, true)).toBe(
      false,
    );
  });

  it("sends only the product id for an existing product, the new product's fields otherwise", () => {
    const typed = {
      productName: "Tubes",
      brand: "Schwalbe",
      description: "700c",
      categoryId: ID(9),
      newProductId: ID(4),
    };
    expect(intakeProductArgs({ ...typed, productId: ID(1) })).toEqual({ product_id: ID(1) });
    expect(intakeProductArgs({ ...typed, productId: null })).toEqual({
      product_name: "Tubes",
      brand: "Schwalbe",
      description: "700c",
      category_id: ID(9),
      new_product_id: ID(4),
    });
  });

  it("takes an optional product id on the intake input", () => {
    const intake = {
      itemId: ID(1),
      consignorId: ID(2),
      locationId: ID(3),
      agreedAmountOwed: "5",
      productName: "Tubes",
      trackingType: "quantity",
      quantity: "4",
      newProductId: ID(4),
    };
    expect(intakeSchema.parse(intake).productId).toBeNull();
    expect(intakeSchema.parse({ ...intake, productId: "" }).productId).toBeNull();
    expect(intakeSchema.parse({ ...intake, productId: ID(5) }).productId).toBe(ID(5));
    expect(intakeSchema.safeParse({ ...intake, productId: "nope" }).success).toBe(false);
  });
});

describe("refund wording for consigned quantity lines", () => {
  it("says a consigned quantity line can't be restocked", () => {
    const shop = { consignment: null, unit: null };
    const consignedUnit = { consignment: { itemId: ID(1) }, unit: { id: ID(2) } };
    const consignedQty = { consignment: { itemId: ID(1) }, unit: null };
    expect(hasConsignedQuantityLine([shop, consignedUnit])).toBe(false);
    expect(hasConsignedQuantityLine([shop, consignedQty])).toBe(true);
    expect(refundStockNote([shop])).toBe(REFUND_NOT_RESTOCK);
    expect(refundStockNote([consignedQty])).toBe(REFUND_NOT_RESTOCK_CONSIGNED);
  });
});
