/**
 * Counter payments, Phase 14 step 3 (PLAN D161, its build defaults
 * D161a-j; ADR-025; DATA-MODEL §5, §15, §16, §19): an admin records money
 * the shop took at the counter on a job, kept out of public.payments so
 * Stripe's rows keep their D153/D159a provenance.
 *
 *   counter_payments, counter_payment_voids  append-only for every role;
 *                       staff read them (never the request fingerprint);
 *                       customers and anon read nothing; no API role
 *                       writes.
 *   record_counter_payment, void_counter_payment  admins only (D161a):
 *                       replay by a client id and fingerprint (the
 *                       consignor settlement pattern), under the job lock.
 *   quote_deposits      a live counter deposit makes the deposit paid
 *                       (counter_payment_id appended); a void takes it out.
 *   work_order_payment_totals  a row for every job; paid_at_counter,
 *                       net_paid and processing_online appended; the
 *                       balance counts counter money.
 *   payment_issues      paid_online_and_counter, the counter
 *                       paid_job_cancelled and paid_parts_cancelled,
 *                       paid_above_bill; counter_payment_id appended.
 *
 * A database with no counter payment and no balance payment reads exactly
 * as the merged views did (compared with their 20261014000500/0700 text).
 * Stripe deposits come from record_deposit_checkout and Stripe events as
 * in indent-deposits.test.ts; balance payments (D156 builds their Checkout
 * in 20261014001400) are inserted pending as the owner and moved only by
 * Stripe events. The races commit, so they run only on this file's clone.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LOCATION, STAFF } from "../fixtures/ids";
import { refundObject, sessionObject, stripeEvent, stripeWebhookHeaders } from "../fixtures/stripe";
import { customerClaims, linkCustomerLogin } from "./customer-fixtures";
import {
  actAs,
  connect,
  inTransaction,
  isolatedDatabase,
  openConnections,
  scalar,
  type Claims,
} from "./harness";
import {
  answerAll,
  beforeTheGuard,
  fit,
  orderParts,
  proposePart,
  quoted,
  sendQuote,
} from "./indent-fixtures";
import {
  ADMIN,
  MANAGER,
  MECHANIC2,
  addStock,
  committed,
  completeJob,
  newJob,
  readAsOwner,
  reopenJob,
} from "./inventory-fixtures";
import { race } from "./lock-race";
import {
  addManualLine,
  events,
  failsWith,
  makeCustomerWithBike,
  ownerMode,
  setStatus,
  tryAndUndo,
  walkTo,
} from "./workshop-fixtures";

const SERVICE: Claims = { role: "service_role" };
const ANON: Claims = { role: "anon" };
const DENIED = { code: "42501" };
const p0001 = (message: string) => ({ code: "P0001", message });
const check = (constraint: string) => ({ code: "23514", constraint });

let conn: pg.Client;

beforeAll(async () => {
  conn = await connect();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A fresh suffix for Stripe ids (letters and digits only). */
const tag = () => randomUUID().replace(/-/g, "").slice(0, 24);
const unixNow = () => Math.floor(Date.now() / 1000);

type Recorded = { counter_payment_id: string; replayed: boolean; open_checkouts: number };

type CounterArgs = {
  id?: string;
  workOrderId: string;
  quoteId?: string | null;
  amount: string;
  method?: string;
  receivedAt?: string | Date | null;
  reference?: string | null;
  note?: string | null;
};

/** public.record_counter_payment as whoever `tx` is. */
async function callRecord(tx: pg.Client, a: CounterArgs): Promise<Recorded> {
  const { rows } = await tx.query<Recorded>(
    `select counter_payment_id, replayed, open_checkouts
       from public.record_counter_payment($1, $2, $3, $4, $5::public.counter_payment_method, $6, $7, $8)`,
    [
      a.id === undefined ? randomUUID() : a.id,
      a.workOrderId,
      a.quoteId ?? null,
      a.amount,
      a.method ?? "cash",
      a.receivedAt ?? null,
      a.reference ?? null,
      a.note ?? null,
    ],
  );
  return rows[0];
}

/** record_counter_payment as the admin; returns the result (its id is the one given or a new one). */
async function record(tx: pg.Client, a: CounterArgs): Promise<Recorded> {
  await actAs(tx, ADMIN);
  return callRecord(tx, a);
}

type Voided = { counter_payment_id: string; replayed: boolean };

/** public.void_counter_payment as whoever `tx` is. */
async function callVoid(
  tx: pg.Client,
  id: string,
  kind: string | null,
  reason: string | null,
): Promise<Voided> {
  const { rows } = await tx.query<Voided>(
    `select counter_payment_id, replayed
       from public.void_counter_payment($1, $2::public.counter_void_kind, $3)`,
    [id, kind, reason],
  );
  return rows[0];
}

async function voidCounter(
  tx: pg.Client,
  id: string,
  kind: "recorded_in_error" | "given_back" = "recorded_in_error",
  reason = "Typed on the wrong job",
): Promise<Voided> {
  await actAs(tx, ADMIN);
  return callVoid(tx, id, kind, reason);
}

/** A new open job (as ADMIN) with one manual line at `price` when given; acting as ADMIN. */
async function billedJob(tx: pg.Client, price: string | null = "80.00") {
  const job = await newJob(tx);
  if (price) await addManualLine(tx, { workOrderId: job.id, description: "Labour", price });
  return job;
}

type Totals = {
  paid_online: string;
  refunded_online: string;
  net_paid_online: string;
  job_total: string;
  balance_due: string | null;
  paid_ahead: string | null;
  held_over_total: string | null;
  paid_at_counter: string;
  net_paid: string;
  processing_online: string;
};

/** The job's work_order_payment_totals rows (read as whoever `tx` is). */
async function totalsAs(tx: pg.Client, workOrderId: string): Promise<Totals[]> {
  const { rows } = await tx.query<Totals>(
    `select paid_online::text, refunded_online::text, net_paid_online::text, job_total::text,
            balance_due::text, paid_ahead::text, held_over_total::text, paid_at_counter::text,
            net_paid::text, processing_online::text
       from public.work_order_payment_totals where work_order_id = $1`,
    [workOrderId],
  );
  return rows;
}

const totals = async (tx: pg.Client, workOrderId: string) =>
  (await readAsOwner(tx, () => totalsAs(tx, workOrderId)))[0];

type IssueRow = {
  payment_id: string | null;
  counter_payment_id: string | null;
  issue: string;
  severity: string;
  message: string;
};

/** The job's payment_issues rows, sorted (read as the owner). */
const issuesOfJob = (tx: pg.Client, workOrderId: string) =>
  readAsOwner(tx, async () => {
    const { rows } = await tx.query<IssueRow>(
      `select payment_id, counter_payment_id, issue, severity, message
         from public.payment_issues where work_order_id = $1
        order by issue, payment_id nulls last, counter_payment_id nulls last`,
      [workOrderId],
    );
    return rows;
  });

const issueKinds = async (tx: pg.Client, workOrderId: string) =>
  (await issuesOfJob(tx, workOrderId)).map((r) => r.issue);

/** Sets the shop's deposit percent as the owner (leaves `tx` as the owner). */
async function withPercent(tx: pg.Client, percent: number): Promise<void> {
  await ownerMode(tx);
  await tx.query("update public.shop_settings set indent_deposit_percent = $1 where id = 1", [
    percent,
  ]);
}

/** The job's newest quote id (read as the owner). */
const quoteIdOf = (tx: pg.Client, workOrderId: string) =>
  readAsOwner(tx, () =>
    scalar<string>(
      tx,
      "select id from public.quotes where work_order_id = $1 order by sent_at desc limit 1",
      [workOrderId],
    ),
  );

type Answered = Awaited<ReturnType<typeof quoted>> & { quoteId: string };

/**
 * quoted() at `percent` (part 2 x 120.00 and a 25.00 service), answered by
 * the link with everything approved: a deposit of 120.00 at 50%, 240.00 at
 * 100%. Acting as ADMIN afterwards.
 */
async function answered(tx: pg.Client, { percent = 50 }: { percent?: number } = {}) {
  await withPercent(tx, percent);
  const q = await quoted(tx);
  await actAs(tx, ANON);
  await answerAll(tx, q.token);
  const quoteId = await quoteIdOf(tx, q.job.id);
  await withPercent(tx, 0);
  await actAs(tx, ADMIN);
  return { ...q, quoteId } as Answered;
}

/** The quote's quote_deposits row (read as the owner), or null. */
const depositRow = (tx: pg.Client, quoteId: string) =>
  readAsOwner(tx, async () => {
    const { rows } = await tx.query<{ state: string; counter_payment_id: string | null }>(
      "select state, counter_payment_id from public.quote_deposits where quote_id = $1",
      [quoteId],
    );
    return rows[0] ?? null;
  });

const depositState = async (tx: pg.Client, quoteId: string) =>
  (await depositRow(tx, quoteId))?.state ?? null;

/** The quote page's view for `token` (as anon). */
async function page(tx: pg.Client, token: string) {
  await actAs(tx, ANON);
  return scalar<Record<string, unknown> & { deposit: { status: string } | null }>(
    tx,
    "select public.quote_by_token($1)",
    [token],
  );
}

type Prepared = {
  outcome: string;
  payment_id: string | null;
  amount: string | null;
  amount_cents: number | null;
};

/** prepare_deposit_checkout as the service role. */
async function prepare(tx: pg.Client, token: string): Promise<Prepared> {
  await actAs(tx, SERVICE);
  const { rows } = await tx.query<Prepared>(
    `select outcome, payment_id, amount::text, amount_cents::int
       from public.prepare_deposit_checkout($1)`,
    [token],
  );
  return rows[0];
}

/** record_deposit_checkout as the service role. */
async function recordCheckout(tx: pg.Client, paymentId: string, quoteId: string, session: unknown) {
  await actAs(tx, SERVICE);
  const { rows } = await tx.query<{ outcome: string; payment_id: string | null }>(
    `select outcome, payment_id from public.record_deposit_checkout($1, $2, $3::jsonb)`,
    [paymentId, quoteId, JSON.stringify(session)],
  );
  return rows[0];
}

type Pay = {
  paymentId: string;
  sessionId: string;
  workOrderId: string;
  quoteId: string | null;
  cents: number;
  pi: string;
};

/** The open Checkout Session Stripe returns for a deposit payment id. */
const openSession = (d: Answered, paymentId: string, cents: number) =>
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
async function startCheckout(tx: pg.Client, d: Answered): Promise<Pay> {
  const prep = await prepare(tx, d.token);
  expect(prep.outcome).toBe("create");
  const s = openSession(d, prep.payment_id!, prep.amount_cents!);
  expect((await recordCheckout(tx, prep.payment_id!, d.quoteId, s)).outcome).toBe("created");
  return {
    paymentId: prep.payment_id!,
    sessionId: s.id as string,
    workOrderId: d.job.id,
    quoteId: d.quoteId,
    cents: prep.amount_cents!,
    pi: `pi_${tag()}`,
  };
}

