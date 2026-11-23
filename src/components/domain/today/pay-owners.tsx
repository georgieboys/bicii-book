import Link from "next/link";

import { RowLink, RowList } from "@/components/ui/row-list";
import type { owedToConsignors } from "@/lib/consignment";
import { formatMoney } from "@/lib/money";
import { plural } from "@/lib/plural";

import { TodaySection } from "./stat-tile";

/** Consignors listed on Today; the rest are on Consignment. */
export const PAY_OWNER_ROWS = 5;

/** The card's headline: what is owed and on how many items. */
export function payOwnersHeadline(total: string, items: number): string {
  return `Owed to consignors: ${formatMoney(total)} on ${plural(items, "item", "items")}`;
}

/**
 * "Pay owners" on Today (server; manage_consignments): who is still owed
 * money for consigned items that sold, most owed first. Each row opens the
 * consignor's page, where the payment is recorded. Hidden when nobody is
 * owed anything.
 */
export function PayOwners({ owed }: { owed: ReturnType<typeof owedToConsignors> }) {
  if (!owed) return null;
  const shown = owed.consignors.slice(0, PAY_OWNER_ROWS);
  return (
    <TodaySection
      id="today-pay-owners"
      title="Pay owners"
      description={payOwnersHeadline(owed.total, owed.items)}
      actions={
        owed.consignors.length > shown.length ? (
          <Link
            href="/consignment"
            className="inline-flex min-h-tap items-center text-sm font-semibold underline"
          >
            See all<span className="sr-only"> consignors</span>
          </Link>
        ) : null
      }
    >
      <RowList label="Consignors to pay">
        {shown.map((c) => (
          <RowLink key={c.id} href={`/consignment/consignors/${c.id}`} className="min-h-14 py-2">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <p className="truncate font-medium">{c.name}</p>
              <p className="text-sm text-dust-500">
                {plural(c.items, "item", "items")} awaiting payment
              </p>
            </div>
            <span className="shrink-0 font-semibold tabular-nums">
              {formatMoney(c.outstanding)}
            </span>
          </RowLink>
        ))}
      </RowList>
    </TodaySection>
  );
}
