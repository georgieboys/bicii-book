import "server-only";

import type { ShopifyAdmin, ShopifyIds, ShopifyProductInput } from "./admin";

/**
 * A full build package as its own Shopify product (D252): one variant at
 * the package price, inventory not tracked (a service, not stock), ACTIVE
 * while it is published online. Bought with a frame through the site's
 * cart link; the order's package line becomes a build order (D253).
 */
export type PushablePackage = {
  id: string;
  name: string;
  description: string | null;
  price: string;
  publishOnline: boolean;
  shopifyProductId: string | null;
};

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The package's productSet input: handle bicii-build-<first 8 of its id>. */
export function buildPackageProductInput(pkg: PushablePackage): ShopifyProductInput {
  const short = pkg.id.replace(/-/g, "").slice(0, 8);
  return {
    handle: `bicii-build-${short}`,
    title: `${pkg.name} build`,
    descriptionHtml: (pkg.description ?? "")
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => `<p>${escapeHtml(p)}</p>`)
      .join(""),
    vendor: "BICII",
    status: pkg.publishOnline ? "ACTIVE" : "DRAFT",
    sku: `BUILD-${short.toUpperCase()}`,
    price: pkg.price,
    imageUrls: [],
    tracked: false,
  };
}

/** Creates or replaces the package's Shopify product; publishes it when ACTIVE. */
export async function pushBuildPackage(
  admin: ShopifyAdmin,
  pkg: PushablePackage,
): Promise<ShopifyIds> {
  const input = buildPackageProductInput(pkg);
  const ids = await admin.upsertProduct(
    input,
    pkg.shopifyProductId ? { productId: pkg.shopifyProductId } : null,
  );
  if (input.status === "ACTIVE") await admin.publishToOnlineStore(ids.productId);
  return ids;
}
