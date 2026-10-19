"use client";

import { useActionState, useId, useState } from "react";

import { transferStock } from "@/app/(staff)/inventory/actions";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { NumberInput } from "@/components/ui/number-input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Sheet } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { useFocusFirstInvalid } from "@/components/ui/use-focus-invalid";
import type { ActionResult } from "@/lib/actions";
import { signedQuantity } from "@/lib/inventory";
import { REASON_MAX_LENGTH } from "@/lib/reasons";
import { newId } from "@/lib/uuid";
import { callAction } from "@/lib/call-action";

import type { SheetLocation } from "./adjust-stock-sheet";

type State = ActionResult<null> | null;

const plain = (n: number) => signedQuantity(n).replace(/^\+/, "");

/**
 * What moves: counted stock of a product (choose how many), or one unique
 * unit (fixed, from its own location).
 */
export type TransferSubject =
  | { kind: "product"; productId: string; name: string; stock: SheetLocation[] }
  | {
      kind: "unit";
      productId: string;
      unitId: string;
      name: string;
      fromLocationId: string;
      locations: SheetLocation[];
    };

/** "Transfer" (manage_inventory): opens StockTransferSheet. */
export function StockTransferButton({
  subject,
  disabled = false,
}: {
  subject: TransferSubject;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" size="sm" disabled={disabled} onClick={() => setOpen(true)}>
        Transfer
      </Button>
      {open ? <StockTransferSheet subject={subject} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/**
 * Move stock between active locations (SPEC §12; transfer_stock writes two
 * linked rows, out and in, with the same request id): From, To, how many
 * (or the unit) and an optional reason. Never below zero at From
 * (insufficient_stock). The request id made when the sheet opens makes a
 * retry move once. Not the bike ownership transfer (transfer-sheet.tsx).
 */
function StockTransferSheet({
  subject,
  onClose,
}: {
  subject: TransferSubject;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const formId = useId();
  const [requestId] = useState(newId);
  const locations = (subject.kind === "product" ? subject.stock : subject.locations).filter(
    (l) => l.active,
  );
  const sources =
    subject.kind === "product"
      ? locations.filter((l) => l.onHand > 0)
      : locations.filter((l) => l.locationId === subject.fromLocationId);
  const [from, setFrom] = useState(sources[0]?.locationId ?? "");
  const targets = locations.filter((l) => l.locationId !== from);
  const [to, setTo] = useState(targets[0]?.locationId ?? "");
  const [quantity, setQuantity] = useState("1");
  const fromLocation = locations.find((l) => l.locationId === from);
  const toLocation = locations.find((l) => l.locationId === to);
  const [state, formAction, pending] = useActionState<State, FormData>(async (prev, formData) => {
    const result = await callAction(() => transferStock(prev, formData), formData);
    if (result.ok) {
      toast({
        title:
          subject.kind === "unit"
            ? `Moved to ${toLocation?.name ?? "the new location"}`
            : `Moved ${formData.get("quantity")} to ${toLocation?.name ?? "the new location"}`,
        tone: "success",
      });
      onClose();
    }
    return result;
  }, null);
  const formRef = useFocusFirstInvalid(state);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  const values = state && !state.ok ? state.values : undefined;
  const qty = /^\d+$/.test(quantity.trim()) ? Number(quantity) : null;
  const tooMany =
    subject.kind === "product" && fromLocation && qty !== null && qty > fromLocation.onHand;
  const possible = sources.length > 0 && locations.length > 1;

  return (
    <Sheet
      open
      onOpenChange={(next) => (next ? null : onClose())}
      dismissible={!pending}
      title="Transfer stock"
      description={subject.name}
      footer={
        possible ? (
          <>
            <Button variant="outline" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button
              type="submit"
              form={formId}
              pending={pending}
              pendingLabel="Moving…"
              disabled={!to || tooMany === true}
            >
              Move stock
            </Button>
          </>
        ) : undefined
      }
    >
      {!possible ? (
        <p className="text-dust-700">
          {locations.length < 2
            ? "Stock moves between two active locations, and there is only one."
            : "There is no stock to move."}
        </p>
      ) : (
        <form
          id={formId}
          ref={formRef}
          action={formAction}
          className="flex flex-col gap-5"
          noValidate
        >
          <input type="hidden" name="requestId" value={requestId} />
          <input type="hidden" name="productId" value={subject.productId} />
          {subject.kind === "unit" ? (
            <>
              <input type="hidden" name="unitId" value={subject.unitId} />
              <input type="hidden" name="quantity" value="1" />
            </>
          ) : null}
          {state && !state.ok ? (
            <p role="alert" className="text-sm font-medium text-danger-deep">
              {state.error}
            </p>
          ) : null}
          <div className="flex flex-col gap-2">
            <span className="font-display text-xs font-bold tracking-wide uppercase">From</span>
            <SegmentedControl
              label="From"
              name="fromLocationId"
              value={from}
              onValueChange={(next) => {
                setFrom(next);
                if (next === to)
                  setTo(locations.find((l) => l.locationId !== next)?.locationId ?? "");
              }}
              options={sources.map((l) => ({
                value: l.locationId,
                label: subject.kind === "product" ? `${l.name} · ${plain(l.onHand)}` : l.name,
              }))}
            />
          </div>
          <div className="flex flex-col gap-2">
            <span className="font-display text-xs font-bold tracking-wide uppercase">To</span>
            <SegmentedControl
              label="To"
              name="toLocationId"
              value={to}
              onValueChange={setTo}
              options={targets.map((l) => ({ value: l.locationId, label: l.name }))}
            />
            {errors?.toLocationId?.[0] ? (
              <p className="text-sm text-danger-deep">{errors.toLocationId[0]}</p>
            ) : null}
          </div>
          {subject.kind === "product" ? (
            <Field
              label="Quantity"
              error={
                errors?.quantity?.[0] ??
                (tooMany ? `${fromLocation?.name} has ${fromLocation?.onHand}.` : undefined)
              }
              required
            >
              <NumberInput
                kind="quantity"
                name="quantity"
                stepper
                minValue={1}
                maxValue={Math.max(1, fromLocation?.onHand ?? 1)}
                value={quantity}
                onValueChange={setQuantity}
              />
            </Field>
          ) : null}
          <Field
            label="Reason"
            hint="Optional. Kept in the stock history."
            error={errors?.reason?.[0]}
          >
            <Textarea
              name="reason"
              rows={2}
              maxLength={REASON_MAX_LENGTH}
              defaultValue={values?.reason ?? ""}
            />
          </Field>
        </form>
      )}
    </Sheet>
  );
}
