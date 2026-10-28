"use server";

import { refresh } from "next/cache";
import { z } from "zod";

import { staffAction } from "@/lib/actions";
import {
  createLocation as createOneLocation,
  setLocationActive as setActive,
  updateLocation as updateOneLocation,
} from "@/lib/domain/inventory";
import { locationSchema } from "@/lib/inventory-forms";

/**
 * Stock locations (SPEC §11, §12; Settings → Locations): manage_inventory
 * adds, renames and reorders them and switches them on or off. RLS and the
 * locations trigger check again; a location still holding stock cannot be
 * deactivated (location_has_stock).
 */

/** A new location; the form's id is the idempotency key. */
export const createLocation = staffAction(
  locationSchema,
  { name: "locations.create", permission: "manage_inventory" },
  async (input, { supabase }) => {
    const result = await createOneLocation(supabase, input);
    refresh();
    return result;
  },
);

/** Rename a location, or change its kind or sort order. */
export const updateLocation = staffAction(
  locationSchema,
  { name: "locations.update", permission: "manage_inventory" },
  async (input, { supabase }) => {
    await updateOneLocation(supabase, input);
    refresh();
    return { id: input.id };
  },
);

/** Activate or deactivate a location (applied at once from its switch). */
export const setLocationActive = staffAction(
  z.object({ id: z.guid({ error: "Unknown location." }), active: z.boolean() }),
  { name: "locations.set_active", permission: "manage_inventory" },
  async ({ id, active }, { supabase }) => {
    await setActive(supabase, id, active);
    refresh();
    return null;
  },
);
