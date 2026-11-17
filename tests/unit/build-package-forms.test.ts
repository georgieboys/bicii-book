import { describe, expect, it } from "vitest";

import { buildPackageSchema, jobBuildSchema, repriceLineSchema } from "@/lib/build-package-forms";

const ID = "6f1c1f3e-8b2a-4c1d-9e0f-1a2b3c4d5e6f";

const base = {
  id: ID,
  kind: "full_build",
  name: " Restomod ",
  description: "",
  price: "1075",
  labourAmount: "180",
  labourServiceId: ID,
  public: "on",
  sortOrder: "30",
};

describe("build package forms (D246-D249)", () => {
  it("parses a package: trimmed name, money strings, switches and a whole sort order", () => {
    expect(buildPackageSchema.parse(base)).toEqual({
      id: ID,
      kind: "full_build",
      name: "Restomod",
      description: null,
      price: "1075.00",
      priceIsFrom: false,
      labourAmount: "180.00",
      labourServiceId: ID,
      public: true,
      sortOrder: 30,
    });
  });

  it("refuses labour above the price, a zero price and an unknown kind", () => {
    const labour = buildPackageSchema.safeParse({ ...base, labourAmount: "2000" });
    expect(labour.success).toBe(false);
    expect(labour.error?.issues[0].path).toEqual(["labourAmount"]);
    expect(buildPackageSchema.safeParse({ ...base, price: "0" }).success).toBe(false);
    expect(buildPackageSchema.safeParse({ ...base, kind: "frame" }).success).toBe(false);
  });

  it("a job's package takes an optional price; a reprice needs one", () => {
    expect(
      jobBuildSchema.parse({ workOrderId: ID, packageId: ID, labourLineId: ID, price: "" }),
    ).toMatchObject({
      price: null,
    });
    expect(repriceLineSchema.safeParse({ lineId: ID, price: "" }).success).toBe(false);
    expect(repriceLineSchema.parse({ lineId: ID, price: "199.5" })).toEqual({
      lineId: ID,
      price: "199.50",
    });
  });
});
