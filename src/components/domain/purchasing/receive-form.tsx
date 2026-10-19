"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useReducer, useRef, useState } from "react";

import { lookupReceipt, receivePurchase } from "@/app/(staff)/purchasing/actions";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field } from "@/components/ui/field";
import { AlertIcon, CheckIcon } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Select } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { toShopLocal } from "@/lib/dates";
import type { PurchaseOrderStatus } from "@/lib/purchasing";
import { formatMoney } from "@/lib/money";
import {
  RECEIVE_INTO_KEY,
  buildReceiptLines,
  checkCost,
  checkQuantity,
  clampQuantity,
  clearReceiveDraft,
  costDiffers,
  defaultValues,
  duplicateReference,
  duplicateWarning,
  initialReceiveState,
  isEditable,
  itemsText,
  loadReceiveDraft,
  mergeValues,
  receiveReducer,
  receiveTotals,
  receivedAtBounds,
  receivedAtForSubmit,
  saveReceiveDraft,
  setAllQuantities,
  whenText,
  type ReceiptSummary,
  type ReceiveLineDef,
  type ReceiveValues,
  type RecordedReference,
} from "@/lib/receive-form";
import { newId } from "@/lib/uuid";
import { callAction } from "@/lib/call-action";

import { ShortIdLink } from "../short-id";
import { NewPurchaseOrderButton } from "./purchase-order-sheet";

export type ReceiveFormOrder = {
  id: string;
  poNumber: string;
  status: PurchaseOrderStatus;
  currency: string;
  submittedAt: string | null;
  supplier: { id: string; name: string; archived: boolean };
};

export type ReceiveFormLineProps = {
  id: string;
  product: { id: string; shortId: string; name: string; sku: string | null };
  ordered: number;
  received: number;
  outstanding: number;
  onHand: number;
  unitCost: string | null;
};

const SLOW_MS = 20_000;
const UNKNOWN_TOAST = "receive-unknown-outcome";

function readReceiveInto(ids: readonly string[]): string | null {
  try {
    const v = window.localStorage.getItem(RECEIVE_INTO_KEY);
    return v && ids.includes(v) ? v : null;
  } catch {
    return null;
  }
}

function rememberReceiveInto(id: string) {
  try {
    window.localStorage.setItem(RECEIVE_INTO_KEY, id);
  } catch {
    // A convenience only.
  }
}

/**
 * The Receive screen's form (SPEC §2, §14, §22; PLAN D63, D64, D65): one
 * controlled client component (never a form action, so nothing typed is
 * reset) running the idempotency state machine in src/lib/receive-form.ts.
 * The key is made when the form first mounts and kept in sessionStorage
 * with the values; an unknown outcome locks the form until
 * purchase_receipt_by_key says whether the delivery was recorded; a fresh
 * key comes only with fresh values ("Receive another delivery"). See
 * DESIGN.md "ReceiveForm".
 */
