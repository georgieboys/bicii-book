"use client";

import { useRouter } from "next/navigation";
import { useActionState, useId, useState, useTransition } from "react";

import {
  archiveAdventureAction,
  createAdventureAction,
  publishAdventureAction,
  removeAdventureOfferAction,
  setAdventureOfferAction,
  startAdventureDraftAction,
  unarchiveAdventureAction,
} from "@/app/(staff)/adventures/actions";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { PlusIcon } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { useFocusFirstInvalid } from "@/components/ui/use-focus-invalid";
import type { ActionResult } from "@/lib/actions";
import {
  PARTICIPATION_DESCRIPTIONS,
  PARTICIPATION_LABELS,
  suggestedPrice,
  type AdventureParticipation,
} from "@/lib/adventures";
import { callAction } from "@/lib/call-action";
import { formatMoney } from "@/lib/money";

type State = ActionResult<unknown> | null;

/** The error line a sheet shows above its fields. */
function FormError({ state }: { state: State }) {
  return state && !state.ok ? (
    <p role="alert" className="text-sm font-medium text-danger-deep">
      {state.error}
    </p>
  ) : null;
}

// ---------------------------------------------------------------- new ----

/** New adventure (manage_adventures): web address, name, distance; opens it. */
export function NewAdventureButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button icon={<PlusIcon className="size-5" />} onClick={() => setOpen(true)}>
        New adventure
      </Button>
      {open ? <NewAdventureSheet onOpenChange={setOpen} /> : null}
    </>
  );
}

function NewAdventureSheet({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const { toast } = useToast();
  const formId = useId();
  const [state, formAction, pending] = useActionState<State, FormData>(async (prev, formData) => {
    const result = await callAction(
      () => createAdventureAction(prev as ActionResult<{ id: string }> | null, formData),
      formData,
    );
    if (result.ok) {
      toast({ title: "Adventure created", tone: "success" });
      router.push(`/adventures/${(result.data as { id: string }).id}`);
    }
    return result;
  }, null);
  const formRef = useFocusFirstInvalid(state);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  const values = state && !state.ok ? state.values : undefined;

  return (
    <Sheet
      open
      onOpenChange={onOpenChange}
      dismissible={!pending}
      title="New adventure"
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} pending={pending} pendingLabel="Creating…">
            Create adventure
          </Button>
        </>
      }
    >
      <form
        id={formId}
        ref={formRef}
        action={formAction}
        className="flex flex-col gap-5"
        noValidate
      >
        <FormError state={state} />
        <Field label="Name" error={errors?.name?.[0]} required>
          <Input
            name="name"
            autoComplete="off"
            placeholder="BICII 250"
            defaultValue={values?.name}
          />
        </Field>
        <Field
          label="Web address"
          hint="The end of its address on bicii.sg, like bicii-250. It cannot change later."
          error={errors?.slug?.[0]}
          required
        >
          <Input
            name="slug"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="bicii-250"
            defaultValue={values?.slug}
          />
        </Field>
        <Field
          label="Distance (km)"
          hint="Certification can be offered from 125 km."
          error={errors?.distanceKm?.[0]}
          required
        >
          <Input
            name="distanceKm"
            inputMode="decimal"
            autoComplete="off"
            defaultValue={values?.distanceKm}
          />
        </Field>
        <p className="text-sm text-dust-700">
          It starts as a draft. Nothing appears on bicii.sg until you publish it.
        </p>
      </form>
    </Sheet>
  );
}

// -------------------------------------------------------------- draft ----

/** Starts (or reopens) the draft: a copy of the published version. */
export function StartDraftButton({ adventureId }: { adventureId: string }) {
  const { toast } = useToast();
  const [pending, start] = useTransition();
  return (
    <Button
      pending={pending}
      pendingLabel="Starting…"
      onClick={() =>
        start(async () => {
          const result = await callAction(() => startAdventureDraftAction({ adventureId }));
          if (!result.ok) toast({ title: result.error, tone: "error" });
        })
      }
    >
      Edit
    </Button>
  );
}

// ------------------------------------------------------------- offers ----

export type OfferFields = {
  kind: AdventureParticipation;
  price: string;
  trackerHirePrice: string | null;
  supportedDays: number | null;
  inclusions: string;
};

