"use client";

import { useId, useState, useTransition } from "react";

import { saveAppointmentType } from "@/app/(staff)/settings/appointment-types/actions";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { PlusIcon } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Sheet } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { useFocusFirstInvalid } from "@/components/ui/use-focus-invalid";
import type { ActionResult } from "@/lib/actions";
import { newId } from "@/lib/uuid";
import { callAction } from "@/lib/call-action";

export type EditableAppointmentType = {
  id: string;
  name: string;
  description: string | null;
  durationMinutes: number;
  capacityUnits: number;
  public: boolean;
  active: boolean;
  sortOrder: number;
};

/** "New type" (admin): a new id each time the sheet opens (the idempotency key, isNew). */
export function NewAppointmentTypeButton({ shopCapacity }: { shopCapacity: number }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button icon={<PlusIcon className="size-5" />} onClick={() => setOpen(true)}>
        New type
      </Button>
      {open ? (
        <AppointmentTypeSheet
          type={null}
          shopCapacity={shopCapacity}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

/** "Edit" on one type (admin; isNew false). */
export function EditAppointmentTypeButton({
  type,
  shopCapacity,
}: {
  type: EditableAppointmentType;
  shopCapacity: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        aria-label={`Edit ${type.name}`}
        onClick={() => setOpen(true)}
      >
        Edit
      </Button>
      {open ? (
        <AppointmentTypeSheet
          type={type}
          shopCapacity={shopCapacity}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

/**
 * An appointment type (PLAN D2, D37, D38): name, description, duration
 * (steps of 5), the capacity units it takes in each slot it overlaps (at
 * most the shop's capacity), whether customers can book it online, whether
 * it is active, and its sort order. Types are never deleted; changing one
 * never alters appointments already booked.
 */
function AppointmentTypeSheet({
  type,
  shopCapacity,
  onClose,
}: {
  type: EditableAppointmentType | null;
  shopCapacity: number;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const formId = useId();
  const [id] = useState(() => type?.id ?? newId());
  const [name, setName] = useState(type?.name ?? "");
  const [description, setDescription] = useState(type?.description ?? "");
  const [duration, setDuration] = useState(String(type?.durationMinutes ?? 30));
  const [units, setUnits] = useState(String(type?.capacityUnits ?? 1));
  const [isPublic, setPublic] = useState(type?.public ?? false);
  const [active, setActive] = useState(type?.active ?? true);
  const [sortOrder, setSortOrder] = useState(String(type?.sortOrder ?? 100));
  const [state, setState] = useState<ActionResult<unknown> | null>(null);
  const [pending, start] = useTransition();
  const formRef = useFocusFirstInvalid(state);
  const errors = state && !state.ok ? state.fieldErrors : undefined;

  const submit = () =>
    start(async () => {
      const result = await callAction(() =>
        saveAppointmentType({
          id,
          isNew: type === null,
          name,
          description,
          durationMinutes: duration,
          capacityUnits: units,
          public: isPublic,
          active,
          sortOrder,
        }),
      );
      setState(result);
      if (!result.ok) return;
      toast({
        title: type ? `${name.trim()} saved` : `${name.trim()} added`,
        tone: "success",
      });
      onClose();
    });

  return (
    <Sheet
      open
      onOpenChange={(next) => (next ? null : onClose())}
      dismissible={!pending}
      title={type ? `Edit ${type.name}` : "New appointment type"}
      description="Appointments already booked keep their length and units."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} pending={pending} pendingLabel="Saving…">
            {type ? "Save" : "Add type"}
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
          if (!pending) submit();
        }}
      >
        {state && !state.ok ? (
          <p role="alert" className="text-sm font-medium text-danger-deep">
            {state.error}
          </p>
        ) : null}
        <Field label="Name" error={errors?.name?.[0]} required>
          <Input
            autoComplete="off"
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field
          label="Description"
          hint="Customers see it when the type is public."
          error={errors?.description?.[0]}
        >
          <Textarea
            rows={2}
            maxLength={500}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field
            label="Duration"
            hint="In steps of 5 minutes."
            error={errors?.durationMinutes?.[0]}
            required
          >
            <NumberInput
              kind="quantity"
              suffix="min"
              value={duration}
              onValueChange={setDuration}
            />
          </Field>
          <Field
            label="Capacity units"
            hint={`Bikes it takes per slot (the shop takes ${shopCapacity}).`}
            error={errors?.capacityUnits?.[0]}
            required
          >
            <NumberInput
              kind="quantity"
              stepper
              minValue={1}
              maxValue={shopCapacity}
              value={units}
              onValueChange={setUnits}
            />
          </Field>
        </div>
        <Switch
          label="Public"
          description="Customers can book this on the BICII website."
          checked={isPublic}
          onCheckedChange={setPublic}
        />
        <Switch
          label="Active"
          description="Inactive types can't be booked; existing bookings stay."
          checked={active}
          onCheckedChange={setActive}
        />
        <Field
          label="Sort order"
          hint="Lower comes first in the booking sheet and on the website."
          error={errors?.sortOrder?.[0]}
          required
        >
          <NumberInput kind="quantity" value={sortOrder} onValueChange={setSortOrder} />
        </Field>
      </form>
    </Sheet>
  );
}
