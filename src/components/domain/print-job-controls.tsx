"use client";

import Link from "next/link";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from "react";

import { setPrintJobStatusAction } from "@/app/(staff)/labels/actions";
import { Button, buttonClasses } from "@/components/ui/button";
import { PrinterIcon } from "@/components/ui/icons";
import { useToast } from "@/components/ui/toast";
import { useArmed } from "@/components/ui/use-armed";
import type { PrintStatus } from "@/lib/printing/types";
import { callAction } from "@/lib/call-action";

import { ReasonConfirm } from "./reason-confirm";

/**
 * The print view's controls for an OPEN job (queued or rendered; D59).
 * They never create a job ("Print again" is always a link to the record).
 *
 * - Browser printer: "Print" calls window.print() synchronously inside the
 *   click (iOS Safari drops the user gesture after an await), then marks
 *   the job rendered without waiting (skipped when it already is) and
 *   shows the confirmation.
 * - PDF printer: "Open PDF" opens the job's PDF in a new tab (Share ->
 *   Print on an iPad), marks the job rendered and shows the confirmation.
 * - A job already rendered (sent earlier, not confirmed) shows the
 *   confirmation straight away.
 *
 * The parts share one state (PrintJobProvider) so the print view can keep
 * only the action in its compact sticky toolbar and put the hint and the
 * confirmation in the page's flow: a sticky confirmation grew taller than
 * a phone screen and hid "Mark as failed" (review finding, Phase 8).
 * PrintJobControls is all of them stacked, for one place.
 */

type PrintJobState = {
  confirming: boolean;
  /** Marks the job rendered (once) and asks for the confirmation. */
  sent: () => void;
};

const PrintJobContext = createContext<PrintJobState | null>(null);

function usePrintJob(): PrintJobState {
  const ctx = useContext(PrintJobContext);
  if (!ctx) throw new Error("PrintJob parts must be inside PrintJobProvider");
  return ctx;
}

export function PrintJobProvider({
  jobId,
  status,
  children,
}: {
  jobId: string;
  status: Extract<PrintStatus, "queued" | "rendered">;
  children: ReactNode;
}) {
  const { toast } = useToast();
  const [confirming, setConfirming] = useState(status === "rendered");
  const marked = useRef(status === "rendered");

  const sent = useCallback(() => {
    setConfirming(true);
    if (marked.current) return;
    marked.current = true;
    void setPrintJobStatusAction({ id: jobId, status: "rendered" }).then((result) => {
      if (!result.ok) {
        marked.current = false;
        toast({ title: "Not recorded as sent", description: result.error, tone: "error" });
      }
    });
  }, [jobId, toast]);

  const value = useMemo(() => ({ confirming, sent }), [confirming, sent]);
  return <PrintJobContext.Provider value={value}>{children}</PrintJobContext.Provider>;
}

/** "Print" (browser printer) or "Open PDF" (PDF printer). */
export function PrintJobAction({
  adapter,
  pdfHref,
  size = "lg",
}: {
  adapter: "browser" | "pdf";
  pdfHref: string;
  size?: "md" | "lg";
}) {
  const { sent } = usePrintJob();

  if (adapter === "browser") {
    return (
      <Button
        size={size}
        icon={<PrinterIcon className="size-5" />}
        onClick={() => {
          // Synchronous, first: the print dialog needs the click's user gesture.
          window.print();
          sent();
        }}
      >
        Print
      </Button>
    );
  }
  return (
    <a
      href={pdfHref}
      target="_blank"
      rel="noopener"
      className={buttonClasses({ size })}
      onClick={sent}
    >
      <PrinterIcon className="size-5" />
      Open PDF
    </a>
  );
}

/** What to choose in the print dialog, or how to print the PDF. */
export function PrintJobHint({
  adapter,
  widthMm,
  heightMm,
}: {
  adapter: "browser" | "pdf";
  widthMm: number;
  heightMm: number;
}) {
  const size = `${widthMm} × ${heightMm} mm`;
  return (
    <p className="text-sm text-dust-700">
      {adapter === "browser"
        ? `In the print dialog choose the label printer, paper ${size}, scale 100%, no margins.`
        : `Open the PDF, then Share → Print. Set the paper to ${size}, scale 100%.`}
    </p>
  );
}

/** The confirmation, once the job was sent (or straight away when it already was). */
export function PrintJobConfirmWhenSent(props: {
  jobId: string;
  quantity: number;
  shortId: string;
  recordHref: string;
}) {
  const { confirming } = usePrintJob();
  return confirming ? <PrintJobConfirm {...props} /> : null;
}

