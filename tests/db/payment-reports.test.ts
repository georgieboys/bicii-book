/**
 * Payment reports, Phase 14 step 3 (PLAN D154 and its build defaults
 * D154a-e; ADR-025; DATA-MODEL §14, §15, §16): customer money on Reports,
 * apart from the sales figures and not driven by the date basis.
 *
 *   reporting.payment_movements  one row per movement of customer money:
 *                       online_payment (Stripe's paid_at, the paid group,
 *                       coalesce(amount_received, amount)), online_refund
 *                       (coalesce(stripe_created_at, created_at), counted
 *                       by payment_refund_total's rule, matched refunds of
 *                       paid-group payments only), counter_payment
 *                       (received_at; a recorded_in_error void removes it)
 *                       and counter_given_back (voided_at, negative). No
 *                       API role reads it.
 *   report_payment_summary, report_payment_items  a period of shop days
 *                       (half open), view_financial_reports.
 *   report_payments_held  NOW: open (net_paid), awaiting_collection
 *                       (least(net_paid, job_total)) and above_bill
 *                       (held_over_total), from work_order_payment_totals.
 *
 * Most cases build their own records on isolated past shop days
 * (TEST_DAY), Stripe payments dated by the event's created time and
 * refunds by the refund's, counter rows and voids inserted as the owner at
 * chosen instants (the reports read the tables, whoever wrote them). The
 * identity case uses the real RPCs too (record_counter_payment,
 * void_counter_payment, a balance link paid by Checkout). Building jobs
 * takes J- numbers, so those cases skip in existing-database mode; the
 * access and catalogue checks run everywhere. Every test rolls back.
 */
import { createHash, randomUUID } from "node:crypto";

import type pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { STAFF } from "../fixtures/ids";
import { refundObject, stripeEvent, stripeWebhookHeaders } from "../fixtures/stripe";
import { customerClaims, linkCustomerLogin } from "./customer-fixtures";
import { actAs, connect, inTransaction, isolatedDatabase, scalar, type Claims } from "./harness";
import { ADMIN, MANAGER, MECHANIC1, MECHANIC2, readAsOwner } from "./inventory-fixtures";
import {
  ANON,
  SERVICE,
  answered,
  paidSession,
  pay,
  recordCounter,
  sendLink,
  startBalanceCheckout,
  startDepositCheckout,
  tag,
  voidCounter,
  type Pay,
} from "./payment-fixtures";
import {
  TEST_DAY,
  addDays,
  completedPath,
  insertJob,
  money,
  sgt,
  shopToday,
  type JobStep,
} from "./reporting-fixtures";
import { failsWith, makeCustomer, ownerMode } from "./workshop-fixtures";

let conn: pg.Client;

beforeAll(async () => {
  conn = await connect();
});

const isolated = isolatedDatabase();
const DENIED = { code: "42501" };

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// The documented columns
// ---------------------------------------------------------------------------

const MOVEMENT_COLUMNS = [
  "at",
  "id",
  "movement",
  "work_order_id",
  "kind",
  "method",
  "amount",
  "signed_amount",
  "currency",
  "other_currency",
  "recorded_at",
  "recorded_by",
];

const SUMMARY_COLUMNS = [
  "currency",
  "online_count",
  "online_total",
  "deposit_online_total",
  "balance_online_total",
  "refund_count",
  "refund_total",
  "counter_count",
  "counter_total",
  "given_back_count",
  "given_back_total",
  "net_total",
  "other_currency_count",
];

const ITEM_COLUMNS = [
  "at",
  "id",
  "movement",
  "work_order_id",
  "job_number",
  "customer_label",
  "kind",
  "method",
  "amount",
  "signed_amount",
  "currency",
  "other_currency",
  "recorded_at",
  "recorded_by_name",
];

const HELD_COLUMNS = [
  "grp",
  "work_order_id",
  "job_number",
  "status",
  "customer_label",
  "amount",
  "net_paid",
  "net_paid_online",
  "paid_at_counter",
  "job_total",
  "balance_due",
  "paid_ahead",
  "currency",
];

const SIGNATURES = [
  "public.report_payment_summary(date, date)",
  "public.report_payment_items(date, date, integer, timestamptz, uuid)",
  "public.report_payments_held()",
];

