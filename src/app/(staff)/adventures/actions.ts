"use server";

import { refresh } from "next/cache";

import { ActionError, staffAction } from "@/lib/actions";
import { fromShopLocal } from "@/lib/dates";
import {
  adventureCheckpointsSchema,
  adventureDraftSchema,
  adventureIdSchema,
  adventureOfferSchema,
  adventureOrderSchema,
  adventureSalesSchema,
  archiveAdventureSchema,
  cancelBookingSchema,
  hideBoardNameSchema,
  publishWaiverSchema,
  settleLateFeeSchema,
  cancelDepartureSchema,
  moveSeatSchema,
  checkInSchema,
  departureStaffSchema,
  observationSchema,
  removeDepartureStaffSchema,
  supportedSalesSchema,
  publicSurfacesSchema,
  emptySchema,
  cancelHireSchema,
  createDepartureSchema,
  updateDepartureSchema,
  correctCaptureSchema,
  deviceStateSchema,
  issueTrackerSchema,
  registerDeviceSchema,
  replaceTrackerSchema,
  returnTrackerSchema,
  trackerHireSchema,
  trackingFeedSchema,
  clearAttentionSchema,
  createAdventureSchema,
  decideReviewSchema,
  packStatusSchema,
  revokeCertificateSchema,
  submissionIdSchema,
  publishAdventureSchema,
  removeAdventureOfferSchema,
} from "@/lib/adventure-forms";
import type { AdventureParticipation } from "@/lib/adventures";
import {
  archiveAdventure,
  createAdventure,
  publishAdventureRevision,
  removeAdventureOffer,
  saveAdventureDraft,
  setAdventureCheckpoints,
  setAdventureOffer,
  setAdventureOrder,
  startAdventureDraft,
  unarchiveAdventure,
} from "@/lib/domain/adventures";
import {
  cancelAdventureBooking,
  claimAdventureReview,
  clearAdventureBookingAttention,
  decideAdventureReview,
  revokeAdventureCertificate,
  setAdventurePackStatus,
  retryFailedAdventureNotices,
  setAdventureSales,
} from "@/lib/domain/adventure-bookings";
import { hideBoardName, publishWaiver, settleLateFee } from "@/lib/domain/adventure-terms";
import { expireAdventureCheckouts } from "@/lib/integrations/stripe/adventure-payments";
import { defaultStripeDeps } from "@/lib/integrations/stripe/deps";
import { newRequestId } from "@/lib/request-id";
import {
  assignDepartureStaff,
  cancelDeparture,
  checkInRider,
  createDeparture,
  moveSeat,
  recordObservation,
  removeDepartureStaff,
  updateDeparture,
} from "@/lib/domain/departures";
import {
  cancelTrackerHire,
  correctCapture,
  issueTracker,
  registerTrackingDevice,
  replaceTracker,
  returnTracker,
  setTrackerHire,
  saveTrackingFeed,
  setSupportedSales,
  setPublicSurfaces,
  setTrackingDeviceState,
} from "@/lib/domain/trackers";

/**
 * Adventure catalogue Server Actions (DATA-MODEL §20, D164-D166). Every
 * write needs manage_adventures; the RPCs check it again with their rules.
 */

export const createAdventureAction = staffAction(
  createAdventureSchema,
  { name: "adventures.create", permission: "manage_adventures" },
  async (input, { supabase }) => createAdventure(supabase, input),
);

export const saveAdventureDraftAction = staffAction(
  adventureDraftSchema,
  { name: "adventures.save_draft", permission: "manage_adventures" },
  async (input, { supabase }) => {
    const result = await saveAdventureDraft(supabase, input);
    refresh();
    return result;
  },
);

export const setAdventureCheckpointsAction = staffAction(
  adventureCheckpointsSchema,
  { name: "adventures.set_checkpoints", permission: "manage_adventures" },
  async ({ revisionId, checkpoints }, { supabase }) => {
    await setAdventureCheckpoints(supabase, revisionId, checkpoints);
    refresh();
    return null;
  },
);

export const setAdventureOfferAction = staffAction(
  adventureOfferSchema,
  { name: "adventures.set_offer", permission: "manage_adventures" },
  async (input, { supabase }) => {
    await setAdventureOffer(supabase, {
      ...input,
      kind: input.kind as AdventureParticipation,
    });
    refresh();
    return null;
  },
);

