import "server-only";

import type { Json } from "@/lib/database.types";

import { ShopifyError } from "./admin";
import type { IntegrationDeps } from "./deps";

/**
 * Shopify Payments fees (D274, amends D273; ADR-020 amendment; RUNBOOK
 * "Shopify: fees"): Cult Commons of an online sale, and of the job a build
 * order on it pays for, bears the fees Shopify Payments charged on the
 * order. The fee is a fact Shopify holds on each order transaction
 * (Order.transactions.fees); BICII reads it with the app's token and hands
 * the order node to record_shopify_fee_read, whose apply stores it
 * (public.shopify_sale_fees). Nothing here computes money: Postgres reads
 * the decimal strings, sums, splits and floors.
 *
 * Never inside the webhook or the order's transaction: the fee may not be on
 * the charge when orders/paid arrives, so a sale whose fee is not there yet
 * stays pending and the sweep reads it again with a backoff
 * (public.shopify_fees_due). The queue reads once, best effort, right after
 * a sale is recorded. A refusal (no orders access: shopify_auth_failed)
 * stops the run and every fee stays pending; sales are never blocked by any
 * of this. A throttle stops the run too, without counting against the
 * sale's backoff. Any other failure is counted with note_shopify_fee_read_failed,
 * so one sale that always fails never takes every run's slots.
 */

export type ShopifyFeeRead =
  { kind: "read"; outcome: string | null } | { kind: "failed"; code: string };

/**
 * Read one online sale's order from Shopify and record its fees. A test
 * order is recorded without a read. Throws for a database error; a Shopify
 * error is returned.
 */
export async function readShopifyFee(
  deps: IntegrationDeps,
  sale: { saleId: string; orderId: string; testOrder: boolean },
): Promise<ShopifyFeeRead> {
  let raw: Record<string, unknown> | null = null;
  if (!sale.testOrder) {
    if (!deps.admin) return { kind: "failed", code: "shopify_not_configured" };
    try {
      raw = (await deps.admin.orderTransactionFees(sale.orderId)).raw;
    } catch (error) {
      if (error instanceof ShopifyError) return { kind: "failed", code: error.code };
      throw error;
    }
    if (raw === null) return { kind: "failed", code: "shopify_order_not_found" };
  }
  const { data, error } = await deps.supabase.rpc("record_shopify_fee_read", {
    p_sale_id: sale.saleId,
    // A test order is recorded without a read (the database checks the delivery).
    p_read: raw as Json,
    p_api_version: deps.admin?.apiVersion ?? undefined,
  });
  if (error) throw Object.assign(new Error("record_shopify_fee_read failed"), { code: error.code });
  return { kind: "read", outcome: data ?? null };
}

/** Count a failed fee read so shopify_fees_due backs off on it (best effort: never throws). */
async function noteFailure(deps: IntegrationDeps, saleId: string, code: string): Promise<void> {
  try {
    const { error } = await deps.supabase.rpc("note_shopify_fee_read_failed", {
      p_sale_id: saleId,
      p_error: code,
    });
    if (error) {
      deps.log.warn({ op: "shopify_fee", saleId, code: error.code }, "could not note a fee read");
    }
  } catch {
    deps.log.warn({ op: "shopify_fee", saleId }, "could not note a fee read");
  }
}

export type ShopifyFeeSweepSummary = {
  /** Sales whose fee was read and recorded (zero rows included). */
  recorded: number;
  /** Read, but Shopify has not put the fee on the charge yet (still pending). */
  pending: number;
  /** Shopify or the database failed for one sale, or the read needs attention. */
  failed: number;
  /** The app lacks orders access: the run stopped at the first refusal. */
  permission: boolean;
  /**
   * Shopify asked BICII to slow down: the run stopped there, leaving the
   * app's request budget to the product syncs, and the sale is not counted
   * against its backoff (it is due again next run).
   */
  throttled: boolean;
};

const RECORDED = new Set([
  "shopify_fee_recorded",
  "shopify_fee_unchanged",
  "shopify_fee_test_order",
]);

type DueRow = { sale_id: string; shopify_order_id: string; test_order: boolean };

