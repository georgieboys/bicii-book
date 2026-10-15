"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition } from "react";

import { setWorkOrderStatus } from "@/app/(staff)/jobs/actions";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Sheet } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { useArmed, useArmedAfter } from "@/components/ui/use-armed";
import type { ActionResult } from "@/lib/actions";
import { cn } from "@/lib/cn";
import {
  CANCEL_UNSETTLED_REFUSAL,
  settleNeeded,
  type ClosingStatus,
  type PartRequestStatus,
} from "@/lib/indent";
import { reopenUnitNote } from "@/lib/inventory";
import { collectedNotes, type paidOnlineSummary } from "@/lib/payments";
import { REASON_MAX_LENGTH } from "@/lib/reasons";
import {
  STATUS_LABELS,
  allowedTransitions,
  isOpenStatus,
  primaryActions,
  type WorkOrderStatus,
} from "@/lib/workshop";

import { ReasonConfirm } from "./reason-confirm";
import { SettleItemsSheet, type SettleContext } from "./settle-items-sheet";

/** The code the settle guard refuses a move with (D149b, D149c). */
const UNSETTLED = "work_order_has_unfitted_requests";

/**
 * A cancel refused for unsettled items (a stale page) says to cancel them,
 * not the mapped "Fit or cancel": a fitted line would stop the cancel too
 * (work_order_has_lines, D16), so the checklist for a cancel offers Cancel
 * only.
 */
function cancelRefusal<T>(result: ActionResult<T>): ActionResult<T> {
  return !result.ok && result.code === UNSETTLED
    ? { ...result, error: CANCEL_UNSETTLED_REFUSAL }
    : result;
}

/**
 * A job's status controls (D15, D16): the usual next steps as large
 * one-tap buttons (primaryActions), and "Change status" for every other
 * allowed move, with an optional note. The database checks every move
 * again; the page refreshes after each.
 *
 * Double taps (DESIGN.md "Forms"): the refreshed page puts the next
 * status's button where the finger is, so the row stays disabled for
 * CONFIRM_GUARD_MS after every status change (useArmedAfter). Collected is
 * final, so it is never one tap: it opens a confirmation naming the job and
 * the customer, focus on Back, whose confirm button is armed after the same
 * guard. Cancelling and reopening need a reason (ReasonConfirm). Both ways
 * to Collected (the button and Change status) say what was paid online.
 *
 * D149b, D149c(1): a move into completed, ready for collection, collected
 * or cancelled while an indent item is approved or ordered opens the settle
 * checklist instead (SettleItemsSheet: Fit and Cancel, Cancel only for
 * Cancel job), whichever way it was chosen; its button continues once none
 * is left, with the note typed in Change status, if any. A stale page
 * refused by the database (work_order_has_unfitted_requests) refreshes and
 * opens it.
 */
