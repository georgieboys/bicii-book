import Link from "next/link";
import type { ReactNode } from "react";

import { ShortId } from "@/components/domain/short-id";
import { EmptyState } from "@/components/ui/empty-state";
import { CheckIcon } from "@/components/ui/icons";
import { RowLink, RowList } from "@/components/ui/row-list";
import { StatusPill } from "@/components/ui/status-pill";
import { formatDate, formatDateTime, shopDaysBetween } from "@/lib/dates";
import { isShortId } from "@/lib/ids";
import {
  exceptionCopy,
  exceptionHref,
  exceptionKeys,
  exceptionLabel,
  exceptionsShownNote,
  exceptionSubjectIsSentence,
  type OperationalException,
} from "@/lib/reports";

/** A secondary link under a row (Phase 9: "Open stock reconciliation"). */
export type ExceptionRowAction = { href: string; label: string };

/**
 * Operational exceptions (server; D34), danger first as the database
 * orders them: a pill (tone and words), the record's short ID and subject,
 * and what is wrong in a sentence. A row opens its record when this build
 * has a page for it; an unknown kind from a later phase still renders.
 * `total` is the full count: when the list is capped below it, a line says
 * how many of how many are shown (most urgent first, as the database
 * orders them); with `moreHref` that line links to the full list.
 *
 * Phase 9 (/reports/exceptions) reuses it with optional props, and Today
 * renders exactly as before without them:
 *   * `detailed`: the pill says how serious ("Critical" or "Needs
 *     attention") because the page's section heading names the kind; the
 *     row adds the record's title, the database's detail when it says more
 *     than the subject, and how long ago it started ("45 days", the date on
 *     hover and from md up);
 *   * `action(row)`: a secondary link under the row;
 *   * `label`: the list's accessible name;
 *   * `empty`: what to show when there are no rows.
 */
export function ExceptionList({
  rows,
  total = rows.length,
  moreHref,
  detailed = false,
  action,
  label = "Needs attention",
  empty,
}: {
  rows: readonly OperationalException[];
  total?: number;
  moreHref?: string;
  detailed?: boolean;
  action?: (row: OperationalException) => ExceptionRowAction | null;
  label?: string;
  empty?: ReactNode;
}) {
  if (rows.length === 0) {
    return (
      empty ?? (
        <EmptyState
          icon={<CheckIcon className="size-6" />}
          title="Nothing needs attention"
          description="No overdue or uncollected jobs, no stock below zero and no stale holds."
        />
      )
    );
  }
  const keys = exceptionKeys(rows);
  const shown = exceptionsShownNote(rows.length, total);
  const list = (
    <RowList label={label}>
      {rows.map((r, i) => {
        const { text, tone } = exceptionCopy(r.kind, r);
        const href = exceptionHref(r);
        const body = detailed ? (
          <DetailedBody row={r} text={text} tone={tone} />
        ) : (
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill status={tone}>{exceptionLabel(r.kind)}</StatusPill>
              {r.entityLabel ? (
                isShortId(r.entityLabel) ? (
                  <ShortId value={r.entityLabel} />
                ) : (
                  <span className="font-medium">{r.entityLabel}</span>
                )
              ) : null}
            </div>
            {r.subjectLabel ? <SubjectLine kind={r.kind} text={r.subjectLabel} /> : null}
            <p className="text-sm text-dust-700">{text}</p>
          </div>
        );
        const key = keys[i];
        const extra = action?.(r);
        const after = extra ? (
          <div className="px-4 pb-3">
            <Link
              href={extra.href}
              className="inline-flex min-h-tap items-center text-sm font-semibold underline"
            >
              {extra.label}
            </Link>
          </div>
        ) : undefined;
        return href ? (
          <RowLink key={key} href={href} after={after}>
            {body}
          </RowLink>
        ) : after ? (
          <li key={key}>
            <div className="flex min-h-16 items-center gap-4 px-4 py-3">{body}</div>
            {after}
          </li>
        ) : (
          <li key={key} className="flex min-h-16 items-center gap-4 px-4 py-3">
            {body}
          </li>
        );
      })}
    </RowList>
  );
  if (!shown) return list;
  return (
    <div className="flex flex-col gap-2">
      {list}
      {moreHref ? (
        <Link
          href={moreHref}
          className="inline-flex min-h-tap items-center self-start text-sm text-dust-500 tabular-nums underline"
        >
          {shown}
        </Link>
      ) : (
        <p className="text-sm text-dust-500 tabular-nums">{shown}</p>
      )}
    </div>
  );
}

/**
 * The row's subject: one truncated line (a name or a place), except for the
 * kinds whose subject is the actionable sentence (customer payments and
 * Stripe deliveries), which wrap so the whole sentence shows on a phone.
 */
function SubjectLine({ kind, text }: { kind: string; text: string }) {
  return exceptionSubjectIsSentence(kind) ? (
    <p className="text-sm break-words">{text}</p>
  ) : (
    <p className="truncate text-sm">{text}</p>
  );
}

/** The /reports/exceptions row: severity, short ID and title, the sentence, the detail and the age. */
function DetailedBody({
  row,
  text,
  tone,
}: {
  row: OperationalException;
  text: string;
  tone: ReturnType<typeof exceptionCopy>["tone"];
}) {
  const shortId = row.shortId ?? row.entityLabel;
  // "C-000012 · consignor" → "consignor": the short ID is already its own chip.
  const title =
    row.title && shortId && row.title.startsWith(`${shortId} · `)
      ? row.title.slice(shortId.length + 3)
      : row.title && row.title !== shortId
        ? row.title
        : null;
  const detail = row.detail && row.detail !== row.subjectLabel ? row.detail : null;
  const age = row.days ?? (row.since ? Math.max(0, shopDaysBetween(row.since, new Date())) : null);
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill status={tone === "danger" ? "danger" : "waiting"}>
          {tone === "danger" ? "Critical" : "Needs attention"}
        </StatusPill>
        {shortId ? (
          isShortId(shortId) ? (
            <ShortId value={shortId} />
          ) : (
            <span className="font-medium">{shortId}</span>
          )
        ) : null}
        {title ? <span className="font-medium">{title}</span> : null}
      </div>
      {row.subjectLabel ? <SubjectLine kind={row.kind} text={row.subjectLabel} /> : null}
      <p className="text-sm text-dust-700">{text}</p>
      {detail ? <p className="text-sm text-dust-500">{detail}</p> : null}
      {row.since && age !== null ? (
        <p className="text-sm text-dust-500 tabular-nums">
          <time dateTime={row.since} title={formatDateTime(row.since)}>
            {age === 1 ? "1 day" : `${age} days`}
          </time>
          <span className="hidden md:inline"> · since {formatDate(row.since)}</span>
        </p>
      ) : null}
    </div>
  );
}
