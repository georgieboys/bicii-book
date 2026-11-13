/**
 * Adventures Phase B, slice 1: bookings and payments (docs/ADVENTURES.md,
 * ADR-026, PLAN D167, D170, D172-D174; DATA-MODEL §20; handoff §20.1-20.2).
 *
 *   sales switch     nothing is prepared until an admin turns sales on with
 *                    a terms version (D170)
 *   price            the booking freezes the sealed offer's price; the
 *                    browser sends no amount; a later price change never
 *                    reaches it (P07, P08)
 *   idempotency      one request id is one booking and one open payment,
 *                    under retries and under a committed race (C01, C02)
 *   Stripe           verified events confirm only the exact amount, adopt
 *                    an early webhook, ignore repeats, keep late money and
 *                    flag it, never move workshop rows (C03-C07, C11-C14)
 *   ownership        a customer sees only their own bookings (A03)
 *
 * Rolled-back transactions; the race commits on this file's own clone.
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { AUTH_USER } from "../fixtures/ids";
import { refundObject } from "../fixtures/stripe";
import { customerClaims, linkCustomerLogin } from "./customer-fixtures";
import {
  actAs,
  connect,
  inTransaction,
  isolatedDatabase,
  openConnections,
  scalar,
  staffClaims,
  type Connection,
} from "./harness";
import { deliver, SERVICE, tag } from "./payment-fixtures";
import { failsWith, makeCustomer } from "./workshop-fixtures";

let conn: pg.Client;

beforeAll(async () => {
  conn = await connect();
});

const refused = (message: string) => ({ code: "P0001", message });
const TERMS = "2026-11-test";

type Sale = { revisionNumber: number; adventureId: string };
type Rider = { customerId: string; authUserId: string };
type Prepared = {
  booking_id: string;
  reference: string;
  payment_id: string;
  amount: string;
  amount_cents: string;
  currency: string;
  reused: boolean;
};

/** As the manager: put a self-supported offer at `price` on BICII 125 and publish it. */
async function offerOn125(tx: Connection, price = 49): Promise<Sale> {
  await actAs(tx, staffClaims(AUTH_USER.manager));
  const adventureId = await scalar<string>(
    tx,
    "select id from public.adventures where slug = 'bicii-125'",
  );
  const { rows } = await tx.query<{ id: string; version: number; revision_number: number }>(
    "select id, version, revision_number from public.start_adventure_draft($1)",
    [adventureId],
  );
  const draft = rows[0];
  await tx.query(
    `select public.update_adventure_draft(
       revision_id => $1, expected_version => $2, name => 'BICII 125', summary => '', description => '',
       note => '', region => '', terrain => 'Road', when_to_start => '', start_finish => '294 River Valley',
       distance_km => 125, nominal_days => 1, time_zone => 'Asia/Singapore', min_elapsed_minutes => null,
       max_elapsed_minutes => 1440, checkpoint_order => 'any', route_url => null, rules => 'Ride it all',
       equipment => '', rider_instructions => 'Buyers only', emergency_procedure => 'Call the shop',
       staff_notes => 'Staff only', is_planned => false)`,
    [draft.id, draft.version],
  );
  await tx.query("select public.set_adventure_offer($1, 'self_supported', $2, 20, null, 'Pack')", [
    draft.id,
    price,
  ]);
  await tx.query("select public.set_adventure_offer($1, 'supported', 149, null, 1, 'Support')", [
    draft.id,
  ]);
  await tx.query("select public.publish_adventure_revision($1, null)", [draft.id]);
  return { revisionNumber: draft.revision_number, adventureId };
}

async function openSales(tx: Connection): Promise<void> {
  await actAs(tx, staffClaims(AUTH_USER.admin));
  await tx.query("select public.set_adventure_sales(true, $1)", [TERMS]);
}

async function makeRider(tx: Connection): Promise<Rider> {
  await tx.query("reset role");
  const customerId = await makeCustomer(tx);
  const authUserId = await linkCustomerLogin(tx, customerId);
  return { customerId, authUserId };
}

async function prepare(
  tx: Connection,
  rider: Rider,
  sale: Sale,
  o: Partial<{
    requestId: string;
    kind: string;
    revision: number;
    size: string;
    terms: string;
  }> = {},
): Promise<Prepared> {
  await actAs(tx, customerClaims(rider.authUserId));
  const { rows } = await tx.query<Prepared>(
    `select booking_id, reference, payment_id, amount::text, amount_cents::text, currency, reused
       from public.prepare_my_adventure_checkout($1, 'bicii-125', $2, $3, $4, 'first_name_initial', $5)`,
    [
      o.requestId ?? randomUUID(),
      o.kind ?? "self_supported",
      o.revision ?? sale.revisionNumber,
      o.size ?? "M",
      o.terms ?? TERMS,
    ],
  );
  return rows[0];
}

