import type { Metadata } from "next";
import Link from "next/link";

import { PackStatusButtons } from "@/components/domain/adventures/booking-sheets";
import { AdventuresSectionNav, PillLink } from "@/components/domain/adventures/section-nav";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { RouteIcon } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/page-header";
import { RowList } from "@/components/ui/row-list";
import { canManageAdventures, PACK_STATUS_LABELS } from "@/lib/adventures";
import { requireStaff } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/dates";
import { listAdventurePacks } from "@/lib/domain/adventure-bookings";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Finisher packs" };

/**
 * Finisher packs (D179, D182): one per certificate. Open packs oldest
 * first (to pack, ready to collect, on hold), or the collected ones,
 * newest first. manage_adventures moves a pack along.
 */
export default async function AdventurePacksPage({ searchParams }: PageProps<"/adventures/packs">) {
  const staff = await requireStaff();
  const manage = canManageAdventures(staff);
  const collected = (await searchParams).show === "collected";
  const packs = await listAdventurePacks(await createClient(), { open: !collected });

  return (
    <>
      <PageHeader title="Adventures" description="Finisher packs for certified riders." />
      <AdventuresSectionNav current="/adventures/packs" />
      <nav aria-label="Show packs" className="mb-4 flex flex-wrap gap-2">
        <PillLink href="/adventures/packs" active={!collected}>
          Open
        </PillLink>
        <PillLink href="/adventures/packs?show=collected" active={collected}>
          Collected
        </PillLink>
      </nav>
      {packs.length === 0 ? (
        <EmptyState
          icon={<RouteIcon />}
          title={collected ? "No packs collected yet" : "No packs to prepare"}
          description="A pack is added when a ride is certified."
        />
      ) : (
        <RowList label="Finisher packs">
          {packs.map((p) => (
            <li key={p.id} className="flex flex-col gap-3 px-4 py-3 sm:px-5">
              <span className="flex flex-col gap-1">
                <span className="flex flex-wrap items-center gap-2">
                  <Link
                    href={`/adventures/bookings/${p.bookingId}`}
                    className="font-medium underline"
                  >
                    {p.customerName}
                  </Link>
                  <span className="text-sm text-dust-500 tabular-nums">
                    {p.certificateReference}
                  </span>
                  <Badge
                    tone={
                      p.status === "fulfilled"
                        ? "done"
                        : p.status === "on_hold"
                          ? "danger"
                          : "waiting"
                    }
                  >
                    {PACK_STATUS_LABELS[p.status]}
                  </Badge>
                </span>
                <span className="text-sm text-dust-700">
                  {p.routeName} · {p.items.join(", ")}
                  {p.tshirtSize ? ` · T-shirt ${p.tshirtSize}` : ""} · certified{" "}
                  {formatDateTime(p.createdAt)}
                </span>
                {p.note ? <span className="text-sm text-dust-700">{p.note}</span> : null}
              </span>
              {manage ? <PackStatusButtons fulfilmentId={p.id} status={p.status} /> : null}
            </li>
          ))}
        </RowList>
      )}
    </>
  );
}
