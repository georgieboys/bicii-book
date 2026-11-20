import "server-only";

import type { BuildFrameSource } from "@/lib/domain/build-packages";
import { formatMoney } from "@/lib/money";

import type { ShopifyAdmin, ShopifyGroupInput } from "./admin";

/**
 * A full build package as its own Shopify product (D252, D257): a "Frame"
 * option with a variant per frame option, inventory not tracked (a
 * service, not stock), ACTIVE while it is published online, with the
 * package's picture (D259). The BICII-frame variant keeps the package's
 * original SKU, so its id (which the site's cart links use) survives the
 * change to three variants. An order line on any variant becomes a build
 * order that remembers its frame option (D253, D257).
 */
export type PushablePackage = {
  id: string;
  name: string;
  description: string | null;
  publishOnline: boolean;
  shopifyProductId: string | null;
  shopifyVariantIds: Record<BuildFrameSource, string | null>;
  imageUrl: string | null;
  currency: string;
  /** From build_package_online_prices: Postgres does the money arithmetic. */
  prices: {
    price: string;
    donor: { amount: string; price: string } | null;
  };
};

export type PushedPackage = {
  productId: string;
  variantIds: Record<BuildFrameSource, string | null>;
  donorAmount: string | null;
};

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** "S$185", as the site writes it; other currencies as the Admin formats them. */
const shownPrice = (amount: string, currency: string) =>
  currency === "SGD" ? `S$${amount.replace(/\.00$/, "")}` : formatMoney(amount, currency);

const paragraphs = (text: string | null) =>
  (text ?? "")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p)}</p>`)
    .join("");

/** What the customer picks on Shopify, and what each choice means (the owner, 2026-11-19/20). */
export function frameOptionValue(
  source: BuildFrameSource,
  donorAmount: string | null,
  currency: string,
) {
  switch (source) {
    case "bicii_frame":
      return "Prepared frame from BICII";
    case "own_frame":
      return "My own prepared frame (inspected first)";
    case "donor_bike":
      return `Donor bike, stripped and prepared (+${shownPrice(donorAmount ?? "0", currency)})`;
  }
}

function frameSectionHtml(donor: { amount: string } | null, currency: string): string {
  const items = [
    "<li><strong>Prepared frame from BICII.</strong> Choose one of our prepared frames and add it to your cart with this build.</li>",
    "<li><strong>Your own prepared frame.</strong> Bring it in first and we'll inspect it for free. We accept it only once we're sure we can make the build work on it, and any work the frame needs before it's ready is quoted separately before anything starts.</li>",
  ];
  if (donor) {
    items.push(
      `<li><strong>A donor bike (+${escapeHtml(shownPrice(donor.amount, currency))}).</strong> Bring a complete bike. We strip it and give the frame the full treatment we give our own: cleaned, polished, protected against corrosion and ceramic coated. We clean and reuse only what can be used; everything else comes back to you, and anything you don't want goes into our community bin, which we use to fix migrant workers' bikes for free.</li>`,
    );
  }
  return [
    "<h3>Where the frame comes from</h3>",
    "<p>The price never includes the frame. Choose one:</p>",
    `<ul>${items.join("")}</ul>`,
    "<p>Once you've ordered, we go through colours and the parts on offer for your package with you at the shop, where you can see and handle them.</p>",
  ].join("");
}

/** The package's productSet input: handle bicii-build-<first 8 of its id>. */
export function buildPackageProductInput(pkg: PushablePackage): ShopifyGroupInput {
  const short = pkg.id.replace(/-/g, "").slice(0, 8);
  const sku = `BUILD-${short.toUpperCase()}`;
  const donor = pkg.prices.donor;
  const variants: ShopifyGroupInput["variants"] = [
    {
      sku,
      optionValue: frameOptionValue("bicii_frame", null, pkg.currency),
      price: pkg.prices.price,
      variantId: pkg.shopifyVariantIds.bicii_frame,
    },
    {
      sku: `${sku}-OWN`,
      optionValue: frameOptionValue("own_frame", null, pkg.currency),
      price: pkg.prices.price,
      variantId: pkg.shopifyVariantIds.own_frame,
    },
  ];
  if (donor) {
    variants.push({
      sku: `${sku}-DONOR`,
      optionValue: frameOptionValue("donor_bike", donor.amount, pkg.currency),
      price: donor.price,
      variantId: pkg.shopifyVariantIds.donor_bike,
    });
  }
  return {
    handle: `bicii-build-${short}`,
    title: `${pkg.name} build`,
    descriptionHtml: paragraphs(pkg.description) + frameSectionHtml(donor, pkg.currency),
    vendor: "BICII",
    status: pkg.publishOnline ? "ACTIVE" : "DRAFT",
    optionName: "Frame",
    variants,
    imageUrls: pkg.imageUrl ? [pkg.imageUrl] : [],
    tracked: false,
  };
}

/** Creates or replaces the package's Shopify product; publishes it when ACTIVE. */
export async function pushBuildPackage(
  admin: ShopifyAdmin,
  pkg: PushablePackage,
): Promise<PushedPackage> {
  const input = buildPackageProductInput(pkg);
  const ids = await admin.upsertGroupProduct(
    input,
    pkg.shopifyProductId ? { productId: pkg.shopifyProductId } : null,
  );
  if (input.status === "ACTIVE") await admin.publishToOnlineStore(ids.productId);
  const bySku = new Map(ids.variants.map((v) => [v.sku, v.variantId]));
  const [bicii, own, donor] = input.variants;
  const biciiId = bySku.get(bicii.sku) ?? null;
  if (!biciiId) throw new Error("Shopify did not return the package's BICII-frame variant.");
  return {
    productId: ids.productId,
    variantIds: {
      bicii_frame: biciiId,
      own_frame: bySku.get(own.sku) ?? null,
      donor_bike: donor ? (bySku.get(donor.sku) ?? null) : null,
    },
    donorAmount: pkg.prices.donor?.amount ?? null,
  };
}
