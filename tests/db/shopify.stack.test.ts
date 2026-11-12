/**
 * The Shopify service layer end to end on the live devstack (Phase 10
 * step 3; SPEC §17, §23 "A Shopify webhook can be processed repeatedly
 * without duplicating business effects", §26; PLAN D81, D83, D84, D87;
 * ADR-020): the app's own runners (src/lib/integrations/shopify) against
 * the real RPCs in bicii_dev through PostgREST, with a fresh in-memory
 * Shopify per test.
 *
 *   (a) a BICII-created product: publish -> productSet + inventory at the
 *       database's price; a sync that changes nothing calls Shopify zero
 *       times; a price change -> one productSet; a retriable failure leaves
 *       the job queued, Shopify's userErrors need a person; once synced the
 *       public Buy-online link is the storefront's /products/<handle>;
 *   (b) a signed orders/paid webhook through the real handler: the same
 *       webhook id twice and a new id once -> one sale, the online stock
 *       down by the order exactly once, delivery_count 2; the next sync
 *       waits once for Shopify's moved count (D83), then pushes the ledger
 *       quantity;
 *   (c) a product made in Shopify, linked by variant: only the variant's
 *       price and its inventory, never productSet, the other variant
 *       untouched, no Buy-online link;
 *   then both are unpublished and drafted / set to 0 (ids kept), the price
 *   and stock restored.
 *
 * bicii_dev persists between runs (and E2E resets it), so the test never
 * assumes a starting state: it asserts deltas, uses unique order ids, and
 * seeds each fresh fake from what the sync rows say was last pushed. It
 * NEVER runs runDueJobs (that would run every due job in bicii_dev): only
 * the jobs of its own two products, by id.
 *
 * Needs the devstack (`npm run db:reset && npm run devstack:start`); skips
 * otherwise, unless BICII_REQUIRE_STACK=1.
 */
import { randomUUID } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SERVICE_ROLE_KEY } from "../../scripts/devstack/config.mjs";
import type { Database } from "@/lib/database.types";
import { prepareUploads, recordPhoto, setPhotoVisibility } from "@/lib/domain/attachments";
import { ShopifyError } from "@/lib/integrations/shopify/admin";
import { publicStorageBase, type IntegrationDeps } from "@/lib/integrations/shopify/deps";
import {
  createFakeShopifyAdmin,
  type FakeShopifyAdmin,
} from "@/lib/integrations/shopify/fake-admin";
import { fakeShopifyIds } from "@/lib/integrations/shopify/fake-ids";
import { runJobById } from "@/lib/integrations/shopify/queue";
import { handleShopifyWebhook, recordShopifyWebhook } from "@/lib/integrations/shopify/webhooks";
import type { ServerSupabase } from "@/lib/supabase/server";

import { LOCATION, SHOPIFY_PRODUCT, SHOPIFY_PRODUCT_SHORT_ID } from "../fixtures/ids";
import {
  SHOPIFY_TEST_SECRET,
  SHOPIFY_TEST_SHOP,
  orderPaidPayload,
  webhookHeaders,
} from "../fixtures/shopify";
import { STACK_URL, anonClient, stackReachable, staffClient } from "./stack";

const reachable = await stackReachable("shopify service layer");

const STACK = SHOPIFY_PRODUCT.stack;
const EXTERNAL = SHOPIFY_PRODUCT.stackExternal;
const HANDLE = `bicii-${SHOPIFY_PRODUCT_SHORT_ID.stack.toLowerCase()}`;
const IDS = fakeShopifyIds(HANDLE);

/** The Shopify-made product stackExternal is linked to (its second variant). */
const MADE_IN_SHOPIFY = {
  productId: "gid://shopify/Product/8800000033",
  first: {
    variantId: "gid://shopify/ProductVariant/8810000331",
    inventoryItemId: "gid://shopify/InventoryItem/8820000331",
  },
  second: {
    variantId: "gid://shopify/ProductVariant/8810000332",
    inventoryItemId: "gid://shopify/InventoryItem/8820000332",
  },
};

/** A real 2x2 JPEG (the same as photo-moves.stack.test.ts). */
const TINY_JPEG = Buffer.from(
  "/9j/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABAb/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCOACqH/9k=",
  "base64",
);

let admin: SupabaseClient<Database>;
let service: IntegrationDeps["supabase"];
const log = pino({ level: "silent" });
/** Something in a stack run that must be cleaned up even if a test failed. */
let priceChanged = false;
let stockToRestore = 0;

