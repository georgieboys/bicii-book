import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ArchiveControl } from "@/components/domain/archive-control";
import { EditBikeButton } from "@/components/domain/bike-sheet";
import { JobHistoryList } from "@/components/domain/job-history";
import { HeaderPrintLabel, LabelsCard } from "@/components/domain/labels-card";
import { PhotoGrid } from "@/components/domain/photo-grid";
import { ShortId } from "@/components/domain/short-id";
import { TransferOwnershipButton } from "@/components/domain/transfer-sheet";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ChevronRightIcon, PlusIcon, WrenchIcon } from "@/components/ui/icons";
import { requireStaff } from "@/lib/auth/session";
import { formatDate, formatDateTime } from "@/lib/dates";
import { listPhotos } from "@/lib/domain/attachments";
import { getBike, type OwnershipEvent } from "@/lib/domain/bikes";
import { getBikeStockUnit } from "@/lib/domain/inventory";
import { getLabelContext, resolvePrintPreset } from "@/lib/domain/labels";
import { unitStatusLabel, type UnitStatus } from "@/lib/inventory";
import { parsePrintParams } from "@/lib/printing/print-sheet";
import { listWorkOrdersForBike } from "@/lib/domain/workshop";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/uuid";

export const metadata: Metadata = { title: "Bike" };

/** The unit statuses that keep a bike in stock (bike_in_stock). */
const IN_STOCK: readonly UnitStatus[] = ["available", "reserved", "held_for_customer"];

function describe(event: OwnershipEvent): string {
  const to = event.to?.label ?? "the shop";
  if (event.type === "registered") return `Registered to ${to}`;
  return `${event.from?.label ?? "The shop"} → ${to}`;
}

/**
 * One bike (SPEC §5, §21): its permanent B- number first, photos with the
 * camera, the current owner with transfer, the ownership history (never
 * rewritten), service history (its jobs, newest first, with "New job"),
 * details and archiving. A bike that is (or was) a unique stock unit links
 * to it ("In stock as U-… · Available"); while it is in stock it cannot be
 * transferred to a customer or archived (bike_in_stock), and those
 * controls show that message. Phase 8: Print label (any staff) prints the
 * bike's B- tag (D57: workshop only, a public scan shows "not found"),
 * disabled with the reason while the bike is archived; the Labels card;
 * `?print=1&qty=N&reprint={job}` opens the print sheet preset.
 */
