"use server";

import { refresh } from "next/cache";
import { z } from "zod";

import { staffAction } from "@/lib/actions";
import {
  chargeSchema,
  consignorSchema,
  intakeSchema,
  reclassifySchema,
  returnSchema,
  reverseSettlementSchema,
  settlementSchema,
  termsSchema,
  voidChargeSchema,
} from "@/lib/consignment-forms";
import {
  addConsignmentCharge,
  createConsignor,
  customerContact,
  getConsignorPayoutDetails,
  receiveConsignmentItem,
  reclassifyAsConsignment,
  recordSettlement,
  returnConsignmentItem,
  reverseSettlement,
  searchConsignors,
  setConsignorArchived,
  updateConsignmentTerms,
  updateConsignor,
  voidConsignmentCharge,
} from "@/lib/domain/consignment";
import { searchShopBikes } from "@/lib/domain/inventory";

/**
 * Consignment actions (SPEC §13, §22; src/lib/domain/consignment.ts). Every
 * write needs manage_consignments and goes through one domain function;
 * the RPCs, RLS and triggers check again (D47, D48). Ids are client-made
 * when a sheet or control opens, so a retry has one effect.
 */

const MANAGE = "manage_consignments" as const;

export const createConsignorAction = staffAction(
  consignorSchema,
  { name: "consignment.create_consignor", permission: MANAGE },
  async ({ id, ...input }, { supabase }) => {
    const result = await createConsignor(supabase, id, input);
    refresh();
    return result;
  },
);

export const updateConsignorAction = staffAction(
  consignorSchema,
  { name: "consignment.update_consignor", permission: MANAGE },
  async ({ id, ...input }, { supabase }) => {
    await updateConsignor(supabase, id, input);
    refresh();
    return null;
  },
);

export const setConsignorArchivedAction = staffAction(
  z.object({ consignorId: z.guid({ error: "Unknown consignor." }), archived: z.boolean() }),
  { name: "consignment.set_consignor_archived", permission: MANAGE },
  async ({ consignorId, archived }, { supabase }) => {
    await setConsignorArchived(supabase, consignorId, archived);
    refresh();
    return null;
  },
);

/** Bank or PayNow details, revealed on request (manage_consignments only, D48). */
export const revealPayoutDetailsAction = staffAction(
  z.object({ consignorId: z.guid({ error: "Unknown consignor." }) }),
  { name: "consignment.reveal_payout_details", permission: MANAGE },
  async ({ consignorId }, { supabase }) => getConsignorPayoutDetails(supabase, consignorId),
);

export const receiveConsignmentItemAction = staffAction(
  intakeSchema,
  { name: "consignment.receive_item", permission: MANAGE },
  async ({ consignorId, ...input }, { supabase }) => {
    const result = await receiveConsignmentItem(supabase, {
      ...input,
      consignorId: consignorId ?? input.newConsignor?.id ?? "",
    });
    refresh();
    return result;
  },
);

/**
 * Change owner (D162): a shop product's stock becomes a consignor's on the
 * same product. Admins only, the highest role (the owner's rule); the RPC
 * checks again (private.require_admin).
 */
export const reclassifyAsConsignmentAction = staffAction(
  reclassifySchema,
  { name: "consignment.reclassify", admin: true },
  async (input, { supabase }) => {
    const result = await reclassifyAsConsignment(supabase, input);
    refresh();
    return result;
  },
);

export const updateConsignmentTermsAction = staffAction(
  termsSchema,
  { name: "consignment.update_terms", permission: MANAGE },
  async (input, { supabase }) => {
    await updateConsignmentTerms(supabase, input);
    refresh();
    return null;
  },
);

export const addChargeAction = staffAction(
  chargeSchema,
  { name: "consignment.add_charge", permission: MANAGE },
  async (input, { supabase }) => {
    await addConsignmentCharge(supabase, input);
    refresh();
    return null;
  },
);

export const voidChargeAction = staffAction(
  voidChargeSchema,
  { name: "consignment.void_charge", permission: MANAGE },
  async (input, { supabase }) => {
    await voidConsignmentCharge(supabase, input);
    refresh();
    return null;
  },
);

export const returnConsignmentItemAction = staffAction(
  returnSchema,
  { name: "consignment.return_item", permission: MANAGE },
  async (input, { supabase }) => {
    await returnConsignmentItem(supabase, input);
    refresh();
    return null;
  },
);

export const recordSettlementAction = staffAction(
  settlementSchema,
  { name: "consignment.record_settlement", permission: MANAGE },
  async (input, { supabase }) => {
    const result = await recordSettlement(supabase, input);
    refresh();
    return result;
  },
);

export const reverseSettlementAction = staffAction(
  reverseSettlementSchema,
  { name: "consignment.reverse_settlement", permission: MANAGE },
  async (input, { supabase }) => {
    await reverseSettlement(supabase, input);
    refresh();
    return null;
  },
);

/** Active consignors matching a query, for the intake's picker (any staff). */
export const searchConsignorsAction = staffAction(
  z.object({ q: z.string().trim().max(200) }),
  { name: "consignment.search_consignors" },
  async ({ q }, { supabase }) => (q ? searchConsignors(supabase, q) : []),
);

/** Shop bikes a unique consignment may be linked to (D51; any staff). */
export const searchShopBikesAction = staffAction(
  z.object({ q: z.string().trim().max(200) }),
  { name: "consignment.search_shop_bikes" },
  async ({ q }, { supabase }) => (q ? searchShopBikes(supabase, q) : []),
);

/** A customer's name and contact, to prefill a consignor linked to them. */
export const customerContactAction = staffAction(
  z.object({ customerId: z.guid({ error: "Unknown customer." }) }),
  { name: "consignment.customer_contact" },
  async ({ customerId }, { supabase }) => customerContact(supabase, customerId),
);
