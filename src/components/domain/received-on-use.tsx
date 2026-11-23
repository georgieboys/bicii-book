"use client";

import Link from "next/link";
import { useTransition } from "react";

import { checkReceivedOnUseAction } from "@/app/(staff)/consignment/actions";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { callAction } from "@/lib/call-action";
import { formatDateTime } from "@/lib/dates";
import type { ReceivedOnUse } from "@/lib/domain/consignment";
import { formatMoney } from "@/lib/money";

/**
 * D267: consigned stock received on a job when it was used. A manager
 * checks the consignor and amount owed (on the item's page) and presses
 * Looks right; nothing waits for it.
 */
export function ReceivedOnUseList({ items }: { items: ReceivedOnUse[] }) {
  if (items.length === 0) return null;
  return (
    <section
      aria-labelledby="received-on-use"
      className="flex flex-col gap-2 rounded-2xl bg-info-soft p-4"
    >
      <h2 id="received-on-use" className="eyebrow text-info-deep">
        Received on use · to check ({items.length})
      </h2>
      <p className="text-sm text-info-deep">
        Used on a job when BICII held too little, so it was received from the consignor then. Check
        the consignor and what they&apos;re owed on the item, then press Looks right.
      </p>
      <ul className="flex flex-col gap-2">
        {items.map((item) => (
          <ReceivedRow key={item.id} item={item} />
        ))}
      </ul>
    </section>
  );
}

function ReceivedRow({ item }: { item: ReceivedOnUse }) {
  const { toast } = useToast();
  const [pending, start] = useTransition();
  const check = () =>
    start(async () => {
      const r = await callAction(() => checkReceivedOnUseAction({ itemId: item.id }));
      if (!r.ok) toast({ title: "Not saved", description: r.error, tone: "error" });
    });
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-card p-3">
      <span className="flex min-w-0 flex-col">
        <Link href={`/consignment/items/${item.id}`} className="font-medium underline">
          {item.quantity} × {item.productName}
        </Link>
        <span className="text-sm text-dust-700">
          {[
            item.shortId,
            item.consignorName,
            item.askingPrice ? `asking ${formatMoney(item.askingPrice, item.currency)}` : null,
            item.note,
            formatDateTime(item.receivedAt),
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </span>
      <Button size="sm" variant="outline" onClick={check} pending={pending} pendingLabel="Saving…">
        Looks right
      </Button>
    </li>
  );
}
