/**
 * The ShopifyAdmin interface: every call BICII makes to Shopify's Admin
 * API goes through it (SPEC §17 "isolate them in an integration/service
 * layer"; ADR-020). Two implementations: the live GraphQL adapter
 * (graphql-admin.ts) and the in-memory fake (fake-admin.ts) used by the
 * tests, local development and E2E. Pure types, no I/O.
 *
 * Money crosses as decimal strings (the price BICII pushes is
 * product_sync_state.sale_price, computed in Postgres); ids are gids.
 */

export type ShopifyProductStatus = "ACTIVE" | "DRAFT";

/** A BICII-created Shopify product, pushed in full with productSet (D84). */
export type ShopifyProductInput = {
  /** bicii-<short id lower-cased>; creation is idempotent by handle. */
  handle: string;
  title: string;
  descriptionHtml: string;
  vendor: string;
  status: ShopifyProductStatus;
  sku: string;
  /**
   * Decimal string, exactly product_sync_state.sale_price. NULL only for a
   * product that is no longer effectively online and has no price: the
   * variant's price is then left out (Shopify keeps the last one).
   */
  price: string | null;
  imageUrls: string[];
  /**
   * Whether Shopify tracks the variant's inventory. Products are tracked
   * (BICII is the stock truth, D83); a build package is a service and is
   * not (D252). Default true.
   */
  tracked?: boolean;
};

/** One member of a product group as a Shopify variant (D243). */
export type ShopifyGroupVariantInput = {
  /** The member's SKU (else its short ID): how the returned variants are matched. */
  sku: string;
  /** The member's value of the group's one option ("Black"). */
  optionValue: string;
  /** Decimal string; null leaves Shopify's price as it is. */
  price: string | null;
  /** Known after the first push; productSet keeps a variant by its id. */
  variantId: string | null;
};

/** A product group, pushed in full as ONE Shopify product with a variant per member (D243). */
export type ShopifyGroupInput = {
  /** bicii-g-<group short id lower-cased>. */
  handle: string;
  title: string;
  descriptionHtml: string;
  vendor: string;
  status: ShopifyProductStatus;
  optionName: string;
  variants: ShopifyGroupVariantInput[];
  imageUrls: string[];
};

export type ShopifyGroupIds = {
  productId: string;
  variants: { sku: string; variantId: string; inventoryItemId: string }[];
};

export type ShopifyIds = {
  productId: string;
  variantId: string;
  inventoryItemId: string;
};

export type SetAvailableQuantityInput = {
  inventoryItemId: string;
  locationId: string;
  /** The absolute "available" quantity at the location (BICII is the stock truth, D83). */
  quantity: number;
  /** Shopify must still hold this quantity, else shopify_quantity_changed; null skips the check. */
  compareQuantity: number | null;
  idempotencyKey: string;
  /** For Shopify's reference document URI (bicii://products/<reference>). */
  reference: string;
};

export interface ShopifyAdmin {
  readonly mode: "live" | "fake";
  readonly apiVersion: string;
  /**
   * productSet: create (by handle) or replace (by id) a BICII-created
   * product with ONE variant. Replaces variants, options and media, so it
   * is used only for origin 'bicii' (D84).
   */
  upsertProduct(
    input: ShopifyProductInput,
    existing: { productId: string } | null,
  ): Promise<ShopifyIds>;
  /**
   * productSet for a product group (D243): create (by handle) or replace
   * (by id) one product with an option and a variant per member. Variants
   * not listed are removed by Shopify, so the input lists every member that
   * was ever pushed.
   */
  upsertGroupProduct(
    input: ShopifyGroupInput,
    existing: { productId: string } | null,
  ): Promise<ShopifyGroupIds>;
  /** productVariantsBulkUpdate with the price only (a Shopify-made product, D84). */
  updateVariantPrice(args: {
    productId: string;
    variantId: string;
    price: string;
  }): Promise<{ inventoryItemId: string }>;
  /** inventorySetQuantities, name "available", reason "correction". */
  setAvailableQuantity(args: SetAvailableQuantityInput): Promise<void>;
  /** The shop's first active location (used until shopify_settings has one). */
  primaryLocationId(): Promise<string>;
  /**
   * publishablePublish to the Online Store sales channel, so an ACTIVE
   * product is visible on the storefront. productSet does not publish;
   * publishing an already-published product is a no-op in Shopify.
   */
  publishToOnlineStore(productId: string): Promise<void>;
}

export type ShopifyErrorCode =
  | "shopify_auth_failed"
  | "shopify_user_error"
  | "shopify_throttled"
  | "shopify_unavailable"
  | "shopify_bad_response"
  | "shopify_quantity_changed";

/** A failed Shopify call: a stable code, whether retrying can help (D87) and the text staff read. */
export class ShopifyError extends Error {
  constructor(
    readonly code: ShopifyErrorCode,
    readonly retriable: boolean,
    readonly userMessage: string,
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "ShopifyError";
  }
}

export const SHOPIFY_MESSAGES = {
  authFailed: "Shopify refused the access token. Check the Shopify app settings.",
  appNotInstalled:
    "The Shopify app is not installed on this store. Install it from the Shopify Dev Dashboard, then sync again.",
  accessDenied:
    "Shopify refused the request. Check that the Shopify app has the products, inventory, locations and publications scopes.",
  onlineStoreMissing:
    "Shopify has no Online Store sales channel, so products cannot be shown on the storefront. Add the Online Store channel in Shopify, then sync again.",
  throttled: "Shopify asked BICII to slow down. The sync will try again shortly.",
  unavailable: "Shopify could not be reached. The sync will try again shortly.",
  badResponse: "Shopify sent an answer BICII did not understand. The sync will try again.",
  quantityChanged:
    "Shopify's stock changed since the last sync. BICII waits briefly for the order to arrive before correcting it.",
} as const;

/** Shopify's userErrors as one sentence staff can read. */
export function userErrorMessage(messages: string[]): string {
  const text = messages
    .map((m) => m.trim())
    .filter(Boolean)
    .join("; ");
  return text ? `Shopify refused the change: ${text}` : "Shopify refused the change.";
}
