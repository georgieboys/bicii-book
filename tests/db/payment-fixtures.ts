/**
 * Payment fixtures for Phase 14 step 3 (balance links D156, counter
 * payments D161, payment reports D154): Stripe deliveries through
 * public.record_stripe_event, the deposit and balance Checkout RPCs as the
 * service role, counter payments as the admin, and balance links. The same
 * helpers as counter-payments.test.ts and stripe-payments.test.ts (which
 * keep their own copies, unchanged); Stripe objects come from
 * tests/fixtures/stripe.ts. Each helper acts as the role it names and
 * leaves `tx` acting as it; every Stripe id is fresh (tag()).
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";

import type pg from "pg";
import { expect } from "vitest";

import { LOCATION, STAFF } from "../fixtures/ids";
import { sessionObject, stripeEvent, stripeWebhookHeaders } from "../fixtures/stripe";
import { actAs, scalar, type Claims } from "./harness";
import { answerAll, fit, quoted } from "./indent-fixtures";
import { ADMIN, addStock, readAsOwner } from "./inventory-fixtures";
import { ownerMode } from "./workshop-fixtures";

export const SERVICE: Claims = { role: "service_role" };
export const ANON: Claims = { role: "anon" };

/** A fresh suffix for Stripe ids (letters and digits only). */
export const tag = () => randomUUID().replace(/-/g, "").slice(0, 24);

const sha256hex = (raw: string) => createHash("sha256").update(raw, "utf8").digest("hex");

// ---------------------------------------------------------------------------
// Stripe deliveries
// ---------------------------------------------------------------------------

export type EventResult = { event_status: string; outcome: string | null };

/** A verified webhook of `type` carrying `object`, as the service role. */
export async function deliver(
  tx: pg.Client,
  type: string,
  object: Record<string, unknown>,
  created?: number,
): Promise<EventResult> {
  await actAs(tx, SERVICE);
  const raw = JSON.stringify(stripeEvent({ id: `evt_${tag()}`, type, object, created }));
  const { rows } = await tx.query<EventResult>(
    `select event_status::text, outcome
       from public.record_stripe_event($1::jsonb, $2::jsonb, $3, $4, null, $5)`,
    [
      raw,
      JSON.stringify(stripeWebhookHeaders({ raw })),
      sha256hex(raw),
      Buffer.byteLength(raw),
      `corr-${tag()}`,
    ],
  );
  return rows[0];
}

/** A payment BICII asked Stripe for: its id, session, job, quote (null for a balance), cents and a PaymentIntent id to pay it with. */
export type Pay = {
  paymentId: string;
  sessionId: string;
  workOrderId: string;
  quoteId: string | null;
  cents: number;
  pi: string;
};

/** The payment's Checkout Session as Stripe sends it once paid (override any field). */
export const paidSession = (p: Pay, o: Partial<Parameters<typeof sessionObject>[0]> = {}) =>
  sessionObject({
    id: p.sessionId,
    paymentId: p.paymentId,
    workOrderId: p.workOrderId,
    quoteId: p.quoteId,
    kind: p.quoteId ? "deposit" : "balance",
    amountCents: p.cents,
    paymentIntent: p.pi,
    ...o,
  });

/** Stripe reports the payment paid. */
export const pay = (tx: pg.Client, p: Pay, o: Partial<Parameters<typeof sessionObject>[0]> = {}) =>
  deliver(tx, "checkout.session.completed", paidSession(p, o));

/** Checkout completed but Stripe still confirming (PayNow): pending with checkout_completed_at. */
export const processing = (tx: pg.Client, p: Pay) =>
  pay(tx, p, { paymentStatus: "unpaid", status: "complete" });

/** Stripe reports the session expired (what the app's expire and read records). */
export const expire = (tx: pg.Client, p: Pay) =>
  deliver(
    tx,
    "checkout.session.expired",
    paidSession(p, { status: "expired", paymentStatus: "unpaid", paymentIntent: null }),
  );

// ---------------------------------------------------------------------------
// Deposits (Phase 14 step 2)
// ---------------------------------------------------------------------------

/** Sets the shop's deposit percent as the owner (leaves `tx` as the owner). */
export async function withPercent(tx: pg.Client, percent: number): Promise<void> {
  await ownerMode(tx);
  await tx.query("update public.shop_settings set indent_deposit_percent = $1 where id = 1", [
    percent,
  ]);
}

