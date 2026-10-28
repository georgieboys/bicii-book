import "server-only";

import { bikeTitle } from "@/lib/bikes";
import type { ChargeBearer, ConsignmentEventType, ConsignmentStatus } from "@/lib/consignment";
import { DbError, constraintOf, mapDbError, unwrap } from "@/lib/db-errors";
import type { TrackingType, UnitStatus } from "@/lib/inventory";
import { DEFAULT_CURRENCY, Decimal, toDecimal, toMoneyString } from "@/lib/money";
import type { ServerSupabase } from "@/lib/supabase/server";

import { listPhotos, type Photo } from "./attachments";
import { DomainError } from "./errors";
import { listLocations } from "./inventory";
import { staffNames } from "@/lib/domain/staff-directory";

/**
 * Consignment (SPEC §13, §19.1, §21, §23; DATA-MODEL §9, §15, §16; PLAN D4,
 * D44–D48, D50–D52). A DTO mapper over RLS reads and the Phase 6 RPCs.
 *
 * Writes: consignors are created, edited and archived with plain table
 * writes under RLS (manage_consignments; the consignors trigger enforces
 * D47's archive rules), like customers. Everything else goes through the
 * RPCs: create_consignment_item, update_consignment_terms,
 * add_consignment_charge, void_consignment_charge, return_consignment_item,
 * record_settlement, reverse_settlement, each keyed by a client id so a
 * retry has exactly one effect.
 *
 * Money visibility (D48): consignors, consignment_items and
 * consignment_settlements have column grants, so this module lists its
 * columns and never selects `*`. The read RPCs (list_consignors,
 * consignor_statement) return consignment money as NULL to staff without
 * manage_consignments or view_costs; charges, events, settlements, their
 * lines and reversals are row-gated the same way. The DTOs carry `null`
 * for hidden money, and screens render nothing for it. Payout details
 * (bank, PayNow) come only through consignor_payout_details
 * (manage_consignments).
 *
 * Owed, paid and outstanding are derived in reporting.consignor_item_ledger
 * and never stored (D46). A consignor's totals here are the sums of their
 * item rows, which is exactly how reporting.consignor_ledger defines them.
 *
 * Money arrives from PostgREST as JSON numbers and leaves as fixed-point
 * strings; amounts go to the database as strings.
 */

type Money = string;

const money = (v: number | string | null | undefined): Money | null =>
  v === null || v === undefined ? null : toMoneyString(v);

const CONSIGNOR_NOT_FOUND = "That consignor no longer exists. Refresh and try again.";

/** Database refusals that belong to one form field: rethrown as a DomainError on it. */
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

const nameOf = (names: ReadonlyMap<string, string>, id: string | null) =>
  id ? (names.get(id) ?? "A former colleague") : null;

const asPayload = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

// ---------------------------------------------------------------------------
// Consignors
// ---------------------------------------------------------------------------

export type ConsignorListItem = {
  id: string;
  name: string;
  customer: { id: string; label: string } | null;
  email: string | null;
  phone: string | null;
  archived: boolean;
  activeItems: number;
  soldItems: number;
  /** Items with money still owed; null without consignment money access (D48). */
  awaitingItems: number | null;
  returnedItems: number;
  /** Consignment money (D48): null without manage_consignments or view_costs. */
  owed: Money | null;
  paid: Money | null;
  outstanding: Money | null;
  lastSaleAt: string | null;
  lastSettlementAt: string | null;
};

/** Consignors by name, email or phone digits (list_consignors), A–Z. */
export async function listConsignors(
  supabase: ServerSupabase,
  { q, archived = false, limit = 100 }: { q: string; archived?: boolean; limit?: number },
): Promise<{ items: ConsignorListItem[]; more: boolean }> {
  const rows =
    unwrap(
      await supabase.rpc("list_consignors", {
        q: q || undefined,
        include_archived: archived,
        max_rows: limit + 1,
      }),
    ) ?? [];
  return {
    items: rows.slice(0, limit).map((r) => ({
      id: r.id,
      name: r.display_name,
      customer: r.customer_id ? { id: r.customer_id, label: r.customer_label ?? "" } : null,
      email: r.email,
      phone: r.phone,
      archived: r.archived_at !== null,
      activeItems: r.active_items ?? 0,
      soldItems: r.sold_items ?? 0,
      awaitingItems: r.awaiting_settlement_items,
      returnedItems: r.returned_items ?? 0,
      owed: money(r.owed),
      paid: money(r.paid),
      outstanding: money(r.outstanding),
      lastSaleAt: r.last_sale_at,
      lastSettlementAt: r.last_settlement_at,
    })),
    more: rows.length > limit,
  };
}

/** One row of consignor_statement: an item's quantities and, for money users, its ledger. */
export type StatementRow = {
  itemId: string;
  shortId: string;
  consignorId: string;
  consignorName: string;
  status: ConsignmentStatus;
  quantity: number;
  soldQty: number;
  restockedQty: number;
  jobHeldQty: number;
  jobSoldQty: number;
  returnedQty: number;
  remainingQty: number;
  receivedAt: string;
  soldAt: string | null;
  returnedAt: string | null;
  returnReason: string | null;
  askingPrice: Money | null;
  lastSaleAt: string | null;
  lastSettlementAt: string | null;
  productId: string;
  productShortId: string;
  productName: string;
  unitId: string | null;
  unitShortId: string | null;
  unitStatus: UnitStatus | null;
  bikeId: string | null;
  bikeShortId: string | null;
  /** Consignment money (D48): null without manage_consignments or view_costs. */
  agreedAmountOwed: Money | null;
  liability: Money | null;
  consignorCharges: Money | null;
  shopCharges: Money | null;
  owed: Money | null;
  paid: Money | null;
  outstanding: Money | null;
};

