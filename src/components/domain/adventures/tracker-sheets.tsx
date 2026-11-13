"use client";

import { useState } from "react";

import {
  cancelTrackerHireAction,
  correctCaptureAction,
  issueTrackerAction,
  registerTrackingDeviceAction,
  replaceTrackerAction,
  returnTrackerAction,
  saveTrackingFeedAction,
  setTrackerHireAction,
  setTrackingDeviceStateAction,
} from "@/app/(staff)/adventures/actions";
import { FormSheet, useOpen, type FormAction } from "@/components/domain/adventures/booking-sheets";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field } from "@/components/ui/field";
import { PlusIcon } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { TRACKER_CONDITION_LABELS, TRACKER_STATE_LABELS } from "@/lib/adventures";

/**
 * The tracker hire sheets (D186-D188): register a tracker, change its
 * state, give one out, replace it, take it back, cancel a hire, and the
 * hire switch. Each is one Server Action; the RPCs check everything again.
 */

export type DeviceChoice = { id: string; label: string };

const act = (a: unknown) => a as FormAction;

/** manage_adventures: add a tracker (it starts in maintenance until checked). */
export function RegisterTrackerButton() {
  const { open, show, close } = useOpen();
  return (
    <>
      <Button icon={<PlusIcon className="size-5" />} onClick={show}>
        Add tracker
      </Button>
      {open ? (
        <FormSheet
          title="Add a tracker"
          description="It starts in maintenance. Put it in service once it's charged and its feed shows it."
          submitLabel="Add tracker"
          pendingLabel="Adding…"
          success="Tracker added"
          action={act(registerTrackingDeviceAction)}
          hidden={{}}
          onClose={close}
        >
          {(errors) => (
            <>
              <Field
                label="Label"
                hint="What's written on it, like T-01."
                error={errors?.label?.[0]}
                required
              >
                <Input name="label" autoComplete="off" />
              </Field>
              <Field label="Service" error={errors?.provider?.[0]} required>
                <Select name="provider" defaultValue="spot">
                  <option value="spot">SPOT</option>
                  <option value="fake">Test tracker (fake feed)</option>
                </Select>
              </Field>
              <Field
                label="Device ID"
                hint="The ID the service shows for this device (on SPOT, its ESN)."
                error={errors?.providerDeviceId?.[0]}
                required
              >
                <Input name="providerDeviceId" autoComplete="off" spellCheck={false} />
              </Field>
              <Field label="Model" error={errors?.model?.[0]}>
                <Input name="model" autoComplete="off" placeholder="SPOT Gen4" />
              </Field>
            </>
          )}
        </FormSheet>
      ) : null}
    </>
  );
}

