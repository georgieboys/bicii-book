"use server";

import { refresh } from "next/cache";

import { staffAction } from "@/lib/actions";
import { buildPackageSchema, packageArchiveSchema } from "@/lib/build-package-forms";
import {
  createBuildPackage,
  setBuildPackageArchived,
  updateBuildPackage,
} from "@/lib/domain/build-packages";

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
