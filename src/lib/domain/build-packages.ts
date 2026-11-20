import "server-only";

import type { Database } from "@/lib/database.types";
import { DbError, constraintOf, mapDbError, unwrap } from "@/lib/db-errors";
import { toMoneyString } from "@/lib/money";
import type { ServerSupabase } from "@/lib/supabase/server";

import { DomainError } from "./errors";

/**
 * Build packages (D246-D251). A full build is sold at one price: its labour
 * amount is the job's labour line (service revenue) and the rest is the
 * parts budget, which the job's parts are priced to fit (product revenue).
 * Admins write packages under RLS; the job RPCs do the rest. Money leaves
 * here as fixed-point strings, as in lines.ts.
 */

export type BuildPackageKind = Database["public"]["Enums"]["build_package_kind"];
export type BuildFrameSource = Database["public"]["Enums"]["build_frame_source"];

/** D257: the three frame options, in the order Shopify and the site show them. */
export const FRAME_SOURCES: BuildFrameSource[] = ["bicii_frame", "own_frame", "donor_bike"];

export const FRAME_SOURCE_LABEL: Record<BuildFrameSource, string> = {
  bicii_frame: "Prepared frame from BICII",
  own_frame: "Customer's own prepared frame",
  donor_bike: "Donor bike",
};

export const BUILD_KIND_LABEL: Record<BuildPackageKind, string> = {
  full_build: "Full build",
  build_only: "Build only",
};

export type BuildPackage = {
  id: string;
  kind: BuildPackageKind;
  name: string;
  description: string | null;
  price: string;
  priceIsFrom: boolean;
  labourAmount: string;
  labourServiceId: string;
  currency: string;
  public: boolean;
  sortOrder: number;
  archived: boolean;
  /** D252: sold on Shopify (ACTIVE) and its Shopify product, once pushed. */
  publishOnline: boolean;
  shopifyProductId: string | null;
  /** D257: the Shopify variant of each frame option, once pushed. */
  shopifyVariantIds: Record<BuildFrameSource, string | null>;
  /** D257: the service a donor bike's strip is charged as; null: no donor option. */
  donorServiceId: string | null;
  /** D259: the package's picture, pushed as its Shopify media. */
  imageUrl: string | null;
};

export type BuildPackageInput = {
  kind: BuildPackageKind;
  name: string;
  description: string | null;
  price: string;
  priceIsFrom: boolean;
  labourAmount: string;
  labourServiceId: string;
  public: boolean;
  sortOrder: number;
  donorServiceId: string | null;
  imageUrl: string | null;
};

const PACKAGE_COLUMNS =
  "id, kind, name, description, price, price_is_from, labour_amount, labour_service_id, currency, public, sort_order, archived_at, publish_online, shopify_product_id, shopify_variant_id, shopify_own_frame_variant_id, shopify_donor_variant_id, donor_service_id, image_url";

type PackageRow = {
  id: string;
  kind: BuildPackageKind;
  name: string;
  description: string | null;
  price: number;
  price_is_from: boolean;
  labour_amount: number;
  labour_service_id: string;
  currency: string;
  public: boolean;
  sort_order: number;
  archived_at: string | null;
  publish_online: boolean;
  shopify_product_id: string | null;
  shopify_variant_id: string | null;
  shopify_own_frame_variant_id: string | null;
  shopify_donor_variant_id: string | null;
  donor_service_id: string | null;
  image_url: string | null;
};

const toPackage = (r: PackageRow): BuildPackage => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  description: r.description,
  price: toMoneyString(r.price),
  priceIsFrom: r.price_is_from,
  labourAmount: toMoneyString(r.labour_amount),
  labourServiceId: r.labour_service_id,
  currency: r.currency,
  public: r.public,
  sortOrder: r.sort_order,
  archived: r.archived_at !== null,
  publishOnline: r.publish_online,
  shopifyProductId: r.shopify_product_id,
  shopifyVariantIds: {
    bicii_frame: r.shopify_variant_id,
    own_frame: r.shopify_own_frame_variant_id,
    donor_bike: r.shopify_donor_variant_id,
  },
  donorServiceId: r.donor_service_id,
  imageUrl: r.image_url,
});

