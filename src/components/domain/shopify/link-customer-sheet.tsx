"use client";

import { useId, useState, useTransition } from "react";

import { linkCustomerAction } from "@/app/(staff)/shopify/actions";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import type { PickerOption } from "@/components/ui/search-picker";
import { Sheet } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import type { ShopifyCustomerOnEvent } from "@/lib/domain/shopify";
import { REASON_MAX_LENGTH } from "@/lib/reasons";
import { earlierSalesText } from "@/lib/shopify";
import { callAction } from "@/lib/call-action";

import { CustomerPicker } from "../customer-picker";

/**
 * Link the order's Shopify customer to a BICII customer (admins; D86).
 * Customers with the same email come first, labelled as candidates only:
 * a matching email is never proof, so staff choose and give a reason. Any
 * customer can be found with the picker. The link applies to later
 * orders; recorded sales are immutable. Cancel and "Link customer" sit in
 * the sheet's footer (pointing at the form), and the sheet cannot be
 * closed while the link is being saved (DESIGN.md "Forms").
 */
export function LinkCustomerButton({
  eventId,
  customer,
}: {
  eventId: string;
  customer: ShopifyCustomerOnEvent;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div>
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          Link to a BICII customer
        </Button>
      </div>
      {open ? (
        <LinkCustomerSheet eventId={eventId} customer={customer} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}

function LinkCustomerSheet({
  eventId,
  customer,
  onClose,
}: {
  eventId: string;
  customer: ShopifyCustomerOnEvent;
  onClose: () => void;
}) {
  const formId = useId();
  const { toast } = useToast();
  const [chosen, setChosen] = useState<PickerOption | null>(null);
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<Record<string, string[] | undefined>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const submit = () =>
    start(async () => {
      setError(null);
      const local: Record<string, string[]> = {};
      if (!chosen) local.customerId = ["Choose the BICII customer."];
      if (!reason.trim()) local.reason = ["Say how you know this is the same person."];
      if (Object.keys(local).length > 0) {
        setErrors(local);
        return;
      }
      const result = await callAction(() =>
        linkCustomerAction({
          eventId,
          customerId: chosen!.id,
          shopifyCustomerGid: customer.gid,
          reason: reason.trim(),
        }),
      );
      if (!result.ok) {
        setErrors(result.fieldErrors ?? {});
        setError(result.error);
        return;
      }
      toast({
        title: `Linked to ${chosen!.label}`,
        description: earlierSalesText(result.data.earlierOnlineSales),
        tone: "success",
      });
      onClose();
    });

  return (
    <Sheet
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      dismissible={!pending}
      title="Link Shopify customer"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} pending={pending} pendingLabel="Linking…">
            Link customer
          </Button>
        </>
      }
    >
      <form
        id={formId}
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!pending) submit();
        }}
      >
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-dust-500">Shopify customer</dt>
          <dd className="font-mono text-xs break-all">{customer.gid}</dd>
          <dt className="text-dust-500">Email on the order</dt>
          <dd className="break-all">{customer.email ?? "None"}</dd>
        </dl>
        {error ? (
          <p role="alert" className="text-sm font-medium text-danger-deep">
            {error}
          </p>
        ) : null}
        {customer.candidates.length > 0 ? (
          <fieldset className="flex flex-col gap-2">
            <legend className="font-display text-xs font-bold tracking-wide uppercase">
              Same email
            </legend>
            <ul className="flex flex-col gap-2">
              {customer.candidates.map((c) => {
                const selected = chosen?.id === c.id;
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      aria-pressed={selected}
                      onClick={() => {
                        setChosen({ id: c.id, label: c.label, description: c.email ?? undefined });
                        setErrors((x) => ({ ...x, customerId: undefined }));
                      }}
                      className={cn(
                        "flex min-h-tap w-full flex-col items-start gap-0.5 rounded-xl border px-3 py-2 text-left",
                        selected ? "border-ink bg-dust-100" : "border-hairline hover:bg-dust-100",
                      )}
                    >
                      <span className="font-medium">{c.label}</span>
                      <span className="text-sm text-waiting-deep">
                        Candidate — same email is not proof
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </fieldset>
        ) : null}
        <Field
          label="BICII customer"
          hint="Search any customer by name, phone or email."
          error={errors.customerId?.[0]}
          required
        >
          <CustomerPicker
            value={chosen}
            onSelect={(o) => {
              setChosen(o);
              setErrors((x) => ({ ...x, customerId: undefined }));
            }}
            required
          />
        </Field>
        <Field
          label="Reason"
          hint="How you know it is the same person, e.g. they confirmed by phone."
          error={errors.reason?.[0]}
          required
        >
          <Textarea
            name="reason"
            rows={2}
            maxLength={REASON_MAX_LENGTH}
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
              setErrors((x) => ({ ...x, reason: undefined }));
            }}
          />
        </Field>
        <p className="text-sm text-dust-700">
          Later orders from this Shopify customer are recorded for them. Sales already recorded are
          not changed; they show the customer through the Shopify ID.
        </p>
      </form>
    </Sheet>
  );
}
