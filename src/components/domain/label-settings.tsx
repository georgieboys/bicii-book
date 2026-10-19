"use client";

import { useEffect, useId, useMemo, useRef, useState, useTransition, type ReactNode } from "react";

import {
  saveProfileAction,
  saveTemplateAction,
  setDefaultProfileAction,
  setDefaultTemplateAction,
  setPublicSiteUrlAction,
} from "@/app/(staff)/settings/labels/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field } from "@/components/ui/field";
import { ChevronRightIcon, PlusIcon } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Sheet } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { useArmed } from "@/components/ui/use-armed";
import type { ActionResult } from "@/lib/actions";
import { composeLabel, type LabelDrawing } from "@/lib/printing/compose";
import { PRINTER_TYPE_NAMES } from "@/lib/printing/job";
import { LabelSvg } from "@/lib/printing/label-svg";
import { SAMPLE_CONTENT } from "@/lib/printing/samples";
import {
  labelTemplateInputSchema,
  printerProfileInputSchema,
  publicSiteUrlInputSchema,
} from "@/lib/printing/schemas";
import {
  LABEL_FIELD_ORDER,
  type LabelField,
  type LabelKind,
  type LabelTemplate,
  type PrinterProfile,
} from "@/lib/printing/types";
import { newId } from "@/lib/uuid";
import { callAction } from "@/lib/call-action";

/**
 * Labels and printers settings (admins only; SPEC §15, §16; PLAN D9,
 * D56–D59; ADR-017): the QR address, the printers and the label templates.
 * Every form checks with the same rules the database applies
 * (src/lib/printing/schemas.ts) before it submits; the database checks
 * again and its refusals show as the error.
 */

// ---------------------------------------------------------------------------
// The QR address
// ---------------------------------------------------------------------------

/**
 * "Change address": the new public website address, checked with the
 * database's rule, then a confirmation (DESIGN.md "Forms": two steps, the
 * confirm button elsewhere and armed after 400 ms) that says what changes
 * for labels already printed.
 */
