import { createHash } from "node:crypto";

import type { Database } from "@/lib/database.types";
import { toDecimal } from "@/lib/money";

import type { ShopifyProductInput } from "./admin";
import { shopifyHandle } from "./ids";

/**
 * What Shopify should show for one product, built from product_sync_state
 * (D81, D83, D84; ADR-020). Pure: no I/O, no business arithmetic. The
 * price is product_sync_state.sale_price (Postgres, private.selling_price
 * through private.shopify_online_price) passed through as its decimal
 * string; the quantity is the ledger's available quantity at the online
 * location when the product is effectively online, else 0.
 *
 *   full          a BICII-created product (origin 'bicii' or not pushed
 *                 yet): productSet with title, vendor, plain-text
 *                 description, public photos, one variant; DRAFT when not
 *                 effectively online.
 *   variant_only  a product made in Shopify that a variant is linked to
 *                 (origin 'external'): only the variant's price and the
 *                 inventory level, never productSet (D84).
 *
 * The hash covers everything pushed plus the location and the pinned API
 * version, so an unchanged hash means nothing to push and a version upgrade
 * re-pushes every product once (D84). The sales channel is in it too, so
 * adding Online Store publishing re-pushed every product once.
 */

export type SyncState = Database["public"]["CompositeTypes"]["shopify_product_sync_state"];

export type DesiredStateProblem = { code: string; message: string };

export type DesiredState = {
  mode: "full" | "variant_only";
  input: ShopifyProductInput | null;
  /** Decimal string; null only when no price is known (D24: 0 is a price). */
  price: string | null;
  quantity: number;
  hash: string;
  problems: DesiredStateProblem[];
};

export type DesiredStateOptions = {
  /** `${NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/media-public` */
  publicStorageBase: string;
  apiVersion: string;
  locationId: string;
};

/** A money_amount from PostgREST (a JSON number or string) as its exact two-decimal string. */
export function moneyText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" && typeof value !== "string") {
    throw new TypeError("a money amount must be a number or a decimal string");
  }
  return toDecimal(value).toFixed(2);
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Plain text -> HTML: escaped, one <p> per blank-line-separated paragraph, <br> for single newlines. */
export function descriptionToHtml(text: string | null): string {
  if (!text) return "";
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${p.replace(/[&<>"']/g, (c) => ESCAPES[c]).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/** JSON with object keys sorted at every level (a stable hash input). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

function photoUrl(base: string, path: string): string {
  const trimmed = base.replace(/\/+$/, "");
  return `${trimmed}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

export function buildDesiredState(state: SyncState, options: DesiredStateOptions): DesiredState {
  const mode = state.shopify_origin === "external" ? "variant_only" : "full";
  const effective = state.effective_online === true;
  const price = moneyText(state.sale_price);
  const quantity = effective ? Math.max(0, state.available_quantity ?? 0) : 0;

  // Refusals matter only while the product is meant to be live: a product
  // being unpublished is still drafted (or set to 0) whatever its prices.
  const problems: DesiredStateProblem[] = [];
  if (effective && price === null) {
    problems.push({
      code: "shopify_price_missing",
      message: "Set a sale price before publishing it online.",
    });
  }
  const conflicts = state.unit_price_conflicts ?? [];
  if (effective && conflicts.length > 0) {
    problems.push({
      code: "shopify_unit_price_mismatch",
      message: `Unit ${conflicts[0]} is priced differently from the product. Give units the product's price to sell them online.`,
    });
  }

  let input: ShopifyProductInput | null = null;
  if (mode === "full") {
    const shortId = state.short_id ?? "";
    input = {
      handle: state.handle ?? shopifyHandle(shortId),
      title: state.name ?? shortId,
      descriptionHtml: descriptionToHtml(state.description),
      vendor: state.brand?.trim() ? state.brand.trim() : "BICII",
      status: effective ? "ACTIVE" : "DRAFT",
      sku: state.sku?.trim() ? state.sku.trim() : shortId,
      price,
      imageUrls: (state.public_photo_paths ?? []).map((p) =>
        photoUrl(options.publicStorageBase, p),
      ),
    };
  }

  const hash = createHash("sha256")
    .update(
      canonicalJson({
        mode,
        input,
        price,
        quantity,
        locationId: options.locationId,
        apiVersion: options.apiVersion,
        // Added 2026-11-13: re-pushes every product once so the ones
        // synced before Online Store publishing get published.
        salesChannel: "online_store",
      }),
    )
    .digest("hex");

  return { mode, input, price, quantity, hash, problems };
}
