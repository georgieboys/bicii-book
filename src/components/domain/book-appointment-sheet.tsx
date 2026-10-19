"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useState, useTransition, type ReactNode } from "react";

import { bookAppointment, loadSchedule } from "@/app/(staff)/appointments/actions";
import { listIntakeBikes } from "@/app/(staff)/jobs/actions";
import { Badge } from "@/components/ui/badge";
import { Button, type ButtonSize, type ButtonVariant } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { PlusIcon } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import type { PickerOption } from "@/components/ui/search-picker";
import { Sheet } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { useFocusFirstInvalid } from "@/components/ui/use-focus-invalid";
import type { ActionResult } from "@/lib/actions";
import { formatAppointmentStart, formatClock } from "@/lib/appointments/format";
import { availableSlots, type AvailableSlot } from "@/lib/appointments/slots";
import { daysFrom } from "@/lib/appointments/time";
import { cn } from "@/lib/cn";
import { formatShopDayShort, parseShopDay, shopDayToDate, shopToday } from "@/lib/dates";
import type { ScheduleData } from "@/lib/domain/appointments";
import type { IntakeBike } from "@/lib/domain/workshop";
import { newId } from "@/lib/uuid";
import { callAction } from "@/lib/call-action";

import { CustomerPicker } from "./customer-picker";
import { ShortId } from "./short-id";

/** How many days the sheet loads and computes at once (the chip strip and "Next day with free times"). */
const WINDOW_DAYS = 14;

/** How often the free times are recomputed as the clock moves on. */
const CLOCK_TICK_MS = 30_000;

/** Refusals that mean the time is no longer bookable: show why, reload the times, keep the rest. */
const SLOT_CODES = new Set([
  "appointment_capacity_exceeded",
  "appointment_slot_misaligned",
  "appointment_outside_hours",
  "appointment_closed",
  "appointment_in_past",
]);

export type BookAppointmentSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Start with this customer (the customer page). */
  presetCustomer?: { id: string; label: string };
  /** Keep the preset customer: the picker is replaced by their name. */
  lockCustomer?: boolean;
  /** Start on this shop day (the day the list shows); today when earlier or missing. */
  presetDate?: string;
};

/**
 * Book an appointment for a customer (SPEC §6; PLAN D2, D37, D38): the
 * customer, the type (staff see staff-only types too), a date from a
 * 14-day strip or the date input, a time computed in the browser from ONE
 * schedule load per 14-day window with the database's own rules
 * (src/lib/appointments/slots.ts; staff see the units left), the bike
 * ("Decide at check-in" by default) and the notes. The booking's id is made
 * when the sheet opens, so a retry books once. A time that filled up
 * meanwhile is refused by the database: the sheet says so, reloads the
 * times and keeps everything else. The body is mounted only while open.
 */
export function BookAppointmentSheet(props: BookAppointmentSheetProps) {
  return props.open ? <BookAppointmentBody {...props} /> : null;
}

type Loaded =
  { key: string; data: ScheduleData; receivedAt: number } | { key: string; error: string };

type BikesLoaded =
  { customerId: string; bikes: IntakeBike[] } | { customerId: string; error: string };

