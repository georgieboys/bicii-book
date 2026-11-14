import { CappedNote } from "@/components/domain/adventures/capped-note";
import type { Metadata } from "next";

import { AdventuresSectionNav, PillLink } from "@/components/domain/adventures/section-nav";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { ChevronRightIcon, RouteIcon } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/page-header";
import { RowLink, RowList } from "@/components/ui/row-list";
import { BOOKING_STATUS_LABELS, PARTICIPATION_LABELS } from "@/lib/adventures";
import { requireStaff } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/dates";
import { listAdventureBookings, type BookingFilter } from "@/lib/domain/adventure-bookings";
import { formatMoney } from "@/lib/money";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Adventure bookings" };

const FILTERS: ReadonlyArray<{ value: BookingFilter; label: string }> = [
  { value: "paid", label: "Paid" },
  { value: "attention", label: "Needs attention" },
  { value: "unpaid", label: "Not paid" },
  { value: "all", label: "All" },
];

function parseFilter(value: unknown): BookingFilter {
  return FILTERS.some((f) => f.value === value) ? (value as BookingFilter) : "paid";
}

/**
 * Adventure bookings (D172, D182): one row per rider's purchase, newest
 * first, filtered by paid, needs attention or not paid. Any staff member
 * can look.
 */
export default async function AdventureBookingsPage({
  searchParams,
}: PageProps<"/adventures/bookings">) {
  await requireStaff();
  const filter = parseFilter((await searchParams).show);
  const bookings = await listAdventureBookings(await createClient(), filter);

  return (
    <>
      <PageHeader title="Adventures" description="Certified ride bookings." />
      <CappedNote count={bookings.length} cap={200} what="bookings" />
      <AdventuresSectionNav current="/adventures/bookings" />
      <nav aria-label="Show bookings" className="mb-4 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <PillLink
            key={f.value}
            href={
              f.value === "paid" ? "/adventures/bookings" : `/adventures/bookings?show=${f.value}`
            }
            active={f.value === filter}
          >
            {f.label}
          </PillLink>
        ))}
      </nav>
      {bookings.length === 0 ? (
        <EmptyState
          icon={<RouteIcon />}
          title="No bookings here"
          description="Bookings appear when riders buy a certified ride on bicii.sg."
        />
      ) : (
        <RowList label="Bookings">
          {bookings.map((b) => (
            <RowLink key={b.id} href={`/adventures/bookings/${b.id}`}>
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium break-words">{b.customerName}</span>
                  <span className="text-sm text-dust-500 tabular-nums">{b.reference}</span>
                </span>
                <span className="text-sm text-dust-700">
                  {b.routeName} · {PARTICIPATION_LABELS[b.kind]} ·{" "}
                  <span className="tabular-nums">{formatMoney(b.total)}</span> ·{" "}
                  {formatDateTime(b.confirmedAt ?? b.createdAt)}
                </span>
                <span className="flex flex-wrap items-center gap-2">
                  <Badge
                    tone={
                      b.status === "confirmed"
                        ? "done"
                        : b.status === "pending_payment"
                          ? "waiting"
                          : "neutral"
                    }
                  >
                    {BOOKING_STATUS_LABELS[b.status]}
                  </Badge>
                  {b.needsAttention ? <Badge tone="danger">Needs attention</Badge> : null}
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
