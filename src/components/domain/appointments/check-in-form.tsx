"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";

import { checkInAppointment } from "@/app/(staff)/appointments/actions";
import { BikeSheet } from "@/components/domain/bike-sheet";
import { LeadPicker } from "@/components/domain/lead-picker";
import { ShortId } from "@/components/domain/short-id";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { PlusIcon } from "@/components/ui/icons";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { useFocusFirstInvalid } from "@/components/ui/use-focus-invalid";
import type { ActionResult } from "@/lib/actions";
import { cn } from "@/lib/cn";
import type { LinkableJob } from "@/lib/domain/appointments";
import type { IntakeBike } from "@/lib/domain/workshop";
import { newId } from "@/lib/uuid";
import { STATUS_LABELS } from "@/lib/workshop";
import { callAction } from "@/lib/call-action";

type Bike = Pick<IntakeBike, "id" | "shortId" | "title" | "colour"> & { isNew?: boolean };

/**
 * Check-in (SPEC §6 "Check In -> select/create bicycle -> create/link work
 * order"; PLAN D40): the customer's bike (the appointment's preselected;
 * "Add a bike" opens BikeSheet with the owner preset and takes the new bike
 * straight back), then the job: a new one (requested work prefilled from
 * the customer's note, intake notes, an optional lead) or, when the bike
 * already has open jobs with no appointment, one of those. The new job's
 * id is made once, so a double tap or retry opens one job. A new job opens
 * on its intake photos step.
 */
