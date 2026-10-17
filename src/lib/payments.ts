import { Constants, type Database } from "@/lib/database.types";
import { formatDate, shiftShopDay, shopDateKey, shopDayToDate } from "@/lib/dates";
import { escapeHtml } from "@/lib/indent";
import { formatMoney, parseMoney, toDecimal } from "@/lib/money";
import type { StatusTone, WorkOrderStatus } from "@/lib/workshop";

/**
 * Customer payments (Phase 14; D150-D159, ADR-025): the words and states
 * the screens share. Pure and safe in the browser: nothing here computes
 * money (Postgres does, DATA-MODEL §19), and nothing names a key or a
 * secret value.
 */

type Enums = Database["public"]["Enums"];
export type PaymentStatus = Enums["payment_status"];
export type StripeRefundStatus = Enums["stripe_refund_status"];
export type StripeEventStatus = Enums["stripe_event_status"];
export type StripeRejectionReason = Enums["stripe_rejection_reason"];

// ---------------------------------------------------------------------------
// Deposits (D151, D152, D158): public.quote_deposits.state
// ---------------------------------------------------------------------------

/**
 * A deposit's state, as public.quote_deposits computes it: paid (paid or
 * partly refunded, D158e), refunded, processing (Checkout complete, Stripe
 * still confirming), due, none (every approved part cancelled).
 */
export const DEPOSIT_STATES = ["due", "processing", "paid", "refunded", "none"] as const;
export type DepositState = (typeof DEPOSIT_STATES)[number];

export const DEPOSIT_STATE_LABELS: Readonly<Record<DepositState, string>> = {
  due: "Deposit due",
  processing: "Being confirmed",
  paid: "Deposit paid",
  refunded: "Deposit refunded",
  none: "No longer due",
};

export const DEPOSIT_STATE_TONES: Readonly<Record<DepositState, StatusTone>> = {
  due: "waiting",
  processing: "waiting",
  paid: "done",
  refunded: "info",
  none: "neutral",
};

/**
 * The approved parts that only an admin or manager may order now, with a
 * reason (D152): those whose answered quote asked a deposit that is not
 * paid. Mirrors the gate in public.order_part_requests, which reads the
 * same public.quote_deposits state; the database enforces it whatever the
 * screen shows.
 */
export function depositBlockedIds(
  itemIds: readonly string[],
  depositByRequest: ReadonlyMap<string, DepositState>,
): string[] {
  return itemIds.filter((id) => {
    const state = depositByRequest.get(id);
    return state !== undefined && state !== "paid";
  });
}

/**
 * Each approved part request's deposit state, from the job's deposits
 * (public.quote_deposits rows). A request on more than one deposit quote
 * takes the state that blocks ordering, as the SQL gate does (any quote
 * whose deposit is not paid).
 */
export function depositStates(
  deposits: ReadonlyArray<{ state: DepositState; partRequestIds: readonly string[] }>,
): Map<string, DepositState> {
  const map = new Map<string, DepositState>();
  for (const d of deposits) {
    for (const id of d.partRequestIds) {
      const before = map.get(id);
      if (before === undefined || before === "paid") map.set(id, d.state);
    }
  }
  return map;
}

/**
 * D157a: a deposit above 0 needs Stripe on (a deposit nobody can pay online
 * would only hold up indent orders); 0 is always allowed (the RUNBOOK's
 * switch-off order). The refusal's sentence, or null when allowed.
 */
export function depositPercentRefusal(percent: number, stripeOn: boolean): string | null {
  return percent > 0 && !stripeOn
    ? "Set up Stripe first: customers can't pay a deposit until it is."
    : null;
}

/** Settings → Customer payments: what the deposit percent means (D151, D157a). */
export function depositPercentLabel(percent: number): string {
  return percent === 0
    ? "No deposit is asked on indent quotes"
    : `Customers pay ${percent}% of the approved indent parts after answering`;
}

// ---------------------------------------------------------------------------
// Payments and refunds (D153, D155, D159)
// ---------------------------------------------------------------------------

/** A payment row's state in words; a pending one whose Checkout completed is being confirmed. */
export function paymentStatusLabel(payment: {
  status: PaymentStatus;
  checkoutCompletedAt: string | null;
}): string {
  switch (payment.status) {
    case "pending":
      return payment.checkoutCompletedAt ? "Being confirmed" : "Checkout open";
    case "paid":
      return "Paid";
    case "partially_refunded":
      return "Partly refunded";
    case "refunded":
      return "Refunded";
    case "failed":
      return "Payment failed";
    case "expired":
      return "Checkout expired";
  }
}

