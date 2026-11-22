import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import {
  AppointmentActionBar,
  AppointmentStatusPill,
  AppointmentStatusScope,
} from "@/components/domain/appointments/appointment-actions";
import {
  ChangeBikeButton,
  EditNotesButton,
} from "@/components/domain/appointments/appointment-edit";
import { ShortId } from "@/components/domain/short-id";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { StatusPill } from "@/components/ui/status-pill";
import { formatAppointmentWhen, formatClock } from "@/lib/appointments/format";
import {
  APPOINTMENT_SOURCE_LABELS,
  SCHEDULE_WARNING_LABELS,
  isActiveStatus,
  isLate,
} from "@/lib/appointments/status";
import { requireStaff } from "@/lib/auth/session";
import { formatDateTime, shopToday } from "@/lib/dates";
import { getAppointment } from "@/lib/domain/appointments";
import { telHref } from "@/lib/people";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/uuid";
import { STATUS_LABELS, statusTone } from "@/lib/workshop";

export const metadata: Metadata = { title: "Appointment" };

/**
 * One appointment (SPEC §6, §21; PLAN D36-D40): when, its status and where
 * it came from, the customer (tap to call), the bike, the type, the notes,
 * the job once checked in, the next steps (a bar above the tab bar on
 * phones) and its history in plain language. An unknown or malformed id is
 * the not-found screen.
 */
