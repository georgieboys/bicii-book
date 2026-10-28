/**
 * The shop's schedule settings on screen and in forms (SPEC §6; PLAN D2,
 * D35, D37, D38): weekday names Monday first, the sentences the settings
 * screens use, and the input schemas of the schedule and appointment-type
 * Server Actions, mirroring the database's checks
 * (supabase/migrations/20261004002800_schedule.sql) so a form shows the
 * same rule before the RPC refuses it. Pure: client sheets, actions and
 * unit tests share it. There is no time zone or currency anywhere: the
 * shop's are fixed (Asia/Singapore, SGD; D35).
 */
import { z } from "zod";

import { formatShopDayShort, parseShopDay } from "@/lib/dates";

import { MINUTES_PER_DAY, parseHHMM } from "./appointments/time";

/** The week as the settings show it: Monday first; `weekday` as stored (0 = Sunday). */
export const WEEKDAYS: readonly { weekday: number; name: string }[] = [
  { weekday: 1, name: "Monday" },
  { weekday: 2, name: "Tuesday" },
  { weekday: 3, name: "Wednesday" },
  { weekday: 4, name: "Thursday" },
  { weekday: 5, name: "Friday" },
  { weekday: 6, name: "Saturday" },
  { weekday: 0, name: "Sunday" },
];

export function weekdayName(weekday: number): string {
  return WEEKDAYS.find((w) => w.weekday === weekday)?.name ?? "That day";
}

/** One opening interval, "HH:MM" (closes may be "24:00"). */
export type HoursInterval = { opens: string; closes: string };

/** "10:00–19:00", "09:00–12:30, 13:30–18:00" or "Closed". */
export function formatIntervals(intervals: readonly HoursInterval[], active: boolean): string {
  if (!active || intervals.length === 0) return "Closed";
  return intervals.map((i) => `${i.opens}–${i.closes}`).join(", ");
}

/** "30 minutes", "1 hour", "2 hours", "1 hour 30 minutes", "1 day", "7 days". */
export function formatDuration(minutes: number): string {
  if (minutes === 0) return "0 minutes";
  if (minutes % MINUTES_PER_DAY === 0) {
    const d = minutes / MINUTES_PER_DAY;
    return d === 1 ? "1 day" : `${d} days`;
  }
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const hours = h === 0 ? "" : h === 1 ? "1 hour" : `${h} hours`;
  const mins = m === 0 ? "" : m === 1 ? "1 minute" : `${m} minutes`;
  return [hours, mins].filter(Boolean).join(" ");
}

/** D2 in one line: "Up to 2 bikes can be booked in for each 30-minute slot." */
export function capacitySentence(slotMinutes: number, capacityUnits: number): string {
  return `Up to ${capacityUnits} ${capacityUnits === 1 ? "bike" : "bikes"} can be booked in for each ${slotMinutes}-minute slot.`;
}

/** D37's online cancellation cutoff in words. */
export function cancelCutoffSentence(minutes: number): string {
  return minutes === 0
    ? "Customers can cancel online until the appointment starts."
    : `Customers can cancel online until ${formatDuration(minutes)} before.`;
}

/** A closure's kind and times in words: "Closed all day", "Closed 14:00–16:00", "Open 12:00–16:00". */
export function closureLabel(c: {
  kind: "closed" | "custom_hours";
  fromTime: string | null;
  toTime: string | null;
}): string {
  if (c.kind === "custom_hours") return `Open ${c.fromTime ?? "?"}–${c.toTime ?? "?"}`;
  return c.fromTime && c.toTime ? `Closed ${c.fromTime}–${c.toTime}` : "Closed all day";
}

/** "Wed, 11 Nov" or "Wed, 11 Nov – Fri, 13 Nov". */
export function closureDays(firstDay: string, lastDay: string): string {
  return firstDay === lastDay
    ? formatShopDayShort(firstDay)
    : `${formatShopDayShort(firstDay)} – ${formatShopDayShort(lastDay)}`;
}

// ---------------------------------------------------------------------------
// Form schemas (the database checks again)
// ---------------------------------------------------------------------------

/** A whole number typed as text (or sent as a number) within bounds. */
const whole = (min: number, max: number, messages: { invalid: string; range: string }) =>
  z
    .union([z.string(), z.number()], { error: messages.invalid })
    .transform((v) => (typeof v === "number" ? String(v) : v.trim()))
    .refine((v) => /^-?\d+$/.test(v), { error: messages.invalid, abort: true })
    .transform((v) => Number(v))
    .refine((v) => v >= min && v <= max, { error: messages.range });