/** The job's newest quote id (read as the owner). */
export const quoteIdOf = (tx: pg.Client, workOrderId: string) =>
  readAsOwner(tx, () =>
    scalar<string>(
      tx,
      "select id from public.quotes where work_order_id = $1 order by sent_at desc limit 1",
      [workOrderId],
    ),
  );

export type Answered = Awaited<ReturnType<typeof quoted>> & { quoteId: string };

/**
 * quoted() at `percent` (part 2 x 120.00 and a 25.00 service), answered by
 * the link with everything approved: a deposit of 120.00 at 50%. The shop's
 * percent is back to 0 afterwards; acting as ADMIN.
 */
export async function answered(
  tx: pg.Client,
  { percent = 50 }: { percent?: number } = {},
): Promise<Answered> {
  await withPercent(tx, percent);
  const q = await quoted(tx);
  await actAs(tx, ANON);
  await answerAll(tx, q.token);
  const quoteId = await quoteIdOf(tx, q.job.id);
  await withPercent(tx, 0);
  await actAs(tx, ADMIN);
  return { ...q, quoteId };
}

/** Fits the answered quote's part (2 in stock first) and cancels its service: the bill is 240.00. As ADMIN. */
export async function fitPartOnly(tx: pg.Client, d: Answered): Promise<void> {
  await actAs(tx, ADMIN);
  await addStock(tx, d.productId, 2);
  await fit(tx, d.partId, randomUUID(), LOCATION.shopFloor);
  await tx.query("select public.cancel_part_request($1, $2)", [
    d.serviceRequestId,
    "Customer fits it",
  ]);
}

export type DepositPrepared = {
  outcome: string;
  payment_id: string | null;
  quote_id: string | null;
  amount: string | null;
  amount_cents: number | null;
  stripe_checkout_session_id: string | null;
};

/** prepare_deposit_checkout as the service role. */
export async function prepareDeposit(tx: pg.Client, token: string): Promise<DepositPrepared> {
  await actAs(tx, SERVICE);
  const { rows } = await tx.query<DepositPrepared>(
    `select outcome, payment_id, quote_id, amount::text, amount_cents::int, stripe_checkout_session_id
       from public.prepare_deposit_checkout($1)`,
    [token],
  );
  return rows[0];
}

export type CheckoutRecorded = {
  outcome: string;
  payment_id: string | null;
  stripe_checkout_session_id: string | null;
};

/** record_deposit_checkout as the service role. */
export async function recordDeposit(
  tx: pg.Client,
  paymentId: string,
  quoteId: string,
  session: unknown,
): Promise<CheckoutRecorded> {
  await actAs(tx, SERVICE);
  const { rows } = await tx.query<CheckoutRecorded>(
    `select outcome, payment_id, stripe_checkout_session_id
       from public.record_deposit_checkout($1, $2, $3::jsonb)`,
    [paymentId, quoteId, JSON.stringify(session)],
  );
  return rows[0];
}

/** The open Checkout Session Stripe returns for a deposit payment id. */
export const depositSession = (d: Answered, paymentId: string, cents: number) =>
  sessionObject({
    id: `cs_test_${tag()}`,
    paymentId,
    workOrderId: d.job.id,
    quoteId: d.quoteId,
    amountCents: cents,
    status: "open",
    paymentStatus: "unpaid",
  });

/** Starts the deposit's Checkout: prepare (create), then record (created). */
export async function startDepositCheckout(tx: pg.Client, d: Answered): Promise<Pay> {
  const prep = await prepareDeposit(tx, d.token);
  expect(prep.outcome).toBe("create");
  const s = depositSession(d, prep.payment_id!, prep.amount_cents!);
  expect((await recordDeposit(tx, prep.payment_id!, d.quoteId, s)).outcome).toBe("created");
  return {
    paymentId: prep.payment_id!,
    sessionId: s.id as string,
    workOrderId: d.job.id,
    quoteId: d.quoteId,
    cents: prep.amount_cents!,
    pi: `pi_${tag()}`,
  };
}

// ---------------------------------------------------------------------------
// Counter payments (D161)
// ---------------------------------------------------------------------------

