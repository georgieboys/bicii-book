import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { CustomerAppointmentRows } from "@/components/domain/appointments/appointment-list";
import { ArchiveControl } from "@/components/domain/archive-control";
import { BookAppointmentButton } from "@/components/domain/book-appointment-sheet";
import { NewBikeButton } from "@/components/domain/bike-sheet";
import { EditCustomerButton } from "@/components/domain/customer-sheet";
import { JobHistoryList } from "@/components/domain/job-history";
import { PhotoGrid } from "@/components/domain/photo-grid";
import { ShortId } from "@/components/domain/short-id";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  BikeIcon,
  CalendarIcon,
  ChevronRightIcon,
  PlusIcon,
  WrenchIcon,
} from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/page-header";
import { RowLink, RowList } from "@/components/ui/row-list";
import { requireStaff } from "@/lib/auth/session";
import { formatDate } from "@/lib/dates";
import { CUSTOMER_PAST_APPOINTMENTS, customerAppointments } from "@/lib/domain/appointments";
import { listPhotos } from "@/lib/domain/attachments";
import { getCustomer } from "@/lib/domain/customers";
import { listWorkOrdersForCustomer } from "@/lib/domain/workshop";
import { mailtoHref, telHref } from "@/lib/people";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/uuid";

export const metadata: Metadata = { title: "Customer" };

/**
 * One customer (SPEC §21): how to reach them, staff notes, the bikes they
 * own now (add one here), their appointments (upcoming first, then the
 * last CUSTOMER_PAST_APPOINTMENTS; "Book appointment" with the customer
 * fixed), their jobs (latest 20, "New job"), photos on their record (never
 * public, PLAN D13), and archiving. Archived customers can't be booked or
 * given bikes.
 */
