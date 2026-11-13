import type { Metadata } from "next";

import { CreateDepartureButton } from "@/components/domain/adventures/departure-sheets";
import { AdventuresSectionNav } from "@/components/domain/adventures/section-nav";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ChevronRightIcon, RouteIcon } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/page-header";
import { RowLink, RowList } from "@/components/ui/row-list";
import { canManageAdventures, DEPARTURE_KIND_LABELS } from "@/lib/adventures";
import { requireStaff } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/dates";
import { listDepartureRoutes, listDepartures, type Departure } from "@/lib/domain/departures";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Departures" };

function DepartureRow({ d }: { d: Departure }) {
  return (
    <RowLink href={`/adventures/departures/${d.id}`}>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{d.routeName}</span>
          <Badge
            tone={
              d.status === "cancelled" ? "neutral" : d.taken >= d.capacity ? "waiting" : "progress"
            }
          >
            {d.status === "cancelled" ? "Cancelled" : `${d.taken} of ${d.capacity}`}
          </Badge>
          <Badge>{DEPARTURE_KIND_LABELS[d.kind]}</Badge>
        </span>
        <span className="text-sm text-dust-700">
          {formatDateTime(d.startsAt)} · {d.meetingPoint}
        </span>
      </span>
      <ChevronRightIcon className="size-5 shrink-0 text-dust-500" />
    </RowLink>
  );
}

/**
 * Departures (D193): the dates BICII publishes for routes, with places
 * taken. manage_adventures adds dates; each opens its manifest.
 */
export default async function DeparturesPage() {
  const staff = await requireStaff();
  const manage = canManageAdventures(staff);
  const supabase = await createClient();
  const [{ upcoming, past }, routes] = await Promise.all([
    listDepartures(supabase),
    listDepartureRoutes(supabase),
  ]);

  return (
    <>
      <PageHeader
        title="Adventures"
        description="Group and supported ride dates."
        actions={manage ? <CreateDepartureButton routes={routes} /> : null}
      />
      <AdventuresSectionNav current="/adventures/departures" />
      <div className="flex flex-col gap-6">
        {upcoming.length === 0 ? (
          <EmptyState
            icon={<RouteIcon />}
            title="No dates coming up"
            description="Add a group ride date; riders with a ticket for that route can join it on bicii.sg."
          />
        ) : (
          <RowList label="Upcoming dates">
            {upcoming.map((d) => (
              <DepartureRow key={d.id} d={d} />
            ))}
          </RowList>
        )}
        {past.length > 0 ? (
          <Card title="Past and cancelled">
            <RowList label="Past and cancelled" className="-mx-4 sm:-mx-5">
              {past.map((d) => (
                <DepartureRow key={d.id} d={d} />
              ))}
            </RowList>
          </Card>
        ) : null}
      </div>
    </>
  );
}