/**
 * Why Check with Stripe recorded the session but not the payment's
 * PaymentIntent or refunds (R-086): `permission` when Stripe refused the
 * key (401 or 403, stripe_auth_failed: most often the restricted key lacks
 * a permission); `unavailable` when Stripe was not reached or was busy (a
 * network error or timeout, a 409, a 5xx, a 429), which a retry may fix;
 * `error` when Stripe
 * answered but BICII could not use the answer (a 400, a not found, a
 * response BICII could not read), which a retry will not fix.
 */
export type IncompleteCheck = "permission" | "unavailable" | "error";

const INCOMPLETE_CHECK_NOTES: Readonly<Record<IncompleteCheck, string>> = {
  permission:
    "Stripe's payment or its refunds couldn't be read: Stripe refused the key. An admin should check the Stripe key's permissions (RUNBOOK “Stripe: restricted key”).",
  unavailable:
    "Stripe's payment or its refunds couldn't be read: Stripe could not be reached; try again in a few minutes.",
  error:
    "Stripe's payment or its refunds couldn't be read: BICII could not use Stripe's answer. An admin should follow RUNBOOK “Stripe: resolving problems”.",
};

/** The toast's second line for an incomplete Check with Stripe: permissions only when Stripe refused the key. */
export function incompleteCheckNote(kind: IncompleteCheck): string {
  return INCOMPLETE_CHECK_NOTES[kind];
}

export const PAYMENT_STATUS_TONES: Readonly<Record<PaymentStatus, StatusTone>> = {
  pending: "waiting",
  paid: "done",
  partially_refunded: "info",
  refunded: "info",
  failed: "danger",
  expired: "neutral",
};

/**
 * D154 and D161 at the counter: what was paid against a job (online net
 * plus counter money, net_paid) and what is left, formatted, for the line
 * under the job's total and the Collected confirmation, so staff never
 * take the full total from a customer who paid a deposit online or part
 * of the bill at the counter. Null only when nothing is paid (net_paid 0)
 * and nothing is being confirmed by Stripe (processing_online 0), or
 * there are no totals. `source` says where the paid money came from;
 * `online` and `counter` are the two parts when both are above 0.
 * `stillToPay` and `paidAhead` are null once the job is closed or outside
 * SGD (work_order_payment_totals); `paidAhead` is null when 0.
 * `moreThanBill` (R-082) is what a collected or cancelled job holds above
 * its bill (held_over_total), null while the job is open or when 0.
 * `processing` is Stripe money whose Checkout completed while Stripe still
 * confirms it (never in net_paid or the balance), null when 0.
 * `nothingLeft` is true when balance_due is exactly 0 and nothing is paid
 * ahead, so Collected says "take nothing" rather than "Take only $0.00.".
 * Formatting and comparisons only: every figure is Postgres's.
 */
export function paidSummary(
  totals: {
    currency: string;
    netPaid: string;
    netPaidOnline: string;
    paidAtCounter: string;
    processingOnline: string;
    balanceDue: string | null;
    paidAhead: string | null;
    heldOverTotal?: string | null;
  } | null,
): PaidSummary | null {
  if (!totals) return null;
  const nonZero = (v: string | null | undefined): v is string => v != null && Number(v) !== 0;
  if (!nonZero(totals.netPaid) && !nonZero(totals.processingOnline)) return null;
  const money = (v: string) => formatMoney(v, totals.currency);
  const online = nonZero(totals.netPaidOnline);
  const counter = nonZero(totals.paidAtCounter);
  const held = totals.heldOverTotal ?? null;
  return {
    paid: nonZero(totals.netPaid) ? money(totals.netPaid) : null,
    source: online && counter ? "both" : counter ? "counter" : "online",
    online: online && counter ? money(totals.netPaidOnline) : null,
    counter: online && counter ? money(totals.paidAtCounter) : null,
    stillToPay: totals.balanceDue === null ? null : money(totals.balanceDue),
    paidAhead: nonZero(totals.paidAhead) ? money(totals.paidAhead) : null,
    moreThanBill: totals.balanceDue === null && nonZero(held) ? money(held) : null,
    processing: nonZero(totals.processingOnline) ? money(totals.processingOnline) : null,
    // A comparison of Postgres's figures, like nonZero: no arithmetic.
    nothingLeft:
      totals.balanceDue !== null && Number(totals.balanceDue) === 0 && !nonZero(totals.paidAhead),
  };
}

