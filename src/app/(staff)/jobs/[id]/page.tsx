import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { AddPartButton } from "@/components/domain/add-part-sheet";
import { AddServiceButton } from "@/components/domain/add-service-sheet";
import { AssignmentsCard } from "@/components/domain/assignments-card";
import { IndentCard } from "@/components/domain/indent-card";
import { ApprovalSwitch, EditDetailsButton, NoteButtons } from "@/components/domain/job-notes";
import { Timeline } from "@/components/domain/job-timeline";
import { JobStatusActions } from "@/components/domain/job-status-actions";
import { LineTable } from "@/components/domain/line-table";
import { ManualLineButton } from "@/components/domain/manual-line-sheet";
import { PhotoGrid } from "@/components/domain/photo-grid";
import { ShortId } from "@/components/domain/short-id";
import { TotalsSummary } from "@/components/domain/totals-summary";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { CalendarIcon, CheckIcon } from "@/components/ui/icons";
import { StatusPill } from "@/components/ui/status-pill";
import { formatAppointmentMoment } from "@/lib/appointments/format";
import { quoteEmailEnabled } from "@/lib/integrations/email/quote";
import { hasPermission } from "@/lib/auth/permissions";
import { requireStaff } from "@/lib/auth/session";
import { formatDateTime, shopDaysBetween } from "@/lib/dates";
import { listPhotos } from "@/lib/domain/attachments";
import { getIndentPanel } from "@/lib/domain/indent";
import { listLocations } from "@/lib/domain/inventory";
import { getWorkOrderYield } from "@/lib/domain/reports";
import {
  TIMELINE_ALL_ROWS,
  getWorkOrder,
  listActiveStaff,
  type WorkOrderDetail,
} from "@/lib/domain/workshop";
import { telHref } from "@/lib/people";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/uuid";
import {
  OVERDUE_AFTER_DAYS,
  STATUS_LABELS,
  isClosedStatus,
  isOpenStatus,
  isOverdue,
  statusTone,
} from "@/lib/workshop";

export const metadata: Metadata = { title: "Job" };

