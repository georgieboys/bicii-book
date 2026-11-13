import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import {
  ClearAttentionButton,
  PackStatusButtons,
  RevokeCertificateButton,
} from "@/components/domain/adventures/booking-sheets";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import {
  BOOKING_EVENT_LABELS,
  BOOKING_STATUS_LABELS,
  canManageAdventures,
  canVerifyAdventures,
  FINISHER_NAME_LABELS,
  formatDistance,
  PACK_STATUS_LABELS,
  PARTICIPATION_LABELS,
  SUBMISSION_STATE_LABELS,
  HIRE_STATUS_LABELS,
  TRACKER_CONDITION_LABELS,
} from "@/lib/adventures";
import { requireStaff } from "@/lib/auth/session";
import { formatDate, formatDateTime } from "@/lib/dates";
import { getAdventureBooking } from "@/lib/domain/adventure-bookings";
import { getBookingHire } from "@/lib/domain/trackers";
import { formatMoney } from "@/lib/money";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/uuid";

export const metadata: Metadata = { title: "Adventure booking" };

const PAYMENT_LABELS: Record<string, string> = {
  pending: "Checkout open",
  paid: "Paid",
  failed: "Failed",
  expired: "Expired",
  partially_refunded: "Partly refunded",
  refunded: "Refunded",
};

/**
 * One adventure booking (D172-D182): the rider, what they bought, the
 * payments, the evidence versions, the certificate and pack, and the
 * history. Admins clear a payment flag and revoke a certificate;
 * manage_adventures moves the pack along.
 */
