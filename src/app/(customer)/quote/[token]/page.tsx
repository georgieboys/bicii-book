import type { Metadata } from "next";

import { Card } from "@/components/ui/card";
import { noteQuoteAttempt } from "@/lib/admin/quote-throttle";
import { formatDate, formatDateTime } from "@/lib/dates";
import { stripeIsOn } from "@/lib/integrations/stripe/client";
import { formatMoney, formatQuantity, sumMoney } from "@/lib/money";
import {
  answeredNext,
  approvedSummary,
  depositReturn,
  isQuoteToken,
  parseQuoteView,
  type DepositReturn,
  type OpenOrAnsweredQuote,
} from "@/lib/quote-page";
import { createAnonClient } from "@/lib/supabase/anon";

import { DepositCard } from "./deposit-card";
import { QuoteForm } from "./quote-form";
import { ThankYou } from "./thank-you";

/**
 * The customer's quote (Phase 13 step 3; PLAN D142, D143, ADR-024): the
 * job, the bike, their first name, the items with prices and the total,
 * and per-item answers. Read as anon through `quote_by_token`, whoever
 * opens it; nothing else of the shop's data is reachable from here. Not
 * indexed, no referrer (next.config.ts sends both as headers too), never
 * cached.
 *
 * Phase 14 step 2 (D151, D153, D158): an open quote says what deposit
 * the shop will ask (the percent only); an answered one shows the deposit
 * and Pay deposit, which goes to Stripe Checkout. `?deposit=returned` or
 * `cancelled` (Stripe's return) only changes the words: what is paid is
 * what Stripe's data says.
 */

/** Pay deposit can make up to four Stripe calls, each with its own timeout. */
export const maxDuration = 60;

export const metadata: Metadata = {
  title: { absolute: "Your quote · BICII" },
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default async function QuotePage({ params, searchParams }: PageProps<"/quote/[token]">) {
  const { token } = await params;
  const returning = depositReturn((await searchParams).deposit);
  if (!isQuoteToken(token)) return <Notice title="This link is not valid" body={ASK_AGAIN} />;

  if ((await noteQuoteAttempt("view", token)) === "limited") {
    return (
      <Notice title="Too many requests" body="Wait a few minutes, then open the link again." />
    );
  }

  const { data, error } = await createAnonClient().rpc("quote_by_token", { token });
  if (error) {
    return (
      <Notice
        title="This quote can't be shown right now"
        body="Try again in a few minutes. If it keeps happening, contact the shop."
      />
    );
  }
  const quote = parseQuoteView(data);
  if (!quote) return <Notice title="This link is not valid" body={ASK_AGAIN} />;

  if (quote.status === "withdrawn") {
    return (
      <Notice
        title={`Quote for job ${quote.job_number} replaced`}
        body="The shop replaced or withdrew this quote. Use the newest link they sent you, or ask them for one."
      />
    );
  }
  if (quote.status === "expired") {
    return (
      <Notice
        title={`Quote for job ${quote.job_number} expired`}
        body="This quote's link has expired. Ask the shop for a new one."
      />
    );
  }

  // Reads the environment only, never a secret; never throws (D157c).
  const payOnline = stripeIsOn();

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <p className="eyebrow text-dust-500">
          Job {quote.job_number}
          {quote.bike ? ` · ${quote.bike}` : ""}
        </p>
        <h1 className="text-3xl">
          {quote.first_name ? `Hi ${quote.first_name}, here is your quote` : "Your quote"}
        </h1>
      </header>
      {quote.status === "answered" ? (
        <Answered quote={quote} token={token} payOnline={payOnline} returning={returning} />
      ) : (
        <Open quote={quote} token={token} payOnline={payOnline} />
      )}
    </div>
  );
}

const ASK_AGAIN = "Check you opened the whole link, or ask the shop for a new one.";

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-3xl">{title}</h1>
      <p className="text-dust-700">{body}</p>
    </div>
  );
}

function Open({
  quote,
  token,
  payOnline,
}: {
  quote: OpenOrAnsweredQuote;
  token: string;
  payOnline: boolean;
}) {
  return (
    <>
      <p className="text-dust-700">
        Approve or decline each item, type your name and send your answer. The shop orders only what
        you approve. You can answer once; this link works until {formatDateTime(quote.expires_at)}{" "}
        (Singapore time).
      </p>
      {quote.deposit?.status === "on_answer" ? (
        <p className="text-dust-700">
          After you answer, the shop asks for a deposit of {quote.deposit.percent}% of the parts you
          approve (not labour){payOnline ? ", paid online by card or PayNow" : ""}. Your approval
          stands either way; the shop orders your parts once the deposit is paid.
        </p>
      ) : null}
      <QuoteForm
        token={token}
        currency={quote.currency}
        total={quote.total}
        items={quote.items.map((i) => ({
          id: i.id,
          kind: i.kind,
          description: i.description,
          quantity: formatQuantity(i.quantity),
          unitPrice: i.unit_sale_price,
          lineTotal: i.line_total,
        }))}
      />
    </>
  );
}

function Answered({
  quote,
  token,
  payOnline,
  returning,
}: {
  quote: OpenOrAnsweredQuote;
  token: string;
  payOnline: boolean;
  returning: DepositReturn;
}) {
  const { approved, of } = approvedSummary(quote.items);
  const deposit = quote.deposit;
  const next = answeredNext(deposit);
  const approvedTotal = sumMoney(
    quote.items.filter((i) => i.decision === "approved").map((i) => i.line_total),
  );
  return (
    <>
      <ThankYou token={token}>
        Thank you{quote.answered_name ? `, ${quote.answered_name}` : ""}. You approved {approved} of{" "}
        {of} {of === 1 ? "item" : "items"}
        {quote.answered_at ? ` on ${formatDate(quote.answered_at)}` : ""}. {next}
      </ThankYou>
      {deposit ? (
        <DepositCard
          token={token}
          deposit={deposit}
          currency={quote.currency}
          payOnline={payOnline}
          returning={returning}
        />
      ) : null}
      <Card title="Your answer">
        <ul aria-label="Your answer" className="flex flex-col divide-y divide-hairline">
          {quote.items.map((i) => (
            <li key={i.id} className="flex items-start justify-between gap-3 py-3">
              <span className="flex min-w-0 flex-col">
                <span className="font-medium break-words">{i.description}</span>
                <span className="text-sm text-dust-500">
                  {formatQuantity(i.quantity)} × {formatMoney(i.unit_sale_price, quote.currency)}
                </span>
              </span>
              <span className="flex flex-col items-end">
                <span className="tabular-nums">{formatMoney(i.line_total, quote.currency)}</span>
                <span
                  className={
                    i.decision === "approved"
                      ? "text-sm font-semibold text-done-deep"
                      : "text-sm text-dust-500"
                  }
                >
                  {i.decision === "approved" ? "Approved" : "Declined"}
                </span>
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-3 flex justify-between border-t border-hairline pt-3 font-semibold tabular-nums">
          <span>Approved total</span>
          <span>{formatMoney(approvedTotal, quote.currency)}</span>
        </p>
      </Card>
    </>
  );
}
