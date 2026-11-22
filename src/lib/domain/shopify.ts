import "server-only";

import { DbError, unwrap, type DbErrorLike } from "@/lib/db-errors";
import type { Database, Json } from "@/lib/database.types";
import { customerLabel } from "@/lib/people";
import {
  parseUnmappedLines,
  type EventFilter,
  type EventStatus,
  type JobKind,
  type JobStatus,
  type ProductFilter,
  type QueueView,
  type RejectionReason,
  type ShopifyOrigin,
  type SyncStatus,
  type UnmappedLine,
} from "@/lib/shopify";
import type { ShopifySettingsInput } from "@/lib/shopify-forms";
import type { ServerSupabase } from "@/lib/supabase/server";

import { DomainError } from "./errors";
import type { ListPage } from "./list";

/**
 * Shopify, staff side (SPEC §17, §26; DATA-MODEL §13, §15, §16; PLAN
 * D80–D89, ADR-020). A DTO mapper over the RLS client: reads go through
 * the tables and views staff may read, writes only through the staff RPCs.
 *
 * Who reads what (D86): every active staff member reads a product's sync
 * status (shopify_product_sync, reporting.shopify_sync_status, settings);
 * the queue, events, payloads and audit rows are admins' only (they name
 * customers), so for anyone else those reads return nothing. The app runs
 * an integration job only by the id an RPC returned (src/lib/integrations/
 * shopify/queue.ts runJobById), never one it read from the queue.
 *
 * Writes:
 *   set_publish_online(product, publish)     manage_inventory
 *   request_product_sync(product)            manage_inventory
 *   retry_integration_job(job)               admin; manage_inventory for product syncs
 *   dismiss_integration_job(job, reason)     admin
 *   link_shopify_variant(product, gids, why) admin
 *   link_shopify_customer(customer, gid, why) admin
 *   unlink_shopify_customer(customer, why)   admin
 *   set_shopify_settings(location, url, test, why) admin
 */

// ---------------------------------------------------------------------------
// A product's online state (OnlineCard; any active staff)
// ---------------------------------------------------------------------------

export type ProductOnline = {
  publishOnline: boolean;
  syncStatus: SyncStatus;
  origin: ShopifyOrigin | null;
  lastPushedAt: string | null;
  lastPushedQuantity: number | null;
  onlineLocationName: string | null;
  lastError: string | null;
  shopifyProductId: string | null;
  shopifyVariantId: string | null;
};

const origin = (v: string | null | undefined): ShopifyOrigin | null =>
  v === "bicii" || v === "external" ? v : null;

/** A product's Publish online state and sync status; never queue data (D86). */
export async function getProductOnline(
  supabase: ServerSupabase,
  productId: string,
): Promise<ProductOnline> {
  const [syncResult, productResult, settingsResult] = await Promise.all([
    supabase
      .from("shopify_product_sync")
      .select(
        "publish_online, sync_status, shopify_origin, last_pushed_at, last_pushed_quantity, last_error",
      )
      .eq("product_id", productId)
      .maybeSingle(),
    supabase
      .from("products")
      .select("shopify_product_id, shopify_variant_id")
      .eq("id", productId)
      .maybeSingle(),
    supabase
      .from("shopify_settings")
      .select("online_location_id, location:locations(name)")
      .eq("id", 1)
      .maybeSingle(),
  ]);
  const sync = unwrap(syncResult);
  const product = unwrap(productResult);
  const settings = unwrap(settingsResult) as { location: { name: string } | null } | null;
  return {
    publishOnline: sync?.publish_online ?? false,
    syncStatus: sync?.sync_status ?? "not_synced",
    origin: origin(sync?.shopify_origin),
    lastPushedAt: sync?.last_pushed_at ?? null,
    lastPushedQuantity: sync?.last_pushed_quantity ?? null,
    onlineLocationName: settings?.location?.name ?? null,
    lastError: sync?.last_error ?? null,
    shopifyProductId: product?.shopify_product_id ?? null,
    shopifyVariantId: product?.shopify_variant_id ?? null,
  };
}

// ---------------------------------------------------------------------------
// The /shopify overview (admin)
// ---------------------------------------------------------------------------

export type ShopifySettingsDTO = {
  onlineLocationId: string | null;
  storefrontUrl: string | null;
  acceptTestOrders: boolean;
  shopifyLocationId: string | null;
  updatedAt: string | null;
};

