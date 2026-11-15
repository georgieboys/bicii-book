import { createHash } from "node:crypto";

import type { ShopifyIds } from "./admin";

/**
 * The fake adapter's deterministic Shopify ids (Phase 10; matches the
 * seed): the number in a BICII handle n (bicii-p-000123 -> 123) gives
 * Product 9000000000 + n, ProductVariant 9100000000 + n and InventoryItem
 * 9200000000 + n. A handle without digits gets n from its SHA-256 (below
 * 10^8). The one fake location is Location 9300000001. Pure.
 */
export const FAKE_LOCATION_GID = "gid://shopify/Location/9300000001";

function handleNumber(handle: string): number {
  const digits = handle.match(/(\d+)\s*$/)?.[1];
  if (digits && digits.length <= 8) return Number(digits);
  const hex = createHash("sha256").update(handle).digest("hex").slice(0, 12);
  return Number.parseInt(hex, 16) % 100_000_000;
}

export function fakeShopifyIds(handle: string): ShopifyIds {
  const n = handleNumber(handle);
  return {
    productId: `gid://shopify/Product/${9_000_000_000 + n}`,
    variantId: `gid://shopify/ProductVariant/${9_100_000_000 + n}`,
    inventoryItemId: `gid://shopify/InventoryItem/${9_200_000_000 + n}`,
  };
}

/**
 * A product group's fake Shopify ids (D243): Product 9400000000 + n for
 * handle bicii-g-<n>, and per member SKU a variant 9500000000 + h and an
 * inventory item 9600000000 + h, h from the SHA-256 of handle and SKU.
 */
export function fakeGroupProductId(handle: string): string {
  return `gid://shopify/Product/${9_400_000_000 + handleNumber(handle)}`;
}

export function fakeGroupVariantIds(
  handle: string,
  sku: string,
): { variantId: string; inventoryItemId: string } {
  const hex = createHash("sha256").update(`${handle}|${sku}`).digest("hex").slice(0, 12);
  const h = Number.parseInt(hex, 16) % 100_000_000;
  return {
    variantId: `gid://shopify/ProductVariant/${9_500_000_000 + h}`,
    inventoryItemId: `gid://shopify/InventoryItem/${9_600_000_000 + h}`,
  };
}
