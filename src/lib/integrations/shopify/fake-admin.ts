import "server-only";

import {
  SHOPIFY_MESSAGES,
  ShopifyError,
  userErrorMessage,
  type ShopifyAdmin,
  type ShopifyIds,
  type ShopifyProductInput,
} from "./admin";
import { SHOPIFY_API_VERSION } from "./config";
import { FAKE_LOCATION_GID, fakeShopifyIds } from "./fake-ids";

/**
 * An in-memory Shopify for tests, local development and E2E
 * (SHOPIFY_ADAPTER=fake; never production, env.ts refuses it there). It
 * behaves like the parts of Shopify BICII relies on: productSet by handle
 * is idempotent, productSet by id replaces the one variant, a variant
 * price update touches only that variant, and inventorySetQuantities
 * enforces the compare quantity (D83) and replays an idempotency key
 * without applying it twice. Every call is recorded in `calls`.
 */

export type FakeCallKind =
  "productSet" | "variantsBulkUpdate" | "inventorySetQuantities" | "primaryLocation" | "publish";

export type FakeCall = {
  kind: FakeCallKind;
  handle?: string;
  productId?: string;
  variantId?: string;
  inventoryItemId?: string;
  locationId?: string;
  quantity?: number;
  compareQuantity?: number | null;
  price?: string | null;
  status?: string;
  imageUrls?: string[];
  idempotencyKey?: string;
};

export type FakeProduct = {
  productId: string;
  handle: string | null;
  title: string;
  vendor: string;
  descriptionHtml: string;
  status: string;
  imageUrls: string[];
  variantIds: string[];
  /** On the Online Store sales channel (publishToOnlineStore). */
  published: boolean;
};

export type FakeVariant = {
  variantId: string;
  productId: string;
  inventoryItemId: string;
  price: string | null;
  sku: string | null;
};

export interface FakeShopifyAdmin extends ShopifyAdmin {
  readonly mode: "fake";
  readonly calls: FakeCall[];
  readonly products: Map<string, FakeProduct>;
  readonly variants: Map<string, FakeVariant>;
  /** Available quantity per inventory item (the one fake location). */
  readonly quantities: Map<string, number>;
  /** A product made in Shopify (origin 'external' in BICII). */
  seedExternalProduct(args: {
    productId: string;
    variants: { variantId: string; inventoryItemId: string; price: string; quantity: number }[];
  }): void;
  /** A BICII-created product that already exists in Shopify (e.g. from an earlier run). */
  seedProduct(ids: ShopifyIds, quantity: number, handle?: string | null): void;
  /** A shopper buys n of an item: Shopify's count drops before BICII hears of the order. */
  simulateCheckout(inventoryItemId: string, n: number): void;
  /** The next call (optionally of one kind) throws this error. */
  failNext(error: ShopifyError, kind?: FakeCallKind): void;
  /** Forget everything. */
  reset(): void;
}

function notFound(what: string): ShopifyError {
  return new ShopifyError(
    "shopify_user_error",
    false,
    userErrorMessage([`${what} does not exist`]),
  );
}