export function PrintJobControls({
  jobId,
  status,
  adapter,
  quantity,
  pdfHref,
  widthMm,
  heightMm,
  shortId,
  recordHref,
}: {
  jobId: string;
  status: Extract<PrintStatus, "queued" | "rendered">;
  adapter: "browser" | "pdf";
  quantity: number;
  pdfHref: string;
  widthMm: number;
  heightMm: number;
  shortId: string;
  recordHref: string;
}) {
  return (
    <PrintJobProvider jobId={jobId} status={status}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <div>
            <PrintJobAction adapter={adapter} pdfHref={pdfHref} />
          </div>
          <PrintJobHint adapter={adapter} widthMm={widthMm} heightMm={heightMm} />
        </div>
        <PrintJobConfirmWhenSent
          jobId={jobId}
          quantity={quantity}
          shortId={shortId}
          recordHref={recordHref}
        />
      </div>
    </PrintJobProvider>
  );
}

/** The D59 question: "Did the label print correctly?" for one, "Did all N labels …" for more. */
export function confirmQuestion(quantity: number): string {
  return quantity === 1
    ? "Did the label print correctly?"
    : `Did all ${quantity} labels print correctly?`;
}

/**
 * "Did all N labels print correctly?" (D59; "Did the label …" for one): staff confirm the job printed,
 * or say what went wrong (two steps with a required reason, DESIGN.md
 * "Forms"). Focus moves here when it appears. Used on the print view and on
 * an open job's history page.
 */
export function PrintJobConfirm({
  jobId,
  quantity,
  shortId,
  recordHref,
  autoFocus = true,
}: {
  jobId: string;
  quantity: number;
  shortId: string;
  recordHref: string;
  /** Move focus here when it appears (it appears after Print); not on page load. */
  autoFocus?: boolean;
}) {
  const { toast } = useToast();
  const [pending, start] = useTransition();
  const [done, setDone] = useState<"printed" | "failed" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const armed = useArmed(true);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  const printed = () =>
    start(async () => {
      setError(null);
      const result = await callAction(() =>
        setPrintJobStatusAction({ id: jobId, status: "printed" }),
      );
      if (!result.ok) {
        setError(result.error);
        toast({ title: "Not marked as printed", description: result.error, tone: "error" });
        return;
      }
      setDone("printed");
      toast({ title: "Marked as printed", tone: "success" });
    });

  const links = (
    <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm font-medium">
      <Link href={recordHref} className="underline underline-offset-4">
        Back to {shortId}
      </Link>
      <Link href="/labels" className="underline underline-offset-4">
        Print history
      </Link>
    </p>
  );

  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="group"
      aria-labelledby={`confirm-${jobId}`}
      className="flex scroll-mt-32 flex-col gap-3 rounded-2xl border border-hairline bg-card p-4 focus:outline-none"
    >
      <h2 id={`confirm-${jobId}`} className="text-lg">
        {done === "printed"
          ? "Marked as printed"
          : done === "failed"
            ? "Marked as failed"
            : confirmQuestion(quantity)}
      </h2>
      {done ? (
        links
      ) : (
        <>
          <div className="flex flex-wrap items-start gap-3">
            <Button disabled={!armed} pending={pending} pendingLabel="Saving…" onClick={printed}>
              Yes, all printed
            </Button>
          </div>
          <ReasonConfirm
            startLabel="Something went wrong…"
            startVariant="ghost"
            question="What went wrong?"
            hint="For example: the roll ran out, the labels came out blank or misaligned."
            confirmLabel="Mark as failed"
            pendingLabel="Saving…"
            failureTitle="Not marked as failed"
            successTitle="Marked as failed"
            dismissLabel="Back"
            onConfirm={async (reason) => {
              const result = await callAction(() =>
                setPrintJobStatusAction({
                  id: jobId,
                  status: "failed",
                  error: reason,
                }),
              );
              return result.ok || !result.fieldErrors?.error
                ? result
                : { ...result, fieldErrors: { reason: result.fieldErrors.error } };
            }}
            onDone={() => setDone("failed")}
          >
            Nothing is reprinted automatically: use Print again on the record for a new job.
          </ReasonConfirm>
          {error ? (
            <p role="alert" className="text-sm font-medium text-danger-deep">
              {error}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
