"use client";

import { useRouter } from "next/navigation";
import { useCallback } from "react";

import { useToast } from "@/components/ui/toast";
import type { LinePlacement } from "@/lib/domain/lines";
import { AFTER_COMPLETE_NOTES, type AfterComplete } from "@/lib/workshop";

/**
 * D269: on a completed job the Add sheets say beforehand what will happen
 * and post `afterComplete`, so the action places the line through the
 * add_*_after_complete RPCs. Renders nothing on an open job.
 */
export function AfterCompleteNote({ mode }: { mode: AfterComplete | null }) {
  if (!mode) return null;
  return (
    <>
      <input type="hidden" name="afterComplete" value="on" />
      <p role="status" className="rounded-xl bg-info-soft p-3 text-sm text-info-deep">
        {AFTER_COMPLETE_NOTES[mode]}
      </p>
    </>
  );
}

/**
 * The success toast for an added line: on a follow-up job it says
 * "Added to follow-up job J-xxxx." with an Open button; completed again,
 * it says so after `title`.
 */
export function useAddedToast(): (title: string, placement?: LinePlacement) => void {
  const { toast } = useToast();
  const router = useRouter();
  return useCallback(
    (title: string, placement?: LinePlacement) => {
      const followUp = placement?.followUp;
      if (followUp) {
        toast({
          title: `Added to follow-up job ${followUp.jobNumber}.`,
          description: title,
          tone: "success",
          action: {
            label: `Open ${followUp.jobNumber}`,
            onAction: () => router.push(`/jobs/${followUp.id}`),
          },
        });
        return;
      }
      const again = placement?.recompleted ? " The job is completed again." : "";
      toast({ title: `${title}${again}`, tone: "success" });
    },
    [toast, router],
  );
}
