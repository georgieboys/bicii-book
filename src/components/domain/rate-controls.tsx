"use client";

import { useEffect, useRef, useState, useTransition } from "react";

import {
  cancelCultCommonsRate,
  scheduleCultCommonsRate,
} from "@/app/(staff)/settings/services/actions";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Sheet } from "@/components/ui/sheet";
import { useToast } from "@/components/ui/toast";
import { useArmed } from "@/components/ui/use-armed";
import { formatRate, percentToRate } from "@/lib/cult-commons";
import { formatDateTime, fromShopLocal, toShopLocal } from "@/lib/dates";
import { newId } from "@/lib/uuid";
import { callAction } from "@/lib/call-action";

/**
 * Admin: "Schedule a new rate" (D21). A percentage with up to two decimals
 * (converted exactly to the stored 4-decimal fraction), starting now or at
 * a later Singapore time, then a second step that says what it does: lines
 * added from then on use it; existing lines never change.
 */
export function ScheduleRateButton({ currentRate }: { currentRate: string | null }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Schedule a new rate
      </Button>
      {open ? <ScheduleRateSheet currentRate={currentRate} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function ScheduleRateSheet({
  currentRate,
  onClose,
}: {
  currentRate: string | null;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [percent, setPercent] = useState("");
  const [when, setWhen] = useState<"now" | "later">("now");
  const [at, setAt] = useState(() => toShopLocal(new Date(Date.now() + 86_400_000)));
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const armed = useArmed(confirming);
  const confirmRef = useRef<HTMLDivElement>(null);
  // The idempotency key: a retried "start now" finds the rate it scheduled.
  const [rateId] = useState(newId);

  const rate = percentToRate(percent);
  const start = when === "later" ? fromShopLocal(at) : null;

  useEffect(() => {
    if (confirming) confirmRef.current?.querySelector<HTMLButtonElement>("[data-back]")?.focus();
  }, [confirming]);

  const review = () => {
    const next: Record<string, string | undefined> = {};
    if (!rate) next.percent = "Enter a percentage from 0 to 100 with at most two decimals.";
    if (when === "later" && (!start || start.getTime() <= Date.now())) {
      next.effectiveFrom = "Choose a time in the future, or start it now.";
    }
    setErrors(next);
    if (Object.values(next).some(Boolean)) return;
    setFormError(null);
    setConfirming(true);
  };

  const confirm = () =>
    startTransition(async () => {
      const result = await callAction(() =>
        scheduleCultCommonsRate({
          rateId,
          percent,
          when,
          effectiveFrom: when === "later" ? at : undefined,
        }),
      );
      if (!result.ok) {
        setConfirming(false);
        setErrors({
          percent: result.fieldErrors?.percent?.[0],
          effectiveFrom: result.fieldErrors?.effectiveFrom?.[0],
        });
        setFormError(result.error);
        return;
      }
      toast({
        title: `Cult Commons rate ${formatRate(rate!)} ${when === "now" ? "now in force" : "scheduled"}`,
        tone: "success",
      });
      onClose();
    });

  return (
    <Sheet
      open
      onOpenChange={(next) => (next ? null : onClose())}
      dismissible={!pending}
      title="Schedule a new rate"
      description={currentRate ? `The rate in force now is ${formatRate(currentRate)}.` : undefined}
      footer={
        confirming ? null : (
          <>
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button key="review" onClick={review}>
              Review
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-5">
        {formError ? (
          <p role="alert" className="text-sm font-medium text-danger-deep">
            {formError}
          </p>
        ) : null}
        <Field
          label="Rate"
          hint="Percent of each line's positive yield, up to two decimals."
          error={errors.percent}
          required
        >
          <Input
            inputMode="decimal"
            autoComplete="off"
            suffix="%"
            value={percent}
            disabled={confirming}
            onChange={(e) => {
              setPercent(e.target.value);
              setErrors((x) => ({ ...x, percent: undefined }));
            }}
          />
        </Field>
        <div className="flex flex-col gap-2">
          <p className="font-display text-xs font-bold tracking-wide uppercase">Starts</p>
          <SegmentedControl<"now" | "later">
            label="Starts"
            options={[
              { value: "now", label: "Now", disabled: confirming },
              { value: "later", label: "Later", disabled: confirming },
            ]}
            value={when}
            onValueChange={setWhen}
          />
        </div>
        {when === "later" ? (
          <Field
            label="Starts at"
            hint="Singapore time. Never in the past."
            error={errors.effectiveFrom}
            required
          >
            <Input
              type="datetime-local"
              value={at}
              disabled={confirming}
              onChange={(e) => {
                setAt(e.target.value);
                setErrors((x) => ({ ...x, effectiveFrom: undefined }));
              }}
            />
          </Field>
        ) : null}
        {confirming && rate ? (
          <div
            key="confirm"
            ref={confirmRef}
            className="flex flex-col gap-3 rounded-xl bg-waiting-soft p-4 text-waiting-deep"
          >
            <p className="font-medium">
              Cult Commons becomes {formatRate(rate)} of positive yield{" "}
              {start ? `from ${formatDateTime(start)}` : "from now"}.
            </p>
            <p className="text-sm">
              It applies to job lines added from then on. Lines already on jobs keep the rate they
              were added with and never change. A rate that has started can&rsquo;t be cancelled,
              only replaced by a new one.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                key="back"
                data-back=""
                variant="outline"
                disabled={pending}
                onClick={() => setConfirming(false)}
              >
                Back
              </Button>
              <Button
                key="confirm-rate"
                disabled={!armed}
                pending={pending}
                pendingLabel="Saving…"
                onClick={confirm}
              >
                {when === "now" ? "Start this rate now" : "Schedule this rate"}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </Sheet>
  );
}

/**
 * Admin: "Cancel" on a rate that has not started (D21). Two steps: the
 * confirmation puts focus on "Keep it" and its confirm button stays
 * disabled for 400 ms.
 */
export function CancelRateButton({
  rateId,
  label,
}: {
  rateId: string;
  /** "27.5% from 1 Nov 2026, 9:00 am". */
  label: string;
}) {
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const armed = useArmed(confirming);
  const boxRef = useRef<HTMLDivElement>(null);
  const startRef = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);

  useEffect(() => {
    const cancelled = wasConfirming.current && !confirming;
    wasConfirming.current = confirming;
    if (cancelled) startRef.current?.focus();
    if (confirming) boxRef.current?.querySelector<HTMLButtonElement>("[data-keep]")?.focus();
  }, [confirming]);

  const cancel = () =>
    startTransition(async () => {
      const result = await callAction(() => cancelCultCommonsRate({ rateId }));
      if (!result.ok) {
        toast({ title: "Rate not cancelled", description: result.error, tone: "error" });
        return;
      }
      wasConfirming.current = false;
      setConfirming(false);
      toast({ title: `Cancelled ${label}`, tone: "success" });
    });

  if (!confirming) {
    return (
      <div key="start">
        <Button
          ref={startRef}
          variant="ghost"
          size="sm"
          aria-label={`Cancel ${label}`}
          onClick={() => setConfirming(true)}
        >
          Cancel…
        </Button>
      </div>
    );
  }
  return (
    <div
      key="confirm"
      ref={boxRef}
      className="flex w-full flex-col gap-3 rounded-xl bg-danger-soft p-3 text-danger-deep"
    >
      <p className="text-sm">
        Cancel {label}? It never starts; the rate in force carries on. The record stays, marked
        cancelled.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          key="keep"
          data-keep=""
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => setConfirming(false)}
        >
          Keep it
        </Button>
        <Button
          key="confirm-cancel"
          variant="danger"
          size="sm"
          disabled={!armed}
          pending={pending}
          pendingLabel="Cancelling…"
          onClick={cancel}
        >
          Cancel rate
        </Button>
      </div>
    </div>
  );
}
