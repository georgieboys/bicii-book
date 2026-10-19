"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useMemo, useState, useTransition } from "react";

import { createPrintJobAction } from "@/app/(staff)/labels/actions";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { Field } from "@/components/ui/field";
import { PrinterIcon } from "@/components/ui/icons";
import { NumberInput } from "@/components/ui/number-input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Sheet } from "@/components/ui/sheet";
import { useFocusFirstInvalid } from "@/components/ui/use-focus-invalid";
import type { ActionResult } from "@/lib/actions";
import { composeLabel } from "@/lib/printing/compose";
import { maxLabelQuantity } from "@/lib/printing/job";
import { LabelSvg } from "@/lib/printing/label-svg";
import { printViewPath } from "@/lib/printing/links";
import {
  QUICK_QUANTITIES,
  chooseTemplate,
  choosePrinter,
  describeLabelPrice,
  initialQuantity,
  priceChanged,
  printButtonLabel,
  readRememberedPrinter,
  rememberPrinter,
} from "@/lib/printing/print-sheet";
import type { LabelKind } from "@/lib/printing/types";
import { newId } from "@/lib/uuid";
import { callAction } from "@/lib/call-action";

import type { PrintLabelPreset, PrintLabelSetup } from "./print-label";

/**
 * The print sheet (mounted only while open, so every opening starts clean
 * with a new job id). Top to bottom: the label as it will print, how many
 * (D56: a per-job cap), which printer (this device's last one preselected)
 * and, when the kind has several, which label size. Print starts the job
 * and opens its print view.
 */
