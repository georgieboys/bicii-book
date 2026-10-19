"use client";

import { useActionState, useEffect, useId, useRef, useState, useTransition } from "react";

import {
  returnConsignmentItemAction,
  revealPayoutDetailsAction,
  updateConsignmentTermsAction,
} from "@/app/(staff)/consignment/actions";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { NumberInput } from "@/components/ui/number-input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Sheet } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { CONFIRM_GUARD_MS } from "@/components/ui/use-armed";
import { useFocusFirstInvalid } from "@/components/ui/use-focus-invalid";
import type { ActionResult } from "@/lib/actions";
import { parseMoney } from "@/lib/money";
import { REASON_MAX_LENGTH } from "@/lib/reasons";
import { newId } from "@/lib/uuid";
import { callAction } from "@/lib/call-action";

type State = ActionResult<null> | null;

/**
 * "Edit terms" on an active consignment item (manage_consignments): the
 * agreed amount owed and the asking price (update_consignment_terms). A
 * changed agreed amount needs a reason, which the field then asks for;
 * the asking price is the public, label and sale price (D45).
 */
export function EditTermsButton({
  itemId,
  agreedAmountOwed,
  askingPrice,
}: {
  itemId: string;
  agreedAmountOwed: string;
  askingPrice: string | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        Edit terms
      </Button>
      {open ? (
        <TermsSheet
          itemId={itemId}
          agreedAmountOwed={agreedAmountOwed}
          askingPrice={askingPrice}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function TermsSheet({
  itemId,
  agreedAmountOwed,
  askingPrice,
  onClose,
}: {
  itemId: string;
  agreedAmountOwed: string;
  askingPrice: string | null;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const formId = useId();
  const [agreed, setAgreed] = useState(agreedAmountOwed);
  const [asking, setAsking] = useState(askingPrice ?? "");
  const [state, formAction, pending] = useActionState<State, FormData>(async (prev, formData) => {
    const result = await callAction(() => updateConsignmentTermsAction(prev, formData), formData);
    if (result.ok) {
      toast({ title: "Terms saved", tone: "success" });
      onClose();
    }
    return result;
  }, null);
  const formRef = useFocusFirstInvalid(state);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  const values = state && !state.ok ? state.values : undefined;
  const typed = parseMoney(agreed);
  const agreedChanged = typed === null || !typed.equals(parseMoney(agreedAmountOwed) ?? -1);

  return (
    <Sheet
      open
      onOpenChange={(next) => (next ? null : onClose())}
      dismissible={!pending}
      title="Edit terms"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} pending={pending} pendingLabel="Saving…">
            Save terms
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
        <input type="hidden" name="itemId" value={itemId} />
        {state && !state.ok ? (
          <p role="alert" className="text-sm font-medium text-danger-deep">
            {state.error}
          </p>
        ) : null}
        <Field
          label="Amount owed to the consignor when it sells"
          hint="What we pay the consignor when it sells. It is the cost of the sale."
          required
          error={errors?.agreedAmountOwed?.[0]}
        >
          <NumberInput
            kind="money"
            name="agreedAmountOwed"
            value={agreed}
            onValueChange={setAgreed}
          />
        </Field>
        <Field
          label="Asking price"
          hint="The public, label and sale price."
          error={errors?.askingPrice?.[0]}
        >
          <NumberInput kind="money" name="askingPrice" value={asking} onValueChange={setAsking} />
        </Field>
        {agreedChanged ? (
          <Field
            label="Why is the amount owed changing?"
            hint="Kept in the item's history."
            required
            error={errors?.reason?.[0]}
          >
            <Textarea
              name="reason"
              rows={2}
              maxLength={REASON_MAX_LENGTH}
              defaultValue={values?.reason ?? ""}
            />
          </Field>
        ) : null}
      </form>
    </Sheet>
  );
}

/**
 * "Return to consignor" (manage_consignments; return_consignment_item): a
 * two-step confirmation with a reason, the confirm button in another
 * place with another key and ignoring presses for 400 ms. A quantity item
 * asks from which location and how many (by default all of this item's
 * stock there: D54, another consignor's stock never goes back). The
 * return id is made when the confirmation opens, so a retry returns once.
 */
export function ReturnToConsignorControl({
  itemId,
  shortId,
  unique,
  remaining,
  locations,
}: {
  itemId: string;
  shortId: string;
  unique: boolean;
  /** Quantity items: what the shop still holds. */
  remaining: number;
  /** Quantity items: where this item's stock is (its on-hand per location, D54). */
  locations: { locationId: string; name: string; onHand: number }[];
}) {
  const { toast } = useToast();
  const [confirming, setConfirming] = useState(false);
  const [returnId, setReturnId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const stocked = locations.filter((l) => l.onHand > 0);
  const [locationId, setLocationId] = useState<string | null>(stocked[0]?.locationId ?? null);
  const stockAt = (id: string | null) =>
    Math.min(stocked.find((l) => l.locationId === id)?.onHand ?? remaining, remaining);
  const [quantity, setQuantity] = useState(String(stockAt(stocked[0]?.locationId ?? null)));
  const here = stockAt(locationId);
  const [error, setError] = useState<string | undefined>();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]> | undefined>();
  const [pending, start] = useTransition();
  const openedAt = useRef(0);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const startRef = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);

  useEffect(() => {
    const cancelled = wasConfirming.current && !confirming;
    wasConfirming.current = confirming;
    if (confirming) reasonRef.current?.focus();
    else if (cancelled) startRef.current?.focus();
  }, [confirming]);

  const open = () => {
    openedAt.current = Date.now();
    setReturnId(newId());
    setReason("");
    setError(undefined);
    setFieldErrors(undefined);
    setQuantity(String(here));
    setConfirming(true);
  };

  const confirm = () => {
    if (Date.now() - openedAt.current < CONFIRM_GUARD_MS || !returnId) return;
    const trimmed = reason.trim();
    if (!trimmed) {
      setFieldErrors({ reason: ["Say why it goes back to the consignor."] });
      reasonRef.current?.focus();
      return;
    }
    start(async () => {
      const result = await callAction(() =>
        returnConsignmentItemAction({
          returnId,
          itemId,
          reason: trimmed,
          quantity: unique ? null : quantity,
          locationId: unique ? null : locationId,
        }),
      );
      if (!result.ok) {
        setFieldErrors(result.fieldErrors);
        setError(result.fieldErrors ? undefined : result.error);
        if (result.fieldErrors?.reason) reasonRef.current?.focus();
        return;
      }
      wasConfirming.current = false;
      setConfirming(false);
      toast({
        title: unique
          ? `${shortId} returned to the consignor`
          : `${quantity} returned to the consignor`,
        tone: "success",
      });
    });
  };

  if (!confirming) {
    return (
      <div key="start">
        <Button key="start" ref={startRef} variant="outline" onClick={open}>
          Return to consignor…
        </Button>
      </div>
    );
  }

  return (
    <div key="confirm" className="flex flex-col gap-3 rounded-xl bg-danger-soft p-4">
      <p className="text-sm text-danger-deep">
        {unique
          ? `${shortId} leaves stock and goes back to the consignor. Nothing is owed for it.`
          : "The returned stock leaves the shop. Nothing is owed for it."}
      </p>
      {error ? (
        <p role="alert" className="text-sm font-medium text-danger-deep">
          {error}
        </p>
      ) : null}
      <Field label="Why is it going back?" required error={fieldErrors?.reason?.[0]}>
        <Textarea
          ref={reasonRef}
          rows={2}
          maxLength={REASON_MAX_LENGTH}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </Field>
      {!unique ? (
        <>
          <Field
            label="How many"
            hint={`${here} here, ${remaining} left with the shop.`}
            required
            error={fieldErrors?.quantity?.[0]}
          >
            <NumberInput
              kind="quantity"
              stepper
              minValue={1}
              maxValue={Math.max(here, 1)}
              value={quantity}
              onValueChange={setQuantity}
            />
          </Field>
          {stocked.length > 1 ? (
            <div className="flex flex-col gap-2">
              <span className="font-display text-xs font-bold tracking-wide uppercase">From</span>
              <SegmentedControl
                label="Return from"
                value={locationId ?? undefined}
                onValueChange={(v) => {
                  setLocationId(v);
                  setQuantity(String(stockAt(v)));
                }}
                options={stocked.map((l) => ({
                  value: l.locationId,
                  label: `${l.name} · ${l.onHand}`,
                }))}
              />
            </div>
          ) : stocked[0] ? (
            <p className="text-sm text-dust-700">From {stocked[0].name}.</p>
          ) : null}
          {fieldErrors?.locationId?.[0] ? (
            <p className="text-sm text-danger-deep">{fieldErrors.locationId[0]}</p>
          ) : null}
        </>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          key="cancel"
          variant="outline"
          disabled={pending}
          onClick={() => setConfirming(false)}
        >
          Cancel
        </Button>
        <Button
          key="confirm"
          variant="danger"
          pending={pending}
          pendingLabel="Returning…"
          onClick={confirm}
        >
          {unique ? "Return to consignor" : `Return ${quantity || "0"} to consignor`}
        </Button>
      </div>
    </div>
  );
}

/**
 * "Show payout details" (manage_consignments only, D48): the consignor's
 * bank or PayNow details, fetched on request and shown inline, never in
 * the page's data.
 */
export function PayoutDetailsReveal({ consignorId }: { consignorId: string }) {
  const [details, setDetails] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (details !== undefined) {
    return (
      <div className="flex flex-col gap-1">
        <span className="eyebrow text-dust-500">Payout details</span>
        <p className="break-words whitespace-pre-line">
          {details ?? "No payout details on file. Add them with Edit."}
        </p>
        <div>
          <Button variant="ghost" size="sm" onClick={() => setDetails(undefined)}>
            Hide
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button
          variant="outline"
          size="sm"
          pending={pending}
          pendingLabel="Loading…"
          onClick={() =>
            start(async () => {
              const result = await callAction(() => revealPayoutDetailsAction({ consignorId }));
              if (!result.ok) {
                setError(result.error);
                return;
              }
              setError(null);
              setDetails(result.data);
            })
          }
        >
          Show payout details
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-danger-deep">
          {error}
        </p>
      ) : null}
    </div>
  );
}
