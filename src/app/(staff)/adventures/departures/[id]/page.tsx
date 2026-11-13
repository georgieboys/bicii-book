import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import {
  CancelDepartureButton,
  EditDepartureButton,
} from "@/components/domain/adventures/departure-sheets";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { canManageAdventures, DEPARTURE_KIND_LABELS } from "@/lib/adventures";
import { requireStaff } from "@/lib/auth/session";
import { formatDateTime, toShopLocal } from "@/lib/dates";
import { getDeparture } from "@/lib/domain/departures";
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
  const result = await getDeparture(await createClient(), id);
  if (!result) notFound();
  const { departure: d, riders } = result;
  const manage = canManageAdventures(staff) && d.status === "scheduled";

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