export type PaidSummary = {
  /** net_paid formatted; null when 0 (only Stripe money being confirmed). */
  paid: string | null;
  /** Where the paid money came from: online (Stripe), at the counter, or both. */
  source: "online" | "counter" | "both";
  /** The online part, only when both parts are above 0. */
  online: string | null;
  /** The counter part, only when both parts are above 0. */
  counter: string | null;
  stillToPay: string | null;
  paidAhead: string | null;
  moreThanBill: string | null;
  /** Stripe money still being confirmed (processing_online), null when 0. */
  processing: string | null;
  /** balance_due is 0 and nothing is paid ahead: nothing is left to take. */
  nothingLeft?: boolean;
};

/** "online", "at the counter", or "($A online, $B at the counter)", for "$X was paid …". */
function paidHow(summary: PaidSummary): string {
  if (summary.source === "both")
    return `(${summary.online} online, ${summary.counter} at the counter)`;
  return summary.source === "counter" ? "at the counter" : "online";
}

/** The sentence for Stripe money still being confirmed (D159b; PayNow). */
export function processingSentence(amount: string): string {
  return `${amount} paid online is being confirmed by Stripe; don't take it again.`;
}

/**
 * The Collected confirmation's sentences, on both paths (the Collected
 * button and Change status), before "Collected is final" (D154, D161):
 * what was paid, online, at the counter or both, and what to take, or that
 * nothing is left to take.
 *
 * While Stripe is still confirming a payment (processing_online, PayNow)
 * it names no amount to take: that money is never in net_paid or
 * balance_due, so what is still to pay may already be covered by it, and
 * taking it at the counter would charge the customer twice. It says to
 * press Check with Stripe first instead; only when nothing is left to take
 * anyway (paid ahead, or nothing left) does it keep that sentence and add
 * the plain "being confirmed" one. Approved indent items never reach it:
 * they are fitted or cancelled first (D149b, the settle checklist).
 */
export function collectedNotes(summary: PaidSummary | null): string[] {
  if (!summary) return [];
  const notes: string[] = [];
  const takeNothing = summary.paidAhead
    ? `That is ${summary.paidAhead} more than the job total; take nothing more.`
    : summary.nothingLeft
      ? "Nothing is left to pay; take nothing."
      : null;
  if (summary.paid) {
    const paid = `${summary.paid} was paid ${paidHow(summary)}.`;
    const rest =
      takeNothing ??
      (summary.processing
        ? null
        : summary.stillToPay
          ? `Take only ${summary.stillToPay}.`
          : "Take only what is left of the job total.");
    notes.push(rest ? `${paid} ${rest}` : paid);
  }
  if (summary.processing) {
    notes.push(
      takeNothing
        ? processingSentence(summary.processing)
        : `Stripe is still confirming ${summary.processing} paid online, so ${
            summary.stillToPay
              ? `${summary.stillToPay} still to pay`
              : "what is left of the job total"
          } may already be covered. Press Check with Stripe before taking anything.`,
    );
  }
  return notes;
}

/**
 * The Customer payments card on a collected or cancelled job that holds
 * more than its bill (R-082, held_over_total); null otherwise. It names
 * where the money came from and how each part is corrected: online money
 * is refunded in Stripe; counter money given back is recorded by an admin
 * (D161d).
 */
export function heldOverSentence(totals: {
  currency: string;
  jobTotal: string;
  balanceDue: string | null;
  heldOverTotal?: string | null;
  netPaidOnline?: string;
  paidAtCounter?: string;
}): string | null {
  const held = totals.heldOverTotal ?? null;
  if (totals.balanceDue !== null || held === null || Number(held) === 0) return null;
  const money = (v: string) => formatMoney(v, totals.currency);
  const online = Number(totals.netPaidOnline ?? "0") !== 0;
  const counter = Number(totals.paidAtCounter ?? "0") !== 0;
  const above = `above this job's bill of ${money(totals.jobTotal)}`;
  if (counter && online) {
    return `${money(held)} was paid ${above}. Refund the online part in Stripe, or an admin records counter money given back; or agree with the customer how it counts.`;
  }
  if (counter) {
    return `${money(held)} was paid at the counter ${above}. If it is given back, an admin records it as given back; or agree with the customer how it counts.`;
  }
  return `${money(held)} was paid online ${above}. Refund it in Stripe if it is due back, or agree with the customer how it counts.`;
}

