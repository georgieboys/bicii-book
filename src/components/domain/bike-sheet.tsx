"use client";

import { useRouter } from "next/navigation";
import { useActionState, useId, useState } from "react";

import { createBike, updateBike } from "@/app/(staff)/bikes/actions";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { PlusIcon } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import type { PickerOption } from "@/components/ui/search-picker";
import { Sheet } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { useFocusFirstInvalid } from "@/components/ui/use-focus-invalid";
import type { ActionResult } from "@/lib/actions";
import { bikeTitle } from "@/lib/bikes";
import { newId } from "@/lib/uuid";
import { callAction } from "@/lib/call-action";

import { CustomerPicker } from "./customer-picker";

/** The descriptive fields of a bike (BikeDetail has them all). */
export type BikeFields = {
  id: string;
  brand: string;
  model: string;
  variant: string | null;
  frameSize: string | null;
  colour: string | null;
  serialNumber: string | null;
  description: string | null;
  internalNotes: string | null;
};

type State = ActionResult<unknown> | null;

/**
 * New or edit bike, in a sheet. A new bike may get an owner (preset when
 * opened from a customer's page, or picked) or none: shop and consigned
 * bikes have no customer. The database assigns its B- number; saving opens
 * the bike, ready for photos. The owner of an existing bike changes only by
 * transfer (with a reason), so the edit form has no owner field. With
 * `onCreated` (intake), the new bike is handed back and the sheet closes
 * instead of opening the bike.
 */
export function BikeSheet({
  open,
  onOpenChange,
  bike,
  owner,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Edit this bike; omit for a new one. */
  bike?: BikeFields;
  /** New bike: register it to this customer. */
  owner?: { id: string; label: string };
  /** New bike: receive it here instead of navigating to it. */
  onCreated?: (created: { id: string; label: string }) => void;
}) {
  return open ? (
    <BikeSheetBody onOpenChange={onOpenChange} bike={bike} owner={owner} onCreated={onCreated} />
  ) : null;
}

function BikeSheetBody({
  onOpenChange,
  bike,
  owner,
  onCreated,
}: {
  onOpenChange: (open: boolean) => void;
  bike?: BikeFields;
  owner?: { id: string; label: string };
  onCreated?: (created: { id: string; label: string }) => void;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const formId = useId();
  const [id] = useState(() => bike?.id ?? newId());
  const [picked, setPicked] = useState<PickerOption | null>(null);
  const [state, formAction, pending] = useActionState<State, FormData>(async (prev, formData) => {
    const result = bike
      ? await callAction(() => updateBike(prev as ActionResult<null> | null, formData), formData)
      : await callAction(
          () => createBike(prev as ActionResult<{ id: string }> | null, formData),
          formData,
        );
    if (result.ok) {
      if (bike) {
        toast({ title: "Bike saved", tone: "success" });
        onOpenChange(false);
      } else if (onCreated) {
        toast({ title: "Bike added", tone: "success" });
        const text = (key: string) => {
          const v = formData.get(key);
          return typeof v === "string" ? v : "";
        };
        onCreated({
          id,
          label: bikeTitle({
            brand: text("brand"),
            model: text("model"),
            variant: text("variant"),
          }),
        });
        onOpenChange(false);
      } else {
        toast({ title: "Bike added", tone: "success" });
        router.push(`/bikes/${id}`);
      }
    }
    return result;
  }, null);
  const formRef = useFocusFirstInvalid(state);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  const values = state && !state.ok ? state.values : undefined;
  const value = (key: keyof Omit<BikeFields, "id">) => values?.[key] ?? bike?.[key] ?? "";

  return (
    <Sheet
      open
      onOpenChange={onOpenChange}
      dismissible={!pending}
      title={bike ? "Edit bike" : "New bike"}
      description={bike ? undefined : "The bike gets its permanent B- number when you save."}
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} pending={pending} pendingLabel="Saving…">
            {bike ? "Save" : "Add bike"}
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
        {bike ? null : owner ? (
          <div className="flex flex-col gap-1.5">
            <span className="font-display text-xs font-bold tracking-wide uppercase">Owner</span>
            <p className="font-medium">{owner.label}</p>
            <input type="hidden" name="customerId" value={owner.id} />
          </div>
        ) : (
          <Field
            label="Owner"
            hint="Leave empty for a shop or consigned bike."
            error={errors?.customerId?.[0]}
          >
            <CustomerPicker name="customerId" value={picked} onSelect={setPicked} />
          </Field>
        )}
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Brand" error={errors?.brand?.[0]} required>
            <Input name="brand" autoComplete="off" defaultValue={value("brand")} />
          </Field>
          <Field label="Model" error={errors?.model?.[0]} required>
            <Input name="model" autoComplete="off" defaultValue={value("model")} />
          </Field>
        </div>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Variant" hint="Build or spec, e.g. Expert" error={errors?.variant?.[0]}>
            <Input name="variant" autoComplete="off" defaultValue={value("variant")} />
          </Field>
          <Field label="Frame size" error={errors?.frameSize?.[0]}>
            <Input name="frameSize" autoComplete="off" defaultValue={value("frameSize")} />
          </Field>
        </div>
        <Field label="Colour" error={errors?.colour?.[0]}>
          <Input name="colour" autoComplete="off" defaultValue={value("colour")} />
        </Field>
        <Field
          label="Serial number"
          hint="As stamped on the frame; spaces and dashes don't matter for search."
          error={errors?.serialNumber?.[0]}
        >
          <Input
            name="serialNumber"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            className="font-mono"
            defaultValue={value("serialNumber")}
          />
        </Field>
        <Field label="Description" error={errors?.description?.[0]}>
          <Textarea name="description" rows={2} defaultValue={value("description")} />
        </Field>
        <Field
          label="Internal notes"
          hint="Staff only. Never shown to the customer."
          error={errors?.internalNotes?.[0]}
        >
          <Textarea name="internalNotes" rows={3} defaultValue={value("internalNotes")} />
        </Field>
      </form>
    </Sheet>
  );
}

export function NewBikeButton({
  owner,
  disabled = false,
  variant = "solid",
}: {
  owner?: { id: string; label: string };
  disabled?: boolean;
  variant?: "solid" | "outline";
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant={variant}
        icon={<PlusIcon className="size-5" />}
        onClick={() => setOpen(true)}
        disabled={disabled}
      >
        {owner ? "Add bike" : "New bike"}
      </Button>
      <BikeSheet open={open} onOpenChange={setOpen} owner={owner} />
    </>
  );
}

export function EditBikeButton({ bike }: { bike: BikeFields }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        Edit
      </Button>
      <BikeSheet open={open} onOpenChange={setOpen} bike={bike} />
    </>
  );
}
