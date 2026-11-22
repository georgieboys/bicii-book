import { ButtonLink } from "@/components/ui/button";

/** Which rows a page shows: "31 to 60 of 132". */
export function pageRange(page: number, perPage: number, shown: number, total: number): string {
  if (shown === 0) return `0 of ${total}`;
  const from = (page - 1) * perPage + 1;
  return `${from} to ${from + shown - 1} of ${total}`;
}

/**
 * Previous and Next under a paged list, with where the page sits in the
 * whole ("31 to 60 of 132"). Nothing when everything fits on one page.
 */
export function PageNav({
  label,
  summary,
  previousHref,
  nextHref,
}: {
  /** What the list holds, for the nav's accessible name ("Products"). */
  label: string;
  summary: string;
  previousHref: string | null;
  nextHref: string | null;
}) {
  if (!previousHref && !nextHref) return null;
  return (
    <nav
      aria-label={`${label}: pages`}
      className="mt-2 flex flex-wrap items-center justify-between gap-3"
    >
      <p className="text-sm text-dust-700 tabular-nums">{summary}</p>
      <div className="flex gap-2">
        {previousHref ? (
          <ButtonLink href={previousHref} variant="outline" size="sm">
            Previous
          </ButtonLink>
        ) : null}
        {nextHref ? (
          <ButtonLink href={nextHref} variant="outline" size="sm">
            Next
          </ButtonLink>
        ) : null}
      </div>
    </nav>
  );
}