/**
 * Whether the Customer payments card shows its totals (Phase 14 step 3,
 * D161): work_order_payment_totals has a row for every job since
 * 20261014001300, so the totals show only once the job has a Stripe payment
 * (any attempt, as before), a counter payment (voided ones too: what is
 * left to pay is still worth reading), Stripe money being confirmed, or a
 * live payment link. Reads Postgres's figures; nothing is computed.
 */
export function showsPaymentTotals(payments: {
  payments: readonly unknown[];
  counterPayments?: readonly unknown[];
  link?: unknown;
  totals: { paidAtCounter: string; processingOnline?: string } | null;
}): boolean {
  if (!payments.totals) return false;
  return (
    payments.payments.length > 0 ||
    (payments.counterPayments?.length ?? 0) > 0 ||
    Number(payments.totals.paidAtCounter) !== 0 ||
    Number(payments.totals.processingOnline ?? "0") !== 0 ||
    (payments.link ?? null) !== null
  );
}

/**
 * Whether the job page renders the Customer payments card (step3-critique
 * C15): when there is anything to show (a deposit, a Stripe payment, a
 * counter payment) or a control applies (Send payment link; an admin's
 * Record counter payment on a job that is not cancelled).
 */
export function showsPaymentsCard(input: {
  deposits: number;
  payments: number;
  counterPayments: number;
  canSendLink: boolean;
  canRecordCounter: boolean;
  jobStatus: WorkOrderStatus;
}): boolean {
  return (
    input.deposits > 0 ||
    input.payments > 0 ||
    input.counterPayments > 0 ||
    input.canSendLink ||
    (input.canRecordCounter && input.jobStatus !== "cancelled")
  );
}

/**
 * A deposit's badge on the card (C15): a deposit still due once the job
 * is no longer open is not asked online any more (D158), and the balance
 * already includes its parts, so it reads "Part of the balance" rather than
 * "Deposit due"; every other state reads as DEPOSIT_STATE_LABELS.
 */
export function depositBadge(
  state: DepositState,
  jobOpen: boolean,
): { label: string; tone: StatusTone } {
  if (state === "due" && !jobOpen) return { label: "Part of the balance", tone: "neutral" };
  return { label: DEPOSIT_STATE_LABELS[state], tone: DEPOSIT_STATE_TONES[state] };
}

/** A Stripe PaymentIntent id, as config.ts's PAYMENT_INTENT_ID (that module is server-only). */
const PAYMENT_INTENT_ID = /^pi_[A-Za-z0-9_]{1,250}$/;

/**
 * The payment in Stripe's Dashboard, for admins and managers ("Open in
 * Stripe"); null when the id is not a PaymentIntent id.
 */
export function stripeDashboardHref(
  paymentIntentId: string | null,
  livemode: boolean,
): string | null {
  if (!paymentIntentId || !PAYMENT_INTENT_ID.test(paymentIntentId)) return null;
  return `https://dashboard.stripe.com/${livemode ? "" : "test/"}payments/${paymentIntentId}`;
}

export const REFUND_STATUS_LABELS: Readonly<Record<StripeRefundStatus, string>> = {
  pending: "Refund pending",
  requires_action: "Refund waiting on the customer",
  succeeded: "Refunded",
  failed: "Refund failed",
  canceled: "Refund cancelled",
};

// ---------------------------------------------------------------------------
// Counter payments (D161) and payment links (D156)
// ---------------------------------------------------------------------------

export type CounterMethod = Enums["counter_payment_method"];
export type CounterVoidKind = Enums["counter_void_kind"];

/** How the shop took the money (D161b), in the order the sheet offers them. */
export const COUNTER_METHODS: readonly CounterMethod[] =
  Constants.public.Enums.counter_payment_method;
export const COUNTER_VOID_KINDS: readonly CounterVoidKind[] =
  Constants.public.Enums.counter_void_kind;

/**
 * The largest counter payment (counter_payments_amount_check), for the
 * sheet's own check and the action's: a bound, compared, never computed.
 */
export const COUNTER_MAX = "999999.99";

