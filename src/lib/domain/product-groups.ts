import "server-only";

import { DbError, constraintOf, mapDbError, unwrap } from "@/lib/db-errors";
import type { ServerSupabase } from "@/lib/supabase/server";

import { DomainError } from "./errors";

/**
 * Product groups (D241-D245): several products sold as one style, one
 * Shopify product with a variant per member. Reads go through RLS (any
 * staff member); writes are plain inserts and updates under RLS
 * (manage_inventory) whose rules the database enforces
 * (products_group_rules, product_groups_enforce_rules).
 */

export const GROUP_NOT_FOUND = "That group no longer exists. Refresh and try again.";

export type ProductGroupSummary = {
  id: string;
  shortId: string;
  name: string;
  optionName: string;
  brand: string | null;
  archived: boolean;
  memberCount: number;
};

export type ProductGroupMember = {
  id: string;
  shortId: string;
  name: string;
  sku: string | null;
  optionValue: string;
  archived: boolean;
  onShopify: boolean;
};

export type ProductGroup = ProductGroupSummary & {
  description: string | null;
  onShopify: boolean;
  members: ProductGroupMember[];
};

export type ProductGroupInput = {
  name: string;
  description: string | null;
  brand: string | null;
  optionName: string;
};

const GROUP_FIELDS: Record<string, string> = {
  product_groups_name_length: "name",
  product_groups_description_length: "description",
  product_groups_brand_length: "brand",
  product_groups_option_name_length: "optionName",
};

const MEMBER_FIELDS: Record<string, string> = {
  products_group_option_value_key: "optionValue",
  products_option_value_length: "optionValue",
  products_group_option_pair: "optionValue",
  product_group_archived: "groupId",
  product_group_shopify_linked: "groupId",
};

function rethrowFields(err: unknown, fields: Record<string, string>): never {
  if (err instanceof DbError) {
    const mapped = mapDbError(err);
    const field = mapped.reason ? fields[mapped.reason] : undefined;
    if (field && mapped.kind !== "unknown" && mapped.kind !== "unavailable") {
      throw new DomainError(mapped.message, { [field]: [mapped.message] });
    }
  }
  throw err;
}

type GroupRow = {
  id: string;
  short_id: string;
  name: string;
  description: string | null;
  brand: string | null;
  option_name: string;
  shopify_product_id: string | null;
  archived_at: string | null;
};

const GROUP_COLUMNS =
  "id, short_id, name, description, brand, option_name, shopify_product_id, archived_at";

/** Every group, live ones first by name, with how many live products each holds. */
export async function listProductGroups(
  supabase: ServerSupabase,
  { includeArchived = false }: { includeArchived?: boolean } = {},
): Promise<ProductGroupSummary[]> {
  let query = supabase.from("product_groups").select(GROUP_COLUMNS).order("name").limit(500);
  if (!includeArchived) query = query.is("archived_at", null);
  const groups = (unwrap(await query) ?? []) as GroupRow[];
  if (groups.length === 0) return [];
  const members =
    unwrap(
      await supabase
        .from("products")
        .select("product_group_id")
        .in(
          "product_group_id",
          groups.map((g) => g.id),
        )
        .is("archived_at", null),
    ) ?? [];
  const counts = new Map<string, number>();
  for (const m of members as { product_group_id: string | null }[]) {
    if (m.product_group_id)
      counts.set(m.product_group_id, (counts.get(m.product_group_id) ?? 0) + 1);
  }
  return groups.map((g) => ({
    id: g.id,
    shortId: g.short_id,
    name: g.name,
    optionName: g.option_name,
    brand: g.brand,
    archived: g.archived_at !== null,
    memberCount: counts.get(g.id) ?? 0,
  }));
}

/** One group and its products (archived ones last), or null. */
export async function getProductGroup(
  supabase: ServerSupabase,
  id: string,
): Promise<ProductGroup | null> {
  const group = unwrap(
    await supabase.from("product_groups").select(GROUP_COLUMNS).eq("id", id).maybeSingle(),
  ) as GroupRow | null;
  if (!group) return null;
  const rows =
    (unwrap(
      await supabase
        .from("products")
        .select(
          "id, short_id, name, sku, option_value, archived_at, shopify_variant_id, created_at",
        )
        .eq("product_group_id", id)
        .order("created_at")
        .order("short_id"),
    ) as
      | {
          id: string;
          short_id: string;
          name: string;
          sku: string | null;
          option_value: string | null;
          archived_at: string | null;
          shopify_variant_id: string | null;
        }[]
      | null) ?? [];
  const members = rows
    .map((r) => ({
      id: r.id,
      shortId: r.short_id,
      name: r.name,
      sku: r.sku,
      optionValue: r.option_value ?? "",
      archived: r.archived_at !== null,
      onShopify: r.shopify_variant_id !== null,
    }))
    .sort((a, b) => Number(a.archived) - Number(b.archived));
  return {
    id: group.id,
    shortId: group.short_id,
    name: group.name,
    description: group.description,
    brand: group.brand,
    optionName: group.option_name,
    archived: group.archived_at !== null,
    onShopify: group.shopify_product_id !== null,
    memberCount: members.filter((m) => !m.archived).length,
    members,
  };
}