const FIELDS: Record<string, string> = {
  build_packages_name_key: "name",
  build_packages_name_length: "name",
  build_packages_description_length: "description",
  build_packages_price_positive: "price",
  build_packages_labour_within_price: "labourAmount",
  build_packages_sort_order_range: "sortOrder",
  build_labour_service_invalid: "labourServiceId",
  build_packages_image_url_https: "imageUrl",
  build_packages_donor_service_id_fkey: "donorServiceId",
};

function rethrowFields(err: unknown): never {
  if (err instanceof DbError) {
    const mapped = mapDbError(err);
    const field = mapped.reason ? FIELDS[mapped.reason] : undefined;
    if (field && mapped.kind !== "unknown" && mapped.kind !== "unavailable") {
      throw new DomainError(mapped.message, { [field]: [mapped.message] });
    }
  }
  throw err;
}

/** Packages by kind, sort order and price; archived ones only when asked. */
export async function listBuildPackages(
  supabase: ServerSupabase,
  { includeArchived = false }: { includeArchived?: boolean } = {},
): Promise<BuildPackage[]> {
  let query = supabase
    .from("build_packages")
    .select(PACKAGE_COLUMNS)
    .order("kind")
    .order("sort_order")
    .order("price")
    .order("name");
  if (!includeArchived) query = query.is("archived_at", null);
  return ((unwrap(await query) ?? []) as PackageRow[]).map(toPackage);
}

const row = (input: BuildPackageInput) => ({
  kind: input.kind,
  name: input.name,
  description: input.description,
  price: Number(input.price),
  price_is_from: input.priceIsFrom,
  labour_amount: Number(input.labourAmount),
  labour_service_id: input.labourServiceId,
  public: input.public,
  sort_order: input.sortOrder,
  donor_service_id: input.donorServiceId,
  image_url: input.imageUrl,
});

/** Creates a package; the form's id is the idempotency key. */
export async function createBuildPackage(
  supabase: ServerSupabase,
  id: string,
  input: BuildPackageInput,
): Promise<{ id: string }> {
  const { error } = await supabase.from("build_packages").insert({ id, ...row(input) });
  if (error) {
    if (error.code === "23505" && constraintOf(error) === "build_packages_pkey") return { id };
    rethrowFields(new DbError(error));
  }
  return { id };
}

export async function updateBuildPackage(
  supabase: ServerSupabase,
  id: string,
  input: BuildPackageInput,
): Promise<void> {
  const { data, error } = await supabase
    .from("build_packages")
    .update(row(input))
    .eq("id", id)
    .select("id")
    .maybeSingle();
  if (error) rethrowFields(new DbError(error));
  if (!data) throw new DomainError("That package no longer exists. Refresh and try again.");
}

export async function setBuildPackageArchived(
  supabase: ServerSupabase,
  id: string,
  archived: boolean,
): Promise<void> {
  const { data, error } = await supabase
    .from("build_packages")
    .update({ archived_at: archived ? new Date().toISOString() : null })
    .eq("id", id)
    .select("id")
    .maybeSingle();
  if (error) throw new DbError(error);
  if (!data) throw new DomainError("That package no longer exists. Refresh and try again.");
}

// ---------------------------------------------------------------------------
// A job's build (D247-D249)
// ---------------------------------------------------------------------------

export type JobBuild = {
  packageId: string;
  name: string;
  kind: BuildPackageKind;
  price: string;
  labourAmount: string;
  partsBudget: string;
  labourLineId: string;
  partsCount: number;
  partsListTotal: string;
  partsTotal: string;
  labourTotal: string | null;
  packageTotal: string;
  /** price − package total: "0.00" when fitted. */
  difference: string;
  currency: string;
  /** Each live part's list price (its price before the first repricing). */
  listPrices: Record<string, string>;
};

