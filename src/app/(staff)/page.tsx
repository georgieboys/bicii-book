import type { Metadata } from "next";
import Link from "next/link";
import { Suspense, type ReactNode } from "react";

import { ActivityList } from "@/components/domain/today/activity-list";
import { AdjustmentList } from "@/components/domain/today/adjustment-list";
import { AppointmentsSection, TodayArrivals } from "@/components/domain/today/appointments-section";
import { DayNavigator } from "@/components/domain/today/day-navigator";
import { ExceptionList } from "@/components/domain/today/exception-list";
import { FinancialEntries } from "@/components/domain/today/financial-entries";
import { LowStockList } from "@/components/domain/today/low-stock-list";
import { RefreshButton } from "@/components/domain/today/refresh-button";
import { SectionLoader, SectionSkeleton } from "@/components/domain/today/section-loader";
import { MoneyTile, StatTile, TileGrid, TodaySection } from "@/components/domain/today/stat-tile";
import { WeekStrip } from "@/components/domain/today/week-strip";
import { EmptyState } from "@/components/ui/empty-state";
import { hasPermission } from "@/lib/auth/permissions";
import { requireStaff } from "@/lib/auth/session";
import {
  EARLIEST_SHOP_DAY,
  formatShopDay,
  formatShopDayLong,
  formatShopDayShort,
  formatTime,
  greetingFor,
  parseShopDay,
  shiftShopDay,
  shopToday,
} from "@/lib/dates";
import { DbError } from "@/lib/db-errors";
import { todaySummary } from "@/lib/domain/appointments";
import {
  getDailySummaries,
  getFinancialEntriesOn,
  getLowStockItems,
  getOperationalExceptions,
  getStockAdjustmentsOn,
  getTodayDashboard,
  getWorkOrderActivityOn,
} from "@/lib/domain/reports";
import {
  ACTIVITY_FLOWS,
  TILE_LINKS,
  lossNote,
  provisionalNote,
  weekStrip,
  type TodayDashboard,
} from "@/lib/reports";
import { canManagePurchasing } from "@/lib/purchasing";
import { createClient, type ServerSupabase } from "@/lib/supabase/server";
import { OVERDUE_AFTER_DAYS } from "@/lib/workshop";

export const metadata: Metadata = { title: "Today" };

/** Low-stock products listed on Today; the rest are one tap away. */
const LOW_STOCK_ROWS = 5;
/** Exceptions listed on Today. */
const EXCEPTION_ROWS = 20;

const isRangeInvalid = (err: unknown) =>
  err instanceof DbError && err.code === "P0001" && err.message === "report_range_invalid";

/**
 * The dashboard for `asked`: the database's today when nothing (or today
 * or later, by this server's clock) is asked. If the database refuses an
 * explicit day as in its future (clocks either side of Singapore
 * midnight), it shows its today instead: a day choice never errors (D35).
 */
async function loadDashboard(
  supabase: ServerSupabase,
  asked: string | null,
): Promise<TodayDashboard> {
  if (asked === null || asked >= shopToday()) return getTodayDashboard(supabase);
  try {
    return await getTodayDashboard(supabase, asked);
  } catch (err) {
    if (isRangeInvalid(err)) return getTodayDashboard(supabase);
    throw err;
  }
}

/**
 * Today (SPEC §19.1; PLAN D30-D35, D41): the shop's day on one screen. The
 * dashboard row comes first (one RPC); each list streams in its own
 * Suspense boundary. The database decides which day is today, and every
 * other read and label uses the day it returned. `?day=YYYY-MM-DD` shows
 * an earlier day, from EARLIEST_SHOP_DAY (flows, money, stock and
 * activity; no snapshot, no exceptions, no arrivals list); `?entries=open`
 * opens "What makes up these figures".
 *
 * No loading.tsx at the group root (DESIGN "Loading"): it would commit a
 * 200 before child pages' 403s.
 */
