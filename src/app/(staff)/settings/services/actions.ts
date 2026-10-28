"use server";

import { refresh } from "next/cache";
import { z } from "zod";

import { ActionError, staffAction } from "@/lib/actions";
import { hasPermission } from "@/lib/auth/permissions";
import { percentToRate } from "@/lib/cult-commons";
import { fromShopLocal } from "@/lib/dates";
import {
  cancelCultCommonsRate as cancelRate,
  createCategory as createOneCategory,
  createService as createOneService,
  scheduleCultCommonsRate as scheduleRate,
  setCategoryArchived as archiveCategory,
  setServiceArchived as archiveService,
  updateCategory as renameCategory,
  updateService as updateOneService,
} from "@/lib/domain/services";
import { Decimal, parseMoney, toMoneyString } from "@/lib/money";

/**
 * Services settings (SPEC §9, §10): services and categories for
 * manage_inventory holders (a service's cost also needs view_costs, D14),
 * Cult Commons rates for admins (D21). The RPCs and RLS check again.
 */

const MAX_MONEY = new Decimal("9999999.99");

const money = (what: string) =>
  z
    .string({ error: `Enter the ${what}.` })
    .trim()
    .min(1, { error: `Enter the ${what}.` })
    .refine((v) => parseMoney(v) !== null, {
      error: `Enter the ${what} as an amount of 0 or more, like 120.00.`,
      abort: true,
    })
    .refine((v) => parseMoney(v)!.lte(MAX_MONEY), {
      error: `The ${what} can be at most $9,999,999.99.`,
    })
    .transform((v) => toMoneyString(parseMoney(v)!));

/** A switch inside a form: "on" when on, absent when off. */
const toggle = z
  .union([z.literal("on"), z.literal("true"), z.literal("false"), z.boolean()])
  .optional()
  .transform((v) => v === "on" || v === "true" || v === true);

const serviceSchema = z.object({
  id: z.guid({ error: "Open the form again." }),
  name: z
    .string({ error: "Name the service." })
    .trim()
    .min(1, { error: "Name the service." })
    .max(120, { error: "Keep the name under 120 characters." }),
  categoryId: z
    .union([z.guid({ error: "Choose a category from the list." }), z.literal("")])
    .optional()
    .transform((v) => v || null),
  salePrice: money("price"),
  description: z
    .string()
    .trim()
    .max(1_000, { error: "Keep the description under 1,000 characters." })
    .optional()
    .transform((v) => v || null),
  cost: z
    .preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      money("cost").optional(),
    )
    .transform((v) => v ?? null),
  active: toggle,
  public: toggle,
});

function requireCost(staff: Parameters<typeof hasPermission>[0], cost: string | null) {
  if (cost !== null && !hasPermission(staff, "view_costs")) {
    throw new ActionError("You can't set a cost.", {
      cost: ["Only staff who can view costs can enter one."],
    });
  }
}

/** A new service; the form's id is the idempotency key. */
export const createService = staffAction(
  serviceSchema,
  { name: "services.create", permission: "manage_inventory" },
  async (input, { supabase, staff }) => {
    requireCost(staff, input.cost);
    const result = await createOneService(supabase, input);
    refresh();
    return result;
  },
);

/** Edit a service; a blank cost keeps the current one. Existing job lines never change. */
export const updateService = staffAction(
  serviceSchema,
  { name: "services.update", permission: "manage_inventory" },
  async (input, { supabase, staff }) => {
    requireCost(staff, input.cost);
    const result = await updateOneService(supabase, input);
    refresh();
    return result;
  },
);

/** Archive or unarchive a service (hidden from pickers; history keeps it). */
export const setServiceArchived = staffAction(
  z.object({ id: z.guid({ error: "Unknown service." }), archived: z.boolean() }),
  { name: "services.set_archived", permission: "manage_inventory" },
  async (input, { supabase }) => {
    const result = await archiveService(supabase, input);
    refresh();
    return result;
  },
);

const categoryName = z
  .string({ error: "Name the category." })
  .trim()
  .min(1, { error: "Name the category." })
  .max(80, { error: "Keep the name under 80 characters." });

/** Service categories (Settings → Services) or product categories (Settings → Product categories). */
const categoryKind = z.enum(["service", "product"], { error: "Unknown kind of category." });

/** A new service or product category. */
export const createCategory = staffAction(
  z.object({
    id: z.guid({ error: "Open the form again." }),
    name: categoryName,
    kind: categoryKind,
  }),
  { name: "categories.create", permission: "manage_inventory" },
  async (input, { supabase }) => {
    const result = await createOneCategory(supabase, input);
    refresh();
    return result;
  },
);

/** Rename a service or product category. */
export const updateCategory = staffAction(
  z.object({ id: z.guid({ error: "Unknown category." }), name: categoryName, kind: categoryKind }),
  { name: "categories.update", permission: "manage_inventory" },
  async (input, { supabase }) => {
    const result = await renameCategory(supabase, input);
    refresh();
    return result;
  },
);

/** Archive or bring back a service or product category. */
export const setCategoryArchived = staffAction(
  z.object({
    id: z.guid({ error: "Unknown category." }),
    archived: z.boolean(),
    kind: categoryKind,
  }),
  { name: "categories.set_archived", permission: "manage_inventory" },
  async (input, { supabase }) => {
    const result = await archiveCategory(supabase, input);
    refresh();
    return result;
  },
);

/**
 * Admin: a new Cult Commons rate from now or a later shop-local time
 * (D21). The percentage converts exactly to a 4-decimal fraction.
 */
export const scheduleCultCommonsRate = staffAction(
  z
    .object({
      rateId: z.guid({ error: "Open the rate sheet again." }),
      percent: z
        .string({ error: "Enter the rate." })
        .trim()
        .min(1, { error: "Enter the rate." })
        .refine((v) => percentToRate(v) !== null, {
          error: "Enter a percentage from 0 to 100 with at most two decimals, like 30 or 27.5.",
        })
        .transform((v) => percentToRate(v)!),
      when: z.enum(["now", "later"], { error: "Choose when it starts." }),
      effectiveFrom: z.string().trim().optional(),
    })
    .transform((v, ctx) => {
      if (v.when === "now") return { rateId: v.rateId, rate: v.percent, effectiveFrom: null };
      const at = v.effectiveFrom ? fromShopLocal(v.effectiveFrom) : null;
      if (!at) {
        ctx.addIssue({
          code: "custom",
          path: ["effectiveFrom"],
          message: "Choose the date and time it starts.",
        });
        return z.NEVER;
      }
      if (at.getTime() <= Date.now()) {
        ctx.addIssue({
          code: "custom",
          path: ["effectiveFrom"],
          message: "Choose a time in the future, or start it now.",
        });
        return z.NEVER;
      }
      return { rateId: v.rateId, rate: v.percent, effectiveFrom: at };
    }),
  { name: "cult_commons.schedule", admin: true },
  async (input, { supabase }) => {
    const result = await scheduleRate(supabase, input);
    refresh();
    return result;
  },
);

/** Admin: withdraw a rate that has not started yet (D21). */
export const cancelCultCommonsRate = staffAction(
  z.object({ rateId: z.guid({ error: "Unknown rate." }) }),
  { name: "cult_commons.cancel", admin: true },
  async (input, { supabase }) => {
    const result = await cancelRate(supabase, input);
    refresh();
    return result;
  },
);
