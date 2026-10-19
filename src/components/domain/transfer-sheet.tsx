"use client";

import { useState, useTransition } from "react";

import { transferBike } from "@/app/(staff)/bikes/actions";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import type { PickerOption } from "@/components/ui/search-picker";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Sheet } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { REASON_MAX_LENGTH } from "@/lib/reasons";
import { callAction } from "@/lib/call-action";

import { CustomerPicker } from "./customer-picker";

type Destination = "customer" | "shop";

/**
 * Hand a bike to another customer, or back to the shop, with a reason
 * (SPEC §5 "Ownership changes preserve history"): the change is one more
 * entry in the bike's ownership history, with who did it and why; nothing
 * earlier is rewritten.
 */
export function TransferOwnershipButton({
  bikeId,
  currentOwner,
  disabled = false,
}: {
  bikeId: string;
  currentOwner: { id: string; label: string } | null;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)} disabled={disabled}>
        Transfer ownership
      </Button>
      {open ? (
        <TransferSheet bikeId={bikeId} currentOwner={currentOwner} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}

function TransferSheet({
  bikeId,
  currentOwner,
  onClose,
}: {
  bikeId: string;
  currentOwner: { id: string; label: string } | null;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [pending, start] = useTransition();
  const [destination, setDestination] = useState<Destination>("customer");
  const [to, setTo] = useState<PickerOption | null>(null);
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<{ to?: string; reason?: string; form?: string }>({});

  const submit = () => {
    const next: typeof errors = {};
    if (destination === "customer" && !to) next.to = "Choose the new owner.";
    if (!reason.trim()) next.reason = "Say why the bike is changing owner.";
    setErrors(next);
    if (next.to || next.reason) return;
    start(async () => {
      const result = await callAction(() =>
        transferBike({
          bikeId,
          toCustomerId: destination === "shop" ? null : (to?.id ?? null),
          reason,
        }),
      );
      if (result.ok) {
        toast({
          title:
            destination === "shop" ? "Bike moved to the shop" : `Bike transferred to ${to?.label}`,
          tone: "success",
        });
        onClose();
        return;
      }
      setErrors({
        to: result.fieldErrors?.toCustomerId?.[0],
        reason: result.fieldErrors?.reason?.[0],
        form: result.fieldErrors ? undefined : result.error,
      });
    });
  };

  return (
    <Sheet
      open
      onOpenChange={(open) => !open && onClose()}
      dismissible={!pending}
      title="Transfer ownership"
      description={
        currentOwner ? `Currently owned by ${currentOwner.label}.` : "Currently a shop bike."
      }
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} pending={pending} pendingLabel="Transferring…">
            Transfer
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-5"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {errors.form ? (
          <p role="alert" className="text-sm font-medium text-danger-deep">
            {errors.form}
          </p>
        ) : null}
        <div className="flex flex-col gap-1.5">
          <span
            aria-hidden="true"
            className="font-display text-xs font-bold tracking-wide uppercase"
          >
            New owner
          </span>
          <SegmentedControl
            label="New owner"
            value={destination}
            onValueChange={(v) => setDestination(v as Destination)}
            options={[
              { value: "customer", label: "A customer" },
              { value: "shop", label: "The shop", disabled: currentOwner === null },
            ]}
          />
        </div>
        {destination === "customer" ? (
          <Field label="Customer" error={errors.to} required>
            <CustomerPicker value={to} onSelect={setTo} currentId={currentOwner?.id} required />
          </Field>
        ) : (
          <p className="text-sm text-dust-700">
            The bike becomes a shop bike with no customer, e.g. traded in or bought back.
          </p>
        )}
        <Field
          label="Reason"
          hint="Kept in the bike's history with your name."
          error={errors.reason}
          required
        >
          <Textarea
            name="reason"
            rows={2}
            maxLength={REASON_MAX_LENGTH}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
      </form>
    </Sheet>
  );
}