/** record_counter_payment as the admin (cash, now); returns its id and open_checkouts. */
export async function recordCounter(
  tx: pg.Client,
  a: { workOrderId: string; amount: string; quoteId?: string | null; id?: string },
): Promise<{ counter_payment_id: string; replayed: boolean; open_checkouts: number }> {
  await actAs(tx, ADMIN);
  const { rows } = await tx.query<{
    counter_payment_id: string;
    replayed: boolean;
    open_checkouts: number;
  }>(
    `select counter_payment_id, replayed, open_checkouts
       from public.record_counter_payment($1, $2, $3, $4, 'cash')`,
    [a.id ?? randomUUID(), a.workOrderId, a.quoteId ?? null, a.amount],
  );
  return rows[0];
}

/** void_counter_payment as the admin. */
export async function voidCounter(
  tx: pg.Client,
  id: string,
  kind: "recorded_in_error" | "given_back" = "recorded_in_error",
  reason = "Typed on the wrong job",
): Promise<void> {
  await actAs(tx, ADMIN);
  await tx.query("select public.void_counter_payment($1, $2::public.counter_void_kind, $3)", [
    id,
    kind,
    reason,
  ]);
}

// ---------------------------------------------------------------------------
// Balance links (D156)
// ---------------------------------------------------------------------------

export type Sent = {
  link_id: string;
  token: string;
  amount: string;
  expires_at: Date;
  replaced_link_id: string | null;
};

/** public.send_balance_link as whoever `tx` is. */
export async function callSend(
  tx: pg.Client,
  a: {
    id?: string | null;
    workOrderId: string | null;
    channel?: string | null;
    days?: number | null;
  },
): Promise<Sent> {
  const { rows } = await tx.query<Sent>(
    `select link_id, token, amount::text, expires_at, replaced_link_id
       from public.send_balance_link($1, $2, $3::public.quote_channel, $4)`,
    [
      a.id === undefined ? randomUUID() : a.id,
      a.workOrderId,
      a.channel === undefined ? "whatsapp" : a.channel,
      a.days === undefined ? 7 : a.days,
    ],
  );
  return rows[0];
}

/** send_balance_link as `claims` (the admin by default). */
export async function sendLink(
  tx: pg.Client,
  workOrderId: string,
  o: { id?: string; channel?: string; days?: number; as?: Claims } = {},
): Promise<Sent> {
  await actAs(tx, o.as ?? ADMIN);
  return callSend(tx, { id: o.id, workOrderId, channel: o.channel, days: o.days });
}

/** A token as send_balance_link makes one: 32 random bytes, base64url, 43 characters. */
export const newToken = () => randomBytes(32).toString("base64url");

/**
 * A balance link inserted as the owner (the guard covers UPDATE and DELETE
 * only), for states send_balance_link never makes: a link already past its
 * expiry, or a live link on a job that is not completed or ready. Leaves
 * `tx` as the owner; returns its id and token.
 */
export async function ownerLink(
  tx: pg.Client,
  workOrderId: string,
  { expiresIn = "7 days", amount = "10.00" }: { expiresIn?: string; amount?: string } = {},
): Promise<{ linkId: string; token: string }> {
  await ownerMode(tx);
  const linkId = randomUUID();
  const token = newToken();
  await tx.query(
    `insert into public.balance_links
       (id, work_order_id, token_hash, channel, valid_days, expires_at, amount_at_send, sent_by)
     values ($1, $2, sha256(convert_to($3, 'UTF8')), 'link', 7, clock_timestamp() + $4::interval, $5, $6)`,
    [linkId, workOrderId, token, expiresIn, amount, STAFF.admin],
  );
  return { linkId, token };
}

/** The pay page's data for `token`, as anon. */
export async function balancePage(
  tx: pg.Client,
  token: string | null,
): Promise<Record<string, unknown> | null> {
  await actAs(tx, ANON);
  return scalar<Record<string, unknown> | null>(tx, "select public.balance_by_token($1)", [token]);
}

export type BalancePrepared = {
  outcome: string;
  payment_id: string | null;
  work_order_id: string;
  link_id: string;
  job_number: string;
  amount: string | null;
  amount_cents: number | null;
  currency: string | null;
  stripe_checkout_session_id: string | null;
  expires_at: number | null;
};

/** prepare_balance_checkout as the service role. */
export async function prepareBalance(tx: pg.Client, token: string): Promise<BalancePrepared> {
  await actAs(tx, SERVICE);
  const { rows } = await tx.query<BalancePrepared>(
    `select outcome, payment_id, work_order_id, link_id, job_number, amount::text,
            amount_cents::int, currency::text, stripe_checkout_session_id, expires_at::int
       from public.prepare_balance_checkout($1)`,
    [token],
  );
  return rows[0];
}