export default async function CustomerPage({ params }: PageProps<"/customers/[id]">) {
  await requireStaff();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const supabase = await createClient();
  const [customer, photos, jobs, appointments] = await Promise.all([
    getCustomer(supabase, id),
    listPhotos(supabase, { entityType: "customer", entityId: id }),
    listWorkOrdersForCustomer(supabase, id),
    customerAppointments(supabase, id),
  ]);
  if (!customer) notFound();
  const archived = customer.archivedAt !== null;
  const tel = telHref(customer.phone);
  const mailto = mailtoHref(customer.email);

  return (
    <>
      <PageHeader
        eyebrow="Customer"
        title={customer.label}
        description={`Customer since ${formatDate(customer.createdAt)}`}
        actions={
          <>
            {archived ? <Badge tone="waiting">Archived</Badge> : null}
            <EditCustomerButton
              customer={{
                id: customer.id,
                firstName: customer.firstName,
                lastName: customer.lastName,
                displayName: customer.displayName,
                email: customer.email,
                phone: customer.phone,
                internalNotes: customer.internalNotes,
                updatedAt: customer.updatedAt,
              }}
            />
          </>
        }
      />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Contact">
          {tel || mailto ? (
            <ul
              aria-label="Contact"
              className="-mx-4 flex flex-col divide-y divide-hairline sm:-mx-5"
            >
              {customer.phone ? (
                <li>
                  {tel ? (
                    <a
                      href={tel}
                      className="flex min-h-tap flex-col px-4 py-2 focus-inset hover:bg-dust-100 sm:px-5"
                    >
                      <span className="eyebrow text-dust-500">Phone · tap to call</span>
                      <span className="text-lg font-medium tabular-nums">{customer.phone}</span>
                    </a>
                  ) : (
                    <p className="px-4 py-2 sm:px-5">{customer.phone}</p>
                  )}
                </li>
              ) : null}
              {customer.email ? (
                <li>
                  {mailto ? (
                    <a
                      href={mailto}
                      className="flex min-h-tap flex-col px-4 py-2 break-all focus-inset hover:bg-dust-100 sm:px-5"
                    >
                      <span className="eyebrow text-dust-500">Email</span>
                      <span className="text-lg font-medium">{customer.email}</span>
                    </a>
                  ) : (
                    <p className="px-4 py-2 sm:px-5">{customer.email}</p>
                  )}
                </li>
              ) : null}
            </ul>
          ) : (
            <p className="text-dust-700">No phone number or email on file.</p>
          )}
        </Card>
        <Card title="Internal notes" eyebrow="Staff only">
          {customer.internalNotes ? (
            <p className="whitespace-pre-line text-dust-700">{customer.internalNotes}</p>
          ) : (
            <p className="text-dust-500">No notes. Add them with Edit.</p>
          )}
        </Card>
      </div>
      <Card
        title="Bikes"
        actions={
          <NewBikeButton
            owner={{ id: customer.id, label: customer.label }}
            disabled={archived}
            variant="outline"
          />
        }
      >
        {archived ? (
          <p className="mb-3 text-sm text-dust-500">
            Archived customers cannot receive bikes. Unarchive them first.
          </p>
        ) : null}
        {customer.bikes.length === 0 ? (
          <p className="flex items-center gap-2 text-dust-700">
            <BikeIcon className="size-5 shrink-0 text-dust-500" />
            No bikes registered to {customer.label} yet.
          </p>
        ) : (
          <RowList label={`Bikes of ${customer.label}`}>
            {customer.bikes.map((bike) => (
              <RowLink key={bike.id} href={`/bikes/${bike.id}`}>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-center gap-2">
                    <span className="line-clamp-2 font-medium break-words">{bike.title}</span>
                    {bike.archived ? <Badge>Archived</Badge> : null}
                  </span>
                  {bike.detail ? (
                    <span className="truncate text-sm text-dust-500">{bike.detail}</span>
                  ) : null}
                </span>
                <ShortId value={bike.shortId} />
                <ChevronRightIcon className="size-5 shrink-0 text-dust-500" />
              </RowLink>
            ))}
          </RowList>
        )}
      </Card>
      <Card
        title="Appointments"
        actions={
          <BookAppointmentButton
            presetCustomer={{ id: customer.id, label: customer.label }}
            lockCustomer
            disabled={archived}
            buttonVariant="outline"
            size="sm"
          />
        }
      >
        {archived ? (
          <p className="mb-3 text-sm text-dust-500">
            Archived customers cannot be booked in. Unarchive them first.
          </p>
        ) : null}
        {appointments.upcoming.length === 0 && appointments.past.length === 0 ? (
          <p className="flex items-center gap-2 text-dust-700">
            <CalendarIcon className="size-5 shrink-0 text-dust-500" />
            No appointments for {customer.label} yet.
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            {appointments.upcoming.length > 0 ? (
              <CustomerAppointmentRows
                label={`Upcoming appointments of ${customer.label}`}
                appointments={appointments.upcoming}
              />
            ) : (
              <p className="text-dust-700">Nothing booked from today on.</p>
            )}
            {appointments.past.length > 0 ? (
              <div className="flex flex-col gap-2">
                <h3 className="font-display text-xs font-bold tracking-wide text-dust-700 uppercase">
                  Past
                  {appointments.past.length === CUSTOMER_PAST_APPOINTMENTS
                    ? ` (latest ${CUSTOMER_PAST_APPOINTMENTS})`
                    : ""}
                </h3>
                <CustomerAppointmentRows
                  label={`Past appointments of ${customer.label}`}
                  appointments={appointments.past}
                />
              </div>
            ) : null}
          </div>
        )}
      </Card>
      <Card
        title="Jobs"
        actions={
          archived ? null : (
            <ButtonLink
              href={`/jobs/new?customer=${customer.id}`}
              variant="outline"
              size="sm"
              icon={<PlusIcon className="size-4" />}
            >
              New job
            </ButtonLink>
          )
        }
      >
        {jobs.items.length === 0 ? (
          <p className="flex items-center gap-2 text-dust-700">
            <WrenchIcon className="size-5 shrink-0 text-dust-500" />
            No jobs for {customer.label} yet.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {jobs.more ? (
              <p className="text-sm text-dust-700">
                Showing the latest {jobs.items.length} jobs. There are more: find an older one by
                its J- number in Search, or on a bike&rsquo;s service history.
              </p>
            ) : null}
            <JobHistoryList label={`Jobs of ${customer.label}`} jobs={jobs.items} showBike />
          </div>
        )}
      </Card>
      <Card title="Photos" eyebrow="On the customer record">
        <PhotoGrid
          target={{ entityType: "customer", entityId: customer.id }}
          photos={photos}
          canAdd={!archived}
        />
      </Card>
      <Card title="Archive">
        <ArchiveControl
          kind="customer"
          id={customer.id}
          name={customer.label}
          archived={archived}
        />
      </Card>
    </>
  );
}
