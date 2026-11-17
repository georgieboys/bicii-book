"use server";

import { refresh } from "next/cache";

import { ActionError, staffAction } from "@/lib/actions";
import {
  buildPackageSchema,
  packageArchiveSchema,
  packageOnlineSchema,
} from "@/lib/build-package-forms";
import {
  createBuildPackage,
  getBuildPackage,
  recordBuildPackagePush,
  setBuildPackageArchived,
  setBuildPackageOnline,
  updateBuildPackage,
} from "@/lib/domain/build-packages";
import { ShopifyError } from "@/lib/integrations/shopify/admin";
import { pushBuildPackage } from "@/lib/integrations/shopify/build-packages";
import { getShopifyAdmin } from "@/lib/integrations/shopify/client";

/**
 * Build packages (D246): admins add, edit and archive them. RLS checks
 * again (build_packages_insert_admin, build_packages_update_admin).
 */

export const createBuildPackageAction = staffAction(
  buildPackageSchema,
  { name: "build_packages.create", admin: true },
  async ({ id, ...input }, { supabase }) => {
    const result = await createBuildPackage(supabase, id, input);
    refresh();
    return result;
  },
);

export const updateBuildPackageAction = staffAction(
  buildPackageSchema,
  { name: "build_packages.update", admin: true },
  async ({ id, ...input }, { supabase }) => {
    await updateBuildPackage(supabase, id, input);
    refresh();
    return { id };
  },
);

export const setBuildPackageArchivedAction = staffAction(
  packageArchiveSchema,
  { name: "build_packages.set_archived", admin: true },
  async ({ id, archived }, { supabase }) => {
    await setBuildPackageArchived(supabase, id, archived);
    refresh();
    return null;
  },
);

/**
 * D252: put a full build on Shopify (or update it, or take it off by
 * making it a draft) right away, then record its ids. Not queued: packages
 * change rarely and an admin presses it.
 */
export const pushBuildPackageAction = staffAction(
  packageOnlineSchema,
  { name: "build_packages.push_to_shopify", admin: true },
  async ({ id, publishOnline }, { supabase }) => {
    const admin = getShopifyAdmin();
    if (!admin)
      throw new ActionError("Shopify isn't connected, so the package can't be put online.");
    const pkg = await getBuildPackage(supabase, id);
    if (!pkg) throw new ActionError("That package no longer exists. Refresh and try again.");
    if (pkg.kind !== "full_build") throw new ActionError("Only a full build is sold online.");
    if (publishOnline && (pkg.archived || !pkg.public)) {
      throw new ActionError(
        "Show the package on the site, and unarchive it, before putting it online.",
      );
    }
    await setBuildPackageOnline(supabase, id, publishOnline);
    try {
      const ids = await pushBuildPackage(admin, { ...pkg, publishOnline });
      await recordBuildPackagePush(supabase, id, ids.productId, ids.variantId);
    } catch (error) {
      if (error instanceof ShopifyError) throw new ActionError(error.userMessage);
      throw error;
    }
    refresh();
    return null;
  },
);