/** shop_settings_slot_minutes_check: 5-240 and dividing the day (D38: the grid starts at midnight). */
export const slotMinutes = whole(5, 240, {
  invalid: "Enter the slot length in whole minutes.",
  range: "A slot is between 5 and 240 minutes.",
}).refine((v) => MINUTES_PER_DAY % v === 0, {
  error: "Pick a length that divides the day evenly, like 15, 20, 30 or 60 minutes.",
});

/** The booking settings an admin edits (update_shop_settings; no time zone, D35). */
export const shopSettingsSchema = z.object({
  slotMinutes,
  capacityUnits: whole(1, 50, {
    invalid: "Enter a whole number of bikes.",
    range: "Take between 1 and 50 bikes per slot.",
  }),
  minNoticeMinutes: whole(0, 10_080, {
    invalid: "Enter the notice in whole minutes.",
    range: "Minimum notice is between 0 minutes and 7 days (10,080 minutes).",
  }),
  horizonDays: whole(1, 365, {
    invalid: "Enter a whole number of days.",
    range: "Customers can book between 1 and 365 days ahead.",
  }),
  maxActiveBookings: whole(1, 20, {
    invalid: "Enter a whole number of bookings.",
    range: "Allow between 1 and 20 upcoming online bookings.",
  }),
  cancelCutoffMinutes: whole(0, 10_080, {
    invalid: "Enter the cutoff in whole minutes.",
    range: "The cutoff is between 0 minutes and 7 days (10,080 minutes).",
  }),
});

export type ShopSettingsInput = z.output<typeof shopSettingsSchema>;

const OPENS = /^([01]\d|2[0-3]):[0-5]\d$/;
const CLOSES = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;

const opensTime = (message: string) => z.string({ error: message }).trim().regex(OPENS, message);
const closesTime = (message: string) => z.string({ error: message }).trim().regex(CLOSES, message);

/**
 * One weekday's hours (set_shop_hours): up to 4 intervals, each "HH:MM"
 * with the closing time after the opening time (up to "24:00"), none
 * overlapping. An open day needs at least one interval. A day switched
 * off keeps its intervals (they come back when it is switched on).
 */
export const shopHoursSchema = z
  .object({
    weekday: z.number().int().min(0).max(6),
    active: z.boolean(),
    intervals: z
      .array(
        z.object({
          opens: opensTime("Enter the opening time as HH:MM."),
          closes: closesTime("Enter the closing time as HH:MM (24:00 is midnight)."),
        }),
      )
      .max(4, { error: "A day has at most 4 opening intervals." }),
  })
  .superRefine((v, ctx) => {
    if (v.active && v.intervals.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["intervals"],
        message: "Add the opening hours, or switch the day off.",
      });
      return;
    }
    // A malformed time is already reported on its own; compare only well-formed ones.
    if (v.intervals.some((i) => !OPENS.test(i.opens) || !CLOSES.test(i.closes))) return;
    v.intervals.forEach((i, n) => {
      if (parseHHMM(i.closes) <= parseHHMM(i.opens)) {
        ctx.addIssue({
          code: "custom",
          path: ["intervals"],
          message: `Interval ${n + 1}: the closing time must be after the opening time.`,
        });
      }
    });
    const sorted = [...v.intervals].sort((a, b) => parseHHMM(a.opens) - parseHHMM(b.opens));
    for (let n = 1; n < sorted.length; n++) {
      if (parseHHMM(sorted[n].opens) < parseHHMM(sorted[n - 1].closes)) {
        ctx.addIssue({
          code: "custom",
          path: ["intervals"],
          message: `${sorted[n - 1].opens}–${sorted[n - 1].closes} and ${sorted[n].opens}–${sorted[n].closes} overlap.`,
        });
      }
    }
  });

export type ShopHoursInput = z.output<typeof shopHoursSchema>;

const day = (message: string) =>
  z
    .string({ error: message })
    .refine((v) => parseShopDay(v) !== null, { error: message })
    .transform((v) => parseShopDay(v)!);

const optionalTime = z
  .string()
  .trim()
  .nullish()
  .transform((v) => (v ? v : null));

/**
 * A closure (save_closure_override; D38). Closed: whole days, or with
 * "Only part of the day" a from/to on ONE day. Short day: opening and
 * closing times over whole days (they replace the weekly hours). The id is
 * made when the sheet opens: Add sends isNew, Edit does not.
 */