export function JobStatusActions({
  workOrderId,
  jobNumber,
  customerLabel,
  status,
  heldUnits = [],
  paidOnline = null,
  settle = null,
}: {
  workOrderId: string;
  jobNumber: string;
  customerLabel: string;
  status: WorkOrderStatus;
  /**
   * D154: money the customer already paid online (paidOnlineSummary), which
   * the Collected confirmation says, so staff take only what is left.
   */
  paidOnline?: ReturnType<typeof paidOnlineSummary>;
  /**
   * U- numbers of the unique units on the job's live part lines: a reopen
   * puts them back on hold for the job (D25), which the reopen says.
   */
  heldUnits?: readonly string[];
  /**
   * D149b: the job's approved and ordered indent items and what the settle
   * checklist needs; null (or no items) moves straight on.
   */
  settle?: SettleContext | null;
}) {
  const { toast } = useToast();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [moving, setMoving] = useState<WorkOrderStatus | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [confirmingCollected, setConfirmingCollected] = useState(false);
  const [settling, setSettling] = useState<ClosingStatus | null>(null);
  // The Change status note, kept while the checklist (and, for Collected,
  // the confirmation) comes between; sent with the move.
  const [settleNote, setSettleNote] = useState<string | undefined>();
  const armed = useArmedAfter(status);
  const primary = primaryActions(status);
  const transitions = allowedTransitions(status);
  const items = settle?.items ?? [];
  const notes = collectedNotes(paidOnline);

  /** Open the checklist for a move to `to`, keeping its note. */
  const startSettling = (to: ClosingStatus, note?: string) => {
    setSettleNote(note);
    setSettling(to);
  };

  /** Leave the checklist or the confirmation: the note goes with them. */
  const stopSettling = () => {
    setSettling(null);
    setSettleNote(undefined);
  };

  /**
   * The database refused a stale page: refresh, then show what is left
   * (`error` null when a ReasonConfirm already said why).
   */
  const refusedUnsettled = (to: ClosingStatus, error: string | null, note?: string) => {
    if (error) toast({ title: "Status not changed", description: error, tone: "error" });
    router.refresh();
    setConfirmingCollected(false);
    startSettling(to, note);
  };

  const move = (to: WorkOrderStatus, note?: string) => {
    if (settleNeeded(to, items)) {
      startSettling(to, note);
      return;
    }
    setMoving(to);
    startTransition(async () => {
      const result = await setWorkOrderStatus({ workOrderId, status: to, note });
      setMoving(null);
      if (!result.ok) {
        if (result.code === UNSETTLED && !isOpenStatus(to)) {
          refusedUnsettled(to as ClosingStatus, result.error, note);
          return;
        }
        toast({ title: "Status not changed", description: result.error, tone: "error" });
        return;
      }
      setConfirmingCollected(false);
      stopSettling();
      toast({ title: `${jobNumber}: ${STATUS_LABELS[to]}`, tone: "success" });
    });
  };

  /** Collected: the checklist first when items are left, then the confirmation. */
  const toCollected = () =>
    settleNeeded("collected", items) ? startSettling("collected") : setConfirmingCollected(true);

  if (transitions.length === 0) return null;

  if (confirmingCollected) {
    return (
      <CollectedConfirm
        jobNumber={jobNumber}
        customerLabel={customerLabel}
        notes={notes}
        pending={pending}
        onBack={() => {
          setConfirmingCollected(false);
          setSettleNote(undefined);
        }}
        onConfirm={() => move("collected", settleNote)}
      />
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {primary.map((action, i) => (
        <Button
          key={action.to}
          size="lg"
          variant={i === 0 ? "solid" : "outline"}
          pending={pending && moving === action.to}
          disabled={pending || !armed}
          onClick={() => (action.to === "collected" ? toCollected() : move(action.to))}
        >
          {action.to === "collected" || settleNeeded(action.to, items)
            ? `${action.label}…`
            : action.label}
        </Button>
      ))}
      <Button variant="ghost" disabled={pending} onClick={() => setSheetOpen(true)}>
        Change status
      </Button>
      {sheetOpen ? (
        <ChangeStatusSheet
          workOrderId={workOrderId}
          jobNumber={jobNumber}
          status={status}
          heldUnits={heldUnits}
          collectedNotes={notes}
          settleItems={items}
          onSettle={(to, note) => {
            setSheetOpen(false);
            startSettling(to, note);
          }}
          onRefused={(to, error, note) => {
            setSheetOpen(false);
            refusedUnsettled(to, error, note);
          }}
          onClose={() => setSheetOpen(false)}
        />
      ) : null}
      {settling && settle ? (
        <SettleItemsSheet
          jobNumber={jobNumber}
          jobStatus={status}
          target={settling}
          settle={settle}
          pending={pending}
          onBack={stopSettling}
          onContinue={() => {
            if (settling === "collected") {
              // The note waits for the confirmation's Mark collected.
              setSettling(null);
              setConfirmingCollected(true);
            } else {
              move(settling, settleNote);
            }
          }}
          onCancelJob={async (reason) => {
            const result = await setWorkOrderStatus({
              workOrderId,
              status: "cancelled",
              note: reason,
            });
            if (!result.ok && result.code === UNSETTLED) router.refresh();
            return cancelRefusal(result);
          }}
          onCancelled={stopSettling}
        />
      ) : null}
    </div>
  );
}

/**
 * "Collected" is final (D15: no reopen, the job locks): a second step that
 * names the job and who collects it and what the customer already paid
 * online (D154), focus on Back, and a confirm button that ignores presses
 * for CONFIRM_GUARD_MS. Approved indent items are never left by then: the
 * settle checklist comes first (D149b).
 */
function CollectedConfirm({
  jobNumber,
  customerLabel,
  notes,
  pending,
  onBack,
  onConfirm,
}: {
  jobNumber: string;
  customerLabel: string;
  /** collectedNotes(): what was paid online, if anything. */
  notes: readonly string[];
  pending: boolean;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const armed = useArmed(true);
  const backRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  useEffect(() => backRef.current?.focus(), []);
  return (
    <div
      key="confirm-collected"
      role="group"
      aria-labelledby={titleId}
      className="flex flex-col gap-3 rounded-xl bg-waiting-soft p-4"
    >
      <p id={titleId} className="font-medium text-waiting-deep">
        Mark {jobNumber} collected by {customerLabel}?
      </p>
      {notes.map((note) => (
        <p key={note} className="text-sm font-semibold text-waiting-deep">
          {note}
        </p>
      ))}
      <p className="text-sm text-waiting-deep">
        Collected is final: the job can&apos;t be reopened, and its lines and people are locked.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button key="back" ref={backRef} variant="outline" disabled={pending} onClick={onBack}>
          Back
        </Button>
        <Button
          key="confirm"
          variant="solid"
          disabled={!armed}
          pending={pending}
          pendingLabel="Saving…"
          onClick={onConfirm}
        >
          Mark collected
        </Button>
      </div>
    </div>
  );
}

function ChangeStatusSheet({
  workOrderId,
  jobNumber,
  status,
  heldUnits,
  collectedNotes: notes,
  settleItems,
  onSettle,
  onRefused,
  onClose,
}: {
  workOrderId: string;
  jobNumber: string;
  status: WorkOrderStatus;
  heldUnits: readonly string[];
  /** The Collected confirmation's sentences (collectedNotes), shown when Collected is picked. */
  collectedNotes: readonly string[];
  /** D149b: approved and ordered indent items; a move out of the open statuses settles them first. */
  settleItems: readonly { status: PartRequestStatus }[];
  /** Open the settle checklist for this move instead (this sheet closes), keeping the note. */
  onSettle: (to: ClosingStatus, note?: string) => void;
  /** The database refused the move for unsettled items (a stale page); null: already said. */
  onRefused: (to: ClosingStatus, error: string | null, note?: string) => void;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const formId = useId();
  const [pending, startTransition] = useTransition();
  const transitions = allowedTransitions(status);
  const forward = transitions.filter((t) => t.kind === "forward");
  const reopen = transitions.find((t) => t.kind === "reopen");
  const cancel = transitions.find((t) => t.kind === "cancel");
  // Nothing is chosen for the user: the submit stays disabled until a
  // status is picked.
  const [to, setTo] = useState<WorkOrderStatus | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | undefined>();
  // While a reopen or cancel reason is open, the sheet's own submit is
  // hidden, so it cannot be taken for that confirmation's button.
  const [reopening, setReopening] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const reasonOpen = reopening || cancelling;

  const unsettled = settleItems.length > 0;

  const submit = () => {
    if (!to) return;
    if (settleNeeded(to, settleItems)) {
      onSettle(to, note);
      return;
    }
    startTransition(async () => {
      const result = await setWorkOrderStatus({ workOrderId, status: to, note });
      if (!result.ok) {
        const fieldError = result.fieldErrors?.note?.[0];
        if (fieldError) setError(fieldError);
        else if (result.code === UNSETTLED && !isOpenStatus(to))
          onRefused(to as ClosingStatus, result.error, note);
        else toast({ title: "Status not changed", description: result.error, tone: "error" });
        return;
      }
      toast({ title: `${jobNumber}: ${STATUS_LABELS[to]}`, tone: "success" });
      onClose();
    });
  };

  const withReason = (target: WorkOrderStatus) => async (reason: string) => {
    const result = await setWorkOrderStatus({ workOrderId, status: target, note: reason });
    // A stale page: ReasonConfirm says why (cancel only, as the checklist
    // that opens on the refresh offers); the reason was the cancel's own.
    if (!result.ok && result.code === UNSETTLED && target === "cancelled") {
      onRefused("cancelled", null);
      return cancelRefusal(result);
    }
    return result;
  };

  return (
    <Sheet
      open
      onOpenChange={(open) => (open ? null : onClose())}
      dismissible={!pending}
      title="Change status"
      description={`${jobNumber} is ${STATUS_LABELS[status].toLowerCase()}.`}
      footer={
        forward.length > 0 ? (
          <>
            <Button variant="outline" onClick={onClose} disabled={pending}>
              Close
            </Button>
            {reasonOpen ? null : (
              <Button
                type="submit"
                form={formId}
                pending={pending}
                pendingLabel="Saving…"
                disabled={!to}
              >
                Change status
              </Button>
            )}
          </>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-6">
        {forward.length > 0 ? (
          <form
            id={formId}
            className="flex flex-col gap-5"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 font-display text-xs font-bold tracking-wide uppercase">
                Move to
              </legend>
              {forward.map((t) => (
                <label
                  key={t.to}
                  className={cn(
                    "flex min-h-tap cursor-pointer items-center gap-3 rounded-xl border-2 px-4 py-2",
                    to === t.to ? "border-ink bg-dust-100" : "border-hairline",
                  )}
                >
                  <input
                    type="radio"
                    name="status"
                    value={t.to}
                    checked={to === t.to}
                    onChange={() => setTo(t.to)}
                    className="size-5 accent-ink"
                  />
                  <span className="font-medium">{STATUS_LABELS[t.to]}</span>
                </label>
              ))}
              {to === "collected" ? (
                <div aria-live="polite" className="flex flex-col gap-2">
                  {notes.map((note) => (
                    <p key={note} className="text-sm font-semibold text-waiting-deep">
                      {note}
                    </p>
                  ))}
                  <p className="text-sm font-medium text-waiting-deep">
                    Collected is final: the job can&apos;t be reopened, and its lines and people are
                    locked.
                  </p>
                </div>
              ) : null}
            </fieldset>
            <Field label="Note" hint="Optional. Shown on the job's timeline." error={error}>
              <Textarea
                name="note"
                rows={2}
                maxLength={REASON_MAX_LENGTH}
                value={note}
                onChange={(e) => {
                  setNote(e.target.value);
                  if (error) setError(undefined);
                }}
              />
            </Field>
          </form>
        ) : null}
        {reopen ? (
          <section className="flex flex-col gap-2">
            <h3 className="font-display text-xs font-bold tracking-wide uppercase">Reopen</h3>
            <p className="text-sm text-dust-700">
              Back to in progress, to change its lines or do more work. The completion time is
              cleared and set again when it is completed; the timeline keeps both.
            </p>
            <ReasonConfirm
              startLabel="Reopen job…"
              question="Why are you reopening this job?"
              hint="Kept on the job's timeline."
              confirmLabel="Reopen job"
              pendingLabel="Reopening…"
              failureTitle="Job not reopened"
              successTitle={`${jobNumber} reopened`}
              dismissLabel="Back"
              onConfirm={withReason(reopen.to)}
              onConfirmingChange={setReopening}
              onDone={onClose}
            >
              {heldUnits.length > 0 ? reopenUnitNote(heldUnits) : undefined}
            </ReasonConfirm>
          </section>
        ) : null}
        {cancel ? (
          <section className="flex flex-col gap-2">
            <h3 className="font-display text-xs font-bold tracking-wide uppercase">Cancel</h3>
            <p className="text-sm text-dust-700">
              Cancelling is final. Void the job&apos;s lines first
              {unsettled ? ", and cancel its approved and ordered indent items" : ""}.
            </p>
            {unsettled ? (
              // D149c(1): the checklist first; its own Cancel job… asks why.
              <Button
                variant="outline"
                className="self-start"
                onClick={() => onSettle("cancelled")}
              >
                Cancel job…
              </Button>
            ) : (
              <ReasonConfirm
                startLabel="Cancel job…"
                question="Why is this job being cancelled?"
                hint="Kept on the job's timeline."
                confirmLabel="Cancel job"
                pendingLabel="Cancelling…"
                failureTitle="Job not cancelled"
                successTitle={`${jobNumber} cancelled`}
                dismissLabel="Keep job"
                onConfirm={withReason(cancel.to)}
                onConfirmingChange={setCancelling}
                onDone={onClose}
              />
            )}
          </section>
        ) : null}
      </div>
    </Sheet>
  );
}
