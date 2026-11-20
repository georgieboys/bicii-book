/**
 * A full build's Shopify product (D252, D257, D259): a "Frame" option with
 * a variant per frame option, untracked, with the package's picture and the
 * frame options explained; the BICII-frame variant keeps the original SKU.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createFakeShopifyAdmin } from "@/lib/integrations/shopify/fake-admin";
import {
  buildPackageProductInput,
  pushBuildPackage,
  type PushablePackage,
} from "@/lib/integrations/shopify/build-packages";

const pkg: PushablePackage = {
  id: "9bcb5657-0ba9-4bfd-ace7-e3cb7bef497b",
  name: "Restomod",
  description: "Our go-to build.\n\nA modern drivetrain.",
  publishOnline: true,
  shopifyProductId: null,
  shopifyVariantIds: { bicii_frame: null, own_frame: null, donor_bike: null },
  imageUrl: "https://bicii.sg/builds/packages/restomod.png",
  currency: "SGD",
  prices: { price: "1075.00", donor: { amount: "185.00", price: "1260.00" } },
};

describe("a full build on Shopify (D257)", () => {
  it("offers three frame options at the package price, the donor bike with its strip on top", () => {
    const input = buildPackageProductInput(pkg);
    expect(input).toMatchObject({
      handle: "bicii-build-9bcb5657",
      title: "Restomod build",
      status: "ACTIVE",
      optionName: "Frame",
      tracked: false,
      imageUrls: ["https://bicii.sg/builds/packages/restomod.png"],
    });
    expect(input.variants).toEqual([
      {
        sku: "BUILD-9BCB5657",
        optionValue: "Prepared frame from BICII",
        price: "1075.00",
        variantId: null,
      },
      {
        sku: "BUILD-9BCB5657-OWN",
        optionValue: "My own prepared frame (inspected first)",
        price: "1075.00",
        variantId: null,
      },
      {
        sku: "BUILD-9BCB5657-DONOR",
        optionValue: "Donor bike, stripped and prepared (+S$185)",
        price: "1260.00",
        variantId: null,
      },
    ]);
    expect(input.descriptionHtml).toContain("<p>Our go-to build.</p><p>A modern drivetrain.</p>");
    expect(input.descriptionHtml).toContain("The price never includes the frame.");
    expect(input.descriptionHtml).toContain("We accept it only once we're sure");
  });

  it("leaves out the donor bike without a donor service, and the picture without a link", () => {
    const input = buildPackageProductInput({
      ...pkg,
      imageUrl: null,
      prices: { price: "1075.00", donor: null },
    });
    expect(input.variants.map((v) => v.sku)).toEqual(["BUILD-9BCB5657", "BUILD-9BCB5657-OWN"]);
    expect(input.imageUrls).toEqual([]);
    expect(input.descriptionHtml).not.toContain("donor bike");
  });

  it("returns each frame option's variant, keeping known ids on a re-push", async () => {
    const admin = createFakeShopifyAdmin();
    const first = await pushBuildPackage(admin, pkg);
    expect(first.variantIds.bicii_frame).toMatch(/^gid:\/\/shopify\/ProductVariant\//);
    expect(first.variantIds.own_frame).toMatch(/^gid:\/\/shopify\/ProductVariant\//);
    expect(first.variantIds.donor_bike).toMatch(/^gid:\/\/shopify\/ProductVariant\//);
    expect(first.donorAmount).toBe("185.00");

    const again = await pushBuildPackage(admin, {
      ...pkg,
      shopifyProductId: first.productId,
      shopifyVariantIds: first.variantIds,
    });
    expect(again).toEqual(first);
  });
});