export function QrAddressForm({
  current,
  environmentBase,
}: {
  current: string | null;
  environmentBase: string | null;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(current ?? "");
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const armed = useArmed(confirming !== null);
  const formId = useId();

  const review = () => {
    const parsed = publicSiteUrlInputSchema.safeParse({ publicSiteUrl: value });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check the address.");
      return;
    }
    const next = parsed.data.publicSiteUrl.replace(/\/+$/, "");
    if (next === current) {
      setError("That is already the address.");
      return;
    }
    setError(null);
    setConfirming(next);
  };

  const save = (next: string) =>
    start(async () => {
      const result = await callAction(() => setPublicSiteUrlAction({ publicSiteUrl: next }));
      if (!result.ok) {
        setConfirming(null);
        setError(result.fieldErrors?.publicSiteUrl?.[0] ?? result.error);
        return;
      }
      toast({ title: "QR address saved", tone: "success" });
      setConfirming(null);
      setOpen(false);
    });

  if (!open) {
    return (
      <div>
        <Button variant="outline" onClick={() => setOpen(true)}>
          {current ? "Change address" : "Set the address"}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <form
        id={formId}
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!pending) review();
        }}
      >
        <Field
          label="Public website address"
          hint="Where customers land when they scan a label, like https://bicii.sg."
          error={error ?? undefined}
          required
        >
          <Input
            type="url"
            inputMode="url"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={200}
            value={value}
            disabled={confirming !== null}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
          />
        </Field>
        {confirming === null ? (
          <div className="flex flex-wrap gap-2">
            <Button type="submit">Review the change</Button>
            <Button
              variant="ghost"
              onClick={() => {
                setOpen(false);
                setValue(current ?? "");
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        ) : null}
      </form>
      {confirming !== null ? (
        <div
          role="group"
          aria-labelledby={`${formId}-confirm`}
          className="flex flex-col gap-3 rounded-2xl border-2 border-ink p-4"
        >
          <h3 id={`${formId}-confirm`} className="text-lg break-all">
            Point new labels at {confirming}?
          </h3>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-dust-700">
            <li>
              Labels printed from now on open{" "}
              <span className="font-mono break-all">{confirming}/q/…</span>
            </li>
            {current ? (
              <li>
                Labels already printed keep pointing at{" "}
                <span className="font-mono break-all">{current}</span>: keep that address working (a
                redirect) so they still open.
              </li>
            ) : null}
            {environmentBase ? (
              <li>
                Scans of <span className="font-mono break-all">{environmentBase}</span> are still
                accepted by this app&apos;s scanner.
              </li>
            ) : null}
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setConfirming(null)} disabled={pending}>
              Back
            </Button>
            <Button
              key="confirm-address"
              disabled={!armed}
              pending={pending}
              pendingLabel="Saving…"
              onClick={() => save(confirming)}
            >
              Change the address
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Printers
// ---------------------------------------------------------------------------

const HARDWARE_NOTE = "Network and Bluetooth need the printer's hardware adapter (Phase 12).";

function RowButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <li className="group/row">
      <button
        type="button"
        onClick={onClick}
        className="flex min-h-16 w-full cursor-pointer items-center gap-4 px-4 py-3 text-left focus-inset transition-colors group-first/row:rounded-t-[15px] group-last/row:rounded-b-[15px] hover:bg-dust-100"
      >
        {children}
        <ChevronRightIcon className="size-5 shrink-0 text-dust-500" />
      </button>
    </li>
  );
}

/** The printers (default first) as rows that open ProfileSheet, and "Add printer". */
export function PrinterList({ profiles }: { profiles: PrinterProfile[] }) {
  const [editing, setEditing] = useState<PrinterProfile | "new" | null>(null);
  const nextSort = profiles.reduce((m, p) => Math.max(m, p.sortOrder), 0) + 1;
  return (
    <div className="flex flex-col gap-3">
      <ul
        aria-label="Printers"
        className="divide-y divide-hairline rounded-2xl border border-hairline bg-card"
      >
        {profiles.map((p) => (
          <RowButton key={p.id} onClick={() => setEditing(p)}>
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="flex flex-wrap items-center gap-2">
                <span className={p.active ? "font-medium" : "font-medium text-dust-500"}>
                  {p.name}
                </span>
                {p.isDefault ? <Badge tone="done">Default</Badge> : null}
                {!p.active ? <Badge>Off</Badge> : null}
              </span>
              <span className="text-sm text-dust-500">{PRINTER_TYPE_NAMES[p.adapter]}</span>
            </span>
          </RowButton>
        ))}
      </ul>
      <div>
        <Button
          variant="outline"
          icon={<PlusIcon className="size-5" />}
          onClick={() => setEditing("new")}
        >
          Add printer
        </Button>
      </div>
      {editing ? (
        <ProfileSheet
          profile={editing === "new" ? null : editing}
          sortOrder={editing === "new" ? nextSort : editing.sortOrder}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}

const offsetValue = (v: string): number | undefined =>
  v.trim() === "" ? undefined : Number(v.trim());

/**
 * One printer: its name, its type (browser print or PDF; fixed once
 * created), the calibration offsets and whether it is on. The default
 * printer stays on; "Make default" for another active one.
 */
export function ProfileSheet({
  profile,
  sortOrder,
  onClose,
}: {
  profile: PrinterProfile | null;
  sortOrder: number;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const formId = useId();
  const [id] = useState(() => profile?.id ?? newId());
  const [name, setName] = useState(profile?.name ?? "");
  const [adapter, setAdapter] = useState<"browser" | "pdf">(
    profile?.adapter === "pdf" ? "pdf" : "browser",
  );
  const [offsetX, setOffsetX] = useState(String(profile?.config.offsetXMm ?? 0));
  const [offsetY, setOffsetY] = useState(String(profile?.config.offsetYMm ?? 0));
  const [active, setActive] = useState(profile?.active ?? true);
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();

  const input = {
    name,
    adapter,
    config: { offsetXMm: offsetValue(offsetX), offsetYMm: offsetValue(offsetY) },
    active,
    sortOrder,
  };

  const submit = () => {
    const parsed = printerProfileInputSchema.safeParse(input);
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        errs[String(issue.path.at(-1))] ??= issue.message;
      }
      setFieldErrors(errs);
      return;
    }
    setFieldErrors({});
    start(async () => {
      const r = await callAction(() =>
        saveProfileAction({
          id,
          mode: profile ? "update" : "create",
          profile: parsed.data,
        }),
      );
      setResult(r);
      if (r.ok) {
        toast({ title: `${parsed.data.name} saved`, tone: "success" });
        onClose();
      }
    });
  };

  const makeDefault = () =>
    start(async () => {
      if (!profile) return;
      const r = await callAction(() => setDefaultProfileAction({ id: profile.id }));
      setResult(r);
      if (r.ok) {
        toast({ title: `${profile.name} is the default printer`, tone: "success" });
        onClose();
      }
    });

  const failure = result && !result.ok ? result : null;

  return (
    <Sheet
      open
      onOpenChange={(next) => (next ? null : onClose())}
      dismissible={!pending}
      title={profile ? `Edit ${profile.name}` : "New printer"}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} pending={pending} pendingLabel="Saving…">
            {profile ? "Save" : "Add printer"}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        noValidate
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!pending) submit();
        }}
      >
        {failure ? (
          <p role="alert" className="text-sm font-medium text-danger-deep">
            {failure.fieldErrors?.profile?.[0] ?? failure.error}
          </p>
        ) : null}
        <Field label="Name" error={fieldErrors.name} required>
          <Input
            autoComplete="off"
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <div className="flex flex-col gap-1.5">
          <p aria-hidden="true" className="font-display text-xs font-bold tracking-wide uppercase">
            Printer type
          </p>
          {profile ? (
            <>
              <p className="font-medium">{PRINTER_TYPE_NAMES[profile.adapter]}</p>
              <p className="text-sm text-dust-500">
                A printer keeps its type. Add a new printer for another type.
              </p>
            </>
          ) : (
            <>
              <SegmentedControl
                label="Printer type"
                value={adapter}
                onValueChange={(v) => setAdapter(v === "pdf" ? "pdf" : "browser")}
                options={[
                  { value: "browser", label: "Browser print" },
                  { value: "pdf", label: "PDF download" },
                  { value: "network_raw", label: "Network", disabled: true },
                  { value: "bluetooth", label: "Bluetooth", disabled: true },
                ]}
              />
              <p className="text-sm text-dust-500">
                {adapter === "pdf"
                  ? "Opens a PDF to share or print (iPhone and iPad: Share → Print)."
                  : "This device's print dialog."}{" "}
                {HARDWARE_NOTE}
              </p>
            </>
          )}
        </div>
        <Field
          label="Calibration offset X (mm)"
          hint="Nudge the print if labels come out off-centre. Positive moves right."
          error={fieldErrors.offsetXMm}
        >
          <NumberInput
            kind="decimal"
            stepper
            step={0.5}
            minValue={-5}
            maxValue={5}
            value={offsetX}
            onValueChange={setOffsetX}
          />
        </Field>
        <Field
          label="Calibration offset Y (mm)"
          hint="Nudge the print if labels come out off-centre. Positive moves down."
          error={fieldErrors.offsetYMm}
        >
          <NumberInput
            kind="decimal"
            stepper
            step={0.5}
            minValue={-5}
            maxValue={5}
            value={offsetY}
            onValueChange={setOffsetY}
          />
        </Field>
        <Switch
          label="Active"
          description={
            profile?.isDefault
              ? "The default printer stays on. Make another printer the default first."
              : "Switched off, it is not offered when printing."
          }
          checked={active}
          disabled={profile?.isDefault ?? false}
          onCheckedChange={setActive}
        />
        {profile && !profile.isDefault ? (
          <div className="flex flex-col gap-1">
            <div>
              <Button variant="outline" onClick={makeDefault} disabled={pending || !profile.active}>
                Make default
              </Button>
            </div>
            <p className="text-sm text-dust-500">
              {profile.active
                ? "Preselected on devices that have not printed yet."
                : "Switch it on and save before making it the default."}
            </p>
          </div>
        ) : null}
      </form>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Label templates
// ---------------------------------------------------------------------------

const KIND_TITLES: Record<LabelKind, string> = {
  product: "Product",
  unit: "Unit",
  bike: "Bike",
};

const FIELD_NAMES: Record<LabelField, string> = {
  name: "Name",
  identity: "Brand, size and colour, condition",
  price: "Price",
  serial_number: "Serial number",
  short_id: "Short ID",
  sku: "SKU",
};

function safeDrawing(
  template: Pick<LabelTemplate, "widthMm" | "heightMm" | "layout">,
  kind: LabelKind,
): LabelDrawing | null {
  try {
    return composeLabel(template, SAMPLE_CONTENT[kind]);
  } catch {
    return null;
  }
}

/** The templates grouped Product / Unit / Bike, rows that open TemplateSheet, and "Add template". */
export function TemplateList({ templates }: { templates: LabelTemplate[] }) {
  const [editing, setEditing] = useState<LabelTemplate | "new" | null>(null);
  const defaults = useMemo(() => {
    const out: Partial<Record<LabelKind, LabelTemplate>> = {};
    for (const t of templates) if (t.isDefault) out[t.kind] = t;
    return out;
  }, [templates]);

  return (
    <div className="flex flex-col gap-5">
      {(["product", "unit", "bike"] as const).map((kind) => {
        const rows = templates.filter((t) => t.kind === kind);
        return (
          <section key={kind} aria-labelledby={`templates-${kind}`} className="flex flex-col gap-2">
            <h3 id={`templates-${kind}`} className="eyebrow text-dust-500">
              {KIND_TITLES[kind]}
            </h3>
            {rows.length === 0 ? (
              <p className="text-sm text-dust-700">
                No template: {KIND_TITLES[kind].toLowerCase()} labels cannot print.
              </p>
            ) : (
              <ul
                aria-label={`${KIND_TITLES[kind]} templates`}
                className="divide-y divide-hairline rounded-2xl border border-hairline bg-card"
              >
                {rows.map((t) => {
                  const drawing = safeDrawing(t, kind);
                  return (
                    <RowButton key={t.id} onClick={() => setEditing(t)}>
                      <span className="w-20 shrink-0" aria-hidden="true">
                        {drawing ? (
                          <LabelSvg
                            drawing={drawing}
                            className="block h-auto w-full rounded ring-1 ring-hairline"
                          />
                        ) : null}
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col gap-1">
                        <span className="flex flex-wrap items-center gap-2">
                          <span
                            className={
                              t.active ? "font-medium break-words" : "font-medium text-dust-500"
                            }
                          >
                            {t.name}
                          </span>
                          {t.isDefault ? <Badge tone="done">Default</Badge> : null}
                          {!t.active ? <Badge>Off</Badge> : null}
                        </span>
                        <span className="text-sm text-dust-500 tabular-nums">
                          {t.widthMm} × {t.heightMm} mm
                        </span>
                      </span>
                    </RowButton>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
      <div>
        <Button
          variant="outline"
          icon={<PlusIcon className="size-5" />}
          onClick={() => setEditing("new")}
        >
          Add template
        </Button>
      </div>
      {editing ? (
        <TemplateSheet
          template={editing === "new" ? null : editing}
          defaults={defaults}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}

const FALLBACK_LAYOUT: LabelTemplate["layout"] = {
  version: 1,
  qrMm: 28,
  paddingMm: 2,
  qrPosition: "left",
  fields: ["name", "price", "short_id", "sku"],
  nameLines: 2,
  textMm: 3,
};

/** The template fields that carry their own error (the rest is the layout's sentence). */
const TEMPLATE_FIELD_KEYS = ["name", "widthMm", "heightMm", "qrMm", "paddingMm", "textMm"] as const;
type TemplateFieldKey = (typeof TEMPLATE_FIELD_KEYS)[number];

function templateFieldKey(path: readonly PropertyKey[]): TemplateFieldKey | null {
  const last = path.at(-1);
  return (TEMPLATE_FIELD_KEYS as readonly PropertyKey[]).includes(last as PropertyKey)
    ? (last as TemplateFieldKey)
    : null;
}

/**
 * One label template: name, kind (fixed once created), size, the QR size
 * and margin, which side the QR goes, which fields print (always in the
 * canonical order; the short ID is always on), name lines and text size,
 * with a live preview on sample content and the layout problem that stops
 * it saving (the database's sentence). A field's own problem (no name, a
 * size out of range) shows on that field once it is changed or Save is
 * pressed, and a blocked Save moves focus to it. "Make default" for its kind.
 */
export function TemplateSheet({
  template,
  defaults,
  onClose,
}: {
  template: LabelTemplate | null;
  defaults: Partial<Record<LabelKind, LabelTemplate>>;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const formId = useId();
  const problemId = useId();
  const start0 = template ?? defaults.product ?? null;
  const layout0 = start0?.layout ?? FALLBACK_LAYOUT;
  const [id] = useState(() => template?.id ?? newId());
  const [name, setName] = useState(template?.name ?? "");
  const [kind, setKind] = useState<LabelKind>(template?.kind ?? "product");
  const [widthMm, setWidthMm] = useState(String(start0?.widthMm ?? 58));
  const [heightMm, setHeightMm] = useState(String(start0?.heightMm ?? 40));
  const [qrMm, setQrMm] = useState(String(layout0.qrMm));
  const [paddingMm, setPaddingMm] = useState(String(layout0.paddingMm));
  const [qrPosition, setQrPosition] = useState<"left" | "right">(layout0.qrPosition);
  const [fields, setFields] = useState<LabelField[]>(layout0.fields);
  const [nameLines, setNameLines] = useState(String(layout0.nameLines));
  const [textMm, setTextMm] = useState(String(layout0.textMm));
  const [active, setActive] = useState(template?.active ?? true);
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [touched, setTouched] = useState<ReadonlySet<TemplateFieldKey>>(() => new Set());
  // Counts blocked saves: each one moves focus to the first invalid field.
  const [attempted, setAttempted] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    if (attempted === 0) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [attempted]);

  const input = {
    name,
    kind,
    widthMm,
    heightMm,
    layout: {
      qrMm,
      paddingMm,
      qrPosition,
      fields: LABEL_FIELD_ORDER.filter((f) => f === "short_id" || fields.includes(f)),
      nameLines,
      textMm,
    },
    active,
  };
  const parsed = labelTemplateInputSchema.safeParse(input);
  // The size and layout alone: the preview needs no name, and a missing
  // name must not hide whether the layout fits (zod skips the fit check
  // while any field is invalid).
  const shapeParsed = labelTemplateInputSchema.safeParse({ ...input, name: "Preview" });
  const fieldIssues: Partial<Record<TemplateFieldKey, string>> = {};
  for (const issue of [
    ...(parsed.success ? [] : parsed.error.issues),
    ...(shapeParsed.success ? [] : shapeParsed.error.issues),
  ]) {
    const key = templateFieldKey(issue.path);
    if (key) fieldIssues[key] ??= issue.message;
  }
  // A problem of the whole layout (the database's sentence, e.g. the QR
  // does not fit): live under the preview, and Save waits for it.
  const problem = shapeParsed.success
    ? null
    : (shapeParsed.error.issues.find((i) => templateFieldKey(i.path) === null)?.message ?? null);
  const shape = parsed.success ? parsed.data : shapeParsed.success ? shapeParsed.data : null;
  const drawing = shape ? safeDrawing(shape, kind) : null;
  // One field's problem shows on that field once it was changed, or after
  // Save was pressed (DESIGN.md "Forms"): never on a form not touched yet.
  const errorFor = (key: TemplateFieldKey) =>
    attempted > 0 || touched.has(key) ? fieldIssues[key] : undefined;
  const edit =
    (key: TemplateFieldKey, set: (v: string) => void) =>
    (v: string): void => {
      set(v);
      setTouched((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
    };

  const chooseKind = (next: LabelKind) => {
    setKind(next);
    const d = defaults[next];
    if (d) setFields(d.layout.fields);
  };

  const toggle = (f: LabelField, on: boolean) =>
    setFields((prev) => (on ? [...prev.filter((x) => x !== f), f] : prev.filter((x) => x !== f)));

  const submit = () => {
    if (!parsed.success) {
      setAttempted((n) => n + 1);
      return;
    }
    start(async () => {
      const r = await callAction(() =>
        saveTemplateAction({
          id,
          mode: template ? "update" : "create",
          template: parsed.data,
        }),
      );
      setResult(r);
      if (r.ok) {
        toast({ title: `${parsed.data.name} saved`, tone: "success" });
        onClose();
      }
    });
  };

  const makeDefault = () =>
    start(async () => {
      if (!template) return;
      const r = await callAction(() => setDefaultTemplateAction({ id: template.id }));
      setResult(r);
      if (r.ok) {
        toast({
          title: `${template.name} is the default ${KIND_TITLES[template.kind].toLowerCase()} label`,
          tone: "success",
        });
        onClose();
      }
    });

  const failure = result && !result.ok ? result : null;
  const mm = (
    key: TemplateFieldKey,
    label: string,
    value: string,
    set: (v: string) => void,
    step: number,
  ) => (
    <Field label={label} error={errorFor(key)} required>
      <NumberInput
        kind="decimal"
        stepper
        step={step}
        minValue={0}
        value={value}
        onValueChange={edit(key, set)}
      />
    </Field>
  );

  return (
    <Sheet
      open
      onOpenChange={(next) => (next ? null : onClose())}
      dismissible={!pending}
      title={template ? `Edit ${template.name}` : "New label template"}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={formId}
            pending={pending}
            pendingLabel="Saving…"
            disabled={problem !== null}
            aria-describedby={problem ? problemId : undefined}
          >
            {template ? "Save" : "Add template"}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        ref={formRef}
        noValidate
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!pending) submit();
        }}
      >
        {failure ? (
          <p role="alert" className="text-sm font-medium text-danger-deep">
            {failure.fieldErrors?.template?.[0] ?? failure.error}
          </p>
        ) : null}

        <figure className="flex flex-col items-center gap-2">
          <div className="flex min-h-24 w-full max-w-80 items-center justify-center rounded-lg ring-1 ring-hairline">
            {drawing ? (
              <LabelSvg drawing={drawing} className="block h-auto w-full" />
            ) : (
              <span className="p-4 text-sm text-dust-500">
                Fix the problem below to see the label.
              </span>
            )}
          </div>
          <figcaption className="text-sm text-dust-700">Preview with sample content</figcaption>
        </figure>
        <p
          id={problemId}
          role="status"
          className={problem ? "text-sm font-medium text-danger-deep" : "sr-only"}
        >
          {problem ?? "The template fits the label."}
        </p>

        <Field label="Name" error={errorFor("name")} required>
          <Input
            autoComplete="off"
            maxLength={80}
            value={name}
            onChange={(e) => edit("name", setName)(e.target.value)}
          />
        </Field>

        <div className="flex flex-col gap-1.5">
          <p aria-hidden="true" className="font-display text-xs font-bold tracking-wide uppercase">
            Labels for
          </p>
          {template ? (
            <>
              <p className="font-medium">{KIND_TITLES[template.kind]}</p>
              <p className="text-sm text-dust-500">
                A template keeps its kind. Add a new template for another kind.
              </p>
            </>
          ) : (
            <SegmentedControl
              label="Labels for"
              value={kind}
              onValueChange={(v) => chooseKind(v as LabelKind)}
              options={[
                { value: "product", label: "Product" },
                { value: "unit", label: "Unit" },
                { value: "bike", label: "Bike" },
              ]}
            />
          )}
        </div>

        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          {mm("widthMm", "Width (mm)", widthMm, setWidthMm, 1)}
          {mm("heightMm", "Height (mm)", heightMm, setHeightMm, 1)}
          {mm("qrMm", "QR size (mm)", qrMm, setQrMm, 1)}
          {mm("paddingMm", "Margin (mm)", paddingMm, setPaddingMm, 0.5)}
        </div>

        <div className="flex flex-col gap-1.5">
          <p aria-hidden="true" className="font-display text-xs font-bold tracking-wide uppercase">
            QR position
          </p>
          <SegmentedControl
            label="QR position"
            value={qrPosition}
            onValueChange={(v) => setQrPosition(v === "right" ? "right" : "left")}
            options={[
              { value: "left", label: "Left" },
              { value: "right", label: "Right" },
            ]}
          />
        </div>

        <fieldset className="flex flex-col">
          <legend className="mb-1 font-display text-xs font-bold tracking-wide uppercase">
            Fields, top to bottom
          </legend>
          {LABEL_FIELD_ORDER.map((f) =>
            f === "short_id" ? (
              <Checkbox
                key={f}
                label={FIELD_NAMES[f]}
                description="Every label shows its short ID."
                checked
                disabled
                readOnly
              />
            ) : (
              <Checkbox
                key={f}
                label={FIELD_NAMES[f]}
                checked={fields.includes(f)}
                onChange={(e) => toggle(f, e.target.checked)}
              />
            ),
          )}
        </fieldset>

        <div className="flex flex-col gap-1.5">
          <p aria-hidden="true" className="font-display text-xs font-bold tracking-wide uppercase">
            Name lines
          </p>
          <SegmentedControl
            label="Name lines"
            value={nameLines}
            onValueChange={setNameLines}
            options={[
              { value: "1", label: "1" },
              { value: "2", label: "2" },
              { value: "3", label: "3" },
            ]}
          />
        </div>

        {mm("textMm", "Text size (mm)", textMm, setTextMm, 0.1)}

        <Switch
          label="Active"
          description={
            template?.isDefault
              ? "The default template stays on. Make another template the default first."
              : "Switched off, it is not offered when printing."
          }
          checked={active}
          disabled={template?.isDefault ?? false}
          onCheckedChange={setActive}
        />

        {template && !template.isDefault ? (
          <div className="flex flex-col gap-1">
            <div>
              <Button
                variant="outline"
                onClick={makeDefault}
                disabled={pending || !template.active}
              >
                Make default
              </Button>
            </div>
            <p className="text-sm text-dust-500">
              {template.active
                ? `Used for ${KIND_TITLES[template.kind].toLowerCase()} labels unless staff choose another size.`
                : "Switch it on and save before making it the default."}
            </p>
          </div>
        ) : null}
      </form>
    </Sheet>
  );
}
