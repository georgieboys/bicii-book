/**
 * The discount sheet's arithmetic before the database plans it (D271):
 * "Take off" is the amount itself; "Round to" a new total is the job's
 * total less that figure. Pure, so it is unit-tested directly; the
 * database checks again and does the per-line allocation.
 */
import { parseMoney, toMoneyString } from "@/lib/money";

export type DiscountMode = "amount" | "target";

export type DiscountAmount = { ok: true; amount: string } | { ok: false; error: string | null };

export function discountAmount(mode: DiscountMode, figure: string, total: string): DiscountAmount {
  if (figure.trim() === "") return { ok: false, error: null };
  const value = parseMoney(figure);
  const jobTotal = parseMoney(total);
  if (value === null || jobTotal === null) {
    return { ok: false, error: "Enter an amount like 12.50." };
  }
  if (mode === "amount") {
    if (value.lte(0)) return { ok: false, error: "Take off an amount above zero." };
    if (value.greaterThan(jobTotal)) {
      return { ok: false, error: "That's more than the job's total." };
    }
    return { ok: true, amount: toMoneyString(value) };
  }
  if (value.gte(jobTotal)) {
    return { ok: false, error: "Round to a total below the job's total now." };
  }
  return { ok: true, amount: toMoneyString(jobTotal.minus(value)) };
}
