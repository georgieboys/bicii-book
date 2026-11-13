"use client";

import { useActionState, useId, useState, useTransition, type ReactNode } from "react";

import {
  cancelAdventureBookingAction,
  claimAdventureReviewAction,
  moveSeatAction,
  clearAdventureAttentionAction,
  revokeAdventureCertificateAction,
  setAdventurePackStatusAction,
  setAdventureSalesAction,
} from "@/app/(staff)/adventures/actions";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Sheet } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { useFocusFirstInvalid } from "@/components/ui/use-focus-invalid";
import type { ActionResult } from "@/lib/actions";
import { PACK_STATUS_LABELS, type AdventurePackStatus } from "@/lib/adventures";
import { callAction } from "@/lib/call-action";

/**
 * The small changes on the bookings, review and pack screens (D178-D182):
 * each a sheet over one Server Action. The RPCs check the permission and
 * the rules again.
 */

type State = ActionResult<unknown> | null;
export type FormAction = (prev: State, formData: FormData) => Promise<ActionResult<unknown>>;

function FormError({ state }: { state: State }) {
  return state && !state.ok ? (
    <p role="alert" className="text-sm font-medium text-danger-deep">
      {state.error}
    </p>
  ) : null;
}

/** A sheet with one form: hidden ids, a few fields, a submit button. */
export function FormSheet({
  title,
  description,
  submitLabel,
  pendingLabel,
  danger,
  success,
  action,
  hidden,
  onClose,
  children,
}: {
  title: string;
  description?: string;
  submitLabel: string;
  pendingLabel: string;
  danger?: boolean;
  success: string;
  action: FormAction;
  hidden: Record<string, string>;
  onClose: () => void;
  children: (errors: Record<string, string[] | undefined> | undefined) => ReactNode;
}) {
  const { toast } = useToast();
  const formId = useId();
  const [state, formAction, pending] = useActionState<State, FormData>(async (prev, formData) => {
    const result = await callAction(() => action(prev, formData), formData);
    if (result.ok) {
      toast({ title: success, tone: "success" });
      onClose();
    }
    return result;
  }, null);
  const formRef = useFocusFirstInvalid(state);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  return (
    <Sheet
      open
      onOpenChange={(next) => (next ? null : onClose())}
      dismissible={!pending}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={formId}
            variant={danger ? "danger" : undefined}
            pending={pending}
            pendingLabel={pendingLabel}
          >
            {submitLabel}
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
        {Object.entries(hidden).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        <FormError state={state} />
        {children(errors)}
      </form>
    </Sheet>
  );
}

export function useOpen() {
  const [open, setOpen] = useState(false);
  return { open, show: () => setOpen(true), close: () => setOpen(false) };
}

/** Admin: clear a booking's payment flag with a note (D181). */
export function ClearAttentionButton({ bookingId }: { bookingId: string }) {
  const { open, show, close } = useOpen();
  return (
    <>
      <Button variant="outline" size="sm" onClick={show}>
        Clear the flag
      </Button>
      {open ? (
        <FormSheet
          title="Clear the payment flag?"
          description="Do this once the problem is handled in Stripe. Your note stays in the booking's history."
          submitLabel="Clear the flag"
          pendingLabel="Clearing…"
          success="Flag cleared"
          action={clearAdventureAttentionAction as unknown as FormAction}
          hidden={{ bookingId }}
          onClose={close}
        >
          {(errors) => (
            <Field label="How it was handled" error={errors?.note?.[0]} required>
              <Textarea name="note" rows={3} />
            </Field>
          )}
        </FormSheet>
      ) : null}
    </>
  );
}

/** Admin: revoke a certificate with a reason (D179). */
export function RevokeCertificateButton({ certificateId }: { certificateId: string }) {
  const { open, show, close } = useOpen();
  return (
    <>
      <Button variant="outline" size="sm" onClick={show}>
        Revoke
      </Button>
      {open ? (
        <FormSheet
          title="Revoke this certificate?"
          description="It comes off the finisher board. The certificate, its review and the pack stay in the history. This cannot be undone."
          submitLabel="Revoke"
          pendingLabel="Revoking…"
          danger
          success="Certificate revoked"
          action={revokeAdventureCertificateAction as unknown as FormAction}
          hidden={{ certificateId }}
          onClose={close}
        >
          {(errors) => (
            <Field label="Reason" error={errors?.reason?.[0]} required>
              <Textarea name="reason" rows={3} />
            </Field>
          )}
        </FormSheet>
      ) : null}
    </>
  );
}

const NEXT_PACK: Record<AdventurePackStatus, AdventurePackStatus[]> = {
  awaiting_pack: ["ready", "on_hold"],
  ready: ["fulfilled", "on_hold"],
  on_hold: ["awaiting_pack", "ready"],
  fulfilled: [],
};

const PACK_ACTION: Record<AdventurePackStatus, string> = {
  awaiting_pack: "Back to packing",
  ready: "Packed, ready to collect",
  fulfilled: "Collected",
  on_hold: "Put on hold",
};

/** manage_adventures: move a finisher pack along (D179). */
export function PackStatusButtons({
  fulfilmentId,
  status,
}: {
  fulfilmentId: string;
  status: AdventurePackStatus;
}) {
  const [target, setTarget] = useState<AdventurePackStatus | null>(null);
  const next = NEXT_PACK[status];
  if (next.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-2">
      {next.map((s) => (
        <Button
          key={s}
          size="sm"
          variant={s === "on_hold" || s === "awaiting_pack" ? "outline" : undefined}
          onClick={() => setTarget(s)}
        >
          {PACK_ACTION[s]}
        </Button>
      ))}
      {target ? (
        <FormSheet
          title={PACK_ACTION[target]}
          description={`The pack will show as “${PACK_STATUS_LABELS[target]}”.`}
          submitLabel="Save"
          pendingLabel="Saving…"
          success={PACK_STATUS_LABELS[target]}
          action={setAdventurePackStatusAction as unknown as FormAction}
          hidden={{ fulfilmentId, status: target }}
          onClose={() => setTarget(null)}
        >
          {(errors) => (
            <Field
              label="Note"
              hint={target === "on_hold" ? "Say why it is on hold." : "Optional."}
              error={errors?.note?.[0]}
            >
              <Textarea name="note" rows={2} />
            </Field>
          )}
        </FormSheet>
      ) : null}
    </span>
  );
}

/** verify_adventures: take a waiting version for review (D178). */
export function ClaimReviewButton({ submissionId }: { submissionId: string }) {
  const { toast } = useToast();
  const [pending, start] = useTransition();
  return (
    <Button
      pending={pending}
      pendingLabel="Starting…"
      onClick={() =>
        start(async () => {
          const result = await callAction(() => claimAdventureReviewAction({ submissionId }));
          if (!result.ok) toast({ title: result.error, tone: "error" });
        })
      }
    >
      Start review
    </Button>
  );
}

/** Admin: switch certified ride sales on or off, with the terms version (D170). */
export function AdventureSalesControl({
  salesEnabled,
  termsVersion,
}: {
  salesEnabled: boolean;
  termsVersion: string;
}) {
  const { open, show, close } = useOpen();
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <p className="text-sm">
        {salesEnabled
          ? `On sale. Riders accept terms version ${termsVersion}.`
          : "Not on sale. Riders cannot buy a certified ride."}
      </p>
      <Button variant="outline" size="sm" onClick={show}>
        Change<span className="sr-only"> certified ride sales</span>
      </Button>
      {open ? (
        <FormSheet
          title="Certified ride sales"
          description="When on, riders can buy a self-supported certification on bicii.sg. Publish the terms (cancellation, refunds, retries) first and give their version."
          submitLabel="Save"
          pendingLabel="Saving…"
          success="Saved"
          action={setAdventureSalesAction as unknown as FormAction}
          hidden={{}}
          onClose={close}
        >
          {(errors) => (
            <>
              <Checkbox
                name="salesEnabled"
                label="Sell certified rides"
                defaultChecked={salesEnabled}
              />
              <Field
                label="Terms version"
                hint="The version of the published terms, like 2026-12. Every booking keeps the version its rider accepted."
                error={errors?.termsVersion?.[0]}
              >
                <Input name="termsVersion" autoComplete="off" defaultValue={termsVersion} />
              </Field>
            </>
          )}
        </FormSheet>
      ) : null}
    </div>
  );
}

