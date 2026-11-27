/**
 * Month-end payouts (PLAN D276; ADR-030; DATA-MODEL §19 "Month-end payouts"): the vocabulary,
 * the month model of /payouts, the DTOs the page reads and the input
 * schemas of its Server Actions. Pure and client-safe.
 *
 * Money: every amount was computed by Postgres (payout_summary) and arrives
 * here as a fixed-2 string. Nothing here adds money up; the only arithmetic
 * is a sign test for the words ("Over by", "Reserve overdrawn by").
 *
 * Months are "YYYY-MM" in the URL and "YYYY-MM-01" for the database, shop
 * months (Asia/Singapore, D35), with UTC calendar maths on the strings.
 */
import { z } from "zod";

import type { Database } from "@/lib/database.types";
import { shopToday } from "@/lib/dates";
import { money } from "@/lib/inventory-forms";
import { formatMoney, parseMoney, toDecimal } from "@/lib/money";
import { REASON_MAX_LENGTH } from "@/lib/reasons";

export type PayoutKind = Database["public"]["Enums"]["payout_kind"];

export const PAYOUT_KIND_LABELS: Readonly<Record<PayoutKind, string>> = {
  mechanic_pay: "Service pay",
  cult_commons: "Cult Commons",
  reserve_labour: "Ad hoc labour",
};

// ---------------------------------------------------------------------------
// Months
// ---------------------------------------------------------------------------

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** The first month /payouts can show. */
export const EARLIEST_PAYOUT_MONTH = "2000-01";

/** "YYYY-MM" of a shop day "YYYY-MM-DD". */
export const monthOf = (day: string) => day.slice(0, 7);

/** The month `n` months after "YYYY-MM". */
export function shiftMonth(month: string, n: number): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7)) - 1 + n;
  const date = new Date(0);
  date.setUTCFullYear(y, m, 1);
  return date.toISOString().slice(0, 7);
}

/** This shop month, "YYYY-MM". */
export const thisMonth = (now: Date = new Date()) => monthOf(shopToday(now));

/**
 * The month the page shows: `?month=YYYY-MM` when it is valid and not in
 * the future, else last month (it is month-end when the owner pays).
 */
export function parseMonth(value: unknown, now: Date = new Date()): string {
  const current = thisMonth(now);
  if (typeof value === "string" && MONTH.test(value)) {
    if (value >= EARLIEST_PAYOUT_MONTH && value <= current) return value;
  }
  return shiftMonth(current, -1);
}

/** "YYYY-MM" → "YYYY-MM-01", what the RPCs take. */
export const monthStart = (month: string) => `${month}-01`;