beforeAll(async () => {
  if (!reachable) return;
  admin = await staffClient("admin");
  service = createClient<Database>(STACK_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
});

afterAll(async () => {
  if (!reachable) return;
  // Best effort if a test stopped half way (the last test does this with
  // assertions on the normal path).
  if (priceChanged) {
    await admin.from("products").update({ default_sale_price: 12 }).eq("id", STACK);
  }
  if (stockToRestore > 0) await restoreStock(stockToRestore);
});

function depsWith(fake: FakeShopifyAdmin): IntegrationDeps {
  return { supabase: service, admin: fake, log, publicStorageBase: publicStorageBase(STACK_URL) };
}

/** The data of a PostgREST result; throws on an error or no data. */
function check<T>(result: { data: T; error: unknown }): NonNullable<T> {
  if (result.error) throw result.error;
  if (result.data === null || result.data === undefined) throw new Error("no data returned");
  return result.data;
}

/** The data of a PostgREST result that may be null; throws on an error. */
function maybe<T>(result: { data: T; error: unknown }): T {
  if (result.error) throw result.error;
  return result.data;
}

async function syncRow(productId: string) {
  return maybe(
    await admin.from("shopify_product_sync").select("*").eq("product_id", productId).maybeSingle(),
  );
}

async function productIds(productId: string) {
  return check(
    await admin
      .from("products")
      .select("shopify_product_id, shopify_variant_id, publication_status")
      .eq("id", productId)
      .single(),
  );
}

async function job(id: string) {
  return check(await admin.from("integration_retry_queue").select("*").eq("id", id).single());
}

async function queuedSyncJob(productId: string): Promise<string> {
  const row = maybe(
    await admin
      .from("integration_retry_queue")
      .select("id")
      .eq("kind", "product_sync")
      .eq("product_id", productId)
      .eq("status", "queued")
      .maybeSingle(),
  );
  if (!row) throw new Error(`no queued sync job for ${productId}`);
  return row.id;
}

async function onlineQuantity(productId: string): Promise<number> {
  const state = check(await service.rpc("product_sync_state", { product_id: productId }));
  return state.available_quantity ?? 0;
}

/** A fresh fake Shopify holding what bicii_dev says was last pushed. */
async function freshFake(): Promise<FakeShopifyAdmin> {
  const fake = createFakeShopifyAdmin();
  const [stackIds, stackSync] = await Promise.all([productIds(STACK), syncRow(STACK)]);
  if (stackIds.shopify_product_id) {
    fake.seedProduct(IDS, stackSync?.last_pushed_quantity ?? 0, HANDLE);
  }
  const externalSync = await syncRow(EXTERNAL);
  fake.seedExternalProduct({
    productId: MADE_IN_SHOPIFY.productId,
    variants: [
      { ...MADE_IN_SHOPIFY.first, price: "99.00", quantity: 4 },
      {
        ...MADE_IN_SHOPIFY.second,
        price: "10.00",
        quantity: externalSync?.last_pushed_quantity ?? 7,
      },
    ],
  });
  return fake;
}

/** Public with a public photo (D26), as staff would make it. */
async function ensurePublic(productId: string) {
  const { publication_status } = await productIds(productId);
  if (publication_status === "public") return;
  const photos = check(
    await admin
      .from("attachments")
      .select("id")
      .eq("entity_type", "product")
      .eq("entity_id", productId)
      .eq("visibility", "public"),
  );
  if (photos.length === 0) {
    const staff = admin as unknown as ServerSupabase;
    const target = { entityType: "product" as const, entityId: productId };
    const [upload] = await prepareUploads(staff, target, ["image/jpeg"]);
    const { error } = await staff.storage
      .from(upload.bucket)
      .uploadToSignedUrl(upload.path, upload.token, new Blob([TINY_JPEG], { type: "image/jpeg" }));
    if (error) throw error;
    const photo = await recordPhoto(staff, {
      ...target,
      attachmentId: upload.attachmentId,
      path: upload.path,
      mediaType: "image/jpeg",
      byteSize: TINY_JPEG.length,
      width: 2,
      height: 2,
    });
    const problems: string[] = [];
    await setPhotoVisibility(staff, photo.id, "public", (p) => problems.push(p));
    expect(problems).toEqual([]);
  }
  check(
    await admin.rpc("set_publication_status", {
      product_id: productId,
      status: "public",
      reason: "Shopify stack test",
    }),
  );
}

/** Publish online and return the job to run (Sync now when it already was). */
async function publish(productId: string): Promise<string> {
  const result = check(
    await admin.rpc("set_publish_online", { product_id: productId, publish: true }),
  );
  if (result.job_id) return result.job_id;
  return check(await admin.rpc("request_product_sync", { product_id: productId }));
}

async function restoreStock(quantity: number) {
  check(
    await admin.rpc("adjust_stock", {
      request_id: randomUUID(),
      product_id: STACK,
      location_id: LOCATION.shopFloor,
      quantity_delta: quantity,
      movement_type: "stock_adjustment",
      reason: "Shopify stack test: put back the online order's stock",
    }),
  );
  stockToRestore = 0;
}

const callsFor = (fake: FakeShopifyAdmin, ...ids: string[]) =>
  fake.calls.filter(
    (c) =>
      (c.handle !== undefined && ids.includes(c.handle)) ||
      (c.productId !== undefined && ids.includes(c.productId)) ||
      (c.inventoryItemId !== undefined && ids.includes(c.inventoryItemId)),
  );

describe.skipIf(!reachable)("Shopify service layer on the live stack", () => {
  it("(a) pushes a BICII-created product, skips unchanged syncs, retries and refuses as the database says", async () => {
    await ensurePublic(STACK);
    let fake = await freshFake();
    let deps = depsWith(fake);

    // Publish -> one productSet and one inventory write at the database price.
    const firstJob = await publish(STACK);
    expect(await runJobById(firstJob, deps)).toBe("done");
    const state = check(await service.rpc("product_sync_state", { product_id: STACK }));
    const mine = callsFor(fake, HANDLE, IDS.productId, IDS.inventoryItemId);
    // An ACTIVE product also goes on the Online Store channel (ADR-020, 2026-11-13).
    expect(mine.map((c) => c.kind)).toEqual(["productSet", "inventorySetQuantities", "publish"]);
    expect(mine[0]).toMatchObject({ handle: HANDLE, price: "12.00", status: "ACTIVE" });
    expect(mine[0].imageUrls?.length).toBeGreaterThan(0);
    expect(mine[1]).toMatchObject({
      inventoryItemId: IDS.inventoryItemId,
      quantity: state.available_quantity,
    });
    expect(await productIds(STACK)).toMatchObject({
      shopify_product_id: IDS.productId,
      shopify_variant_id: IDS.variantId,
    });
    expect(await syncRow(STACK)).toMatchObject({
      sync_status: "synced",
      shopify_origin: "bicii",
      shopify_handle: HANDLE,
      shopify_inventory_item_id: IDS.inventoryItemId,
      last_pushed_quantity: state.available_quantity,
      last_pushed_price: 12,
      api_version: fake.apiVersion,
    });

    // A change Shopify does not show (stock at another location) -> the
    // job runs and calls Shopify zero times (desired_hash).
    for (const delta of [1, -1]) {
      check(
        await admin.rpc("adjust_stock", {
          request_id: randomUUID(),
          product_id: STACK,
          location_id: LOCATION.workshopStore,
          quantity_delta: delta,
          movement_type: "stock_adjustment",
          reason: "Shopify stack test: not an online change",
        }),
      );
    }
    fake.calls.length = 0;
    expect(await runJobById(await queuedSyncJob(STACK), deps)).toBe("done");
    expect(fake.calls).toEqual([]);

    // Sync now (D84) clears the hash on purpose: it pushes in full.
    const syncNow = check(await admin.rpc("request_product_sync", { product_id: STACK }));
    expect(await runJobById(syncNow, deps)).toBe("done");
    expect(callsFor(fake, HANDLE).map((c) => c.kind)).toEqual(["productSet"]);

    // A price change -> exactly one productSet, at the new database price.
    fake.calls.length = 0;
    priceChanged = true;
    maybe(await admin.from("products").update({ default_sale_price: 13.5 }).eq("id", STACK));
    expect(await runJobById(await queuedSyncJob(STACK), deps)).toBe("done");
    expect(fake.calls.filter((c) => c.kind === "productSet")).toEqual([
      expect.objectContaining({ handle: HANDLE, productId: IDS.productId, price: "13.50" }),
    ]);

    // A retriable failure: status error with the message, the job queued.
    const failing = check(await admin.rpc("request_product_sync", { product_id: STACK }));
    fake.failNext(new ShopifyError("shopify_unavailable", true, "Shopify could not be reached."));
    expect(await runJobById(failing, deps)).toBe("failed");
    expect(await syncRow(STACK)).toMatchObject({
      sync_status: "error",
      last_error_code: "shopify_unavailable",
      last_error: "Shopify could not be reached.",
    });
    expect((await job(failing)).status).toBe("queued");

    // Shopify's userErrors: a person must act.
    fake.failNext(
      new ShopifyError(
        "shopify_user_error",
        false,
        "Shopify refused the change: Title is too long",
      ),
    );
    expect(await runJobById(failing, deps)).toBe("needs_attention");
    expect(await job(failing)).toMatchObject({
      status: "needs_attention",
      last_error: "Shopify refused the change: Title is too long",
    });

    // Sync now supersedes it; once synced the Buy-online link appears (D84).
    fake = await freshFake();
    deps = depsWith(fake);
    const recover = check(await admin.rpc("request_product_sync", { product_id: STACK }));
    expect(await runJobById(recover, deps)).toBe("done");
    expect((await job(failing)).status).toBe("dismissed");
    expect((await syncRow(STACK))?.sync_status).toBe("synced");
    const settings = check(await admin.from("shopify_settings").select("storefront_url").single());
    const item = check(
      await anonClient()
        .schema("reporting")
        .from("public_items")
        .select("short_id, buy_online_url")
        .eq("short_id", SHOPIFY_PRODUCT_SHORT_ID.stack)
        .single(),
    );
    expect(item.buy_online_url).toBe(`${settings.storefront_url}/products/${HANDLE}`);
  });

  it("(b) records a replayed orders/paid webhook once and then pushes the ledger quantity", async () => {
    const fake = await freshFake();
    const deps = depsWith(fake);
    const before = await onlineQuantity(STACK);
    const quantity = 2;
    const stamp = Date.now();
    const orderId = Number(`9${stamp}`);
    const raw = JSON.stringify(
      orderPaidPayload({
        orderId,
        name: `#S${stamp}`,
        processedAt: new Date().toISOString(),
        lines: [
          {
            lineItemId: Number(`8${stamp}`),
            productId: Number(IDS.productId.split("/").pop()),
            variantId: Number(IDS.variantId.split("/").pop()),
            title: "Stack sync stickers",
            quantity,
            price: "13.50",
          },
        ],
      }),
    );
    // The shopper's checkout already took Shopify's count down.
    fake.simulateCheckout(IDS.inventoryItemId, quantity);

    const pending: Promise<void>[] = [];
    const deliver = async (webhookId: string) => {
      const response = await handleShopifyWebhook(
        new Request("http://localhost:3000/api/shopify/webhooks", {
          method: "POST",
          body: raw,
          headers: webhookHeaders({ topic: "orders/paid", webhookId, raw }),
        }),
        {
          secret: SHOPIFY_TEST_SECRET,
          shopDomain: SHOPIFY_TEST_SHOP,
          record: (input) => recordShopifyWebhook(service, input),
          schedule: (task) => {
            pending.push(task());
          },
          runEvent: (jobId) => runJobById(jobId, deps),
          // Never every due job of bicii_dev: only this test's own.
          runDue: async () => undefined,
          log,
        },
      );
      await Promise.all(pending.splice(0));
      return response;
    };

    const first = `stack-${stamp}-a`;
    const r1 = await deliver(first);
    const r2 = await deliver(first);
    const r3 = await deliver(`stack-${stamp}-b`);
    expect([r1.status, r2.status, r3.status]).toEqual([200, 200, 200]);
    expect(await r1.json()).toEqual({ received: true, duplicate: false });
    expect(await r2.json()).toEqual({ received: true, duplicate: true });
    expect(await r3.json()).toEqual({ received: true, duplicate: false });
    stockToRestore = quantity;

    const sales = check(
      await admin
        .from("sales")
        .select("id, source")
        .eq("shopify_order_id", `gid://shopify/Order/${orderId}`),
    );
    expect(sales).toEqual([{ id: expect.any(String), source: "online_shopify" }]);
    expect(await onlineQuantity(STACK)).toBe(before - quantity);
    const events = check(
      await admin
        .from("integration_events")
        .select("external_event_id, delivery_count, status, outcome")
        .in("external_event_id", [first, `stack-${stamp}-b`])
        .order("external_event_id"),
    );
    expect(events).toEqual([
      {
        external_event_id: first,
        delivery_count: 2,
        status: "processed",
        outcome: "sale_recorded",
      },
      {
        external_event_id: `stack-${stamp}-b`,
        delivery_count: 1,
        status: "processed",
        outcome: "duplicate_order",
      },
    ]);

    // The sale queued the product's sync: Shopify's count moved, so it waits
    // once for the order (D83), then pushes the ledger quantity.
    const syncJob = await queuedSyncJob(STACK);
    expect(await runJobById(syncJob, deps)).toBe("deferred");
    expect((await job(syncJob)).last_error_code).toBe("shopify_quantity_changed");
    expect(await runJobById(syncJob, deps)).toBe("done");
    expect(fake.quantities.get(IDS.inventoryItemId)).toBe(before - quantity);
    expect((await syncRow(STACK))?.last_pushed_quantity).toBe(before - quantity);
  });

  it("(c) pushes only price and inventory to a variant of a product made in Shopify", async () => {
    check(
      await admin.rpc("link_shopify_variant", {
        product_id: EXTERNAL,
        shopify_product_id: MADE_IN_SHOPIFY.productId,
        shopify_variant_id: MADE_IN_SHOPIFY.second.variantId,
        reason: "Shopify stack test: sold through an existing Shopify listing",
      }),
    );
    await ensurePublic(EXTERNAL);
    const fake = await freshFake();
    const deps = depsWith(fake);
    const jobId = await publish(EXTERNAL);
    expect(await runJobById(jobId, deps)).toBe("done");

    const mine = callsFor(fake, MADE_IN_SHOPIFY.productId, MADE_IN_SHOPIFY.second.inventoryItemId);
    expect(mine.map((c) => c.kind)).toEqual(["variantsBulkUpdate", "inventorySetQuantities"]);
    expect(fake.calls.some((c) => c.kind === "productSet")).toBe(false);
    expect(mine[0]).toMatchObject({ variantId: MADE_IN_SHOPIFY.second.variantId, price: "12.00" });
    expect(fake.variants.get(MADE_IN_SHOPIFY.second.variantId)?.price).toBe("12.00");
    expect(fake.quantities.get(MADE_IN_SHOPIFY.second.inventoryItemId)).toBe(
      await onlineQuantity(EXTERNAL),
    );
    // The other variant is Shopify's business.
    expect(fake.variants.get(MADE_IN_SHOPIFY.first.variantId)?.price).toBe("99.00");
    expect(fake.quantities.get(MADE_IN_SHOPIFY.first.inventoryItemId)).toBe(4);
    expect(await syncRow(EXTERNAL)).toMatchObject({
      sync_status: "synced",
      shopify_origin: "external",
      shopify_handle: null,
      shopify_inventory_item_id: MADE_IN_SHOPIFY.second.inventoryItemId,
    });
    const item = check(
      await anonClient()
        .schema("reporting")
        .from("public_items")
        .select("buy_online_url")
        .eq("short_id", SHOPIFY_PRODUCT_SHORT_ID.stackExternal)
        .single(),
    );
    expect(item.buy_online_url).toBeNull();
  });

  it("restores: unpublished, the BICII product is drafted at 0 with its ids, the variant set to 0", async () => {
    if (priceChanged) {
      maybe(await admin.from("products").update({ default_sale_price: 12 }).eq("id", STACK));
      priceChanged = false;
    }
    if (stockToRestore > 0) await restoreStock(stockToRestore);
    const fake = await freshFake();
    const deps = depsWith(fake);

    for (const productId of [STACK, EXTERNAL]) {
      check(
        await admin.rpc("set_publication_status", {
          product_id: productId,
          status: "internal_only",
          reason: "Shopify stack test: done",
        }),
      );
      const result = check(
        await admin.rpc("set_publish_online", { product_id: productId, publish: false }),
      );
      expect(result.job_id).not.toBeNull();
      expect(await runJobById(result.job_id!, deps)).toBe("done");
      expect((await syncRow(productId))?.sync_status).toBe("unpublished");
    }

    expect(callsFor(fake, HANDLE).map((c) => c.kind)).toEqual(["productSet"]);
    expect(fake.products.get(IDS.productId)).toMatchObject({ status: "DRAFT" });
    expect(fake.quantities.get(IDS.inventoryItemId)).toBe(0);
    expect(await productIds(STACK)).toMatchObject({
      shopify_product_id: IDS.productId,
      shopify_variant_id: IDS.variantId,
    });
    expect(fake.quantities.get(MADE_IN_SHOPIFY.second.inventoryItemId)).toBe(0);
    expect(fake.variants.get(MADE_IN_SHOPIFY.first.variantId)?.price).toBe("99.00");
    // Nothing of these two products is left in the queue.
    const open = check(
      await admin
        .from("integration_retry_queue")
        .select("id")
        .in("product_id", [STACK, EXTERNAL])
        .in("status", ["queued", "running", "needs_attention"]),
    );
    expect(open).toEqual([]);
  });
});
