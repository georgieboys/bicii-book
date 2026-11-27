import Link from "next/link";

import { formatMoney, toDecimal } from "@/lib/money";
import { formatMonth } from "@/lib/payouts";

import { TodaySection } from "./stat-tile";

/**
 * "To pay this month" on Today (server; admins only, D276): the Payouts
 * page's Total to transfer for last month (service pay and Cult Commons
 * with earlier months, and what consignors are owed). Hidden when it is 0.
 */
export function ToPay({
  month,
  total,
  currency,
}: {
  month: string;
  total: string;
  currency: string;
}) {
  if (!toDecimal(total).greaterThan(0)) return null;
  return (
    <TodaySection
      id="today-to-pay"
      title={`To pay this month: ${formatMoney(total, currency)}`}
      description={`Service pay and Cult Commons for ${formatMonth(month)} and before, and consignors.`}
      actions={
        <Link
          href={`/payouts?month=${month}`}
          className="inline-flex min-h-tap items-center text-sm font-semibold underline"
        >
          Open Payouts
        </Link>
      }
    >
      {null}
    </TodaySection>
  );
}
