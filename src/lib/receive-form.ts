/**
 * The Receive screen's pure parts (SPEC §2 "retries cannot duplicate
 * stock", §14, §22; PLAN D63 D-LASTCOST, D64 D-RECEIPT-TIME,
 * D65 D-OVERRECEIPT): the values typed, the lines sent to receive_purchase,
 * the totals and value preview, the duplicate delivery-note guard, the key
 * store, and the idempotency state machine ReceiveForm runs on. Pure: safe
 * in Client Components and unit tests (tests/unit/receive-form.test.ts).
 *
 * The idempotency key is the receipt's: receive_purchase replays it (the
 * same key and lines return the first receipt and write nothing) and
 * refuses it with other lines (purchase_receipt_key_reused). So the rules
 * are:
 *   - one key per delivery, made when the form first mounts, kept across
 *     reloads in sessionStorage with the values typed;
 *   - after an unknown outcome (the call threw: network lost, response
 *     aborted) nothing is editable until purchase_receipt_by_key says
 *     whether it was recorded;
 *   - a retry after "not recorded" reuses the key (nothing was written
 *     under it, and if the first request lands later, the retry replays it
 *     or, with other values, is refused as key_reused and shown as
 *     recorded);
 *   - a fresh key comes only with fresh values ("Receive another delivery"):
 *     never a new key with the old values, which could receive twice.
 */
import { formatDateTime, formatTime, fromShopLocal, shopDateKey, toShopLocal } from "@/lib/dates";
import { Decimal, lineTotal, parseMoney, sumMoney, toMoneyString } from "@/lib/money";
import { plural } from "@/lib/plural";
import { MAX_PURCHASE_UNIT_COST } from "@/lib/purchasing";

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/** What the form knows about one open PO line. */
export type ReceiveLineDef = {
  id: string;
  /** Still to come: the most this delivery can receive (D65). */
  outstanding: number;
  /** The PO line's unit cost ("12.00"): the actual cost's prefill. */
  unitCost: string;
};

export type ReceiveLineValues = {
  /** Typed text; "" counts as 0. */
  quantity: string;
  /** Typed text, parsed with parseMoney. */
  unitCost: string;
  /** null: the form-level "Receive into" location. */
  locationId: string | null;
};

export type ReceiveValues = {
  lines: Record<string, ReceiveLineValues>;
  /** The form-level "Receive into" location. */
  receiveInto: string;
  reference: string;
  notes: string;
  /** The datetime-local text (shop time); sent only when `receivedAtChanged`. */
  receivedAt: string;
  receivedAtChanged: boolean;
  /** The duplicate delivery-note guard's acknowledgement (D65). */
  differentDelivery: boolean;
};

/** A fresh form: every line at its outstanding quantity and the PO cost. */
export function defaultValues(
  lines: readonly ReceiveLineDef[],
  receiveInto: string,
): ReceiveValues {
  return {
    lines: Object.fromEntries(
      lines.map((l) => [
        l.id,
        { quantity: String(l.outstanding), unitCost: l.unitCost, locationId: null },
      ]),
    ),
    receiveInto,
    reference: "",
    notes: "",
    receivedAt: "",
    receivedAtChanged: false,
    differentDelivery: false,
  };
}

/**
 * Stored values over the current lines: a line the form no longer shows
 * (fully received meanwhile) is dropped, a new one gets its defaults.
 */
export function mergeValues(
  lines: readonly ReceiveLineDef[],
  stored: ReceiveValues,
  receiveInto: string,
): ReceiveValues {
  const fresh = defaultValues(lines, receiveInto);
  return {
    ...stored,
    receiveInto: stored.receiveInto || receiveInto,
    lines: Object.fromEntries(lines.map((l) => [l.id, stored.lines[l.id] ?? fresh.lines[l.id]])),
  };
}

/** Every line set to its outstanding quantity ("All to come") or to 0 ("Clear all"). */
export function setAllQuantities(
  values: ReceiveValues,
  lines: readonly ReceiveLineDef[],
  to: "outstanding" | "zero",
): ReceiveValues {
  const next = { ...values.lines };
  for (const l of lines) {
    const current = next[l.id] ?? { quantity: "0", unitCost: l.unitCost, locationId: null };
    next[l.id] = { ...current, quantity: to === "zero" ? "0" : String(l.outstanding) };
  }
  return { ...values, lines: next };
}