type StatementRpcRow = {
  item_id: string;
  short_id: string;
  consignor_id: string;
  consignor_name: string;
  status: ConsignmentStatus;
  quantity: number;
  sold_qty: number;
  restocked_qty: number;
  job_held_qty: number;
  job_sold_qty: number;
  returned_qty: number;
  remaining_qty: number;
  received_at: string;
  sold_at: string | null;
  returned_at: string | null;
  return_reason: string | null;
  asking_price: number | null;
  last_sale_at: string | null;
  last_settlement_at: string | null;
  product_id: string;
  product_short_id: string;
  product_name: string;
  inventory_unit_id: string | null;
  unit_short_id: string | null;
  unit_status: UnitStatus | null;
  bike_id: string | null;
  bike_short_id: string | null;
  agreed_amount_owed: number | null;
  liability: number | null;
  consignor_charges: number | null;
  shop_charges: number | null;
  owed: number | null;
  paid: number | null;
  outstanding: number | null;
};

const toStatementRow = (r: StatementRpcRow): StatementRow => ({
  itemId: r.item_id,
  shortId: r.short_id,
  consignorId: r.consignor_id,
  consignorName: r.consignor_name,
  status: r.status,
  quantity: r.quantity ?? 0,
  soldQty: r.sold_qty ?? 0,
  restockedQty: r.restocked_qty ?? 0,
  jobHeldQty: r.job_held_qty ?? 0,
  jobSoldQty: r.job_sold_qty ?? 0,
  returnedQty: r.returned_qty ?? 0,
  remainingQty: r.remaining_qty ?? 0,
  receivedAt: r.received_at,
  soldAt: r.sold_at,
  returnedAt: r.returned_at,
  returnReason: r.return_reason,
  askingPrice: money(r.asking_price),
  lastSaleAt: r.last_sale_at,
  lastSettlementAt: r.last_settlement_at,
  productId: r.product_id,
  productShortId: r.product_short_id,
  productName: r.product_name,
  unitId: r.inventory_unit_id,
  unitShortId: r.unit_short_id,
  unitStatus: r.unit_status,
  bikeId: r.bike_id,
  bikeShortId: r.bike_short_id,
  agreedAmountOwed: money(r.agreed_amount_owed),
  liability: money(r.liability),
  consignorCharges: money(r.consignor_charges),
  shopCharges: money(r.shop_charges),
  owed: money(r.owed),
  paid: money(r.paid),
  outstanding: money(r.outstanding),
});

/** consignor_statement for one consignor (active items first, then latest sale). */
export async function consignorStatement(
  supabase: ServerSupabase,
  consignorId: string,
): Promise<StatementRow[]> {
  const rows =
    unwrap(await supabase.rpc("consignor_statement", { target_consignor_id: consignorId })) ?? [];
  return (rows as StatementRpcRow[]).map(toStatementRow);
}

/** consignor_statement for one item, or null when there is no such item. */
async function itemStatement(
  supabase: ServerSupabase,
  itemId: string,
): Promise<StatementRow | null> {
  const rows = unwrap(await supabase.rpc("consignor_statement", { target_item_id: itemId })) ?? [];
  const row = (rows as StatementRpcRow[])[0];
  return row ? toStatementRow(row) : null;
}

export type SettlementLine = {
  itemId: string;
  shortId: string;
  amount: Money;
  overrideReason: string | null;
};

export type Settlement = {
  id: string;
  amount: Money;
  currency: string;
  paidAt: string;
  reference: string | null;
  notes: string | null;
  createdByName: string | null;
  lines: SettlementLine[];
  reversal: { reason: string; byName: string | null; at: string } | null;
};

export type ConsignorTotals = {
  owed: Money;
  paid: Money;
  outstanding: Money;
  /** What consignor-paid charges took off what is owed (D4). */
  consignorCharges: Money;
};

export type ConsignorDetail = {
  id: string;
  name: string;
  customer: { id: string; label: string } | null;
  email: string | null;
  phone: string | null;
  internalNotes: string | null;
  archivedAt: string | null;
  createdAt: string;
  currency: string;
  /** Every item, from consignor_statement. */
  items: StatementRow[];
  /** Consignment money users only (D48); null otherwise. */
  totals: ConsignorTotals | null;
  /** Consignment money users only, newest first; null otherwise. */
  settlements: Settlement[] | null;
};

const CONSIGNOR_COLUMNS =
  "id, display_name, email, phone, internal_notes, archived_at, created_at, customer:customers(id, first_name, last_name, display_name, email, phone)";

/** One consignor with their statement and, for money users, totals and payments; null if unknown. */
export async function getConsignor(
  supabase: ServerSupabase,
  id: string,
  { canSeeMoney }: { canSeeMoney: boolean },
): Promise<ConsignorDetail | null> {
  const row = unwrap(
    await supabase.from("consignors").select(CONSIGNOR_COLUMNS).eq("id", id).maybeSingle(),
  );
  if (!row) return null;
  const [items, settlements] = await Promise.all([
    consignorStatement(supabase, id),
    canSeeMoney ? consignorSettlements(supabase, id) : Promise.resolve(null),
  ]);
  const shortIds = new Map(items.map((i) => [i.itemId, i.shortId]));
  if (settlements) {
    for (const s of settlements) {
      for (const l of s.lines) l.shortId = shortIds.get(l.itemId) ?? l.shortId;
    }
  }
  let totals: ConsignorTotals | null = null;
  if (canSeeMoney) {
    // reporting.consignor_ledger is defined as these sums of the item rows.
    const sum = (pick: (r: StatementRow) => Money | null) =>
      toMoneyString(items.reduce((acc, r) => acc.plus(toDecimal(pick(r) ?? "0")), new Decimal(0)));
    totals = {
      owed: sum((r) => r.owed),
      paid: sum((r) => r.paid),
      outstanding: sum((r) => r.outstanding),
      consignorCharges: sum((r) => r.consignorCharges),
    };
  }
  const customer = row.customer;
  return {
    id: row.id,
    name: row.display_name,
    customer: customer
      ? {
          id: customer.id,
          label:
            customer.display_name ??
            ([customer.first_name, customer.last_name].filter(Boolean).join(" ") ||
              customer.email ||
              customer.phone ||
              "Customer"),
        }
      : null,
    email: row.email,
    phone: row.phone,
    internalNotes: row.internal_notes,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    currency: settlements?.[0]?.currency ?? DEFAULT_CURRENCY,
    items,
    totals,
    settlements,
  };
}

