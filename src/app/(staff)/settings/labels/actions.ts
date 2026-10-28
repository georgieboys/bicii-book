"use server";

import { refresh } from "next/cache";
import { z } from "zod";

import { staffAction } from "@/lib/actions";
import {
  saveProfile,
  saveTemplate,
  setDefaultProfile,
  setDefaultTemplate,
  setPublicSiteUrl,
} from "@/lib/domain/labels";
import {
  labelTemplateInputSchema,
  printerProfileInputSchema,
  publicSiteUrlInputSchema,
} from "@/lib/printing/schemas";

/**
 * Labels and printers settings (admins only; SPEC §16; PLAN D9, ADR-017).
 * The screens: src/app/(staff)/settings/labels/page.tsx and
 * src/components/domain/label-settings.tsx. The database checks every rule again
 * (layout and printer config validators, column grants, admin RPCs).
 *
 *   saveTemplateAction        create (the form's id is the key) or update
 *   setDefaultTemplateAction  the default template for its kind
 *   saveProfileAction         create or update a printer (its type is fixed)
 *   setDefaultProfileAction   the default printer
 *   setPublicSiteUrlAction    the shop's public website address: the QR base
 */

const mode = z.enum(["create", "update"]);

export const saveTemplateAction = staffAction(
  z.object({ id: z.guid(), mode, template: labelTemplateInputSchema }),
  { name: "labels.save_template", admin: true },
  async ({ id, mode, template }, { supabase }) => {
    const saved = await saveTemplate(supabase, id, template, mode);
    refresh();
    return saved;
  },
);

export const setDefaultTemplateAction = staffAction(
  z.object({ id: z.guid() }),
  { name: "labels.set_default_template", admin: true },
  async ({ id }, { supabase }) => {
    await setDefaultTemplate(supabase, id);
    refresh();
    return null;
  },
);

export const saveProfileAction = staffAction(
  z.object({ id: z.guid(), mode, profile: printerProfileInputSchema }),
  { name: "labels.save_profile", admin: true },
  async ({ id, mode, profile }, { supabase }) => {
    const saved = await saveProfile(supabase, id, profile, mode);
    refresh();
    return saved;
  },
);

export const setDefaultProfileAction = staffAction(
  z.object({ id: z.guid() }),
  { name: "labels.set_default_profile", admin: true },
  async ({ id }, { supabase }) => {
    await setDefaultProfile(supabase, id);
    refresh();
    return null;
  },
);

export const setPublicSiteUrlAction = staffAction(
  publicSiteUrlInputSchema,
  { name: "labels.set_public_site_url", admin: true },
  async ({ publicSiteUrl }, { supabase }) => {
    const saved = await setPublicSiteUrl(supabase, publicSiteUrl);
    refresh();
    return { publicSiteUrl: saved };
  },
);
