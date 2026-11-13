import Link from "next/link";

import { cn } from "@/lib/cn";

const SECTIONS = [
  { href: "/adventures", label: "Routes" },
  { href: "/adventures/bookings", label: "Bookings" },
  { href: "/adventures/reviews", label: "Reviews" },
  { href: "/adventures/packs", label: "Packs" },
  { href: "/adventures/handovers", label: "Handovers" },
  { href: "/adventures/trackers", label: "Trackers" },
] as const;

export type AdventureSection = (typeof SECTIONS)[number]["href"];

/** Links between the four Adventures lists (D182). */
export function AdventuresSectionNav({ current }: { current: AdventureSection }) {
  return (
    <nav aria-label="Adventures sections" className="-mt-2 mb-6 flex flex-wrap gap-2">
      {SECTIONS.map((s) => (
        <PillLink key={s.href} href={s.href} active={s.href === current}>
          {s.label}
        </PillLink>
      ))}
    </nav>
  );
}

/** A 48px link styled as a chip; the current one is filled. */
export function PillLink({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "inline-flex min-h-12 items-center rounded-full border-2 px-4 text-sm font-semibold transition-colors",
        active ? "border-ink bg-ink text-paper" : "border-hairline bg-card hover:border-ink",
      )}
    >
      {children}
    </Link>
  );
}