export default async function TodayPage({ searchParams }: PageProps<"/">) {
  const staff = await requireStaff();
  const { day: raw, entries } = await searchParams;
  const parsed = parseShopDay(Array.isArray(raw) ? raw[0] : raw);
  // Before EARLIEST_SHOP_DAY is treated like garbage: today.
  const asked = parsed !== null && parsed >= EARLIEST_SHOP_DAY ? parsed : null;
  const firstName = staff.displayName.split(/\s+/)[0];
  // U1-2: the greeting and placeholders at once, after the session check
  // (so its redirect and 403 keep their status), while the dashboard loads.
  return (
    <Suspense fallback={<TodayLoading asked={asked} firstName={firstName} />}>
      <TodayContent staff={staff} asked={asked} entries={entries} />
    </Suspense>
  );
}

/** Today's header and section placeholders while the dashboard RPC runs. */
function TodayLoading({ asked, firstName }: { asked: string | null; firstName: string }) {
  const today = asked === null || asked >= shopToday();
  return (
    <>
      <header className="flex flex-col gap-3 pt-6">
        <p className="eyebrow text-dust-500">{today ? formatShopDay(shopToday()) : "Past day"}</p>
        <h1 className="text-4xl sm:text-5xl">
          {today ? `${greetingFor(new Date())}, ${firstName}` : formatShopDayLong(asked)}
        </h1>
      </header>
      <div role="status" className="sr-only">
        Loading the day…
      </div>
      <div className="mt-6 flex flex-col gap-6">
        <SectionSkeleton rows={2} />
        <SectionSkeleton rows={4} />
        <SectionSkeleton rows={3} />
      </div>
    </>
  );
}