/**
 * A pending balance payment (kind balance, no quote) of `amount`, inserted
 * as the owner as stripe-payments.test.ts does; its session expires in an
 * hour unless `expiresIn` says otherwise. Leaves `tx` as the owner.
 */
async function balancePayment(
  tx: pg.Client,
  workOrderId: string,
  amount = "100.00",
  expiresIn = "1 hour",
): Promise<Pay> {
  await ownerMode(tx);
  const id = randomUUID();
  const sessionId = `cs_test_${tag()}`;
  await tx.query(
    `insert into public.payments
       (id, work_order_id, quote_id, kind, amount, stripe_checkout_session_id,
        stripe_session_expires_at, livemode)
     values ($1, $2, null, 'balance', $3, $4, now() + $5::interval, false)`,
    [id, workOrderId, amount, sessionId, expiresIn],
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

const sha256hex = (raw: string) => createHash("sha256").update(raw, "utf8").digest("hex");

type EventResult = { event_status: string; outcome: string | null };

/** public.record_stripe_event as whoever `tx` is. */
async function callRecordEvent(tx: pg.Client, payload: unknown): Promise<EventResult> {
  const raw = JSON.stringify(payload);
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

/** A verified webhook of `type` carrying `object`, as the service role. */
async function deliver(
  tx: pg.Client,
  type: string,
  object: Record<string, unknown>,
  created?: number,
): Promise<EventResult> {
  await actAs(tx, SERVICE);
  return callRecordEvent(tx, stripeEvent({ id: `evt_${tag()}`, type, object, created }));
}

/** The payment's Checkout Session as Stripe sends it once paid. */
const paidSession = (p: Pay, o: Partial<Parameters<typeof sessionObject>[0]> = {}) =>
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

const pay = (tx: pg.Client, p: Pay, o: Partial<Parameters<typeof sessionObject>[0]> = {}) =>
  deliver(tx, "checkout.session.completed", paidSession(p, o));

/** Checkout completed but Stripe still confirming (PayNow): pending with checkout_completed_at. */
const processing = (tx: pg.Client, p: Pay) =>
  pay(tx, p, { paymentStatus: "unpaid", status: "complete" });

const refund = (tx: pg.Client, p: Pay, cents: number) =>
  deliver(
    tx,
    "refund.updated",
    refundObject({
      id: `re_${tag()}`,
      paymentIntent: p.pi,
      amountCents: cents,
      status: "succeeded",
    }),
  );

const cancelRequest = (tx: pg.Client, requestId: string) =>
  tx.query("select public.cancel_part_request($1, $2)", [requestId, "Supplier discontinued it"]);

/** order_part_requests with an override reason, as whoever `tx` is. */
const orderWithReason = (tx: pg.Client, requestIds: string[], supplierId: string, reason: string) =>
  scalar<string>(tx, "select public.order_part_requests($1, $2, $3, true, $4)", [
    requestIds,
    supplierId,
    randomUUID(),
    reason,
  ]);

/** Fits the answered quote's part (2 in stock first) and cancels its service, as ADMIN. */
async function fitPartOnly(tx: pg.Client, d: Answered): Promise<void> {
  await actAs(tx, ADMIN);
  await addStock(tx, d.productId, 2);
  await fit(tx, d.partId, randomUUID(), LOCATION.shopFloor);
  await cancelRequest(tx, d.serviceRequestId);
}

/** The D152 gate as the admin, without a reason, tried and undone: true when it orders. */
async function gateOpen(tx: pg.Client, d: Answered): Promise<boolean> {
  await actAs(tx, ADMIN);
  return tryAndUndo(tx, async () => {
    try {
      await tx.query("savepoint gate");
      await orderParts(tx, [d.partId], d.supplierId);
      return true;
    } catch (error) {
      await tx.query("rollback to savepoint gate");
      expect(error).toMatchObject(p0001("deposit_unpaid"));
      return false;
    }
  });
}

/** The job's counter timeline payloads of `type`, oldest first (read as the owner). */
const counterEvents = (tx: pg.Client, workOrderId: string, type: string) =>
  readAsOwner(tx, async () =>
    (await events(tx, workOrderId))
      .filter((e) => e.event_type === type)
      .map((e) => ({ payload: e.payload, actor: e.actor_staff_id })),
  );

// ---------------------------------------------------------------------------
// 1. Who can reach it (D161a, DATA-MODEL §15)
// ---------------------------------------------------------------------------

describe("Who can reach counter payments (D161a, DATA-MODEL §15)", () => {
  it("only an active admin records or voids; managers, mechanics and customers get 42501; anon and the service role cannot execute", async () => {
    await inTransaction(conn, async (tx) => {
      const job = await billedJob(tx);
      const { counter_payment_id: id } = await record(tx, { workOrderId: job.id, amount: "10.00" });
      await ownerMode(tx);
      const login = await linkCustomerLogin(tx, job.customer_id);
      for (const claims of [MANAGER, MECHANIC2, customerClaims(login), ANON, SERVICE]) {
        await actAs(tx, claims);
        await failsWith(tx, () => callRecord(tx, { workOrderId: job.id, amount: "5.00" }), DENIED);
        await failsWith(tx, () => callVoid(tx, id, "recorded_in_error", "No"), DENIED);
      }
      expect(
        await readAsOwner(tx, () =>
          scalar<number>(
            tx,
            "select count(*)::int from public.counter_payments where work_order_id = $1",
            [job.id],
          ),
        ),
      ).toBe(1);
    });
  });

  it("staff read both tables (never the fingerprint); customers read nothing; anon and the service role are refused; nobody writes, and the owner cannot change or delete a row", async () => {
    await inTransaction(conn, async (tx) => {
      const job = await billedJob(tx);
      const { counter_payment_id: id } = await record(tx, { workOrderId: job.id, amount: "10.00" });
      const { counter_payment_id: voidedId } = await record(tx, {
        workOrderId: job.id,
        amount: "5.00",
      });
      await voidCounter(tx, voidedId);

      for (const claims of [MECHANIC2, MANAGER, ADMIN]) {
        await actAs(tx, claims);
        expect(
          await scalar<number>(
            tx,
            `select count(*)::int from public.counter_payments where work_order_id = $1`,
            [job.id],
          ),
        ).toBe(2);
        const { rows } = await tx.query(
          `select id, work_order_id, quote_id, kind::text, amount::text, currency::text, method::text,
                  received_at is not null as dated, reference, note, recorded_by, created_at is not null as stamped
             from public.counter_payments where id = $1`,
          [id],
        );
        expect(rows).toEqual([
          {
            id,
            work_order_id: job.id,
            quote_id: null,
            kind: "balance",
            amount: "10.00",
            currency: "SGD",
            method: "cash",
            dated: true,
            reference: null,
            note: null,
            recorded_by: STAFF.admin,
            stamped: true,
          },
        ]);
        expect(
          await scalar<number>(
            tx,
            `select count(*)::int from public.counter_payment_voids v
               join public.counter_payments c on c.id = v.counter_payment_id
              where c.work_order_id = $1`,
            [job.id],
          ),
        ).toBe(1);
        await failsWith(
          tx,
          () => tx.query("select request_fingerprint from public.counter_payments"),
          DENIED,
        );
      }

      // No API role writes either table, admins included.
      await actAs(tx, ADMIN);
      await failsWith(
        tx,
        () =>
          tx.query(
            `insert into public.counter_payments
               (id, work_order_id, kind, amount, method, received_at, request_fingerprint, recorded_by)
             values ($1, $2, 'balance', 1, 'cash', now(), 'x', $3)`,
            [randomUUID(), job.id, STAFF.admin],
          ),
        DENIED,
      );
      await failsWith(
        tx,
        () => tx.query("update public.counter_payments set amount = 1 where id = $1", [id]),
        DENIED,
      );
      await failsWith(
        tx,
        () => tx.query("delete from public.counter_payments where id = $1", [id]),
        DENIED,
      );
      await failsWith(
        tx,
        () =>
          tx.query(
            `insert into public.counter_payment_voids (counter_payment_id, kind, reason, voided_by)
             values ($1, 'given_back', 'x', $2)`,
            [id, STAFF.admin],
          ),
        DENIED,
      );
      await failsWith(
        tx,
        () =>
          tx.query("delete from public.counter_payment_voids where counter_payment_id = $1", [
            voidedId,
          ]),
        DENIED,
      );

      // Append-only for every role, the owner included.
      await ownerMode(tx);
      await failsWith(
        tx,
        () => tx.query("update public.counter_payments set note = 'x' where id = $1", [id]),
        p0001("counter_payment_immutable"),
      );
      await failsWith(
        tx,
        () => tx.query("delete from public.counter_payments where id = $1", [id]),
        p0001("counter_payment_immutable"),
      );
      await failsWith(
        tx,
        () =>
          tx.query(
            "update public.counter_payment_voids set reason = 'x' where counter_payment_id = $1",
            [voidedId],
          ),
        p0001("counter_payment_immutable"),
      );
      await failsWith(
        tx,
        () =>
          tx.query("delete from public.counter_payment_voids where counter_payment_id = $1", [
            voidedId,
          ]),
        p0001("counter_payment_immutable"),
      );

      // Customers read nothing; anon and the service role hold no grant.
      const login = await linkCustomerLogin(tx, job.customer_id);
      await actAs(tx, customerClaims(login));
      for (const table of ["counter_payments", "counter_payment_voids"])
        expect(await scalar<number>(tx, `select count(*)::int from public.${table}`)).toBe(0);
      for (const claims of [ANON, SERVICE]) {
        await actAs(tx, claims);
        for (const table of ["counter_payments", "counter_payment_voids"])
          await failsWith(tx, () => tx.query(`select 1 from public.${table}`), DENIED);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Recording: the row, replay and conflicts (D161c, D161i)
// ---------------------------------------------------------------------------

describe("record_counter_payment: the row, replay and conflicts (D161c, D161i)", () => {
  it("records a balance payment with the admin as recorder; reference and note trimmed; a timeline entry without them", async () => {
    await inTransaction(conn, async (tx) => {
      const job = await billedJob(tx);
      const id = randomUUID();
      const before = await scalar<Date>(tx, "select clock_timestamp()");
      const r = await record(tx, {
        id,
        workOrderId: job.id,
        amount: "50",
        method: "paynow",
        reference: "  PayNow 77  ",
        note: "   ",
      });
      const after = await scalar<Date>(tx, "select clock_timestamp()");
      expect(r).toEqual({ counter_payment_id: id, replayed: false, open_checkouts: 0 });
      const row = await readAsOwner(tx, async () => {
        const { rows } = await tx.query(
          `select kind::text, quote_id, amount::text, method::text, received_at, reference, note,
                  recorded_by, request_fingerprint ~ '^[0-9a-f]{32}$' as fingerprinted
             from public.counter_payments where id = $1`,
          [id],
        );
        return rows[0];
      });
      expect(row).toMatchObject({
        kind: "balance",
        quote_id: null,
        amount: "50.00",
        method: "paynow",
        reference: "PayNow 77",
        note: null,
        recorded_by: STAFF.admin,
        fingerprinted: true,
      });
      // received_at NULL means now (the call's clock).
      expect(row.received_at.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(row.received_at.getTime()).toBeLessThanOrEqual(after.getTime());

      const recorded = await counterEvents(tx, job.id, "counter_payment_recorded");
      expect(recorded).toHaveLength(1);
      expect(recorded[0].actor).toBe(STAFF.admin);
      expect(Object.keys(recorded[0].payload).sort()).toEqual([
        "amount",
        "counter_payment_id",
        "kind",
        "method",
        "quote_id",
        "received_at",
      ]);
      expect(recorded[0].payload).toMatchObject({
        counter_payment_id: id,
        kind: "balance",
        quote_id: null,
        amount: 50,
        method: "paynow",
      });
      expect(JSON.stringify(recorded[0].payload)).not.toContain("PayNow 77");

      // Every method of D161b is accepted; anything else is not a method.
      for (const method of ["cash", "card", "paynow", "bank_transfer", "other"])
        expect((await record(tx, { workOrderId: job.id, amount: "1.00", method })).replayed).toBe(
          false,
        );
      await failsWith(
        tx,
        () => callRecord(tx, { workOrderId: job.id, amount: "1.00", method: "bitcoin" }),
        { code: "22P02" },
      );
    });
  });

  it("received_at NULL replays when it is NULL again; giving the stamped instant is another request", async () => {
    await inTransaction(conn, async (tx) => {
      const job = await billedJob(tx);
      const request = { id: randomUUID(), workOrderId: job.id, amount: "30.00" };
      const first = await record(tx, request);
      expect(first.replayed).toBe(false);
      expect(await record(tx, request)).toEqual({ ...first, replayed: true });
      // The fingerprint keeps NULL as given, never the stamped time (or any
      // time resolved from it), so a retry minutes later still replays.
      expect(
        await readAsOwner(tx, async () => {
          const { rows } = await tx.query(
            `select request_fingerprint = private.counter_payment_request_fingerprint(
                      work_order_id, quote_id, amount, method, null, reference, note) as kept_null,
                    request_fingerprint <> private.counter_payment_request_fingerprint(
                      work_order_id, quote_id, amount, method, received_at, reference, note) as not_stamped
               from public.counter_payments where id = $1`,
            [request.id],
          );
          return rows[0];
        }),
      ).toEqual({ kept_null: true, not_stamped: true });
      const stamped = await readAsOwner(tx, () =>
        scalar<string>(tx, "select received_at::text from public.counter_payments where id = $1", [
          request.id,
        ]),
      );
      await failsWith(
        tx,
        () => record(tx, { ...request, receivedAt: stamped }),
        p0001("counter_payment_conflict"),
      );
      // A given instant replays when given again.
      const dated = { id: randomUUID(), workOrderId: job.id, amount: "5.00", receivedAt: stamped };
      expect((await record(tx, dated)).replayed).toBe(false);
      expect((await record(tx, dated)).replayed).toBe(true);
      expect(
        await readAsOwner(tx, () =>
          scalar<number>(
            tx,
            "select count(*)::int from public.counter_payments where work_order_id = $1",
            [job.id],
          ),
        ),
      ).toBe(2);
      expect(await counterEvents(tx, job.id, "counter_payment_recorded")).toHaveLength(2);
    });
  });

  it("'200' and '200.00' replay; any other change is a conflict; the same id on another job is a conflict", async () => {
    await inTransaction(conn, async (tx) => {
      const job = await billedJob(tx, "500.00");
      const other = await billedJob(tx, "500.00");
      const id = randomUUID();
      const base = {
        id,
        workOrderId: job.id,
        amount: "200",
        method: "card",
        reference: "Terminal 4411",
        note: "Paid before the parts came",
      };
      expect((await record(tx, base)).replayed).toBe(false);
      expect((await record(tx, { ...base, amount: "200.00" })).replayed).toBe(true);
      expect((await record(tx, { ...base, amount: "200.0" })).replayed).toBe(true);
      // Trimmed text is the same request.
      expect((await record(tx, { ...base, reference: "  Terminal 4411 " })).replayed).toBe(true);
      for (const change of [
        { amount: "200.01" },
        { method: "cash" },
        { reference: "Terminal 4412" },
        { reference: null },
        { note: "Another note" },
        { receivedAt: new Date(Date.now() - 60_000) },
        { workOrderId: other.id },
      ])
        await failsWith(
          tx,
          () => record(tx, { ...base, ...change }),
          p0001("counter_payment_conflict"),
        );
      // A replay is answered before any other check: still a replay once the
      // job is completed.
      await completeJob(tx, job.id);
      expect((await record(tx, base)).replayed).toBe(true);
      expect(
        await readAsOwner(tx, () =>
          scalar<number>(tx, "select count(*)::int from public.counter_payments where id = $1", [
            id,
          ]),
        ),
      ).toBe(1);
    });
  });

  it("refuses a missing id, job, amount or method, an amount out of range, long text and an unknown job", async () => {
    await inTransaction(conn, async (tx) => {
      const job = await billedJob(tx);
      await actAs(tx, ADMIN);
      await failsWith(
        tx,
        () =>
          callRecord(tx, { id: null as unknown as string, workOrderId: job.id, amount: "1.00" }),
        {
          code: "22004",
        },
      );
      await failsWith(
        tx,
        () => callRecord(tx, { workOrderId: null as unknown as string, amount: "1.00" }),
        {
          code: "22004",
        },
      );
      await failsWith(
        tx,
        () => callRecord(tx, { workOrderId: job.id, amount: null as unknown as string }),
        {
          code: "22004",
        },
      );
      await failsWith(
        tx,
        () =>
          tx.query("select * from public.record_counter_payment($1, $2, null, '1.00', null)", [
            randomUUID(),
            job.id,
          ]),
        { code: "22004" },
      );
      for (const amount of ["0", "0.00", "-5.00", "1000000.00"])
        await failsWith(
          tx,
          () => callRecord(tx, { workOrderId: job.id, amount }),
          check("counter_payments_amount_check"),
        );
      expect((await callRecord(tx, { workOrderId: job.id, amount: "999999.99" })).replayed).toBe(
        false,
      );
      expect((await callRecord(tx, { workOrderId: job.id, amount: "0.01" })).replayed).toBe(false);
      await failsWith(
        tx,
        () => callRecord(tx, { workOrderId: job.id, amount: "1.00", reference: "r".repeat(201) }),
        check("counter_payments_reference_check"),
      );
      expect(
        (
          await callRecord(tx, {
            workOrderId: job.id,
            amount: "1.00",
            reference: ` ${"r".repeat(200)} `,
          })
        ).replayed,
      ).toBe(false);
      await failsWith(
        tx,
        () => callRecord(tx, { workOrderId: job.id, amount: "1.00", note: "n".repeat(2001) }),
        check("counter_payments_note_check"),
      );
      await failsWith(tx, () => callRecord(tx, { workOrderId: randomUUID(), amount: "1.00" }), {
        code: "P0002",
      });
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Where and when (D161e, D161h)
// ---------------------------------------------------------------------------

describe("Where and when a counter payment is recorded (D161e, D161h)", () => {
  it("a cancelled job is refused; completed, ready and collected jobs record; the job must be in SGD", async () => {
    await inTransaction(conn, async (tx) => {
      const cancelled = await billedJob(tx, null);
      await setStatus(tx, cancelled.id, "cancelled", "Customer withdrew");
      await failsWith(
        tx,
        () => record(tx, { workOrderId: cancelled.id, amount: "10.00" }),
        p0001("work_order_cancelled"),
      );

      const job = await billedJob(tx);
      await completeJob(tx, job.id);
      expect((await record(tx, { workOrderId: job.id, amount: "10.00" })).replayed).toBe(false);
      await setStatus(tx, job.id, "ready_for_collection");
      expect((await record(tx, { workOrderId: job.id, amount: "10.00" })).replayed).toBe(false);
      await setStatus(tx, job.id, "collected");
      expect((await record(tx, { workOrderId: job.id, amount: "10.00" })).replayed).toBe(false);

      // A job in another currency (inserted as the owner).
      await ownerMode(tx);
      const ids = await makeCustomerWithBike(tx);
      const usd = await scalar<string>(
        tx,
        `insert into public.work_orders (customer_id, bike_id, requested_work, currency)
         values ($1, $2, 'Service', 'USD') returning id`,
        [ids.customerId, ids.bikeId],
      );
      await failsWith(
        tx,
        () => record(tx, { workOrderId: usd, amount: "10.00" }),
        p0001("counter_payment_currency"),
      );
    });
  });

  it("time bounds: at most 5 minutes ahead, not before check-in, a deposit not before the answer, at most 30 days ago", async () => {
    await inTransaction(conn, async (tx) => {
      const job = await billedJob(tx);
      await failsWith(
        tx,
        () =>
          record(tx, {
            workOrderId: job.id,
            amount: "1.00",
            receivedAt: new Date(Date.now() + 10 * 60_000),
          }),
        p0001("counter_payment_in_future"),
      );
      expect(
        (
          await record(tx, {
            workOrderId: job.id,
            amount: "1.00",
            receivedAt: new Date(Date.now() + 4 * 60_000),
          })
        ).replayed,
      ).toBe(false);
      const checkedIn = await scalar<string>(
        tx,
        "select checked_in_at::text from public.work_orders where id = $1",
        [job.id],
      );
      const justBefore = await scalar<string>(
        tx,
        "select ($1::timestamptz - interval '1 millisecond')::text",
        [checkedIn],
      );
      await failsWith(
        tx,
        () => record(tx, { workOrderId: job.id, amount: "1.00", receivedAt: justBefore }),
        p0001("counter_payment_before_job"),
      );
      expect(
        (await record(tx, { workOrderId: job.id, amount: "1.00", receivedAt: checkedIn })).replayed,
      ).toBe(false);

      // A deposit is not dated before the customer answered the quote.
      const d = await answered(tx);
      const answeredAt = await readAsOwner(tx, () =>
        scalar<string>(tx, "select answered_at::text from public.quotes where id = $1", [
          d.quoteId,
        ]),
      );
      const beforeAnswer = await scalar<string>(
        tx,
        "select ($1::timestamptz - interval '1 millisecond')::text",
        [answeredAt],
      );
      await failsWith(
        tx,
        () =>
          record(tx, {
            workOrderId: d.job.id,
            quoteId: d.quoteId,
            amount: "120.00",
            receivedAt: beforeAnswer,
          }),
        p0001("counter_payment_before_job"),
      );
      // A balance payment at that instant is fine (after check-in).
      expect(
        (await record(tx, { workOrderId: d.job.id, amount: "1.00", receivedAt: beforeAnswer }))
          .replayed,
      ).toBe(false);
      expect(
        (
          await record(tx, {
            workOrderId: d.job.id,
            quoteId: d.quoteId,
            amount: "120.00",
            receivedAt: answeredAt,
          })
        ).replayed,
      ).toBe(false);

      // At most 30 days back, on a job checked in 40 days ago (owner insert).
      await ownerMode(tx);
      const ids = await makeCustomerWithBike(tx);
      const old = await scalar<string>(
        tx,
        `insert into public.work_orders (customer_id, bike_id, requested_work, checked_in_at)
         values ($1, $2, 'Service', now() - interval '40 days') returning id`,
        [ids.customerId, ids.bikeId],
      );
      await failsWith(
        tx,
        () =>
          record(tx, {
            workOrderId: old,
            amount: "1.00",
            receivedAt: new Date(Date.now() - 31 * 86_400_000),
          }),
        p0001("counter_payment_too_old"),
      );
      expect(
        (
          await record(tx, {
            workOrderId: old,
            amount: "1.00",
            receivedAt: new Date(Date.now() - 29 * 86_400_000),
          })
        ).replayed,
      ).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Deposits (D161f) and the D152 gate
// ---------------------------------------------------------------------------

describe("Counter deposits (D161f), the quote page and the D152 gate", () => {
  it("a counter deposit settles a due deposit: paid with its id, the gate opens, the page says paid, Checkout says paid", async () => {
    await inTransaction(conn, async (tx) => {
      const d = await answered(tx);
      expect(await depositRow(tx, d.quoteId)).toEqual({ state: "due", counter_payment_id: null });
      expect(await gateOpen(tx, d)).toBe(false);
      // A Checkout prepared before the counter payment, recorded after it.
      const prep = await prepare(tx, d.token);
      expect(prep.outcome).toBe("create");

      const id = randomUUID();
      const r = await record(tx, {
        id,
        workOrderId: d.job.id,
        quoteId: d.quoteId,
        amount: "120",
        reference: "Till 3",
      });
      expect(r).toEqual({ counter_payment_id: id, replayed: false, open_checkouts: 0 });
      expect(await depositRow(tx, d.quoteId)).toEqual({ state: "paid", counter_payment_id: id });
      expect(await gateOpen(tx, d)).toBe(true);
      const view = await page(tx, d.token);
      expect(Object.keys(view)).toHaveLength(12);
      expect(view.deposit).toMatchObject({ status: "paid" });
      expect(JSON.stringify(view)).not.toContain(id);
      expect(JSON.stringify(view)).not.toContain("Till 3");
      expect(await prepare(tx, d.token)).toMatchObject({ outcome: "paid", payment_id: null });
      expect(
        await recordCheckout(
          tx,
          prep.payment_id!,
          d.quoteId,
          openSession(d, prep.payment_id!, 12000),
        ),
      ).toEqual({ outcome: "paid", payment_id: null });
      const recorded = await counterEvents(tx, d.job.id, "counter_payment_recorded");
      expect(recorded.map((e) => e.payload)).toMatchObject([
        {
          counter_payment_id: id,
          kind: "deposit",
          quote_id: d.quoteId,
          amount: 120,
          method: "cash",
        },
      ]);
      // The job's totals count it.
      expect(await totals(tx, d.job.id)).toMatchObject({
        net_paid_online: "0.00",
        paid_at_counter: "120.00",
        net_paid: "120.00",
      });
    });
  });

  it("refuses another job's quote, a quote without a deposit, parts cancelled, processing, already paid and another amount", async () => {
    await inTransaction(conn, async (tx) => {
      const d = await answered(tx);
      const other = await billedJob(tx);
      await failsWith(
        tx,
        () => record(tx, { workOrderId: other.id, quoteId: d.quoteId, amount: "120.00" }),
        p0001("counter_payment_quote_mismatch"),
      );
      await failsWith(
        tx,
        () => record(tx, { workOrderId: d.job.id, quoteId: randomUUID(), amount: "120.00" }),
        p0001("counter_payment_quote_mismatch"),
      );
      for (const amount of ["119.99", "120.01", "240.00"])
        await failsWith(
          tx,
          () => record(tx, { workOrderId: d.job.id, quoteId: d.quoteId, amount }),
          p0001("counter_deposit_amount"),
        );

      // Answered with no deposit (percent 0): no quote_deposits row.
      const zero = await answered(tx, { percent: 0 });
      expect(await depositRow(tx, zero.quoteId)).toBeNull();
      await failsWith(
        tx,
        () => record(tx, { workOrderId: zero.job.id, quoteId: zero.quoteId, amount: "120.00" }),
        p0001("deposit_not_due"),
      );
      // An open quote: not answered yet.
      await withPercent(tx, 50);
      const open = await quoted(tx);
      await withPercent(tx, 0);
      const openQuote = await quoteIdOf(tx, open.job.id);
      await failsWith(
        tx,
        () => record(tx, { workOrderId: open.job.id, quoteId: openQuote, amount: "120.00" }),
        p0001("deposit_not_due"),
      );

      // Every part cancelled: none.
      const none = await answered(tx);
      await cancelRequest(tx, none.partId);
      expect(await depositState(tx, none.quoteId)).toBe("none");
      await failsWith(
        tx,
        () => record(tx, { workOrderId: none.job.id, quoteId: none.quoteId, amount: "120.00" }),
        p0001("deposit_not_due"),
      );

      // Processing: Checkout completed, Stripe still confirming.
      const proc = await answered(tx);
      const pp = await startCheckout(tx, proc);
      await processing(tx, pp);
      expect(await depositState(tx, proc.quoteId)).toBe("processing");
      await failsWith(
        tx,
        () => record(tx, { workOrderId: proc.job.id, quoteId: proc.quoteId, amount: "120.00" }),
        p0001("deposit_processing"),
      );

      // Paid online.
      const online = await answered(tx);
      await pay(tx, await startCheckout(tx, online));
      await failsWith(
        tx,
        () => record(tx, { workOrderId: online.job.id, quoteId: online.quoteId, amount: "120.00" }),
        p0001("deposit_already_paid"),
      );
      // Paid at the counter.
      await record(tx, { workOrderId: d.job.id, quoteId: d.quoteId, amount: "120.00" });
      await failsWith(
        tx,
        () => record(tx, { workOrderId: d.job.id, quoteId: d.quoteId, amount: "120.00" }),
        p0001("deposit_already_paid"),
      );
      // Money towards the bill is still recorded beside it.
      expect((await record(tx, { workOrderId: d.job.id, amount: "120.00" })).replayed).toBe(false);
    });
  });

  it("a void of either kind takes the counter deposit out: due again, Pay offered on the open job, the gate closed again", async () => {
    await inTransaction(conn, async (tx) => {
      for (const kind of ["recorded_in_error", "given_back"] as const) {
        const d = await answered(tx);
        const { counter_payment_id: id } = await record(tx, {
          workOrderId: d.job.id,
          quoteId: d.quoteId,
          amount: "120.00",
        });
        expect(await depositState(tx, d.quoteId)).toBe("paid");
        expect(await voidCounter(tx, id, kind)).toEqual({
          counter_payment_id: id,
          replayed: false,
        });
        expect(await depositRow(tx, d.quoteId)).toEqual({ state: "due", counter_payment_id: null });
        expect((await page(tx, d.token)).deposit).toMatchObject({ status: "due" });
        expect((await prepare(tx, d.token)).outcome).toBe("create");
        expect(await gateOpen(tx, d)).toBe(false);
        // It can be paid at the counter again.
        const again = await record(tx, {
          workOrderId: d.job.id,
          quoteId: d.quoteId,
          amount: "120.00",
        });
        expect(await depositRow(tx, d.quoteId)).toEqual({
          state: "paid",
          counter_payment_id: again.counter_payment_id,
        });
      }
    });
  });

  it("a Stripe-refunded deposit paid at the counter is paid; after the void it is refunded again, with no Pay and the gate closed", async () => {
    await inTransaction(conn, async (tx) => {
      const d = await answered(tx);
      const p = await startCheckout(tx, d);
      await pay(tx, p);
      await refund(tx, p, 12000);
      expect(await depositState(tx, d.quoteId)).toBe("refunded");
      expect(await gateOpen(tx, d)).toBe(false);

      const { counter_payment_id: id } = await record(tx, {
        workOrderId: d.job.id,
        quoteId: d.quoteId,
        amount: "120.00",
      });
      expect(await depositRow(tx, d.quoteId)).toEqual({ state: "paid", counter_payment_id: id });
      expect(await gateOpen(tx, d)).toBe(true);

      await voidCounter(tx, id, "recorded_in_error");
      expect(await depositState(tx, d.quoteId)).toBe("refunded");
      expect((await prepare(tx, d.token)).outcome).toBe("refunded");
      expect((await page(tx, d.token)).deposit).toMatchObject({ status: "refunded" });
      expect(await gateOpen(tx, d)).toBe(false);
    });
  });

  it("a void on a collected job: due again, but the page offers no deposit and Checkout refuses the closed job", async () => {
    await inTransaction(conn, async (tx) => {
      const d = await answered(tx);
      const { counter_payment_id: id } = await record(tx, {
        workOrderId: d.job.id,
        quoteId: d.quoteId,
        amount: "120.00",
      });
      await fitPartOnly(tx, d);
      await completeJob(tx, d.job.id);
      await setStatus(tx, d.job.id, "collected");
      await voidCounter(tx, id, "given_back", "Customer paid by card instead");
      expect(await depositState(tx, d.quoteId)).toBe("due");
      expect((await page(tx, d.token)).deposit).toBeNull();
      await actAs(tx, SERVICE);
      await failsWith(
        tx,
        () => tx.query("select * from public.prepare_deposit_checkout($1)", [d.token]),
        p0001("deposit_job_closed"),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// 5. Stripe money still open or being confirmed (D161g)
// ---------------------------------------------------------------------------

describe("Open and processing Stripe payments (D161g)", () => {
  it("open_checkouts counts the job's unfinished, unexpired sessions of the balance or of the quote's own deposit", async () => {
    await inTransaction(conn, async (tx) => {
      const d = await answered(tx);
      // A second answered quote on the same job (60.00 at 50%).
      await withPercent(tx, 50);
      await actAs(tx, ADMIN);
      const second = await proposePart(tx, {
        workOrderId: d.job.id,
        productId: d.productId,
        quantity: 1,
      });
      const token2 = await sendQuote(tx, { workOrderId: d.job.id, requestIds: [second] });
      await actAs(tx, ANON);
      await answerAll(tx, token2);
      await withPercent(tx, 0);
      const quote2 = await quoteIdOf(tx, d.job.id);
      expect(quote2).not.toBe(d.quoteId);
      const d2 = { ...d, token: token2, quoteId: quote2 };

      await startCheckout(tx, d); // the first quote's deposit session, open
      await startCheckout(tx, d2); // the second quote's, open
      await balancePayment(tx, d.job.id, "50.00"); // a balance session, open
      await balancePayment(tx, d.job.id, "50.00", "-1 minute"); // past its expiry
      const expired = await balancePayment(tx, d.job.id, "50.00");
      await deliver(
        tx,
        "checkout.session.expired",
        paidSession(expired, { status: "expired", paymentStatus: "unpaid", paymentIntent: null }),
      );

      // A balance payment: the open balance session only.
      const balance = await record(tx, { workOrderId: d.job.id, amount: "10.00" });
      expect(balance.open_checkouts).toBe(1);
      // A deposit: the open balance session and its own quote's session.
      const depositRequest = {
        id: randomUUID(),
        workOrderId: d.job.id,
        quoteId: d.quoteId,
        amount: "120.00",
      };
      const deposit = await record(tx, depositRequest);
      expect(deposit.open_checkouts).toBe(2);
      // A replay gives the count as it stands.
      expect(await record(tx, depositRequest)).toEqual({ ...deposit, replayed: true });
    });
  });

  it("refused while a Stripe payment on the job is being confirmed; recorded again once Stripe decides", async () => {
    await inTransaction(conn, async (tx) => {
      const d = await answered(tx);
      const b = await balancePayment(tx, d.job.id, "50.00");
      await processing(tx, b);
      expect(await totals(tx, d.job.id)).toMatchObject({
        processing_online: "50.00",
        net_paid: "0.00",
        balance_due: "0.00",
      });
      await failsWith(
        tx,
        () => record(tx, { workOrderId: d.job.id, amount: "10.00" }),
        p0001("counter_payment_stripe_processing"),
      );
      // A deposit too, while the job's balance payment is processing.
      expect(await depositState(tx, d.quoteId)).toBe("due");
      await failsWith(
        tx,
        () => record(tx, { workOrderId: d.job.id, quoteId: d.quoteId, amount: "120.00" }),
        p0001("counter_payment_stripe_processing"),
      );
      // Stripe confirms it: recording works again.
      await deliver(tx, "checkout.session.async_payment_succeeded", paidSession(b));
      expect(await totals(tx, d.job.id)).toMatchObject({
        processing_online: "0.00",
        net_paid: "50.00",
      });
      expect((await record(tx, { workOrderId: d.job.id, amount: "10.00" })).replayed).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// 6. Voids (D161d)
// ---------------------------------------------------------------------------

describe("void_counter_payment (D161d)", () => {
  it("one void per payment with a kind and a reason: replay, already voided, unknown, reasons; any job status; the timeline entry", async () => {
    await inTransaction(conn, async (tx) => {
      const job = await billedJob(tx);
      const { counter_payment_id: id } = await record(tx, {
        workOrderId: job.id,
        amount: "40.00",
        method: "card",
        reference: "Slip 9",
      });
      await actAs(tx, ADMIN);
      await failsWith(tx, () => callVoid(tx, id, "given_back", "   "), p0001("reason_required"));
      await failsWith(tx, () => callVoid(tx, id, "given_back", null), p0001("reason_required"));
      await failsWith(
        tx,
        () => callVoid(tx, id, "given_back", "r".repeat(501)),
        p0001("reason_too_long"),
      );
      await failsWith(tx, () => callVoid(tx, id, null, "Why"), { code: "22004" });
      await failsWith(tx, () => callVoid(tx, randomUUID(), "given_back", "Why"), {
        code: "P0002",
        message: "counter_payment_not_found",
      });

      expect(await callVoid(tx, id, "given_back", "  Handed back in cash  ")).toEqual({
        counter_payment_id: id,
        replayed: false,
      });
      expect(await callVoid(tx, id, "given_back", "Handed back in cash")).toEqual({
        counter_payment_id: id,
        replayed: true,
      });
      await failsWith(
        tx,
        () => callVoid(tx, id, "recorded_in_error", "Handed back in cash"),
        p0001("counter_payment_already_voided"),
      );
      await failsWith(
        tx,
        () => callVoid(tx, id, "given_back", "Another reason"),
        p0001("counter_payment_already_voided"),
      );
      const stored = await readAsOwner(tx, async () => {
        const { rows } = await tx.query(
          `select kind::text, reason, voided_by, voided_at is not null as stamped
             from public.counter_payment_voids where counter_payment_id = $1`,
          [id],
        );
        return rows;
      });
      expect(stored).toEqual([
        {
          kind: "given_back",
          reason: "Handed back in cash",
          voided_by: STAFF.admin,
          stamped: true,
        },
      ]);
      const voided = await counterEvents(tx, job.id, "counter_payment_voided");
      expect(voided).toHaveLength(1);
      expect(voided[0].actor).toBe(STAFF.admin);
      expect(voided[0].payload).toEqual({
        counter_payment_id: id,
        kind: "balance",
        quote_id: null,
        amount: 40,
        method: "card",
        void_kind: "given_back",
        reason: "Handed back in cash",
      });

      // Voids are allowed on any job status, cancelled included.
      const cancelled = await billedJob(tx, null);
      const { counter_payment_id: held } = await record(tx, {
        workOrderId: cancelled.id,
        amount: "15.00",
      });
      await setStatus(tx, cancelled.id, "cancelled", "Customer withdrew");
      expect((await voidCounter(tx, held, "given_back", "Given back")).replayed).toBe(false);
      const collected = await billedJob(tx);
      const { counter_payment_id: kept } = await record(tx, {
        workOrderId: collected.id,
        amount: "80.00",
      });
      await completeJob(tx, collected.id);
      await setStatus(tx, collected.id, "collected");
      expect((await voidCounter(tx, kept)).replayed).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// 7. work_order_payment_totals (D161j)
// ---------------------------------------------------------------------------

describe("work_order_payment_totals counts counter money, for every job (D161j)", () => {
  it("a row for every job: nothing paid, counter only, a void, processing online; no balance once collected or cancelled", async () => {
    await inTransaction(conn, async (tx) => {
      const job = await billedJob(tx);
      const zero = {
        paid_online: "0.00",
        refunded_online: "0.00",
        net_paid_online: "0.00",
        job_total: "80.00",
        balance_due: "80.00",
        paid_ahead: "0.00",
        held_over_total: "0.00",
        paid_at_counter: "0.00",
        net_paid: "0.00",
        processing_online: "0.00",
      };
      expect(await totals(tx, job.id)).toEqual(zero);

      await record(tx, { workOrderId: job.id, amount: "30.00" });
      expect(await totals(tx, job.id)).toEqual({
        ...zero,
        paid_at_counter: "30.00",
        net_paid: "30.00",
        balance_due: "50.00",
      });
      const { counter_payment_id: extra } = await record(tx, {
        workOrderId: job.id,
        amount: "60.00",
      });
      expect(await totals(tx, job.id)).toEqual({
        ...zero,
        paid_at_counter: "90.00",
        net_paid: "90.00",
        balance_due: "0.00",
        paid_ahead: "10.00",
        held_over_total: "10.00",
      });
      await voidCounter(tx, extra, "given_back", "Overpaid; handed back");
      expect(await totals(tx, job.id)).toMatchObject({
        paid_at_counter: "30.00",
        balance_due: "50.00",
      });

      // Stripe money still being confirmed is shown apart, never as paid.
      const b = await balancePayment(tx, job.id, "50.00");
      await processing(tx, b);
      expect(await totals(tx, job.id)).toEqual({
        ...zero,
        paid_at_counter: "30.00",
        net_paid: "30.00",
        balance_due: "50.00",
        processing_online: "50.00",
      });
      await deliver(tx, "checkout.session.async_payment_succeeded", paidSession(b));
      expect(await totals(tx, job.id)).toEqual({
        ...zero,
        paid_online: "50.00",
        net_paid_online: "50.00",
        paid_at_counter: "30.00",
        net_paid: "80.00",
        balance_due: "0.00",
      });

      // Collected: no balance or paid ahead; held over still reconciles.
      await actAs(tx, ADMIN);
      await completeJob(tx, job.id);
      await record(tx, { workOrderId: job.id, amount: "5.00" });
      expect(await totals(tx, job.id)).toMatchObject({
        balance_due: "0.00",
        paid_ahead: "5.00",
        held_over_total: "5.00",
      });
      await setStatus(tx, job.id, "collected");
      expect(await totals(tx, job.id)).toMatchObject({
        net_paid: "85.00",
        balance_due: null,
        paid_ahead: null,
        held_over_total: "5.00",
      });

      // A cancelled job with nothing paid.
      const cancelled = await billedJob(tx, null);
      await setStatus(tx, cancelled.id, "cancelled", "Customer withdrew");
      expect(await totals(tx, cancelled.id)).toEqual({
        ...zero,
        job_total: "0.00",
        balance_due: null,
        paid_ahead: null,
      });
    });
  });

  it("staff read a row for every job; customers read none; anon is refused", async () => {
    await inTransaction(conn, async (tx) => {
      const job = await billedJob(tx);
      for (const claims of [MECHANIC2, MANAGER, ADMIN]) {
        await actAs(tx, claims);
        expect(await totalsAs(tx, job.id)).toHaveLength(1);
        expect(
          await scalar<number>(tx, "select count(*)::int from public.work_order_payment_totals"),
        ).toBe(await scalar<number>(tx, "select count(*)::int from public.work_orders"));
      }
      await ownerMode(tx);
      const login = await linkCustomerLogin(tx, job.customer_id);
      await actAs(tx, customerClaims(login));
      expect(
        await scalar<number>(tx, "select count(*)::int from public.work_order_payment_totals"),
      ).toBe(0);
      await actAs(tx, ANON);
      await failsWith(tx, () => tx.query("select 1 from public.work_order_payment_totals"), DENIED);
    });
  });
});

// ---------------------------------------------------------------------------
// 8. payment_issues (D161j)
// ---------------------------------------------------------------------------

describe("payment_issues: counter money that needs attention (D161j)", () => {
  type ExceptionRow = { kind: string; entity_id: string; detail: string | null };
  const listed = async (tx: pg.Client, claims: Claims, workOrderId: string) => {
    await actAs(tx, claims);
    const { rows } = await tx.query<ExceptionRow>(
      "select kind, entity_id, detail from public.operational_exceptions(200)",
    );
    return rows.filter((r) => r.kind === "payment_attention" && r.entity_id === workOrderId);
  };

  it("paid_online_and_counter on the Stripe deposit; it clears by a refund or by a given-back void", async () => {
    await inTransaction(conn, async (tx) => {
      const d = await answered(tx);
      const p = await startCheckout(tx, d);
      const { counter_payment_id: id, open_checkouts } = await record(tx, {
        workOrderId: d.job.id,
        quoteId: d.quoteId,
        amount: "120.00",
      });
      expect(open_checkouts).toBe(1);
      // The customer finishes the tab they already had open (D159b records it).
      expect(await pay(tx, p)).toMatchObject({ outcome: "payment_paid" });
      expect(await issuesOfJob(tx, d.job.id)).toEqual([
        {
          payment_id: p.paymentId,
          counter_payment_id: null,
          issue: "paid_online_and_counter",
          severity: "danger",
          message:
            "The deposit of $120.00 was paid online and at the counter. Refund the online payment in Stripe, or, if the counter money was given back, an admin records it as given back.",
        },
      ]);
      expect(await depositRow(tx, d.quoteId)).toEqual({ state: "paid", counter_payment_id: id });
      expect(await listed(tx, ADMIN, d.job.id)).toHaveLength(1);
      expect(await listed(tx, MANAGER, d.job.id)).toHaveLength(1);
      expect(await listed(tx, MECHANIC2, d.job.id)).toEqual([]);

      await tryAndUndo(tx, async () => {
        await refund(tx, p, 12000);
        expect(await issuesOfJob(tx, d.job.id)).toEqual([]);
      });
      await voidCounter(tx, id, "given_back", "Customer paid online as well");
      expect(await issuesOfJob(tx, d.job.id)).toEqual([]);
      expect(await depositRow(tx, d.quoteId)).toEqual({ state: "paid", counter_payment_id: null });
    });
  });

  it("counter paid_parts_cancelled, then paid_job_cancelled once the job is cancelled; a void clears them; Exceptions for admins and managers", async () => {
    await inTransaction(conn, async (tx) => {
      const d = await answered(tx);
      const { counter_payment_id: id } = await record(tx, {
        workOrderId: d.job.id,
        quoteId: d.quoteId,
        amount: "120.00",
      });
      expect(await issuesOfJob(tx, d.job.id)).toEqual([]);
      await actAs(tx, ADMIN);
      await cancelRequest(tx, d.partId);
      await cancelRequest(tx, d.serviceRequestId);
      expect(await issuesOfJob(tx, d.job.id)).toEqual([
        {
          payment_id: null,
          counter_payment_id: id,
          issue: "paid_parts_cancelled",
          severity: "danger",
          message:
            "$120.00 taken at the counter is held but every part it was for is cancelled. Give it back and have an admin record it as given back, or agree with the customer that it counts towards the job.",
        },
      ]);
      await actAs(tx, ADMIN);
      await setStatus(tx, d.job.id, "cancelled", "Customer withdrew");
      const cancelledMessage =
        "$120.00 taken at the counter is held but this job is cancelled. Give it back and have an admin record it as given back, or agree with the customer how it counts.";
      expect(await issuesOfJob(tx, d.job.id)).toEqual([
        {
          payment_id: null,
          counter_payment_id: id,
          issue: "paid_job_cancelled",
          severity: "danger",
          message: cancelledMessage,
        },
      ]);
      const since = await readAsOwner(tx, () =>
        scalar<boolean>(
          tx,
          `select i.since = c.received_at and i.quote_id = c.quote_id
             from public.payment_issues i join public.counter_payments c on c.id = i.counter_payment_id
            where i.counter_payment_id = $1`,
          [id],
        ),
      );
      expect(since).toBe(true);
      expect(await listed(tx, ADMIN, d.job.id)).toEqual([
        { kind: "payment_attention", entity_id: d.job.id, detail: cancelledMessage },
      ]);
      expect(await listed(tx, MANAGER, d.job.id)).toHaveLength(1);
      expect(await listed(tx, MECHANIC2, d.job.id)).toEqual([]);

      // Customers read none of it.
      await ownerMode(tx);
      const login = await linkCustomerLogin(tx, d.job.customer_id);
      await actAs(tx, customerClaims(login));
      expect(await scalar<number>(tx, "select count(*)::int from public.payment_issues")).toBe(0);

      await voidCounter(tx, id, "given_back", "Handed back in cash");
      expect(await issuesOfJob(tx, d.job.id)).toEqual([]);
      expect(await listed(tx, ADMIN, d.job.id)).toEqual([]);

      // A balance prepayment on a job then cancelled.
      const pre = await billedJob(tx, null);
      const { counter_payment_id: preId } = await record(tx, {
        workOrderId: pre.id,
        amount: "30.00",
      });
      await setStatus(tx, pre.id, "cancelled", "Customer withdrew");
      expect((await issuesOfJob(tx, pre.id)).map((r) => [r.issue, r.counter_payment_id])).toEqual([
        ["paid_job_cancelled", preId],
      ]);
    });
  });

  it("paid_above_bill on the newest counter payment of a completed job when no Stripe money is paid; clears on a void, a reopen or a bill that covers it", async () => {
    await inTransaction(conn, async (tx) => {
      const job = await billedJob(tx);
      await record(tx, { workOrderId: job.id, amount: "50.00" });
      const { counter_payment_id: second } = await record(tx, {
        workOrderId: job.id,
        amount: "50.00",
        method: "card",
      });
      // Open: paid ahead, but no issue (lines can still be added).
      expect(await issuesOfJob(tx, job.id)).toEqual([]);
      await completeJob(tx, job.id);
      const above = (id: string, over: string, bill: string) => ({
        payment_id: null,
        counter_payment_id: id,
        issue: "paid_above_bill",
        severity: "danger",
        message: `${over} more than this job's bill of ${bill} has been paid. Refund the extra in Stripe, or an admin records counter money given back.`,
      });
      expect(await issuesOfJob(tx, job.id)).toEqual([above(second, "$20.00", "$80.00")]);
      const since = await readAsOwner(tx, () =>
        scalar<boolean>(
          tx,
          `select i.since = greatest(w.completed_at, c.received_at)
             from public.payment_issues i
             join public.work_orders w on w.id = i.work_order_id
             join public.counter_payments c on c.id = i.counter_payment_id
            where i.counter_payment_id = $1`,
          [second],
        ),
      );
      expect(since).toBe(true);
      await setStatus(tx, job.id, "ready_for_collection");
      expect(await issueKinds(tx, job.id)).toEqual(["paid_above_bill"]);

      await voidCounter(tx, second, "given_back", "Handed the extra back");
      expect(await issuesOfJob(tx, job.id)).toEqual([]);
      const { counter_payment_id: third } = await record(tx, {
        workOrderId: job.id,
        amount: "40.00",
      });
      expect(await issuesOfJob(tx, job.id)).toEqual([above(third, "$10.00", "$80.00")]);
      // A reopen clears it; a line that covers the excess keeps it clear.
      await reopenJob(tx, job.id);
      expect(await issuesOfJob(tx, job.id)).toEqual([]);
      await addManualLine(tx, { workOrderId: job.id, description: "Bar tape", price: "10.00" });
      await completeJob(tx, job.id);
      expect(await issuesOfJob(tx, job.id)).toEqual([]);
      // Less than S$0.50 above the bill is not flagged.
      await record(tx, { workOrderId: job.id, amount: "0.49" });
      expect(await issuesOfJob(tx, job.id)).toEqual([]);
      await setStatus(tx, job.id, "collected");
      const { counter_payment_id: last } = await record(tx, {
        workOrderId: job.id,
        amount: "0.01",
      });
      expect(await issuesOfJob(tx, job.id)).toEqual([above(last, "$0.50", "$90.00")]);
    });
  });

  it("paid_above_bill on the newest paid Stripe payment once a balance or counter payment exists; a refund or a void clears it", async () => {
    await inTransaction(conn, async (tx) => {
      // A counter balance, then the customer pays the still-open balance session.
      const job = await billedJob(tx, "100.00");
      await completeJob(tx, job.id);
      const b = await balancePayment(tx, job.id, "100.00");
      const { counter_payment_id: cash, open_checkouts } = await record(tx, {
        workOrderId: job.id,
        amount: "100.00",
      });
      expect(open_checkouts).toBe(1);
      await pay(tx, b);
      const message =
        "$100.00 more than this job's bill of $100.00 has been paid. Refund the extra in Stripe, or an admin records counter money given back.";
      expect(await issuesOfJob(tx, job.id)).toEqual([
        {
          payment_id: b.paymentId,
          counter_payment_id: null,
          issue: "paid_above_bill",
          severity: "danger",
          message,
        },
      ]);
      expect(await listed(tx, ADMIN, job.id)).toEqual([
        { kind: "payment_attention", entity_id: job.id, detail: message },
      ]);
      await tryAndUndo(tx, async () => {
        await refund(tx, b, 10000);
        expect(await issuesOfJob(tx, job.id)).toEqual([]);
      });
      await voidCounter(tx, cash, "given_back", "Paid online after all");
      expect(await issuesOfJob(tx, job.id)).toEqual([]);

      // Stripe money alone above the bill is not this issue (as before): a
      // deposit Stripe took more of than asked, on a completed job.
      const d = await answered(tx);
      const p = await startCheckout(tx, d);
      await pay(tx, p, { amountCents: 30000 });
      await fitPartOnly(tx, d);
      await completeJob(tx, d.job.id);
      expect(await totals(tx, d.job.id)).toMatchObject({
        job_total: "240.00",
        held_over_total: "60.00",
      });
      expect(await issueKinds(tx, d.job.id)).toEqual(["amount_mismatch"]);
      // Once a counter payment exists, it sits on the Stripe payment.
      const { counter_payment_id: one } = await record(tx, {
        workOrderId: d.job.id,
        amount: "1.00",
      });
      expect(await issuesOfJob(tx, d.job.id)).toEqual([
        expect.objectContaining({ issue: "amount_mismatch", payment_id: p.paymentId }),
        {
          payment_id: p.paymentId,
          counter_payment_id: null,
          issue: "paid_above_bill",
          severity: "danger",
          message:
            "$61.00 more than this job's bill of $240.00 has been paid. Refund the extra in Stripe, or an admin records counter money given back.",
        },
      ]);
      await voidCounter(tx, one);
      expect(await issueKinds(tx, d.job.id)).toEqual(["amount_mismatch"]);
    });
  });

  it("paid_above_bill when Stripe alone paid above the bill once a balance payment is paid: on the newest paid payment only; a refund clears it; a balance still pending opens nothing", async () => {
    await inTransaction(conn, async (tx) => {
      // A deposit of 120.00, the part fitted (a 240.00 bill), then a balance
      // of 200.00 paid later (an old link's tab and a new one's, say).
      const d = await answered(tx);
      const p = await startCheckout(tx, d);
      await pay(tx, p);
      await fitPartOnly(tx, d);
      await completeJob(tx, d.job.id);
      const b = await balancePayment(tx, d.job.id, "200.00");
      await deliver(tx, "checkout.session.completed", paidSession(b), unixNow() + 5);
      expect(await totals(tx, d.job.id)).toMatchObject({
        job_total: "240.00",
        held_over_total: "80.00",
        paid_at_counter: "0.00",
      });
      const message =
        "$80.00 more than this job's bill of $240.00 has been paid. Refund the extra in Stripe, or an admin records counter money given back.";
      expect(await issuesOfJob(tx, d.job.id)).toEqual([
        {
          payment_id: b.paymentId,
          counter_payment_id: null,
          issue: "paid_above_bill",
          severity: "danger",
          message,
        },
      ]);
      expect(await listed(tx, ADMIN, d.job.id)).toEqual([
        { kind: "payment_attention", entity_id: d.job.id, detail: message },
      ]);
      const since = await readAsOwner(tx, () =>
        scalar<boolean>(
          tx,
          `select i.since = greatest(w.completed_at, p.paid_at)
             from public.payment_issues i
             join public.work_orders w on w.id = i.work_order_id
             join public.payments p on p.id = i.payment_id
            where i.payment_id = $1 and i.issue = 'paid_above_bill'`,
          [b.paymentId],
        ),
      );
      expect(since).toBe(true);
      await tryAndUndo(tx, async () => {
        await refund(tx, b, 8000);
        expect(await issuesOfJob(tx, d.job.id)).toEqual([]);
      });

      // A balance payment still pending put no money on the job: Stripe
      // money alone above the bill stays what it was (amount_mismatch only).
      const e = await answered(tx);
      const q = await startCheckout(tx, e);
      await pay(tx, q, { amountCents: 30000 });
      await fitPartOnly(tx, e);
      await completeJob(tx, e.job.id);
      await balancePayment(tx, e.job.id, "10.00");
      expect(await issueKinds(tx, e.job.id)).toEqual(["amount_mismatch"]);
    });
  });

  it("paid_above_bill is left out beside a Stripe deposit held for cancelled parts; once it is refunded, the counter money above the bill is named", async () => {
    await inTransaction(conn, async (tx) => {
      // A Stripe deposit of 120.00 whose part is cancelled; the service fitted: a 25.00 bill.
      const d = await answered(tx);
      const p = await startCheckout(tx, d);
      await pay(tx, p);
      await actAs(tx, ADMIN);
      await cancelRequest(tx, d.partId);
      await fit(tx, d.serviceRequestId);
      await completeJob(tx, d.job.id);
      await record(tx, { workOrderId: d.job.id, amount: "25.00" });
      expect(await totals(tx, d.job.id)).toMatchObject({
        job_total: "25.00",
        held_over_total: "120.00",
      });
      expect(await issuesOfJob(tx, d.job.id)).toEqual([
        expect.objectContaining({
          payment_id: p.paymentId,
          counter_payment_id: null,
          issue: "paid_parts_cancelled",
        }),
      ]);
      // Counter money above the bill as well: the deposit's issue still names it.
      await record(tx, { workOrderId: d.job.id, amount: "10.00" });
      expect(await issueKinds(tx, d.job.id)).toEqual(["paid_parts_cancelled"]);
      // The deposit refunded in Stripe: what is still above the bill shows.
      await refund(tx, p, 12000);
      expect(await issuesOfJob(tx, d.job.id)).toEqual([
        {
          payment_id: p.paymentId,
          counter_payment_id: null,
          issue: "paid_above_bill",
          severity: "danger",
          message:
            "$10.00 more than this job's bill of $25.00 has been paid. Refund the extra in Stripe, or an admin records counter money given back.",
        },
      ]);
    });
  });

  it("paid_above_bill is left out beside a counter deposit held for cancelled parts, with a Stripe balance or counter money beside it; once it is given back, the rest above the bill is named", async () => {
    await inTransaction(conn, async (tx) => {
      const d = await answered(tx);
      const { counter_payment_id: dep } = await record(tx, {
        workOrderId: d.job.id,
        quoteId: d.quoteId,
        amount: "120.00",
      });
      await actAs(tx, ADMIN);
      await cancelRequest(tx, d.partId);
      await fit(tx, d.serviceRequestId);
      await completeJob(tx, d.job.id);
      expect(await totals(tx, d.job.id)).toMatchObject({
        job_total: "25.00",
        held_over_total: "95.00",
      });
      const cancelled = {
        payment_id: null,
        counter_payment_id: dep,
        issue: "paid_parts_cancelled",
        severity: "danger",
        message:
          "$120.00 taken at the counter is held but every part it was for is cancelled. Give it back and have an admin record it as given back, or agree with the customer that it counts towards the job.",
      };
      expect(await issuesOfJob(tx, d.job.id)).toEqual([cancelled]);
      // A Stripe balance paid as well opens the gate: still the deposit's issue only.
      await tryAndUndo(tx, async () => {
        const b = await balancePayment(tx, d.job.id, "25.00");
        await pay(tx, b);
        expect(await totals(tx, d.job.id)).toMatchObject({ held_over_total: "120.00" });
        expect(await issuesOfJob(tx, d.job.id)).toEqual([cancelled]);
      });
      // Counter money above the bill beside it: the same.
      const { counter_payment_id: extra } = await record(tx, {
        workOrderId: d.job.id,
        amount: "35.00",
      });
      expect(await issuesOfJob(tx, d.job.id)).toEqual([cancelled]);
      // The deposit given back: the 10.00 still above the bill, on the newest counter payment.
      await voidCounter(tx, dep, "given_back", "Handed the deposit back");
      expect(await issuesOfJob(tx, d.job.id)).toEqual([
        {
          payment_id: null,
          counter_payment_id: extra,
          issue: "paid_above_bill",
          severity: "danger",
          message:
            "$10.00 more than this job's bill of $25.00 has been paid. Refund the extra in Stripe, or an admin records counter money given back.",
        },
      ]);
    });
  });

  it("paid_above_bill is left out beside paid_online_and_counter, paid_twice, or a deposit held for cancelled or unfitted parts, which already name the surplus", async () => {
    await inTransaction(conn, async (tx) => {
      // A 240.00 deposit paid online and at the counter, the part fitted: 480 paid on a 240 bill.
      const d = await answered(tx, { percent: 100 });
      const p = await startCheckout(tx, d);
      const { counter_payment_id: id } = await record(tx, {
        workOrderId: d.job.id,
        quoteId: d.quoteId,
        amount: "240.00",
      });
      await pay(tx, p);
      await fitPartOnly(tx, d);
      await completeJob(tx, d.job.id);
      expect(await totals(tx, d.job.id)).toMatchObject({ held_over_total: "240.00" });
      expect(await issueKinds(tx, d.job.id)).toEqual(["paid_online_and_counter"]);
      await voidCounter(tx, id, "given_back", "Handed back");
      expect(await issueKinds(tx, d.job.id)).toEqual([]);

      // A deposit paid twice online, plus a counter balance payment.
      const t = await answered(tx);
      const first = await startCheckout(tx, t);
      await deliver(
        tx,
        "checkout.session.expired",
        paidSession(first, { status: "expired", paymentStatus: "unpaid", paymentIntent: null }),
      );
      const second = await startCheckout(tx, t);
      await pay(tx, second);
      await deliver(tx, "checkout.session.completed", paidSession(first), unixNow() + 5);
      await fitPartOnly(tx, t);
      await completeJob(tx, t.job.id);
      await record(tx, { workOrderId: t.job.id, amount: "1.00" });
      expect(await totals(tx, t.job.id)).toMatchObject({ held_over_total: "1.00" });
      expect(await issueKinds(tx, t.job.id)).toEqual(["paid_twice"]);

      // A job completed before D149b with its part unfitted (production's
      // J-000002 kind), then counter money: the deposit's
      // paid_parts_not_fitted names what is held. Once the deposit is
      // refunded, the counter money above the bill shows.
      const g = await answered(tx);
      const gp = await startCheckout(tx, g);
      await pay(tx, gp);
      await actAs(tx, ADMIN);
      await addManualLine(tx, { workOrderId: g.job.id, description: "Labour", price: "10.00" });
      await beforeTheGuard(tx, () => completeJob(tx, g.job.id));
      await record(tx, { workOrderId: g.job.id, amount: "15.00" });
      expect(await totals(tx, g.job.id)).toMatchObject({
        job_total: "10.00",
        held_over_total: "125.00",
      });
      expect(await issueKinds(tx, g.job.id)).toEqual(["paid_parts_not_fitted"]);
      await refund(tx, gp, 12000);
      expect(await issuesOfJob(tx, g.job.id)).toEqual([
        {
          payment_id: gp.paymentId,
          counter_payment_id: null,
          issue: "paid_above_bill",
          severity: "danger",
          message:
            "$5.00 more than this job's bill of $10.00 has been paid. Refund the extra in Stripe, or an admin records counter money given back.",
        },
      ]);
    });
  });
});

// ---------------------------------------------------------------------------
// 9. Unchanged without counter or balance payments (PR A's promise)
// ---------------------------------------------------------------------------

/** A view's statement as its merged migration created it, renamed to a temporary view. */
function mergedView(file: string, view: string, as: string): string {
  const sql = readFileSync(path.join(process.cwd(), "supabase/migrations", file), "utf8");
  const start = sql.search(new RegExp(`create (or replace )?view public\\.${view}\\b`));
  const end = sql.indexOf(`comment on view public.${view}`, start);
  if (start < 0 || end < 0) throw new Error(`${view} was not found in ${file}`);
  return sql
    .slice(start, end)
    .trim()
    .replace(/;$/, "")
    .replace(
      new RegExp(`^create (or replace )?view public\\.${view}`),
      `create temporary view ${as}`,
    );
}

describe("A database without counter or balance payments reads as before (D161j)", () => {
  it("payment_issues, quote_deposits and the old work_order_payment_totals columns equal the merged views", async () => {
    await inTransaction(conn, async (tx) => {
      // Deposits in each state the merged views know.
      const paid = await answered(tx);
      await pay(tx, await startCheckout(tx, paid));
      const partsCancelled = await answered(tx);
      await pay(tx, await startCheckout(tx, partsCancelled));
      await actAs(tx, ADMIN);
      await cancelRequest(tx, partsCancelled.partId);
      const jobCancelled = await answered(tx);
      await pay(tx, await startCheckout(tx, jobCancelled));
      await actAs(tx, ADMIN);
      await cancelRequest(tx, jobCancelled.partId);
      await cancelRequest(tx, jobCancelled.serviceRequestId);
      await setStatus(tx, jobCancelled.job.id, "cancelled", "Customer withdrew");
      const twice = await answered(tx);
      const t1 = await startCheckout(tx, twice);
      await deliver(
        tx,
        "checkout.session.expired",
        paidSession(t1, { status: "expired", paymentStatus: "unpaid", paymentIntent: null }),
      );
      await pay(tx, await startCheckout(tx, twice));
      await deliver(tx, "checkout.session.completed", paidSession(t1), unixNow() + 5);
      const over = await answered(tx);
      await pay(tx, await startCheckout(tx, over), { amountCents: 30000 });
      await fitPartOnly(tx, over);
      await completeJob(tx, over.job.id);
      const refunded = await answered(tx);
      const r = await startCheckout(tx, refunded);
      await pay(tx, r);
      await refund(tx, r, 12000);
      const notFitted = await answered(tx);
      await pay(tx, await startCheckout(tx, notFitted));
      await actAs(tx, ADMIN);
      await beforeTheGuard(tx, () => walkTo(tx, notFitted.job.id, "collected"));
      const proc = await answered(tx);
      await processing(tx, await startCheckout(tx, proc));
      await answered(tx); // due, never paid
      const none = await answered(tx);
      await cancelRequest(tx, none.partId);
      await billedJob(tx); // no payment at all

      await readAsOwner(tx, async () => {
        expect(await scalar<number>(tx, "select count(*)::int from public.counter_payments")).toBe(
          0,
        );
        expect(
          await scalar<number>(
            tx,
            "select count(*)::int from public.payments where kind = 'balance'",
          ),
        ).toBe(0);
        await tx.query(
          mergedView(
            "20261014000700_indent_closed_jobs.sql",
            "payment_issues",
            "merged_payment_issues",
          ),
        );
        await tx.query(
          mergedView(
            "20261014000500_indent_deposits.sql",
            "quote_deposits",
            "merged_quote_deposits",
          ),
        );
        await tx.query(
          mergedView(
            "20261014000700_indent_closed_jobs.sql",
            "work_order_payment_totals",
            "merged_payment_totals",
          ),
        );
        const differ = (a: string, b: string) =>
          scalar<number>(tx, `select count(*)::int from ((${a}) except all (${b})) x`);
        const ISSUE_COLUMNS =
          "payment_id, work_order_id, quote_id, issue, severity, since, message";
        const newIssues = `select ${ISSUE_COLUMNS} from public.payment_issues`;
        const oldIssues = `select ${ISSUE_COLUMNS} from merged_payment_issues`;
        expect(
          await scalar<number>(tx, `select count(*)::int from (${oldIssues}) x`),
        ).toBeGreaterThanOrEqual(5);
        expect(await differ(newIssues, oldIssues)).toBe(0);
        expect(await differ(oldIssues, newIssues)).toBe(0);
        expect(
          await scalar<number>(
            tx,
            "select count(*)::int from public.payment_issues where counter_payment_id is not null",
          ),
        ).toBe(0);
        expect(
          (
            await tx.query<{ issue: string }>(
              "select distinct issue from merged_payment_issues order by 1",
            )
          ).rows.map((x) => x.issue),
        ).toEqual(
          expect.arrayContaining([
            "amount_mismatch",
            "paid_job_cancelled",
            "paid_parts_cancelled",
            "paid_parts_not_fitted",
            "paid_twice",
          ]),
        );

        const DEPOSIT_COLUMNS =
          "quote_id, work_order_id, sent_at, answered_at, currency, deposit_percent, deposit_amount, state, part_request_ids";
        const newDeposits = `select ${DEPOSIT_COLUMNS} from public.quote_deposits`;
        const oldDeposits = `select ${DEPOSIT_COLUMNS} from merged_quote_deposits`;
        expect(
          await scalar<number>(tx, `select count(distinct state)::int from (${oldDeposits}) x`),
        ).toBe(5);
        expect(await differ(newDeposits, oldDeposits)).toBe(0);
        expect(await differ(oldDeposits, newDeposits)).toBe(0);
        expect(
          await scalar<number>(
            tx,
            "select count(*)::int from public.quote_deposits where counter_payment_id is not null",
          ),
        ).toBe(0);

        const TOTAL_COLUMNS =
          "work_order_id, currency, paid_online, refunded_online, net_paid_online, job_total, balance_due, paid_ahead, held_over_total";
        const newTotals = `select ${TOTAL_COLUMNS} from public.work_order_payment_totals`;
        const oldTotals = `select ${TOTAL_COLUMNS} from merged_payment_totals`;
        // Every merged row is unchanged; the new rows are the jobs without a payment.
        expect(await differ(oldTotals, newTotals)).toBe(0);
        expect(
          await scalar<number>(
            tx,
            `select count(*)::int from ((${newTotals}) except all (${oldTotals})) x
              where exists (select 1 from public.payments p where p.work_order_id = x.work_order_id)`,
          ),
        ).toBe(0);
        expect(
          await scalar<number>(tx, "select count(*)::int from public.work_order_payment_totals"),
        ).toBe(await scalar<number>(tx, "select count(*)::int from public.work_orders"));
        // Nothing paid at the counter: net_paid is the online net.
        expect(
          await scalar<number>(
            tx,
            `select count(*)::int from public.work_order_payment_totals
              where paid_at_counter <> 0 or net_paid <> net_paid_online`,
          ),
        ).toBe(0);
      });
    });
  });
});

// ---------------------------------------------------------------------------
// 10. Concurrency (committed; per-file clone only)
// ---------------------------------------------------------------------------

describe.skipIf(!isolatedDatabase())("Concurrency (DATA-MODEL §19 lock order)", () => {
  // Each case holds the first call's locks in an open transaction and
  // proves the second waits on a lock before the first commits (race(),
  // tests/db/lock-race.ts).
  let setupConn: pg.Client;

  beforeAll(async () => {
    [setupConn] = await openConnections(1);
  });

  afterAll(async () => {
    await inTransaction(setupConn, (tx) => withPercent(tx, 0), { commit: true });
  });

  const committedDeposit = () => inTransaction(setupConn, (tx) => answered(tx), { commit: true });
  const committedJob = () => inTransaction(setupConn, (tx) => billedJob(tx), { commit: true });

  const countOf = (sql: string, params: unknown[]) => scalar<number>(conn, sql, params);

  it("a replayed counter payment id on two connections: one row and one entry; the second waits, then is replayed", async () => {
    const job = await committedJob();
    const d = await committedDeposit();
    for (const request of [
      { id: randomUUID(), workOrderId: job.id, amount: "40.00" },
      { id: randomUUID(), workOrderId: d.job.id, quoteId: d.quoteId, amount: "120.00" },
    ]) {
      const [first, second] = await race(
        setupConn,
        { as: ADMIN, run: (tx) => callRecord(tx, request) },
        { as: ADMIN, run: (tx) => callRecord(tx, request) },
      );
      expect(first).toMatchObject({
        ok: true,
        value: { counter_payment_id: request.id, replayed: false },
      });
      expect(second).toMatchObject({
        ok: true,
        value: { counter_payment_id: request.id, replayed: true },
      });
      expect(
        await countOf("select count(*)::int from public.counter_payments where id = $1", [
          request.id,
        ]),
      ).toBe(1);
      expect(
        await countOf(
          `select count(*)::int from public.work_order_events
            where work_order_id = $1 and event_type = 'counter_payment_recorded'`,
          [request.workOrderId],
        ),
      ).toBe(1);
    }
  });

  it("the same id on two jobs at once: the second waits on the first's row, then is counter_payment_conflict and writes nothing", async () => {
    // The job lock does not serialise two jobs; the insert's on conflict does.
    const a = await committedJob();
    const b = await committedJob();
    const id = randomUUID();
    const [first, second] = await race(
      setupConn,
      { as: ADMIN, run: (tx) => callRecord(tx, { id, workOrderId: a.id, amount: "10.00" }) },
      { as: ADMIN, run: (tx) => callRecord(tx, { id, workOrderId: b.id, amount: "10.00" }) },
    );
    expect(first).toMatchObject({ ok: true, value: { counter_payment_id: id, replayed: false } });
    expect(second).toMatchObject({ ok: false, error: p0001("counter_payment_conflict") });
    expect(
      await countOf("select count(*)::int from public.counter_payments where work_order_id = $1", [
        b.id,
      ]),
    ).toBe(0);
    expect(
      await countOf(
        `select count(*)::int from public.work_order_events
          where work_order_id = $1 and event_type = 'counter_payment_recorded'`,
        [b.id],
      ),
    ).toBe(0);
  });

  it("two counter deposits for one quote: the second waits on the job, then is deposit_already_paid", async () => {
    const d = await committedDeposit();
    const deposit = { workOrderId: d.job.id, quoteId: d.quoteId, amount: "120.00" };
    const [first, second] = await race(
      setupConn,
      { as: ADMIN, run: (tx) => callRecord(tx, { ...deposit, id: randomUUID() }) },
      { as: ADMIN, run: (tx) => callRecord(tx, { ...deposit, id: randomUUID() }) },
    );
    expect(first).toMatchObject({ ok: true, value: { replayed: false } });
    expect(second).toMatchObject({ ok: false, error: p0001("deposit_already_paid") });
    expect(
      await countOf("select count(*)::int from public.counter_payments where quote_id = $1", [
        d.quoteId,
      ]),
    ).toBe(1);
    const { rows } = await conn.query(
      "select state, counter_payment_id from public.quote_deposits where quote_id = $1",
      [d.quoteId],
    );
    expect(rows).toEqual([
      {
        state: "paid",
        counter_payment_id: (first as { value: Recorded }).value.counter_payment_id,
      },
    ]);
  });

  it("a quote of another job is refused without waiting on that quote or its job", async () => {
    const d = await committedDeposit();
    const other = await committedJob();
    const [holder, caller] = await openConnections(2);
    await holder.query("begin");
    try {
      await holder.query("select 1 from public.work_orders where id = $1 for update", [d.job.id]);
      await holder.query("select 1 from public.quotes where id = $1 for update", [d.quoteId]);
      const result = await committed(
        caller,
        async (tx) => {
          await tx.query("set local lock_timeout = '3s'");
          return callRecord(tx, { workOrderId: other.id, quoteId: d.quoteId, amount: "120.00" });
        },
        ADMIN,
      );
      expect(result).toMatchObject({ ok: false, error: p0001("counter_payment_quote_mismatch") });
    } finally {
      await holder.query("rollback");
      await Promise.all([holder.end(), caller.end()]);
    }
  });

  it("ordering without a reason waits for a counter deposit still recording, then orders (the gate reads under the job lock)", async () => {
    const d = await committedDeposit();
    const [recorded, ordered] = await race(
      setupConn,
      {
        as: ADMIN,
        run: (tx) =>
          callRecord(tx, { workOrderId: d.job.id, quoteId: d.quoteId, amount: "120.00" }),
      },
      { as: ADMIN, run: (tx) => orderParts(tx, [d.partId], d.supplierId) },
    );
    expect(recorded.ok, JSON.stringify(recorded)).toBe(true);
    expect(ordered.ok, JSON.stringify(ordered)).toBe(true);
    expect(
      await scalar<string>(
        conn,
        "select status::text from public.job_part_requests where id = $1",
        [d.partId],
      ),
    ).toBe("ordered");
  });

  it("a void and an order without a reason: the order waits for the void, then is refused deposit_unpaid", async () => {
    const d = await committedDeposit();
    const { counter_payment_id: id } = await inTransaction(
      setupConn,
      (tx) => record(tx, { workOrderId: d.job.id, quoteId: d.quoteId, amount: "120.00" }),
      { commit: true },
    );
    const [voided, ordered] = await race(
      setupConn,
      { as: ADMIN, run: (tx) => callVoid(tx, id, "recorded_in_error", "Wrong job") },
      { as: ADMIN, run: (tx) => orderParts(tx, [d.partId], d.supplierId) },
    );
    expect(voided).toMatchObject({ ok: true, value: { replayed: false } });
    expect(ordered).toMatchObject({ ok: false, error: p0001("deposit_unpaid") });
    // An admin can still order with a reason (D152).
    const withReason = await committed(
      setupConn,
      (tx) => orderWithReason(tx, [d.partId], d.supplierId, "Paying at collection"),
      ADMIN,
    );
    expect(withReason.ok, JSON.stringify(withReason)).toBe(true);
  });

  it("the same void on two connections: the second waits on the job, then is replayed", async () => {
    const job = await committedJob();
    const { counter_payment_id: id } = await inTransaction(
      setupConn,
      (tx) => record(tx, { workOrderId: job.id, amount: "20.00" }),
      { commit: true },
    );
    const run = (tx: pg.Client) => callVoid(tx, id, "given_back", "Handed back");
    const [first, second] = await race(setupConn, { as: ADMIN, run }, { as: ADMIN, run });
    expect(first).toMatchObject({ ok: true, value: { replayed: false } });
    expect(second).toMatchObject({ ok: true, value: { replayed: true } });
    expect(
      await countOf(
        `select count(*)::int from public.work_order_events
          where work_order_id = $1 and event_type = 'counter_payment_voided'`,
        [job.id],
      ),
    ).toBe(1);
  });
});
