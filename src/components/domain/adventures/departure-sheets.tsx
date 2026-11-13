"use client";

import {
  cancelDepartureAction,
  createDepartureAction,
  updateDepartureAction,
} from "@/app/(staff)/adventures/actions";
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