export type ShopifyOverview = {
  settings: ShopifySettingsDTO;
  locations: { id: string; name: string }[];
  needsAttention: number;
  waiting: number;
  productsByStatus: Record<SyncStatus, number>;
  eventsLast24h: number;
};

const count = (r: { count: number | null; error: DbErrorLike | null }) => {
  if (r.error) throw new DbError(r.error);
  return r.count ?? 0;
};

export async function getShopifyOverview(supabase: ServerSupabase): Promise<ShopifyOverview> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const [settingsResult, locationsResult, attention, waiting, events, syncResult] =
    await Promise.all([
      supabase
        .from("shopify_settings")
        .select(
          "online_location_id, storefront_url, accept_test_orders, shopify_location_id, updated_at",
        )
        .eq("id", 1)
        .maybeSingle(),
      supabase
        .from("locations")
        .select("id, name, active")
        .order("sort_order", { ascending: true })
        .order("name", { ascending: true }),
      supabase
        .from("integration_retry_queue")
        .select("id", { count: "exact", head: true })
        .eq("status", "needs_attention"),
      supabase
        .from("integration_retry_queue")
        .select("id", { count: "exact", head: true })
        .in("status", ["queued", "running"]),
      supabase
        .from("integration_events")
        .select("id", { count: "exact", head: true })
        .gte("received_at", since),
      supabase.schema("reporting").from("shopify_sync_status").select("sync_status"),
    ]);
  const settings = unwrap(settingsResult);
  const locations = unwrap(locationsResult) ?? [];
  const productsByStatus: Record<SyncStatus, number> = {
    not_synced: 0,
    pending: 0,
    synced: 0,
    error: 0,
    unpublished: 0,
  };
  for (const r of unwrap(syncResult) ?? []) {
    if (r.sync_status) productsByStatus[r.sync_status] += 1;
  }
  return {
    settings: {
      onlineLocationId: settings?.online_location_id ?? null,
      storefrontUrl: settings?.storefront_url ?? null,
      acceptTestOrders: settings?.accept_test_orders ?? false,
      shopifyLocationId: settings?.shopify_location_id ?? null,
      updatedAt: settings?.updated_at ?? null,
    },
    // The current online location stays choosable even when inactive.
    locations: locations
      .filter((l) => l.active || l.id === settings?.online_location_id)
      .map((l) => ({ id: l.id, name: l.active ? l.name : `${l.name} (inactive)` })),
    needsAttention: count(attention),
    waiting: count(waiting),
    productsByStatus,
    eventsLast24h: count(events),
  };
}

// ---------------------------------------------------------------------------
// Synced products (/shopify/products; any staff may read the view)
// ---------------------------------------------------------------------------

export type SyncedProduct = {
  productId: string;
  shortId: string;
  name: string;
  publishOnline: boolean;
  syncStatus: SyncStatus;
  origin: ShopifyOrigin | null;
  lastPushedAt: string | null;
  lastPushedQuantity: number | null;
  lastError: string | null;
};

export async function listSyncedProducts(
  supabase: ServerSupabase,
  { filter, limit = 100 }: { filter: ProductFilter; limit?: number },
): Promise<ListPage<SyncedProduct>> {
  let query = supabase
    .schema("reporting")
    .from("shopify_sync_status")
    .select(
      "product_id, short_id, name, publish_online, sync_status, shopify_origin, last_pushed_at, last_pushed_quantity, last_error",
    );
  if (filter === "errors") query = query.eq("sync_status", "error");
  if (filter === "pending") query = query.eq("sync_status", "pending");
  const rows = unwrap(await query.order("name", { ascending: true }).limit(limit + 1)) ?? [];
  return {
    items: rows.slice(0, limit).map((r) => ({
      productId: r.product_id ?? "",
      shortId: r.short_id ?? "",
      name: r.name ?? "",
      publishOnline: r.publish_online === true,
      syncStatus: r.sync_status ?? "not_synced",
      origin: origin(r.shopify_origin),
      lastPushedAt: r.last_pushed_at,
      lastPushedQuantity: r.last_pushed_quantity,
      lastError: r.last_error,
    })),
    more: rows.length > limit,
  };
}

// ---------------------------------------------------------------------------
// The queue (/shopify/queue; admin)
// ---------------------------------------------------------------------------

