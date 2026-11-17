"use client";

import { useState, useTransition, useId } from "react";

import {
  createBuildPackageAction,
  pushBuildPackageAction,
  setBuildPackageArchivedAction,
  updateBuildPackageAction,
} from "@/app/(staff)/settings/build-packages/actions";
import {
  clearJobBuildAction,
  fitBuildToBudgetAction,
  linkBuildOrderAction,
  repriceBuildLineAction,
  setJobBuildAction,
} from "@/app/(staff)/jobs/build-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { PlusIcon } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Sheet } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { useFocusFirstInvalid } from "@/components/ui/use-focus-invalid";
import type { ActionResult } from "@/lib/actions";
import { callAction } from "@/lib/call-action";
import { formatMoney } from "@/lib/money";
import { newId } from "@/lib/uuid";

export type PackageKind = "full_build" | "build_only";

const KIND_LABEL: Record<PackageKind, string> = {
  full_build: "Full build",
  build_only: "Build only",
};

export type EditablePackage = {
  id: string;
  kind: PackageKind;
  name: string;
  description: string | null;
  price: string;
  priceIsFrom: boolean;
  labourAmount: string;
  labourServiceId: string;
  currency: string;
  public: boolean;
  sortOrder: number;
  archived: boolean;
  publishOnline: boolean;
  shopifyProductId: string | null;
};

export type ServiceChoice = { id: string; name: string };

type Errors = Record<string, string[] | undefined> | undefined;

// ---------------------------------------------------------------------------
// Settings → Build packages (D246, admins)
// ---------------------------------------------------------------------------

