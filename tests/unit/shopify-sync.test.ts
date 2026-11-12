// @vitest-environment node
/**
 * The product sync runner (D81, D83, D84, D87) with stubbed RPCs and the
 * fake Shopify: what it pushes, when it pushes nothing, and what it
 * reports to record_product_sync_result.
 */
import pino from "pino";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { ShopifyError } = await import("@/lib/integrations/shopify/admin");
const { createFakeShopifyAdmin } = await import("@/lib/integrations/shopify/fake-admin");
const { buildDesiredState } = await import("@/lib/integrations/shopify/desired-state");
const { runProductSync, SYNC_MESSAGES } = await import("@/lib/integrations/shopify/sync");

import type { IntegrationDeps } from "@/lib/integrations/shopify/deps";
import type { SyncState } from "@/lib/integrations/shopify/desired-state";

const PRODUCT_ID = "d1000000-0000-4000-8000-000000000006";
const LOCATION = "gid://shopify/Location/9300000001";
const BASE = "http://127.0.0.1:54321/storage/v1/object/public/media-public";
const IDS = {
  productId: "gid://shopify/Product/9000000032",
  variantId: "gid://shopify/ProductVariant/9100000032",
  inventoryItemId: "gid://shopify/InventoryItem/9200000032",
};

function state(overrides: Partial<SyncState> = {}): SyncState {
  return {
    product_id: PRODUCT_ID,
    short_id: "P-000032",
    sku: null,
    name: "Stack sync stickers",
    description: null,
    brand: "BICII",
    tracking_type: "quantity",
    ownership_type: "shop_owned",
    publication_status: "public",
    active: true,
    archived: false,
    sale_price: 12,
    currency: "SGD",
    publish_online: true,
    effective_online: true,
    available_quantity: 50,
    unit_price_conflicts: [],
    public_photo_paths: [],
    handle: "bicii-p-000032",
    shopify_origin: null,
    shopify_product_id: null,
    shopify_variant_id: null,
    shopify_inventory_item_id: null,
    shopify_location_id: LOCATION,
    online_location_name: "Shop floor",
    last_desired_hash: null,
    last_pushed_quantity: null,
    orders_in_flight: false,
    sync_status: "pending",
    ...overrides,
  } as SyncState;
}

type Rpc = { name: string; args: Record<string, unknown> };

function harness(
  s: SyncState | { error: { code: string; message: string } },
  recordError?: { code: string; message: string },
) {
  const rpcs: Rpc[] = [];
  const fake = createFakeShopifyAdmin();
  const supabase = {
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      rpcs.push({ name, args });
      if (name === "product_sync_state") {
        return "error" in s ? { data: null, error: s.error } : { data: s, error: null };
      }
      if (name === "record_product_sync_result") {
        if (recordError && args.outcome === "pushed") return { data: null, error: recordError };
        return { data: {}, error: null };
      }
      throw new Error(`unexpected rpc ${name}`);
    }),
  };
  const deps: IntegrationDeps = {
    supabase: supabase as unknown as IntegrationDeps["supabase"],
    admin: fake,
    log: pino({ level: "silent" }),
    publicStorageBase: BASE,
  };
  const recorded = () =>
    rpcs.filter((r) => r.name === "record_product_sync_result").map((r) => r.args);
  return { fake, deps, rpcs, recorded };
}

const job = (lastErrorCode: string | null = null) => ({
  id: "0e000000-0000-4000-8000-000000000001",
  product_id: PRODUCT_ID,
  last_error_code: lastErrorCode,
});

