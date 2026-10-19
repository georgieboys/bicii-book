import { z } from "zod";

import { formatMoney, toDecimal } from "@/lib/money";

/**
 * The customer's payment link page, /pay/<token> (Phase 14 step 3; D156f;
 * ADR-025; step3-critique C10, C11): what `balance_by_token` returns,
 * parsed at the trust boundary, the token's shape, the words for each
 * state and Stripe's return marker. Pure, so the page, its actions and the
 * unit tests share it. Nothing here computes money: every amount is
 * Postgres's, formatted only.
 */

/** A link token: 32 random bytes as base64url without padding (43 characters, D156c). */
export const BALANCE_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export const isBalanceToken = (token: string) => BALANCE_TOKEN.test(token);

const money = z.union([z.string(), z.number()]).transform(String);

/** One live line of the bill: sale side only, never an id, unit id or serial (C10). */
const line = z.object({
  description: z.string(),
  quantity: money,
  line_total: money,
});

/**
 * What Pay can do for an open link (D156f), computed in SQL at every read:
 * due; processing (a Stripe payment on the job is being confirmed);
 * too_small (under S$0.50 left); nothing_due; too_large (above
 * S$999,999.99).
 */
export const BALANCE_PAYMENT_STATES = [
  "due",
  "processing",
  "too_small",
  "nothing_due",
  "too_large",
] as const;
export type BalancePaymentState = (typeof BALANCE_PAYMENT_STATES)[number];

/** A withdrawn, expired or closed link shows only its state and the job (C11). */
const closedLink = <S extends "withdrawn" | "expired" | "closed">(status: S) =>
  z.object({ status: z.literal(status), job_number: z.string() });

const openLink = z.object({
  status: z.literal("open"),
  shop_name: z.string(),
  job_number: z.string(),
  bike: z.string().nullable(),
  first_name: z.string().nullable(),
  currency: z.string(),
  lines: z.array(line),
  job_total: money,
  paid: money,
  // U2-11: what Stripe gave back on the job, which paid is already net of.
  // Optional, so a payload from before it still parses (nothing refunded).
  refunded: money.optional().transform((v) => v ?? "0"),
  paid_ahead: money,
  balance_due: money,
  payment: z.enum(BALANCE_PAYMENT_STATES),
});

/**
 * The two key sets (D156f), pinned here as tests/db/balance-links.test.ts
 * pins them in SQL. A key the payload carries beyond them is dropped, never
 * rendered.
 */
export const balanceViewSchema = z.discriminatedUnion("status", [
  closedLink("withdrawn"),
  closedLink("expired"),
  closedLink("closed"),
  openLink,
]);

export const BALANCE_OPEN_KEYS = Object.keys(openLink.shape).sort();
export const BALANCE_CLOSED_KEYS = Object.keys(closedLink("closed").shape).sort();

export type BalanceView = z.infer<typeof balanceViewSchema>;
export type OpenBalance = Extract<BalanceView, { status: "open" }>;
export type ClosedBalance = Exclude<BalanceView, { status: "open" }>;
export type BalanceLine = OpenBalance["lines"][number];

/** Parses what the RPC returned; null for an unknown token or an unexpected shape. */
export function parseBalanceView(value: unknown): BalanceView | null {
  if (value === null || value === undefined) return null;
  const parsed = balanceViewSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Where Stripe sent the customer back to (`?balance=`): display only,
 * never proof of payment (D153), never reflected or used as a target.
 */
export type BalanceReturn = "returned" | "cancelled" | null;

export function balanceReturn(value: string | string[] | undefined): BalanceReturn {
  return value === "returned" || value === "cancelled" ? value : null;
}

export type Notice = { title: string; body: string };

/** An unknown token or one of the wrong shape. */
export const NOT_VALID_NOTICE: Notice = {
  title: "This link is not valid",
  body: "Check you opened the whole link, or ask the shop for a new one.",
};

const CLOSED_BODIES: Readonly<Record<ClosedBalance["status"], string>> = {
  withdrawn: "This payment link was replaced or stopped. Ask the shop for a new one.",
  expired: "This payment link has expired. Ask the shop for a new one.",
  // Read from the job's status at every read: reopened, collected or cancelled.
  closed: "This job has changed. Ask the shop how to pay.",
};

/** A withdrawn, expired or closed link: the job, and what to do. */
export function balanceNotice(view: ClosedBalance): Notice {
  return { title: `Your bill for job ${view.job_number}`, body: CLOSED_BODIES[view.status] };
}

/**
 * The bill's "Paid so far" label: it is net of Stripe refunds, so once
 * anything was refunded it says how much (U2-11). Postgres's figure,
 * compared with zero and formatted, never computed.
 */
export function paidLabel(view: OpenBalance): string {
  return toDecimal(view.refunded).greaterThan(0)
    ? `Paid so far (after ${formatMoney(view.refunded, view.currency)} refunded)`
    : "Paid so far";
}

/**
 * What an open bill says instead of Pay, one sentence per line; null when
 * the balance is due (the page shows Pay). paid_ahead is Postgres's,
 * compared with zero, never computed.
 */
export function paymentNote(view: OpenBalance): string[] | null {
  switch (view.payment) {
    case "due":
      return null;
    case "processing":
      return [
        "Your payment is being confirmed by Stripe. Reload this page later to see it confirmed. You don't need to pay again.",
      ];
    case "too_small":
      return [`Less than ${formatMoney("0.50", view.currency)} is left; pay it at the shop.`];
    case "nothing_due":
      return toDecimal(view.paid_ahead).greaterThan(0)
        ? [
            "Nothing is left to pay. Thank you.",
            "You have paid more than the bill; the shop will sort out the difference.",
          ]
        : ["Nothing is left to pay. Thank you."];
    case "too_large":
      return ["This bill is too large to pay online; pay it at the shop."];
  }
}
