import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { ChevronRightIcon, CloseIcon } from "@/components/ui/icons";
import { RowLink } from "@/components/ui/row-list";
import { StatusPill } from "@/components/ui/status-pill";
import { cn } from "@/lib/cn";
import { shopDaysBetween } from "@/lib/dates";
import type { BoardJob } from "@/lib/domain/workshop";
import { STATUS_LABELS, formatAge, isOverdue, statusTone } from "@/lib/workshop";

import { ShortId } from "./short-id";

/**
 * Pieces of the workshop board (/jobs, SPEC §7.2). Server Components: the
 * filters are links, so the board works before hydration and every view
 * is a shareable URL.
 */

export type LinkOption = {
  key: string;
  text: string;
  href: string;
  current: boolean;
  count?: number;
};

/**
 * A one-of-few choice as links (the board's All / My jobs / Unassigned),
 * styled like SegmentedControl; the current one has aria-current.
 */
export function LinkSegments({ label, options }: { label: string; options: LinkOption[] }) {
  return (
    <nav aria-label={label} className="max-w-full">
      <ul className="inline-flex max-w-full [scrollbar-width:none] gap-1 overflow-x-auto rounded-full border-2 border-ink bg-card p-1">
        {options.map((o) => (
          <li key={o.key} className="shrink-0">
            <Link
              href={o.href}
              replace
              scroll={false}
              aria-current={o.current ? "page" : undefined}
              className={cn(
                "inline-flex min-h-tap items-center rounded-full px-4 font-display text-xs font-bold tracking-wide whitespace-nowrap uppercase focus-inset transition-colors",
                o.current ? "bg-ink text-paper" : "text-ink hover:bg-dust-100",
              )}
            >
              {o.text}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * The board's groups as a horizontally scrolling row of chips, each with
 * its count (SPEC §7.2: Received, Waiting, Ready, In progress, Completed,
 * Ready for collection, plus Closed). Wraps on a phone too, so every group,
 * Closed included, is in view without a hidden sideways scroll (U1-8).
 */
export function GroupChips({ label, options }: { label: string; options: LinkOption[] }) {
  return (
    <nav aria-label={label}>
      <ul className="flex flex-wrap gap-2 py-1">
        {options.map((o) => (
          <li key={o.key} className="shrink-0">
            <Link
              href={o.href}
              replace
              scroll={false}
              aria-current={o.current ? "page" : undefined}
              className={cn(
                "inline-flex min-h-tap items-center gap-2 rounded-full border-2 px-4 text-sm font-semibold whitespace-nowrap transition-colors",
                o.current
                  ? "border-ink bg-ink text-paper"
                  : "border-hairline bg-card text-ink hover:border-ink",
              )}
            >
              {o.text}
              {o.count !== undefined ? (
                <span
                  className={cn(
                    "rounded-full px-2 text-xs tabular-nums",
                    o.current ? "bg-paper/20" : "bg-dust-100",
                  )}
                >
                  {o.count}
                </span>
              ) : null}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** The active filters as removable chips, and "Clear" to drop them all. */
export function ActiveFilterChips({
  chips,
  clearHref,
}: {
  chips: { key: string; text: string; removeHref: string }[];
  clearHref: string;
}) {
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ul aria-label="Active filters" className="flex flex-wrap gap-2">
        {chips.map((c) => (
          <li key={c.key}>
            <Link
              href={c.removeHref}
              replace
              scroll={false}
              aria-label={`Remove filter: ${c.text}`}
              className="inline-flex min-h-tap items-center gap-1.5 rounded-full bg-info-soft py-1 pr-3 pl-4 text-sm font-medium text-info-deep hover:bg-info-soft/70"
            >
              {c.text}
              <CloseIcon aria-hidden="true" className="size-4" />
            </Link>
          </li>
        ))}
      </ul>
      <Link
        href={clearHref}
        replace
        scroll={false}
        className="inline-flex min-h-tap items-center px-2 text-sm font-semibold underline underline-offset-4"
      >
        Clear
      </Link>
    </div>
  );
}

/**
 * One job on the board: the whole row opens it. J- number, status (text
 * and tone), bike, customer, lead or "Unassigned", age, and Overdue (D20)
 * as a red badge with its word. Never any money.
 */
export function JobRow({ job, now }: { job: BoardJob; now: Date }) {
  const overdue = isOverdue(job, now);
  return (
    <RowLink href={`/jobs/${job.id}`}>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-2">
          <ShortId value={job.jobNumber} />
          <StatusPill status={statusTone(job.status)}>{STATUS_LABELS[job.status]}</StatusPill>
          {overdue ? (
            <Badge tone="danger" emphasis="solid">
              Overdue
            </Badge>
          ) : null}
        </span>
        <span className="truncate font-medium">{job.bikeTitle}</span>
        <span className="flex flex-wrap gap-x-2 text-sm text-dust-500">
          <span className="truncate">{job.customerLabel}</span>
          <span aria-hidden="true">·</span>
          <span className={job.leadName ? undefined : "font-medium text-waiting-deep"}>
            {job.leadName ?? "Unassigned"}
          </span>
          <span aria-hidden="true">·</span>
          <span>
            <span className="sr-only">Age </span>
            {formatAge(shopDaysBetween(job.checkedInAt, now))}
          </span>
        </span>
      </span>
      <ChevronRightIcon className="size-5 shrink-0 text-dust-500" />
    </RowLink>
  );
}
