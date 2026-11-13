"use server";

import { refresh } from "next/cache";

import { staffAction } from "@/lib/actions";
import {
  adventureCheckpointsSchema,
  adventureDraftSchema,
  adventureIdSchema,
  adventureOfferSchema,
  adventureOrderSchema,
  archiveAdventureSchema,
  createAdventureSchema,
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
