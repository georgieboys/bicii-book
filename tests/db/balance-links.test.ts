/**
 * Balance links, Phase 14 step 3 (PLAN D156 and its build defaults
 * D156a-h; ADR-025; DATA-MODEL §5, §15, §16, §19): any active staff member
 * sends a link once a job is completed or ready for collection, and the
 * customer pays what is left by Stripe Checkout from a BICII page.
 *
 *   balance_links         one live link per job; the token is shown once
 *                         and only its hash kept; guarded for every role
 *                         (never deleted; only the withdrawal moves, once).
 *   work_orders_withdraw_balance_link  a reopen or Collected withdraws it.
 *   send_balance_link     staff; the live balance (Stripe net + counter).
 *   balance_by_token      the pay page (anon): the bill's live lines and
 *                         the balance, never a serial, unit id or any id.
 *   prepare_balance_checkout, record_balance_checkout  the service role's
 *                         Pay: processing, replace, check, nothing_due or
 *                         create; then created, existing, stale or
 *                         nothing_due under the job lock.
 *   payments.balance_link_id, payments_one_open_balance  a pending balance
 *                         payment never sits beside another live or
 *                         processing Stripe payment on its job.
 *   prepare_deposit_checkout, record_deposit_checkout  replaced: the
 *                         reverse direction (a pending balance payment
 *                         makes the deposit's Pay replace it, or wait).
 *
 * Stripe's side comes from tests/fixtures/stripe.ts through the shared
 * helpers in payment-fixtures.ts. States send_balance_link never makes (a
 * link already past its expiry, or live on a job that is not completed or
 * ready) are inserted as the owner, which the guard allows. The races
 * commit, so they run only on this file's clone.
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { STAFF } from "../fixtures/ids";
import { refundObject } from "../fixtures/stripe";
import { customerClaims, linkCustomerLogin } from "./customer-fixtures";
import {
  actAs,
  connect,
  inTransaction,
  isolatedDatabase,
  openConnections,
  scalar,
} from "./harness";
import {
  ADMIN,
  MANAGER,
  MECHANIC2,
  addPart,
  completeJob,
  makeProduct,
  makeUnit,
  newJob,
  readAsOwner,
  reopenJob,
} from "./inventory-fixtures";
import { race } from "./lock-race";
import {
  ANON,
  SERVICE,
  answered,
  balancePage,
  balanceSession,
  callRecordBalance,
  callSend,
  deliver,
  depositSession,
  expire,
  fitPartOnly,
  newToken,
  ownerBalancePayment,
  ownerLink,
  paidSession,
  pay,
  paymentTotals,
  prepareBalance,
  prepareDeposit,
  processing,
  recordBalance,
  recordCounter,
  recordDeposit,
  sendLink,
  startBalanceCheckout,
  startDepositCheckout,
  tag,
  voidCounter,
  type BalancePrepared,
  type Pay,
} from "./payment-fixtures";
import {
  addManualLine,
  eventTypes,
  events,
  failsWith,
  makeCustomerWithBike,
  ownerMode,
  setStatus,
  voidLine,
  workOrder,
} from "./workshop-fixtures";

const DENIED = { code: "42501" };
const p0001 = (message: string) => ({ code: "P0001", message });
const p0002 = (message: string) => ({ code: "P0002", message });
const check = (constraint: string) => ({ code: "23514", constraint });
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** The open page's thirteen keys (D156f; refunded, U2-11), sorted. */
const OPEN_KEYS = [
  "balance_due",
  "bike",
  "currency",
  "first_name",
  "job_number",
  "job_total",
  "lines",
  "paid",
  "paid_ahead",
  "payment",
  "refunded",
  "shop_name",
  "status",
];

let conn: pg.Client;