/** A consignor's settlements with their allocations and any reversal, newest first. */
async function consignorSettlements(
  supabase: ServerSupabase,
  consignorId: string,
): Promise<Settlement[]> {
  const [headersResult, names] = await Promise.all([
    supabase
      .from("consignment_settlements")
      .select("id, amount, currency, paid_at, reference, notes, created_by, created_at")
      .eq("consignor_id", consignorId)
      .order("paid_at", { ascending: false })
      .order("created_at", { ascending: false }),
    staffNames(supabase),
  ]);
  const headers = unwrap(headersResult) ?? [];
  if (headers.length === 0) return [];
  const ids = headers.map((h) => h.id);
  const [linesResult, reversalsResult] = await Promise.all([
    supabase
      .from("settlement_lines")
      .select(
        "settlement_id, consignment_item_id, amount_applied, override_reason, item:consignment_items(short_id)",
      )
      .in("settlement_id", ids)
      .order("created_at", { ascending: true }),
    supabase
      .from("consignment_settlement_reversals")
      .select("settlement_id, reason, created_by, created_at")
      .in("settlement_id", ids),
  ]);
  const lines = unwrap(linesResult) ?? [];
  const reversals = new Map((unwrap(reversalsResult) ?? []).map((r) => [r.settlement_id, r]));
  return headers.map((h) => {
    const reversal = reversals.get(h.id);
    return {
      id: h.id,
      amount: toMoneyString(h.amount),
      currency: h.currency,
      paidAt: h.paid_at,
      reference: h.reference,
      notes: h.notes,
      createdByName: nameOf(names, h.created_by),
      lines: lines
        .filter((l) => l.settlement_id === h.id)
        .map((l) => ({
          itemId: l.consignment_item_id,
          shortId: l.item?.short_id ?? "",
          amount: toMoneyString(l.amount_applied),
          overrideReason: l.override_reason,
        })),
      reversal: reversal
        ? {
            reason: reversal.reason,
            byName: nameOf(names, reversal.created_by),
            at: reversal.created_at,
          }
        : null,
    };
  });
}

/** Bank or PayNow details (manage_consignments only, D48); null when none are on file. */
export async function getConsignorPayoutDetails(
  supabase: ServerSupabase,
  consignorId: string,
): Promise<string | null> {
  return unwrap(await supabase.rpc("consignor_payout_details", { consignor_id: consignorId }));
}

export type ConsignorInput = {
  displayName: string;
  phone: string | null;
  email: string | null;
  customerId: string | null;
  internalNotes: string | null;
};

const CONSIGNOR_FIELDS: Record<string, string> = {
  consignors_display_name_check: "displayName",
  consignors_email_check: "email",
  consignors_phone_check: "phone",
  consignors_payout_details_check: "payoutDetails",
  consignors_internal_notes_check: "internalNotes",
  consignors_customer_id_key: "customerId",
  customer_archived: "customerId",
};

/**
 * Creates a consignor with the id the form chose (its idempotency key): a
 * repeated submit of the same details finds the row it already made; the
 * same id with other details is refused (consignor_conflict), never
 * silently kept. manage_consignments (RLS).
 */
export async function createConsignor(
  supabase: ServerSupabase,
  id: string,
  input: ConsignorInput & { payoutDetails: string | null },
): Promise<{ id: string }> {
  const { error } = await supabase.from("consignors").insert({
    id,
    display_name: input.displayName,
    phone: input.phone,
    email: input.email,
    customer_id: input.customerId,
    internal_notes: input.internalNotes,
    payout_details: input.payoutDetails,
  });
  if (error) {
    if (error.code === "23505" && constraintOf(error) === "consignors_pkey") {
      const stored = unwrap(
        await supabase
          .from("consignors")
          .select("display_name, phone, email, customer_id, internal_notes")
          .eq("id", id)
          .maybeSingle(),
      );
      if (
        stored &&
        sameConsignor(stored, input) &&
        (await getConsignorPayoutDetails(supabase, id)) === blankToNull(input.payoutDetails)
      ) {
        return { id };
      }
      throw new DomainError(mapDbError({ code: "P0001", message: "consignor_conflict" }).message);
    }
    rethrowFields(new DbError(error), CONSIGNOR_FIELDS);
  }
  return { id };
}

const blankToNull = (v: string | null | undefined) => {
  const t = v?.trim() ?? "";
  return t === "" ? null : t;
};

/** The stored row against a submit, as consignors_normalize stores it (email case-blind). */
function sameConsignor(
  stored: {
    display_name: string;
    phone: string | null;
    email: string | null;
    customer_id: string | null;
    internal_notes: string | null;
  },
  input: ConsignorInput,
): boolean {
  return (
    stored.display_name === input.displayName.trim() &&
    stored.phone === blankToNull(input.phone) &&
    (stored.email?.toLowerCase() ?? null) === (blankToNull(input.email)?.toLowerCase() ?? null) &&
    stored.customer_id === input.customerId &&
    stored.internal_notes === blankToNull(input.internalNotes)
  );
}

