"use client";

import { useRouter } from "next/navigation";
import { useActionState, useId, useState } from "react";

import { createCustomer, updateCustomer } from "@/app/(staff)/customers/actions";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { PlusIcon } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { useFocusFirstInvalid } from "@/components/ui/use-focus-invalid";
import type { ActionResult } from "@/lib/actions";
import { customerLabel } from "@/lib/people";
import { newId } from "@/lib/uuid";
import { callAction } from "@/lib/call-action";

/** The fields a customer form edits (CustomerDetail has them all). */
export type CustomerFields = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  displayName: string | null;
  email: string | null;
  phone: string | null;
  internalNotes: string | null;
};

type State = ActionResult<unknown> | null;

/**
 * New or edit customer, in a sheet. A new customer's form carries its own
 * id (idempotency key, made when the sheet opens), so a repeated submit
 * cannot create the same person twice; saving opens their page. Failed
 * submissions keep what was typed (DESIGN.md "Forms"). Mounted only while
 * open, so every opening starts clean. With `onCreated` (intake), a new
 * customer is handed back and the sheet closes instead of opening their page.
 */
export function CustomerSheet({
  open,
  onOpenChange,
  customer,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Edit this customer; omit for a new one. */
  customer?: CustomerFields;
  /** New customer: receive it here instead of navigating to their page. */
  onCreated?: (created: { id: string; label: string }) => void;
}) {
  return open ? (
    <CustomerSheetBody onOpenChange={onOpenChange} customer={customer} onCreated={onCreated} />
  ) : null;
}

/** The name a new customer will be shown by, from the submitted form. */
function labelFromForm(formData: FormData): string {
  const get = (key: string) => {
    const v = formData.get(key);
    return typeof v === "string" ? v : null;
  };
  return customerLabel({
    firstName: get("firstName"),
    lastName: get("lastName"),
    displayName: get("displayName"),
    email: get("email"),
    phone: get("phone"),
  });
}

function CustomerSheetBody({
  onOpenChange,
  customer,
  onCreated,
}: {
  onOpenChange: (open: boolean) => void;
  customer?: CustomerFields;
  onCreated?: (created: { id: string; label: string }) => void;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const formId = useId();
  const [id] = useState(() => customer?.id ?? newId());
  const [state, formAction, pending] = useActionState<State, FormData>(async (prev, formData) => {
    const result = customer
      ? await callAction(
          () => updateCustomer(prev as ActionResult<null> | null, formData),
          formData,
        )
      : await callAction(
          () => createCustomer(prev as ActionResult<{ id: string }> | null, formData),
          formData,
        );
    if (result.ok) {
      if (customer) {
        toast({ title: "Customer saved", tone: "success" });
        onOpenChange(false);
      } else if (onCreated) {
        toast({ title: "Customer created", tone: "success" });
        onCreated({ id, label: labelFromForm(formData) });
        onOpenChange(false);
      } else {
        toast({ title: "Customer created", tone: "success" });
        router.push(`/customers/${id}`);
      }
    }
    return result;
  }, null);
  const formRef = useFocusFirstInvalid(state);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  const values = state && !state.ok ? state.values : undefined;
  const value = (key: keyof Omit<CustomerFields, "id">) => values?.[key] ?? customer?.[key] ?? "";

  return (
    <Sheet
      open
      onOpenChange={onOpenChange}
      dismissible={!pending}
      title={customer ? "Edit customer" : "New customer"}
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} pending={pending} pendingLabel="Saving…">
            {customer ? "Save" : "Create customer"}
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
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="First name" error={errors?.firstName?.[0]}>
            <Input name="firstName" autoComplete="off" defaultValue={value("firstName")} />
          </Field>
          <Field label="Last name" error={errors?.lastName?.[0]}>
            <Input name="lastName" autoComplete="off" defaultValue={value("lastName")} />
          </Field>
        </div>
        <Field
          label="Display name"
          hint="Optional: how the shop knows them, if not first + last name."
          error={errors?.displayName?.[0]}
        >
          <Input name="displayName" autoComplete="off" defaultValue={value("displayName")} />
        </Field>
        <Field label="Phone" error={errors?.phone?.[0]}>
          <Input
            type="tel"
            name="phone"
            inputMode="tel"
            autoComplete="off"
            placeholder="+65 9123 4567"
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
        <Field
          label="Internal notes"
          hint="Staff only. Never shown to the customer."
          error={errors?.internalNotes?.[0]}
        >
          <Textarea name="internalNotes" rows={3} defaultValue={value("internalNotes")} />
        </Field>
        <p className="text-sm text-dust-500">A name, a phone number or an email is enough.</p>
      </form>
    </Sheet>
  );
}

export function NewCustomerButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button icon={<PlusIcon className="size-5" />} onClick={() => setOpen(true)}>
        New customer
      </Button>
      <CustomerSheet open={open} onOpenChange={setOpen} />
    </>
  );
}

export function EditCustomerButton({ customer }: { customer: CustomerFields }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        Edit
      </Button>
      <CustomerSheet open={open} onOpenChange={setOpen} customer={customer} />
    </>
  );
}
