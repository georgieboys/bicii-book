import type { Metadata } from "next";
import Link from "next/link";

import {
  AddClosureButton,
  DeleteClosureControl,
  EditBookingAlertsButton,
  EditBookingSettingsButton,
  EditClosureButton,
  SettingFigure,
  WeeklyHoursList,
} from "@/components/domain/schedule-settings";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { requireStaff } from "@/lib/auth/session";
import { unwrap } from "@/lib/db-errors";
import {
  getShopSettings,
  getWeeklyHours,
  listClosures,
  type ClosureItem,
} from "@/lib/domain/schedule";
import { staffDirectory } from "@/lib/domain/staff-directory";
import {
  cancelCutoffSentence,
  capacitySentence,
  closureDays,
  closureLabel,
  formatDuration,
} from "@/lib/schedule";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Shop hours and closures" };

/**
 * Shop hours, closures and booking capacity (SPEC §6; PLAN D2, D35, D37,
 * D38). Every active staff member may read the schedule (RLS select), so
 * this page needs only requireStaff() and has its own loading.tsx; only
 * admins see Edit, the hour rows as buttons, Add closure and Delete, and
 * the RPCs check the role again. The time zone is fixed (Singapore, D35).
 * Settings changes never move existing appointments (D38): closures show
 * how many bookings they affect, linked to that day.
 */
export default async function ScheduleSettingsPage() {
  const staff = await requireStaff();
  // Admin-only on purpose (D91): hours, closures and booking capacity are
  // shop settings, which no role but admin and no exception changes
  // (private.require_admin()).
  const admin = staff.role === "admin";
  const supabase = await createClient();
  const [settings, week, closures, directory] = await Promise.all([
    getShopSettings(supabase),
    getWeeklyHours(supabase),
    listClosures(supabase),
    staffDirectory(supabase),
  ]);
  // D163b: booking alerts go to the chosen active staff and other addresses.
  const activeStaff = (unwrap(directory) ?? [])
    .filter((s) => s.active)
    .map((s) => ({ id: s.id, name: s.display_name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const alertNames = activeStaff
    .filter((s) => settings.bookingAlertStaffIds.includes(s.id))
    .map((s) => s.name);
  const alertRecipients = [...alertNames, ...settings.bookingAlertEmails];

  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="Shop hours and closures"
        description={
          admin
            ? "When customers and staff can book, and how many bikes the shop takes in."
            : "When customers and staff can book. Only an admin can change these."
        }
      />

      <Card
        title="Booking capacity"
        actions={
          admin ? (
            <EditBookingSettingsButton
              settings={{
                slotMinutes: settings.slotMinutes,
                capacityUnits: settings.capacityUnits,
                minNoticeMinutes: settings.minNoticeMinutes,
                horizonDays: settings.horizonDays,
                maxActiveBookings: settings.maxActiveBookings,
                cancelCutoffMinutes: settings.cancelCutoffMinutes,
              }}
            />
          ) : null
        }
      >
        <dl aria-label="Booking capacity" className="grid gap-x-6 sm:grid-cols-2">
          <SettingFigure label="Slot length" value={`${settings.slotMinutes} minutes`} />
          <SettingFigure
            label="Intake capacity"
            value={`${settings.capacityUnits} per slot`}
            note={capacitySentence(settings.slotMinutes, settings.capacityUnits)}
          />
          <SettingFigure
            label="Minimum notice online"
            value={formatDuration(settings.minNoticeMinutes)}
            note="Customers book at least this far ahead."
          />
          <SettingFigure
            label="How far ahead online"
            value={settings.horizonDays === 1 ? "1 day" : `${settings.horizonDays} days`}
          />
          <SettingFigure
            label="Online bookings per customer"
            value={`${settings.maxActiveBookings} upcoming`}
            note="Bookings made by staff don't count."
          />
          <SettingFigure
            label="Online cancellation"
            value={formatDuration(settings.cancelCutoffMinutes)}
            note={cancelCutoffSentence(settings.cancelCutoffMinutes)}
          />
          <SettingFigure label="Time zone" value="Singapore time" />
        </dl>
        <p className="mt-3 text-sm text-dust-500">
          Changing these never moves or cancels an existing appointment. Bookings the new settings
          don&apos;t fit are flagged on the appointments list.
        </p>
      </Card>

      <Card
        title="Booking emails"
        actions={
          admin ? (
            <EditBookingAlertsButton
              staff={activeStaff}
              staffIds={settings.bookingAlertStaffIds}
              emails={settings.bookingAlertEmails}
            />
          ) : null
        }
      >
        <dl aria-label="Booking emails" className="grid gap-x-6 sm:grid-cols-2">
          <SettingFigure
            label="Shop alerts go to"
            value={alertRecipients.length > 0 ? alertRecipients.join(", ") : "Nobody yet"}
            note="When a customer books or cancels online."
          />
          <SettingFigure
            label="Customers get"
            value="A confirmation"
            note="When they book online, and an email if the booking is cancelled."
          />
        </dl>
        <p className="mt-3 text-sm text-dust-500">
          Bookings made by staff send no emails. Emails go out within a minute.
        </p>
      </Card>

      <Card title="Weekly hours">
        <WeeklyHoursList days={week} editable={admin} />
      </Card>

      <Card title="Closures and short days" actions={admin ? <AddClosureButton /> : null}>
        {closures.upcoming.length === 0 ? (
          <p className="text-dust-700">No closures or short days coming up.</p>
        ) : (
          <ClosureList closures={closures.upcoming} admin={admin} label="Upcoming closures" />
        )}
        {closures.past.length > 0 ? (
          <details className="mt-4">
            <summary className="flex min-h-tap cursor-pointer items-center font-semibold">
              Past ({closures.past.length})
            </summary>
            <ClosureList closures={closures.past} admin={false} label="Past closures" />
          </details>
        ) : null}
      </Card>
    </>
  );
}

function ClosureList({
  closures,
  admin,
  label,
}: {
  closures: readonly ClosureItem[];
  admin: boolean;
  label: string;
}) {
  return (
    <ul aria-label={label} className="-mx-4 flex flex-col divide-y divide-hairline sm:-mx-5">
      {closures.map((c) => {
        const days = closureDays(c.firstDay, c.lastDay);
        const what = closureLabel(c);
        return (
          <li
            key={c.id}
            aria-label={`${days}: ${what}`}
            className="flex flex-col gap-2 px-4 py-3 sm:px-5"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{days}</span>
              <Badge tone={c.kind === "closed" ? "neutral" : "waiting"}>{what}</Badge>
              {c.affectedAppointments > 0 && c.firstAffectedDay ? (
                <Link
                  href={`/appointments?date=${c.firstAffectedDay}`}
                  className="inline-flex min-h-tap items-center"
                >
                  <Badge tone="waiting" emphasis="solid">
                    {c.affectedAppointments === 1
                      ? "1 appointment affected"
                      : `${c.affectedAppointments} appointments affected`}
                  </Badge>
                </Link>
              ) : null}
            </div>
            <p className="text-dust-700">{c.reason}</p>
            {admin ? (
              <div className="flex flex-wrap items-start gap-2">
                <EditClosureButton
                  label={`${days} closure`}
                  closure={{
                    id: c.id,
                    kind: c.kind,
                    firstDay: c.firstDay,
                    lastDay: c.lastDay,
                    fromTime: c.fromTime,
                    toTime: c.toTime,
                    reason: c.reason,
                  }}
                />
                <DeleteClosureControl id={c.id} label={`the ${days} closure`} />
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
