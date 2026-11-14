import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import {
  AssignStaffButton,
  CancelDepartureButton,
  CheckInButton,
  EditDepartureButton,
  ObservationButton,
  RemoveStaffButton,
} from "@/components/domain/adventures/departure-sheets";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { canManageAdventures, DEPARTURE_KIND_LABELS } from "@/lib/adventures";
import { requireStaff } from "@/lib/auth/session";
import { formatDateTime, toShopLocal } from "@/lib/dates";
import { getDeparture, getDepartureWork } from "@/lib/domain/departures";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/uuid";

export const metadata: Metadata = { title: "Departure" };

/**
 * One departure's manifest (D193): who joined, with their contact details
 * for staff, whether each shows their name publicly, and the date's notes.
 * manage_adventures changes or cancels it.
 */
export default async function DeparturePage({ params }: { params: Promise<{ id: string }> }) {
  const staff = await requireStaff();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const supabase = await createClient();
  const [result, work] = await Promise.all([
    getDeparture(supabase, id),
    getDepartureWork(supabase, id),
  ]);
  if (!result) notFound();
  const { departure: d, riders } = result;
  const manage = canManageAdventures(staff) && d.status === "scheduled";
  const supported = d.kind === "supported";
  // Facilitators assigned to this date (or managers) work it; the RPCs decide.
  // Check-in and observations need Facilitate adventures and a place on the
  // date, or Manage adventures (the RPCs' rule; audit A-74).
  const onIt =
    canManageAdventures(staff) ||
    (staff.permissions.includes("facilitate_adventures") &&
      work.staff.some((x) => x.staffId === staff.staffId));
  const riderName = new Map(riders.map((r) => [r.bookingId, r.name]));

  return (
    <>
      <PageHeader
        eyebrow={DEPARTURE_KIND_LABELS[d.kind]}
        title={d.routeName}
        description={`${formatDateTime(d.startsAt)} · ${d.meetingPoint}`}
        actions={
          <>
            <Badge tone={d.status === "cancelled" ? "neutral" : "progress"}>
              {d.status === "cancelled" ? "Cancelled" : `${d.taken} of ${d.capacity} places`}
            </Badge>
            {manage ? (
              <>
                <EditDepartureButton
                  departure={{
                    id: d.id,
                    version: d.version,
                    startsAt: toShopLocal(d.startsAt),
                    expectedFinishAt: d.expectedFinishAt ? toShopLocal(d.expectedFinishAt) : "",
                    meetingPoint: d.meetingPoint,
                    capacity: d.capacity,
                    note: d.note,
                    staffNote: d.staffNote,
                  }}
                />
                <CancelDepartureButton departureId={d.id} />
              </>
            ) : null}
          </>
        }
      />
      <div className="flex flex-col gap-6">
        {d.cancelReason ? (
          <p className="rounded-2xl bg-danger-soft px-4 py-3 text-sm text-danger-deep">
            Cancelled: {d.cancelReason}
          </p>
        ) : null}
        <Card title="Riders">
          {riders.length === 0 ? (
            <p className="text-sm text-dust-700">Nobody has joined yet.</p>
          ) : (
            <ul aria-label="Riders" className="flex flex-col gap-3 text-sm">
              {riders.map((r) => (
                <li key={r.bookingId} className="flex flex-col gap-0.5">
                  <span className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/adventures/bookings/${r.bookingId}`}
                      className="font-medium underline"
                    >
                      {r.name}
                    </Link>
                    <span className="text-dust-500 tabular-nums">{r.reference}</span>
                    {r.showName ? <Badge tone="info">Name shown publicly</Badge> : null}
                    {supported ? (
                      r.checkedInAt ? (
                        <Badge tone="done">Checked in {formatDateTime(r.checkedInAt)}</Badge>
                      ) : onIt && d.status === "scheduled" ? (
                        <CheckInButton departureId={d.id} bookingId={r.bookingId} name={r.name} />
                      ) : null
                    ) : null}
                  </span>
                  <span className="text-dust-700">
                    {[r.phone, r.email].filter(Boolean).join(" · ") || "No contact details"} ·
                    joined {formatDateTime(r.joinedAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        {supported ? (
          <Card
            title="Staff"
            actions={
              manage ? <AssignStaffButton departureId={d.id} staff={work.activeStaff} /> : null
            }
          >
            {work.staff.length === 0 ? (
              <p className="text-sm text-dust-700">No staff on this date yet.</p>
            ) : (
              <ul aria-label="Staff on this date" className="flex flex-col gap-2 text-sm">
                {work.staff.map((x) => (
                  <li key={x.staffId} className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{x.name}</span>
                    <Badge>{x.role === "lead" ? "Lead" : "Facilitator"}</Badge>
                    {manage ? (
                      <RemoveStaffButton departureId={d.id} staffId={x.staffId} name={x.name} />
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        ) : null}

        {supported ? (
          <Card
            title="Observations"
            actions={
              onIt ? (
                <ObservationButton
                  departureId={d.id}
                  riders={riders.map((r) => ({ bookingId: r.bookingId, name: r.name }))}
                />
              ) : null
            }
          >
            {work.observations.length === 0 ? (
              <p className="text-sm text-dust-700">Nothing recorded yet.</p>
            ) : (
              <ol aria-label="Observations" className="flex flex-col gap-3 text-sm">
                {work.observations.map((o) => (
                  <li key={o.id} className="flex flex-col">
                    <span>
                      <span className="font-medium capitalize">{o.kind}</span>
                      {o.bookingId
                        ? ` · ${riderName.get(o.bookingId) ?? "a rider"}`
                        : " · whole group"}
                      {o.staffName ? ` · ${o.staffName}` : ""}
                    </span>
                    <span className="whitespace-pre-wrap">{o.body}</span>
                    <span className="text-dust-500">{formatDateTime(o.createdAt)}</span>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        ) : null}

        <Card title="Notes">
          <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
            <dt className="text-dust-700">Expected finish</dt>
            <dd>{d.expectedFinishAt ? formatDateTime(d.expectedFinishAt) : "Not set"}</dd>
            <dt className="text-dust-700">For riders</dt>
            <dd className="whitespace-pre-wrap">{d.note || "None"}</dd>
            <dt className="text-dust-700">Staff only</dt>
            <dd className="whitespace-pre-wrap">{d.staffNote || "None"}</dd>
          </dl>
        </Card>
      </div>
    </>
  );
}
