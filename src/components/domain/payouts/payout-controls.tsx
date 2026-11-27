"use client";

import { useId, useState, useTransition } from "react";

import {
  recordPayoutAction,
  reversePayoutAction,
  setServicePayRuleAction,
} from "@/app/(staff)/payouts/actions";
import { Button, type ButtonVariant } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Select } from "@/components/ui/select";
import { Sheet } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { useFocusFirstInvalid } from "@/components/ui/use-focus-invalid";
import type { ActionResult } from "@/lib/actions";
import { callAction } from "@/lib/call-action";
import { paidAtFromDate } from "@/lib/consignment";
import { shopToday } from "@/lib/dates";
import { formatMoney, parseMoney } from "@/lib/money";
import { monthStart, type PayoutKind } from "@/lib/payouts";
import { newId } from "@/lib/uuid";

import { ReasonConfirm } from "../reason-confirm";

type StaffOption = { id: string; name: string };

/**
 * "Record payment" on /payouts (admins; D276): opens PayoutSheet for one
 * payee. `amount` is the month's outstanding (blank when nothing is left).
 */
export function RecordPayoutButton({
  kind,
  month,
  payeeLabel,
  staffId = null,
  amount,
  currency,
  staff = [],
  label = "Record payment",
  variant = "solid",
}: {
  kind: PayoutKind;
  /** "YYYY-MM". */
  month: string;
  /** "Bobby", "Cult Commons", "ad hoc labour". */
  payeeLabel: string;
  staffId?: string | null;
  amount: string;
  currency: string;
  /** Reserve labour: the staff a payment may go to. */
  staff?: StaffOption[];
  label?: string;
  variant?: ButtonVariant;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant={variant} onClick={() => setOpen(true)}>
        {label}
      </Button>
      {open ? (
        <PayoutSheet
          kind={kind}
          month={month}
          payeeLabel={payeeLabel}
          staffId={staffId}
          amount={amount}
          currency={currency}
          staff={staff}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

/**
 * The payment (record_payout): amount, paid on (today by default, sent as
 * NULL then), reference and notes; for ad hoc labour, a staff member or the
 * name of whoever was paid. It may be more than is owed: the page then says
 * "Over by". The payout id is made when the sheet opens, so a retry
 * records once.
 */
function PayoutSheet({
  kind,
  month,
  payeeLabel,
  staffId,
  amount: initial,
  currency,
  staff,
  onClose,
}: {
  kind: PayoutKind;
  month: string;
  payeeLabel: string;
  staffId: string | null;
  amount: string;
  currency: string;
  staff: StaffOption[];
  onClose: () => void;
}) {
  const { toast } = useToast();
  const formId = useId();
  const [id] = useState(newId);
  const [today] = useState(() => shopToday());
  const [amount, setAmount] = useState(initial);
  const [paidDay, setPaidDay] = useState(today);
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [labourStaff, setLabourStaff] = useState("");
  const [payeeName, setPayeeName] = useState("");
  const [state, setState] = useState<ActionResult<{ replayed: boolean }> | null>(null);
  const [pending, start] = useTransition();
  const formRef = useFocusFirstInvalid(state);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  const total = parseMoney(amount);
  const labour = kind === "reserve_labour";

  const submit = () => {
    const input = {
      id,
      kind,
      amount,
      month: labour ? null : monthStart(month),
      staffId: labour ? labourStaff || null : staffId,
      payeeName: labour && !labourStaff ? payeeName || null : null,
      paidAt: paidAtFromDate(paidDay, today),
      reference: reference || null,
      notes: notes || null,
    };
    start(async () => {
      const result = await callAction(() => recordPayoutAction(input));
      setState(result);
      if (result.ok) {
        toast({
          title: `Payment of ${formatMoney(total!, currency)} recorded for ${
            labour ? (staff.find((s) => s.id === labourStaff)?.name ?? payeeName) : payeeLabel
          }`,
          tone: "success",
        });
        onClose();
      }
    });
  };

  return (
    <Sheet
      open
      onOpenChange={(next) => (next ? null : onClose())}
      dismissible={!pending}
      title={labour ? "Pay ad hoc labour" : "Record payment"}
      description={
        labour ? "Money paid from the services reserve." : `Money you transferred to ${payeeLabel}.`
      }
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} pending={pending} pendingLabel="Recording…">
            {total && total.greaterThan(0)
              ? `Record payment of ${formatMoney(total, currency)}`
              : "Record payment"}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        ref={formRef}
        className="flex flex-col gap-5"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {state && !state.ok ? (
          <p role="alert" className="text-sm font-medium text-danger-deep">
            {state.error}
          </p>
        ) : null}
        {labour ? (
          <>
            <Field
              label="Paid to"
              hint="A staff member, or leave this and type a name."
              error={errors?.staffId?.[0]}
            >
              <Select value={labourStaff} onChange={(e) => setLabourStaff(e.target.value)}>
                <option value="">Someone else</option>
                {staff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            {labourStaff ? null : (
              <Field label="Name" required error={errors?.payeeName?.[0]}>
                <Input
                  autoComplete="off"
                  maxLength={200}
                  value={payeeName}
                  onChange={(e) => setPayeeName(e.target.value)}
                />
              </Field>
            )}
          </>
        ) : null}
        <Field label="Amount paid" required error={errors?.amount?.[0]}>
          <NumberInput kind="money" value={amount} onValueChange={setAmount} />
        </Field>
        <Field label="Paid on" error={errors?.paidAt?.[0]}>
          <Input
            type="date"
            max={today}
            value={paidDay}
            onChange={(e) => setPaidDay(e.target.value || today)}
          />
        </Field>
        <Field
          label="Reference"
          hint="The bank or PayNow reference, if any."
          error={errors?.reference?.[0]}
        >
          <Input
            autoComplete="off"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          />
        </Field>
        <Field label="Notes" error={errors?.notes?.[0] ?? errors?.month?.[0]}>
          <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </form>
    </Sheet>
  );
}

/** Reverse a payout with a reason (admins; D276). It stays in the list, struck through. */
export function ReversePayoutControl({ payoutId, label }: { payoutId: string; label: string }) {
  return (
    <ReasonConfirm
      startLabel="Reverse…"
      startAccessibleName={`Reverse… ${label}`}
      startSize="sm"
      question={`Why are you reversing ${label}?`}
      confirmLabel="Reverse payment"
      pendingLabel="Reversing…"
      failureTitle="Payment not reversed"
      successTitle="Payment reversed"
      onConfirm={(reason) => reversePayoutAction({ payoutId, reason })}
    >
      What it paid counts as owed again. It stays in the list, struck through, with your reason.
    </ReasonConfirm>
  );
}

/**
 * Service pay (admins; D276): a mechanic, their monthly cap and the month
 * it starts. Earlier months keep the cap they had.
 */
export function ServicePayRuleForm({
  staff,
  defaultMonth,
}: {
  staff: StaffOption[];
  /** "YYYY-MM". */
  defaultMonth: string;
}) {
  const { toast } = useToast();
  const formId = useId();
  const [staffId, setStaffId] = useState("");
  const [cap, setCap] = useState("3000.00");
  const [from, setFrom] = useState(defaultMonth);
  const [state, setState] = useState<ActionResult<null> | null>(null);
  const [pending, start] = useTransition();
  const formRef = useFocusFirstInvalid(state);
  const errors = state && !state.ok ? state.fieldErrors : undefined;

  return (
    <form
      id={formId}
      ref={formRef}
      className="flex flex-col gap-4"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const input = { staffId, monthlyCap: cap, effectiveFrom: from };
        start(async () => {
          const result = await callAction(() => setServicePayRuleAction(input));
          setState(result);
          if (result.ok) {
            toast({ title: "Service pay saved", tone: "success" });
          }
        });
      }}
    >
      {state && !state.ok ? (
        <p role="alert" className="text-sm font-medium text-danger-deep">
          {state.error}
        </p>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Mechanic" required error={errors?.staffId?.[0]}>
          <Select value={staffId} onChange={(e) => setStaffId(e.target.value)}>
            <option value="">Choose…</option>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Monthly cap"
          hint="Of service after Cult Commons."
          required
          error={errors?.monthlyCap?.[0]}
        >
          <NumberInput kind="money" value={cap} onValueChange={setCap} />
        </Field>
        <Field label="From month" required error={errors?.effectiveFrom?.[0]}>
          <Input type="month" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
      </div>
      <div>
        <Button type="submit" variant="outline" pending={pending} pendingLabel="Saving…">
          Save service pay
        </Button>
      </div>
    </form>
  );
}
