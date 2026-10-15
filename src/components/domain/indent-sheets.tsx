"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";

import {
  cancelPartRequestAction,
  fitPartBoughtOutsideAction,
  fitPartRequestAction,
} from "@/app/(staff)/jobs/indent-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Sheet } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import type { ActionResult } from "@/lib/actions";
import type { PartRequest } from "@/lib/domain/indent";
import {
  BACK_IN_STOCK_NOTE,
  COST_MISSING_BUY_NOTE,
  COST_MISSING_NOTE,
  COST_MISSING_SWITCH_NOTE,
  COST_SET_ON_RECEIPT_NOTE,
  canBuyOutside,
  neverOrderedNote,
} from "@/lib/indent";
import { formatMoney, formatQuantity, parseMoney } from "@/lib/money";
import { DEPOSIT_STATE_LABELS, DEPOSIT_STATE_TONES, type DepositState } from "@/lib/payments";
import { newId } from "@/lib/uuid";

/**
 * The indent sheets the Indent parts card and the settle checklist share
 * (Phase 13, D146, D149, D149a): Fit (from stock, or bought outside BICII)
 * and Cancel, plus the deposit badge of an approved or ordered part.
 */

type Errors = Record<string, string[]> | undefined;
const errorsOf = (r: ActionResult<unknown> | null): Errors =>
  r && !r.ok ? r.fieldErrors : undefined;

/**
 * "Deposit due", "Being confirmed" or "Deposit refunded" on an approved or
 * ordered part (D152); "Deposit paid" too with `showPaid`, where the money
 * is held for a part not on the bill (R-082) or about to be settled before
 * the job closes (D149b).
 */
export function DepositBadge({
  request,
  depositByRequest,
  showPaid = false,
}: {
  request: PartRequest;
  depositByRequest: ReadonlyMap<string, DepositState>;
  showPaid?: boolean;
}) {
  if (request.kind !== "part" || (request.status !== "approved" && request.status !== "ordered"))
    return null;
  const state = depositByRequest.get(request.id);
  if (state === undefined || state === "none" || (state === "paid" && !showPaid)) return null;
  return <Badge tone={DEPOSIT_STATE_TONES[state]}>{DEPOSIT_STATE_LABELS[state]}</Badge>;
}

type Source = "stock" | "outside";

/**
 * Put an approved or ordered item on the job as an ordinary line (D146).
 * For a part it warns before the fit: an order not received yet, a part
 * never ordered in BICII (it comes out of the default location's stock,
 * which may go below zero, D23), and, for cost holders, a product with no
 * cost (D24: Fit from stock is refused with part_cost_missing).
 *
 * D149a: for an approved part never ordered in BICII, staff with View
 * costs or Manage purchasing (`purchaseData`) may choose "Bought outside
 * BICII" instead: they enter what the shop paid for one (prefilled with
 * the expected cost, D147) and where it was bought; BICII records the
 * purchase at that cost and fits the part in one step at the default
 * location, so the stock count there does not change, and the cost becomes
 * the product's cost (D149c(4)). A From stock fit refused for a missing
 * cost switches to it. A part bought outside BICII whose line was voided
 * (D160) is back in stock, so the sheet says to fit it from stock.
 */
