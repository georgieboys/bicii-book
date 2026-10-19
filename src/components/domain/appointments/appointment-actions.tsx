"use client";

import {
  createContext,
  useContext,
  useEffect,
  useOptimistic,
  useRef,
  useState,
  useTransition,
  type ReactNode,
  type TransitionStartFunction,
} from "react";

import { cancelAppointment, markAppointmentStatus } from "@/app/(staff)/appointments/actions";
import { ReasonConfirm } from "@/components/domain/reason-confirm";
import { Button, ButtonLink } from "@/components/ui/button";
import { StatusPill } from "@/components/ui/status-pill";
import { useToast } from "@/components/ui/toast";
import { useArmed, useArmedAfter } from "@/components/ui/use-armed";
import {
  APPOINTMENT_STATUS_LABELS,
  appointmentTone,
  availableActions,
  primaryAction,
  type AppointmentStatus,
} from "@/lib/appointments/status";
import { callAction } from "@/lib/call-action";

type Marked = "confirmed" | "arrived" | "no_show";

type Scope = {
  shown: AppointmentStatus;
  setShown: (status: AppointmentStatus) => void;
  pending: boolean;
  startTransition: TransitionStartFunction;
};

const StatusScope = createContext<Scope | null>(null);

function useScope(): Scope {
  const scope = useContext(StatusScope);
  if (!scope) throw new Error("Wrap the appointment page in <AppointmentStatusScope>.");
  return scope;
}

/**
 * Holds the appointment's status for its page, so the header's pill and
 * the action bar (which sticks above the tab bar, so it sits at the page
 * level) change together the moment staff tap (useOptimistic).
 */
export function AppointmentStatusScope({
  status,
  children,
}: {
  status: AppointmentStatus;
  children: ReactNode;
}) {
  const [pending, startTransition] = useTransition();
  const [shown, setShown] = useOptimistic(status);
  return (
    <StatusScope.Provider value={{ shown, setShown, pending, startTransition }}>
      {children}
    </StatusScope.Provider>
  );
}

/** The status as staff last set it (text and tone, never colour alone). */
export function AppointmentStatusPill() {
  const { shown } = useScope();
  return (
    <StatusPill status={appointmentTone(shown)}>{APPOINTMENT_STATUS_LABELS[shown]}</StatusPill>
  );
}

/**
 * The detail page's next steps (PLAN D36, D37, D39, D40). The primary
 * button is the next step: Arrived (one tap, shown at once with
 * useOptimistic and a toast), Check in (the check-in page), or "Reinstate
 * as arrived" for a no-show on its own shop day. Then Confirm, No-show (a
 * confirmation without a reason: focus on Cancel, the confirm button
 * disabled for 400 ms) and Cancel appointment (ReasonConfirm with a
 * required reason). Completed is never offered: it follows the job (D36).
 * Buttons are disabled for 400 ms after every status change, so a double
 * tap cannot reach the button the first tap revealed. On phones the bar
 * sticks above the tab bar.
 */
