import type { Metadata } from "next";
import type { ReactNode } from "react";

import { Card } from "@/components/ui/card";
import { noteBalanceAttempt } from "@/lib/admin/balance-throttle";
import {
  NOT_VALID_NOTICE,
  balanceNotice,
  balanceReturn,
  isBalanceToken,
  paidLabel,
  parseBalanceView,
  paymentNote,
  type BalanceReturn as ReturnMarker,
  type BalanceView,
  type Notice as NoticeWords,
  type OpenBalance,
} from "@/lib/balance-page";
import { stripeIsOn } from "@/lib/integrations/stripe/client";
import { formatMoney, formatQuantity } from "@/lib/money";
import { createAnonClient } from "@/lib/supabase/anon";

import { StripePrivacyLine } from "../../stripe-privacy-line";
import { BalanceReturn, ReturnSlot, type PageState } from "./balance-return";
import { PayBalanceButton } from "./pay-balance-button";

/**
 * The customer's payment link (Phase 14 step 3; PLAN D156; ADR-025): the
 * job's bill (its live lines, the job total, what was paid and what is
 * left) and Pay, which goes to Stripe Checkout for the balance Postgres
 * computes at every read and every Pay. Read as anon through
 * `balance_by_token`, whoever opens it; nothing else of the shop's data is
 * reachable from here, never a cost, a serial, a unit id or a contact
 * (D156f, step3-critique C10). A replaced, stopped or expired link, or
 * one whose job is no longer completed or ready, shows the job and what to
 * do only (C11). Not indexed, no referrer (next.config.ts sends both as
 * headers too), never cached.
 *
 * `?balance=returned` or `cancelled` (Stripe's return) only changes the
 * words: what is paid is what Stripe's data says (D153).
 */

/** Pay can make up to four Stripe calls, each with its own timeout. */
export const maxDuration = 60;

export const metadata: Metadata = {
  title: { absolute: "Your bill · BICII" },
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default async function PayPage({ params, searchParams }: PageProps<"/pay/[token]">) {
  const { token } = await params;
  const returning = balanceReturn((await searchParams).balance);
  if (!isBalanceToken(token)) return <Notice {...NOT_VALID_NOTICE} />;

  // Every read is wrapped the same way, so the return from Stripe keeps its
  // state across the page's refreshes, whatever the page then says.
  const wrap = (page: PageState, view: BalanceView | null, body: ReactNode) => (
    <BalanceReturn
      token={token}
      returned={returning === "returned"}
      page={page}
      jobNumber={view?.job_number ?? null}
      balanceDue={view !== null && view.status === "open" ? view.balance_due : null}
    >
      {body}
    </BalanceReturn>
  );

  if ((await noteBalanceAttempt("view", token)) === "limited") {
    return wrap(
      "unknown",
      null,
      <Notice title="Too many requests" body="Wait a few minutes, then open the link again." />,
    );
  }

  const { data, error } = await createAnonClient().rpc("balance_by_token", { p_token: token });
  if (error) {
    return wrap(
      "unknown",
      null,
      <Notice
        title="This bill can't be shown right now"
        body="Try again in a few minutes. If it keeps happening, contact the shop."
      />,
    );
  }
  const view = parseBalanceView(data);
  if (view === null) return wrap("closed", null, <Notice {...NOT_VALID_NOTICE} />);
  if (view.status !== "open") return wrap("closed", view, <Notice {...balanceNotice(view)} />);

  // Reads the environment only, never a secret; never throws (D157c).
  const payOnline = stripeIsOn();
  return wrap(
    view.payment === "due" ? "due" : "open",
    view,
    <OpenBill view={view} token={token} payOnline={payOnline} returning={returning} />,
  );
}

function Notice({ title, body }: NoticeWords) {
  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-3xl">{title}</h1>
      <p className="text-dust-700">{body}</p>
    </div>
  );
}

function OpenBill({
  view,
  token,
  payOnline,
  returning,
}: {
  view: OpenBalance;
  token: string;
  payOnline: boolean;
  returning: ReturnMarker;
}) {
  const money = (value: string) => formatMoney(value, view.currency);
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <p className="eyebrow text-dust-500">
          Job {view.job_number}
          {view.bike ? ` · ${view.bike}` : ""}
        </p>
        <h1 className="text-3xl">
          {view.first_name ? `Hi ${view.first_name}, here is your bill` : "Your bill"}
        </h1>
      </header>
      <Card title="Your bill">
        {view.lines.length > 0 ? (
          <ul aria-label="Your bill" className="flex flex-col divide-y divide-hairline">
            {view.lines.map((line, index) => (
              // Lines carry no id (D156f); their order is the bill's.
              <li key={index} className="flex items-start justify-between gap-3 py-3">
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium break-words">{line.description}</span>
                  <span className="text-sm text-dust-500">
                    Quantity {formatQuantity(line.quantity)}
                  </span>
                </span>
                <span className="tabular-nums">{money(line.line_total)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-dust-700">No lines on this bill.</p>
        )}
        <dl className="mt-3 flex flex-col gap-2 border-t border-hairline pt-3 tabular-nums">
          <div className="flex justify-between gap-3">
            <dt>Job total</dt>
            <dd>{money(view.job_total)}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt>{paidLabel(view)}</dt>
            <dd>{money(view.paid)}</dd>
          </div>
          <div className="flex justify-between gap-3 text-lg font-semibold">
            <dt>Balance due</dt>
            <dd>{money(view.balance_due)}</dd>
          </div>
        </dl>
      </Card>
      <section aria-label="Payment" className="flex flex-col gap-3">
        <Payment
          view={view}
          token={token}
          amount={money(view.balance_due)}
          payOnline={payOnline}
          returning={returning}
        />
      </section>
    </div>
  );
}

function Payment({
  view,
  token,
  amount,
  payOnline,
  returning,
}: {
  view: OpenBalance;
  token: string;
  amount: string;
  payOnline: boolean;
  returning: ReturnMarker;
}) {
  const note = paymentNote(view);
  if (note !== null) {
    return (
      <div role="status" className="flex flex-col gap-2 rounded-xl bg-sunken p-4 text-dust-700">
        {note.map((sentence) => (
          <p key={sentence}>{sentence}</p>
        ))}
      </div>
    );
  }
  return (
    <ReturnSlot payOnline={payOnline} amount={amount}>
      {returning === "cancelled" ? (
        <p role="status" className="rounded-xl bg-sunken p-4 text-dust-700">
          Payment not finished. Nothing was charged. You can pay the balance below whenever
          you&apos;re ready.
        </p>
      ) : null}
      {payOnline ? (
        <>
          <PayBalanceButton token={token} amountLabel={amount} />
          <p className="text-sm text-dust-700">
            Pay securely by card or PayNow with Stripe. You&apos;ll come back to this page.
          </p>
          <StripePrivacyLine />
        </>
      ) : (
        <p className="text-dust-700">The shop will tell you how to pay the balance.</p>
      )}
    </ReturnSlot>
  );
}
