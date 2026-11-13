"use client";

import { useTransition } from "react";

import {
  assignDepartureStaffAction,
  cancelDepartureAction,
  checkInRiderAction,
  createDepartureAction,
  recordObservationAction,
  removeDepartureStaffAction,
  retryFailedNoticesAction,
  setSupportedSalesAction,
  setPublicSurfacesAction,
  updateDepartureAction,
} from "@/app/(staff)/adventures/actions";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/components/ui/toast";
import { callAction } from "@/lib/call-action";
import { FormSheet, useOpen, type FormAction } from "@/components/domain/adventures/booking-sheets";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { PlusIcon } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

/**
 * Departure sheets (D193-D195): add a date, change it (at the version you
 * opened), cancel it. Times are in shop time. The RPCs check places,
 * versions and the route's offers again.
 */

const act = (a: unknown) => a as FormAction;

export type DepartureFields = {
  id: string;
  version: number;
  startsAt: string;
  expectedFinishAt: string;
  meetingPoint: string;
  capacity: number;
  note: string;
  staffNote: string;
};

function Fields({
  errors,
  values,
}: {
  errors: Record<string, string[] | undefined> | undefined;
  values?: Partial<DepartureFields>;
}) {
  return (
    <>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Starts" error={errors?.startsAt?.[0]} required>
          <Input name="startsAt" type="datetime-local" defaultValue={values?.startsAt} />
        </Field>
        <Field label="Expected finish" error={errors?.expectedFinishAt?.[0]}>
          <Input
            name="expectedFinishAt"
            type="datetime-local"
            defaultValue={values?.expectedFinishAt}
          />
        </Field>
      </div>
      <Field label="Meeting point" error={errors?.meetingPoint?.[0]} required>
        <Input
          name="meetingPoint"
          autoComplete="off"
          defaultValue={values?.meetingPoint ?? "294 River Valley"}
        />
      </Field>
      <Field label="Places" error={errors?.capacity?.[0]} required>
        <Input name="capacity" inputMode="numeric" defaultValue={String(values?.capacity ?? 12)} />
      </Field>
      <Field
        label="Note for riders"
        hint="Shown on bicii.sg with the date."
        error={errors?.note?.[0]}
      >
        <Textarea name="note" rows={2} defaultValue={values?.note} />
      </Field>
      <Field label="Staff note" hint="Only staff see this." error={errors?.staffNote?.[0]}>
        <Textarea name="staffNote" rows={2} defaultValue={values?.staffNote} />
      </Field>
    </>
  );
}

