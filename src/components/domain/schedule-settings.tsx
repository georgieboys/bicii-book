"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type ReactNode } from "react";

import {
  deleteClosure,
  saveClosure,
  setShopHours,
  updateShopSettings,
} from "@/app/(staff)/settings/schedule/actions";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { ChevronRightIcon, CloseIcon, PlusIcon } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Sheet } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { useFocusFirstInvalid } from "@/components/ui/use-focus-invalid";
import type { ActionResult } from "@/lib/actions";
import { formatShopDay, shopToday } from "@/lib/dates";
import { formatIntervals, type HoursInterval } from "@/lib/schedule";
import { newId } from "@/lib/uuid";
import { callAction } from "@/lib/call-action";

import { ReasonConfirm } from "./reason-confirm";

/**
 * The schedule settings' sheets (client; Settings → Shop hours and
 * closures; PLAN D2, D37, D38). Admins only: the page renders them for
 * admins, and every action is admin-only in the database too. Each sheet
 * keeps its values in state and submits through onSubmit, so nothing
 * typed is lost on an error, and stays open on a refusal. Saving never
 * moves an existing appointment (D38): the toast names the upcoming ones
 * the schedule no longer fits, with a link to the first such day.
 */

type Affected = { affected: number; firstAffectedDay: string | null };

/** The toast after a schedule change: saved, and how many appointments it affects. */
function useAffectedToast() {
  const { toast } = useToast();
  const router = useRouter();
  return (title: string, { affected, firstAffectedDay }: Affected, what = "no longer fit") => {
    if (affected === 0 || !firstAffectedDay) {
      toast({ title, tone: "success" });
      return;
    }
    toast({
      title,
      description: `${affected} upcoming ${affected === 1 ? "appointment" : "appointments"} ${what} the schedule. They keep their times: call the customers to rebook (first on ${formatShopDay(firstAffectedDay)}).`,
      tone: "info",
      action: {
        label: "Show",
        onAction: () => router.push(`/appointments?date=${firstAffectedDay}`),
      },
    });
  };
}

function FormError({ state }: { state: ActionResult<unknown> | null }) {
  return state && !state.ok ? (
    <p role="alert" className="text-sm font-medium text-danger-deep">
      {state.error}
    </p>
  ) : null;
}

/** "HH:MM" from a time input; a closing "00:00" means midnight at the end of the day. */
const asClosing = (v: string) => (v === "00:00" ? "24:00" : v);
/** A stored closing "24:00" shown in a time input (which stops at 23:59). */
const forInput = (v: string) => (v === "24:00" ? "00:00" : v);

// ---------------------------------------------------------------------------
// Booking capacity and online rules
// ---------------------------------------------------------------------------

export type BookingSettingsValues = {
  slotMinutes: number;
  capacityUnits: number;
  minNoticeMinutes: number;
  horizonDays: number;
  maxActiveBookings: number;
  cancelCutoffMinutes: number;
};

