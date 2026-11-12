import "server-only";

import {
  SHOPIFY_MESSAGES,
  ShopifyError,
  userErrorMessage,
  type ShopifyAdmin,
  type ShopifyIds,
} from "./admin";
import { staticAccessToken, type AccessTokenSource } from "./access-token";
import { SHOPIFY_API_VERSION, SHOPIFY_TIMEOUT_MS } from "./config";

/**
 * The live ShopifyAdmin: Shopify's GraphQL Admin API at the pinned version
 * (config.ts), authenticated with an Admin API access token: a legacy
 * custom app's fixed token, or one a Dev Dashboard app's client ID and
 * secret are exchanged for (access-token.ts), fetched again once after a
 * 401 (D84, D83; ADR-020). Every call is one POST with a 15 s timeout.
 *
 * Error mapping (D87): HTTP 401/403 -> shopify_auth_failed (a person must
 * fix the token; not retriable); 429, a THROTTLED GraphQL error, 5xx,
 * network errors and timeouts -> retriable; userErrors -> shopify_user_error
 * with Shopify's messages (not retriable), except a stale compare quantity
 * -> shopify_quantity_changed (retriable, D83); any other unexpected shape
 * -> shopify_bad_response (retriable).
 *
 * UNVERIFIED against a live store (docs/RUNBOOK.md "Verify before go-live",
 * docs/RISKS.md): the exact input field names below for productSet media
 * (files), the variant SKU (inventoryItem.sku), the compare quantity
 * (changeFromQuantity) and its stale error code, and the @idempotent
 * directive on inventorySetQuantities.
 */