/** The job's build and its numbers, or null without a package. */
export async function getJobBuild(
  supabase: ServerSupabase,
  workOrderId: string,
): Promise<JobBuild | null> {
  const summary = unwrap(
    await supabase
      .from("work_order_build_summary")
      .select(
        "build_package_id, name, kind, price, labour_amount, parts_budget, labour_line_id, parts_count, parts_list_total, parts_total, labour_total, package_total, difference, currency",
      )
      .eq("work_order_id", workOrderId)
      .maybeSingle(),
  );
  if (!summary) return null;
  const lists =
    (unwrap(
      await supabase
        .from("work_order_line_items")
        .select("id, unit_sale_price_snapshot, unit_list_price_snapshot")
        .eq("work_order_id", workOrderId)
        .is("voided_at", null),
    ) as
      | { id: string; unit_sale_price_snapshot: number; unit_list_price_snapshot: number | null }[]
      | null) ?? [];
  return {
    packageId: summary.build_package_id!,
    name: summary.name!,
    kind: summary.kind!,
    price: toMoneyString(summary.price!),
    labourAmount: toMoneyString(summary.labour_amount!),
    partsBudget: toMoneyString(summary.parts_budget!),
    labourLineId: summary.labour_line_id!,
    partsCount: summary.parts_count ?? 0,
    partsListTotal: toMoneyString(summary.parts_list_total ?? 0),
    partsTotal: toMoneyString(summary.parts_total ?? 0),
    labourTotal: summary.labour_total === null ? null : toMoneyString(summary.labour_total),
    packageTotal: toMoneyString(summary.package_total ?? 0),
    difference: toMoneyString(summary.difference ?? 0),
    currency: summary.currency ?? "SGD",
    listPrices: Object.fromEntries(
      lists.map((l) => [
        l.id,
        toMoneyString(l.unit_list_price_snapshot ?? l.unit_sale_price_snapshot),
      ]),
    ),
  };
}

export async function setJobBuild(
  supabase: ServerSupabase,
  workOrderId: string,
  packageId: string,
  labourLineId: string,
  price: string | null,
): Promise<void> {
  const { error } = await supabase.rpc("set_work_order_build", {
    work_order_id: workOrderId,
    build_package_id: packageId,
    labour_line_id: labourLineId,
    ...(price === null ? {} : { price: Number(price) }),
  });
  if (error) {
    const err = new DbError(error);
    const mapped = mapDbError(err);
    if (mapped.reason === "build_price_fixed" || mapped.reason === "build_price_below_from") {
      throw new DomainError(mapped.message, { price: [mapped.message] });
    }
    throw err;
  }
}

export async function clearJobBuild(
  supabase: ServerSupabase,
  workOrderId: string,
  reason: string,
): Promise<void> {
  const { error } = await supabase.rpc("clear_work_order_build", {
    work_order_id: workOrderId,
    reason,
  });
  if (error) {
    const err = new DbError(error);
    const mapped = mapDbError(err);
    if (mapped.reason === "reason_required" || mapped.reason === "reason_too_long") {
      throw new DomainError(mapped.message, { reason: [mapped.message] });
    }
    throw err;
  }
}

export async function repriceBuildLine(
  supabase: ServerSupabase,
  lineId: string,
  price: string,
): Promise<void> {
  const { error } = await supabase.rpc("reprice_build_line", {
    line_id: lineId,
    unit_sale_price: Number(price),
  });
  if (error) throw new DbError(error);
}

export async function fitBuildToBudget(
  supabase: ServerSupabase,
  workOrderId: string,
): Promise<void> {
  const { error } = await supabase.rpc("fit_build_to_budget", { work_order_id: workOrderId });
  if (error) throw new DbError(error);
}

/** One package by id, or null. */
export async function getBuildPackage(
  supabase: ServerSupabase,
  id: string,
): Promise<BuildPackage | null> {
  const row = unwrap(
    await supabase.from("build_packages").select(PACKAGE_COLUMNS).eq("id", id).maybeSingle(),
  ) as PackageRow | null;
  return row ? toPackage(row) : null;
}

/** D252: on or off Shopify (an admin; the push follows). */
export async function setBuildPackageOnline(
  supabase: ServerSupabase,
  id: string,
  publishOnline: boolean,
): Promise<void> {
  const { data, error } = await supabase
    .from("build_packages")
    .update({ publish_online: publishOnline })
    .eq("id", id)
    .select("id")
    .maybeSingle();
  if (error) throw new DbError(error);
  if (!data) throw new DomainError("That package no longer exists. Refresh and try again.");
}

/** D257: a package's Shopify prices, from Postgres (money arithmetic stays there). */
export type OnlinePrices = {
  price: string;
  /** Null: no active donor service, so no donor-bike option online. */
  donor: { serviceId: string; amount: string; price: string } | null;
};

