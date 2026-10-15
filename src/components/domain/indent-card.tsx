"use client";

import { useEffect, useId, useMemo, useState, useTransition } from "react";

import {
  orderPartRequestsAction,
  proposePartAction,
  proposeServiceAction,
  searchIndentProductOptions,
  sendQuoteAction,
  supplierOptions,
  withdrawQuoteAction,
} from "@/app/(staff)/jobs/indent-actions";
import { searchServiceOptions } from "@/app/(staff)/jobs/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field } from "@/components/ui/field";
import { PlusIcon } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { SearchPicker, type PickerOption } from "@/components/ui/search-picker";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Select } from "@/components/ui/select";
import { Sheet } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import type { ActionResult } from "@/lib/actions";
import { formatDateTime } from "@/lib/dates";
import type { IndentPanel, IndentProductOption, PartRequest } from "@/lib/domain/indent";
import type { JobDeposit } from "@/lib/domain/payments";
import {
  QUOTE_DAYS,
  canCancelRequest,
  canFit,
  isUnfitted,
  notFittedNote,
  quoteMessage,
  requestBadge,
  unansweredQuoteNote,
  unfittedNote,
  whatsappHref,
} from "@/lib/indent";
import { formatMoney, formatQuantity, sumMoney } from "@/lib/money";
import { depositBlockedIds, depositStates, type DepositState } from "@/lib/payments";
import { REASON_MAX_LENGTH } from "@/lib/reasons";
import { newId } from "@/lib/uuid";
import type { WorkOrderStatus } from "@/lib/workshop";

import { CopyText } from "./copy-text";
import { CancelSheet, DepositBadge, FitSheet } from "./indent-sheets";

type Errors = Record<string, string[]> | undefined;
const errorsOf = (r: ActionResult<unknown> | null): Errors =>
  r && !r.ok ? r.fieldErrors : undefined;

/**
 * Indent parts and the customer's quote on one job (Phase 13; PLAN
 * D140-D147, ADR-024). Proposed items use no stock and are not job lines:
 * they are quoted to the customer (WhatsApp or a copied link), answered per
 * item, ordered from a supplier (Manage purchasing) and fitted, which adds
 * the ordinary job line. Costs and suppliers only for cost holders.
 * From Phase 14 (D152), a part whose answered quote asked a deposit that is
 * not paid shows the deposit's state and starts unticked in the order
 * sheet; only an admin or manager orders it, with a reason.
 * On a job that is no longer open (R-082), an approved or ordered item is
 * "Not fitted" with what can be done: on a completed or ready job, reopen
 * to fit it or cancel it; on a collected or cancelled job only an admin or
 * manager cancels it (D149), and Fit is never offered. An item still on
 * the open quote there is "Not answered"; on a collected or cancelled job
 * an admin or manager cancels it too, which withdraws the quote.
 * Fit on an approved part never ordered in BICII offers "Bought outside
 * BICII" to cost and purchasing holders (D149a, FitSheet in
 * indent-sheets.tsx, shared with the settle checklist of D149b).
 * An item whose fitted line was voided is approved or ordered again with
 * Fit and Cancel, and says why (D160).
 */