// ---------------------------------------------------------------------------
// One line
// ---------------------------------------------------------------------------

/** A whole number 0..outstanding; the stepper bounds. */
export function clampQuantity(n: number, outstanding: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(Math.trunc(n), 0), Math.max(outstanding, 0));
}

export type QuantityCheck =
  { ok: true; quantity: number } | { ok: false; quantity: number | null; message: string };

/**
 * The quantity typed on a line: a whole number from 0 to what is still to
 * come. More than that is refused with the D65 sentence (extra units need a
 * higher ordered quantity first).
 */
export function checkQuantity(text: string, outstanding: number): QuantityCheck {
  const t = text.trim();
  if (t === "") return { ok: true, quantity: 0 };
  if (!/^\d+$/.test(t)) {
    return { ok: false, quantity: null, message: "Enter a whole number, like 0 or 18." };
  }
  const n = Number(t);
  if (n > outstanding) {
    return {
      ok: false,
      quantity: n,
      message: `Only ${outstanding} still to come. Raise the ordered quantity on the order first.`,
    };
  }
  return { ok: true, quantity: n };
}

const MAX_COST = new Decimal(MAX_PURCHASE_UNIT_COST);

export type CostCheck = { ok: true; cost: string } | { ok: false; message: string };

/**
 * The actual unit cost typed: 0..99,999.99 with at most 2 decimals, as a
 * fixed-point string. 0 is a KNOWN cost (free goods; D24 as amended, D63);
 * only a blank is missing. Mirrors purchaseUnitCostSchema's rules.
 */
export function checkCost(text: string, currency?: string): CostCheck {
  const t = text.trim();
  if (t === "") return { ok: false, message: "Enter the unit cost (0 for free goods)." };
  if (/\.\d{3,}$/.test(t)) return { ok: false, message: "Use at most 2 decimals, like 12.50." };
  const d = parseMoney(t, { currency });
  if (d === null) {
    return { ok: false, message: "Enter the unit cost as an amount of 0 or more, like 12.50." };
  }
  if (d.gt(MAX_COST)) return { ok: false, message: "The unit cost can be at most 99,999.99." };
  return { ok: true, cost: toMoneyString(d, currency) };
}

/** Whether the typed cost differs from the PO line's (the neutral badge). */
export function costDiffers(typed: string, poCost: string, currency?: string): boolean {
  const c = checkCost(typed, currency);
  return c.ok && !new Decimal(c.cost).eq(new Decimal(poCost));
}

// ---------------------------------------------------------------------------
// The submission
// ---------------------------------------------------------------------------

/** One line of the receivePurchase action's input. */
export type ReceiveActionLine = {
  purchaseOrderLineId: string;
  /** A whole number, at least 1. */
  quantityReceived: number;
  /** Always sent, as a fixed-point string; "0.00" is a known cost. */
  unitCostActual: string;
  locationId: string;
};

export type BuiltLines =
  | { ok: true; lines: ReceiveActionLine[] }
  | { ok: false; lineErrors: Record<string, { quantity?: string; unitCost?: string }> };

/**
 * The lines to send: lines at 0 are left out; quantities are integers;
 * every included line carries its cost as a string (never omitted, so the
 * receipt's cost is exactly what was confirmed on screen); its location is
 * the line's own or the form's "Receive into".
 */
export function buildReceiptLines(
  defs: readonly ReceiveLineDef[],
  values: ReceiveValues,
  currency?: string,
): BuiltLines {
  const lines: ReceiveActionLine[] = [];
  const lineErrors: Record<string, { quantity?: string; unitCost?: string }> = {};
  for (const def of defs) {
    const v = values.lines[def.id];
    if (!v) continue;
    const q = checkQuantity(v.quantity, def.outstanding);
    if (!q.ok) {
      lineErrors[def.id] = { quantity: q.message };
      continue;
    }
    if (q.quantity === 0) continue;
    const c = checkCost(v.unitCost, currency);
    if (!c.ok) {
      lineErrors[def.id] = { unitCost: c.message };
      continue;
    }
    lines.push({
      purchaseOrderLineId: def.id,
      quantityReceived: q.quantity,
      unitCostActual: c.cost,
      locationId: v.locationId ?? values.receiveInto,
    });
  }
  return Object.keys(lineErrors).length > 0 ? { ok: false, lineErrors } : { ok: true, lines };
}

