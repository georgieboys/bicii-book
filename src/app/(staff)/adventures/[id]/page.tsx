import type { Metadata } from "next";
import { notFound } from "next/navigation";

import {
  ArchiveAdventureButton,
  OfferButton,
  PublishButton,
  RemoveOfferButton,
  StartDraftButton,
  UnarchiveAdventureButton,
} from "@/components/domain/adventures/catalogue-sheets";
import { CheckpointsEditor, DraftForm } from "@/components/domain/adventures/draft-editor";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import {
  canManageAdventures,
  EVENT_LABELS,
  formatDistance,
  formatElapsed,
  isCertifiableDistance,
  PARTICIPATION_DESCRIPTIONS,
  PARTICIPATION_LABELS,
  PARTICIPATIONS,
  STATUS_LABELS,
} from "@/lib/adventures";
import { requireStaff } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/dates";
import { getAdventure, type AdventureRevision } from "@/lib/domain/adventures";
import { formatMoney } from "@/lib/money";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/uuid";

export const metadata: Metadata = { title: "Adventure" };

/** A read-only summary of a revision: what the public sees, or the draft for viewers. */
function RevisionSummary({ revision }: { revision: AdventureRevision }) {
  const facts = [
    formatDistance(revision.distanceKm),
    revision.nominalDays !== null
      ? `${revision.nominalDays} ${revision.nominalDays === 1 ? "day" : "days"}`
      : null,
    revision.maxElapsedMinutes !== null
      ? `within ${formatElapsed(revision.maxElapsedMinutes)}`
      : null,
    revision.terrain || null,
    revision.whenToStart || null,
  ].filter(Boolean);
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="text-dust-700">{facts.join(" · ")}</p>
      {revision.summary ? <p>{revision.summary}</p> : null}
      {revision.note ? <p className="text-dust-700">{revision.note}</p> : null}
      {revision.routeUrl ? (
        <p>
          <a href={revision.routeUrl} className="underline" target="_blank" rel="noreferrer">
            Route link
          </a>
        </p>
      ) : (
        <p className="text-dust-500">No route link yet.</p>
      )}
      <p className="text-dust-700">
        {revision.checkpoints.length === 0
          ? "No checkpoints."
          : `${revision.checkpoints.length} ${revision.checkpoints.length === 1 ? "checkpoint" : "checkpoints"}: ${revision.checkpoints.map((c) => c.label).join(", ")}.`}
      </p>
    </div>
  );
}