export function NewBuildPackageButton({ services }: { services: ServiceChoice[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button icon={<PlusIcon className="size-5" />} onClick={() => setOpen(true)}>
        New package
      </Button>
      {open ? <PackageSheet pkg={null} services={services} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

export function EditBuildPackageButton({
  pkg,
  services,
}: {
  pkg: EditablePackage;
  services: ServiceChoice[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Edit
      </Button>
      {open ? <PackageSheet pkg={pkg} services={services} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function PackageSheet({
  pkg,
  services,
  onClose,
}: {
  pkg: EditablePackage | null;
  services: ServiceChoice[];
  onClose: () => void;
}) {
  const { toast } = useToast();
  const formId = useId();
  const [id] = useState(() => pkg?.id ?? newId());
  const [state, setState] = useState<ActionResult<unknown> | null>(null);
  const [pending, start] = useTransition();
  const formRef = useFocusFirstInvalid(state);
  const errors: Errors = state && !state.ok ? state.fieldErrors : undefined;

  const submit = (formData: FormData) =>
    start(async () => {
      formData.set("id", id);
      const name = String(formData.get("name") ?? "").trim();
      const result = await callAction(
        () => (pkg ? updateBuildPackageAction(formData) : createBuildPackageAction(formData)),
        formData,
      );
      setState(result);
      if (!result.ok) return;
      toast({ title: `${name} saved`, tone: "success" });
      onClose();
    });

  return (
    <Sheet
      open
      onOpenChange={(next) => (next ? null : onClose())}
      dismissible={!pending}
      title={pkg ? `Edit ${pkg.name}` : "New package"}
      description="A full build's labour amount is service revenue; the rest of its price is the parts budget."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} pending={pending} pendingLabel="Saving…">
            {pkg ? "Save" : "Add package"}
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
          submit(new FormData(e.currentTarget));
        }}
      >
        {state && !state.ok ? (
          <p role="alert" className="text-sm font-medium text-danger-deep">
            {state.error}
          </p>
        ) : null}
        <Field label="Kind" error={errors?.kind?.[0]} required>
          <Select name="kind" defaultValue={pkg?.kind ?? "full_build"}>
            <option value="full_build">Full build (parts and labour)</option>
            <option value="build_only">Build only (labour on the customer&apos;s bike)</option>
          </Select>
        </Field>
        <Field label="Name" error={errors?.name?.[0]} required>
          <Input name="name" autoComplete="off" maxLength={80} defaultValue={pkg?.name ?? ""} />
        </Field>
        <Field label="Price" error={errors?.price?.[0]} required>
          <Input
            name="price"
            inputMode="decimal"
            autoComplete="off"
            defaultValue={pkg?.price ?? ""}
          />
        </Field>
        <label className="flex items-center gap-3 text-sm">
          <input type="checkbox" name="priceIsFrom" defaultChecked={pkg?.priceIsFrom ?? false} />
          The price is a starting price (&ldquo;from&rdquo;)
        </label>
        <Field
          label="Labour amount"
          hint="Service revenue. On a full build the rest of the price is the parts budget; on build only it is usually the whole price."
          error={errors?.labourAmount?.[0]}
          required
        >
          <Input
            name="labourAmount"
            inputMode="decimal"
            autoComplete="off"
            defaultValue={pkg?.labourAmount ?? "180.00"}
          />
        </Field>
        <Field
          label="Labour service"
          hint="The service the job's labour line is recorded as."
          error={errors?.labourServiceId?.[0]}
          required
        >
          <Select
            name="labourServiceId"
            defaultValue={pkg?.labourServiceId ?? services[0]?.id ?? ""}
          >
            {services.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Description" hint="Shown on the site." error={errors?.description?.[0]}>
          <Textarea name="description" rows={4} defaultValue={pkg?.description ?? ""} />
        </Field>
        <Field label="Sort order" hint="Lower comes first." error={errors?.sortOrder?.[0]}>
          <Input
            name="sortOrder"
            inputMode="numeric"
            defaultValue={String(pkg?.sortOrder ?? 100)}
          />
        </Field>
        <label className="flex items-center gap-3 text-sm">
          <input type="checkbox" name="public" defaultChecked={pkg?.public ?? true} />
          Show on the site
        </label>
      </form>
    </Sheet>
  );
}

export function ArchiveBuildPackageButton({ id, archived }: { id: string; archived: boolean }) {
  const { toast } = useToast();
  const [pending, start] = useTransition();
  return (
    <Button
      variant="outline"
      size="sm"
      pending={pending}
      onClick={() =>
        start(async () => {
          const result = await callAction(() =>
            setBuildPackageArchivedAction({ id, archived: !archived }),
          );
          toast(
            result.ok
              ? { title: archived ? "Package restored" : "Package archived", tone: "success" }
              : { title: "Not changed", description: result.error, tone: "error" },
          );
        })
      }
    >
      {archived ? "Unarchive" : "Archive"}
    </Button>
  );
}

/** D252: put a full build on Shopify, update it there, or take it off (draft). */
export function ShopifyPackageButton({
  id,
  online,
  pushed,
}: {
  id: string;
  online: boolean;
  pushed: boolean;
}) {
  const { toast } = useToast();
  const [pending, start] = useTransition();
  const push = (publishOnline: boolean) =>
    start(async () => {
      const result = await callAction(() => pushBuildPackageAction({ id, publishOnline }));
      toast(
        result.ok
          ? {
              title: publishOnline ? "On Shopify" : "Taken off Shopify",
              description: publishOnline ? "Customers can buy it with a frame." : undefined,
              tone: "success",
            }
          : { title: "Shopify not changed", description: result.error, tone: "error" },
      );
    });
  return (
    <>
      <Button variant="outline" size="sm" pending={pending} onClick={() => push(true)}>
        {online && pushed ? "Update on Shopify" : "Put on Shopify"}
      </Button>
      {online ? (
        <Button variant="outline" size="sm" disabled={pending} onClick={() => push(false)}>
          Take off Shopify
        </Button>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// The job's Build card (D247-D251)
// ---------------------------------------------------------------------------

export type JobBuildView = {
  packageId: string;
  name: string;
  kind: PackageKind;
  price: string;
  labourAmount: string;
  partsBudget: string;
  labourLineId: string;
  partsListTotal: string;
  partsTotal: string;
  labourTotal: string | null;
  packageTotal: string;
  difference: string;
  currency: string;
  listPrices: Record<string, string>;
};

export type OnlineOrder = {
  id: string;
  orderName: string | null;
  packageName: string;
  amount: string;
  currency: string;
};

export type BuildPart = {
  id: string;
  description: string;
  quantity: string;
  unitSalePrice: string;
};

export function JobBuildPanel({
  workOrderId,
  open,
  build,
  packages,
  parts,
  linkedOrder,
  unlinkedOrders,
}: {
  workOrderId: string;
  open: boolean;
  build: JobBuildView | null;
  packages: EditablePackage[];
  parts: BuildPart[];
  /** D255: the online order paid for this build, if any. */
  linkedOrder: OnlineOrder | null;
  /** Online build orders waiting for a job. */
  unlinkedOrders: OnlineOrder[];
}) {
  const { toast } = useToast();
  const [sheet, setSheet] = useState<"set" | "clear" | null>(null);
  const [pending, start] = useTransition();

  const fit = () =>
    start(async () => {
      const result = await callAction(() => fitBuildToBudgetAction({ workOrderId }));
      toast(
        result.ok
          ? { title: "Parts fitted to the budget", tone: "success" }
          : { title: "Not fitted", description: result.error, tone: "error" },
      );
    });

  if (!build) {
    return (
      <div className="flex flex-col gap-3 px-4 pb-4 sm:px-5">
        <p className="text-sm text-dust-700">
          No package. A full build&apos;s price covers its labour and a parts budget; the parts
          fitted are priced to the budget.
        </p>
        {open ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => setSheet("set")}>
              Set package
            </Button>
            {unlinkedOrders.length > 0 ? (
              <LinkOrderButton workOrderId={workOrderId} orders={unlinkedOrders} />
            ) : null}
          </div>
        ) : null}
        {sheet === "set" ? (
          <SetBuildSheet
            workOrderId={workOrderId}
            packages={packages}
            current={null}
            onClose={() => setSheet(null)}
          />
        ) : null}
      </div>
    );
  }

  const money = (v: string | null) => (v === null ? "—" : formatMoney(v, build.currency));
  const fitted = Number(build.difference) === 0;
  const rows: [string, string][] = [
    ["Package price", money(build.price)],
    ["Labour (service)", money(build.labourAmount)],
    ["Parts budget", money(build.partsBudget)],
    ["Parts at shelf price", money(build.partsListTotal)],
    ["Parts now", money(build.partsTotal)],
    ["Labour now", money(build.labourTotal)],
  ];

  return (
    <div className="flex flex-col gap-4 px-4 pb-4 sm:px-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{build.name}</span>
        <Badge>{KIND_LABEL[build.kind]}</Badge>
        {fitted ? (
          <Badge tone="done">Adds up to the price</Badge>
        ) : (
          <Badge tone="waiting">
            {Number(build.difference) > 0
              ? `${money(build.difference)} under the price`
              : `${money(String(-Number(build.difference)))} over the price`}
          </Badge>
        )}
      </div>
      {linkedOrder ? (
        <p className="text-sm text-done-deep">
          Paid on Shopify{linkedOrder.orderName ? ` (${linkedOrder.orderName})` : ""}:{" "}
          {formatMoney(linkedOrder.amount, linkedOrder.currency)}. It counts as revenue when the
          build is completed.
        </p>
      ) : open && unlinkedOrders.length > 0 ? (
        <div>
          <LinkOrderButton workOrderId={workOrderId} orders={unlinkedOrders} />
        </div>
      ) : null}
      <dl
        aria-label="Build figures"
        className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3"
      >
        {rows.map(([label, value]) => (
          <div key={label} className="flex flex-col">
            <dt className="text-dust-500">{label}</dt>
            <dd className="font-semibold tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      {parts.length > 0 ? (
        <ul
          aria-label="Parts in the build"
          className="divide-y divide-hairline rounded-xl border border-hairline"
        >
          {parts.map((part) => {
            const list = build.listPrices[part.id] ?? part.unitSalePrice;
            const changed = list !== part.unitSalePrice;
            return (
              <li key={part.id} className="flex min-h-12 items-center gap-3 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1">
                  {part.description}
                  {Number(part.quantity) !== 1 ? ` × ${Number(part.quantity)}` : ""}
                </span>
                <span className="tabular-nums">
                  {changed ? (
                    <span className="mr-2 text-dust-500 line-through">{money(list)}</span>
                  ) : null}
                  {money(part.unitSalePrice)}
                </span>
                {open ? (
                  <RepriceButton
                    lineId={part.id}
                    label={part.description}
                    price={part.unitSalePrice}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-dust-700">Add the parts the build uses as part lines above.</p>
      )}
      {open ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={fit} pending={pending} pendingLabel="Fitting…">
            Fit parts to budget
          </Button>
          <Button variant="outline" size="sm" onClick={() => setSheet("set")}>
            Change package
          </Button>
          <Button variant="outline" size="sm" onClick={() => setSheet("clear")}>
            Take off
          </Button>
        </div>
      ) : null}
      {sheet === "set" ? (
        <SetBuildSheet
          workOrderId={workOrderId}
          packages={packages}
          current={build}
          onClose={() => setSheet(null)}
        />
      ) : null}
      {sheet === "clear" ? (
        <ClearBuildSheet workOrderId={workOrderId} onClose={() => setSheet(null)} />
      ) : null}
    </div>
  );
}

function SetBuildSheet({
  workOrderId,
  packages,
  current,
  onClose,
}: {
  workOrderId: string;
  packages: EditablePackage[];
  current: JobBuildView | null;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const formId = useId();
  const [labourLineId] = useState(() => newId());
  const [packageId, setPackageId] = useState(current?.packageId ?? packages[0]?.id ?? "");
  const pkg = packages.find((p) => p.id === packageId);
  const [price, setPrice] = useState(current?.price ?? "");
  const [state, setState] = useState<ActionResult<unknown> | null>(null);
  const [pending, start] = useTransition();
  const formRef = useFocusFirstInvalid(state);
  const errors: Errors = state && !state.ok ? state.fieldErrors : undefined;

  return (
    <Sheet
      open
      onOpenChange={(next) => (next ? null : onClose())}
      dismissible={!pending}
      title={current ? "Change package" : "Set package"}
      description="The package's labour becomes the job's labour line; the rest is the parts budget."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} pending={pending} pendingLabel="Saving…">
            Save
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
          start(async () => {
            const result = await callAction(() =>
              setJobBuildAction({
                workOrderId,
                packageId,
                labourLineId,
                price: pkg?.priceIsFrom && price.trim() ? price : null,
              }),
            );
            setState(result);
            if (!result.ok) return;
            toast({ title: `${pkg?.name ?? "Package"} set`, tone: "success" });
            onClose();
          });
        }}
      >
        {state && !state.ok ? (
          <p role="alert" className="text-sm font-medium text-danger-deep">
            {state.error}
          </p>
        ) : null}
        {packages.length === 0 ? (
          <p className="text-sm text-dust-700">
            There are no packages yet. An admin adds them under Settings → Build packages.
          </p>
        ) : (
          <Field label="Package" error={errors?.packageId?.[0]} required>
            <Select
              name="packageId"
              value={packageId}
              onChange={(e) => setPackageId(e.target.value)}
            >
              {packages.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.priceIsFrom ? "from " : ""}
                  {formatMoney(p.price, p.currency)}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {pkg?.priceIsFrom ? (
          <Field
            label="Price"
            hint={`At least ${formatMoney(pkg.price, pkg.currency)}. The amount above it is labour.`}
            error={errors?.price?.[0]}
          >
            <Input
              name="price"
              inputMode="decimal"
              autoComplete="off"
              value={price}
              placeholder={pkg.price}
              onChange={(e) => setPrice(e.target.value)}
            />
          </Field>
        ) : null}
      </form>
    </Sheet>
  );
}

function ClearBuildSheet({ workOrderId, onClose }: { workOrderId: string; onClose: () => void }) {
  const { toast } = useToast();
  const formId = useId();
  const [reason, setReason] = useState("");
  const [state, setState] = useState<ActionResult<unknown> | null>(null);
  const [pending, start] = useTransition();
  const formRef = useFocusFirstInvalid(state);
  const errors: Errors = state && !state.ok ? state.fieldErrors : undefined;
  return (
    <Sheet
      open
      onOpenChange={(next) => (next ? null : onClose())}
      dismissible={!pending}
      title="Take the package off"
      description="The labour line is voided and repriced parts go back to their shelf prices."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} pending={pending} pendingLabel="Taking off…">
            Take off
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
          start(async () => {
            const result = await callAction(() => clearJobBuildAction({ workOrderId, reason }));
            setState(result);
            if (!result.ok) return;
            toast({ title: "Package taken off", tone: "success" });
            onClose();
          });
        }}
      >
        {state && !state.ok ? (
          <p role="alert" className="text-sm font-medium text-danger-deep">
            {state.error}
          </p>
        ) : null}
        <Field label="Reason" error={errors?.reason?.[0]} required>
          <Input
            name="reason"
            autoComplete="off"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
      </form>
    </Sheet>
  );
}

function RepriceButton({ lineId, label, price }: { lineId: string; label: string; price: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        aria-label={`Reprice ${label}`}
      >
        Reprice
      </Button>
      {open ? (
        <RepriceSheet lineId={lineId} label={label} price={price} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}

function RepriceSheet({
  lineId,
  label,
  price,
  onClose,
}: {
  lineId: string;
  label: string;
  price: string;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const formId = useId();
  const [value, setValue] = useState(price);
  const [state, setState] = useState<ActionResult<unknown> | null>(null);
  const [pending, start] = useTransition();
  const formRef = useFocusFirstInvalid(state);
  const errors: Errors = state && !state.ok ? state.fieldErrors : undefined;
  return (
    <Sheet
      open
      onOpenChange={(next) => (next ? null : onClose())}
      dismissible={!pending}
      title={`Reprice ${label}`}
      description="The price for one, in this build. The shelf price is kept."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} pending={pending} pendingLabel="Saving…">
            Save
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
          start(async () => {
            const result = await callAction(() => repriceBuildLineAction({ lineId, price: value }));
            setState(result);
            if (!result.ok) return;
            toast({ title: "Price saved", tone: "success" });
            onClose();
          });
        }}
      >
        {state && !state.ok ? (
          <p role="alert" className="text-sm font-medium text-danger-deep">
            {state.error}
          </p>
        ) : null}
        <Field label="Price each" error={errors?.price?.[0]} required>
          <Input
            name="price"
            inputMode="decimal"
            autoComplete="off"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </Field>
      </form>
    </Sheet>
  );
}

function LinkOrderButton({ workOrderId, orders }: { workOrderId: string; orders: OnlineOrder[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Link online order
      </Button>
      {open ? (
        <LinkOrderSheet workOrderId={workOrderId} orders={orders} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}

function LinkOrderSheet({
  workOrderId,
  orders,
  onClose,
}: {
  workOrderId: string;
  orders: OnlineOrder[];
  onClose: () => void;
}) {
  const { toast } = useToast();
  const formId = useId();
  const [labourLineId] = useState(() => newId());
  const [buildOrderId, setBuildOrderId] = useState(orders[0]?.id ?? "");
  const [state, setState] = useState<ActionResult<unknown> | null>(null);
  const [pending, start] = useTransition();
  const formRef = useFocusFirstInvalid(state);
  const errors: Errors = state && !state.ok ? state.fieldErrors : undefined;
  return (
    <Sheet
      open
      onOpenChange={(next) => (next ? null : onClose())}
      dismissible={!pending}
      title="Link an online order"
      description="A build bought on Shopify. Its payment counts on this job, and the job gets its package if it has none."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} pending={pending} pendingLabel="Linking…">
            Link
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
          start(async () => {
            const result = await callAction(() =>
              linkBuildOrderAction({ buildOrderId, workOrderId, labourLineId }),
            );
            setState(result);
            if (!result.ok) return;
            toast({ title: "Online order linked", tone: "success" });
            onClose();
          });
        }}
      >
        {state && !state.ok ? (
          <p role="alert" className="text-sm font-medium text-danger-deep">
            {state.error}
          </p>
        ) : null}
        <Field label="Online order" error={errors?.buildOrderId?.[0]} required>
          <Select
            name="buildOrderId"
            value={buildOrderId}
            onChange={(e) => setBuildOrderId(e.target.value)}
          >
            {orders.map((o) => (
              <option key={o.id} value={o.id}>
                {o.orderName ?? "Online order"} · {o.packageName} ·{" "}
                {formatMoney(o.amount, o.currency)}
              </option>
            ))}
          </Select>
        </Field>
      </form>
    </Sheet>
  );
}
