import "server-only";

import type { StaffDTO } from "@/lib/auth/permissions";
import { DbError, mapDbError, unwrap } from "@/lib/db-errors";
import { defaultLocation } from "@/lib/inventory";
import { toMoneyString } from "@/lib/money";
import {
  PURCHASE_ORDER_FILTERS,
  canManagePurchasing,
  canSeeProductPageSupplierCosts,
  canSeePurchaseCosts,
  describePurchaseOrderEvent,
  eventShowsReason,
  isEditableStatus,
  isOpenStatus,
  type PurchaseOrderEventType,
  type PurchaseOrderFilter,
  type PurchaseOrderStatus,
} from "@/lib/purchasing";
import {
  normaliseReference,
  toRpcLines,
  type ReceiptSummary,
  type ReceiveActionLine,
} from "@/lib/receive-form";
import type { ServerSupabase } from "@/lib/supabase/server";

import { DomainError } from "./errors";
import type { ListPage } from "./list";
import { staffSearch } from "./search";
import { staffNames } from "@/lib/domain/staff-directory";

/**
 * Purchase orders (SPEC §14, §21; DATA-MODEL §10, §16; PLAN D60 D-PO-COSTS,
 * D61 D-PO-CANCEL, D62 D-PO-SCOPE, D65 D-OVERRECEIPT). A DTO mapper over RLS
 * reads and the Phase 7 RPCs; every write is an RPC (manage_purchasing),
 * which checks everything again.
 *
 * Cost visibility (D60): purchase_order_lines and purchase_receipt_lines
 * have no column grant on their costs, so this module lists its columns
 * (never `select *`, which fails by design). Unit costs, line totals,
 * receipt costs and PO totals come only from the *_staff views and are
 * queried and returned only when canSeePurchaseCosts(staff); otherwise the
 * DTO has no such key. Totals are the database's (purchase_order_totals_staff),
 * never summed here. Money stays a decimal string. History payloads carry
 * costs, so events are read only for cost-visible staff (RLS enforces it).
 */

type Money = string;

const money = (v: number | string | null | undefined): Money | null =>
  v === null || v === undefined ? null : toMoneyString(v);

/** Database refusals that belong to one field: rethrown as a DomainError on it. */
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

const HEADER_FIELDS: Record<string, string> = {
  supplier_archived: "supplierId",
  purchase_order_supplier_locked: "supplierId",
  purchase_orders_supplier_reference_check: "supplierReference",
  purchase_orders_notes_check: "notes",
};

const LINE_FIELDS: Record<string, string> = {
  purchase_line_below_received: "quantityOrdered",
  purchase_order_lines_quantity_ordered_check: "quantityOrdered",
  purchase_order_lines_unit_cost_check: "unitCost",
  purchase_order_lines_notes_check: "notes",
  purchase_line_unique_product: "productId",
  purchase_line_not_shop_owned: "productId",
  purchase_line_product_inactive: "productId",
  purchase_line_duplicate_product: "productId",
  purchase_order_lines_product_once: "productId",
  purchase_currency_mismatch: "productId",
  reason_too_long: "reason",
  reason_required: "reason",
};

/** Staff id -> display name (staff_directory, once per render). */
export { staffNames };

const actorOf = (names: ReadonlyMap<string, string>, id: string | null) =>
  id ? (names.get(id) ?? "A former colleague") : null;

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

export type PurchaseOrderListItem = {
  id: string;
  poNumber: string;
  supplier: { id: string; name: string };
  status: PurchaseOrderStatus;
  /** The order's expected date ("YYYY-MM-DD"), or null. */
  expectedAt: string | null;
  createdAt: string;
  ordered: number;
  received: number;
  outstanding: number;
  cancelled: number;
  lineCount: number;
  /** reporting.purchase_order_progress: a line past its date with units to come. */
  overdue: boolean;
};

type PoRow = {
  id: string;
  po_number: string;
  status: PurchaseOrderStatus;
  expected_at: string | null;
  created_at: string;
  supplier_id: string;
  suppliers: { id: string; name: string } | null;
};

const PO_LIST_COLUMNS =
  "id, po_number, status, expected_at, created_at, supplier_id, suppliers(id, name)";

/** Per-PO progress from reporting.purchase_order_progress, in the rows' order. */
export async function purchaseOrderItems(
  supabase: ServerSupabase,
  rows: readonly PoRow[],
): Promise<PurchaseOrderListItem[]> {
  if (rows.length === 0) return [];
  const progress =
    unwrap(
      await supabase
        .schema("reporting")
        .from("purchase_order_progress")
        .select(
          "purchase_order_id, quantity_ordered, quantity_received, quantity_outstanding, quantity_cancelled, is_overdue",
        )
        .in(
          "purchase_order_id",
          rows.map((r) => r.id),
        ),
    ) ?? [];
  const totals = new Map<
    string,
    {
      ordered: number;
      received: number;
      outstanding: number;
      cancelled: number;
      lines: number;
      overdue: boolean;
    }
  >();
  for (const p of progress) {
    if (!p.purchase_order_id) continue;
    const t = totals.get(p.purchase_order_id) ?? {
      ordered: 0,
      received: 0,
      outstanding: 0,
      cancelled: 0,
      lines: 0,
      overdue: false,
    };
    t.ordered += p.quantity_ordered ?? 0;
    t.received += p.quantity_received ?? 0;
    t.outstanding += p.quantity_outstanding ?? 0;
    t.cancelled += p.quantity_cancelled ?? 0;
    t.lines += 1;
    t.overdue ||= p.is_overdue === true;
    totals.set(p.purchase_order_id, t);
  }
  return rows.map((r) => {
    const t = totals.get(r.id);
    return {
      id: r.id,
      poNumber: r.po_number,
      supplier: { id: r.supplier_id, name: r.suppliers?.name ?? "Supplier" },
      status: r.status,
      expectedAt: r.expected_at,
      createdAt: r.created_at,
      ordered: t?.ordered ?? 0,
      received: t?.received ?? 0,
      outstanding: t?.outstanding ?? 0,
      cancelled: t?.cancelled ?? 0,
      lineCount: t?.lines ?? 0,
      overdue: t?.overdue ?? false,
    };
  });
}

