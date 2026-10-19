"use client";

import { useId, useState, useTransition } from "react";

import { setPublication } from "@/app/(staff)/inventory/actions";
import { Button } from "@/components/ui/button";
import { CheckIcon, CloseIcon } from "@/components/ui/icons";
import { StatusPill } from "@/components/ui/status-pill";
import { useToast } from "@/components/ui/toast";
import { useArmedAfter } from "@/components/ui/use-armed";
import type { PublicPreview } from "@/lib/domain/inventory";
import {
  missingRequirements,
  publicationActions,
  publicationChecklist,
  publicationLabel,
  publicationTone,
  type PublicationRequirements,
  type PublicationStatus,
  type TrackingType,
} from "@/lib/inventory";
import { callAction } from "@/lib/call-action";

import { PublicPreviewPanel } from "./public-preview";
import { QrLabelUrl } from "./qr-label-url";

const STATUS_NOTES: Record<PublicationStatus, string> = {
  draft: "Not listed anywhere yet. Make it internal to get it ready for publishing.",
  internal_only: "Staff see it; the public does not. Publish when it is ready to sell.",
  public: "Listed: anyone scanning its QR label sees the public details below.",
  sold: "Sold items return to public automatically if the sale is reversed.",
  archived: "Withdrawn. Restore brings it back as internal only.",
};

const DONE: Record<PublicationStatus, string> = {
  draft: "Listing is a draft",
  internal_only: "Listing is internal only",
  public: "Published",
  sold: "Listing is sold",
  archived: "Listing archived",
};

/**
 * The product page's publication card (D26 PUBLICATION-MACHINE): the
 * current status; the moves staff may make by hand (publicationActions:
 * never 'sold', a sold product only archives, no Publish for a unique
 * product without an available unit) as buttons, disabled for 400 ms after
 * each change because the next move lands where the last one was; the
 * requirement checklist with Publish disabled until all are met, naming
 * what is missing; the QR URL with Copy (or "QR address not set", D9); and
 * what the public sees. The
 * database decides every move; its refusals show their mapped message.
 * Only for manage_inventory holders (others see the status and preview).
 */
export function PublicationControls({
  productId,
  status,
  trackingType,
  availableUnits,
  requirements,
  qrUrl,
  isAdmin,
  preview,
  canManage,
}: {
  productId: string;
  status: PublicationStatus;
  trackingType: TrackingType;
  availableUnits: number;
  requirements: PublicationRequirements;
  /** From src/lib/qr.ts; null while the shop's public website address is not set (D9). */
  qrUrl: string | null;
  isAdmin: boolean;
  preview: PublicPreview | null;
  canManage: boolean;
}) {
  const { toast } = useToast();
  const missingId = useId();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const armed = useArmedAfter(status);
  const actions = canManage ? publicationActions(status, { trackingType, availableUnits }) : [];
  const missing = missingRequirements(requirements);
  const checklist = publicationChecklist(requirements);
  const showChecklist = status !== "public" && status !== "sold";

  const change = (to: PublicationStatus) =>
    start(async () => {
      setError(null);
      const result = await callAction(() => setPublication({ productId, status: to }));
      if (result.ok) {
        toast({ title: DONE[result.data.status], tone: "success" });
        return;
      }
      setError(result.error);
      toast({ title: "Listing not changed", description: result.error, tone: "error" });
    });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <p className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-dust-500">Status</span>
          <StatusPill status={publicationTone(status)}>{publicationLabel(status)}</StatusPill>
        </p>
        <p className="text-sm text-dust-700">{STATUS_NOTES[status]}</p>
      </div>

      {showChecklist ? (
        <div className="flex flex-col gap-1">
          <h3 className="font-display text-xs font-bold tracking-wide uppercase">
            Publishing needs
          </h3>
          <ul aria-label="Publishing needs" className="flex flex-col gap-1">
            {checklist.map((r) => (
              <li key={r.key} className="flex items-center gap-2 text-sm">
                {r.met ? (
                  <CheckIcon aria-hidden="true" className="size-4 shrink-0 text-done-deep" />
                ) : (
                  <CloseIcon aria-hidden="true" className="size-4 shrink-0 text-danger-deep" />
                )}
                <span className={r.met ? undefined : "font-medium"}>{r.label}</span>
                <span className="sr-only">{r.met ? "(done)" : "(missing)"}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {actions.length > 0 ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            {actions.map((a) => {
              const blocked = a.to === "public" && missing !== null;
              return (
                <Button
                  key={`${status}-${a.to}`}
                  variant={a.to === "public" ? "solid" : "outline"}
                  size="sm"
                  disabled={blocked || !armed || pending}
                  aria-describedby={blocked ? missingId : undefined}
                  onClick={() => change(a.to)}
                >
                  {a.label}
                </Button>
              );
            })}
          </div>
          {actions.some((a) => a.to === "public") && missing ? (
            <p id={missingId} className="text-sm text-waiting-deep">
              {missing}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm font-medium text-danger-deep">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}

      <QrLabelUrl value={qrUrl} isAdmin={isAdmin} />

      <PublicPreviewPanel preview={preview} />
    </div>
  );
}
