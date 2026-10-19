"use client";

import { useId, useState, useTransition } from "react";

import { recordSettlementAction, reverseSettlementAction } from "@/app/(staff)/consignment/actions";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Sheet } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { useFocusFirstInvalid } from "@/components/ui/use-focus-invalid";
import type { ActionResult } from "@/lib/actions";
import {
  allocationProblems,
  autoAllocate,
  outstandingLabel,
  paidAtFromDate,
  type AllocationCandidate,
} from "@/lib/consignment";
import { shopToday } from "@/lib/dates";
import { formatMoney, parseMoney, toDecimal } from "@/lib/money";
import { REASON_MAX_LENGTH } from "@/lib/reasons";
import { newId } from "@/lib/uuid";
import { callAction } from "@/lib/call-action";

import { ReasonConfirm } from "./reason-confirm";
import { ShortId } from "./short-id";

/** An item a payment can go to: its C- number, name and outstanding. */
export type SettlementItem = AllocationCandidate & { shortId: string; name: string };

type Line = { id: string; amount: string; overrideReason: string };

/**
 * "Record payment" (manage_consignments): opens SettlementSheet for one
 * consignor. `items` are all of the consignor's items with their
 * outstanding (money users only reach this button).
 */
export function RecordPaymentButton({
  consignorId,
  consignorName,
  items,
  currency,
}: {
  consignorId: string;
  consignorName: string;
  items: SettlementItem[];
  currency: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Record payment</Button>
      {open ? (
        <SettlementSheet
          consignorId={consignorId}
          consignorName={consignorName}
          items={items}
          currency={currency}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

/**
 * Money paid to a consignor (SPEC §13, §23; D46, D47; record_settlement):
 * the amount, the paid date (today by default; sent as NULL then), a
 * reference and notes, and how it is allocated: one row per item with
 * something outstanding, oldest sale first, each with its outstanding and
 * an amount. "Add another item" offers the consignor's other items for a
 * deliberate overpayment; Auto-fill spreads the amount (autoAllocate). The
 * sheet shows "Unallocated $x" / "Over by $x" live; a row above its
 * outstanding asks "Why pay more than is owed?" and needs an answer (D47).
 * The commit names the amount and stays disabled until allocationProblems
 * is clear. The settlement id is made when the sheet opens and every value
 * is held in state, so a retry records once.
 */
function SettlementSheet({
  consignorId,
  consignorName,
  items,
  currency,
  onClose,
}: {
  consignorId: string;
  consignorName: string;
  items: SettlementItem[];
  currency: string;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const formId = useId();
  const [settlementId] = useState(newId);
  const [today] = useState(() => shopToday());
  const owed = items
    .filter((i) => toDecimal(i.outstanding).greaterThan(0))
    .sort((a, b) => {
      if (a.lastSaleAt === b.lastSaleAt) return 0;
      if (a.lastSaleAt === null) return 1;
      if (b.lastSaleAt === null) return -1;
      return Date.parse(a.lastSaleAt) - Date.parse(b.lastSaleAt);
    });
  const [amount, setAmount] = useState("");
  const [paidDay, setPaidDay] = useState(today);
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<Line[]>(() =>
    owed.map((i) => ({ id: i.id, amount: "", overrideReason: "" })),
  );
  const [adding, setAdding] = useState(false);
  const [state, setState] = useState<ActionResult<{ replayed: boolean }> | null>(null);
  const [pending, start] = useTransition();
  const formRef = useFocusFirstInvalid(state);
  const errors = state && !state.ok ? state.fieldErrors : undefined;

  const filled = lines.filter((l) => l.amount.trim() !== "");
  const problems = allocationProblems(
    amount,
    filled.map((l) => ({ id: l.id, amount: l.amount, overrideReason: l.overrideReason })),
    items,
    currency,
  );
  const total = parseMoney(amount);
  const itemOf = (id: string) => items.find((i) => i.id === id);
  const others = items.filter((i) => !lines.some((l) => l.id === i.id));

  const setLine = (id: string, patch: Partial<Line>) =>
    setLines((all) => all.map((l) => (l.id === id ? { ...l, ...patch } : l)));

  const autoFill = () => {
    const { allocations } = autoAllocate(amount, items);
    setLines((all) =>
      all.map((l) => ({
        ...l,
        amount: allocations.find((a) => a.id === l.id)?.amount ?? "",
      })),
    );
  };

  const submit = () => {
    if (problems.blocking) return;
    const input = {
      settlementId,
      consignorId,
      amount,
      allocations: filled.map((l) => ({
        itemId: l.id,
        amount: l.amount,
        overrideReason: problems.overrides.includes(l.id) ? l.overrideReason.trim() : null,
      })),
      paidAt: paidAtFromDate(paidDay, today),
      reference: reference || null,
      notes: notes || null,
    };
    start(async () => {
      const result = await callAction(() => recordSettlementAction(input));
      setState(result);
      if (result.ok) {
        toast({
          title: `Payment of ${formatMoney(total!, currency)} recorded for ${consignorName}`,
          tone: "success",
        });
        onClose();
      }
    });
  };

  const commitLabel =
    total && total.greaterThan(0)
      ? `Record payment of ${formatMoney(total, currency)}`
      : "Record payment";

  return (
    <Sheet
      open
      onOpenChange={(next) => (next ? null : onClose())}
      dismissible={!pending}
      title="Record payment"
      description={`Money paid to ${consignorName}, allocated to their items.`}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={formId}
            pending={pending}
            pendingLabel="Recording…"
            disabled={problems.blocking}
          >
            {commitLabel}
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

        <section aria-labelledby={`${formId}-alloc`} className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3
              id={`${formId}-alloc`}
              className="font-display text-xs font-bold tracking-wide uppercase"
            >
              Allocate to items
            </h3>
            <Button variant="ghost" size="sm" onClick={autoFill} disabled={!total}>
              Auto-fill
            </Button>
          </div>
          {lines.length === 0 ? (
            <p className="text-sm text-dust-700">
              Nothing is owed to {consignorName} right now. Add an item below to pay ahead of a
              sale; it needs a reason.
            </p>
          ) : null}
          <ul className="flex flex-col gap-3">
            {lines.map((line) => {
              const item = itemOf(line.id);
              if (!item) return null;
              const over = problems.overrides.includes(line.id);
              const missing = problems.missingReasons.includes(line.id);
              return (
                <li key={line.id} className="flex flex-col gap-2 rounded-xl bg-sunken p-3">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <ShortId value={item.shortId} />
                    <span className="min-w-0 flex-1 truncate">{item.name}</span>
                    <span className="text-dust-700 tabular-nums">
                      {outstandingLabel(item.outstanding, currency)}
                    </span>
                  </div>
                  <Field label={`Amount for ${item.shortId}`}>
                    <NumberInput
                      kind="money"
                      value={line.amount}
                      onValueChange={(v) => setLine(line.id, { amount: v })}
                    />
                  </Field>
                  {over ? (
                    <Field
                      label="Why pay more than is owed?"
                      hint="Kept with the payment."
                      required
                      error={missing ? "Give a reason to pay more than is owed." : undefined}
                    >
                      <Textarea
                        rows={2}
                        maxLength={REASON_MAX_LENGTH}
                        value={line.overrideReason}
                        onChange={(e) => setLine(line.id, { overrideReason: e.target.value })}
                      />
                    </Field>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {others.length > 0 ? (
            adding ? (
              <div className="flex flex-col gap-2">
                <span className="text-sm text-dust-700">Add another item:</span>
                <ul className="flex flex-wrap gap-2">
                  {others.map((i) => (
                    <li key={i.id}>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setLines((all) => [...all, { id: i.id, amount: "", overrideReason: "" }]);
                          setAdding(false);
                        }}
                      >
                        {i.shortId} {i.name}
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <div>
                <Button variant="ghost" size="sm" onClick={() => setAdding(true)}>
                  Add another item
                </Button>
              </div>
            )
          ) : null}
          <p
            role="status"
            className={
              problems.mismatch
                ? "rounded-xl bg-waiting-soft px-4 py-3 text-sm font-medium text-waiting-deep tabular-nums"
                : total && total.greaterThan(0)
                  ? "rounded-xl bg-done-soft px-4 py-3 text-sm font-medium text-done-deep tabular-nums"
                  : // A prompt, not a result: the done tone only once it is allocated.
                    "rounded-xl bg-sunken px-4 py-3 text-sm font-medium text-dust-700 tabular-nums"
            }
          >
            {problems.mismatch ??
              (total && total.greaterThan(0) ? "Fully allocated" : "Enter the amount paid")}
          </p>
        </section>

        <Field label="Notes" error={errors?.notes?.[0]}>
          <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </form>
    </Sheet>
  );
}

/**
 * Reverse a whole settlement with a reason (manage_consignments; D47). The
 * settlement and its lines stay, struck through; the ledger stops counting
 * them. The reversal id is made when the confirmation opens.
 */
export function ReverseSettlementControl({
  settlementId,
  label,
}: {
  settlementId: string;
  /** "the $200.00 payment of 4 Oct", for the question. */
  label: string;
}) {
  const [reversalId, setReversalId] = useState<string | null>(null);
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
      onConfirmingChange={(confirming) => {
        if (confirming) setReversalId((id) => id ?? newId());
      }}
      onConfirm={(reason) =>
        reverseSettlementAction({ reversalId: reversalId ?? newId(), settlementId, reason })
      }
      onDone={() => setReversalId(null)}
    >
      The whole payment is reversed: what it paid counts as owed again. It stays in the list, struck
      through, with your reason.
    </ReasonConfirm>
  );
}
