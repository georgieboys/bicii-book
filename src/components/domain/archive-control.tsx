"use client";

import { useEffect, useRef, useState, useTransition } from "react";

import { setBikeArchived } from "@/app/(staff)/bikes/actions";
import { setConsignorArchivedAction } from "@/app/(staff)/consignment/actions";
import { archiveProduct } from "@/app/(staff)/inventory/actions";
import { setCustomerArchived } from "@/app/(staff)/customers/actions";
import { setServiceArchived } from "@/app/(staff)/settings/services/actions";
import { setSupplierArchived } from "@/app/(staff)/purchasing/supplier-actions";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";

/** How long the confirm button stays disabled after the confirmation opens (a double tap). */
const CONFIRM_GUARD_MS = 400;

const COPY = {
  customer: {
    noun: "customer",
    archived:
      "Archived: hidden from search and pickers, no bikes or bookings can be added for them, and their bicii.sg account is closed. Their bikes and history are kept.",
    active:
      "Archiving hides this customer from search and pickers, stops new bikes and bookings, and closes their online account on bicii.sg. It can't be done while they have an open job, an upcoming booking, an open quote or payment link, or a consignor record that isn't archived. Nothing is deleted: their bikes and history stay, and you can unarchive them later.",
  },
  bike: {
    noun: "bike",
    archived:
      "Archived: hidden from search and pickers, and its owner cannot change. Its B- number, photos and history are kept.",
    active:
      "Archiving hides this bike from search and pickers. Nothing is deleted: it keeps its B- number, photos and history, and you can unarchive it later.",
  },
  product: {
    noun: "product",
    archived:
      "Archived: hidden from the Inventory list, search and the job part picker. Its P- number, history and the jobs that used it are kept.",
    active:
      "Archiving hides this product from the Inventory list, search and the job part picker. Only a product with no stock left and not public can be archived. Nothing is deleted, and you can unarchive it later.",
  },
  consignor: {
    noun: "consignor",
    archived:
      "Archived: hidden from the consignor list, search and the intake picker, and takes in no new items. Their items, payments and history are kept.",
    active:
      "Archiving hides this consignor from the list, search and the intake picker. Only a consignor with no items for sale and nothing owed either way can be archived. Nothing is deleted, and you can unarchive them later.",
  },
  service: {
    noun: "service",
    archived:
      "Archived: not offered on jobs or in the services list. Jobs that used it keep their lines.",
    active:
      "Archiving takes this service off the list jobs choose from. Nothing is deleted: jobs that used it keep their lines, and you can unarchive it later.",
  },
  // Purchasing (Phase 7)
  supplier: {
    noun: "supplier",
    archived:
      "Archived: hidden from search and the supplier pickers, and takes no new orders. Its orders and history are kept.",
    active:
      "Archiving hides this supplier from search and the supplier pickers. Only a supplier with no open orders can be archived. Nothing is deleted: its orders stay, and you can unarchive it later.",
  },
} as const;

/**
 * Archive (two steps: the first press opens a confirmation in a different
 * place whose button is disabled for 400 ms, DESIGN.md "Forms") or
 * unarchive (one press). Archiving is the
 * only way to retire a customer, bike, service, product or consignor: rows are never deleted, so every
 * historical reference keeps working (SPEC §23).
 */
export function ArchiveControl({
  kind,
  id,
  name,
  archived,
}: {
  kind: "customer" | "bike" | "service" | "product" | "consignor" | "supplier";
  id: string;
  name: string;
  archived: boolean;
}) {
  const { toast } = useToast();
  const [pending, start] = useTransition();
  const [confirming, setConfirming] = useState(false);
  // The confirm button stays disabled for a moment after the first press,
  // so a double tap cannot archive by itself.
  const [armed, setArmed] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const startRef = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);
  const copy = COPY[kind];

  useEffect(() => {
    const cancelled = wasConfirming.current && !confirming;
    wasConfirming.current = confirming;
    // Cancel removed the focused button: put focus back on "Archive …".
    if (cancelled) startRef.current?.focus();
    if (!confirming) return;
    boxRef.current?.querySelector<HTMLButtonElement>("[data-cancel]")?.focus();
    const timer = window.setTimeout(() => setArmed(true), CONFIRM_GUARD_MS);
    return () => window.clearTimeout(timer);
  }, [confirming]);

  const apply = (next: boolean) => {
    start(async () => {
      const result =
        kind === "customer"
          ? await setCustomerArchived({ customerId: id, archived: next })
          : kind === "bike"
            ? await setBikeArchived({ bikeId: id, archived: next })
            : kind === "product"
              ? await archiveProduct({ productId: id, archived: next })
              : kind === "consignor"
                ? await setConsignorArchivedAction({ consignorId: id, archived: next })
                : kind === "supplier"
                  ? await setSupplierArchived({ supplierId: id, archived: next })
                  : await setServiceArchived({ id, archived: next });
      if (!result.ok) {
        toast({
          title: next ? `${name} not archived` : `${name} not unarchived`,
          description: result.error,
          tone: "error",
        });
        return;
      }
      setConfirming(false);
      toast({ title: next ? `${name} archived` : `${name} unarchived`, tone: "success" });
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-dust-700">{archived ? copy.archived : copy.active}</p>
      {archived ? (
        <div key="unarchive">
          <Button
            variant="outline"
            pending={pending}
            pendingLabel="Unarchiving…"
            onClick={() => apply(false)}
          >
            Unarchive
          </Button>
        </div>
      ) : confirming ? (
        <div
          key="confirm"
          ref={boxRef}
          className="flex flex-col gap-3 rounded-xl bg-waiting-soft p-4"
        >
          <p className="font-medium text-waiting-deep">Archive {name}?</p>
          <div className="flex flex-wrap gap-2">
            <Button
              key="cancel"
              data-cancel=""
              variant="outline"
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
            <Button
              key="confirm-archive"
              variant="solid"
              disabled={!armed}
              pending={pending}
              pendingLabel="Archiving…"
              onClick={() => apply(true)}
            >
              Archive {copy.noun}
            </Button>
          </div>
        </div>
      ) : (
        <div key="start">
          <Button
            key="archive"
            ref={startRef}
            variant="outline"
            onClick={() => {
              setArmed(false);
              setConfirming(true);
            }}
          >
            Archive {copy.noun}…
          </Button>
        </div>
      )}
    </div>
  );
}
