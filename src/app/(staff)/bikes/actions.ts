"use server";

import { refresh } from "next/cache";
import { z } from "zod";

import { staffAction } from "@/lib/actions";
import { REASON_MAX_LENGTH } from "@/lib/reasons";
import {
  createBike as create,
  setBikeArchived as setArchived,
  transferBike as transfer,
  updateBike as update,
} from "@/lib/domain/bikes";

/** Optional text: trimmed, at most `max` characters, blank stored as null. */
const text = (max: number, what: string) =>
  z
    .string()
    .trim()
    .max(max, { error: `Keep the ${what} under ${max.toLocaleString("en-SG")} characters.` })
    .optional()
    .transform((v) => (v ? v : null));

const required = (max: number, what: string) =>
  z
    .string({ error: `Enter the ${what}.` })
    .trim()
    .min(1, { error: `Enter the ${what}.` })
    .max(max, { error: `Keep the ${what} under ${max} characters.` });

/** A customer picker's hidden input: a customer id, or empty for none. */
const optionalCustomer = z
  .union([z.guid({ error: "Choose a customer from the list." }), z.literal(""), z.null()])
  .optional()
  .transform((v) => v || null);

const bikeFields = {
  /** New bike: the form's idempotency key. Edit: the bike. */
  id: z.guid({ error: "Unknown bike." }),
  brand: required(100, "brand"),
  model: required(100, "model"),
  variant: text(100, "variant"),
  frameSize: text(40, "frame size"),
  colour: text(60, "colour"),
  serialNumber: text(100, "serial number"),
  description: text(2_000, "description"),
  internalNotes: text(10_000, "notes"),
};

/**
 * Register a bike, to a customer or to nobody (shop or consigned bikes).
 * The database assigns its B- short ID.
 */
export const createBike = staffAction(
  z.object({ ...bikeFields, customerId: optionalCustomer }),
  { name: "bikes.create" },
  async ({ id, ...input }, { supabase }) => create(supabase, id, input),
);

/** Edit what a bike is; its owner changes only by transfer, its short ID never. */
export const updateBike = staffAction(
  z.object(bikeFields),
  { name: "bikes.update" },
  async ({ id, ...input }, { supabase }) => {
    await update(supabase, id, input);
    refresh();
    return null;
  },
);

export const setBikeArchived = staffAction(
  z.object({ bikeId: z.guid({ error: "Unknown bike." }), archived: z.boolean() }),
  { name: "bikes.set_archived" },
  async ({ bikeId, archived }, { supabase }) => {
    await setArchived(supabase, bikeId, archived);
    refresh();
    return null;
  },
);

/** Hand a bike to another customer or to the shop, with the reason kept in its history. */
export const transferBike = staffAction(
  z.object({
    bikeId: z.guid({ error: "Unknown bike." }),
    toCustomerId: z.guid({ error: "Choose the new owner from the list." }).nullable(),
    reason: z
      .string()
      .trim()
      .min(1, { error: "Say why the bike is changing owner." })
      .max(REASON_MAX_LENGTH, { error: `Keep the reason under ${REASON_MAX_LENGTH} characters.` }),
  }),
  { name: "bikes.transfer" },
  async (input, { supabase }) => {
    await transfer(supabase, input);
    refresh();
    return null;
  },
);
