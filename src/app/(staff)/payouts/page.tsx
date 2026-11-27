import type { Metadata } from "next";
import Link from "next/link";

import {
  RecordPayoutButton,
  ReversePayoutControl,
  ServicePayRuleForm,
} from "@/components/domain/payouts/payout-controls";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { RowLink, RowList } from "@/components/ui/row-list";
import { requireAdmin } from "@/lib/auth/session";
import { cn } from "@/lib/cn";
import { formatDate } from "@/lib/dates";
import {
  getPayoutSummary,
  listPayableStaff,
  listPayouts,
  listServicePayRules,
} from "@/lib/domain/payouts";
import { formatMoney } from "@/lib/money";
import { plural } from "@/lib/plural";
import {
  EARLIEST_PAYOUT_MONTH,
  PAYOUT_KIND_LABELS,
  carryOverMonth,
  carryOverWords,
  formatMonth,
  outstandingWords,
  parseMonth,
  prefillAmount,
  reserveWords,
  shiftMonth,
  thisMonth,
} from "@/lib/payouts";
import { formatSignedMoney } from "@/lib/reports";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Payouts" };

/**
 * "Still owed from earlier months: $x", linking to the earliest month still
 * owed so its own Record payment can pay it (the total counts it).
 */
function CarryOver({
  carry,
  carryFrom,
  currency,
}: {
  carry: string;
  carryFrom: string | null;
  currency: string;
}) {
  const words = carryOverWords(carry, currency);
  if (!words) return null;
  const from = carryOverMonth(carry, carryFrom);
  return (
    <p className="mt-3 text-sm font-medium">
      {words}
      {from ? (
        <>
          {" "}
          <Link href={`/payouts?month=${from}`} className="underline underline-offset-2">
            Pay {formatMonth(from)}
          </Link>
        </>
      ) : null}
    </p>
  );
}

const navLink =
  "inline-flex min-h-tap items-center rounded-full px-3 font-display text-xs font-bold tracking-wide uppercase";

/**
 * Payouts (admins only, a real 403 for anyone else: no loading.tsx, so the
 * guard runs before anything streams; PLAN D276; ADR-030): what the owner
 * owes at month end and the payments recorded against it. Every figure is
 * payout_summary's; this page adds nothing up.
 *
 *   - Total to transfer, then the mechanics (service pay), Cult Commons,
 *     the consignors (each to its own Record payment) and the services
 *     reserve (Pay ad hoc labour);
 *   - Payments recorded for the month, each with Reverse…;
 *   - Service pay: the caps, and a form for a new one.
 */