/** "October 2026". */
export function formatMonth(month: string): string {
  const date = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1));
  return new Intl.DateTimeFormat("en-SG", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export type MechanicPayout = {
  staffId: string;
  name: string;
  serviceRevenue: string;
  /** Their own service after Cult Commons. */
  serviceAfterCc: string;
  /** What the other service revenue, after ad hoc labour, adds to reach the cap. */
  topUp: string;
  /** The cap in force this month; null when the rule starts later. */
  monthlyCap: string | null;
  owed: string;
  paid: string;
  outstanding: string;
  carryOver: string;
  /** The earliest earlier month still owed ("YYYY-MM"), or null. */
  carryFrom: string | null;
};

export type CultCommonsPayout = {
  owed: string;
  paid: string;
  outstanding: string;
  carryOver: string;
  /** The earliest earlier month still owed ("YYYY-MM"), or null. */
  carryFrom: string | null;
};

export type ReservePosition = {
  /** Service on jobs led by nobody on service pay: revenue, and after Cult Commons. */
  otherRevenue: string;
  otherAfterCc: string;
  /** The month's change: own + other - labour - pay (may be below 0). */
  added: string;
  /** The month's ad hoc labour. */
  paid: string;
  /** The balance before this month. */
  before: string;
  balance: string;
};

export type ConsignorOwed = { id: string; name: string; outstanding: string; items: number };

export type PayoutSummary = {
  month: string;
  currency: string;
  mechanics: MechanicPayout[];
  cultCommons: CultCommonsPayout;
  reserve: ReservePosition;
  consignors: { total: string; count: number; owed: ConsignorOwed[] };
  /** Mechanics and Cult Commons (with carry-over, never below 0) plus consignors. */
  total: string;
  /**
   * "YYYY-MM" tracking starts (the first pay rule's month). A month before
   * it is settled: nothing in it is outstanding and the reserve starts after.
   */
  trackedFrom: string | null;
};

export type PayoutRecord = {
  id: string;
  kind: PayoutKind;
  payee: string;
  amount: string;
  currency: string;
  paidAt: string;
  reference: string | null;
  notes: string | null;
  recordedBy: string | null;
  reversedAt: string | null;
  reversalReason: string | null;
  reversedBy: string | null;
};

export type ServicePayRule = {
  id: string;
  staffId: string;
  name: string;
  monthlyCap: string;
  effectiveFrom: string;
  createdAt: string;
};

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

const isNegative = (v: string) => toDecimal(v).isNegative() && !toDecimal(v).isZero();

/**
 * What is left to pay, as the page says it: "$1,200.00 to pay", "Paid",
 * or "Over by $50.00" when more was paid than is owed (operator first).
 */
export function outstandingWords(outstanding: string, currency: string): string {
  const d = toDecimal(outstanding);
  if (d.isZero()) return "Paid";
  if (isNegative(outstanding)) return `Over by ${formatMoney(d.negated(), currency)}`;
  return `${formatMoney(d, currency)} to pay`;
}

/** The reserve balance: "$500.00", or "Reserve overdrawn by $100.00". */
export function reserveWords(balance: string, currency: string): string {
  if (isNegative(balance)) {
    return `Reserve overdrawn by ${formatMoney(toDecimal(balance).negated(), currency)}`;
  }
  return formatMoney(balance, currency);
}

/** "Still owed from earlier months: $x", "Paid ahead by $x", or null when 0. */
export function carryOverWords(carry: string, currency: string): string | null {
  const d = toDecimal(carry);
  if (d.isZero()) return null;
  if (isNegative(carry)) return `Paid ahead by ${formatMoney(d.negated(), currency)}`;
  return `Still owed from earlier months: ${formatMoney(d, currency)}`;
}

/**
 * Where "Still owed from earlier months" links: the earliest earlier month
 * still owed, when there is a carry-over to pay; else null.
 */
export function carryOverMonth(carry: string, carryFrom: string | null): string | null {
  if (!carryFrom || !toDecimal(carry).greaterThan(0)) return null;
  return monthOf(carryFrom);
}

/**
 * The amount Record payment starts with: the month's outstanding, as the
 * database worked it out; blank when nothing is left to pay this month.
 */
export function prefillAmount(outstanding: string): string {
  return toDecimal(outstanding).greaterThan(0) ? toDecimal(outstanding).toFixed(2) : "";
}

// ---------------------------------------------------------------------------
// Input schemas (the Server Actions; the RPCs check everything again)
// ---------------------------------------------------------------------------

const text = (max: number, what: string) =>
  z
    .string()
    .trim()
    .max(max, { error: `Keep the ${what} under ${max.toLocaleString("en-SG")} characters.` })
    .nullish()
    .transform((v) => (v ? v : null));

const positive = (what: string) =>
  money(what).refine((v) => parseMoney(v)!.greaterThan(0), {
    error: `The ${what} must be more than 0.`,
  });

const monthField = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])-01$/, { error: "Choose the month." })
  .nullish()
  .transform((v) => v ?? null);

export const recordPayoutSchema = z
  .object({
    id: z.guid({ error: "Start the payment again." }),
    kind: z.enum(["mechanic_pay", "cult_commons", "reserve_labour"], {
      error: "Unknown kind of payment.",
    }),
    amount: positive("amount paid"),
    month: monthField,
    staffId: z
      .union([z.guid({ error: "Unknown staff member." }), z.literal(""), z.null()])
      .optional()
      .transform((v) => v || null),
    payeeName: text(200, "name"),
    paidAt: z.iso
      .datetime({ offset: true, error: "Choose the date it was paid." })
      .nullish()
      .transform((v) => v ?? null),
    reference: text(200, "reference"),
    notes: text(2_000, "notes"),
  })
  .superRefine((v, ctx) => {
    if (v.kind !== "reserve_labour" && !v.month) {
      ctx.addIssue({ code: "custom", path: ["month"], message: "Choose the month." });
    }
    if (v.kind === "mechanic_pay" && !v.staffId) {
      ctx.addIssue({ code: "custom", path: ["staffId"], message: "Choose the mechanic." });
    }
    if (v.kind === "reserve_labour" && !v.staffId === !v.payeeName) {
      ctx.addIssue({
        code: "custom",
        path: ["payeeName"],
        message: "Choose a staff member or type a name, not both.",
      });
    }
  });

export const reversePayoutSchema = z.object({
  payoutId: z.guid({ error: "Unknown payment." }),
  reason: z
    .string({ error: "Say why the payment is reversed." })
    .trim()
    .min(1, { error: "Say why the payment is reversed." })
    .max(REASON_MAX_LENGTH, { error: `Keep the reason under ${REASON_MAX_LENGTH} characters.` }),
});

export const servicePayRuleSchema = z.object({
  staffId: z.guid({ error: "Choose the mechanic." }),
  monthlyCap: money("monthly cap"),
  effectiveFrom: z
    .string({ error: "Choose the month it starts." })
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, { error: "Choose the month it starts." })
    .transform((v) => `${v}-01`),
});