function BookAppointmentBody({
  onOpenChange,
  presetCustomer,
  lockCustomer = false,
  presetDate,
}: BookAppointmentSheetProps) {
  const router = useRouter();
  const { toast } = useToast();
  const formId = useId();
  const [id] = useState(() => newId());
  const [today] = useState(() => shopToday());
  const startDay =
    presetDate && parseShopDay(presetDate) !== null && presetDate > today ? presetDate : today;
  const [customer, setCustomer] = useState<PickerOption | null>(
    presetCustomer ? { id: presetCustomer.id, label: presetCustomer.label } : null,
  );
  const [typeId, setTypeId] = useState<string | null>(null);
  const [date, setDate] = useState(startDay);
  const [windowFrom, setWindowFrom] = useState(startDay);
  const [reloads, setReloads] = useState(0);
  const [startsAt, setStartsAt] = useState<string | null>(null);
  const [bikeId, setBikeId] = useState("");
  const [customerNote, setCustomerNote] = useState("");
  const [internalNote, setInternalNote] = useState("");
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [bikes, setBikes] = useState<BikesLoaded | null>(null);
  const [state, setState] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const formRef = useFocusFirstInvalid(state);

  // The device's clock, read every CLOCK_TICK_MS (only the time elapsed
  // since a load is taken from it), so a time that ends while the sheet is
  // open drops out.
  const [deviceNow, setDeviceNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setDeviceNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const scheduleKey = `${windowFrom}#${reloads}`;
  useEffect(() => {
    let live = true;
    loadSchedule({ from: windowFrom, days: WINDOW_DAYS }).then(
      (result) => {
        if (!live) return;
        setLoaded(
          result.ok
            ? { key: scheduleKey, data: result.data, receivedAt: Date.now() }
            : { key: scheduleKey, error: result.error },
        );
      },
      () => live && setLoaded({ key: scheduleKey, error: "Couldn't load the times." }),
    );
    return () => {
      live = false;
    };
  }, [windowFrom, scheduleKey]);

  const customerId = customer?.id ?? null;
  useEffect(() => {
    if (!customerId) return;
    let live = true;
    listIntakeBikes({ customerId }).then(
      (result) => {
        if (!live) return;
        setBikes(
          result.ok ? { customerId, bikes: result.data } : { customerId, error: result.error },
        );
      },
      () => live && setBikes({ customerId, error: "Couldn't load the bikes." }),
    );
    return () => {
      live = false;
    };
  }, [customerId]);

  const schedule = loaded && loaded.key === scheduleKey && "data" in loaded ? loaded : null;
  const scheduleError =
    loaded && loaded.key === scheduleKey && "error" in loaded ? loaded.error : null;
  const loadingTimes = !schedule && !scheduleError;
  const types = schedule?.data.types ?? [];
  // The first type until one is chosen (or when the chosen one is no longer active).
  const type = types.find((t) => t.id === typeId) ?? types[0] ?? null;

  /** Every loaded day's free times for the chosen type. */
  const slotsByDay = useMemo(() => {
    const out = new Map<string, AvailableSlot[]>();
    if (!schedule || !type) return out;
    const { data } = schedule;
    const ctx = {
      settings: data.settings,
      hours: data.hours,
      closures: data.closures,
      appointments: data.appointments,
    };
    // The server's clock (the database refuses a time by its own now()),
    // advanced by the time elapsed here since the load: a device clock that
    // runs slow or fast must not offer an ended slot or hide a live one.
    const elapsed = Math.max(0, deviceNow - schedule.receivedAt);
    const asOf = new Date(Date.parse(data.asOf) + elapsed);
    for (const day of daysFrom(data.from, data.days)) {
      out.set(day, availableSlots({ day, type, asOf, forStaff: true }, ctx));
    }
    return out;
  }, [schedule, type, deviceNow]);

  const daySlots = slotsByDay.get(date) ?? [];
  const nextDay = [...slotsByDay.entries()].find(([d, s]) => d > date && s.length > 0)?.[0] ?? null;
  const chosenSlot = daySlots.find((s) => s.start.toISOString() === startsAt) ?? null;
  const customerBikes =
    customerId && bikes && bikes.customerId === customerId && "bikes" in bikes ? bikes.bikes : null;
  const bikesError =
    customerId && bikes && bikes.customerId === customerId && "error" in bikes ? bikes.error : null;

  const chooseDate = (next: string) => {
    if (parseShopDay(next) === null) return;
    setDate(next);
    setStartsAt(null);
    const end = daysFrom(windowFrom, WINDOW_DAYS).at(-1)!;
    if (next < windowFrom || next > end) setWindowFrom(next);
  };

  const errors = state && !state.ok ? state.fieldErrors : undefined;

  const submit = () => {
    if (pending) return;
    const missing: Record<string, string[]> = {};
    if (!customer) missing.customerId = ["Choose the customer."];
    if (!type) missing.appointmentTypeId = ["Choose the type of appointment."];
    if (!chosenSlot) missing.startsAt = ["Choose a time."];
    if (Object.keys(missing).length > 0) {
      setState({ ok: false, error: "Check the highlighted fields.", fieldErrors: missing });
      return;
    }
    startTransition(async () => {
      const result = await callAction(() =>
        bookAppointment({
          id,
          customerId: customer!.id,
          appointmentTypeId: type!.id,
          startsAt: chosenSlot!.start.toISOString(),
          bikeId: bikeId || null,
          customerNote,
          internalNote,
        }),
      );
      if (!result.ok) {
        const slotRefused = Boolean(result.code && SLOT_CODES.has(result.code));
        // A refused time is the Time field's error: it shows beside the
        // reloaded grid and useFocusFirstInvalid scrolls it into view, even
        // when the sheet is scrolled down to the notes.
        setState(
          slotRefused
            ? { ...result, fieldErrors: { ...result.fieldErrors, startsAt: [result.error] } }
            : result,
        );
        if (slotRefused) {
          setStartsAt(null);
          setReloads((n) => n + 1);
        }
        if (slotRefused || !result.fieldErrors) {
          toast({ title: "Not booked", description: result.error, tone: "error" });
        }
        return;
      }
      setState(result);
      toast({
        title: `Booked ${formatAppointmentStart(result.data.startsAt)} for ${customer!.label}`,
        tone: "success",
      });
      onOpenChange(false);
      router.push(`/appointments/${result.data.id}`);
    });
  };

  const stripDays = daysFrom(today, WINDOW_DAYS);

  return (
    <Sheet
      open
      onOpenChange={onOpenChange}
      dismissible={!pending}
      title="Book appointment"
      description="Times follow the shop's hours, closures and capacity."
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} pending={pending} pendingLabel="Booking…">
            Book
          </Button>
        </>
      }
    >
      <form
        id={formId}
        ref={formRef}
        noValidate
        className="flex flex-col gap-6"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {state && !state.ok ? (
          <p role="alert" className="text-sm font-medium text-danger-deep">
            {state.error}
          </p>
        ) : null}

        {lockCustomer && presetCustomer ? (
          <div className="flex flex-col gap-1.5">
            <span className="font-display text-xs font-bold tracking-wide uppercase">Customer</span>
            <p className="font-medium">{presetCustomer.label}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <Field label="Customer" error={errors?.customerId?.[0]} required>
              <CustomerPicker
                value={customer}
                onSelect={(option) => {
                  setCustomer(option);
                  setBikeId("");
                }}
                required
                allowCreate
              />
            </Field>
            <p className="text-sm text-dust-500">
              Not on the list?{" "}
              <Link href="/customers" className="font-medium text-ink underline">
                New customer…
              </Link>{" "}
              Add them under Customers, then book from their page.
            </p>
          </div>
        )}

        <RadioFieldset legend="Type" error={errors?.appointmentTypeId?.[0]} required>
          {loadingTimes && types.length === 0 ? (
            <LoadingLine>Loading appointment types…</LoadingLine>
          ) : types.length === 0 ? (
            <p className="text-sm text-dust-500">
              No active appointment types. An admin adds them in Settings.
            </p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {types.map((t) => (
                <RadioCard
                  key={t.id}
                  name="appointmentTypeId"
                  value={t.id}
                  checked={type?.id === t.id}
                  onChange={() => {
                    setTypeId(t.id);
                    setStartsAt(null);
                  }}
                >
                  <span className="font-semibold">{t.name}</span>
                  <span className="flex flex-wrap items-center gap-2 text-sm text-dust-500">
                    {t.durationMinutes} min
                    {t.public ? null : <Badge tone="neutral">Staff only</Badge>}
                  </span>
                </RadioCard>
              ))}
            </div>
          )}
        </RadioFieldset>

        <RadioFieldset legend="Date" required>
          <div className="-mx-1 flex [scrollbar-width:none] gap-2 overflow-x-auto px-1 pb-1">
            {stripDays.map((d) => (
              <label
                key={d}
                className={cn(
                  "relative flex min-h-tap min-w-16 shrink-0 cursor-pointer flex-col items-center justify-center rounded-xl border-2 px-2 py-1 text-center text-sm has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-indigo",
                  d === date ? "border-ink bg-ink text-paper" : "border-hairline bg-card",
                )}
              >
                <input
                  type="radio"
                  name="date"
                  value={d}
                  checked={d === date}
                  onChange={() => chooseDate(d)}
                  className="sr-only"
                />
                <span className="font-display text-[0.6875rem] font-bold tracking-wide uppercase">
                  {d === today ? "Today" : formatShopDayShort(d).split(",")[0]}
                </span>
                <span className="font-semibold tabular-nums">
                  {shopDayToDate(d).toLocaleDateString("en-SG", {
                    day: "numeric",
                    month: "short",
                    timeZone: "Asia/Singapore",
                  })}
                </span>
              </label>
            ))}
          </div>
          <Field label="Or pick a date" className="mt-2">
            <Input
              type="date"
              min={today}
              value={date}
              onChange={(e) => chooseDate(e.target.value)}
            />
          </Field>
        </RadioFieldset>

        <RadioFieldset legend="Time" error={errors?.startsAt?.[0]} required>
          {scheduleError ? (
            <div className="flex flex-wrap items-center gap-3">
              <p role="alert" className="text-sm text-danger-deep">
                {scheduleError}
              </p>
              <Button size="sm" variant="outline" onClick={() => setReloads((n) => n + 1)}>
                Try again
              </Button>
            </div>
          ) : loadingTimes ? (
            <LoadingLine>Loading free times…</LoadingLine>
          ) : !type ? (
            <p className="text-sm text-dust-500">Choose a type to see the free times.</p>
          ) : daySlots.length === 0 ? (
            <div className="flex flex-col items-start gap-2">
              <p className="text-sm text-dust-700">No free times on this day.</p>
              {nextDay ? (
                <Button size="sm" variant="outline" onClick={() => chooseDate(nextDay)}>
                  Next day with free times
                </Button>
              ) : (
                <p className="text-sm text-dust-500">No free times in the next 14 days.</p>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {daySlots.map((s) => {
                const value = s.start.toISOString();
                const checked = value === startsAt;
                return (
                  <label
                    key={value}
                    className={cn(
                      "relative flex min-h-tap cursor-pointer flex-col items-center justify-center rounded-xl border-2 px-1 py-1 text-center has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-indigo",
                      checked ? "border-ink bg-ink text-paper" : "border-hairline bg-card",
                    )}
                  >
                    <input
                      type="radio"
                      name="startsAt"
                      value={value}
                      checked={checked}
                      onChange={() => setStartsAt(value)}
                      className="sr-only"
                    />
                    <span className="font-semibold tabular-nums">{formatClock(s.start)}</span>
                    {s.remaining !== null ? (
                      <span className={cn("text-xs", checked ? "text-paper" : "text-dust-500")}>
                        {s.remaining} left
                      </span>
                    ) : null}
                  </label>
                );
              })}
            </div>
          )}
        </RadioFieldset>

        <RadioFieldset legend="Bike" error={errors?.bikeId?.[0]}>
          {!customerId ? (
            <p className="text-sm text-dust-500">Choose the customer to pick one of their bikes.</p>
          ) : bikesError ? (
            <p role="alert" className="text-sm text-danger-deep">
              {bikesError}
            </p>
          ) : !customerBikes ? (
            <LoadingLine>Loading bikes…</LoadingLine>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              <RadioCard
                name="bikeId"
                value=""
                checked={bikeId === ""}
                onChange={() => setBikeId("")}
              >
                <span className="font-semibold">Decide at check-in</span>
                <span className="text-sm text-dust-500">Pick the bike when they arrive.</span>
              </RadioCard>
              {customerBikes.map((b) => (
                <RadioCard
                  key={b.id}
                  name="bikeId"
                  value={b.id}
                  checked={bikeId === b.id}
                  onChange={() => setBikeId(b.id)}
                >
                  <span className="font-semibold">{b.title}</span>
                  <span className="flex flex-wrap items-center gap-2 text-sm text-dust-500">
                    <ShortId value={b.shortId} />
                    {b.colour ? <span>{b.colour}</span> : null}
                  </span>
                </RadioCard>
              ))}
            </div>
          )}
        </RadioFieldset>

        <Field
          label="Customer's note"
          hint="What they want done, in their words. The customer can see it."
          error={errors?.customerNote?.[0]}
        >
          <Textarea
            rows={2}
            maxLength={1000}
            value={customerNote}
            onChange={(e) => setCustomerNote(e.target.value)}
          />
        </Field>
        <Field
          label="Internal note"
          hint="Staff only. Never shown to the customer."
          error={errors?.internalNote?.[0]}
        >
          <Textarea
            rows={2}
            maxLength={5000}
            value={internalNote}
            onChange={(e) => setInternalNote(e.target.value)}
          />
        </Field>
      </form>
    </Sheet>
  );
}

function LoadingLine({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="flex items-center gap-2 text-sm text-dust-500">
      <Spinner className="size-4" />
      {children}
    </p>
  );
}

/** A labelled group of radio choices with an error under its legend. */
function RadioFieldset({
  legend,
  error,
  required = false,
  children,
}: {
  legend: string;
  error?: string;
  required?: boolean;
  children: ReactNode;
}) {
  const errorId = useId();
  return (
    <fieldset
      className="flex min-w-0 flex-col gap-2"
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? errorId : undefined}
      // useFocusFirstInvalid focuses the first aria-invalid element.
      tabIndex={error ? -1 : undefined}
    >
      <legend className="mb-2 font-display text-xs font-bold tracking-wide text-ink uppercase">
        {legend}
        {required ? (
          <>
            <span aria-hidden="true" className="ml-1 text-danger-deep">
              *
            </span>{" "}
            <span className="sr-only">(required)</span>
          </>
        ) : null}
      </legend>
      {error ? (
        <p id={errorId} className="text-sm font-medium text-danger-deep">
          {error}
        </p>
      ) : null}
      {children}
    </fieldset>
  );
}

