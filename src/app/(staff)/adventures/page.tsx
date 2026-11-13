import type { Metadata } from "next";

import { NewAdventureButton } from "@/components/domain/adventures/catalogue-sheets";
import { AdventuresSectionNav } from "@/components/domain/adventures/section-nav";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { ChevronRightIcon, RouteIcon } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/page-header";
import { RowLink, RowList } from "@/components/ui/row-list";
import { canManageAdventures, formatDistance, STATUS_LABELS } from "@/lib/adventures";
import { requireStaff } from "@/lib/auth/session";
import { listAdventures } from "@/lib/domain/adventures";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Adventures" };

/**
 * Adventures (docs/ADVENTURES.md, D164-D166): every route in public order,
 * with whether it is published, planned, has certification offers or a
 * draft in progress. Any staff member can look; manage_adventures adds and
 * edits.
 */
export default async function AdventuresPage() {
  const staff = await requireStaff();
  const manage = canManageAdventures(staff);
  const adventures = await listAdventures(await createClient());

  return (
    <>
      <PageHeader
        title="Adventures"
        description="Routes anyone can ride free, and the certified rides BICII sells from 125 km."
        actions={manage ? <NewAdventureButton /> : null}
      />
      <AdventuresSectionNav current="/adventures" />
      {adventures.length === 0 ? (
        <EmptyState
          icon={<RouteIcon />}
          title="No adventures yet"
          description="Add a route, then publish it to show it on bicii.sg."
          action={manage ? <NewAdventureButton /> : undefined}
        />
      ) : (
        <RowList label="Adventures">
          {adventures.map((a) => (
            <RowLink key={a.id} href={`/adventures/${a.id}`}>
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium break-words">{a.name}</span>
                  <span className="text-sm text-dust-500 tabular-nums">
                    {formatDistance(a.distanceKm)}
                  </span>
                </span>
                <span className="flex flex-wrap items-center gap-2">
                  {a.status === "published" ? (
                    <Badge tone="done">{STATUS_LABELS.published}</Badge>
                  ) : a.status === "archived" ? (
                    <Badge tone="waiting">{STATUS_LABELS.archived}</Badge>
                  ) : (
                    <Badge>{STATUS_LABELS.draft}</Badge>
                  )}
                  {a.isPlanned ? <Badge tone="info">Planned</Badge> : null}
                  {a.offerCount > 0 ? (
                    <Badge tone="progress">
                      {a.offerCount} {a.offerCount === 1 ? "offer" : "offers"}
                    </Badge>
                  ) : null}
                  {a.hasDraft && a.status !== "draft" ? <Badge>Draft in progress</Badge> : null}
                </span>
              </span>
              <ChevronRightIcon className="size-5 shrink-0 text-dust-500" />
            </RowLink>
          ))}
        </RowList>
      )}
    </>
  );
}
