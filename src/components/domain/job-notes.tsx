"use client";

import { useActionState, useId, useOptimistic, useState, useTransition } from "react";

import {
  addWorkOrderNote,
  setApprovalFlag,
  updateWorkOrderDetails,
} from "@/app/(staff)/jobs/actions";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { PlusIcon } from "@/components/ui/icons";
import { Sheet } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { useFocusFirstInvalid } from "@/components/ui/use-focus-invalid";
import type { ActionResult } from "@/lib/actions";
import { newId } from "@/lib/uuid";
import { callAction } from "@/lib/call-action";

/**
 * "Customer approved extra work" (SPEC §7.1: approval happens offline; this
 * is the optional internal flag and note). The switch applies at once
 * (useOptimistic, then a toast) and sends no note, so the stored one is
 * kept; the note is saved only with its own button. The draft follows the
 * stored note whenever the page brings a newer one. Hidden on collected or
 * cancelled jobs.
 */
export function ApprovalSwitch({
  workOrderId,
  flagged,
  note,
}: {
  workOrderId: string;
  flagged: boolean;
  note: string | null;
}) {
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [optimistic, setOptimistic] = useOptimistic(flagged);
  const [draft, setDraft] = useState(note ?? "");
  const [shownNote, setShownNote] = useState(note);
  if (note !== shownNote) {
    // Someone saved a note (this user or a colleague): show it.
    setShownNote(note);
    setDraft(note ?? "");
  }
  const [noteError, setNoteError] = useState<string | undefined>();
  const noteChanged = draft.trim() !== (note ?? "");

  /** `nextNote` null keeps the stored note; "" clears it. */
  const save = (next: boolean, nextNote: string | null) =>
    startTransition(async () => {
      setOptimistic(next);
      const result = await callAction(() =>
        setApprovalFlag({ workOrderId, flagged: next, note: nextNote }),
      );
      if (!result.ok) {
        const fieldError = result.fieldErrors?.note?.[0];
        if (fieldError) setNoteError(fieldError);
        toast({ title: "Approval not saved", description: result.error, tone: "error" });
        return;
      }
      setNoteError(undefined);
      toast({
        title:
          next !== flagged
            ? next
              ? "Marked as approved by the customer"
              : "Approval removed"
            : "Approval note saved",
        tone: "success",
      });
    });

  return (
    <div className="flex flex-col gap-2">
      <Switch
        label="Customer approved extra work"
        description="Agreed offline (phone, in person). Staff only."
        checked={optimistic}
        disabled={pending}
        onCheckedChange={(next) => save(next, null)}
      />
      <Field label="Approval note" hint="Optional: what was agreed, with whom." error={noteError}>
        <Textarea
          rows={2}
          maxLength={500}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setNoteError(undefined);
          }}
        />
      </Field>
      {noteChanged ? (
        <div>
          <Button
            variant="outline"
            size="sm"
            pending={pending}
            pendingLabel="Saving…"
            onClick={() => save(optimistic, draft)}
          >
            Save note
          </Button>
        </div>
      ) : null}
    </div>
  );
}

type NoteKind = "note" | "diagnosis";
type NoteState = ActionResult<{ id: number }> | null;

const NOTE_COPY: Record<NoteKind, { button: string; title: string; label: string; done: string }> =
  {
    note: { button: "Add note", title: "Add note", label: "Note", done: "Note added" },
    diagnosis: {
      button: "Add diagnosis",
      title: "Add diagnosis",
      label: "Diagnosis",
      done: "Diagnosis added",
    },
  };

/** "Add note" and "Add diagnosis": each goes into the timeline, in any status. */
export function NoteButtons({ workOrderId }: { workOrderId: string }) {
  const [open, setOpen] = useState<NoteKind | null>(null);
  return (
    <div className="flex flex-wrap gap-2">
      {(["note", "diagnosis"] as const).map((kind) => (
        <Button
          key={kind}
          variant="outline"
          size="sm"
          icon={<PlusIcon className="size-4" />}
          onClick={() => setOpen(kind)}
        >
          {NOTE_COPY[kind].button}
        </Button>
      ))}
      {open ? (
        <NoteSheet workOrderId={workOrderId} kind={open} onClose={() => setOpen(null)} />
      ) : null}
    </div>
  );
}