export const PRODUCT_SET_MUTATION = /* GraphQL */ `
  mutation BiciiProductSet($identifier: ProductSetIdentifiers, $input: ProductSetInput!) {
    productSet(identifier: $identifier, input: $input, synchronous: true) {
      product {
        id
        variants(first: 1) {
          nodes {
            id
            inventoryItem {
              id
            }
          }
        }
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

export const VARIANT_PRICE_MUTATION = /* GraphQL */ `
  mutation BiciiVariantPrice($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants {
        id
        inventoryItem {
          id
        }
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

export const SET_QUANTITIES_MUTATION = /* GraphQL */ `
  mutation BiciiSetAvailable($input: InventorySetQuantitiesInput!, $idempotencyKey: String!) {
    inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) {
      inventoryAdjustmentGroup {
        id
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

export const LOCATIONS_QUERY = /* GraphQL */ `
  query BiciiLocations {
    locations(first: 10) {
      nodes {
        id
        isActive
      }
    }
  }
`;

/** userErrors codes meaning "Shopify's quantity is no longer the compare quantity". */
export const STALE_QUANTITY_CODES = ["CHANGE_FROM_QUANTITY_STALE", "COMPARE_QUANTITY_STALE"];

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function badResponse(detail: string): ShopifyError {
  return new ShopifyError("shopify_bad_response", true, SHOPIFY_MESSAGES.badResponse, detail);
}

type UserError = { message: string; code: string | null };

function userErrorsOf(payload: Obj): UserError[] {
  const raw = payload.userErrors;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw badResponse("userErrors is not a list");
  return raw.map((e) => ({
    message: isObj(e) && typeof e.message === "string" ? e.message : "",
    code: isObj(e) ? str(e.code) : null,
  }));
}

function throwUserErrors(errors: UserError[]): void {
  if (errors.length === 0) return;
  throw new ShopifyError(
    "shopify_user_error",
    false,
    userErrorMessage(errors.map((e) => e.message)),
    errors.map((e) => `${e.code ?? "?"}: ${e.message}`).join("; "),
  );
}

export type GraphqlAdminOptions = {
  shopDomain: string;
  /** A fixed token, or a source that fetches and renews one. */
  accessToken: string | AccessTokenSource;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
};

export function createGraphqlShopifyAdmin({
  shopDomain,
  accessToken,
  fetch: fetchImpl = globalThis.fetch,
  timeoutMs = SHOPIFY_TIMEOUT_MS,
}: GraphqlAdminOptions): ShopifyAdmin {
  const endpoint = `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  const tokens = typeof accessToken === "string" ? staticAccessToken(accessToken) : accessToken;

  async function post(query: string, variables: Obj): Promise<Response> {
    const token = await tokens.get();
    try {
      return await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-Shopify-Access-Token": token,
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(timeoutMs),
        cache: "no-store",
      });
    } catch (e) {
      throw new ShopifyError(
        "shopify_unavailable",
        true,
        SHOPIFY_MESSAGES.unavailable,
        e instanceof Error ? `${e.name}: ${e.message}` : "network error",
      );
    }
  }

  async function call(query: string, variables: Obj): Promise<Obj> {
    let res = await post(query, variables);
    if (res.status === 401 && typeof accessToken !== "string") {
      // An exchanged token can be revoked before it expires: fetch a new one once.
      tokens.invalidate();
      res = await post(query, variables);
    }
    if (res.status === 401 || res.status === 403) {
      throw new ShopifyError(
        "shopify_auth_failed",
        false,
        SHOPIFY_MESSAGES.authFailed,
        `HTTP ${res.status}`,
      );
    }
    if (res.status === 429) {
      throw new ShopifyError("shopify_throttled", true, SHOPIFY_MESSAGES.throttled, "HTTP 429");
    }
    if (res.status >= 500) {
      throw new ShopifyError(
        "shopify_unavailable",
        true,
        SHOPIFY_MESSAGES.unavailable,
        `HTTP ${res.status}`,
      );
    }
    if (!res.ok) throw badResponse(`HTTP ${res.status}`);

    let body: unknown;
    try {
      body = await res.json();
    } catch (e) {
      if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
        throw new ShopifyError("shopify_unavailable", true, SHOPIFY_MESSAGES.unavailable, e.name);
      }
      throw badResponse("the body is not JSON");
    }
    if (!isObj(body)) throw badResponse("the body is not an object");

    if (Array.isArray(body.errors) && body.errors.length > 0) {
      const codes = body.errors.map((e) =>
        isObj(e) && isObj(e.extensions) ? str(e.extensions.code) : null,
      );
      const detail = body.errors
        .map((e) => (isObj(e) && typeof e.message === "string" ? e.message : "?"))
        .join("; ");
      if (codes.includes("THROTTLED")) {
        throw new ShopifyError("shopify_throttled", true, SHOPIFY_MESSAGES.throttled, detail);
      }
      if (codes.includes("ACCESS_DENIED")) {
        throw new ShopifyError("shopify_auth_failed", false, SHOPIFY_MESSAGES.accessDenied, detail);
      }
      if (codes.includes("INTERNAL_SERVER_ERROR")) {
        throw new ShopifyError("shopify_unavailable", true, SHOPIFY_MESSAGES.unavailable, detail);
      }
      throw badResponse(detail);
    }
    if (!isObj(body.data)) throw badResponse("no data");
    return body.data;
  }

  function payloadOf(data: Obj, field: string): Obj {
    const payload = data[field];
    if (!isObj(payload)) throw badResponse(`no ${field} payload`);
    return payload;
  }

  return {
    mode: "live",
    apiVersion: SHOPIFY_API_VERSION,

    async upsertProduct(input, existing): Promise<ShopifyIds> {
      const variant: Obj = {
        optionValues: [{ optionName: "Title", name: "Default Title" }],
        inventoryItem: { tracked: true, sku: input.sku },
      };
      if (input.price !== null) variant.price = input.price;
      const data = await call(PRODUCT_SET_MUTATION, {
        identifier: existing ? { id: existing.productId } : { handle: input.handle },
        input: {
          handle: input.handle,
          title: input.title,
          descriptionHtml: input.descriptionHtml,
          vendor: input.vendor,
          status: input.status,
          productOptions: [{ name: "Title", position: 1, values: [{ name: "Default Title" }] }],
          variants: [variant],
          files: input.imageUrls.map((url) => ({ originalSource: url, contentType: "IMAGE" })),
        },
      });
      const payload = payloadOf(data, "productSet");
      throwUserErrors(userErrorsOf(payload));
      const product = payload.product;
      if (!isObj(product)) throw badResponse("productSet returned no product");
      const productId = str(product.id);
      const nodes = isObj(product.variants) ? product.variants.nodes : null;
      const first = Array.isArray(nodes) && isObj(nodes[0]) ? nodes[0] : null;
      const variantId = first ? str(first.id) : null;
      const inventoryItemId =
        first && isObj(first.inventoryItem) ? str(first.inventoryItem.id) : null;
      if (!productId || !variantId || !inventoryItemId) {
        throw badResponse("productSet returned no product, variant or inventory item id");
      }
      return { productId, variantId, inventoryItemId };
    },

    async updateVariantPrice({ productId, variantId, price }) {
      const data = await call(VARIANT_PRICE_MUTATION, {
        productId,
        variants: [{ id: variantId, price }],
      });
      const payload = payloadOf(data, "productVariantsBulkUpdate");
      throwUserErrors(userErrorsOf(payload));
      const variants = payload.productVariants;
      const match = Array.isArray(variants)
        ? variants.find((v) => isObj(v) && v.id === variantId)
        : undefined;
      const inventoryItemId =
        isObj(match) && isObj(match.inventoryItem) ? str(match.inventoryItem.id) : null;
      if (!inventoryItemId)
        throw badResponse("productVariantsBulkUpdate returned no inventory item");
      return { inventoryItemId };
    },

    async setAvailableQuantity({
      inventoryItemId,
      locationId,
      quantity,
      compareQuantity,
      idempotencyKey,
      reference,
    }) {
      const data = await call(SET_QUANTITIES_MUTATION, {
        idempotencyKey,
        input: {
          name: "available",
          reason: "correction",
          referenceDocumentUri: `bicii://products/${reference}`,
          quantities: [
            // null: no compare-and-set (BICII overwrites; D83).
            { inventoryItemId, locationId, quantity, changeFromQuantity: compareQuantity },
          ],
        },
      });
      const payload = payloadOf(data, "inventorySetQuantities");
      const errors = userErrorsOf(payload);
      if (errors.some((e) => e.code !== null && STALE_QUANTITY_CODES.includes(e.code))) {
        throw new ShopifyError(
          "shopify_quantity_changed",
          true,
          SHOPIFY_MESSAGES.quantityChanged,
          errors.map((e) => e.message).join("; "),
        );
      }
      throwUserErrors(errors);
    },

    async primaryLocationId() {
      const data = await call(LOCATIONS_QUERY, {});
      const nodes = isObj(data.locations) ? data.locations.nodes : null;
      if (!Array.isArray(nodes)) throw badResponse("no locations");
      const active = nodes.find((n) => isObj(n) && n.isActive === true && str(n.id));
      if (!isObj(active)) {
        throw new ShopifyError(
          "shopify_user_error",
          false,
          "Shopify has no active location. Add one in Shopify, then sync again.",
          "no active location",
        );
      }
      return active.id as string;
    },
  };
}