/** Add or change the draft's offer of one kind, with the formula's price as a hint (D165). */
export function OfferButton({
  revisionId,
  kind,
  offer,
  nominalDays,
}: {
  revisionId: string;
  kind: AdventureParticipation;
  offer: OfferFields | null;
  nominalDays: number | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant={offer ? "outline" : "solid"} size="sm" onClick={() => setOpen(true)}>
        {offer ? "Change" : "Add offer"}
      </Button>
      {open ? (
        <OfferSheet
          revisionId={revisionId}
          kind={kind}
          offer={offer}
          nominalDays={nominalDays}
          onOpenChange={setOpen}
        />
      ) : null}
    </>
  );
}

function OfferSheet({
  revisionId,
  kind,
  offer,
  nominalDays,
  onOpenChange,
}: {
  revisionId: string;
  kind: AdventureParticipation;
  offer: OfferFields | null;
  nominalDays: number | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const formId = useId();
  const [supportedDays, setSupportedDays] = useState(offer?.supportedDays?.toString() ?? "");
  const [state, formAction, pending] = useActionState<State, FormData>(async (prev, formData) => {
    const result = await callAction(
      () => setAdventureOfferAction(prev as ActionResult<null> | null, formData),
      formData,
    );
    if (result.ok) {
      toast({ title: `${PARTICIPATION_LABELS[kind]} offer saved`, tone: "success" });
      onOpenChange(false);
    }
    return result;
  }, null);
  const formRef = useFocusFirstInvalid(state);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  const values = state && !state.ok ? state.values : undefined;
  const days = /^\d+$/.test(supportedDays) ? Number(supportedDays) : null;
  const suggestion = suggestedPrice(kind, nominalDays, days);

  return (
    <Sheet
      open
      onOpenChange={onOpenChange}
      dismissible={!pending}
      title={`${PARTICIPATION_LABELS[kind]} offer`}
      description={PARTICIPATION_DESCRIPTIONS[kind]}
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} pending={pending} pendingLabel="Saving…">
            Save offer
          </Button>
        </>
      }
    >
      <form
        id={formId}
        ref={formRef}
        action={formAction}
        className="flex flex-col gap-5"
        noValidate
      >
        <input type="hidden" name="revisionId" value={revisionId} />
        <input type="hidden" name="kind" value={kind} />
        <FormError state={state} />
        {kind === "supported" ? (
          <Field
            label="Supported days"
            hint="How many days BICII supports the ride."
            error={errors?.supportedDays?.[0]}
            required
          >
            <Input
              name="supportedDays"
              inputMode="numeric"
              autoComplete="off"
              value={supportedDays}
              onChange={(e) => setSupportedDays(e.target.value)}
            />
          </Field>
        ) : null}
        <Field
          label="Price (SGD)"
          hint={
            suggestion
              ? `The pricing formula gives ${formatMoney(suggestion)}. No GST is added.`
              : kind === "supported"
                ? "Enter the supported days to see the formula's price. No GST is added."
                : "Set the route's nominal days to see the formula's price. No GST is added."
          }
          error={errors?.price?.[0]}
          required
        >
          <Input
            name="price"
            inputMode="decimal"
            autoComplete="off"
            defaultValue={values?.price ?? offer?.price ?? suggestion ?? ""}
          />
        </Field>
        {kind === "supported" ? (
          <p className="text-sm text-dust-700">The tracker is included. No hire charge is added.</p>
        ) : (
          <Field
            label="Tracker hire per 24 hours (SGD)"
            hint="Leave blank to not offer tracker hire. The usual price is S$20.00."
            error={errors?.trackerHirePrice?.[0]}
          >
            <Input
              name="trackerHirePrice"
              inputMode="decimal"
              autoComplete="off"
              defaultValue={values?.trackerHirePrice ?? offer?.trackerHirePrice ?? ""}
            />
          </Field>
        )}
        <Field
          label="What's included"
          hint="Shown to riders before they buy."
          error={errors?.inclusions?.[0]}
        >
          <Textarea
            name="inclusions"
            rows={3}
            defaultValue={
              values?.inclusions ??
              offer?.inclusions ??
              "Certification review, finisher T-shirt, patch, pin and sticker, and a place on the finisher board."
            }
          />
        </Field>
      </form>
    </Sheet>
  );
}

export function RemoveOfferButton({
  revisionId,
  kind,
}: {
  revisionId: string;
  kind: AdventureParticipation;
}) {
  const { toast } = useToast();
  const [pending, start] = useTransition();
  return (
    <Button
      variant="ghost"
      size="sm"
      pending={pending}
      pendingLabel="Removing…"
      onClick={() =>
        start(async () => {
          const result = await callAction(() => removeAdventureOfferAction({ revisionId, kind }));
          toast(
            result.ok
              ? { title: `${PARTICIPATION_LABELS[kind]} offer removed`, tone: "success" }
              : { title: result.error, tone: "error" },
          );
        })
      }
    >
      Remove
    </Button>
  );
}

