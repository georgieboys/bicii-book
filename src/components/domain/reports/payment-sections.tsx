import Link from "next/link";

import { lineDate } from "@/components/domain/reports/report-sections";
import { MoneyTile } from "@/components/domain/today/stat-tile";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { RowLink, RowList } from "@/components/ui/row-list";
import { cn } from "@/lib/cn";
import { formatMoney } from "@/lib/money";
import {
  COUNTER_RECORDED_NOTE,
  HELD_BASIS_NOTE,
  HELD_GROUP_COPY,
  PAYMENTS_NOT_SALES_NOTE,
  heldGroups,
  heldJobDetail,
  isOutgoing,
  movementLabel,
  otherCurrencyNote,
  paymentKindLabel,
  paymentMethodLabel,
  type HeldJob,
  type HeldList,
  type PaymentItem,
  type PaymentSummary,
} from "@/lib/payment-reports";
import { formatSignedMoney } from "@/lib/reports";

/**
 * The server-rendered Customer payments parts of /reports and
 * /reports/payments (Phase 14 step 3; PLAN D154a–e; DESIGN "Reports").
 * Every amount arrives as a fixed-2 string computed by Postgres; the only
 * sum made here is each held list's display total (`heldGroups`, see
 * src/lib/payment-reports.ts). Nothing is cost-derived (D154d), so there
 * is no view_costs layout.
 */

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The period's customer money (report_payment_summary): taken online,
 * refunded online, recorded at the counter, given back at the counter and
 * the net, each with its count; then the notes that say these are not
 * sales and what "Recorded at the counter" means (D154a, D154d).
 */
export function PaymentSummaryFigures({ summary }: { summary: PaymentSummary }) {
  const s = summary;
  const c = s.currency;
  const other = otherCurrencyNote(s.otherCurrencyCount);
  return (
    <div className="flex flex-col gap-2">
      <div
        role="group"
        aria-label="Customer payment figures"
        className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5"
      >
        <MoneyTile
          label="Taken online"
          amount={s.onlineTotal}
          currency={c}
          hint={
            <>
              {plural(s.onlineCount, "payment", "payments")}
              {s.onlineCount > 0 ? (
                <>
                  <br />
                  Deposits {formatMoney(s.depositOnlineTotal, c)} · balances{" "}
                  {formatMoney(s.balanceOnlineTotal, c)}
                </>
              ) : null}
            </>
          }
        />
        <MoneyTile
          label="Refunded online"
          amount={s.refundTotal}
          currency={c}
          hint={plural(s.refundCount, "refund", "refunds")}
        />
        <MoneyTile
          label="Recorded at the counter"
          amount={s.counterTotal}
          currency={c}
          hint={plural(s.counterCount, "payment", "payments")}
        />
        <MoneyTile
          label="Given back at the counter"
          amount={s.givenBackTotal}
          currency={c}
          hint={plural(s.givenBackCount, "payment", "payments")}
        />
        <MoneyTile
          label="Net taken"
          amount={s.netTotal}
          currency={c}
          className="col-span-2 md:col-span-1"
          hint="Taken less refunded and given back"
        />
      </div>
      <p role="note" className="text-sm text-dust-700">
        {PAYMENTS_NOT_SALES_NOTE}
      </p>
      <p role="note" className="text-sm text-dust-700">
        {COUNTER_RECORDED_NOTE}
      </p>
      {other ? (
        <p role="note" className="text-sm font-medium text-waiting-deep">
          {other}{" "}
          <Link href="/reports/exceptions" className="inline-flex min-h-tap items-center underline">
            See exceptions
          </Link>
        </p>
      ) : null}
    </div>
  );
}

/**
 * "Held on jobs now" (report_payments_held, D154c): the basis sentence,
 * then three lists, each with its own total and no grand total: paid on
 * open jobs, paid on jobs awaiting collection (with still to pay), paid
 * above the bill. A row opens its job.
 */
export function HeldOnJobs({ rows }: { rows: readonly HeldJob[] }) {
  const lists = heldGroups(rows);
  return (
    <div className="flex flex-col gap-4">
      <p role="note" className="text-sm text-dust-700">
        {HELD_BASIS_NOTE}
      </p>
      {lists.map((list) => (
        <HeldListView key={list.group} list={list} />
      ))}
    </div>
  );
}

function HeldListView({ list }: { list: HeldList }) {
  const copy = HELD_GROUP_COPY[list.group];
  const id = `held-${list.group}`;
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h4 id={id} className="font-display text-base font-bold">
          {copy.title}
        </h4>
        <p className="text-sm tabular-nums">
          <span className="font-semibold">
            Total {formatSignedMoney(list.total, list.currency)}
          </span>
          <span className="text-dust-500"> · {plural(list.rows.length, "job", "jobs")}</span>
        </p>
      </div>
      <p className="text-sm text-dust-500">{copy.description}</p>
      {list.rows.length === 0 ? (
        <p className="rounded-2xl border border-hairline bg-card px-4 py-3 text-sm text-dust-500">
          {copy.empty}
        </p>
      ) : (
        <RowList label={copy.title}>
          {list.rows.map((r) => (
            <RowLink key={r.workOrderId} href={r.jobHref}>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate">
                    <span className="font-semibold">{r.jobNumber}</span>
                    {r.customerLabel ? (
                      <span className="text-dust-700"> · {r.customerLabel}</span>
                    ) : null}
                  </span>
                  <span className="shrink-0 font-semibold tabular-nums">
                    {formatSignedMoney(r.amount, r.currency)}
                  </span>
                </span>
                <span className="text-sm text-dust-500 tabular-nums">{heldJobDetail(r)}</span>
              </span>
            </RowLink>
          ))}
        </RowList>
      )}
    </section>
  );
}