/**
 * Edits a consignor. `payoutDetails` null keeps what is on file (staff
 * without manage_consignments never read it, and the form never shows
 * it); a string replaces it.
 */
export async function updateConsignor(
  supabase: ServerSupabase,
  id: string,
  input: ConsignorInput & { payoutDetails: string | null },
): Promise<void> {
  const patch = {
    display_name: input.displayName,
    phone: input.phone,
    email: input.email,
    customer_id: input.customerId,
    internal_notes: input.internalNotes,
    ...(input.payoutDetails !== null ? { payout_details: input.payoutDetails } : {}),
  };
  let row;
  try {
    row = unwrap(
      await supabase.from("consignors").update(patch).eq("id", id).select("id").maybeSingle(),
    );
  } catch (err) {
    rethrowFields(err, CONSIGNOR_FIELDS);
  }
  if (!row) throw new DomainError(CONSIGNOR_NOT_FOUND);
}

/**
 * Archive or unarchive. Archiving needs no active item and an outstanding
 * of exactly 0 (D47; the consignors trigger refuses otherwise with
 * consignor_has_open_items / consignor_has_balance). Replaying the
 * current state changes nothing.
 */
export async function setConsignorArchived(
  supabase: ServerSupabase,
  id: string,
  archived: boolean,
): Promise<void> {
  const update = supabase
    .from("consignors")
    .update({ archived_at: archived ? new Date().toISOString() : null })
    .eq("id", id);
  const row = unwrap(
    await (archived ? update.is("archived_at", null) : update.not("archived_at", "is", null))
      .select("id")
      .maybeSingle(),
  );
  if (row) return;
  const exists = unwrap(await supabase.from("consignors").select("id").eq("id", id).maybeSingle());
  if (!exists) throw new DomainError(CONSIGNOR_NOT_FOUND);
}

export type ConsignorOption = { id: string; label: string; description?: string };

/** Active consignors matching `q` (staff_search kind consignor), for the intake's picker. */
export async function searchConsignors(
  supabase: ServerSupabase,
  q: string,
): Promise<ConsignorOption[]> {
  const hits =
    unwrap(await supabase.rpc("staff_search", { q, kinds: ["consignor"], max_results: 8 })) ?? [];
  return hits.map((h) => ({ id: h.id, label: h.title, description: h.subtitle ?? undefined }));
}