export const removeAdventureOfferAction = staffAction(
  removeAdventureOfferSchema,
  { name: "adventures.remove_offer", permission: "manage_adventures" },
  async ({ revisionId, kind }, { supabase }) => {
    await removeAdventureOffer(supabase, revisionId, kind as AdventureParticipation);
    refresh();
    return null;
  },
);

export const startAdventureDraftAction = staffAction(
  adventureIdSchema,
  { name: "adventures.start_draft", permission: "manage_adventures" },
  async ({ adventureId }, { supabase }) => {
    const result = await startAdventureDraft(supabase, adventureId);
    refresh();
    return result;
  },
);

export const publishAdventureAction = staffAction(
  publishAdventureSchema,
  { name: "adventures.publish", permission: "manage_adventures" },
  async ({ revisionId, changeSummary }, { supabase }) => {
    await publishAdventureRevision(supabase, revisionId, changeSummary);
    refresh();
    return null;
  },
);

export const archiveAdventureAction = staffAction(
  archiveAdventureSchema,
  { name: "adventures.archive", permission: "manage_adventures" },
  async ({ adventureId, reason }, { supabase }) => {
    await archiveAdventure(supabase, adventureId, reason);
    refresh();
    return null;
  },
);

export const unarchiveAdventureAction = staffAction(
  adventureIdSchema,
  { name: "adventures.unarchive", permission: "manage_adventures" },
  async ({ adventureId }, { supabase }) => {
    await unarchiveAdventure(supabase, adventureId);
    refresh();
    return null;
  },
);

export const setAdventureOrderAction = staffAction(
  adventureOrderSchema,
  { name: "adventures.set_order", permission: "manage_adventures" },
  async ({ adventureId, sortOrder }, { supabase }) => {
    await setAdventureOrder(supabase, adventureId, sortOrder);
    refresh();
    return null;
  },
);

// ------------------------------------------- bookings, review, packs ----
// Phase B (D178-D182). The RPCs check the permission and every rule again:
// nobody reviews their own ride, a version is decided once, approval needs
// the whole checklist.

export const claimAdventureReviewAction = staffAction(
  submissionIdSchema,
  { name: "adventures.claim_review", permission: "verify_adventures" },
  async ({ submissionId }, { supabase }) => {
    await claimAdventureReview(supabase, submissionId);
    refresh();
    return null;
  },
);

export const decideAdventureReviewAction = staffAction(
  decideReviewSchema,
  { name: "adventures.decide_review", permission: "verify_adventures" },
  async (input, { supabase }) => {
    await decideAdventureReview(supabase, {
      submissionId: input.submissionId,
      decision: input.decision,
      checklist: {
        identity: input.identity,
        coverage: input.coverage,
        checkpoints: input.checkpoints,
        chronology: input.chronology,
        time_window: input.time_window,
        distance: input.distance,
      },
      acceptedDistanceKm: input.decision === "approved" ? input.acceptedDistanceKm : null,
      completedOn: input.decision === "approved" ? input.completedOn : null,
      messageToRider: input.messageToRider,
      internalNote: input.internalNote,
    });
    refresh();
    return { decision: input.decision };
  },
);

export const revokeAdventureCertificateAction = staffAction(
  revokeCertificateSchema,
  { name: "adventures.revoke_certificate", admin: true },
  async ({ certificateId, reason }, { supabase }) => {
    await revokeAdventureCertificate(supabase, certificateId, reason);
    refresh();
    return null;
  },
);

export const clearAdventureAttentionAction = staffAction(
  clearAttentionSchema,
  { name: "adventures.clear_attention", admin: true },
  async ({ bookingId, note }, { supabase }) => {
    await clearAdventureBookingAttention(supabase, bookingId, note);
    refresh();
    return null;
  },
);

export const setAdventurePackStatusAction = staffAction(
  packStatusSchema,
  { name: "adventures.set_pack_status", permission: "manage_adventures" },
  async ({ fulfilmentId, status, note }, { supabase }) => {
    await setAdventurePackStatus(supabase, fulfilmentId, status, note);
    refresh();
    return null;
  },
);

export const setAdventureSalesAction = staffAction(
  adventureSalesSchema,
  { name: "adventures.set_sales", admin: true },
  async ({ salesEnabled, termsVersion }, { supabase }) => {
    await setAdventureSales(supabase, salesEnabled, termsVersion);
    refresh();
    return { salesEnabled };
  },
);

// ------------------------------------------------------- tracker hire ----
// Phase C (D186-D188). The RPCs check the permission and every rule again.

