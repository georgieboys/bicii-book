import Link from "next/link";

import { ShortId } from "@/components/domain/short-id";
import { EmptyState } from "@/components/ui/empty-state";
import { CheckIcon } from "@/components/ui/icons";
import { RowLink, RowList } from "@/components/ui/row-list";
import { StatusPill } from "@/components/ui/status-pill";
import { formatDate, formatDateTime } from "@/lib/dates";
import {
  dispositionLabel,
  issueSentence,
  unitStatusLabel,
  type StockReconciliationRow,
  type UnitReconciliationRow,
} from "@/lib/reconciliation";
import { plural } from "@/lib/plural";

/**
 * The server-rendered parts of /reports/reconciliation (Phase 9 step 4;
 * SPEC §12, §26; PLAN D106; DESIGN "Reconciliation"): rows on phones and a
 * dense table from md up, each row opening its product or unit. Read only:
 * for adjust_stock holders an issue row links to the product page, where
 * Adjust stock (a reason, a movement) is the guarded fix; nothing here
 * changes anything.
 */

const FIX_LABEL = "Fix with a stock adjustment";

function IssuePill({ issue }: { issue: string | null }) {
  return issue ? (
    <StatusPill status="danger">Problem</StatusPill>
  ) : (
    <StatusPill status="done">Reconciles</StatusPill>
  );
}

const sentence = (issue: string | null, fallback?: string | null) =>
  issue ? (issueSentence(issue) ?? fallback ?? issue) : null;

function FixLink({ href, name }: { href: string; name: string }) {
  return (
    <Link
      href={href}
      aria-label={`${FIX_LABEL}: ${name}`}
      className="inline-flex min-h-tap items-center text-sm font-semibold underline"
    >
      {FIX_LABEL}
    </Link>
  );
}

const onHand = (n: number | null) => (n === null ? "—" : n < 0 ? `−${Math.abs(n)}` : String(n));