/** A customer's name and contact, to prefill a new consignor linked to them. */
export async function customerContact(
  supabase: ServerSupabase,
  customerId: string,
): Promise<{ name: string; phone: string | null; email: string | null } | null> {
  const row = unwrap(
    await supabase
      .from("customers")
      .select("id, first_name, last_name, display_name, email, phone")
      .eq("id", customerId)
      .maybeSingle(),
  );
  if (!row) return null;
  const name = row.display_name ?? [row.first_name, row.last_name].filter(Boolean).join(" ") ?? "";
  return { name, phone: row.phone, email: row.email };
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export type ItemStatusFilterValue = "active" | "sold" | "returned" | "all";

export type ConsignmentItemListItem = {
  id: string;
  shortId: string;
  status: ConsignmentStatus;
  productName: string;
  trackingType: TrackingType;
  quantity: number;
  /** Quantity items: what the shop still holds (consignor_statement); null for unique items. */
  remaining: number | null;
  consignor: { id: string; name: string };
  askingPrice: Money | null;
  currency: string;
  receivedAt: string;
  unitShortId: string | null;
  /** Consignment money (D48); null when hidden. */
  outstanding: Money | null;
};

const ITEM_LIST_COLUMNS =
  "id, short_id, status, quantity, asking_price, currency, received_at, consignor:consignors(id, display_name), product:products!consignment_items_product_id_fkey(name, tracking_type), unit:inventory_units!consignment_items_inventory_unit_id_fkey(short_id)";

/**
 * Consignment items, newest intake first, filtered by status; `q` goes
 * through staff_search's consignment_item kind (C- number, product name,
 * consignor). Quantities and outstanding come from consignor_statement.
 */
export async function listConsignmentItems(
  supabase: ServerSupabase,
  { status, q, limit = 50 }: { status: ItemStatusFilterValue; q: string; limit?: number },
): Promise<{ items: ConsignmentItemListItem[]; more: boolean }> {
  let ids: string[] | null = null;
  if (q) {
    const hits =
      unwrap(
        await supabase.rpc("staff_search", {
          q,
          kinds: ["consignment_item"],
          max_results: 50,
        }),
      ) ?? [];
    ids = hits.map((h) => h.id);
    if (ids.length === 0) return { items: [], more: false };
  }
  let query = supabase.from("consignment_items").select(ITEM_LIST_COLUMNS);
  if (status !== "all") query = query.eq("status", status);
  if (ids) query = query.in("id", ids);
  const rows =
    unwrap(
      await query
        .order("received_at", { ascending: false })
        .order("short_id", { ascending: false })
        .limit(limit + 1),
    ) ?? [];
  const shown = rows.slice(0, limit);
  const consignorIds = [...new Set(shown.map((r) => r.consignor?.id).filter(Boolean))] as string[];
  const statements = await Promise.all(consignorIds.map((c) => consignorStatement(supabase, c)));
  const byItem = new Map(statements.flat().map((s) => [s.itemId, s]));
  return {
    items: shown.map((r) => {
      const st = byItem.get(r.id);
      const tracking = (r.product?.tracking_type ?? "unique") as TrackingType;
      return {
        id: r.id,
        shortId: r.short_id,
        status: r.status,
        productName: r.product?.name ?? "",
        trackingType: tracking,
        quantity: r.quantity,
        remaining: tracking === "quantity" ? (st?.remainingQty ?? null) : null,
        consignor: { id: r.consignor?.id ?? "", name: r.consignor?.display_name ?? "" },
        askingPrice: money(r.asking_price),
        currency: r.currency,
        receivedAt: r.received_at,
        unitShortId: r.unit?.short_id ?? null,
        outstanding: st?.outstanding ?? null,
      };
    }),
    more: rows.length > limit,
  };
}

export type ItemCharge = {
  id: string;
  description: string;
  amount: Money;
  bearer: ChargeBearer;
  currency: string;
  createdAt: string;
  createdByName: string | null;
  voided: { at: string; byName: string | null; reason: string | null } | null;
};

export type ItemEvent = {
  id: string;
  type: ConsignmentEventType;
  payload: Record<string, unknown>;
  reason: string | null;
  actorName: string | null;
  at: string;
};

export type ItemSaleLine = {
  id: string;
  saleId: string;
  saleNumber: string;
  quantity: number;
  unitPrice: Money;
  total: Money;
  recognizedAt: string | null;
  restocked: boolean;
  voided: boolean;
};

export type ItemJobLine = {
  id: string;
  jobId: string;
  jobNumber: string;
  quantity: number;
  unitPrice: Money;
  completed: boolean;
  voided: boolean;
};

export type ItemLocation = { locationId: string; name: string; onHand: number };

export type ConsignmentItemDetail = {
  id: string;
  shortId: string;
  status: ConsignmentStatus;
  currency: string;
  quantity: number;
  askingPrice: Money | null;
  receivedAt: string;
  soldAt: string | null;
  returnedAt: string | null;
  returnReason: string | null;
  agreementNotes: string | null;
  internalNotes: string | null;
  consignor: { id: string; name: string; archived: boolean };
  product: { id: string; shortId: string; name: string; brand: string | null };
  trackingType: TrackingType;
  unit: {
    id: string;
    shortId: string;
    status: UnitStatus;
    location: { id: string; name: string };
    serialNumber: string | null;
  } | null;
  bike: { id: string; shortId: string; title: string } | null;
  /** consignor_statement (money fields null without consignment money access). */
  statement: StatementRow;
  sales: ItemSaleLine[];
  jobs: ItemJobLine[];
  /** Quantity items: this item's on-hand at each location (every active one; D54). */
  stock: ItemLocation[];
  /** Consignment money users only (D48); null otherwise. */
  charges: ItemCharge[] | null;
  events: ItemEvent[] | null;
  /** Listing photos (on the product; may be public, D26). */
  listingPhotos: Photo[];
  /** Agreement photos (internal only, D52); null when not loaded (no money access). */
  agreementPhotos: Photo[] | null;
};

const ITEM_COLUMNS =
  "id, short_id, status, quantity, asking_price, currency, received_at, sold_at, returned_at, return_reason, agreement_notes, internal_notes, consignor:consignors(id, display_name, archived_at), product:products!consignment_items_product_id_fkey(id, short_id, name, brand, tracking_type), unit:inventory_units!consignment_items_inventory_unit_id_fkey(id, short_id, status, serial_number, location:locations(id, name))";

/** One consignment item with its ledger, sales, jobs and (for money users) charges and history. */
export async function getConsignmentItem(
  supabase: ServerSupabase,
  id: string,
  { canSeeMoney }: { canSeeMoney: boolean },
): Promise<ConsignmentItemDetail | null> {
  const row = unwrap(
    await supabase.from("consignment_items").select(ITEM_COLUMNS).eq("id", id).maybeSingle(),
  );
  if (!row || !row.product || !row.consignor) return null;
  const quantityTracked = row.product.tracking_type === "quantity";
  const [
    statement,
    salesResult,
    jobsResult,
    chargesResult,
    eventsResult,
    names,
    listingPhotos,
    agreementPhotos,
    levelsResult,
    locations,
  ] = await Promise.all([
    itemStatement(supabase, id),
    supabase
      .from("sale_lines")
      .select(
        "id, sale_id, quantity, unit_sale_price_snapshot, sale_total, restocked_at, sale:sales(sale_number, recognized_at, status)",
      )
      .eq("consignment_item_id", id)
      .order("created_at", { ascending: true }),
    supabase
      .from("work_order_line_items")
      .select(
        "id, quantity, unit_sale_price_snapshot, voided_at, job:work_orders(id, job_number, completed_at)",
      )
      .eq("consignment_item_id", id)
      .order("created_at", { ascending: true }),
    canSeeMoney
      ? supabase
          .from("consignment_item_charges")
          .select(
            "id, description, amount, bearer, currency, created_by, created_at, voided_at, voided_by, void_reason",
          )
          .eq("consignment_item_id", id)
          .order("created_at", { ascending: true })
      : Promise.resolve({ data: null, error: null }),
    canSeeMoney
      ? supabase
          .from("consignment_item_events")
          .select("id, event_type, payload, reason, actor_staff_id, created_at")
          .eq("consignment_item_id", id)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(100)
      : Promise.resolve({ data: null, error: null }),
    staffNames(supabase),
    listPhotos(supabase, { entityType: "product", entityId: row.product.id }),
    canSeeMoney
      ? listPhotos(supabase, { entityType: "consignment_item", entityId: id })
      : Promise.resolve(null),
    // D54: this item's own stock per location (every consigned movement
    // names its item), not the product's, which other consignors share.
    quantityTracked
      ? supabase
          .from("inventory_movements")
          .select("location_id, quantity_delta")
          .eq("consignment_item_id", id)
      : Promise.resolve({ data: [], error: null }),
    quantityTracked ? listLocations(supabase) : Promise.resolve(null),
  ]);
  if (!statement) return null;

  let bike: ConsignmentItemDetail["bike"] = null;
  if (statement.bikeId) {
    const b = unwrap(
      await supabase
        .from("bikes")
        .select("id, short_id, brand, model, variant")
        .eq("id", statement.bikeId)
        .maybeSingle(),
    );
    if (b) bike = { id: b.id, shortId: b.short_id, title: bikeTitle(b) };
  }

  const levels = new Map<string, number>();
  for (const m of (unwrap(levelsResult) ?? []) as {
    location_id: string;
    quantity_delta: number;
  }[]) {
    levels.set(m.location_id, (levels.get(m.location_id) ?? 0) + m.quantity_delta);
  }
  const stock: ItemLocation[] = locations
    ? locations.locations
        .filter((l) => l.active || (levels.get(l.id) ?? 0) !== 0)
        .map((l) => ({ locationId: l.id, name: l.name, onHand: levels.get(l.id) ?? 0 }))
    : [];

  const charges = unwrap(chargesResult);
  const events = unwrap(eventsResult);
  return {
    id: row.id,
    shortId: row.short_id,
    status: row.status,
    currency: row.currency,
    quantity: row.quantity,
    askingPrice: money(row.asking_price),
    receivedAt: row.received_at,
    soldAt: row.sold_at,
    returnedAt: row.returned_at,
    returnReason: row.return_reason,
    agreementNotes: row.agreement_notes,
    internalNotes: row.internal_notes,
    consignor: {
      id: row.consignor.id,
      name: row.consignor.display_name,
      archived: row.consignor.archived_at !== null,
    },
    product: {
      id: row.product.id,
      shortId: row.product.short_id,
      name: row.product.name,
      brand: row.product.brand,
    },
    trackingType: row.product.tracking_type,
    unit: row.unit
      ? {
          id: row.unit.id,
          shortId: row.unit.short_id,
          status: row.unit.status,
          serialNumber: row.unit.serial_number,
          location: { id: row.unit.location?.id ?? "", name: row.unit.location?.name ?? "" },
        }
      : null,
    bike,
    statement,
    sales: (unwrap(salesResult) ?? []).map((s) => ({
      id: s.id,
      saleId: s.sale_id,
      saleNumber: s.sale?.sale_number ?? "",
      quantity: Number(s.quantity ?? 0),
      unitPrice: toMoneyString(s.unit_sale_price_snapshot ?? 0),
      total: toMoneyString(s.sale_total ?? 0),
      recognizedAt: s.sale?.recognized_at ?? null,
      restocked: s.restocked_at !== null,
      voided: s.sale?.status === "voided",
    })),
    jobs: (unwrap(jobsResult) ?? []).map((l) => ({
      id: l.id ?? "",
      jobId: l.job?.id ?? "",
      jobNumber: l.job?.job_number ?? "",
      quantity: Number(l.quantity ?? 0),
      unitPrice: toMoneyString(l.unit_sale_price_snapshot ?? 0),
      completed: l.job?.completed_at != null,
      voided: l.voided_at !== null,
    })),
    stock,
    charges: charges
      ? charges.map((c) => ({
          id: c.id,
          description: c.description,
          amount: toMoneyString(c.amount),
          bearer: c.bearer,
          currency: c.currency,
          createdAt: c.created_at,
          createdByName: nameOf(names, c.created_by),
          voided: c.voided_at
            ? { at: c.voided_at, byName: nameOf(names, c.voided_by), reason: c.void_reason }
            : null,
        }))
      : null,
    events: events
      ? events.map((e) => ({
          id: e.id,
          type: e.event_type,
          payload: asPayload(e.payload),
          reason: e.reason,
          actorName: nameOf(names, e.actor_staff_id),
          at: e.created_at,
        }))
      : null,
    listingPhotos,
    agreementPhotos,
  };
}

/** The consignment behind a consigned unit, for the unit page's card; null for other units. */
export async function consignmentForUnit(
  supabase: ServerSupabase,
  unitId: string,
): Promise<{
  itemId: string;
  shortId: string;
  consignor: { id: string; name: string };
  /** Consignment money (D48); null when hidden. */
  agreedAmountOwed: Money | null;
  currency: string;
} | null> {
  const unit = unwrap(
    await supabase
      .from("inventory_units")
      .select("consignment_item_id")
      .eq("id", unitId)
      .maybeSingle(),
  );
  if (!unit?.consignment_item_id) return null;
  const [item, statement] = await Promise.all([
    supabase
      .from("consignment_items")
      .select("id, short_id, currency, consignor:consignors(id, display_name)")
      .eq("id", unit.consignment_item_id)
      .maybeSingle(),
    itemStatement(supabase, unit.consignment_item_id),
  ]);
  const row = unwrap(item);
  if (!row) return null;
  return {
    itemId: row.id,
    shortId: row.short_id,
    consignor: { id: row.consignor?.id ?? "", name: row.consignor?.display_name ?? "" },
    agreedAmountOwed: statement?.agreedAmountOwed ?? null,
    currency: row.currency,
  };
}

/** The consignments of a consignment-owned product, for its page (newest intake first). */
export async function consignmentsForProduct(
  supabase: ServerSupabase,
  productId: string,
): Promise<{ id: string; shortId: string; status: ConsignmentStatus; consignorName: string }[]> {
  const rows =
    unwrap(
      await supabase
        .from("consignment_items")
        .select("id, short_id, status, consignor:consignors(display_name)")
        .eq("product_id", productId)
        .order("received_at", { ascending: false })
        .limit(50),
    ) ?? [];
  return rows.map((r) => ({
    id: r.id,
    shortId: r.short_id,
    status: r.status,
    consignorName: r.consignor?.display_name ?? "",
  }));
}

// ---------------------------------------------------------------------------
// Writes (RPCs)
// ---------------------------------------------------------------------------

const INTAKE_FIELDS: Record<string, string> = {
  consignor_archived: "consignorId",
  // The new consignor, created by the same call (its name field shows these).
  consignor_conflict: "newConsignor",
  consignors_display_name_check: "newConsignor",
  consignors_email_check: "newConsignor",
  consignors_phone_check: "newConsignor",
  consignors_customer_id_key: "newConsignor",
  location_inactive: "locationId",
  location_required: "locationId",
  consignment_quantity_invalid: "quantity",
  consignment_items_quantity_check: "quantity",
  consignment_received_in_future: "receivedAt",
  consignment_items_agreed_amount_owed_check: "agreedAmountOwed",
  consignment_items_asking_price_check: "askingPrice",
  consignment_items_agreement_notes_check: "agreementNotes",
  consignment_items_internal_notes_check: "internalNotes",
  products_name_check: "productName",
  products_brand_check: "brand",
  products_description_check: "description",
  inventory_units_serial_number_check: "serialNumber",
  inventory_units_condition_check: "condition",
  category_kind_mismatch: "categoryId",
  bike_has_owner: "bikeId",
  bike_already_linked: "bikeId",
  bike_archived: "bikeId",
  inventory_units_bike_id_key: "bikeId",
  consignment_bike_requires_unique: "bikeId",
};

export type NewConsignor = {
  id: string;
  displayName: string;
  phone: string | null;
  email: string | null;
  customerId: string | null;
};

export type IntakeInput = {
  itemId: string;
  /** An existing consignor, or the new one's id (`newConsignor.id`). */
  consignorId: string;
  /** Created by the intake RPC in the same transaction (its id is client-made). */
  newConsignor: NewConsignor | null;
  locationId: string;
  agreedAmountOwed: Money;
  askingPrice: Money | null;
  productName: string;
  brand: string | null;
  description: string | null;
  categoryId: string | null;
  trackingType: TrackingType;
  quantity: number;
  serialNumber: string | null;
  condition: string | null;
  /** Null: now (the database stamps it). */
  receivedAt: string | null;
  agreementNotes: string | null;
  internalNotes: string | null;
  newProductId: string;
  newUnitId: string | null;
  /** D51: a shop bike record (no owner, not archived, not already a unit). */
  bikeId: string | null;
};

/**
 * Takes a consigned item in (create_consignment_item): a new
 * consignment-owned product (D45), for a unique item its unit (and the
 * linked bike, D51), the consignment_received movement and the C- number.
 * The item, product and unit ids are client-made, so a retry replays.
 */
export async function receiveConsignmentItem(
  supabase: ServerSupabase,
  input: IntakeInput,
): Promise<{ id: string; shortId: string }> {
  const nc = input.newConsignor;
  let result;
  try {
    result = unwrap(
      await supabase.rpc("create_consignment_item", {
        item_id: input.itemId,
        consignor_id: nc?.id ?? input.consignorId,
        // A new consignor is created by the same call, so a refused intake
        // leaves none behind and a retry stores the edited details.
        new_consignor: nc
          ? {
              display_name: nc.displayName,
              phone: nc.phone,
              email: nc.email,
              customer_id: nc.customerId,
            }
          : undefined,
        location_id: input.locationId,
        agreed_amount_owed: input.agreedAmountOwed,
        asking_price: input.askingPrice ?? undefined,
        product_name: input.productName,
        brand: input.brand ?? undefined,
        description: input.description ?? undefined,
        category_id: input.categoryId ?? undefined,
        tracking_type: input.trackingType,
        quantity: input.quantity,
        serial_number: input.serialNumber ?? undefined,
        condition: input.condition ?? undefined,
        received_at: input.receivedAt ?? undefined,
        agreement_notes: input.agreementNotes ?? undefined,
        internal_notes: input.internalNotes ?? undefined,
        new_product_id: input.newProductId,
        new_unit_id: input.newUnitId ?? undefined,
        bike_id: input.bikeId ?? undefined,
      }),
    );
  } catch (err) {
    rethrowFields(err, INTAKE_FIELDS);
  }
  return { id: result?.item_id ?? input.itemId, shortId: result?.short_id ?? "" };
}

/**
 * New agreed amount and/or asking price for an active item
 * (update_consignment_terms). A changed agreed amount needs a reason; the
 * asking price is the public, label and sale price (D45).
 */
export async function updateConsignmentTerms(
  supabase: ServerSupabase,
  input: {
    itemId: string;
    agreedAmountOwed: Money;
    askingPrice: Money | null;
    reason: string | null;
  },
): Promise<void> {
  try {
    unwrap(
      await supabase.rpc("update_consignment_terms", {
        item_id: input.itemId,
        agreed_amount_owed: input.agreedAmountOwed,
        asking_price: input.askingPrice ?? undefined,
        reason: input.reason ?? undefined,
      }),
    );
  } catch (err) {
    rethrowFields(err, {
      reason_required: "reason",
      reason_too_long: "reason",
      consignment_items_agreed_amount_owed_check: "agreedAmountOwed",
      consignment_items_asking_price_check: "askingPrice",
    });
  }
}

/**
 * Change owner (D162, reclassify_as_consignment; admins only): a shop
 * product whose stock was only ever counted becomes consigned stock on the
 * same product. Its stock is counted out of the shop's and taken in as one
 * item of the consignor's; with no stock only the owner changes (no item).
 * The item id is the idempotency key.
 */
export async function reclassifyAsConsignment(
  supabase: ServerSupabase,
  input: {
    itemId: string;
    productId: string;
    consignorId: string;
    agreedAmountOwed: Money;
    askingPrice: Money | null;
    receivedAt: string | null;
    reason: string;
  },
): Promise<{ itemId: string | null; itemShortId: string | null; quantity: number }> {
  try {
    const result = unwrap(
      await supabase.rpc("reclassify_as_consignment", {
        item_id: input.itemId,
        product_id: input.productId,
        consignor_id: input.consignorId,
        agreed_amount_owed: input.agreedAmountOwed,
        reason: input.reason,
        asking_price: input.askingPrice ?? undefined,
        received_at: input.receivedAt ?? undefined,
      }),
    );
    return {
      itemId: result?.consignment_item_id ?? null,
      itemShortId: result?.consignment_item_short_id ?? null,
      quantity: result?.quantity ?? 0,
    };
  } catch (err) {
    rethrowFields(err, {
      reason_required: "reason",
      reason_too_long: "reason",
      consignor_archived: "consignorId",
      consignment_items_agreed_amount_owed_check: "agreedAmountOwed",
      consignment_items_asking_price_check: "askingPrice",
      consignment_received_in_future: "receivedAt",
    });
  }
}

/** A charge with its explicit bearer (D4); the charge id is the idempotency key. */
export async function addConsignmentCharge(
  supabase: ServerSupabase,
  input: {
    chargeId: string;
    itemId: string;
    description: string;
    amount: Money;
    bearer: ChargeBearer;
  },
): Promise<void> {
  try {
    unwrap(
      await supabase.rpc("add_consignment_charge", {
        charge_id: input.chargeId,
        item_id: input.itemId,
        description: input.description,
        amount: input.amount,
        bearer: input.bearer,
      }),
    );
  } catch (err) {
    rethrowFields(err, {
      charge_bearer_required: "bearer",
      consignment_item_charges_description_check: "description",
      consignment_item_charges_amount_check: "amount",
    });
  }
}

/** Voids a charge with a reason (never edited or deleted). */
export async function voidConsignmentCharge(
  supabase: ServerSupabase,
  input: { chargeId: string; reason: string },
): Promise<void> {
  try {
    unwrap(
      await supabase.rpc("void_consignment_charge", {
        charge_id: input.chargeId,
        reason: input.reason,
      }),
    );
  } catch (err) {
    rethrowFields(err, { reason_required: "reason", reason_too_long: "reason" });
  }
}

/**
 * Gives stock back to its consignor (return_consignment_item): a unique
 * item whole, a quantity item `quantity` from `locationId`. The return id
 * is the idempotency key (stored as the movement's request_id).
 */
export async function returnConsignmentItem(
  supabase: ServerSupabase,
  input: {
    returnId: string;
    itemId: string;
    reason: string;
    quantity: number | null;
    locationId: string | null;
  },
): Promise<void> {
  try {
    unwrap(
      await supabase.rpc("return_consignment_item", {
        return_id: input.returnId,
        item_id: input.itemId,
        reason: input.reason,
        quantity: input.quantity ?? undefined,
        location_id: input.locationId ?? undefined,
      }),
    );
  } catch (err) {
    rethrowFields(err, {
      reason_required: "reason",
      reason_too_long: "reason",
      consignment_return_quantity_invalid: "quantity",
      insufficient_stock: "quantity",
      location_inactive: "locationId",
      unit_location_mismatch: "locationId",
    });
  }
}

export type AllocationInput = { itemId: string; amount: Money; overrideReason: string | null };

/**
 * Records money paid to a consignor, allocated to their items
 * (record_settlement, D47). The settlement id is the idempotency key;
 * `paidAt` null stamps now.
 */
export async function recordSettlement(
  supabase: ServerSupabase,
  input: {
    settlementId: string;
    consignorId: string;
    amount: Money;
    allocations: AllocationInput[];
    paidAt: string | null;
    reference: string | null;
    notes: string | null;
  },
): Promise<{ replayed: boolean }> {
  let result;
  try {
    result = unwrap(
      await supabase.rpc("record_settlement", {
        settlement_id: input.settlementId,
        consignor_id: input.consignorId,
        amount: input.amount,
        allocations: input.allocations.map((a) => ({
          consignment_item_id: a.itemId,
          amount: a.amount,
          ...(a.overrideReason ? { override_reason: a.overrideReason } : {}),
        })),
        paid_at: input.paidAt ?? undefined,
        reference: input.reference ?? undefined,
        notes: input.notes ?? undefined,
      }),
    );
  } catch (err) {
    rethrowFields(err, {
      settlement_paid_in_future: "paidAt",
      settlement_allocation_mismatch: "amount",
      consignment_settlements_amount_check: "amount",
      consignment_settlements_reference_check: "reference",
      consignment_settlements_notes_check: "notes",
    });
  }
  return { replayed: result?.replayed === true };
}

/** Reverses a whole settlement with a reason (D47); the reversal id is the idempotency key. */
export async function reverseSettlement(
  supabase: ServerSupabase,
  input: { reversalId: string; settlementId: string; reason: string },
): Promise<void> {
  try {
    unwrap(
      await supabase.rpc("reverse_settlement", {
        reversal_id: input.reversalId,
        settlement_id: input.settlementId,
        reason: input.reason,
      }),
    );
  } catch (err) {
    rethrowFields(err, { reason_required: "reason", reason_too_long: "reason" });
  }
}
