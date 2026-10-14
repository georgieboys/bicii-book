/**
 * Indent deposits, Phase 14 step 2 (PLAN Phase 14, D151, D152, D154,
 * D157-D159; ADR-025; DATA-MODEL §5, §14, §15, §16, §19):
 *
 *   shop_settings.indent_deposit_percent  ships at 0; admins set it
 *                       (set_indent_deposit_percent), history kept.
 *   quotes.deposit_percent / deposit_amount  the snapshot: the percent
 *                       when sent, the amount (approved parts only) when
 *                       answered, computed in Postgres (D158a, b).
 *   quote_deposits      the one definition of a deposit's state.
 *   quote_view          the quote page's 12th key, 'deposit'.
 *   prepare_deposit_checkout, record_deposit_checkout  service role only.
 *   order_part_requests the D152 gate and its override_reason.
 *   payment_issues, work_order_payment_totals  derived live (D159b, D154).
 *   operational exceptions  payment_attention and stripe_attention (D108).
 *
 * Quotes come from tests/db/indent-fixtures.ts (Phase 13's helpers, at the
 * percent withPercent() sets as the owner); deposit payments are created
 * through record_deposit_checkout as the service role, with Stripe objects
 * from tests/fixtures/stripe.ts, and moved only by Stripe events through
 * record_stripe_event (Phase 14 step 1). The races commit, so they run
 * only on this file's clone.
 */
import { createHash, randomUUID } from "node:crypto";

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
  fit,
  orderParts,
  proposePart,
  quoteByToken,
  quoted,
  sendQuote,
  setup,
} from "./indent-fixtures";
import {
  ADMIN,
  MANAGER,
  MECHANIC1,
  MECHANIC2,
  addStock,
  committed,
  readAsOwner,
} from "./inventory-fixtures";
import { grantPurchasing } from "./purchasing-fixtures";
import { events, failsWith, ownerMode, setStatus, walkTo } from "./workshop-fixtures";

const SERVICE: Claims = { role: "service_role" };
const ANON: Claims = { role: "anon" };
const DENIED = { code: "42501" };
const p0001 = (message: string) => ({ code: "P0001", message });

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

type QuoteRow = { status: string; deposit_percent: number | null; deposit_amount: string | null };

const quoteRow = (tx: pg.Client, quoteId: string) =>
  readAsOwner(tx, async () => {
    const { rows } = await tx.query<QuoteRow>(
      "select status::text, deposit_percent, deposit_amount::text from public.quotes where id = $1",
      [quoteId],
    );
    return rows[0];
  });

type Answered = Awaited<ReturnType<typeof quoted>> & { quoteId: string };

/**
 * quoted() at `percent` (part 2 x 120.00 and a 25.00 service), answered by
 * the link (everything approved unless `approve` says otherwise); acting as
 * ADMIN afterwards.
 */
async function answered(
  tx: pg.Client,
  { percent = 50, approve }: { percent?: number; approve?: (d: string) => boolean } = {},
): Promise<Answered> {
  await withPercent(tx, percent);
  const q = await quoted(tx);
  await actAs(tx, ANON);
  await answerAll(tx, q.token, approve);
  const quoteId = await quoteIdOf(tx, q.job.id);
  await actAs(tx, ADMIN);
  return { ...q, quoteId };
}

/** The deposit object the quote page receives, its amount as Postgres prints it. */
async function pageDeposit(tx: pg.Client, token: string) {
  await actAs(tx, ANON);
  const { rows } = await tx.query<{
    deposit: { percent: number; status: string } | null;
    amount: string | null;
  }>(
    `select q -> 'deposit' as deposit, q -> 'deposit' ->> 'amount' as amount
       from public.quote_by_token($1) q`,
    [token],
  );
  const { deposit, amount } = rows[0];
  return deposit === null ? null : { ...deposit, amount };
}

type Prepared = {
  outcome: string;
  payment_id: string | null;
  work_order_id: string;
  quote_id: string;
  job_number: string;
  amount: string | null;
  amount_cents: number | null;
  currency: string | null;
  stripe_checkout_session_id: string | null;
  expires_at: number | null;
};

/** public.prepare_deposit_checkout as whoever `tx` is. */
async function callPrepare(tx: pg.Client, token: string): Promise<Prepared> {
  const { rows } = await tx.query<Prepared>(
    `select outcome, payment_id, work_order_id, quote_id, job_number, amount::text,
            amount_cents::int, currency::text, stripe_checkout_session_id, expires_at::int
       from public.prepare_deposit_checkout($1)`,
    [token],
  );
  return rows[0];
}

async function prepare(tx: pg.Client, token: string): Promise<Prepared> {
  await actAs(tx, SERVICE);
  return callPrepare(tx, token);
}

type Recorded = { outcome: string; payment_id: string | null; stripe_checkout_session_id: string };

/** public.record_deposit_checkout as whoever `tx` is. */
async function callRecordCheckout(
  tx: pg.Client,
  paymentId: string,
  quoteId: string,
  session: unknown,
): Promise<Recorded> {
  const { rows } = await tx.query<Recorded>(
    `select outcome, payment_id, stripe_checkout_session_id
       from public.record_deposit_checkout($1, $2, $3::jsonb)`,
    [paymentId, quoteId, JSON.stringify(session)],
  );
  return rows[0];
}

async function recordCheckout(
  tx: pg.Client,
  paymentId: string,
  quoteId: string,
  session: unknown,
): Promise<Recorded> {
  await actAs(tx, SERVICE);
  return callRecordCheckout(tx, paymentId, quoteId, session);
}

/** The open Checkout Session Stripe returns for the deposit asked (120.00 by default). */
const openSession = (
  d: { job: { id: string }; quoteId: string },
  paymentId: string,
  o: Partial<Parameters<typeof sessionObject>[0]> = {},
) =>
  sessionObject({
    id: `cs_test_${tag()}`,
    paymentId,
    workOrderId: d.job.id,
    quoteId: d.quoteId,
    amountCents: 12000,
    status: "open",
    paymentStatus: "unpaid",
    ...o,
  });

type Pay = {
  paymentId: string;
  sessionId: string;
  workOrderId: string;
  quoteId: string;
  pi: string;
};

/** Starts Checkout for an answered quote: prepare (create), then record (created). */
async function startCheckout(tx: pg.Client, d: Answered): Promise<Pay> {
  const prep = await prepare(tx, d.token);
  expect(prep.outcome).toBe("create");
  const s = openSession(d, prep.payment_id!);
  const r = await recordCheckout(tx, prep.payment_id!, d.quoteId, s);
  expect(r.outcome).toBe("created");
  return {
    paymentId: prep.payment_id!,
    sessionId: s.id as string,
    workOrderId: d.job.id,
    quoteId: d.quoteId,
    pi: `pi_${tag()}`,
  };
}