/** The action lines as receive_purchase's JSON (snake_case; costs stay strings). */
export function toRpcLines(lines: readonly ReceiveActionLine[]) {
  return lines.map((l) => ({
    purchase_order_line_id: l.purchaseOrderLineId,
    quantity_received: l.quantityReceived,
    unit_cost_actual: l.unitCostActual,
    location_id: l.locationId,
  }));
}

export type ReceiveTotals = {
  items: number;
  lines: number;
  /** "18 items on 1 line" */
  text: string;
  /** Σ quantity × cost of the valid lines: a PREVIEW, never authoritative. */
  value: Decimal;
};

/** "1 item", "18 items". */
export const itemsText = (n: number) => plural(n, "item", "items");

/** The sticky footer's counts and value preview (lines with a valid quantity above 0). */
export function receiveTotals(
  defs: readonly ReceiveLineDef[],
  values: ReceiveValues,
  currency?: string,
): ReceiveTotals {
  let items = 0;
  let lines = 0;
  const amounts: Decimal[] = [];
  for (const def of defs) {
    const v = values.lines[def.id];
    if (!v) continue;
    const q = checkQuantity(v.quantity, def.outstanding);
    if (!q.ok || q.quantity === 0) continue;
    items += q.quantity;
    lines += 1;
    const c = checkCost(v.unitCost, currency);
    if (c.ok) amounts.push(lineTotal(q.quantity, c.cost, currency));
  }
  return {
    items,
    lines,
    text: `${itemsText(items)} on ${plural(lines, "line", "lines")}`,
    value: sumMoney(amounts),
  };
}

// ---------------------------------------------------------------------------
// Received date-time (D64)
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/**
 * The datetime-local bounds in shop time: from 30 days ago (or the order's
 * submission, if later) to now. The server checks again (5 minutes of
 * clock skew ahead allowed there).
 */
export function receivedAtBounds(
  now: Date,
  submittedAt: string | null,
): { min: string; max: string } {
  const floor = now.getTime() - 30 * DAY_MS;
  const submitted = submittedAt ? new Date(submittedAt).getTime() : Number.NaN;
  const min = Number.isNaN(submitted) ? floor : Math.max(floor, submitted);
  return { min: toShopLocal(new Date(min)), max: toShopLocal(now) };
}

/**
 * receivedAt for the action: undefined while untouched (the server uses
 * now()), the instant as ISO when changed, or null when what was typed is
 * not a date-time.
 */
export function receivedAtForSubmit(values: ReceiveValues): string | undefined | null {
  if (!values.receivedAtChanged) return undefined;
  const d = fromShopLocal(values.receivedAt);
  return d ? d.toISOString() : null;
}

/** The business codes about the delivery date, shown on its field. */
export const RECEIVED_AT_CODES: ReadonlySet<string> = new Set([
  "purchase_receipt_in_future",
  "purchase_receipt_too_old",
  "purchase_receipt_before_submission",
]);

// ---------------------------------------------------------------------------
// Duplicate delivery-note guard (D65)
// ---------------------------------------------------------------------------

