"use client";

import { useRouter } from "next/navigation";
import { useActionState, useId, useState, useTransition } from "react";

import {
  createConsignorAction,
  customerContactAction,
  updateConsignorAction,
} from "@/app/(staff)/consignment/actions";
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
import { newId } from "@/lib/uuid";
import { callAction } from "@/lib/call-action";

import { CustomerPicker } from "./customer-picker";

/** The fields a consignor form edits (never the payout details: those are only replaced). */
export type ConsignorFields = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  customer: { id: string; label: string } | null;
  internalNotes: string | null;
};

type State = ActionResult<unknown> | null;

/**
 * New or edit consignor, in a sheet (manage_consignments; SPEC §13). A
 * consignor may be linked to the customer record of the same person
 * (choosing one prefills the name, phone and email). A new consignor's
 * form carries its own id (idempotency key, made when the sheet opens);
 * saving opens their page. Payout details (bank, PayNow) are entered here
 * but never shown back: on an edit, a blank field keeps what is on file
 * (D48: only manage_consignments reads them, through Show payout details).
 */
export function ConsignorSheet({
  open,
  onOpenChange,
  consignor,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  consignor?: ConsignorFields;
}) {
  return open ? <ConsignorSheetBody onOpenChange={onOpenChange} consignor={consignor} /> : null;
}

function ConsignorSheetBody({
  onOpenChange,
  consignor,
}: {
  onOpenChange: (open: boolean) => void;
  consignor?: ConsignorFields;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const formId = useId();
  const [id] = useState(() => consignor?.id ?? newId());
  const [name, setName] = useState(consignor?.name ?? "");
  const [phone, setPhone] = useState(consignor?.phone ?? "");
  const [email, setEmail] = useState(consignor?.email ?? "");
  const [customer, setCustomer] = useState<PickerOption | null>(consignor?.customer ?? null);
  const [, startPrefill] = useTransition();
  const [state, formAction, pending] = useActionState<State, FormData>(async (prev, formData) => {
    const result = consignor
      ? await callAction(
          () => updateConsignorAction(prev as ActionResult<null> | null, formData),
          formData,
        )
      : await callAction(
          () => createConsignorAction(prev as ActionResult<{ id: string }> | null, formData),
          formData,
        );
    if (result.ok) {
      if (consignor) {
        toast({ title: "Consignor saved", tone: "success" });
        onOpenChange(false);
      } else {
        toast({ title: "Consignor created", tone: "success" });
        router.push(`/consignment/consignors/${id}`);
      }
    }
    return result;
  }, null);
  const formRef = useFocusFirstInvalid(state);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  const values = state && !state.ok ? state.values : undefined;

  const chooseCustomer = (option: PickerOption | null) => {
    setCustomer(option);
    if (!option) return;
    startPrefill(async () => {
      const result = await callAction(() => customerContactAction({ customerId: option.id }));
      if (!result.ok || !result.data) return;
      const c = result.data;
      // Prefill what is still empty; never overwrite what staff typed.
      setName((v) => v || c.name);
      setPhone((v) => v || (c.phone ?? ""));
      setEmail((v) => v || (c.email ?? ""));
    });
  };

  return (
    <Sheet
      open
      onOpenChange={onOpenChange}
      dismissible={!pending}
      title={consignor ? "Edit consignor" : "New consignor"}
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} pending={pending} pendingLabel="Saving…">
            {consignor ? "Save" : "Create consignor"}
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
        <Field
          label="Customer record"
          hint="Optional: link the consignor to their customer record. Choosing one fills in the name, phone and email."
          error={errors?.customerId?.[0]}
        >
          <CustomerPicker name="customerId" value={customer} onSelect={chooseCustomer} />
        </Field>
        <Field label="Name" error={errors?.displayName?.[0]} required>
          <Input
            name="displayName"
            autoComplete="off"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Phone" error={errors?.phone?.[0]}>
          <Input
            type="tel"
            name="phone"
            inputMode="tel"
            autoComplete="off"
            placeholder="+65 9123 4567"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
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
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field
          label={consignor ? "Replace payout details" : "Payout details"}
          hint={
            consignor
              ? "Leave empty to keep what is on file. Bank account or PayNow; only staff who manage consignments can see them."
              : "Optional. Bank account or PayNow; only staff who manage consignments can see them."
          }
          error={errors?.payoutDetails?.[0]}
        >
          <Textarea
            name="payoutDetails"
            rows={2}
            autoComplete="off"
            defaultValue={values?.payoutDetails ?? ""}
          />
        </Field>
        <Field label="Internal notes" hint="Staff only." error={errors?.internalNotes?.[0]}>
          <Textarea
            name="internalNotes"
            rows={3}
            defaultValue={values?.internalNotes ?? consignor?.internalNotes ?? ""}
          />
        </Field>
      </form>
    </Sheet>
  );
}

export function NewConsignorButton({ variant = "outline" }: { variant?: "solid" | "outline" }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant={variant}
        icon={<PlusIcon className="size-5" />}
        onClick={() => setOpen(true)}
      >
        New consignor
      </Button>
      <ConsignorSheet open={open} onOpenChange={setOpen} />
    </>
  );
}

export function EditConsignorButton({ consignor }: { consignor: ConsignorFields }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        Edit
      </Button>
      <ConsignorSheet open={open} onOpenChange={setOpen} consignor={consignor} />
    </>
  );
}
