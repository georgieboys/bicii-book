import type { Metadata } from "next";
import Link from "next/link";
import { forbidden, notFound } from "next/navigation";

import { ClaimReviewButton } from "@/components/domain/adventures/booking-sheets";
import { ReviewDecisionForm } from "@/components/domain/adventures/review-form";
import { TrackMap } from "@/components/domain/adventures/track-map";
import { CorrectCaptureButton } from "@/components/domain/adventures/tracker-sheets";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import {
  canVerifyAdventures,
  DECISION_LABELS,
  FILE_STATE_LABELS,
  formatDistance,
  formatElapsed,
  formatMetres,
  minutesBetween,
  SUBMISSION_STATE_LABELS,
} from "@/lib/adventures";
import { requireStaff } from "@/lib/auth/session";
import { formatDateTime, shopDateKey, toShopLocal } from "@/lib/dates";
import { getReviewWorkspace, type ReviewWorkspace } from "@/lib/domain/adventure-bookings";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/uuid";

export const metadata: Metadata = { title: "Ride review" };

/** The figures the decision form starts from: the longest recording's. */
function suggestions(w: ReviewWorkspace) {
  const tracks: Array<{ distanceKm: string; finishedAt: string | null }> = [
    ...w.files.flatMap((f) => (f.track ? [f.track] : [])),
    ...(w.tracker && w.tracker.points > 1
      ? [{ distanceKm: w.tracker.distanceKm, finishedAt: w.tracker.lastAt }]
      : []),
  ];
  if (tracks.length === 0) return { distance: null, day: null };
  const longest = tracks.reduce((a, b) => (Number(b.distanceKm) > Number(a.distanceKm) ? b : a));
  const finished = tracks
    .map((t) => t.finishedAt)
    .filter((t): t is string => t !== null)
    .sort()
    .at(-1);
  return { distance: longest.distanceKm, day: finished ? shopDateKey(finished) : null };
}

/**
 * The review workspace (D178, D182): the rider's recordings drawn with the
 * route's checkpoints, the derived figures beside the route's rules, the
 * checkpoint photos, earlier decisions, and the decision form. Staff with
 * verify_adventures only; the figures inform the decision, never make it.
 */