/** The offers of a revision; editable when it is the draft and the viewer manages adventures. */
function OffersCard({ revision, editable }: { revision: AdventureRevision; editable: boolean }) {
  const certifiable = isCertifiableDistance(revision.distanceKm) && !revision.isPlanned;
  return (
    <Card title="Certification offers">
      {!certifiable ? (
        <p className="text-sm text-dust-700">
          {revision.isPlanned
            ? "A planned route is not sold. Untick “Still being planned” to add offers."
            : "Certification starts at 125 km. This route stays free to ride."}
        </p>
      ) : (
        <ul aria-label="Offers" className="-mx-4 flex flex-col divide-y divide-hairline sm:-mx-5">
          {PARTICIPATIONS.map((kind) => {
            const offer = revision.offers.find((o) => o.kind === kind) ?? null;
            return (
              <li key={kind} className="flex flex-wrap items-start gap-3 px-4 py-3 sm:px-5">
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="font-medium">{PARTICIPATION_LABELS[kind]}</span>
                  {offer ? (
                    <span className="text-sm text-dust-700 tabular-nums">
                      {formatMoney(offer.price)}
                      {kind === "supported"
                        ? ` · ${offer.supportedDays} ${offer.supportedDays === 1 ? "day" : "days"}, tracker included`
                        : offer.trackerHirePrice
                          ? ` · tracker hire ${formatMoney(offer.trackerHirePrice)} per 24 h`
                          : " · no tracker hire"}
                    </span>
                  ) : (
                    <span className="text-sm text-dust-500">
                      {PARTICIPATION_DESCRIPTIONS[kind]}
                    </span>
                  )}
                </span>
                {editable ? (
                  <span className="flex gap-2">
                    {offer ? <RemoveOfferButton revisionId={revision.id} kind={kind} /> : null}
                    <OfferButton
                      revisionId={revision.id}
                      kind={kind}
                      offer={offer}
                      nominalDays={revision.nominalDays}
                    />
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

/**
 * One adventure (DATA-MODEL §20): what the public sees (the published,
 * sealed version) and, for manage_adventures, the draft editor with its
 * checkpoints and offers, Publish, Archive, and the history.
 */
export default async function AdventurePage({ params }: PageProps<"/adventures/[id]">) {
  const staff = await requireStaff();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const adventure = await getAdventure(await createClient(), id);
  if (!adventure) notFound();
  const manage = canManageAdventures(staff);
  const archived = adventure.status === "archived";
  const name = adventure.draft?.name ?? adventure.current?.name ?? adventure.slug;

  return (
    <>
      <PageHeader
        eyebrow="Adventure"
        title={name}
        description={`bicii.sg/adventures/${adventure.slug}`}
        actions={
          <>
            {adventure.status === "published" ? (
              <Badge tone="done">{STATUS_LABELS.published}</Badge>
            ) : archived ? (
              <Badge tone="waiting">{STATUS_LABELS.archived}</Badge>
            ) : (
              <Badge>{STATUS_LABELS.draft}</Badge>
            )}
            {manage && !adventure.draft && !archived ? (
              <StartDraftButton adventureId={adventure.id} />
            ) : null}
            {manage && adventure.draft && !archived ? (
              <PublishButton
                revisionId={adventure.draft.id}
                firstPublish={adventure.current === null}
              />
            ) : null}
            {manage ? (
              archived ? (
                <UnarchiveAdventureButton adventureId={adventure.id} />
              ) : (
                <ArchiveAdventureButton adventureId={adventure.id} />
              )
            ) : null}
          </>
        }
      />

      <div className="flex flex-col gap-6">
        {adventure.current ? (
          <Card
            eyebrow={`Version ${adventure.current.revisionNumber}`}
            title="What the public sees"
          >
            <RevisionSummary revision={adventure.current} />
          </Card>
        ) : null}
        {adventure.current && !adventure.draft ? (
          <OffersCard revision={adventure.current} editable={false} />
        ) : null}

        {adventure.draft ? (
          <section aria-labelledby="draft-heading" className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <h2 id="draft-heading" className="text-lg font-semibold">
                Draft (version {adventure.draft.revisionNumber})
              </h2>
              <p className="text-sm text-dust-700">
                Changes here are not public until you publish. Publishing locks this version.
              </p>
            </div>
            {manage && !archived ? (
              <>
                <DraftForm draft={adventure.draft} />
                <CheckpointsEditor
                  key={adventure.draft.id}
                  revisionId={adventure.draft.id}
                  checkpoints={adventure.draft.checkpoints}
                />
              </>
            ) : (
              <Card title="Draft">
                <RevisionSummary revision={adventure.draft} />
              </Card>
            )}
            <OffersCard revision={adventure.draft} editable={manage && !archived} />
          </section>
        ) : null}

        <Card title="History">
          <ol aria-label="Adventure history" className="flex flex-col gap-2 text-sm">
            {adventure.events.map((e) => (
              <li key={e.id} className="flex flex-col">
                <span>
                  {EVENT_LABELS[e.kind]}
                  {e.revisionNumber !== null ? ` · version ${e.revisionNumber}` : ""}
                  {e.staffName ? ` · ${e.staffName}` : ""}
                </span>
                <span className="text-dust-500">
                  {formatDateTime(e.createdAt)}
                  {e.reason ? ` · ${e.reason}` : ""}
                </span>
              </li>
            ))}
          </ol>
        </Card>
      </div>
    </>
  );
}
