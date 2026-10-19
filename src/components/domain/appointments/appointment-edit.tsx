"use client";

import { useEffect, useId, useState, useTransition } from "react";

import { updateAppointment } from "@/app/(staff)/appointments/actions";
import { listIntakeBikes } from "@/app/(staff)/jobs/actions";
import { ShortId } from "@/components/domain/short-id";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Sheet } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { useFocusFirstInvalid } from "@/components/ui/use-focus-invalid";
import type { ActionResult } from "@/lib/actions";
import { cn } from "@/lib/cn";
import type { IntakeBike } from "@/lib/domain/workshop";
import { callAction } from "@/lib/call-action";

/**
 * "Edit" on an appointment's notes: the customer's note (while the
 * appointment is not over) and the internal note. Only what changed since
 * the sheet opened is sent (a colleague's newer text elsewhere is kept); an
 * emptied note is cleared.
 */
export function EditNotesButton({
  appointmentId,
  customerNote,
  internalNote,
  customerNoteEditable,
}: {
  appointmentId: string;
  customerNote: string | null;
  internalNote: string | null;
  customerNoteEditable: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        Edit
      </Button>
      {open ? (
        <NotesSheet
          appointmentId={appointmentId}
          customerNote={customerNote}
          internalNote={internalNote}
          customerNoteEditable={customerNoteEditable}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function NotesSheet({
  appointmentId,
  customerNote,
  internalNote,
  customerNoteEditable,
  onClose,
}: {
  appointmentId: string;
  customerNote: string | null;
  internalNote: string | null;
  customerNoteEditable: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const formId = useId();
  const [customer, setCustomer] = useState(customerNote ?? "");
  const [internal, setInternal] = useState(internalNote ?? "");
  const [state, setState] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const formRef = useFocusFirstInvalid(state);
  const errors = state && !state.ok ? state.fieldErrors : undefined;

  const save = () =>
    startTransition(async () => {
      const changedCustomer = customerNoteEditable && customer.trim() !== (customerNote ?? "");
      const changedInternal = internal.trim() !== (internalNote ?? "");
      if (!changedCustomer && !changedInternal) {
        onClose();
        return;
      }
      const result = await callAction(() =>
        updateAppointment({
          appointmentId,
          ...(changedCustomer ? { customerNote: customer } : {}),
          ...(changedInternal ? { internalNote: internal } : {}),
        }),
      );
      setState(result);
      if (result.ok) {
        toast({ title: "Notes saved", tone: "success" });
        onClose();
      }
    });

  return (
    <Sheet
      open
      onOpenChange={(o) => !o && onClose()}
      dismissible={!pending}
      title="Edit notes"
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
        noValidate
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        {state && !state.ok ? (
          <p role="alert" className="text-sm font-medium text-danger-deep">
            {state.error}
          </p>
        ) : null}
        <Field
          label="Customer's note"
          hint={
            customerNoteEditable
              ? "The customer can see it."
              : "Kept as it was once the appointment is over."
          }
          error={errors?.customerNote?.[0]}
        >
          <Textarea
            rows={3}
            maxLength={1000}
            value={customer}
            disabled={!customerNoteEditable}
            onChange={(e) => setCustomer(e.target.value)}
          />
        </Field>
        <Field
          label="Internal note"
          hint="Staff only. Never shown to the customer."
          error={errors?.internalNote?.[0]}
        >
          <Textarea
            rows={4}
            maxLength={5000}
            value={internal}
            onChange={(e) => setInternal(e.target.value)}
          />
        </Field>
      </form>
    </Sheet>
  );
}

type BikesState = { bikes: IntakeBike[] } | { error: string } | null;

/**
 * "Change" on the appointment's bike, before check-in: one of the
 * customer's active bikes, or "No bike yet" (decide at check-in).
 */
export function ChangeBikeButton({
  appointmentId,
  customerId,
  bikeId,
}: {
  appointmentId: string;
  customerId: string;
  bikeId: string | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        Change
      </Button>
      {open ? (
        <BikeSheet
          appointmentId={appointmentId}
          customerId={customerId}
          bikeId={bikeId}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function BikeSheet({
  appointmentId,
  customerId,
  bikeId,
  onClose,
}: {
  appointmentId: string;
  customerId: string;
  bikeId: string | null;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const formId = useId();
  const [chosen, setChosen] = useState(bikeId ?? "");
  const [bikes, setBikes] = useState<BikesState>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let live = true;
    listIntakeBikes({ customerId }).then(
      (r) => live && setBikes(r.ok ? { bikes: r.data } : { error: r.error }),
      () => live && setBikes({ error: "Couldn't load the bikes." }),
    );
    return () => {
      live = false;
    };
  }, [customerId]);

  const save = () =>
    startTransition(async () => {
      if (chosen === (bikeId ?? "")) {
        onClose();
        return;
      }
      const result = await callAction(() =>
        updateAppointment(
          chosen ? { appointmentId, bikeId: chosen } : { appointmentId, clearBike: true },
        ),
      );
      if (!result.ok) {
        setError(result.fieldErrors?.bikeId?.[0] ?? result.error);
        return;
      }
      toast({ title: chosen ? "Bike changed" : "Bike removed", tone: "success" });
      onClose();
    });

  const options =
    bikes && "bikes" in bikes
      ? [
          { id: "", title: "No bike yet", detail: "Decide at check-in." },
          ...bikes.bikes.map((b) => ({ id: b.id, title: b.title, shortId: b.shortId })),
        ]
      : [];

  return (
    <Sheet
      open
      onOpenChange={(o) => !o && onClose()}
      dismissible={!pending}
      title="Change bike"
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
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        {error ? (
          <p role="alert" className="text-sm font-medium text-danger-deep">
            {error}
          </p>
        ) : null}
        {bikes === null ? (
          <p role="status" className="flex items-center gap-2 text-sm text-dust-500">
            <Spinner className="size-4" /> Loading bikes…
          </p>
        ) : "error" in bikes ? (
          <p role="alert" className="text-sm text-danger-deep">
            {bikes.error}
          </p>
        ) : (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 font-display text-xs font-bold tracking-wide uppercase">
              The customer&apos;s bikes
            </legend>
            {options.map((o) => (
              <label
                key={o.id || "none"}
                className={cn(
                  "relative flex min-h-16 cursor-pointer flex-col justify-center gap-1 rounded-2xl border-2 px-4 py-3 has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-indigo",
                  chosen === o.id ? "border-ink bg-dust-100" : "border-hairline bg-card",
                )}
              >
                <input
                  type="radio"
                  name="bikeId"
                  value={o.id}
                  checked={chosen === o.id}
                  onChange={() => setChosen(o.id)}
                  className="sr-only"
                />
                <span className="font-semibold">{o.title}</span>
                {"shortId" in o && o.shortId ? (
                  <ShortId value={o.shortId} className="self-start" />
                ) : "detail" in o ? (
                  <span className="text-sm text-dust-500">{o.detail}</span>
                ) : null}
              </label>
            ))}
            {bikes.bikes.length === 0 ? (
              <p className="text-sm text-dust-500">
                No bikes yet. Add one from the customer&apos;s page or at check-in.
              </p>
            ) : null}
          </fieldset>
        )}
      </form>
    </Sheet>
  );
}