/** Products by location (report_stock_reconciliation). */
export function StockReconciliationList({
  rows,
  canAdjust,
  caption,
  empty,
}: {
  rows: readonly StockReconciliationRow[];
  canAdjust: boolean;
  caption: string;
  empty: string;
}) {
  if (rows.length === 0) {
    return <EmptyState tone="done" icon={<CheckIcon className="size-6" />} title={empty} />;
  }
  const key = (r: StockReconciliationRow) => `${r.productId}:${r.locationId}`;
  return (
    <>
      <RowList label={caption} className="md:hidden">
        {rows.map((r) => (
          <RowLink
            key={key(r)}
            href={r.href}
            after={
              r.issue && canAdjust ? (
                <div className="px-4 pb-3">
                  <FixLink href={r.href} name={r.productName} />
                </div>
              ) : undefined
            }
          >
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="flex flex-wrap items-center gap-2">
                <IssuePill issue={r.issue} />
                <ShortId value={r.productShortId} />
                <span className="truncate font-semibold">{r.productName}</span>
              </span>
              <span className="text-sm tabular-nums">
                {r.locationName} · ledger {onHand(r.ledgerOnHand)}
                {r.unitsInStock !== null
                  ? ` · ${plural(r.unitsInStock, "item", "items")} in stock`
                  : ""}
              </span>
              {r.issue ? <span className="text-sm text-dust-700">{sentence(r.issue)}</span> : null}
            </span>
          </RowLink>
        ))}
      </RowList>
      <div className="hidden max-h-[70dvh] overflow-auto rounded-2xl border border-hairline bg-card md:block">
        <table className="w-full text-sm tabular-nums [&_thead_th]:whitespace-nowrap">
          <caption className="sr-only">{caption}</caption>
          <thead className="sticky top-0 bg-card text-left">
            <tr className="border-b border-hairline">
              <th scope="col" className="px-3 py-2 font-semibold">
                Product
              </th>
              <th scope="col" className="px-3 py-2 font-semibold">
                Location
              </th>
              <th scope="col" className="px-3 py-2 text-right font-semibold">
                Ledger on hand
              </th>
              <th scope="col" className="px-3 py-2 text-right font-semibold">
                Items in stock
              </th>
              <th scope="col" className="px-3 py-2 font-semibold">
                Issue
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-hairline">
            {rows.map((r) => (
              <tr key={key(r)}>
                <th scope="row" className="min-w-56 px-3 py-2 text-left font-normal">
                  <Link
                    href={r.href}
                    className="inline-flex min-h-tap flex-wrap items-center gap-2 underline-offset-2 hover:underline"
                  >
                    <ShortId value={r.productShortId} />
                    <span className="font-semibold">{r.productName}</span>
                  </Link>
                </th>
                <td className="px-3 py-2 whitespace-nowrap">{r.locationName}</td>
                <td
                  className={
                    r.ledgerOnHand < 0
                      ? "px-3 py-2 text-right font-semibold text-danger-deep"
                      : "px-3 py-2 text-right"
                  }
                >
                  {onHand(r.ledgerOnHand)}
                </td>
                <td className="px-3 py-2 text-right">{onHand(r.unitsInStock)}</td>
                <td className="min-w-64 px-3 py-2">
                  {r.issue ? (
                    <span className="flex flex-col gap-1">
                      <span>{sentence(r.issue)}</span>
                      {canAdjust ? <FixLink href={r.href} name={r.productName} /> : null}
                    </span>
                  ) : (
                    <span className="text-dust-500">Reconciles</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function LastMoved({ at }: { at: string | null }) {
  if (!at) return <span className="text-dust-500">No movement</span>;
  return (
    <time dateTime={at} title={formatDateTime(at)}>
      {formatDate(at)}
    </time>
  );
}

const ledgerSays = (r: UnitReconciliationRow) =>
  r.ledgerLocationName ? `ledger says ${r.ledgerLocationName}` : "ledger says nowhere";

/** Unique items (report_unit_reconciliation). */
export function UnitReconciliationList({
  rows,
  canAdjust,
  caption,
  empty,
}: {
  rows: readonly UnitReconciliationRow[];
  canAdjust: boolean;
  caption: string;
  empty: string;
}) {
  if (rows.length === 0) {
    return <EmptyState tone="done" icon={<CheckIcon className="size-6" />} title={empty} />;
  }
  return (
    <>
      <RowList label={caption} className="md:hidden">
        {rows.map((r) => (
          <RowLink
            key={r.unitId}
            href={r.href}
            after={
              r.issue && canAdjust ? (
                <div className="px-4 pb-3">
                  <FixLink href={r.productHref} name={r.unitShortId} />
                </div>
              ) : undefined
            }
          >
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="flex flex-wrap items-center gap-2">
                <IssuePill issue={r.issue} />
                <ShortId value={r.unitShortId} />
                <span className="truncate font-semibold">{r.productName}</span>
              </span>
              <span className="text-sm">
                {unitStatusLabel(r.status)} · {r.locationName} ({ledgerSays(r)})
              </span>
              <span className="text-sm text-dust-700 tabular-nums">
                {dispositionLabel(r.disposition, r.dispositionRef)} · ledger on hand{" "}
                {onHand(r.ledgerOnHand)}, expected {onHand(r.expectedOnHand)}
              </span>
              {r.issue ? (
                <span className="text-sm text-dust-700">{sentence(r.issue, r.issueDetail)}</span>
              ) : null}
              <span className="text-sm text-dust-500">
                Last moved <LastMoved at={r.lastMovementAt} />
              </span>
            </span>
          </RowLink>
        ))}
      </RowList>
      <div className="hidden max-h-[70dvh] overflow-auto rounded-2xl border border-hairline bg-card md:block">
        <table className="w-full text-sm tabular-nums [&_thead_th]:whitespace-nowrap">
          <caption className="sr-only">{caption}</caption>
          <thead className="sticky top-0 bg-card text-left">
            <tr className="border-b border-hairline">
              <th scope="col" className="px-3 py-2 font-semibold">
                Item
              </th>
              <th scope="col" className="px-3 py-2 font-semibold">
                Status
              </th>
              <th scope="col" className="px-3 py-2 font-semibold">
                Location
              </th>
              <th scope="col" className="px-3 py-2 font-semibold">
                Ledger says
              </th>
              <th scope="col" className="px-3 py-2 text-right font-semibold">
                On hand
              </th>
              <th scope="col" className="px-3 py-2 font-semibold">
                Issue
              </th>
              <th scope="col" className="px-3 py-2 font-semibold">
                Last moved
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-hairline">
            {rows.map((r) => (
              <tr key={r.unitId}>
                <th scope="row" className="min-w-48 px-3 py-2 text-left font-normal">
                  <Link
                    href={r.href}
                    className="inline-flex min-h-tap flex-col justify-center gap-1 underline-offset-2 hover:underline"
                  >
                    <ShortId value={r.unitShortId} />
                    <span className="font-semibold">{r.productName}</span>
                  </Link>
                </th>
                <td className="px-3 py-2 whitespace-nowrap">{unitStatusLabel(r.status)}</td>
                <td className="px-3 py-2 whitespace-nowrap">{r.locationName}</td>
                <td className="px-3 py-2">
                  <span className="flex flex-col">
                    <span>{dispositionLabel(r.disposition, r.dispositionRef)}</span>
                    <span className="text-dust-500">{r.ledgerLocationName ?? "Nowhere"}</span>
                  </span>
                </td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  {onHand(r.ledgerOnHand)}
                  <span className="text-dust-500"> / expected {onHand(r.expectedOnHand)}</span>
                </td>
                <td className="min-w-64 px-3 py-2">
                  {r.issue ? (
                    <span className="flex flex-col gap-1">
                      <span>{sentence(r.issue, r.issueDetail)}</span>
                      {r.issueDetail ? (
                        <span className="text-dust-500">{r.issueDetail}</span>
                      ) : null}
                      {canAdjust ? <FixLink href={r.productHref} name={r.unitShortId} /> : null}
                    </span>
                  ) : (
                    <span className="text-dust-500">Reconciles</span>
                  )}
                </td>
                <td className="px-3 py-2 whitespace-nowrap">
                  <LastMoved at={r.lastMovementAt} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