export default async function BikePage({ params, searchParams }: PageProps<"/bikes/[id]">) {
  const staff = await requireStaff();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const supabase = await createClient();
  // The label reads start with the rest (audit E1-7) but are awaited only
  // for a bike that exists (as on the product and unit pages): an unknown
  // id is a 404, never the label code's "not found" error. The no-op catch
  // keeps their refusal for an unknown id from going unhandled.
  const labelsQuery = getLabelContext(supabase, { kind: "bike", entityId: id });
  const presetQuery = searchParams.then((sp) =>
    resolvePrintPreset(supabase, "bike", id, parsePrintParams(sp)),
  );
  labelsQuery.catch(() => {});
  presetQuery.catch(() => {});
  const [bike, photos, jobs, stockUnit] = await Promise.all([
    getBike(supabase, id),
    listPhotos(supabase, { entityType: "bike", entityId: id }),
    listWorkOrdersForBike(supabase, id),
    getBikeStockUnit(supabase, id),
  ]);
  if (!bike) notFound();
  const [labels, preset] = await Promise.all([labelsQuery, presetQuery]);
  const archived = bike.archivedAt !== null;
  const details = [
    { label: "Serial number", value: bike.serialNumber, mono: true },
    { label: "Frame size", value: bike.frameSize },
    { label: "Colour", value: bike.colour },
    { label: "Variant", value: bike.variant },
  ];

  return (
    <>
      <header className="flex flex-col gap-4 pt-6 pb-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <ShortId value={bike.shortId} large />
            {archived ? <Badge tone="waiting">Archived</Badge> : null}
          </div>
          <h1 className="text-4xl sm:text-5xl">{bike.title}</h1>
          <p className="text-dust-700">
            {bike.owner ? (
              <>
                Owned by{" "}
                <Link href={`/customers/${bike.owner.id}`} className="font-medium underline">
                  {bike.owner.label}
                </Link>
              </>
            ) : (
              "Shop bike · no customer"
            )}
            {" · "}Registered {formatDate(bike.createdAt)}
          </p>
        </div>
        <div className="flex flex-wrap items-start gap-2">
          <HeaderPrintLabel
            kind="bike"
            entityId={bike.id}
            shortId={bike.shortId}
            ctx={labels}
            preset={preset}
          />
          <EditBikeButton
            bike={{
              id: bike.id,
              brand: bike.brand,
              model: bike.model,
              variant: bike.variant,
              frameSize: bike.frameSize,
              colour: bike.colour,
              serialNumber: bike.serialNumber,
              description: bike.description,
              internalNotes: bike.internalNotes,
            }}
          />
        </div>
      </header>

      {stockUnit ? (
        <Card title="Stock">
          <Link
            href={`/units/${stockUnit.id}`}
            className="-mx-2 flex min-h-tap flex-wrap items-center gap-3 rounded-xl px-2 py-1 hover:bg-dust-100"
          >
            <span className="font-medium">
              {IN_STOCK.includes(stockUnit.status) ? "In stock as" : "Stock unit"}{" "}
              <span className="font-mono">{stockUnit.shortId}</span>
              {" · "}
              {unitStatusLabel(stockUnit.status)}
            </span>
            <ChevronRightIcon className="ml-auto size-5 shrink-0 text-dust-500" />
          </Link>
          {IN_STOCK.includes(stockUnit.status) ? (
            <p className="mt-2 text-sm text-dust-500">
              While it is in stock it can&apos;t go to a customer or be archived; sell or write off
              the unit first.
            </p>
          ) : null}
        </Card>
      ) : null}

      <Card title="Photos">
        <PhotoGrid
          target={{ entityType: "bike", entityId: bike.id }}
          photos={photos}
          canAdd={!archived}
        />
      </Card>

      <LabelsCard
        kind="bike"
        entityId={bike.id}
        shortId={bike.shortId}
        ctx={labels}
        isAdmin={staff.role === "admin"}
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card
          title="Owner"
          actions={
            <TransferOwnershipButton
              bikeId={bike.id}
              currentOwner={bike.owner ? { id: bike.owner.id, label: bike.owner.label } : null}
              disabled={archived}
            />
          }
        >
          {bike.owner ? (
            <Link
              href={`/customers/${bike.owner.id}`}
              className="-mx-2 flex min-h-tap items-center gap-3 rounded-xl px-2 py-1 hover:bg-dust-100"
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="font-medium">{bike.owner.label}</span>
                <span className="truncate text-sm text-dust-500">
                  {[bike.owner.phone, bike.owner.email].filter(Boolean).join(" · ") ||
                    "No contact details"}
                </span>
              </span>
              {bike.owner.archived ? <Badge>Archived</Badge> : null}
              <ChevronRightIcon className="size-5 shrink-0 text-dust-500" />
            </Link>
          ) : (
            <p className="text-dust-700">
              No customer owns this bike: it belongs to the shop or is on consignment.
            </p>
          )}
          {archived ? (
            <p className="mt-3 text-sm text-dust-500">
              Archived bikes cannot change owner. Unarchive it first.
            </p>
          ) : null}
        </Card>

        <Card title="Ownership history">
          {bike.history.length === 0 ? (
            <p className="text-dust-700">No owner has been recorded for this bike.</p>
          ) : (
            <ol aria-label="Ownership history" className="flex flex-col">
              {bike.history.map((event, i) => (
                <li key={event.id} className="relative flex gap-3 pb-4 last:pb-0">
                  <span aria-hidden="true" className="flex flex-col items-center">
                    <span
                      className={
                        i === 0
                          ? "mt-1.5 size-3 shrink-0 rounded-full bg-ink"
                          : "mt-1.5 size-3 shrink-0 rounded-full border-2 border-dust-300 bg-card"
                      }
                    />
                    {i < bike.history.length - 1 ? (
                      <span className="mt-1 w-0.5 flex-1 bg-dust-200" />
                    ) : null}
                  </span>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="font-medium">{describe(event)}</span>
                    <span className="text-sm text-dust-500">
                      <time dateTime={event.at}>{formatDateTime(event.at)}</time>
                      {" · "}
                      {event.actorName ?? "Recorded outside the app"}
                    </span>
                    {event.reason ? (
                      <span className="text-sm text-dust-700">“{event.reason}”</span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>

      <Card
        title="Service history"
        actions={
          archived ? null : (
            <ButtonLink
              href={`/jobs/new?bike=${bike.id}`}
              variant="outline"
              size="sm"
              icon={<PlusIcon className="size-4" />}
            >
              New job
            </ButtonLink>
          )
        }
      >
        {jobs.items.length === 0 ? (
          <EmptyState
            icon={<WrenchIcon />}
            title="No jobs yet"
            description="Each visit to the workshop appears here, newest first."
          />
        ) : (
          <div className="flex flex-col gap-2">
            {jobs.more ? (
              <p className="text-sm text-dust-700">
                Showing the latest {jobs.items.length} jobs. There are more: find an older one by
                its J- number in Search.
              </p>
            ) : null}
            <JobHistoryList label="Service history" jobs={jobs.items} />
          </div>
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Details">
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
            {details.map((d) => (
              <div key={d.label} className="contents">
                <dt className="text-sm text-dust-500">{d.label}</dt>
                <dd className={d.mono && d.value ? "font-mono break-all" : undefined}>
                  {d.value ?? <span className="text-dust-500">—</span>}
                </dd>
              </div>
            ))}
          </dl>
          {bike.description ? (
            <p className="mt-4 whitespace-pre-line text-dust-700">{bike.description}</p>
          ) : null}
        </Card>
        <Card title="Internal notes" eyebrow="Staff only">
          {bike.internalNotes ? (
            <p className="whitespace-pre-line text-dust-700">{bike.internalNotes}</p>
          ) : (
            <p className="text-dust-500">No notes. Add them with Edit.</p>
          )}
        </Card>
      </div>

      <Card title="Archive">
        <ArchiveControl kind="bike" id={bike.id} name={bike.shortId} archived={archived} />
      </Card>
    </>
  );
}