async function readAndCount(
  deps: IntegrationDeps,
  row: DueRow,
  summary: ShopifyFeeSweepSummary,
): Promise<void> {
  try {
    const read = await readShopifyFee(deps, {
      saleId: row.sale_id,
      orderId: row.shopify_order_id,
      testOrder: row.test_order,
    });
    if (read.kind === "failed") {
      summary.failed += 1;
      if (read.code === "shopify_throttled") {
        summary.throttled = true;
        deps.log.info({ op: "shopify_fee", saleId: row.sale_id }, "shopify throttled a fee read");
        return;
      }
      deps.log.warn(
        { op: "shopify_fee", saleId: row.sale_id, code: read.code },
        "could not read a shopify fee",
      );
      if (read.code === "shopify_auth_failed") summary.permission = true;
      await noteFailure(deps, row.sale_id, read.code);
      return;
    }
    if (read.outcome !== null && RECORDED.has(read.outcome)) {
      summary.recorded += 1;
    } else if (read.outcome === "shopify_fee_pending") {
      summary.pending += 1;
    } else {
      // Needs attention (counted by the RPC) or not eligible any more.
      summary.failed += 1;
      deps.log.warn(
        { op: "shopify_fee", saleId: row.sale_id, outcome: read.outcome },
        "shopify fee read needs attention",
      );
    }
  } catch (err) {
    summary.failed += 1;
    deps.log.warn(
      {
        op: "shopify_fee",
        saleId: row.sale_id,
        code: (err as { code?: string }).code ?? null,
      },
      "could not record a shopify fee",
    );
    await noteFailure(deps, row.sale_id, "database_error");
  }
}

/**
 * The integration cron's step (D274): up to `max` online sales with no fee
 * row, those within Shopify's 60 days first, never-tried first and newest
 * first among them (the restated history is the same list), none started
 * after `deadlineMs`. Off (null) while Shopify is off.
 */
export async function sweepShopifyFees(
  deps: IntegrationDeps,
  options: { max: number; deadlineMs: number; now?: () => number },
): Promise<ShopifyFeeSweepSummary | null> {
  if (!deps.admin) return null;
  const now = options.now ?? Date.now;
  const summary: ShopifyFeeSweepSummary = {
    recorded: 0,
    pending: 0,
    failed: 0,
    permission: false,
    throttled: false,
  };
  const { data, error } = await deps.supabase.rpc("shopify_fees_due", { max_rows: options.max });
  if (error) throw Object.assign(new Error("shopify_fees_due failed"), { code: error.code });
  for (const row of data ?? []) {
    if (now() >= options.deadlineMs) break;
    await readAndCount(deps, row, summary);
    // A refusal is the app's missing scope (shopify_fees_due lists sales
    // within Shopify's 60 days first, so an old order refused for lack of
    // read_all_orders is reached only when no recent sale is due); a
    // throttle is the app's spent budget. Either way the rest would fail too.
    if (summary.permission || summary.throttled) break;
  }
  if (summary.recorded + summary.pending + summary.failed > 0) {
    deps.log.info({ op: "shopify_fee", ...summary }, "shopify fees swept");
  }
  return summary;
}

/**
 * D274: the best-effort read right after the queue recorded a sale. Never
 * throws and never fails the job: the sweep reads it again later.
 */
export async function readFeeAfterSale(deps: IntegrationDeps, saleId: string): Promise<void> {
  if (!deps.admin) return;
  try {
    const { data, error } = await deps.supabase.rpc("shopify_fees_due", {
      max_rows: 1,
      p_sale_id: saleId,
    });
    if (error) {
      deps.log.warn({ op: "shopify_fee", saleId, code: error.code }, "could not list a sale's fee");
      return;
    }
    const row = (data ?? [])[0];
    if (!row) return;
    const summary: ShopifyFeeSweepSummary = {
      recorded: 0,
      pending: 0,
      failed: 0,
      permission: false,
      throttled: false,
    };
    await readAndCount(deps, row, summary);
  } catch (err) {
    deps.log.warn(
      { op: "shopify_fee", saleId, err: err instanceof Error ? err.message : String(err) },
      "could not read a sale's fee",
    );
  }
}
