import type { Metadata } from "next";
import Link from "next/link";

import { AdventuresSectionNav } from "@/components/domain/adventures/section-nav";
import {
  RegisterTrackerButton,
  TrackerStateButton,
} from "@/components/domain/adventures/tracker-sheets";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { RouteIcon } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/page-header";
import { RowList } from "@/components/ui/row-list";
import { canManageAdventures, TRACKER_STATE_LABELS } from "@/lib/adventures";
import { requireStaff } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/dates";
import { listTrackingDevices } from "@/lib/domain/trackers";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Trackers" };

/**
 * Trackers (D186, D188): BICII's GPS trackers, their state and who has each
 * now. Any staff member can look; manage_adventures adds them and changes
 * their state (never while someone has one).
 */
export default async function TrackersPage() {
  const staff = await requireStaff();
  const manage = canManageAdventures(staff);
  const devices = await listTrackingDevices(await createClient());

  return (
    <>
      <PageHeader
        title="Adventures"
        description="GPS trackers riders can hire."
        actions={manage ? <RegisterTrackerButton /> : null}
      />
      <AdventuresSectionNav current="/adventures/trackers" />
      {devices.length === 0 ? (
        <EmptyState
          icon={<RouteIcon />}
          title="No trackers yet"
          description="Add each tracker with its label and device ID. Riders can hire one once it's in service and hire is on."
          action={manage ? <RegisterTrackerButton /> : undefined}
        />
      ) : (
        <RowList label="Trackers">
          {devices.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-5">
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{d.label}</span>
                  <Badge
                    tone={
                      d.holder
                        ? "progress"
                        : d.serviceState === "in_service"
                          ? "done"
                          : d.serviceState === "lost"
                            ? "danger"
                            : "waiting"
                    }
                  >
                    {d.holder ? "With a rider" : TRACKER_STATE_LABELS[d.serviceState]}
                  </Badge>
                </span>
                <span className="text-sm text-dust-700">
                  {d.provider === "fake" ? "Test tracker" : "SPOT"} · {d.providerDeviceId}
                  {d.model ? ` · ${d.model}` : ""}
                </span>
                {d.holder ? (
                  <span className="text-sm">
                    <Link href={`/adventures/bookings/${d.holder.bookingId}`} className="underline">
                      {d.holder.riderName} ({d.holder.reference})
                    </Link>{" "}
                    since {formatDateTime(d.holder.issuedAt)}
                  </span>
                ) : null}
                {d.note ? <span className="text-sm text-dust-700">{d.note}</span> : null}
              </span>
              {manage && !d.holder ? (
                <TrackerStateButton deviceId={d.id} label={d.label} state={d.serviceState} />
              ) : null}
            </li>
          ))}
        </RowList>
      )}
    </>
  );
}