const sha256hex = (raw: string) => createHash("sha256").update(raw, "utf8").digest("hex");

type EventResult = { event_status: string; outcome: string | null; payment_id: string | null };

/** public.record_stripe_event as whoever `tx` is. */
async function callRecordEvent(
  tx: pg.Client,
  payload: unknown,
  reason: string | null = null,
): Promise<EventResult> {
  const raw = JSON.stringify(payload);
  const { rows } = await tx.query<EventResult>(
    `select event_status::text, outcome, payment_id
       from public.record_stripe_event($1::jsonb, $2::jsonb, $3, $4,
                                       $5::public.stripe_rejection_reason, $6)`,
    [
      raw,
      JSON.stringify(stripeWebhookHeaders({ raw })),
      sha256hex(raw),
      Buffer.byteLength(raw),
      reason,
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

/** The payment's Checkout Session as Stripe sends it once paid (12000 cents by default). */
const paidSession = (p: Pay, o: Partial<Parameters<typeof sessionObject>[0]> = {}) =>
  sessionObject({
    id: p.sessionId,
    paymentId: p.paymentId,
    workOrderId: p.workOrderId,
    quoteId: p.quoteId,
    amountCents: 12000,
    paymentIntent: p.pi,
    ...o,
  });

const payDeposit = (tx: pg.Client, p: Pay, o: Partial<Parameters<typeof sessionObject>[0]> = {}) =>
  deliver(tx, "checkout.session.completed", paidSession(p, o));

const refundDeposit = (
  tx: pg.Client,
  p: Pay,
  cents: number,
  status = "succeeded",
  id = `re_${tag()}`,
) =>
  deliver(
    tx,
    "refund.updated",
    refundObject({ id, paymentIntent: p.pi, amountCents: cents, status }),
  );

/** order_part_requests with an override reason, as whoever `tx` is. */
const orderWithReason = (
  tx: pg.Client,
  requestIds: string[],
  supplierId: string,
  reason: string | null,
  poId: string = randomUUID(),
) =>
  scalar<string>(tx, "select public.order_part_requests($1, $2, $3, true, $4)", [
    requestIds,
    supplierId,
    poId,
    reason,
  ]);

/** The job's part_ordered payloads, oldest first (read as the owner). */
const partOrdered = (tx: pg.Client, workOrderId: string) =>
  readAsOwner(tx, async () =>
    (await events(tx, workOrderId))
      .filter((e) => e.event_type === "part_ordered")
      .map((e) => ({ payload: e.payload, actor: e.actor_staff_id })),
  );

const cancelPart = (tx: pg.Client, requestId: string) =>
  tx.query("select public.cancel_part_request($1, $2)", [requestId, "Supplier discontinued it"]);

/** The payment's live issues, sorted (read as the owner). */
const issuesOf = (tx: pg.Client, paymentId: string) =>
  readAsOwner(tx, async () => {
    const { rows } = await tx.query<{ issue: string }>(
      "select issue from public.payment_issues where payment_id = $1 order by issue",
      [paymentId],
    );
    return rows.map((r) => r.issue);
  });

/** The quote's deposit state, or null when it asked none (no quote_deposits row). */
const depositState = (tx: pg.Client, quoteId: string) =>
  readAsOwner(tx, async () => {
    const { rows } = await tx.query<{ state: string }>(
      "select state from public.quote_deposits where quote_id = $1",
      [quoteId],
    );
    return rows[0]?.state ?? null;
  });

// ---------------------------------------------------------------------------
// 1. The setting (D151, D157)
// ---------------------------------------------------------------------------

describe("The deposit percent setting (D151, D157)", () => {
  it("ships at 0; admins set it with history; out of range and other roles are refused", async () => {
    await inTransaction(conn, async (tx) => {
      expect(
        await scalar<number>(
          tx,
          "select indent_deposit_percent from public.shop_settings where id = 1",
        ),
      ).toBe(0);
      await actAs(tx, ADMIN);
      const setPercent = (n: number | null) =>
        scalar<number>(tx, "select public.set_indent_deposit_percent($1)", [n]);
      const history = () =>
        scalar<number>(
          tx,
          "select count(*)::int from public.schedule_events where entity = 'shop_settings'",
        );

      const before = await history();
      expect(await setPercent(0)).toBe(0);
      expect(await history()).toBe(before);
      expect(await setPercent(50)).toBe(50);
      expect(await history()).toBe(before + 1);
      const last = (
        await tx.query<{ payload: Record<string, unknown> }>(
          "select payload from public.schedule_events where entity = 'shop_settings' order by id desc limit 1",
        )
      ).rows[0];
      expect(last.payload).toEqual({ indent_deposit_percent: { from: 0, to: 50 } });
      expect(await setPercent(50)).toBe(50);
      expect(await history()).toBe(before + 1);
      expect(await setPercent(100)).toBe(100);
      expect(await setPercent(37)).toBe(37);
      expect(await history()).toBe(before + 3);

      for (const bad of [-1, 101, null])
        await failsWith(tx, () => setPercent(bad), p0001("deposit_percent_out_of_range"));

      // Never directly writable, not even by an admin.
      await failsWith(
        tx,
        () => tx.query("update public.shop_settings set indent_deposit_percent = 90 where id = 1"),
        DENIED,
      );
      for (const claims of [MANAGER, MECHANIC2, ANON]) {
        await actAs(tx, claims);
        await failsWith(tx, () => setPercent(30), DENIED);
      }
      await ownerMode(tx);
      expect(
        await scalar<number>(
          tx,
          "select indent_deposit_percent from public.shop_settings where id = 1",
        ),
      ).toBe(37);
    });
  });
});

// ---------------------------------------------------------------------------
// 2. The snapshot (D158a, b)
// ---------------------------------------------------------------------------

describe("The deposit snapshot on quotes (D158a, b)", () => {
  it("copies the percent when sent and computes the amount from approved parts when answered", async () => {
    await inTransaction(conn, async (tx) => {
      await withPercent(tx, 50);
      const q = await quoted(tx);
      const quoteId = await quoteIdOf(tx, q.job.id);
      expect(await quoteRow(tx, quoteId)).toEqual({
        status: "open",
        deposit_percent: 50,
        deposit_amount: null,
      });
      // A later change of the setting never moves a sent quote.
      await withPercent(tx, 30);
      await actAs(tx, ANON);
      await answerAll(tx, q.token);
      // 2 x 120.00 approved at 50%; the 25.00 service is not counted (132.50 would be).
      expect(await quoteRow(tx, quoteId)).toEqual({
        status: "answered",
        deposit_percent: 50,
        deposit_amount: "120.00",
      });

      // An owner update of either column after answering is refused.
      await ownerMode(tx);
      await failsWith(
        tx,
        () => tx.query("update public.quotes set deposit_amount = 1 where id = $1", [quoteId]),
        p0001("quote_deposit_immutable"),
      );
      await failsWith(
        tx,
        () => tx.query("update public.quotes set deposit_percent = 10 where id = $1", [quoteId]),
        p0001("quote_deposit_immutable"),
      );
    });
  });

  it("declined parts, only services, percent 0 and amounts outside Stripe's range ask nothing; rounding is half away from zero", async () => {
    await inTransaction(conn, async (tx) => {
      // The part declined, the service approved.
      const declined = await answered(tx, { approve: (d) => d.startsWith("Fit ") });
      expect((await quoteRow(tx, declined.quoteId)).deposit_amount).toBeNull();

      // Percent 0.
      const zero = await answered(tx, { percent: 0 });
      expect(await quoteRow(tx, zero.quoteId)).toMatchObject({
        deposit_percent: 0,
        deposit_amount: null,
      });

      // One part at a given price, at 50%.
      const single = async (price: string) => {
        await withPercent(tx, 50);
        const s = await setup(tx);
        const partId = await proposePart(tx, {
          workOrderId: s.job.id,
          productId: s.productId,
          quantity: 1,
          price,
        });
        const token = await sendQuote(tx, { workOrderId: s.job.id, requestIds: [partId] });
        await actAs(tx, ANON);
        await answerAll(tx, token);
        return (await quoteRow(tx, await quoteIdOf(tx, s.job.id))).deposit_amount;
      };
      expect(await single("33.33")).toBe("16.67"); // 16.665
      expect(await single("0.99")).toBe("0.50"); // 0.495: asked, never rounded up further
      expect(await single("0.80")).toBeNull(); // 0.40: under Stripe's minimum

      // Only services.
      await withPercent(tx, 50);
      const s = await setup(tx);
      const { rows } = await tx.query<{ id: string }>(
        "select public.propose_service($1, $2, $3, 1, null) as id",
        [randomUUID(), s.job.id, s.serviceId],
      );
      const token = await sendQuote(tx, { workOrderId: s.job.id, requestIds: [rows[0].id] });
      await actAs(tx, ANON);
      await answerAll(tx, token);
      expect(await quoteRow(tx, await quoteIdOf(tx, s.job.id))).toMatchObject({
        deposit_percent: 50,
        deposit_amount: null,
      });
    });
  });

  it("a quote not in SGD asks nothing; a quote sent before step 2 is never gated", async () => {
    await inTransaction(conn, async (tx) => {
      // A USD quote (inserted as the owner): percent 0, never an amount.
      await withPercent(tx, 50);
      const s = await setup(tx);
      await ownerMode(tx);
      const usdQuote = randomUUID();
      await tx.query(
        `insert into public.quotes (id, work_order_id, token_hash, channel, currency, total, expires_at, sent_by)
         values ($1, $2, sha256(convert_to($3, 'UTF8')), 'link', 'USD', 0, now() + interval '7 days', $4)`,
        [usdQuote, s.job.id, randomUUID(), STAFF.admin],
      );
      expect(await quoteRow(tx, usdQuote)).toMatchObject({ deposit_percent: 0 });
      await tx.query(
        "update public.quotes set status = 'answered', answered_at = now(), answered_name = 'Tan' where id = $1",
        [usdQuote],
      );
      expect(await quoteRow(tx, usdQuote)).toEqual({
        status: "answered",
        deposit_percent: 0,
        deposit_amount: null,
      });

      // Sent before step 2: a null percent (simulated inside this
      // rolled-back transaction), answered with no deposit, ordered freely.
      await withPercent(tx, 50);
      const q = await quoted(tx);
      const quoteId = await quoteIdOf(tx, q.job.id);
      await ownerMode(tx);
      await tx.query("alter table public.quotes disable trigger quotes_deposit_snapshot");
      await tx.query("update public.quotes set deposit_percent = null where id = $1", [quoteId]);
      await tx.query("alter table public.quotes enable trigger quotes_deposit_snapshot");
      await actAs(tx, ANON);
      await answerAll(tx, q.token);
      expect(await quoteRow(tx, quoteId)).toEqual({
        status: "answered",
        deposit_percent: null,
        deposit_amount: null,
      });
      expect(await depositState(tx, quoteId)).toBeNull();
      await ownerMode(tx);
      await grantPurchasing(tx, STAFF.mechanic2);
      await actAs(tx, MECHANIC2);
      expect(await orderParts(tx, [q.partId], q.supplierId)).toBeTruthy();
    });
  });
});

// ---------------------------------------------------------------------------
// 3. The quote page's contract (D143, D151, D158)
// ---------------------------------------------------------------------------

describe("The quote view's deposit key (D143, D158)", () => {
  it("12 keys; on_answer, due, processing, paid and refunded; nothing from Stripe on the page", async () => {
    await inTransaction(conn, async (tx) => {
      await withPercent(tx, 50);
      const q = await quoted(tx);
      await actAs(tx, ANON);
      const open = await quoteByToken(tx, q.token);
      expect(Object.keys(open!).sort()).toEqual([
        "answered_at",
        "answered_name",
        "bike",
        "currency",
        "deposit",
        "expires_at",
        "first_name",
        "items",
        "job_number",
        "sent_at",
        "status",
        "total",
      ]);
      expect(await pageDeposit(tx, q.token)).toEqual({
        percent: 50,
        amount: null,
        status: "on_answer",
      });
      await answerAll(tx, q.token);
      const d: Answered = { ...q, quoteId: await quoteIdOf(tx, q.job.id) };
      expect(await pageDeposit(tx, q.token)).toEqual({
        percent: 50,
        amount: "120.00",
        status: "due",
      });

      // Completed but unpaid (an asynchronous method): processing.
      const p = await startCheckout(tx, d);
      expect((await pageDeposit(tx, q.token))!.status).toBe("due");
      await deliver(
        tx,
        "checkout.session.completed",
        paidSession(p, { paymentStatus: "unpaid", status: "complete" }),
      );
      expect((await pageDeposit(tx, q.token))!.status).toBe("processing");
      await deliver(tx, "checkout.session.async_payment_succeeded", paidSession(p));
      expect(await pageDeposit(tx, q.token)).toEqual({
        percent: 50,
        amount: "120.00",
        status: "paid",
      });
      await refundDeposit(tx, p, 5000);
      expect((await pageDeposit(tx, q.token))!.status).toBe("paid");
      await refundDeposit(tx, p, 7000);
      expect((await pageDeposit(tx, q.token))!.status).toBe("refunded");

      await actAs(tx, ANON);
      const page = await quoteByToken(tx, q.token);
      expect(Object.keys(page!)).toHaveLength(12);
      expect(JSON.stringify(page)).not.toMatch(/70\.00|cost|supplier|email|phone|note/i);
      expect(JSON.stringify(page)).not.toMatch(/cs_|pi_|re_|evt_|https?:/i);
    });
  });

  it("no deposit on the page: a due deposit on a cancelled job, every part cancelled, or percent 0; withdrawn and expired keep 2 keys", async () => {
    await inTransaction(conn, async (tx) => {
      const cancelledJob = await answered(tx);
      await setStatus(tx, cancelledJob.job.id, "cancelled", "Customer withdrew");
      expect(await pageDeposit(tx, cancelledJob.token)).toBeNull();

      const cancelledParts = await answered(tx);
      await cancelPart(tx, cancelledParts.partId);
      expect(await depositState(tx, cancelledParts.quoteId)).toBe("none");
      expect(await pageDeposit(tx, cancelledParts.token)).toBeNull();

      const zero = await answered(tx, { percent: 0 });
      expect(await pageDeposit(tx, zero.token)).toBeNull();

      await withPercent(tx, 50);
      const withdrawn = await quoted(tx);
      await tx.query("select public.withdraw_quote($1)", [await quoteIdOf(tx, withdrawn.job.id)]);
      await actAs(tx, ANON);
      expect(Object.keys((await quoteByToken(tx, withdrawn.token))!).sort()).toEqual([
        "job_number",
        "status",
      ]);

      await withPercent(tx, 50);
      const expired = await quoted(tx);
      await ownerMode(tx);
      await tx.query(
        "update public.quotes set expires_at = now() - interval '1 minute' where work_order_id = $1",
        [expired.job.id],
      );
      await actAs(tx, ANON);
      expect(await quoteByToken(tx, expired.token)).toEqual({
        status: "expired",
        job_number: expired.job.job_number,
      });
    });
  });
});

// ---------------------------------------------------------------------------
// 4. prepare_deposit_checkout
// ---------------------------------------------------------------------------

describe("prepare_deposit_checkout (service role; D151, D158)", () => {
  it("only the service role; unknown links and quotes without a deposit are refused", async () => {
    await inTransaction(conn, async (tx) => {
      const d = await answered(tx);
      for (const claims of [ANON, ADMIN, MECHANIC1]) {
        await actAs(tx, claims);
        await failsWith(tx, () => callPrepare(tx, d.token), DENIED);
      }
      await actAs(tx, SERVICE);
      const unknown = randomUUID().replace(/-/g, "").padEnd(43, "A");
      for (const token of [unknown, "not-a-token"])
        await failsWith(tx, () => callPrepare(tx, token), {
          code: "P0002",
          message: "quote_not_found",
        });

      await withPercent(tx, 50);
      const open = await quoted(tx);
      await actAs(tx, SERVICE);
      await failsWith(tx, () => callPrepare(tx, open.token), p0001("deposit_not_due"));
      const zero = await answered(tx, { percent: 0 });
      await actAs(tx, SERVICE);
      await failsWith(tx, () => callPrepare(tx, zero.token), p0001("deposit_not_due"));
    });
  });

  it("create, then check, then processing, paid and refunded; closed jobs and cancelled parts are refused", async () => {
    await inTransaction(conn, async (tx) => {
      const d = await answered(tx);
      const first = await prepare(tx, d.token);
      const nowSeconds = await scalar<number>(tx, "select extract(epoch from now())::int");
      expect(first).toMatchObject({
        outcome: "create",
        work_order_id: d.job.id,
        quote_id: d.quoteId,
        job_number: d.job.job_number,
        amount: "120.00",
        amount_cents: 12000,
        currency: "SGD",
        stripe_checkout_session_id: null,
      });
      expect(Math.abs(first.expires_at! - nowSeconds - 3600)).toBeLessThan(120);
      const second = await prepare(tx, d.token);
      expect(second.outcome).toBe("create");
      expect(second.payment_id).not.toBe(first.payment_id);

      const s = openSession(d, first.payment_id!);
      await recordCheckout(tx, first.payment_id!, d.quoteId, s);
      expect(await prepare(tx, d.token)).toMatchObject({
        outcome: "check",
        payment_id: first.payment_id,
        stripe_checkout_session_id: s.id,
        amount_cents: 12000,
      });
      const p: Pay = {
        paymentId: first.payment_id!,
        sessionId: s.id as string,
        workOrderId: d.job.id,
        quoteId: d.quoteId,
        pi: `pi_${tag()}`,
      };
      await deliver(tx, "checkout.session.completed", paidSession(p, { paymentStatus: "unpaid" }));
      expect(await prepare(tx, d.token)).toMatchObject({
        outcome: "processing",
        payment_id: p.paymentId,
      });
      await deliver(tx, "checkout.session.async_payment_succeeded", paidSession(p));
      expect(await prepare(tx, d.token)).toMatchObject({
        outcome: "paid",
        payment_id: p.paymentId,
      });
      await refundDeposit(tx, p, 12000);
      expect(await prepare(tx, d.token)).toMatchObject({
        outcome: "refunded",
        payment_id: p.paymentId,
      });

      const closed = await answered(tx);
      await setStatus(tx, closed.job.id, "cancelled", "Customer withdrew");
      await actAs(tx, SERVICE);
      await failsWith(tx, () => callPrepare(tx, closed.token), p0001("deposit_job_closed"));

      const cancelled = await answered(tx);
      await cancelPart(tx, cancelled.partId);
      await actAs(tx, SERVICE);
      await failsWith(tx, () => callPrepare(tx, cancelled.token), p0001("deposit_parts_cancelled"));
    });
  });
});

// ---------------------------------------------------------------------------
// 5. record_deposit_checkout
// ---------------------------------------------------------------------------

describe("record_deposit_checkout (service role; D153, D158d)", () => {
  it("records Stripe's open session once; replays and concurrent attempts are existing; no timeline entry", async () => {
    await inTransaction(conn, async (tx) => {
      const d = await answered(tx);
      for (const claims of [ANON, ADMIN, MECHANIC1]) {
        await actAs(tx, claims);
        await failsWith(
          tx,
          () => callRecordCheckout(tx, randomUUID(), d.quoteId, openSession(d, randomUUID())),
          DENIED,
        );
      }
      const eventsBefore = await readAsOwner(tx, async () => (await events(tx, d.job.id)).length);
      const prep = await prepare(tx, d.token);
      const expiresAt = unixNow() + 3000;
      const s = openSession(d, prep.payment_id!, { expiresAt });
      expect(await recordCheckout(tx, prep.payment_id!, d.quoteId, s)).toEqual({
        outcome: "created",
        payment_id: prep.payment_id,
        stripe_checkout_session_id: s.id,
      });
      const row = await readAsOwner(tx, async () => {
        const { rows } = await tx.query(
          `select status::text, kind::text, amount::text, amount_cents::int, livemode,
                  stripe_checkout_session_id, extract(epoch from stripe_session_expires_at)::int as expires
             from public.payments where id = $1`,
          [prep.payment_id],
        );
        return rows[0];
      });
      expect(row).toEqual({
        status: "pending",
        kind: "deposit",
        amount: "120.00",
        amount_cents: 12000,
        livemode: false,
        stripe_checkout_session_id: s.id,
        expires: expiresAt,
      });

      // Replays.
      expect(await recordCheckout(tx, prep.payment_id!, d.quoteId, s)).toMatchObject({
        outcome: "existing",
        payment_id: prep.payment_id,
      });
      await failsWith(
        tx,
        () => callRecordCheckout(tx, prep.payment_id!, d.quoteId, openSession(d, prep.payment_id!)),
        p0001("checkout_session_conflict"),
      );
      // Another attempt while one is pending: the first wins.
      const other = randomUUID();
      expect(await recordCheckout(tx, other, d.quoteId, openSession(d, other))).toEqual({
        outcome: "existing",
        payment_id: prep.payment_id,
        stripe_checkout_session_id: s.id,
      });
      expect(await readAsOwner(tx, async () => (await events(tx, d.job.id)).length)).toBe(
        eventsBefore,
      );

      // A second pending deposit inserted directly is refused by the index.
      await ownerMode(tx);
      await failsWith(
        tx,
        () =>
          tx.query(
            `insert into public.payments
               (id, work_order_id, quote_id, kind, amount, stripe_checkout_session_id,
                stripe_session_expires_at, livemode)
             values ($1, $2, $3, 'deposit', 120, $4, now() + interval '1 hour', false)`,
            [randomUUID(), d.job.id, d.quoteId, `cs_test_${tag()}`],
          ),
        { code: "23505", constraint: "payments_one_open_deposit" },
      );
    });
  });

  it("refuses a session that does not echo the deposit asked; a paid deposit records nothing", async () => {
    await inTransaction(conn, async (tx) => {
      const d = await answered(tx);
      const prep = await prepare(tx, d.token);
      const id = prep.payment_id!;
      const mismatches: Array<Partial<Parameters<typeof sessionObject>[0]>> = [
        { amountCents: 13250 },
        { currency: "usd" },
        { extra: { metadata: { bicii_payment_id: randomUUID() } } },
        { extra: { metadata: { bicii_quote_id: randomUUID() } } },
        { extra: { client_reference_id: randomUUID() } },
        { status: "complete" },
        { expiresAt: unixNow() - 60 },
        { extra: { livemode: "false" } },
      ];
      for (const o of mismatches)
        await failsWith(
          tx,
          () => callRecordCheckout(tx, id, d.quoteId, openSession(d, id, o)),
          p0001("checkout_session_mismatch"),
        );
      await failsWith(
        tx,
        () => callRecordCheckout(tx, id, d.quoteId, { ...openSession(d, id), id: "cs_bad" }),
        p0001("checkout_session_mismatch"),
      );
      const paymentCount = () =>
        readAsOwner(tx, () =>
          scalar<number>(tx, "select count(*)::int from public.payments where quote_id = $1", [
            d.quoteId,
          ]),
        );
      expect(await paymentCount()).toBe(0);

      const p = await startCheckout(tx, d);
      await payDeposit(tx, p);
      const late = randomUUID();
      expect(await recordCheckout(tx, late, d.quoteId, openSession(d, late))).toEqual({
        outcome: "paid",
        payment_id: null,
        stripe_checkout_session_id: null,
      });
      expect(await paymentCount()).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// 6. The D152 gate
// ---------------------------------------------------------------------------

describe("The D152 ordering gate and its override", () => {
  it("unpaid deposits need an active admin or manager and a reason, recorded on part_ordered", async () => {
    await inTransaction(conn, async (tx) => {
      const d = await answered(tx);
      expect(await depositState(tx, d.quoteId)).toBe("due");
      await actAs(tx, ADMIN);
      await failsWith(tx, () => orderParts(tx, [d.partId], d.supplierId), p0001("deposit_unpaid"));
      await failsWith(
        tx,
        () => orderWithReason(tx, [d.partId], d.supplierId, "   "),
        p0001("deposit_unpaid"),
      );
      // manage_purchasing as extra access does not include the override.
      await ownerMode(tx);
      await grantPurchasing(tx, STAFF.mechanic2);
      await actAs(tx, MECHANIC2);
      await failsWith(
        tx,
        () => orderWithReason(tx, [d.partId], d.supplierId, "Customer paid cash"),
        DENIED,
      );
      await failsWith(
        tx,
        () => orderWithReason(tx, [d.partId], d.supplierId, null),
        p0001("deposit_unpaid"),
      );
      await actAs(tx, MANAGER);
      await failsWith(
        tx,
        () => orderWithReason(tx, [d.partId], d.supplierId, "x".repeat(501)),
        p0001("reason_too_long"),
      );
      const poId = randomUUID();
      expect(
        await orderWithReason(
          tx,
          [d.partId],
          d.supplierId,
          "  Customer paid cash at the counter  ",
          poId,
        ),
      ).toBe(poId);
      const ordered = await partOrdered(tx, d.job.id);
      expect(ordered).toHaveLength(1);
      expect(ordered[0].actor).toBe(STAFF.manager);
      expect(ordered[0].payload.deposit_override).toEqual({
        reason: "Customer paid cash at the counter",
        quote_ids: [d.quoteId],
      });
      // A replay returns the purchase order, with or without a reason.
      expect(await orderParts(tx, [d.partId], d.supplierId)).toBe(poId);
    });
  });

  it("paid or partly refunded opens the gate; refunded and processing close it; no deposit never gates", async () => {
    await inTransaction(conn, async (tx) => {
      // Paid: ordered without a reason, nothing recorded.
      const paid = await answered(tx);
      const p = await startCheckout(tx, paid);
      await payDeposit(tx, p);
      await actAs(tx, ADMIN);
      const poId = await orderParts(tx, [paid.partId], paid.supplierId);
      expect((await partOrdered(tx, paid.job.id))[0].payload).not.toHaveProperty(
        "deposit_override",
      );
      // A replay of the ordered set after a full refund still returns its order.
      await refundDeposit(tx, p, 12000);
      expect(await depositState(tx, paid.quoteId)).toBe("refunded");
      await actAs(tx, ADMIN);
      expect(await orderParts(tx, [paid.partId], paid.supplierId)).toBe(poId);

      // Partly refunded: still paid (D158e).
      const partial = await answered(tx);
      const pp = await startCheckout(tx, partial);
      await payDeposit(tx, pp);
      await refundDeposit(tx, pp, 5000);
      expect(await depositState(tx, partial.quoteId)).toBe("paid");
      await actAs(tx, ADMIN);
      expect(await orderParts(tx, [partial.partId], partial.supplierId)).toBeTruthy();

      // Fully refunded: unpaid again.
      const refunded = await answered(tx);
      const rp = await startCheckout(tx, refunded);
      await payDeposit(tx, rp);
      await refundDeposit(tx, rp, 12000);
      await actAs(tx, ADMIN);
      await failsWith(
        tx,
        () => orderParts(tx, [refunded.partId], refunded.supplierId),
        p0001("deposit_unpaid"),
      );

      // Processing: not yet paid.
      const processing = await answered(tx);
      const prp = await startCheckout(tx, processing);
      await payDeposit(tx, prp, { paymentStatus: "unpaid" });
      expect(await depositState(tx, processing.quoteId)).toBe("processing");
      await actAs(tx, ADMIN);
      await failsWith(
        tx,
        () => orderParts(tx, [processing.partId], processing.supplierId),
        p0001("deposit_unpaid"),
      );

      // Percent 0: never gated; a reason given when nothing is unpaid is not recorded.
      const zero = await answered(tx, { percent: 0 });
      await actAs(tx, MANAGER);
      expect(
        await orderWithReason(tx, [zero.partId], zero.supplierId, "Just in case"),
      ).toBeTruthy();
      expect((await partOrdered(tx, zero.job.id))[0].payload).not.toHaveProperty(
        "deposit_override",
      );
    });
  });

  it("checks approval first; records the override only on the unpaid job; fitting is not gated", async () => {
    await inTransaction(conn, async (tx) => {
      const unpaid = await answered(tx);
      await actAs(tx, ADMIN);
      await failsWith(
        tx,
        () => orderParts(tx, [unpaid.partId, unpaid.serviceRequestId], unpaid.supplierId),
        p0001("part_request_not_approved"),
      );

      // Two jobs, one paid and one unpaid, ordered together with a reason.
      const paid = await answered(tx);
      const p = await startCheckout(tx, paid);
      await payDeposit(tx, p);
      await actAs(tx, MANAGER);
      await orderWithReason(tx, [paid.partId, unpaid.partId], paid.supplierId, "Urgent repair");
      expect((await partOrdered(tx, paid.job.id))[0].payload).not.toHaveProperty(
        "deposit_override",
      );
      expect((await partOrdered(tx, unpaid.job.id))[0].payload.deposit_override).toEqual({
        reason: "Urgent repair",
        quote_ids: [unpaid.quoteId],
      });

      // Fitting an approved part already in stock, its deposit due (D152 gates ordering only).
      const fitting = await answered(tx);
      await actAs(tx, ADMIN);
      await addStock(tx, fitting.productId, 2);
      const lineId = randomUUID();
      expect(await fit(tx, fitting.partId, lineId, LOCATION.shopFloor)).toBe(lineId);
      expect(await depositState(tx, fitting.quoteId)).toBe("due");
    });
  });
});

// ---------------------------------------------------------------------------
// 7. The views
// ---------------------------------------------------------------------------

describe("quote_deposits, payment_issues and work_order_payment_totals", () => {
  it("quote_deposits: staff read it through RLS; customers read nothing; anon is refused", async () => {
    await inTransaction(conn, async (tx) => {
      const d = await answered(tx);
      await actAs(tx, MECHANIC1);
      const { rows } = await tx.query(
        `select quote_id, work_order_id, deposit_percent, deposit_amount::text, state, part_request_ids
           from public.quote_deposits where quote_id = $1`,
        [d.quoteId],
      );
      expect(rows).toEqual([
        {
          quote_id: d.quoteId,
          work_order_id: d.job.id,
          deposit_percent: 50,
          deposit_amount: "120.00",
          state: "due",
          part_request_ids: [d.partId],
        },
      ]);
      await ownerMode(tx);
      const login = await linkCustomerLogin(tx, d.job.customer_id);
      await actAs(tx, customerClaims(login));
      for (const view of ["quote_deposits", "payment_issues", "work_order_payment_totals"])
        expect(await scalar<number>(tx, `select count(*)::int from public.${view}`)).toBe(0);
      await actAs(tx, ANON);
      for (const view of ["quote_deposits", "payment_issues", "work_order_payment_totals"])
        await failsWith(tx, () => tx.query(`select 1 from public.${view}`), DENIED);
    });
  });

  it("payment_issues: each condition is derived live and clears when its cause clears", async () => {
    await inTransaction(conn, async (tx) => {
      // paid_job_cancelled, cleared by a full refund.
      const a = await answered(tx);
      const pa = await startCheckout(tx, a);
      await payDeposit(tx, pa);
      expect(await issuesOf(tx, pa.paymentId)).toEqual([]);
      await actAs(tx, ADMIN);
      await setStatus(tx, a.job.id, "cancelled", "Customer withdrew");
      expect(await issuesOf(tx, pa.paymentId)).toEqual(["paid_job_cancelled"]);
      await refundDeposit(tx, pa, 12000);
      expect(await issuesOf(tx, pa.paymentId)).toEqual([]);

      // paid_parts_cancelled.
      const b = await answered(tx);
      const pb = await startCheckout(tx, b);
      await payDeposit(tx, pb);
      await actAs(tx, ADMIN);
      await cancelPart(tx, b.partId);
      expect(await issuesOf(tx, pb.paymentId)).toEqual(["paid_parts_cancelled"]);
      const message = await readAsOwner(tx, () =>
        scalar<string>(tx, "select message from public.payment_issues where payment_id = $1", [
          pb.paymentId,
        ]),
      );
      expect(message).toBe(
        "SGD 120.00 is held but every part it was for is cancelled. Refund it in Stripe, or agree with the customer that it counts towards the job.",
      );
      await refundDeposit(tx, pb, 5000);
      expect(await issuesOf(tx, pb.paymentId)).toEqual(["paid_parts_cancelled"]);
      expect(
        await readAsOwner(tx, () =>
          scalar<string>(tx, "select message from public.payment_issues where payment_id = $1", [
            pb.paymentId,
          ]),
        ),
      ).toContain("SGD 70.00 is held");

      // paid_twice: an expired session paid after a second one was paid.
      const c = await answered(tx);
      const first = await startCheckout(tx, c);
      await deliver(
        tx,
        "checkout.session.expired",
        paidSession(first, { status: "expired", paymentStatus: "unpaid", paymentIntent: null }),
      );
      const second = await startCheckout(tx, c);
      await payDeposit(tx, second);
      await deliver(tx, "checkout.session.completed", paidSession(first), unixNow() + 5);
      expect(await issuesOf(tx, second.paymentId)).toEqual([]);
      expect(await issuesOf(tx, first.paymentId)).toEqual(["paid_twice"]);
      await refundDeposit(tx, first, 12000);
      expect(await issuesOf(tx, first.paymentId)).toEqual([]);

      // amount_mismatch.
      const e = await answered(tx);
      const pe = await startCheckout(tx, e);
      await payDeposit(tx, pe, { amountCents: 11999 });
      expect(await issuesOf(tx, pe.paymentId)).toEqual(["amount_mismatch"]);

      // refund_failed, cleared by a later refund that succeeds.
      const f = await answered(tx);
      const pf = await startCheckout(tx, f);
      await payDeposit(tx, pf);
      const r1 = `pyr_${tag()}`;
      await refundDeposit(tx, pf, 5000, "succeeded", r1);
      await refundDeposit(tx, pf, 5000, "failed", r1);
      expect(await issuesOf(tx, pf.paymentId)).toEqual(["refund_failed"]);
      await refundDeposit(tx, pf, 5000, "succeeded");
      expect(await issuesOf(tx, pf.paymentId)).toEqual([]);

      // refund_exceeds_payment.
      const g = await answered(tx);
      const pg_ = await startCheckout(tx, g);
      await payDeposit(tx, pg_);
      await refundDeposit(tx, pg_, 10000);
      await refundDeposit(tx, pg_, 3000);
      expect(await issuesOf(tx, pg_.paymentId)).toEqual(["refund_exceeds_payment"]);

      // pending_unconfirmed, 15 minutes after the session expired; cleared once Stripe answers.
      const h = await answered(tx);
      const ph = await startCheckout(tx, h);
      await ownerMode(tx);
      await tx.query("alter table public.payments disable trigger payments_guard");
      await tx.query(
        "update public.payments set stripe_session_expires_at = now() - interval '20 minutes' where id = $1",
        [ph.paymentId],
      );
      await tx.query("alter table public.payments enable trigger payments_guard");
      expect(await issuesOf(tx, ph.paymentId)).toEqual(["pending_unconfirmed"]);
      const severity = await scalar<string>(
        tx,
        "select severity from public.payment_issues where payment_id = $1",
        [ph.paymentId],
      );
      expect(severity).toBe("warning");
      await deliver(
        tx,
        "checkout.session.expired",
        paidSession(ph, { status: "expired", paymentStatus: "unpaid", paymentIntent: null }),
      );
      expect(await issuesOf(tx, ph.paymentId)).toEqual([]);
    });
  });

  it("work_order_payment_totals: paid ahead while the part is unfitted; no balance once closed", async () => {
    await inTransaction(conn, async (tx) => {
      const d = await answered(tx);
      const p = await startCheckout(tx, d);
      await payDeposit(tx, p);
      const totals = () =>
        readAsOwner(tx, async () => {
          const { rows } = await tx.query(
            `select t.paid_online::text, t.refunded_online::text, t.net_paid_online::text,
                    t.job_total::text, t.balance_due::text, t.paid_ahead::text,
                    (select sale_total::text from public.work_order_totals where work_order_id = $1) as sale_total
               from public.work_order_payment_totals t where t.work_order_id = $1`,
            [d.job.id],
          );
          return rows[0];
        });
      expect(await totals()).toMatchObject({
        paid_online: "120.00",
        refunded_online: "0.00",
        net_paid_online: "120.00",
        job_total: "0.00",
        sale_total: "0.00",
        balance_due: "0.00",
        paid_ahead: "120.00",
      });
      await actAs(tx, MECHANIC1);
      expect(
        await scalar<number>(
          tx,
          "select count(*)::int from public.work_order_payment_totals where work_order_id = $1",
          [d.job.id],
        ),
      ).toBe(1);

      await actAs(tx, ADMIN);
      await walkTo(tx, d.job.id, "collected");
      expect(await totals()).toMatchObject({
        net_paid_online: "120.00",
        balance_due: null,
        paid_ahead: null,
      });

      const c = await answered(tx);
      const pc = await startCheckout(tx, c);
      await payDeposit(tx, pc);
      await actAs(tx, ADMIN);
      await setStatus(tx, c.job.id, "cancelled", "Customer withdrew");
      const cancelled = await readAsOwner(tx, async () => {
        const { rows } = await tx.query(
          "select balance_due, paid_ahead from public.work_order_payment_totals where work_order_id = $1",
          [c.job.id],
        );
        return rows[0];
      });
      expect(cancelled).toEqual({ balance_due: null, paid_ahead: null });
    });
  });
});

// ---------------------------------------------------------------------------
// 8. Exceptions (D108 kept)
// ---------------------------------------------------------------------------

describe("Exceptions: payment_attention and stripe_attention (D108, D159b)", () => {
  type ExceptionRow = {
    kind: string;
    severity: string;
    entity_type: string;
    entity_id: string;
    title: string | null;
    detail: string | null;
    issue: string | null;
  };
  const listed = async (tx: pg.Client, claims: Claims) => {
    await actAs(tx, claims);
    const { rows } = await tx.query<ExceptionRow>(
      "select kind, severity, entity_type, entity_id, title, detail, issue from public.operational_exceptions(200)",
    );
    return rows;
  };

  it("payment_attention for admins and managers; stripe_attention for admins only; counts and Today agree", async () => {
    await inTransaction(conn, async (tx) => {
      const d = await answered(tx);
      const p = await startCheckout(tx, d);
      await payDeposit(tx, p, { amountCents: 11999 });

      // A paid session naming a payment BICII has no record of.
      const orphan = await deliver(
        tx,
        "checkout.session.completed",
        sessionObject({
          id: `cs_test_${tag()}`,
          paymentId: randomUUID(),
          workOrderId: d.job.id,
          amountCents: 5000,
        }),
      );
      expect(orphan).toMatchObject({
        event_status: "needs_attention",
        outcome: "payment_not_found",
      });

      // A delivery that could not be recorded, later stored by a retry.
      const retried = stripeEvent({
        id: `evt_${tag()}`,
        type: "checkout.session.expired",
        object: sessionObject({
          id: `cs_test_${tag()}`,
          paymentId: randomUUID(),
          workOrderId: d.job.id,
          amountCents: 5000,
          status: "expired",
          paymentStatus: "unpaid",
        }),
      });
      await actAs(tx, SERVICE);
      await callRecordEvent(tx, retried, "not_recorded");

      const paymentRows = (rows: ExceptionRow[]) =>
        rows.filter((r) => r.kind === "payment_attention" && r.entity_id === d.job.id);
      const stripeRows = (rows: ExceptionRow[]) =>
        rows.filter((r) => r.kind === "stripe_attention");

      const asAdmin = await listed(tx, ADMIN);
      expect(paymentRows(asAdmin)).toEqual([
        {
          kind: "payment_attention",
          severity: "danger",
          entity_type: "work_order",
          entity_id: d.job.id,
          title: d.job.job_number,
          detail: "Stripe received SGD 119.99, not the 120.00 asked. Check the payment in Stripe.",
          issue: "payment_attention",
        },
      ]);
      expect(
        stripeRows(asAdmin)
          .map((r) => r.detail)
          .sort(),
      ).toEqual([
        "A Stripe delivery could not be recorded; Stripe is retrying it. Ask engineering if this stays.",
        "Stripe reported a payment BICII has no record of. Check it in Stripe.",
      ]);
      expect(stripeRows(asAdmin).every((r) => r.entity_type === "stripe_event")).toBe(true);
      expect(stripeRows(asAdmin).every((r) => r.title === "Stripe")).toBe(true);

      const asManager = await listed(tx, MANAGER);
      expect(paymentRows(asManager)).toHaveLength(1);
      expect(stripeRows(asManager)).toEqual([]);
      const asMechanic = await listed(tx, MECHANIC2);
      expect(paymentRows(asMechanic)).toEqual([]);
      expect(stripeRows(asMechanic)).toEqual([]);

      // Counts and Today agree with the list, per caller.
      for (const claims of [ADMIN, MANAGER, MECHANIC2]) {
        const rows = await listed(tx, claims);
        expect(rows.length).toBeLessThan(200);
        const counts = (
          await tx.query<{ kind: string; count: number }>(
            "select kind, count from public.report_exception_counts()",
          )
        ).rows;
        expect(counts.reduce((sum, c) => sum + c.count, 0)).toBe(rows.length);
        for (const kind of ["payment_attention", "stripe_attention"])
          expect(counts.find((c) => c.kind === kind)?.count ?? 0).toBe(
            rows.filter((r) => r.kind === kind).length,
          );
        const dash = await scalar<number>(
          tx,
          "select exceptions_now from public.today_dashboard(null)",
        );
        expect(dash).toBe(rows.length);
      }

      // The not_recorded row clears once Stripe's retry of the same body is stored.
      await actAs(tx, SERVICE);
      expect((await callRecordEvent(tx, retried)).event_status).toBe("ignored");
      expect(stripeRows(await listed(tx, ADMIN)).map((r) => r.detail)).toEqual([
        "Stripe reported a payment BICII has no record of. Check it in Stripe.",
      ]);
      // The payment issue clears when its cause clears (a full refund).
      await refundDeposit(tx, p, 11999);
      expect(paymentRows(await listed(tx, ADMIN))).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// 9. Concurrency (committed; per-file clone only)
// ---------------------------------------------------------------------------

describe.skipIf(!isolatedDatabase())("Concurrency (DATA-MODEL §19 lock order)", () => {
  let c1: pg.Client;
  let c2: pg.Client;
  let setupConn: pg.Client;

  beforeAll(async () => {
    [c1, c2, setupConn] = await openConnections(3);
  });

  afterAll(async () => {
    // The committed quotes keep their snapshot; the shop goes back to 0.
    await inTransaction(setupConn, (tx) => withPercent(tx, 0), { commit: true });
  });

  /** A committed answered quote at 50% (the setting back at 0 afterwards). */
  const committedDeposit = () =>
    inTransaction(
      setupConn,
      async (tx) => {
        const d = await answered(tx);
        await withPercent(tx, 0);
        return d;
      },
      { commit: true },
    );

  it("two record_deposit_checkout calls for one quote: one created, one existing", async () => {
    const d = await committedDeposit();
    const [a, b] = await inTransaction(
      setupConn,
      async (tx) => [await prepare(tx, d.token), await prepare(tx, d.token)],
      { commit: true },
    );
    const results = await Promise.all([
      committed(
        c1,
        (tx) => callRecordCheckout(tx, a.payment_id!, d.quoteId, openSession(d, a.payment_id!)),
        SERVICE,
      ),
      committed(
        c2,
        (tx) => callRecordCheckout(tx, b.payment_id!, d.quoteId, openSession(d, b.payment_id!)),
        SERVICE,
      ),
    ]);
    expect(
      results.every((r) => r.ok),
      JSON.stringify(results),
    ).toBe(true);
    expect(results.map((r) => (r.ok ? r.value.outcome : null)).sort()).toEqual([
      "created",
      "existing",
    ]);
    expect(
      await scalar<number>(
        conn,
        "select count(*)::int from public.payments where quote_id = $1 and status = 'pending'",
        [d.quoteId],
      ),
    ).toBe(1);
  });

  it("a paid webhook against ordering without a reason: never ordered while unpaid, no deadlock", async () => {
    for (let i = 0; i < 2; i++) {
      const d = await committedDeposit();
      const p = await inTransaction(setupConn, (tx) => startCheckout(tx, d), { commit: true });
      const webhook = (tx: pg.Client) =>
        callRecordEvent(
          tx,
          stripeEvent({
            id: `evt_${tag()}`,
            type: "checkout.session.completed",
            object: paidSession(p),
          }),
        );
      const order = (tx: pg.Client) => orderParts(tx, [d.partId], d.supplierId);
      const results =
        i === 0
          ? await Promise.all([committed(c1, webhook, SERVICE), committed(c2, order, ADMIN)])
          : await Promise.all([committed(c2, order, ADMIN), committed(c1, webhook, SERVICE)]);
      const [hook, ordered] = i === 0 ? results : [results[1], results[0]];
      expect(hook.ok, JSON.stringify(hook)).toBe(true);
      if (!ordered.ok) expect(ordered.error).toMatchObject(p0001("deposit_unpaid"));
      // If ordering committed, it saw the payment the webhook had committed.
      if (ordered.ok) {
        const orderedAt = await scalar<Date>(
          conn,
          "select ordered_at from public.job_part_requests where id = $1",
          [d.partId],
        );
        const paidCommitted = await scalar<Date>(
          conn,
          "select processed_at from public.stripe_events where payment_id = $1 and outcome = 'payment_paid'",
          [p.paymentId],
        );
        expect(orderedAt.getTime()).toBeGreaterThanOrEqual(paidCommitted.getTime());
      }
      expect(
        await scalar<string>(conn, "select status::text from public.payments where id = $1", [
          p.paymentId,
        ]),
      ).toBe("paid");
    }
  });

  it("record_deposit_checkout against cancelling the part: no deadlock, a consistent outcome", async () => {
    const d = await committedDeposit();
    const prep = await inTransaction(setupConn, (tx) => prepare(tx, d.token), { commit: true });
    const results = await Promise.all([
      committed(
        c1,
        (tx) =>
          callRecordCheckout(tx, prep.payment_id!, d.quoteId, openSession(d, prep.payment_id!)),
        SERVICE,
      ),
      committed(c2, (tx) => cancelPart(tx, d.partId), ADMIN),
    ]);
    const [rec, cancel] = results;
    expect(cancel.ok, JSON.stringify(cancel)).toBe(true);
    if (rec.ok) expect(rec.value.outcome).toBe("created");
    else expect(rec.error).toMatchObject(p0001("deposit_parts_cancelled"));
  });
});
