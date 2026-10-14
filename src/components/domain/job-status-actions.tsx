"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";

import { setWorkOrderStatus } from "@/app/(staff)/jobs/actions";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Sheet } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { useArmed, useArmedAfter } from "@/components/ui/use-armed";
import { cn } from "@/lib/cn";
import { reopenUnitNote } from "@/lib/inventory";
import { collectedNotes, type UnfittedItem, type paidOnlineSummary } from "@/lib/payments";
import { REASON_MAX_LENGTH } from "@/lib/reasons";
import {
  STATUS_LABELS,
  allowedTransitions,
  primaryActions,
  type WorkOrderStatus,
} from "@/lib/workshop";

import { ReasonConfirm } from "./reason-confirm";

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
 * to Collected (the button and Change status) say what was paid online and
 * name approved indent items not on the bill (R-082).
 */
export function JobStatusActions({
  workOrderId,
  jobNumber,
  customerLabel,
  status,
  heldUnits = [],
  paidOnline = null,
  unfitted = [],
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
   * R-082: approved indent items (approved or ordered) not on the bill, with
   * their quoted totals, which the Collected confirmation names.
   */
  unfitted?: readonly UnfittedItem[];
}) {
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [moving, setMoving] = useState<WorkOrderStatus | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [confirmingCollected, setConfirmingCollected] = useState(false);
  const armed = useArmedAfter(status);
  const primary = primaryActions(status);
  const transitions = allowedTransitions(status);

  const move = (to: WorkOrderStatus) => {
    setMoving(to);
    startTransition(async () => {
      const result = await setWorkOrderStatus({ workOrderId, status: to });
      setMoving(null);
      if (!result.ok) {
        toast({ title: "Status not changed", description: result.error, tone: "error" });
        return;
      }
      setConfirmingCollected(false);
      toast({ title: `${jobNumber}: ${STATUS_LABELS[to]}`, tone: "success" });
    });
  };

  if (transitions.length === 0) return null;

  if (confirmingCollected) {
    return (
      <CollectedConfirm
        jobNumber={jobNumber}
        customerLabel={customerLabel}
        notes={collectedNotes(paidOnline, unfitted)}
        pending={pending}
        onBack={() => setConfirmingCollected(false)}
        onConfirm={() => move("collected")}
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
          onClick={() =>
            action.to === "collected" ? setConfirmingCollected(true) : move(action.to)
          }
        >
          {action.to === "collected" ? `${action.label}…` : action.label}
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
          collectedNotes={collectedNotes(paidOnline, unfitted)}
          onClose={() => setSheetOpen(false)}
        />
      ) : null}
    </div>
  );
}

/**
 * "Collected" is final (D15: no reopen, the job locks): a second step that
 * names the job and who collects it, what the customer already paid online
 * (D154) and any approved indent item not on the bill (R-082), focus on
 * Back, and a confirm button that ignores presses for CONFIRM_GUARD_MS.
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
  /** collectedNotes(): paid online, and approved items not on the bill. */
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
  onClose,
}: {
  workOrderId: string;
  jobNumber: string;
  status: WorkOrderStatus;
  heldUnits: readonly string[];
  /** The Collected confirmation's sentences (collectedNotes), shown when Collected is picked. */
  collectedNotes: readonly string[];
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

  const submit = () => {
    if (!to) return;
    startTransition(async () => {
      const result = await setWorkOrderStatus({ workOrderId, status: to, note });
      if (!result.ok) {
        const fieldError = result.fieldErrors?.note?.[0];
        if (fieldError) setError(fieldError);
        else toast({ title: "Status not changed", description: result.error, tone: "error" });
        return;
      }
      toast({ title: `${jobNumber}: ${STATUS_LABELS[to]}`, tone: "success" });
      onClose();
    });
  };

  const withReason = (target: WorkOrderStatus) => (reason: string) =>
    setWorkOrderStatus({ workOrderId, status: target, note: reason });

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
              Cancelling is final. Void the job&apos;s lines first.
            </p>
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
          </section>
        ) : null}
      </div>
    </Sheet>
  );
}