export function CheckInForm({
  appointmentId,
  customer,
  bikes: initialBikes,
  presetBikeId,
  customerNote,
  openJobs,
  me,
  staff,
}: {
  appointmentId: string;
  customer: { id: string; label: string };
  bikes: Bike[];
  presetBikeId: string | null;
  customerNote: string | null;
  openJobs: LinkableJob[];
  me: { id: string; name: string };
  staff: { id: string; name: string }[];
}) {
  const router = useRouter();
  const { toast } = useToast();
  const formId = useId();
  const [newJobId] = useState(() => newId());
  const [bikes, setBikes] = useState<Bike[]>(initialBikes);
  const [bikeId, setBikeId] = useState<string | null>(
    presetBikeId && initialBikes.some((b) => b.id === presetBikeId)
      ? presetBikeId
      : initialBikes.length === 1
        ? initialBikes[0].id
        : null,
  );
  const [bikeSheet, setBikeSheet] = useState(false);
  const [mode, setMode] = useState<string>("new");
  const [requestedWork, setRequestedWork] = useState(customerNote ?? "");
  const [intakeNotes, setIntakeNotes] = useState("");
  const [leadId, setLeadId] = useState<string | null>(null);
  const [state, setState] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const formRef = useFocusFirstInvalid(state);
  const errors = state && !state.ok ? state.fieldErrors : undefined;

  const linkable = openJobs.filter((j) => j.bikeId === bikeId);
  const linkJob = linkable.find((j) => j.id === mode) ?? null;

  const submit = () => {
    if (pending) return;
    const missing: Record<string, string[]> = {};
    if (!bikeId) missing.bikeId = ["Choose the bike they brought."];
    if (!linkJob && !requestedWork.trim())
      missing.requestedWork = ["Say what the customer wants done."];
    if (Object.keys(missing).length > 0) {
      setState({ ok: false, error: "Check the highlighted fields.", fieldErrors: missing });
      return;
    }
    startTransition(async () => {
      const result = await callAction(() =>
        checkInAppointment({
          appointmentId,
          bikeId: bikeId!,
          workOrderId: linkJob ? linkJob.id : newJobId,
          linkExisting: Boolean(linkJob),
          requestedWork: linkJob ? null : requestedWork,
          intakeNotes: linkJob ? null : intakeNotes,
          leadMechanicId: linkJob ? null : leadId,
        }),
      );
      setState(result);
      if (!result.ok) {
        // A refusal no field explains (a job conflict, the appointment
        // cancelled meanwhile) shows only at the top of a long form: say it
        // where the submit button is too.
        if (!result.fieldErrors) {
          toast({ title: "Not checked in", description: result.error, tone: "error" });
        }
        return;
      }
      const { workOrderId, jobNumber, created } = result.data;
      toast({
        title: created ? `Checked in. ${jobNumber} opened.` : `Checked in. Linked to ${jobNumber}.`,
        tone: "success",
      });
      router.push(created ? `/jobs/${workOrderId}?intake=photos` : `/jobs/${workOrderId}`);
    });
  };

  return (
    <>
      <form
        id={formId}
        ref={formRef}
        noValidate
        className="flex flex-col gap-8"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {state && !state.ok ? (
          <p role="alert" className="font-medium text-danger-deep">
            {state.error}
          </p>
        ) : null}

        <fieldset
          className="flex min-w-0 flex-col gap-3"
          aria-invalid={errors?.bikeId ? true : undefined}
          tabIndex={errors?.bikeId ? -1 : undefined}
        >
          <legend className="mb-3 text-xl font-semibold">Bike</legend>
          {errors?.bikeId ? (
            <p className="text-sm font-medium text-danger-deep">{errors.bikeId[0]}</p>
          ) : null}
          {bikes.length === 0 ? (
            <p className="text-dust-500">
              {customer.label} has no bikes yet. Add the bike they brought in.
            </p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {bikes.map((b) => (
                <label
                  key={b.id}
                  className={cn(
                    "relative flex min-h-20 cursor-pointer flex-col justify-center gap-1 rounded-2xl border-2 px-4 py-3 has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-3 has-[:focus-visible]:outline-indigo",
                    bikeId === b.id ? "border-ink bg-dust-100" : "border-hairline bg-card",
                  )}
                >
                  <input
                    type="radio"
                    name="bikeId"
                    value={b.id}
                    checked={bikeId === b.id}
                    onChange={() => {
                      setBikeId(b.id);
                      setMode("new");
                    }}
                    className="sr-only"
                  />
                  <span className="font-semibold">{b.title}</span>
                  <span className="flex flex-wrap items-center gap-2 text-sm text-dust-500">
                    {b.shortId ? <ShortId value={b.shortId} /> : <Badge tone="done">New</Badge>}
                    {b.colour ? <span>{b.colour}</span> : null}
                  </span>
                </label>
              ))}
            </div>
          )}
          <div>
            <Button
              variant="outline"
              icon={<PlusIcon className="size-5" />}
              onClick={() => setBikeSheet(true)}
            >
              Add a bike
            </Button>
          </div>
        </fieldset>

        <fieldset className="flex min-w-0 flex-col gap-5">
          <legend className="mb-3 text-xl font-semibold">Job</legend>
          {linkable.length > 0 ? (
            <div className="flex flex-col gap-2">
              <SegmentedControl
                label="New or existing job"
                value={linkJob ? linkJob.id : "new"}
                onValueChange={setMode}
                options={[
                  { value: "new", label: "New job" },
                  ...linkable.map((j) => ({ value: j.id, label: `Existing job ${j.jobNumber}` })),
                ]}
              />
              <p className="text-sm text-dust-500">
                This bike is already in the shop on an open job with no appointment. Link it instead
                of opening a second job.
              </p>
            </div>
          ) : null}
          {linkJob ? (
            <div className="rounded-2xl border border-hairline bg-card p-4">
              <p className="flex flex-wrap items-center gap-2 font-semibold">
                <ShortId value={linkJob.jobNumber} />
                {STATUS_LABELS[linkJob.status]}
              </p>
              <p className="mt-1 text-dust-700">{linkJob.requestedWork}</p>
            </div>
          ) : (
            <>
              <Field
                label="Requested work"
                hint="What the customer asked for, in their words."
                error={errors?.requestedWork?.[0]}
                required
              >
                <Textarea
                  rows={3}
                  maxLength={2000}
                  value={requestedWork}
                  onChange={(e) => setRequestedWork(e.target.value)}
                />
              </Field>
              <Field
                label="Condition on arrival"
                hint="Scratches, damage, missing parts. Photos come next."
                error={errors?.intakeNotes?.[0]}
              >
                <Textarea
                  rows={3}
                  maxLength={5000}
                  value={intakeNotes}
                  onChange={(e) => setIntakeNotes(e.target.value)}
                />
              </Field>
              <div className="flex flex-col gap-1">
                <LeadPicker me={me} staff={staff} value={leadId} onChange={setLeadId} />
                {errors?.leadMechanicId ? (
                  <p className="text-sm font-medium text-danger-deep">{errors.leadMechanicId[0]}</p>
                ) : (
                  <p className="text-sm text-dust-500">Optional. It can be changed on the job.</p>
                )}
              </div>
            </>
          )}
        </fieldset>

        <div className="sticky bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-20 -mx-1 rounded-full bg-paper/95 p-1 backdrop-blur md:static md:mx-0 md:bg-transparent md:p-0">
          <Button type="submit" size="lg" fullWidth pending={pending} pendingLabel="Checking in…">
            {linkJob ? `Check in and link ${linkJob.jobNumber}` : "Check in and open job"}
          </Button>
        </div>
      </form>

      <BikeSheet
        open={bikeSheet}
        onOpenChange={setBikeSheet}
        owner={customer}
        onCreated={({ id, label }) => {
          setBikes((list) => [
            ...list,
            { id, title: label, shortId: "", colour: null, isNew: true },
          ]);
          setBikeId(id);
          setMode("new");
        }}
      />
    </>
  );
}