export async function getOnlinePrices(
  supabase: ServerSupabase,
  id: string,
): Promise<OnlinePrices | null> {
  const rows = unwrap(
    await supabase.rpc("build_package_online_prices", { build_package_id: id }),
  ) as
    | {
        price: number;
        donor_service_id: string | null;
        donor_amount: number | null;
        donor_price: number | null;
      }[]
    | null;
  const r = rows?.[0];
  if (!r) return null;
  return {
    price: toMoneyString(r.price),
    donor:
      r.donor_service_id && r.donor_amount !== null && r.donor_price !== null
        ? {
            serviceId: r.donor_service_id,
            amount: toMoneyString(r.donor_amount),
            price: toMoneyString(r.donor_price),
          }
        : null,
  };
}

export async function recordBuildPackagePush(
  supabase: ServerSupabase,
  id: string,
  push: {
    productId: string;
    variantIds: Record<BuildFrameSource, string | null>;
    donorAmount: string | null;
  },
): Promise<void> {
  const { error } = await supabase.rpc("record_build_package_push", {
    build_package_id: id,
    shopify_product_id: push.productId,
    shopify_variant_id: push.variantIds.bicii_frame!,
    shopify_own_frame_variant_id: push.variantIds.own_frame ?? undefined,
    shopify_donor_variant_id: push.variantIds.donor_bike ?? undefined,
    shopify_donor_amount: push.variantIds.donor_bike ? (push.donorAmount ?? undefined) : undefined,
  });
  if (error) throw new DbError(error);
}

// ---------------------------------------------------------------------------
// Online build orders (D253-D255)
// ---------------------------------------------------------------------------

export type BuildOrder = {
  id: string;
  orderName: string | null;
  packageId: string;
  packageName: string;
  amount: string;
  currency: string;
  customerId: string | null;
  workOrderId: string | null;
  createdAt: string;
  /** D257: the frame option bought. */
  frameSource: BuildFrameSource;
  /** D258: the donor strip's share of amount ("0.00" unless a donor bike). */
  donorAmount: string;
};

type OrderRow = {
  id: string;
  shopify_order_name: string | null;
  build_package_id: string;
  amount: number;
  currency: string;
  customer_id: string | null;
  work_order_id: string | null;
  created_at: string;
  frame_source: BuildFrameSource;
  donor_amount: number;
  build_packages: { name: string } | null;
};

const toOrder = (r: OrderRow): BuildOrder => ({
  id: r.id,
  orderName: r.shopify_order_name,
  packageId: r.build_package_id,
  packageName: r.build_packages?.name ?? "Build",
  amount: toMoneyString(r.amount),
  currency: r.currency,
  customerId: r.customer_id,
  workOrderId: r.work_order_id,
  createdAt: r.created_at,
  frameSource: r.frame_source,
  donorAmount: toMoneyString(r.donor_amount),
});

const ORDER_COLUMNS =
  "id, shopify_order_name, build_package_id, amount, currency, customer_id, work_order_id, created_at, frame_source, donor_amount, build_packages(name)";

/** Online build orders not on a job yet, oldest first. */
export async function listUnlinkedBuildOrders(supabase: ServerSupabase): Promise<BuildOrder[]> {
  const rows = unwrap(
    await supabase
      .from("build_orders")
      .select(ORDER_COLUMNS)
      .is("work_order_id", null)
      .order("created_at")
      .limit(100),
  ) as OrderRow[] | null;
  return (rows ?? []).map(toOrder);
}

/** The online build order on this job, or null. */
export async function getJobBuildOrder(
  supabase: ServerSupabase,
  workOrderId: string,
): Promise<BuildOrder | null> {
  const row = unwrap(
    await supabase
      .from("build_orders")
      .select(ORDER_COLUMNS)
      .eq("work_order_id", workOrderId)
      .maybeSingle(),
  ) as OrderRow | null;
  return row ? toOrder(row) : null;
}

export async function linkBuildOrder(
  supabase: ServerSupabase,
  buildOrderId: string,
  workOrderId: string,
  labourLineId: string,
  donorLineId: string,
): Promise<void> {
  const { error } = await supabase.rpc("link_build_order", {
    build_order_id: buildOrderId,
    work_order_id: workOrderId,
    labour_line_id: labourLineId,
    donor_line_id: donorLineId,
  });
  if (error) throw new DbError(error);
}