/**
 * Purchase orders, newest first, at most `limit`. With `q`: staff_search
 * (PO number however typed, supplier reference, supplier name), in its
 * order, filtered by `status`. Without: purchase_orders in the status
 * filter (Open = submitted and partially received).
 */
export async function listPurchaseOrders(
  supabase: ServerSupabase,
  {
    q,
    status = "open",
    limit = 30,
    supplierId,
  }: { q: string; status?: PurchaseOrderFilter; limit?: number; supplierId?: string },
): Promise<ListPage<PurchaseOrderListItem>> {
  const statuses = [...PURCHASE_ORDER_FILTERS[status].statuses];
  if (q) {
    const hits = await staffSearch(supabase, q, { kinds: ["purchase_order"], limit: 100 });
    const ids = hits.items.map((h) => h.id);
    if (ids.length === 0) return { items: [], more: false };
    let query = supabase.from("purchase_orders").select(PO_LIST_COLUMNS).in("id", ids);
    if (status !== "all") query = query.in("status", statuses);
    const rows = (unwrap(await query) ?? []) as PoRow[];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const ordered = ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
    return {
      items: await purchaseOrderItems(supabase, ordered.slice(0, limit)),
      more: ordered.length > limit || hits.more,
    };
  }
  let query = supabase.from("purchase_orders").select(PO_LIST_COLUMNS);
  if (status !== "all") query = query.in("status", statuses);
  if (supplierId) query = query.eq("supplier_id", supplierId);
  const rows = (unwrap(
    await query
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .limit(limit + 1),
  ) ?? []) as PoRow[];
  return {
    items: await purchaseOrderItems(supabase, rows.slice(0, limit)),
    more: rows.length > limit,
  };
}

// ---------------------------------------------------------------------------
// One purchase order
// ---------------------------------------------------------------------------

export type PurchaseOrderLine = {
  id: string;
  product: { id: string; shortId: string; name: string; sku: string | null };
  ordered: number;
  received: number;
  outstanding: number;
  cancelled: number;
  /** The line's own expected date, if it overrides the order's. */
  expectedAt: string | null;
  notes: string | null;
  /** Current on hand (reporting.product_stock). */
  onHand: number;
  /** Has any receipt: cannot be removed, quantity never below `received`. */
  hasReceipts: boolean;
  overdue: boolean;
  /** D60: present only for cost-visible staff. */
  costs?: { unitCost: Money; orderedTotal: Money; receivedValue: Money };
};

export type PurchaseReceiptLine = {
  id: string;
  lineNumber: number;
  product: { id: string; shortId: string; name: string };
  quantity: number;
  location: string;
  /** D60: present only for cost-visible staff. */
  costs?: { unitCostActual: Money; receivedTotal: Money };
};

export type PurchaseReceipt = {
  id: string;
  receivedAt: string;
  receivedBy: string;
  reference: string | null;
  notes: string | null;
  lines: PurchaseReceiptLine[];
};

export type PurchaseOrderHistoryEntry = {
  id: string;
  at: string;
  type: PurchaseOrderEventType;
  text: string;
  /** Shown quoted under the sentence (a cancellation's is in the sentence). */
  reason: string | null;
};

export type PurchaseOrderDetail = {
  id: string;
  poNumber: string;
  status: PurchaseOrderStatus;
  supplier: { id: string; name: string; archived: boolean };
  currency: string;
  expectedAt: string | null;
  supplierReference: string | null;
  notes: string | null;
  createdAt: string;
  createdBy: string | null;
  submittedAt: string | null;
  submittedBy: string | null;
  receivedAt: string | null;
  cancelledAt: string | null;
  cancelledBy: string | null;
  cancellationReason: string | null;
  lines: PurchaseOrderLine[];
  receipts: PurchaseReceipt[];
  progress: { ordered: number; received: number; outstanding: number; cancelled: number };
  overdue: boolean;
  /** D60: present only for cost-visible staff (purchase_order_totals_staff). */
  totals?: { ordered: Money; received: Money; outstanding: Money };
  /** D60: present only for cost-visible staff (events carry costs). */
  history?: PurchaseOrderHistoryEntry[];
  canSeeCosts: boolean;
  flags: { canEdit: boolean; canSubmit: boolean; canCancel: boolean; canReceive: boolean };
};

type ProductBrief = { id: string; short_id: string; name: string; sku: string | null };

async function productBriefs(
  supabase: ServerSupabase,
  ids: readonly string[],
): Promise<Map<string, ProductBrief>> {
  if (ids.length === 0) return new Map();
  const rows =
    unwrap(
      await supabase
        .from("products")
        .select("id, short_id, name, sku")
        .in("id", [...ids]),
    ) ?? [];
  return new Map(rows.map((p) => [p.id, p]));
}

