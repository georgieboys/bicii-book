"use client";

import { useEffect, useId, useRef, useState, useTransition, type ReactNode } from "react";

import { recordCounterPaymentAction } from "@/app/(staff)/jobs/payment-actions";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Sheet } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { useArmed } from "@/components/ui/use-armed";
import type { ActionResult } from "@/lib/actions";
import { cn } from "@/lib/cn";
import { shopToday } from "@/lib/dates";
import type { JobDeposit } from "@/lib/domain/payments";
import { formatMoney, parseMoney } from "@/lib/money";
import {
  COUNTER_MAX,
  COUNTER_METHODS,
  COUNTER_METHOD_LABELS,
  counterCommitLabels,
  counterDayRange,
  counterDepositChoices,
  counterDepositLabel,
  counterPrefill,
  counterReceivedAt,
  counterWarnings,
  type CounterMethod,
} from "@/lib/payments";
import { newId } from "@/lib/uuid";
import type { WorkOrderStatus } from "@/lib/workshop";
import { callAction } from "@/lib/call-action";

const BILL = "bill";

/**
 * Record money the shop took at the counter (D161; an active admin, the
 * page offers it only then and the RPC checks again; step3-critique C19).
 * What it is for: each deposit that is due or refunded ("Record the
 * $300.00 deposit for the quote answered 12 Oct", its amount fixed from
 * the quote, since the database takes only that amount), or "Towards the
 * bill" (any amount, prefilled with what is left to pay). How it was paid
 * (Cash, Card, PayNow, Bank transfer, Other: never Stripe), the day it was
 * paid (today sends nothing, the database stamps now; an earlier day is
 * noon that day, never before the check-in or the quote's answer, and at
 * most 29 days back), a reference and a note. Warnings never refuse: a
 * deposit still asked online, a deposit left due on a final bill, an
 * amount above what is left. The commit is two steps that repeat the
 * amount and the method ("Record $3,800.00 cash…" in the footer, then
 * "Record $3,800.00" at the top of the form, clear of the toasts at the
 * bottom of a phone's screen, focus on Back), disabled for 400 ms. The id
 * is made when the sheet opens and every value is held in state, so a
 * retry records once. Works with Stripe off. When the job's open online
 * Checkout could not be expired or was paid meanwhile, the sheet stays
 * open and says so.
 */
