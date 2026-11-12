import "server-only";

import { createHash } from "node:crypto";

import type { Database } from "@/lib/database.types";
import { mapDbError, type DbErrorLike } from "@/lib/db-errors";

import { SHOPIFY_MESSAGES, ShopifyError, type ShopifyIds } from "./admin";
import type { IntegrationDeps } from "./deps";
import { buildDesiredState, type SyncState } from "./desired-state";

/**
 * One product sync (D81, D83, D84, D87; DATA-MODEL §13 "Outbound product
 * sync"). Reads public.product_sync_state, pushes what changed through the
 * ShopifyAdmin adapter and reports public.record_product_sync_result; the
 * database decides every status, retry and backoff. Never throws.
 *
 *   1 read the state;                2 no adapter -> failed, retriable;
 *   3 a problem (no price, a unit priced differently) -> failed, a person acts;
 *   4 same hash as the last push and the ids known -> unchanged, no call;
 *   5 an online order in flight -> deferred, no call (D83);
 *   6 full: productSet (by id, or by handle when new); variant_only:
 *     the variant's price; then the absolute quantity with the last pushed
 *     quantity as the compare quantity;
 *   7 Shopify's count moved: deferred once (the order webhook may be on its
 *     way), then overwritten without a compare (BICII is the stock truth);
 *   8 pushed, with the ids, quantity, price, hash and API version.
 */

export const SYNC_MESSAGES = {
  notConfigured: "Shopify is not connected. It will sync once the Shopify settings are added.",
  orderInFlight:
    "An online order is being recorded. The sync waits for it so Shopify's stock is not overwritten.",
  crashed: "The sync stopped unexpectedly. It will try again.",
  notLinked: "This product is not linked to a Shopify variant. Link it again, then sync.",
  priceMissing: "Set a sale price before publishing it online.",
} as const;

export type SyncJob = { id: string; product_id: string | null; last_error_code: string | null };

export type SyncOutcome = "pushed" | "unchanged" | "deferred" | "failed";

export type SyncResult = {
  outcome: SyncOutcome;
  /** The human message recorded with a deferral or failure; null otherwise. */
  message: string | null;
  code: string | null;
};

type RecordArgs = Database["public"]["Functions"]["record_product_sync_result"]["Args"];

type Recorded = {
  outcome: SyncOutcome;
  ids?: ShopifyIds;
  locationId?: string | null;
  quantity?: number;
  price?: string | null;
  hash?: string;
  apiVersion?: string;
  code?: string;
  message?: string;
  retriable?: boolean;
};

class RecordRefused extends Error {
  constructor(readonly error: DbErrorLike) {
    super(error.message ?? "record_product_sync_result failed");
  }
}

