import Link from "next/link";

import { cn } from "@/lib/cn";
import { formatDateTime } from "@/lib/dates";
import type { TimelineEntry } from "@/lib/domain/workshop";
import type { StatusTone } from "@/lib/workshop";

const DOT: Record<StatusTone, string> = {
  info: "bg-indigo",
  waiting: "bg-yellow-deep",
  progress: "bg-sky-deep",
  done: "bg-green-deep",
  danger: "bg-red-deep",
  neutral: "bg-dust-500",
};

/**
 * A job's timeline (SPEC §7.3), newest first: what happened
 * (describeEvent; a title with an `href`, such as the appointment a job
 * was opened from, is a link), who did it ("Recorded outside the app"
 * when nobody in the app did) and when, with any note or reason quoted (the
 * app's own details, such as an amount, are not). It never shows a
 * cost: event payloads carry none. When older events were left out
 * (`truncated`) it says so under the last one, with a link to more when
 * there is one (`moreHref`).
 */
export function Timeline({
  entries,
  truncated = false,
  moreHref = null,
}: {
  entries: TimelineEntry[];
  truncated?: boolean;
  moreHref?: string | null;
}) {
  if (entries.length === 0) return <p className="text-dust-500">Nothing has happened yet.</p>;
  return (
    <div className="flex flex-col gap-3">
      <TimelineList entries={entries} />
      {truncated ? (
        <p role="note" className="text-sm text-dust-700">
          Showing the newest {entries.length.toLocaleString("en-SG")} events. Earlier ones,
          including the check-in, are not shown.{" "}
          {moreHref ? (
            <Link href={moreHref} className="font-medium underline">
              Show earlier events
            </Link>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

function TimelineList({ entries }: { entries: TimelineEntry[] }) {
  return (
    <ol aria-label="Timeline" className="flex flex-col">
      {entries.map((e, i) => (
        <li key={e.id} className="relative flex gap-3 pb-4 last:pb-0">
          <span aria-hidden="true" className="flex flex-col items-center">
            <span className={cn("mt-1.5 size-3 shrink-0 rounded-full", DOT[e.tone])} />
            {i < entries.length - 1 ? <span className="mt-1 w-0.5 flex-1 bg-dust-200" /> : null}
          </span>
          <span className="flex min-w-0 flex-col gap-0.5">
            {e.href ? (
              <Link href={e.href} className="font-medium break-words underline underline-offset-4">
                {e.title}
              </Link>
            ) : (
              <span className="font-medium break-words">{e.title}</span>
            )}
            {e.detail ? (
              <span className="text-sm whitespace-pre-line text-dust-700">
                {e.plain ? e.detail : `“${e.detail}”`}
              </span>
            ) : null}
            <span className="text-sm text-dust-500">
              {e.actorName ?? "Recorded outside the app"}
              {" · "}
              <time dateTime={e.at}>{formatDateTime(e.at)}</time>
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}
