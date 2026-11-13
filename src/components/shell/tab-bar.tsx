"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/cn";

import { LinkPending } from "./link-pending";
import { TABS, isItemActive, isMoreActive } from "./nav";

/**
 * Phone navigation: fixed to the bottom, clear of the iPhone home indicator
 * (safe-area inset), with Scan raised in the middle as the primary action
 * (SPEC §22: camera and scan actions prominent). Hidden from md up, where
 * the side rail takes over.
 */
export function TabBar() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-hairline bg-paper pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <ul className="mx-auto grid max-w-lg grid-cols-5 items-end px-[max(0.25rem,env(safe-area-inset-left))]">
        {TABS.map((tab) => {
          const active =
            tab.href === "/more" ? isMoreActive(pathname) : isItemActive(pathname, tab);
          const Icon = tab.icon;
          if (tab.href === "/scan") {
            return (
              <li key={tab.href} className="flex justify-center">
                <Link
                  href={tab.href}
                  aria-current={active ? "page" : undefined}
                  className="-mt-5 flex flex-col items-center gap-1 pb-2"
                >
                  <LinkPending
                    className={cn(
                      "flex size-16 items-center justify-center rounded-full border-4 border-paper bg-yellow text-ink shadow-[0_6px_16px_-6px_rgb(5_7_7/0.45)]",
                      "transition-transform duration-200 ease-[var(--ease-spring)] active:scale-[0.92] motion-reduce:active:scale-100",
                    )}
                    pendingClassName="animate-pulse"
                  >
                    <Icon className="size-7" />
                  </LinkPending>
                  <span className="font-display text-[0.6875rem] font-bold tracking-wide uppercase">
                    {tab.label}
                  </span>
                </Link>
              </li>
            );
          }
          return (
            <li key={tab.href}>
              <Link
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-h-16 flex-col items-center justify-center gap-1 pt-2 pb-2",
                  active ? "text-ink" : "text-dust-500 hover:text-ink",
                )}
              >
                <LinkPending
                  className={cn(
                    "flex h-7 w-12 items-center justify-center rounded-full transition-colors",
                    active && "bg-ink text-paper",
                  )}
                  pendingClassName="animate-pulse bg-dust-200 text-ink"
                >
                  <Icon className="size-5" />
                </LinkPending>
                <span className="font-display text-[0.6875rem] font-bold tracking-wide uppercase">
                  {tab.label}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