/** A deterministic, UUID-shaped idempotency key for one inventory write. */
export function inventoryIdempotencyKey(parts: string[]): string {
  const h = createHash("sha256").update(parts.join("|")).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export async function runProductSync(job: SyncJob, deps: IntegrationDeps): Promise<SyncResult> {
  const { supabase, admin, log } = deps;
  const started = Date.now();
  const productId = job.product_id;
  let mode: string | null = null;

  const done = (result: SyncResult): SyncResult => {
    log[result.outcome === "failed" ? "warn" : "info"](
      {
        productId,
        jobId: job.id,
        mode,
        outcome: result.outcome,
        code: result.code,
        durationMs: Date.now() - started,
      },
      "shopify product sync",
    );
    return result;
  };

  async function record(r: Recorded): Promise<SyncResult> {
    const args = {
      product_id: productId,
      job_id: job.id,
      outcome: r.outcome,
      shopify_product_id: r.ids?.productId ?? null,
      shopify_variant_id: r.ids?.variantId ?? null,
      shopify_inventory_item_id: r.ids?.inventoryItemId ?? null,
      shopify_location_id: r.locationId ?? null,
      pushed_quantity: r.quantity ?? null,
      pushed_price: r.price ?? null,
      desired_hash: r.hash ?? null,
      api_version: r.apiVersion ?? null,
      error_code: r.code ?? null,
      error_message: r.message ?? null,
      retriable: r.retriable ?? null,
    };
    const { error } = await supabase.rpc(
      "record_product_sync_result",
      args as unknown as RecordArgs,
    );
    if (error) throw new RecordRefused(error);
    return { outcome: r.outcome, message: r.message ?? null, code: r.code ?? null };
  }

  const failed = (code: string, message: string, retriable: boolean) =>
    record({ outcome: "failed", code, message, retriable });

  if (!productId) {
    log.error({ jobId: job.id }, "shopify product sync job without a product");
    return done({
      outcome: "failed",
      message: SYNC_MESSAGES.crashed,
      code: "shopify_sync_crashed",
    });
  }

  try {
    // 1. The desired state's input, from Postgres.
    const { data, error } = await supabase.rpc("product_sync_state", { product_id: productId });
    if (error || !data) {
      const mapped = mapDbError(error);
      log.warn(
        { productId, jobId: job.id, code: error?.code, reason: mapped.reason },
        "product_sync_state failed",
      );
      return done(
        mapped.kind === "business"
          ? await failed(mapped.reason ?? "shopify_sync_failed", mapped.message, true)
          : await failed("shopify_sync_crashed", SYNC_MESSAGES.crashed, true),
      );
    }
    const state = data as SyncState;
    mode = state.shopify_origin === "external" ? "variant_only" : "full";

    // 2. Shopify not configured: retried with backoff until it is.
    if (!admin) {
      return done(await failed("shopify_not_configured", SYNC_MESSAGES.notConfigured, true));
    }

    const locationId = state.shopify_location_id ?? (await admin.primaryLocationId());
    const desired = buildDesiredState(state, {
      publicStorageBase: deps.publicStorageBase,
      apiVersion: admin.apiVersion,
      locationId,
    });
    mode = desired.mode;

    // 3. A person must act (D81, D24).
    if (desired.problems.length > 0) {
      const [first] = desired.problems;
      return done(await failed(first.code, first.message, false));
    }

    // 4. Nothing changed since the last push.
    const linked =
      Boolean(state.shopify_product_id) &&
      Boolean(state.shopify_variant_id) &&
      Boolean(state.shopify_inventory_item_id);
    if (linked && state.last_desired_hash === desired.hash) {
      return done(await record({ outcome: "unchanged" }));
    }

    // 5. D83: never overwrite Shopify's count while an online order is in flight.
    if (state.orders_in_flight) {
      return done(
        await record({
          outcome: "deferred",
          code: "shopify_order_in_flight",
          message: SYNC_MESSAGES.orderInFlight,
        }),
      );
    }

    // 6. Push.
    let ids: ShopifyIds;
    if (desired.mode === "full") {
      ids = await admin.upsertProduct(
        desired.input!,
        state.shopify_product_id ? { productId: state.shopify_product_id } : null,
      );
    } else {
      if (!state.shopify_product_id || !state.shopify_variant_id) {
        return done(await failed("shopify_variant_not_linked", SYNC_MESSAGES.notLinked, false));
      }
      let inventoryItemId: string;
      if (desired.price !== null) {
        ({ inventoryItemId } = await admin.updateVariantPrice({
          productId: state.shopify_product_id,
          variantId: state.shopify_variant_id,
          price: desired.price,
        }));
      } else if (state.shopify_inventory_item_id) {
        // Unpublishing a product without a price: only the quantity (0).
        inventoryItemId = state.shopify_inventory_item_id;
      } else {
        return done(await failed("shopify_price_missing", SYNC_MESSAGES.priceMissing, false));
      }
      ids = {
        productId: state.shopify_product_id,
        variantId: state.shopify_variant_id,
        inventoryItemId,
      };
    }

    const setQuantity = (compareQuantity: number | null, phase: string) =>
      admin.setAvailableQuantity({
        inventoryItemId: ids.inventoryItemId,
        locationId,
        quantity: desired.quantity,
        compareQuantity,
        idempotencyKey: inventoryIdempotencyKey([ids.inventoryItemId, desired.hash, job.id, phase]),
        reference: state.handle ?? state.short_id ?? productId,
      });
    try {
      await setQuantity(state.last_pushed_quantity ?? null, "compare");
    } catch (e) {
      if (!(e instanceof ShopifyError) || e.code !== "shopify_quantity_changed") throw e;
      // 7. D83: wait once for the order webhook, then overwrite.
      if (job.last_error_code !== "shopify_quantity_changed") {
        return done(
          await record({
            outcome: "deferred",
            code: "shopify_quantity_changed",
            message: SHOPIFY_MESSAGES.quantityChanged,
          }),
        );
      }
      log.warn(
        { productId, jobId: job.id },
        "shopify count moved twice; overwriting with the ledger quantity",
      );
      await setQuantity(null, "overwrite");
    }

    // 8. An ACTIVE BICII-made product goes on the Online Store sales
    // channel (productSet does not publish it; Shopify ignores a repeat).
    // After the price and stock, so a refusal here never holds those back.
    if (desired.mode === "full" && desired.input?.status === "ACTIVE") {
      await admin.publishToOnlineStore(ids.productId);
    }

    // 9. Done.
    try {
      return done(
        await record({
          outcome: "pushed",
          ids,
          locationId,
          quantity: desired.quantity,
          price: desired.price,
          hash: desired.hash,
          apiVersion: admin.apiVersion,
        }),
      );
    } catch (e) {
      if (e instanceof RecordRefused && e.error.code === "P0001") {
        // A business refusal (e.g. shopify_ids_conflict): a person must act.
        const mapped = mapDbError(e.error);
        return done(await failed(mapped.reason ?? "shopify_sync_failed", mapped.message, false));
      }
      if (e instanceof RecordRefused && e.error.code === "23505") {
        const mapped = mapDbError(e.error);
        return done(await failed(mapped.reason ?? "shopify_ids_conflict", mapped.message, false));
      }
      throw e;
    }
  } catch (e) {
    try {
      if (e instanceof ShopifyError) {
        log.warn({ productId, jobId: job.id, code: e.code, err: e.message }, "shopify call failed");
        return done(await failed(e.code, e.userMessage, e.retriable));
      }
      log.error(
        { productId, jobId: job.id, err: e instanceof Error ? e.message : String(e) },
        "shopify product sync crashed",
      );
      return done(await failed("shopify_sync_crashed", SYNC_MESSAGES.crashed, true));
    } catch (recordError) {
      // The result could not be stored: the job stays running and is
      // reclaimed after ten minutes (claim_integration_jobs).
      log.error(
        {
          productId,
          jobId: job.id,
          err: recordError instanceof Error ? recordError.message : String(recordError),
        },
        "could not record the shopify sync result",
      );
      return done({
        outcome: "failed",
        message: SYNC_MESSAGES.crashed,
        code: "shopify_sync_crashed",
      });
    }
  }
}