export function CreateDepartureButton({ routes }: { routes: Array<{ id: string; name: string }> }) {
  const { open, show, close } = useOpen();
  return (
    <>
      <Button icon={<PlusIcon className="size-5" />} onClick={show} disabled={routes.length === 0}>
        Add date
      </Button>
      {open ? (
        <FormSheet
          title="Add a date"
          description="A group ride: riders join with their self-supported ticket and support each other. A supported ride needs a supported offer on the route."
          submitLabel="Add date"
          pendingLabel="Adding…"
          success="Date added"
          action={act(createDepartureAction)}
          hidden={{}}
          onClose={close}
        >
          {(errors) => (
            <>
              <Field label="Route" error={errors?.adventureId?.[0]} required>
                <Select name="adventureId" defaultValue="">
                  <option value="" disabled>
                    Choose a route
                  </option>
                  {routes.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Kind" error={errors?.kind?.[0]} required>
                <Select name="kind" defaultValue="self_supported_group">
                  <option value="self_supported_group">Group ride (peer-supported)</option>
                  <option value="supported">Supported ride</option>
                </Select>
              </Field>
              <Fields errors={errors} />
            </>
          )}
        </FormSheet>
      ) : null}
    </>
  );
}

export function EditDepartureButton({ departure }: { departure: DepartureFields }) {
  const { open, show, close } = useOpen();
  return (
    <>
      <Button variant="outline" onClick={show}>
        Change
      </Button>
      {open ? (
        <FormSheet
          title="Change this date"
          description="Riders who are joining see the change; anyone looking at the old version is asked to look again."
          submitLabel="Save"
          pendingLabel="Saving…"
          success="Saved"
          action={act(updateDepartureAction)}
          hidden={{ departureId: departure.id, expectedVersion: String(departure.version) }}
          onClose={close}
        >
          {(errors) => <Fields errors={errors} values={departure} />}
        </FormSheet>
      ) : null}
    </>
  );
}

export function CancelDepartureButton({ departureId }: { departureId: string }) {
  const { open, show, close } = useOpen();
  return (
    <>
      <Button variant="outline" onClick={show}>
        Cancel date
      </Button>
      {open ? (
        <FormSheet
          title="Cancel this date?"
          description="Every rider on it is emailed. Their tickets stand: they can ride on their own or join another date."
          submitLabel="Cancel date"
          pendingLabel="Cancelling…"
          danger
          success="Date cancelled"
          action={act(cancelDepartureAction)}
          hidden={{ departureId }}
          onClose={close}
        >
          {(errors) => (
            <Field
              label="Reason"
              hint="Riders see it in their email."
              error={errors?.reason?.[0]}
              required
            >
              <Textarea name="reason" rows={2} />
            </Field>
          )}
        </FormSheet>
      ) : null}
    </>
  );
}

// -------------------------------------------- supported departures ----

export function AssignStaffButton({
  departureId,
  staff,
}: {
  departureId: string;
  staff: Array<{ id: string; name: string }>;
}) {
  const { open, show, close } = useOpen();
  return (
    <>
      <Button variant="outline" size="sm" onClick={show}>
        Add staff
      </Button>
      {open ? (
        <FormSheet
          title="Add staff to this date"
          description="Facilitators with Facilitate adventures can check riders in and record observations on dates they're on."
          submitLabel="Add"
          pendingLabel="Adding…"
          success="Added"
          action={act(assignDepartureStaffAction)}
          hidden={{ departureId }}
          onClose={close}
        >
          {(errors) => (
            <>
              <Field label="Staff member" error={errors?.staffId?.[0]} required>
                <Select name="staffId" defaultValue="">
                  <option value="" disabled>
                    Choose
                  </option>
                  {staff.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Role" error={errors?.role?.[0]} required>
                <Select name="role" defaultValue="facilitator">
                  <option value="lead">Lead</option>
                  <option value="facilitator">Facilitator</option>
                </Select>
              </Field>
            </>
          )}
        </FormSheet>
      ) : null}
    </>
  );
}

function useQuick() {
  const { toast } = useToast();
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, success: string) =>
    start(async () => {
      const result = await callAction(fn as never);
      if (result.ok) toast({ title: success, tone: "success" });
      else toast({ title: (result as { error: string }).error, tone: "error" });
    });
  return { pending, run };
}

export function RemoveStaffButton({
  departureId,
  staffId,
  name,
}: {
  departureId: string;
  staffId: string;
  name: string;
}) {
  const { pending, run } = useQuick();
  return (
    <Button
      variant="outline"
      size="sm"
      pending={pending}
      pendingLabel="Removing…"
      onClick={() =>
        run(() => removeDepartureStaffAction({ departureId, staffId }) as never, "Removed")
      }
    >
      Remove<span className="sr-only"> {name}</span>
    </Button>
  );
}

export function CheckInButton({
  departureId,
  bookingId,
  name,
}: {
  departureId: string;
  bookingId: string;
  name: string;
}) {
  const { pending, run } = useQuick();
  return (
    <Button
      size="sm"
      pending={pending}
      pendingLabel="Checking in…"
      onClick={() =>
        run(() => checkInRiderAction({ departureId, bookingId }) as never, "Checked in")
      }
    >
      Check in<span className="sr-only"> {name}</span>
    </Button>
  );
}

export function ObservationButton({
  departureId,
  riders,
}: {
  departureId: string;
  riders: Array<{ bookingId: string; name: string }>;
}) {
  const { open, show, close } = useOpen();
  return (
    <>
      <Button size="sm" onClick={show}>
        Add observation
      </Button>
      {open ? (
        <FormSheet
          title="Add an observation"
          description="Kept as written. The reviewer reads it beside the rider's evidence; it never certifies anyone."
          submitLabel="Save"
          pendingLabel="Saving…"
          success="Saved"
          action={act(recordObservationAction)}
          hidden={{ departureId }}
          onClose={close}
        >
          {(errors) => (
            <>
              <Field
                label="Rider"
                hint="Leave empty for the whole group."
                error={errors?.bookingId?.[0]}
              >
                <Select name="bookingId" defaultValue="">
                  <option value="">The whole group</option>
                  {riders.map((r) => (
                    <option key={r.bookingId} value={r.bookingId}>
                      {r.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="What" error={errors?.kind?.[0]} required>
                <Select name="kind" defaultValue="note">
                  <option value="note">Note</option>
                  <option value="deviation">Left the route</option>
                  <option value="withdrawal">Withdrew</option>
                  <option value="completion">Finished</option>
                  <option value="attendance">Attendance</option>
                </Select>
              </Field>
              <Field label="Observation" error={errors?.body?.[0]} required>
                <Textarea name="body" rows={3} />
              </Field>
            </>
          )}
        </FormSheet>
      ) : null}
    </>
  );
}

/** Admin: whether supported rides are on sale (off until insurance and staffing are confirmed). */
export function SupportedSalesControl({ enabled }: { enabled: boolean }) {
  const { open, show, close } = useOpen();
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <p className="text-sm">
        {enabled ? "Supported rides are on sale." : "Supported rides are not on sale."}
      </p>
      <Button variant="outline" size="sm" onClick={show}>
        Change<span className="sr-only"> supported ride sales</span>
      </Button>
      {open ? (
        <FormSheet
          title="Supported ride sales"
          description="Turn on only once the insurance policy, the staffing ratio, the emergency procedure and the overrun terms are confirmed. Certified ride sales must be on too."
          submitLabel="Save"
          pendingLabel="Saving…"
          success="Saved"
          action={act(setSupportedSalesAction)}
          hidden={{}}
          onClose={close}
        >
          {() => <Checkbox name="enabled" label="Sell supported rides" defaultChecked={enabled} />}
        </FormSheet>
      ) : null}
    </div>
  );
}

/** Admin: riders' live-share links and public profiles (D205, D206). */
export function PublicSurfacesControl({
  liveSharing,
  publicProfiles,
}: {
  liveSharing: boolean;
  publicProfiles: boolean;
}) {
  const { open, show, close } = useOpen();
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <p className="text-sm">
        Live-share links {liveSharing ? "on" : "off"}; public rider profiles{" "}
        {publicProfiles ? "on" : "off"}.
      </p>
      <Button variant="outline" size="sm" onClick={show}>
        Change<span className="sr-only"> rider sharing</span>
      </Button>
      {open ? (
        <FormSheet
          title="Rider sharing"
          description="Live-share links let a rider send anyone a link to their open ride's positions. Public profiles let a rider show their certificates on bicii.sg. Riders opt in themselves; turning either off hides every link or profile at once."
          submitLabel="Save"
          pendingLabel="Saving…"
          success="Saved"
          action={act(setPublicSurfacesAction)}
          hidden={{}}
          onClose={close}
        >
          {() => (
            <div className="flex flex-col gap-3">
              <Checkbox name="liveSharing" label="Live-share links" defaultChecked={liveSharing} />
              <Checkbox
                name="publicProfiles"
                label="Public rider profiles"
                defaultChecked={publicProfiles}
              />
            </div>
          )}
        </FormSheet>
      ) : null}
    </div>
  );
}

/** Admin: put failed adventure emails back in the queue (D211). */
export function RetryFailedEmailsButton({ failed }: { failed: number }) {
  const { pending, run } = useQuick();
  if (failed === 0) return null;
  return (
    <Button
      variant="outline"
      size="sm"
      pending={pending}
      pendingLabel="Retrying…"
      onClick={() => run(() => retryFailedNoticesAction({}) as never, "Emails queued again")}
    >
      Retry failed emails
    </Button>
  );
}