export type QueueRow = {
  id: string;
  kind: JobKind;
  topic: string | null;
  status: JobStatus;
  /** "#1042", "Refund … of order …", or the product's short ID and name. */
  subject: string;
  reason: string | null;
  code: string | null;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  resolutionReason: string | null;
  updatedAt: string;
  eventId: string | null;
  productId: string | null;
  unmappedLines: UnmappedLine[];
};

type QueueSelect = Database["public"]["Tables"]["integration_retry_queue"]["Row"] & {
  event: { subject: string | null; topic: string; result: Json } | null;
  product: { short_id: string; name: string } | null;
};

const QUEUE_COLUMNS =
  "id, kind, status, attempts, max_attempts, next_attempt_at, last_error, last_error_code, resolution_reason, resolved_at, updated_at, created_at, integration_event_id, product_id, event:integration_events!integration_retry_queue_integration_event_id_fkey(subject, topic, result), product:products(short_id, name)";

function toQueueRow(r: QueueSelect): QueueRow {
  const subject =
    r.kind === "product_sync"
      ? r.product
        ? `${r.product.short_id} · ${r.product.name}`
        : "A product"
      : (r.event?.subject ?? r.event?.topic ?? "A Shopify event");
  return {
    id: r.id,
    kind: r.kind,
    topic: r.event?.topic ?? null,
    status: r.status,
    subject,
    reason: r.last_error,
    code: r.last_error_code,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    nextAttemptAt: r.status === "queued" ? r.next_attempt_at : null,
    resolutionReason: r.resolution_reason,
    updatedAt: r.updated_at,
    eventId: r.integration_event_id,
    productId: r.product_id,
    unmappedLines:
      r.last_error_code === "shopify_variant_unmapped" ? parseUnmappedLines(r.event?.result) : [],
  };
}

export async function listQueue(
  supabase: ServerSupabase,
  { view, limit = 50 }: { view: QueueView; limit?: number },
): Promise<ListPage<QueueRow>> {
  let query = supabase.from("integration_retry_queue").select(QUEUE_COLUMNS);
  if (view === "attention") {
    query = query.eq("status", "needs_attention").order("updated_at", { ascending: false });
  } else if (view === "waiting") {
    query = query.in("status", ["queued", "running"]).order("next_attempt_at", { ascending: true });
  } else {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    query = query
      .in("status", ["done", "dismissed"])
      .gte("updated_at", since)
      .order("updated_at", { ascending: false });
  }
  const rows = (unwrap(await query.limit(limit + 1)) ?? []) as unknown as QueueSelect[];
  return { items: rows.slice(0, limit).map(toQueueRow), more: rows.length > limit };
}

/** One job (admin), for the Sheet a deep link (?job=) opens; null when unknown. */
export async function getQueueJob(
  supabase: ServerSupabase,
  jobId: string,
): Promise<QueueRow | null> {
  const row = unwrap(
    await supabase
      .from("integration_retry_queue")
      .select(QUEUE_COLUMNS)
      .eq("id", jobId)
      .maybeSingle(),
  ) as unknown as QueueSelect | null;
  return row ? toQueueRow(row) : null;
}

// ---------------------------------------------------------------------------
// Events (/shopify/events; admin)
// ---------------------------------------------------------------------------

export type EventListItem = {
  id: string;
  topic: string;
  subject: string | null;
  status: EventStatus;
  outcome: string | null;
  receivedAt: string;
  deliveryCount: number;
  testDelivery: boolean;
  webhookId: string;
  rejectionReason: RejectionReason | null;
  saleNumber: string | null;
};

type EventListSelect = {
  id: string;
  topic: string;
  subject: string | null;
  status: EventStatus;
  outcome: string | null;
  received_at: string;
  delivery_count: number;
  test_delivery: boolean;
  external_event_id: string;
  rejection_reason: RejectionReason | null;
  sale: { sale_number: string } | null;
};

/** A stored order gid (DB check integration_events_shopify_order_gid_check). */
const ORDER_GID = /^gid:\/\/shopify\/Order\/[0-9]{1,20}$/;