/** "Edit" on the Booking capacity card: one sheet for the six numbers. */
export function EditBookingSettingsButton({ settings }: { settings: BookingSettingsValues }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        aria-label="Edit booking capacity"
        onClick={() => setOpen(true)}
      >
        Edit
      </Button>
      {open ? <BookingSettingsSheet settings={settings} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function BookingSettingsSheet({
  settings,
  onClose,
}: {
  settings: BookingSettingsValues;
  onClose: () => void;
}) {
  const formId = useId();
  const notify = useAffectedToast();
  const [values, setValues] = useState(() =>
    Object.fromEntries(Object.entries(settings).map(([k, v]) => [k, String(v)])),
  );
  const [state, setState] = useState<ActionResult<Affected> | null>(null);
  const [pending, start] = useTransition();
  const formRef = useFocusFirstInvalid(state);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  const field = (key: keyof BookingSettingsValues) => ({
    value: values[key],
    onValueChange: (v: string) => setValues((prev) => ({ ...prev, [key]: v })),
  });

  const submit = () =>
    start(async () => {
      const result = await callAction(() =>
        updateShopSettings(values as Record<keyof BookingSettingsValues, string>),
      );
      setState(result);
      if (!result.ok) return;
      notify("Booking settings saved", result.data);
      onClose();
    });

  return (
    <Sheet
      open
      onOpenChange={(next) => (next ? null : onClose())}
      dismissible={!pending}
      title="Booking capacity"
      description="Existing appointments are never moved or cancelled by a change here."
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
        noValidate
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!pending) submit();
        }}
      >
        <FormError state={state} />
        <Field
          label="Slot length"
          hint="5 to 240 minutes, dividing the day evenly (e.g. 15, 20, 30, 45 or 60): bookings start every slot from midnight."
          error={errors?.slotMinutes?.[0]}
          required
        >
          <NumberInput kind="quantity" suffix="min" {...field("slotMinutes")} />
        </Field>
        <Field
          label="Bikes per slot"
          hint="How many bikes the shop can take in during each slot (a type can take more than one)."
          error={errors?.capacityUnits?.[0]}
          required
        >
          <NumberInput
            kind="quantity"
            stepper
            minValue={1}
            maxValue={50}
            {...field("capacityUnits")}
          />
        </Field>
        <h3 className="font-display text-sm font-bold tracking-wide uppercase">
          Online booking rules
        </h3>
        <Field
          label="Minimum notice"
          hint="How long before a time customers can still book it online (120 = 2 hours)."
          error={errors?.minNoticeMinutes?.[0]}
          required
        >
          <NumberInput kind="quantity" suffix="min" {...field("minNoticeMinutes")} />
        </Field>
        <Field
          label="How far ahead"
          hint="Customers can book up to this many days ahead."
          error={errors?.horizonDays?.[0]}
          required
        >
          <NumberInput kind="quantity" suffix="days" {...field("horizonDays")} />
        </Field>
        <Field
          label="Online bookings per customer"
          hint="Upcoming online bookings one customer may hold at once. Bookings made by staff don't count."
          error={errors?.maxActiveBookings?.[0]}
          required
        >
          <NumberInput
            kind="quantity"
            stepper
            minValue={1}
            maxValue={20}
            {...field("maxActiveBookings")}
          />
        </Field>
        <Field
          label="Online cancellation cutoff"
          hint="Customers can cancel online until this long before the start; after that they call the shop."
          error={errors?.cancelCutoffMinutes?.[0]}
          required
        >
          <NumberInput kind="quantity" suffix="min" {...field("cancelCutoffMinutes")} />
        </Field>
        <p className="text-sm text-dust-500">
          Times are Singapore time. Staff bookings ignore the online rules, never the hours,
          closures or capacity.
        </p>
      </form>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Weekly hours
// ---------------------------------------------------------------------------

export type WeekdayHoursValue = {
  weekday: number;
  name: string;
  active: boolean;
  intervals: HoursInterval[];
};

/**
 * The week, Monday first: "Tuesday 10:00–19:00", "Saturday 09:00–12:30,
 * 13:30–18:00", "Monday Closed". For admins each row opens its sheet.
 */
export function WeeklyHoursList({
  days,
  editable,
}: {
  days: readonly WeekdayHoursValue[];
  editable: boolean;
}) {
  const [editing, setEditing] = useState<WeekdayHoursValue | null>(null);
  return (
    <>
      <ul
        aria-label="Weekly hours"
        className="-mx-4 flex flex-col divide-y divide-hairline sm:-mx-5"
      >
        {days.map((d) => {
          const hours = formatIntervals(d.intervals, d.active);
          const body = (
            <>
              <span className="w-28 shrink-0 font-medium">{d.name}</span>
              <span
                className={
                  d.active && d.intervals.length > 0
                    ? "flex-1 tabular-nums"
                    : "flex-1 text-dust-500"
                }
              >
                {hours}
              </span>
            </>
          );
          return (
            <li key={d.weekday}>
              {editable ? (
                <button
                  type="button"
                  aria-label={`${d.name}: ${hours}. Edit`}
                  onClick={() => setEditing(d)}
                  className="flex min-h-tap w-full cursor-pointer items-center gap-3 px-4 py-3 text-left focus-inset hover:bg-dust-100 sm:px-5"
                >
                  {body}
                  <ChevronRightIcon className="size-5 shrink-0 text-dust-500" />
                </button>
              ) : (
                <div className="flex min-h-tap items-center gap-3 px-4 py-3 sm:px-5">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
      {editing ? <HoursSheet day={editing} onClose={() => setEditing(null)} /> : null}
    </>
  );
}

type IntervalDraft = { key: string; opens: string; closes: string };

function HoursSheet({ day, onClose }: { day: WeekdayHoursValue; onClose: () => void }) {
  const formId = useId();
  const notify = useAffectedToast();
  const [active, setActive] = useState(day.active);
  const [intervals, setIntervals] = useState<IntervalDraft[]>(() =>
    (day.intervals.length > 0 ? day.intervals : [{ opens: "10:00", closes: "19:00" }]).map((i) => ({
      key: newId(),
      opens: i.opens,
      closes: forInput(i.closes),
    })),
  );
  const [state, setState] = useState<ActionResult<Affected> | null>(null);
  const [pending, start] = useTransition();
  const formRef = useFocusFirstInvalid(state);
  const intervalsError = state && !state.ok ? state.fieldErrors?.intervals : undefined;

  const change = (key: string, part: "opens" | "closes", value: string) =>
    setIntervals((list) => list.map((i) => (i.key === key ? { ...i, [part]: value } : i)));

  const submit = () =>
    start(async () => {
      const result = await callAction(() =>
        setShopHours({
          weekday: day.weekday,
          active,
          intervals: intervals.map((i) => ({ opens: i.opens, closes: asClosing(i.closes) })),
        }),
      );
      setState(result);
      if (!result.ok) return;
      notify(`${day.name} saved`, result.data);
      onClose();
    });

  return (
    <Sheet
      open
      onOpenChange={(next) => (next ? null : onClose())}
      dismissible={!pending}
      title={`${day.name} hours`}
      description="Existing appointments keep their times; ones outside the new hours are flagged."
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
        noValidate
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!pending) submit();
        }}
      >
        {state && !state.ok && !intervalsError ? <FormError state={state} /> : null}
        <Switch label={`Open on ${day.name}`} checked={active} onCheckedChange={setActive} />
        {active ? (
          <fieldset
            className="flex flex-col gap-3"
            aria-invalid={intervalsError ? true : undefined}
            tabIndex={intervalsError ? -1 : undefined}
          >
            <legend className="mb-2 font-display text-xs font-bold tracking-wide uppercase">
              Opening hours
            </legend>
            {intervalsError ? (
              <ul className="flex flex-col gap-1 text-sm font-medium text-danger-deep">
                {intervalsError.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            ) : null}
            {intervals.map((i, n) => (
              <div key={i.key} className="flex items-end gap-2">
                <Field label={`Opens (${n + 1})`} className="flex-1">
                  <Input
                    type="time"
                    step={300}
                    value={i.opens}
                    onChange={(e) => change(i.key, "opens", e.target.value)}
                  />
                </Field>
                <Field label={`Closes (${n + 1})`} className="flex-1">
                  <Input
                    type="time"
                    step={300}
                    value={i.closes}
                    onChange={(e) => change(i.key, "closes", e.target.value)}
                  />
                </Field>
                <Button
                  variant="ghost"
                  size="sm"
                  className="mb-1 px-3"
                  aria-label={`Remove ${i.opens}–${i.closes}`}
                  disabled={intervals.length === 1}
                  onClick={() => setIntervals((list) => list.filter((x) => x.key !== i.key))}
                >
                  <CloseIcon className="size-5" />
                </Button>
              </div>
            ))}
            <div>
              <Button
                variant="outline"
                size="sm"
                icon={<PlusIcon className="size-4" />}
                disabled={intervals.length >= 4}
                onClick={() =>
                  setIntervals((list) => [...list, { key: newId(), opens: "", closes: "" }])
                }
              >
                Add hours
              </Button>
            </div>
            <p className="text-sm text-dust-500">
              Up to 4 stretches a day, for a lunch break. A closing time of 00:00 means midnight.
            </p>
          </fieldset>
        ) : (
          <p className="text-dust-700">
            Closed every {day.name}. The hours are kept for when you open again.
          </p>
        )}
      </form>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Closures and short days
// ---------------------------------------------------------------------------

export type ClosureValue = {
  id: string;
  kind: "closed" | "custom_hours";
  firstDay: string;
  lastDay: string;
  fromTime: string | null;
  toTime: string | null;
  reason: string;
};

/** "Add closure": a new id each time it opens (the idempotency key, isNew). */
export function AddClosureButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" icon={<PlusIcon className="size-4" />} onClick={() => setOpen(true)}>
        Add closure
      </Button>
      {open ? <ClosureSheet closure={null} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/** "Edit" on one closure (isNew false). */
export function EditClosureButton({ closure, label }: { closure: ClosureValue; label: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" size="sm" aria-label={`Edit ${label}`} onClick={() => setOpen(true)}>
        Edit
      </Button>
      {open ? <ClosureSheet closure={closure} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function ClosureSheet({ closure, onClose }: { closure: ClosureValue | null; onClose: () => void }) {
  const formId = useId();
  const notify = useAffectedToast();
  const [today] = useState(() => shopToday());
  const [id] = useState(() => closure?.id ?? newId());
  const [kind, setKind] = useState<"closed" | "custom_hours">(closure?.kind ?? "closed");
  const [firstDay, setFirstDay] = useState(closure?.firstDay ?? "");
  const [lastDay, setLastDay] = useState(closure?.lastDay ?? "");
  const [partDay, setPartDay] = useState(closure?.kind === "closed" && closure.fromTime !== null);
  const [fromTime, setFromTime] = useState(closure?.fromTime ?? "");
  const [toTime, setToTime] = useState(closure?.toTime ? forInput(closure.toTime) : "");
  const [reason, setReason] = useState(closure?.reason ?? "");
  const [state, setState] = useState<ActionResult<Affected & { id: string }> | null>(null);
  const [pending, start] = useTransition();
  const formRef = useFocusFirstInvalid(state);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  const timed = kind === "custom_hours" || partDay;
  const oneDay = kind === "closed" && partDay;

  const submit = () =>
    start(async () => {
      const result = await callAction(() =>
        saveClosure({
          id,
          isNew: closure === null,
          kind,
          firstDay,
          lastDay: oneDay || !lastDay ? firstDay : lastDay,
          partDay: kind === "closed" && partDay,
          fromTime: timed ? fromTime : null,
          toTime: timed ? asClosing(toTime) : null,
          reason,
        }),
      );
      setState(result);
      if (!result.ok) return;
      notify(
        closure ? "Closure saved" : kind === "custom_hours" ? "Short day added" : "Closure added",
        result.data,
        kind === "custom_hours" ? "fall outside the hours of" : "are blocked by",
      );
      onClose();
    });

  return (
    <Sheet
      open
      onOpenChange={(next) => (next ? null : onClose())}
      dismissible={!pending}
      title={closure ? "Edit closure" : "Add closure"}
      description="Nobody can book into a closure. Bookings already made keep their times and are flagged."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} pending={pending} pendingLabel="Saving…">
            {closure ? "Save" : kind === "custom_hours" ? "Add short day" : "Add closure"}
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
        <FormError state={state} />
        <SegmentedControl
          label="Kind of closure"
          value={kind}
          onValueChange={setKind}
          options={[
            { value: "closed", label: "Closed" },
            { value: "custom_hours", label: "Short day" },
          ]}
        />
        <p className="-mt-2 text-sm text-dust-500">
          {kind === "closed"
            ? "The shop is closed: no bookings on those days (or those hours)."
            : "The shop opens only these hours on those days, instead of the usual ones."}
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="First day" error={errors?.firstDay?.[0]} required>
            <Input
              type="date"
              min={closure ? undefined : today}
              value={firstDay}
              onChange={(e) => {
                setFirstDay(e.target.value);
                if (!lastDay || lastDay < e.target.value) setLastDay(e.target.value);
              }}
            />
          </Field>
          <Field
            label="Last day"
            hint={oneDay ? "Part of a day closes one day only." : undefined}
            error={errors?.lastDay?.[0]}
            required
          >
            <Input
              type="date"
              min={firstDay || (closure ? undefined : today)}
              value={oneDay ? firstDay : lastDay}
              disabled={oneDay}
              onChange={(e) => setLastDay(e.target.value)}
            />
          </Field>
        </div>
        {kind === "closed" ? (
          <Switch
            label="Only part of the day"
            description="Close a few hours of one day, e.g. 14:00–16:00."
            checked={partDay}
            onCheckedChange={setPartDay}
          />
        ) : null}
        {timed ? (
          <div className="grid grid-cols-2 gap-4">
            <Field
              label={kind === "custom_hours" ? "Opens" : "Closed from"}
              error={errors?.fromTime?.[0]}
              required
            >
              <Input
                type="time"
                step={300}
                value={fromTime}
                onChange={(e) => setFromTime(e.target.value)}
              />
            </Field>
            <Field
              label={kind === "custom_hours" ? "Closes" : "Until"}
              error={errors?.toTime?.[0]}
              required
            >
              <Input
                type="time"
                step={300}
                value={toTime}
                onChange={(e) => setToTime(e.target.value)}
              />
            </Field>
          </div>
        ) : null}
        <Field
          label="Reason"
          hint="For staff, e.g. Public holiday or Stocktake. Customers only see that no times are free."
          error={errors?.reason?.[0]}
          required
        >
          <Textarea
            rows={2}
            maxLength={200}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
      </form>
    </Sheet>
  );
}

/** Delete a closure: two steps with a required reason (it re-opens those hours). */
export function DeleteClosureControl({ id, label }: { id: string; label: string }) {
  return (
    <ReasonConfirm
      startLabel="Delete…"
      startAccessibleName={`Delete ${label}…`}
      startVariant="ghost"
      startSize="sm"
      question={`Why remove ${label}?`}
      confirmLabel="Delete closure"
      pendingLabel="Deleting…"
      failureTitle="Closure not deleted"
      successTitle="Closure deleted"
      dismissLabel="Keep closure"
      onConfirm={(reason) => deleteClosure({ id, reason })}
    >
      Those hours open for booking again.
    </ReasonConfirm>
  );
}

/** A labelled read-only figure on the Booking capacity card. */
export function SettingFigure({
  label,
  value,
  note,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5 py-2">
      <dt className="text-sm text-dust-500">{label}</dt>
      <dd className="font-medium">{value}</dd>
      {note ? <dd className="text-sm text-dust-700">{note}</dd> : null}
    </div>
  );
}
