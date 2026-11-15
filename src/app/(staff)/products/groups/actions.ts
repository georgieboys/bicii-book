"use server";

import { refresh } from "next/cache";

import { staffAction } from "@/lib/actions";
import {
  createProductGroup,
  setProductGroup,
  setProductGroupArchived,
  updateProductGroup,
} from "@/lib/domain/product-groups";
import {
  groupArchiveSchema,
  productGroupSchema,
  productMembershipSchema,
} from "@/lib/product-group-forms";

/**
 * Product groups (D241-D245): manage_inventory creates, edits and archives
 * groups and puts products in them. RLS and the triggers check again.
 */

export const createProductGroupAction = staffAction(
  productGroupSchema,
  { name: "product_groups.create", permission: "manage_inventory" },
  async ({ id, ...input }, { supabase }) => {
    const result = await createProductGroup(supabase, id, input);
    refresh();
    return result;
  },
);

export const updateProductGroupAction = staffAction(
  productGroupSchema,
  { name: "product_groups.update", permission: "manage_inventory" },
  async ({ id, ...input }, { supabase }) => {
    await updateProductGroup(supabase, id, input);
    refresh();
    return { id };
  },
);

export const setProductGroupArchivedAction = staffAction(
  groupArchiveSchema,
  { name: "product_groups.set_archived", permission: "manage_inventory" },
  async ({ id, archived }, { supabase }) => {
    await setProductGroupArchived(supabase, id, archived);
    refresh();
    return null;
  },
);

export const setProductGroupAction = staffAction(
  productMembershipSchema,
  { name: "product_groups.set_member", permission: "manage_inventory" },
  async ({ productId, groupId, optionValue }, { supabase }) => {
    await setProductGroup(supabase, productId, groupId, optionValue);
    refresh();
    return null;
  },
);
