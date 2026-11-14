import { CappedNote } from "@/components/domain/adventures/capped-note";
import type { Metadata } from "next";

import { AdventuresSectionNav } from "@/components/domain/adventures/section-nav";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { ChevronRightIcon, RouteIcon } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/page-header";
import { RowLink, RowList } from "@/components/ui/row-list";
import { canVerifyAdventures, SUBMISSION_STATE_LABELS } from "@/lib/adventures";
import { requireStaff } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/dates";
import { listReviewQueue } from "@/lib/domain/adventure-bookings";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Ride reviews" };

/**
 * The certification queue (D178, D182): versions riders have sent,
 * oldest first, with who has taken each. Anyone can see the queue; only
 * staff with verify_adventures open the evidence and decide.
 */
export default async function AdventureReviewsPage() {
  const staff = await requireStaff();
  const verify = canVerifyAdventures(staff);
  const queue = await listReviewQueue(await createClient());

  return (
    <>
      <PageHeader title="Adventures" description="Rides waiting for certification." />
      <CappedNote count={queue.length} cap={200} what="rides" />
      <AdventuresSectionNav current="/adventures/reviews" />
      {!verify ? (
        <p className="mb-4 rounded-xl bg-waiting-soft px-3 py-2 text-sm text-waiting-deep">
          Reviewing rides needs the Verify adventures permission. Ask an admin.
        </p>
      ) : null}
      {queue.length === 0 ? (
        <EmptyState
          icon={<RouteIcon />}
          title="Nothing to review"
          description="Rides appear here when a rider requests certification."
        />
      ) : (
        <RowList label="Rides waiting for review">
          {queue.map((q) => {
            const body = (
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium break-words">{q.customerName}</span>
                  <span className="text-sm text-dust-500 tabular-nums">{q.reference}</span>
                </span>
                <span className="text-sm text-dust-700">
                  {q.routeName} · version {q.version}
                  {q.submittedAt ? ` · sent ${formatDateTime(q.submittedAt)}` : ""}
                </span>
                <span className="flex flex-wrap items-center gap-2">
                  <Badge tone={q.state === "in_review" ? "progress" : "waiting"}>
                    {SUBMISSION_STATE_LABELS[q.state]}
                    {q.claimedBy ? ` · ${q.claimedBy}` : ""}
                  </Badge>
                  {q.needsAttention ? <Badge tone="danger">Payment needs attention</Badge> : null}
                </span>
              </span>
            );
            return verify ? (
              <RowLink key={q.submissionId} href={`/adventures/reviews/${q.submissionId}`}>
                {body}
                <ChevronRightIcon className="size-5 shrink-0 text-dust-500" />
              </RowLink>
            ) : (
              <li key={q.submissionId} className="flex min-h-16 items-center px-4 py-3 sm:px-5">
                {body}
              </li>
            );
          })}
        </RowList>
      )}
    </>
  );
}