export function CounterPaymentSheet({
  workOrderId,
  jobNumber,
  jobStatus,
  jobOpen,
  checkedInAt,
  deposits,
  balanceDue,
  jobTotal,
  currency,
  onClose,
}: {
  workOrderId: string;
  jobNumber: string;
  jobStatus: WorkOrderStatus;
  /** One of D15's open statuses. */
  jobOpen: boolean;
  checkedInAt: string;
  deposits: readonly JobDeposit[];
  /** What is left to pay (null once collected, or outside SGD). */
  balanceDue: string | null;
  jobTotal: string | null;
  currency: string;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const formId = useId();
  const [id] = useState(newId);
  const [today] = useState(() => shopToday());
  const choices = counterDepositChoices(deposits, jobStatus);
  const [choice, setChoice] = useState<string>(BILL);
  const [amount, setAmount] = useState(() => counterPrefill(balanceDue));
  const [method, setMethod] = useState<CounterMethod>("cash");
  const [day, setDay] = useState(today);
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<ActionResult<{
    replayed: boolean;
    checkoutNote: string | null;
  }> | null>(null);
  const [pending, start] = useTransition();
  const armed = useArmed(confirming);
  const backRef = useRef<HTMLButtonElement>(null);
  const startRef = useRef<HTMLButtonElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const wasConfirming = useRef(false);

  const deposit = choices.find((d) => d.quoteId === choice) ?? null;
  const dueDeposit = choices.find((d) => d.state === "due") ?? null;
  const sent = deposit ? deposit.amount : amount;
  const parsed = parseMoney(sent, { currency });
  // The database's bounds (counter_payments_amount_check), compared, never
  // computed: an amount above the cap never reaches the confirm step.
  const overCap = parsed !== null && parsed.greaterThan(COUNTER_MAX);
  const valid = parsed !== null && parsed.greaterThan(0) && !overCap;
  const shown = valid ? formatMoney(parsed, currency) : null;
  const labels = counterCommitLabels(shown, method);
  const notBefore = deposit ? (deposit.answeredAt ?? checkedInAt) : checkedInAt;
  const range = counterDayRange(today, notBefore);
  // A day before the deposit's quote answer (after switching to it) reads as that day.
  const paidDay = day < range.min ? range.min : day;
  const { warnings, info } = counterWarnings({
    choice: deposit ? "deposit" : "bill",
    amount,
    currency,
    jobStatus,
    jobOpen,
    dueDeposit,
    balanceDue,
    jobTotal,
  });
  const errors = result && !result.ok ? result.fieldErrors : undefined;
  const recorded = result?.ok ? result.data : null;

  // Focus follows the confirm step: Back when it opens; when it closes,
  // the first invalid field after a refusal with field errors (DESIGN
  // Forms, as useFocusFirstInvalid does), else the start button. One
  // effect, so nothing runs after it and takes the focus back.
  useEffect(() => {
    const cancelled = wasConfirming.current && !confirming;
    wasConfirming.current = confirming;
    if (confirming) {
      backRef.current?.focus();
      return;
    }
    if (!cancelled) return;
    const invalid =
      result && !result.ok && result.fieldErrors
        ? formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')
        : null;
    (invalid ?? startRef.current)?.focus();
  }, [confirming, result]);

  const record = () => {
    if (!armed || !valid) return;
    start(async () => {
      const r = await callAction(() =>
        recordCounterPaymentAction({
          id,
          workOrderId,
          quoteId: deposit?.quoteId ?? null,
          amount: sent,
          method,
          receivedAt: counterReceivedAt(paidDay, today, notBefore),
          reference: reference || null,
          note: note || null,
        }),
      );
      setResult(r);
      if (!r.ok) {
        setConfirming(false);
        return;
      }
      if (r.data.checkoutNote) {
        // Kept open: what happened online needs reading before it is gone.
        setConfirming(false);
        return;
      }
      toast({ title: `Recorded ${shown} at the counter on ${jobNumber}`, tone: "success" });
      onClose();
    });
  };

  if (recorded) {
    return (
      <Sheet
        open
        onOpenChange={(next) => (next ? null : onClose())}
        title="Counter payment recorded"
        footer={<Button onClick={onClose}>Done</Button>}
      >
        <div className="flex flex-col gap-3">
          <p role="status" className="rounded-xl bg-done-soft p-3 text-sm text-done-deep">
            Recorded {shown} at the counter on {jobNumber}.
          </p>
          {recorded.checkoutNote ? (
            <p role="alert" className="rounded-xl bg-danger-soft p-3 text-sm text-danger-deep">
              {recorded.checkoutNote}
            </p>
          ) : null}
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet
      open
      onOpenChange={(next) => (next ? null : onClose())}
      dismissible={!pending}
      title="Record counter payment"
      description={`Money the shop took itself on ${jobNumber}: BICII records it and moves no money. Money taken as the bike leaves need not be recorded.`}
      footer={
        confirming ? null : (
          <>
            <Button variant="outline" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button
              ref={startRef}
              key="start"
              disabled={!valid}
              onClick={() => {
                setResult(null);
                setConfirming(true);
              }}
            >
              {labels.start}
            </Button>
          </>
        )
      }
    >
      <form
        ref={formRef}
        id={formId}
        className="flex flex-col gap-5"
        noValidate
        onSubmit={(e) => e.preventDefault()}
      >
        {result && !result.ok ? (
          <p role="alert" className="text-sm font-medium text-danger-deep">
            {result.error}
          </p>
        ) : null}
        {confirming ? (
          <div
            key="confirm"
            role="group"
            aria-label={`${labels.start.replace(/…$/, "")}?`}
            className="flex flex-col gap-3 rounded-xl bg-sunken p-4"
          >
            <p className="text-sm">
              {labels.start.replace(/…$/, "")} {deposit ? "as the deposit" : "towards the bill"} on{" "}
              {jobNumber}? A wrong entry is corrected by voiding it.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                key="back"
                ref={backRef}
                variant="outline"
                disabled={pending}
                onClick={() => setConfirming(false)}
              >
                Back
              </Button>
              <Button
                key="confirm"
                disabled={!armed}
                pending={pending}
                pendingLabel="Recording…"
                onClick={record}
              >
                {labels.confirm}
              </Button>
            </div>
          </div>
        ) : null}

        <fieldset className="flex flex-col gap-2" disabled={confirming}>
          <legend className="mb-1 font-display text-xs font-bold tracking-wide uppercase">
            What it is for
          </legend>
          {choices.map((d) => (
            <RadioCard
              key={d.quoteId}
              name={`${formId}-for`}
              value={d.quoteId}
              checked={choice === d.quoteId}
              onChange={() => setChoice(d.quoteId)}
            >
              <span className="font-medium">{counterDepositLabel(d)}</span>
              <span className="text-sm text-dust-500">
                {d.state === "refunded"
                  ? "Its online payment was refunded in Stripe. The amount is the deposit's."
                  : "The amount is the deposit's."}
              </span>
            </RadioCard>
          ))}
          <RadioCard
            name={`${formId}-for`}
            value={BILL}
            checked={choice === BILL}
            onChange={() => setChoice(BILL)}
          >
            <span className="font-medium">Towards the bill</span>
            <span className="text-sm text-dust-500">Any amount, also before the work is done.</span>
          </RadioCard>
        </fieldset>

        {deposit ? (
          <p className="flex items-baseline justify-between rounded-xl bg-sunken px-4 py-3 tabular-nums">
            <span className="text-sm text-dust-700">Amount (the deposit)</span>
            <output className="text-lg font-bold">
              {formatMoney(deposit.amount, deposit.currency)}
            </output>
          </p>
        ) : (
          <Field
            label="Amount"
            required
            hint={
              balanceDue !== null
                ? `${formatMoney(balanceDue, currency)} is left to pay.`
                : undefined
            }
            error={
              errors?.amount?.[0] ??
              (amount.trim() !== "" && !valid
                ? overCap
                  ? `At most ${formatMoney(COUNTER_MAX, currency)}.`
                  : "Enter an amount above 0, like 12.50."
                : undefined)
            }
          >
            <NumberInput
              kind="money"
              value={amount}
              onValueChange={setAmount}
              disabled={confirming}
            />
          </Field>
        )}

        <div className="flex flex-col gap-2">
          <span className="font-display text-xs font-bold tracking-wide uppercase">Paid by</span>
          <SegmentedControl
            label="Paid by"
            name="method"
            value={method}
            onValueChange={(v) => setMethod(v as CounterMethod)}
            options={COUNTER_METHODS.map((m) => ({
              value: m,
              label: COUNTER_METHOD_LABELS[m],
              disabled: confirming,
            }))}
          />
          <p className="text-sm text-dust-500">
            Card is the shop&apos;s own terminal and PayNow its own QR. Online payments through
            Stripe record themselves.
          </p>
        </div>

        <Field
          label="Paid on"
          hint="Today unless the money came in on an earlier day."
          error={errors?.receivedAt?.[0]}
        >
          <Input
            type="date"
            min={range.min}
            max={range.max}
            value={paidDay}
            disabled={confirming}
            onChange={(e) => setDay(e.target.value || today)}
          />
        </Field>
        <Field
          label="Reference"
          hint="The receipt, terminal or PayNow reference, if any."
          error={errors?.reference?.[0]}
        >
          <Input
            autoComplete="off"
            maxLength={200}
            value={reference}
            disabled={confirming}
            onChange={(e) => setReference(e.target.value)}
          />
        </Field>
        <Field label="Note" error={errors?.note?.[0]}>
          <Textarea
            rows={2}
            maxLength={2000}
            value={note}
            disabled={confirming}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>

        {warnings.length > 0 ? (
          <ul aria-label="Before you record it" className="flex flex-col gap-2">
            {warnings.map((w) => (
              <li key={w} className="rounded-xl bg-waiting-soft p-3 text-sm text-waiting-deep">
                {w}
              </li>
            ))}
          </ul>
        ) : null}
        {info ? (
          <p role="note" className="rounded-xl bg-info-soft p-3 text-sm text-info-deep">
            {info}
          </p>
        ) : null}
      </form>
    </Sheet>
  );
}

function RadioCard({
  name,
  value,
  checked,
  onChange,
  children,
}: {
  name: string;
  value: string;
  checked: boolean;
  onChange: () => void;
  children: ReactNode;
}) {
  return (
    <label
      className={cn(
        "relative flex min-h-tap cursor-pointer flex-col items-start justify-center gap-1 rounded-2xl border-2 px-4 py-3 has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-3 has-[:focus-visible]:outline-indigo",
        checked ? "border-ink bg-dust-100" : "border-hairline bg-card hover:bg-dust-100",
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onChange}
        className="sr-only"
      />
      {children}
    </label>
  );
}
