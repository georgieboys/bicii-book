"use server";

import { refresh } from "next/cache";

import { staffAction } from "@/lib/actions";
import {
  adventureCheckpointsSchema,
  adventureDraftSchema,
  adventureIdSchema,
  adventureOfferSchema,
  adventureOrderSchema,
  adventureSalesSchema,
  archiveAdventureSchema,
  cancelHireSchema,
  deviceStateSchema,
  issueTrackerSchema,
  registerDeviceSchema,
  replaceTrackerSchema,
  returnTrackerSchema,
  trackerHireSchema,
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
  claimAdventureReview,
  clearAdventureBookingAttention,
  decideAdventureReview,
  revokeAdventureCertificate,
  setAdventurePackStatus,
  setAdventureSales,
} from "@/lib/domain/adventure-bookings";
import {
  cancelTrackerHire,
  issueTracker,
  registerTrackingDevice,
  replaceTracker,
  returnTracker,
  setTrackerHire,
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
