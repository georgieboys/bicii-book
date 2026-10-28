"use server";

import { refresh } from "next/cache";

import { ActionError, staffAction } from "@/lib/actions";
import { hasPermission } from "@/lib/auth/permissions";
import { z } from "zod";
import {
  addUnit as addOneUnit,
  adjustStock as adjust,
  createProduct as createOneProduct,
  createUniqueItem as createUnique,
  searchParts as findParts,
  searchShopBikes as findShopBikes,
  setProductArchived as setArchived,
  setPublicationStatus,
  splitToUnique as split,
  transferStock as transfer,
  updateProduct as updateOneProduct,
  updateUnit as updateOneUnit,
  writeOffUnit as writeOff,
} from "@/lib/domain/inventory";
import {
  addUnitSchema,
  adjustStockSchema,
  createProductSchema,
  createUniqueItemSchema,
  searchSchema,
  setPublicationSchema,
  splitToUniqueSchema,
  transferStockSchema,
  updateProductSchema,
  updateUnitSchema,
  writeOffUnitSchema,
} from "@/lib/inventory-forms";
import {
  describeRun,
  productSyncStatus,
  requestProductSync,
  setPublishOnline,
} from "@/lib/domain/shopify";
import { afterCommit } from "@/lib/integrations/shopify/after-commit";
import { defaultDeps } from "@/lib/integrations/shopify/deps";
import { runJobById } from "@/lib/integrations/shopify/queue";
import { SYNC_QUEUED_MESSAGE } from "@/lib/shopify";
import { productIdSchema, publishOnlineSchema } from "@/lib/shopify-forms";

/**
 * Inventory actions (SPEC §11, §12, §22, §23; src/lib/domain/inventory.ts).
 * Product and unit details and transfers need manage_inventory; stock
 * adjustments and write-offs need adjust_stock; entering a cost needs
 * view_costs as well (SPEC §4.2). The RPCs, RLS and triggers check every
 * one again; these validate the input and refresh the page. Phase 10 adds
 * Publish online and Sync now (manage_inventory) at the end.
 */

type Staff = Parameters<typeof hasPermission>[0];

/** Only view_costs holders enter a cost (the database refuses anyone else too). */
function requireCost(staff: Staff, costs: Record<string, string | null>): void {
  if (hasPermission(staff, "view_costs")) return;
  const entered = Object.entries(costs).filter(([, v]) => v !== null);
  if (entered.length === 0) return;
  throw new ActionError(
    "You can't set a cost.",
    Object.fromEntries(entered.map(([k]) => [k, ["Only staff who can view costs can enter one."]])),
  );
}

const productInput = (input: z.output<typeof updateProductSchema>) => ({
  name: input.name,
  sku: input.sku,
  brand: input.brand,
  categoryId: input.categoryId,
  description: input.description,
  salePrice: input.salePrice,
  cost: input.cost,
  reorderPoint: input.reorderPoint,
  active: input.active,
});

/** A new counted (quantity) or unique product; the form's id is the idempotency key. */
export const createProduct = staffAction(
  createProductSchema,
  { name: "inventory.create_product", permission: "manage_inventory" },
  async ({ id, trackingType, ...input }, { supabase, staff }) => {
    requireCost(staff, { cost: input.cost });
    const result = await createOneProduct(supabase, id, {
      ...productInput({ id, ...input }),
      trackingType,
    });
    refresh();
    return result;
  },
);

/**
 * A unique item with its first unit, from one sheet: the product (form
 * id), then the unit (unit id), both idempotent. If the unit is refused the
 * product still exists; the result says why, and its page offers Add unit.
 */
export const createUniqueItem = staffAction(
  createUniqueItemSchema,
  { name: "inventory.create_unique_item", permission: "manage_inventory" },
  async (input, { supabase, staff, log }) => {
    requireCost(staff, { cost: input.cost, unitCost: input.unitCost });
    const result = await createUnique(
      supabase,
      {
        productId: input.id,
        unitId: input.unitId,
        product: productInput(input),
        unit: {
          locationId: input.locationId,
          serialNumber: input.serialNumber,
          condition: input.condition,
          salePrice: input.unitSalePrice,
          cost: input.unitCost,
          bikeId: input.bikeId,
        },
      },
      log,
    );
    refresh();
    return result;
  },
);

/** Edit a product's details; a blank cost keeps the current one. */
export const updateProduct = staffAction(
  updateProductSchema,
  { name: "inventory.update_product", permission: "manage_inventory" },
  async (input, { supabase, staff }) => {
    requireCost(staff, { cost: input.cost });
    await updateOneProduct(supabase, input.id, productInput(input));
    refresh();
    return null;
  },
);

/** Archive (refused while published or holding stock) or unarchive a product. */
export const archiveProduct = staffAction(
  z.object({ productId: z.guid({ error: "Unknown product." }), archived: z.boolean() }),
  { name: "inventory.set_product_archived", permission: "manage_inventory" },
  async ({ productId, archived }, { supabase }) => {
    await setArchived(supabase, productId, archived);
    refresh();
    return null;
  },
);

/** Register another unit of a unique product (shop-owned, D27); replay-safe by unit id. */
export const addUnit = staffAction(
  addUnitSchema,
  { name: "inventory.add_unit", permission: "manage_inventory" },
  async (input, { supabase, staff }) => {
    requireCost(staff, { unitCost: input.unitCost });
    const result = await addOneUnit(supabase, {
      unitId: input.unitId,
      productId: input.productId,
      locationId: input.locationId,
      serialNumber: input.serialNumber,
      condition: input.condition,
      salePrice: input.unitSalePrice,
      cost: input.unitCost,
      bikeId: input.bikeId,
    });
    refresh();
    return result;
  },
);