/** A method as a label: the sheet's choices, the card's rows and the timeline. */
export const COUNTER_METHOD_LABELS: Readonly<Record<CounterMethod, string>> = {
  cash: "Cash",
  card: "Card",
  paynow: "PayNow",
  bank_transfer: "Bank transfer",
  other: "Other",
};

/** A method inside a sentence: "Record $3,800.00 cash…", "… by card…". */
const COUNTER_METHOD_PHRASES: Readonly<Record<CounterMethod, string>> = {
  cash: "cash",
  card: "by card",
  paynow: "by PayNow",
  bank_transfer: "by bank transfer",
  other: "paid another way",
};

/** Why a counter payment no longer counts (D161d). */
export const COUNTER_VOID_LABELS: Readonly<Record<CounterVoidKind, string>> = {
  recorded_in_error: "Recorded in error",
  given_back: "Given back",
};

/**
 * The counter payment sheet's commit (step3-critique C19): the first step
 * repeats the amount and the method ("Record $3,800.00 cash…"), the
 * confirm the amount ("Record $3,800.00"). Null labels while the amount is
 * not a valid one.
 */
export function counterCommitLabels(
  amount: string | null,
  method: CounterMethod,
): { start: string; confirm: string } {
  if (!amount) return { start: "Record payment…", confirm: "Record payment" };
  return {
    start: `Record ${amount} ${COUNTER_METHOD_PHRASES[method]}…`,
    confirm: `Record ${amount}`,
  };
}

/** What a deposit the sheet can record looks like (public.quote_deposits). */
type DepositChoice = {
  quoteId: string;
  state: DepositState;
  amount: string;
  currency: string;
  answeredAt: string | null;
};

/**
 * The deposits a counter payment can settle (D161f; C19): each quote whose
 * deposit is due, or refunded in Stripe, on any job that is not cancelled.
 * Never paid, processing or none (record_counter_payment refuses them).
 */
export function counterDepositChoices<T extends DepositChoice>(
  deposits: readonly T[],
  jobStatus: WorkOrderStatus,
): T[] {
  if (jobStatus === "cancelled") return [];
  return deposits.filter((d) => d.state === "due" || d.state === "refunded");
}

/** "Record the $300.00 deposit for the quote answered 12 Oct 2026". */
export function counterDepositLabel(d: DepositChoice): string {
  const answered = d.answeredAt ? ` answered ${formatDate(d.answeredAt)}` : "";
  return `Record the ${formatMoney(d.amount, d.currency)} deposit for the quote${answered}`;
}

/**
 * "Towards the bill" starts at what is left to pay (balance_due) when that
 * is known and above 0, else empty (C19).
 */
export function counterPrefill(balanceDue: string | null): string {
  return balanceDue !== null && Number(balanceDue) > 0 ? balanceDue : "";
}

/** A job status that is not open: completed or ready for collection (the bill is final). */
const BILL_FINAL: ReadonlySet<WorkOrderStatus> = new Set(["completed", "ready_for_collection"]);

/**
 * The counter payment sheet's warnings (step3-critique C19). They never
 * refuse: the database decides. `amount` is what the admin typed (any
 * text), `balanceDue` and `jobTotal` Postgres's figures; the comparison is
 * a Decimal one on display only, and the difference shown is formatted
 * from it (nothing is stored or sent from it).
 */
export function counterWarnings(input: {
  choice: "deposit" | "bill";
  amount: string;
  currency: string;
  jobStatus: WorkOrderStatus;
  /** True for an open job (D15's open statuses). */
  jobOpen: boolean;
  /** A deposit the admin could record instead (the first due one), if any. */
  dueDeposit: { amount: string; currency: string } | null;
  balanceDue: string | null;
  jobTotal: string | null;
}): { warnings: string[]; info: string | null } {
  const warnings: string[] = [];
  let info: string | null = null;
  const final = BILL_FINAL.has(input.jobStatus);
  if (input.dueDeposit && input.choice === "bill" && input.jobOpen) {
    warnings.push(
      `The customer's quote page still asks the full ${formatMoney(input.dueDeposit.amount, input.dueDeposit.currency)} deposit online. Record the deposit instead if this money is for it.`,
    );
  }
  if (input.dueDeposit && input.choice === "bill" && final) {
    warnings.push(
      "The deposit stays 'due' on this card, and is asked online again if the job is reopened, unless you record it as the deposit.",
    );
  }
  const typed =
    input.choice === "bill" ? parseMoney(input.amount, { currency: input.currency }) : null;
  if (typed && typed.greaterThan(0) && input.balanceDue !== null) {
    const due = toDecimal(input.balanceDue);
    if (final && typed.greaterThan(due)) {
      warnings.push(
        `This is ${formatMoney(typed.minus(due), input.currency)} more than still to pay; it will show as paid above the bill.`,
      );
    } else if (input.jobOpen && typed.greaterThan(due)) {
      info = `More than is left to pay on the job so far (${formatMoney(due, input.currency)} of a job total of ${formatMoney(input.jobTotal ?? "0", input.currency)}). Indent parts join the job total when they're fitted.`;
    }
  }
  return { warnings, info };
}