describe("runProductSync", () => {
  it("creates a BICII product by handle, sets its quantity and records the push", async () => {
    const { fake, deps, recorded } = harness(state());
    const result = await runProductSync(job(), deps);
    expect(result).toEqual({ outcome: "pushed", message: null, code: null });
    expect(fake.calls.map((c) => c.kind)).toEqual([
      "productSet",
      "inventorySetQuantities",
      "publish",
    ]);
    expect(fake.calls[2]).toMatchObject({ productId: IDS.productId });
    expect(fake.products.get(IDS.productId)?.published).toBe(true);
    expect(fake.calls[0]).toMatchObject({
      handle: "bicii-p-000032",
      productId: undefined,
      price: "12.00",
    });
    expect(fake.calls[1]).toMatchObject({
      quantity: 50,
      compareQuantity: null,
      locationId: LOCATION,
    });
    const hash = buildDesiredState(state(), {
      publicStorageBase: BASE,
      apiVersion: fake.apiVersion,
      locationId: LOCATION,
    }).hash;
    expect(recorded()).toEqual([
      {
        product_id: PRODUCT_ID,
        job_id: job().id,
        outcome: "pushed",
        shopify_product_id: IDS.productId,
        shopify_variant_id: IDS.variantId,
        shopify_inventory_item_id: IDS.inventoryItemId,
        shopify_location_id: LOCATION,
        pushed_quantity: 50,
        pushed_price: "12.00",
        desired_hash: hash,
        api_version: fake.apiVersion,
        error_code: null,
        error_message: null,
        retriable: null,
      },
    ]);
  });

  it("asks Shopify for its location only when none is stored", async () => {
    const { fake, deps, recorded } = harness(state({ shopify_location_id: null }));
    await runProductSync(job(), deps);
    expect(fake.calls[0].kind).toBe("primaryLocation");
    expect(recorded()[0].shopify_location_id).toBe(LOCATION);
  });

  it("pushes nothing when the hash equals the last push", async () => {
    const pushed = state({
      shopify_product_id: IDS.productId,
      shopify_variant_id: IDS.variantId,
      shopify_inventory_item_id: IDS.inventoryItemId,
      shopify_origin: "bicii",
    });
    const hash = buildDesiredState(pushed, {
      publicStorageBase: BASE,
      apiVersion: "2026-10",
      locationId: LOCATION,
    }).hash;
    const { fake, deps, recorded } = harness({ ...pushed, last_desired_hash: hash });
    expect((await runProductSync(job(), deps)).outcome).toBe("unchanged");
    expect(fake.calls).toEqual([]);
    expect(recorded()[0]).toMatchObject({ outcome: "unchanged", error_code: null });
  });

  it("defers without a Shopify call while an online order is in flight (D83)", async () => {
    const { fake, deps, recorded } = harness(state({ orders_in_flight: true }));
    const result = await runProductSync(job(), deps);
    expect(result).toEqual({
      outcome: "deferred",
      code: "shopify_order_in_flight",
      message: SYNC_MESSAGES.orderInFlight,
    });
    expect(fake.calls).toEqual([]);
    expect(recorded()[0]).toMatchObject({
      outcome: "deferred",
      error_code: "shopify_order_in_flight",
    });
  });

  it("pushes only the variant price and inventory of a Shopify-made product, never productSet (D84)", async () => {
    const external = {
      productId: "gid://shopify/Product/8800000001",
      other: "gid://shopify/ProductVariant/8810000001",
      variantId: "gid://shopify/ProductVariant/8810000002",
      inventoryItemId: "gid://shopify/InventoryItem/8820000002",
    };
    const { fake, deps, recorded } = harness(
      state({
        shopify_origin: "external",
        handle: null,
        shopify_product_id: external.productId,
        shopify_variant_id: external.variantId,
      }),
    );
    fake.seedExternalProduct({
      productId: external.productId,
      variants: [
        {
          variantId: external.other,
          inventoryItemId: "gid://shopify/InventoryItem/8820000001",
          price: "9.00",
          quantity: 1,
        },
        {
          variantId: external.variantId,
          inventoryItemId: external.inventoryItemId,
          price: "10.00",
          quantity: 2,
        },
      ],
    });
    expect((await runProductSync(job(), deps)).outcome).toBe("pushed");
    expect(fake.calls.map((c) => c.kind)).toEqual(["variantsBulkUpdate", "inventorySetQuantities"]);
    expect(fake.variants.get(external.variantId)?.price).toBe("12.00");
    expect(fake.variants.get(external.other)?.price).toBe("9.00");
    expect(fake.quantities.get(external.inventoryItemId)).toBe(50);
    expect(recorded()[0]).toMatchObject({
      outcome: "pushed",
      shopify_product_id: external.productId,
      shopify_variant_id: external.variantId,
      shopify_inventory_item_id: external.inventoryItemId,
    });
  });

  it("unpublishing a priceless Shopify-made product sets only its quantity to 0", async () => {
    const { fake, deps } = harness(
      state({
        shopify_origin: "external",
        handle: null,
        effective_online: false,
        sale_price: null,
        shopify_product_id: IDS.productId,
        shopify_variant_id: IDS.variantId,
        shopify_inventory_item_id: IDS.inventoryItemId,
        last_pushed_quantity: 5,
      }),
    );
    fake.seedProduct(IDS, 5);
    expect((await runProductSync(job(), deps)).outcome).toBe("pushed");
    expect(fake.calls.map((c) => c.kind)).toEqual(["inventorySetQuantities"]);
    expect(fake.quantities.get(IDS.inventoryItemId)).toBe(0);
  });

  it("defers once when Shopify's count moved, then overwrites on the next attempt (D83)", async () => {
    const pushed = state({
      shopify_origin: "bicii",
      shopify_product_id: IDS.productId,
      shopify_variant_id: IDS.variantId,
      shopify_inventory_item_id: IDS.inventoryItemId,
      last_pushed_quantity: 50,
      available_quantity: 49,
    });
    const first = harness(pushed);
    first.fake.seedProduct(IDS, 50, "bicii-p-000032");
    first.fake.simulateCheckout(IDS.inventoryItemId, 2);
    const r1 = await runProductSync(job(), first.deps);
    expect(r1).toMatchObject({ outcome: "deferred", code: "shopify_quantity_changed" });
    expect(first.fake.quantities.get(IDS.inventoryItemId)).toBe(48);
    expect(first.recorded()[0]).toMatchObject({
      outcome: "deferred",
      error_code: "shopify_quantity_changed",
    });

    // The job comes back with its last error: BICII is the stock truth.
    const r2 = await runProductSync(job("shopify_quantity_changed"), first.deps);
    expect(r2.outcome).toBe("pushed");
    expect(first.fake.quantities.get(IDS.inventoryItemId)).toBe(49);
    const sets = first.fake.calls.filter((c) => c.kind === "inventorySetQuantities");
    expect(sets.map((c) => c.compareQuantity)).toEqual([50, 50, null]);
  });

  it("records a retriable failure with Shopify's message", async () => {
    const { fake, deps, recorded } = harness(state());
    fake.failNext(new ShopifyError("shopify_unavailable", true, "Shopify could not be reached."));
    expect(await runProductSync(job(), deps)).toEqual({
      outcome: "failed",
      code: "shopify_unavailable",
      message: "Shopify could not be reached.",
    });
    expect(recorded()[0]).toMatchObject({
      outcome: "failed",
      error_code: "shopify_unavailable",
      retriable: true,
    });
  });

  it("publishes a product synced before Online Store publishing, once its hash changes", async () => {
    // Like bicii-p-000004 on 2026-11-13: in Shopify, ACTIVE, not on the channel.
    const { fake, deps } = harness(
      state({
        shopify_product_id: IDS.productId,
        shopify_variant_id: IDS.variantId,
        shopify_inventory_item_id: IDS.inventoryItemId,
        last_pushed_quantity: 50,
        last_desired_hash: "a hash from before sales channels were hashed",
      }),
    );
    fake.seedProduct(IDS, 50, "bicii-p-000032");
    expect(fake.products.get(IDS.productId)?.published).toBe(false);
    expect((await runProductSync(job(), deps)).outcome).toBe("pushed");
    expect(fake.products.get(IDS.productId)?.published).toBe(true);
  });

  it("does not publish a product going offline (DRAFT hides it)", async () => {
    const { fake, deps } = harness(state({ publish_online: false, effective_online: false }));
    await runProductSync(job(), deps);
    expect(fake.calls.map((c) => c.kind)).toEqual(["productSet", "inventorySetQuantities"]);
    expect(fake.calls[0]).toMatchObject({ status: "DRAFT" });
  });

  it("a publishing refusal comes after the price and stock, and needs a person", async () => {
    const { fake, deps, recorded } = harness(state());
    fake.failNext(
      new ShopifyError(
        "shopify_auth_failed",
        false,
        "Shopify refused the request.",
        "ACCESS_DENIED",
      ),
      "publish",
    );
    await runProductSync(job(), deps);
    expect(fake.calls.map((c) => c.kind)).toEqual([
      "productSet",
      "inventorySetQuantities",
      "publish",
    ]);
    expect(fake.quantities.get(IDS.inventoryItemId)).toBe(50);
    expect(recorded()).toHaveLength(1);
    expect(recorded()[0]).toMatchObject({ outcome: "failed", retriable: false });
  });

  it("records userErrors as needing a person", async () => {
    const { fake, deps, recorded } = harness(state());
    fake.failNext(
      new ShopifyError(
        "shopify_user_error",
        false,
        "Shopify refused the change: Title is too long",
      ),
    );
    await runProductSync(job(), deps);
    expect(recorded()[0]).toMatchObject({
      outcome: "failed",
      retriable: false,
      error_message: "Shopify refused the change: Title is too long",
    });
  });

  it("refuses a product whose units are priced differently, without calling Shopify (D81)", async () => {
    const { fake, deps, recorded } = harness(state({ unit_price_conflicts: ["U-000012"] }));
    await runProductSync(job(), deps);
    expect(fake.calls).toEqual([]);
    expect(recorded()[0]).toMatchObject({
      outcome: "failed",
      error_code: "shopify_unit_price_mismatch",
      retriable: false,
    });
  });

  it("waits retriably when Shopify is not configured", async () => {
    const { deps, recorded } = harness(state());
    await runProductSync(job(), { ...deps, admin: null });
    expect(recorded()[0]).toMatchObject({
      outcome: "failed",
      error_code: "shopify_not_configured",
      retriable: true,
      error_message: SYNC_MESSAGES.notConfigured,
    });
  });

  it("turns a record refusal after the push into a failure a person must resolve", async () => {
    const { deps, recorded } = harness(state(), { code: "P0001", message: "shopify_ids_conflict" });
    const result = await runProductSync(job(), deps);
    expect(result).toMatchObject({ outcome: "failed", code: "shopify_ids_conflict" });
    expect(recorded().at(-1)).toMatchObject({
      outcome: "failed",
      retriable: false,
      error_message: "This product is already linked to a different Shopify product.",
    });
  });

  it("records a crash retriably and never throws", async () => {
    const { deps, recorded } = harness({ error: { code: "XX000", message: "boom" } });
    expect((await runProductSync(job(), deps)).outcome).toBe("failed");
    expect(recorded()[0]).toMatchObject({
      outcome: "failed",
      error_code: "shopify_sync_crashed",
      retriable: true,
    });

    const broken = harness(state());
    broken.deps.supabase.rpc = (async () => {
      throw new Error("network down");
    }) as never;
    await expect(runProductSync(job(), broken.deps)).resolves.toMatchObject({
      outcome: "failed",
      code: "shopify_sync_crashed",
    });
  });
});