export function FitSheet({
  request,
  locationName,
  purchaseData = false,
  onClose,
}: {
  request: PartRequest;
  locationName: string | null;
  /** View costs or Manage purchasing (D60, D147, D149c(3)). */
  purchaseData?: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const router = useRouter();
  const [lineId] = useState(newId);
  const canBuy = canBuyOutside(request, purchaseData);
  const [source, setSource] = useState<Source>("stock");
  const expected = request.purchase?.expectedUnitCost ?? null;
  const [cost, setCost] = useState(expected ?? "");
  const [reference, setReference] = useState("");
  const [switchNote, setSwitchNote] = useState<string | null>(null);
  const costRef = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<ActionResult<{ lineId: string }> | null>(null);
  const [pending, start] = useTransition();
  const errors = errorsOf(result);
  const outside = canBuy && source === "outside";
  const notArrived = request.kind === "part" && request.order !== null && !request.order.arrived;
  const neverOrdered = request.kind === "part" && request.order === null;
  const costMissing = request.kind === "part" && request.costMissing === true;
  const parsedCost = parseMoney(cost);
  const costTotal =
    outside && parsedCost !== null
      ? formatMoney(parsedCost.times(request.quantity), request.currency)
      : null;
  const where = locationName ?? "the default location";

  const submit = () =>
    start(async () => {
      if (outside) {
        const r = await fitPartBoughtOutsideAction({
          requestId: request.id,
          lineId,
          unitCost: cost,
          locationId: "",
          reference,
        });
        setResult(r);
        if (r.ok) {
          toast({
            title: `${request.description} is on the job (bought outside BICII).`,
            tone: "success",
          });
          onClose();
        } else if (r.code === "part_request_ordered" || r.code === "part_request_not_approved") {
          router.refresh();
        }
        return;
      }
      const r = await fitPartRequestAction({
        requestId: request.id,
        lineId,
        locationId: request.order?.arrived ? (request.order.locationId ?? "") : "",
      });
      if (!r.ok && r.code === "part_cost_missing") {
        if (canBuy) {
          // Offer the purchase instead: what the shop paid becomes the cost.
          setResult(null);
          setSource("outside");
          setSwitchNote(COST_MISSING_SWITCH_NOTE);
          requestAnimationFrame(() => costRef.current?.focus());
          return;
        }
        setResult({ ...r, error: request.order ? COST_SET_ON_RECEIPT_NOTE : r.error });
        return;
      }
      setResult(r);
      if (r.ok) {
        toast({ title: `${request.description} is on the job.`, tone: "success" });
        onClose();
      }
    });

  return (
    <Sheet
      open
      onOpenChange={(next) => (next ? null : onClose())}
      dismissible={!pending}
      title={request.kind === "service" ? "Add to job" : "Fit part"}
      description={
        request.kind === "service"
          ? "Adds the service to the job's lines at the quoted price."
          : outside
            ? "Records the purchase and adds the part to the job's lines at the quoted price."
            : "Adds the part to the job's lines at the quoted price and takes it out of stock."
      }
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            pending={pending}
            pendingLabel={outside ? "Recording…" : "Adding…"}
            disabled={!outside && costMissing}
          >
            {outside ? "Record and fit" : request.kind === "service" ? "Add to job" : "Fit part"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {result && !result.ok && !errors?.unitCost && !errors?.reference ? (
          <p role="alert" className="text-sm font-medium text-danger-deep">
            {result.error}
          </p>
        ) : null}
        <p>
          {formatQuantity(request.quantity)} × {request.description} at{" "}
          {formatMoney(request.unitSalePrice, request.currency)} ={" "}
          <strong>{formatMoney(request.lineTotal, request.currency)}</strong>
        </p>
        {canBuy ? (
          <div className="flex flex-col gap-2">
            <span className="font-display text-xs font-bold tracking-wide uppercase">
              Where it comes from
            </span>
            <SegmentedControl<Source>
              label="Where it comes from"
              name="source"
              value={source}
              onValueChange={(v) => {
                setSource(v);
                setResult(null);
              }}
              options={[
                { value: "stock", label: "From stock" },
                { value: "outside", label: "Bought outside BICII" },
              ]}
            />
          </div>
        ) : null}
        {outside ? (
          <>
            {switchNote ? (
              <p role="status" className="rounded-xl bg-waiting-soft p-3 text-sm text-waiting-deep">
                {switchNote}
              </p>
            ) : null}
            <Field
              label="Cost each"
              hint={`What the shop paid for one, from the receipt. It becomes this product's cost.${
                expected
                  ? ` Expected when proposed: ${formatMoney(expected, request.currency)}.`
                  : ""
              }`}
              error={errors?.unitCost?.[0]}
              required
            >
              <NumberInput ref={costRef} kind="money" value={cost} onValueChange={setCost} />
            </Field>
            <Field
              label="Bought from"
              hint="Optional. Shop and receipt number, for example Bike Hub receipt 4471. Not the price."
              error={errors?.reference?.[0]}
            >
              <Input
                value={reference}
                maxLength={100}
                onChange={(e) => setReference(e.target.value)}
              />
            </Field>
            <p className="text-sm text-dust-700">
              Records {formatQuantity(request.quantity)} × {request.description} as bought outside
              BICII at {where} and fits it now. The stock count there doesn&apos;t change, and the
              job&apos;s yield uses this cost.
            </p>
            {costTotal ? (
              <p className="text-sm font-semibold tabular-nums">
                Cost {formatQuantity(request.quantity)} ×{" "}
                {formatMoney(parsedCost!, request.currency)} = {costTotal}
              </p>
            ) : null}
          </>
        ) : (
          <>
            {costMissing ? (
              <p role="alert" className="rounded-xl bg-danger-soft p-3 text-sm text-danger-deep">
                {canBuy ? COST_MISSING_BUY_NOTE : COST_MISSING_NOTE}{" "}
                {request.productId ? (
                  <a href={`/products/${request.productId}`} className="font-medium underline">
                    Open the product
                  </a>
                ) : null}
              </p>
            ) : null}
            {notArrived ? (
              <p role="status" className="rounded-xl bg-waiting-soft p-3 text-sm text-waiting-deep">
                Its order ({request.order!.poNumber}) has not been received yet. Fitting it now may
                take the stock count below zero.
              </p>
            ) : null}
            {neverOrdered ? (
              <p role="status" className="rounded-xl bg-waiting-soft p-3 text-sm text-waiting-deep">
                {request.unfitted?.boughtOutside
                  ? BACK_IN_STOCK_NOTE
                  : neverOrderedNote(locationName, canBuy)}
              </p>
            ) : null}
          </>
        )}
      </div>
    </Sheet>
  );
}

/**
 * Cancel a proposed, answered or ordered item, with a reason; on a collected
 * or cancelled job (`closed`, admins and managers only, D149) it also says
 * to refund any deposit in Stripe.
 */
export function CancelSheet({
  request,
  closed,
  onClose,
}: {
  request: PartRequest;
  closed: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [reason, setReason] = useState("");
  const [result, setResult] = useState<ActionResult<null> | null>(null);
  const [pending, start] = useTransition();
  const errors = errorsOf(result);

  const submit = () =>
    start(async () => {
      const r = await cancelPartRequestAction({ requestId: request.id, reason });
      setResult(r);
      if (r.ok) {
        toast({
          title:
            request.status === "quoted"
              ? `${request.description} cancelled. The quote was withdrawn.`
              : `${request.description} cancelled.`,
          tone: "success",
        });
        onClose();
      }
    });

  return (
    <Sheet
      open
      onOpenChange={(next) => (next ? null : onClose())}
      dismissible={!pending}
      title={`Cancel ${request.description}`}
      description={
        (request.status === "ordered"
          ? "It stays on its purchase order: change the order in Purchasing if needed."
          : request.status === "quoted"
            ? "It is on the quote the customer can no longer answer: cancelling it withdraws that quote (its link stops working) and its other items go back to Proposed. The reason is kept in the timeline."
            : "It is removed from the proposed items. The reason is kept in the timeline.") +
        (closed ? " The job is closed and stays closed; refund any deposit for it in Stripe." : "")
      }
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Back
          </Button>
          <Button variant="danger" onClick={submit} pending={pending} pendingLabel="Cancelling…">
            Cancel item
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {result && !result.ok && !errors ? (
          <p role="alert" className="text-sm font-medium text-danger-deep">
            {result.error}
          </p>
        ) : null}
        <Field label="Reason" error={errors?.reason?.[0]} required>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
        </Field>
      </div>
    </Sheet>
  );
}