/** An adventure Checkout Session as Stripe sends it (override any field). */
function session(
  p: Prepared,
  sessionId: string,
  o: Partial<{
    status: string;
    paymentStatus: string;
    amountCents: number;
    currency: string;
    pi: string | null;
    livemode: boolean;
  }> = {},
): Record<string, unknown> {
  return {
    id: sessionId,
    object: "checkout.session",
    livemode: o.livemode ?? false,
    mode: "payment",
    status: o.status ?? "complete",
    payment_status: o.paymentStatus ?? "paid",
    amount_total: o.amountCents ?? Number(p.amount_cents),
    currency: o.currency ?? "sgd",
    client_reference_id: p.payment_id,
    expires_at: Math.floor(Date.now() / 1000) + 1800,
    created: Math.floor(Date.now() / 1000),
    payment_intent: o.pi === undefined ? `pi_${tag()}` : o.pi,
    metadata: { bicii_subject: "adventure", bicii_adventure_payment_id: p.payment_id },
  };
}

async function record(
  tx: Connection,
  p: Prepared,
  sessionId: string,
  livemode = false,
): Promise<void> {
  await actAs(tx, SERVICE);
  await tx.query("select public.record_adventure_checkout($1, $2::jsonb)", [
    p.payment_id,
    JSON.stringify(
      session(p, sessionId, { status: "open", paymentStatus: "unpaid", pi: null, livemode }),
    ),
  ]);
}

async function owner<T>(tx: Connection, sql: string, params: unknown[] = []): Promise<T> {
  await tx.query("reset role");
  return scalar<T>(tx, sql, params);
}

const bookingStatus = (tx: Connection, id: string) =>
  owner<string>(tx, "select status::text from public.adventure_bookings where id = $1", [id]);
const paymentStatus = (tx: Connection, id: string) =>
  owner<string>(tx, "select status::text from public.adventure_payments where id = $1", [id]);
const attention = (tx: Connection, id: string) =>
  owner<string | null>(tx, "select attention_reason from public.adventure_bookings where id = $1", [
    id,
  ]);

describe("sales switch (D170)", () => {
  it("prepares nothing until an admin turns sales on with a terms version", async () => {
    await inTransaction(conn, async (tx) => {
      const sale = await offerOn125(tx);
      const rider = await makeRider(tx);
      await failsWith(tx, () => prepare(tx, rider, sale), refused("adventure_sales_closed"));

      await actAs(tx, staffClaims(AUTH_USER.manager));
      await failsWith(tx, () => tx.query("select public.set_adventure_sales(true, 'v1')"), {
        code: "42501",
      });
      await actAs(tx, staffClaims(AUTH_USER.admin));
      await failsWith(
        tx,
        () => tx.query("select public.set_adventure_sales(true, null)"),
        refused("adventure_terms_required"),
      );
      await openSales(tx);
      expect((await prepare(tx, rider, sale)).amount).toBe("49.00");

      await actAs(tx, { role: "anon" });
      expect((await tx.query("select * from public.adventure_sales_state()")).rows).toEqual([
        { sales_enabled: true, terms_version: TERMS },
      ]);
    });
  });
});

