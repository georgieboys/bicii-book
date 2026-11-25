import type { SaleShopifyFees } from "@/lib/domain/sales";
import { formatMoney, toDecimal } from "@/lib/money";

/**
 * D274: an online sale's share of its order's Shopify Payments fees (less
 * GST) on the sale's Yield card and the Sales list (view_costs only), from
 * public.sale_shopify_fees: what Cult Commons bore of them (never more than
 * its share; BICII bears the rest), Cult Commons and BICII after them, and
 * "Not reported yet" while Shopify has not put the fee on the charge (never
 * a known $0.00). Everything is the database's figure; nothing is added up
 * here.
 */

const minus = (v: string, currency: string) =>
  toDecimal(v).isZero() ? formatMoney(v, currency) : `−${formatMoney(v, currency)}`;

/** The Yield card's rows (dt/dd pairs inside its grid), after the gross Cult Commons. */
export function SaleShopifyFeeRows({
  fees,
  currency,
}: {
  fees: SaleShopifyFees;
  currency: string;
}) {
  const unread = fees.pending && toDecimal(fees.shopifyFees).isZero();
  return (
    <>
      <dt>Shopify fees (less GST)</dt>
      <dd className="text-right">
        {unread ? "Not reported yet" : formatMoney(fees.shopifyFees, currency)}
      </dd>
      {unread ? null : (
        <>
          <dt>Shopify fees borne by Cult Commons</dt>
          <dd className="text-right">{minus(fees.shopifyFeesBorne, currency)}</dd>
        </>
      )}
      <dt>Cult Commons after Shopify fees</dt>
      <dd className="text-right">{formatMoney(fees.ccAfterFees, currency)}</dd>
      <dt className="border-t border-hairline pt-2 font-semibold">
        BICII after Cult Commons and Shopify fees
      </dt>
      <dd className="border-t border-hairline pt-2 text-right font-bold">
        {formatMoney(fees.biciiAfterFees, currency)}
      </dd>
    </>
  );
}

/**
 * The notes under the Yield card: provisional while unread, and the build
 * orders' share. The share is reported for every build order on the sale,
 * linked or not (D1, D2), so the note says both outcomes: it comes off a
 * linked job's Cult Commons once that job is completed, and BICII bears it
 * for an unlinked build order or a cancelled job.
 */
export function saleShopifyFeeNotes(fees: SaleShopifyFees, currency: string): string[] {
  const out: string[] = [];
  if (fees.pending) {
    out.push(
      "Provisional: Shopify has not reported the fee on this order yet, so Cult Commons may still go down.",
    );
  }
  if (!toDecimal(fees.buildOrderFees).isZero()) {
    out.push(
      `${formatMoney(fees.buildOrderFees, currency)} of the order's Shopify fees are the build order's share: it comes off the Cult Commons of the job it is linked to, once that job is completed. BICII bears it while the build order is not linked to a job, or if the job is cancelled.`,
    );
  }
  return out;
}

/** The Sales list's short line for an online sale, e.g. "Shopify fees $3.20 · Cult Commons after fees $14.80". */
export function saleShopifyFeeLine(fees: SaleShopifyFees, currency?: string): string {
  if (fees.pending && toDecimal(fees.shopifyFees).isZero()) return "Shopify fee not reported yet";
  return `Shopify fees ${formatMoney(fees.shopifyFees, currency)} · Cult Commons after fees ${formatMoney(fees.ccAfterFees, currency)}`;
}
