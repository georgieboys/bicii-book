"use server";

import { refresh } from "next/cache";

import { staffAction } from "@/lib/actions";
import {
  clearJobBuildSchema,
  fitBuildSchema,
  jobBuildSchema,
  repriceLineSchema,
} from "@/lib/build-package-forms";
import {
  clearJobBuild,
  fitBuildToBudget,
  repriceBuildLine,
  setJobBuild,
} from "@/lib/domain/build-packages";

/**
 * A job's build package (D247-D251), for any active staff member like the
 * job's other lines. The RPCs check the job is open and do the arithmetic.
 */

export const setJobBuildAction = staffAction(
  jobBuildSchema,
  { name: "jobs.set_build" },
  async ({ workOrderId, packageId, labourLineId, price }, { supabase }) => {
    await setJobBuild(supabase, workOrderId, packageId, labourLineId, price);
    refresh();
    return null;
  },
);

export const clearJobBuildAction = staffAction(
  clearJobBuildSchema,
  { name: "jobs.clear_build" },
  async ({ workOrderId, reason }, { supabase }) => {
    await clearJobBuild(supabase, workOrderId, reason);
    refresh();
    return null;
  },
);

export const repriceBuildLineAction = staffAction(
  repriceLineSchema,
  { name: "jobs.reprice_build_line" },
  async ({ lineId, price }, { supabase }) => {
    await repriceBuildLine(supabase, lineId, price);
    refresh();
    return null;
  },
);

export const fitBuildToBudgetAction = staffAction(
  fitBuildSchema,
  { name: "jobs.fit_build_to_budget" },
  async ({ workOrderId }, { supabase }) => {
    await fitBuildToBudget(supabase, workOrderId);
    refresh();
    return null;
  },
);