const groupRow = (input: ProductGroupInput) => ({
  name: input.name,
  description: input.description,
  brand: input.brand,
  option_name: input.optionName,
});

/** Creates a group; the form's id is the idempotency key (a pkey conflict is the earlier save). */
export async function createProductGroup(
  supabase: ServerSupabase,
  id: string,
  input: ProductGroupInput,
): Promise<{ id: string }> {
  const { error } = await supabase.from("product_groups").insert({ id, ...groupRow(input) });
  if (error) {
    if (error.code === "23505" && constraintOf(error) === "product_groups_pkey") return { id };
    rethrowFields(new DbError(error), GROUP_FIELDS);
  }
  return { id };
}

/** Edits a group's name, description, brand and option name (every member re-syncs). */
export async function updateProductGroup(
  supabase: ServerSupabase,
  id: string,
  input: ProductGroupInput,
): Promise<void> {
  const { data, error } = await supabase
    .from("product_groups")
    .update(groupRow(input))
    .eq("id", id)
    .select("id")
    .maybeSingle();
  if (error) rethrowFields(new DbError(error), GROUP_FIELDS);
  if (!data) throw new DomainError(GROUP_NOT_FOUND);
}

/** Archive or unarchive; a group with live products refuses (product_group_has_members). */
export async function setProductGroupArchived(
  supabase: ServerSupabase,
  id: string,
  archived: boolean,
): Promise<void> {
  const { data, error } = await supabase
    .from("product_groups")
    .update({ archived_at: archived ? new Date().toISOString() : null })
    .eq("id", id)
    .select("id")
    .maybeSingle();
  if (error) throw new DbError(error);
  if (!data) throw new DomainError(GROUP_NOT_FOUND);
}

/**
 * Puts a product in a group with its option value, changes its option
 * value, or takes it out (groupId null). The database refuses a product
 * already on Shopify changing group, an archived group and a duplicate
 * option value.
 */
export async function setProductGroup(
  supabase: ServerSupabase,
  productId: string,
  groupId: string | null,
  optionValue: string | null,
): Promise<void> {
  const { data, error } = await supabase
    .from("products")
    .update({
      product_group_id: groupId,
      option_value: groupId ? optionValue : null,
    })
    .eq("id", productId)
    .select("id")
    .maybeSingle();
  if (error) rethrowFields(new DbError(error), MEMBER_FIELDS);
  if (!data) throw new DomainError("That product no longer exists. Refresh and try again.");
}

export type ProductMembership = {
  groupId: string;
  shortId: string;
  name: string;
  optionName: string;
  optionValue: string;
};

/** The product's group and option value, and whether it is on Shopify (its group then stays, D242). */
export async function getProductGrouping(
  supabase: ServerSupabase,
  productId: string,
): Promise<{ membership: ProductMembership | null; onShopify: boolean }> {
  const row = unwrap(
    await supabase
      .from("products")
      .select("product_group_id, option_value, shopify_product_id, shopify_variant_id")
      .eq("id", productId)
      .maybeSingle(),
  ) as {
    product_group_id: string | null;
    option_value: string | null;
    shopify_product_id: string | null;
    shopify_variant_id: string | null;
  } | null;
  const onShopify = Boolean(row?.shopify_product_id || row?.shopify_variant_id);
  if (!row?.product_group_id) return { membership: null, onShopify };
  const group = unwrap(
    await supabase
      .from("product_groups")
      .select("id, short_id, name, option_name")
      .eq("id", row.product_group_id)
      .maybeSingle(),
  ) as { id: string; short_id: string; name: string; option_name: string } | null;
  if (!group) return { membership: null, onShopify };
  return {
    membership: {
      groupId: group.id,
      shortId: group.short_id,
      name: group.name,
      optionName: group.option_name,
      optionValue: row.option_value ?? "",
    },
    onShopify,
  };
}
