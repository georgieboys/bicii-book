"use client";

import { useState, useTransition } from "react";

import { setSettlementAlertDays } from "@/app/(staff)/reports/exceptions/actions";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { NumberInput } from "@/components/ui/number-input";
import { Sheet } from "@/components/ui/sheet";
import { useToast } from "@/components/ui/toast";
import { alertDaysLabel } from "@/lib/reconciliation";
import { callAction } from "@/lib/call-action";

/**
 * Admin: "Alert unsettled consignments after N days" with Change (D107;
 * DESIGN "Forms"). The sheet keeps what was typed when the save fails and
 * shows the field's error under it; a save closes the sheet with a toast.
 * The Server Action checks the admin again, and so does the RPC.
 */
export function AlertDaysControl({ days }: { days: number }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <p className="text-sm">{alertDaysLabel(days)}</p>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Change<span className="sr-only"> when unsettled consignments are flagged</span>
      </Button>
      {open ? <AlertDaysSheet days={days} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

function AlertDaysSheet({ days, onClose }: { days: number; onClose: () => void }) {
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [value, setValue] = useState(String(days));
  const [error, setError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | null>(null);

  const save = () =>
    startTransition(async () => {
      const result = await callAction(() => setSettlementAlertDays({ days: value.trim() }));
      if (!result.ok) {
        setError(result.fieldErrors?.days?.[0] ?? (result.code ? result.error : undefined));
        setFormError(result.fieldErrors?.days || result.code ? null : result.error);
        return;
      }
      toast({ title: alertDaysLabel(result.data.days), tone: "success" });
      onClose();
    });

  return (
    <Sheet
      open
      onOpenChange={(next) => (next ? null : onClose())}
      dismissible={!pending}
      title="When to flag unsettled consignments"
      description="A sold consignment item with money still owed to its consignor becomes an exception once its latest sale is more than this many shop days old."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button pending={pending} pendingLabel="Saving…" onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
        noValidate
      >
        {formError ? (
          <p role="alert" className="text-sm font-medium text-danger-deep">
            {formError}
          </p>
        ) : null}
        <Field label="Days" hint="From 1 to 365 shop days." error={error} required>
          <NumberInput
            kind="quantity"
            stepper
            minValue={1}
            maxValue={365}
            suffix="days"
            autoComplete="off"
            value={value}
            onValueChange={(v) => {
              setValue(v);
              setError(undefined);
            }}
          />
        </Field>
      </form>
    </Sheet>
  );
}