export function IndentCard({
  id,
  workOrderId,
  jobNumber,
  open,
  jobStatus,
  panel,
  customer,
  canOrder,
  purchaseData,
  canCreateProduct,
  emailEnabled,
  deposits = [],
  canOverrideDeposit = false,
  canCancelClosed = false,
  defaultLocationName = null,
}: {
  /** The anchor the memo under the job's total links to. */
  id?: string;
  workOrderId: string;
  jobNumber: string;
  /** Lines may change (D15): proposing, quoting and fitting need an open job. */
  open: boolean;
  /** The job's status: what a not-fitted item on a job that is not open says (R-082). */
  jobStatus: WorkOrderStatus;
  panel: IndentPanel;
  customer: { firstName: string | null; phone: string | null; email: string | null };
  canOrder: boolean;
  purchaseData: boolean;
  canCreateProduct: boolean;
  /** RESEND_API_KEY and EMAIL_FROM are set (D144). */
  emailEnabled: boolean;
  /** Answered quotes that asked a deposit (public.quote_deposits, D151). */
  deposits?: JobDeposit[];
  /** An active admin or manager (D152): may order before the deposit is paid. */
  canOverrideDeposit?: boolean;
  /** An active admin or manager (D149): may cancel an item on a collected or cancelled job. */
  canCancelClosed?: boolean;
  /** Where a never-ordered part is taken from when fitted (add_inventory_line's default). */
  defaultLocationName?: string | null;
}) {
  const [sheet, setSheet] = useState<
    null | "part" | "service" | "quote" | "order" | { cancel: PartRequest } | { fit: PartRequest }
  >(null);
  const [sent, setSent] = useState<QuoteSent | null>(null);
  const { toast } = useToast();
  const [withdrawing, startWithdraw] = useTransition();

  const live = panel.requests.filter((r) => r.status !== "cancelled");
  // Sending again withdraws the open quote first, so its items can go on the new one.
  const quotable = live.filter((r) => r.status === "proposed" || r.status === "quoted");
  const approvedParts = live.filter((r) => r.kind === "part" && r.status === "approved");
  const quote = panel.quote;
  const close = () => setSheet(null);
  const depositByRequest = useMemo(() => depositStates(deposits), [deposits]);

  const withdraw = () =>
    startWithdraw(async () => {
      if (!quote) return;
      const result = await withdrawQuoteAction({ quoteId: quote.id });
      toast(
        result.ok
          ? { title: "Quote withdrawn. Its link no longer works.", tone: "success" }
          : { title: "Quote not withdrawn", description: result.error, tone: "error" },
      );
    });

  return (
    <Card
      id={id}
      className="scroll-mt-4"
      title="Indent parts and quote"
      eyebrow="Customer approval"
      actions={
        open ? (
          <>
            <Button
              variant="outline"
              size="sm"
              icon={<PlusIcon className="size-4" />}
              onClick={() => setSheet("part")}
            >
              Propose part
            </Button>
            <Button
              variant="outline"
              size="sm"
              icon={<PlusIcon className="size-4" />}
              onClick={() => setSheet("service")}
            >
              Propose service
            </Button>
          </>
        ) : null
      }
    >
      <div className="flex flex-col gap-4">
        {quote ? (
          <p aria-label="Quote status" className="rounded-xl bg-sunken px-4 py-3 text-sm">
            {quote.state === "open" && !open ? (
              <>
                Quote sent {formatDateTime(quote.sentAt)}, not answered. The job is no longer open,
                so the customer can&apos;t answer it. {unansweredQuoteNote(jobStatus)}
              </>
            ) : quote.state === "open" ? (
              <>
                Quote sent {formatDateTime(quote.sentAt)}
                {quote.channel === "whatsapp" ? " by WhatsApp" : ""}, waiting for the customer. The
                link works until {formatDateTime(quote.expiresAt)}.
              </>
            ) : quote.state === "answered" ? (
              <>
                Quote answered by <strong>{quote.answeredName}</strong> on{" "}
                {formatDateTime(quote.answeredAt!)}.
              </>
            ) : quote.state === "expired" ? (
              <>
                The last quote expired {formatDateTime(quote.expiresAt)} without an answer.
                {open ? null : <> {unansweredQuoteNote(jobStatus)}</>}
              </>
            ) : (
              <>The last quote was withdrawn.</>
            )}
          </p>
        ) : null}

        {live.length === 0 ? (
          <p className="text-dust-700">
            Nothing proposed. Propose a part the shop doesn&apos;t stock (and its fitting) to quote
            it to the customer before ordering.
          </p>
        ) : (
          <ul aria-label="Proposed items" className="flex flex-col divide-y divide-hairline">
            {live.map((r) => {
              const notFitted = !open && isUnfitted(r.status);
              const badge = requestBadge(r.status, open);
              const fittable = open && canFit(r.kind, r.status);
              const cancellable = canCancelRequest(r.status, jobStatus, canCancelClosed);
              return (
                <li key={r.id} aria-label={r.description} className="flex flex-col gap-2 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <span className="flex min-w-0 flex-col">
                      <span className="font-medium break-words">{r.description}</span>
                      <span className="text-sm text-dust-500">
                        {r.kind === "service" ? "Service" : "Part"} · {formatQuantity(r.quantity)} ×{" "}
                        {formatMoney(r.unitSalePrice, r.currency)}
                        {r.purchase?.supplierName ? ` · from ${r.purchase.supplierName}` : ""}
                        {r.purchase?.expectedUnitCost
                          ? ` · cost ${formatMoney(r.purchase.expectedUnitCost, r.currency)}`
                          : ""}
                      </span>
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="font-semibold tabular-nums">
                        {formatMoney(r.lineTotal, r.currency)}
                      </span>
                      <Badge tone={badge.tone}>{badge.label}</Badge>
                      <DepositBadge
                        request={r}
                        depositByRequest={depositByRequest}
                        showPaid={!open}
                      />
                    </span>
                  </div>
                  {r.order ? (
                    <p className="text-sm text-dust-700">
                      On {r.order.poNumber} ·{" "}
                      {r.order.arrived ? (
                        <Badge tone="done">Arrived</Badge>
                      ) : (
                        <span>not arrived yet</span>
                      )}
                    </p>
                  ) : null}
                  {notFitted ? (
                    <p className="text-sm text-danger-deep">{notFittedNote(jobStatus)}</p>
                  ) : open && r.unfitted ? (
                    // D160: its fitted line was voided; it is back to approved or ordered.
                    <p className="text-sm text-waiting-deep">
                      {unfittedNote(r.unfitted.boughtOutside)}
                    </p>
                  ) : null}
                  {fittable || cancellable ? (
                    <div className="flex flex-wrap gap-2">
                      {fittable ? (
                        <Button size="sm" onClick={() => setSheet({ fit: r })}>
                          {r.kind === "service" ? "Add to job" : "Fit"}
                        </Button>
                      ) : null}
                      {cancellable ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Cancel ${r.description}`}
                          onClick={() => setSheet({ cancel: r })}
                        >
                          Cancel
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}

        {open ? (
          <div className="flex flex-wrap gap-2">
            {quotable.length > 0 ? (
              <Button onClick={() => setSheet("quote")}>
                {quote?.state === "open" ? "Send again" : "Send quote"} ({quotable.length}{" "}
                {quotable.length === 1 ? "item" : "items"})
              </Button>
            ) : null}
            {quote?.state === "open" ? (
              <Button
                variant="outline"
                onClick={withdraw}
                pending={withdrawing}
                pendingLabel="Withdrawing…"
              >
                Withdraw quote
              </Button>
            ) : null}
            {canOrder && approvedParts.length > 0 ? (
              <Button variant="outline" onClick={() => setSheet("order")}>
                Order approved parts
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      {sheet === "part" ? (
        <ProposePartSheet
          workOrderId={workOrderId}
          purchaseData={purchaseData}
          canCreateProduct={canCreateProduct}
          onClose={close}
        />
      ) : null}
      {sheet === "service" ? (
        <ProposeServiceSheet workOrderId={workOrderId} onClose={close} />
      ) : null}
      {sheet === "quote" ? (
        <SendQuoteSheet
          workOrderId={workOrderId}
          items={quotable}
          hasWhatsapp={whatsappHref(customer.phone, "x") !== null}
          emailEnabled={emailEnabled}
          emailTo={emailEnabled ? customer.email : null}
          onSent={(result) => {
            setSheet(null);
            setSent(result);
          }}
          onClose={close}
        />
      ) : null}
      {sheet === "order" ? (
        <OrderSheet
          items={approvedParts}
          depositByRequest={depositByRequest}
          canOverrideDeposit={canOverrideDeposit}
          onClose={close}
        />
      ) : null}
      {sheet && typeof sheet === "object" && "cancel" in sheet ? (
        <CancelSheet
          request={sheet.cancel}
          closed={jobStatus === "collected" || jobStatus === "cancelled"}
          onClose={close}
        />
      ) : null}
      {sheet && typeof sheet === "object" && "fit" in sheet ? (
        <FitSheet
          request={sheet.fit}
          locationName={defaultLocationName}
          purchaseData={purchaseData}
          onClose={close}
        />
      ) : null}
      {sent ? (
        <QuoteSentSheet
          sent={sent}
          link={sent.link}
          message={quoteMessage({
            firstName: customer.firstName,
            jobNumber,
            link: sent.link,
            days: sent.validDays,
          })}
          phone={customer.phone}
          onClose={() => setSent(null)}
        />
      ) : null}
    </Card>
  );
}

type ProductPick = PickerOption & { product: IndentProductOption };
type SendChannel = "whatsapp" | "email" | "link";
type QuoteSent = {
  link: string;
  validDays: number;
  emailedTo: string | null;
  emailFailed: boolean;
};
type SupplierOption = { id: string; name: string };

/** Active suppliers, loaded once when the sheet opens (cost holders only; others get none). */
function useSuppliers(enabled: boolean) {
  const [suppliers, setSuppliers] = useState<SupplierOption[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void supplierOptions({ q: "" }).then((result) => {
      if (live && result.ok) setSuppliers(result.data);
    });
    return () => {
      live = false;
    };
  }, [enabled]);
  return suppliers;
}

/** Propose an existing product, or a new one (Manage inventory), with quantity and price. */
function ProposePartSheet({
  workOrderId,
  purchaseData,
  canCreateProduct,
  onClose,
}: {
  workOrderId: string;
  purchaseData: boolean;
  canCreateProduct: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [requestId] = useState(newId);
  const [newProductId] = useState(newId);
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [picked, setPicked] = useState<ProductPick | null>(null);
  const [quantity, setQuantity] = useState("1");
  const [price, setPrice] = useState("");
  const [newName, setNewName] = useState("");
  const [newPrice, setNewPrice] = useState("");
  const [cost, setCost] = useState("");
  const [supplierId, setSupplierId] = useState("");
  const [result, setResult] = useState<ActionResult<{ id: string }> | null>(null);
  const [pending, start] = useTransition();
  const suppliers = useSuppliers(purchaseData);
  const errors = errorsOf(result);

  const search = async (q: string): Promise<ProductPick[]> => {
    const r = await searchIndentProductOptions({ q });
    if (!r.ok) throw new Error(r.error);
    return r.data.map((p) => ({
      id: p.id,
      label: p.name,
      description: [p.shortId, p.sku].filter(Boolean).join(" · "),
      meta: p.salePrice !== null ? formatMoney(p.salePrice, p.currency) : "No price",
      product: p,
    }));
  };

  const submit = () =>
    start(async () => {
      const r = await proposePartAction({
        requestId,
        workOrderId,
        productId: mode === "existing" ? (picked?.product.id ?? "") : "",
        newProductId: mode === "new" ? newProductId : "",
        newName: mode === "new" ? newName : "",
        newPrice: mode === "new" ? newPrice : "",
        quantity,
        unitSalePrice: price,
        expectedUnitCost: cost,
        supplierId,
      });
      setResult(r);
      if (r.ok) {
        toast({ title: "Part proposed. Send a quote when you're ready.", tone: "success" });
        onClose();
      }
    });

  return (
    <Sheet
      open
      onOpenChange={(next) => (next ? null : onClose())}
      dismissible={!pending}
      title="Propose part"
      description="A part to order for this bike. Nothing comes out of stock until it is fitted."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} pending={pending} pendingLabel="Proposing…">
            Propose part
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {result && !result.ok ? (
          <p role="alert" className="text-sm font-medium text-danger-deep">
            {result.error}
          </p>
        ) : null}
        {canCreateProduct ? (
          <SegmentedControl
            label="Which part"
            name="mode"
            value={mode}
            onValueChange={(v) => setMode(v as "existing" | "new")}
            options={[
              { value: "existing", label: "Existing product" },
              { value: "new", label: "New product" },
            ]}
          />
        ) : null}
        {mode === "existing" ? (
          <Field label="Part" error={errors?.productId?.[0]} required>
            <SearchPicker<ProductPick>
              search={search}
              value={picked}
              onSelect={setPicked}
              placeholder="Name, SKU or P- number"
              emptyMessage="No product matches. Only shop-owned products counted by quantity can be ordered."
            />
          </Field>
        ) : (
          <>
            <Field label="Name" error={errors?.newName?.[0] ?? errors?.productId?.[0]} required>
              <Input value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={200} />
            </Field>
            <Field label="Selling price" error={errors?.newPrice?.[0]} required>
              <NumberInput kind="money" value={newPrice} onValueChange={setNewPrice} />
            </Field>
          </>
        )}
        <Field label="Quantity" error={errors?.quantity?.[0]} required>
          <NumberInput
            kind="quantity"
            stepper
            minValue={1}
            maxValue={999}
            value={quantity}
            onValueChange={setQuantity}
          />
        </Field>
        <Field
          label="Price each for this job"
          hint="Optional. Leave empty to quote the selling price."
          error={errors?.unitSalePrice?.[0]}
        >
          <NumberInput kind="money" value={price} onValueChange={setPrice} />
        </Field>
        {purchaseData ? (
          <>
            <Field
              label="Expected cost each"
              hint="Staff with cost access only. Used on the purchase order."
              error={errors?.expectedUnitCost?.[0]}
            >
              <NumberInput kind="money" value={cost} onValueChange={setCost} />
            </Field>
            <Field
              label="Supplier"
              hint="Optional: who it is ordered from."
              error={errors?.supplierId?.[0]}
            >
              <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                <option value="">Not chosen yet</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
          </>
        ) : null}
      </div>
    </Sheet>
  );
}

type ServicePick = PickerOption & { serviceId: string };

/** Propose a catalogue service, such as fitting the part. */
function ProposeServiceSheet({
  workOrderId,
  onClose,
}: {
  workOrderId: string;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [requestId] = useState(newId);
  const [picked, setPicked] = useState<ServicePick | null>(null);
  const [quantity, setQuantity] = useState("1");
  const [price, setPrice] = useState("");
  const [result, setResult] = useState<ActionResult<{ id: string }> | null>(null);
  const [pending, start] = useTransition();
  const errors = errorsOf(result);

  const search = async (q: string): Promise<ServicePick[]> => {
    const r = await searchServiceOptions({ q });
    if (!r.ok) throw new Error(r.error);
    return r.data.map((s) => ({
      id: s.id,
      label: s.name,
      description: s.categoryName,
      meta: formatMoney(s.salePrice, s.currency),
      serviceId: s.id,
    }));
  };

  const submit = () =>
    start(async () => {
      const r = await proposeServiceAction({
        requestId,
        workOrderId,
        serviceId: picked?.serviceId ?? "",
        quantity,
        unitSalePrice: price,
      });
      setResult(r);
      if (r.ok) {
        toast({ title: "Service proposed.", tone: "success" });
        onClose();
      }
    });

  return (
    <Sheet
      open
      onOpenChange={(next) => (next ? null : onClose())}
      dismissible={!pending}
      title="Propose service"
      description="Labour to quote with the parts, such as fitting them."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} pending={pending} pendingLabel="Proposing…">
            Propose service
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {result && !result.ok ? (
          <p role="alert" className="text-sm font-medium text-danger-deep">
            {result.error}
          </p>
        ) : null}
        <Field label="Service" error={errors?.serviceId?.[0]} required>
          <SearchPicker<ServicePick>
            search={search}
            value={picked}
            onSelect={setPicked}
            placeholder="Service name"
            emptyMessage="No active service matches."
          />
        </Field>
        <Field label="Quantity" error={errors?.quantity?.[0]} required>
          <NumberInput kind="quantity" value={quantity} onValueChange={setQuantity} />
        </Field>
        <Field
          label="Price each for this job"
          hint="Optional. Leave empty to quote the service's price."
          error={errors?.unitSalePrice?.[0]}
        >
          <NumberInput kind="money" value={price} onValueChange={setPrice} />
        </Field>
      </div>
    </Sheet>
  );
}

/** Choose the proposed items, how to send and how long the link works (D141, D144). */
function SendQuoteSheet({
  workOrderId,
  items,
  hasWhatsapp,
  emailEnabled,
  emailTo,
  onSent,
  onClose,
}: {
  workOrderId: string;
  items: PartRequest[];
  hasWhatsapp: boolean;
  emailEnabled: boolean;
  /** The customer's address when quote emails are on, else null (no Email option). */
  emailTo: string | null;
  onSent: (result: QuoteSent) => void;
  onClose: () => void;
}) {
  const [quoteId] = useState(newId);
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(items.map((i) => i.id)));
  const [channel, setChannel] = useState<SendChannel>(
    hasWhatsapp ? "whatsapp" : emailTo ? "email" : "link",
  );
  const [days, setDays] = useState(String(QUOTE_DAYS.default));
  const [result, setResult] = useState<ActionResult<QuoteSent> | null>(null);
  const [pending, start] = useTransition();
  const errors = errorsOf(result);
  const currency = items[0]?.currency ?? "SGD";
  const total = useMemo(
    () => sumMoney(items.filter((i) => chosen.has(i.id)).map((i) => i.lineTotal)),
    [items, chosen],
  );

  const submit = () =>
    start(async () => {
      const r = await sendQuoteAction({
        quoteId,
        workOrderId,
        requestIds: items.filter((i) => chosen.has(i.id)).map((i) => i.id),
        channel,
        validDays: days,
      });
      setResult(r);
      if (r.ok) onSent(r.data);
    });

  return (
    <Sheet
      open
      onOpenChange={(next) => (next ? null : onClose())}
      dismissible={!pending}
      title="Send quote"
      description="The customer approves or declines each item from a private link. Sending again replaces any open quote."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            pending={pending}
            pendingLabel="Sending…"
            disabled={chosen.size === 0}
          >
            Create link
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {result && !result.ok ? (
          <p role="alert" className="text-sm font-medium text-danger-deep">
            {result.error}
          </p>
        ) : null}
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 font-display text-xs font-bold tracking-wide uppercase">
            Items
          </legend>
          {items.map((i) => (
            <Checkbox
              key={i.id}
              label={`${formatQuantity(i.quantity)} × ${i.description}`}
              description={formatMoney(i.lineTotal, i.currency)}
              checked={chosen.has(i.id)}
              onChange={(e) => {
                const next = new Set(chosen);
                if (e.target.checked) next.add(i.id);
                else next.delete(i.id);
                setChosen(next);
              }}
            />
          ))}
          {errors?.requestIds?.[0] ? (
            <p className="text-sm text-danger-deep">{errors.requestIds[0]}</p>
          ) : null}
        </fieldset>
        <p className="flex items-baseline justify-between rounded-xl bg-sunken px-4 py-3 tabular-nums">
          <span className="text-sm text-dust-700">Quote total</span>
          <output className="text-lg font-bold">{formatMoney(total, currency)}</output>
        </p>
        <div className="flex flex-col gap-2">
          <span className="font-display text-xs font-bold tracking-wide uppercase">Send by</span>
          <SegmentedControl
            label="Send by"
            name="channel"
            value={channel}
            onValueChange={(v) => setChannel(v as SendChannel)}
            options={[
              ...(hasWhatsapp ? [{ value: "whatsapp", label: "WhatsApp" }] : []),
              ...(emailTo ? [{ value: "email", label: "Email" }] : []),
              { value: "link", label: "Copy link" },
            ]}
          />
          {channel === "email" && emailTo ? (
            <p className="text-sm text-dust-500">The Admin emails the link to {emailTo}.</p>
          ) : null}
          {!hasWhatsapp ? (
            <p className="text-sm text-dust-500">
              No WhatsApp: the customer has no mobile number it can use.
            </p>
          ) : null}
          {!emailEnabled ? (
            <p className="text-sm text-dust-500">
              No email: quote emails aren&apos;t set up yet (an admin sets them up).
            </p>
          ) : !emailTo ? (
            <p className="text-sm text-dust-500">No email: the customer has no email address.</p>
          ) : null}
        </div>
        <Field
          label="Link works for (days)"
          hint={`${QUOTE_DAYS.min} to ${QUOTE_DAYS.max} days.`}
          error={errors?.validDays?.[0]}
        >
          <NumberInput
            kind="quantity"
            stepper
            minValue={QUOTE_DAYS.min}
            maxValue={QUOTE_DAYS.max}
            value={days}
            onValueChange={setDays}
          />
        </Field>
      </div>
    </Sheet>
  );
}

/** The link, shown this once (only its hash is stored): open WhatsApp or copy it. */
function QuoteSentSheet({
  sent,
  link,
  message,
  phone,
  onClose,
}: {
  sent: QuoteSent;
  link: string;
  message: string;
  phone: string | null;
  onClose: () => void;
}) {
  const whatsapp = whatsappHref(phone, message);
  return (
    <Sheet
      open
      onOpenChange={(next) => (next ? null : onClose())}
      title="Quote ready to send"
      description="This link is shown only now. If it is lost, send the quote again for a new one."
      footer={
        <Button variant="outline" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="flex flex-col gap-5">
        {sent.emailedTo ? (
          <p role="status" className="rounded-xl bg-done-soft p-3 text-sm text-done-deep">
            Emailed to {sent.emailedTo}.
          </p>
        ) : null}
        {sent.emailFailed ? (
          <p role="alert" className="rounded-xl bg-waiting-soft p-3 text-sm text-waiting-deep">
            The email didn&apos;t go out. Copy the link and send it another way.
          </p>
        ) : null}
        {whatsapp && !sent.emailedTo ? (
          <a
            href={whatsapp}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-tap items-center justify-center rounded-full bg-ink px-5 font-medium text-paper"
          >
            Open WhatsApp
          </a>
        ) : null}
        <Field label="Quote link">
          <CopyText value={link} label="quote link" />
        </Field>
        <Field label="Message">
          <Textarea readOnly value={message} rows={5} />
        </Field>
      </div>
    </Sheet>
  );
}

/** Order approved parts from one supplier (D145), optionally moving the job to Waiting on parts. */
function OrderSheet({
  items,
  depositByRequest,
  canOverrideDeposit,
  onClose,
}: {
  items: PartRequest[];
  depositByRequest: ReadonlyMap<string, DepositState>;
  /** An active admin or manager (D152). */
  canOverrideDeposit: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [purchaseOrderId] = useState(newId);
  // D152: parts whose deposit isn't paid start unticked, so the default order never needs a reason.
  const [blocked] = useState(
    () =>
      new Set(
        depositBlockedIds(
          items.map((i) => i.id),
          depositByRequest,
        ),
      ),
  );
  const [chosen, setChosen] = useState<Set<string>>(
    () => new Set(items.filter((i) => !blocked.has(i.id)).map((i) => i.id)),
  );
  const [reason, setReason] = useState("");
  const [reasonMissing, setReasonMissing] = useState(false);
  // The note under the parts says why a disabled one can't be ticked.
  const blockedNoteId = useId();
  const showBlockedNote = blocked.size > 0 && !canOverrideDeposit;
  const unpaidChosen = items.filter((i) => chosen.has(i.id) && blocked.has(i.id)).length;
  const preset = items.find((i) => i.purchase?.supplierId)?.purchase?.supplierId ?? "";
  const [supplierId, setSupplierId] = useState(preset);
  const [moveToWaiting, setMoveToWaiting] = useState(true);
  const [result, setResult] = useState<ActionResult<{ purchaseOrderId: string }> | null>(null);
  const [pending, start] = useTransition();
  const suppliers = useSuppliers(true);
  const errors = errorsOf(result);

  const submit = () =>
    start(async () => {
      // The two-step reason rule (DESIGN): this sheet is the confirm step.
      if (unpaidChosen > 0 && reason.trim() === "") {
        setReasonMissing(true);
        return;
      }
      setReasonMissing(false);
      const r = await orderPartRequestsAction({
        requestIds: items.filter((i) => chosen.has(i.id)).map((i) => i.id),
        supplierId,
        purchaseOrderId,
        moveToWaiting,
        // Only when a part whose deposit isn't paid is chosen (D152).
        ...(unpaidChosen > 0 ? { overrideReason: reason } : {}),
      });
      setResult(r);
      if (r.ok) {
        toast({
          title:
            unpaidChosen > 0
              ? "Added to the supplier's draft order without the deposit."
              : "Added to the supplier's draft order.",
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
      title="Order approved parts"
      description="They go on the supplier's draft purchase order (a new one if there is none). Submit the order from Purchasing."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            pending={pending}
            pendingLabel="Ordering…"
            disabled={chosen.size === 0}
          >
            {unpaidChosen > 0 ? "Order without deposit" : "Add to order"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {result && !result.ok ? (
          <p role="alert" className="text-sm font-medium text-danger-deep">
            {result.error}
          </p>
        ) : null}
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 font-display text-xs font-bold tracking-wide uppercase">
            Parts
          </legend>
          {items.map((i) => (
            <Checkbox
              key={i.id}
              label={`${formatQuantity(i.quantity)} × ${i.description}${blocked.has(i.id) ? " (deposit not paid)" : ""}`}
              checked={chosen.has(i.id)}
              disabled={blocked.has(i.id) && !canOverrideDeposit}
              aria-describedby={blocked.has(i.id) && showBlockedNote ? blockedNoteId : undefined}
              onChange={(e) => {
                const next = new Set(chosen);
                if (e.target.checked) next.add(i.id);
                else next.delete(i.id);
                setChosen(next);
              }}
            />
          ))}
          {showBlockedNote ? (
            <p id={blockedNoteId} className="text-sm text-dust-700">
              Parts whose deposit isn&apos;t paid can be ordered once the customer pays, or by an
              admin or manager.
            </p>
          ) : null}
        </fieldset>
        {unpaidChosen > 0 ? (
          <>
            <p role="status" className="rounded-xl bg-waiting-soft p-3 text-sm text-waiting-deep">
              The customer hasn&apos;t paid the deposit for {unpaidChosen} of these parts.
            </p>
            <Field
              label="Why order before the deposit is paid?"
              hint="Recorded on the job's timeline."
              error={
                reasonMissing
                  ? "Say why the parts are ordered before the deposit is paid."
                  : errors?.overrideReason?.[0]
              }
              required
            >
              <Textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                maxLength={REASON_MAX_LENGTH}
              />
            </Field>
          </>
        ) : null}
        <Field label="Supplier" error={errors?.supplierId?.[0]} required>
          <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
            <option value="">Choose a supplier</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Switch
          label="Move the job to Waiting on parts"
          checked={moveToWaiting}
          onCheckedChange={setMoveToWaiting}
        />
      </div>
    </Sheet>
  );
}