/** A delivery-note reference as compared: trimmed, lower-case. */
export function normaliseReference(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

export type RecordedReference = {
  /** As recorded (shown back). */
  reference: string;
  /** normaliseReference(reference) */
  normalised: string;
  receivedAt: string;
  receivedBy: string;
  units: number;
};

/** The earlier receipt on this order with the same delivery note, or null. */
export function duplicateReference(
  reference: string,
  recorded: readonly RecordedReference[],
): RecordedReference | null {
  const n = normaliseReference(reference);
  if (!n) return null;
  return recorded.find((r) => r.normalised === n) ?? null;
}

/** "at 10:42 am" today (shop time), else "on 5 Oct 2026, 10:42 am". */
export function whenText(at: string, now: Date = new Date()): string {
  return shopDateKey(at) === shopDateKey(now) ? `at ${formatTime(at)}` : `on ${formatDateTime(at)}`;
}

/** A recent receipt's time: "10:42 am" today (shop time), else "4 Oct 2026, 5:30 pm". */
export function receiptTimeText(at: string, now: Date = new Date()): string {
  return shopDateKey(at) === shopDateKey(now) ? formatTime(at) : formatDateTime(at);
}

/** "DN-5531 was already recorded at 10:42 am by Asha Admin (18 items)" */
export function duplicateWarning(match: RecordedReference, now: Date = new Date()): string {
  return `${match.reference} was already recorded ${whenText(match.receivedAt, now)} by ${match.receivedBy} (${itemsText(match.units)})`;
}

// ---------------------------------------------------------------------------
// The key store (sessionStorage)
// ---------------------------------------------------------------------------

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type ReceiveDraft = {
  v: 1;
  /** The receipt's idempotency key. */
  key: string;
  values: ReceiveValues;
  /** A submission under this key was started and not answered. */
  pending: boolean;
};

export const receiveDraftKey = (purchaseOrderId: string) => `bicii:receive:${purchaseOrderId}`;

function sessionStore(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValues(v: unknown): v is ReceiveValues {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.lines === "object" &&
    o.lines !== null &&
    typeof o.receiveInto === "string" &&
    typeof o.reference === "string" &&
    typeof o.notes === "string" &&
    typeof o.receivedAt === "string" &&
    typeof o.receivedAtChanged === "boolean" &&
    typeof o.differentDelivery === "boolean"
  );
}

/** The stored draft for this order, or null (none, unreadable, or storage unavailable). */
export function loadReceiveDraft(
  purchaseOrderId: string,
  storage: StorageLike | null = sessionStore(),
): ReceiveDraft | null {
  try {
    const raw = storage?.getItem(receiveDraftKey(purchaseOrderId));
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<ReceiveDraft>;
    if (d.v !== 1 || typeof d.key !== "string" || !UUID.test(d.key) || !isValues(d.values)) {
      return null;
    }
    return { v: 1, key: d.key, values: d.values, pending: d.pending === true };
  } catch {
    return null;
  }
}

/** Saves the draft; false when storage is unavailable (the page works without it). */
export function saveReceiveDraft(
  purchaseOrderId: string,
  draft: Omit<ReceiveDraft, "v">,
  storage: StorageLike | null = sessionStore(),
): boolean {
  try {
    if (!storage) return false;
    storage.setItem(receiveDraftKey(purchaseOrderId), JSON.stringify({ v: 1, ...draft }));
    return true;
  } catch {
    return false;
  }
}

export function clearReceiveDraft(
  purchaseOrderId: string,
  storage: StorageLike | null = sessionStore(),
): void {
  try {
    storage?.removeItem(receiveDraftKey(purchaseOrderId));
  } catch {
    // Storage unavailable: nothing was stored either.
  }
}

/** The last "Receive into" location on this device (localStorage; a convenience only). */
export const RECEIVE_INTO_KEY = "bicii:receive-into";

// ---------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------

export type ReceiptSummary = {
  receiptId: string;
  purchaseOrderId: string;
  poNumber: string;
  receivedAt: string;
  receivedBy: string;
  reference: string | null;
  units: number;
};

/**
 *   starting    before the key store was read (nothing editable yet)
 *   editing     values editable; the key is kept
 *   submitting  a call is in flight under the key; read-only
 *   checking    outcome unknown: purchase_receipt_by_key decides; read-only
 *   notRecorded checked: nothing was written; Retry (same key) or edit
 *   recorded    a receipt exists under the key; "Receive another delivery"
 *   closed      the order was closed meanwhile (purchase_order_closed)
 *   done        received; navigating to the order
 */
export type ReceivePhase =
  | "starting"
  | "editing"
  | "submitting"
  | "checking"
  | "notRecorded"
  | "recorded"
  | "closed"
  | "done";

export type ReceiveState = {
  phase: ReceivePhase;
  /** The receipt's idempotency key (null only while starting). */
  key: string | null;
  values: ReceiveValues;
  /** submitting for 20 s without an answer: "Still confirming…". */
  slow: boolean;
  /** checking: the lookup failed; offer "Check again". */
  lookupFailed: boolean;
  /** checking a key found in storage on mount: was a submission pending? */
  resumedPending: boolean | null;
  recorded: ReceiptSummary | null;
  /** The last refusal, shown above the footer. */
  error: string | null;
  /** The delivery date's refusal (D64 codes). */
  receivedAtError: string | null;
  /** purchase_over_receipt came back: show the per-line limits. */
  overReceipt: boolean;
};

export type ReceiveEvent =
  /** Mount without a stored key: a new key. */
  | { type: "start"; key: string; values: ReceiveValues }
  /** Mount with a stored key: check it before anything is editable. */
  | { type: "resume"; key: string; values: ReceiveValues; pending: boolean }
  | { type: "edit"; values: ReceiveValues }
  | { type: "submit" }
  | { type: "slow" }
  | { type: "succeeded" }
  /** The server answered with a refusal (nothing was written under the key). */
  | { type: "refused"; code?: string; message: string }
  /** The call threw or was aborted: it may or may not have committed. */
  | { type: "unknown" }
  /** purchase_receipt_key_reused: a submission under this key WAS committed. */
  | { type: "keyReused" }
  | { type: "found"; receipt: ReceiptSummary }
  | { type: "notFound" }
  | { type: "lookupFailed" }
  | { type: "checkAgain" }
  /** From recorded: a fresh form, a NEW key and NEW defaults (old values discarded). */
  | { type: "receiveAnother"; key: string; values: ReceiveValues };

export function initialReceiveState(values: ReceiveValues): ReceiveState {
  return {
    phase: "starting",
    key: null,
    values,
    slow: false,
    lookupFailed: false,
    resumedPending: null,
    recorded: null,
    error: null,
    receivedAtError: null,
    overReceipt: false,
  };
}

/** Whether the values may be changed (and submitted). */
export function isEditable(phase: ReceivePhase): boolean {
  return phase === "editing" || phase === "notRecorded";
}

const toChecking = (s: ReceiveState): ReceiveState => ({
  ...s,
  phase: "checking",
  slow: false,
  lookupFailed: false,
  resumedPending: null,
  error: null,
});

export function receiveReducer(state: ReceiveState, event: ReceiveEvent): ReceiveState {
  switch (event.type) {
    case "start":
      if (state.phase !== "starting") return state;
      return { ...state, phase: "editing", key: event.key, values: event.values };
    case "resume":
      if (state.phase !== "starting") return state;
      return {
        ...toChecking(state),
        key: event.key,
        values: event.values,
        resumedPending: event.pending,
      };
    case "edit":
      if (!isEditable(state.phase)) return state;
      return { ...state, values: event.values };
    case "submit":
      if (!isEditable(state.phase) || state.key === null) return state;
      return {
        ...state,
        phase: "submitting",
        slow: false,
        error: null,
        receivedAtError: null,
      };
    case "slow":
      return state.phase === "submitting" ? { ...state, slow: true } : state;
    case "succeeded":
      return state.phase === "submitting" ? { ...state, phase: "done", slow: false } : state;
    case "refused": {
      if (state.phase !== "submitting") return state;
      const base = { ...state, slow: false };
      if (event.code === "purchase_order_closed") {
        return { ...base, phase: "closed", error: event.message };
      }
      if (event.code && RECEIVED_AT_CODES.has(event.code)) {
        return { ...base, phase: "editing", error: null, receivedAtError: event.message };
      }
      return {
        ...base,
        phase: "editing",
        error: event.message,
        overReceipt: event.code === "purchase_over_receipt",
      };
    }
    case "unknown":
    case "keyReused":
      return state.phase === "submitting" ? toChecking(state) : state;
    case "found":
      if (state.phase !== "checking") return state;
      return { ...state, phase: "recorded", recorded: event.receipt, lookupFailed: false };
    case "notFound":
      if (state.phase !== "checking") return state;
      return {
        ...state,
        // A stored key whose submission never started: just the form again.
        phase: state.resumedPending === false ? "editing" : "notRecorded",
        lookupFailed: false,
        resumedPending: null,
      };
    case "lookupFailed":
      return state.phase === "checking" ? { ...state, lookupFailed: true } : state;
    case "checkAgain":
      return state.phase === "checking" ? { ...state, lookupFailed: false } : state;
    case "receiveAnother":
      if (state.phase !== "recorded") return state;
      return {
        ...initialReceiveState(event.values),
        phase: "editing",
        key: event.key,
      };
  }
}
