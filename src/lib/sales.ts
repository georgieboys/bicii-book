/**
 * In-store sales, for people (SPEC §10, §13, §22; DATA-MODEL §8; PLAN D1,
 * D7, D46, D48, D49, D53). Pure and client-safe: the sale sheet's preview
 * and warnings, the Sales list's ranges and the status words. The database
 * is the authority: these only say, before it answers, what it will store.
 *
 * Cult Commons previews go through src/lib/cult-commons.ts (lineEconomics /
 * jobEconomics), the one TS mirror of the generated columns, so a sale's
 * preview and a job's use the same arithmetic (D1: per line, max(yield, 0)
 * x rate, half up).
 */
import type { Database } from "@/lib/database.types";
import { jobEconomics, lineEconomics, type Economics, type LineInput } from "@/lib/cult-commons";
import {
  SHOP_UTC_OFFSET,
  parseShopDay,
  shiftShopDay,
  shopDayStart,
  type DateInput,
} from "@/lib/dates";
import { Decimal, toDecimal, toMoneyString, type MoneyInput } from "@/lib/money";

export type SaleStatus = Database["public"]["Enums"]["sale_status"];

// ---------------------------------------------------------------------------
// Preview (D1)
// ---------------------------------------------------------------------------

export type SalePreview = {
  /** Each line's economics, in the order given. */
  lines: Economics[];
  /** The sums of the lines' (Cult Commons per line, never netted). */
  total: Economics;
};

/**
 * What a sale would snapshot: each line's sale, cost, yield, Cult Commons
 * and BICII after Cult Commons, and their sums (a loss-making line adds no
 * Cult Commons and takes none from another line). Display only.
 */
export function previewSale(lines: readonly LineInput[]): SalePreview {
  return { lines: lines.map(lineEconomics), total: jobEconomics(lines) };
}

// ---------------------------------------------------------------------------
// Quantity (the sale sheet's field)
// ---------------------------------------------------------------------------

export const SALE_QUANTITY_MESSAGE = "Enter a whole number, like 1.";

/**
 * The sale sheet's quantity text as a whole number of 1 or more, or null:
 * digits only (surrounding spaces allowed), so "1.5", "2x" or "1e3" are not
 * read as a different number than the field shows.
 */
export function saleQuantity(text: string): number | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

// ---------------------------------------------------------------------------
// Price warnings (D53: any staff may change a price; no database floor)
// ---------------------------------------------------------------------------

export const BELOW_ASKING = "Below the asking price";
export const BELOW_COST = "Below cost: this sale loses money";

/**
 * The sale sheet's warnings for one line's price (D53). "Below the asking
 * price" when the price is under the database selling price (shown to
 * everyone); "Below cost: this sale loses money" when a cost is given and
 * the price is under it (the sheet passes a cost to view_costs holders
 * only). 0 is a known price and cost (D24): a free line under a priced item
 * warns, a free line of a free item does not. Never blocks.
 */
export function priceWarnings({
  price,
  referencePrice,
  cost,
}: {
  price: MoneyInput | null;
  referencePrice: MoneyInput | null;
  cost?: MoneyInput | null;
}): string[] {
  if (price === null) return [];
  const p = toDecimal(price);
  const out: string[] = [];
  if (referencePrice !== null && p.lessThan(toDecimal(referencePrice))) out.push(BELOW_ASKING);
  if (cost !== undefined && cost !== null && p.lessThan(toDecimal(cost))) out.push(BELOW_COST);
  return out;
}

// ---------------------------------------------------------------------------
// Status (D49: refunds change only the status)
// ---------------------------------------------------------------------------

const STATUS_LABELS: Record<SaleStatus, string> = {
  recorded: "Recorded",
  partially_refunded: "Partly refunded",
  refunded: "Refunded",
  voided: "Voided",
};

export type SaleTone = "neutral" | "waiting" | "done" | "danger" | "info";

const STATUS_TONES: Record<SaleStatus, SaleTone> = {
  recorded: "done",
  partially_refunded: "waiting",
  refunded: "danger",
  voided: "neutral",
};

export function saleStatusLabel(status: SaleStatus): string {
  return STATUS_LABELS[status];
}

export function saleStatusTone(status: SaleStatus): SaleTone {
  return STATUS_TONES[status];
}

// ---------------------------------------------------------------------------
// Ranges for /sales (shop days, Asia/Singapore; D35)
// ---------------------------------------------------------------------------

export const SALE_RANGES = [
  { key: "today", label: "Today", days: 1 },
  { key: "7d", label: "7 days", days: 7 },
  { key: "30d", label: "30 days", days: 30 },
] as const;

export type SaleRange = (typeof SALE_RANGES)[number]["key"];

/** `?range=`: one of today, 7d, 30d; anything else is 7d. */
export function readSaleRange(value: unknown): SaleRange {
  return SALE_RANGES.some((r) => r.key === value) ? (value as SaleRange) : "7d";
}

/** `?day=`: one shop day ("YYYY-MM-DD", from Today's tiles), else null. */
export function readSaleDay(value: unknown): string | null {
  return parseShopDay(value);
}

/** The instants [from, to) of one shop day: its Singapore midnight to the next (D35). */
export function saleDayRange(day: string): { from: string; to: string } {
  const start = new Date(`${day}T00:00:00${SHOP_UTC_OFFSET}`);
  const end = new Date(`${shiftShopDay(day, 1)}T00:00:00${SHOP_UTC_OFFSET}`);
  return { from: start.toISOString(), to: end.toISOString() };
}

/**
 * The instants [from, to) of a range in shop time: Today is the shop day
 * of `now` (from its Singapore midnight to the next), 7 days and 30 days
 * end with today and start that many shop days back (today included).
 * ISO strings in UTC, for list_sales.
 */
export function saleRange(
  range: SaleRange,
  now: DateInput = new Date(),
): { from: string; to: string } {
  const days = SALE_RANGES.find((r) => r.key === range)?.days ?? 7;
  const start = shopDayStart(now, days - 1);
  const end = new Date(shopDayStart(now, 0).getTime() + 86_400_000);
  return { from: start.toISOString(), to: end.toISOString() };
}

// ---------------------------------------------------------------------------
// Refunds (D49: capped at the sale total minus earlier refunds)
// ---------------------------------------------------------------------------

/** What is left to refund on a sale (never below 0), as a fixed-2 string. */
export function refundableAmount(
  saleTotal: MoneyInput,
  refunds: readonly { amount: MoneyInput }[],
  currency?: string,
): string {
  const left = refunds.reduce<Decimal>(
    (acc, r) => acc.minus(toDecimal(r.amount)),
    toDecimal(saleTotal),
  );
  return toMoneyString(Decimal.max(left, 0), currency);
}

/** D7, said where a refund is recorded. */
export const REFUND_NOT_RESTOCK =
  "A refund does not put anything back in stock. If the item came back, restock it separately.";

/** D46, said where a consigned unit is restocked. */
export const CONSIGNED_RESTOCK_NOTE =
  "It goes back on sale for the consignor and is no longer owed to them.";

/** D51, said on a sale line whose unit is a bike. */
export const BIKE_NOT_TRANSFERRED =
  "Ownership is not transferred automatically; use Transfer on the bike page.";