export const closureSchema = z
  .object({
    id: z.guid({ error: "Open the closure again." }),
    isNew: z.boolean(),
    kind: z.enum(["closed", "custom_hours"], { error: "Choose Closed or Short day." }),
    firstDay: day("Choose the first day."),
    lastDay: day("Choose the last day."),
    partDay: z.boolean().default(false),
    fromTime: optionalTime,
    toTime: optionalTime,
    reason: z
      .string({ error: "Say why." })
      .trim()
      .min(1, { error: "Say why (customers never see it)." })
      .max(200, { error: "Keep the reason under 200 characters." }),
  })
  .superRefine((v, ctx) => {
    if (v.lastDay < v.firstDay) {
      ctx.addIssue({
        code: "custom",
        path: ["lastDay"],
        message: "The last day can't be before the first day.",
      });
    } else if (Date.parse(v.lastDay) - Date.parse(v.firstDay) > 365 * 86_400_000) {
      ctx.addIssue({
        code: "custom",
        path: ["lastDay"],
        message: "A closure lasts at most 366 days.",
      });
    }
    const timed = v.kind === "custom_hours" || v.partDay;
    if (!timed) return;
    const what = v.kind === "custom_hours" ? "opening" : "start";
    const until = v.kind === "custom_hours" ? "closing" : "end";
    if (!v.fromTime || !OPENS.test(v.fromTime)) {
      ctx.addIssue({ code: "custom", path: ["fromTime"], message: `Enter the ${what} time.` });
    }
    if (!v.toTime || !CLOSES.test(v.toTime)) {
      ctx.addIssue({ code: "custom", path: ["toTime"], message: `Enter the ${until} time.` });
    }
    if (
      v.fromTime &&
      v.toTime &&
      OPENS.test(v.fromTime) &&
      CLOSES.test(v.toTime) &&
      parseHHMM(v.toTime) <= parseHHMM(v.fromTime)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["toTime"],
        message: `The ${until} time must be after the ${what} time.`,
      });
    }
    if (v.kind === "closed" && v.partDay && v.lastDay !== v.firstDay) {
      ctx.addIssue({
        code: "custom",
        path: ["lastDay"],
        message: "Part of a day closes one day only.",
      });
    }
  })
  .transform((v) => {
    const timed = v.kind === "custom_hours" || v.partDay;
    return {
      id: v.id,
      isNew: v.isNew,
      kind: v.kind,
      firstDay: v.firstDay,
      lastDay: v.lastDay,
      fromTime: timed ? v.fromTime : null,
      toTime: timed ? v.toTime : null,
      reason: v.reason,
    };
  });

export type ClosureInput = z.output<typeof closureSchema>;

/** Removing a closure re-opens the shop: a reason is required (kept in the schedule history). */
export const deleteClosureSchema = z.object({
  id: z.guid({ error: "Unknown closure." }),
  reason: z
    .string({ error: "Say why the closure is removed." })
    .trim()
    .min(1, { error: "Say why the closure is removed." })
    .max(500, { error: "Keep the reason under 500 characters." }),
});

/**
 * An appointment type (save_appointment_type). Units at most the shop's
 * capacity is checked by the action against the current settings (and by
 * the RPC for an active type). Types are never deleted: deactivate them.
 */
export const appointmentTypeSchema = z.object({
  id: z.guid({ error: "Open the type again." }),
  isNew: z.boolean(),
  name: z
    .string({ error: "Enter a name." })
    .trim()
    .min(1, { error: "Enter a name." })
    .max(80, { error: "Keep the name under 80 characters." }),
  description: z
    .string()
    .trim()
    .max(500, { error: "Keep the description under 500 characters." })
    .nullish()
    .transform((v) => (v ? v : null)),
  durationMinutes: whole(5, 480, {
    invalid: "Enter the length in whole minutes.",
    range: "An appointment lasts between 5 and 480 minutes.",
  }).refine((v) => v % 5 === 0, { error: "Use steps of 5 minutes, like 30 or 45." }),
  capacityUnits: whole(1, 50, {
    invalid: "Enter a whole number of units.",
    range: "Use between 1 and 50 units.",
  }),
  public: z.boolean(),
  active: z.boolean(),
  sortOrder: whole(0, 9_999, {
    invalid: "Enter a whole number.",
    range: "Use a sort order between 0 and 9,999.",
  }),
});

export type AppointmentTypeInput = z.output<typeof appointmentTypeSchema>;