function age(checkedInAt: string, now: Date): string {
  const days = shopDaysBetween(checkedInAt, now);
  if (days <= 0) return "today";
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

/** The stamps a job has, each its own labelled row (completed and collected never merge). */
function stampRows(job: WorkOrderDetail): { label: string; at: string; note?: string | null }[] {
  const s = job.stamps;
  const rows: { label: string; at: string | null; note?: string | null }[] = [
    { label: "Checked in", at: s.checkedInAt },
    { label: "Started", at: s.startedAt },
    { label: "Completed", at: s.completedAt },
    { label: "Ready for collection", at: s.readyForCollectionAt },
    { label: "Collected", at: s.collectedAt },
    { label: "Cancelled", at: s.cancelledAt, note: s.cancellationReason },
  ];
  return rows.filter(
    (r): r is { label: string; at: string; note?: string | null } => r.at !== null,
  );
}

/** The Cult Commons rate shared by every live line, for the totals' label; null when mixed. */
function sharedRate(job: WorkOrderDetail): string | null {
  const rates = new Set(job.lines.filter((l) => !l.voided && l.costs).map((l) => l.costs!.ccRate));
  return rates.size === 1 ? [...rates][0] : null;
}

/**
 * One job (SPEC §7, §21, §22): its number, status and the next steps
 * first; then what the customer asked for, the lines with running totals
 * (services, parts from stock and manual lines; costs, yield and Cult
 * Commons only with view_costs: the DTO has none otherwise), photos, the
 * people on it, notes and the timeline. A job checked in from an
 * appointment (D40) links back to it under the header. Straight after intake (`?intake=photos`) the intake photos come first: the job
 * has to exist before a photo can be recorded against it. The timeline
 * shows its newest events; `?events=all` shows up to TIMELINE_ALL_ROWS.
 */
export default async function JobPage({ params, searchParams }: PageProps<"/jobs/[id]">) {
  const staff = await requireStaff();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const query = await searchParams;
  const intake = query.intake === "photos";
  const allEvents = query.events === "all";
  const viewCosts = hasPermission(staff, "view_costs");
  const canOrder = hasPermission(staff, "manage_purchasing");
  // D60, D147: expected costs and suppliers on indent parts.
  const purchaseData = viewCosts || canOrder;
  const supabase = await createClient();
  const [job, photos, activeStaff, locations, report, indent] = await Promise.all([
    getWorkOrder(supabase, id, {
      viewCosts,
      ...(allEvents ? { timelineRows: TIMELINE_ALL_ROWS } : {}),
    }),
    listPhotos(supabase, { entityType: "work_order", entityId: id }),
    listActiveStaff(supabase),
    listLocations(supabase),
    // The yield panel's rates, losses and recognition (view_costs only, D30).
    viewCosts ? getWorkOrderYield(supabase, id) : Promise.resolve(null),
    // Indent parts and the customer's quote (Phase 13, D140-D147).
    getIndentPanel(supabase, id, { purchaseData }),
  ]);
  if (!job) notFound();
  // Units on live part lines: a reopen puts them back on hold (D25).
  const heldUnits = job.lines
    .filter((l) => !l.voided && l.part?.unitId)
    .map((l) => l.part!.shortId);

  const now = new Date();
  const open = isOpenStatus(job.status);
  const closed = isClosedStatus(job.status);
  const overdue = isOverdue({ status: job.status, checkedInAt: job.stamps.checkedInAt }, now);
  const tel = telHref(job.customer.phone);
  const target = { entityType: "work_order" as const, entityId: job.id };
  const lockedReason = open
    ? null
    : closed
      ? "This job is closed, so its lines can't change."
      : "Completed jobs are locked. Reopen to change lines.";

  return (
    <>
      <header className="flex flex-col gap-3 pt-6 pb-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1>
            <ShortId value={job.jobNumber} large />
          </h1>
          <StatusPill status={statusTone(job.status)}>{STATUS_LABELS[job.status]}</StatusPill>
          {overdue ? (
            <Badge tone="danger" emphasis="solid">
              Overdue
            </Badge>
          ) : null}
        </div>
        <p className="flex flex-wrap items-center gap-2 text-2xl leading-tight font-semibold">
          <Link href={`/bikes/${job.bike.id}`} className="underline-offset-4 hover:underline">
            {job.bike.title}
          </Link>
          <ShortId value={job.bike.shortId} />
        </p>
        <p className="text-dust-700">
          <Link href={`/customers/${job.customer.id}`} className="font-medium underline">
            {job.customer.label}
          </Link>
          {job.customer.phone ? (
            <>
              {" · "}
              {tel ? (
                <a href={tel} className="font-medium underline">
                  {job.customer.phone}
                </a>
              ) : (
                job.customer.phone
              )}
            </>
          ) : null}
        </p>
        <p className="text-sm text-dust-500">
          Checked in {formatDateTime(job.stamps.checkedInAt)} · {age(job.stamps.checkedInAt, now)}
          {overdue ? ` · open more than ${OVERDUE_AFTER_DAYS} days` : ""}
        </p>
        {job.appointment ? (
          <p>
            <Link
              href={`/appointments/${job.appointment.id}`}
              className="inline-flex min-h-tap items-center gap-2 rounded-full border border-hairline bg-card px-4 text-sm font-medium transition-colors hover:bg-dust-100"
            >
              <CalendarIcon className="size-4 shrink-0 text-dust-500" />
              <span>
                Booked appointment · {formatAppointmentMoment(job.appointment.startsAt)} ·{" "}
                {job.appointment.typeName}
              </span>
            </Link>
          </p>
        ) : null}
      </header>

      <JobStatusActions
        workOrderId={job.id}
        jobNumber={job.jobNumber}
        customerLabel={job.customer.label}
        status={job.status}
        heldUnits={heldUnits}
      />

      {intake ? (
        <Card
          title="Intake photos"
          eyebrow="Before work starts"
          actions={
            <ButtonLink
              href={`/jobs/${job.id}`}
              replace
              variant="solid"
              size="sm"
              icon={<CheckIcon className="size-4" />}
            >
              Done
            </ButtonLink>
          }
        >
          <p className="mb-4 text-dust-700">
            Photograph the bike as it came in: each side, the drivetrain and any damage.
          </p>
          <PhotoGrid target={target} photos={photos} />
        </Card>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="flex min-w-0 flex-col gap-6">
          <Card
            title="Requested work"
            actions={
              <EditDetailsButton
                workOrderId={job.id}
                details={{
                  requestedWork: job.requestedWork,
                  intakeNotes: job.intakeNotes,
                  internalNotes: job.internalNotes,
                  completionNotes: job.completionNotes,
                }}
              />
            }
          >
            <p className="whitespace-pre-line">{job.requestedWork}</p>
            {job.intakeNotes ? (
              <>
                <h3 className="mt-4 font-display text-xs font-bold tracking-wide uppercase">
                  Condition on arrival
                </h3>
                <p className="mt-1 whitespace-pre-line text-dust-700">{job.intakeNotes}</p>
              </>
            ) : null}
          </Card>

          <Card
            title="Lines"
            flush
            actions={
              <>
                <AddServiceButton
                  workOrderId={job.id}
                  viewCosts={viewCosts}
                  currency={job.currency}
                  disabled={!open}
                />
                <AddPartButton
                  workOrderId={job.id}
                  viewCosts={viewCosts}
                  disabled={!open}
                  hasActiveLocation={locations.defaultLocationId !== null}
                />
                <ManualLineButton
                  workOrderId={job.id}
                  viewCosts={viewCosts}
                  currency={job.currency}
                  disabled={!open}
                />
              </>
            }
          >
            {lockedReason ? (
              <p className="px-4 pb-3 text-sm text-dust-700 sm:px-5">{lockedReason}</p>
            ) : null}
            <LineTable lines={job.lines} viewCosts={viewCosts} canVoid={open} />
            <div className="mt-3">
              <TotalsSummary totals={job.totals} ccRate={sharedRate(job)} report={report} />
            </div>
          </Card>

          <IndentCard
            workOrderId={job.id}
            jobNumber={job.jobNumber}
            open={open}
            panel={indent}
            customer={{
              firstName: job.customer.firstName,
              phone: job.customer.phone,
              email: job.customer.email,
            }}
            canOrder={canOrder}
            purchaseData={purchaseData}
            canCreateProduct={hasPermission(staff, "manage_inventory")}
            emailEnabled={quoteEmailEnabled()}
          />

          {intake ? null : (
            <Card title="Photos">
              <PhotoGrid target={target} photos={photos} canAdd={!closed} />
            </Card>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-6">
          <AssignmentsCard
            workOrderId={job.id}
            assignments={job.assignments}
            staff={activeStaff}
            editable={!closed}
          />

          <Card title="Dates">
            <dl aria-label="Dates" className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              {stampRows(job).map((r) => (
                <div key={r.label} className="contents">
                  <dt className="text-sm text-dust-500">{r.label}</dt>
                  <dd className="text-sm">
                    <time dateTime={r.at}>{formatDateTime(r.at)}</time>
                    {r.note ? <span className="block text-dust-700">“{r.note}”</span> : null}
                  </dd>
                </div>
              ))}
            </dl>
          </Card>

          <Card title="Notes" eyebrow="Staff only">
            <div className="flex flex-col gap-5">
              {closed ? (
                job.approval.flagged || job.approval.note ? (
                  <div>
                    {job.approval.flagged ? <Badge tone="done">Customer approved</Badge> : null}
                    {job.approval.note ? (
                      <p className="mt-1 text-dust-700">{job.approval.note}</p>
                    ) : null}
                  </div>
                ) : null
              ) : (
                <ApprovalSwitch
                  workOrderId={job.id}
                  flagged={job.approval.flagged}
                  note={job.approval.note}
                />
              )}
              {job.internalNotes ? (
                <div>
                  <h3 className="font-display text-xs font-bold tracking-wide uppercase">
                    Internal notes
                  </h3>
                  <p className="mt-1 whitespace-pre-line text-dust-700">{job.internalNotes}</p>
                </div>
              ) : null}
              {job.completionNotes ? (
                <div>
                  <h3 className="font-display text-xs font-bold tracking-wide uppercase">
                    Completion notes
                  </h3>
                  <p className="mt-1 whitespace-pre-line text-dust-700">{job.completionNotes}</p>
                </div>
              ) : null}
              <div className="flex flex-col gap-2">
                <p className="text-sm text-dust-500">
                  Notes and diagnoses go into the timeline below.
                </p>
                <NoteButtons workOrderId={job.id} />
              </div>
            </div>
          </Card>

          <Card title="Timeline" id="timeline" className="scroll-mt-20">
            <Timeline
              entries={job.timeline}
              truncated={job.timelineTruncated}
              moreHref={allEvents ? null : `/jobs/${job.id}?events=all#timeline`}
            />
          </Card>
        </div>
      </div>
    </>
  );
}