export default async function AppointmentPage({ params }: PageProps<"/appointments/[id]">) {
  await requireStaff();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const supabase = await createClient();
  const appt = await getAppointment(supabase, id);
  if (!appt) notFound();

  const now = new Date();
  const tel = telHref(appt.customer.phone);
  const active = isActiveStatus(appt.status);
  const day = shopToday(appt.startsAt);
  const customerNoteEditable = !["cancelled", "completed", "no_show"].includes(appt.status);

  return (
    <AppointmentStatusScope status={appt.status}>
      <header className="flex flex-col gap-3 pt-6 pb-2">
        <p className="eyebrow text-dust-500">
          <Link href={`/appointments?date=${day}`} className="underline-offset-4 hover:underline">
            Appointments
          </Link>
        </p>
        <h1 className="text-3xl sm:text-4xl">
          {formatAppointmentWhen(appt.startsAt, appt.endsAt)}
        </h1>
        <div className="flex flex-wrap items-center gap-2">
          <AppointmentStatusPill />
          <Badge tone={appt.source === "customer" ? "info" : "neutral"}>
            {APPOINTMENT_SOURCE_LABELS[appt.source]}
          </Badge>
          {isLate(appt, now) ? (
            <Badge tone="danger" emphasis="solid">
              Late
            </Badge>
          ) : null}
          {appt.scheduleWarning ? (
            <Badge tone="waiting" emphasis="solid">
              {SCHEDULE_WARNING_LABELS[appt.scheduleWarning]}
            </Badge>
          ) : null}
        </div>
        {appt.scheduleWarning ? (
          <p className="text-sm text-dust-700">
            {appt.scheduleWarning === "closed"
              ? "The shop is now closed for some of this time. The booking stands until it is cancelled; call the customer to rebook."
              : "This booking is outside the opening hours (they may have changed since it was made). It stands until it is cancelled; call the customer if it needs moving."}
          </p>
        ) : null}
      </header>

      <AppointmentActionBar
        appointmentId={appt.id}
        startsAt={appt.startsAt}
        source={appt.source}
        now={now.toISOString()}
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="flex min-w-0 flex-col gap-6">
          {appt.job ? (
            <Card title="Job">
              <Link
                href={`/jobs/${appt.job.id}`}
                className="flex min-h-tap flex-wrap items-center gap-3 rounded-xl underline-offset-4 hover:underline"
              >
                <ShortId value={appt.job.jobNumber} />
                <StatusPill status={statusTone(appt.job.status)}>
                  {STATUS_LABELS[appt.job.status]}
                </StatusPill>
                <span className="font-medium">View job</span>
              </Link>
              {appt.status === "checked_in" ? (
                <p className="mt-2 text-sm text-dust-500">
                  The appointment completes when this job is completed.
                </p>
              ) : null}
            </Card>
          ) : null}

          <Card title="Customer">
            <div className="flex flex-col gap-1">
              <Link
                href={`/customers/${appt.customer.id}`}
                className="text-lg font-semibold underline underline-offset-4"
              >
                {appt.customer.label}
              </Link>
              {appt.customer.phone ? (
                tel ? (
                  <a href={tel} className="flex min-h-tap items-center font-medium underline">
                    Call {appt.customer.phone}
                  </a>
                ) : (
                  <p>{appt.customer.phone}</p>
                )
              ) : (
                <p className="text-sm text-dust-500">No phone number on file.</p>
              )}
              {appt.customer.archived ? (
                <Badge tone="waiting" className="self-start">
                  Archived customer
                </Badge>
              ) : null}
            </div>
          </Card>

          <Card
            title="Bike"
            actions={
              active ? (
                <ChangeBikeButton
                  appointmentId={appt.id}
                  customerId={appt.customer.id}
                  bikeId={appt.bike?.id ?? null}
                />
              ) : null
            }
          >
            {appt.bike ? (
              <Link
                href={`/bikes/${appt.bike.id}`}
                className="flex min-h-tap flex-wrap items-center gap-2 font-medium underline-offset-4 hover:underline"
              >
                <ShortId value={appt.bike.shortId} />
                {appt.bike.title}
              </Link>
            ) : (
              <p className="text-dust-500">No bike yet. Pick it now or at check-in.</p>
            )}
          </Card>

          <Card
            title="Notes"
            actions={
              <EditNotesButton
                appointmentId={appt.id}
                customerNote={appt.customerNote}
                internalNote={appt.internalNote}
                customerNoteEditable={customerNoteEditable}
              />
            }
          >
            <dl className="flex flex-col gap-4">
              <div className="flex flex-col gap-1">
                <dt className="font-display text-xs font-bold tracking-wide uppercase">
                  Customer&apos;s note
                </dt>
                <dd>
                  {appt.customerNote ? (
                    <blockquote className="border-l-4 border-hairline pl-3 whitespace-pre-wrap">
                      {appt.customerNote}
                    </blockquote>
                  ) : (
                    <span className="text-dust-500">None</span>
                  )}
                </dd>
              </div>
              <div className="flex flex-col gap-1">
                <dt className="font-display text-xs font-bold tracking-wide uppercase">
                  Internal note <span className="font-sans normal-case">(staff only)</span>
                </dt>
                <dd className="whitespace-pre-wrap">
                  {appt.internalNote ?? <span className="text-dust-500">None</span>}
                </dd>
              </div>
            </dl>
          </Card>
        </div>

        <div className="flex min-w-0 flex-col gap-6">
          <Card title="Details">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-dust-500">Type</dt>
              <dd className="font-medium">{appt.type.name}</dd>
              <dt className="text-dust-500">Capacity</dt>
              <dd>
                {appt.capacityUnits} {appt.capacityUnits === 1 ? "unit" : "units"}
              </dd>
              <dt className="text-dust-500">Booked</dt>
              <dd>{formatDateTime(appt.stamps.createdAt)}</dd>
              {appt.stamps.cancelledAt ? (
                <>
                  <dt className="text-dust-500">Cancelled</dt>
                  <dd>
                    {formatDateTime(appt.stamps.cancelledAt)}
                    {appt.cancelledVia === "customer" ? " (online)" : ""}
                    {appt.cancellationReason ? (
                      <span className="block text-dust-700">“{appt.cancellationReason}”</span>
                    ) : null}
                  </dd>
                </>
              ) : null}
            </dl>
          </Card>

          <Card title="History">
            {appt.history.length === 0 ? (
              <p className="text-sm text-dust-500">Nothing recorded yet.</p>
            ) : (
              <ol aria-label="History" className="flex flex-col gap-3">
                {appt.history.map((e) => (
                  <li key={e.id} className="flex flex-col gap-0.5">
                    <p className="font-medium">
                      {e.title}
                      <span className="font-normal text-dust-500">
                        ,{" "}
                        {shopToday(e.at) === shopToday(now)
                          ? formatClock(e.at)
                          : formatDateTime(e.at)}
                      </span>
                    </p>
                    {e.detail ? <p className="text-sm text-dust-700">“{e.detail}”</p> : null}
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>
      </div>
    </AppointmentStatusScope>
  );
}