beforeAll(async () => {
  conn = await connect();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A new job (as ADMIN) with a manual line at `price` when given, completed; acting as ADMIN. */
async function completedJob(tx: pg.Client, price: string | null = "80.00") {
  const job = await newJob(tx);
  if (price) await addManualLine(tx, { workOrderId: job.id, description: "Labour", price });
  await completeJob(tx, job.id);
  return job;
}

type LinkRow = {
  work_order_id: string;
  channel: string;
  valid_days: number;
  amount_at_send: string;
  sent_by: string;
  withdrawn: boolean;
  withdrawn_reason: string | null;
  replaced_by: string | null;
};

/** The link as the owner reads it. */
const linkRow = (tx: pg.Client, linkId: string) =>
  readAsOwner(tx, async () => {
    const { rows } = await tx.query<LinkRow>(
      `select work_order_id, channel::text, valid_days, amount_at_send::text, sent_by,
              withdrawn_at is not null as withdrawn, withdrawn_reason, replaced_by
         from public.balance_links where id = $1`,
      [linkId],
    );
    return rows[0];
  });

const liveLinks = (tx: pg.Client, workOrderId: string) =>
  readAsOwner(tx, () =>
    scalar<number>(
      tx,
      "select count(*)::int from public.balance_links where work_order_id = $1 and withdrawn_at is null",
      [workOrderId],
    ),
  );

/** The job's balance-link timeline entries, oldest first (read as the owner). */
const linkEvents = (tx: pg.Client, workOrderId: string) =>
  readAsOwner(tx, async () =>
    (await events(tx, workOrderId))
      .filter((e) => e.event_type.startsWith("balance_link_"))
      .map((e) => ({ type: e.event_type, payload: e.payload, actor: e.actor_staff_id })),
  );

const lastTypes = async (tx: pg.Client, workOrderId: string, n: number) =>
  (await readAsOwner(tx, () => eventTypes(tx, workOrderId))).slice(-n);

type PaymentRow = {
  id: string;
  kind: string;
  status: string;
  quote_id: string | null;
  balance_link_id: string | null;
  amount: string;
  amount_cents: string;
  stripe_checkout_session_id: string;
};

/** The job's Stripe payments, oldest first (read as the owner). */
const paymentsOf = (tx: pg.Client, workOrderId: string) =>
  readAsOwner(tx, async () => {
    const { rows } = await tx.query<PaymentRow>(
      `select id, kind::text, status::text, quote_id, balance_link_id, amount::text,
              amount_cents::text, stripe_checkout_session_id
         from public.payments where work_order_id = $1 order by created_at, id`,
      [workOrderId],
    );
    return rows;
  });

/** The open session Stripe echoes for what `prep` (a create) asked. */
const echoOf = (prep: BalancePrepared, o: Parameters<typeof balanceSession>[1] = {}) =>
  balanceSession(
    {
      paymentId: prep.payment_id!,
      workOrderId: prep.work_order_id,
      cents: prep.amount_cents!,
      expiresAt: prep.expires_at,
    },
    o,
  );

/** Stripe says the payment of a completed Checkout failed (PayNow). */
const failAsync = (tx: pg.Client, p: Pay) =>
  deliver(
    tx,
    "checkout.session.async_payment_failed",
    paidSession(p, { paymentStatus: "unpaid", status: "complete" }),
  );

/** The job's status, as the owner reads it. */
const statusOf = async (tx: pg.Client, workOrderId: string) =>
  (await readAsOwner(tx, () => workOrder(tx, workOrderId))).status;

// ---------------------------------------------------------------------------
// 1. Who can reach balance links (D156e, DATA-MODEL §15)
// ---------------------------------------------------------------------------

describe("Who can reach balance links (D156e, DATA-MODEL §15)", () => {
  it("any active staff member sends a link; a customer gets 42501; anon and the service role cannot execute it", async () => {
    await inTransaction(conn, async (tx) => {
      const job = await completedJob(tx);
      const byMechanic = await sendLink(tx, job.id, { as: MECHANIC2 });
      const byManager = await sendLink(tx, job.id, { as: MANAGER });
      const byAdmin = await sendLink(tx, job.id);
      expect(byManager.replaced_link_id).toBe(byMechanic.link_id);
      expect(byAdmin.replaced_link_id).toBe(byManager.link_id);
      expect((await linkRow(tx, byMechanic.link_id)).sent_by).toBe(STAFF.mechanic2);
      expect((await linkRow(tx, byManager.link_id)).sent_by).toBe(STAFF.manager);

      await ownerMode(tx);
      const login = await linkCustomerLogin(tx, job.customer_id);
      for (const claims of [customerClaims(login), ANON, SERVICE]) {
        await actAs(tx, claims);
        await failsWith(tx, () => callSend(tx, { workOrderId: job.id }), DENIED);
      }
      expect(await liveLinks(tx, job.id)).toBe(1);
    });
  });

  it("staff read every column but the token hash; customers read none; anon and the service role are refused; no API role writes", async () => {
    await inTransaction(conn, async (tx) => {
      const job = await completedJob(tx);
      const sent = await sendLink(tx, job.id);

      await actAs(tx, MECHANIC2);
      const { rows } = await tx.query(
        `select id, work_order_id, channel, valid_days, expires_at, amount_at_send, sent_by,
                created_at, withdrawn_at, withdrawn_reason, replaced_by
           from public.balance_links where id = $1`,
        [sent.link_id],
      );
      expect(rows).toHaveLength(1);
      await failsWith(tx, () => tx.query("select token_hash from public.balance_links"), DENIED);
      // The new payments column reads like the rest of payments.
      await tx.query("select balance_link_id from public.payments where work_order_id = $1", [
        job.id,
      ]);

      await ownerMode(tx);
      const login = await linkCustomerLogin(tx, job.customer_id);
      await actAs(tx, customerClaims(login));
      expect((await tx.query("select id from public.balance_links")).rows).toEqual([]);
      for (const claims of [ANON, SERVICE]) {
        await actAs(tx, claims);
        await failsWith(tx, () => tx.query("select id from public.balance_links"), DENIED);
      }

      await actAs(tx, ADMIN);
      await failsWith(
        tx,
        () =>
          tx.query("insert into public.balance_links (id, work_order_id) values ($1, $2)", [
            randomUUID(),
            job.id,
          ]),
        DENIED,
      );
      await failsWith(
        tx,
        () =>
          tx.query(
            "update public.balance_links set withdrawn_at = now(), withdrawn_reason = 'reopened' where id = $1",
            [sent.link_id],
          ),
        DENIED,
      );
      await failsWith(
        tx,
        () => tx.query("delete from public.balance_links where id = $1", [sent.link_id]),
        DENIED,
      );
    });
  });

  it("the guard, for every role: never deleted; only the withdrawal moves, each column once from null; the shape checks", async () => {
    await inTransaction(conn, async (tx) => {
      const other = await completedJob(tx);
      const job = await completedJob(tx);
      const a = await sendLink(tx, job.id);
      const b = await sendLink(tx, job.id); // a: withdrawn, replaced by b
      await ownerMode(tx);
      const immutable = p0001("balance_link_immutable");
      const update = (set: string, id: string) =>
        tx.query(`update public.balance_links set ${set} where id = $1`, [id]);

      await failsWith(
        tx,
        () => tx.query("delete from public.balance_links where id = $1", [b.link_id]),
        immutable,
      );
      for (const set of [
        "id = gen_random_uuid()",
        `work_order_id = '${other.id}'`,
        "token_hash = sha256('another'::bytea)",
        "channel = 'email'",
        "valid_days = 8",
        "expires_at = expires_at + interval '1 day'",
        "amount_at_send = 1.00",
        `sent_by = '${STAFF.mechanic2}'`,
        "created_at = created_at - interval '1 day'",
      ]) {
        await failsWith(tx, () => update(set, b.link_id), immutable);
      }
      // A second withdrawal, another reason, and clearing it are refused.
      for (const set of [
        "withdrawn_at = clock_timestamp()",
        "withdrawn_reason = 'collected'",
        `replaced_by = '${other.id}'`,
        "replaced_by = null",
        "withdrawn_at = null, withdrawn_reason = null, replaced_by = null",
      ]) {
        await failsWith(tx, () => update(set, a.link_id), immutable);
      }
      // The guard lets each column move once; the CHECKs keep them together.
      await failsWith(
        tx,
        () => update("withdrawn_at = clock_timestamp()", b.link_id),
        check("balance_links_withdrawn_shape"),
      );
      await failsWith(
        tx,
        () => update("withdrawn_at = clock_timestamp(), withdrawn_reason = 'later'", b.link_id),
        check("balance_links_withdrawn_reason_check"),
      );
      await failsWith(
        tx,
        () => update("withdrawn_at = clock_timestamp(), withdrawn_reason = 'replaced'", b.link_id),
        check("balance_links_replaced_shape"),
      );
      await failsWith(
        tx,
        () =>
          update(
            `withdrawn_at = clock_timestamp(), withdrawn_reason = 'reopened', replaced_by = '${a.link_id}'`,
            b.link_id,
          ),
        check("balance_links_replaced_shape"),
      );
      await failsWith(
        tx,
        () => update(`replaced_by = '${a.link_id}'`, b.link_id),
        check("balance_links_replaced_shape"),
      );
      // replaced_by is a deferred foreign key (send withdraws before it inserts).
      await failsWith(
        tx,
        async () => {
          await update(
            `withdrawn_at = clock_timestamp(), withdrawn_reason = 'replaced', replaced_by = '${randomUUID()}'`,
            b.link_id,
          );
          await tx.query("set constraints balance_links_replaced_by_fkey immediate");
        },
        { code: "23503", constraint: "balance_links_replaced_by_fkey" },
      );
      await tx.query("set constraints balance_links_replaced_by_fkey deferred");
      // The one change allowed: a live link withdrawn once.
      await update("withdrawn_at = clock_timestamp(), withdrawn_reason = 'reopened'", b.link_id);
      expect(await linkRow(tx, b.link_id)).toMatchObject({
        withdrawn: true,
        withdrawn_reason: "reopened",
        replaced_by: null,
      });
    });
  });

  it("the pay page is for anon and signed-in callers; prepare and record are the service role's only", async () => {
    await inTransaction(conn, async (tx) => {
      const job = await completedJob(tx);
      const sent = await sendLink(tx, job.id);
      await ownerMode(tx);
      const login = await linkCustomerLogin(tx, job.customer_id);
      for (const claims of [ANON, customerClaims(login), ADMIN]) {
        await actAs(tx, claims);
        expect(
          await scalar<string>(tx, "select public.balance_by_token($1) ->> 'status'", [sent.token]),
        ).toBe("open");
      }
      await actAs(tx, SERVICE);
      await failsWith(
        tx,
        () => tx.query("select public.balance_by_token($1)", [sent.token]),
        DENIED,
      );
      const prep = await prepareBalance(tx, sent.token);
      for (const claims of [ANON, customerClaims(login), ADMIN, MANAGER]) {
        await actAs(tx, claims);
        await failsWith(
          tx,
          () => tx.query("select * from public.prepare_balance_checkout($1)", [sent.token]),
          DENIED,
        );
        await failsWith(
          tx,
          () => callRecordBalance(tx, prep.payment_id, sent.link_id, 8000, echoOf(prep)),
          DENIED,
        );
      }
    });
  });
});

// ---------------------------------------------------------------------------
// 2. send_balance_link (D156a, D156b, D156c, D156h)
// ---------------------------------------------------------------------------

describe("send_balance_link (D156a-c, D156h)", () => {
  it("sends on a completed job: a 43-character token whose hash only is kept, the live balance, 7 days, the sender, a timeline entry; again on a ready job", async () => {
    await inTransaction(conn, async (tx) => {
      const job = await completedJob(tx, "80.00");
      await recordCounter(tx, { workOrderId: job.id, amount: "30.00" });
      const sent = await sendLink(tx, job.id, { as: MECHANIC2 });
      expect(sent).toMatchObject({ amount: "50.00", replaced_link_id: null });
      expect(sent.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Math.abs(sent.expires_at.getTime() - (Date.now() + 7 * 86_400_000))).toBeLessThan(
        60_000,
      );
      expect(await linkRow(tx, sent.link_id)).toEqual({
        work_order_id: job.id,
        channel: "whatsapp",
        valid_days: 7,
        amount_at_send: "50.00",
        sent_by: STAFF.mechanic2,
        withdrawn: false,
        withdrawn_reason: null,
        replaced_by: null,
      });
      expect(
        await readAsOwner(tx, () =>
          scalar<boolean>(
            tx,
            `select token_hash = sha256(convert_to($2, 'UTF8')) and octet_length(token_hash) = 32
                    and expires_at - created_at = interval '7 days'
               from public.balance_links where id = $1`,
            [sent.link_id, sent.token],
          ),
        ),
      ).toBe(true);
      expect(await linkEvents(tx, job.id)).toEqual([
        {
          type: "balance_link_sent",
          payload: { link_id: sent.link_id, channel: "whatsapp", valid_days: 7, amount: 50 },
          actor: STAFF.mechanic2,
        },
      ]);

      // Ready for collection: still live; a new link replaces it.
      await actAs(tx, ADMIN);
      await setStatus(tx, job.id, "ready_for_collection");
      expect((await linkRow(tx, sent.link_id)).withdrawn).toBe(false);
      const again = await sendLink(tx, job.id, { channel: "email", days: 14 });
      expect(again).toMatchObject({ amount: "50.00", replaced_link_id: sent.link_id });
      expect(await linkRow(tx, again.link_id)).toMatchObject({ channel: "email", valid_days: 14 });
    });
  });

  it("refuses validity outside 1-30, missing arguments, an unknown job, a job not completed or ready, another currency, and a used id", async () => {
    await inTransaction(conn, async (tx) => {
      const job = await completedJob(tx);
      for (const days of [0, 31]) {
        await failsWith(
          tx,
          () => callSend(tx, { workOrderId: job.id, days }),
          p0001("balance_link_validity_invalid"),
        );
      }
      for (const a of [
        { id: null, workOrderId: job.id },
        { workOrderId: null },
        { workOrderId: job.id, channel: null },
        { workOrderId: job.id, days: null },
      ]) {
        await failsWith(tx, () => callSend(tx, a), { code: "22004" });
      }
      await failsWith(tx, () => callSend(tx, { workOrderId: randomUUID() }), { code: "P0002" });

      // Only a completed or ready job: open, collected and cancelled are refused.
      const open = await newJob(tx);
      await addManualLine(tx, { workOrderId: open.id, price: "40.00" });
      await failsWith(
        tx,
        () => callSend(tx, { workOrderId: open.id }),
        p0001("balance_link_not_ready"),
      );
      await setStatus(tx, open.id, "in_progress");
      await failsWith(
        tx,
        () => callSend(tx, { workOrderId: open.id }),
        p0001("balance_link_not_ready"),
      );
      const collected = await completedJob(tx);
      await setStatus(tx, collected.id, "collected");
      await failsWith(
        tx,
        () => callSend(tx, { workOrderId: collected.id }),
        p0001("balance_link_not_ready"),
      );
      const cancelled = await newJob(tx);
      await setStatus(tx, cancelled.id, "cancelled", "Customer withdrew");
      await failsWith(
        tx,
        () => callSend(tx, { workOrderId: cancelled.id }),
        p0001("balance_link_not_ready"),
      );

      // A completed job in another currency (inserted as the owner).
      await ownerMode(tx);
      const ids = await makeCustomerWithBike(tx);
      const usd = await scalar<string>(
        tx,
        `insert into public.work_orders (customer_id, bike_id, requested_work, currency)
         values ($1, $2, 'Service', 'USD') returning id`,
        [ids.customerId, ids.bikeId],
      );
      await actAs(tx, ADMIN);
      await addManualLine(tx, { workOrderId: usd, price: "40.00" });
      await completeJob(tx, usd);
      await failsWith(tx, () => callSend(tx, { workOrderId: usd }), p0001("balance_link_currency"));

      // A used id: no replay (the token is shown once), on this job or another.
      const id = randomUUID();
      await callSend(tx, { id, workOrderId: job.id });
      await failsWith(
        tx,
        () => callSend(tx, { id, workOrderId: job.id }),
        p0001("balance_link_already_sent"),
      );
      const second = await completedJob(tx);
      await failsWith(
        tx,
        () => callSend(tx, { id, workOrderId: second.id }),
        p0001("balance_link_already_sent"),
      );
      expect(await liveLinks(tx, second.id)).toBe(0);
    });
  });

  it("refuses a balance under S$0.50, nothing or paid ahead, above S$999,999.99, and while a Stripe payment on the job is being confirmed", async () => {
    await inTransaction(conn, async (tx) => {
      const small = await completedJob(tx, "80.00");
      await recordCounter(tx, { workOrderId: small.id, amount: "79.60" });
      await failsWith(tx, () => sendLink(tx, small.id), p0001("balance_too_small"));
      await recordCounter(tx, { workOrderId: small.id, amount: "0.40" }); // nothing left
      await failsWith(tx, () => sendLink(tx, small.id), p0001("balance_too_small"));
      await recordCounter(tx, { workOrderId: small.id, amount: "20.00" }); // paid ahead
      await failsWith(tx, () => sendLink(tx, small.id), p0001("balance_too_small"));

      const large = await newJob(tx);
      await addManualLine(tx, { workOrderId: large.id, price: "600000.00", quantity: 2 });
      await completeJob(tx, large.id);
      await failsWith(tx, () => sendLink(tx, large.id), p0001("balance_too_large"));

      const confirming = await completedJob(tx, "80.00");
      await processing(tx, await ownerBalancePayment(tx, confirming.id, { amount: "80.00" }));
      await failsWith(tx, () => sendLink(tx, confirming.id), p0001("balance_payment_processing"));
      for (const j of [small, large, confirming]) expect(await liveLinks(tx, j.id)).toBe(0);
    });
  });

  it("sending again withdraws the live link as replaced and returns its id; the old page and Pay read withdrawn; one live link per job", async () => {
    await inTransaction(conn, async (tx) => {
      const job = await completedJob(tx);
      const a = await sendLink(tx, job.id);
      const b = await sendLink(tx, job.id, { channel: "link" });
      expect(b.replaced_link_id).toBe(a.link_id);
      expect(await linkRow(tx, a.link_id)).toMatchObject({
        withdrawn: true,
        withdrawn_reason: "replaced",
        replaced_by: b.link_id,
      });
      expect(await linkRow(tx, b.link_id)).toMatchObject({ withdrawn: false, replaced_by: null });
      expect(await liveLinks(tx, job.id)).toBe(1);
      expect(await linkEvents(tx, job.id)).toEqual([
        {
          type: "balance_link_sent",
          payload: { link_id: a.link_id, channel: "whatsapp", valid_days: 7, amount: 80 },
          actor: STAFF.admin,
        },
        {
          type: "balance_link_withdrawn",
          payload: { link_id: a.link_id, reason: "replaced" },
          actor: STAFF.admin,
        },
        {
          type: "balance_link_sent",
          payload: { link_id: b.link_id, channel: "link", valid_days: 7, amount: 80 },
          actor: STAFF.admin,
        },
      ]);
      expect(await balancePage(tx, a.token)).toEqual({
        status: "withdrawn",
        job_number: job.job_number,
      });
      expect((await balancePage(tx, b.token))!.status).toBe("open");
      await failsWith(tx, () => prepareBalance(tx, a.token), p0001("balance_link_withdrawn"));
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Withdrawn when the job leaves completed or ready (D156d)
// ---------------------------------------------------------------------------

describe("A link is withdrawn when its job leaves completed or ready (D156d)", () => {
  it("completed to ready keeps it live; Collected withdraws it as collected, after the collected entry", async () => {
    await inTransaction(conn, async (tx) => {
      const job = await completedJob(tx);
      const sent = await sendLink(tx, job.id);
      await setStatus(tx, job.id, "ready_for_collection");
      expect((await linkRow(tx, sent.link_id)).withdrawn).toBe(false);
      expect((await balancePage(tx, sent.token))!.status).toBe("open");

      await actAs(tx, MECHANIC2);
      await setStatus(tx, job.id, "collected");
      expect(await linkRow(tx, sent.link_id)).toMatchObject({
        withdrawn: true,
        withdrawn_reason: "collected",
        replaced_by: null,
      });
      expect(await lastTypes(tx, job.id, 2)).toEqual(["collected", "balance_link_withdrawn"]);
      expect((await linkEvents(tx, job.id)).at(-1)).toEqual({
        type: "balance_link_withdrawn",
        payload: { link_id: sent.link_id, reason: "collected" },
        actor: STAFF.mechanic2,
      });
      expect(await balancePage(tx, sent.token)).toEqual({
        status: "withdrawn",
        job_number: job.job_number,
      });
    });
  });

  it("a reopen withdraws it as reopened; completing again does not revive it; Pay and record are refused withdrawn; a job without a link writes nothing", async () => {
    await inTransaction(conn, async (tx) => {
      const job = await completedJob(tx);
      const sent = await sendLink(tx, job.id);
      const prep = await prepareBalance(tx, sent.token);
      await actAs(tx, ADMIN);
      await reopenJob(tx, job.id);
      expect(await linkRow(tx, sent.link_id)).toMatchObject({
        withdrawn: true,
        withdrawn_reason: "reopened",
      });
      expect(await lastTypes(tx, job.id, 2)).toEqual(["reopened", "balance_link_withdrawn"]);

      await completeJob(tx, job.id);
      expect((await linkRow(tx, sent.link_id)).withdrawn).toBe(true);
      expect(await liveLinks(tx, job.id)).toBe(0);
      expect(await balancePage(tx, sent.token)).toEqual({
        status: "withdrawn",
        job_number: job.job_number,
      });
      await failsWith(tx, () => prepareBalance(tx, sent.token), p0001("balance_link_withdrawn"));
      await failsWith(
        tx,
        () => recordBalance(tx, prep.payment_id!, sent.link_id, prep.amount_cents!, echoOf(prep)),
        p0001("balance_link_withdrawn"),
      );

      const plain = await completedJob(tx);
      await reopenJob(tx, plain.id);
      await completeJob(tx, plain.id);
      await setStatus(tx, plain.id, "collected");
      expect(await linkEvents(tx, plain.id)).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// 4. The pay page (D156f)
// ---------------------------------------------------------------------------

describe("The pay page, balance_by_token (D156f)", () => {
  it("refunded (U2-11): what Stripe gave back on the job, beside paid, which is already net of it", async () => {
    await inTransaction(conn, async (tx) => {
      const job = await newJob(tx);
      await actAs(tx, ADMIN);
      await addManualLine(tx, { workOrderId: job.id, description: "Labour", price: "105.00" });
      await completeJob(tx, job.id);
      await recordCounter(tx, { workOrderId: job.id, amount: "30.00" });
      const sent = await sendLink(tx, job.id);
      const p = await startBalanceCheckout(tx, sent.token);
      await pay(tx, p);
      expect(await balancePage(tx, sent.token)).toMatchObject({
        paid: 105,
        refunded: 0,
        balance_due: 0,
        payment: "nothing_due",
      });

      // Part of the Stripe payment comes back: paid drops by it, refunded
      // names it, and the bill is due again by the same amount.
      await deliver(
        tx,
        "refund.updated",
        refundObject({
          id: `re_${tag()}`,
          paymentIntent: p.pi,
          amountCents: 2000,
          status: "succeeded",
        }),
      );
      expect(await balancePage(tx, sent.token)).toMatchObject({
        job_total: 105,
        paid: 85,
        refunded: 20,
        balance_due: 20,
        payment: "due",
      });
      // A refund Stripe has not finished counts nowhere.
      await deliver(
        tx,
        "refund.updated",
        refundObject({
          id: `re_${tag()}`,
          paymentIntent: p.pi,
          amountCents: 1000,
          status: "pending",
        }),
      );
      expect(await balancePage(tx, sent.token)).toMatchObject({ paid: 85, refunded: 20 });
    });
  });

  it("an open link: thirteen keys, the bill's live lines and the live balance; withdrawn, expired and closed links: status and job number only; an unknown token: null", async () => {
    await inTransaction(conn, async (tx) => {
      const job = await newJob(tx);
      await ownerMode(tx);
      await tx.query("update public.customers set first_name = 'Mei' where id = $1", [
        job.customer_id,
      ]);
      await actAs(tx, ADMIN);
      await addManualLine(tx, { workOrderId: job.id, description: "Labour", price: "80.00" });
      await addManualLine(tx, {
        workOrderId: job.id,
        description: "Brake pads",
        price: "12.50",
        quantity: 2,
      });
      await completeJob(tx, job.id);
      await recordCounter(tx, { workOrderId: job.id, amount: "30.00" });
      const sent = await sendLink(tx, job.id);
      expect(sent.amount).toBe("75.00");

      const view = await balancePage(tx, sent.token);
      expect(Object.keys(view!).sort()).toEqual(OPEN_KEYS);
      expect(view).toEqual({
        status: "open",
        shop_name: "BICII",
        job_number: job.job_number,
        bike: "Test Bike",
        first_name: "Mei",
        currency: "SGD",
        lines: [
          { description: "Labour", quantity: 1, line_total: 80 },
          { description: "Brake pads", quantity: 2, line_total: 25 },
        ],
        job_total: 105,
        paid: 30,
        refunded: 0,
        paid_ahead: 0,
        balance_due: 75,
        payment: "due",
      });
      for (const line of view!.lines as Record<string, unknown>[]) {
        expect(Object.keys(line).sort()).toEqual(["description", "line_total", "quantity"]);
      }

      // Live at every read: more counter money lowers it.
      await recordCounter(tx, { workOrderId: job.id, amount: "5.00" });
      expect(await balancePage(tx, sent.token)).toMatchObject({ paid: 35, balance_due: 70 });

      // Withdrawn (resent), expired, closed: exactly {status, job_number}.
      const resent = await sendLink(tx, job.id);
      expect(await balancePage(tx, sent.token)).toEqual({
        status: "withdrawn",
        job_number: job.job_number,
      });
      expect((await balancePage(tx, resent.token))!.status).toBe("open");

      const expiredJob = await completedJob(tx);
      const expired = await ownerLink(tx, expiredJob.id, { expiresIn: "-1 minute" });
      expect(await balancePage(tx, expired.token)).toEqual({
        status: "expired",
        job_number: expiredJob.job_number,
      });
      // Expiry is read before the job (an expired link on an open job).
      const openJob = await newJob(tx);
      const expiredOpen = await ownerLink(tx, openJob.id, { expiresIn: "-1 minute" });
      expect((await balancePage(tx, expiredOpen.token))!.status).toBe("expired");

      // Closed: a live link on a job that is not completed or ready (the
      // trigger withdraws it first in practice; this is the fallback).
      await actAs(tx, ADMIN);
      await setStatus(tx, openJob.id, "in_progress");
      const inProgress = await newJob(tx);
      await setStatus(tx, inProgress.id, "in_progress");
      const closed = await ownerLink(tx, inProgress.id);
      expect(await balancePage(tx, closed.token)).toEqual({
        status: "closed",
        job_number: inProgress.job_number,
      });
      await actAs(tx, ADMIN);
      const cancelled = await newJob(tx);
      await setStatus(tx, cancelled.id, "cancelled", "Customer withdrew");
      const onCancelled = await ownerLink(tx, cancelled.id);
      expect(await balancePage(tx, onCancelled.token)).toEqual({
        status: "closed",
        job_number: cancelled.job_number,
      });

      for (const token of [newToken(), "not-a-token", "", null]) {
        expect(await balancePage(tx, token)).toBeNull();
      }
    });
  });

  it("never shows a serial, a unit id, the bike's serial, a voided line or any id; a renamed product keeps the line's name; the lines add up to the job total", async () => {
    await inTransaction(conn, async (tx) => {
      const job = await newJob(tx);
      await ownerMode(tx);
      await tx.query(
        "update public.bikes set variant = 'Disc', serial_number = 'FRAME-SN-77' where id = $1",
        [job.bike_id],
      );
      const productId = await makeProduct(tx, {
        name: "Wheelset Pro",
        tracking: "unique",
        price: "300.00",
        cost: "150.00",
      });
      await actAs(tx, ADMIN);
      const unit = await makeUnit(tx, productId, {
        serial: "SN-PIN-1",
        price: "300.00",
        cost: "150.00",
      });
      await addManualLine(tx, { workOrderId: job.id, description: "Labour", price: "80.00" });
      await addPart(tx, { workOrderId: job.id, productId, unitId: unit.unit_id });
      const voided = await addManualLine(tx, {
        workOrderId: job.id,
        description: "SECRET VOIDED TEXT",
        price: "45.00",
      });
      await voidLine(tx, voided, "Added by mistake");
      await ownerMode(tx);
      await tx.query("update public.products set name = 'Wheelset Renamed' where id = $1", [
        productId,
      ]);
      expect(
        await scalar<string>(
          tx,
          "select description_snapshot from public.work_order_line_items where source_inventory_unit_id = $1",
          [unit.unit_id],
        ),
      ).toBe(`Wheelset Pro · ${unit.short_id} · S/N SN-PIN-1`);

      await actAs(tx, ADMIN);
      await completeJob(tx, job.id);
      const sent = await sendLink(tx, job.id);
      const view = await balancePage(tx, sent.token);
      expect(view).toMatchObject({
        bike: "Test Bike Disc",
        lines: [
          { description: "Labour", quantity: 1, line_total: 80 },
          { description: "Wheelset Pro", quantity: 1, line_total: 300 },
        ],
        job_total: 380,
        balance_due: 380,
      });
      const text = JSON.stringify(view);
      for (const leak of [
        "SN-PIN-1",
        unit.short_id,
        "FRAME-SN-77",
        "SECRET VOIDED",
        "Renamed",
        "S/N",
      ]) {
        expect(text).not.toContain(leak);
      }
      expect(text).not.toMatch(UUID);
      expect(text).not.toMatch(/U-[0-9]{6}/);
      expect(text).not.toMatch(/cs_|pi_|https?:/);
      await actAs(tx, ANON);
      expect(
        await scalar<boolean>(
          tx,
          `select (select sum((l ->> 'line_total')::numeric) from jsonb_array_elements(v -> 'lines') l)
                  = (v ->> 'job_total')::numeric
             from (select public.balance_by_token($1) as v) s`,
          [sent.token],
        ),
      ).toBe(true);
    });
  });

  it("a unit line whose description does not carry the unit's short id shows the product's current name, never the rest of the description", async () => {
    await inTransaction(conn, async (tx) => {
      const job = await newJob(tx);
      await ownerMode(tx);
      const productId = await makeProduct(tx, {
        name: "Wheelset Pro",
        tracking: "unique",
        price: "300.00",
        cost: "150.00",
      });
      await actAs(tx, ADMIN);
      const unit = await makeUnit(tx, productId, {
        serial: "SN-X",
        price: "300.00",
        cost: "150.00",
      });
      // A unit line written in another format than "<name> · <short_id> · S/N".
      await ownerMode(tx);
      await tx.query(
        "update public.inventory_units set status = 'held_for_customer' where id = $1",
        [unit.unit_id],
      );
      await tx.query(
        `insert into public.work_order_line_items
           (id, work_order_id, line_type, source_product_id, source_inventory_unit_id,
            description_snapshot, quantity, unit_sale_price_snapshot, unit_direct_cost_snapshot,
            cult_commons_rate_snapshot, currency)
         values ($1, $2, 'inventory', $3, $4, 'Wheelset Pro · S/N SN-X', 1, 300, 150, 0.3, 'SGD')`,
        [randomUUID(), job.id, productId, unit.unit_id],
      );
      await tx.query("update public.products set name = 'Wheelset Current' where id = $1", [
        productId,
      ]);
      await actAs(tx, ADMIN);
      await completeJob(tx, job.id);
      const sent = await sendLink(tx, job.id);
      const view = await balancePage(tx, sent.token);
      expect(view).toMatchObject({
        lines: [{ description: "Wheelset Current", quantity: 1, line_total: 300 }],
      });
      const text = JSON.stringify(view);
      for (const leak of ["SN-X", "S/N", unit.short_id]) expect(text).not.toContain(leak);
      expect(text).not.toMatch(/U-[0-9]{6}/);
    });
  });

  it("payment: due, processing while Stripe confirms, too_small under S$0.50, nothing_due when paid or paid ahead, too_large above S$999,999.99", async () => {
    await inTransaction(conn, async (tx) => {
      const job = await completedJob(tx, "80.00");
      const sent = await sendLink(tx, job.id);
      expect(await balancePage(tx, sent.token)).toMatchObject({ payment: "due", balance_due: 80 });

      const p = await startBalanceCheckout(tx, sent.token);
      expect((await balancePage(tx, sent.token))!.payment).toBe("due"); // an open session is not money
      await processing(tx, p);
      expect(await balancePage(tx, sent.token)).toMatchObject({
        payment: "processing",
        paid: 0,
        balance_due: 80,
      });
      await failAsync(tx, p);
      expect((await balancePage(tx, sent.token))!.payment).toBe("due");

      await recordCounter(tx, { workOrderId: job.id, amount: "79.60" });
      expect(await balancePage(tx, sent.token)).toMatchObject({
        payment: "too_small",
        paid: 79.6,
        balance_due: 0.4,
        paid_ahead: 0,
      });
      await recordCounter(tx, { workOrderId: job.id, amount: "0.40" });
      expect(await balancePage(tx, sent.token)).toMatchObject({
        payment: "nothing_due",
        balance_due: 0,
        paid_ahead: 0,
      });
      await recordCounter(tx, { workOrderId: job.id, amount: "10.00" });
      expect(await balancePage(tx, sent.token)).toMatchObject({
        payment: "nothing_due",
        paid: 90,
        balance_due: 0,
        paid_ahead: 10,
      });

      // Too large: sent at 600,000.00 left; a void of the counter money
      // takes it to 1,200,000.00.
      const large = await newJob(tx);
      await addManualLine(tx, { workOrderId: large.id, price: "600000.00", quantity: 2 });
      await completeJob(tx, large.id);
      const cash = await recordCounter(tx, { workOrderId: large.id, amount: "600000.00" });
      const big = await sendLink(tx, large.id);
      expect(big.amount).toBe("600000.00");
      await voidCounter(tx, cash.counter_payment_id);
      expect(await balancePage(tx, big.token)).toMatchObject({
        payment: "too_large",
        balance_due: 1200000,
      });
      await failsWith(tx, () => prepareBalance(tx, big.token), p0001("balance_too_large"));
    });
  });
});

// ---------------------------------------------------------------------------
// 5. prepare_balance_checkout (D156h)
// ---------------------------------------------------------------------------

describe("prepare_balance_checkout (D156h)", () => {
  it("create: a fresh payment id, the live balance in money and cents, SGD, 60 minutes in whole seconds; nothing stored", async () => {
    await inTransaction(conn, async (tx) => {
      const job = await completedJob(tx, "80.00");
      await recordCounter(tx, { workOrderId: job.id, amount: "30.00" });
      const sent = await sendLink(tx, job.id);
      const before = Math.floor(Date.now() / 1000);
      const a = await prepareBalance(tx, sent.token);
      const b = await prepareBalance(tx, sent.token);
      expect(a).toMatchObject({
        outcome: "create",
        work_order_id: job.id,
        link_id: sent.link_id,
        job_number: job.job_number,
        amount: "50.00",
        amount_cents: 5000,
        currency: "SGD",
        stripe_checkout_session_id: null,
      });
      expect(a.payment_id).toMatch(UUID);
      expect(b.payment_id).not.toBe(a.payment_id);
      expect(a.expires_at! - before).toBeGreaterThanOrEqual(3598);
      expect(a.expires_at! - before).toBeLessThanOrEqual(3602);
      expect(await paymentsOf(tx, job.id)).toEqual([]);
    });
  });

  it("refuses an unknown token, a withdrawn link, an expired link and a job that is not completed or ready", async () => {
    await inTransaction(conn, async (tx) => {
      for (const token of [newToken(), "not-a-token"]) {
        await failsWith(tx, () => prepareBalance(tx, token), p0002("balance_link_not_found"));
      }
      const job = await completedJob(tx);
      const a = await sendLink(tx, job.id);
      await sendLink(tx, job.id);
      await failsWith(tx, () => prepareBalance(tx, a.token), p0001("balance_link_withdrawn"));

      const other = await completedJob(tx);
      const expired = await ownerLink(tx, other.id, { expiresIn: "-1 minute" });
      await failsWith(tx, () => prepareBalance(tx, expired.token), p0001("balance_link_expired"));

      await actAs(tx, ADMIN);
      const open = await newJob(tx);
      const closed = await ownerLink(tx, open.id);
      await failsWith(tx, () => prepareBalance(tx, closed.token), p0001("balance_link_job_closed"));
    });
  });

  it("check: this link's open session at the live amount; processing while any Stripe payment on the job is being confirmed, a deposit's too", async () => {
    await inTransaction(conn, async (tx) => {
      const job = await completedJob(tx);
      const sent = await sendLink(tx, job.id);
      const p = await startBalanceCheckout(tx, sent.token);
      expect(await prepareBalance(tx, sent.token)).toMatchObject({
        outcome: "check",
        payment_id: p.paymentId,
        link_id: sent.link_id,
        stripe_checkout_session_id: p.sessionId,
        amount: "80.00",
        amount_cents: 8000,
      });
      await processing(tx, p);
      expect(await prepareBalance(tx, sent.token)).toMatchObject({
        outcome: "processing",
        payment_id: p.paymentId,
      });

      // A deposit opened while the job was open and finished (PayNow) after
      // it was completed.
      const d = await answered(tx);
      const dep = await startDepositCheckout(tx, d);
      await fitPartOnly(tx, d);
      await completeJob(tx, d.job.id);
      const link = await sendLink(tx, d.job.id);
      await processing(tx, dep);
      expect(await prepareBalance(tx, link.token)).toMatchObject({
        outcome: "processing",
        payment_id: dep.paymentId,
      });
    });
  });

  it("replace: a live deposit session left from the open job; once Stripe records it, create (or, paid, the rest)", async () => {
    await inTransaction(conn, async (tx) => {
      for (const ending of ["expired", "paid"] as const) {
        const d = await answered(tx);
        const dep = await startDepositCheckout(tx, d);
        await fitPartOnly(tx, d);
        await completeJob(tx, d.job.id);
        const sent = await sendLink(tx, d.job.id);
        expect(sent.amount).toBe("240.00");
        expect(await prepareBalance(tx, sent.token)).toMatchObject({
          outcome: "replace",
          payment_id: dep.paymentId,
          stripe_checkout_session_id: dep.sessionId,
        });
        if (ending === "expired") {
          await expire(tx, dep);
          expect(await prepareBalance(tx, sent.token)).toMatchObject({
            outcome: "create",
            amount: "240.00",
          });
        } else {
          // The customer finished the deposit tab instead: recorded (D159b).
          await pay(tx, dep);
          expect(await prepareBalance(tx, sent.token)).toMatchObject({
            outcome: "create",
            amount: "120.00",
            amount_cents: 12000,
          });
        }
      }
    });
  });

  it("replace: another link's session (live, or past its expiry but not yet recorded), or this link's at an old amount; this link's past its expiry is checked", async () => {
    await inTransaction(conn, async (tx) => {
      const job = await completedJob(tx);
      const l1 = await sendLink(tx, job.id);
      const p1 = await startBalanceCheckout(tx, l1.token);
      const l2 = await sendLink(tx, job.id);
      expect(l2.replaced_link_id).toBe(l1.link_id);
      expect(await prepareBalance(tx, l2.token)).toMatchObject({
        outcome: "replace",
        payment_id: p1.paymentId,
        stripe_checkout_session_id: p1.sessionId,
      });
      await expire(tx, p1);
      expect((await prepareBalance(tx, l2.token)).outcome).toBe("create");

      // A withdrawn link's pending row whose session is past its expiry:
      // still one of the job's pending balance payments until Stripe's
      // answer is recorded, so it is replaced (re-read), not overtaken.
      const l3 = await sendLink(tx, job.id);
      const left = await ownerBalancePayment(tx, job.id, {
        amount: "80.00",
        expiresIn: "-1 minute",
        linkId: l2.link_id,
      });
      expect(await prepareBalance(tx, l3.token)).toMatchObject({
        outcome: "replace",
        payment_id: left.paymentId,
      });
      await expire(tx, left);

      // This link's session at an amount the balance has moved from.
      const p3 = await startBalanceCheckout(tx, l3.token);
      const cash = await recordCounter(tx, { workOrderId: job.id, amount: "30.00" });
      expect(cash.open_checkouts).toBe(1);
      expect(await prepareBalance(tx, l3.token)).toMatchObject({
        outcome: "replace",
        payment_id: p3.paymentId,
        amount: "80.00",
      });
      await expire(tx, p3);
      expect(await prepareBalance(tx, l3.token)).toMatchObject({
        outcome: "create",
        amount: "50.00",
        amount_cents: 5000,
      });

      // This link's own row past its expiry: check (re-read, then create).
      const own = await ownerBalancePayment(tx, job.id, {
        amount: "50.00",
        expiresIn: "-1 minute",
        linkId: l3.link_id,
      });
      expect(await prepareBalance(tx, l3.token)).toMatchObject({
        outcome: "check",
        payment_id: own.paymentId,
      });
    });
  });

  it("nothing_due under S$0.50: this link's session left past its expiry is returned for the app to expire; with none, no payment", async () => {
    await inTransaction(conn, async (tx) => {
      const job = await completedJob(tx, "80.00");
      const sent = await sendLink(tx, job.id);
      const left = await ownerBalancePayment(tx, job.id, {
        amount: "80.00",
        expiresIn: "-1 minute",
        linkId: sent.link_id,
      });
      await recordCounter(tx, { workOrderId: job.id, amount: "79.80" });
      expect(await prepareBalance(tx, sent.token)).toMatchObject({
        outcome: "nothing_due",
        payment_id: left.paymentId,
        stripe_checkout_session_id: left.sessionId,
        amount: "0.20",
        amount_cents: 20,
      });
      await expire(tx, left);
      expect(await prepareBalance(tx, sent.token)).toMatchObject({
        outcome: "nothing_due",
        payment_id: null,
        stripe_checkout_session_id: null,
        amount: "0.20",
      });
      await recordCounter(tx, { workOrderId: job.id, amount: "10.00" }); // paid ahead
      expect(await prepareBalance(tx, sent.token)).toMatchObject({
        outcome: "nothing_due",
        amount: "0.00",
        amount_cents: 0,
      });
    });
  });
});

// ---------------------------------------------------------------------------
// 6. record_balance_checkout (D156g, D156h)
// ---------------------------------------------------------------------------

describe("record_balance_checkout (D156g, D156h)", () => {
  it("created: a pending balance payment for the link at the live amount, no timeline entry; a replay is existing; another session, amount or payment is a conflict", async () => {
    await inTransaction(conn, async (tx) => {
      const job = await completedJob(tx, "80.00");
      await recordCounter(tx, { workOrderId: job.id, amount: "30.00" });
      const sent = await sendLink(tx, job.id);
      const before = (await readAsOwner(tx, () => events(tx, job.id))).length;
      const prep = await prepareBalance(tx, sent.token);
      const s = echoOf(prep);
      expect(await recordBalance(tx, prep.payment_id!, sent.link_id, 5000, s)).toEqual({
        outcome: "created",
        payment_id: prep.payment_id,
        stripe_checkout_session_id: s.id,
      });
      expect(await paymentsOf(tx, job.id)).toEqual([
        {
          id: prep.payment_id,
          kind: "balance",
          status: "pending",
          quote_id: null,
          balance_link_id: sent.link_id,
          amount: "50.00",
          amount_cents: "5000",
          stripe_checkout_session_id: s.id,
        },
      ]);
      expect(
        await readAsOwner(tx, () =>
          scalar<boolean>(
            tx,
            `select stripe_session_expires_at = to_timestamp($2) and livemode = false
               from public.payments where id = $1`,
            [prep.payment_id, prep.expires_at],
          ),
        ),
      ).toBe(true);
      expect((await readAsOwner(tx, () => events(tx, job.id))).length).toBe(before);

      // Replay: the same id and session.
      expect(await recordBalance(tx, prep.payment_id!, sent.link_id, 5000, s)).toEqual({
        outcome: "existing",
        payment_id: prep.payment_id,
        stripe_checkout_session_id: s.id,
      });
      // The same id with another session, or another amount: a conflict.
      await failsWith(
        tx,
        () => recordBalance(tx, prep.payment_id!, sent.link_id, 5000, echoOf(prep)),
        p0001("checkout_session_conflict"),
      );
      await failsWith(
        tx,
        () => recordBalance(tx, prep.payment_id!, sent.link_id, 5100, { ...s, amount_total: 5100 }),
        p0001("checkout_session_conflict"),
      );
      // A session already recorded for another payment (once the first is
      // no longer pending): a conflict.
      await expire(tx, {
        paymentId: prep.payment_id!,
        sessionId: s.id as string,
        workOrderId: job.id,
        quoteId: null,
        cents: 5000,
        pi: "pi_unused",
      });
      const next = await prepareBalance(tx, sent.token);
      expect(next.outcome).toBe("create");
      await failsWith(
        tx,
        () =>
          recordBalance(
            tx,
            next.payment_id!,
            sent.link_id,
            5000,
            echoOf(next, { id: s.id as string }),
          ),
        p0001("checkout_session_conflict"),
      );
    });
  });

  it("refuses missing arguments, cents outside 50..99,999,999 and an unknown link", async () => {
    await inTransaction(conn, async (tx) => {
      const job = await completedJob(tx);
      const sent = await sendLink(tx, job.id);
      const prep = await prepareBalance(tx, sent.token);
      const s = echoOf(prep);
      await actAs(tx, SERVICE);
      const missing: [string | null, string | null, number | null, unknown][] = [
        [null, sent.link_id, 8000, s],
        [prep.payment_id, null, 8000, s],
        [prep.payment_id, sent.link_id, null, s],
        [prep.payment_id, sent.link_id, 8000, null],
      ];
      for (const [paymentId, linkId, cents, session] of missing) {
        await failsWith(tx, () => callRecordBalance(tx, paymentId, linkId, cents, session), {
          code: "22004",
        });
      }
      for (const cents of [0, 49, 100_000_000]) {
        await failsWith(tx, () => callRecordBalance(tx, prep.payment_id, sent.link_id, cents, s), {
          code: "22023",
        });
      }
      await failsWith(
        tx,
        () => callRecordBalance(tx, prep.payment_id, randomUUID(), 8000, s),
        p0002("balance_link_not_found"),
      );
      expect(await paymentsOf(tx, job.id)).toEqual([]);
    });
  });

  it("existing, inserting nothing, while another live or processing Stripe payment is on the job, or another link's pending row", async () => {
    await inTransaction(conn, async (tx) => {
      // A live deposit session left from the open job.
      const d = await answered(tx);
      const dep = await startDepositCheckout(tx, d);
      await fitPartOnly(tx, d);
      await completeJob(tx, d.job.id);
      const onDeposit = await sendLink(tx, d.job.id);
      const id = randomUUID();
      const echo = balanceSession({ paymentId: id, workOrderId: d.job.id, cents: 24000 });
      expect(await recordBalance(tx, id, onDeposit.link_id, 24000, echo)).toEqual({
        outcome: "existing",
        payment_id: dep.paymentId,
        stripe_checkout_session_id: dep.sessionId,
      });
      expect((await paymentsOf(tx, d.job.id)).map((p) => p.kind)).toEqual(["deposit"]);

      // Another link's live session, then the same while it is processing.
      const job = await completedJob(tx);
      const l1 = await sendLink(tx, job.id);
      const p1 = await startBalanceCheckout(tx, l1.token);
      const l2 = await sendLink(tx, job.id);
      for (const step of ["live", "processing"]) {
        if (step === "processing") await processing(tx, p1);
        const fresh = randomUUID();
        expect(
          await recordBalance(
            tx,
            fresh,
            l2.link_id,
            8000,
            balanceSession({ paymentId: fresh, workOrderId: job.id, cents: 8000 }),
          ),
        ).toEqual({
          outcome: "existing",
          payment_id: p1.paymentId,
          stripe_checkout_session_id: p1.sessionId,
        });
      }
      expect(await paymentsOf(tx, job.id)).toHaveLength(1);

      // Another link's pending row past its expiry, not yet recorded.
      const other = await completedJob(tx);
      const o1 = await sendLink(tx, other.id);
      const left = await ownerBalancePayment(tx, other.id, {
        amount: "80.00",
        expiresIn: "-1 minute",
        linkId: o1.link_id,
      });
      const o2 = await sendLink(tx, other.id);
      const fresh = randomUUID();
      expect(
        await recordBalance(
          tx,
          fresh,
          o2.link_id,
          8000,
          balanceSession({ paymentId: fresh, workOrderId: other.id, cents: 8000 }),
        ),
      ).toMatchObject({ outcome: "existing", payment_id: left.paymentId });
      expect(await paymentsOf(tx, other.id)).toHaveLength(1);
    });
  });

  it("checkout_session_mismatch when Stripe's echo differs from what was asked (never stale)", async () => {
    await inTransaction(conn, async (tx) => {
      const other = await completedJob(tx);
      const job = await completedJob(tx);
      const sent = await sendLink(tx, job.id);
      const prep = await prepareBalance(tx, sent.token);
      const id = prep.payment_id!;
      const s = echoOf(prep);
      const now = Math.floor(Date.now() / 1000);
      const without = (key: string) => {
        const copy: Record<string, unknown> = { ...s };
        delete copy[key];
        return copy;
      };
      const variants: unknown[] = [
        { ...s, amount_total: 8100 },
        { ...s, amount_total: "8000" },
        { ...s, currency: "usd" },
        { ...s, status: "complete" },
        { ...s, object: "payment_intent" },
        { ...s, id: "pi_123" },
        { ...s, client_reference_id: randomUUID() },
        { ...s, livemode: "false" },
        without("livemode"),
        without("expires_at"),
        { ...s, expires_at: now - 10 },
        { ...s, expires_at: now + 2 * 3600 },
        echoOf(prep, { kind: "deposit" }),
        echoOf(prep, { extra: { metadata: { bicii_quote_id: randomUUID() } } }),
        echoOf(prep, { workOrderId: other.id }),
        echoOf(prep, { paymentId: randomUUID(), extra: { client_reference_id: id } }),
        [s],
      ];
      for (const v of variants) {
        await failsWith(
          tx,
          () => recordBalance(tx, id, sent.link_id, 8000, v),
          p0001("checkout_session_mismatch"),
        );
      }
      expect(await paymentsOf(tx, job.id)).toEqual([]);
    });
  });

  it("stale when the balance moved between prepare and record; nothing_due when it fell under S$0.50", async () => {
    await inTransaction(conn, async (tx) => {
      const job = await completedJob(tx, "80.00");
      const sent = await sendLink(tx, job.id);
      const prep = await prepareBalance(tx, sent.token); // 80.00
      await recordCounter(tx, { workOrderId: job.id, amount: "30.00" });
      expect(await recordBalance(tx, prep.payment_id!, sent.link_id, 8000, echoOf(prep))).toEqual({
        outcome: "stale",
        payment_id: null,
        stripe_checkout_session_id: null,
      });
      const next = await prepareBalance(tx, sent.token); // 50.00
      await recordCounter(tx, { workOrderId: job.id, amount: "49.70" });
      expect(await recordBalance(tx, next.payment_id!, sent.link_id, 5000, echoOf(next))).toEqual({
        outcome: "nothing_due",
        payment_id: null,
        stripe_checkout_session_id: null,
      });
      expect(await paymentsOf(tx, job.id)).toEqual([]);
    });
  });

  it("refused once the link is withdrawn, expired, or its job is not completed or ready", async () => {
    await inTransaction(conn, async (tx) => {
      const job = await completedJob(tx);
      const sent = await sendLink(tx, job.id);
      const prep = await prepareBalance(tx, sent.token);
      await sendLink(tx, job.id);
      await failsWith(
        tx,
        () => recordBalance(tx, prep.payment_id!, sent.link_id, 8000, echoOf(prep)),
        p0001("balance_link_withdrawn"),
      );

      const other = await completedJob(tx);
      const expired = await ownerLink(tx, other.id, { expiresIn: "-1 minute" });
      const id = randomUUID();
      const echo = balanceSession({ paymentId: id, workOrderId: other.id, cents: 8000 });
      await failsWith(
        tx,
        () => recordBalance(tx, id, expired.linkId, 8000, echo),
        p0001("balance_link_expired"),
      );

      await actAs(tx, ADMIN);
      const open = await newJob(tx);
      await addManualLine(tx, { workOrderId: open.id, price: "80.00" });
      const closed = await ownerLink(tx, open.id);
      const echoOpen = balanceSession({ paymentId: id, workOrderId: open.id, cents: 8000 });
      await failsWith(
        tx,
        () => recordBalance(tx, id, closed.linkId, 8000, echoOpen),
        p0001("balance_link_job_closed"),
      );
    });
  });

  it("paid by Stripe: counted in paid and the balance, never collects the job; a session paid after counter money took the balance is recorded and flagged", async () => {
    await inTransaction(conn, async (tx) => {
      const job = await completedJob(tx, "80.00");
      const sent = await sendLink(tx, job.id);
      const p = await startBalanceCheckout(tx, sent.token);
      expect(await pay(tx, p)).toMatchObject({ outcome: "payment_paid" });
      expect(await paymentTotals(tx, job.id)).toEqual({
        job_total: "80.00",
        net_paid: "80.00",
        balance_due: "0.00",
        paid_ahead: "0.00",
      });
      expect(await statusOf(tx, job.id)).toBe("completed");
      expect(await balancePage(tx, sent.token)).toMatchObject({
        payment: "nothing_due",
        paid: 80,
        balance_due: 0,
      });
      const received = (await readAsOwner(tx, () => events(tx, job.id))).filter(
        (e) => e.event_type === "payment_received",
      );
      expect(received.map((e) => e.payload)).toMatchObject([
        { payment_id: p.paymentId, kind: "balance", quote_id: null },
      ]);
      await failsWith(tx, () => sendLink(tx, job.id), p0001("balance_too_small"));

      // Cash at the counter, then the customer pays the tab still open.
      const twice = await completedJob(tx, "80.00");
      const link = await sendLink(tx, twice.id);
      const tab = await startBalanceCheckout(tx, link.token);
      expect(
        (await recordCounter(tx, { workOrderId: twice.id, amount: "80.00" })).open_checkouts,
      ).toBe(1);
      expect(await pay(tx, tab)).toMatchObject({ outcome: "payment_paid" });
      expect(
        await readAsOwner(
          tx,
          async () =>
            (
              await tx.query<{ payment_id: string; issue: string }>(
                "select payment_id, issue from public.payment_issues where work_order_id = $1",
                [twice.id],
              )
            ).rows,
        ),
      ).toEqual([{ payment_id: tab.paymentId, issue: "paid_above_bill" }]);
    });
  });
});

// ---------------------------------------------------------------------------
// 7. The deposit Checkout beside a pending balance payment (D156h)
// ---------------------------------------------------------------------------

describe("The deposit Checkout and a pending balance payment (D156h, the reverse direction)", () => {
  it("on the closed job the deposit is refused as before; reopened with the balance tab still open, Pay deposit replaces it and the deposit's record is existing; once Stripe records it, the deposit starts", async () => {
    await inTransaction(conn, async (tx) => {
      const d = await answered(tx);
      await fitPartOnly(tx, d);
      await completeJob(tx, d.job.id);
      const sent = await sendLink(tx, d.job.id);
      const p = await startBalanceCheckout(tx, sent.token);
      expect(p.amount).toBe("240.00");
      // Completed: the deposit's own refusal, and the balance tab left alone.
      await failsWith(tx, () => prepareDeposit(tx, d.token), p0001("deposit_job_closed"));

      await actAs(tx, ADMIN);
      await reopenJob(tx, d.job.id);
      expect((await linkRow(tx, sent.link_id)).withdrawn_reason).toBe("reopened");
      expect(await prepareDeposit(tx, d.token)).toMatchObject({
        outcome: "replace",
        payment_id: p.paymentId,
        quote_id: d.quoteId,
        stripe_checkout_session_id: p.sessionId,
      });
      const id = randomUUID();
      expect(await recordDeposit(tx, id, d.quoteId, depositSession(d, id, 12000))).toEqual({
        outcome: "existing",
        payment_id: p.paymentId,
        stripe_checkout_session_id: p.sessionId,
      });
      expect((await paymentsOf(tx, d.job.id)).map((r) => r.kind)).toEqual(["balance"]);

      await expire(tx, p);
      const dep = await startDepositCheckout(tx, d);
      expect(dep.cents).toBe(12000);
    });
  });

  it("a balance payment Stripe is still confirming: Pay deposit answers job_payment_processing, creating nothing; the deposit's record is existing; once Stripe decides, the deposit starts", async () => {
    await inTransaction(conn, async (tx) => {
      const d = await answered(tx);
      await fitPartOnly(tx, d);
      await completeJob(tx, d.job.id);
      const sent = await sendLink(tx, d.job.id);
      const p = await startBalanceCheckout(tx, sent.token);
      await processing(tx, p);
      // Closed: the deposit's own refusal comes first.
      await failsWith(tx, () => prepareDeposit(tx, d.token), p0001("deposit_job_closed"));
      await actAs(tx, ADMIN);
      await reopenJob(tx, d.job.id);
      // Not 'processing': the deposit itself is not being confirmed.
      expect(await prepareDeposit(tx, d.token)).toEqual({
        outcome: "job_payment_processing",
        payment_id: p.paymentId,
        quote_id: d.quoteId,
        amount: "240.00",
        amount_cents: 24000,
        stripe_checkout_session_id: null,
      });
      // The backstop: a deposit session made anyway is not recorded.
      const id = randomUUID();
      expect(await recordDeposit(tx, id, d.quoteId, depositSession(d, id, 12000))).toEqual({
        outcome: "existing",
        payment_id: p.paymentId,
        stripe_checkout_session_id: p.sessionId,
      });
      expect((await paymentsOf(tx, d.job.id)).map((r) => r.kind)).toEqual(["balance"]);

      // Stripe says the balance failed: Pay deposit creates again.
      await failAsync(tx, p);
      const dep = await startDepositCheckout(tx, d);
      expect(dep.cents).toBe(12000);
    });
  });

  it("a linked balance row past its expiry whose answer Stripe has not sent does not hold up the deposit (the invariant covers live and processing rows; R-092)", async () => {
    await inTransaction(conn, async (tx) => {
      const d = await answered(tx);
      await fitPartOnly(tx, d);
      await completeJob(tx, d.job.id);
      const sent = await sendLink(tx, d.job.id);
      await ownerBalancePayment(tx, d.job.id, {
        amount: "240.00",
        expiresIn: "-1 minute",
        linkId: sent.link_id,
      });
      await actAs(tx, ADMIN);
      await reopenJob(tx, d.job.id);
      const prep = await prepareDeposit(tx, d.token);
      expect(prep.outcome).toBe("create");
      expect(
        await recordDeposit(
          tx,
          prep.payment_id!,
          d.quoteId,
          depositSession(d, prep.payment_id!, 12000),
        ),
      ).toMatchObject({ outcome: "created", payment_id: prep.payment_id });
      expect((await paymentsOf(tx, d.job.id)).map((r) => [r.kind, r.status])).toEqual([
        ["balance", "pending"],
        ["deposit", "pending"],
      ]);
    });
  });
});

// ---------------------------------------------------------------------------
// 8. Concurrency (DATA-MODEL §19 lock order)
// ---------------------------------------------------------------------------

describe.skipIf(!isolatedDatabase())("Concurrency (DATA-MODEL §19 lock order)", () => {
  // Each case holds the first call's locks in an open transaction and
  // proves the second waits on a lock before the first commits (race(),
  // tests/db/lock-race.ts).
  let setupConn: pg.Client;

  beforeAll(async () => {
    [setupConn] = await openConnections(1);
  });

  const committedLink = () =>
    inTransaction(
      setupConn,
      async (tx) => {
        const job = await completedJob(tx);
        return { job, sent: await sendLink(tx, job.id) };
      },
      { commit: true },
    );
  /** prepare_balance_checkout's create, rolled back (it stores nothing). */
  const prepared = (token: string) => inTransaction(setupConn, (tx) => prepareBalance(tx, token));
  const countOf = (sql: string, params: unknown[]) => scalar<number>(conn, sql, params);

  it("two records on one job: the second waits on the job, then is existing with the first's payment", async () => {
    const { job, sent } = await committedLink();
    const a = await prepared(sent.token);
    const b = await prepared(sent.token);
    const sa = echoOf(a);
    const sb = echoOf(b);
    const [first, second] = await race(
      setupConn,
      { as: SERVICE, run: (tx) => callRecordBalance(tx, a.payment_id, sent.link_id, 8000, sa) },
      { as: SERVICE, run: (tx) => callRecordBalance(tx, b.payment_id, sent.link_id, 8000, sb) },
    );
    expect(first).toEqual({
      ok: true,
      value: { outcome: "created", payment_id: a.payment_id, stripe_checkout_session_id: sa.id },
    });
    expect(second).toEqual({
      ok: true,
      value: { outcome: "existing", payment_id: a.payment_id, stripe_checkout_session_id: sa.id },
    });
    expect(
      await countOf(
        "select count(*)::int from public.payments where work_order_id = $1 and status = 'pending'",
        [job.id],
      ),
    ).toBe(1);
  });

  it("the same link id sent on two connections: one link; the second waits, then is balance_link_already_sent", async () => {
    const job = await inTransaction(setupConn, (tx) => completedJob(tx), { commit: true });
    const id = randomUUID();
    const [first, second] = await race(
      setupConn,
      { as: ADMIN, run: (tx) => callSend(tx, { id, workOrderId: job.id }) },
      { as: MECHANIC2, run: (tx) => callSend(tx, { id, workOrderId: job.id }) },
    );
    expect(first).toMatchObject({ ok: true, value: { link_id: id } });
    expect(second).toMatchObject({
      ok: false,
      error: { code: "P0001", message: "balance_link_already_sent" },
    });
    expect(
      await countOf("select count(*)::int from public.balance_links where work_order_id = $1", [
        job.id,
      ]),
    ).toBe(1);
  });

  it("the same link id sent for two jobs at once: the second waits on the first's row, then is balance_link_already_sent, and its job's live link stays live", async () => {
    // The job lock does not serialise two jobs; the insert's on conflict does,
    // and the refusal undoes the second job's withdrawal.
    const a = await inTransaction(setupConn, (tx) => completedJob(tx), { commit: true });
    const { job: b, sent: live } = await committedLink();
    const id = randomUUID();
    const [first, second] = await race(
      setupConn,
      { as: ADMIN, run: (tx) => callSend(tx, { id, workOrderId: a.id }) },
      { as: MECHANIC2, run: (tx) => callSend(tx, { id, workOrderId: b.id }) },
    );
    expect(first).toMatchObject({ ok: true, value: { link_id: id } });
    expect(second).toMatchObject({
      ok: false,
      error: { code: "P0001", message: "balance_link_already_sent" },
    });
    const { rows } = await conn.query(
      "select id, withdrawn_at, replaced_by from public.balance_links where work_order_id = $1",
      [b.id],
    );
    expect(rows).toEqual([{ id: live.link_id, withdrawn_at: null, replaced_by: null }]);
    expect(
      await countOf(
        `select count(*)::int from public.work_order_events
          where work_order_id = $1 and event_type = 'balance_link_withdrawn'`,
        [b.id],
      ),
    ).toBe(0);
  });

  it("a send and a record: the record waits for the send, then is refused balance_link_withdrawn", async () => {
    const { job, sent } = await committedLink();
    const prep = await prepared(sent.token);
    const [first, second] = await race(
      setupConn,
      { as: ADMIN, run: (tx) => callSend(tx, { workOrderId: job.id }) },
      {
        as: SERVICE,
        run: (tx) => callRecordBalance(tx, prep.payment_id, sent.link_id, 8000, echoOf(prep)),
      },
    );
    expect(first).toMatchObject({ ok: true, value: { replaced_link_id: sent.link_id } });
    expect(second).toMatchObject({
      ok: false,
      error: { code: "P0001", message: "balance_link_withdrawn" },
    });
    expect(
      await countOf("select count(*)::int from public.payments where work_order_id = $1", [job.id]),
    ).toBe(0);
  });

  it("a reopen and a record: the record waits for the reopen, then is refused balance_link_withdrawn", async () => {
    const { job, sent } = await committedLink();
    const prep = await prepared(sent.token);
    const [first, second] = await race(
      setupConn,
      { as: ADMIN, run: (tx) => reopenJob(tx, job.id) },
      {
        as: SERVICE,
        run: (tx) => callRecordBalance(tx, prep.payment_id, sent.link_id, 8000, echoOf(prep)),
      },
    );
    expect(first.ok).toBe(true);
    expect(second).toMatchObject({
      ok: false,
      error: { code: "P0001", message: "balance_link_withdrawn" },
    });
  });

  it("a record and a counter payment: the counter payment waits, then counts the new session among open_checkouts", async () => {
    const { job, sent } = await committedLink();
    const prep = await prepared(sent.token);
    const [first, second] = await race(
      setupConn,
      {
        as: SERVICE,
        run: (tx) => callRecordBalance(tx, prep.payment_id, sent.link_id, 8000, echoOf(prep)),
      },
      { as: ADMIN, run: (tx) => recordCounter(tx, { workOrderId: job.id, amount: "10.00" }) },
    );
    expect(first).toMatchObject({ ok: true, value: { outcome: "created" } });
    expect(second).toMatchObject({ ok: true, value: { replayed: false, open_checkouts: 1 } });
  });
});