/** record_balance_checkout as whoever `tx` is. */
export async function callRecordBalance(
  tx: pg.Client,
  paymentId: string | null,
  linkId: string | null,
  cents: number | null,
  session: unknown,
): Promise<CheckoutRecorded> {
  const { rows } = await tx.query<CheckoutRecorded>(
    `select outcome, payment_id, stripe_checkout_session_id
       from public.record_balance_checkout($1, $2, $3, $4::jsonb)`,
    [paymentId, linkId, cents, session === null ? null : JSON.stringify(session)],
  );
  return rows[0];
}

/** record_balance_checkout as the service role. */
export async function recordBalance(
  tx: pg.Client,
  paymentId: string,
  linkId: string,
  cents: number,
  session: unknown,
): Promise<CheckoutRecorded> {
  await actAs(tx, SERVICE);
  return callRecordBalance(tx, paymentId, linkId, cents, session);
}

/** The open Checkout Session Stripe returns for a balance payment id (override any field). */
export const balanceSession = (
  a: { paymentId: string; workOrderId: string; cents: number; expiresAt?: number | null },
  o: Partial<Parameters<typeof sessionObject>[0]> = {},
) =>
  sessionObject({
    id: `cs_test_${tag()}`,
    paymentId: a.paymentId,
    workOrderId: a.workOrderId,
    quoteId: null,
    kind: "balance",
    amountCents: a.cents,
    status: "open",
    paymentStatus: "unpaid",
    ...(a.expiresAt ? { expiresAt: a.expiresAt } : {}),
    ...o,
  });

/** Pay on the link: prepare (create), then record (created). Returns the payment and its link. */
export async function startBalanceCheckout(
  tx: pg.Client,
  token: string,
): Promise<Pay & { linkId: string; amount: string }> {
  const prep = await prepareBalance(tx, token);
  expect(prep.outcome).toBe("create");
  const s = balanceSession({
    paymentId: prep.payment_id!,
    workOrderId: prep.work_order_id,
    cents: prep.amount_cents!,
    expiresAt: prep.expires_at,
  });
  const recorded = await recordBalance(tx, prep.payment_id!, prep.link_id, prep.amount_cents!, s);
  expect(recorded.outcome).toBe("created");
  return {
    paymentId: prep.payment_id!,
    sessionId: s.id as string,
    workOrderId: prep.work_order_id,
    quoteId: null,
    cents: prep.amount_cents!,
    pi: `pi_${tag()}`,
    linkId: prep.link_id,
    amount: prep.amount!,
  };
}

/**
 * A pending balance payment inserted as the owner (payments_guard allows a
 * pending insert), optionally for a link, with its session expiring after
 * `expiresIn` (negative: already past). Leaves `tx` as the owner.
 */
export async function ownerBalancePayment(
  tx: pg.Client,
  workOrderId: string,
  {
    amount = "50.00",
    expiresIn = "1 hour",
    linkId = null,
  }: {
    amount?: string;
    expiresIn?: string;
    linkId?: string | null;
  } = {},
): Promise<Pay> {
  await ownerMode(tx);
  const id = randomUUID();
  const sessionId = `cs_test_${tag()}`;
  await tx.query(
    `insert into public.payments
       (id, work_order_id, quote_id, kind, amount, stripe_checkout_session_id,
        stripe_session_expires_at, livemode, balance_link_id)
     values ($1, $2, null, 'balance', $3, $4, clock_timestamp() + $5::interval, false, $6)`,
    [id, workOrderId, amount, sessionId, expiresIn, linkId],
  );
  return {
    paymentId: id,
    sessionId,
    workOrderId,
    quoteId: null,
    cents: Math.round(Number(amount) * 100),
    pi: `pi_${tag()}`,
  };
}

export type Totals = {
  job_total: string;
  net_paid: string;
  balance_due: string | null;
  paid_ahead: string | null;
};

/** The job's work_order_payment_totals (read as the owner). */
export const paymentTotals = (tx: pg.Client, workOrderId: string) =>
  readAsOwner(tx, async () => {
    const { rows } = await tx.query<Totals>(
      `select job_total::text, net_paid::text, balance_due::text, paid_ahead::text
         from public.work_order_payment_totals where work_order_id = $1`,
      [workOrderId],
    );
    return rows[0];
  });