describe("preparing a checkout (handoff P07, P08, C01, C02)", () => {
  it("freezes the offer's price into the booking, a line and one pending payment", async () => {
    await inTransaction(conn, async (tx) => {
      const sale = await offerOn125(tx);
      await openSales(tx);
      const rider = await makeRider(tx);
      const p = await prepare(tx, rider, sale);
      expect(p).toMatchObject({
        amount: "49.00",
        amount_cents: "4900",
        currency: "SGD",
        reused: false,
      });
      expect(p.reference).toMatch(/^AV-\d{6}$/);
      await tx.query("reset role");
      const { rows } = await tx.query(
        `select b.status::text, b.total::text, b.kind::text, b.tshirt_size, b.terms_version,
                (select count(*)::int from public.adventure_booking_lines l where l.booking_id = b.id) as lines,
                (select count(*)::int from public.adventure_payments x where x.booking_id = b.id) as payments
           from public.adventure_bookings b where b.id = $1`,
        [p.booking_id],
      );
      expect(rows).toEqual([
        {
          status: "pending_payment",
          total: "49.00",
          kind: "self_supported",
          tshirt_size: "M",
          terms_version: TERMS,
          lines: 1,
          payments: 1,
        },
      ]);
    });
  });

  it("refuses a stale revision, an unsold way to ride, changed terms and a bad size", async () => {
    await inTransaction(conn, async (tx) => {
      const sale = await offerOn125(tx);
      await openSales(tx);
      const rider = await makeRider(tx);
      await failsWith(
        tx,
        () => prepare(tx, rider, sale, { revision: sale.revisionNumber - 1 }),
        refused("adventure_quote_changed"),
      );
      await failsWith(
        tx,
        // Supported rides have their own switch, off here (Phase E, D196).
        () => prepare(tx, rider, sale, { kind: "supported" }),
        refused("adventure_supported_closed"),
      );
      await failsWith(
        tx,
        () => prepare(tx, rider, sale, { terms: "old" }),
        refused("adventure_terms_changed"),
      );
      await failsWith(
        tx,
        () => prepare(tx, rider, sale, { size: "huge" }),
        refused("adventure_size_invalid"),
      );
    });
  });

  it("a retry with the same request id reuses the booking and payment; other inputs conflict", async () => {
    await inTransaction(conn, async (tx) => {
      const sale = await offerOn125(tx);
      await openSales(tx);
      const rider = await makeRider(tx);
      const requestId = randomUUID();
      const first = await prepare(tx, rider, sale, { requestId });
      const again = await prepare(tx, rider, sale, { requestId });
      expect(again).toMatchObject({
        booking_id: first.booking_id,
        payment_id: first.payment_id,
        reused: true,
      });
      await failsWith(
        tx,
        () => prepare(tx, rider, sale, { requestId, size: "L" }),
        refused("adventure_request_conflict"),
      );
      expect(
        await owner<number>(
          tx,
          "select count(*)::int from public.adventure_bookings where request_id = $1",
          [requestId],
        ),
      ).toBe(1);
    });
  });

  it("a later price change never reaches a booking already made", async () => {
    await inTransaction(conn, async (tx) => {
      const sale = await offerOn125(tx);
      await openSales(tx);
      const rider = await makeRider(tx);
      const p = await prepare(tx, rider, sale);
      await offerOn125(tx, 59);
      await actAs(tx, customerClaims(rider.authUserId));
      expect(
        await scalar<string>(tx, "select total::text from public.my_adventure_booking($1)", [
          p.booking_id,
        ]),
      ).toBe("49.00");
    });
  });
});

