import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { AddPartButton } from "@/components/domain/add-part-sheet";
import { AddServiceButton } from "@/components/domain/add-service-sheet";
import { AssignmentsCard } from "@/components/domain/assignments-card";
import { IndentCard } from "@/components/domain/indent-card";
import { ApprovalSwitch, EditDetailsButton, NoteButtons } from "@/components/domain/job-notes";
import { PaymentsCard } from "@/components/domain/payments-card";
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
import { balanceEmailEnabled } from "@/lib/integrations/email/balance";
import { quoteEmailEnabled } from "@/lib/integrations/email/quote";
import { stripeIsOn } from "@/lib/integrations/stripe/client";
import {
  canOverrideDeposit,
  canRecordCounterPayment,
  canRecordRefund,
  hasPermission,
} from "@/lib/auth/permissions";
import { requireStaff } from "@/lib/auth/session";
import { formatDateTime, shopDaysBetween } from "@/lib/dates";
import { listPhotos } from "@/lib/domain/attachments";
import { getIndentPanel, getUnfittedSummary } from "@/lib/domain/indent";
import { getJobPayments } from "@/lib/domain/payments";
import { fittedIndentLines, isUnfitted, unfittedMemo } from "@/lib/indent";
import { canSendLink, paidSummary, showsPaymentsCard } from "@/lib/payments";
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
 * Commons only with view_costs: the DTO has none otherwise), the indent
 * parts and quote (Phase 13), the Customer payments card once a deposit,
 * an online payment or a counter payment exists, or when a payment link
 * can be sent or an admin can record a counter payment (Phase 14, D154,
 * D156, D161; hidden if its read fails), what was paid (online and at the
 * counter) and what is left under the total, approved indent items not on
 * the bill as a memo under the total, never in it, and what a closed job
 * holds above its bill (R-082); Complete and the
 * other moves out of the open statuses settle those items first (D149b),
 * and voiding a line a fitted indent item became puts it back among them
 * (D160),
 * photos, the people on it, notes and the timeline. A job checked in from an
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
  const [job, photos, activeStaff, locations, report, indent, payments, unfitted] =
    await Promise.all([
      getWorkOrder(supabase, id, {
        viewCosts,
        ...(allEvents ? { timelineRows: TIMELINE_ALL_ROWS } : {}),
      }),
      listPhotos(supabase, { entityType: "work_order", entityId: id }),
      listActiveStaff(supabase),
      listLocations(supabase),
      // The yield panel's rates, losses and recognition (view_costs only, D30).
      viewCosts ? getWorkOrderYield(supabase, id) : Promise.resolve(null),
      // Indent parts and the customer's quote (Phase 13, D140-D147); with
      // view_costs, whether each part's product has a cost (Fit needs one).
      getIndentPanel(supabase, id, { purchaseData, viewCosts }),
      // Deposits and online payments (Phase 14, D151-D159); null when the read fails.
      getJobPayments(supabase, id),
      // Approved indent items not on the bill (R-082); null when none or the read fails.
      getUnfittedSummary(supabase, id),
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
  const stripeOn = stripeIsOn();
  // D154, D161 at the counter: what was paid online and at the counter,
  // shown by the total and on Collected, with what Stripe is confirming.
  const paid = paidSummary(payments?.totals ?? null);
  const canRecordCounter = canRecordCounterPayment(staff);
  const showPayments =
    payments !== null &&
    showsPaymentsCard({
      deposits: payments.deposits.length,
      payments: payments.payments.length,
      counterPayments: payments.counterPayments.length,
      canSendLink:
        payments.totals !== null &&
        canSendLink({
          stripeOn,
          jobStatus: job.status,
          currency: payments.totals.currency,
          balanceDue: payments.totals.balanceDue,
          processingOnline: payments.totals.processingOnline,
        }),
      canRecordCounter,
      jobStatus: job.status,
    });
  // R-082: approved indent items not on the bill: a memo under the total
  // (never in it); the moves out of the open statuses settle them first
  // (D149b), so the Collected confirmation no longer names them.
  const memo = unfittedMemo(unfitted, open);
  const defaultLocationName =
    locations.locations.find((l) => l.id === locations.defaultLocationId)?.name ?? null;
  // D149b, D149c: what the settle checklist lists before the job leaves the
  // open statuses (approved and ordered items) and the quote it withdraws.
  const settle = {
    items: indent.requests.filter((r) => isUnfitted(r.status)),
    quote: indent.quote,
    quotedItems: indent.requests.filter((r) => r.status === "quoted").length,
    purchaseData,
    canOrder,
    defaultLocationName,
    deposits: payments?.deposits ?? [],
  };
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
        paid={paid}
        settle={settle}
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
            <LineTable
              lines={job.lines}
              viewCosts={viewCosts}
              canVoid={open}
              // D160: voiding a line a fitted indent item became puts the
              // item back to approved or ordered; the confirmation says so.
              indentLines={fittedIndentLines(indent.requests)}
            />
            <div className="mt-3">
              <TotalsSummary totals={job.totals} ccRate={sharedRate(job)} report={report} />
            </div>
            {memo ? (
              // R-082, D140: approved indent items reach the total only
              // when fitted; this memo is never added to it, to the yield
              // or to Cult Commons.
              <p
                aria-label="Approved, not on the bill"
                className="border-t border-hairline px-4 py-3 text-sm text-waiting-deep sm:px-5"
              >
                <a href="#indent-parts" className="underline underline-offset-4">
                  {memo}
                </a>
              </p>
            ) : null}
            {paid ? (
              // D154, D161 where the counter looks: what was paid (online
              // and at the counter) is not in the total above (money held,
              // not a sale), and Stripe money being confirmed is not taken
              // again.
              <p
                aria-label="Paid and still to pay"
                className="flex flex-wrap gap-x-2 border-t border-hairline px-4 py-3 text-sm font-semibold sm:px-5"
              >
                {paid.paid ? (
                  <>
                    <a href="#customer-payments" className="underline underline-offset-4">
                      Paid {paid.paid}
                    </a>
                    {paid.source === "both" ? (
                      <span className="font-normal">
                        ({paid.online} online, {paid.counter} at the counter)
                      </span>
                    ) : null}
                  </>
                ) : (
                  <a href="#customer-payments" className="underline underline-offset-4">
                    {paid.processing} being confirmed by Stripe
                  </a>
                )}
                {paid.paidAhead ? (
                  <span>
                    · {open ? "Paid ahead" : "Paid above the bill"} {paid.paidAhead}
                  </span>
                ) : paid.stillToPay ? (
                  <span>· Still to pay {paid.stillToPay}</span>
                ) : paid.moreThanBill ? (
                  <span>· {paid.moreThanBill} more than the bill</span>
                ) : null}
                {paid.paid && paid.processing ? (
                  <span className="text-waiting-deep">
                    · {paid.processing} being confirmed by Stripe
                  </span>
                ) : null}
              </p>
            ) : null}
          </Card>

          <IndentCard
            id="indent-parts"
            workOrderId={job.id}
            jobNumber={job.jobNumber}
            open={open}
            jobStatus={job.status}
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
            deposits={payments?.deposits ?? []}
            canOverrideDeposit={canOverrideDeposit(staff)}
            canCancelClosed={canRecordRefund(staff)}
            defaultLocationName={defaultLocationName}
          />

          {payments && showPayments ? (
            <PaymentsCard
              id="customer-payments"
              job={{
                id: job.id,
                jobNumber: job.jobNumber,
                status: job.status,
                open,
                currency: job.currency,
                checkedInAt: job.stamps.checkedInAt,
              }}
              payments={payments}
              canCheck={stripeOn}
              canOpenStripe={canRecordRefund(staff)}
              payOnline={stripeOn}
              canRecordCounter={canRecordCounter}
              customer={{
                firstName: job.customer.firstName,
                phone: job.customer.phone,
                email: job.customer.email,
              }}
              emailEnabled={balanceEmailEnabled()}
            />
          ) : null}

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