/** How far back "Paid on" goes: record_counter_payment refuses more than 30 days (D161h). */
export const COUNTER_DAYS_BACK = 29;

/**
 * The days the counter sheet's "Paid on" allows: today back to the later
 * of 29 days ago and the day of `notBefore` (the job's check-in; for a
 * deposit the quote's answer), so the RPC's time rules are never hit by
 * a day the picker offered.
 */
export function counterDayRange(
  today: string,
  notBefore: string | null,
): { min: string; max: string } {
  const floor = shiftShopDay(today, -COUNTER_DAYS_BACK);
  const start = notBefore ? shopDateKey(notBefore) : floor;
  const min = start > floor ? start : floor;
  return { min: min > today ? today : min, max: today };
}

/**
 * The received_at the sheet sends for the day picked: null for today (the
 * database stamps now()); otherwise noon Singapore time on that day, as
 * settlements do, or, when that is earlier than `notBefore` on the same
 * day, just after `notBefore` (a millisecond up, since Postgres keeps
 * microseconds), so a payment taken on the check-in day is never "before
 * the job". Fixed by the day, so a retry sends the same instant.
 */
export function counterReceivedAt(
  day: string,
  today: string,
  notBefore: string | null,
): string | null {
  if (day === today) return null;
  const noon = shopDayToDate(day).getTime();
  const floor = notBefore ? Date.parse(notBefore) : Number.NaN;
  if (Number.isFinite(floor) && floor >= noon && shopDateKey(new Date(floor)) === day) {
    return new Date(floor + 1).toISOString();
  }
  return new Date(noon).toISOString();
}

/**
 * After a counter payment (D161g) the action expires the job's open
 * Checkout sessions it made wrong (expireOpenCheckouts). What the admin is
 * told, or null when every one was expired: one paid meanwhile, or one
 * that may still be payable (Stripe off or not reached, which also leaves
 * fewer expired than were open).
 */
export function counterCheckoutNote(
  result: { expired: number; paid: number; failed: number },
  openCheckouts: number,
): string | null {
  if (result.paid > 0) {
    return "An online payment for this job has just gone through; refund it in Stripe or record the counter money as given back.";
  }
  if (result.failed > 0 || result.expired + result.paid < openCheckouts) {
    return "An online payment page may still be open for this job; use Check with Stripe.";
  }
  return null;
}

/**
 * After a link replaced another (D156h), the old link's open Checkout is
 * expired too. What staff are told, or null when nothing was open or it
 * was expired.
 */
export function replacedLinkCheckoutNote(result: {
  expired: number;
  paid: number;
  failed: number;
}): string | null {
  if (result.paid > 0) {
    return "A payment on the earlier link has just gone through. The new link asks only what is left; check the card.";
  }
  if (result.failed > 0) {
    return "The earlier link's payment page may still be open; use Check with Stripe.";
  }
  return null;
}

/** The pay page's path for a link token (D156f). */
export const payPath = (token: string) => `/pay/${token}`;

/** How long a payment link works (D156c): 1 to 30 days, 7 by default. */
export const LINK_DAYS = { min: 1, max: 30, default: 7 } as const;

const CHANNEL_WORDS: Readonly<Record<string, string>> = {
  whatsapp: " by WhatsApp",
  email: " by email",
  link: "",
};

/**
 * The card's line for the live link (D156): "Payment link sent 17 Oct
 * 2026 by WhatsApp ($180.00 when sent), valid until 24 Oct 2026." or, once
 * past its expiry, "…, expired 24 Oct 2026.". `now` is the page's clock.
 */