export const registerTrackingDeviceAction = staffAction(
  registerDeviceSchema,
  { name: "adventures.register_tracker", permission: "manage_adventures" },
  async (input, { supabase }) => {
    const result = await registerTrackingDevice(supabase, input);
    refresh();
    return result;
  },
);

export const setTrackingDeviceStateAction = staffAction(
  deviceStateSchema,
  { name: "adventures.set_tracker_state", permission: "manage_adventures" },
  async ({ deviceId, state, note }, { supabase }) => {
    await setTrackingDeviceState(supabase, deviceId, state, note);
    refresh();
    return null;
  },
);

export const issueTrackerAction = staffAction(
  issueTrackerSchema,
  { name: "adventures.issue_tracker", permission: "manage_adventures" },
  async ({ reservationId, deviceId, note }, { supabase }) => {
    await issueTracker(supabase, reservationId, deviceId, note);
    refresh();
    return null;
  },
);

export const replaceTrackerAction = staffAction(
  replaceTrackerSchema,
  { name: "adventures.replace_tracker", permission: "manage_adventures" },
  async ({ assignmentId, deviceId, reason }, { supabase }) => {
    await replaceTracker(supabase, assignmentId, deviceId, reason);
    refresh();
    return null;
  },
);

export const returnTrackerAction = staffAction(
  returnTrackerSchema,
  { name: "adventures.return_tracker", permission: "manage_adventures" },
  async ({ assignmentId, condition, note }, { supabase }) => {
    await returnTracker(supabase, assignmentId, condition, note);
    refresh();
    return null;
  },
);

export const cancelTrackerHireAction = staffAction(
  cancelHireSchema,
  { name: "adventures.cancel_hire", admin: true },
  async ({ reservationId, reason }, { supabase }) => {
    await cancelTrackerHire(supabase, reservationId, reason);
    refresh();
    return null;
  },
);

export const setTrackerHireAction = staffAction(
  trackerHireSchema,
  { name: "adventures.set_tracker_hire", admin: true },
  async ({ enabled, maxDays }, { supabase }) => {
    await setTrackerHire(supabase, enabled, maxDays);
    refresh();
    return { enabled };
  },
);

export const saveTrackingFeedAction = staffAction(
  trackingFeedSchema,
  { name: "adventures.save_feed", admin: true },
  async (input, { supabase }) => {
    await saveTrackingFeed(supabase, input);
    refresh();
    return null;
  },
);

export const correctCaptureAction = staffAction(
  correctCaptureSchema,
  { name: "adventures.correct_capture", permission: "verify_adventures" },
  async ({ attemptId, startedAt, finishedAt, reason }, { supabase }) => {
    const start = startedAt ? fromShopLocal(startedAt) : null;
    const finish = finishedAt ? fromShopLocal(finishedAt) : null;
    if (!start)
      throw new ActionError("Enter when the ride started.", {
        startedAt: ["Enter a real date and time."],
      });
    if (finishedAt && !finish)
      throw new ActionError("Check the finish.", { finishedAt: ["Enter a real date and time."] });
    await correctCapture(
      supabase,
      attemptId,
      start.toISOString(),
      finish ? finish.toISOString() : null,
      reason,
    );
    refresh();
    return null;
  },
);

// ---------------------------------------------------------- departures ----
// Phase D (D193-D195). Times are typed in shop time.

function shopInstant(value: string | null, field: string): string | null {
  if (value === null) return null;
  const at = fromShopLocal(value);
  if (!at) throw new ActionError("Check the dates.", { [field]: ["Enter a real date and time."] });
  return at.toISOString();
}

export const createDepartureAction = staffAction(
  createDepartureSchema,
  { name: "adventures.create_departure", permission: "manage_adventures" },
  async (input, { supabase }) => {
    const result = await createDeparture(supabase, {
      ...input,
      startsAt: shopInstant(input.startsAt, "startsAt")!,
      expectedFinishAt: shopInstant(input.expectedFinishAt, "expectedFinishAt"),
    });
    refresh();
    return result;
  },
);

export const updateDepartureAction = staffAction(
  updateDepartureSchema,
  { name: "adventures.update_departure", permission: "manage_adventures" },
  async (input, { supabase }) => {
    await updateDeparture(supabase, {
      ...input,
      startsAt: shopInstant(input.startsAt, "startsAt")!,
      expectedFinishAt: shopInstant(input.expectedFinishAt, "expectedFinishAt"),
    });
    refresh();
    return null;
  },
);