async function TodayContent({
  staff,
  asked,
  entries,
}: {
  staff: Awaited<ReturnType<typeof requireStaff>>;
  asked: string | null;
  entries: string | string[] | undefined;
}) {
  const supabase = await createClient();
  const dash = await loadDashboard(supabase, asked);
  const { day, isToday } = dash;

  const canSeeEntries = dash.money !== null && hasPermission(staff, "view_financial_reports");
  const showCosts = dash.money?.costs != null;
  const firstName = staff.displayName.split(/\s+/)[0];
  const generated = new Date(dash.generatedAt);
  const nextDay = shiftShopDay(day, 1);
  const flowsTitle = isToday ? "Today" : `On ${formatShopDayShort(day)}`;
  const w = dash.workshop;
  const exceptionTotal = dash.now?.exceptions ?? 0;
  const flowHref = (count: number, anchor: string) => (count > 0 ? `#${anchor}` : null);
  const anchorOf = (flow: (typeof ACTIVITY_FLOWS)[number]["flow"]) =>
    ACTIVITY_FLOWS.find((f) => f.flow === flow)!.anchor;

  return (
    <>
      <header className="flex flex-col gap-3 pt-6">
        {isToday ? (
          <>
            <p className="eyebrow text-dust-500">{formatShopDay(day)}</p>
            <h1 className="text-4xl sm:text-5xl">
              {greetingFor(generated)}, {firstName}
            </h1>
          </>
        ) : (
          <>
            <p className="eyebrow text-dust-500">Past day</p>
            <h1 className="text-4xl sm:text-5xl">{formatShopDayLong(day)}</h1>
            <p>
              <Link href="/" className="inline-flex min-h-tap items-center font-semibold underline">
                Back to today
              </Link>
            </p>
          </>
        )}
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <DayNavigator
            day={day}
            isToday={isToday}
            min={EARLIEST_SHOP_DAY}
            max={isToday ? day : shopToday()}
            previousHref={day > EARLIEST_SHOP_DAY ? `/?day=${shiftShopDay(day, -1)}` : null}
            nextHref={isToday ? null : nextDay >= shopToday() ? "/" : `/?day=${nextDay}`}
          />
          <RefreshButton generatedAt={dash.generatedAt} label={formatTime(generated)} />
        </div>
      </header>

      {dash.now ? (
        <TodaySection
          id="today-now"
          title="Right now"
          description="Jobs in the workshop at this moment."
        >
          <TileGrid columns={3}>
            <StatTile label="Received" value={dash.now.received} href={TILE_LINKS.received} />
            <StatTile label="Waiting" value={dash.now.waiting} href={TILE_LINKS.waiting} />
            <StatTile
              label="Ready to start"
              value={dash.now.readyToStart}
              href={TILE_LINKS.ready_to_start}
            />
            <StatTile
              label="In progress"
              value={dash.now.inProgress}
              href={TILE_LINKS.in_progress}
            />
            <StatTile
              label="Awaiting collection"
              value={dash.now.awaitingCollection}
              hint="Completed, not yet collected"
              href={TILE_LINKS.awaiting_collection}
            />
            <StatTile
              label="Overdue"
              value={dash.now.overdue}
              tone={dash.now.overdue > 0 ? "danger" : "neutral"}
              hint={`Open more than ${OVERDUE_AFTER_DAYS} days`}
              href={TILE_LINKS.overdue}
            />
          </TileGrid>
        </TodaySection>
      ) : null}

      <AppointmentsSection appointments={dash.appointments}>
        {isToday ? (
          <Suspense fallback={<SectionSkeleton rows={3} />}>
            <SectionLoader name="arrivals" load={() => todaySummary(supabase, day)}>
              {(summary) => <TodayArrivals summary={summary} />}
            </SectionLoader>
          </Suspense>
        ) : null}
      </AppointmentsSection>

      <TodaySection
        id="today-flows"
        title={flowsTitle}
        description="Jobs whose check-in, start, completion or collection falls on this day."
      >
        <TileGrid columns={3}>
          <StatTile
            label="Checked in"
            value={w.checkedIn}
            href={flowHref(w.checkedIn, anchorOf("checkedIn"))}
          />
          <StatTile
            label="Started"
            value={w.started}
            href={flowHref(w.started, anchorOf("started"))}
          />
          <StatTile
            label="Completed"
            value={w.completed}
            href={flowHref(w.completed, anchorOf("completed"))}
          />
          <StatTile
            label="Ready for collection"
            value={w.readyForCollection}
            href={flowHref(w.readyForCollection, anchorOf("readyForCollection"))}
          />
          <StatTile
            label="Collected"
            value={w.collected}
            href={flowHref(w.collected, anchorOf("collected"))}
          />
          {w.cancelled > 0 ? (
            <StatTile
              label="Cancelled"
              value={w.cancelled}
              href={flowHref(w.cancelled, anchorOf("cancelled"))}
            />
          ) : null}
        </TileGrid>
      </TodaySection>

      {dash.money ? (
        <MoneySection dash={dash}>
          {canSeeEntries ? (
            <Suspense fallback={<SectionSkeleton rows={2} />}>
              <SectionLoader
                name="financial-entries"
                load={() => getFinancialEntriesOn(supabase, day)}
              >
                {(rows) => <FinancialEntries entries={rows} open={entries === "open"} />}
              </SectionLoader>
            </Suspense>
          ) : null}
        </MoneySection>
      ) : null}

      <TodaySection id="today-stock" title="Stock">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div className="flex flex-col gap-3">
            <StatTile
              label="Parts used"
              value={dash.stock.partsConsumedQty}
              hint={
                <>
                  {dash.stock.partsConsumedLines === 1
                    ? "on 1 job line"
                    : `on ${dash.stock.partsConsumedLines} job lines`}
                  {dash.stock.partsReturnedQty > 0
                    ? ` · ${dash.stock.partsReturnedQty} returned`
                    : ""}
                </>
              }
            />
            <div className="flex flex-col gap-2 rounded-2xl border border-hairline bg-card px-4 py-3">
              <dl className="flex flex-col gap-1">
                <dt className="eyebrow text-dust-500">Stock adjustments</dt>
                <dd className="font-display text-3xl leading-none font-extrabold tabular-nums sm:text-4xl">
                  {dash.stock.adjustments}
                </dd>
              </dl>
              {dash.stock.significantAdjustments > 0 ? (
                <p className="text-sm font-medium text-waiting-deep">
                  {dash.stock.significantAdjustments} significant
                </p>
              ) : null}
              {dash.stock.adjustments > 0 ? (
                <Suspense fallback={<SectionSkeleton rows={2} />}>
                  <SectionLoader
                    name="stock-adjustments"
                    load={() => getStockAdjustmentsOn(supabase, day)}
                  >
                    {(rows) => <AdjustmentList rows={rows} />}
                  </SectionLoader>
                </Suspense>
              ) : null}
            </div>
          </div>
          {dash.now ? (
            <div className="flex flex-col gap-2 rounded-2xl border border-hairline bg-card px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <dl className="flex flex-col gap-1">
                  <dt className="eyebrow text-dust-500">Low stock</dt>
                  <dd
                    className={
                      dash.now.lowStock > 0
                        ? "font-display text-3xl leading-none font-extrabold text-waiting-deep tabular-nums sm:text-4xl"
                        : "font-display text-3xl leading-none font-extrabold tabular-nums sm:text-4xl"
                    }
                  >
                    {dash.now.lowStock}
                  </dd>
                </dl>
                <div className="flex flex-wrap items-center justify-end gap-x-4">
                  {/* Purchasing (Phase 7): a draft order from what is low (D66). */}
                  {dash.now.lowStock > 0 && canManagePurchasing(staff) ? (
                    <Link
                      href="/purchasing/reorder"
                      className="inline-flex min-h-tap items-center text-sm font-semibold underline"
                    >
                      Reorder
                    </Link>
                  ) : null}
                  <Link
                    href="/inventory?filter=low"
                    className="inline-flex min-h-tap items-center text-sm font-semibold underline"
                  >
                    See all<span className="sr-only"> low stock</span>
                  </Link>
                </div>
              </div>
              {dash.now.lowStock > 0 ? (
                <Suspense fallback={<SectionSkeleton rows={3} />}>
                  <SectionLoader
                    name="low-stock"
                    load={() => getLowStockItems(supabase, LOW_STOCK_ROWS)}
                  >
                    {(items) => <LowStockList items={items} />}
                  </SectionLoader>
                </Suspense>
              ) : (
                <p className="text-sm text-dust-500">Nothing is at or below its reorder point.</p>
              )}
            </div>
          ) : null}
        </div>
      </TodaySection>

      {dash.now ? (
        <TodaySection
          id="today-attention"
          title="Needs attention"
          actions={
            <>
              <span className="text-sm text-dust-500 tabular-nums">
                {dash.now.exceptions === 1 ? "1 item" : `${dash.now.exceptions} items`}
              </span>
              {/* Phase 9: the full list, grouped, on /reports/exceptions. */}
              <Link
                href="/reports/exceptions"
                className="inline-flex min-h-tap items-center text-sm font-semibold underline"
              >
                See all<span className="sr-only"> exceptions</span>
              </Link>
            </>
          }
        >
          <Suspense fallback={<SectionSkeleton rows={3} />}>
            <SectionLoader
              name="exceptions"
              load={() => getOperationalExceptions(supabase, EXCEPTION_ROWS)}
            >
              {(rows) => (
                <ExceptionList rows={rows} total={exceptionTotal} moreHref="/reports/exceptions" />
              )}
            </SectionLoader>
          </Suspense>
        </TodaySection>
      ) : null}

      <TodaySection id="today-activity" title="Activity">
        <Suspense fallback={<SectionSkeleton rows={4} />}>
          <SectionLoader name="activity" load={() => getWorkOrderActivityOn(supabase, day)}>
            {(rows) =>
              rows.length === 0 ? (
                <EmptyState
                  title="Nothing happened on this day"
                  description="No job was checked in, started, completed, collected or cancelled."
                />
              ) : (
                <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
                  {ACTIVITY_FLOWS.map(({ flow, label, anchor }) => {
                    const list = rows.filter((r) => r.on[flow]);
                    const always =
                      flow === "checkedIn" || flow === "completed" || flow === "collected";
                    return always || list.length > 0 ? (
                      <ActivityList key={flow} label={label} anchor={anchor} rows={list} />
                    ) : null;
                  })}
                </div>
              )
            }
          </SectionLoader>
        </Suspense>
      </TodaySection>

      <TodaySection id="today-week" title="Last 7 days" className="mb-4">
        <Suspense fallback={<SectionSkeleton rows={7} />}>
          <SectionLoader
            name="week"
            load={() => getDailySummaries(supabase, { from: shiftShopDay(day, -6), to: day })}
          >
            {(rows) => (
              <WeekStrip
                days={weekStrip(rows, day)}
                selected={day}
                showMoney={dash.money !== null}
                showCosts={showCosts}
              />
            )}
          </SectionLoader>
        </Suspense>
      </TodaySection>
    </>
  );
}