export function AppointmentActionBar({
  appointmentId,
  startsAt,
  now,
}: {
  appointmentId: string;
  startsAt: string;
  /** The server's render time (ISO), so the offered actions match the page. */
  now: string;
}) {
  const { toast } = useToast();
  const { shown, setShown, pending, startTransition } = useScope();
  const [confirmingNoShow, setConfirmingNoShow] = useState(false);
  const [reasonOpen, setReasonOpen] = useState(false);
  const armed = useArmedAfter(shown);
  const actions = availableActions(shown, startsAt, new Date(now));
  const primary = primaryAction(shown, actions);

  const mark = (next: Marked, success: string, failure: string) =>
    startTransition(async () => {
      setShown(next);
      const result = await callAction(() => markAppointmentStatus({ appointmentId, status: next }));
      if (!result.ok) {
        toast({ title: failure, description: result.error, tone: "error" });
        return;
      }
      toast({ title: success, tone: "success" });
    });

  const busy = pending || !armed;
  const hasSecondary =
    (actions.confirm && !reasonOpen) ||
    (actions.checkIn && primary !== "checkIn") ||
    actions.noShow ||
    actions.cancel;

  if (!primary && !hasSecondary) return null;
  return (
    <div
      role="group"
      aria-label="Appointment actions"
      className="sticky bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-20 -mx-1 flex max-h-[60dvh] flex-col gap-3 overflow-y-auto rounded-3xl bg-paper/95 p-1 backdrop-blur md:static md:mx-0 md:max-h-none md:overflow-visible md:bg-transparent md:p-0"
    >
      <div className="flex flex-wrap items-center gap-2">
        {primary === "arrive" ? (
          <Button
            key={`arrive-${shown}`}
            size="lg"
            disabled={busy}
            onClick={() => mark("arrived", "Marked as arrived", "Not marked as arrived")}
          >
            Arrived
          </Button>
        ) : primary === "checkIn" ? (
          <ButtonLink
            key={`check-in-${shown}`}
            size="lg"
            href={`/appointments/${appointmentId}/check-in`}
            aria-disabled={busy || undefined}
            onClick={(e) => busy && e.preventDefault()}
          >
            Check in
          </ButtonLink>
        ) : primary === "reinstate" ? (
          <Button
            key={`reinstate-${shown}`}
            size="lg"
            disabled={busy}
            onClick={() => mark("arrived", "Reinstated as arrived", "Not reinstated")}
          >
            Reinstate as arrived
          </Button>
        ) : null}
        {actions.checkIn && primary !== "checkIn" ? (
          <ButtonLink variant="outline" href={`/appointments/${appointmentId}/check-in`}>
            Check in
          </ButtonLink>
        ) : null}
        {actions.confirm ? (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => mark("confirmed", "Appointment confirmed", "Not confirmed")}
          >
            Confirm
          </Button>
        ) : null}
        {actions.noShow && !confirmingNoShow ? (
          <Button variant="outline" disabled={busy} onClick={() => setConfirmingNoShow(true)}>
            No-show…
          </Button>
        ) : null}
      </div>
      {actions.noShow && confirmingNoShow ? (
        <NoShowConfirm
          pending={pending}
          onCancel={() => setConfirmingNoShow(false)}
          onConfirm={() => {
            setConfirmingNoShow(false);
            mark("no_show", "Marked as a no-show", "Not marked as a no-show");
          }}
        />
      ) : null}
      {actions.cancel ? (
        <ReasonConfirm
          startLabel="Cancel appointment…"
          question="Why is the appointment cancelled?"
          hint="Kept in the appointment's history. The customer is not told automatically."
          confirmLabel="Cancel appointment"
          pendingLabel="Cancelling…"
          failureTitle="Appointment not cancelled"
          successTitle="Appointment cancelled"
          dismissLabel="Keep appointment"
          disabled={busy}
          onConfirmingChange={setReasonOpen}
          onConfirm={(reason) => cancelAppointment({ appointmentId, reason })}
        >
          Cancelling frees its place. To move it, cancel and book the new time.
        </ReasonConfirm>
      ) : null}
    </div>
  );
}

/**
 * "Mark as a no-show?" in place: focus on Cancel, the confirm button
 * disabled for CONFIRM_GUARD_MS (DESIGN.md "Forms": a confirmation
 * without a reason).
 */
function NoShowConfirm({
  pending,
  onCancel,
  onConfirm,
}: {
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const armed = useArmed(true);
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);
  return (
    <div key="no-show" className="flex flex-col gap-3 rounded-xl bg-danger-soft p-4">
      <p className="font-medium text-danger-deep">
        Mark as a no-show? If they turn up later today, you can still reinstate them as arrived.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button key="cancel" ref={cancelRef} variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          key="confirm-no-show"
          variant="danger"
          disabled={!armed}
          pending={pending}
          pendingLabel="Saving…"
          onClick={onConfirm}
        >
          Mark no-show
        </Button>
      </div>
    </div>
  );
}