/** A native radio as a large card (keyboard arrows move within its group). */
function RadioCard({
  name,
  value,
  checked,
  onChange,
  children,
}: {
  name: string;
  value: string;
  checked: boolean;
  onChange: () => void;
  children: ReactNode;
}) {
  return (
    <label
      className={cn(
        "relative flex min-h-16 cursor-pointer flex-col items-start justify-center gap-1 rounded-2xl border-2 px-4 py-3 has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-3 has-[:focus-visible]:outline-indigo",
        checked ? "border-ink bg-dust-100" : "border-hairline bg-card hover:bg-dust-100",
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onChange}
        className="sr-only"
      />
      {children}
    </label>
  );
}

/**
 * "Book appointment" (md+) or the phones' floating "Book" button above the
 * tab bar, opening the sheet preset to `presetDate`.
 */
export function BookAppointmentButton({
  presetDate,
  presetCustomer,
  lockCustomer,
  variant = "button",
  label = "Book appointment",
  buttonVariant = "solid",
  size = "md",
  disabled = false,
}: {
  presetDate?: string;
  presetCustomer?: { id: string; label: string };
  lockCustomer?: boolean;
  variant?: "button" | "fab";
  label?: string;
  /** The "button" variant's look (the customer page uses outline, like Add bike). */
  buttonVariant?: ButtonVariant;
  size?: ButtonSize;
  /** E.g. an archived customer (book_appointment refuses customer_archived). */
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {variant === "fab" ? (
        <Button
          variant="accent"
          size="lg"
          icon={<PlusIcon className="size-5" />}
          onClick={() => setOpen(true)}
          className="fixed right-[max(1rem,env(safe-area-inset-right))] bottom-[calc(6rem+env(safe-area-inset-bottom))] z-30 shadow-lg md:hidden"
        >
          Book
        </Button>
      ) : (
        <Button
          variant={buttonVariant}
          size={size}
          icon={<PlusIcon className={size === "sm" ? "size-4" : "size-5"} />}
          disabled={disabled}
          onClick={() => setOpen(true)}
        >
          {label}
        </Button>
      )}
      <BookAppointmentSheet
        open={open}
        onOpenChange={setOpen}
        presetDate={presetDate}
        presetCustomer={presetCustomer}
        lockCustomer={lockCustomer}
      />
    </>
  );
}
