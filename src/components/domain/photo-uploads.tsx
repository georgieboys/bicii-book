"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { prepareUploads, recordPhoto } from "@/app/(staff)/attachments/actions";
import { AlertIcon } from "@/components/ui/icons";
import { useToast } from "@/components/ui/toast";
import type { PhotoTarget } from "@/lib/attachments";
import { onUploadProgress } from "@/lib/supabase/upload-progress";
import { newId } from "@/lib/uuid";

import { preparePhoto } from "./prepare-photo";
import { UploadStore, targetKeyOf, type PendingUpload } from "./upload-store";

export type { PendingUpload };

const UploadsContext = createContext<UploadStore | null>(null);

function createStore() {
  return new UploadStore({
    preparePhoto,
    prepareUploads,
    recordPhoto,
    upload: async (target, blob, onProgress) => {
      const stop = onUploadProgress(target.token, onProgress);
      try {
        // Loaded on the first upload, not with the layout: supabase-js and
        // the env check (zod) are about 160 KB gzip every staff page would
        // otherwise download before it is interactive.
        const { getBrowserClient } = await import("@/lib/supabase/browser");
        return await getBrowserClient()
          .storage.from(target.bucket)
          .uploadToSignedUrl(target.path, target.token, blob, { contentType: target.mediaType });
      } finally {
        stop();
      }
    },
    createPreview: (file) => URL.createObjectURL(file),
    revokePreview: (url) => URL.revokeObjectURL(url),
    newKey: newId,
    now: () => Date.now(),
  });
}

/**
 * Holds the staff app's photo upload queue (upload-store.ts) above every
 * page, so uploads, their failures and the unsaved-photo guard survive
 * moving between screens. Mounted in the staff layout; the toasts it
 * raises come from the root ToastProvider.
 */
export function PhotoUploadsProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createStore);
  const { toast, dismiss } = useToast();
  const router = useRouter();

  useEffect(() => {
    store.setUi({ toast, dismissToast: dismiss, refresh: () => router.refresh() });
    return () => store.setUi(null);
  }, [store, toast, dismiss, router]);

  // Closing or reloading the tab with unsaved photos asks first, whatever
  // screen is open.
  const unsaved = useSyncExternalStore(
    store.subscribe,
    () => store.unsaved().length > 0,
    () => false,
  );
  useEffect(() => {
    if (!unsaved) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [unsaved]);

  return <UploadsContext.Provider value={store}>{children}</UploadsContext.Provider>;
}

function useStore(): UploadStore {
  const store = useContext(UploadsContext);
  if (!store) throw new Error("Photo uploads need <PhotoUploadsProvider> (the staff layout).");
  return store;
}

const noItems: readonly PendingUpload[] = [];

/**
 * The queue's photos for one record (in flight, failed, or saved but not
 * yet on the page), with the ways to add, retry and discard them. While
 * mounted, the record counts as on screen: its queue draining refreshes
 * the page once.
 */
export function usePhotoUploads(target: PhotoTarget) {
  const store = useStore();
  const all = useSyncExternalStore(store.subscribe, store.getItems, () => noItems);
  const key = targetKeyOf(target);
  const { entityType, entityId } = target;

  useEffect(() => store.watch({ entityType, entityId }), [store, entityType, entityId]);

  const items = useMemo(() => all.filter((it) => it.targetKey === key), [all, key]);
  const actions = useMemo(
    () => ({
      addFiles: (files: File[]) => store.add({ entityType, entityId }, files),
      retry: (k: string) => store.retry(k),
      discard: (k: string) => store.discard(k),
      forgetShown: (ids: readonly string[]) => store.forgetShown(ids),
    }),
    [store, entityType, entityId],
  );
  return { items, ...actions };
}

const RECORD_PATH: Record<PhotoTarget["entityType"], string> = {
  bike: "/bikes",
  customer: "/customers",
  work_order: "/jobs",
  product: "/products",
  inventory_unit: "/units",
  consignment_item: "/consignment/items",
};

const hrefFor = (t: PhotoTarget) => `${RECORD_PATH[t.entityType]}/${t.entityId}`;

/**
 * "2 photos not saved" in the header, on every screen, while any photo
 * has failed: the lasting record of a failure (toasts can be dismissed).
 * Links to the record where the photo's tile has Retry and Discard.
 */
export function UnsavedPhotos() {
  const store = useContext(UploadsContext);
  const items = useSyncExternalStore(
    store?.subscribe ?? (() => () => {}),
    store?.getItems ?? (() => noItems),
    () => noItems,
  );
  const failed = items.filter((it) => it.status === "failed");
  if (failed.length === 0) return null;
  const n = failed.length;
  return (
    <Link
      href={hrefFor(failed[0].target)}
      className="flex min-h-tap shrink-0 items-center gap-1.5 rounded-full bg-danger px-3 text-sm font-medium text-danger-fg"
    >
      <AlertIcon className="size-4 shrink-0" />
      <span>
        {n}
        <span className="sr-only sm:not-sr-only"> {n === 1 ? "photo" : "photos"} not saved</span>
      </span>
    </Link>
  );
}
