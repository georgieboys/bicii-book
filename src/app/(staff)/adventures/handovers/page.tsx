import type { Metadata } from "next";
import Link from "next/link";

import { AdventuresSectionNav } from "@/components/domain/adventures/section-nav";
import {
  CancelHireButton,
  IssueTrackerButton,
  ReplaceTrackerButton,
  ReturnTrackerButton,
  type DeviceChoice,
} from "@/components/domain/adventures/tracker-sheets";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { RouteIcon } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/page-header";
import { RowList } from "@/components/ui/row-list";
import {
  canManageAdventures,
  HIRE_STATUS_LABELS,
  TRACKER_CONDITION_LABELS,
} from "@/lib/adventures";
import { requireStaff } from "@/lib/auth/session";
import { formatDate, formatDateTime, shopToday } from "@/lib/dates";
import { listHandovers, listTrackingDevices, type TrackerHire } from "@/lib/domain/trackers";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Tracker handovers" };

const day = (d: string) => formatDate(`${d}T12:00:00+08:00`);

/**
 * Handovers (D187, D188): the counter's list of paid tracker hires. To
 * collect (by collection day), out with a rider (due back, or overdue),
 * and the latest finished. manage_adventures gives out, replaces and takes
 * back; an admin cancels a hire nobody collected.
 */
export default async function HandoversPage() {
  const staff = await requireStaff();
  const manage = canManageAdventures(staff);
  const admin = staff.role === "admin";
  const supabase = await createClient();
  const [{ open, finished }, devices] = await Promise.all([
    listHandovers(supabase),
    listTrackingDevices(supabase),
  ]);
  const free: DeviceChoice[] = devices
    .filter((d) => d.serviceState === "in_service" && !d.holder)
    .map((d) => ({ id: d.id, label: d.label }));
  const today = shopToday();
  const toCollect = open.filter((h) => !h.assignment || h.assignment.returnedAt);
  const out = open.filter((h) => h.assignment && !h.assignment.returnedAt);

  const row = (h: TrackerHire, actions: React.ReactNode, extra?: React.ReactNode) => (
    <li key={h.reservationId} className="flex flex-col gap-3 px-4 py-3 sm:px-5">
      <span className="flex flex-col gap-1">
        <span className="flex flex-wrap items-center gap-2">
          <Link href={`/adventures/bookings/${h.bookingId}`} className="font-medium underline">
            {h.riderName}
          </Link>
          <span className="text-sm text-dust-500 tabular-nums">{h.reference}</span>
          {extra}
          {h.needsAttention ? <Badge tone="danger">Payment needs attention</Badge> : null}
        </span>
        <span className="text-sm text-dust-700">
          {h.routeName} · collect {day(h.collectOn)} · back {day(h.returnOn)} ({h.days}{" "}
          {h.days === 1 ? "day" : "days"})
          {h.assignment && !h.assignment.returnedAt
            ? ` · ${h.assignment.deviceLabel} since ${formatDateTime(h.assignment.issuedAt)}`
            : ""}
        </span>
      </span>
      {actions ? <span className="flex flex-wrap gap-2">{actions}</span> : null}
    </li>
  );

  return (
    <>
      <PageHeader title="Adventures" description="Trackers to give out and take back." />
      <AdventuresSectionNav current="/adventures/handovers" />
      <div className="flex flex-col gap-6">
        <Card title="To collect">
          {toCollect.length === 0 ? (
            <p className="text-sm text-dust-700">No paid hires waiting to be collected.</p>
          ) : (
            <>
              {manage && free.length === 0 ? (
                <p className="mb-3 rounded-xl bg-waiting-soft px-3 py-2 text-sm text-waiting-deep">
                  No tracker is free to give out. Put one in service on Trackers.
                </p>
              ) : null}
              <RowList label="To collect" className="-mx-4 sm:-mx-5">
                {toCollect.map((h) =>
                  row(
                    h,
                    manage || admin ? (
                      <>
                        {manage ? (
                          <IssueTrackerButton
                            reservationId={h.reservationId}
                            riderName={h.riderName}
                            devices={free}
                          />
                        ) : null}
                        {admin ? <CancelHireButton reservationId={h.reservationId} /> : null}
                      </>
                    ) : null,
                    h.collectOn === today ? (
                      <Badge tone="info">Today</Badge>
                    ) : h.collectOn < today ? (
                      <Badge tone="waiting">Not collected yet</Badge>
                    ) : null,
                  ),
                )}
              </RowList>
            </>
          )}
        </Card>

        <Card title="Out with riders">
          {out.length === 0 ? (
            <p className="text-sm text-dust-700">No trackers are out.</p>
          ) : (
            <RowList label="Out with riders" className="-mx-4 sm:-mx-5">
              {out.map((h) => {
                const late = h.returnOn < today;
                return row(
                  h,
                  manage && h.assignment ? (
                    <>
                      <ReturnTrackerButton assignmentId={h.assignment.id} late={late} />
                      <ReplaceTrackerButton assignmentId={h.assignment.id} devices={free} />
                    </>
                  ) : null,
                  late ? (
                    <Badge tone="danger">Overdue</Badge>
                  ) : h.returnOn === today ? (
                    <Badge tone="info">Due today</Badge>
                  ) : null,
                );
              })}
            </RowList>
          )}
        </Card>

        {finished.length > 0 ? (
          <Card title="Recently finished">
            <RowList label="Recently finished" className="-mx-4 sm:-mx-5">
              {finished.map((h) =>
                row(
                  h,
                  null,
                  <Badge tone={h.status === "completed" ? "done" : "neutral"}>
                    {h.status === "completed" && h.assignment?.returnCondition
                      ? TRACKER_CONDITION_LABELS[h.assignment.returnCondition]
                      : HIRE_STATUS_LABELS[h.status]}
                  </Badge>,
                ),
              )}
            </RowList>
          </Card>
        ) : null}

        {open.length === 0 && finished.length === 0 ? (
          <EmptyState
            icon={<RouteIcon />}
            title="No tracker hires yet"
            description="Paid hires appear here, by collection day."
          />
        ) : null}
      </div>
    </>
  );
}
