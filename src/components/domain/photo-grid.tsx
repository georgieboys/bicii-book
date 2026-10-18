"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { CameraIcon } from "@/components/ui/icons";
import { VISIBILITY_LABELS, type PhotoTarget } from "@/lib/attachments";
import type { Photo } from "@/lib/domain/attachments";

import { CaptureButton } from "./capture-button";
import { PhotoViewer } from "./photo-viewer";

const noPhotos = (
  <p className="flex items-center gap-2 text-dust-500">
    <CameraIcon className="size-5 shrink-0" />
    No photos yet.
  </p>
);

/**
 * A record's photos: a thumbnail grid (tap to enlarge, caption, visibility,
 * delete in PhotoViewer) with the camera controls underneath.
 *
 * Internal photos are shown through short-lived signed URLs; if one has
 * expired by the time it loads (a page left open), the page is refreshed
 * once to mint new ones.
 */
export function PhotoGrid({
  target,
  photos,
  canAdd = true,
}: {
  target: PhotoTarget;
  photos: Photo[];
  /** False hides the camera (e.g. an archived record). */
  canAdd?: boolean;
}) {
  const router = useRouter();
  const [openId, setOpenId] = useState<string | null>(null);
  const refreshedAt = useRef(0);
  const open = photos.find((p) => p.id === openId) ?? null;

  const onBroken = () => {
    // At most one refresh a minute, so a photo that is really missing does
    // not loop.
    if (Date.now() - refreshedAt.current < 60_000) return;
    refreshedAt.current = Date.now();
    router.refresh();
  };

  return (
    <div className="flex flex-col gap-4">
      {photos.length > 0 ? (
        <ul aria-label="Photos" className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {photos.map((photo, i) => (
            <li key={photo.id} className="relative aspect-square">
              <button
                type="button"
                onClick={() => setOpenId(photo.id)}
                aria-label={`Open photo ${i + 1}${photo.caption ? `: ${photo.caption}` : ""}`}
                className="block size-full cursor-pointer overflow-hidden rounded-xl bg-sunken focus-visible:outline-offset-2"
              >
                {photo.thumbUrl ? (
                  <Image
                    src={photo.thumbUrl}
                    alt={photo.caption ?? ""}
                    width={photo.width ?? 400}
                    height={photo.height ?? 400}
                    unoptimized
                    loading="lazy"
                    onError={onBroken}
                    className="size-full object-cover"
                  />
                ) : (
                  <span className="flex size-full items-center justify-center p-2 text-center text-xs text-dust-500">
                    Photo unavailable
                  </span>
                )}
              </button>
              {photo.visibility !== "internal" ? (
                <Badge
                  tone={photo.visibility === "public" ? "info" : "done"}
                  emphasis="solid"
                  className="pointer-events-none absolute bottom-1.5 left-1.5"
                >
                  {VISIBILITY_LABELS[photo.visibility]}
                </Badge>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {canAdd ? (
        <CaptureButton
          target={target}
          hiddenIds={photos.map((p) => p.id)}
          empty={photos.length === 0 ? noPhotos : null}
        />
      ) : photos.length === 0 ? (
        noPhotos
      ) : null}
      {open ? (
        <PhotoViewer
          key={open.id}
          photo={open}
          index={photos.indexOf(open)}
          onClose={() => setOpenId(null)}
          onBroken={onBroken}
        />
      ) : null}
    </div>
  );
}
