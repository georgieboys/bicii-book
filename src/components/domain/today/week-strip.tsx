import Link from "next/link";

import { cn } from "@/lib/cn";
import { formatShopDayShort } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import type { WeekStripDay } from "@/lib/reports";

/**
 * "Last 7 days" ending at the day shown (server): per day, the jobs
 * completed and collected and, when the database returned them (D30),
 * gross sales, yield and Cult Commons. Each day links to its Today view;
 * the day shown is marked (aria-current and a bold row, not colour alone).
 * A table from md (scrolling inside its card where the columns don't fit);
 * stacked rows on a phone.
 */
export function WeekStrip({
  days,
  selected,
  showMoney,
  showCosts,
}: {
  days: readonly WeekStripDay[];
  selected: string;
  showMoney: boolean;
  showCosts: boolean;
}) {
  const money = (v: string | null | undefined, currency: string | null | undefined) =>
    v === null || v === undefined ? "—" : formatMoney(v, currency ?? "SGD");
  const href = (day: string) => `/?day=${day}`;
  return (
    <>
      <ul aria-label="Last 7 days" className="flex flex-col gap-2 md:hidden">
        {days.map(({ day, summary: s }) => (
          <li
            key={day}
            data-day={day}
            className={cn(
              "flex flex-col gap-1 rounded-2xl border bg-card px-4 py-2",
              day === selected ? "border-2 border-ink" : "border-hairline",
            )}
          >
            <Link
              href={href(day)}
              aria-current={day === selected ? "date" : undefined}
              className={cn(
                "flex min-h-tap items-center underline-offset-4 hover:underline",
                day === selected ? "font-bold" : "font-semibold",
              )}
            >
              {formatShopDayShort(day)}
              {day === selected ? <span className="sr-only"> (shown)</span> : null}
            </Link>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-dense tabular-nums">
              <dt className="text-dust-500">Completed</dt>
              <dd className="text-right">{s?.jobsCompleted ?? "—"}</dd>
              <dt className="text-dust-500">Collected</dt>
              <dd className="text-right">{s?.jobsCollected ?? "—"}</dd>
              {showMoney ? (
                <>
                  <dt className="text-dust-500">Gross sales</dt>
                  <dd className="text-right">{money(s?.grossSales, s?.currency)}</dd>
                </>
              ) : null}
              {showCosts ? (
                <>
                  <dt className="text-dust-500">Yield</dt>
                  <dd className="text-right">{money(s?.yield, s?.currency)}</dd>
                  <dt className="text-dust-500">Cult Commons</dt>
                  <dd className="text-right">{money(s?.cultCommons, s?.currency)}</dd>
                </>
              ) : null}
            </dl>
          </li>
        ))}
      </ul>
      {/* Six columns for cost holders need ~600px; on an iPad's ~520px the
          table scrolls inside its card, never the page (DESIGN: no sideways
          page scroll). */}
      <div className="hidden overflow-x-auto rounded-2xl border border-hairline bg-card md:block">
        <table className="w-full text-dense tabular-nums">
          <caption className="sr-only">Last 7 days</caption>
          <thead className="bg-sunken text-left">
            <tr>
              <th scope="col" className="rounded-tl-2xl px-4 py-2 font-semibold">
                Day
              </th>
              <th scope="col" className="px-4 py-2 text-right font-semibold">
                Completed
              </th>
              <th scope="col" className="px-4 py-2 text-right font-semibold">
                Collected
              </th>
              {showMoney ? (
                <th scope="col" className="px-4 py-2 text-right font-semibold">
                  Gross sales
                </th>
              ) : null}
              {showCosts ? (
                <>
                  <th scope="col" className="px-4 py-2 text-right font-semibold">
                    Yield
                  </th>
                  <th scope="col" className="px-4 py-2 text-right font-semibold">
                    Cult Commons
                  </th>
                </>
              ) : null}
            </tr>
          </thead>
          <tbody className="divide-y divide-hairline">
            {days.map(({ day, summary: s }) => (
              <tr
                key={day}
                data-day={day}
                className={day === selected ? "bg-dust-100 font-bold" : undefined}
              >
                <th scope="row" className="px-4 py-1 text-left font-[inherit]">
                  <Link
                    href={href(day)}
                    aria-current={day === selected ? "date" : undefined}
                    className="inline-flex min-h-tap items-center whitespace-nowrap underline-offset-4 hover:underline"
                  >
                    {formatShopDayShort(day)}
                    {day === selected ? <span className="sr-only"> (shown)</span> : null}
                  </Link>
                </th>
                <td className="px-4 py-1 text-right">{s?.jobsCompleted ?? "—"}</td>
                <td className="px-4 py-1 text-right">{s?.jobsCollected ?? "—"}</td>
                {showMoney ? (
                  <td className="px-4 py-1 text-right">{money(s?.grossSales, s?.currency)}</td>
                ) : null}
                {showCosts ? (
                  <>
                    <td className="px-4 py-1 text-right">{money(s?.yield, s?.currency)}</td>
                    <td className="px-4 py-1 text-right">{money(s?.cultCommons, s?.currency)}</td>
                  </>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