export const cancelDepartureAction = staffAction(
  cancelDepartureSchema,
  { name: "adventures.cancel_departure", permission: "manage_adventures" },
  async ({ departureId, reason }, { supabase }) => {
    await cancelDeparture(supabase, departureId, reason);
    refresh();
    return null;
  },
);

// -------------------------------------------- supported departures ----
// Phase E (D196-D199). Check-ins and observations are open to any staff
// member here: the RPCs allow facilitators assigned to the date, and
// manage_adventures.

export const assignDepartureStaffAction = staffAction(
  departureStaffSchema,
  { name: "adventures.assign_departure_staff", permission: "manage_adventures" },
  async ({ departureId, staffId, role }, { supabase }) => {
    await assignDepartureStaff(supabase, departureId, staffId, role);
    refresh();
    return null;
  },
);

export const removeDepartureStaffAction = staffAction(
  removeDepartureStaffSchema,
  { name: "adventures.remove_departure_staff", permission: "manage_adventures" },
  async ({ departureId, staffId }, { supabase }) => {
    await removeDepartureStaff(supabase, departureId, staffId);
    refresh();
    return null;
  },
);

export const checkInRiderAction = staffAction(
  checkInSchema,
  { name: "adventures.check_in_rider" },
  async ({ departureId, bookingId }, { supabase }) => {
    await checkInRider(supabase, departureId, bookingId);
    refresh();
    return null;
  },
);

export const recordObservationAction = staffAction(
  observationSchema,
  { name: "adventures.record_observation" },
  async ({ departureId, bookingId, kind, body }, { supabase }) => {
    await recordObservation(supabase, departureId, bookingId, kind, body);
    refresh();
    return null;
  },
);

export const setSupportedSalesAction = staffAction(
  supportedSalesSchema,
  { name: "adventures.set_supported_sales", admin: true },
  async ({ enabled }, { supabase }) => {
    await setSupportedSales(supabase, enabled);
    refresh();
    return { enabled };
  },
);

export const retryFailedNoticesAction = staffAction(
  emptySchema,
  { name: "adventures.retry_failed_notices", admin: true },
  async (_input, { supabase }) => {
    const n = await retryFailedAdventureNotices(supabase);
    refresh();
    return { n };
  },
);

export const setPublicSurfacesAction = staffAction(
  publicSurfacesSchema,
  { name: "adventures.set_public_surfaces", admin: true },
  async ({ liveSharing, publicProfiles }, { supabase }) => {
    await setPublicSurfaces(supabase, liveSharing, publicProfiles);
    refresh();
    return null;
  },
);

// ------------------------------------------------- Phase F (D201, D202) ----

export const cancelAdventureBookingAction = staffAction(
  cancelBookingSchema,
  { name: "adventures.cancel_booking", admin: true },
  async ({ bookingId, reason }, { supabase }) => {
    // An open Stripe page can't be paid once the booking is cancelled (A-42).
    await expireAdventureCheckouts(defaultStripeDeps(newRequestId()), supabase, bookingId);
    await cancelAdventureBooking(supabase, bookingId, reason);
    refresh();
    return null;
  },
);

export const moveSeatAction = staffAction(
  moveSeatSchema,
  { name: "adventures.move_seat", permission: "manage_adventures" },
  async ({ bookingId, departureId, reason }, { supabase }) => {
    await moveSeat(supabase, bookingId, departureId, reason);
    refresh();
    return null;
  },
);

// ----------------------------------- the owner's sales terms (D212-D218) ----

export const publishWaiverAction = staffAction(
  publishWaiverSchema,
  { name: "adventures.publish_waiver", admin: true },
  async ({ version, title, body }, { supabase }) => {
    await publishWaiver(supabase, version, title, body);
    refresh();
    return { version };
  },
);

export const hideBoardNameAction = staffAction(
  hideBoardNameSchema,
  { name: "adventures.hide_board_name", permission: "manage_adventures" },
  async ({ bookingId, reason }, { supabase }) => {
    await hideBoardName(supabase, bookingId, reason);
    refresh();
    return null;
  },
);

export const settleLateFeeAction = staffAction(
  settleLateFeeSchema,
  { name: "adventures.settle_late_fee", admin: true },
  async ({ feeId, outcome, note }, { supabase }) => {
    await settleLateFee(supabase, feeId, outcome, note);
    refresh();
    return null;
  },
);