/** manage_adventures: in service, maintenance, lost or retired (not while someone has it). */
export function TrackerStateButton({
  deviceId,
  label,
  state,
}: {
  deviceId: string;
  label: string;
  state: string;
}) {
  const { open, show, close } = useOpen();
  return (
    <>
      <Button variant="outline" size="sm" onClick={show}>
        Change<span className="sr-only"> the state of {label}</span>
      </Button>
      {open ? (
        <FormSheet
          title={`Tracker ${label}`}
          submitLabel="Save"
          pendingLabel="Saving…"
          success="Saved"
          action={act(setTrackingDeviceStateAction)}
          hidden={{ deviceId }}
          onClose={close}
        >
          {(errors) => (
            <>
              <Field label="State" error={errors?.state?.[0]} required>
                <Select name="state" defaultValue={state}>
                  {Object.entries(TRACKER_STATE_LABELS).map(([value, text]) => (
                    <option key={value} value={value}>
                      {text}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Note" hint="Battery, damage, where it is." error={errors?.note?.[0]}>
                <Textarea name="note" rows={2} />
              </Field>
            </>
          )}
        </FormSheet>
      ) : null}
    </>
  );
}

function DeviceSelect({ devices, name = "deviceId" }: { devices: DeviceChoice[]; name?: string }) {
  return (
    <Select name={name} defaultValue="">
      <option value="" disabled>
        Choose a tracker
      </option>
      {devices.map((d) => (
        <option key={d.id} value={d.id}>
          {d.label}
        </option>
      ))}
    </Select>
  );
}

/** manage_adventures: give a tracker to a rider whose hire is paid. */
export function IssueTrackerButton({
  reservationId,
  riderName,
  devices,
}: {
  reservationId: string;
  riderName: string;
  devices: DeviceChoice[];
}) {
  const { open, show, close } = useOpen();
  return (
    <>
      <Button size="sm" onClick={show} disabled={devices.length === 0}>
        Give out
      </Button>
      {open ? (
        <FormSheet
          title={`Give a tracker to ${riderName}`}
          description="Check it's charged and switched on with the rider before they leave."
          submitLabel="Give out"
          pendingLabel="Saving…"
          success="Tracker given out"
          action={act(issueTrackerAction)}
          hidden={{ reservationId }}
          onClose={close}
        >
          {(errors) => (
            <>
              <Field label="Tracker" error={errors?.deviceId?.[0]} required>
                <DeviceSelect devices={devices} />
              </Field>
              <Field label="Note" hint="Its condition as it leaves." error={errors?.note?.[0]}>
                <Textarea name="note" rows={2} />
              </Field>
            </>
          )}
        </FormSheet>
      ) : null}
    </>
  );
}

/** manage_adventures: swap a failed tracker during a ride (both stay on the ride). */
export function ReplaceTrackerButton({
  assignmentId,
  devices,
}: {
  assignmentId: string;
  devices: DeviceChoice[];
}) {
  const { open, show, close } = useOpen();
  return (
    <>
      <Button variant="outline" size="sm" onClick={show} disabled={devices.length === 0}>
        Replace
      </Button>
      {open ? (
        <FormSheet
          title="Replace the tracker"
          description="The old one goes to maintenance. Both stay on this ride."
          submitLabel="Replace"
          pendingLabel="Saving…"
          success="Tracker replaced"
          action={act(replaceTrackerAction)}
          hidden={{ assignmentId }}
          onClose={close}
        >
          {(errors) => (
            <>
              <Field label="Replacement" error={errors?.deviceId?.[0]} required>
                <DeviceSelect devices={devices} />
              </Field>
              <Field label="What went wrong" error={errors?.reason?.[0]} required>
                <Textarea name="reason" rows={2} />
              </Field>
            </>
          )}
        </FormSheet>
      ) : null}
    </>
  );
}

/** manage_adventures: the tracker is back (or lost). */
export function ReturnTrackerButton({
  assignmentId,
  late,
}: {
  assignmentId: string;
  late: boolean;
}) {
  const { open, show, close } = useOpen();
  return (
    <>
      <Button size="sm" onClick={show}>
        Take back
      </Button>
      {open ? (
        <FormSheet
          title="Take the tracker back"
          description={
            late
              ? "It's back after its return day. Settle that with the rider yourself: nothing is charged."
              : undefined
          }
          submitLabel="Save"
          pendingLabel="Saving…"
          success="Tracker returned"
          action={act(returnTrackerAction)}
          hidden={{ assignmentId }}
          onClose={close}
        >
          {(errors) => (
            <>
              <Field label="Condition" error={errors?.condition?.[0]} required>
                <Select name="condition" defaultValue="good">
                  {Object.entries(TRACKER_CONDITION_LABELS).map(([value, text]) => (
                    <option key={value} value={value}>
                      {text}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Note" error={errors?.note?.[0]}>
                <Textarea name="note" rows={2} />
              </Field>
            </>
          )}
        </FormSheet>
      ) : null}
    </>
  );
}

/** Admin: cancel a hire nobody collected. */
export function CancelHireButton({ reservationId }: { reservationId: string }) {
  const { open, show, close } = useOpen();
  return (
    <>
      <Button variant="outline" size="sm" onClick={show}>
        Cancel hire
      </Button>
      {open ? (
        <FormSheet
          title="Cancel this hire?"
          description="The tracker is free for others. Refund the hire in Stripe yourself if it's owed."
          submitLabel="Cancel hire"
          pendingLabel="Cancelling…"
          danger
          success="Hire cancelled"
          action={act(cancelTrackerHireAction)}
          hidden={{ reservationId }}
          onClose={close}
        >
          {(errors) => (
            <Field label="Reason" error={errors?.reason?.[0]} required>
              <Textarea name="reason" rows={2} />
            </Field>
          )}
        </FormSheet>
      ) : null}
    </>
  );
}

/** Admin: whether riders can hire a tracker, and for how many days at most. */
export function TrackerHireControl({
  enabled,
  maxDays,
  inService,
}: {
  enabled: boolean;
  maxDays: number;
  inService: number;
}) {
  const { open, show, close } = useOpen();
  const [on, setOn] = useState(enabled);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <p className="text-sm">
        {enabled
          ? `Riders can hire a tracker for up to ${maxDays} ${maxDays === 1 ? "day" : "days"}.`
          : "Riders cannot hire a tracker."}{" "}
        {inService} {inService === 1 ? "tracker" : "trackers"} in service.
      </p>
      <Button variant="outline" size="sm" onClick={show}>
        Change<span className="sr-only"> tracker hire</span>
      </Button>
      {open ? (
        <FormSheet
          title="Tracker hire"
          description="Hire is sold with a certified ride, at the offer's price per day. Only trackers in service can be hired."
          submitLabel="Save"
          pendingLabel="Saving…"
          success="Saved"
          action={act(setTrackerHireAction)}
          hidden={{}}
          onClose={close}
        >
          {(errors) => (
            <>
              <Checkbox
                name="enabled"
                label="Riders can hire a tracker"
                checked={on}
                onChange={(e) => setOn(e.target.checked)}
              />
              {on && inService === 0 ? (
                <p className="rounded-xl bg-waiting-soft px-3 py-2 text-sm text-waiting-deep">
                  No tracker is in service, so nobody can hire one yet.
                </p>
              ) : null}
              <Field label="Longest hire (days)" error={errors?.maxDays?.[0]} required>
                <Input name="maxDays" inputMode="numeric" defaultValue={String(maxDays)} />
              </Field>
            </>
          )}
        </FormSheet>
      ) : null}
    </div>
  );
}

/** Admin: add a feed, or change one's name and whether it is read. */
export function TrackingFeedButton({
  feed,
}: {
  feed?: { id: string; provider: string; label: string; configName: string; enabled: boolean };
}) {
  const { open, show, close } = useOpen();
  return (
    <>
      <Button variant={feed ? "outline" : undefined} size="sm" onClick={show}>
        {feed ? (
          <>
            Change<span className="sr-only"> the feed {feed.label}</span>
          </>
        ) : (
          "Add feed"
        )}
      </Button>
      {open ? (
        <FormSheet
          title={feed ? `Feed ${feed.label}` : "Add a tracking feed"}
          description="The feed's ID is never typed here. Set it in Vercel as the variable named below (and NAME_PASSWORD if the feed has one), then redeploy."
          submitLabel="Save"
          pendingLabel="Saving…"
          success="Saved"
          action={act(saveTrackingFeedAction)}
          hidden={
            feed ? { feedId: feed.id, provider: feed.provider, configName: feed.configName } : {}
          }
          onClose={close}
        >
          {(errors) => (
            <>
              <Field label="Name" error={errors?.label?.[0]} required>
                <Input
                  name="label"
                  autoComplete="off"
                  defaultValue={feed?.label}
                  placeholder="Shop SPOT feed"
                />
              </Field>
              {feed ? null : (
                <>
                  <Field label="Service" error={errors?.provider?.[0]} required>
                    <Select name="provider" defaultValue="spot">
                      <option value="spot">SPOT</option>
                      <option value="fake">Test feed (fake trackers)</option>
                    </Select>
                  </Field>
                  <Field
                    label="Variable name"
                    hint="Starts TRACKING_FEED_. For SPOT it holds the shared feed's ID; for the test feed, device IDs separated by commas."
                    error={errors?.configName?.[0]}
                    required
                  >
                    <Input
                      name="configName"
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="TRACKING_FEED_SHOP"
                    />
                  </Field>
                </>
              )}
              <Checkbox
                name="enabled"
                label="Read this feed"
                defaultChecked={feed?.enabled ?? false}
              />
            </>
          )}
        </FormSheet>
      ) : null}
    </>
  );
}

/** verify_adventures: correct a missed or wrong Start or Finish (D189). */
export function CorrectCaptureButton({
  attemptId,
  startedAt,
  finishedAt,
}: {
  attemptId: string;
  /** datetime-local values in shop time, or "". */
  startedAt: string;
  finishedAt: string;
}) {
  const { open, show, close } = useOpen();
  return (
    <>
      <Button variant="outline" size="sm" onClick={show}>
        Correct the ride window
      </Button>
      {open ? (
        <FormSheet
          title="Correct the ride window"
          description="Only the tracker's points recorded inside this window count for the ride. Changing it never certifies anything by itself."
          submitLabel="Save"
          pendingLabel="Saving…"
          success="Ride window corrected"
          action={act(correctCaptureAction)}
          hidden={{ attemptId }}
          onClose={close}
        >
          {(errors) => (
            <>
              <Field label="Started" error={errors?.startedAt?.[0]} required>
                <Input name="startedAt" type="datetime-local" defaultValue={startedAt} />
              </Field>
              <Field
                label="Finished"
                hint="Leave empty if the ride is still going."
                error={errors?.finishedAt?.[0]}
              >
                <Input name="finishedAt" type="datetime-local" defaultValue={finishedAt} />
              </Field>
              <Field label="Why" error={errors?.reason?.[0]} required>
                <Textarea
                  name="reason"
                  rows={2}
                  placeholder="The rider forgot to press Start Ride."
                />
              </Field>
            </>
          )}
        </FormSheet>
      ) : null}
    </>
  );
}