/** Characters PostgREST's or() filter would read as syntax, and LIKE wildcards. */
const sanitizeSearch = (q: string) => q.replace(/[,()"'\\%*_]/g, " ").trim();

export async function listEvents(
  supabase: ServerSupabase,
  { status, q, limit = 30 }: { status: EventFilter; q: string; limit?: number },
): Promise<ListPage<EventListItem>> {
  let query = supabase
    .from("integration_events")
    .select(
      "id, topic, subject, status, outcome, received_at, delivery_count, test_delivery, external_event_id, rejection_reason, sale:sales!integration_events_sale_id_fkey(sale_number)",
    );
  if (status !== "all") query = query.eq("status", status);
  const term = sanitizeSearch(q);
  if (term) {
    // An order name (#1042) also finds the order's refunds, through the
    // order gid every delivery of the order carries.
    const orders = (unwrap(
      await supabase
        .from("integration_events")
        .select("shopify_order_gid")
        .eq("topic", "orders/paid")
        .ilike("subject", `%${term}%`)
        .not("shopify_order_gid", "is", null)
        .limit(20),
    ) ?? []) as { shopify_order_gid: string | null }[];
    const gids = [
      ...new Set(
        orders.map((o) => o.shopify_order_gid).filter((g): g is string => !!g && ORDER_GID.test(g)),
      ),
    ];
    const byOrder = gids.length
      ? `,shopify_order_gid.in.(${gids.map((g) => `"${g}"`).join(",")})`
      : "";
    query = query.or(`subject.ilike.*${term}*,external_event_id.ilike.*${term}*${byOrder}`);
  }
  const rows = (unwrap(await query.order("received_at", { ascending: false }).limit(limit + 1)) ??
    []) as unknown as EventListSelect[];
  return {
    items: rows.slice(0, limit).map((r) => ({
      id: r.id,
      topic: r.topic,
      subject: r.subject,
      status: r.status,
      outcome: r.outcome,
      receivedAt: r.received_at,
      deliveryCount: r.delivery_count,
      testDelivery: r.test_delivery,
      webhookId: r.external_event_id,
      rejectionReason: r.rejection_reason,
      saleNumber: r.sale?.sale_number ?? null,
    })),
    more: rows.length > limit,
  };
}

export type ShopifyCustomerOnEvent = {
  gid: string;
  email: string | null;
  linked: { id: string; label: string } | null;
  /** Same email only: a candidate, never proof (D86). */
  candidates: { id: string; label: string; email: string | null }[];
};

export type EventDetail = {
  id: string;
  topic: string;
  subject: string | null;
  status: EventStatus;
  outcome: string | null;
  webhookId: string;
  shopifyEventId: string | null;
  shopDomain: string | null;
  apiVersion: string | null;
  triggeredAt: string | null;
  receivedAt: string;
  lastDeliveredAt: string;
  deliveryCount: number;
  hmacValid: boolean;
  rejectionReason: RejectionReason | null;
  testDelivery: boolean;
  bodyBytes: number;
  bodySha256: string;
  attempts: number;
  processedAt: string | null;
  lastError: string | null;
  lastErrorCode: string | null;
  lastErrorDetail: string | null;
  headers: [string, string][];
  headersTruncated: boolean;
  /** Pretty JSON; null when not stored (rejected) or purged. */
  payload: string | null;
  payloadPurgedAt: string | null;
  result: unknown;
  unmappedLines: UnmappedLine[];
  job: QueueRow | null;
  sale: { id: string; saleNumber: string; currency: string } | null;
  customer: ShopifyCustomerOnEvent | null;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The order's Shopify customer gid and email from an orders/paid payload, or null. */
export function payloadCustomer(payload: unknown): { gid: string; email: string | null } | null {
  if (!isRecord(payload) || !isRecord(payload.customer)) return null;
  const c = payload.customer;
  const fromGid =
    typeof c.admin_graphql_api_id === "string" &&
    /^gid:\/\/shopify\/Customer\/[0-9]{1,20}$/.test(c.admin_graphql_api_id)
      ? c.admin_graphql_api_id
      : null;
  const fromId =
    (typeof c.id === "number" && Number.isSafeInteger(c.id) && c.id > 0) ||
    (typeof c.id === "string" && /^[0-9]{1,20}$/.test(c.id))
      ? `gid://shopify/Customer/${c.id}`
      : null;
  const gid = fromGid ?? fromId;
  if (!gid) return null;
  const email =
    typeof c.email === "string" && c.email.trim()
      ? c.email.trim()
      : typeof payload.email === "string" && payload.email.trim()
        ? payload.email.trim()
        : null;
  return { gid, email };
}

const CUSTOMER_COLUMNS = "id, first_name, last_name, display_name, email, phone";

type CustomerRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  display_name: string | null;
  email: string | null;
  phone: string | null;
};

const labelOf = (c: CustomerRow) =>
  customerLabel({
    firstName: c.first_name,
    lastName: c.last_name,
    displayName: c.display_name,
    email: c.email,
    phone: c.phone,
  });

export async function getEvent(supabase: ServerSupabase, id: string): Promise<EventDetail | null> {
  const ev = unwrap(
    await supabase.from("integration_events").select("*").eq("id", id).maybeSingle(),
  );
  if (!ev) return null;
  const [jobResult, saleResult] = await Promise.all([
    supabase
      .from("integration_retry_queue")
      .select(QUEUE_COLUMNS)
      .eq("integration_event_id", id)
      .order("created_at", { ascending: false })
      .limit(1),
    ev.sale_id
      ? supabase
          .from("sales")
          .select("id, sale_number, currency, shopify_customer_id")
          .eq("id", ev.sale_id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  const jobRow = ((unwrap(jobResult) ?? []) as unknown as QueueSelect[])[0];
  const sale = unwrap(saleResult) as {
    id: string;
    sale_number: string;
    currency: string;
    shopify_customer_id: string | null;
  } | null;

  let customer: ShopifyCustomerOnEvent | null = null;
  if (ev.topic === "orders/paid") {
    const fromPayload = payloadCustomer(ev.payload);
    const gid = sale?.shopify_customer_id ?? fromPayload?.gid ?? null;
    if (gid) {
      const email = fromPayload?.email ?? null;
      const [linkedResult, candidatesResult] = await Promise.all([
        supabase
          .from("customers")
          .select(CUSTOMER_COLUMNS)
          .eq("shopify_customer_id", gid)
          .maybeSingle(),
        email
          ? supabase
              .from("customers")
              .select(CUSTOMER_COLUMNS)
              .ilike(
                "email",
                email.replace(/[\\%_]/g, (m) => `\\${m}`),
              )
              .is("archived_at", null)
              .limit(5)
          : Promise.resolve({ data: [], error: null }),
      ]);
      const linked = unwrap(linkedResult) as CustomerRow | null;
      const candidates = ((unwrap(candidatesResult) ?? []) as CustomerRow[]).filter(
        (c) => c.id !== linked?.id,
      );
      customer = {
        gid,
        email,
        linked: linked ? { id: linked.id, label: labelOf(linked) } : null,
        candidates: candidates.map((c) => ({ id: c.id, label: labelOf(c), email: c.email })),
      };
    }
  }

  const headers = isRecord(ev.headers)
    ? Object.entries(ev.headers)
        .map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)] as [string, string])
        .sort(([a], [b]) => a.localeCompare(b))
    : [];

  return {
    id: ev.id,
    topic: ev.topic,
    subject: ev.subject,
    status: ev.status,
    outcome: ev.outcome,
    webhookId: ev.external_event_id,
    shopifyEventId: ev.shopify_event_id,
    shopDomain: ev.shop_domain,
    apiVersion: ev.api_version,
    triggeredAt: ev.triggered_at,
    receivedAt: ev.received_at,
    lastDeliveredAt: ev.last_delivered_at,
    deliveryCount: ev.delivery_count,
    hmacValid: ev.hmac_valid,
    rejectionReason: ev.rejection_reason,
    testDelivery: ev.test_delivery,
    bodyBytes: ev.body_bytes,
    bodySha256: ev.body_sha256,
    attempts: ev.attempts,
    processedAt: ev.processed_at,
    lastError: ev.last_error,
    lastErrorCode: ev.last_error_code,
    lastErrorDetail: ev.last_error_detail,
    headers: headers.filter(([k]) => k !== "x-bicii-truncated"),
    headersTruncated: headers.some(([k]) => k === "x-bicii-truncated"),
    payload: ev.payload === null ? null : JSON.stringify(ev.payload, null, 2),
    payloadPurgedAt: ev.payload_purged_at,
    result: ev.result,
    unmappedLines: parseUnmappedLines(ev.result),
    job: jobRow ? toQueueRow(jobRow) : null,
    sale: sale ? { id: sale.id, saleNumber: sale.sale_number, currency: sale.currency } : null,
    customer,
  };
}

// ---------------------------------------------------------------------------
// Writes (RPCs only)
// ---------------------------------------------------------------------------

/** Publish online on or off (manage_inventory); the job to run, when one was queued. */
export async function setPublishOnline(
  supabase: ServerSupabase,
  productId: string,
  publish: boolean,
): Promise<{ publishOnline: boolean; syncStatus: SyncStatus; jobId: string | null }> {
  const r = unwrap(await supabase.rpc("set_publish_online", { product_id: productId, publish }));
  return {
    publishOnline: r?.publish_online ?? publish,
    syncStatus: r?.sync_status ?? "pending",
    jobId: r?.job_id ?? null,
  };
}

/** Sync now (manage_inventory): the queued job to run. */
export async function requestProductSync(
  supabase: ServerSupabase,
  productId: string,
): Promise<string> {
  const jobId = unwrap(await supabase.rpc("request_product_sync", { product_id: productId }));
  if (!jobId) throw new DomainError("Sync could not be queued. Try again.");
  return jobId;
}

/** The product's sync status after a run (any staff). */
export async function productSyncStatus(
  supabase: ServerSupabase,
  productId: string,
): Promise<{ syncStatus: SyncStatus; lastError: string | null }> {
  const r = unwrap(
    await supabase
      .from("shopify_product_sync")
      .select("sync_status, last_error")
      .eq("product_id", productId)
      .maybeSingle(),
  );
  return { syncStatus: r?.sync_status ?? "not_synced", lastError: r?.last_error ?? null };
}

/** Queue a job again now (admin; manage_inventory for a product sync). */
export async function retryJob(
  supabase: ServerSupabase,
  jobId: string,
): Promise<{ id: string; kind: JobKind; productId: string | null; eventId: string | null }> {
  const r = unwrap(await supabase.rpc("retry_integration_job", { job_id: jobId }));
  if (!r) throw new DomainError("That item is no longer in the queue.");
  return {
    id: r.id,
    kind: r.kind,
    productId: r.product_id,
    eventId: r.integration_event_id,
  };
}

/** Close a job with a reason (admin); an order also closes its waiting refunds. */
export async function dismissJob(
  supabase: ServerSupabase,
  jobId: string,
  reason: string,
): Promise<void> {
  unwrap(await supabase.rpc("dismiss_integration_job", { job_id: jobId, reason }));
}

/** Link a Shopify variant to a BICII product (admin, with a reason; mapping only, D84). */
export async function linkVariant(
  supabase: ServerSupabase,
  {
    productId,
    productGid,
    variantGid,
    reason,
  }: { productId: string; productGid: string; variantGid: string; reason: string },
): Promise<void> {
  unwrap(
    await supabase.rpc("link_shopify_variant", {
      product_id: productId,
      shopify_product_id: productGid,
      shopify_variant_id: variantGid,
      reason,
    }),
  );
}

/** Link a Shopify customer to a BICII customer (admin, with a reason; never by email, D86). */
export async function linkCustomer(
  supabase: ServerSupabase,
  {
    customerId,
    shopifyCustomerId,
    reason,
  }: { customerId: string; shopifyCustomerId: string; reason: string },
): Promise<{ earlierOnlineSales: number }> {
  const r = unwrap(
    await supabase.rpc("link_shopify_customer", {
      customer_id: customerId,
      shopify_customer_id: shopifyCustomerId,
      reason,
    }),
  );
  return { earlierOnlineSales: r?.earlier_online_sales ?? 0 };
}

/**
 * Remove a customer's Shopify customer link (admin, with a reason): a link
 * made by hand or by the verified-email match (D263) that names the wrong
 * person. Sales recorded while it stood keep the customer (sales are
 * immutable) and are counted in `onlineSalesKept`; the customer's own account
 * no longer shows them, and the automatic match never makes that pair again.
 */
export async function unlinkCustomer(
  supabase: ServerSupabase,
  { customerId, reason }: { customerId: string; reason: string },
): Promise<{ onlineSalesKept: number }> {
  const r = unwrap(
    await supabase.rpc("unlink_shopify_customer", { customer_id: customerId, reason }),
  );
  return { onlineSalesKept: r?.online_sales_kept ?? 0 };
}

/** Save the online location, storefront and test-order setting (admin). */
export async function saveShopifySettings(
  supabase: ServerSupabase,
  input: Pick<
    ShopifySettingsInput,
    "onlineLocationId" | "storefrontUrl" | "acceptTestOrders" | "reason"
  >,
): Promise<ShopifySettingsDTO> {
  const r = unwrap(
    await supabase.rpc("set_shopify_settings", {
      online_location_id: input.onlineLocationId,
      // The RPC treats '' as no storefront (no Buy-online link) and no reason.
      storefront_url: input.storefrontUrl ?? "",
      accept_test_orders: input.acceptTestOrders,
      reason: input.reason ?? "",
    }),
  );
  return {
    onlineLocationId: r?.online_location_id ?? input.onlineLocationId,
    storefrontUrl: r?.storefront_url ?? null,
    acceptTestOrders: r?.accept_test_orders ?? input.acceptTestOrders,
    shopifyLocationId: r?.shopify_location_id ?? null,
    updatedAt: r?.updated_at ?? null,
  };
}

/** A recorded sale's S- number by id (any staff), for an action's toast. */
export async function saleNumberOf(
  supabase: ServerSupabase,
  saleId: string | null,
): Promise<string | null> {
  if (!saleId) return null;
  const r = unwrap(
    await supabase.from("sales").select("sale_number").eq("id", saleId).maybeSingle(),
  );
  return r?.sale_number ?? null;
}

/** An event's state after a run (admin), for an action's toast. */
export async function eventState(
  supabase: ServerSupabase,
  eventId: string,
): Promise<{
  status: EventStatus;
  outcome: string | null;
  saleId: string | null;
  lastError: string | null;
} | null> {
  const r = unwrap(
    await supabase
      .from("integration_events")
      .select("status, outcome, sale_id, last_error")
      .eq("id", eventId)
      .maybeSingle(),
  );
  return r
    ? { status: r.status, outcome: r.outcome, saleId: r.sale_id, lastError: r.last_error }
    : null;
}

// ---------------------------------------------------------------------------
// What a run did, for the toast after Retry, Link or Sync now
// ---------------------------------------------------------------------------

export type RunReport = {
  /** The toast's title: "Recorded as S-000123", "Synced with Shopify", … */
  title: string;
  /** The human reason when it still needs attention; null otherwise. */
  description: string | null;
  tone: "success" | "error" | "neutral";
  saleNumber: string | null;
};

/**
 * Reads back the job's event (admins) or product (any staff) after
 * runJobById, so the screen can say "Recorded as S-000123" or show the new
 * human reason. `outcome` null: another runner held the job, so it runs in
 * the background.
 */
export async function describeRun(
  supabase: ServerSupabase,
  job: { kind: JobKind; productId: string | null; eventId: string | null },
  outcome: "done" | "failed" | "needs_attention" | "deferred" | null,
): Promise<RunReport> {
  if (outcome === null) {
    return {
      title: "Retry queued",
      description: "It is already running or will run in a moment.",
      tone: "neutral",
      saleNumber: null,
    };
  }
  if (job.kind === "product_sync" && job.productId) {
    const { syncStatus, lastError } = await productSyncStatus(supabase, job.productId);
    if (outcome === "deferred") {
      return {
        title: "Sync waits a moment",
        description: "An online order is being recorded; the sync runs right after it.",
        tone: "neutral",
        saleNumber: null,
      };
    }
    if (syncStatus === "error" || outcome !== "done") {
      return {
        title: "Sync failed",
        description: lastError ?? "Shopify did not take the change. It is in the queue.",
        tone: "error",
        saleNumber: null,
      };
    }
    return { title: "Synced with Shopify", description: null, tone: "success", saleNumber: null };
  }
  const state = job.eventId ? await eventState(supabase, job.eventId) : null;
  if (!state) {
    return {
      title: outcome === "done" ? "Done" : "Still needs attention",
      description: null,
      tone: outcome === "done" ? "success" : "error",
      saleNumber: null,
    };
  }
  const saleNumber = await saleNumberOf(supabase, state.saleId);
  if (state.status === "processed") {
    const title =
      state.outcome === "sale_recorded" || state.outcome === "duplicate_order"
        ? `Recorded as ${saleNumber ?? "a sale"}`
        : state.outcome === "refund_recorded"
          ? `Refund recorded on ${saleNumber ?? "the sale"}`
          : "Done";
    return { title, description: null, tone: "success", saleNumber };
  }
  if (state.status === "skipped") {
    return { title: "Closed without recording", description: null, tone: "neutral", saleNumber };
  }
  return {
    title: outcome === "needs_attention" ? "Still needs attention" : "Will retry automatically",
    description: state.lastError,
    tone: "error",
    saleNumber: null,
  };
}