function NoteSheet({
  workOrderId,
  kind,
  onClose,
}: {
  workOrderId: string;
  kind: NoteKind;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const formId = useId();
  // The idempotency key: a retry after a lost response finds the note.
  const [noteId] = useState(newId);
  const copy = NOTE_COPY[kind];
  const [state, formAction, pending] = useActionState<NoteState, FormData>(
    async (prev, formData) => {
      const result = await callAction(() => addWorkOrderNote(prev, formData), formData);
      if (result.ok) {
        toast({ title: copy.done, tone: "success" });
        onClose();
      }
      return result;
    },
    null,
  );
  const formRef = useFocusFirstInvalid(state);
  const failed = state && !state.ok ? state : null;

  return (
    <Sheet
      open
      onOpenChange={(next) => (next ? null : onClose())}
      dismissible={!pending}
      title={copy.title}
      description="Staff only. It goes into the job's timeline and can't be edited later."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} pending={pending} pendingLabel="Adding…">
            {copy.button}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        ref={formRef}
        action={formAction}
        className="flex flex-col gap-4"
        noValidate
      >
        <input type="hidden" name="noteId" value={noteId} />
        <input type="hidden" name="workOrderId" value={workOrderId} />
        <input type="hidden" name="kind" value={kind} />
        {failed ? (
          <p role="alert" className="text-sm font-medium text-danger-deep">
            {failed.error}
          </p>
        ) : null}
        <Field label={copy.label} error={failed?.fieldErrors?.body?.[0]} required>
          <Textarea
            name="body"
            rows={6}
            maxLength={5000}
            defaultValue={failed?.values?.body ?? ""}
          />
        </Field>
      </form>
    </Sheet>
  );
}

export type JobDetails = {
  requestedWork: string;
  intakeNotes: string | null;
  internalNotes: string | null;
  completionNotes: string | null;
};

type DetailsState = ActionResult<null> | null;

const DETAIL_FIELDS = ["requestedWork", "intakeNotes", "internalNotes", "completionNotes"] as const;

/** "Edit" on the requested work: the work wanted, condition on arrival and the two notes. */
export function EditDetailsButton({
  workOrderId,
  details,
}: {
  workOrderId: string;
  details: JobDetails;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Edit
      </Button>
      {open ? (
        <DetailsSheet workOrderId={workOrderId} details={details} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}

function DetailsSheet({
  workOrderId,
  details,
  onClose,
}: {
  workOrderId: string;
  details: JobDetails;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const formId = useId();
  const [state, formAction, pending] = useActionState<DetailsState, FormData>(
    async (prev, formData) => {
      // Only what this user changed since the sheet opened: an unchanged
      // field is left out (the RPC keeps it), so a colleague's newer text
      // there is not overwritten with this page's older copy.
      for (const field of DETAIL_FIELDS) {
        const typed = String(formData.get(field) ?? "").trim();
        if (typed === (details[field] ?? "").trim()) formData.delete(field);
      }
      const result = await callAction(() => updateWorkOrderDetails(prev, formData), formData);
      if (result.ok) {
        toast({ title: "Job details saved", tone: "success" });
        onClose();
      }
      return result;
    },
    null,
  );
  const formRef = useFocusFirstInvalid(state);
  const failed = state && !state.ok ? state : null;
  const errors = failed?.fieldErrors;
  // A failed submit shows what was typed, not the saved values (DESIGN.md "Forms").
  const value = (field: keyof JobDetails) => failed?.values?.[field] ?? details[field] ?? "";

  return (
    <Sheet
      open
      onOpenChange={(next) => (next ? null : onClose())}
      dismissible={!pending}
      title="Edit job details"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} pending={pending} pendingLabel="Saving…">
            Save
          </Button>
        </>
      }
    >
      <form
        id={formId}
        ref={formRef}
        action={formAction}
        className="flex flex-col gap-5"
        noValidate
      >
        <input type="hidden" name="workOrderId" value={workOrderId} />
        {failed ? (
          <p role="alert" className="text-sm font-medium text-danger-deep">
            {failed.error}
          </p>
        ) : null}
        <Field label="Requested work" error={errors?.requestedWork?.[0]} required>
          <Textarea
            name="requestedWork"
            rows={3}
            maxLength={2000}
            defaultValue={value("requestedWork")}
          />
        </Field>
        <Field label="Condition on arrival" error={errors?.intakeNotes?.[0]}>
          <Textarea
            name="intakeNotes"
            rows={3}
            maxLength={5000}
            defaultValue={value("intakeNotes")}
          />
        </Field>
        <Field
          label="Internal notes"
          hint="Staff only; never shown to the customer."
          error={errors?.internalNotes?.[0]}
        >
          <Textarea
            name="internalNotes"
            rows={3}
            maxLength={10000}
            defaultValue={value("internalNotes")}
          />
        </Field>
        <Field label="Completion notes" error={errors?.completionNotes?.[0]}>
          <Textarea
            name="completionNotes"
            rows={3}
            maxLength={5000}
            defaultValue={value("completionNotes")}
          />
        </Field>
      </form>
    </Sheet>
  );
}