/** A movement's date as a shop-local day and time ("Mon, 5 Oct 2026 14:05"). */
export function paymentDate(at: string): string {
  return lineDate({ basisAt: at });
}

/** "Recorded Mon, 5 Oct 2026 14:05 by Alex" for a counter row; null for Stripe's. */
export function recordedLine(
  item: Pick<PaymentItem, "recordedAt" | "recordedByName">,
): string | null {
  if (!item.recordedAt) return null;
  const by = item.recordedByName ? ` by ${item.recordedByName}` : "";
  return `Recorded ${paymentDate(item.recordedAt)}${by}`;
}

function JobLink({ item }: { item: PaymentItem }) {
  return (
    <Link href={item.jobHref} className="font-semibold underline-offset-2 hover:underline">
      {item.jobNumber}
    </Link>
  );
}

function OtherCurrencyBadge({ item }: { item: PaymentItem }) {
  return item.otherCurrency ? (
    <Badge tone="waiting" className="ml-2">
      Other currency
    </Badge>
  ) : null;
}

/** The empty list for a period with no customer money. */
export function PaymentsEmpty() {
  return (
    <EmptyState
      title="No customer money moved in this period."
      description="Payments, refunds and counter payments show on the day they moved."
    />
  );
}

/**
 * Phones and tablets: one row per movement. Below `lg` the table's eight
 * columns would scroll inside their box and hide the amount on an iPad.
 */
export function PaymentItemList({ items }: { items: readonly PaymentItem[] }) {
  return (
    <ul
      aria-label="Payments"
      className="divide-y divide-hairline rounded-2xl border border-hairline bg-card lg:hidden"
    >
      {items.map((p) => {
        const recorded = recordedLine(p);
        return (
          <li key={`${p.movement}:${p.id}`} className="flex flex-col gap-0.5 px-4 py-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate font-semibold">
                {movementLabel(p.movement)}
                <OtherCurrencyBadge item={p} />
              </span>
              <span
                className={cn(
                  "shrink-0 font-semibold tabular-nums",
                  isOutgoing(p.movement) && "text-dust-700",
                )}
              >
                {formatSignedMoney(p.signedAmount, p.currency)}
              </span>
            </div>
            <div className="text-sm text-dust-500">
              <JobLink item={p} />
              {p.customerLabel ? ` · ${p.customerLabel}` : null} · {paymentDate(p.at)}
            </div>
            <div className="text-sm text-dust-700">
              {paymentKindLabel(p.movement, p.kind)} · {paymentMethodLabel(p.method)}
            </div>
            {recorded ? <div className="text-sm text-dust-500">{recorded}</div> : null}
          </li>
        );
      })}
    </ul>
  );
}

/** lg and up: a dense table, the amount beside the movement. */
export function PaymentItemTable({
  items,
  caption,
}: {
  items: readonly PaymentItem[];
  caption: string;
}) {
  const th = "px-3 py-2 font-semibold";
  return (
    <div className="hidden max-h-[75dvh] overflow-auto rounded-2xl border border-hairline bg-card lg:block">
      <table className="w-full text-sm tabular-nums [&_thead_th]:whitespace-nowrap">
        <caption className="sr-only">{caption}</caption>
        <thead className="sticky top-0 bg-card text-left">
          <tr className="border-b border-hairline">
            <th scope="col" className={th}>
              Date
            </th>
            <th scope="col" className={th}>
              Job
            </th>
            <th scope="col" className={th}>
              Movement
            </th>
            <th scope="col" className={cn(th, "text-right")}>
              Amount
            </th>
            <th scope="col" className={th}>
              Customer
            </th>
            <th scope="col" className={th}>
              Kind
            </th>
            <th scope="col" className={th}>
              Method
            </th>
            <th scope="col" className={th}>
              Recorded
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-hairline">
          {items.map((p) => (
            <tr key={`${p.movement}:${p.id}`}>
              <td className="px-3 py-2 whitespace-nowrap">{paymentDate(p.at)}</td>
              <td className="px-3 py-2 whitespace-nowrap">
                <JobLink item={p} />
              </td>
              <td className="px-3 py-2 whitespace-nowrap">
                {movementLabel(p.movement)}
                <OtherCurrencyBadge item={p} />
              </td>
              <td
                className={cn(
                  "px-3 py-2 text-right whitespace-nowrap",
                  isOutgoing(p.movement) && "text-dust-700",
                )}
              >
                {formatSignedMoney(p.signedAmount, p.currency)}
              </td>
              <td className="min-w-40 px-3 py-2">{p.customerLabel ?? "—"}</td>
              <td className="px-3 py-2 whitespace-nowrap">
                {paymentKindLabel(p.movement, p.kind)}
              </td>
              <td className="px-3 py-2 whitespace-nowrap">{paymentMethodLabel(p.method)}</td>
              <td className="min-w-48 px-3 py-2 text-dust-700">
                {p.recordedAt ? (
                  <>
                    {paymentDate(p.recordedAt)}
                    {p.recordedByName ? ` · ${p.recordedByName}` : null}
                  </>
                ) : (
                  <span className="text-dust-500">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
