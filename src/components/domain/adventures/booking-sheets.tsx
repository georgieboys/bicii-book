"use client";

import { useActionState, useEffect, useId, useState, useTransition, type ReactNode } from "react";

import {
  cancelAdventureBookingAction,
  claimAdventureReviewAction,
  moveSeatAction,
  clearAdventureAttentionAction,
  hideBoardNameAction,
  publishWaiverAction,
  revokeAdventureCertificateAction,
  settleLateFeeAction,
  unlockBoardNameAction,
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
  // React resets uncontrolled fields after every form action; after a
  // refusal, put back what was typed (audit A-53; DESIGN.md "Forms").
  const echoed = state && !state.ok ? state.values : undefined;
  useEffect(() => {
    const form = formRef.current;
    if (!form || !echoed) return;
    for (const [name, value] of Object.entries(echoed)) {
      const field = form.elements.namedItem(name);
      if (
        field instanceof HTMLTextAreaElement ||
        field instanceof HTMLSelectElement ||
        (field instanceof HTMLInputElement &&
          !["checkbox", "radio", "hidden", "file"].includes(field.type))
      ) {
        field.value = value;
      }
    }
  }, [echoed, formRef]);
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

/** Admin: switch certified ride sales on or off, with the waiver riders sign (D170, D215). */
export function AdventureSalesControl({
  salesEnabled,
  termsVersion,
  waiverVersions,
}: {
  salesEnabled: boolean;
  termsVersion: string;
  waiverVersions: string[];
}) {
  const { open, show, close } = useOpen();
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <p className="text-sm">
        {salesEnabled
          ? `On sale. Riders sign waiver version ${termsVersion}.`
          : "Not on sale. Riders cannot buy a certified ride."}
      </p>
      <Button variant="outline" size="sm" onClick={show}>
        Change<span className="sr-only"> certified ride sales</span>
      </Button>
      {open ? (
        <FormSheet
          title="Certified ride sales"
          description="When on, riders can buy a certified ride on bicii.sg. Each rider signs the waiver you choose before paying."
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
                label="Waiver riders sign"
                hint="A published waiver version. Every booking keeps the version its rider signed."
                error={errors?.termsVersion?.[0]}
              >
                <Select name="termsVersion" defaultValue={termsVersion || waiverVersions[0] || ""}>
                  {waiverVersions.length === 0 ? (
                    <option value="">No waiver published</option>
                  ) : null}
                  {waiverVersions.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </Select>
              </Field>
            </>
          )}
        </FormSheet>
      ) : null}
    </div>
  );
}

/** Admin: publish a new waiver version (D215). Published text never changes. */
export function PublishWaiverButton() {
  const { open, show, close } = useOpen();
  return (
    <>
      <Button variant="outline" size="sm" onClick={show}>
        Publish a new version
      </Button>
      {open ? (
        <FormSheet
          title="Publish a waiver version"
          description="Once published, this text can never be edited. Riders sign it only after you choose it for sales."
          submitLabel="Publish"
          pendingLabel="Publishing…"
          success="Waiver published"
          action={publishWaiverAction as unknown as FormAction}
          hidden={{}}
          onClose={close}
        >
          {(errors) => (
            <>
              <Field label="Version" hint="Like 2026-12." error={errors?.version?.[0]}>
                <Input name="version" autoComplete="off" />
              </Field>
              <Field label="Title" error={errors?.title?.[0]}>
                <Input name="title" defaultValue="BICII rider terms, release and waiver" />
              </Field>
              <Field label="Full text" error={errors?.body?.[0]}>
                <Textarea name="body" rows={14} />
              </Field>
            </>
          )}
        </FormSheet>
      ) : null}
    </>
  );
}

/** manage_adventures: take a rider's chosen name off the finisher board (D218). */
export function HideBoardNameButton({ bookingId }: { bookingId: string }) {
  const { open, show, close } = useOpen();
  return (
    <>
      <Button variant="outline" size="sm" onClick={show}>
        Take off the board
      </Button>
      {open ? (
        <FormSheet
          title="Take this name off the board?"
          description="The rider is shown nowhere on the board. They can choose another name from their ride page."
          submitLabel="Take it off"
          pendingLabel="Saving…"
          danger
          success="Name taken off the board"
          action={hideBoardNameAction as unknown as FormAction}
          hidden={{ bookingId }}
          onClose={close}
        >
          {(errors) => (
            <Field label="Reason" error={errors?.reason?.[0]}>
              <Textarea name="reason" rows={3} />
            </Field>
          )}
        </FormSheet>
      ) : null}
    </>
  );
}

/** Admin: settle a tracker late fee, paid at the shop or waived (D213). */
export function SettleLateFeeButton({ feeId, amount }: { feeId: string; amount: string }) {
  const { open, show, close } = useOpen();
  return (
    <>
      <Button variant="outline" size="sm" onClick={show}>
        Settle<span className="sr-only"> the {amount} late fee</span>
      </Button>
      {open ? (
        <FormSheet
          title={`Settle the ${amount} late fee`}
          description="Record that the rider paid it at the shop, or waive it with a reason."
          submitLabel="Save"
          pendingLabel="Saving…"
          success="Late fee settled"
          action={settleLateFeeAction as unknown as FormAction}
          hidden={{ feeId }}
          onClose={close}
        >
          {(errors) => (
            <>
              <Field label="Outcome" error={errors?.outcome?.[0]}>
                <Select name="outcome" defaultValue="paid">
                  <option value="paid">Paid at the shop</option>
                  <option value="waived">Waived</option>
                </Select>
              </Field>
              <Field
                label="Note"
                hint="How it was paid, or why it is waived."
                error={errors?.note?.[0]}
              >
                <Textarea name="note" rows={3} />
              </Field>
            </>
          )}
        </FormSheet>
      ) : null}
    </>
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

/** Admin: let a rider whose board name was taken down choose another (D229). */
export function UnlockBoardNameButton({ bookingId }: { bookingId: string }) {
  const { toast } = useToast();
  const [pending, start] = useTransition();
  return (
    <Button
      variant="outline"
      size="sm"
      pending={pending}
      pendingLabel="Unlocking…"
      onClick={() =>
        start(async () => {
          const result = await callAction(() => unlockBoardNameAction({ bookingId }));
          toast(
            result.ok
              ? { title: "The rider can choose a board name again", tone: "success" }
              : { title: result.error, tone: "error" },
          );
        })
      }
    >
      Let them choose again
    </Button>
  );
}