export function linkLine(
  link: { channel: string; sentAt: string; expiresAt: string; amountAtSend: string },
  currency: string,
  now: Date = new Date(),
): string {
  const head = `Payment link sent ${formatDate(link.sentAt)}${CHANNEL_WORDS[link.channel] ?? ""} (${formatMoney(link.amountAtSend, currency)} when sent)`;
  return Date.parse(link.expiresAt) <= now.getTime()
    ? `${head}, expired ${formatDate(link.expiresAt)}.`
    : `${head}, valid until ${formatDate(link.expiresAt)}.`;
}

/**
 * Whether "Send payment link" applies (D156a, D156e, C15): Stripe on, the
 * job completed or ready for collection, in SGD, at least S$0.50 left to
 * pay and no Stripe payment being confirmed. The RPC checks each again;
 * this only hides a control that would be refused. The S$0.50 test is a
 * comparison of Postgres's figure, not arithmetic.
 */
export function canSendLink(input: {
  stripeOn: boolean;
  jobStatus: WorkOrderStatus;
  currency: string;
  balanceDue: string | null;
  processingOnline: string;
}): boolean {
  return (
    input.stripeOn &&
    BILL_FINAL.has(input.jobStatus) &&
    input.currency === "SGD" &&
    input.balanceDue !== null &&
    toDecimal(input.balanceDue).greaterThanOrEqualTo("0.50") &&
    Number(input.processingOnline) === 0
  );
}

/**
 * The message a payment link is sent with (D156): who it is for, the job,
 * what was left to pay when it was sent, and the link.
 */
export function balanceMessage({
  firstName,
  jobNumber,
  amount,
  link,
  days,
}: {
  firstName: string | null;
  jobNumber: string;
  /** Formatted, as send_balance_link returned it. */
  amount: string;
  link: string;
  days: number;
}): string {
  const hello = firstName ? `Hi ${firstName},` : "Hi,";
  return [
    `${hello} here is the bill for your bike (job ${jobNumber}) from BICII: ${amount} is left to pay.`,
    `You can pay it securely by card or PayNow here: ${link}`,
    `The link works for ${days} ${days === 1 ? "day" : "days"}.`,
  ].join("\n");
}

/** The payment link email (D156): the same words as the WhatsApp message, with a button. */
export function balanceEmail(input: {
  firstName: string | null;
  jobNumber: string;
  amount: string;
  link: string;
  days: number;
}): { subject: string; text: string; html: string } {
  const text = balanceMessage(input);
  const hello = input.firstName ? `Hi ${escapeHtml(input.firstName)},` : "Hi,";
  const link = escapeHtml(input.link);
  const html = [
    `<p>${hello} here is the bill for your bike (job ${escapeHtml(input.jobNumber)}) from BICII: ${escapeHtml(input.amount)} is left to pay.</p>`,
    `<p><a href="${link}" style="display:inline-block;padding:12px 20px;border-radius:999px;background:#111;color:#fff;text-decoration:none;font-weight:bold">See your bill and pay</a></p>`,
    `<p>Or open this link: <a href="${link}">${link}</a></p>`,
    `<p>You can pay securely by card or PayNow. The link works for ${input.days} ${input.days === 1 ? "day" : "days"}.</p>`,
  ].join("\n");
  return { subject: `Your bill from BICII (job ${input.jobNumber})`, text, html };
}

// ---------------------------------------------------------------------------
// Whether Stripe is on (D157)
// ---------------------------------------------------------------------------

/**
 * Why Stripe is off, in the order stripeConfig checks them
 * (src/lib/integrations/stripe/client.ts; D157b, c). Each names a
 * configuration problem, never a value.
 */
export const STRIPE_OFF_REASON_CODES = [
  "preview",
  "not_configured",
  "key_invalid",
  "test_key_in_production",
  "live_key_outside_production",
  "webhook_secret_missing",
  "webhook_secret_invalid",
  "service_role_missing",
  "origin_invalid",
] as const;

export type StripeOffReason = (typeof STRIPE_OFF_REASON_CODES)[number];

/**
 * Settings → Customer payments: each reason as a sentence an admin can act
 * on (RUNBOOK "Stripe: environment variables and fake mode"). Variables are
 * named; their values never are.
 */