export function PrintLabelSheet({
  kind,
  entityId,
  shortId,
  setup,
  preset,
  onClose,
}: {
  kind: LabelKind;
  entityId: string;
  shortId: string;
  setup: PrintLabelSetup;
  preset: PrintLabelPreset | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const formId = useId();
  const qtyLabelId = useId();
  const [id, setId] = useState(() => newId());
  const max = maxLabelQuantity(kind);
  const [start0] = useState(() => initialQuantity(kind, preset?.requestedQuantity));
  const [quantity, setQuantity] = useState(String(start0.quantity));
  const [profileId, setProfileId] = useState(() =>
    choosePrinter(
      setup.profiles.map((p) => p.id),
      {
        presetId: preset?.profileId,
        rememberedId: readRememberedPrinter(),
        defaultId: setup.defaultProfileId,
      },
    ),
  );
  const [templateId, setTemplateId] = useState(() =>
    chooseTemplate(
      setup.templates.map((t) => t.id),
      { presetId: preset?.templateId, defaultId: setup.defaultTemplateId },
    ),
  );
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [conflict, setConflict] = useState(false);
  const [pending, start] = useTransition();
  const formRef = useFocusFirstInvalid(result);

  const template = setup.templates.find((t) => t.id === templateId) ?? setup.templates[0];
  const profile = setup.profiles.find((p) => p.id === profileId) ?? null;
  const drawing = useMemo(
    () => composeLabel(template, setup.content, profile?.config ?? {}),
    [template, setup.content, profile],
  );
  const reprint = preset?.reprintOfId ?? null;
  const { content } = setup;
  const errors = result && !result.ok ? result.fieldErrors : undefined;
  const label = printButtonLabel(quantity);

  const submit = () =>
    start(async () => {
      setConflict(false);
      const r = await callAction(() =>
        createPrintJobAction({
          id,
          kind,
          entityId,
          quantity,
          profileId: profileId ?? undefined,
          templateId: template?.id,
          reprintOfId: reprint ?? undefined,
        }),
      );
      setResult(r);
      if (r.ok) {
        if (profileId) rememberPrinter(profileId);
        // Inside the transition: the button stays pending until the print view shows.
        // A deep link (`?print=1&qty=…&reprint=…`, `preset`) is spent once
        // it printed: the print view REPLACES that history entry, so Back
        // never lands on it and reopens the sheet for another job.
        if (preset) router.replace(printViewPath(r.data.jobId));
        else router.push(printViewPath(r.data.jobId));
        return;
      }
      if (r.code === "print_job_conflict") {
        // That id already started a different job: the next press is a new one.
        setId(newId());
        setConflict(true);
      }
    });

  return (
    <Sheet
      open
      onOpenChange={(next) => (next ? null : onClose())}
      dismissible={!pending}
      title={reprint ? `Print again · ${shortId}` : `Print labels · ${shortId}`}
      description="Every label is identical. The QR opens this record."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={formId}
            icon={<PrinterIcon className="size-5" />}
            pending={pending}
            pendingLabel="Starting…"
          >
            {label}
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
        {result && !result.ok ? (
          <div role="alert" className="flex flex-col gap-1 text-sm font-medium text-danger-deep">
            {conflict ? (
              <p>
                This print was already started.{" "}
                <Link
                  href={`/labels?q=${encodeURIComponent(shortId)}`}
                  className="underline underline-offset-4"
                >
                  See {shortId}&apos;s print jobs
                </Link>
                , or press Print again to start a new one.
              </p>
            ) : (
              <p>{result.error}</p>
            )}
          </div>
        ) : null}

        <figure className="flex flex-col items-center gap-2">
          <div className="w-full max-w-80 rounded-lg ring-1 ring-hairline">
            <LabelSvg drawing={drawing} className="block h-auto w-full" />
          </div>
          <figcaption className="text-sm text-dust-700 tabular-nums">
            {template.widthMm} × {template.heightMm} mm · {template.name}
          </figcaption>
        </figure>
        {kind === "bike" ? (
          <p className="text-sm text-dust-700">
            Bike tags are for the workshop. Customers who scan one see &lsquo;not found&rsquo;.
          </p>
        ) : setup.isPublic === false ? (
          <p className="rounded-xl bg-waiting-soft px-3 py-2 text-sm text-waiting-deep">
            Not public yet: anyone who scans this label sees &lsquo;not found&rsquo; until it is
            published.
          </p>
        ) : null}
        {reprint && preset && priceChanged(preset.reprintPrice, content.price) ? (
          <p className="rounded-xl bg-waiting-soft px-3 py-2 text-sm text-waiting-deep">
            Price changed since that print (
            {describeLabelPrice(preset.reprintPrice, content.currency)} →{" "}
            {describeLabelPrice(content.price, content.currency)}). These labels show the new price.
          </p>
        ) : null}

        <Field
          label="How many"
          hint={
            kind === "product"
              ? `Up to ${max} labels in one print.`
              : kind === "unit"
                ? "One label per unit. Print a spare for the box if you need one."
                : "One tag per bike. Print a spare if you need one."
          }
          error={errors?.quantity?.[0]}
          required
        >
          <NumberInput
            kind="quantity"
            stepper
            minValue={1}
            maxValue={max}
            value={quantity}
            onValueChange={setQuantity}
          />
        </Field>
        {kind === "product" ? (
          <div className="-mt-2 flex flex-col gap-2">
            <p id={qtyLabelId} className="sr-only">
              Quick choices
            </p>
            <div role="group" aria-labelledby={qtyLabelId} className="flex flex-wrap gap-2">
              {QUICK_QUANTITIES.map((n) => (
                <Chip
                  key={n}
                  pressed={quantity.trim() === String(n)}
                  label={`${n} ${n === 1 ? "label" : "labels"}`}
                  onClick={() => setQuantity(String(n))}
                >
                  {n}
                </Chip>
              ))}
            </div>
          </div>
        ) : null}
        {start0.remaining > 0 ? (
          <p className="text-sm text-waiting-deep">
            Prints {max} now; print again for the remaining {start0.remaining}.
          </p>
        ) : null}

        <ChoiceField
          label="Printer"
          options={setup.profiles.map((p) => ({
            value: p.id,
            label: p.name,
            hint:
              p.adapter === "pdf" ? "Opens a PDF to share or print" : "This device's print dialog",
          }))}
          value={profileId}
          onChange={setProfileId}
          list
        />

        {setup.templates.length > 1 ? (
          <ChoiceField
            label="Label size"
            options={setup.templates.map((t) => ({
              value: t.id,
              label: t.name,
              hint: `${t.widthMm} × ${t.heightMm} mm`,
            }))}
            value={template.id}
            onChange={setTemplateId}
          />
        ) : null}
      </form>
    </Sheet>
  );
}

/**
 * One choice among a few (a SegmentedControl up to 4 short options), or a
 * radio list, each option with its hint: never a long dropdown (SPEC §22).
 * `list` forces the radio list: printer names are long (up to 80
 * characters, "This device (browser print)"), and a segmented row of them
 * scrolls sideways off a phone screen and hides the PDF printer.
 */
function ChoiceField({
  label,
  options,
  value,
  onChange,
  list = false,
}: {
  label: string;
  options: { value: string; label: string; hint: string }[];
  value: string | null;
  onChange: (value: string) => void;
  list?: boolean;
}) {
  const name = useId();
  const chosen = options.find((o) => o.value === value);
  if (!list && options.length <= 4) {
    return (
      <div className="flex flex-col gap-1.5">
        {/* The radiogroup carries the name; this is the visible label. */}
        <p aria-hidden="true" className="font-display text-xs font-bold tracking-wide uppercase">
          {label}
        </p>
        <SegmentedControl label={label} options={options} value={value} onValueChange={onChange} />
        {chosen ? <p className="text-sm text-dust-500">{chosen.hint}</p> : null}
      </div>
    );
  }
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="mb-1.5 font-display text-xs font-bold tracking-wide uppercase">
        {label}
      </legend>
      {options.map((o, i) => (
        <label
          key={o.value}
          className="flex min-h-tap cursor-pointer items-center gap-3 rounded-xl px-2 py-2 hover:bg-dust-100"
        >
          <input
            type="radio"
            name={name}
            value={o.value}
            checked={o.value === value}
            onChange={() => onChange(o.value)}
            aria-labelledby={`${name}-${i}-label`}
            aria-describedby={`${name}-${i}-hint`}
            className="size-5 shrink-0 accent-ink"
          />
          <span className="flex min-w-0 flex-col">
            <span id={`${name}-${i}-label`} className="font-medium break-words">
              {o.label}
            </span>
            <span id={`${name}-${i}-hint`} className="text-sm text-dust-500">
              {o.hint}
            </span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
