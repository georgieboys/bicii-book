import { ButtonLink } from "@/components/ui/button";

/**
 * Below a paged Adventures list: back to the first page once past it, and
 * the next page while there is one, so no row is out of reach.
 */
export function ListPager({
  firstHref,
  firstLabel,
  nextHref,
  nextLabel,
}: {
  /** Set once past the first page. */
  firstHref: string | null;
  firstLabel: string;
  /** Set while more rows follow. */
  nextHref: string | null;
  nextLabel: string;
}) {
  if (!firstHref && !nextHref) return null;
  return (
    <nav aria-label="More of this list" className="mt-4 flex flex-wrap gap-2">
      {firstHref ? (
        <ButtonLink href={firstHref} variant="outline">
          {firstLabel}
        </ButtonLink>
      ) : null}
      {nextHref ? (
        <ButtonLink href={nextHref} variant="outline">
          {nextLabel}
        </ButtonLink>
      ) : null}
    </nav>
  );
}
