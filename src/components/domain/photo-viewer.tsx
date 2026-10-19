"use client";

import Image from "next/image";
import {
  useActionState,
  useEffect,
  useId,
  useOptimistic,
  useRef,
  useState,
  useTransition,
} from "react";

import {
  deletePhoto,
  setPhotoCaption,
  setPhotoVisibility,
} from "@/app/(staff)/attachments/actions";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Sheet } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import type { ActionResult } from "@/lib/actions";
import { isUndecodedOriginal, visibilityOptions, type Visibility } from "@/lib/attachments";
import { formatDateTime } from "@/lib/dates";
import type { Photo } from "@/lib/domain/attachments";
import { formatBytes } from "@/lib/images";
import { callAction } from "@/lib/call-action";

/** Clicks this soon after the delete confirmation opens are ignored (a double tap). */
const CONFIRM_GUARD_MS = 400;

/**
 * One photo, enlarged, with what staff can change about it: its caption,
 * who may see it (internal / customer / public, each explained; PLAN D13:
 * never public on a customer record, nor for an original that may carry
 * its GPS position) and deleting it with a reason.
 *
 * A change that went through but could not remove the photo's old copy
 * from Storage says so (not as a failure) and offers Finish, which repeats
 * it; the next showing of the record finishes it anyway (listPhotos).
 */
export function PhotoViewer({
  photo,
  index,
  onClose,
  onBroken,
}: {
  photo: Photo;
  index: number;
  onClose: () => void;
  onBroken: () => void;
}) {
  return (
    <Sheet
      open
      onOpenChange={(open) => !open && onClose()}
      title={`Photo ${index + 1}`}
      description={`Added ${formatDateTime(photo.createdAt)}${
        photo.byteSize ? ` · ${formatBytes(photo.byteSize)}` : ""
      }${photo.width && photo.height ? ` · ${photo.width}×${photo.height}` : ""}`}
    >
      <div className="flex flex-col gap-6">
        <figure className="flex flex-col gap-2">
          {photo.url ? (
            <a
              href={photo.url}
              target="_blank"
              rel="noopener noreferrer"
              className="block overflow-hidden rounded-xl bg-ink"
            >
              <Image
                src={photo.url}
                alt={photo.caption ?? `Photo ${index + 1}`}
                width={photo.width ?? 1200}
                height={photo.height ?? 900}
                unoptimized
                onError={onBroken}
                className="mx-auto max-h-[55dvh] w-auto object-contain"
              />
              <span className="sr-only">(opens full size in a new tab)</span>
            </a>
          ) : (
            <p className="rounded-xl bg-sunken p-6 text-center text-dust-500">
              This photo can&rsquo;t be shown right now.
            </p>
          )}
          {photo.caption ? (
            <figcaption className="text-sm text-dust-700">{photo.caption}</figcaption>
          ) : null}
        </figure>
        <VisibilityControl photo={photo} />
        <CaptionForm photo={photo} />
        <DeleteControl photo={photo} onDeleted={onClose} />
      </div>
    </Sheet>
  );
}

function VisibilityControl({ photo }: { photo: Photo }) {
  const { toast } = useToast();
  const [optimistic, setOptimistic] = useOptimistic(photo.visibility);
  const [pending, start] = useTransition();
  // The setting whose move went through but left an old copy to remove.
  const [unfinished, setUnfinished] = useState<Visibility | null>(null);
  const options = visibilityOptions(photo.entityType, { original: isUndecodedOriginal(photo) });
  const current = options.find((o) => o.value === optimistic) ?? options[0];
  const blocked = options.filter((o) => o.blocked);
  const labelId = useId();
  const labelOf = (v: Visibility) => options.find((o) => o.value === v)?.label.toLowerCase();

  const change = (next: Visibility) => {
    // Choosing the current setting again only means something when it
    // still has a cleanup to finish.
    if (next === optimistic && next !== unfinished) return;
    start(async () => {
      setOptimistic(next);
      const result = await callAction(() =>
        setPhotoVisibility({ attachmentId: photo.id, visibility: next }),
      );
      if (!result.ok) {
        toast({
          title: "Visibility not changed",
          description: result.error,
          tone: "error",
          action: { label: "Retry", onAction: () => change(next) },
        });
        return;
      }
      if (result.data.cleanupPending) {
        setUnfinished(next);
        toast({
          title: `Photo is now ${labelOf(next)}`,
          description:
            "Its old copy could not be removed yet. Press Finish, or it is removed the next time this record is opened.",
          tone: "info",
          action: { label: "Finish", onAction: () => change(next) },
        });
        return;
      }
      setUnfinished(null);
      toast({ title: `Photo is now ${labelOf(next)}`, tone: "success" });
    });
  };

  return (
    <section
      aria-labelledby={labelId}
      className="flex flex-col gap-2"
      aria-busy={pending || undefined}
    >
      <h3 id={labelId} className="font-display text-xs font-bold tracking-wide uppercase">
        Who can see this photo
      </h3>
      <SegmentedControl
        label="Who can see this photo"
        value={optimistic}
        onValueChange={change}
        options={options.map((o) => ({
          value: o.value,
          label: o.label,
          disabled: Boolean(o.blocked),
        }))}
      />
      <p className="text-sm text-dust-700">
        <span className="font-medium">{current.label}:</span> {current.description}
      </p>
      {unfinished && unfinished === optimistic ? (
        <div className="flex flex-wrap items-center gap-2 rounded-xl bg-waiting-soft p-3">
          <p className="flex-1 text-sm text-waiting-deep">
            The photo&rsquo;s old copy is still being removed.
          </p>
          <Button
            variant="outline"
            size="sm"
            pending={pending}
            pendingLabel="Finishing…"
            onClick={() => change(unfinished)}
          >
            Finish
          </Button>
        </div>
      ) : null}
      {[...new Set(blocked.map((o) => o.blocked))].map((why) => (
        <p key={why} className="text-sm text-dust-500">
          {why}
        </p>
      ))}
    </section>
  );
}