export default async function AdventureReviewPage({
  params,
}: PageProps<"/adventures/reviews/[id]">) {
  const staff = await requireStaff();
  if (!canVerifyAdventures(staff)) forbidden();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const w = await getReviewWorkspace(await createClient(), id);
  if (!w) notFound();

  const activities = w.files.filter((f) => f.kind === "activity");
  const photos = w.files.filter((f) => f.kind === "checkpoint_photo");
  const fileTracks = activities.flatMap((f) => (f.track ? [f.track] : []));
  // The hired tracker's track counts like a file's (D191).
  const tracks = [
    ...fileTracks,
    ...(w.tracker && w.tracker.points > 1
      ? [
          {
            startedAt: w.tracker.firstAt,
            finishedAt: w.tracker.lastAt,
            distanceKm: w.tracker.distanceKm,
            outline: w.tracker.outline,
          },
        ]
      : []),
  ];
  const starts = tracks
    .map((t) => t.startedAt)
    .filter((t): t is string => t !== null)
    .sort();
  const ends = tracks
    .map((t) => t.finishedAt)
    .filter((t): t is string => t !== null)
    .sort();
  const elapsed = minutesBetween(starts[0] ?? null, ends.at(-1) ?? null);
  const overTime =
    elapsed !== null && w.route.maxElapsedMinutes !== null && elapsed > w.route.maxElapsedMinutes;
  // The longest recording, not the sum: overlapping recordings of one ride
  // must not add up (D209).
  const totalKm = tracks.reduce((max, t) => Math.max(max, Number(t.distanceKm)), 0);
  const short = totalKm < Number(w.route.distanceKm);
  const open = w.state === "submitted" || w.state === "in_review";
  const s = suggestions(w);

  return (
    <>
      <PageHeader
        eyebrow={`Ride review · ${w.booking.reference} · version ${w.version}`}
        title={w.booking.customerName}
        description={`${w.route.name} (version ${w.route.revisionNumber})`}
        actions={
          <>
            <Badge tone={open ? "waiting" : w.state === "approved" ? "done" : "neutral"}>
              {SUBMISSION_STATE_LABELS[w.state]}
              {w.claimedBy && open ? ` · ${w.claimedBy}` : ""}
            </Badge>
            {w.state === "submitted" ? <ClaimReviewButton submissionId={w.submissionId} /> : null}
          </>
        }
      />

      <div className="flex flex-col gap-6">
        <p className="text-sm">
          <Link href={`/adventures/bookings/${w.booking.id}`} className="underline">
            Open the booking
          </Link>
        </p>
        {w.booking.needsAttention ? (
          <p role="alert" className="rounded-2xl bg-danger-soft px-4 py-3 text-sm text-danger-deep">
            <strong>Payment needs attention:</strong> {w.booking.attentionReason}. An admin must
            clear the flag on the booking before this ride can be certified.
          </p>
        ) : null}

        <Card title="The ride">
          <div className="flex flex-col gap-4">
            <TrackMap
              label={`Recorded track of ${w.booking.customerName} with ${w.checkpoints.length} checkpoints`}
              tracks={tracks.map((t) => t.outline)}
              checkpoints={w.checkpoints}
            />
            <p className="text-xs text-dust-500">
              Circle: start. Square: finish. Numbered circles: checkpoints at their review radius.
            </p>
            <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
              <dt className="text-dust-700">Recorded distance</dt>
              <dd className={short ? "font-semibold text-danger-deep" : undefined}>
                {formatDistance(totalKm.toFixed(1))} (point to point
                {tracks.length > 1 ? `, longest of ${tracks.length}` : ""}) · route{" "}
                {formatDistance(w.route.distanceKm)}
              </dd>
              <dt className="text-dust-700">Recorded time</dt>
              <dd className={overTime ? "font-semibold text-danger-deep" : undefined}>
                {elapsed !== null ? formatElapsed(elapsed) : "No times"}
                {w.route.maxElapsedMinutes !== null
                  ? ` · limit ${formatElapsed(w.route.maxElapsedMinutes)}`
                  : ""}
              </dd>
              <dt className="text-dust-700">Started</dt>
              <dd>{starts[0] ? formatDateTime(starts[0]) : "Unknown"}</dd>
              <dt className="text-dust-700">Finished</dt>
              <dd>{ends.at(-1) ? formatDateTime(ends.at(-1)!) : "Unknown"}</dd>
            </dl>
          </div>
        </Card>

        {w.tracker ? (
          <Card
            title="Hired tracker"
            actions={
              <CorrectCaptureButton
                attemptId={w.tracker.attemptId}
                startedAt={
                  w.tracker.captureStartedAt ? toShopLocal(w.tracker.captureStartedAt) : ""
                }
                finishedAt={
                  w.tracker.captureFinishedAt ? toShopLocal(w.tracker.captureFinishedAt) : ""
                }
              />
            }
          >
            <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
              <dt className="text-dust-700">Ride window</dt>
              <dd>
                {w.tracker.captureStartedAt
                  ? formatDateTime(w.tracker.captureStartedAt)
                  : "Not started"}
                {" to "}
                {w.tracker.captureFinishedAt
                  ? formatDateTime(w.tracker.captureFinishedAt)
                  : "not finished"}
              </dd>
              <dt className="text-dust-700">Positions</dt>
              <dd>
                {w.tracker.points} · {formatDistance(w.tracker.distanceKm)} (point to point
                {w.tracker.approximate ? ", approximate: points are minutes apart" : ""})
              </dd>
              {w.tracker.latePoints > 0 ? (
                <>
                  <dt className="text-dust-700">After the decision</dt>
                  <dd>
                    {w.tracker.latePoints} more{" "}
                    {w.tracker.latePoints === 1 ? "position" : "positions"} arrived; they are kept
                    with the ride but not counted here.
                  </dd>
                </>
              ) : null}
              <dt className="text-dust-700">First and last</dt>
              <dd>
                {w.tracker.firstAt ? formatDateTime(w.tracker.firstAt) : "None"}
                {w.tracker.lastAt ? ` to ${formatDateTime(w.tracker.lastAt)}` : ""}
              </dd>
            </dl>
          </Card>
        ) : null}

        <Card title="Recordings">
          <ul aria-label="Recordings" className="flex flex-col gap-3 text-sm">
            {activities.map((f) => (
              <li key={f.id} className="flex flex-col gap-1">
                <span className="font-medium break-all">{f.originalName}</span>
                <span className="text-dust-700">
                  {FILE_STATE_LABELS[f.state]}
                  {f.track
                    ? ` · ${f.track.format.toUpperCase()} · ${f.track.pointCount.toLocaleString("en-SG")} points · ${formatDistance(f.track.distanceKm)}${f.track.hasTimes ? "" : " · some points have no time"}`
                    : ""}
                </span>
                {f.parseError ? <span className="text-danger-deep">{f.parseError}</span> : null}
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Checkpoints">
          <ul aria-label="Checkpoints" className="flex flex-col gap-4 text-sm">
            {w.checkpoints.map((c) => {
              const photo = photos.filter((p) => p.checkpointPosition === c.position);
              const within =
                c.nearestM !== null && c.reviewRadiusM !== null
                  ? c.nearestM <= c.reviewRadiusM
                  : null;
              return (
                <li key={c.position} className="flex flex-col gap-2">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">
                      {c.position}. {c.label}
                    </span>
                    {c.mandatory ? <Badge>Mandatory</Badge> : <Badge>Optional</Badge>}
                    {within === true ? <Badge tone="done">Passed within radius</Badge> : null}
                    {within === false ? <Badge tone="danger">Outside radius</Badge> : null}
                  </span>
                  <span className="text-dust-700">
                    {c.latitude === null
                      ? "No coordinates on the route: check it by the photo and the track."
                      : c.nearestM === null
                        ? "No recorded point to compare."
                        : `Nearest recorded point ${formatMetres(c.nearestM)} away${c.nearestAt ? `, ${formatDateTime(c.nearestAt)}` : ""}${c.reviewRadiusM ? ` (radius ${formatMetres(c.reviewRadiusM)})` : ""}.`}
                  </span>
                  {photo.length > 0 ? (
                    <span className="flex flex-wrap gap-2">
                      {photo.map((p) =>
                        p.photoUrl ? (
                          <a key={p.id} href={p.photoUrl} target="_blank" rel="noreferrer">
                            {/* A signed link to a private object; not optimised. */}
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={p.photoUrl}
                              alt={`Photo at ${c.label}`}
                              className="h-32 w-32 rounded-lg border border-hairline object-cover"
                            />
                          </a>
                        ) : (
                          <span key={p.id} className="text-dust-500">
                            {p.originalName}: {FILE_STATE_LABELS[p.state]}
                          </span>
                        ),
                      )}
                    </span>
                  ) : c.photoRequired ? (
                    <span className="font-semibold text-danger-deep">
                      No photo, and one is required.
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </Card>

        <Card title="From the rider">
          <p className="text-sm whitespace-pre-wrap">
            {w.riderStatement.trim() === "" ? "No statement." : w.riderStatement}
          </p>
        </Card>

        {w.route.rules.trim() !== "" ? (
          <Card title="The route's rules">
            <p className="text-sm whitespace-pre-wrap">{w.route.rules}</p>
          </Card>
        ) : null}

        {w.history.length > 0 ? (
          <Card title="Earlier decisions">
            <ol aria-label="Earlier decisions" className="flex flex-col gap-3 text-sm">
              {w.history.map((h) => (
                <li key={`${h.version}-${h.decidedAt}`} className="flex flex-col gap-1">
                  <span className="font-medium">
                    Version {h.version}: {DECISION_LABELS[h.decision]}
                    {h.reviewerName ? ` · ${h.reviewerName}` : ""} · {formatDateTime(h.decidedAt)}
                  </span>
                  {h.messageToRider ? <span>To the rider: {h.messageToRider}</span> : null}
                  {h.internalNote ? (
                    <span className="text-dust-700">Internal: {h.internalNote}</span>
                  ) : null}
                </li>
              ))}
            </ol>
          </Card>
        ) : null}

        {open ? (
          <ReviewDecisionForm
            submissionId={w.submissionId}
            suggestedDistanceKm={s.distance}
            suggestedCompletedOn={s.day}
          />
        ) : null}
      </div>
    </>
  );
}