export default async function PayoutsPage({ searchParams }: PageProps<"/payouts">) {
  await requireAdmin();
  const { month: asked } = await searchParams;
  const month = parseMonth(Array.isArray(asked) ? asked[0] : asked);
  const supabase = await createClient();
  const [summary, payouts, rules, staff] = await Promise.all([
    getPayoutSummary(supabase, month),
    listPayouts(supabase, month),
    listServicePayRules(supabase),
    listPayableStaff(supabase),
  ]);
  const c = summary.currency;
  const label = formatMonth(month);
  const previous = month > EARLIEST_PAYOUT_MONTH ? shiftMonth(month, -1) : null;
  const next = month < thisMonth() ? shiftMonth(month, 1) : null;
  const cc = summary.cultCommons;
  const reserve = summary.reserve;
  // The month tracking starts: the earliest rule's (payout_summary's start).
  const trackedFrom = rules
    .reduce<string | null>(
      (min, r) => (min === null || r.effectiveFrom < min ? r.effectiveFrom : min),
      null,
    )
    ?.slice(0, 7);

  return (
    <>
      <PageHeader
        title="Payouts"
        description="What you owe at month end, and the payments you have made."
      />

      <nav aria-label="Months" className="flex flex-wrap items-center gap-1">
        {previous ? (
          <Link href={`/payouts?month=${previous}`} className={cn(navLink, "hover:bg-dust-100")}>
            <span aria-hidden="true">‹&nbsp;</span>Previous month
          </Link>
        ) : null}
        <span aria-current="page" className={cn(navLink, "bg-ink text-paper")}>
          {label}
        </span>
        {next ? (
          <Link href={`/payouts?month=${next}`} className={cn(navLink, "hover:bg-dust-100")}>
            Next month<span aria-hidden="true">&nbsp;›</span>
          </Link>
        ) : null}
      </nav>

      <Card title="Total to transfer" eyebrow={label}>
        <div className="flex flex-col gap-3">
          <p className="font-display text-4xl font-bold tabular-nums">
            {formatMoney(summary.total, c)}
          </p>
          <p className="text-sm text-dust-700">
            Service pay and Cult Commons still to pay, including earlier months, and what consignors
            are owed today. Record payment fills in this month&apos;s amount; pay an earlier month
            from its own page (follow its link below).
          </p>
        </div>
      </Card>

      {summary.mechanics.length === 0 ? (
        <Card title="Service pay">
          <p className="text-sm text-dust-700">
            No mechanic has service pay yet. Set a monthly cap under Service pay below.
          </p>
        </Card>
      ) : (
        summary.mechanics.map((mech) => {
          return (
            <Card
              key={mech.staffId}
              title={`${mech.name} (service pay)`}
              actions={
                <RecordPayoutButton
                  kind="mechanic_pay"
                  month={month}
                  payeeLabel={mech.name}
                  staffId={mech.staffId}
                  amount={prefillAmount(mech.outstanding)}
                  currency={c}
                />
              }
            >
              <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-sm tabular-nums">
                <dt className="text-dust-700">Service revenue (jobs they led)</dt>
                <dd className="text-right">{formatMoney(mech.serviceRevenue, c)}</dd>
                <dt className="text-dust-700">After Cult Commons</dt>
                <dd className="text-right">{formatSignedMoney(mech.serviceAfterCc, c)}</dd>
                <dt className="text-dust-700">Top-up from other service</dt>
                <dd className="text-right">{formatMoney(mech.topUp, c)}</dd>
                <dt className="text-dust-700">
                  Pay{" "}
                  {mech.monthlyCap
                    ? `(capped at ${formatMoney(mech.monthlyCap, c)})`
                    : "(no cap yet)"}
                </dt>
                <dd className="text-right">{formatMoney(mech.owed, c)}</dd>
                <dt className="text-dust-700">Paid</dt>
                <dd className="text-right">{formatMoney(mech.paid, c)}</dd>
                <dt className="font-semibold">Outstanding</dt>
                <dd className="text-right font-semibold">
                  {outstandingWords(mech.outstanding, c)}
                </dd>
              </dl>
              <CarryOver carry={mech.carryOver} carryFrom={mech.carryFrom} currency={c} />
            </Card>
          );
        })
      )}

      <Card
        title="Cult Commons"
        actions={
          <RecordPayoutButton
            kind="cult_commons"
            month={month}
            payeeLabel="Cult Commons"
            amount={prefillAmount(cc.outstanding)}
            currency={c}
          />
        }
      >
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-sm tabular-nums">
          <dt className="text-dust-700">The month&apos;s Cult Commons (as on Reports)</dt>
          <dd className="text-right">{formatSignedMoney(cc.owed, c)}</dd>
          <dt className="text-dust-700">Paid</dt>
          <dd className="text-right">{formatMoney(cc.paid, c)}</dd>
          <dt className="font-semibold">Outstanding</dt>
          <dd className="text-right font-semibold">{outstandingWords(cc.outstanding, c)}</dd>
        </dl>
        <CarryOver carry={cc.carryOver} carryFrom={cc.carryFrom} currency={c} />
      </Card>

      <section aria-labelledby="payouts-consignors" className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="payouts-consignors" className="text-2xl leading-tight">
            Consignors
          </h2>
          <p className="text-sm text-dust-500">
            {summary.consignors.count === 0
              ? "Nobody is owed anything for consigned items."
              : `${formatMoney(summary.consignors.total, c)} owed today to ${plural(summary.consignors.count, "consignor", "consignors")}. Record each payment on the consignor's page.`}
          </p>
        </div>
        {summary.consignors.owed.length > 0 ? (
          <RowList label="Consignors to pay">
            {summary.consignors.owed.map((o) => (
              <RowLink
                key={o.id}
                href={`/consignment/consignors/${o.id}`}
                className="min-h-14 py-2"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <p className="truncate font-medium">{o.name}</p>
                  <p className="text-sm text-dust-500">
                    {plural(o.items, "item", "items")} awaiting payment
                  </p>
                </div>
                <span className="shrink-0 font-semibold tabular-nums">
                  {formatMoney(o.outstanding, c)}
                </span>
              </RowLink>
            ))}
          </RowList>
        ) : null}
      </section>

      <Card
        title="Services reserve"
        actions={
          <RecordPayoutButton
            kind="reserve_labour"
            month={month}
            payeeLabel="ad hoc labour"
            amount=""
            currency={c}
            staff={staff}
            label="Pay ad hoc labour"
            variant="outline"
          />
        }
      >
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-sm tabular-nums">
          <dt className="text-dust-700">Other service (after Cult Commons)</dt>
          <dd className="text-right">{formatSignedMoney(reserve.otherAfterCc, c)}</dd>
          <dt className="text-dust-700">Ad hoc labour</dt>
          <dd className="text-right">{formatMoney(reserve.paid, c)}</dd>
          <dt className="text-dust-700">Change this month</dt>
          <dd className="text-right">{formatSignedMoney(reserve.added, c)}</dd>
          <dt className="text-dust-700">Before {label}</dt>
          <dd className="text-right">{formatSignedMoney(reserve.before, c)}</dd>
          <dt className="font-semibold">Balance</dt>
          <dd className="text-right font-semibold">{reserveWords(reserve.balance, c)}</dd>
        </dl>
        <p className="mt-3 text-sm text-dust-700">
          Other service is service on jobs with no mechanic on service pay. It pays ad hoc labour
          first, then tops a mechanic up to their cap; the rest, and service above a cap, stays
          here. Labour beyond it comes out of the reserve.
        </p>
      </Card>

      <Card title="Payments recorded" eyebrow={label} flush={payouts.length > 0}>
        {payouts.length === 0 ? (
          <p className="text-sm text-dust-700">No payments recorded for {label} yet.</p>
        ) : (
          <ul className="divide-y divide-hairline">
            {payouts.map((p) => {
              const reversed = p.reversedAt !== null;
              const what = `the ${formatMoney(p.amount, p.currency)} payment to ${p.payee}`;
              return (
                <li key={p.id} className="flex flex-wrap items-start gap-3 px-4 py-3 sm:px-5">
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <p className={cn("font-medium", reversed && "line-through")}>
                      {p.payee} · {PAYOUT_KIND_LABELS[p.kind]}
                    </p>
                    <p className="text-sm text-dust-500">
                      Paid {formatDate(p.paidAt)}
                      {p.reference ? ` · ${p.reference}` : ""}
                      {p.recordedBy ? ` · recorded by ${p.recordedBy}` : ""}
                    </p>
                    {p.notes ? <p className="text-sm">{p.notes}</p> : null}
                    {reversed ? (
                      <p className="text-sm text-danger-deep">
                        Reversed{p.reversedBy ? ` by ${p.reversedBy}` : ""}: {p.reversalReason}
                      </p>
                    ) : null}
                  </div>
                  <span
                    className={cn(
                      "shrink-0 font-semibold tabular-nums",
                      reversed && "line-through",
                    )}
                  >
                    {formatMoney(p.amount, p.currency)}
                  </span>
                  {reversed ? null : <ReversePayoutControl payoutId={p.id} label={what} />}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card title="Service pay">
        <div className="flex flex-col gap-5">
          <p className="text-sm text-dust-700">
            A mechanic is paid their service revenue after Cult Commons on the jobs they lead, up to
            the monthly cap. Other service, after the month&apos;s ad hoc labour, tops them up to
            the cap. The rest goes to the services reserve. Labour recorded after paying restates
            the month and can show &quot;Over by&quot;. A new cap applies from its month on; earlier
            months keep theirs.
          </p>
          {trackedFrom ? (
            <p className="text-sm text-dust-700">
              Payouts counts what is owed from {formatMonth(trackedFrom)}, the first month of
              service pay. Earlier months count as settled and never carry over.
            </p>
          ) : null}
          {rules.length > 0 ? (
            <ul className="flex flex-col gap-1 text-sm tabular-nums">
              {rules.map((r) => (
                <li key={r.id}>
                  {r.name}: {formatMoney(r.monthlyCap, c)} a month from{" "}
                  {formatMonth(r.effectiveFrom.slice(0, 7))}
                </li>
              ))}
            </ul>
          ) : null}
          <ServicePayRuleForm staff={staff} defaultMonth={month} />
        </div>
      </Card>
    </>
  );
}
