/**
 * Stripe payments, Phase 14 step 1 (PLAN Phase 14, D150, D153, D155,
 * D157-D159; ADR-025; DATA-MODEL §19, §15, §16): stripe_events,
 * payments and payment_refunds, the apply paths behind
 * public.record_stripe_event (verified webhooks and rejected deliveries)
 * and public.record_stripe_read (the server's own reads with the secret
 * key), and the guards that keep a payment Stripe's word only.
 *
 * Step 2's Checkout RPCs do not exist yet, so a pending payment is inserted
 * as the owner (pendingPayment), which the guard allows: a payment starts
 * pending and only Stripe moves it. Stripe objects come from
 * tests/fixtures/stripe.ts. Every id a test uses is fresh (tag()). The
 * service-role RPCs are called as service_role, as the webhook route and
 * the Checkout code will call them. The "needs attention" issues
 * (payment_issues) are step 2's view; here the columns they derive from
 * are asserted instead.
 */
import { createHash, randomUUID } from "node:crypto";

import type pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { LOCATION } from "../fixtures/ids";
import {
  refundObject,
  sessionObject,
  stripeEvent,
  stripeWebhookHeaders,
  type SessionInput,
} from "../fixtures/stripe";
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
  ADMIN,
  MANAGER,
  MECHANIC1,
  addPart,
  addStock,
  committed,
  completeJob,
  makeProduct,
  newJob,
  readAsOwner,
} from "./inventory-fixtures";
import { shopToday } from "./reporting-fixtures";
import { addServiceLine, failsWith, makeService, ownerMode, setStatus } from "./workshop-fixtures";

const SERVICE: Claims = { role: "service_role" };
const ANON: Claims = { role: "anon" };
const DENIED = { code: "42501" };

let conn: pg.Client;