type CaptionState = ActionResult | null;

function CaptionForm({ photo }: { photo: Photo }) {
  const { toast } = useToast();
  const [state, formAction, pending] = useActionState<CaptionState, FormData>(
    async (prev, formData) => {
      const result = await callAction(() => setPhotoCaption(prev, formData), formData);
      if (result.ok) toast({ title: "Caption saved", tone: "success" });
      return result;
    },
    null,
  );
  const values = state && !state.ok ? state.values : undefined;
  return (
    <form action={formAction} className="flex flex-col gap-3" noValidate>
      <input type="hidden" name="attachmentId" value={photo.id} />
      <Field
        label="Caption"
        hint="Optional. Customers see it with the photo if it is shared with them."
        error={state && !state.ok ? (state.fieldErrors?.caption?.[0] ?? state.error) : undefined}
      >
        <Textarea
          name="caption"
          rows={2}
          maxLength={500}
          defaultValue={values?.caption ?? photo.caption ?? ""}
        />
      </Field>
      <div>
        <Button type="submit" variant="outline" size="sm" pending={pending} pendingLabel="Saving…">
          Save caption
        </Button>
      </div>
    </form>
  );
}

function DeleteControl({ photo, onDeleted }: { photo: Photo; onDeleted: () => void }) {
  const { toast } = useToast();
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [pending, start] = useTransition();
  const openedAt = useRef(0);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const startRef = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);

  // Opening the confirmation focuses the reason; Cancel puts focus back on
  // "Delete photo…" (the focused Cancel button has just gone).
  useEffect(() => {
    if (confirming) reasonRef.current?.focus();
    else if (wasConfirming.current) startRef.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);

  const remove = (why: string) => {
    start(async () => {
      const result = await callAction(() => deletePhoto({ attachmentId: photo.id, reason: why }));
      if (result.ok) {
        toast(
          result.data.cleanupPending
            ? {
                title: "Photo deleted",
                description:
                  "Its file could not be removed from storage yet. Press Finish, or it is removed the next time this record is opened.",
                tone: "info",
                action: { label: "Finish", onAction: () => remove(why) },
              }
            : { title: "Photo deleted", tone: "success" },
        );
        onDeleted();
        return;
      }
      const fieldError = result.fieldErrors?.reason?.[0];
      if (fieldError) {
        setError(fieldError);
        reasonRef.current?.focus();
        return;
      }
      toast({
        title: "Photo not deleted",
        description: result.error,
        tone: "error",
        action: { label: "Retry", onAction: () => remove(why) },
      });
    });
  };

  const confirm = () => {
    if (Date.now() - openedAt.current < CONFIRM_GUARD_MS) return;
    if (!reason.trim()) {
      setError("Say why you are deleting this photo.");
      reasonRef.current?.focus();
      return;
    }
    remove(reason);
  };

  if (!confirming) {
    return (
      <div key="start" className="border-t border-hairline pt-4">
        <Button
          key="delete"
          ref={startRef}
          variant="ghost"
          size="sm"
          className="text-danger-deep"
          onClick={() => {
            openedAt.current = Date.now();
            setReason("");
            setError(undefined);
            setConfirming(true);
          }}
        >
          Delete photo…
        </Button>
      </div>
    );
  }
  return (
    <div key="confirm" className="flex flex-col gap-3 border-t border-hairline pt-4">
      <Field
        label="Why are you deleting this photo?"
        hint="Kept in the photo history with your name."
        error={error}
        required
      >
        <Textarea
          ref={reasonRef}
          name="reason"
          rows={2}
          maxLength={500}
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
            if (error) setError(undefined);
          }}
        />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button key="cancel" variant="outline" onClick={() => setConfirming(false)}>
          Cancel
        </Button>
        <Button
          key="confirm-delete"
          variant="danger"
          pending={pending}
          pendingLabel="Deleting…"
          onClick={confirm}
        >
          Delete photo
        </Button>
      </div>
    </div>
  );
}
