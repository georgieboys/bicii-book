/**
 * Period reports (Phase 9; SPEC §19.2, §21, §22; PLAN D30, D100–D105;
 * ADR-022): the vocabulary, the period model, the URL state of /reports and
 * the DTOs the screens and the CSV export read. Pure and client-safe: the
 * server-only reads are in src/lib/domain/period-reports.ts, which maps the
 * step 1 RPC rows onto these DTOs.
 *
 * Money: every amount was computed by Postgres and arrives here as a fixed-2
 * string with its currency. Nothing in this module adds, subtracts or
 * multiplies money. A figure the database withheld (D30: cost-derived
 * columns without view_costs) is null, never 0.
 *
 * Days are "YYYY-MM-DD" shop days (D35). Date arithmetic is on the date
 * strings with UTC calendar maths only (Date.UTC / getUTC*), never the
 * machine's local zone.
 */
import { Constants, type Database } from "@/lib/database.types";
import { EARLIEST_SHOP_DAY, parseShopDay, shiftShopDay } from "@/lib/dates";
import { BUSINESS_ERRORS } from "@/lib/db-errors";
import { hrefForRecord } from "@/lib/ids";

// ---------------------------------------------------------------------------
// Vocabulary (from the generated enums, so a new value fails typecheck)
// ---------------------------------------------------------------------------

export type ReportBasis = Database["public"]["Enums"]["report_date_basis"];
export type ReportDimension = Database["public"]["Enums"]["report_dimension"];
export type ReportGrain = Database["public"]["Enums"]["report_grain"];

/** D100: the four date bases, in the order the control shows them. */
export const BASIS_VALUES: readonly ReportBasis[] = Constants.public.Enums.report_date_basis;
export const DIMENSION_VALUES: readonly ReportDimension[] = Constants.public.Enums.report_dimension;

/** D100 REPORT-BASES: what each basis counts, as the control and its description say it. */
export const BASES: Readonly<Record<ReportBasis, { label: string; description: string }>> = {
  sale: {
    label: "Sale date",
    description:
      "Jobs on the day they were completed; retail and online sales on the day they were paid. This is the financial figure.",
  },
  check_in: {
    label: "Check-in",
    description:
      "Jobs on the day the bike was checked in, including work not finished yet. Sales are not included.",
  },
  completion: {
    label: "Completed",
    description: "Jobs on the day they were completed. Sales are not included.",
  },
  collection: {
    label: "Collected",
    description: "Jobs on the day the customer collected the bike. Sales are not included.",
  },
};

/** The breakdown dimensions, in the order the strip shows them. */
export const DIMENSIONS: Readonly<Record<ReportDimension, { label: string }>> = {
  job: { label: "Job / sale" },
  product: { label: "Product" },
  category: { label: "Category" },
  service: { label: "Service" },
  mechanic: { label: "Mechanic" },
  ownership: { label: "Ownership" },
  channel: { label: "Channel" },
};

/**
 * The pseudo keys of each dimension (private.report_key_valid, step 1):
 * every other key is a lowercase uuid. Ownership and channel have only
 * pseudo keys. The labels match report_breakdown's.
 */