/** Today's Money (view_financial_reports; costs with view_costs, D30). */
function MoneySection({ dash, children }: { dash: TodayDashboard; children: ReactNode }) {
  const money = dash.money!;
  const costs = money.costs;
  const c = money.currency;
  const loss = costs ? lossNote(costs.lossLines, costs.lossTotal, c) : null;
  const provisional = costs ? provisionalNote(money.costPendingLines) : null;
  return (
    <TodaySection
      id="today-money"
      title="Money"
      description="Jobs completed and sales recorded on this day, from each line's prices and costs when it was added or sold."
    >
      <MoneyTile label="Gross sales" amount={money.grossSales} currency={c} large />
      {costs ? (
        <TileGrid>
          <MoneyTile label="Direct costs (COGS)" amount={costs.cogs} currency={c} />
          <MoneyTile label="Yield" amount={costs.yield} currency={c} />
          <MoneyTile
            label="Cult Commons"
            amount={costs.cultCommons}
            currency={c}
            hint="Each line's share of its positive yield, at the rate it was added with"
          />
          <MoneyTile label="BICII after Cult Commons" amount={costs.biciiAfterCc} currency={c} />
        </TileGrid>
      ) : (
        <p className="text-sm text-dust-700">
          Costs, yield and Cult Commons need the View costs permission.
        </p>
      )}
      {loss ? (
        <p role="note" className="text-sm font-medium text-danger-deep">
          {loss}
        </p>
      ) : null}
      {provisional ? (
        <p role="note" className="text-sm font-medium text-waiting-deep">
          {provisional}
        </p>
      ) : null}
      {dash.isToday ? null : (
        <p className="text-sm text-dust-500">
          Counts jobs completed and sales recorded on this day. If a job is reopened, it moves to
          the day it is completed again.
        </p>
      )}
      <TileGrid>
        <MoneyTile
          label="Consignment sales"
          amount={money.consignmentSales.total}
          currency={c}
          href={`/sales?day=${dash.day}`}
          hint={
            // Sales and completed jobs that used consigned stock (D44): the
            // link opens that day's sales; jobs are under Jobs completed.
            money.consignmentSales.count === 1
              ? "1 sale or job with consigned items"
              : `${money.consignmentSales.count} sales or jobs with consigned items`
          }
        />
        {costs ? (
          <MoneyTile
            label="New consignor liability"
            amount={costs.newConsignorLiability}
            currency={c}
            href="/consignment"
            hint="Owed to consignors for what sold on this day"
          />
        ) : null}
      </TileGrid>
      {children}
    </TodaySection>
  );
}