// ------------------------------------------------------------ publish ----

/** Publish the draft: what the public sees changes now; the version is sealed. */
export function PublishButton({
  revisionId,
  firstPublish,
}: {
  revisionId: string;
  firstPublish: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="accent" onClick={() => setOpen(true)}>
        Publish
      </Button>
      {open ? (
        <PublishSheet revisionId={revisionId} firstPublish={firstPublish} onOpenChange={setOpen} />
      ) : null}
    </>
  );
}

function PublishSheet({
  revisionId,
  firstPublish,
  onOpenChange,
}: {
  revisionId: string;
  firstPublish: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const formId = useId();
  const [state, formAction, pending] = useActionState<State, FormData>(async (prev, formData) => {
    const result = await callAction(
      () => publishAdventureAction(prev as ActionResult<null> | null, formData),
      formData,
    );
    if (result.ok) {
      toast({ title: "Published", tone: "success" });
      onOpenChange(false);
    }
    return result;
  }, null);
  const formRef = useFocusFirstInvalid(state);
  const errors = state && !state.ok ? state.fieldErrors : undefined;

  return (
    <Sheet
      open
      onOpenChange={onOpenChange}
      dismissible={!pending}
      title="Publish this draft?"
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={formId}
            variant="accent"
            pending={pending}
            pendingLabel="Publishing…"
          >
            Publish
          </Button>
        </>
      }
    >
      <form
        id={formId}
        ref={formRef}
        action={formAction}
        className="flex flex-col gap-5"
        noValidate
      >
        <input type="hidden" name="revisionId" value={revisionId} />
        <FormError state={state} />
        <p className="text-sm text-dust-700">
          {firstPublish
            ? "It appears on bicii.sg once the site reads the catalogue."
            : "It replaces the version on bicii.sg once the site reads the catalogue."}{" "}
          This version is then locked: later changes start a new draft, and anything sold keeps the
          terms it was sold with.
        </p>
        <Field
          label="What changed"
          hint="For the history. Optional."
          error={errors?.changeSummary?.[0]}
        >
          <Textarea name="changeSummary" rows={2} />
        </Field>
      </form>
    </Sheet>
  );
}

// ------------------------------------------------------------ archive ----

export function ArchiveAdventureButton({ adventureId }: { adventureId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        Archive
      </Button>
      {open ? <ArchiveSheet adventureId={adventureId} onOpenChange={setOpen} /> : null}
    </>
  );
}

function ArchiveSheet({
  adventureId,
  onOpenChange,
}: {
  adventureId: string;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const formId = useId();
  const [state, formAction, pending] = useActionState<State, FormData>(async (prev, formData) => {
    const result = await callAction(
      () => archiveAdventureAction(prev as ActionResult<null> | null, formData),
      formData,
    );
    if (result.ok) {
      toast({ title: "Archived", tone: "success" });
      onOpenChange(false);
    }
    return result;
  }, null);
  const formRef = useFocusFirstInvalid(state);
  const errors = state && !state.ok ? state.fieldErrors : undefined;

  return (
    <Sheet
      open
      onOpenChange={onOpenChange}
      dismissible={!pending}
      title="Archive this adventure?"
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={formId}
            variant="danger"
            pending={pending}
            pendingLabel="Archiving…"
          >
            Archive
          </Button>
        </>
      }
    >
      <form
        id={formId}
        ref={formRef}
        action={formAction}
        className="flex flex-col gap-5"
        noValidate
      >
        <input type="hidden" name="adventureId" value={adventureId} />
        <FormError state={state} />
        <p className="text-sm text-dust-700">
          It comes off bicii.sg and cannot be sold. Nothing is deleted, and you can unarchive it
          later.
        </p>
        <Field label="Reason" error={errors?.reason?.[0]} required>
          <Textarea name="reason" rows={2} />
        </Field>
      </form>
    </Sheet>
  );
}

export function UnarchiveAdventureButton({ adventureId }: { adventureId: string }) {
  const { toast } = useToast();
  const [pending, start] = useTransition();
  return (
    <Button
      variant="outline"
      pending={pending}
      pendingLabel="Unarchiving…"
      onClick={() =>
        start(async () => {
          const result = await callAction(() => unarchiveAdventureAction({ adventureId }));
          toast(
            result.ok
              ? { title: "Unarchived", tone: "success" }
              : { title: result.error, tone: "error" },
          );
        })
      }
    >
      Unarchive
    </Button>
  );
}