/** Admin: cancel a booking with a reason (D201). Refunds stay in Stripe. */
export function CancelBookingButton({ bookingId }: { bookingId: string }) {
  const { open, show, close } = useOpen();
  return (
    <>
      <Button variant="outline" size="sm" onClick={show}>
        Cancel booking
      </Button>
      {open ? (
        <FormSheet
          title="Cancel this booking?"
          description="Its date and tracker hire are released and the rider is emailed with your reason. Refund the payment in Stripe yourself. This cannot be undone."
          submitLabel="Cancel booking"
          pendingLabel="Cancelling…"
          danger
          success="Booking cancelled"
          action={cancelAdventureBookingAction as unknown as FormAction}
          hidden={{ bookingId }}
          onClose={close}
        >
          {(errors) => (
            <Field label="Reason" hint="The rider sees it." error={errors?.reason?.[0]} required>
              <Textarea name="reason" rows={3} />
            </Field>
          )}
        </FormSheet>
      ) : null}
    </>
  );
}

/** manage_adventures: move the rider to another date of the same route and kind (D202). */
export function MoveSeatButton({
  bookingId,
  dates,
}: {
  bookingId: string;
  dates: Array<{ id: string; label: string }>;
}) {
  const { open, show, close } = useOpen();
  return (
    <>
      <Button variant="outline" size="sm" onClick={show} disabled={dates.length === 0}>
        Move to another date
      </Button>
      {open ? (
        <FormSheet
          title="Move to another date"
          submitLabel="Move"
          pendingLabel="Moving…"
          success="Moved"
          action={moveSeatAction as unknown as FormAction}
          hidden={{ bookingId }}
          onClose={close}
        >
          {(errors) => (
            <>
              <Field label="Date" error={errors?.departureId?.[0]} required>
                <Select name="departureId" defaultValue="">
                  <option value="" disabled>
                    Choose a date
                  </option>
                  {dates.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Reason" error={errors?.reason?.[0]} required>
                <Textarea name="reason" rows={2} />
              </Field>
            </>
          )}
        </FormSheet>
      ) : null}
    </>
  );
}