export default async function AdventureBookingPage({
  params,
}: PageProps<"/adventures/bookings/[id]">) {
  const staff = await requireStaff();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const supabase = await createClient();
  const [booking, hire] = await Promise.all([
    getAdventureBooking(supabase, id),
    getBookingHire(supabase, id),
  ]);
  if (!booking) notFound();
  const admin = staff.role === "admin";
  const verify = canVerifyAdventures(staff);

  return (
    <>
      <PageHeader
        eyebrow={`Adventure booking ${booking.reference}`}
        title={booking.customerName}
        description={`${booking.routeName} · ${PARTICIPATION_LABELS[booking.kind]}`}
        actions={
          <>
            <Badge tone={booking.status === "confirmed" ? "done" : "neutral"}>
              {BOOKING_STATUS_LABELS[booking.status]}
            </Badge>
            {booking.needsAttention ? <Badge tone="danger">Needs attention</Badge> : null}
          </>
        }
      />

      <div className="flex flex-col gap-6">
        {booking.needsAttention ? (
          <div
            role="alert"
            className="flex flex-col gap-3 rounded-2xl bg-danger-soft px-4 py-3 text-sm text-danger-deep"
          >
            <p>
              <strong>Payment needs attention:</strong> {booking.attentionReason}. This ride cannot
              be certified until an admin clears the flag.
            </p>
            {admin ? (
              <div>
                <ClearAttentionButton bookingId={booking.id} />
              </div>
            ) : null}
          </div>
        ) : null}

        <Card title="What they bought">
          <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
            <dt className="text-dust-700">Rider</dt>
            <dd>
              <Link href={`/customers/${booking.customerId}`} className="underline">
                {booking.customerName}
              </Link>
            </dd>
            <dt className="text-dust-700">Route</dt>
            <dd>
              <Link href={`/adventures/${booking.adventureId}`} className="underline">
                {booking.routeName}
              </Link>{" "}
              · version {booking.revisionNumber} · {formatDistance(booking.distanceKm)}
            </dd>
            <dt className="text-dust-700">T-shirt</dt>
            <dd>{booking.tshirtSize ?? "None"}</dd>
            <dt className="text-dust-700">Name on the board</dt>
            <dd>{FINISHER_NAME_LABELS[booking.finisherName]}</dd>
            <dt className="text-dust-700">Terms accepted</dt>
            <dd>Version {booking.termsVersion}</dd>
          </dl>
          <ul aria-label="Booking lines" className="mt-4 flex flex-col gap-1 text-sm">
            {booking.lines.map((l) => (
              <li key={l.id} className="flex justify-between gap-3">
                <span>
                  {l.description}
                  {l.quantity > 1 ? ` × ${l.quantity}` : ""}
                </span>
                <span className="tabular-nums">{formatMoney(l.total)}</span>
              </li>
            ))}
            <li className="flex justify-between gap-3 border-t border-hairline pt-1 font-semibold">
              <span>Total</span>
              <span className="tabular-nums">{formatMoney(booking.total)}</span>
            </li>
          </ul>
        </Card>

        <Card title="Payments">
          {booking.payments.length === 0 ? (
            <p className="text-sm text-dust-700">No checkout yet.</p>
          ) : (
            <ul aria-label="Payments" className="flex flex-col gap-2 text-sm">
              {booking.payments.map((p) => (
                <li key={p.id} className="flex flex-wrap justify-between gap-2">
                  <span>
                    {PAYMENT_LABELS[p.status] ?? p.status}
                    {p.livemode === false ? " · Stripe test mode" : ""}
                    {Number(p.refundedAmount) > 0
                      ? ` · ${formatMoney(p.refundedAmount)} refunded`
                      : ""}
                  </span>
                  <span className="text-dust-700 tabular-nums">
                    {formatMoney(p.amount)} · {formatDateTime(p.paidAt ?? p.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {hire ? (
          <Card
            title="Tracker hire"
            actions={
              hire.status === "confirmed" ? (
                <Link href="/adventures/handovers" className="text-sm underline">
                  Open handovers
                </Link>
              ) : null
            }
          >
            <div className="flex flex-col gap-2 text-sm">
              <p>
                <Badge
                  tone={
                    hire.status === "confirmed"
                      ? "progress"
                      : hire.status === "completed"
                        ? "done"
                        : "neutral"
                  }
                >
                  {HIRE_STATUS_LABELS[hire.status]}
                </Badge>
              </p>
              <p>
                Collect {formatDate(`${hire.collectOn}T12:00:00+08:00`)}, back{" "}
                {formatDate(`${hire.returnOn}T12:00:00+08:00`)} ({hire.days}{" "}
                {hire.days === 1 ? "day" : "days"})
              </p>
              {hire.assignment ? (
                <p>
                  {hire.assignment.deviceLabel}: given out{" "}
                  {formatDateTime(hire.assignment.issuedAt)}
                  {hire.assignment.returnedAt
                    ? `, back ${formatDateTime(hire.assignment.returnedAt)}${
                        hire.assignment.returnCondition
                          ? ` (${TRACKER_CONDITION_LABELS[hire.assignment.returnCondition]})`
                          : ""
                      }`
                    : ", still out"}
                </p>
              ) : null}
              {hire.cancelReason ? (
                <p className="text-dust-700">Cancelled: {hire.cancelReason}</p>
              ) : null}
            </div>
          </Card>
        ) : null}

        <Card title="Evidence">
          {booking.submissions.length === 0 ? (
            <p className="text-sm text-dust-700">The rider has not added any evidence yet.</p>
          ) : (
            <ul aria-label="Evidence versions" className="flex flex-col gap-2 text-sm">
              {booking.submissions.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    Version {s.version} · {SUBMISSION_STATE_LABELS[s.state]}
                    {s.submittedAt ? ` · sent ${formatDateTime(s.submittedAt)}` : ""}
                  </span>
                  {verify && s.state !== "draft" ? (
                    <Link href={`/adventures/reviews/${s.id}`} className="underline">
                      {s.state === "submitted" || s.state === "in_review" ? "Review" : "Open"}
                    </Link>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Card>

        {booking.certificate ? (
          <Card
            title={`Certificate ${booking.certificate.reference}`}
            actions={
              admin && booking.certificate.status === "active" ? (
                <RevokeCertificateButton certificateId={booking.certificate.id} />
              ) : null
            }
          >
            <div className="flex flex-col gap-2 text-sm">
              <p>
                {booking.certificate.status === "active" ? (
                  <Badge tone="done">Active</Badge>
                ) : (
                  <Badge tone="danger">Revoked</Badge>
                )}
              </p>
              <p>
                Completed {formatDate(booking.certificate.completedOn)} ·{" "}
                {formatDistance(booking.certificate.acceptedDistanceKm)} accepted · issued{" "}
                {formatDateTime(booking.certificate.issuedAt)}
              </p>
              {booking.certificate.revokeReason ? (
                <p className="text-dust-700">Revoked: {booking.certificate.revokeReason}</p>
              ) : null}
            </div>
          </Card>
        ) : null}

        {booking.pack ? (
          <Card title="Finisher pack">
            <div className="flex flex-col gap-3 text-sm">
              <p>
                <Badge tone={booking.pack.status === "fulfilled" ? "done" : "waiting"}>
                  {PACK_STATUS_LABELS[booking.pack.status]}
                </Badge>
              </p>
              <p>
                {booking.pack.items.join(", ")}
                {booking.pack.tshirtSize ? ` · T-shirt ${booking.pack.tshirtSize}` : ""}
              </p>
              {booking.pack.note ? <p className="text-dust-700">{booking.pack.note}</p> : null}
              {canManageAdventures(staff) ? (
                <PackStatusButtons fulfilmentId={booking.pack.id} status={booking.pack.status} />
              ) : null}
            </div>
          </Card>
        ) : null}

        <Card title="History">
          <ol aria-label="Booking history" className="flex flex-col gap-2 text-sm">
            {booking.events.map((e) => (
              <li key={e.id} className="flex flex-col">
                <span>
                  {BOOKING_EVENT_LABELS[e.kind]}
                  {e.staffName ? ` · ${e.staffName}` : ""}
                </span>
                <span className="text-dust-500">
                  {formatDateTime(e.createdAt)}
                  {e.note ? ` · ${e.note}` : ""}
                </span>
              </li>
            ))}
          </ol>
        </Card>
      </div>
    </>
  );
}
