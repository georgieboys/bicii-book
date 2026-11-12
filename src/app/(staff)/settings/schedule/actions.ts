"use server";

import { refresh } from "next/cache";

import { staffAction } from "@/lib/actions";
import {
  affectedBySchedule,
  deleteClosure as removeClosure,
  saveClosure as storeClosure,
  setBookingAlertRecipients,
  setShopHours as storeHours,
  updateShopSettings as storeSettings,
} from "@/lib/domain/schedule";
import {
  bookingAlertsSchema,
  closureSchema,
  deleteClosureSchema,
  shopHoursSchema,
  shopSettingsSchema,
} from "@/lib/schedule";

/**
 * Shop hours, closures and booking capacity (SPEC §6; Settings → Shop
 * hours and closures; PLAN D2, D35, D37, D38). Admin only (the RPCs check
 * the role again). Thin: validate, call one domain function, refresh. A
 * change never moves an existing appointment (D38), so settings and hours
 * answer with the upcoming appointments the schedule no longer fits, and a
 * closure with the ones it affects, for the toast. No time zone or currency
 * (fixed, D35) and no public site URL (D9: Phase 8 decides its role).
 */

/** Who gets the shop's booking alerts (D163b; admin only, checked again in the RPC). */
export const setBookingAlerts = staffAction(
  bookingAlertsSchema,
  { name: "schedule.set_booking_alerts", admin: true },
  async (input, { supabase }) => {
    await setBookingAlertRecipients(supabase, input);
    refresh();
    return null;
  },
);

/** Slot length, intake capacity and the online booking rules. */
export const updateShopSettings = staffAction(
  shopSettingsSchema,
  { name: "schedule.update_settings", admin: true },
  async (input, { supabase }) => {
    await storeSettings(supabase, input);
    const affected = await affectedBySchedule(supabase);
    refresh();
    return { affected: affected.total, firstAffectedDay: affected.days[0]?.day ?? null };
  },
);

/** One weekday's opening intervals (replaced at once). */
export const setShopHours = staffAction(
  shopHoursSchema,
  { name: "schedule.set_hours", admin: true },
  async (input, { supabase }) => {
    await storeHours(supabase, input);
    const affected = await affectedBySchedule(supabase);
    refresh();
    return { affected: affected.total, firstAffectedDay: affected.days[0]?.day ?? null };
  },
);

/** Add (isNew) or edit a closure or short day; the id is the sheet's idempotency key. */
export const saveClosure = staffAction(
  closureSchema,
  { name: "schedule.save_closure", admin: true },
  async (input, { supabase }) => {
    const saved = await storeClosure(supabase, input);
    refresh();
    return {
      id: saved.id,
      affected: saved.affectedAppointments,
      firstAffectedDay: saved.firstAffectedDay,
    };
  },
);

/** Remove a closure with a reason (it re-opens the shop for those hours). */
export const deleteClosure = staffAction(
  deleteClosureSchema,
  { name: "schedule.delete_closure", admin: true },
  async (input, { supabase }) => {
    await removeClosure(supabase, input);
    refresh();
    return null;
  },
);
