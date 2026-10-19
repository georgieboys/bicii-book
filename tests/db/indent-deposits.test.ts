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
 *   completed and closed jobs (R-082, D149)  paid_parts_not_fitted,
 *                       held_over_total and the page's job_closed.
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
  beforeTheGuard,
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
  completeJob,
  readAsOwner,
  reopenJob,
} from "./inventory-fixtures";
import { race } from "./lock-race";
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
    deposit: {
      percent: number;
      status: string;
      parts_ordered?: boolean;
      job_closed?: boolean;
      refunded?: number;
    } | null;
    amount: string | null;
    refunded: string | null;
  }>(
    `select q -> 'deposit' as deposit, q -> 'deposit' ->> 'amount' as amount,
            q -> 'deposit' ->> 'refunded' as refunded
       from public.quote_by_token($1) q`,
    [token],
  );
  // Money as text, as Postgres wrote it.
  const { deposit, amount, refunded } = rows[0];
  if (deposit === null) return null;
  return "refunded" in deposit ? { ...deposit, amount, refunded } : { ...deposit, amount };
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
  livemode = false,
): Promise<EventResult> {
  await actAs(tx, SERVICE);
  return callRecordEvent(tx, stripeEvent({ id: `evt_${tag()}`, type, object, created, livemode }));
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

/**
 * D149b/c: a job leaves the open statuses only once its approved and
 * ordered items are settled; answered() approves the part and the service,
 * so both are cancelled first (as whoever `tx` is).
 */
const cancelBoth = async (tx: pg.Client, d: { partId: string; serviceRequestId: string }) => {
  await cancelPart(tx, d.partId);
  await cancelPart(tx, d.serviceRequestId);
};

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
        parts_ordered: false,
        job_closed: false,
        refunded: "0.00",
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
        parts_ordered: false,
        job_closed: false,
        refunded: "0.00",
      });
      // U2-11: a partly refunded deposit is still paid, and says how much
      // of it came back; once all of it has, the state says so instead.
      await refundDeposit(tx, p, 5000);
      expect(await pageDeposit(tx, q.token)).toMatchObject({ status: "paid", refunded: "50.00" });
      await refundDeposit(tx, p, 7000);
      expect(await pageDeposit(tx, q.token)).toMatchObject({
        status: "refunded",
        refunded: "0.00",
      });

      await actAs(tx, ANON);
      const page = await quoteByToken(tx, q.token);
      expect(Object.keys(page!)).toHaveLength(12);
      expect(JSON.stringify(page)).not.toMatch(/70\.00|cost|supplier|email|phone|note/i);
      expect(JSON.stringify(page)).not.toMatch(/cs_|pi_|re_|evt_|https?:/i);
    });
  });

  it("parts_ordered: once an admin or manager orders the parts before the deposit is paid, it is still due", async () => {
    await inTransaction(conn, async (tx) => {
      const d = await answered(tx);
      await actAs(tx, ADMIN);
      await orderWithReason(tx, [d.partId], d.supplierId, "Customer is paying at the counter");
      expect(await pageDeposit(tx, d.token)).toEqual({
        percent: 50,
        amount: "120.00",
        status: "due",
        parts_ordered: true,
        job_closed: false,
        refunded: "0.00",
      });
      // Fitted counts as ordered.
      await actAs(tx, ADMIN);
      await addStock(tx, d.productId, 2);
      await fit(tx, d.partId, randomUUID(), LOCATION.shopFloor);
      expect((await pageDeposit(tx, d.token))!.parts_ordered).toBe(true);
    });
  });

  it("no deposit on the page: a due deposit on a cancelled job, every part cancelled, or percent 0; withdrawn and expired keep 2 keys", async () => {
    await inTransaction(conn, async (tx) => {
      // A job cancelled with its deposit still due: only before
      // 20261014000900's guard (R-082's residual).
      const cancelledJob = await answered(tx);
      await beforeTheGuard(tx, () =>
        setStatus(tx, cancelledJob.job.id, "cancelled", "Customer withdrew"),
      );
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

      // A job cancelled with its approved parts live (before the guard).
      const closed = await answered(tx);
      await beforeTheGuard(tx, () =>
        setStatus(tx, closed.job.id, "cancelled", "Customer withdrew"),
      );
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
      // The same payment id and session replayed against another quote.
      const elsewhere = await answered(tx);
      await failsWith(
        tx,
        async () => {
          await actAs(tx, SERVICE);
          return callRecordCheckout(tx, prep.payment_id!, elsewhere.quoteId, s);
        },
        p0001("checkout_session_conflict"),
      );
      await actAs(tx, SERVICE);
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
        // More than 61 minutes ahead: not the 60-minute session asked (D158d).
        { expiresAt: unixNow() + 2 * 60 * 60 },
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
      // paid_job_cancelled, cleared by a full refund (D149b: the items are
      // cancelled before the job).
      const a = await answered(tx);
      const pa = await startCheckout(tx, a);
      await payDeposit(tx, pa);
      expect(await issuesOf(tx, pa.paymentId)).toEqual([]);
      await actAs(tx, ADMIN);
      await cancelBoth(tx, a);
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
        "$120.00 is held but every part it was for is cancelled. Refund it in Stripe, or agree with the customer that it counts towards the job.",
      );
      await refundDeposit(tx, pb, 5000);
      expect(await issuesOf(tx, pb.paymentId)).toEqual(["paid_parts_cancelled"]);
      expect(
        await readAsOwner(tx, () =>
          scalar<string>(tx, "select message from public.payment_issues where payment_id = $1", [
            pb.paymentId,
          ]),
        ),
      ).toContain("$70.00 is held");

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
      // U2-11: the duplicate came back in full; the deposit itself was not
      // refunded, so the page names no refund.
      expect(await pageDeposit(tx, c.token)).toMatchObject({ status: "paid", refunded: "0.00" });

      // amount_mismatch.
      const e = await answered(tx);
      const pe = await startCheckout(tx, e);
      await payDeposit(tx, pe, { amountCents: 11999 });
      expect(await issuesOf(tx, pe.paymentId)).toEqual(["amount_mismatch"]);
      // Money as the screens print it, both figures with the currency sign.
      expect(
        await readAsOwner(tx, () =>
          scalar<string>(tx, "select message from public.payment_issues where payment_id = $1", [
            pe.paymentId,
          ]),
        ),
      ).toBe("Stripe received $119.99, not the $120.00 asked. Check the payment in Stripe.");

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

      // refund_failed when the refunds were decided before the completion
      // arrived: adopting them re-cites the completion on every row, so the
      // last decision is read from each refund's own status time.
      const o = await answered(tx);
      const po = await startCheckout(tx, o);
      const [o1, o2] = [`pyr_${tag()}`, `pyr_${tag()}`];
      await refundDeposit(tx, po, 3000, "pending", o1);
      await refundDeposit(tx, po, 3000, "pending", o2);
      await refundDeposit(tx, po, 3000, "succeeded", o1);
      await refundDeposit(tx, po, 3000, "succeeded", o2);
      await refundDeposit(tx, po, 3000, "failed", o1);
      await payDeposit(tx, po);
      expect(
        await readAsOwner(tx, () =>
          scalar<string>(
            tx,
            "select status::text || ' ' || refunded_amount::text from public.payments where id = $1",
            [po.paymentId],
          ),
        ),
      ).toBe("partially_refunded 30.00");
      expect(await issuesOf(tx, po.paymentId)).toEqual(["refund_failed"]);

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
      expect(
        await scalar<string>(
          tx,
          "select message from public.payment_issues where payment_id = $1",
          [ph.paymentId],
        ),
      ).toBe("Stripe has not confirmed a payment of $120.00. Press Check with Stripe on the job.");
      await deliver(
        tx,
        "checkout.session.expired",
        paidSession(ph, { status: "expired", paymentStatus: "unpaid", paymentIntent: null }),
      );
      expect(await issuesOf(tx, ph.paymentId)).toEqual([]);

      // Completed at Checkout but never confirmed (R-086): other words.
      const k = await answered(tx);
      const pk = await startCheckout(tx, k);
      await deliver(
        tx,
        "checkout.session.completed",
        paidSession(pk, { paymentStatus: "unpaid", status: "complete" }),
      );
      await ownerMode(tx);
      await tx.query("alter table public.payments disable trigger payments_guard");
      await tx.query(
        "update public.payments set stripe_session_expires_at = now() - interval '20 minutes' where id = $1",
        [pk.paymentId],
      );
      await tx.query("alter table public.payments enable trigger payments_guard");
      expect(
        await scalar<string>(
          tx,
          "select message from public.payment_issues where payment_id = $1",
          [pk.paymentId],
        ),
      ).toBe(
        "The customer completed Checkout for $120.00, but Stripe has not confirmed the payment. Press Check with Stripe on the job; if it stays, look the payment up in the Stripe Dashboard.",
      );
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
      await cancelBoth(tx, d);
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
      await cancelBoth(tx, c);
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
// 7b. Completed and closed jobs (R-082, D149)
// ---------------------------------------------------------------------------

// Each job here completes or closes with approved or ordered parts, which
// 20261014000900's guard now refuses (D149b/c): beforeTheGuard builds the
// state of the jobs that did so before it (production's J-000002; R-082's
// residual), which these views and D149's cancel still serve.
describe("Deposits held for parts never fitted (R-082, D149)", () => {
  const NOT_ON_JOB =
    "$120.00 is held for parts that are not on this job. Reopen the job to fit them, or cancel them and refund in Stripe.";
  const NEVER_WENT_ON =
    "$120.00 is held for parts that never went on this job. Cancel them and refund in Stripe, or agree with the customer how it counts.";

  /** The payment's issues with their words and severity (read as the owner). */
  const issueRows = (tx: pg.Client, paymentId: string) =>
    readAsOwner(tx, async () => {
      const { rows } = await tx.query<{ issue: string; severity: string; message: string }>(
        "select issue, severity, message from public.payment_issues where payment_id = $1 order by issue",
        [paymentId],
      );
      return rows;
    });

  type Totals = {
    job_total: string;
    net_paid_online: string;
    balance_due: string | null;
    paid_ahead: string | null;
    held_over_total: string | null;
  };
  const totals = (tx: pg.Client, workOrderId: string) =>
    readAsOwner(tx, async () => {
      const { rows } = await tx.query<Totals>(
        `select job_total::text, net_paid_online::text, balance_due::text, paid_ahead::text,
                held_over_total::text
           from public.work_order_payment_totals where work_order_id = $1`,
        [workOrderId],
      );
      return rows[0];
    });

  it("paid_parts_not_fitted appears when the job completes with the part unfitted and clears once it is fitted", async () => {
    await inTransaction(conn, async (tx) => {
      const d = await answered(tx);
      const p = await startCheckout(tx, d);
      await payDeposit(tx, p);
      expect(await issuesOf(tx, p.paymentId)).toEqual([]);

      await actAs(tx, ADMIN);
      await beforeTheGuard(tx, () => completeJob(tx, d.job.id));
      expect(await issueRows(tx, p.paymentId)).toEqual([
        { issue: "paid_parts_not_fitted", severity: "danger", message: NOT_ON_JOB },
      ]);
      await actAs(tx, ADMIN);
      await beforeTheGuard(tx, () => setStatus(tx, d.job.id, "ready_for_collection"));
      expect(await issueRows(tx, p.paymentId)).toEqual([
        { issue: "paid_parts_not_fitted", severity: "danger", message: NOT_ON_JOB },
      ]);
      // Its date is the later of the completion and the payment.
      const since = await readAsOwner(tx, () =>
        scalar<boolean>(
          tx,
          `select i.since = greatest(w.completed_at, p.paid_at)
             from public.payment_issues i
             join public.work_orders w on w.id = i.work_order_id
             join public.payments p on p.id = i.payment_id
            where i.payment_id = $1`,
          [p.paymentId],
        ),
      );
      expect(since).toBe(true);

      // Reopen (open again: no issue), fit, complete: nothing held for nothing.
      await actAs(tx, ADMIN);
      await reopenJob(tx, d.job.id);
      expect(await issuesOf(tx, p.paymentId)).toEqual([]);
      await actAs(tx, ADMIN);
      await addStock(tx, d.productId, 2);
      await fit(tx, d.partId, randomUUID(), LOCATION.shopFloor);
      // The fitting service is settled too (D149b), here by cancelling it.
      await cancelPart(tx, d.serviceRequestId);
      await completeJob(tx, d.job.id);
      expect(await issuesOf(tx, p.paymentId)).toEqual([]);
      // The part is on the bill now: 240.00 billed, 120.00 paid online.
      expect(await totals(tx, d.job.id)).toEqual({
        job_total: "240.00",
        net_paid_online: "120.00",
        balance_due: "120.00",
        paid_ahead: "0.00",
        held_over_total: "0.00",
      });
    });
  });

  it("an ordered part counts too; on a collected job the words change, and D149's cancel and a refund clear it", async () => {
    await inTransaction(conn, async (tx) => {
      const d = await answered(tx);
      const p = await startCheckout(tx, d);
      await payDeposit(tx, p);
      await actAs(tx, ADMIN);
      await orderParts(tx, [d.partId], d.supplierId, randomUUID(), false);
      await beforeTheGuard(tx, () => walkTo(tx, d.job.id, "collected"));
      expect(await issueRows(tx, p.paymentId)).toEqual([
        { issue: "paid_parts_not_fitted", severity: "danger", message: NEVER_WENT_ON },
      ]);
      // A partial refund: the words follow what is still held.
      await refundDeposit(tx, p, 5000);
      expect((await issueRows(tx, p.paymentId))[0].message).toBe(
        NEVER_WENT_ON.replace("$120.00", "$70.00"),
      );

      // D149: an admin or manager cancels the part on the collected job;
      // with no approved part left the deposit is for cancelled parts.
      await actAs(tx, MANAGER);
      await cancelPart(tx, d.partId);
      expect(await issuesOf(tx, p.paymentId)).toEqual(["paid_parts_cancelled"]);
      await refundDeposit(tx, p, 7000);
      expect(await issuesOf(tx, p.paymentId)).toEqual([]);
    });
  });

  it("cancelling the unfitted part on a completed job and refunding clears it; a cancelled job keeps paid_job_cancelled only", async () => {
    await inTransaction(conn, async (tx) => {
      const d = await answered(tx);
      const p = await startCheckout(tx, d);
      await payDeposit(tx, p);
      await actAs(tx, ADMIN);
      await beforeTheGuard(tx, () => completeJob(tx, d.job.id));
      expect(await issuesOf(tx, p.paymentId)).toEqual(["paid_parts_not_fitted"]);
      await actAs(tx, MECHANIC1);
      await cancelPart(tx, d.partId);
      expect(await issuesOf(tx, p.paymentId)).toEqual(["paid_parts_cancelled"]);
      await refundDeposit(tx, p, 12000);
      expect(await issuesOf(tx, p.paymentId)).toEqual([]);

      // An open job never has it; a cancelled one has paid_job_cancelled.
      const c = await answered(tx);
      const pc = await startCheckout(tx, c);
      await payDeposit(tx, pc);
      expect(await issuesOf(tx, pc.paymentId)).toEqual([]);
      await actAs(tx, ADMIN);
      await beforeTheGuard(tx, () => setStatus(tx, c.job.id, "cancelled", "Customer withdrew"));
      expect(await issuesOf(tx, pc.paymentId)).toEqual(["paid_job_cancelled"]);

      // A refunded deposit raises nothing, whatever the parts.
      const r = await answered(tx);
      const pr = await startCheckout(tx, r);
      await payDeposit(tx, pr);
      await refundDeposit(tx, pr, 12000);
      await actAs(tx, ADMIN);
      await beforeTheGuard(tx, () => walkTo(tx, r.job.id, "collected"));
      expect(await issuesOf(tx, pr.paymentId)).toEqual([]);
    });
  });

  /**
   * One quote at 100% approving two parts at 60.00 each (deposit 120.00,
   * the fixtures' default Checkout amount), paid; acting as ADMIN.
   */
  async function twoParts(tx: pg.Client) {
    await withPercent(tx, 100);
    const s = await setup(tx);
    const a = await proposePart(tx, {
      workOrderId: s.job.id,
      productId: s.productId,
      price: "60.00",
    });
    const b = await proposePart(tx, {
      workOrderId: s.job.id,
      productId: s.productId,
      price: "60.00",
    });
    const token = await sendQuote(tx, { workOrderId: s.job.id, requestIds: [a, b] });
    await actAs(tx, ANON);
    await answerAll(tx, token);
    const quoteId = await quoteIdOf(tx, s.job.id);
    expect((await quoteRow(tx, quoteId)).deposit_amount).toBe("120.00");
    await actAs(tx, ADMIN);
    const p = await startCheckout(tx, { ...s, partId: a, serviceRequestId: b, token, quoteId });
    await payDeposit(tx, p);
    await actAs(tx, ADMIN);
    return { ...s, a, b, p };
  }

  it("names only the unfitted share when some of the quote's parts were fitted; cancelling or refunding the rest clears it", async () => {
    await inTransaction(conn, async (tx) => {
      const t = await twoParts(tx);
      await addStock(tx, t.productId, 1);
      await fit(tx, t.a, randomUUID(), LOCATION.shopFloor);
      await beforeTheGuard(tx, () => completeJob(tx, t.job.id));
      expect(await issueRows(tx, t.p.paymentId)).toEqual([
        {
          issue: "paid_parts_not_fitted",
          severity: "danger",
          message:
            "$120.00 is held; $60.00 of it is for parts that are not on this job. Reopen the job to fit them, or cancel them and refund that share in Stripe.",
        },
      ]);
      // The same figure as the job's: 60.00 billed, 60.00 paid ahead of it.
      expect(await totals(tx, t.job.id)).toEqual({
        job_total: "60.00",
        net_paid_online: "120.00",
        balance_due: "0.00",
        paid_ahead: "60.00",
        held_over_total: "60.00",
      });
      await actAs(tx, ADMIN);
      await beforeTheGuard(tx, async () => {
        await setStatus(tx, t.job.id, "ready_for_collection");
        await setStatus(tx, t.job.id, "collected");
      });
      expect((await issueRows(tx, t.p.paymentId))[0].message).toBe(
        "$120.00 is held; $60.00 of it is for parts that never went on this job. Cancel them and refund that share in Stripe, or agree with the customer how it counts.",
      );
      expect((await totals(tx, t.job.id)).held_over_total).toBe("60.00");
      // D149: cancelling the unfitted part clears it; the fitted one keeps
      // the deposit live, so it is not paid_parts_cancelled. What is left
      // to settle is the closed job's held_over_total.
      await actAs(tx, MANAGER);
      await cancelPart(tx, t.b);
      expect(await issuesOf(tx, t.p.paymentId)).toEqual([]);
      expect((await totals(tx, t.job.id)).held_over_total).toBe("60.00");

      // Refunding the unfitted share (part not cancelled) clears it too: a
      // refund is taken from the unfitted share first.
      const r = await twoParts(tx);
      await addStock(tx, r.productId, 1);
      await fit(tx, r.a, randomUUID(), LOCATION.shopFloor);
      await beforeTheGuard(tx, () => completeJob(tx, r.job.id));
      await refundDeposit(tx, r.p, 3000);
      expect((await issueRows(tx, r.p.paymentId))[0].message).toBe(
        "$90.00 is held; $30.00 of it is for parts that are not on this job. Reopen the job to fit them, or cancel them and refund that share in Stripe.",
      );
      await refundDeposit(tx, r.p, 3000);
      expect(await issuesOf(tx, r.p.paymentId)).toEqual([]);
      expect(
        await readAsOwner(tx, () =>
          scalar<string>(tx, "select status::text from public.job_part_requests where id = $1", [
            r.b,
          ]),
        ),
      ).toBe("approved");
    });
  });

  it("with two paid quotes on one job, only the payment whose quote has an unfitted part is flagged", async () => {
    await inTransaction(conn, async (tx) => {
      await withPercent(tx, 100);
      const s = await setup(tx);
      const pay = async (requestId: string) => {
        const token = await sendQuote(tx, { workOrderId: s.job.id, requestIds: [requestId] });
        await actAs(tx, ANON);
        await answerAll(tx, token);
        const quoteId = await quoteIdOf(tx, s.job.id);
        await actAs(tx, ADMIN);
        const p = await startCheckout(tx, {
          ...s,
          partId: requestId,
          serviceRequestId: requestId,
          token,
          quoteId,
        });
        await payDeposit(tx, p);
        await actAs(tx, ADMIN);
        return p;
      };
      // Two quotes of one 120.00 part each: 120.00 asked and paid on each.
      const first = await proposePart(tx, { workOrderId: s.job.id, productId: s.productId });
      const p1 = await pay(first);
      const second = await proposePart(tx, { workOrderId: s.job.id, productId: s.productId });
      const p2 = await pay(second);

      await addStock(tx, s.productId, 1);
      await fit(tx, first, randomUUID(), LOCATION.shopFloor);
      await beforeTheGuard(tx, () => completeJob(tx, s.job.id));
      expect(await issuesOf(tx, p1.paymentId)).toEqual([]);
      expect(await issueRows(tx, p2.paymentId)).toEqual([
        {
          issue: "paid_parts_not_fitted",
          severity: "danger",
          message: NOT_ON_JOB,
        },
      ]);
      expect((await totals(tx, s.job.id)).held_over_total).toBe("120.00");

      // Fitted after a reopen: nothing is flagged.
      await actAs(tx, ADMIN);
      await reopenJob(tx, s.job.id);
      await addStock(tx, s.productId, 1);
      await fit(tx, second, randomUUID(), LOCATION.shopFloor);
      await completeJob(tx, s.job.id);
      expect(await issuesOf(tx, p1.paymentId)).toEqual([]);
      expect(await issuesOf(tx, p2.paymentId)).toEqual([]);
    });
  });

  it("held_over_total reconciles a closed job: what was paid online above the bill, in every status", async () => {
    await inTransaction(conn, async (tx) => {
      const d = await answered(tx);
      const p = await startCheckout(tx, d);
      await payDeposit(tx, p);
      expect(await totals(tx, d.job.id)).toEqual({
        job_total: "0.00",
        net_paid_online: "120.00",
        balance_due: "0.00",
        paid_ahead: "120.00",
        held_over_total: "120.00",
      });
      await actAs(tx, ADMIN);
      await beforeTheGuard(tx, () => walkTo(tx, d.job.id, "collected"));
      // balance_due and paid_ahead stay null once closed; held_over_total does not.
      expect(await totals(tx, d.job.id)).toEqual({
        job_total: "0.00",
        net_paid_online: "120.00",
        balance_due: null,
        paid_ahead: null,
        held_over_total: "120.00",
      });
      await refundDeposit(tx, p, 5000);
      expect((await totals(tx, d.job.id)).held_over_total).toBe("70.00");
      await refundDeposit(tx, p, 7000);
      expect((await totals(tx, d.job.id)).held_over_total).toBe("0.00");

      // A cancelled job: everything paid is above its (empty) bill.
      const c = await answered(tx);
      const pc = await startCheckout(tx, c);
      await payDeposit(tx, pc);
      await actAs(tx, ADMIN);
      await beforeTheGuard(tx, () => setStatus(tx, c.job.id, "cancelled", "Customer withdrew"));
      expect((await totals(tx, c.job.id)).held_over_total).toBe("120.00");

      // Staff read it through RLS like the rest of the view.
      await actAs(tx, MECHANIC1);
      expect(
        await scalar<string>(
          tx,
          "select held_over_total::text from public.work_order_payment_totals where work_order_id = $1",
          [c.job.id],
        ),
      ).toBe("120.00");
    });
  });

  it("the quote page's job_closed: false while open, true once completed or collected; still 12 keys and no cost", async () => {
    await inTransaction(conn, async (tx) => {
      const d = await answered(tx);
      expect((await pageDeposit(tx, d.token))!.job_closed).toBe(false);
      const p = await startCheckout(tx, d);
      await payDeposit(tx, p);
      await actAs(tx, ADMIN);
      await beforeTheGuard(tx, () => completeJob(tx, d.job.id));
      expect(await pageDeposit(tx, d.token)).toEqual({
        percent: 50,
        amount: "120.00",
        status: "paid",
        parts_ordered: false,
        job_closed: true,
        refunded: "0.00",
      });
      await actAs(tx, ADMIN);
      await beforeTheGuard(tx, () => setStatus(tx, d.job.id, "collected"));
      await actAs(tx, ANON);
      const page = await quoteByToken(tx, d.token);
      expect(Object.keys(page!)).toHaveLength(12);
      expect(Object.keys(page!.deposit!).sort()).toEqual([
        "amount",
        "job_closed",
        "parts_ordered",
        "percent",
        "refunded",
        "status",
      ]);
      expect(JSON.stringify(page)).not.toMatch(/70\.00|cost|supplier|email|phone|note/i);

      // An open quote's deposit keeps its three keys.
      await withPercent(tx, 50);
      const q = await quoted(tx);
      expect(Object.keys((await pageDeposit(tx, q.token))!).sort()).toEqual([
        "amount",
        "percent",
        "status",
      ]);
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
          detail: "Stripe received $119.99, not the $120.00 asked. Check the payment in Stripe.",
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

      // A linked refund in another currency is listed once: payment_attention
      // (refund_not_counted), not also stripe_attention (currency_mismatch).
      const u = await answered(tx);
      const pu = await startCheckout(tx, u);
      await payDeposit(tx, pu);
      const usd = await deliver(
        tx,
        "refund.updated",
        refundObject({
          id: `re_${tag()}`,
          paymentIntent: pu.pi,
          amountCents: 1000,
          status: "succeeded",
          currency: "usd",
        }),
      );
      expect(usd).toMatchObject({ event_status: "needs_attention", outcome: "currency_mismatch" });
      const afterUsd = await listed(tx, ADMIN);
      expect(afterUsd.filter((r) => r.entity_id === u.job.id).map((r) => r.kind)).toEqual([
        "payment_attention",
      ]);
      expect(await issuesOf(tx, pu.paymentId)).toEqual(["refund_not_counted"]);
    });
  });

  it("paid_parts_not_fitted reaches Exceptions as payment_attention for admins and managers only", async () => {
    await inTransaction(conn, async (tx) => {
      const d = await answered(tx);
      const p = await startCheckout(tx, d);
      await payDeposit(tx, p);
      await actAs(tx, ADMIN);
      // Collected before 20261014000900's guard, as J-000002 was.
      await beforeTheGuard(tx, () => walkTo(tx, d.job.id, "collected"));
      const forJob = (rows: ExceptionRow[]) => rows.filter((r) => r.entity_id === d.job.id);
      expect(forJob(await listed(tx, ADMIN))).toEqual([
        {
          kind: "payment_attention",
          severity: "danger",
          entity_type: "work_order",
          entity_id: d.job.id,
          title: d.job.job_number,
          detail:
            "$120.00 is held for parts that never went on this job. Cancel them and refund in Stripe, or agree with the customer how it counts.",
          issue: "payment_attention",
        },
      ]);
      expect(forJob(await listed(tx, MANAGER))).toHaveLength(1);
      expect(forJob(await listed(tx, MECHANIC2))).toEqual([]);
      // Counts agree with the list for the admin.
      const rows = await listed(tx, ADMIN);
      const counts = (
        await tx.query<{ kind: string; count: number }>(
          "select kind, count from public.report_exception_counts()",
        )
      ).rows;
      expect(counts.find((c) => c.kind === "payment_attention")?.count ?? 0).toBe(
        rows.filter((r) => r.kind === "payment_attention").length,
      );
      // Cleared by the cancel (D149) and the refund.
      await actAs(tx, ADMIN);
      await cancelPart(tx, d.partId);
      await refundDeposit(tx, p, 12000);
      expect(forJob(await listed(tx, ADMIN))).toEqual([]);
    });
  });

  it("a mismatched refund is listed exactly once: refund_not_counted, or one stripe_attention row when failed, canceled or counted", async () => {
    await inTransaction(conn, async (tx) => {
      const jobRows = async (workOrderId: string) =>
        (await listed(tx, ADMIN))
          .filter((r) => r.entity_id === workOrderId)
          .map((r) => [r.kind, r.detail]);
      const notCounted =
        "Stripe reported a refund of this payment in another currency or mode (test or live), and BICII did not count it. Check it in Stripe.";
      const otherMode =
        "Stripe data from the other mode (test or live) was not applied. Check the Stripe keys.";
      const otherCurrency =
        "Stripe reported a refund in another currency, and BICII did not count it. Check it in Stripe.";

      // 1. A linked refund from the other mode, succeeded: payment_attention
      // lists it (refund_not_counted); stripe_attention does not repeat it.
      const a = await answered(tx);
      const pa = await startCheckout(tx, a);
      await payDeposit(tx, pa);
      const live = await deliver(
        tx,
        "refund.updated",
        refundObject({
          id: `re_${tag()}`,
          paymentIntent: pa.pi,
          amountCents: 1000,
          status: "succeeded",
        }),
        undefined,
        true,
      );
      expect(live).toMatchObject({ event_status: "needs_attention", outcome: "livemode_mismatch" });
      expect(await issuesOf(tx, pa.paymentId)).toEqual(["refund_not_counted"]);
      expect(await jobRows(a.job.id)).toEqual([["payment_attention", notCounted]]);

      // 2. A failed refund in another currency and a canceled one from the
      // other mode: refund_not_counted leaves both out (nothing to count),
      // so each keeps its stripe_attention row and is still listed.
      const b = await answered(tx);
      const pb = await startCheckout(tx, b);
      await payDeposit(tx, pb);
      const failedUsd = await deliver(
        tx,
        "refund.failed",
        refundObject({
          id: `re_${tag()}`,
          paymentIntent: pb.pi,
          amountCents: 1000,
          status: "failed",
          currency: "usd",
          failureReason: "expired_or_canceled_card",
        }),
      );
      expect(failedUsd).toMatchObject({
        event_status: "needs_attention",
        outcome: "currency_mismatch",
      });
      const canceledLive = await deliver(
        tx,
        "refund.updated",
        refundObject({
          id: `re_${tag()}`,
          paymentIntent: pb.pi,
          amountCents: 2000,
          status: "canceled",
        }),
        undefined,
        true,
      );
      expect(canceledLive).toMatchObject({
        event_status: "needs_attention",
        outcome: "livemode_mismatch",
      });
      expect(await issuesOf(tx, pb.paymentId)).toEqual([]);
      expect((await jobRows(b.job.id)).sort()).toEqual(
        [
          ["stripe_attention", otherCurrency],
          ["stripe_attention", otherMode],
        ].sort(),
      );

      // 3. An event from the other mode about a refund stored in the
      // payment's own mode (counted): no refund_not_counted, so
      // stripe_attention keeps the event.
      const c = await answered(tx);
      const pc = await startCheckout(tx, c);
      await payDeposit(tx, pc);
      const rid = `re_${tag()}`;
      await refundDeposit(tx, pc, 1000, "succeeded", rid);
      const replay = await deliver(
        tx,
        "refund.updated",
        refundObject({ id: rid, paymentIntent: pc.pi, amountCents: 1000, status: "succeeded" }),
        undefined,
        true,
      );
      expect(replay).toMatchObject({
        event_status: "needs_attention",
        outcome: "livemode_mismatch",
      });
      expect(await issuesOf(tx, pc.paymentId)).toEqual([]);
      expect(await jobRows(c.job.id)).toEqual([["stripe_attention", otherMode]]);

      // 4. A pending refund in another currency is refund_not_counted's
      // alone; once it fails, refund_not_counted drops it and it comes back
      // as stripe_attention, so it never disappears: one row for its
      // created and failed events and a Check with Stripe read of it.
      const d = await answered(tx);
      const pd = await startCheckout(tx, d);
      await payDeposit(tx, pd);
      const pendingId = `re_${tag()}`;
      const usd = (status: string) =>
        refundObject({
          id: pendingId,
          paymentIntent: pd.pi,
          amountCents: 1000,
          status,
          currency: "usd",
        });
      expect(await deliver(tx, "refund.created", usd("pending"))).toMatchObject({
        event_status: "needs_attention",
        outcome: "currency_mismatch",
      });
      expect(await issuesOf(tx, pd.paymentId)).toEqual(["refund_not_counted"]);
      expect(await jobRows(d.job.id)).toEqual([["payment_attention", notCounted]]);
      expect(await deliver(tx, "refund.failed", usd("failed"))).toMatchObject({
        event_status: "needs_attention",
        outcome: "currency_mismatch",
      });
      expect(await issuesOf(tx, pd.paymentId)).toEqual([]);
      await actAs(tx, SERVICE);
      const { rows: readRows } = await tx.query<{ event_status: string; outcome: string }>(
        `select event_status::text, outcome from public.record_stripe_read($1, $2::jsonb, $3)`,
        [pd.paymentId, JSON.stringify(usd("failed")), `corr-${tag()}`],
      );
      expect(readRows[0]).toMatchObject({
        event_status: "needs_attention",
        outcome: "currency_mismatch",
      });
      expect(
        await readAsOwner(tx, () =>
          scalar(
            tx,
            `select count(*)::int from public.stripe_events
              where object_id = $1 and status = 'needs_attention'`,
            [pendingId],
          ),
        ),
      ).toBe(3);
      expect(await jobRows(d.job.id)).toEqual([["stripe_attention", otherCurrency]]);
    });
  });

  it("one stripe_attention row per Stripe object and outcome: the earliest event in the 30-day window", async () => {
    await inTransaction(conn, async (tx) => {
      const d = await answered(tx);
      const pd = await startCheckout(tx, d);
      await payDeposit(tx, pd);
      const rid = `re_${tag()}`;
      const usd = (status: string) =>
        refundObject({ id: rid, paymentIntent: pd.pi, amountCents: 1000, status, currency: "usd" });
      await deliver(tx, "refund.created", usd("pending"));
      await deliver(tx, "refund.updated", usd("pending"));
      await deliver(tx, "refund.failed", usd("failed"));

      // Spread the three over time (the guard keeps received_at fixed, so
      // as the owner with triggers off): 40 days ago, outside the window;
      // 10 and 2 days ago, inside it.
      await ownerMode(tx);
      await tx.query("set local session_replication_role = replica");
      await tx.query(
        `update public.stripe_events
            set received_at = now() - case event_type
                                        when 'refund.created' then interval '40 days'
                                        when 'refund.updated' then interval '10 days'
                                        else interval '2 days' end
          where object_id = $1`,
        [rid],
      );
      await tx.query("set local session_replication_role = origin");
      const tenDaysAgo = await scalar<Date>(
        tx,
        "select received_at from public.stripe_events where object_id = $1 and event_type = 'refund.updated'",
        [rid],
      );

      // One row, dated from the earliest event still in the window: not the
      // newest (2 days), and not hidden by the one outside the window.
      await actAs(tx, ADMIN);
      const { rows } = await tx.query<{ days: number; since: Date; detail: string }>(
        `select days, since, detail from public.operational_exceptions(200)
          where kind = 'stripe_attention' and entity_id = $1`,
        [d.job.id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].detail).toBe(
        "Stripe reported a refund in another currency, and BICII did not count it. Check it in Stripe.",
      );
      expect(rows[0].days).toBe(10);
      expect(rows[0].since.getTime()).toBe(tenDaysAgo.getTime());
    });
  });
});

// ---------------------------------------------------------------------------
// 9. Concurrency (committed; per-file clone only)
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

  const paidWebhook = (p: Pay) => (tx: pg.Client) =>
    callRecordEvent(
      tx,
      stripeEvent({
        id: `evt_${tag()}`,
        type: "checkout.session.completed",
        object: paidSession(p),
      }),
    );

  const paymentStatus = (paymentId: string) =>
    scalar<string>(conn, "select status::text from public.payments where id = $1", [paymentId]);

  it("two record_deposit_checkout calls for one quote: the second waits on the job, then is existing", async () => {
    const d = await committedDeposit();
    const [a, b] = await inTransaction(
      setupConn,
      async (tx) => [await prepare(tx, d.token), await prepare(tx, d.token)],
      { commit: true },
    );
    const [first, second] = await race(
      setupConn,
      {
        as: SERVICE,
        run: (tx) =>
          callRecordCheckout(tx, a.payment_id!, d.quoteId, openSession(d, a.payment_id!)),
      },
      {
        as: SERVICE,
        run: (tx) =>
          callRecordCheckout(tx, b.payment_id!, d.quoteId, openSession(d, b.payment_id!)),
      },
    );
    expect(first).toMatchObject({ ok: true, value: { outcome: "created" } });
    expect(second).toMatchObject({
      ok: true,
      value: { outcome: "existing", payment_id: a.payment_id },
    });
    expect(
      await scalar<number>(
        conn,
        "select count(*)::int from public.payments where quote_id = $1 and status = 'pending'",
        [d.quoteId],
      ),
    ).toBe(1);
  });

  it("ordering without a reason waits for a paid webhook still applying, then orders (the gate reads under the job lock)", async () => {
    const d = await committedDeposit();
    const p = await inTransaction(setupConn, (tx) => startCheckout(tx, d), { commit: true });
    const [hook, ordered] = await race(
      setupConn,
      { as: SERVICE, run: paidWebhook(p) },
      { as: ADMIN, run: (tx) => orderParts(tx, [d.partId], d.supplierId) },
    );
    expect(hook).toMatchObject({ ok: true, value: { outcome: "payment_paid" } });
    // Had the gate read the deposit before waiting, it would have refused.
    expect(ordered.ok, JSON.stringify(ordered)).toBe(true);
    expect(
      await scalar<string>(
        conn,
        "select status::text from public.job_part_requests where id = $1",
        [d.partId],
      ),
    ).toBe("ordered");
    expect(await paymentStatus(p.paymentId)).toBe("paid");
  });

  it("a paid webhook waits for an override order still holding the job, then records the payment", async () => {
    const d = await committedDeposit();
    const p = await inTransaction(setupConn, (tx) => startCheckout(tx, d), { commit: true });
    const [ordered, hook] = await race(
      setupConn,
      {
        as: ADMIN,
        run: (tx) =>
          orderWithReason(tx, [d.partId], d.supplierId, "Customer is paying at the counter"),
      },
      { as: SERVICE, run: paidWebhook(p) },
    );
    expect(ordered.ok, JSON.stringify(ordered)).toBe(true);
    expect(hook).toMatchObject({ ok: true, value: { outcome: "payment_paid" } });
    const overrides = await readAsOwner(conn, async () =>
      (await partOrdered(conn, d.job.id)).map((e) => e.payload.deposit_override),
    );
    expect(overrides).toHaveLength(1);
    expect(overrides[0]).toMatchObject({ reason: "Customer is paying at the counter" });
    expect(await paymentStatus(p.paymentId)).toBe("paid");
  });

  it("record_deposit_checkout and cancelling the part wait on the job lock, in either order", async () => {
    for (const recordFirst of [true, false]) {
      const d = await committedDeposit();
      const prep = await inTransaction(setupConn, (tx) => prepare(tx, d.token), { commit: true });
      const record = {
        as: SERVICE,
        run: (tx: pg.Client) =>
          callRecordCheckout(tx, prep.payment_id!, d.quoteId, openSession(d, prep.payment_id!)),
      };
      const cancel = { as: ADMIN, run: (tx: pg.Client) => cancelPart(tx, d.partId) };
      if (recordFirst) {
        const [rec, cancelled] = await race(setupConn, record, cancel);
        expect(rec).toMatchObject({ ok: true, value: { outcome: "created" } });
        expect(cancelled.ok, JSON.stringify(cancelled)).toBe(true);
      } else {
        const [cancelled, rec] = await race(setupConn, cancel, record);
        expect(cancelled.ok, JSON.stringify(cancelled)).toBe(true);
        expect(rec).toMatchObject({ ok: false, error: p0001("deposit_parts_cancelled") });
      }
    }
  });
});