export function ReceiveForm({
  order,
  lines,
  locations,
  defaultLocationId,
  references,
  serverNow,
}: {
  order: ReceiveFormOrder;
  lines: ReceiveFormLineProps[];
  locations: { id: string; name: string }[];
  defaultLocationId: string | null;
  references: RecordedReference[];
  /** The server's render time: the first value of the date-time input. */
  serverNow: string;
}) {
  const router = useRouter();
  const { toast, dismiss } = useToast();
  const uid = useId();
  const currency = order.currency;
  const money = (v: string | number) => formatMoney(v, currency);
  const symbol = money(0).replace(/[\d.,\s ]/g, "") || "$";

  const defs: ReceiveLineDef[] = lines.map((l) => ({
    id: l.id,
    outstanding: l.outstanding,
    unitCost: l.unitCost ?? "0.00",
  }));
  const fallbackLocation = defaultLocationId ?? locations[0]?.id ?? "";

  const [state, dispatch] = useReducer(
    receiveReducer,
    defaultValues(defs, fallbackLocation),
    initialReceiveState,
  );
  // The latest state for the async handlers (they outlive the render they started in).
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });
  const inFlight = useRef(false);
  const [clock, setClock] = useState(() => new Date(serverNow));

  // The clock behind the date-time input's "now" and its max.
  useEffect(() => {
    const tick = () => setClock(new Date());
    const first = window.setTimeout(tick, 0);
    const t = window.setInterval(tick, 30_000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(t);
    };
  }, []);

  const check = useCallback(
    async (key: string) => {
      try {
        const result = await callAction(() => lookupReceipt({ idempotencyKey: key }));
        if (!result.ok) {
          dispatch({ type: "lookupFailed" });
          return;
        }
        // The "could not confirm" toast has done its job: the answer is on the page.
        dismiss(UNKNOWN_TOAST);
        if (result.data) {
          clearReceiveDraft(order.id);
          dispatch({ type: "found", receipt: result.data });
          router.refresh();
        } else {
          saveReceiveDraft(order.id, { key, values: stateRef.current.values, pending: false });
          dispatch({ type: "notFound" });
        }
      } catch {
        dispatch({ type: "lookupFailed" });
      }
    },
    [order.id, router, dismiss],
  );

  // Mount: a stored key (pending or not) is checked before anything is
  // editable; otherwise a new key.
  useEffect(() => {
    const stored = loadReceiveDraft(order.id);
    const into =
      readReceiveInto(locations.map((l) => l.id)) ?? defaultLocationId ?? locations[0]?.id ?? "";
    if (stored) {
      dispatch({
        type: "resume",
        key: stored.key,
        values: mergeValues(defs, stored.values, into),
        pending: stored.pending,
      });
      void check(stored.key);
    } else {
      dispatch({ type: "start", key: newId(), values: defaultValues(defs, into) });
    }
    // Once, on mount: later prop changes (refresh) must not restart the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the key and what is typed across a reload, while editable.
  useEffect(() => {
    if (isEditable(state.phase) && state.key) {
      saveReceiveDraft(order.id, { key: state.key, values: state.values, pending: false });
    }
  }, [order.id, state.phase, state.key, state.values]);

  const editable = isEditable(state.phase);
  const values = state.values;
  const setValues = (next: ReceiveValues) => dispatch({ type: "edit", values: next });
  const setLine = (id: string, patch: Partial<ReceiveValues["lines"][string]>) =>
    setValues({ ...values, lines: { ...values.lines, [id]: { ...values.lines[id], ...patch } } });

  const totals = receiveTotals(defs, values, currency);
  const built = buildReceiptLines(defs, values, currency);
  const receivedAt = receivedAtForSubmit(values);
  const bounds = receivedAtBounds(clock, order.submittedAt);
  const duplicate = duplicateReference(values.reference, references);
  const guardOk = !duplicate || values.differentDelivery;
  const canCommit =
    editable &&
    state.key !== null &&
    totals.items > 0 &&
    built.ok &&
    receivedAt !== null &&
    guardOk &&
    values.receiveInto !== "";

  async function submit() {
    const s = stateRef.current;
    if (inFlight.current || !isEditable(s.phase) || !s.key) return;
    const b = buildReceiptLines(defs, s.values, currency);
    const at = receivedAtForSubmit(s.values);
    if (!b.ok || b.lines.length === 0 || at === null) return;
    if (duplicateReference(s.values.reference, references) && !s.values.differentDelivery) return;
    inFlight.current = true;
    const key = s.key;
    saveReceiveDraft(order.id, { key, values: s.values, pending: true });
    dispatch({ type: "submit" });
    const slow = window.setTimeout(() => dispatch({ type: "slow" }), SLOW_MS);
    let result: Awaited<ReturnType<typeof receivePurchase>>;
    try {
      result = await receivePurchase({
        purchaseOrderId: order.id,
        idempotencyKey: key,
        reference: s.values.reference,
        receivedAt: at ?? null,
        notes: s.values.notes,
        lines: b.lines,
      });
    } catch {
      result = { ok: false, error: "" };
    } finally {
      window.clearTimeout(slow);
      inFlight.current = false;
    }
    if (result.ok) {
      clearReceiveDraft(order.id);
      dispatch({ type: "succeeded" });
      const { unitsReceived, outstandingAfter, status } = result.data;
      toast({
        title:
          status === "received"
            ? "Order fully received."
            : `Received ${itemsText(unitsReceived)}. ${outstandingAfter} still to come.`,
        tone: "success",
      });
      router.push(`/purchasing/orders/${order.id}`);
      return;
    }
    if (result.code === "purchase_receipt_key_reused") {
      // A submission under this key WAS committed: show it, never re-key.
      dispatch({ type: "keyReused" });
      void check(key);
      return;
    }
    if (result.code || result.fieldErrors) {
      // The server answered: nothing was written under the key.
      saveReceiveDraft(order.id, { key, values: s.values, pending: false });
      dispatch({ type: "refused", code: result.code, message: result.error });
      if (result.code === "purchase_over_receipt" || result.code === "purchase_order_closed") {
        router.refresh();
      }
      return;
    }
    // Thrown, aborted or an unexplained failure: it may have committed.
    toast({
      title: "We could not confirm the receipt. Checking whether it was recorded…",
      tone: "error",
      key: UNKNOWN_TOAST,
    });
    dispatch({ type: "unknown" });
    void check(key);
  }

  function receiveAnother() {
    const into = values.receiveInto || fallbackLocation;
    dispatch({ type: "receiveAnother", key: newId(), values: defaultValues(defs, into) });
  }

  // ---- Closed orders ------------------------------------------------------
  const closedOnLoad =
    (order.status === "received" || order.status === "cancelled") &&
    (state.phase === "starting" || state.phase === "editing");
  if (state.phase === "closed" || closedOnLoad) {
    return <ClosedOrder order={order} />;
  }

  // ---- Recorded -----------------------------------------------------------
  if (state.phase === "recorded" && state.recorded) {
    return (
      <RecordedBanner
        receipt={state.recorded}
        orderId={order.id}
        poNumber={order.poNumber}
        canReceiveMore={lines.length > 0 && order.status !== "received"}
        onReceiveAnother={receiveAnother}
      />
    );
  }

  if (lines.length === 0 && state.phase !== "checking" && state.phase !== "starting") {
    return (
      <p className="rounded-2xl bg-info-soft p-4 text-info-deep">
        Nothing is still to come on this order.{" "}
        <Link href={`/purchasing/orders/${order.id}`} className="font-semibold underline">
          Back to {order.poNumber}
        </Link>
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4 pb-4">
      {state.phase === "checking" ? (
        <div
          role="status"
          className="flex flex-col gap-3 rounded-2xl bg-waiting-soft p-4 text-waiting-deep"
        >
          {state.lookupFailed ? (
            <>
              <p className="font-medium">
                We could not check whether this delivery was recorded. Nothing can be changed until
                we know.
              </p>
              <div>
                <Button
                  variant="outline"
                  onClick={() => {
                    dispatch({ type: "checkAgain" });
                    if (state.key) void check(state.key);
                  }}
                >
                  Check again
                </Button>
              </div>
            </>
          ) : (
            <p className="flex items-center gap-2 font-medium">
              <Spinner className="size-4" />
              Checking whether this delivery was recorded…
            </p>
          )}
        </div>
      ) : null}

      {state.phase === "notRecorded" ? (
        <div
          role="status"
          className="flex flex-col gap-3 rounded-2xl bg-info-soft p-4 text-info-deep sm:flex-row sm:items-center sm:justify-between"
        >
          <p className="font-medium">
            It was not recorded. Retrying is safe: it will not be received twice.
          </p>
          <Button onClick={submit} disabled={!canCommit}>
            Retry
          </Button>
        </div>
      ) : null}

      {state.error ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-2xl bg-danger-soft p-4 font-medium text-danger-deep"
        >
          <AlertIcon className="mt-0.5 size-5 shrink-0" />
          {state.error}
        </p>
      ) : null}

      <section
        aria-labelledby={`${uid}-lines`}
        className="flex flex-col gap-3 rounded-2xl border border-hairline bg-card p-4 sm:p-5"
      >
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 id={`${uid}-lines`} className="text-xl leading-tight">
            What arrived
          </h2>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!editable}
              onClick={() => setValues(setAllQuantities(values, defs, "outstanding"))}
            >
              All to come
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!editable}
              onClick={() => setValues(setAllQuantities(values, defs, "zero"))}
            >
              Clear all
            </Button>
          </div>
        </div>
        <Field label="Receive into" hint="Each line can go somewhere else." className="max-w-sm">
          <Select
            value={values.receiveInto}
            disabled={!editable}
            onChange={(e) => {
              rememberReceiveInto(e.target.value);
              setValues({ ...values, receiveInto: e.target.value });
            }}
          >
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        </Field>

        <div className="@container">
          <div
            aria-hidden="true"
            className="hidden px-4 pb-1 text-dense font-semibold text-dust-700 @4xl:grid @4xl:grid-cols-[minmax(0,1fr)_4rem_4.5rem_4rem_13rem_9rem_10rem] @4xl:gap-3"
          >
            <span>Product</span>
            <span className="text-right">Ordered</span>
            <span className="text-right">Received</span>
            <span className="text-right">To come</span>
            <span>Receive now</span>
            <span>Unit cost</span>
            <span>Location</span>
          </div>
          <ul aria-label="Lines to receive" className="flex flex-col gap-3">
            {lines.map((l) => {
              const v = values.lines[l.id] ?? {
                quantity: "0",
                unitCost: l.unitCost ?? "0.00",
                locationId: null,
              };
              const q = checkQuantity(v.quantity, l.outstanding);
              const c = checkCost(v.unitCost, currency);
              const zero = q.ok && q.quantity === 0;
              const poCost = l.unitCost ?? "0.00";
              const nameId = `${uid}-${l.id}-name`;
              return (
                <li
                  key={l.id}
                  role="group"
                  aria-labelledby={nameId}
                  className={cn(
                    "grid gap-3 rounded-2xl border border-hairline p-4 transition-opacity @4xl:grid-cols-[minmax(0,1fr)_4rem_4.5rem_4rem_13rem_9rem_10rem] @4xl:items-start",
                    zero && "opacity-60",
                  )}
                >
                  <div className="flex min-w-0 flex-col gap-1">
                    <span id={nameId} className="font-medium break-words">
                      {l.product.name}
                    </span>
                    <span className="flex flex-wrap items-center gap-2 text-dense text-dust-500">
                      <ShortIdLink href={`/products/${l.product.id}`} value={l.product.shortId} />
                      {l.product.sku ? <span className="font-mono">{l.product.sku}</span> : null}
                      <span className="tabular-nums">On hand {l.onHand}</span>
                    </span>
                  </div>
                  <dl className="grid grid-cols-3 gap-2 text-dense tabular-nums @4xl:contents">
                    <div className="flex flex-col @4xl:text-right">
                      <dt className="text-dust-500 @4xl:sr-only">Ordered</dt>
                      <dd className="font-semibold @4xl:pt-3">{l.ordered}</dd>
                    </div>
                    <div className="flex flex-col @4xl:text-right">
                      <dt className="text-dust-500 @4xl:sr-only">Received</dt>
                      <dd className="font-semibold @4xl:pt-3">{l.received}</dd>
                    </div>
                    <div className="flex flex-col @4xl:text-right">
                      <dt className="text-dust-500 @4xl:sr-only">To come</dt>
                      <dd className="font-semibold @4xl:pt-3">{l.outstanding}</dd>
                    </div>
                  </dl>
                  <Field
                    label={<span className="@4xl:sr-only">Receive now</span>}
                    error={!q.ok ? q.message : undefined}
                  >
                    <NumberInput
                      kind="quantity"
                      stepper
                      minValue={0}
                      maxValue={l.outstanding}
                      value={v.quantity}
                      disabled={!editable}
                      onValueChange={(text) => setLine(l.id, { quantity: text })}
                      onBlur={() => {
                        // A typed value beyond the bounds keeps its message;
                        // only a negative or fractional one is tidied.
                        const n = Number(v.quantity);
                        if (v.quantity.trim() !== "" && Number.isFinite(n) && n < 0) {
                          setLine(l.id, { quantity: String(clampQuantity(n, l.outstanding)) });
                        }
                      }}
                    />
                  </Field>
                  <Field
                    label={<span className="@4xl:sr-only">Actual unit cost</span>}
                    hint={
                      <span className="flex flex-wrap items-center gap-1.5">
                        Ordered at {money(poCost)}
                        {costDiffers(v.unitCost, poCost, currency) ? <Badge>Differs</Badge> : null}
                      </span>
                    }
                    error={!zero && !c.ok ? c.message : undefined}
                  >
                    <NumberInput
                      kind="money"
                      currencySymbol={symbol}
                      value={v.unitCost}
                      disabled={!editable}
                      onValueChange={(text) => setLine(l.id, { unitCost: text })}
                    />
                  </Field>
                  <Field label={<span className="@4xl:sr-only">Location</span>}>
                    <Select
                      value={v.locationId ?? values.receiveInto}
                      disabled={!editable}
                      onChange={(e) =>
                        setLine(l.id, {
                          locationId: e.target.value === values.receiveInto ? null : e.target.value,
                        })
                      }
                    >
                      {locations.map((loc) => (
                        <option key={loc.id} value={loc.id}>
                          {loc.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </li>
              );
            })}
          </ul>
        </div>
      </section>

      <section
        aria-labelledby={`${uid}-delivery`}
        className="flex flex-col gap-4 rounded-2xl border border-hairline bg-card p-4 sm:p-5"
      >
        <h2 id={`${uid}-delivery`} className="text-xl leading-tight">
          Delivery
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <Field label="Delivery note reference" hint="As printed on the supplier's note">
              <Input
                value={values.reference}
                maxLength={100}
                autoComplete="off"
                disabled={!editable}
                onChange={(e) =>
                  setValues({ ...values, reference: e.target.value, differentDelivery: false })
                }
              />
            </Field>
            {duplicate ? (
              <div className="flex flex-col gap-1 rounded-xl bg-waiting-soft p-3 text-waiting-deep">
                <p role="alert" className="font-medium">
                  {duplicateWarning(duplicate, clock)}
                </p>
                <Checkbox
                  label="This is a different delivery"
                  checked={values.differentDelivery}
                  disabled={!editable}
                  onChange={(e) => setValues({ ...values, differentDelivery: e.target.checked })}
                />
              </div>
            ) : null}
          </div>
          <Field
            label="Received"
            hint={
              values.receivedAtChanged
                ? "Back-dated deliveries: up to 30 days, not before the order was submitted."
                : "Now, unless you change it."
            }
            error={
              state.receivedAtError ??
              (receivedAt === null ? "Enter the delivery date and time." : undefined)
            }
          >
            <Input
              type="datetime-local"
              value={values.receivedAtChanged ? values.receivedAt : toShopLocal(clock)}
              min={bounds.min}
              max={bounds.max}
              disabled={!editable}
              onChange={(e) =>
                setValues({ ...values, receivedAt: e.target.value, receivedAtChanged: true })
              }
            />
          </Field>
        </div>
        <Field label="Notes">
          <Textarea
            rows={2}
            value={values.notes}
            maxLength={2000}
            disabled={!editable}
            onChange={(e) => setValues({ ...values, notes: e.target.value })}
          />
        </Field>
      </section>

      {/* One row at every width (a two-row footer hid the first line's
          controls on a phone): the summary takes what the button leaves. */}
      <div
        data-sticky-footer
        className="sticky bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-20 flex items-center justify-between gap-3 rounded-2xl border border-hairline bg-paper/95 p-3 backdrop-blur md:bottom-4"
      >
        <div className="flex min-w-0 flex-1 flex-col">
          <p
            className="text-sm leading-tight font-semibold tabular-nums sm:text-base"
            aria-live="polite"
          >
            {totals.text}
          </p>
          <p className="text-xs leading-tight text-dust-700 tabular-nums sm:text-sm">
            {state.phase === "submitting" && state.slow
              ? "Still confirming…"
              : `Value ${money(totals.value.toFixed(2))} (preview)`}
          </p>
        </div>
        <Button
          size="md"
          className="sm:min-h-14 sm:px-8 sm:text-base"
          pending={state.phase === "submitting" || state.phase === "done"}
          pendingLabel={state.slow ? "Still confirming…" : "Receiving…"}
          disabled={!canCommit}
          onClick={submit}
        >
          Receive {itemsText(totals.items)}
        </Button>
      </div>
    </div>
  );
}

function ClosedOrder({ order }: { order: ReceiveFormOrder }) {
  const back = (
    <ButtonLink href={`/purchasing/orders/${order.id}`} variant="outline">
      Back to {order.poNumber}
    </ButtonLink>
  );
  if (order.status === "cancelled") {
    return (
      <div className="flex flex-col gap-3 rounded-2xl bg-danger-soft p-4 text-danger-deep">
        <p className="font-medium">This order was cancelled.</p>
        <div>{back}</div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3 rounded-2xl bg-done-soft p-4 text-done-deep">
      <p className="font-medium">
        This order is fully received. Extra or late units go on a new order.
      </p>
      <div className="flex flex-wrap gap-2">
        {!order.supplier.archived ? (
          <NewPurchaseOrderButton
            supplier={{ id: order.supplier.id, name: order.supplier.name }}
            label="Start a new order for this supplier"
            wrap
            className="w-full sm:w-auto"
          />
        ) : null}
        {back}
      </div>
    </div>
  );
}

function RecordedBanner({
  receipt,
  orderId,
  poNumber,
  canReceiveMore,
  onReceiveAnother,
}: {
  receipt: ReceiptSummary;
  orderId: string;
  poNumber: string;
  canReceiveMore: boolean;
  onReceiveAnother: () => void;
}) {
  const sameOrder = receipt.purchaseOrderId === orderId;
  return (
    <div role="status" className="flex flex-col gap-3 rounded-2xl bg-done-soft p-4 text-done-deep">
      <p className="flex items-start gap-2 font-medium">
        <CheckIcon className="mt-0.5 size-5 shrink-0" />
        This delivery was recorded {whenText(receipt.receivedAt)} by {receipt.receivedBy} (
        {itemsText(receipt.units)}).
      </p>
      <div className="flex flex-wrap gap-2">
        <ButtonLink
          href={`/purchasing/orders/${receipt.purchaseOrderId}`}
          variant={canReceiveMore ? "outline" : "solid"}
        >
          Open {sameOrder ? poNumber : receipt.poNumber}
        </ButtonLink>
        {canReceiveMore ? (
          <Button onClick={onReceiveAnother}>Receive another delivery</Button>
        ) : null}
      </div>
    </div>
  );
}
