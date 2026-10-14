"use client";

import { useState, useTransition } from "react";

import { setDepositPercentAction } from "@/app/(staff)/settings/payments/actions";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { NumberInput } from "@/components/ui/number-input";
import { Sheet } from "@/components/ui/sheet";
import { useToast } from "@/components/ui/toast";
import { depositPercentLabel } from "@/lib/payments";

/**
 * Admin: the deposit on indent quotes with Change (Phase 14 step 2; D151,
 * D157a; DESIGN "Forms"), a copy of AlertDaysControl. While Stripe is off
 * only 0 can be saved, and the sheet says why: a deposit nobody can pay
 * online would only hold up orders. The Server Action checks the admin
 * and Stripe again, and the RPC checks the admin and the range.
 */
export function DepositPercentControl({
  percent,
  stripeOn,
  offReason,
}: {
  percent: number;
  stripeOn: boolean;
  /** The sentence for why Stripe is off (src/lib/payments.ts), when it is. */
  offReason: string | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <p className="text-sm">{depositPercentLabel(percent)}</p>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Change<span className="sr-only"> the deposit on indent parts</span>
      </Button>
      {open ? (
        <DepositPercentSheet
          percent={percent}
          stripeOn={stripeOn}
          offReason={offReason}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}

function DepositPercentSheet({
  percent,
  stripeOn,
  offReason,
  onClose,
}: {
  percent: number;
  stripeOn: boolean;
  offReason: string | null;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [value, setValue] = useState(String(percent));
  const [error, setError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | null>(null);

  const save = () =>
    startTransition(async () => {
      const result = await setDepositPercentAction({ percent: value.trim() });
      if (!result.ok) {
        setError(result.fieldErrors?.percent?.[0] ?? (result.code ? result.error : undefined));
        setFormError(result.fieldErrors?.percent || result.code ? null : result.error);
        return;
      }
      toast({ title: depositPercentLabel(result.data.percent), tone: "success" });
      onClose();
    });

  return (
    <Sheet
      open
      onOpenChange={(next) => (next ? null : onClose())}
      dismissible={!pending}
      title="Deposit on indent parts"
      description="Asked after the customer answers a quote, on the parts they approve (not fitting or labour). Quotes already sent keep the deposit they were sent with."
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
        {!stripeOn ? (
          <p className="rounded-xl bg-waiting-soft px-3 py-2 text-sm text-waiting-deep">
            Stripe is off, so only 0 can be saved.{offReason ? ` ${offReason}` : ""}
          </p>
        ) : null}
        <Field
          label="Deposit"
          hint="0 asks for no deposit. Deposits under S$0.50 aren't asked (Stripe's minimum)."
          error={error}
          required
        >
          <NumberInput
            kind="quantity"
            stepper
            minValue={0}
            maxValue={stripeOn ? 100 : 0}
            suffix="%"
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