/** A purchase order with its lines, receipts and (cost-visible staff) totals and history. */
export async function getPurchaseOrder(
  supabase: ServerSupabase,
  id: string,
  staff: StaffDTO,
): Promise<PurchaseOrderDetail | null> {
  const seeCosts = canSeePurchaseCosts(staff);
  const po = unwrap(
    await supabase
      .from("purchase_orders")
      .select(
        "id, po_number, status, supplier_id, expected_at, supplier_reference, currency, notes, created_at, created_by, submitted_at, submitted_by, received_at, cancelled_at, cancelled_by, cancellation_reason, suppliers(id, name, archived_at)",
      )
      .eq("id", id)
      .maybeSingle(),
  );
  if (!po) return null;

  const [
    linesResult,
    progressResult,
    receiptsResult,
    totalsResult,
    costsResult,
    eventsResult,
    names,
  ] = await Promise.all([
    supabase
      .from("purchase_order_lines")
      .select("id, product_id, quantity_ordered, expected_at, notes, created_at")
      .eq("purchase_order_id", id)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true }),
    supabase
      .schema("reporting")
      .from("purchase_order_progress")
      .select(
        "purchase_order_line_id, quantity_ordered, quantity_received, quantity_outstanding, quantity_cancelled, is_overdue",
      )
      .eq("purchase_order_id", id),
    supabase
      .from("purchase_receipts")
      .select("id, reference, received_at, received_by, notes, created_at")
      .eq("purchase_order_id", id)
      .order("received_at", { ascending: false })
      .order("created_at", { ascending: false }),
    seeCosts
      ? supabase
          .from("purchase_order_totals_staff")
          .select("ordered_total, received_total, outstanding_total")
          .eq("purchase_order_id", id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    seeCosts
      ? supabase
          .from("purchase_order_lines_staff")
          .select("purchase_order_line_id, unit_cost, ordered_total, received_value")
          .eq("purchase_order_id", id)
      : Promise.resolve({ data: [], error: null }),
    seeCosts
      ? supabase
          .from("purchase_order_events")
          .select(
            "id, event_type, purchase_order_line_id, payload, reason, actor_staff_id, created_at",
          )
          .eq("purchase_order_id", id)
          .order("created_at", { ascending: false })
          .order("id", { ascending: true })
          .limit(500)
      : Promise.resolve({ data: [], error: null }),
    staffNames(supabase),
  ]);

  const lineRows = unwrap(linesResult) ?? [];
  const progress = new Map(
    (unwrap(progressResult) ?? []).map((p) => [p.purchase_order_line_id, p]),
  );
  const receiptRows = unwrap(receiptsResult) ?? [];
  const lineCosts = new Map(
    (
      (unwrap(costsResult) ?? []) as {
        purchase_order_line_id: string | null;
        unit_cost: number | null;
        ordered_total: number | null;
        received_value: number | null;
      }[]
    ).map((c) => [c.purchase_order_line_id, c]),
  );
  const events = (unwrap(eventsResult) ?? []) as {
    id: string;
    event_type: PurchaseOrderEventType;
    purchase_order_line_id: string | null;
    payload: unknown;
    reason: string | null;
    actor_staff_id: string | null;
    created_at: string;
  }[];

  const receiptIds = receiptRows.map((r) => r.id);
  const [receiptLinesResult, receiptCostsResult] = await Promise.all([
    receiptIds.length > 0
      ? supabase
          .from("purchase_receipt_lines")
          .select(
            "id, purchase_receipt_id, product_id, location_id, line_number, quantity_received",
          )
          .in("purchase_receipt_id", receiptIds)
          .order("line_number", { ascending: true })
      : Promise.resolve({ data: [], error: null }),
    seeCosts && receiptIds.length > 0
      ? supabase
          .from("purchase_receipt_lines_staff")
          .select("purchase_receipt_line_id, unit_cost_actual, received_total")
          .in("purchase_receipt_id", receiptIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  const receiptLines = (unwrap(receiptLinesResult) ?? []) as {
    id: string;
    purchase_receipt_id: string;
    product_id: string;
    location_id: string;
    line_number: number;
    quantity_received: number;
  }[];
  const receiptCosts = new Map(
    (
      (unwrap(receiptCostsResult) ?? []) as {
        purchase_receipt_line_id: string | null;
        unit_cost_actual: number | null;
        received_total: number | null;
      }[]
    ).map((c) => [c.purchase_receipt_line_id, c]),
  );

  // Line ids of every line ever on the order (removed ones too) -> product.
  const lineProduct = new Map<string, string>(lineRows.map((l) => [l.id, l.product_id]));
  for (const e of events) {
    const p = e.payload as Record<string, unknown> | null;
    if (e.purchase_order_line_id && typeof p?.product_id === "string") {
      lineProduct.set(e.purchase_order_line_id, p.product_id);
    }
  }
  const productIds = [
    ...new Set([...lineProduct.values(), ...receiptLines.map((r) => r.product_id)]),
  ];
  const locationIds = [...new Set(receiptLines.map((r) => r.location_id))];
  const [products, stockResult, locationsResult] = await Promise.all([
    productBriefs(supabase, productIds),
    lineRows.length > 0
      ? supabase
          .schema("reporting")
          .from("product_stock")
          .select("product_id, on_hand")
          .in(
            "product_id",
            lineRows.map((l) => l.product_id),
          )
      : Promise.resolve({ data: [], error: null }),
    locationIds.length > 0
      ? supabase.from("locations").select("id, name").in("id", locationIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  const onHand = new Map(
    ((unwrap(stockResult) ?? []) as { product_id: string | null; on_hand: number | null }[]).map(
      (s) => [s.product_id, s.on_hand ?? 0],
    ),
  );
  const locations = new Map(
    ((unwrap(locationsResult) ?? []) as { id: string; name: string }[]).map((l) => [l.id, l.name]),
  );
  const brief = (pid: string) => {
    const p = products.get(pid);
    return {
      id: pid,
      shortId: p?.short_id ?? "",
      name: p?.name ?? "Product",
      sku: p?.sku ?? null,
    };
  };

  const lines: PurchaseOrderLine[] = lineRows.map((l) => {
    const p = progress.get(l.id);
    const c = lineCosts.get(l.id);
    const received = p?.quantity_received ?? 0;
    return {
      id: l.id,
      product: brief(l.product_id),
      ordered: l.quantity_ordered,
      received,
      outstanding: p?.quantity_outstanding ?? 0,
      cancelled: p?.quantity_cancelled ?? 0,
      expectedAt: l.expected_at,
      notes: l.notes,
      onHand: onHand.get(l.product_id) ?? 0,
      hasReceipts: received > 0,
      overdue: p?.is_overdue === true,
      ...(seeCosts && c
        ? {
            costs: {
              unitCost: money(c.unit_cost) ?? "0.00",
              orderedTotal: money(c.ordered_total) ?? "0.00",
              receivedValue: money(c.received_value) ?? "0.00",
            },
          }
        : {}),
    };
  });

  const receipts: PurchaseReceipt[] = receiptRows.map((r) => ({
    id: r.id,
    receivedAt: r.received_at,
    receivedBy: actorOf(names, r.received_by) ?? "Someone",
    reference: r.reference,
    notes: r.notes,
    lines: receiptLines
      .filter((rl) => rl.purchase_receipt_id === r.id)
      .map((rl) => {
        const c = receiptCosts.get(rl.id);
        const b = brief(rl.product_id);
        return {
          id: rl.id,
          lineNumber: rl.line_number,
          product: { id: b.id, shortId: b.shortId, name: b.name },
          quantity: rl.quantity_received,
          location: locations.get(rl.location_id) ?? "A location",
          ...(seeCosts && c
            ? {
                costs: {
                  unitCostActual: money(c.unit_cost_actual) ?? "0.00",
                  receivedTotal: money(c.received_total) ?? "0.00",
                },
              }
            : {}),
        };
      }),
  }));

  const totalsRow = unwrap(totalsResult) as {
    ordered_total: number | null;
    received_total: number | null;
    outstanding_total: number | null;
  } | null;

  const history: PurchaseOrderHistoryEntry[] = events.map((e) => {
    const payload = (e.payload ?? {}) as Record<string, unknown>;
    const productId = e.purchase_order_line_id ? lineProduct.get(e.purchase_order_line_id) : null;
    const event = {
      type: e.event_type,
      payload,
      reason: e.reason,
      actor: actorOf(names, e.actor_staff_id),
      productName: productId ? (products.get(productId)?.name ?? null) : null,
    };
    return {
      id: e.id,
      at: e.created_at,
      type: e.event_type,
      text: describePurchaseOrderEvent(event, { currency: po.currency, showCosts: seeCosts }),
      reason: eventShowsReason(event) ? e.reason : null,
    };
  });

  const manage = canManagePurchasing(staff);
  const status = po.status as PurchaseOrderStatus;
  const sum = (key: "ordered" | "received" | "outstanding" | "cancelled") =>
    lines.reduce((n, l) => n + l[key], 0);
  const supplier = po.suppliers as { id: string; name: string; archived_at: string | null } | null;

  return {
    id: po.id,
    poNumber: po.po_number,
    status,
    supplier: {
      id: po.supplier_id,
      name: supplier?.name ?? "Supplier",
      archived: supplier?.archived_at != null,
    },
    currency: po.currency,
    expectedAt: po.expected_at,
    supplierReference: po.supplier_reference,
    notes: po.notes,
    createdAt: po.created_at,
    createdBy: actorOf(names, po.created_by),
    submittedAt: po.submitted_at,
    submittedBy: actorOf(names, po.submitted_by),
    receivedAt: po.received_at,
    cancelledAt: po.cancelled_at,
    cancelledBy: actorOf(names, po.cancelled_by),
    cancellationReason: po.cancellation_reason,
    lines,
    receipts,
    progress: {
      ordered: sum("ordered"),
      received: sum("received"),
      outstanding: sum("outstanding"),
      cancelled: sum("cancelled"),
    },
    overdue: lines.some((l) => l.overdue),
    ...(seeCosts
      ? {
          totals: {
            ordered: money(totalsRow?.ordered_total) ?? "0.00",
            received: money(totalsRow?.received_total) ?? "0.00",
            outstanding: money(totalsRow?.outstanding_total) ?? "0.00",
          },
          history,
        }
      : {}),
    canSeeCosts: seeCosts,
    flags: {
      canEdit: manage && isEditableStatus(status),
      canSubmit: manage && status === "draft",
      canCancel: manage && isEditableStatus(status),
      canReceive: manage && isOpenStatus(status),
    },
  };
}

// ---------------------------------------------------------------------------
// Pickers and defaults
// ---------------------------------------------------------------------------

export type CostDefault = { productId: string; unitCost: Money; source: string };

/** Default unit costs for new lines: the supplier's last cost, else the product's, else 0 (D66). */
export async function getPurchaseCostDefaults(
  supabase: ServerSupabase,
  supplierId: string,
  productIds: readonly string[],
): Promise<CostDefault[]> {
  if (productIds.length === 0) return [];
  const rows =
    unwrap(
      await supabase.rpc("purchase_cost_defaults", {
        supplier_id: supplierId,
        product_ids: [...productIds],
      }),
    ) ?? [];
  return rows.map((r) => ({
    productId: r.product_id,
    unitCost: money(r.unit_cost as number | string) ?? "0.00",
    source: r.source,
  }));
}

export type PurchasableProduct = {
  id: string;
  shortId: string;
  name: string;
  sku: string | null;
  currency: string;
  onHand: number;
  /** Still to come on submitted and partially received orders (never drafts). */
  onOrder: number;
};

/**
 * Products a PO may order (D62): quantity-tracked, shop-owned, active and
 * not archived, matching `q` (staff_search), with on hand
 * (reporting.product_stock) and on order (reporting.product_on_order).
 */
export async function searchPurchasableProducts(
  supabase: ServerSupabase,
  q: string,
): Promise<PurchasableProduct[]> {
  const hits = await staffSearch(supabase, q, { kinds: ["product"], limit: 20 });
  const ids = hits.items.map((h) => h.id);
  if (ids.length === 0) return [];
  const [productsResult, stockResult, onOrderResult] = await Promise.all([
    supabase
      .from("products")
      .select(
        "id, short_id, name, sku, currency, tracking_type, ownership_type, active, archived_at",
      )
      .in("id", ids),
    supabase
      .schema("reporting")
      .from("product_stock")
      .select("product_id, on_hand")
      .in("product_id", ids),
    supabase
      .schema("reporting")
      .from("product_on_order")
      .select("product_id, quantity_on_order")
      .in("product_id", ids),
  ]);
  const products = new Map((unwrap(productsResult) ?? []).map((p) => [p.id, p]));
  const stock = new Map((unwrap(stockResult) ?? []).map((s) => [s.product_id, s.on_hand ?? 0]));
  const onOrder = new Map(
    (unwrap(onOrderResult) ?? []).map((s) => [s.product_id, s.quantity_on_order ?? 0]),
  );
  return ids.flatMap((id) => {
    const p = products.get(id);
    if (
      !p ||
      p.tracking_type !== "quantity" ||
      p.ownership_type !== "shop_owned" ||
      !p.active ||
      p.archived_at !== null
    ) {
      return [];
    }
    return [
      {
        id: p.id,
        shortId: p.short_id,
        name: p.name,
        sku: p.sku,
        currency: p.currency,
        onHand: stock.get(id) ?? 0,
        onOrder: onOrder.get(id) ?? 0,
      },
    ];
  });
}

// ---------------------------------------------------------------------------
// Writes (RPCs; manage_purchasing)
// ---------------------------------------------------------------------------

export type PurchaseOrderInput = {
  supplierId: string;
  expectedAt: string | null;
  supplierReference: string | null;
  notes: string | null;
};

/**
 * Creates a draft with the id the form chose (its idempotency key); a
 * replay returns the same order. The server sets the currency
 * (private.shop_currency(), D62); the app never sends one.
 */
export async function createPurchaseOrder(
  supabase: ServerSupabase,
  id: string,
  input: PurchaseOrderInput,
): Promise<{ id: string; poNumber: string }> {
  try {
    const row = unwrap(
      await supabase.rpc("create_purchase_order", {
        id,
        supplier_id: input.supplierId,
        expected_at: input.expectedAt ?? undefined,
        supplier_reference: input.supplierReference ?? undefined,
        notes: input.notes ?? undefined,
      }),
    );
    return { id, poNumber: row?.po_number ?? "" };
  } catch (err) {
    rethrowFields(err, HEADER_FIELDS);
  }
}

/** Sets the header exactly (null clears); the supplier changes only on a draft. */
export async function updatePurchaseOrder(
  supabase: ServerSupabase,
  purchaseOrderId: string,
  input: PurchaseOrderInput,
): Promise<void> {
  try {
    unwrap(
      await supabase.rpc("update_purchase_order", {
        purchase_order_id: purchaseOrderId,
        supplier_id: input.supplierId,
        // null clears the optional fields (the RPC's arguments have no default).
        expected_at: input.expectedAt as string,
        supplier_reference: input.supplierReference as string,
        notes: input.notes as string,
      }),
    );
  } catch (err) {
    rethrowFields(err, HEADER_FIELDS);
  }
}

export type PurchaseOrderLineInput = {
  id: string;
  purchaseOrderId: string;
  productId: string;
  quantityOrdered: number;
  /** A fixed-point string; "0.00" is a known cost (D24 as amended). */
  unitCost: Money;
  expectedAt: string | null;
  notes: string | null;
  reason: string | null;
};

/** Adds or changes a line (upsert by id) on an open order. */
export async function setPurchaseOrderLine(
  supabase: ServerSupabase,
  input: PurchaseOrderLineInput,
): Promise<void> {
  try {
    unwrap(
      await supabase.rpc("set_purchase_order_line", {
        id: input.id,
        purchase_order_id: input.purchaseOrderId,
        product_id: input.productId,
        quantity_ordered: input.quantityOrdered,
        unit_cost: input.unitCost,
        expected_at: input.expectedAt ?? undefined,
        notes: input.notes ?? undefined,
        reason: input.reason ?? undefined,
      }),
    );
  } catch (err) {
    rethrowFields(err, LINE_FIELDS);
  }
}

/** Removes a line without receipts (a reason once submitted). A replay is a no-op. */
export async function removePurchaseOrderLine(
  supabase: ServerSupabase,
  lineId: string,
  reason: string | null,
): Promise<void> {
  try {
    unwrap(
      await supabase.rpc("remove_purchase_order_line", {
        line_id: lineId,
        reason: reason ?? undefined,
      }),
    );
  } catch (err) {
    rethrowFields(err, { reason_required: "reason", reason_too_long: "reason" });
  }
}

/** draft -> submitted (a replay returns it unchanged). */
export async function submitPurchaseOrder(
  supabase: ServerSupabase,
  purchaseOrderId: string,
): Promise<void> {
  unwrap(await supabase.rpc("submit_purchase_order", { purchase_order_id: purchaseOrderId }));
}

/** Cancels with a reason (D61); received stock and receipts stay. */
export async function cancelPurchaseOrder(
  supabase: ServerSupabase,
  purchaseOrderId: string,
  reason: string,
): Promise<void> {
  const cleaned = reason.trim();
  if (!cleaned) {
    throw new DomainError("Say why the order is being cancelled.", {
      reason: ["Say why the order is being cancelled."],
    });
  }
  try {
    unwrap(
      await supabase.rpc("cancel_purchase_order", {
        purchase_order_id: purchaseOrderId,
        reason: cleaned,
      }),
    );
  } catch (err) {
    rethrowFields(err, { reason_required: "reason", reason_too_long: "reason" });
  }
}

// ---------------------------------------------------------------------------
// The product page's "Suppliers & orders"
// ---------------------------------------------------------------------------

export type ProductSupplierLink = {
  supplierId: string;
  supplierName: string;
  supplierArchived: boolean;
  supplierSku: string | null;
  leadDays: number | null;
  preferred: boolean;
  /** D60: present only for cost-visible staff. */
  costs?: { lastUnitCost: Money | null; currency: string; lastReceivedAt: string | null };
};

export type ProductOpenOrder = {
  id: string;
  poNumber: string;
  status: PurchaseOrderStatus;
  supplierName: string;
  outstanding: number;
  expectedAt: string | null;
  overdue: boolean;
};

export type ProductPurchasing = {
  suppliers: ProductSupplierLink[];
  /** reporting.product_on_order: submitted and partially received only. */
  onOrder: number;
  nextExpectedAt: string | null;
  /** Draft, submitted and partially received orders with this product, newest first. */
  openOrders: ProductOpenOrder[];
};

/**
 * A product's suppliers, what is on order and the open orders holding it,
 * for the product page's card. Supplier last costs need view_costs there
 * (canSeeProductPageSupplierCosts): the product page is not a purchasing
 * screen, so manage_purchasing alone shows none (D60).
 */
export async function getProductPurchasing(
  supabase: ServerSupabase,
  productId: string,
  staff: StaffDTO,
): Promise<ProductPurchasing> {
  const seeCosts = canSeeProductPageSupplierCosts(staff);
  const [linksResult, costsResult, onOrderResult, progressResult] = await Promise.all([
    supabase
      .from("supplier_products")
      .select("supplier_id, supplier_sku, lead_days, preferred, suppliers(name, archived_at)")
      .eq("product_id", productId),
    seeCosts
      ? supabase
          .from("supplier_products_staff")
          .select("supplier_id, last_unit_cost, currency, last_received_at")
          .eq("product_id", productId)
      : Promise.resolve({ data: [], error: null }),
    supabase
      .schema("reporting")
      .from("product_on_order")
      .select("quantity_on_order, next_expected_at")
      .eq("product_id", productId)
      .maybeSingle(),
    supabase
      .schema("reporting")
      .from("purchase_order_progress")
      .select("purchase_order_id, po_status, quantity_outstanding, expected_at, is_overdue")
      .eq("product_id", productId)
      .in("po_status", ["draft", "submitted", "partially_received"]),
  ]);
  const costs = new Map(
    (
      (unwrap(costsResult) ?? []) as {
        supplier_id: string | null;
        last_unit_cost: number | null;
        currency: string | null;
        last_received_at: string | null;
      }[]
    ).map((c) => [c.supplier_id, c]),
  );
  const links = (unwrap(linksResult) ?? []) as {
    supplier_id: string;
    supplier_sku: string | null;
    lead_days: number | null;
    preferred: boolean;
    suppliers: { name: string; archived_at: string | null } | null;
  }[];
  const suppliers = links
    .map((l) => {
      const c = costs.get(l.supplier_id);
      return {
        supplierId: l.supplier_id,
        supplierName: l.suppliers?.name ?? "Supplier",
        supplierArchived: l.suppliers?.archived_at != null,
        supplierSku: l.supplier_sku,
        leadDays: l.lead_days,
        preferred: l.preferred,
        ...(seeCosts && c
          ? {
              costs: {
                lastUnitCost: money(c.last_unit_cost),
                currency: c.currency ?? "SGD",
                lastReceivedAt: c.last_received_at,
              },
            }
          : {}),
      };
    })
    .sort(
      (a, b) =>
        Number(b.preferred) - Number(a.preferred) || a.supplierName.localeCompare(b.supplierName),
    );

  const progress = (unwrap(progressResult) ?? []) as {
    purchase_order_id: string | null;
    po_status: PurchaseOrderStatus | null;
    quantity_outstanding: number | null;
    expected_at: string | null;
    is_overdue: boolean | null;
  }[];
  const poIds = [
    ...new Set(progress.map((p) => p.purchase_order_id).filter((v): v is string => !!v)),
  ];
  const poRows =
    poIds.length > 0
      ? ((unwrap(
          await supabase
            .from("purchase_orders")
            .select("id, po_number, status, created_at, suppliers(name)")
            .in("id", poIds)
            .order("created_at", { ascending: false }),
        ) ?? []) as {
          id: string;
          po_number: string;
          status: PurchaseOrderStatus;
          suppliers: { name: string } | null;
        }[])
      : [];
  const openOrders = poRows.map((po) => {
    const p = progress.find((x) => x.purchase_order_id === po.id);
    return {
      id: po.id,
      poNumber: po.po_number,
      status: po.status,
      supplierName: po.suppliers?.name ?? "Supplier",
      outstanding: p?.quantity_outstanding ?? 0,
      expectedAt: p?.expected_at ?? null,
      overdue: p?.is_overdue === true,
    };
  });
  const onOrder = unwrap(onOrderResult) as {
    quantity_on_order: number | null;
    next_expected_at: string | null;
  } | null;
  return {
    suppliers,
    onOrder: onOrder?.quantity_on_order ?? 0,
    nextExpectedAt: onOrder?.next_expected_at ?? null,
    openOrders,
  };
}

// ---------------------------------------------------------------------------
// Receiving (Phase 7 step 4; SPEC §2 "retries cannot duplicate stock", §14;
// D63 D-LASTCOST, D64 D-RECEIPT-TIME, D65 D-OVERRECEIPT)
// ---------------------------------------------------------------------------

export type ReceiveFormLine = {
  id: string;
  product: { id: string; shortId: string; name: string; sku: string | null };
  ordered: number;
  received: number;
  outstanding: number;
  onHand: number;
  /** The PO line's unit cost (D60: manage_purchasing always sees it); null otherwise. */
  unitCost: Money | null;
};

export type ReceiveFormLocation = { id: string; name: string; kind: string; sortOrder: number };

export type ReceiptBrief = {
  id: string;
  receivedAt: string;
  receivedBy: string;
  reference: string | null;
  units: number;
};

export type ReceiveFormData = {
  id: string;
  poNumber: string;
  status: PurchaseOrderStatus;
  currency: string;
  submittedAt: string | null;
  supplier: { id: string; name: string; archived: boolean };
  /** Open lines only (something still to come). */
  lines: ReceiveFormLine[];
  /** Active locations, by sort order then name. */
  locations: ReceiveFormLocation[];
  /** Phase 4's defaultLocation(): active, lowest sort order, then name. */
  defaultLocationId: string | null;
  /** This order's receipts from the last 24 hours, newest first. */
  recentReceipts: ReceiptBrief[];
  /** Every receipt's delivery note on this order, for the soft duplicate guard (D65). */
  allReferences: {
    reference: string;
    normalised: string;
    receivedAt: string;
    receivedBy: string;
    units: number;
  }[];
};

/** The Receive screen's data: the order, its open lines, locations and earlier receipts. */
export async function getReceiveForm(
  supabase: ServerSupabase,
  purchaseOrderId: string,
  staff: StaffDTO,
  now: Date = new Date(),
): Promise<ReceiveFormData | null> {
  const [po, locationRows] = await Promise.all([
    getPurchaseOrder(supabase, purchaseOrderId, staff),
    supabase
      .from("locations")
      .select("id, name, kind, active, sort_order")
      .eq("active", true)
      .order("sort_order", { ascending: true })
      .order("name", { ascending: true }),
  ]);
  if (!po) return null;
  const locations = (unwrap(locationRows) ?? []).map((l) => ({
    id: l.id,
    name: l.name,
    kind: l.kind as string,
    active: l.active,
    sortOrder: l.sort_order,
  }));
  const units = (r: PurchaseReceipt) => r.lines.reduce((n, l) => n + l.quantity, 0);
  const since = now.getTime() - 86_400_000;
  return {
    id: po.id,
    poNumber: po.poNumber,
    status: po.status,
    currency: po.currency,
    submittedAt: po.submittedAt,
    supplier: po.supplier,
    lines: po.lines
      .filter((l) => l.outstanding > 0)
      .map((l) => ({
        id: l.id,
        product: l.product,
        ordered: l.ordered,
        received: l.received,
        outstanding: l.outstanding,
        onHand: l.onHand,
        unitCost: l.costs?.unitCost ?? null,
      })),
    locations: locations.map(({ id, name, kind, sortOrder }) => ({ id, name, kind, sortOrder })),
    defaultLocationId: defaultLocation(locations)?.id ?? null,
    recentReceipts: po.receipts
      .filter((r) => new Date(r.receivedAt).getTime() >= since)
      .map((r) => ({
        id: r.id,
        receivedAt: r.receivedAt,
        receivedBy: r.receivedBy,
        reference: r.reference,
        units: units(r),
      })),
    allReferences: po.receipts.flatMap((r) =>
      r.reference && r.reference.trim()
        ? [
            {
              reference: r.reference,
              normalised: normaliseReference(r.reference),
              receivedAt: r.receivedAt,
              receivedBy: r.receivedBy,
              units: units(r),
            },
          ]
        : [],
    ),
  };
}

export type ReceivePurchaseInput = {
  purchaseOrderId: string;
  idempotencyKey: string;
  reference: string | null;
  /** ISO instant; null: the server's now(). */
  receivedAt: string | null;
  notes: string | null;
  lines: ReceiveActionLine[];
};

export type ReceivePurchaseResult = {
  receiptId: string;
  unitsReceived: number;
  /** Units still to come on the whole order after this receipt. */
  outstandingAfter: number;
  status: PurchaseOrderStatus;
};

/**
 * Records a delivery (receive_purchase): quantities as integers, costs as
 * decimal STRINGS and ALWAYS sent (0 is a known cost). A replay with the
 * same key and lines returns the first receipt and writes nothing; other
 * lines under the key raise purchase_receipt_key_reused. Business refusals
 * propagate as DbError so the action carries their code to the client.
 */
export async function receivePurchase(
  supabase: ServerSupabase,
  input: ReceivePurchaseInput,
): Promise<ReceivePurchaseResult> {
  const receipt = unwrap(
    await supabase.rpc("receive_purchase", {
      purchase_order_id: input.purchaseOrderId,
      idempotency_key: input.idempotencyKey,
      lines: toRpcLines(input.lines),
      reference: input.reference ?? undefined,
      received_at: input.receivedAt ?? undefined,
      notes: input.notes ?? undefined,
    }),
  );
  if (!receipt) throw new DomainError("The delivery was not recorded. Try again.");
  const [linesResult, progressResult, poResult] = await Promise.all([
    supabase
      .from("purchase_receipt_lines")
      .select("quantity_received")
      .eq("purchase_receipt_id", receipt.id),
    supabase
      .schema("reporting")
      .from("purchase_order_progress")
      .select("quantity_outstanding")
      .eq("purchase_order_id", receipt.purchase_order_id),
    supabase.from("purchase_orders").select("status").eq("id", receipt.purchase_order_id).single(),
  ]);
  return {
    receiptId: receipt.id,
    unitsReceived: (unwrap(linesResult) ?? []).reduce((n, l) => n + l.quantity_received, 0),
    outstandingAfter: (unwrap(progressResult) ?? []).reduce(
      (n, p) => n + (p.quantity_outstanding ?? 0),
      0,
    ),
    status: unwrap(poResult)!.status as PurchaseOrderStatus,
  };
}

/** After a lost response: the receipt recorded under `idempotencyKey`, or null. */
export async function findReceiptByKey(
  supabase: ServerSupabase,
  idempotencyKey: string,
): Promise<ReceiptSummary | null> {
  const rows =
    unwrap(await supabase.rpc("purchase_receipt_by_key", { idempotency_key: idempotencyKey })) ??
    [];
  const receipt = rows[0];
  if (!receipt) return null;
  const [poResult, linesResult, names] = await Promise.all([
    supabase
      .from("purchase_orders")
      .select("po_number")
      .eq("id", receipt.purchase_order_id)
      .single(),
    supabase
      .from("purchase_receipt_lines")
      .select("quantity_received")
      .eq("purchase_receipt_id", receipt.id),
    staffNames(supabase),
  ]);
  return {
    receiptId: receipt.id,
    purchaseOrderId: receipt.purchase_order_id,
    poNumber: unwrap(poResult)?.po_number ?? "",
    receivedAt: receipt.received_at,
    receivedBy: actorOf(names, receipt.received_by) ?? "Someone",
    reference: receipt.reference,
    units: (unwrap(linesResult) ?? []).reduce((n, l) => n + l.quantity_received, 0),
  };
}

// ---------------------------------------------------------------------------
// Reorder from low stock (D66 D-REORDER)
// ---------------------------------------------------------------------------

export type ReorderSuggestion = {
  productId: string;
  shortId: string;
  sku: string | null;
  name: string;
  onHand: number;
  reorderPoint: number;
  /** Submitted and partially received orders only, never drafts. */
  onOrder: number;
  /** max(2 x reorder point - on hand - on order, 0). */
  suggested: number;
  /** Linked to the chosen supplier. */
  supplierLinked: boolean;
  supplierSku: string | null;
  preferredSupplier: { id: string; name: string } | null;
  /** Draft orders already holding the product. */
  draftPoNumbers: string[];
  /** D60: the draft line's default cost (supplier's last, else product cost, else 0). */
  defaultCost?: { unitCost: Money; source: string };
};

/** reorder_suggestions for `supplierId` (or none chosen), with the default cost for cost-visible staff. */
export async function getReorderSuggestions(
  supabase: ServerSupabase,
  supplierId: string | null,
  staff: StaffDTO,
): Promise<ReorderSuggestion[]> {
  const rows =
    unwrap(
      await supabase.rpc("reorder_suggestions", supplierId ? { supplier_id: supplierId } : {}),
    ) ?? [];
  if (rows.length === 0) return [];
  const preferredIds = [
    ...new Set(rows.map((r) => r.preferred_supplier_id).filter((v): v is string => !!v)),
  ];
  const [suppliersResult, defaults] = await Promise.all([
    preferredIds.length > 0
      ? supabase.from("suppliers").select("id, name").in("id", preferredIds)
      : Promise.resolve({ data: [], error: null }),
    supplierId && canSeePurchaseCosts(staff)
      ? getPurchaseCostDefaults(
          supabase,
          supplierId,
          rows.map((r) => r.product_id),
        )
      : Promise.resolve([] as CostDefault[]),
  ]);
  const supplierNames = new Map(
    ((unwrap(suppliersResult) ?? []) as { id: string; name: string }[]).map((s) => [s.id, s.name]),
  );
  const costs = new Map(defaults.map((d) => [d.productId, d]));
  return rows.map((r) => {
    const c = costs.get(r.product_id);
    return {
      productId: r.product_id,
      shortId: r.short_id,
      sku: r.sku,
      name: r.name,
      onHand: r.on_hand ?? 0,
      reorderPoint: r.reorder_point ?? 0,
      onOrder: r.on_order ?? 0,
      suggested: r.suggested_quantity ?? 0,
      supplierLinked: r.supplier_linked === true,
      supplierSku: r.supplier_sku,
      preferredSupplier: r.preferred_supplier_id
        ? {
            id: r.preferred_supplier_id,
            name: supplierNames.get(r.preferred_supplier_id) ?? "Another supplier",
          }
        : null,
      draftPoNumbers: r.draft_po_numbers ?? [],
      ...(c ? { defaultCost: { unitCost: c.unitCost, source: c.source } } : {}),
    };
  });
}

/** A draft order for `supplierId` with the chosen low-stock products (replay by id returns it). */
export async function createPurchaseOrderFromLowStock(
  supabase: ServerSupabase,
  id: string,
  supplierId: string,
  productIds: readonly string[],
): Promise<{ id: string; poNumber: string }> {
  try {
    const row = unwrap(
      await supabase.rpc("create_purchase_order_from_low_stock", {
        id,
        supplier_id: supplierId,
        product_ids: [...productIds],
      }),
    );
    return { id: row?.id ?? id, poNumber: row?.po_number ?? "" };
  } catch (err) {
    rethrowFields(err, { supplier_archived: "supplierId", reorder_nothing_selected: "productIds" });
  }
}
