"use client";

import { useRouter } from "next/navigation";
import { useActionState, useId, useState } from "react";

import { createSupplier, updateSupplier } from "@/app/(staff)/purchasing/supplier-actions";
import { Button, type ButtonVariant } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { PlusIcon } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { useFocusFirstInvalid } from "@/components/ui/use-focus-invalid";
import type { ActionResult } from "@/lib/actions";
import { newId } from "@/lib/uuid";
import { callAction } from "@/lib/call-action";

/** The fields a supplier form edits (SupplierDetail has them all). */
export type SupplierFields = {
  id: string;
  name: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  accountReference: string | null;
  notes: string | null;
};

type State = ActionResult<unknown> | null;

/**
 * New or edit supplier (manage_purchasing), in a sheet mounted only while
 * open. A new supplier's form carries its own id (the idempotency key, made
 * when the sheet opens); creating opens the supplier. A failed save shows
 * what was typed again (ActionResult.values).
 */
export function SupplierSheet({
  open,
  onOpenChange,
  supplier,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Edit this supplier; omit for a new one. */
  supplier?: SupplierFields;
}) {
  return open ? <SupplierSheetBody onOpenChange={onOpenChange} supplier={supplier} /> : null;
}

function SupplierSheetBody({
  onOpenChange,
  supplier,
}: {
  onOpenChange: (open: boolean) => void;
  supplier?: SupplierFields;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const formId = useId();
  const [id] = useState(() => supplier?.id ?? newId());
  const [state, formAction, pending] = useActionState<State, FormData>(async (prev, formData) => {
    const result = supplier
      ? await callAction(
          () => updateSupplier(prev as ActionResult<null> | null, formData),
          formData,
        )
      : await callAction(
          () => createSupplier(prev as ActionResult<{ id: string }> | null, formData),
          formData,
        );
    if (result.ok) {
      if (supplier) {
        toast({ title: "Supplier saved", tone: "success" });
        onOpenChange(false);
      } else {
        toast({ title: "Supplier created", tone: "success" });
        router.push(`/purchasing/suppliers/${id}`);
      }
    }
    return result;
  }, null);
  const formRef = useFocusFirstInvalid(state);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  const values = state && !state.ok ? state.values : undefined;
  const value = (key: keyof Omit<SupplierFields, "id">) => values?.[key] ?? supplier?.[key] ?? "";

  return (
    <Sheet
      open
      onOpenChange={onOpenChange}
      dismissible={!pending}
      title={supplier ? "Edit supplier" : "New supplier"}
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} pending={pending} pendingLabel="Saving…">
            {supplier ? "Save" : "Create supplier"}
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
          <Input name="name" autoComplete="off" defaultValue={value("name")} />
        </Field>
        <Field label="Contact name" error={errors?.contactName?.[0]}>
          <Input name="contactName" autoComplete="off" defaultValue={value("contactName")} />
        </Field>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Phone" error={errors?.phone?.[0]}>
            <Input
              type="tel"
              name="phone"
              inputMode="tel"
              autoComplete="off"
              placeholder="+65 6123 4501"
              defaultValue={value("phone")}
            />
          </Field>
          <Field label="Email" error={errors?.email?.[0]}>
            <Input
              type="email"
              name="email"
              inputMode="email"
              autoCapitalize="none"
              spellCheck={false}
              autoComplete="off"
              defaultValue={value("email")}
            />
          </Field>
        </div>
        <Field label="Website" hint="https:// is added when left out." error={errors?.website?.[0]}>
          <Input
            name="website"
            inputMode="url"
            autoCapitalize="none"
            spellCheck={false}
            autoComplete="off"
            placeholder="veloparts.test"
            defaultValue={value("website")}
          />
        </Field>
        <Field
          label="Account reference"
          hint="BICII's account number with this supplier."
          error={errors?.accountReference?.[0]}
        >
          <Input
            name="accountReference"
            autoComplete="off"
            spellCheck={false}
            defaultValue={value("accountReference")}
          />
        </Field>
        <Field
          label="Notes"
          hint="Ordering terms, minimums, delivery days."
          error={errors?.notes?.[0]}
        >
          <Textarea name="notes" rows={3} defaultValue={value("notes")} />
        </Field>
      </form>
    </Sheet>
  );
}

export function NewSupplierButton({ variant = "solid" }: { variant?: ButtonVariant }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant={variant}
        icon={<PlusIcon className="size-5" />}
        onClick={() => setOpen(true)}
      >
        New supplier
      </Button>
      <SupplierSheet open={open} onOpenChange={setOpen} />
    </>
  );
}

export function EditSupplierButton({ supplier }: { supplier: SupplierFields }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        Edit
      </Button>
      <SupplierSheet open={open} onOpenChange={setOpen} supplier={supplier} />
    </>
  );
}
