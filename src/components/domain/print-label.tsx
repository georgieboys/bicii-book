"use client";

import dynamic from "next/dynamic";
import { usePathname, useRouter } from "next/navigation";
import { useId, useState, useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";
import { PrinterIcon } from "@/components/ui/icons";
import type { LabelContent, LabelKind, LabelTemplate, PrinterProfile } from "@/lib/printing/types";

/**
 * Printing from a record (SPEC §16: open the record → Print label → how
 * many → printer → print; PLAN D56–D59, ADR-017). The label text, price
 * and QR come from the database (label_preview, then the job's snapshot);
 * this only chooses how many, which printer and which label size, starts
 * the job (createPrintJobAction, keyed by an id minted when the sheet
 * opens) and opens its print view.
 */

/** What the sheet needs from the record page's label context (getLabelContext, ok). */
export type PrintLabelSetup = {
  content: LabelContent;
  templates: LabelTemplate[];
  profiles: PrinterProfile[];
  defaultTemplateId: string | null;
  defaultProfileId: string | null;
  /** Products and units: whether a scan shows it publicly now; null for a bike tag. */
  isPublic: boolean | null;
};

/** The deep link's preset (resolvePrintPreset): opens the sheet once with these. */
export type PrintLabelPreset = {
  requestedQuantity: number;
  reprintOfId: string | null;
  profileId: string | null;
  templateId: string | null;
  reprintPrice: string | null;
};

const noSubscribe = () => () => {};

/**
 * The sheet and what it draws the label with (the QR encoder and the PDF
 * fonts' metrics, about 120 KB gzip that hardly compresses) load when it
 * first opens, not with every product, unit and bike page.
 */
const PrintLabelSheet = dynamic(
  () => import("./print-label-sheet").then((m) => m.PrintLabelSheet),
  {
    ssr: false,
  },
);

/**
 * "Print label" (outline, 48 px). Disabled, with the reason beneath it,
 * when the record cannot get a label now (`unavailable`). With `preset`
 * (the page's `?print=1&qty=…&reprint=…`) the sheet opens once by itself;
 * closing it drops those parameters from the address, and printing from
 * it replaces that address with the print view (Back does not reopen it).
 */
export function PrintLabelButton({
  kind,
  entityId,
  shortId,
  setup,
  unavailable,
  preset = null,
}: {
  kind: LabelKind;
  entityId: string;
  shortId: string;
  setup: PrintLabelSetup | null;
  /** Why printing is unavailable (getLabelContext's message) when `setup` is null. */
  unavailable?: string | null;
  preset?: PrintLabelPreset | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const describedBy = useId();
  // The preset opens the sheet after hydration (the sheet is a portal,
  // never part of the server HTML), and only once.
  const mounted = useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false,
  );
  const [manual, setManual] = useState(false);
  const [presetDone, setPresetDone] = useState(false);
  const auto = mounted && setup !== null && preset !== null && !presetDone;
  const open = manual || auto;

  const close = () => {
    setManual(false);
    if (auto) {
      setPresetDone(true);
      router.replace(pathname, { scroll: false });
    }
  };

  if (setup === null) {
    return (
      <div className="flex max-w-xs flex-col gap-1">
        <div>
          <Button
            variant="outline"
            icon={<PrinterIcon className="size-5" />}
            disabled
            aria-describedby={unavailable ? describedBy : undefined}
          >
            Print label
          </Button>
        </div>
        {unavailable ? (
          <p id={describedBy} className="text-sm text-dust-700">
            {unavailable}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <>
      <Button
        variant="outline"
        icon={<PrinterIcon className="size-5" />}
        onClick={() => setManual(true)}
      >
        Print label
      </Button>
      {open ? (
        <PrintLabelSheet
          kind={kind}
          entityId={entityId}
          shortId={shortId}
          setup={setup}
          preset={auto ? preset : null}
          onClose={close}
        />
      ) : null}
    </>
  );
}