/** Edit a unit's serial, condition, price, notes and (view_costs) cost. */
export const updateUnit = staffAction(
  updateUnitSchema,
  { name: "inventory.update_unit", permission: "manage_inventory" },
  async (input, { supabase, staff }) => {
    requireCost(staff, { unitCost: input.unitCost });
    await updateOneUnit(supabase, input.id, {
      serialNumber: input.serialNumber,
      condition: input.condition,
      salePrice: input.unitSalePrice,
      cost: input.unitCost,
      internalNotes: input.internalNotes,
    });
    refresh();
    return null;
  },
);

/** Move stock or a unit between active locations; replay-safe by request id. */
export const transferStock = staffAction(
  transferStockSchema,
  { name: "inventory.transfer_stock", permission: "manage_inventory" },
  async (input, { supabase }) => {
    await transfer(supabase, input);
    refresh();
    return null;
  },
);

/**
 * A manual stock change with a reason (never below zero, D23); a unit cost
 * for stock added needs view_costs. Replay-safe by request id.
 */
export const adjustStock = staffAction(
  adjustStockSchema,
  { name: "inventory.adjust_stock", permission: "adjust_stock" },
  async (input, { supabase, staff }) => {
    requireCost(staff, { unitCost: input.unitCost });
    const result = await adjust(supabase, input);
    refresh();
    return result;
  },
);

/** Write off an available or reserved unit with a reason; replay-safe by request id. */
export const writeOffUnit = staffAction(
  writeOffUnitSchema,
  { name: "inventory.write_off_unit", permission: "adjust_stock" },
  async ({ requestId, unitId, reason }, { supabase }) => {
    await writeOff(supabase, requestId, unitId, reason);
    refresh();
    return null;
  },
);

/**
 * Publish, unpublish, make internal, archive or restore a listing by hand
 * (D26, set_publication_status). The RPC refuses 'sold' and every move it
 * does not allow, with the reason (publication_requires_*,
 * publication_sold_by_sale).
 */
export const setPublication = staffAction(
  setPublicationSchema,
  { name: "inventory.set_publication", permission: "manage_inventory" },
  async ({ productId, status, reason }, { supabase }) => {
    const result = await setPublicationStatus(supabase, productId, status, reason);
    refresh();
    return result;
  },
);

/**
 * Split one counted item off as a new draft unique product and unit (D28).
 * The RPC needs adjust_stock AND manage_inventory; the action is gated on
 * manage_inventory and checks adjust_stock here too, so a refusal is a
 * plain message rather than a 403 page.
 */
export const splitToUnique = staffAction(
  splitToUniqueSchema,
  { name: "inventory.split_to_unique", permission: "manage_inventory" },
  async (input, { supabase, staff }) => {
    if (!hasPermission(staff, "adjust_stock")) {
      throw new ActionError("Splitting stock also needs the adjust stock permission.");
    }
    const result = await split(supabase, input);
    refresh();
    return result;
  },
);

/** Parts for a job's Add part picker (any staff; costs only for view_costs). */
export const searchParts = staffAction(
  searchSchema,
  { name: "inventory.search_parts" },
  async ({ q, locationId }, { supabase, staff }) =>
    q ? findParts(supabase, q, { locationId, viewCosts: hasPermission(staff, "view_costs") }) : [],
);

/** Shop bikes that can become a unique item (no owner, not already in stock). */
export const searchShopBikes = staffAction(
  searchSchema,
  { name: "inventory.search_shop_bikes" },
  async ({ q }, { supabase }) => (q ? findShopBikes(supabase, q) : []),
);

/**
 * Publish online on or off (Phase 10; D84, D86; manage_inventory). When the
 * RPC queued a sync it returns that job's id, and the action runs exactly
 * that job (runJobById with the service-role deps): staff without admin
 * never read the queue. Returns the status after the run, so the card's
 * toast can say what happened.
 */
export const setPublishOnlineAction = staffAction(
  publishOnlineSchema,
  { name: "shopify.set_publish_online", permission: "manage_inventory" },
  async ({ productId, publish }, { supabase, correlationId, log }) => {
    // Committed here; what follows only speeds the sync up (D87).
    const result = await setPublishOnline(supabase, productId, publish);
    const after = await afterCommit(
      "run the publish sync",
      log,
      async () => {
        if (result.jobId) await runJobById(result.jobId, defaultDeps(correlationId));
        const status = await productSyncStatus(supabase, productId);
        return {
          syncStatus: status.syncStatus,
          message: status.syncStatus === "error" ? status.lastError : null,
        };
      },
      { syncStatus: result.syncStatus, message: SYNC_QUEUED_MESSAGE },
    );
    refresh();
    return { publishOnline: result.publishOnline, ...after };
  },
);

/** Sync now (manage_inventory): queue a full push and run that job (D86, D87). */
export const syncNowAction = staffAction(
  productIdSchema,
  { name: "shopify.sync_now", permission: "manage_inventory" },
  async ({ productId }, { supabase, correlationId, log }) => {
    // Committed here; what follows only speeds the sync up (D87).
    const jobId = await requestProductSync(supabase, productId);
    const job = { kind: "product_sync" as const, productId, eventId: null };
    const report = await afterCommit(
      "run the sync",
      log,
      async () => describeRun(supabase, job, await runJobById(jobId, defaultDeps(correlationId))),
      {
        title: "Sync queued",
        description: SYNC_QUEUED_MESSAGE,
        tone: "neutral",
        saleNumber: null,
      },
    );
    refresh();
    return report;
  },
);