export const PSEUDO_KEYS: Readonly<Record<ReportDimension, Readonly<Record<string, string>>>> = {
  job: {},
  // D273: a completed job's Stripe fee entry groups as stripe_fees.
  product: { none: "Services and labour", stripe_fees: "Stripe fees" },
  category: { none: "Uncategorised", stripe_fees: "Stripe fees" },
  service: { products: "Parts and products", manual: "Custom lines", stripe_fees: "Stripe fees" },
  mechanic: { unassigned: "Unassigned", not_workshop: "Not workshop" },
  ownership: {
    shop_owned: "Shop-owned stock",
    consignment: "Consignment",
    customer_owned: "Customer-owned",
    service: "Services and labour",
    stripe_fees: "Stripe fees",
  },
  channel: { workshop: "Workshop", retail: "Retail", online: "Online" },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Mirrors private.report_key_valid: a key the dimension can have (a malformed one is not-found). */
export function isReportKey(dimension: ReportDimension, key: string): boolean {
  if (dimension === "ownership" || dimension === "channel") return key in PSEUDO_KEYS[dimension];
  return UUID.test(key) || key in PSEUDO_KEYS[dimension];
}

type Fn = Database["public"]["Functions"];
type SummaryRow = Fn["report_period_summary"]["Returns"][number];
type SeriesRow = Fn["report_period_series"]["Returns"][number];
type BreakdownRpcRow = Fn["report_breakdown"]["Returns"][number];
type LineRpcRow = Fn["report_line_items"]["Returns"][number];
type StockValueRpcRow = Fn["report_stock_value"]["Returns"][number];

/**
 * The columns each RPC returns NULL without view_costs (D30), typed against
 * the generated return types so a renamed column fails typecheck. The
 * screens hide these figures, and the CSV export omits these columns.
 */
export const COST_GATED = {
  summary: [
    "loss_line_count",
    "cost_total",
    "yield_total",
    "cult_commons_share",
    "yield_after_cc",
    "new_consignor_liability",
    "settlements_paid_total",
    "purchases_received_total",
    "stripe_fees",
    "stripe_fees_borne",
  ],
  series: [
    "cost_total",
    "yield_total",
    "cult_commons_share",
    "yield_after_cc",
    "loss_line_count",
    "new_consignor_liability",
    "settlements_paid_total",
  ],
  breakdown: ["cost_total", "yield_total", "cult_commons_share", "yield_after_cc"],
  lines: ["cost_total", "yield_total", "cult_commons_share"],
  stockValue: ["value_at_cost"],
} as const satisfies {
  summary: readonly (keyof SummaryRow)[];
  series: readonly (keyof SeriesRow)[];
  breakdown: readonly (keyof BreakdownRpcRow)[];
  lines: readonly (keyof LineRpcRow)[];
  stockValue: readonly (keyof StockValueRpcRow)[];
};

// ---------------------------------------------------------------------------
// The period model
// ---------------------------------------------------------------------------

export type ReportPeriod = "day" | "week" | "month" | "custom";
export const PERIODS: readonly ReportPeriod[] = ["day", "week", "month", "custom"];
export const PERIOD_LABELS: Readonly<Record<ReportPeriod, string>> = {
  day: "Day",
  week: "Week",
  month: "Month",
  custom: "Custom",
};
/** The word the stepper uses: "Previous week", "Next range". */
export const PERIOD_NOUNS: Readonly<Record<ReportPeriod, string>> = {
  day: "day",
  week: "week",
  month: "month",
  custom: "range",
};

/** D100: a report covers at most 731 shop days (private.report_require_range). */
export const MAX_RANGE_DAYS = 731;

export type DayRange = { from: string; to: string };

const MS_PER_DAY = 86_400_000;
const utc = (day: string) => Date.parse(`${day}T00:00:00Z`);
const ymd = (y: number, m: number, d: number) => {
  const date = new Date(0);
  date.setUTCFullYear(y, m, d);
  return date.toISOString().slice(0, 10);
};
const parts = (day: string) => ({
  y: Number(day.slice(0, 4)),
  m: Number(day.slice(5, 7)) - 1,
  d: Number(day.slice(8, 10)),
});

/** Whole days from `from` to `to` (to − from), on the calendar. */
export function daysBetween(from: string, to: string): number {
  return Math.round((utc(to) - utc(from)) / MS_PER_DAY);
}

/** The days `period` covers around `anchor`: the day, its ISO Monday–Sunday week or its month. */
export function periodRange(period: Exclude<ReportPeriod, "custom">, anchor: string): DayRange {
  if (parseShopDay(anchor) === null) throw new RangeError(`Invalid shop day: ${anchor}`);
  switch (period) {
    case "day":
      return { from: anchor, to: anchor };
    case "week": {
      // getUTCDay: 0 = Sunday; ISO weeks start on Monday.
      const back = (new Date(utc(anchor)).getUTCDay() + 6) % 7;
      const from = shiftShopDay(anchor, -back);
      return { from, to: shiftShopDay(from, 6) };
    }
    case "month": {
      const { y, m } = parts(anchor);
      return { from: ymd(y, m, 1), to: ymd(y, m + 1, 0) };
    }
  }
}

/**
 * An anchor in the period before (−1) or after (+1) the one containing
 * `anchor`: a day either side, a week either side, or the first of the
 * month either side (so 31 January steps to 1 February, never 3 March).
 */
export function shiftPeriod(
  period: Exclude<ReportPeriod, "custom">,
  anchor: string,
  delta: 1 | -1,
): string {
  switch (period) {
    case "day":
      return shiftShopDay(anchor, delta);
    case "week":
      return shiftShopDay(anchor, 7 * delta);
    case "month": {
      const { y, m } = parts(anchor);
      return ymd(y, m + delta, 1);
    }
  }
}

/** A custom range moved by its own length, earlier (−1) or later (+1). */
export function shiftRange({ from, to }: DayRange, delta: 1 | -1): DayRange {
  const n = (daysBetween(from, to) + 1) * delta;
  return { from: shiftShopDay(from, n), to: shiftShopDay(to, n) };
}

/** The series grain for a range: none for one day, days up to 31, weeks up to 184, else months. */
export function autoGrain(from: string, to: string): ReportGrain | null {
  const days = daysBetween(from, to) + 1;
  if (days <= 1) return null;
  if (days <= 31) return "day";
  if (days <= 184) return "week";
  return "month";
}

const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const MONTHS_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "5 Oct" or, with the year, "5 Oct 2026". */
function dayMonth(day: string, withYear: boolean): string {
  const { y, m, d } = parts(day);
  return withYear ? `${d} ${MONTHS_SHORT[m]} ${y}` : `${d} ${MONTHS_SHORT[m]}`;
}

/**
 * A range for people: one day "Mon, 5 Oct 2026"; a whole calendar month
 * "October 2026"; otherwise "28 Sep – 4 Oct 2026" (each year shown when
 * the range crosses one: "29 Dec 2025 – 4 Jan 2026").
 */
export function formatRangeLabel(from: string, to: string): string {
  if (from === to) {
    return `${WEEKDAYS_SHORT[new Date(utc(from)).getUTCDay()]}, ${dayMonth(from, true)}`;
  }
  const a = parts(from);
  const b = parts(to);
  const month = periodRange("month", from);
  if (month.from === from && month.to === to) return `${MONTHS_LONG[a.m]} ${a.y}`;
  return `${dayMonth(from, a.y !== b.y)} – ${dayMonth(to, true)}`;
}

/** A series bucket's label: "Mon, 5 Oct" for a day, "5 Oct – 11 Oct" for a week, "Oct 2026" for a month. */
export function formatBucketLabel(grain: ReportGrain, start: string, end: string): string {
  if (grain === "day")
    return `${WEEKDAYS_SHORT[new Date(utc(start)).getUTCDay()]}, ${dayMonth(start, false)}`;
  if (grain === "month") return `${MONTHS_SHORT[parts(start).m]} ${parts(start).y}`;
  return `${dayMonth(start, false)} – ${dayMonth(end, false)}`;
}

// ---------------------------------------------------------------------------
// URL state (`period, date, from, to, basis, by`)
// ---------------------------------------------------------------------------

type ParamValue = string | string[] | undefined | null;
export type ReportSearchParams = Record<string, ParamValue>;

const first = (v: ParamValue): string | undefined => (Array.isArray(v) ? v[0] : (v ?? undefined));

/** The report a URL asks for. With `error`, the range is the anchor's week, shown beside the error. */
export type ReportParams = {
  period: ReportPeriod;
  /** The day the period is built around (for custom: its end day). */
  anchor: string;
  from: string;
  to: string;
  basis: ReportBasis;
  by: ReportDimension;
  /** A safe message (BUSINESS_ERRORS) when the custom range is not valid. */
  error?: string;
};

/**
 * Why a custom range cannot be reported, or null when it can: both days
 * must be real shop days from EARLIEST_SHOP_DAY, start on or before the end
 * (report_range_invalid), at most 731 days (report_range_too_long). The
 * messages are BUSINESS_ERRORS', so the screen and the database say the
 * same thing.
 */
export function customRangeError(
  from: string | null | undefined,
  to: string | null | undefined,
): string | null {
  const f = parseShopDay(from);
  const t = parseShopDay(to);
  if (f === null || t === null || f < EARLIEST_SHOP_DAY || t < EARLIEST_SHOP_DAY) {
    return BUSINESS_ERRORS.report_range_invalid;
  }
  if (f > t) return BUSINESS_ERRORS.report_range_invalid;
  if (daysBetween(f, t) + 1 > MAX_RANGE_DAYS) return BUSINESS_ERRORS.report_range_too_long;
  return null;
}

const isOneOf = <T extends string>(list: readonly T[], v: string | undefined): v is T =>
  v !== undefined && (list as readonly string[]).includes(v);

/**
 * The report a URL asks for. Defaults: period week, anchor today, basis
 * sale, by job; an invalid value falls back to its default. A custom
 * range needs `from` and `to`; when they do not make a valid range, the
 * result carries `error` (a BUSINESS_ERRORS message) and the week of the
 * anchor as its range.
 */
export function parseReportParams(searchParams: ReportSearchParams, today: string): ReportParams {
  const rawPeriod = first(searchParams.period);
  const period: ReportPeriod = isOneOf(PERIODS, rawPeriod) ? rawPeriod : "week";
  const rawBasis = first(searchParams.basis);
  const basis: ReportBasis = isOneOf(BASIS_VALUES, rawBasis) ? rawBasis : "sale";
  const rawBy = first(searchParams.by);
  const by: ReportDimension = isOneOf(DIMENSION_VALUES, rawBy) ? rawBy : "job";
  const date = parseShopDay(first(searchParams.date));
  const anchor = date !== null && date >= EARLIEST_SHOP_DAY ? date : today;

  if (period === "custom") {
    const from = first(searchParams.from);
    const to = first(searchParams.to);
    const error = customRangeError(from, to);
    if (error) {
      return { period, anchor, ...periodRange("week", anchor), basis, by, error };
    }
    return { period, anchor: to!, from: from!, to: to!, basis, by };
  }
  return { period, anchor, ...periodRange(period, anchor), basis, by };
}

/** The cursor parameters of /reports and /reports/lines; a change of report drops them. */
export const CURSOR_PARAMS = ["after_total", "after_key", "after_at", "after_id"] as const;

/** The URL parameters of a report state (the period as date, or as from and to for custom). */
export function reportParams(
  state: Pick<ReportParams, "period" | "anchor" | "from" | "to" | "basis" | "by">,
): Record<string, string> {
  return state.period === "custom"
    ? { period: "custom", from: state.from, to: state.to, basis: state.basis, by: state.by }
    : { period: state.period, date: state.anchor, basis: state.basis, by: state.by };
}

/**
 * A report URL: `params` (the current ones) with `overrides` applied; a
 * null or empty override removes the parameter. Like withParam it keeps
 * every other parameter, except the cursors (CURSOR_PARAMS), which belong
 * to one page of one report and are kept only when `overrides` sets them.
 * Changing the period drops the parameters of the other kind (date versus
 * from/to).
 */
export function reportHref(
  pathname: string,
  params: Readonly<Record<string, string | null | undefined>> | URLSearchParams,
  overrides: Readonly<Record<string, string | null | undefined>> = {},
): string {
  const next = new URLSearchParams(
    params instanceof URLSearchParams
      ? params
      : (Object.entries(params).filter(([, v]) => v) as [string, string][]),
  );
  for (const k of CURSOR_PARAMS) if (!(k in overrides)) next.delete(k);
  for (const [k, v] of Object.entries(overrides)) {
    if (v) next.set(k, v);
    else next.delete(k);
  }
  if (next.get("period") === "custom") next.delete("date");
  else if (next.has("period")) {
    next.delete("from");
    next.delete("to");
  }
  const s = next.toString();
  return s ? `${pathname}?${s}` : pathname;
}

// ---------------------------------------------------------------------------
// DTOs (money as fixed-2 strings, NULL = withheld by the database, D30)
// ---------------------------------------------------------------------------

export type PeriodSummary = {
  basis: ReportBasis;
  from: string;
  to: string;
  currency: string;
  lineCount: number;
  jobCount: number;
  saleCount: number;
  saleTotal: string;
  /** View costs only (D30). */
  costTotal: string | null;
  yieldTotal: string | null;
  /** D273: net of what each completed job's Cult Commons bears of its Stripe fees. */
  cultCommons: string | null;
  /** Yield less Cult Commons (net) less Stripe fees. */
  afterCc: string | null;
  lossLineCount: number | null;
  costPendingLines: number;
  /** D273, view costs only: Stripe's fees (less GST) on the jobs counted, and what Cult Commons bore. */
  stripeFees: string | null;
  stripeFeesBorne: string | null;
  /** Jobs whose Stripe fee is not read yet: Cult Commons is provisional. */
  stripeFeePendingJobs: number;
  /** Sale basis only (D102): refunds recorded in the range, beside gross, never netted. */
  refundsTotal: string | null;
  refundCount: number | null;
  /** Sale basis only. */
  consignmentSales: number | null;
  consignmentSalesTotal: string | null;
  /** Sale basis and view costs only. */
  newConsignorLiability: string | null;
  settlementsPaid: string | null;
  purchasesReceived: string | null;
  /** D104: lines in another currency, left out of every total. */
  excludedForeignLineCount: number;
};

export type SeriesBucket = {
  start: string;
  end: string;
  /** The bucket reaches outside the range (a week or month cut by it). */
  partial: boolean;
  lineCount: number;
  jobCount: number;
  saleCount: number;
  saleTotal: string;
  costTotal: string | null;
  yieldTotal: string | null;
  cultCommons: string | null;
  afterCc: string | null;
  lossLineCount: number | null;
  refundsTotal: string | null;
  consignmentSales: number | null;
  consignmentSalesTotal: string | null;
  newConsignorLiability: string | null;
  settlementsPaid: string | null;
  currency: string;
};

/** The breakdown keyset: the last row's sale_total exactly as received (never rounded) and key. */
export type BreakdownCursor = { saleTotal: string; key: string };

export type BreakdownRow = {
  dimension: ReportDimension;
  key: string;
  entityType: string | null;
  entityId: string | null;
  label: string;
  detail: string | null;
  lineCount: number;
  jobCount: number;
  saleCount: number;
  /** Product dimension only. */
  quantity: string | null;
  saleTotal: string;
  costTotal: string | null;
  yieldTotal: string | null;
  cultCommons: string | null;
  afterCc: string | null;
  firstAt: string | null;
  lastAt: string | null;
  currency: string;
  /** Where the row opens: the job or sale, else the group's lines. */
  href: string;
};

/** The line keyset: the last row's (basis_at, source_line_id). */
export type LineCursor = { at: string; id: string };

export type ReportLine = {
  sourceLineId: string;
  source: string;
  channel: string;
  basisAt: string;
  documentId: string;
  documentNumber: string;
  documentHref: string | null;
  lineType: string;
  description: string;
  quantity: string;
  unitSalePrice: string;
  saleTotal: string;
  costTotal: string | null;
  yieldTotal: string | null;
  cultCommons: string | null;
  costPending: boolean;
  ownershipType: string | null;
  categoryName: string | null;
  mechanicName: string | null;
  currency: string;
};

export type PeriodActivity = {
  checkedIn: number;
  started: number;
  completed: number;
  readyForCollection: number;
  collected: number;
  cancelled: number;
  openAtEnd: number;
  /** Null when no job finished that step in the range. */
  medianHoursToComplete: number | null;
  medianHoursToCollect: number | null;
  appointments: { scheduled: number; arrived: number; noShow: number; cancelled: number };
  stock: {
    partsConsumedQty: number;
    partsConsumedLines: number;
    partsReturnedQty: number;
    adjustments: number;
    significantAdjustments: number;
    deliveries: number;
    unitsReceived: number;
  };
};

export type MechanicActivity = {
  /** Null for jobs without a lead ("Unassigned", D103). */
  staffId: string | null;
  name: string;
  active: boolean;
  checkedIn: number;
  completed: number;
  collected: number;
  openNow: number;
};

export type StockValueRow = {
  ownership: string;
  quantityOnHand: number;
  unitsInStock: number;
  uncostedItems: number;
  /** Shop-owned with view costs only (D105, D30). */
  valueAtCost: string | null;
  currency: string;
};

export const OWNERSHIP_LABELS: Readonly<Record<string, string>> = PSEUDO_KEYS.ownership;
export const CHANNEL_LABELS: Readonly<Record<string, string>> = PSEUDO_KEYS.channel;

/**
 * Where a breakdown row opens: a job or sale (the job dimension) on its own
 * page; every other group on /reports/lines with the report's parameters.
 */
export function breakdownHref(
  state: Pick<ReportParams, "period" | "anchor" | "from" | "to" | "basis">,
  dimension: ReportDimension,
  row: { key: string; entityType: string | null; entityId: string | null },
): string {
  if (dimension === "job" && row.entityId) {
    if (row.entityType === "work_order") return hrefForRecord("work_order", row.entityId)!;
    if (row.entityType === "sale") return hrefForRecord("sale", row.entityId)!;
  }
  return reportHref("/reports/lines", reportParams({ ...state, by: dimension }), { key: row.key });
}

/** Hours as people say them: "5 h" under two days, else "2.5 days" (one decimal, trailing .0 dropped). */
export function formatDuration(hours: number | null): string {
  if (hours === null) return "—";
  if (hours < 48) return `${Number(hours.toFixed(1))} h`;
  return `${Number((hours / 24).toFixed(1))} days`;
}

/** The empty-state copy for a period with no lines on `basis`. */
export function emptyCopy(basis: ReportBasis): string {
  const base = `Nothing recorded for this period on the ${BASES[basis].label} basis.`;
  return basis === "sale" || basis === "completion"
    ? `${base} Jobs not completed yet only show on the Check-in basis.`
    : base;
}