describe("Stripe (handoff C03-C07, C11-C14)", () => {
  it("a paid session confirms the booking once; a repeat changes nothing", async () => {
    await inTransaction(conn, async (tx) => {
      const sale = await offerOn125(tx);
      await openSales(tx);
      const p = await prepare(tx, await makeRider(tx), sale);
      const sid = `cs_test_${tag()}`;
      await record(tx, p, sid);
      const pi = `pi_${tag()}`;
      expect(await deliver(tx, "checkout.session.completed", session(p, sid, { pi }))).toEqual({
        event_status: "applied",
        outcome: "payment_paid",
      });
      expect(await bookingStatus(tx, p.booking_id)).toBe("confirmed");
      expect(await paymentStatus(tx, p.payment_id)).toBe("paid");
      expect(
        await deliver(tx, "checkout.session.async_payment_succeeded", session(p, sid, { pi })),
      ).toEqual({
        event_status: "ignored",
        outcome: "already_paid",
      });
      expect(
        await owner<number>(
          tx,
          "select count(*)::int from public.adventure_booking_events where booking_id = $1 and kind = 'confirmed'",
          [p.booking_id],
        ),
      ).toBe(1);
      // The event points at the adventure payment, never a workshop one.
      expect(
        (
          await tx.query(
            "select payment_id, work_order_id, adventure_payment_id from public.stripe_events where object_id = $1",
            [sid],
          )
        ).rows,
      ).toEqual([
        { payment_id: null, work_order_id: null, adventure_payment_id: p.payment_id },
        { payment_id: null, work_order_id: null, adventure_payment_id: p.payment_id },
      ]);
    });
  });

  it("a webhook that arrives before the session is recorded adopts it (C03)", async () => {
    await inTransaction(conn, async (tx) => {
      const sale = await offerOn125(tx);
      await openSales(tx);
      const p = await prepare(tx, await makeRider(tx), sale);
      const sid = `cs_test_${tag()}`;
      expect((await deliver(tx, "checkout.session.completed", session(p, sid))).outcome).toBe(
        "payment_paid",
      );
      expect(await bookingStatus(tx, p.booking_id)).toBe("confirmed");
      await record(tx, p, sid); // the late record is accepted, not a conflict
      await failsWith(
        tx,
        () => record(tx, p, `cs_test_${tag()}`),
        refused("adventure_session_mismatch"),
      );
    });
  });

  it("the wrong amount, currency or mode never confirms (C05)", async () => {
    await inTransaction(conn, async (tx) => {
      const sale = await offerOn125(tx);
      await openSales(tx);
      const rider = await makeRider(tx);

      const short = await prepare(tx, rider, sale);
      const s1 = `cs_test_${tag()}`;
      expect(
        (await deliver(tx, "checkout.session.completed", session(short, s1, { amountCents: 100 })))
          .outcome,
      ).toBe("paid_amount_mismatch");
      expect(await bookingStatus(tx, short.booking_id)).toBe("pending_payment");
      expect(await attention(tx, short.booking_id)).toMatch(/amount/);

      const usd = await prepare(tx, rider, sale);
      expect(
        (
          await deliver(
            tx,
            "checkout.session.completed",
            session(usd, `cs_test_${tag()}`, { currency: "usd" }),
          )
        ).outcome,
      ).toBe("paid_amount_mismatch");
      expect(await bookingStatus(tx, usd.booking_id)).toBe("pending_payment");

      const mode = await prepare(tx, rider, sale);
      const s3 = `cs_test_${tag()}`;
      await record(tx, mode, s3, false);
      expect(
        await deliver(tx, "checkout.session.completed", session(mode, s3, { livemode: true })),
      ).toEqual({
        event_status: "needs_attention",
        outcome: "livemode_mismatch",
      });
      expect(await paymentStatus(tx, mode.payment_id)).toBe("pending");

      await actAs(tx, SERVICE);
      await failsWith(
        tx,
        () =>
          tx.query("select public.record_adventure_checkout($1, $2::jsonb)", [
            mode.payment_id,
            JSON.stringify(session(mode, `cs_test_${tag()}`, { amountCents: 1 })),
          ]),
        refused("adventure_session_mismatch"),
      );
    });
  });

  it("completed but unpaid stays processing; the later success confirms (C07)", async () => {
    await inTransaction(conn, async (tx) => {
      const sale = await offerOn125(tx);
      await openSales(tx);
      const rider = await makeRider(tx);
      const requestId = randomUUID();
      const p = await prepare(tx, rider, sale, { requestId });
      const sid = `cs_test_${tag()}`;
      const pi = `pi_${tag()}`;
      expect(
        (
          await deliver(
            tx,
            "checkout.session.completed",
            session(p, sid, { paymentStatus: "unpaid", pi }),
          )
        ).outcome,
      ).toBe("payment_processing");
      expect(await bookingStatus(tx, p.booking_id)).toBe("pending_payment");
      await failsWith(
        tx,
        () => prepare(tx, rider, sale, { requestId }),
        refused("adventure_payment_processing"),
      );
      expect(
        (await deliver(tx, "checkout.session.async_payment_succeeded", session(p, sid, { pi })))
          .outcome,
      ).toBe("payment_paid");
      expect(await bookingStatus(tx, p.booking_id)).toBe("confirmed");
    });
  });

  it("an abandoned checkout expires its booking; money that arrives later is kept and flagged (C10, C11)", async () => {
    await inTransaction(conn, async (tx) => {
      const sale = await offerOn125(tx);
      await openSales(tx);
      const rider = await makeRider(tx);
      const requestId = randomUUID();
      const p = await prepare(tx, rider, sale, { requestId });
      const sid = `cs_test_${tag()}`;
      await record(tx, p, sid);
      expect(
        (
          await deliver(
            tx,
            "checkout.session.expired",
            session(p, sid, { status: "expired", paymentStatus: "unpaid", pi: null }),
          )
        ).outcome,
      ).toBe("payment_expired");
      expect(await bookingStatus(tx, p.booking_id)).toBe("expired");
      await failsWith(
        tx,
        () => prepare(tx, rider, sale, { requestId }),
        refused("adventure_booking_closed"),
      );

      expect((await deliver(tx, "checkout.session.completed", session(p, sid))).outcome).toBe(
        "paid_after_expired",
      );
      expect(await paymentStatus(tx, p.payment_id)).toBe("paid");
      expect(await bookingStatus(tx, p.booking_id)).toBe("expired");
      expect(await attention(tx, p.booking_id)).toMatch(/expired/);
    });
  });

  it("refunds settle the payment and leave the booking and workshop rows alone (C12, C14)", async () => {
    await inTransaction(conn, async (tx) => {
      const sale = await offerOn125(tx);
      await openSales(tx);
      const p = await prepare(tx, await makeRider(tx), sale);
      const sid = `cs_test_${tag()}`;
      const pi = `pi_${tag()}`;
      // A refund Stripe reports before the completion waits, then is adopted.
      const early = `re_${tag()}`;
      expect(
        (
          await deliver(
            tx,
            "refund.created",
            refundObject({ id: early, paymentIntent: pi, amountCents: 900, status: "succeeded" }),
          )
        ).outcome,
      ).toBe("refund_unmatched");
      expect(
        (await deliver(tx, "checkout.session.completed", session(p, sid, { pi }))).outcome,
      ).toBe("payment_paid");
      expect(await paymentStatus(tx, p.payment_id)).toBe("partially_refunded");

      const rest = `re_${tag()}`;
      expect(
        (
          await deliver(
            tx,
            "refund.created",
            refundObject({ id: rest, paymentIntent: pi, amountCents: 4000, status: "succeeded" }),
          )
        ).outcome,
      ).toBe("refund_recorded");
      expect(await paymentStatus(tx, p.payment_id)).toBe("refunded");
      expect(await bookingStatus(tx, p.booking_id)).toBe("confirmed");
      expect(
        (
          await tx.query(
            "select payment_id, adventure_payment_id from public.payment_refunds where stripe_payment_intent_id = $1 order by created_at",
            [pi],
          )
        ).rows,
      ).toEqual([
        { payment_id: null, adventure_payment_id: p.payment_id },
        { payment_id: null, adventure_payment_id: p.payment_id },
      ]);
    });
  });
});