export function createFakeShopifyAdmin(): FakeShopifyAdmin {
  const calls: FakeCall[] = [];
  const products = new Map<string, FakeProduct>();
  const variants = new Map<string, FakeVariant>();
  const quantities = new Map<string, number>();
  const appliedKeys = new Set<string>();
  let pending: { error: ShopifyError; kind?: FakeCallKind } | null = null;

  function record(call: FakeCall): void {
    calls.push(call);
    if (pending && (pending.kind === undefined || pending.kind === call.kind)) {
      const { error } = pending;
      pending = null;
      throw error;
    }
  }

  function writeProduct(ids: ShopifyIds, input: ShopifyProductInput): void {
    const previous = products.get(ids.productId);
    // productSet replaces the variants: the product keeps exactly one.
    for (const v of previous?.variantIds ?? []) {
      if (v !== ids.variantId) variants.delete(v);
    }
    products.set(ids.productId, {
      productId: ids.productId,
      handle: input.handle,
      title: input.title,
      vendor: input.vendor,
      descriptionHtml: input.descriptionHtml,
      status: input.status,
      imageUrls: [...input.imageUrls],
      variantIds: [ids.variantId],
      published: previous?.published ?? false,
    });
    const old = variants.get(ids.variantId);
    variants.set(ids.variantId, {
      variantId: ids.variantId,
      productId: ids.productId,
      inventoryItemId: ids.inventoryItemId,
      price: input.price ?? old?.price ?? null,
      sku: input.sku,
    });
    if (!quantities.has(ids.inventoryItemId)) quantities.set(ids.inventoryItemId, 0);
  }

  const fake: FakeShopifyAdmin = {
    mode: "fake",
    apiVersion: SHOPIFY_API_VERSION,
    calls,
    products,
    variants,
    quantities,

    async upsertProduct(input, existing) {
      record({
        kind: "productSet",
        handle: input.handle,
        productId: existing?.productId,
        price: input.price,
        status: input.status,
        imageUrls: [...input.imageUrls],
      });
      let ids: ShopifyIds;
      if (existing) {
        const product = products.get(existing.productId);
        const derived = fakeShopifyIds(input.handle);
        if (product) {
          const variantId = product.variantIds[0] ?? derived.variantId;
          ids = {
            productId: product.productId,
            variantId,
            inventoryItemId: variants.get(variantId)?.inventoryItemId ?? derived.inventoryItemId,
          };
        } else if (derived.productId === existing.productId) {
          // Created by an earlier process (e.g. the seed): same ids.
          ids = derived;
        } else {
          throw notFound("Product");
        }
      } else {
        const byHandle = [...products.values()].find((p) => p.handle === input.handle);
        if (byHandle) {
          const variantId = byHandle.variantIds[0];
          ids = {
            productId: byHandle.productId,
            variantId,
            inventoryItemId: variants.get(variantId)!.inventoryItemId,
          };
        } else {
          ids = fakeShopifyIds(input.handle);
        }
      }
      writeProduct(ids, input);
      return ids;
    },

    async updateVariantPrice({ productId, variantId, price }) {
      record({ kind: "variantsBulkUpdate", productId, variantId, price });
      const variant = variants.get(variantId);
      if (!variant || variant.productId !== productId) throw notFound("Product variant");
      variant.price = price;
      return { inventoryItemId: variant.inventoryItemId };
    },

    async setAvailableQuantity({
      inventoryItemId,
      locationId,
      quantity,
      compareQuantity,
      idempotencyKey,
    }) {
      record({
        kind: "inventorySetQuantities",
        inventoryItemId,
        locationId,
        quantity,
        compareQuantity,
        idempotencyKey,
      });
      if (!quantities.has(inventoryItemId)) throw notFound("Inventory item");
      if (appliedKeys.has(idempotencyKey)) return;
      const current = quantities.get(inventoryItemId) ?? 0;
      if (compareQuantity !== null && compareQuantity !== current) {
        throw new ShopifyError(
          "shopify_quantity_changed",
          true,
          SHOPIFY_MESSAGES.quantityChanged,
          `expected ${compareQuantity}, Shopify has ${current}`,
        );
      }
      quantities.set(inventoryItemId, quantity);
      appliedKeys.add(idempotencyKey);
    },

    async primaryLocationId() {
      record({ kind: "primaryLocation" });
      return FAKE_LOCATION_GID;
    },

    async publishToOnlineStore(productId) {
      record({ kind: "publish", productId });
      const product = products.get(productId);
      if (!product) throw notFound("Product");
      product.published = true;
    },

    seedExternalProduct({ productId, variants: list }) {
      products.set(productId, {
        productId,
        handle: null,
        title: "Made in Shopify",
        vendor: "Shopify",
        descriptionHtml: "",
        status: "ACTIVE",
        imageUrls: [],
        variantIds: list.map((v) => v.variantId),
        published: true,
      });
      for (const v of list) {
        variants.set(v.variantId, {
          variantId: v.variantId,
          productId,
          inventoryItemId: v.inventoryItemId,
          price: v.price,
          sku: null,
        });
        quantities.set(v.inventoryItemId, v.quantity);
      }
    },

    seedProduct(ids, quantity, handle = null) {
      products.set(ids.productId, {
        productId: ids.productId,
        handle,
        title: "",
        vendor: "",
        descriptionHtml: "",
        status: "ACTIVE",
        imageUrls: [],
        variantIds: [ids.variantId],
        // Like a product pushed before BICII published to the Online Store.
        published: false,
      });
      variants.set(ids.variantId, {
        variantId: ids.variantId,
        productId: ids.productId,
        inventoryItemId: ids.inventoryItemId,
        price: null,
        sku: null,
      });
      quantities.set(ids.inventoryItemId, quantity);
    },

    simulateCheckout(inventoryItemId, n) {
      quantities.set(inventoryItemId, (quantities.get(inventoryItemId) ?? 0) - n);
    },

    failNext(error, kind) {
      pending = { error, kind };
    },

    reset() {
      calls.length = 0;
      products.clear();
      variants.clear();
      quantities.clear();
      appliedKeys.clear();
      pending = null;
    },
  };
  return fake;
}