beforeAll(async () => {
  conn = await connect();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A fresh suffix for Stripe ids (letters and digits only). */
const tag = () => randomUUID().replace(/-/g, "").slice(0, 24);
const evtId = () => `evt_${tag()}`;

type Recorded = {
  event_id: string;
  duplicate: boolean;
  event_status: string;
  outcome: string | null;
  payment_id: string | null;
};

const sha256hex = (raw: string) => createHash("sha256").update(raw, "utf8").digest("hex");

/** public.record_stripe_event as whoever `tx` is (positional, as the route calls it). */
async function callRecord(
  tx: pg.Client,
  payload: unknown,
  {
    reason = null,
    headers,
    raw,
  }: { reason?: string | null; headers?: Record<string, string>; raw?: string } = {},
): Promise<Recorded> {
  const body = raw ?? JSON.stringify(payload);
  const { rows } = await tx.query<Recorded>(
    `select event_id, duplicate, event_status::text, outcome, payment_id
       from public.record_stripe_event($1::jsonb, $2::jsonb, $3, $4,
                                       $5::public.stripe_rejection_reason, $6)`,
    [
      payload === null ? null : JSON.stringify(payload),
      JSON.stringify(headers ?? stripeWebhookHeaders({ raw: body })),
      sha256hex(body),
      Buffer.byteLength(body),
      reason,
      `corr-${tag()}`,
    ],
  );
  return rows[0];
}

/** record_stripe_event as the service role (leaves `tx` as the service role). */
async function record(
  tx: pg.Client,
  payload: unknown,
  options?: Parameters<typeof callRecord>[2],
): Promise<Recorded> {
  await actAs(tx, SERVICE);
  return callRecord(tx, payload, options);
}

type ReadResult = {
  event_id: string;
  event_status: string;
  outcome: string | null;
  payment_status: string;
};

/** public.record_stripe_read as whoever `tx` is. */
async function callRead(tx: pg.Client, paymentId: string, object: unknown): Promise<ReadResult> {
  const { rows } = await tx.query<ReadResult>(
    `select event_id, event_status::text, outcome, payment_status::text
       from public.record_stripe_read($1, $2::jsonb, $3)`,
    [paymentId, object === null ? null : JSON.stringify(object), `corr-${tag()}`],
  );
  return rows[0];
}

async function read(tx: pg.Client, paymentId: string, object: unknown): Promise<ReadResult> {
  await actAs(tx, SERVICE);
  return callRead(tx, paymentId, object);
}

/**
 * A pending payment, inserted as the owner (the guard allows a pending
 * insert; step 2's record_deposit_checkout stands in for this). Leaves `tx`
 * as the owner.
 */
async function pendingPayment(
  tx: pg.Client,
  {
    workOrderId,
    quoteId = null,
    kind = "balance",
    amount = "120.00",
    sessionId = `cs_test_${tag()}`,
    livemode = false,
  }: {
    workOrderId: string;
    quoteId?: string | null;
    kind?: "deposit" | "balance";
    amount?: string;
    sessionId?: string;
    livemode?: boolean;
  },
): Promise<{ id: string; sessionId: string }> {
  await ownerMode(tx);
  const id = randomUUID();
  await tx.query(
    `insert into public.payments
       (id, work_order_id, quote_id, kind, amount, stripe_checkout_session_id,
        stripe_session_expires_at, livemode)
     values ($1, $2, $3, $4, $5, $6, now() + interval '1 hour', $7)`,
    [id, workOrderId, quoteId, kind, amount, sessionId, livemode],
  );
  return { id, sessionId };
}

type Pay = { id: string; sessionId: string; workOrderId: string; pi: string };

/** A new job with a pending 120.00 balance payment; leaves `tx` as the service role. */
async function setupPayment(
  tx: pg.Client,
  o: { amount?: string; livemode?: boolean; workOrderId?: string } = {},
): Promise<Pay> {
  const workOrderId = o.workOrderId ?? (await newJob(tx)).id;
  const p = await pendingPayment(tx, { workOrderId, amount: o.amount, livemode: o.livemode });
  await actAs(tx, SERVICE);
  return { ...p, workOrderId, pi: `pi_${tag()}` };
}

/** The payment's Checkout Session as Stripe would send it (paid, 12000 cents by default). */
const session = (p: Pay, o: Partial<SessionInput> = {}) =>
  sessionObject({
    id: p.sessionId,
    paymentId: p.id,
    workOrderId: p.workOrderId,
    kind: "balance",
    amountCents: 12000,
    paymentIntent: p.pi,
    ...o,
  });

/** A verified webhook of `type` carrying `object`, as the service role. */
const deliver = (
  tx: pg.Client,
  type: string,
  object: Record<string, unknown>,
  o: { id?: string; created?: number; livemode?: boolean } = {},
) => record(tx, stripeEvent({ id: o.id ?? evtId(), type, object, ...o }));

const refund = (
  p: Pay,
  id: string,
  amountCents: number,
  status: string,
  created = Math.floor(Date.now() / 1000),
) => refundObject({ id, paymentIntent: p.pi, amountCents, status, created });

type PaymentRow = {
  status: string;
  amount: string;
  amount_cents: number;
  amount_received: string | null;
  refunded_amount: string;
  paid_at: Date | null;
  failed_at: Date | null;
  expired_at: Date | null;
  checkout_completed_at: Date | null;
  checked_at: Date | null;
  stripe_payment_intent_id: string | null;
  last_event_id: string | null;
  updated_at: Date;
};

const paymentRow = (tx: pg.Client, id: string) =>
  readAsOwner(tx, async () => {
    const { rows } = await tx.query<PaymentRow>(
      `select status::text, amount::text, amount_cents::int, amount_received::text,
              refunded_amount::text, paid_at, failed_at, expired_at, checkout_completed_at,
              checked_at, stripe_payment_intent_id, last_event_id, updated_at
         from public.payments where id = $1`,
      [id],
    );
    return rows[0];
  });

type EventRow = {
  source: string;
  stripe_event_id: string | null;
  event_type: string;
  livemode: boolean | null;
  object_type: string | null;
  object_id: string | null;
  payload: Record<string, unknown> | null;
  payload_text: string | null;
  headers: Record<string, string>;
  body_sha256: string | null;
  body_bytes: number | null;
  rejection_reason: string | null;
  status: string;
  outcome: string | null;
  payment_id: string | null;
  work_order_id: string | null;
  delivery_count: number;
  processed_at: Date | null;
};

const eventRow = (tx: pg.Client, id: string) =>
  readAsOwner(tx, async () => {
    const { rows } = await tx.query<EventRow>(
      `select source::text, stripe_event_id, event_type, livemode, object_type, object_id, payload,
              payload::text as payload_text, headers, body_sha256, body_bytes,
              rejection_reason::text, status::text, outcome, payment_id, work_order_id,
              delivery_count, processed_at
         from public.stripe_events where id = $1`,
      [id],
    );
    return rows[0];
  });

type RefundRow = {
  stripe_refund_id: string;
  payment_id: string | null;
  amount: string;
  currency: string;
  status: string;
  stripe_created_at: Date | null;
};

const refundRows = (tx: pg.Client, pi: string) =>
  readAsOwner(tx, async () => {
    const { rows } = await tx.query<RefundRow>(
      `select stripe_refund_id, payment_id, amount::text, currency::text, status::text,
              stripe_created_at
         from public.payment_refunds where stripe_payment_intent_id = $1
        order by stripe_refund_id`,
      [pi],
    );
    return rows;
  });

/** The job's payment timeline entries, oldest first, money as text. */
const paymentEvents = (tx: pg.Client, workOrderId: string) =>
  readAsOwner(tx, async () => {
    const { rows } = await tx.query<{
      event_type: string;
      amount: string | null;
      refunded: string | null;
      refunded_total: string | null;
      full: boolean | null;
      payload: Record<string, unknown>;
    }>(
      `select event_type::text, payload ->> 'amount' as amount, payload ->> 'refunded' as refunded,
              payload ->> 'refunded_total' as refunded_total, (payload -> 'full')::boolean as full,
              payload
         from public.work_order_events
        where work_order_id = $1 and event_type::text like 'payment\\_%'
        order by created_at, id`,
      [workOrderId],
    );
    return rows;
  });

const unixNow = () => Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------------------
// 1. Who can reach it
// ---------------------------------------------------------------------------

describe("Who can reach it (D86, DATA-MODEL §15)", () => {
  it("only the service role calls the RPCs; nobody writes the tables; staff, admins and customers read per policy", async () => {
    await inTransaction(conn, async (tx) => {
      const p = await setupPayment(tx);
      await deliver(tx, "checkout.session.completed", session(p));
      await deliver(tx, "refund.updated", refund(p, `re_${tag()}`, 5000, "succeeded"));
      const otherPi = `pi_${tag()}`;
      await deliver(
        tx,
        "refund.created",
        refundObject({
          id: `re_${tag()}`,
          paymentIntent: otherPi,
          amountCents: 700,
          status: "pending",
        }),
      );

      for (const claims of [ANON, MECHANIC1, MANAGER, ADMIN]) {
        await actAs(tx, claims);
        await failsWith(
          tx,
          () => callRecord(tx, stripeEvent({ id: evtId(), type: "x.y", object: {} })),
          {
            code: "42501",
            message: expect.stringMatching(/permission denied for function/),
          },
        );
        await failsWith(tx, () => callRead(tx, p.id, session(p)), {
          code: "42501",
          message: expect.stringMatching(/permission denied for function/),
        });
      }

      await actAs(tx, ADMIN);
      for (const table of ["stripe_events", "payments", "payment_refunds"]) {
        await failsWith(tx, () => tx.query(`insert into public.${table} default values`), DENIED);
        await failsWith(
          tx,
          () => tx.query(`update public.${table} set id = id where false`),
          DENIED,
        );
        await failsWith(tx, () => tx.query(`delete from public.${table} where false`), DENIED);
      }

      // Staff read payments and matched refunds; unmatched refunds and the
      // delivery evidence are admins only.
      await actAs(tx, MECHANIC1);
      expect(
        await scalar(tx, "select count(*)::int from public.payments where id = $1", [p.id]),
      ).toBe(1);
      expect(
        await scalar(
          tx,
          "select count(*)::int from public.payment_refunds where stripe_payment_intent_id = $1",
          [p.pi],
        ),
      ).toBe(1);
      expect(
        await scalar(
          tx,
          "select count(*)::int from public.payment_refunds where stripe_payment_intent_id = $1",
          [otherPi],
        ),
      ).toBe(0);
      expect(await scalar(tx, "select count(*)::int from public.stripe_events")).toBe(0);

      await actAs(tx, ADMIN);
      expect(
        await scalar(tx, "select count(*)::int from public.payments where id = $1", [p.id]),
      ).toBe(1);
      expect(
        await scalar(
          tx,
          "select count(*)::int from public.payment_refunds where stripe_payment_intent_id in ($1, $2)",
          [p.pi, otherPi],
        ),
      ).toBe(2);
      expect(
        await scalar(tx, "select count(*)::int from public.stripe_events"),
      ).toBeGreaterThanOrEqual(3);

      // A signed-in customer (the job's own) reads nothing.
      await ownerMode(tx);
      const customerId = await scalar<string>(
        tx,
        "select customer_id from public.work_orders where id = $1",
        [p.workOrderId],
      );
      const login = await linkCustomerLogin(tx, customerId);
      await actAs(tx, customerClaims(login));
      for (const table of ["stripe_events", "payments", "payment_refunds"]) {
        expect(await scalar(tx, `select count(*)::int from public.${table}`)).toBe(0);
      }

      await actAs(tx, ANON);
      for (const table of ["stripe_events", "payments", "payment_refunds"]) {
        await failsWith(tx, () => tx.query(`select 1 from public.${table}`), DENIED);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// 2-3. Provenance (D153, D159a) and the guards
// ---------------------------------------------------------------------------

describe("A payment changes only from a verified event (D153, D159a)", () => {
  it("a rejected delivery of a paid body changes nothing and keeps no body; a verified non-evt_ id is refused", async () => {
    await inTransaction(conn, async (tx) => {
      const p = await setupPayment(tx);
      const body = stripeEvent({
        id: evtId(),
        type: "checkout.session.completed",
        object: session(p),
      });
      const r = await record(tx, body, { reason: "signature_invalid" });
      expect(r).toMatchObject({
        duplicate: false,
        event_status: "rejected",
        outcome: null,
        payment_id: null,
      });
      expect(await eventRow(tx, r.event_id)).toMatchObject({
        source: "webhook",
        payload: null,
        stripe_event_id: null,
        status: "rejected",
        rejection_reason: "signature_invalid",
        event_type: "unknown",
      });
      expect((await paymentRow(tx, p.id)).status).toBe("pending");

      await failsWith(tx, () => callRecord(tx, { ...body, id: "notanevent_1" }), { code: "22023" });
      await failsWith(tx, () => callRecord(tx, { ...body, livemode: "false" }), { code: "22023" });
      await failsWith(tx, () => callRecord(tx, [1, 2]), { code: "22023" });
    });
  });
});

describe("The guards hold for every role, including the owner (D153)", () => {
  it("payments: no Stripe-owned change without the event being applied; checked_at alone is free", async () => {
    await inTransaction(conn, async (tx) => {
      const other = await setupPayment(tx);
      const applied = await deliver(tx, "checkout.session.completed", session(other));
      expect(applied.event_status).toBe("applied");

      const p = await setupPayment(tx);
      await ownerMode(tx);
      const immutable = { code: "P0001", message: "payment_immutable" };
      await failsWith(
        tx,
        () =>
          tx.query("update public.payments set status = 'paid', paid_at = now() where id = $1", [
            p.id,
          ]),
        immutable,
      );
      await failsWith(
        tx,
        () => tx.query("update public.payments set amount = 99 where id = $1", [p.id]),
        immutable,
      );
      await failsWith(
        tx,
        () => tx.query("delete from public.payments where id = $1", [p.id]),
        immutable,
      );
      await failsWith(
        tx,
        () =>
          tx.query(
            `insert into public.payments (id, work_order_id, kind, amount, stripe_checkout_session_id,
                                          stripe_session_expires_at, livemode, status, paid_at)
             values ($1, $2, 'balance', 10, $3, now(), false, 'paid', now())`,
            [randomUUID(), p.workOrderId, `cs_test_${tag()}`],
          ),
        immutable,
      );
      // Citing an event that is already decided is not provenance.
      await failsWith(
        tx,
        () =>
          tx.query(
            "update public.payments set status = 'expired', expired_at = now(), last_event_id = $2 where id = $1",
            [p.id, applied.event_id],
          ),
        immutable,
      );
      // ... nor is moving the citation on its own.
      await failsWith(
        tx,
        () =>
          tx.query("update public.payments set last_event_id = $2 where id = $1", [
            p.id,
            applied.event_id,
          ]),
        immutable,
      );
      await tx.query("update public.payments set checked_at = now() where id = $1", [p.id]);
      expect((await paymentRow(tx, p.id)).checked_at).not.toBeNull();
    });
  });

  it("payment_refunds: never deleted, amount fixed, a status never moves down in rank", async () => {
    await inTransaction(conn, async (tx) => {
      const p = await setupPayment(tx);
      await deliver(tx, "checkout.session.completed", session(p));
      const rid = `re_${tag()}`;
      await deliver(tx, "refund.updated", refund(p, rid, 5000, "succeeded"));
      await ownerMode(tx);
      const immutable = { code: "P0001", message: "payment_refund_immutable" };
      await failsWith(
        tx,
        () => tx.query("delete from public.payment_refunds where stripe_refund_id = $1", [rid]),
        immutable,
      );
      await failsWith(
        tx,
        () =>
          tx.query("update public.payment_refunds set amount = 1 where stripe_refund_id = $1", [
            rid,
          ]),
        immutable,
      );
      // Even citing a received event, succeeded (2) cannot go back to pending (0).
      const received = await scalar<string>(
        tx,
        `insert into public.stripe_events (source, event_type, payload, status)
         values ('api_read', 'read.refund', '{}'::jsonb, 'received') returning id`,
      );
      await failsWith(
        tx,
        () =>
          tx.query(
            "update public.payment_refunds set status = 'pending', last_event_id = $2 where stripe_refund_id = $1",
            [rid, received],
          ),
        immutable,
      );
      // ... and without one, nothing moves at all.
      await failsWith(
        tx,
        () =>
          tx.query(
            "update public.payment_refunds set status = 'failed' where stripe_refund_id = $1",
            [rid],
          ),
        immutable,
      );
      const decided = (await paymentRow(tx, p.id)).last_event_id;
      await failsWith(
        tx,
        () =>
          tx.query(
            `insert into public.payment_refunds (stripe_refund_id, stripe_payment_intent_id, amount, currency,
                                                 status, last_event_id)
             values ($1, $2, 1, 'SGD', 'succeeded', $3)`,
            [`re_${tag()}`, p.pi, decided],
          ),
        immutable,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// 4-5. Paid, cents, mismatches
// ---------------------------------------------------------------------------

describe("Paid, with exact amounts in cents (D153, D159d)", () => {
  it("completed and paid: Stripe's amount, Stripe's time, one timeline entry", async () => {
    await inTransaction(conn, async (tx) => {
      const p = await setupPayment(tx);
      const created = unixNow() - 120;
      const r = await deliver(tx, "checkout.session.completed", session(p), { created });
      expect(r).toMatchObject({
        duplicate: false,
        event_status: "applied",
        outcome: "payment_paid",
        payment_id: p.id,
      });
      const row = await paymentRow(tx, p.id);
      expect(row).toMatchObject({
        status: "paid",
        amount: "120.00",
        amount_cents: 12000,
        amount_received: "120.00",
        refunded_amount: "0.00",
        stripe_payment_intent_id: p.pi,
        last_event_id: r.event_id,
      });
      expect(row.paid_at?.getTime()).toBe(created * 1000);
      expect(row.checkout_completed_at).not.toBeNull();
      expect(await eventRow(tx, r.event_id)).toMatchObject({
        status: "applied",
        outcome: "payment_paid",
        payment_id: p.id,
        work_order_id: p.workOrderId,
        object_type: "checkout.session",
        object_id: p.sessionId,
      });
      const timeline = await paymentEvents(tx, p.workOrderId);
      expect(timeline).toHaveLength(1);
      expect(timeline[0]).toMatchObject({ event_type: "payment_received", amount: "120.00" });
      expect(timeline[0].payload).toMatchObject({
        payment_id: p.id,
        kind: "balance",
        currency: "SGD",
      });

      for (const [amount, cents] of [
        ["120.01", 12001],
        ["999999.99", 99999999],
        ["0.50", 50],
      ] as const) {
        const q = await setupPayment(tx, { amount, workOrderId: p.workOrderId });
        expect((await paymentRow(tx, q.id)).amount_cents).toBe(cents);
      }
      await ownerMode(tx);
      for (const amount of ["0.49", "1000000.00"]) {
        await failsWith(tx, () => pendingPayment(tx, { workOrderId: p.workOrderId, amount }), {
          code: "23514",
          constraint: "payments_amount_check",
        });
      }
    });
  });

  it("a mismatched amount or currency is recorded as paid, never refused (D159b)", async () => {
    await inTransaction(conn, async (tx) => {
      const cases: Array<[Partial<SessionInput>, string | null]> = [
        [{ amountCents: 11999 }, "119.99"],
        [{ currency: "usd" }, null],
        [{ amountCents: 12000.5 }, null],
        [{ amountCents: "12000" }, null],
      ];
      for (const [override, received] of cases) {
        const p = await setupPayment(tx);
        const r = await deliver(tx, "checkout.session.completed", session(p, override));
        expect(r, JSON.stringify(override)).toMatchObject({
          event_status: "applied",
          outcome: "paid_amount_mismatch",
        });
        expect(await paymentRow(tx, p.id)).toMatchObject({
          status: "paid",
          amount: "120.00",
          amount_received: received,
        });
        const timeline = await paymentEvents(tx, p.workOrderId);
        expect(timeline.map((e) => [e.event_type, e.amount])).toEqual([
          ["payment_received", received],
        ]);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// 6-7. Replays and out-of-order delivery
// ---------------------------------------------------------------------------

describe("A replayed event changes nothing (D153)", () => {
  it("the same evt_ twice is a duplicate; a second Event object for the same change is already_paid", async () => {
    await inTransaction(conn, async (tx) => {
      const p = await setupPayment(tx);
      const body = stripeEvent({
        id: evtId(),
        type: "checkout.session.completed",
        object: session(p),
      });
      const first = await record(tx, body);
      const before = await paymentRow(tx, p.id);
      const second = await record(tx, body);
      expect(second).toEqual({
        event_id: first.event_id,
        duplicate: true,
        event_status: "applied",
        outcome: "payment_paid",
        payment_id: p.id,
      });
      expect((await eventRow(tx, first.event_id)).delivery_count).toBe(2);
      expect((await paymentRow(tx, p.id)).updated_at).toEqual(before.updated_at);

      const again = await deliver(tx, "checkout.session.async_payment_succeeded", session(p));
      expect(again).toMatchObject({
        duplicate: false,
        event_status: "ignored",
        outcome: "already_paid",
      });
      expect((await paymentRow(tx, p.id)).updated_at).toEqual(before.updated_at);
      expect(await paymentEvents(tx, p.workOrderId)).toHaveLength(1);
    });
  });
});

describe("Out-of-order delivery (D159; DATA-MODEL §19)", () => {
  const unpaid = { paymentStatus: "unpaid" } as const;

  it("async_payment_succeeded before completed (unpaid): paid, then stale", async () => {
    await inTransaction(conn, async (tx) => {
      const p = await setupPayment(tx);
      expect(
        (await deliver(tx, "checkout.session.async_payment_succeeded", session(p))).outcome,
      ).toBe("payment_paid");
      expect(await deliver(tx, "checkout.session.completed", session(p, unpaid))).toMatchObject({
        event_status: "ignored",
        outcome: "stale",
      });
      expect((await paymentRow(tx, p.id)).status).toBe("paid");
    });
  });

  it("expired after paid: stale", async () => {
    await inTransaction(conn, async (tx) => {
      const p = await setupPayment(tx);
      await deliver(tx, "checkout.session.completed", session(p));
      expect(
        await deliver(
          tx,
          "checkout.session.expired",
          session(p, { status: "expired", paymentStatus: "unpaid" }),
        ),
      ).toMatchObject({ event_status: "ignored", outcome: "stale" });
      expect((await paymentRow(tx, p.id)).status).toBe("paid");
    });
  });

  it("completed (unpaid) then async_payment_failed: processing, then failed", async () => {
    await inTransaction(conn, async (tx) => {
      const p = await setupPayment(tx);
      expect(await deliver(tx, "checkout.session.completed", session(p, unpaid))).toMatchObject({
        event_status: "applied",
        outcome: "payment_processing",
      });
      const processing = await paymentRow(tx, p.id);
      expect(processing).toMatchObject({ status: "pending", stripe_payment_intent_id: p.pi });
      expect(processing.checkout_completed_at).not.toBeNull();
      expect(await deliver(tx, "checkout.session.completed", session(p, unpaid))).toMatchObject({
        event_status: "ignored",
        outcome: "already_processing",
      });
      expect(
        await deliver(tx, "checkout.session.async_payment_failed", session(p, unpaid)),
      ).toMatchObject({ event_status: "applied", outcome: "payment_failed" });
      const failed = await paymentRow(tx, p.id);
      expect(failed.status).toBe("failed");
      expect(failed.failed_at).not.toBeNull();
      expect(await paymentEvents(tx, p.workOrderId)).toEqual([]);
    });
  });

  it("async_payment_failed then completed (unpaid): failed, then stale", async () => {
    await inTransaction(conn, async (tx) => {
      const p = await setupPayment(tx);
      await deliver(tx, "checkout.session.async_payment_failed", session(p, unpaid));
      expect(await deliver(tx, "checkout.session.completed", session(p, unpaid))).toMatchObject({
        event_status: "ignored",
        outcome: "stale",
      });
      expect(
        await deliver(tx, "checkout.session.async_payment_failed", session(p, unpaid)),
      ).toMatchObject({ event_status: "ignored", outcome: "already_failed" });
      expect((await paymentRow(tx, p.id)).status).toBe("failed");
    });
  });

  it("paid after failed or expired: the money is real (paid_after_failed, paid_after_expired)", async () => {
    await inTransaction(conn, async (tx) => {
      const p = await setupPayment(tx);
      const expired = session(p, {
        status: "expired",
        paymentStatus: "unpaid",
        paymentIntent: null,
      });
      expect(await deliver(tx, "checkout.session.expired", expired)).toMatchObject({
        event_status: "applied",
        outcome: "payment_expired",
      });
      expect(await deliver(tx, "checkout.session.expired", expired)).toMatchObject({
        event_status: "ignored",
        outcome: "already_expired",
      });
      const before = await paymentRow(tx, p.id);
      expect(before.status).toBe("expired");
      expect(await deliver(tx, "checkout.session.completed", session(p))).toMatchObject({
        event_status: "applied",
        outcome: "paid_after_expired",
      });
      const after = await paymentRow(tx, p.id);
      expect(after.status).toBe("paid");
      expect(after.expired_at).toEqual(before.expired_at);

      const f = await setupPayment(tx);
      await deliver(
        tx,
        "checkout.session.async_payment_failed",
        session(f, { paymentStatus: "unpaid" }),
      );
      expect(
        await deliver(tx, "checkout.session.async_payment_succeeded", session(f)),
      ).toMatchObject({
        event_status: "applied",
        outcome: "paid_after_failed",
      });
      expect((await paymentRow(tx, f.id)).status).toBe("paid");
    });
  });

  it("an open session is still_open; a session Stripe completed cannot expire", async () => {
    await inTransaction(conn, async (tx) => {
      const p = await setupPayment(tx);
      const open = session(p, { status: "open", paymentStatus: "unpaid", paymentIntent: null });
      expect(await read(tx, p.id, open)).toMatchObject({
        event_status: "ignored",
        outcome: "still_open",
        payment_status: "pending",
      });
      await deliver(tx, "checkout.session.completed", session(p, unpaid));
      expect(
        await deliver(
          tx,
          "checkout.session.expired",
          session(p, { status: "expired", paymentStatus: "unpaid" }),
        ),
      ).toMatchObject({ event_status: "ignored", outcome: "stale" });
      expect((await paymentRow(tx, p.id)).status).toBe("pending");
    });
  });

  it("refund.updated (succeeded) before refund.created (pending): the lower rank changes nothing", async () => {
    await inTransaction(conn, async (tx) => {
      const p = await setupPayment(tx);
      await deliver(tx, "checkout.session.completed", session(p));
      const rid = `re_${tag()}`;
      expect(await deliver(tx, "refund.updated", refund(p, rid, 5000, "succeeded"))).toMatchObject({
        event_status: "applied",
        outcome: "refund_recorded",
        payment_id: p.id,
      });
      expect(await deliver(tx, "refund.created", refund(p, rid, 5000, "pending"))).toMatchObject({
        event_status: "ignored",
        outcome: "refund_unchanged",
      });
      expect((await refundRows(tx, p.pi)).map((r) => r.status)).toEqual(["succeeded"]);
      expect(await paymentRow(tx, p.id)).toMatchObject({
        status: "partially_refunded",
        refunded_amount: "50.00",
      });
    });
  });
});

// ---------------------------------------------------------------------------
// 8-10. Refunds
// ---------------------------------------------------------------------------

describe("Refunds and partial refunds (D155, D159c)", () => {
  it("only succeeded refunds count; a refund failing after success puts the amount back", async () => {
    await inTransaction(conn, async (tx) => {
      const p = await setupPayment(tx);
      await deliver(tx, "checkout.session.completed", session(p));
      const [r1, r2, r3] = [`re_${tag()}`, `pyr_${tag()}`, `re_${tag()}`];
      const t1 = unixNow() - 300;

      await deliver(tx, "refund.created", refund(p, r1, 5000, "pending", t1));
      expect(await paymentRow(tx, p.id)).toMatchObject({ status: "paid", refunded_amount: "0.00" });

      await deliver(tx, "refund.updated", refund(p, r1, 5000, "succeeded", t1));
      expect(await paymentRow(tx, p.id)).toMatchObject({
        status: "partially_refunded",
        refunded_amount: "50.00",
      });

      await deliver(tx, "refund.updated", refund(p, r2, 7000, "succeeded"));
      expect(await paymentRow(tx, p.id)).toMatchObject({
        status: "refunded",
        refunded_amount: "120.00",
      });

      // A PayNow refund that fails after succeeding (test card 4000000000005126).
      expect(await deliver(tx, "refund.failed", refund(p, r1, 5000, "failed", t1))).toMatchObject({
        event_status: "applied",
        outcome: "refund_recorded",
      });
      expect(await paymentRow(tx, p.id)).toMatchObject({
        status: "partially_refunded",
        refunded_amount: "70.00",
      });

      // A canceled refund never counts; a stale succeeded snapshot after failed changes nothing.
      await deliver(tx, "refund.updated", refund(p, r3, 1000, "canceled"));
      expect(
        await deliver(tx, "refund.updated", refund(p, r1, 5000, "succeeded", t1)),
      ).toMatchObject({
        event_status: "ignored",
        outcome: "refund_unchanged",
      });
      expect(await paymentRow(tx, p.id)).toMatchObject({
        status: "partially_refunded",
        refunded_amount: "70.00",
      });

      const rows = await refundRows(tx, p.pi);
      expect(
        Object.fromEntries(
          rows.map((r) => [r.stripe_refund_id, [r.status, r.amount, r.currency, r.payment_id]]),
        ),
      ).toEqual({
        [r1]: ["failed", "50.00", "SGD", p.id],
        [r2]: ["succeeded", "70.00", "SGD", p.id],
        [r3]: ["canceled", "10.00", "SGD", p.id],
      });
      for (const r of rows) expect(r.stripe_created_at).not.toBeNull();
      expect(rows.find((r) => r.stripe_refund_id === r1)?.stripe_created_at?.getTime()).toBe(
        t1 * 1000,
      );

      expect(
        (await paymentEvents(tx, p.workOrderId)).map((e) => [
          e.event_type,
          e.refunded ?? e.amount,
          e.refunded_total,
          e.full,
        ]),
      ).toEqual([
        ["payment_received", "120.00", null, null],
        ["payment_refunded", "50.00", "50.00", false],
        ["payment_refunded", "70.00", "120.00", true],
        ["payment_refund_failed", "50.00", "70.00", null],
      ]);
    });
  });

  it("a refund before its payment is kept unmatched (admins only) and adopted on completion", async () => {
    await inTransaction(conn, async (tx) => {
      const p = await setupPayment(tx);
      const rid = `re_${tag()}`;
      expect(await deliver(tx, "refund.updated", refund(p, rid, 5000, "succeeded"))).toMatchObject({
        event_status: "ignored",
        outcome: "refund_unmatched",
        payment_id: null,
      });
      expect((await refundRows(tx, p.pi)).map((r) => r.payment_id)).toEqual([null]);
      await actAs(tx, MECHANIC1);
      expect(
        await scalar(
          tx,
          "select count(*)::int from public.payment_refunds where stripe_refund_id = $1",
          [rid],
        ),
      ).toBe(0);
      await actAs(tx, ADMIN);
      expect(
        await scalar(
          tx,
          "select count(*)::int from public.payment_refunds where stripe_refund_id = $1",
          [rid],
        ),
      ).toBe(1);

      const r = await deliver(tx, "checkout.session.completed", session(p));
      expect(r).toMatchObject({ event_status: "applied", outcome: "payment_paid" });
      expect(await paymentRow(tx, p.id)).toMatchObject({
        status: "partially_refunded",
        refunded_amount: "50.00",
        last_event_id: r.event_id,
      });
      expect((await refundRows(tx, p.pi)).map((x) => x.payment_id)).toEqual([p.id]);
      expect((await paymentEvents(tx, p.workOrderId)).map((e) => e.event_type)).toEqual([
        "payment_received",
        "payment_refunded",
      ]);
    });
  });

  it("an over-refund is recorded, never refused", async () => {
    await inTransaction(conn, async (tx) => {
      const p = await setupPayment(tx);
      await deliver(tx, "checkout.session.completed", session(p));
      await deliver(tx, "refund.updated", refund(p, `re_${tag()}`, 10000, "succeeded"));
      await deliver(tx, "refund.updated", refund(p, `re_${tag()}`, 3000, "succeeded"));
      expect(await paymentRow(tx, p.id)).toMatchObject({
        status: "refunded",
        refunded_amount: "130.00",
        amount_received: "120.00",
      });
    });
  });
});

// ---------------------------------------------------------------------------
// 11. Identity guards
// ---------------------------------------------------------------------------

describe("Identity guards: attention, never a raise (D159b)", () => {
  it("unknown payment, other session, other mode, not ours, unhandled types, no payment required", async () => {
    await inTransaction(conn, async (tx) => {
      const p = await setupPayment(tx);
      const ghost = { ...p, id: randomUUID() };
      expect(await deliver(tx, "checkout.session.completed", session(ghost))).toMatchObject({
        event_status: "needs_attention",
        outcome: "payment_not_found",
        payment_id: null,
      });
      expect(
        await deliver(
          tx,
          "checkout.session.expired",
          session(ghost, { status: "expired", paymentStatus: "unpaid" }),
        ),
      ).toMatchObject({ event_status: "ignored", outcome: "payment_not_found" });

      expect(
        await deliver(tx, "checkout.session.completed", session(p, { id: `cs_test_${tag()}` })),
      ).toMatchObject({
        event_status: "needs_attention",
        outcome: "session_mismatch",
        payment_id: p.id,
      });
      const live = await deliver(tx, "checkout.session.completed", session(p, { livemode: true }), {
        livemode: true,
      });
      expect(live).toMatchObject({ event_status: "needs_attention", outcome: "livemode_mismatch" });
      expect((await eventRow(tx, live.event_id)).work_order_id).toBe(p.workOrderId);

      const foreign = sessionObject({
        id: `cs_test_${tag()}`,
        paymentId: "x",
        workOrderId: "y",
        amountCents: 100,
      });
      delete (foreign as { client_reference_id?: unknown }).client_reference_id;
      foreign.metadata = {};
      expect(await deliver(tx, "checkout.session.completed", foreign)).toMatchObject({
        event_status: "ignored",
        outcome: "not_ours",
      });

      for (const type of ["charge.refunded", "charge.dispute.created"]) {
        const r = await deliver(tx, type, {
          id: `ch_${tag()}`,
          object: "charge",
          amount: 12000,
          billing_details: { email: "a@example.com" },
        });
        expect(r, type).toMatchObject({ event_status: "ignored", outcome: "type_not_handled" });
        const ev = await eventRow(tx, r.event_id);
        expect(ev.payload_text).not.toMatch(/@|billing/);
        expect(ev.object_type).toBe("charge");
      }

      expect(
        await deliver(
          tx,
          "checkout.session.completed",
          session(p, { paymentStatus: "no_payment_required" }),
        ),
      ).toMatchObject({ event_status: "needs_attention", outcome: "unexpected_payment_status" });
      expect(
        await deliver(tx, "checkout.session.completed", { ...session(p), id: "nonsense" }),
      ).toMatchObject({ event_status: "needs_attention", outcome: "object_invalid" });
      expect(
        await deliver(tx, "refund.updated", {
          ...refund(p, `re_${tag()}`, 100, "succeeded"),
          amount: -5,
        }),
      ).toMatchObject({ event_status: "needs_attention", outcome: "object_invalid" });
      expect(
        await deliver(
          tx,
          "refund.updated",
          refundObject({
            id: `re_${tag()}`,
            paymentIntent: null,
            amountCents: 100,
            status: "succeeded",
          }),
        ),
      ).toMatchObject({ event_status: "ignored", outcome: "not_ours" });

      const row = await paymentRow(tx, p.id);
      expect(row).toMatchObject({ status: "pending", last_event_id: null });
      expect(await paymentEvents(tx, p.workOrderId)).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// 12-13. Evidence
// ---------------------------------------------------------------------------

describe("The stored copy is an allow-listed projection (D159e)", () => {
  it("keeps ids, statuses, amounts and bicii_* metadata; never customer details or URLs", async () => {
    await inTransaction(conn, async (tx) => {
      const p = await setupPayment(tx);
      const body = stripeEvent({
        id: evtId(),
        type: "checkout.session.completed",
        object: session(p, {
          extra: {
            customer_details: {
              name: "Tan Ah Kow",
              email: "tan@example.com",
              phone: "+6591234567",
              address: { line1: "1 Bike Lane", country: "SG" },
            },
            customer_email: "tan@example.com",
            success_url: "https://admin.example/quote/SECRETTOKEN?deposit=returned",
            cancel_url: "https://admin.example/quote/SECRETTOKEN?deposit=cancelled",
            url: "https://checkout.stripe.com/c/pay/cs_test_x",
            metadata: { foo: "bar" },
          },
        }),
      });
      const raw = JSON.stringify(body);
      const r = await record(tx, body, { raw });
      const ev = await eventRow(tx, r.event_id);
      expect(ev.payload_text).not.toMatch(
        /@|customer|success_url|cancel_url|quote\/|"url"|"foo"|SECRETTOKEN/,
      );
      const object = (ev.payload?.data as { object: Record<string, unknown> }).object;
      expect(object).toMatchObject({
        id: p.sessionId,
        object: "checkout.session",
        amount_total: 12000,
        payment_intent: p.pi,
        metadata: { bicii_payment_id: p.id },
      });
      expect(ev.payload).toMatchObject({ id: body.id, type: body.type, object: "event" });
      expect(ev.payload).not.toHaveProperty("request");
      expect(ev).toMatchObject({
        stripe_event_id: body.id,
        body_sha256: sha256hex(raw),
        body_bytes: Buffer.byteLength(raw),
        livemode: false,
      });
    });
  });
});

describe("Rejected deliveries are evidence (D88); events are immutable", () => {
  it("one row per bad body with a delivery count, capped headers, the dedupe key left free", async () => {
    await inTransaction(conn, async (tx) => {
      const body = stripeEvent({ id: evtId(), type: "checkout.session.completed", object: {} });
      const raw = JSON.stringify(body);
      const a = await record(tx, body, { raw, reason: "signature_invalid" });
      const b = await record(tx, body, { raw, reason: "signature_invalid" });
      expect(b).toMatchObject({ event_id: a.event_id, duplicate: true, event_status: "rejected" });
      expect(await eventRow(tx, a.event_id)).toMatchObject({
        delivery_count: 2,
        stripe_event_id: null,
        payload: null,
      });

      const headers = Object.fromEntries(
        Array.from({ length: 17 }, (_, i) => [`X-Header-${String(i).padStart(2, "0")}`, "v"]),
      );
      const capped = await record(tx, { other: 1 }, { reason: "body_not_json", headers });
      const h = (await eventRow(tx, capped.event_id)).headers;
      expect(Object.keys(h)).toHaveLength(17);
      expect(h["x-bicii-truncated"]).toBe("true");
      expect(h["x-header-00"]).toBe("v");
      expect(h).not.toHaveProperty("x-header-16");

      // A later verified delivery of the same event id is accepted (its
      // empty object is unreadable, so it needs attention).
      const verified = await record(tx, body, { raw });
      expect(verified).toMatchObject({
        duplicate: false,
        event_status: "needs_attention",
        outcome: "object_invalid",
      });
      expect((await eventRow(tx, verified.event_id)).stripe_event_id).toBe(body.id);

      await ownerMode(tx);
      const immutable = { code: "P0001", message: "stripe_event_immutable" };
      for (const id of [a.event_id, verified.event_id]) {
        await failsWith(
          tx,
          () => tx.query("update public.stripe_events set event_type = 'x' where id = $1", [id]),
          immutable,
        );
        await failsWith(
          tx,
          () => tx.query("delete from public.stripe_events where id = $1", [id]),
          immutable,
        );
      }
      await failsWith(
        tx,
        () =>
          tx.query("update public.stripe_events set status = 'applied' where id = $1", [
            verified.event_id,
          ]),
        immutable,
      );
      expect(
        await scalar(
          tx,
          "select count(*)::int from public.stripe_events where status = 'received'",
        ),
      ).toBe(0);
    });
  });

  it("the owner's purge deletes only rejected rows older than 30 days or more", async () => {
    await inTransaction(conn, async (tx) => {
      const old = await record(tx, { n: tag() }, { reason: "signature_invalid" });
      const recent = await record(tx, { n: tag() }, { reason: "signature_expired" });
      const kept = await record(
        tx,
        stripeEvent({ id: evtId(), type: "charge.refunded", object: {} }),
      );
      await ownerMode(tx);
      await failsWith(tx, () => tx.query("select private.purge_stripe_events('29 days')"), {
        code: "22023",
      });
      await failsWith(tx, () => tx.query("select private.purge_stripe_events(null)"), {
        code: "22023",
      });
      // Age a rejected row and a verified one as the owner (the delivery
      // columns are the only ones that ever move), under the purge setting.
      await tx.query("select set_config('bicii.stripe_purge', 'on', true)");
      await tx.query(
        "update public.stripe_events set last_delivered_at = now() - interval '40 days' where id in ($1, $2)",
        [old.event_id, kept.event_id],
      );
      // Even under the setting, a verified row is never deleted.
      await failsWith(
        tx,
        () => tx.query("delete from public.stripe_events where id = $1", [kept.event_id]),
        {
          code: "P0001",
          message: "stripe_event_immutable",
        },
      );
      await tx.query("select set_config('bicii.stripe_purge', 'off', true)");
      expect(await scalar(tx, "select private.purge_stripe_events('30 days')")).toBe(1);
      const left = await scalar<number>(
        tx,
        "select count(*)::int from public.stripe_events where id in ($1, $2, $3)",
        [old.event_id, recent.event_id, kept.event_id],
      );
      expect(left).toBe(2);
      expect(await eventRow(tx, old.event_id)).toBeUndefined();
      await failsWith(
        tx,
        () => tx.query("delete from public.stripe_events where id = $1", [recent.event_id]),
        {
          code: "P0001",
          message: "stripe_event_immutable",
        },
      );
    });
  });
});

// ---------------------------------------------------------------------------
// 14. Server reads (D159a)
// ---------------------------------------------------------------------------

describe("Server reads with the secret key (D159a)", () => {
  it("a read applies like a webhook, keeps evidence, and stamps checked_at", async () => {
    await inTransaction(conn, async (tx) => {
      const p = await setupPayment(tx);
      const r = await read(tx, p.id, session(p));
      expect(r).toMatchObject({
        event_status: "applied",
        outcome: "payment_paid",
        payment_status: "paid",
      });
      const first = await paymentRow(tx, p.id);
      expect(first.paid_at).not.toBeNull();
      expect(first.checked_at).not.toBeNull();
      expect(await eventRow(tx, r.event_id)).toMatchObject({
        source: "api_read",
        event_type: "read.checkout.session",
        stripe_event_id: null,
        body_sha256: null,
        status: "applied",
        payment_id: p.id,
        work_order_id: p.workOrderId,
      });

      const again = await read(tx, p.id, session(p));
      expect(again).toMatchObject({
        event_status: "ignored",
        outcome: "already_paid",
        payment_status: "paid",
      });
      expect(again.event_id).not.toBe(r.event_id);
      const second = await paymentRow(tx, p.id);
      expect(second.checked_at!.getTime()).toBeGreaterThan(first.checked_at!.getTime());
      expect(second.last_event_id).toBe(r.event_id);

      const refunded = await read(tx, p.id, refund(p, `re_${tag()}`, 2000, "succeeded"));
      expect(refunded).toMatchObject({
        event_status: "applied",
        outcome: "refund_recorded",
        payment_status: "partially_refunded",
      });

      const mismatch = await read(tx, p.id, session(p, { id: `cs_test_${tag()}` }));
      expect(mismatch).toMatchObject({
        event_status: "needs_attention",
        outcome: "read_mismatch",
        payment_status: "partially_refunded",
      });
      expect(
        await read(
          tx,
          p.id,
          refundObject({
            id: `re_${tag()}`,
            paymentIntent: `pi_${tag()}`,
            amountCents: 1,
            status: "succeeded",
          }),
        ),
      ).toMatchObject({ outcome: "read_mismatch" });

      await failsWith(tx, () => callRead(tx, p.id, { id: "ch_1", object: "charge" }), {
        code: "22023",
      });
      await failsWith(
        tx,
        () => callRead(tx, p.id, { id: "nonsense", object: "checkout.session" }),
        {
          code: "22023",
        },
      );
      await failsWith(tx, () => callRead(tx, randomUUID(), session(p)), { code: "P0002" });
      await failsWith(tx, () => callRead(tx, p.id, null), { code: "22004" });
    });
  });
});

// ---------------------------------------------------------------------------
// 15. D154: money held, not revenue
// ---------------------------------------------------------------------------

describe("D154: payments are money held, not revenue", () => {
  it("nothing in totals, yield, daily or period reports, the job or sales changes", async () => {
    await inTransaction(conn, async (tx) => {
      const job = await newJob(tx);
      await ownerMode(tx);
      const service = await makeService(tx, { price: "80.00" });
      const product = await makeProduct(tx, { price: "40.00", cost: "15.00" });
      await actAs(tx, ADMIN);
      await addStock(tx, product, 3, { unitCost: "15.00" });
      await addServiceLine(tx, { workOrderId: job.id, serviceId: service });
      await addPart(tx, {
        workOrderId: job.id,
        productId: product,
        quantity: 1,
        locationId: LOCATION.shopFloor,
      });
      await completeJob(tx, job.id);
      const day = await shopToday(tx);

      const periods = async () => {
        const out: string[] = [];
        for (const basis of ["sale", "check_in", "completion", "collection"]) {
          out.push(
            (
              await tx.query<{ t: string }>(
                `select coalesce(json_agg(x order by x::text)::text, '[]') as t
                   from public.report_period_summary($1::date, $1::date, $2::public.report_date_basis) x`,
                [day, basis],
              )
            ).rows[0].t,
          );
        }
        return out;
      };

      const snapshot = async () => {
        await actAs(tx, ADMIN);
        const asText = async (sql: string, params: unknown[] = []) =>
          (
            await tx.query<{ t: string }>(
              `select coalesce(json_agg(x order by x::text)::text, '[]') as t from (${sql}) x`,
              params,
            )
          ).rows[0].t;
        const owner = await readAsOwner(tx, async () => ({
          financial: await asText(
            "select * from reporting.financial_lines where document_id = $1",
            [job.id],
          ),
          report: await asText("select * from reporting.report_lines where document_id = $1", [
            job.id,
          ]),
          totals: await asText("select * from public.work_order_totals where work_order_id = $1", [
            job.id,
          ]),
          totalsStaff: await asText(
            "select * from public.work_order_totals_staff where work_order_id = $1",
            [job.id],
          ),
          job: await asText(
            "select status, completed_at, collected_at, approval_flag, approval_note from public.work_orders where id = $1",
            [job.id],
          ),
          counts: await asText(
            `select (select count(*) from public.work_order_line_items) as lines,
                    (select count(*) from public.sales) as sales,
                    (select count(*) from public.sale_lines) as sale_lines,
                    (select count(*) from public.sale_refunds) as sale_refunds`,
          ),
        }));
        return {
          ...owner,
          yield: await asText("select * from public.work_order_yield($1)", [job.id]),
          daily: await asText("select * from public.daily_summary($1::date, $1::date)", [day]),
          periods: await periods(),
        };
      };

      const before = await snapshot();
      expect(before.financial).not.toBe("[]");
      const p = await setupPayment(tx, { workOrderId: job.id });
      await deliver(tx, "checkout.session.completed", session(p));
      const rid = `re_${tag()}`;
      await deliver(tx, "refund.updated", refund(p, rid, 5000, "succeeded"));
      await deliver(tx, "refund.updated", refund(p, `re_${tag()}`, 7000, "succeeded"));
      await deliver(tx, "refund.failed", refund(p, rid, 5000, "failed"));
      expect((await paymentRow(tx, p.id)).status).toBe("partially_refunded");
      expect(await snapshot()).toEqual(before);
    });
  });
});

// ---------------------------------------------------------------------------
// 16. Concurrency (committed; per-file clone only)
// ---------------------------------------------------------------------------

describe.skipIf(!isolatedDatabase())("Concurrency (DATA-MODEL §19 lock order)", () => {
  let c1: pg.Client;
  let c2: pg.Client;
  let setup: pg.Client;

  beforeAll(async () => {
    [c1, c2, setup] = await openConnections(3);
  });

  /** A committed job and pending payment. */
  const committedPayment = () => inTransaction(setup, (tx) => setupPayment(tx), { commit: true });

  const timelineCount = (paymentWorkOrderId: string, type: string) =>
    scalar<number>(
      conn,
      "select count(*)::int from public.work_order_events where work_order_id = $1 and event_type::text = $2",
      [paymentWorkOrderId, type],
    );

  it("the same evt_ on two connections at once: one applied, one duplicate", async () => {
    const p = await committedPayment();
    const body = stripeEvent({
      id: evtId(),
      type: "checkout.session.completed",
      object: session(p),
    });
    const results = await Promise.all([
      committed(c1, (tx) => callRecord(tx, body), SERVICE),
      committed(c2, (tx) => callRecord(tx, body), SERVICE),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    const values = results.map((r) => (r.ok ? r.value : null));
    expect(values.map((v) => v?.duplicate).sort()).toEqual([false, true]);
    expect(await timelineCount(p.workOrderId, "payment_received")).toBe(1);
  });

  it("a refund and the completion for the same payment intent, in either order", async () => {
    for (const refundFirst of [true, false]) {
      const p = await committedPayment();
      const refundCall = (tx: pg.Client) =>
        callRecord(
          tx,
          stripeEvent({
            id: evtId(),
            type: "refund.updated",
            object: refund(p, `re_${tag()}`, 5000, "succeeded"),
          }),
        );
      const completeCall = (tx: pg.Client) =>
        callRecord(
          tx,
          stripeEvent({ id: evtId(), type: "checkout.session.completed", object: session(p) }),
        );
      const calls = refundFirst ? [refundCall, completeCall] : [completeCall, refundCall];
      const results = await Promise.all([
        committed(c1, calls[0], SERVICE),
        committed(c2, calls[1], SERVICE),
      ]);
      expect(
        results.every((r) => r.ok),
        JSON.stringify(results),
      ).toBe(true);
      const row = await inTransaction(conn, (tx) => paymentRow(tx, p.id));
      expect(row).toMatchObject({ status: "partially_refunded", refunded_amount: "50.00" });
    }
  });

  it("a webhook and a server read of the same paid session: one transition, no deadlock", async () => {
    const p = await committedPayment();
    const results = await Promise.all([
      committed(
        c1,
        (tx) =>
          callRecord(
            tx,
            stripeEvent({ id: evtId(), type: "checkout.session.completed", object: session(p) }),
          ),
        SERVICE,
      ),
      committed(c2, (tx) => callRead(tx, p.id, session(p)), SERVICE),
    ]);
    expect(
      results.every((r) => r.ok),
      JSON.stringify(results),
    ).toBe(true);
    const outcomes = results.map((r) => (r.ok ? r.value.outcome : null)).sort();
    expect(outcomes).toEqual(["already_paid", "payment_paid"]);
    expect(await timelineCount(p.workOrderId, "payment_received")).toBe(1);
  });

  it("a paid webhook against cancelling the job: both commit, the money is recorded", async () => {
    const p = await committedPayment();
    const results = await Promise.all([
      committed(
        c1,
        (tx) =>
          callRecord(
            tx,
            stripeEvent({ id: evtId(), type: "checkout.session.completed", object: session(p) }),
          ),
        SERVICE,
      ),
      committed(
        c2,
        (tx) => setStatus(tx, p.workOrderId, "cancelled", "Customer changed their mind"),
        ADMIN,
      ),
    ]);
    expect(
      results.every((r) => r.ok),
      JSON.stringify(results),
    ).toBe(true);
    const row = await inTransaction(conn, (tx) => paymentRow(tx, p.id));
    expect(row.status).toBe("paid");
    expect(
      await scalar(conn, "select status::text from public.work_orders where id = $1", [
        p.workOrderId,
      ]),
    ).toBe("cancelled");
  });
});