describe("ownership (handoff A03)", () => {
  it("a customer sees only their own bookings; tables and the server RPCs stay closed", async () => {
    await inTransaction(conn, async (tx) => {
      const sale = await offerOn125(tx);
      await openSales(tx);
      const a = await makeRider(tx);
      const b = await makeRider(tx);
      const pa = await prepare(tx, a, sale);
      await prepare(tx, b, sale);

      await actAs(tx, customerClaims(a.authUserId));
      const mine = await tx.query<{ id: string }>("select id from public.my_adventure_bookings()");
      expect(mine.rows.map((r) => r.id)).toEqual([pa.booking_id]);
      expect(await scalar<number>(tx, "select count(*)::int from public.adventure_bookings")).toBe(
        0,
      );
      expect(await scalar<number>(tx, "select count(*)::int from public.adventure_payments")).toBe(
        0,
      );
      const detail = await tx.query(
        "select rider_instructions, emergency_procedure from public.my_adventure_booking($1)",
        [pa.booking_id],
      );
      // Not paid yet: the buyers-only text stays hidden.
      expect(detail.rows).toEqual([{ rider_instructions: "", emergency_procedure: "" }]);
      await failsWith(
        tx,
        () => tx.query("select public.record_adventure_checkout($1, '{}'::jsonb)", [pa.payment_id]),
        { code: "42501" },
      );

      await actAs(tx, customerClaims(b.authUserId));
      expect(
        (await tx.query("select * from public.my_adventure_booking($1)", [pa.booking_id])).rows,
      ).toEqual([]);

      await actAs(tx, { role: "anon" });
      await failsWith(
        tx,
        () =>
          tx.query(
            "select * from public.prepare_my_adventure_checkout($1, 'bicii-125', 'self_supported', 1, 'M', 'hidden', 'x')",
            [randomUUID()],
          ),
        { code: "42501" },
      );
    });
  });
});

describe.skipIf(!isolatedDatabase())("committed race (handoff C01)", () => {
  it("two requests with the same id at the same time make one booking", async () => {
    const setup = await connect();
    const [one, two] = await openConnections(2);
    try {
      const { sale, rider } = await inTransaction(
        setup,
        async (tx) => {
          const sale = await offerOn125(tx);
          await openSales(tx);
          return { sale, rider: await makeRider(tx) };
        },
        { commit: true },
      );
      const requestId = randomUUID();
      const results = await Promise.all(
        [one, two].map((c) =>
          inTransaction(c, (tx) => prepare(tx, rider, sale, { requestId }), { commit: true }),
        ),
      );
      expect(new Set(results.map((r) => r.booking_id)).size).toBe(1);
      expect(new Set(results.map((r) => r.payment_id)).size).toBe(1);
      expect(
        await scalar<number>(
          setup,
          "select count(*)::int from public.adventure_bookings where request_id = $1",
          [requestId],
        ),
      ).toBe(1);
    } finally {
      await Promise.all([setup.end(), one.end(), two.end()]);
    }
  });
});