export const STRIPE_OFF_REASONS: Readonly<Record<StripeOffReason, string>> = {
  preview:
    "This is a Vercel Preview deployment. Stripe never runs in Preview: there is no staging database.",
  not_configured:
    "Customers can't pay online yet. Follow RUNBOOK “Stripe payments”: add STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and ADMIN_ORIGIN to Vercel (Production).",
  key_invalid:
    "STRIPE_SECRET_KEY isn't a Stripe secret or restricted key (sk_ or rk_). Paste the key again; a publishable pk_ key is the wrong one.",
  test_key_in_production: "STRIPE_SECRET_KEY is a test key; Production takes a live key only.",
  live_key_outside_production:
    "STRIPE_SECRET_KEY is a live key, but this isn't Production. Use a test key here; the live key belongs in Production only.",
  webhook_secret_missing:
    "STRIPE_WEBHOOK_SECRET isn't set. Copy the signing secret from the webhook endpoint in Stripe's Dashboard.",
  webhook_secret_invalid:
    "STRIPE_WEBHOOK_SECRET isn't a signing secret (whsec_). Copy it again from the webhook endpoint, not the endpoint's id.",
  service_role_missing:
    "SUPABASE_SERVICE_ROLE_KEY isn't set, so BICII can't record payments. Set it in Vercel (sign-in needs it too).",
  origin_invalid:
    "ADMIN_ORIGIN isn't this Admin's https address with no path (http only for localhost, and never localhost in Production). Set it to https://<admin host>.",
};

export type StripeConnectionSummary = {
  state: "on" | "off";
  mode: "live" | "test" | "fake" | null;
  reason: StripeOffReason | null;
};

/** One line for Settings: Live, Test mode, the fake, or Off with the reason. */
export function stripeConnectionLabel(c: StripeConnectionSummary): string {
  if (c.state === "on") {
    if (c.mode === "live") return "Live";
    if (c.mode === "test") return "Test mode";
    return "Fake Stripe (development and tests only)";
  }
  return `Off: ${STRIPE_OFF_REASONS[c.reason ?? "not_configured"]}`;
}

// ---------------------------------------------------------------------------
// Stripe deliveries (Settings → Customer payments, admins only, D86)
// ---------------------------------------------------------------------------

export const STRIPE_EVENT_STATUS_LABELS: Readonly<Record<StripeEventStatus, string>> = {
  received: "Being recorded",
  applied: "Applied",
  ignored: "Nothing to change",
  needs_attention: "Needs attention",
  rejected: "Rejected",
};

export const STRIPE_EVENT_STATUS_TONES: Readonly<Record<StripeEventStatus, StatusTone>> = {
  received: "neutral",
  applied: "done",
  ignored: "neutral",
  needs_attention: "danger",
  rejected: "danger",
};

/** Why a delivery was rejected (stored without its body, D88). */
export const STRIPE_REJECTION_LABELS: Readonly<Record<StripeRejectionReason, string>> = {
  stripe_off: "Stripe was off",
  signature_invalid: "Signature didn't match",
  signature_expired: "Signature too old",
  body_not_json: "Body wasn't JSON",
  event_shape_invalid: "Not a Stripe event",
  livemode_mismatch: "Wrong mode (test or live)",
  not_recorded: "Couldn't be recorded; Stripe retries",
};

/**
 * What applying an event or read did (stripe_events.outcome; the values
 * stripe_events_outcome_check allows).
 */
const STRIPE_OUTCOME_LABELS: Readonly<Record<string, string>> = {
  payment_paid: "Payment recorded",
  paid_amount_mismatch: "Paid, amount differs",
  paid_after_failed: "Paid after failing",
  paid_after_expired: "Paid after expiring",
  payment_processing: "Payment being confirmed",
  payment_failed: "Payment failed",
  payment_expired: "Checkout expired",
  already_paid: "Already paid",
  already_processing: "Already being confirmed",
  already_failed: "Already failed",
  already_expired: "Already expired",
  still_open: "Checkout still open",
  stale: "Older than what's recorded",
  refund_recorded: "Refund recorded",
  refund_unchanged: "Refund unchanged",
  refund_unmatched: "Refund of an unknown payment",
  not_ours: "Not a BICII payment",
  type_not_handled: "Event type not used",
  payment_not_found: "Unknown payment",
  session_mismatch: "Checkout didn't match",
  livemode_mismatch: "Wrong mode (test or live)",
  currency_mismatch: "Other currency",
  object_invalid: "Unreadable data",
  unexpected_payment_status: "Unexpected payment status",
  read_mismatch: "Read didn't match",
};

/** An outcome in words; an unknown one shows as it is stored. */
export function stripeOutcomeLabel(outcome: string): string {
  return STRIPE_OUTCOME_LABELS[outcome] ?? outcome;
}
