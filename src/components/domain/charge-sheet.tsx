"use client";

import { useActionState, useId, useState } from "react";

import { addChargeAction, voidChargeAction } from "@/app/(staff)/consignment/actions";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { PlusIcon } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Sheet } from "@/components/ui/sheet";
import { useToast } from "@/components/ui/toast";
import { useFocusFirstInvalid } from "@/components/ui/use-focus-invalid";
import type { ActionResult } from "@/lib/actions";
import {
  CHARGE_BEARER_EXPLANATIONS,
  CHARGE_BEARER_LABELS,
  type ChargeBearer,
} from "@/lib/consignment";
import { newId } from "@/lib/uuid";
import { callAction } from "@/lib/call-action";

import { ReasonConfirm } from "./reason-confirm";

type State = ActionResult<null> | null;

/**
 * "Add charge" on a consignment item (manage_consignments): opens ChargeSheet.
 * `shopBlocked` says why the shop cannot bear a charge here (D45: quantity
 * items, or a unit already on a job or sold), or null.
 */
export function AddChargeButton({
  itemId,
  shopBlocked,
}: {
  itemId: string;
  shopBlocked: string | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        icon={<PlusIcon className="size-4" />}
        onClick={() => setOpen(true)}
      >
        Add charge
      </Button>
      {open ? (
        <ChargeSheet itemId={itemId} shopBlocked={shopBlocked} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}

/**
 * A charge on a consignment item (SPEC §13; D4): a description, an amount
 * above 0 and who bears it, chosen explicitly: the bearer control starts
 * with nothing selected and the sheet cannot be submitted until one is
 * chosen. "Consignor pays" is deducted from what the consignor is owed;
 * "Shop pays" adds to the item's cost, lowering yield, and exists only on
 * a single item that is still available (D45). The charge id is made when
 * the sheet opens, so a retry adds one charge.
 */
function ChargeSheet({
  itemId,
  shopBlocked,
  onClose,
}: {
  itemId: string;
  shopBlocked: string | null;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const formId = useId();
  const [chargeId] = useState(newId);
  const [bearer, setBearer] = useState<ChargeBearer | null>(null);
  const [amount, setAmount] = useState("");
  const [state, formAction, pending] = useActionState<State, FormData>(async (prev, formData) => {
    const result = await callAction(() => addChargeAction(prev, formData), formData);
    if (result.ok) {
      toast({ title: "Charge added", tone: "success" });
      onClose();
    }
    return result;
  }, null);
  const formRef = useFocusFirstInvalid(state);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  const values = state && !state.ok ? state.values : undefined;

  return (
    <Sheet
      open
      onOpenChange={(next) => (next ? null : onClose())}
      dismissible={!pending}
      title="Add charge"
      description="Work or costs on this item, such as a service before listing."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={formId}
            pending={pending}
            pendingLabel="Adding…"
            disabled={bearer === null}
          >
            Add charge
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
        <input type="hidden" name="chargeId" value={chargeId} />
        <input type="hidden" name="itemId" value={itemId} />
        {state && !state.ok ? (
          <p role="alert" className="text-sm font-medium text-danger-deep">
            {state.error}
          </p>
        ) : null}
        <Field label="Description" required error={errors?.description?.[0]}>
          <Input name="description" autoComplete="off" defaultValue={values?.description ?? ""} />
        </Field>
        <Field label="Amount" required error={errors?.amount?.[0]}>
          <NumberInput kind="money" name="amount" value={amount} onValueChange={setAmount} />
        </Field>
        <div className="flex flex-col gap-2">
          <span className="font-display text-xs font-bold tracking-wide uppercase">
            Who pays? (required)
          </span>
          <SegmentedControl
            label="Who pays"
            name="bearer"
            value={bearer}
            onValueChange={setBearer}
            options={[
              { value: "consignor", label: CHARGE_BEARER_LABELS.consignor },
              { value: "shop", label: CHARGE_BEARER_LABELS.shop, disabled: shopBlocked !== null },
            ]}
          />
          <ul className="flex flex-col gap-1 text-sm text-dust-700">
            <li>{CHARGE_BEARER_EXPLANATIONS.consignor}</li>
            <li>{CHARGE_BEARER_EXPLANATIONS.shop}</li>
          </ul>
          {shopBlocked ? <p className="text-sm text-dust-500">{shopBlocked}</p> : null}
          {errors?.bearer?.[0] ? (
            <p className="text-sm text-danger-deep">{errors.bearer[0]}</p>
          ) : bearer === null ? (
            <p className="text-sm text-waiting-deep">Choose who pays to add the charge.</p>
          ) : null}
        </div>
      </form>
    </Sheet>
  );
}

/** Void a charge with a reason (two steps, ReasonConfirm). */
export function VoidChargeControl({
  chargeId,
  description,
}: {
  chargeId: string;
  description: string;
}) {
  return (
    <ReasonConfirm
      startLabel="Void…"
      startAccessibleName={`Void… the charge ${description}`}
      startSize="sm"
      question={`Why are you voiding ${description}?`}
      confirmLabel="Void charge"
      pendingLabel="Voiding…"
      failureTitle="Charge not voided"
      successTitle={`${description} voided`}
      onConfirm={(reason) => voidChargeAction({ chargeId, reason })}
    >
      The charge stays in the history, struck through. A consignor-paid charge no longer comes off
      what they are owed; a shop-paid one no longer adds to the cost.
    </ReasonConfirm>
  );
}
