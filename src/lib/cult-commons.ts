/**
 * Cult Commons previews (SPEC §10; PLAN D1). DISPLAY ONLY: the authoritative
 * numbers are the generated columns of work_order_line_items and the
 * work_order_totals_staff view. This copies their arithmetic exactly, so a
 * preview shown before the database answers matches what it stores:
 *
 *   sale  = round(quantity × unit sale price, 2)
 *   cost  = round(quantity × unit direct cost, 2)
 *   yield = sale − cost
 *   Cult Commons = round(max(yield, 0) × rate, 2)        per line (D1)
 *   BICII yield after CC = yield − Cult Commons
 *   D273, per completed job: Cult Commons bears least(Stripe fees, its
 *   share); BICII after CC and fees = yield − (share − borne) − fees
 *
 * A job's figures are the sums of its lines': a loss-making line contributes
 * no Cult Commons and does not reduce another line's. Rounding is half up
 * (away from zero), as Postgres round(numeric). The fixture table in
 * tests/fixtures/cult-commons.ts is run through both this module and the
 * database. This is the shared Cult Commons helper: later phases (Phase 5
 * reporting) extend it rather than recreate it.
 */
import { Decimal, toDecimal, type MoneyInput } from "@/lib/money";

export type LineInput = {
  quantity: MoneyInput;
  unitSalePrice: MoneyInput;
  unitDirectCost: MoneyInput;
  /** Fraction: 0.3 = 30%. */
  rate: MoneyInput;
};

export type Economics = {
  sale: Decimal;
  cost: Decimal;
  yield: Decimal;
  ccShare: Decimal;
  yieldAfterCc: Decimal;
};

const round2 = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

export function lineEconomics(line: LineInput): Economics {
  const quantity = toDecimal(line.quantity);
  const sale = round2(quantity.times(toDecimal(line.unitSalePrice)));
  const cost = round2(quantity.times(toDecimal(line.unitDirectCost)));
  const lineYield = sale.minus(cost);
  const ccShare = round2(Decimal.max(lineYield, 0).times(toDecimal(line.rate)));
  return { sale, cost, yield: lineYield, ccShare, yieldAfterCc: lineYield.minus(ccShare) };
}

/** Sums of the lines' economics (D1: Cult Commons per line, never netted). */
export function jobEconomics(lines: readonly LineInput[]): Economics {
  const zero = new Decimal(0);
  return lines.map(lineEconomics).reduce<Economics>(
    (acc, l) => ({
      sale: acc.sale.plus(l.sale),
      cost: acc.cost.plus(l.cost),
      yield: acc.yield.plus(l.yield),
      ccShare: acc.ccShare.plus(l.ccShare),
      yieldAfterCc: acc.yieldAfterCc.plus(l.yieldAfterCc),
    }),
    { sale: zero, cost: zero, yield: zero, ccShare: zero, yieldAfterCc: zero },
  );
}

/**
 * D273: a completed job's Stripe fees (Stripe's fee less GST, summed over
 * its paid Stripe payments) against its economics. Cult Commons bears them
 * up to its own share, never below 0, per job; BICII bears the rest. DISPLAY
 * ONLY, the authority is reporting.financial_lines' stripe_fee entry and
 * work_order_totals_staff; this copies their arithmetic.
 */
export type FeeEconomics = {
  fees: Decimal;
  borne: Decimal;
  ccAfterFees: Decimal;
  yieldAfterFees: Decimal;
};

export function stripeFeeEconomics(job: Economics, fees: MoneyInput): FeeEconomics {
  const f = toDecimal(fees);
  const borne = Decimal.min(f, Decimal.max(job.ccShare, 0));
  const ccAfterFees = job.ccShare.minus(borne);
  return { fees: f, borne, ccAfterFees, yieldAfterFees: job.yield.minus(ccAfterFees).minus(f) };
}

// ---------------------------------------------------------------------------
// Rates (D21): staff type a percentage; the database stores a fraction with
// four decimals (rate_fraction, numeric(5,4)).
// ---------------------------------------------------------------------------

/**
 * A percentage typed by staff ("30", "12.5", "12.25%") as the stored
 * fraction with four decimals ("0.3000", "0.1250", "0.1225"), converted
 * exactly (no floating point). Null unless it is 0–100 with at most two
 * decimals.
 */
export function percentToRate(input: string): string | null {
  const text = input.trim().replace(/\s*%$/, "");
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(text)) return null;
  const percent = new Decimal(text);
  if (percent.gt(100)) return null;
  return percent.dividedBy(100).toFixed(4);
}

/** A stored fraction as a percentage for people: "0.3000" -> "30%", "0.1225" -> "12.25%". */
export function formatRate(rate: MoneyInput): string {
  return `${toDecimal(rate).times(100).toDecimalPlaces(2).toString()}%`;
}

export type RateRow = {
  id: string;
  /** Fraction, "0.3000". */
  rate: string;
  effectiveFrom: string;
  cancelledAt: string | null;
};

export type RateState = "current" | "scheduled" | "past" | "cancelled";

/**
 * Each rate's standing at `now` (mirrors private.cult_commons_rate_at): the
 * current one is the latest uncancelled rate that has started; uncancelled
 * rates not started yet are scheduled; earlier ones are past; cancelled ones
 * never apply. Newest effective date first.
 */
export function classifyRates<T extends RateRow>(
  rates: readonly T[],
  now: Date = new Date(),
): (T & { state: RateState })[] {
  const sorted = [...rates].sort(
    (a, b) => Date.parse(b.effectiveFrom) - Date.parse(a.effectiveFrom) || b.id.localeCompare(a.id),
  );
  const current = sorted.find(
    (r) => r.cancelledAt === null && Date.parse(r.effectiveFrom) <= now.getTime(),
  );
  return sorted.map((r) => ({
    ...r,
    state:
      r.cancelledAt !== null
        ? "cancelled"
        : r === current
          ? "current"
          : Date.parse(r.effectiveFrom) > now.getTime()
            ? "scheduled"
            : "past",
  }));
}
