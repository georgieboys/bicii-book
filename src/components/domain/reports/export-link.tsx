"use client";

import { buttonClasses } from "@/components/ui/button";
import { useIsFramed } from "@/lib/framed";

/**
 * An "Export CSV" link (SPEC §22, ADR-001 A7). A plain <a>, never
 * next/link: Link prefetches what it shows, and a prefetch here would run
 * the export. target=_blank so the iOS standalone PWA opens the file in
 * Safari's viewer (with Share and Save to Files) instead of replacing the
 * app with it. Inside the Shopify admin's frame (D275) it opens in place:
 * the export is sent as an attachment, so the download starts with the
 * frame's own session, which a new top-level tab would not have (R-136).
 */
export function ExportLink({ href, name }: { href: string; name: string }) {
  const framed = useIsFramed();
  return (
    <a
      href={href}
      target={framed ? undefined : "_blank"}
      rel="noopener"
      aria-label={`Export CSV: ${name}`}
      className={buttonClasses({ variant: "outline", size: "sm" })}
    >
      Export CSV
    </a>
  );
}