const CALLS = [
  "select * from public.report_payment_summary('2025-03-03', '2025-03-09')",
  "select * from public.report_payment_items('2025-03-03', '2025-03-09')",
  "select * from public.report_payments_held()",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const unix = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const sha256hex = (raw: string) => createHash("sha256").update(raw, "utf8").digest("hex");

/** A verified webhook as the service role, with the event's created time and mode under control. */
async function deliverAt(
  tx: pg.Client,
  type: string,
  object: Record<string, unknown>,
  { created, livemode = false }: { created?: number; livemode?: boolean } = {},
): Promise<{ event_status: string; outcome: string | null }> {
  await actAs(tx, SERVICE);
  const raw = JSON.stringify(stripeEvent({ id: `evt_${tag()}`, type, object, created, livemode }));
  const { rows } = await tx.query<{ event_status: string; outcome: string | null }>(
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

const paymentStatus = (tx: pg.Client, id: string) =>
  readAsOwner(tx, () =>
    scalar<string>(tx, "select status::text from public.payments where id = $1", [id]),
  );

/** A pending Stripe payment inserted as the owner (the guard allows a pending insert). */
async function pendingOnline(tx: pg.Client, workOrderId: string, amount: string): Promise<Pay> {
  await ownerMode(tx);
  const id = randomUUID();
  const sessionId = `cs_test_${tag()}`;
  await tx.query(
    `insert into public.payments
       (id, work_order_id, quote_id, kind, amount, stripe_checkout_session_id,
        stripe_session_expires_at, livemode)
     values ($1, $2, null, 'balance', $3, $4, clock_timestamp() + interval '1 hour', false)`,
    [id, workOrderId, amount, sessionId],
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

/** Stripe reports `p` paid at `paidAt` (the event's created time is Stripe's paid_at, D159d). */
async function paidAt(
  tx: pg.Client,
  p: Pay,
  at: string,
  o: { currency?: string; amountCents?: number } = {},
): Promise<Pay> {
  await deliverAt(tx, "checkout.session.completed", paidSession(p, o), { created: unix(at) });
  expect(await paymentStatus(tx, p.paymentId)).toBe("paid");
  return p;
}

/** A balance payment on the job, paid at `at`. */
const online = async (
  tx: pg.Client,
  workOrderId: string,
  amount: string,
  at: string,
  o: { currency?: string } = {},
) => paidAt(tx, await pendingOnline(tx, workOrderId, amount), at, o);

/** A Stripe refund of `p` (refund.created = `created`; null: Stripe sent no created). */
async function refundAt(
  tx: pg.Client,
  p: Pay,
  {
    cents,
    created,
    status = "succeeded",
    currency = "sgd",
    livemode = false,
    id = `re_${tag()}`,
    paymentIntent = p.pi,
  }: {
    cents: number;
    created: string | null;
    status?: string;
    currency?: string;
    livemode?: boolean;
    id?: string;
    paymentIntent?: string;
  },
): Promise<string> {
  const obj = refundObject({
    id,
    paymentIntent,
    amountCents: cents,
    status,
    currency,
    created: created === null ? undefined : unix(created),
  });
  if (created === null) delete obj.created;
  await deliverAt(tx, "refund.updated", obj, { livemode });
  return id;
}

/**
 * A counter payment inserted as the owner at a chosen received_at (and
 * created_at), outside record_counter_payment's time bounds; the guard
 * allows inserts. Returns its id.
 */
async function counterAt(
  tx: pg.Client,
  workOrderId: string,
  {
    amount,
    receivedAt,
    createdAt = null,
    method = "cash",
    id = randomUUID(),
    recordedBy = STAFF.admin,
  }: {
    amount: string;
    receivedAt: string;
    createdAt?: string | null;
    method?: string;
    id?: string;
    recordedBy?: string;
  },
): Promise<string> {
  await ownerMode(tx);
  await tx.query(
    `insert into public.counter_payments
       (id, work_order_id, quote_id, kind, amount, method, received_at, request_fingerprint,
        recorded_by, created_at)
     values ($1, $2, null, 'balance', $3, $4::public.counter_payment_method, $5, 'test', $6,
             coalesce($7::timestamptz, clock_timestamp()))`,
    [id, workOrderId, amount, method, receivedAt, recordedBy, createdAt],
  );
  return id;
}

/** A void of a counter payment inserted as the owner at a chosen voided_at. */
async function voidAt(
  tx: pg.Client,
  counterId: string,
  kind: "recorded_in_error" | "given_back",
  voidedAt: string,
  voidedBy: string = STAFF.admin,
): Promise<void> {
  await ownerMode(tx);
  await tx.query(
    `insert into public.counter_payment_voids (counter_payment_id, kind, reason, voided_by, voided_at)
     values ($1, $2::public.counter_void_kind, 'Test void', $3, $4)`,
    [counterId, kind, voidedBy, voidedAt],
  );
}

type JobStatus =
  "received" | "in_progress" | "completed" | "ready_for_collection" | "collected" | "cancelled";

/** A job checked in on `day` 08:00 with one manual line of `total` (none when null), walked to `status`. */
async function pastJob(
  tx: pg.Client,
  day: string,
  { total = null, status = "received" }: { total?: string | null; status?: JobStatus } = {},
): Promise<{ id: string; job_number: string; customer_id: string; status: string }> {
  const path: JobStep[] = [];
  if (status === "in_progress") path.push({ status: "in_progress", at: sgt(day, "08:20") });
  if (status === "completed" || status === "ready_for_collection" || status === "collected")
    path.push(...completedPath(sgt(day, "08:20"), sgt(day, "08:30")));
  if (status === "ready_for_collection" || status === "collected")
    path.push({ status: "ready_for_collection", at: sgt(day, "08:40") });
  if (status === "collected") path.push({ status: "collected", at: sgt(day, "08:50") });
  if (status === "cancelled") path.push({ status: "cancelled", at: sgt(day, "08:20") });
  const { job } = await insertJob(tx, {
    checkedInAt: sgt(day, "08:00"),
    lines: total
      ? [{ type: "manual", unitSale: total, unitCost: "0.00", createdAt: sgt(day, "08:10") }]
      : [],
    path,
  });
  return job;
}

const MONEY_KEYS = new Set([
  "online_total",
  "deposit_online_total",
  "balance_online_total",
  "refund_total",
  "counter_total",
  "given_back_total",
  "net_total",
  "amount",
  "signed_amount",
  "net_paid",
  "net_paid_online",
  "paid_at_counter",
  "job_total",
  "balance_due",
  "paid_ahead",
]);

/** A row with every money column as a fixed-2 string (null stays null). */
function norm(row: Row): Row {
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => [k, MONEY_KEYS.has(k) ? money(v) : v]),
  );
}

async function summary(tx: pg.Client, from: string, to: string, as: Claims = ADMIN) {
  await actAs(tx, as);
  const { rows } = await tx.query(
    "select * from public.report_payment_summary($1::date, $2::date)",
    [from, to],
  );
  expect(rows).toHaveLength(1);
  return norm(rows[0] as Row);
}

async function items(
  tx: pg.Client,
  from: string,
  to: string,
  o: { max?: number | null; afterAt?: Date | string | null; afterId?: string | null } = {},
) {
  await actAs(tx, ADMIN);
  const { rows } = await tx.query(
    "select * from public.report_payment_items($1::date, $2::date, $3, $4, $5)",
    [from, to, o.max === undefined ? 1000 : o.max, o.afterAt ?? null, o.afterId ?? null],
  );
  return (rows as Row[]).map(norm);
}

/** Every item of the range, page by page (`size` rows a page). */
async function allItems(tx: pg.Client, from: string, to: string, size = 1000) {
  const out: Row[] = [];
  let afterAt: Date | null = null;
  let afterId: string | null = null;
  for (;;) {
    const page = await items(tx, from, to, { max: size, afterAt, afterId });
    out.push(...page);
    if (page.length < size) return out;
    afterAt = page[page.length - 1].at as Date;
    afterId = page[page.length - 1].id as string;
  }
}

async function held(tx: pg.Client, as: Claims = ADMIN) {
  await actAs(tx, as);
  const { rows } = await tx.query("select * from public.report_payments_held()");
  return (rows as Row[]).map(norm);
}

/** The job card's figures (work_order_payment_totals, read as the owner). */
const card = (tx: pg.Client, workOrderId: string) =>
  readAsOwner(tx, async () => {
    const { rows } = await tx.query(
      `select net_paid, net_paid_online, paid_at_counter, job_total, balance_due, paid_ahead,
              held_over_total
         from public.work_order_payment_totals where work_order_id = $1`,
      [workOrderId],
    );
    return norm({ ...(rows[0] as Row), held_over_total: money((rows[0] as Row).held_over_total) });
  });

const displayName = (tx: pg.Client, staffId: string) =>
  readAsOwner(tx, () =>
    scalar<string>(tx, "select display_name::text from public.staff where id = $1", [staffId]),
  );

/** The summary's figures without the currency, money as fixed-2 strings. */
const figures = (s: Row) => ({
  online: [s.online_count, s.online_total],
  deposit: s.deposit_online_total,
  balance: s.balance_online_total,
  refund: [s.refund_count, s.refund_total],
  counter: [s.counter_count, s.counter_total],
  givenBack: [s.given_back_count, s.given_back_total],
  net: s.net_total,
  other: s.other_currency_count,
});

const EMPTY = {
  online: [0, "0.00"],
  deposit: "0.00",
  balance: "0.00",
  refund: [0, "0.00"],
  counter: [0, "0.00"],
  givenBack: [0, "0.00"],
  net: "0.00",
  other: 0,
};

// ---------------------------------------------------------------------------
// 1. Who can reach them (D154d)
// ---------------------------------------------------------------------------

describe("Who can reach the payment reports (D154d, DATA-MODEL §15)", () => {
  it("the RPCs are security definer, pin search_path, return no float, and only authenticated executes them", async () => {
    for (const sig of SIGNATURES) {
      const { rows } = await conn.query<{
        secdef: boolean;
        config: string[] | null;
        floats: number;
      }>(
        `select p.prosecdef as secdef, p.proconfig as config,
                (select count(*)::int from unnest(coalesce(p.proallargtypes, p.proargtypes::oid[])) t(oid)
                  where t.oid in ('float4'::regtype, 'float8'::regtype)) as floats
           from pg_proc p where p.oid = $1::regprocedure`,
        [sig],
      );
      expect({ sig, ...rows[0] }).toEqual({
        sig,
        secdef: true,
        config: ['search_path=""'],
        floats: 0,
      });
      for (const [role, ok] of [
        ["anon", false],
        ["authenticated", true],
        ["service_role", false],
        ["public", false],
      ] as const) {
        const can =
          role === "public"
            ? await scalar<boolean>(
                conn,
                `select exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                    where p.oid = $1::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE')`,
                [sig],
              )
            : await scalar<boolean>(conn, "select has_function_privilege($1, $2, 'EXECUTE')", [
                role,
                sig,
              ]);
        expect({ sig, role, can }).toEqual({ sig, role, can: ok });
      }
    }
  });

  it("reporting.payment_movements is a security-invoker view no API role can read", async () => {
    const { rows } = await conn.query<{ relkind: string; options: string[] | null }>(
      `select c.relkind::text as relkind, c.reloptions as options
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'reporting' and c.relname = 'payment_movements'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].relkind).toBe("v");
    expect(rows[0].options).toEqual(expect.arrayContaining(["security_invoker=true"]));
    for (const role of ["anon", "authenticated", "service_role"]) {
      expect(
        await scalar<boolean>(
          conn,
          "select has_any_column_privilege($1, 'reporting.payment_movements', 'SELECT')",
          [role],
        ),
      ).toBe(false);
    }
    await inTransaction(conn, async (tx) => {
      for (const claims of [ANON, ADMIN, MANAGER, MECHANIC1, SERVICE]) {
        await ownerMode(tx);
        await actAs(tx, claims);
        await failsWith(
          tx,
          () => tx.query("select * from reporting.payment_movements limit 1"),
          DENIED,
        );
      }
      await ownerMode(tx);
      const cols = await tx.query("select * from reporting.payment_movements limit 0");
      expect(cols.fields.map((f) => f.name)).toEqual(MOVEMENT_COLUMNS);
    });
  });

  it("admins and managers read all three, with the documented columns", async () => {
    await inTransaction(conn, async (tx) => {
      for (const claims of [ADMIN, MANAGER]) {
        await actAs(tx, claims);
        // One query at a time on one client (pg@9 drops queued queries).
        const s = await tx.query(CALLS[0]);
        const i = await tx.query(CALLS[1]);
        const h = await tx.query(CALLS[2]);
        expect(s.fields.map((f) => f.name)).toEqual(SUMMARY_COLUMNS);
        expect(s.rows).toHaveLength(1);
        expect(i.fields.map((f) => f.name)).toEqual(ITEM_COLUMNS);
        expect(h.fields.map((f) => f.name)).toEqual(HELD_COLUMNS);
      }
    });
  });

  it("mechanic2 (no permissions), mechanic1 (view_costs only), a customer, anon and inactive staff get 42501", async () => {
    await inTransaction(conn, async (tx) => {
      for (const claims of [MECHANIC2, MECHANIC1, ANON]) {
        await ownerMode(tx);
        await actAs(tx, claims);
        for (const sql of CALLS) await failsWith(tx, () => tx.query(sql), DENIED);
      }
      await ownerMode(tx);
      const authUserId = await linkCustomerLogin(tx, await makeCustomer(tx));
      await actAs(tx, customerClaims(authUserId));
      for (const sql of CALLS) await failsWith(tx, () => tx.query(sql), DENIED);
      await ownerMode(tx);
      await tx.query("update public.staff set active = false where id = $1", [STAFF.manager]);
      await actAs(tx, MANAGER);
      for (const sql of CALLS) await failsWith(tx, () => tx.query(sql), DENIED);
    });
  });

  it("the permission, not the role: a mechanic granted view_financial_reports reads them", async () => {
    await inTransaction(conn, async (tx) => {
      await tx.query(
        "insert into public.staff_permissions (staff_id, permission) values ($1, 'view_financial_reports')",
        [STAFF.mechanic2],
      );
      await actAs(tx, MECHANIC2);
      for (const sql of CALLS) await tx.query(sql);
    });
  });

  it("the period RPCs check the range first: report_range_invalid, report_range_too_long", async () => {
    await inTransaction(conn, async (tx) => {
      await actAs(tx, ADMIN);
      for (const fn of ["report_payment_summary", "report_payment_items"]) {
        await failsWith(tx, () => tx.query(`select * from public.${fn}(null, '2025-03-09')`), {
          code: "P0001",
          message: "report_range_invalid",
        });
        await failsWith(
          tx,
          () => tx.query(`select * from public.${fn}('2025-03-10', '2025-03-09')`),
          { code: "P0001", message: "report_range_invalid" },
        );
        await failsWith(
          tx,
          () => tx.query(`select * from public.${fn}('2025-01-01', '2027-01-02')`),
          { code: "P0001", message: "report_range_too_long" },
        );
        await tx.query(`select * from public.${fn}('2025-01-01', '2027-01-01')`);
      }
      // The permission comes before the range.
      await actAs(tx, MECHANIC2);
      await failsWith(
        tx,
        () => tx.query("select * from public.report_payment_summary(null, null)"),
        DENIED,
      );
    });
  });

  it("items refuse half a cursor (report_key_invalid)", async () => {
    await inTransaction(conn, async (tx) => {
      await actAs(tx, ADMIN);
      for (const [at, id] of [
        ["2025-03-05T00:00:00Z", null],
        [null, randomUUID()],
      ]) {
        await failsWith(
          tx,
          () =>
            tx.query(
              "select * from public.report_payment_items('2025-03-03', '2025-03-09', 10, $1, $2)",
              [at, id],
            ),
          { code: "P0001", message: "report_key_invalid" },
        );
      }
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Dates and amounts (D154b)
// ---------------------------------------------------------------------------

describe.skipIf(!isolated)("What moved, and on which shop day (D154b)", () => {
  it("an online payment counts on Stripe's paid_at shop day, half open at both edges", async () => {
    await inTransaction(conn, async (tx) => {
      const D = TEST_DAY(410);
      const job = await pastJob(tx, addDays(D, -2));
      await online(tx, job.id, "11.00", sgt(addDays(D, -1), "23:59:59"));
      await online(tx, job.id, "13.00", sgt(D, "00:00:00"));
      await online(tx, job.id, "17.00", sgt(D, "23:59:59"));
      await online(tx, job.id, "19.00", sgt(addDays(D, 1), "00:00:00"));
      expect(figures(await summary(tx, D, D))).toMatchObject({
        online: [2, "30.00"],
        balance: "30.00",
        net: "30.00",
      });
      expect(figures(await summary(tx, addDays(D, -1), addDays(D, -1))).online).toEqual([
        1,
        "11.00",
      ]);
      expect(figures(await summary(tx, addDays(D, 1), addDays(D, 1))).online).toEqual([1, "19.00"]);
      expect(figures(await summary(tx, addDays(D, -1), addDays(D, 1))).online).toEqual([
        4,
        "60.00",
      ]);
      // Items carry Stripe's instant and no recorder.
      const rows = await items(tx, D, D);
      expect(
        rows.map((r) => [r.movement, r.amount, r.method, r.recorded_at, r.recorded_by_name]),
      ).toEqual([
        ["online_payment", "17.00", "stripe", null, null],
        ["online_payment", "13.00", "stripe", null, null],
      ]);
      expect((rows[0].at as Date).toISOString()).toBe(new Date(sgt(D, "23:59:59")).toISOString());
    });
  });

  it("a counter payment counts on its received_at shop day, to the microsecond", async () => {
    await inTransaction(conn, async (tx) => {
      const D = TEST_DAY(420);
      const job = await pastJob(tx, addDays(D, -2));
      await counterAt(tx, job.id, {
        amount: "5.00",
        receivedAt: `${addDays(D, -1)}T23:59:59.999999+08:00`,
      });
      await counterAt(tx, job.id, { amount: "7.00", receivedAt: `${D}T00:00:00.000000+08:00` });
      await counterAt(tx, job.id, { amount: "9.00", receivedAt: `${D}T23:59:59.999999+08:00` });
      await counterAt(tx, job.id, {
        amount: "3.00",
        receivedAt: `${addDays(D, 1)}T00:00:00.000000+08:00`,
      });
      expect(figures(await summary(tx, D, D))).toEqual({
        ...EMPTY,
        counter: [2, "16.00"],
        net: "16.00",
      });
      expect(figures(await summary(tx, addDays(D, -1), addDays(D, 1))).counter).toEqual([
        4,
        "24.00",
      ]);
    });
  });

  it("only the paid group moves money: pending, processing, expired and failed payments are not movements", async () => {
    await inTransaction(conn, async (tx) => {
      const D = TEST_DAY(430);
      const at = unix(sgt(D, "10:00"));
      const job = await pastJob(tx, addDays(D, -1));
      await pendingOnline(tx, job.id, "21.00");
      const processing = await pendingOnline(tx, job.id, "22.00");
      await deliverAt(
        tx,
        "checkout.session.completed",
        paidSession(processing, { paymentStatus: "unpaid", status: "complete" }),
        { created: at },
      );
      const expired = await pendingOnline(tx, job.id, "23.00");
      await deliverAt(
        tx,
        "checkout.session.expired",
        paidSession(expired, { status: "expired", paymentStatus: "unpaid", paymentIntent: null }),
        { created: at },
      );
      const failed = await pendingOnline(tx, job.id, "24.00");
      await deliverAt(
        tx,
        "checkout.session.completed",
        paidSession(failed, { paymentStatus: "unpaid", status: "complete" }),
        { created: at },
      );
      await deliverAt(
        tx,
        "checkout.session.async_payment_failed",
        paidSession(failed, { paymentStatus: "unpaid", status: "complete" }),
        { created: at },
      );
      expect(await paymentStatus(tx, processing.paymentId)).toBe("pending");
      expect(await paymentStatus(tx, expired.paymentId)).toBe("expired");
      expect(await paymentStatus(tx, failed.paymentId)).toBe("failed");
      // A succeeded refund on the failed payment's PaymentIntent is matched
      // to it but not counted: the payment is not in the paid group.
      await refundAt(tx, failed, { cents: 300, created: sgt(D, "11:00") });
      expect(figures(await summary(tx, addDays(D, -1), addDays(D, 1)))).toEqual(EMPTY);
      expect(await items(tx, addDays(D, -1), addDays(D, 1))).toEqual([]);
    });
  });

  it("a refund counts by payment_refund_total's rule, on refund.created's shop day", async () => {
    await inTransaction(conn, async (tx) => {
      const R = TEST_DAY(440);
      const job = await pastJob(tx, addDays(R, -1));
      const p = await online(tx, job.id, "200.00", sgt(R, "10:00"));
      await refundAt(tx, p, { cents: 3000, created: sgt(R, "11:00") }); // counted
      await refundAt(tx, p, { cents: 1000, created: sgt(R, "11:10"), status: "pending" });
      const failing = await refundAt(tx, p, { cents: 2000, created: sgt(R, "11:20") });
      await refundAt(tx, p, { cents: 500, created: sgt(R, "11:30"), currency: "usd" });
      await refundAt(tx, p, { cents: 700, created: sgt(R, "11:40"), livemode: true });
      await refundAt(tx, p, { cents: 400, created: sgt(addDays(R, 1), "09:00") }); // next day
      // Another payment intent: unmatched (admins only), never BICII's money.
      await refundAt(tx, p, {
        cents: 900,
        created: sgt(R, "11:50"),
        paymentIntent: `pi_${tag()}`,
      });
      expect(figures(await summary(tx, R, R))).toMatchObject({
        online: [1, "200.00"],
        refund: [2, "50.00"],
        net: "150.00",
      });
      // The refund that fails after succeeding leaves its day (D101 restates).
      await refundAt(tx, p, {
        cents: 2000,
        created: sgt(R, "11:20"),
        status: "failed",
        id: failing,
      });
      expect(figures(await summary(tx, R, R))).toMatchObject({
        refund: [1, "30.00"],
        net: "170.00",
      });
      expect(figures(await summary(tx, addDays(R, 1), addDays(R, 1)))).toEqual({
        ...EMPTY,
        refund: [1, "4.00"],
        net: "-4.00",
      });
      const rows = await items(tx, R, addDays(R, 1));
      expect(rows.map((r) => [r.movement, r.amount, r.signed_amount, r.kind])).toEqual([
        ["online_refund", "4.00", "-4.00", "balance"],
        ["online_refund", "30.00", "-30.00", "balance"],
        ["online_payment", "200.00", "200.00", "balance"],
      ]);
      // The refund movements of a payment add up to its refunded_amount.
      expect(
        await readAsOwner(tx, () =>
          scalar<string>(tx, "select refunded_amount::text from public.payments where id = $1", [
            p.paymentId,
          ]),
        ),
      ).toBe("34.00");
    });
  });

  it("a refund Stripe sent without created is dated by its created_at; one with created never by created_at", async () => {
    await inTransaction(conn, async (tx) => {
      const R = TEST_DAY(450);
      const today = await shopToday(tx);
      const job = await pastJob(tx, addDays(R, -1));
      const p = await online(tx, job.id, "100.00", sgt(R, "10:00"));
      const before = figures(await summary(tx, today, today));
      const noDate = await refundAt(tx, p, { cents: 600, created: null });
      await refundAt(tx, p, { cents: 800, created: sgt(R, "12:00") });
      const { stripeCreated, createdDay } = await readAsOwner(tx, async () => {
        const { rows } = await tx.query<{ stripeCreated: Date | null; createdDay: string }>(
          `select stripe_created_at as "stripeCreated",
                  to_char(private.shop_day(created_at), 'YYYY-MM-DD') as "createdDay"
             from public.payment_refunds where stripe_refund_id = $1`,
          [noDate],
        );
        return rows[0];
      });
      expect(stripeCreated).toBeNull();
      expect(createdDay).toBe(today);
      // Today gains the undated refund only (created_at today, no Stripe date);
      // the dated one counts on its Stripe day although it was recorded today.
      const after = figures(await summary(tx, today, today));
      expect(after.refund).toEqual([
        (before.refund[0] as number) + 1,
        money(Number(before.refund[1]) + 6),
      ]);
      expect(figures(await summary(tx, R, R))).toMatchObject({
        online: [1, "100.00"],
        refund: [1, "8.00"],
        net: "92.00",
      });
      const todays = (await items(tx, today, today)).filter((r) => r.work_order_id === job.id);
      expect(todays.map((r) => [r.movement, r.amount])).toEqual([["online_refund", "6.00"]]);
    });
  });

  it("voids: recorded_in_error removes the payment from its day; given_back keeps it and adds a negative movement on the void's day", async () => {
    await inTransaction(conn, async (tx) => {
      const V = TEST_DAY(460);
      const job = await pastJob(tx, addDays(V, -1));
      const live = await counterAt(tx, job.id, { amount: "100.00", receivedAt: sgt(V, "10:00") });
      const error = await counterAt(tx, job.id, {
        amount: "40.00",
        receivedAt: sgt(V, "11:00"),
        method: "card",
      });
      const back = await counterAt(tx, job.id, {
        amount: "60.00",
        receivedAt: sgt(V, "12:00"),
        method: "paynow",
      });
      expect(figures(await summary(tx, V, V))).toEqual({
        ...EMPTY,
        counter: [3, "200.00"],
        net: "200.00",
      });
      await voidAt(tx, error, "recorded_in_error", sgt(addDays(V, 2), "09:00"));
      await voidAt(tx, back, "given_back", sgt(addDays(V, 3), "15:00"), STAFF.manager);
      // The day of receipt restates for the error only.
      expect(figures(await summary(tx, V, V))).toEqual({
        ...EMPTY,
        counter: [2, "160.00"],
        net: "160.00",
      });
      expect(figures(await summary(tx, addDays(V, 2), addDays(V, 2)))).toEqual(EMPTY);
      expect(figures(await summary(tx, addDays(V, 3), addDays(V, 3)))).toEqual({
        ...EMPTY,
        givenBack: [1, "60.00"],
        net: "-60.00",
      });
      expect(figures(await summary(tx, V, addDays(V, 3)))).toEqual({
        ...EMPTY,
        counter: [2, "160.00"],
        givenBack: [1, "60.00"],
        net: "100.00",
      });
      const rows = await items(tx, V, addDays(V, 3));
      expect(rows.map((r) => [r.movement, r.id, r.method, r.amount, r.signed_amount])).toEqual([
        ["counter_given_back", back, "paynow", "60.00", "-60.00"],
        ["counter_payment", back, "paynow", "60.00", "60.00"],
        ["counter_payment", live, "cash", "100.00", "100.00"],
      ]);
      expect(rows.some((r) => r.id === error)).toBe(false);
      // Both count nowhere on the job card any more.
      expect((await card(tx, job.id)).paid_at_counter).toBe("100.00");
    });
  });

  it("a give-back stamped before the payment it reverses (received_at may be 5 minutes ahead) counts on the payment's day, just after it", async () => {
    await inTransaction(conn, async (tx) => {
      const D = TEST_DAY(465);
      const next = addDays(D, 1);
      const job = await pastJob(tx, addDays(D, -1));
      const id = await counterAt(tx, job.id, { amount: "50.00", receivedAt: sgt(next, "00:01") });
      await voidAt(tx, id, "given_back", sgt(D, "23:58"));
      // Day D shows no money handed back that it never received.
      expect(figures(await summary(tx, D, D))).toEqual(EMPTY);
      expect(figures(await summary(tx, next, next))).toEqual({
        ...EMPTY,
        counter: [1, "50.00"],
        givenBack: [1, "50.00"],
        net: "0.00",
      });
      // The give-back is dated one microsecond after the payment, so (at, id)
      // stays a unique keyset; its recorded_at keeps the void's own time.
      const page = async (afterAt: string | null, afterId: string | null) => {
        await actAs(tx, ADMIN);
        const { rows } = await tx.query<{
          at: string;
          id: string;
          movement: string;
          recorded_at: string;
        }>(
          `select to_char("at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') as "at", id, movement,
                  to_char(recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') as recorded_at
             from public.report_payment_items($1::date, $2::date, 1, $3::timestamptz, $4)`,
          [next, next, afterAt === null ? null : `${afterAt}Z`, afterId],
        );
        return rows;
      };
      // UTC to the millisecond, without the zone: the microseconds follow.
      const utc = (s: string) => new Date(s).toISOString().slice(0, -1);
      const first = await page(null, null);
      expect(first).toEqual([
        {
          at: `${utc(sgt(next, "00:01"))}001`,
          id,
          movement: "counter_given_back",
          recorded_at: `${utc(sgt(D, "23:58"))}000`,
        },
      ]);
      const second = await page(first[0].at, first[0].id);
      expect(second).toEqual([
        {
          at: `${utc(sgt(next, "00:01"))}000`,
          id,
          movement: "counter_payment",
          recorded_at: expect.any(String),
        },
      ]);
      expect(await page(second[0].at, second[0].id)).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// 3. The summary (D154e)
// ---------------------------------------------------------------------------

describe.skipIf(!isolated)("report_payment_summary (D154e)", () => {
  it("counts and totals by kind and method, net taken, and Stripe payments in another currency", async () => {
    await inTransaction(conn, async (tx) => {
      const S = TEST_DAY(470);
      const at = (t: string) => sgt(S, t);
      // A deposit through the real Checkout RPCs, paid on S.
      const d = await answered(tx);
      const deposit = await startDepositCheckout(tx, d);
      await paidAt(tx, deposit, at("09:00"));
      const job = await pastJob(tx, addDays(S, -1));
      const balance = await online(tx, job.id, "80.00", at("10:00"));
      // Stripe took another currency: amount_received is null, the amount
      // asked counts (as on the job card), and it is flagged.
      const usd = await online(tx, job.id, "50.00", at("11:00"), { currency: "usd" });
      expect(
        await readAsOwner(tx, () =>
          scalar<string | null>(
            tx,
            "select amount_received::text from public.payments where id = $1",
            [usd.paymentId],
          ),
        ),
      ).toBeNull();
      await refundAt(tx, balance, { cents: 2000, created: at("12:00") });
      await counterAt(tx, job.id, { amount: "30.00", receivedAt: at("13:00"), method: "card" });
      const back = await counterAt(tx, job.id, {
        amount: "15.00",
        receivedAt: at("14:00"),
        method: "paynow",
      });
      await voidAt(tx, back, "given_back", at("15:00"));

      const s = await summary(tx, S, S);
      expect(s.currency).toBe("SGD");
      expect(figures(s)).toEqual({
        online: [3, "250.00"],
        deposit: "120.00",
        balance: "130.00",
        refund: [1, "20.00"],
        counter: [2, "45.00"],
        givenBack: [1, "15.00"],
        net: "260.00",
        other: 1,
      });
      // net_total = online - refunds + counter - given back.
      expect(
        money(
          Number(s.online_total) -
            Number(s.refund_total) +
            Number(s.counter_total) -
            Number(s.given_back_total),
        ),
      ).toBe(s.net_total);
      const rows = await items(tx, S, S);
      expect(rows.map((r) => [r.movement, r.kind, r.method, r.amount, r.other_currency])).toEqual([
        ["counter_given_back", "balance", "paynow", "15.00", false],
        ["counter_payment", "balance", "paynow", "15.00", false],
        ["counter_payment", "balance", "card", "30.00", false],
        ["online_refund", "balance", "stripe", "20.00", false],
        ["online_payment", "balance", "stripe", "50.00", true],
        ["online_payment", "balance", "stripe", "80.00", false],
        ["online_payment", "deposit", "stripe", "120.00", false],
      ]);
      // The item count is the summary's (the export's integrity check).
      expect(rows.length).toBe(
        (s.online_count as number) +
          (s.refund_count as number) +
          (s.counter_count as number) +
          (s.given_back_count as number),
      );
      // A manager reads the same row.
      expect(await summary(tx, S, S, MANAGER)).toEqual(s);
      // A day with nothing reads zeros.
      expect(figures(await summary(tx, addDays(S, 5), addDays(S, 5)))).toEqual(EMPTY);
    });
  });
});

// ---------------------------------------------------------------------------
// 4. The identity with the job card (D154b, C5)
// ---------------------------------------------------------------------------

describe.skipIf(!isolated)("Movements reconcile with the job card", () => {
  it("per job, online - refunds + counter - given back over every movement = net_paid", async () => {
    await inTransaction(conn, async (tx) => {
      const today = await shopToday(tx);
      const ago = (n: number) => addDays(today, -n);
      // J1: partial refunds (one with no Stripe date), counter money live,
      // voided in error and given back through the real RPCs.
      const j1 = await pastJob(tx, ago(12), { total: "300.00", status: "completed" });
      const p1 = await online(tx, j1.id, "200.00", sgt(ago(10), "10:00"));
      await refundAt(tx, p1, { cents: 5000, created: sgt(ago(9), "10:00") });
      await refundAt(tx, p1, { cents: 1000, created: null });
      await counterAt(tx, j1.id, { amount: "80.00", receivedAt: sgt(ago(5), "10:00") });
      const e1 = await recordCounter(tx, { workOrderId: j1.id, amount: "40.00" });
      await voidCounter(tx, e1.counter_payment_id, "recorded_in_error");
      const g1 = await recordCounter(tx, { workOrderId: j1.id, amount: "25.00" });
      await voidCounter(tx, g1.counter_payment_id, "given_back", "Handed back in cash");
      // J2: fully refunded online, then paid at the counter.
      const j2 = await pastJob(tx, ago(12));
      const p2 = await online(tx, j2.id, "120.00", sgt(ago(8), "10:00"));
      await refundAt(tx, p2, { cents: 12000, created: sgt(ago(7), "10:00") });
      expect(await paymentStatus(tx, p2.paymentId)).toBe("refunded");
      await recordCounter(tx, { workOrderId: j2.id, amount: "60.00" });
      // J3: Stripe took another currency; a refund in that currency is not
      // counted. Stripe took 35.00 of 40.00 asked (D159b): what it took counts.
      const j3 = await pastJob(tx, ago(12));
      const p3 = await online(tx, j3.id, "50.00", sgt(ago(3), "10:00"), { currency: "usd" });
      await refundAt(tx, p3, { cents: 1000, created: sgt(ago(2), "10:00"), currency: "usd" });
      const short = await paidAt(
        tx,
        await pendingOnline(tx, j3.id, "40.00"),
        sgt(ago(3), "11:00"),
        {
          amountCents: 3500,
        },
      );
      // J4: counter money, then the rest by a balance link (D156) paid now.
      const j4 = await pastJob(tx, ago(12), { total: "90.00", status: "completed" });
      await counterAt(tx, j4.id, { amount: "30.00", receivedAt: sgt(ago(2), "10:00") });
      const link = await sendLink(tx, j4.id);
      expect(link.amount).toBe("60.00");
      const p4 = await startBalanceCheckout(tx, link.token);
      await pay(tx, p4);
      expect(await paymentStatus(tx, p4.paymentId)).toBe("paid");
      // J5: a cancelled job holding counter money.
      const j5 = await pastJob(tx, ago(12), { status: "cancelled" });
      await counterAt(tx, j5.id, { amount: "45.00", receivedAt: sgt(ago(4), "10:00") });

      const jobs = [j1, j2, j3, j4, j5];
      const all = await allItems(tx, ago(12), today, 3);
      const byJob = new Map<string, number>();
      for (const r of all) {
        byJob.set(
          r.work_order_id as string,
          (byJob.get(r.work_order_id as string) ?? 0) + Math.round(Number(r.signed_amount) * 100),
        );
      }
      const expected = { j1: "220.00", j2: "60.00", j3: "85.00", j4: "90.00", j5: "45.00" };
      const got: Record<string, string | null> = {};
      const cardNet: Record<string, unknown> = {};
      for (const [i, j] of jobs.entries()) {
        const key = `j${i + 1}`;
        got[key] = money((byJob.get(j.id) ?? 0) / 100);
        cardNet[key] = (await card(tx, j.id)).net_paid;
      }
      expect(got).toEqual(expected);
      expect(cardNet).toEqual(expected);
      // Paging by 3 walked every movement once; the summary agrees with the items.
      expect(new Set(all.map((r) => `${r.movement}:${r.id}`)).size).toBe(all.length);
      const s = await summary(tx, ago(12), today);
      expect(
        money(all.reduce((t, r) => t + Math.round(Number(r.signed_amount) * 100), 0) / 100),
      ).toBe(s.net_total);
      expect(all.length).toBe(
        (s.online_count as number) +
          (s.refund_count as number) +
          (s.counter_count as number) +
          (s.given_back_count as number),
      );
      // The RPC's given-back row is dated by the void and recorded by the admin.
      const name = await displayName(tx, STAFF.admin);
      const gb = all.filter((r) => r.movement === "counter_given_back");
      expect(gb.map((r) => [r.id, r.amount, r.signed_amount, r.recorded_by_name])).toEqual([
        [g1.counter_payment_id, "25.00", "-25.00", name],
      ]);
      expect(all.some((r) => r.id === e1.counter_payment_id)).toBe(false);
      expect(all.find((r) => r.id === short.paymentId)).toMatchObject({
        movement: "online_payment",
        amount: "35.00",
        other_currency: false,
      });
      expect(all.find((r) => r.id === p3.paymentId)).toMatchObject({
        amount: "50.00",
        other_currency: true,
      });
    });
  });
});

// ---------------------------------------------------------------------------
// 5. The list (D154e)
// ---------------------------------------------------------------------------

describe.skipIf(!isolated)("report_payment_items (D154e)", () => {
  it("newest first on (at, id), keyset pages that meet exactly, job and customer, recorder for counter rows", async () => {
    await inTransaction(conn, async (tx) => {
      const K = TEST_DAY(480);
      const job = await pastJob(tx, addDays(K, -1));
      const p = await online(tx, job.id, "70.00", sgt(K, "09:00"));
      await refundAt(tx, p, { cents: 1500, created: sgt(K, "11:00") });
      const back = await counterAt(tx, job.id, {
        amount: "12.00",
        receivedAt: sgt(K, "08:00"),
        createdAt: sgt(K, "11:30"),
      });
      await voidAt(tx, back, "given_back", sgt(K, "12:00"), STAFF.manager);
      const high = "ffffffff-ffff-4fff-bfff-ffffffffffff";
      const low = "00000000-0000-4000-8000-000000000001";
      await counterAt(tx, job.id, {
        amount: "20.00",
        receivedAt: sgt(K, "10:00"),
        id: low,
        method: "bank_transfer",
      });
      await counterAt(tx, job.id, {
        amount: "21.00",
        receivedAt: sgt(K, "10:00"),
        id: high,
        method: "other",
      });

      const full = await items(tx, K, K, { max: 100 });
      expect(full.map((r) => [r.movement, r.amount])).toEqual([
        ["counter_given_back", "12.00"],
        ["online_refund", "15.00"],
        ["counter_payment", "21.00"],
        ["counter_payment", "20.00"],
        ["online_payment", "70.00"],
        ["counter_payment", "12.00"],
      ]);
      expect(full[2].id).toBe(high);
      expect(full[3].id).toBe(low);
      // Two rows a page: every row once, in order.
      const pages: Row[][] = [];
      let cursor: { afterAt: Date | null; afterId: string | null } = {
        afterAt: null,
        afterId: null,
      };
      for (let i = 0; i < 5; i++) {
        const page = await items(tx, K, K, { max: 2, ...cursor });
        pages.push(page);
        if (page.length === 0) break;
        const last = page[page.length - 1];
        cursor = { afterAt: last.at as Date, afterId: last.id as string };
      }
      expect(pages.map((pg) => pg.length)).toEqual([2, 2, 2, 0]);
      expect(pages.flat()).toEqual(full);
      // A cursor between the two rows of the same instant.
      const afterHigh = await items(tx, K, K, {
        max: 100,
        afterAt: full[2].at as Date,
        afterId: high,
      });
      expect(afterHigh.map((r) => r.id)).toEqual([low, full[4].id, back]);
      // Page size: null is 100, below 1 is 1.
      expect(await items(tx, K, K, { max: null })).toHaveLength(6);
      expect(await items(tx, K, K, { max: 0 })).toHaveLength(1);

      // Who and what.
      const admin = await displayName(tx, STAFF.admin);
      const manager = await displayName(tx, STAFF.manager);
      const label = await readAsOwner(tx, () =>
        scalar<string>(
          tx,
          `select private.customer_label(c.first_name, c.last_name, c.display_name, c.email::text, c.phone)
             from public.customers c where c.id = $1`,
          [job.customer_id],
        ),
      );
      for (const r of full) {
        expect([r.work_order_id, r.job_number, r.customer_label, r.currency]).toEqual([
          job.id,
          job.job_number,
          label,
          "SGD",
        ]);
      }
      const byMovement = (m: string, id?: string) =>
        full.find((r) => r.movement === m && (id === undefined || r.id === id))!;
      expect(byMovement("online_payment")).toMatchObject({
        method: "stripe",
        kind: "balance",
        recorded_at: null,
        recorded_by_name: null,
        id: p.paymentId,
      });
      expect(byMovement("online_refund")).toMatchObject({
        method: "stripe",
        recorded_at: null,
        recorded_by_name: null,
        signed_amount: "-15.00",
      });
      // A back-dated counter payment shows when it was recorded and by whom.
      const original = byMovement("counter_payment", back);
      expect((original.at as Date).toISOString()).toBe(new Date(sgt(K, "08:00")).toISOString());
      expect((original.recorded_at as Date).toISOString()).toBe(
        new Date(sgt(K, "11:30")).toISOString(),
      );
      expect(original.recorded_by_name).toBe(admin);
      const given = byMovement("counter_given_back");
      expect(given).toMatchObject({ id: back, method: "cash", recorded_by_name: manager });
      expect((given.recorded_at as Date).toISOString()).toBe(
        new Date(sgt(K, "12:00")).toISOString(),
      );
      expect(byMovement("counter_payment", low).method).toBe("bank_transfer");
    });
  });
});

// ---------------------------------------------------------------------------
// 6. Held on jobs now (D154c)
// ---------------------------------------------------------------------------

describe.skipIf(!isolated)("report_payments_held (D154c)", () => {
  it("three disjoint groups from the job card; the amounts of a job that is not collected add up to net_paid", async () => {
    await inTransaction(conn, async (tx) => {
      const H = TEST_DAY(490);
      const t = (n: number) => sgt(addDays(H, 1), `${String(9 + n).padStart(2, "0")}:00`);
      const j = {
        // open: in progress, paid above the lines so far (paid_ahead as a memo)
        h1: await pastJob(tx, H, { total: "100.00", status: "in_progress" }),
        // open: paid online, partly refunded, no lines yet
        h2: await pastJob(tx, H),
        // awaiting: completed, part paid
        h3: await pastJob(tx, H, { total: "200.00", status: "completed" }),
        // awaiting: completed, nothing paid (balance due)
        h4: await pastJob(tx, H, { total: "120.00", status: "completed" }),
        // awaiting + above the bill: ready, paid over
        h5: await pastJob(tx, H, { total: "100.00", status: "ready_for_collection" }),
        // collected, paid exactly: not held
        h6: await pastJob(tx, H, { total: "100.00", status: "collected" }),
        // collected, paid over: above the bill only
        h7: await pastJob(tx, H, { total: "100.00", status: "collected" }),
        // cancelled with counter money: above the bill
        h8: await pastJob(tx, H, { status: "cancelled" }),
        // open, refunded in full: nothing held
        h9: await pastJob(tx, H),
        // open, nothing paid
        h10: await pastJob(tx, H, { total: "50.00" }),
        // completed, paid exactly
        h11: await pastJob(tx, H, { total: "100.00", status: "completed" }),
        // open, every counter payment voided
        h12: await pastJob(tx, H, { total: "100.00" }),
      };
      await counterAt(tx, j.h1.id, { amount: "150.00", receivedAt: t(0) });
      const p2 = await online(tx, j.h2.id, "80.00", t(0));
      await refundAt(tx, p2, { cents: 3000, created: t(1) });
      await counterAt(tx, j.h3.id, { amount: "50.00", receivedAt: t(0) });
      await counterAt(tx, j.h5.id, { amount: "130.00", receivedAt: t(0) });
      await counterAt(tx, j.h6.id, { amount: "100.00", receivedAt: t(0) });
      await counterAt(tx, j.h7.id, { amount: "110.00", receivedAt: t(0) });
      await counterAt(tx, j.h8.id, { amount: "40.00", receivedAt: t(0) });
      const p9 = await online(tx, j.h9.id, "60.00", t(0));
      await refundAt(tx, p9, { cents: 6000, created: t(1) });
      await counterAt(tx, j.h11.id, { amount: "100.00", receivedAt: t(0) });
      const e12 = await counterAt(tx, j.h12.id, { amount: "70.00", receivedAt: t(0) });
      await voidAt(tx, e12, "recorded_in_error", t(2));
      const g12 = await counterAt(tx, j.h12.id, { amount: "20.00", receivedAt: t(0) });
      await voidAt(tx, g12, "given_back", t(2));

      const names = new Map(Object.entries(j).map(([k, v]) => [v.id, k]));
      const rows = (await held(tx)).filter((r) => names.has(r.work_order_id as string));
      const pick = (r: Row) => [
        names.get(r.work_order_id as string),
        r.grp,
        r.status,
        r.amount,
        r.net_paid,
        r.job_total,
        r.balance_due,
        r.paid_ahead,
      ];
      const order = (x: unknown[]) => `${String(x[0]).slice(1).padStart(2, "0")}:${String(x[1])}`;
      const byJob = (a: unknown[], b: unknown[]) => order(a).localeCompare(order(b));
      expect(rows.map(pick).sort(byJob)).toEqual(
        [
          ["h1", "open", "in_progress", "150.00", "150.00", "100.00", "0.00", "50.00"],
          ["h2", "open", "received", "50.00", "50.00", "0.00", "0.00", "50.00"],
          ["h3", "awaiting_collection", "completed", "50.00", "50.00", "200.00", "150.00", "0.00"],
          ["h4", "awaiting_collection", "completed", "0.00", "0.00", "120.00", "120.00", "0.00"],
          [
            "h5",
            "above_bill",
            "ready_for_collection",
            "30.00",
            "130.00",
            "100.00",
            "0.00",
            "30.00",
          ],
          [
            "h5",
            "awaiting_collection",
            "ready_for_collection",
            "100.00",
            "130.00",
            "100.00",
            "0.00",
            "30.00",
          ],
          ["h7", "above_bill", "collected", "10.00", "110.00", "100.00", null, null],
          ["h8", "above_bill", "cancelled", "40.00", "40.00", "0.00", null, null],
          ["h11", "awaiting_collection", "completed", "100.00", "100.00", "100.00", "0.00", "0.00"],
        ].sort(byJob),
      );
      // Groups come in order (open, awaiting_collection, above_bill), each job once per group.
      const rank = { open: 0, awaiting_collection: 1, above_bill: 2 } as Record<string, number>;
      const ranks = rows.map((r) => rank[r.grp as string]);
      expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
      expect(new Set(rows.map((r) => `${r.grp}:${r.work_order_id}`)).size).toBe(rows.length);
      // Open jobs are in no other group.
      const openJobs = new Set(rows.filter((r) => r.grp === "open").map((r) => r.work_order_id));
      expect(rows.filter((r) => r.grp !== "open" && openJobs.has(r.work_order_id))).toEqual([]);
      // Each row's figures are the job card's; the groups add up to net_paid
      // (to held_over_total once collected: the bill is settled, only the
      // excess is still held).
      for (const [key, job] of Object.entries(j)) {
        const c = await card(tx, job.id);
        const mine = rows.filter((r) => r.work_order_id === job.id);
        for (const r of mine) {
          expect([key, r.net_paid, r.net_paid_online, r.paid_at_counter, r.job_total]).toEqual([
            key,
            c.net_paid,
            c.net_paid_online,
            c.paid_at_counter,
            c.job_total,
          ]);
          expect([key, r.balance_due, r.paid_ahead]).toEqual([key, c.balance_due, c.paid_ahead]);
        }
        const sum = money(mine.reduce((s, r) => s + Math.round(Number(r.amount) * 100), 0) / 100);
        if (Number(c.net_paid) > 0) {
          expect([key, sum]).toEqual([
            key,
            job.status === "collected" ? c.held_over_total : c.net_paid,
          ]);
        }
      }
      // The labels are the customers'.
      const label = await readAsOwner(tx, () =>
        scalar<string>(
          tx,
          `select private.customer_label(c.first_name, c.last_name, c.display_name, c.email::text, c.phone)
             from public.customers c where c.id = $1`,
          [j.h3.customer_id],
        ),
      );
      expect(rows.find((r) => r.work_order_id === j.h3.id)).toMatchObject({
        job_number: j.h3.job_number,
        customer_label: label,
        currency: "SGD",
      });
      // A manager reads the same rows.
      expect((await held(tx, MANAGER)).filter((r) => names.has(r.work_order_id as string))).toEqual(
        rows,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// 7. Nothing in the sales figures changes (D154)
// ---------------------------------------------------------------------------

describe.skipIf(!isolated)("Customer payments are not sales (D154)", () => {
  it("report_period_summary on every basis, daily_summary and the job's totals are unchanged by any movement", async () => {
    await inTransaction(conn, async (tx) => {
      const today = await shopToday(tx);
      const job = await pastJob(tx, addDays(today, -3), { total: "150.00", status: "completed" });
      const snapshot = async () => {
        await actAs(tx, ADMIN);
        const out: string[] = [];
        for (const basis of ["sale", "check_in", "completion", "collection"]) {
          out.push(
            (
              await tx.query<{ t: string }>(
                `select coalesce(json_agg(x order by x::text)::text, '[]') as t
                   from public.report_period_summary($1::date, $2::date, $3::public.report_date_basis) x`,
                [addDays(today, -3), today, basis],
              )
            ).rows[0].t,
          );
        }
        out.push(
          (
            await tx.query<{ t: string }>(
              `select coalesce(json_agg(x order by x::text)::text, '[]') as t
                 from public.daily_summary($1::date, $2::date) x`,
              [addDays(today, -3), today],
            )
          ).rows[0].t,
        );
        out.push(
          await readAsOwner(tx, () =>
            scalar<string>(
              tx,
              "select coalesce(json_agg(t)::text, '[]') from public.work_order_totals t where t.work_order_id = $1",
              [job.id],
            ),
          ),
        );
        return out;
      };
      const before = await snapshot();
      const p = await online(tx, job.id, "100.00", sgt(addDays(today, -2), "10:00"));
      await refundAt(tx, p, { cents: 1000, created: sgt(addDays(today, -1), "10:00") });
      const c = await recordCounter(tx, { workOrderId: job.id, amount: "20.00" });
      await voidCounter(tx, c.counter_payment_id, "given_back", "Handed back");
      await recordCounter(tx, { workOrderId: job.id, amount: "30.00" });
      const link = await sendLink(tx, job.id);
      await pay(tx, await startBalanceCheckout(tx, link.token));
      expect(figures(await summary(tx, addDays(today, -3), today))).toMatchObject({
        online: [2, "130.00"],
        refund: [1, "10.00"],
        counter: [2, "50.00"],
        givenBack: [1, "20.00"],
        net: "150.00",
      });
      expect(await snapshot()).toEqual(before);
    });
  });
});
