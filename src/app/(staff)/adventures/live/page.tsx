import { CappedNote } from "@/components/domain/adventures/capped-note";
import type { Metadata } from "next";
import Link from "next/link";

import { AdventuresSectionNav } from "@/components/domain/adventures/section-nav";
import { TrackMap } from "@/components/domain/adventures/track-map";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { RouteIcon } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/page-header";
import { RowList } from "@/components/ui/row-list";
import { canVerifyAdventures, canManageAdventures } from "@/lib/adventures";
import { requireStaff } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/dates";
import { listLiveRides, type LiveRide } from "@/lib/domain/trackers";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Live rides" };

/** Older than this, the latest position is stale (no proof of trouble, or of a stop). */
const STALE_MINUTES = 30;

function freshness(r: LiveRide): { label: string; tone: "info" | "done" | "waiting" } {
  if (r.latestAgeMinutes === null) return { label: "Waiting for first position", tone: "info" };
  const minutes = r.latestAgeMinutes;
  return minutes <= STALE_MINUTES
    ? { label: `Current · ${minutes} min ago`, tone: "done" }
    : {
        label: `Stale · ${minutes < 120 ? `${minutes} min` : `${Math.round(minutes / 60)} h`} ago`,
        tone: "waiting",
      };
}

/**
 * Live rides (D192; handoff §12.5): every ride whose window is open (Start
 * Ride pressed, Finish Ride not yet), with its tracker, the latest position
 * recorded, when it arrived and how old it is, and a simple map. A stale
 * position is not proof that a rider stopped or is in trouble, and this is
 * not an emergency service. Positions need verify or manage adventures.
 */
export default async function LiveRidesPage() {
  const staff = await requireStaff();
  const seesPositions = canVerifyAdventures(staff) || canManageAdventures(staff);
  const rides = await listLiveRides(await createClient());

  return (
    <>
      <PageHeader title="Adventures" description="Rides in progress with a hired tracker." />
      <CappedNote count={rides.length} cap={50} what="rides" />
      <AdventuresSectionNav current="/adventures/live" />
      {rides.length === 0 ? (
        <EmptyState
          icon={<RouteIcon />}
          title="Nobody is riding"
          description="A ride appears here when a rider with a hired tracker presses Start Ride."
        />
      ) : (
        <div className="flex flex-col gap-6">
          {seesPositions ? (
            <Card title="Map">
              <TrackMap
                label={`Latest tracks of ${rides.length} ${rides.length === 1 ? "rider" : "riders"}`}
                tracks={rides.map((r) => r.points)}
                checkpoints={[]}
              />
              <p className="mt-2 text-xs text-dust-500">
                Each line is a rider&apos;s last positions; the square is their latest. Not an
                emergency service.
              </p>
            </Card>
          ) : (
            <p className="rounded-xl bg-waiting-soft px-3 py-2 text-sm text-waiting-deep">
              Positions need the Verify adventures or Manage adventures permission.
            </p>
          )}
          <RowList label="Live rides">
            {rides.map((r) => {
              const f = freshness(r);
              return (
                <li key={r.attemptId} className="flex flex-col gap-1 px-4 py-3 sm:px-5">
                  <span className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/adventures/bookings/${r.bookingId}`}
                      className="font-medium underline"
                    >
                      {r.riderName}
                    </Link>
                    <span className="text-sm text-dust-500 tabular-nums">{r.reference}</span>
                    {seesPositions ? <Badge tone={f.tone}>{f.label}</Badge> : null}
                  </span>
                  <span className="text-sm text-dust-700">
                    {r.routeName} · started {formatDateTime(r.startedAt)}
                    {r.deviceLabel ? ` · tracker ${r.deviceLabel}` : " · no tracker out"}
                    {seesPositions && r.latestAt
                      ? ` · ${r.positions}${r.positions === 300 ? "+" : ""} positions · latest recorded ${formatDateTime(r.latestAt)}${r.latestReceivedAt ? `, arrived ${formatDateTime(r.latestReceivedAt)}` : ""}`
                      : ""}
                  </span>
                </li>
              );
            })}
          </RowList>
        </div>
      )}
    </>
  );
}
