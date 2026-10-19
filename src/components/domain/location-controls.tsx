"use client";

import { useActionState, useId, useOptimistic, useState, useTransition } from "react";

import {
  createLocation,
  setLocationActive,
  updateLocation,
} from "@/app/(staff)/settings/locations/actions";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { PlusIcon } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Select } from "@/components/ui/select";
import { Sheet } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { useFocusFirstInvalid } from "@/components/ui/use-focus-invalid";
import type { ActionResult } from "@/lib/actions";
import { LOCATION_KIND_LABELS, type LocationKindValue } from "@/lib/inventory";
import { newId } from "@/lib/uuid";
import { callAction } from "@/lib/call-action";

export type EditableLocation = {
  id: string;
  name: string;
  kind: LocationKindValue;
  sortOrder: number;
  active: boolean;
};

type State = ActionResult<{ id: string }> | null;

/** "Add location" (manage_inventory). */
export function NewLocationButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button icon={<PlusIcon className="size-5" />} onClick={() => setOpen(true)}>
        Add location
      </Button>
      {open ? <LocationSheet location={null} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/** "Edit" on one location row (manage_inventory). */
export function EditLocationButton({ location }: { location: EditableLocation }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        aria-label={`Edit ${location.name}`}
        onClick={() => setOpen(true)}
      >
        Edit
      </Button>
      {open ? <LocationSheet location={location} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/**
 * A location's name, kind and sort order (the default location is the
 * active one with the lowest sort order, then name). A new location's id
 * is made when the sheet opens: the idempotency key.
 */
function LocationSheet({
  location,
  onClose,
}: {
  location: EditableLocation | null;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const formId = useId();
  const [id] = useState(() => location?.id ?? newId());
  const [name, setName] = useState(location?.name ?? "");
  const [kind, setKind] = useState<string>(location?.kind ?? "storage");
  const [sortOrder, setSortOrder] = useState(String(location?.sortOrder ?? 100));
  const [state, formAction, pending] = useActionState<State, FormData>(async (prev, formData) => {
    const result = location
      ? await callAction(() => updateLocation(prev, formData), formData)
      : await callAction(() => createLocation(prev, formData), formData);
    if (result.ok) {
      toast({
        title: location ? `${name.trim()} saved` : `${name.trim()} added`,
        tone: "success",
      });
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
      title={location ? `Edit ${location.name}` : "New location"}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} pending={pending} pendingLabel="Saving…">
            {location ? "Save" : "Add location"}
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
        <input type="hidden" name="id" value={id} />
        {state && !state.ok ? (
          <p role="alert" className="text-sm font-medium text-danger-deep">
            {state.error}
          </p>
        ) : null}
        <Field label="Name" error={errors?.name?.[0]} required>
          <Input
            name="name"
            autoComplete="off"
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Kind" error={errors?.kind?.[0]} required>
          <Select name="kind" value={kind} onChange={(e) => setKind(e.target.value)}>
            {Object.entries(LOCATION_KIND_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Sort order"
          hint="Lower comes first. The active location with the lowest number is the default for new stock and parts."
          error={errors?.sortOrder?.[0]}
          required
        >
          <NumberInput
            kind="quantity"
            name="sortOrder"
            value={sortOrder}
            onValueChange={setSortOrder}
          />
        </Field>
      </form>
    </Sheet>
  );
}

/**
 * A location's Active switch, applied at once (useOptimistic and a toast).
 * A location still holding stock cannot be deactivated
 * (location_has_stock): the error toast says so and the switch snaps back.
 */
export function LocationActiveSwitch({
  location,
  disabled = false,
}: {
  location: Pick<EditableLocation, "id" | "name" | "active">;
  disabled?: boolean;
}) {
  const { toast } = useToast();
  const [pending, start] = useTransition();
  const [optimistic, setOptimistic] = useOptimistic(location.active);

  const change = (next: boolean) =>
    start(async () => {
      setOptimistic(next);
      const result = await callAction(() => setLocationActive({ id: location.id, active: next }));
      if (!result.ok) {
        toast({
          title: next ? `${location.name} not activated` : `${location.name} not deactivated`,
          description: result.error,
          tone: "error",
        });
        return;
      }
      toast({
        title: next ? `${location.name} is active` : `${location.name} is inactive`,
        tone: "success",
      });
    });

  return (
    <Switch
      label={<span className="sr-only">{location.name} active</span>}
      checked={optimistic}
      disabled={disabled || pending}
      onCheckedChange={change}
    />
  );
}
