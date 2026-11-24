/**
 * D273: Stripe fees are borne by Cult Commons (PLAN D273, amends D154;
 * ADR-025 amendment; DATA-MODEL §19a). The invariant, per COMPLETED job:
 *
 *   net CC = gross CC - least(fees, gross CC)       (never below 0)
 *   BICII after CC = yield - net CC - fees
 *
 * where gross CC is Σ the live line shares (D1, unchanged) and fees is Σ
 * Stripe's fee less the GST on it over the job's paid, partly refunded or
 * refunded Stripe payments. A fee comes only from a server read of the
 * PaymentIntent (record_stripe_read → apply_stripe_fee), is insert-only
 * and view_costs to read. The deduction is one stripe_fee entry per job in
 * reporting.financial_lines on the job's CURRENT completed_at, so every
 * report sums net Cult Commons with a floor per job, a reopen moves it,
 * and a cancelled job deducts nothing.
 *
 * The file creates jobs and payments, so it runs only on a per-file clone,
 * in rolled-back transactions. Period figures are compared as differences
 * within one transaction (the seed may recognise lines on the same day).
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { paymentIntentObject, refundObject } from "../fixtures/stripe";
import { FEE_FIXTURES } from "../fixtures/cult-commons";
import { STAFF } from "../fixtures/ids";
import { actAs, connect, inTransaction, isolatedDatabase, scalar } from "./harness";
import {
  ADMIN,
  MECHANIC1,
  MECHANIC2,
  completeJob,
  newJob,
  readAsOwner,
  reopenJob,
} from "./inventory-fixtures";
import { SERVICE, deliver, paidSession, pay, tag, type Pay } from "./payment-fixtures";
import { shopToday } from "./reporting-fixtures";
import { addManualLine, failsWith, ownerMode, setStatus, voidLine } from "./workshop-fixtures";

let conn: pg.Client;

beforeAll(async () => {
  conn = await connect();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A Stripe balance payment of `amount` on the job, paid (at `paidAt` unix seconds, else now). */
async function paidPayment(
  tx: pg.Client,
  workOrderId: string,
  amount = "100.00",
  paidAt?: number,
): Promise<Pay> {
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
  const p: Pay = {
    paymentId: id,
    sessionId,
    workOrderId,
    quoteId: null,
    cents: Math.round(Number(amount) * 100),
    pi: `pi_${tag()}`,
  };
  if (paidAt === undefined) await pay(tx, p);
  else await deliver(tx, "checkout.session.completed", paidSession(p), paidAt);
  return p;
}

type FeeInput = {
  feeCents?: number;
  taxCents?: number;
  currency?: string;
  txn?: string;
  /** No balance transaction yet (Stripe has not settled the charge). */
  none?: boolean;
  extraCharge?: Record<string, unknown>;
};

/** The PaymentIntent as the fee read returns it (latest_charge.balance_transaction expanded). */
function intentWithFee(p: Pay, f: FeeInput = {}) {
  const currency = f.currency ?? "sgd";
  const fee = f.feeCents ?? 0;
  const tax = f.taxCents ?? 0;
  return {
    ...paymentIntentObject({ id: p.pi, status: "succeeded", amountCents: p.cents }),
    latest_charge: {
      id: `ch_${p.pi.slice(3)}`,
      object: "charge",
      // Never stored (D159e).
      billing_details: { email: "someone@example.com", name: "Some One" },
      ...f.extraCharge,
      balance_transaction: f.none
        ? null
        : {
            id: f.txn ?? `txn_${tag()}`,
            object: "balance_transaction",
            amount: p.cents,
            fee,
            net: p.cents - fee,
            currency,
            created: Math.floor(Date.now() / 1000),
            fee_details: [
              {
                type: "stripe_fee",
                amount: fee - tax,
                currency,
                description: "Stripe processing fees",
              },
              ...(tax > 0 ? [{ type: "tax", amount: tax, currency, description: "GST" }] : []),
            ],
            source: `ch_${p.pi.slice(3)}`,
          },
    },
  };
}

type ReadResult = {
  event_id: string;
  event_status: string;
  outcome: string;
  payment_status: string;
};

/** record_stripe_read of the expanded intent, as the service role. */
async function readFee(tx: pg.Client, p: Pay, f: FeeInput = {}): Promise<ReadResult> {
  await actAs(tx, SERVICE);
  const { rows } = await tx.query<ReadResult>(
    `select event_id, event_status::text, outcome, payment_status::text
       from public.record_stripe_read($1, $2::jsonb, $3)`,
    [p.paymentId, JSON.stringify(intentWithFee(p, f)), `corr-${tag()}`],
  );
  return rows[0];
}

/** A job with one manual line of `price` (no cost: gross CC = 30%), as the admin. */
async function jobWithLine(
  tx: pg.Client,
  price: string,
): Promise<{ id: string; job_number: string }> {
  const job = await newJob(tx);
  await actAs(tx, ADMIN);
  await addManualLine(tx, { workOrderId: job.id, price, cost: "0.00" });
  return job;
}

async function complete(tx: pg.Client, jobId: string) {
  await actAs(tx, ADMIN);
  return completeJob(tx, jobId);
}

type Entry = {
  entry_kind: string;
  line_type: string;
  description: string;
  sale_total: string;
  yield_total: string;
  cult_commons_share: string;
  bicii_yield_after_cc: string;
  stripe_fee: string;
  stripe_fee_pending: boolean;
  recognized_at: Date;
};

/** The job's financial_lines entries, as the owner (fee entry last). */
const entries = (tx: pg.Client, jobId: string) =>
  readAsOwner(tx, async () => {
    const { rows } = await tx.query<Entry>(
      `select entry_kind, line_type, description, sale_total::text, yield_total::text,
              cult_commons_share::text, bicii_yield_after_cc::text, stripe_fee::text,
              stripe_fee_pending, recognized_at
         from reporting.financial_lines where document_id = $1
        order by entry_kind, entry_key`,
      [jobId],
    );
    return rows;
  });

const feeEntry = async (tx: pg.Client, jobId: string) =>
  (await entries(tx, jobId)).find((e) => e.entry_kind === "stripe_fee") ?? null;

/** Σ of the job's entries (net Cult Commons and BICII after it, from the view). */
const jobSums = (tx: pg.Client, jobId: string) =>
  readAsOwner(tx, async () => {
    const { rows } = await tx.query<{ cc: string; after: string; fees: string; lines: number }>(
      `select sum(cult_commons_share)::numeric(12,2)::text as cc,
              sum(bicii_yield_after_cc)::numeric(12,2)::text as after,
              sum(stripe_fee)::numeric(12,2)::text as fees,
              (count(*) filter (where entry_kind = 'line'))::int as lines
         from reporting.financial_lines where document_id = $1`,
      [jobId],
    );
    return rows[0];
  });

type Totals = {
  cult_commons_share: string;
  bicii_yield_after_cc: string;
  stripe_fees: string;
  stripe_fees_borne: string;
  cult_commons_after_fees: string;
  bicii_yield_after_fees: string;
  stripe_fee_pending_count: number;
};

const totalsOf = async (tx: pg.Client, jobId: string, claims = ADMIN) => {
  await actAs(tx, claims);
  const { rows } = await tx.query<Totals>(
    `select cult_commons_share::text, bicii_yield_after_cc::text, stripe_fees::text,
            stripe_fees_borne::text, cult_commons_after_fees::text, bicii_yield_after_fees::text,
            stripe_fee_pending_count
       from public.work_order_totals_staff where work_order_id = $1`,
    [jobId],
  );
  return rows[0];
};

const yieldOf = async (tx: pg.Client, jobId: string) => {
  await actAs(tx, ADMIN);
  const { rows } = await tx.query<Totals>(
    `select cult_commons_share::text, bicii_yield_after_cc::text, stripe_fees::text,
            stripe_fees_borne::text, cult_commons_after_fees::text, bicii_yield_after_fees::text,
            stripe_fee_pending_count
       from public.work_order_yield($1)`,
    [jobId],
  );
  return rows[0];
};

type Summary = {
  line_count: number;
  job_count: number;
  cult_commons_share: string | null;
  yield_after_cc: string | null;
  yield_total: string | null;
  stripe_fees: string | null;
  stripe_fees_borne: string | null;
  stripe_fee_pending_jobs: number | null;
};

const summary = async (tx: pg.Client, day: string, basis = "sale", claims = ADMIN) => {
  await actAs(tx, claims);
  const { rows } = await tx.query<Summary>(
    `select line_count, job_count, cult_commons_share::text, yield_after_cc::text, yield_total::text,
            stripe_fees::text, stripe_fees_borne::text, stripe_fee_pending_jobs
       from public.report_period_summary($1::date, $1::date, $2::public.report_date_basis)`,
    [day, basis],
  );
  return rows[0];
};

const cents = (v: string | null) => Math.round(Number(v ?? 0) * 100);
/** after − before, in cents, for the money columns; counts as numbers. */
const delta = (before: Summary, after: Summary) => ({
  line_count: after.line_count - before.line_count,
  job_count: after.job_count - before.job_count,
  cc: cents(after.cult_commons_share) - cents(before.cult_commons_share),
  afterCc: cents(after.yield_after_cc) - cents(before.yield_after_cc),
  yield: cents(after.yield_total) - cents(before.yield_total),
  fees: cents(after.stripe_fees) - cents(before.stripe_fees),
  borne: cents(after.stripe_fees_borne) - cents(before.stripe_fees_borne),
  pending: (after.stripe_fee_pending_jobs ?? 0) - (before.stripe_fee_pending_jobs ?? 0),
});

/** The day's bucket of report_period_series (sale basis, by day), as the admin. */
const seriesDay = async (tx: pg.Client, day: string) => {
  await actAs(tx, ADMIN);
  const { rows } = await tx.query<{ cult_commons_share: string; yield_after_cc: string }>(
    `select cult_commons_share::text, yield_after_cc::text
       from public.report_period_series($1::date, $1::date, 'sale', 'day')`,
    [day],
  );
  return rows[0];
};

const feeRows = (tx: pg.Client, paymentId: string) =>
  readAsOwner(tx, async () => {
    const { rows } = await tx.query<{
      fee: string;
      fee_tax: string;
      fee_ex_tax: string;
      currency: string;
      livemode: boolean;
      stripe_charge_id: string | null;
      read_event_id: string;
    }>(
      `select fee::text, fee_tax::text, fee_ex_tax::text, currency::text, livemode,
              stripe_charge_id, read_event_id
         from public.stripe_payment_fees where payment_id = $1`,
      [paymentId],
    );
    return rows;
  });

// ---------------------------------------------------------------------------
// 1. The fee fact
// ---------------------------------------------------------------------------

describe.skipIf(!isolatedDatabase())("D273: a Stripe fee is Stripe's word, recorded once", () => {
  it("a read of the expanded intent records the fee less GST; the stored read keeps only amounts and ids", async () => {
    await inTransaction(conn, async (tx) => {
      const job = await jobWithLine(tx, "200.00");
      const p = await paidPayment(tx, job.id);
      const r = await readFee(tx, p, { feeCents: 410, taxCents: 34 });
      expect(r).toMatchObject({
        event_status: "applied",
        outcome: "stripe_fee_recorded",
        payment_status: "paid",
      });
      const [row] = await feeRows(tx, p.paymentId);
      expect(row).toMatchObject({
        fee: "4.10",
        fee_tax: "0.34",
        fee_ex_tax: "3.76",
        currency: "SGD",
        livemode: false,
        stripe_charge_id: `ch_${p.pi.slice(3)}`,
        read_event_id: r.event_id,
      });
      // D159e: the projection keeps the fee's evidence, never the charge's details.
      const payload = await readAsOwner(tx, () =>
        scalar<string>(tx, "select payload::text from public.stripe_events where id = $1", [
          r.event_id,
        ]),
      );
      expect(payload).toContain('"fee": 410');
      expect(payload).toContain('"type": "tax"');
      expect(payload).not.toMatch(
        /someone@example\.com|Some One|billing_details|description|source/,
      );
      // A repeat read changes nothing.
      expect(await readFee(tx, p, { feeCents: 999 })).toMatchObject({
        event_status: "ignored",
        outcome: "stripe_fee_unchanged",
      });
      expect((await feeRows(tx, p.paymentId)).map((x) => x.fee)).toEqual(["4.10"]);
    });
  });

  it("no balance transaction yet: pending, retried with a backoff; another currency or a bad fee needs attention", async () => {
    await inTransaction(conn, async (tx) => {
      const job = await jobWithLine(tx, "50.00");
      // Paid long ago, so it is first in the sweep's oldest-first list.
      const p = await paidPayment(tx, job.id, "50.00", 1_577_836_800);
      const due = async () => {
        await actAs(tx, SERVICE);
        return (
          await tx.query<{ payment_id: string }>(
            "select payment_id from public.stripe_fees_due(20, false)",
          )
        ).rows.map((x) => x.payment_id);
      };
      expect(await due()).toContain(p.paymentId);
      // Live payments are not on the test key's list.
      await actAs(tx, SERVICE);
      expect(
        (
          await tx.query<{ payment_id: string }>(
            "select payment_id from public.stripe_fees_due(20, true)",
          )
        ).rows.map((x) => x.payment_id),
      ).not.toContain(p.paymentId);
      expect(await readFee(tx, p, { none: true })).toMatchObject({
        event_status: "ignored",
        outcome: "stripe_fee_pending",
      });
      expect(await feeRows(tx, p.paymentId)).toEqual([]);
      // Within five minutes of a pending read the sweep leaves it.
      expect(await due()).not.toContain(p.paymentId);

      const usd = await paidPayment(tx, job.id, "10.00", 1_577_836_800);
      expect(await readFee(tx, usd, { feeCents: 60, currency: "usd" })).toMatchObject({
        event_status: "needs_attention",
        outcome: "stripe_fee_currency_mismatch",
      });
      expect(await feeRows(tx, usd.paymentId)).toEqual([]);
      expect(await due()).not.toContain(usd.paymentId);
      const bad = await paidPayment(tx, job.id, "10.00");
      expect(await readFee(tx, bad, { feeCents: 30, taxCents: 40 })).toMatchObject({
        event_status: "needs_attention",
        outcome: "object_invalid",
      });
      // The same balance transaction cannot be another payment's fee.
      const first = await paidPayment(tx, job.id, "10.00");
      await readFee(tx, first, { feeCents: 50, txn: "txn_shared123" });
      const second = await paidPayment(tx, job.id, "10.00");
      expect(await readFee(tx, second, { feeCents: 50, txn: "txn_shared123" })).toMatchObject({
        outcome: "object_invalid",
      });

      // Exceptions (admins): the currency problem, and a completed job whose
      // fee is still unread a day after payment, as stripe_attention.
      await complete(tx, job.id);
      await actAs(tx, ADMIN);
      const rows = (
        await tx.query<{ kind: string; severity: string; entity_id: string }>(
          "select kind, severity, entity_id from public.operational_exceptions(500) where entity_id = $1",
          [job.id],
        )
      ).rows;
      expect(
        rows
          .filter((x) => x.kind === "stripe_attention")
          .map((x) => x.severity)
          .sort(),
      ).toEqual(expect.arrayContaining(["danger", "warning"]));
    });
  });

  it("a read that failed at Stripe backs off too, and never takes the never-tried payments' slots", async () => {
    await inTransaction(conn, async (tx) => {
      const job = await jobWithLine(tx, "50.00");
      // Both paid long ago; `stuck` first, so it would lead an oldest-paid list.
      const stuck = await paidPayment(tx, job.id, "10.00", 1_577_836_000);
      const fresh = await paidPayment(tx, job.id, "10.00", 1_577_836_800);
      const due = async (n: number) => {
        await actAs(tx, SERVICE);
        return (
          await tx.query<{ payment_id: string }>(
            "select payment_id from public.stripe_fees_due($1, false)",
            [n],
          )
        ).rows.map((x) => x.payment_id);
      };
      const before = await due(20);
      expect(before.indexOf(stuck.paymentId)).toBeLessThan(before.indexOf(fresh.paymentId));
      // A 404 at Stripe leaves no stored read: the sweep notes it.
      await actAs(tx, SERVICE);
      await tx.query("select public.note_stripe_fee_read_failed($1, 'stripe_not_found')", [
        stuck.paymentId,
      ]);
      const after = await due(20);
      expect(after).not.toContain(stuck.paymentId);
      expect(after).toContain(fresh.paymentId);
      // Past its backoff it comes back, after every never-tried payment.
      await ownerMode(tx);
      await tx.query(
        "update private.stripe_fee_read_failures set last_failed_at = now() - interval '1 hour' where payment_id = $1",
        [stuck.paymentId],
      );
      const later = await due(20);
      expect(later.indexOf(stuck.paymentId)).toBeGreaterThan(later.indexOf(fresh.paymentId));
      // Nobody but the service role notes a failure, and nobody reads the counts.
      await actAs(tx, ADMIN);
      await failsWith(
        tx,
        () => tx.query("select public.note_stripe_fee_read_failed($1, 'x')", [stuck.paymentId]),
        { code: "42501" },
      );
      await actAs(tx, SERVICE);
      await failsWith(tx, () => tx.query("select * from private.stripe_fee_read_failures"), {
        code: "42501",
      });
    });
  });

  it("insert-only, written only inside a read's apply, view_costs to read", async () => {
    await inTransaction(conn, async (tx) => {
      const job = await jobWithLine(tx, "50.00");
      const p = await paidPayment(tx, job.id);
      await readFee(tx, p, { feeCents: 100 });
      const count = async (claims: typeof ADMIN) => {
        await actAs(tx, claims);
        return scalar<number>(
          tx,
          "select count(*)::int from public.stripe_payment_fees where payment_id = $1",
          [p.paymentId],
        );
      };
      expect(await count(ADMIN)).toBe(1);
      expect(await count(MECHANIC1)).toBe(1); // view_costs as an exception
      expect(await count(MECHANIC2)).toBe(0); // no view_costs
      await actAs(tx, ADMIN);
      for (const sql of [
        "insert into public.stripe_payment_fees default values",
        "update public.stripe_payment_fees set fee = fee where false",
        "delete from public.stripe_payment_fees where false",
      ]) {
        await failsWith(tx, () => tx.query(sql), { code: "42501" });
      }
      await actAs(tx, SERVICE);
      await failsWith(tx, () => tx.query("select * from public.stripe_payment_fees"), {
        code: "42501",
      });
      // Not even the owner changes one, or records one outside a read.
      await ownerMode(tx);
      await failsWith(
        tx,
        () =>
          tx.query("update public.stripe_payment_fees set fee = 0 where payment_id = $1", [
            p.paymentId,
          ]),
        { code: "P0001", message: "stripe_fee_immutable" },
      );
      await failsWith(
        tx,
        () =>
          tx.query("delete from public.stripe_payment_fees where payment_id = $1", [p.paymentId]),
        { code: "P0001", message: "stripe_fee_immutable" },
      );
      const other = await paidPayment(tx, job.id);
      const ev = await readAsOwner(tx, () =>
        scalar<string>(tx, "select id from public.stripe_events where payment_id = $1 limit 1", [
          other.paymentId,
        ]),
      );
      await ownerMode(tx);
      await failsWith(
        tx,
        () =>
          tx.query(
            `insert into public.stripe_payment_fees
               (payment_id, work_order_id, stripe_balance_transaction_id, fee, fee_tax, currency,
                livemode, read_event_id)
             values ($1, $2, 'txn_forged1', 1.00, 0, 'SGD', false, $3)`,
            [other.paymentId, job.id, ev],
          ),
        { code: "P0001", message: "stripe_fee_immutable" },
      );
      // The job's fee figures are cost figures: NULL without view_costs.
      await ownerMode(tx);
      await tx.query(
        "insert into public.staff_permissions (staff_id, permission) values ($1, 'view_financial_reports')",
        [STAFF.mechanic2],
      );
      await complete(tx, job.id);
      const s = await summary(tx, await shopToday(tx), "sale", MECHANIC2);
      expect(s.stripe_fees).toBeNull();
      expect(s.stripe_fees_borne).toBeNull();
      expect(s.cult_commons_share).toBeNull();
      expect(s.stripe_fee_pending_jobs).toBeNull();
      expect(await totalsOf(tx, job.id, MECHANIC2)).toBeUndefined();
      // The fee entry itself is a cost figure: no row of it reaches them,
      // not in the day's entries, the line list or a breakdown group.
      const day = await shopToday(tx);
      await actAs(tx, MECHANIC2);
      const kinds = async (sql: string) =>
        (await tx.query<{ k: string }>(sql, [day, job.id])).rows.map((x) => x.k);
      expect(
        await kinds(
          "select entry_kind as k from public.financial_lines($1::date, $1::date) where document_id = $2",
        ),
      ).toEqual(["line"]);
      expect(
        await kinds(
          "select line_type as k from public.report_line_items($1::date, $1::date) where document_id = $2",
        ),
      ).not.toContain("stripe_fee");
      expect(
        (
          await tx.query(
            "select 1 from public.report_breakdown($1::date, $1::date, 'sale', 'product', 10, 'stripe_fees')",
            [day],
          )
        ).rows,
      ).toEqual([]);
      // With view_costs the entry is there, with its fee.
      await actAs(tx, ADMIN);
      const own = await tx.query<{ entry_kind: string; stripe_fee: string | null }>(
        "select entry_kind, stripe_fee::numeric(12,2)::text as stripe_fee from public.financial_lines($1::date, $1::date) where document_id = $2 order by entry_kind",
        [day, job.id],
      );
      expect(own.rows).toEqual([
        { entry_kind: "line", stripe_fee: "0.00" },
        { entry_kind: "stripe_fee", stripe_fee: "1.00" },
      ]);
    });
  });
});

// ---------------------------------------------------------------------------
// 2. The invariant
// ---------------------------------------------------------------------------

describe.skipIf(!isolatedDatabase())(
  "D273: net Cult Commons = max(gross - fees, 0) per completed job",
  () => {
    it("one fee entry on the completion day; totals, yield, daily and every basis agree", async () => {
      await inTransaction(conn, async (tx) => {
        const day = await shopToday(tx);
        const before = {
          sale: await summary(tx, day, "sale"),
          completion: await summary(tx, day, "completion"),
          check_in: await summary(tx, day, "check_in"),
          collection: await summary(tx, day, "collection"),
        };
        const seriesBefore = await seriesDay(tx, day);
        const dailyBefore = await (async () => {
          await actAs(tx, ADMIN);
          return (
            await tx.query<{ lines: number; cc: string; after: string }>(
              `select lines_recognised as lines, cult_commons_share::text as cc,
                    bicii_yield_after_cc::text as after
               from public.daily_summary($1::date, $1::date)`,
              [day],
            )
          ).rows[0];
        })();

        const job = await jobWithLine(tx, "200.00"); // gross CC 60.00
        const p = await paidPayment(tx, job.id, "200.00");
        await readFee(tx, p, { feeCents: 410, taxCents: 34 }); // 3.76 less GST
        // Open: held, deducted at completion; the totals already say so.
        expect(await feeEntry(tx, job.id)).toBeNull();
        const open = await totalsOf(tx, job.id);
        expect(open).toEqual({
          cult_commons_share: "60.00",
          bicii_yield_after_cc: "140.00",
          stripe_fees: "3.76",
          stripe_fees_borne: "3.76",
          cult_commons_after_fees: "56.24",
          bicii_yield_after_fees: "140.00",
          stripe_fee_pending_count: 0,
        });
        await complete(tx, job.id);

        const fee = await feeEntry(tx, job.id);
        expect(fee).toMatchObject({
          line_type: "stripe_fee",
          description: "Stripe fees",
          stripe_fee_pending: false,
        });
        expect(
          [
            fee!.sale_total,
            fee!.yield_total,
            fee!.cult_commons_share,
            fee!.bicii_yield_after_cc,
            fee!.stripe_fee,
          ].map(cents),
        ).toEqual([0, 0, -376, 0, 376]);
        expect(await jobSums(tx, job.id)).toEqual({
          cc: "56.24",
          after: "140.00",
          fees: "3.76",
          lines: 1,
        });
        expect(await totalsOf(tx, job.id)).toEqual(open);
        expect(await yieldOf(tx, job.id)).toEqual(open);

        for (const basis of ["sale", "completion", "check_in"] as const) {
          expect(delta(before[basis], await summary(tx, day, basis)), basis).toEqual({
            line_count: 1,
            job_count: 1,
            cc: 5624,
            afterCc: 14000,
            yield: 20000,
            fees: 376,
            borne: 376,
            pending: 0,
          });
        }
        // The series bucket of the day says the same.
        const seriesAfter = await seriesDay(tx, day);
        expect(cents(seriesAfter.cult_commons_share) - cents(seriesBefore.cult_commons_share)).toBe(
          5624,
        );
        expect(cents(seriesAfter.yield_after_cc) - cents(seriesBefore.yield_after_cc)).toBe(14000);
        // Collection basis (dated by collected_at, its own branch): once
        // collected, the same line and the same fee entry, once.
        expect(delta(before.collection, await summary(tx, day, "collection")).line_count).toBe(0);
        await actAs(tx, ADMIN);
        await setStatus(tx, job.id, "collected");
        expect(delta(before.collection, await summary(tx, day, "collection"))).toEqual({
          line_count: 1,
          job_count: 1,
          cc: 5624,
          afterCc: 14000,
          yield: 20000,
          fees: 376,
          borne: 376,
          pending: 0,
        });
        await actAs(tx, ADMIN);
        const daily = (
          await tx.query<{ lines: number; cc: string; after: string }>(
            `select lines_recognised as lines, cult_commons_share::text as cc,
                  bicii_yield_after_cc::text as after
             from public.daily_summary($1::date, $1::date)`,
            [day],
          )
        ).rows[0];
        expect(daily.lines - dailyBefore.lines).toBe(1);
        expect(cents(daily.cc) - cents(dailyBefore.cc)).toBe(5624);
        expect(cents(daily.after) - cents(dailyBefore.after)).toBe(14000);

        // Breakdown: the fee joins its job's group and is its own group elsewhere.
        const group = async (dimension: string, key: string) => {
          await actAs(tx, ADMIN);
          return (
            await tx.query<{ label: string; line_count: number; cult_commons_share: string }>(
              `select label, line_count, cult_commons_share::text
               from public.report_breakdown($1::date, $1::date, 'sale', $2::public.report_dimension, 10, $3)`,
              [day, dimension, key],
            )
          ).rows[0];
        };
        expect(await group("job", job.id)).toMatchObject({
          line_count: 1,
          cult_commons_share: "56.24",
        });
        expect((await group("product", "stripe_fees")).label).toBe("Stripe fees");
        expect((await group("ownership", "stripe_fees")).line_count).toBe(0);
      });
    });

    it.each(FEE_FIXTURES.map((f) => [f.name, f] as const))("%s", async (_name, f) => {
      // The fixture's job, built as one manual line per line fixture is not
      // possible here; its fee arithmetic is checked on a job with the same
      // gross share and yield instead.
      const shapes: Record<number, { price: string }> = {
        0: { price: "600.00" }, // yield 600, CC 180
        1: { price: "600.00" },
        2: { price: "40.00" }, // CC 12
      };
      await inTransaction(conn, async (tx) => {
        const job = await jobWithLine(tx, shapes[f.job].price);
        if (f.fees !== "0.00") {
          const p = await paidPayment(tx, job.id, "50.00");
          await readFee(tx, p, { feeCents: cents(f.fees) });
        }
        await complete(tx, job.id);
        const t = await totalsOf(tx, job.id);
        expect(t.stripe_fees).toBe(f.fees);
        expect(t.stripe_fees_borne).toBe(f.borne);
        expect(t.cult_commons_after_fees).toBe(f.ccAfterFees);
        // The reports' sum over the job's entries is the same net figure.
        expect((await jobSums(tx, job.id)).cc).toBe(t.cult_commons_after_fees);
      });
    });

    it("the floor is per job, not per period: one job's fees never reach another's share", async () => {
      await inTransaction(conn, async (tx) => {
        const day = await shopToday(tx);
        const before = await summary(tx, day);
        const small = await jobWithLine(tx, "10.00"); // CC 3.00
        await readFee(tx, await paidPayment(tx, small.id, "10.00"), { feeCents: 500 });
        const big = await jobWithLine(tx, "200.00"); // CC 60.00
        await readFee(tx, await paidPayment(tx, big.id, "200.00"), { feeCents: 100 });
        await complete(tx, small.id);
        await complete(tx, big.id);
        // yield 10.00 - net CC 0.00 - fees 5.00: BICII bears the 2.00 over the share.
        expect(await jobSums(tx, small.id)).toMatchObject({
          cc: "0.00",
          after: "5.00",
          fees: "5.00",
        });
        expect(await jobSums(tx, big.id)).toMatchObject({ cc: "59.00", after: "140.00" });
        // 0 + 59, not 63 - 6 = 57.
        expect(delta(before, await summary(tx, day))).toMatchObject({
          cc: 5900,
          fees: 600,
          borne: 400,
          afterCc: 21000 - 5900 - 600,
        });
      });
    });

    it("refunds never reduce the fee; every paid Stripe payment of the job counts, duplicates included", async () => {
      await inTransaction(conn, async (tx) => {
        const job = await jobWithLine(tx, "200.00");
        const a = await paidPayment(tx, job.id, "100.00");
        const b = await paidPayment(tx, job.id, "100.00");
        await readFee(tx, a, { feeCents: 100 });
        await readFee(tx, b, { feeCents: 200 });
        // b fully refunded: Stripe keeps its fee.
        await deliver(
          tx,
          "refund.updated",
          refundObject({
            id: `re_${tag()}`,
            paymentIntent: b.pi,
            amountCents: 10000,
            status: "succeeded",
          }),
        );
        expect(
          await readAsOwner(tx, () =>
            scalar<string>(tx, "select status::text from public.payments where id = $1", [
              b.paymentId,
            ]),
          ),
        ).toBe("refunded");
        // A refunded payment's fee is still read (the sweep lists it until then).
        const c = await paidPayment(tx, job.id, "50.00");
        await deliver(
          tx,
          "refund.updated",
          refundObject({
            id: `re_${tag()}`,
            paymentIntent: c.pi,
            amountCents: 1000,
            status: "succeeded",
          }),
        );
        expect(await readFee(tx, c, { feeCents: 50 })).toMatchObject({
          outcome: "stripe_fee_recorded",
        });
        // No fan-out: three lines (gross 60 + 3 + 3), one fee entry, each fee once.
        await actAs(tx, ADMIN);
        await addManualLine(tx, { workOrderId: job.id, price: "10.00", cost: "0.00" });
        await addManualLine(tx, { workOrderId: job.id, price: "10.00", cost: "0.00" });
        await complete(tx, job.id);
        expect((await totalsOf(tx, job.id)).stripe_fees).toBe("3.50");
        expect(await jobSums(tx, job.id)).toMatchObject({ cc: "62.50", fees: "3.50", lines: 3 });
        expect(
          (await entries(tx, job.id)).filter((e) => e.entry_kind === "stripe_fee"),
        ).toHaveLength(1);
      });
    });

    it("a cancelled job deducts nothing (BICII bears its fees); a pending fee is flagged, not zero", async () => {
      await inTransaction(conn, async (tx) => {
        // A job is cancelled only once its lines are voided (work_order_has_lines).
        const cancelled = await newJob(tx);
        await actAs(tx, ADMIN);
        const lineId = await addManualLine(tx, {
          workOrderId: cancelled.id,
          price: "200.00",
          cost: "0.00",
        });
        await readFee(tx, await paidPayment(tx, cancelled.id), { feeCents: 300 });
        await actAs(tx, ADMIN);
        await voidLine(tx, lineId, "Customer withdrew");
        await setStatus(tx, cancelled.id, "cancelled", "Customer withdrew");
        expect(await feeEntry(tx, cancelled.id)).toBeNull();
        expect(await totalsOf(tx, cancelled.id)).toMatchObject({
          stripe_fees: "3.00",
          stripe_fees_borne: "0.00",
          cult_commons_after_fees: "0.00",
        });
        expect(await yieldOf(tx, cancelled.id)).toMatchObject({ stripe_fees_borne: "0.00" });

        const day = await shopToday(tx);
        const before = await summary(tx, day);
        const job = await jobWithLine(tx, "200.00");
        const p = await paidPayment(tx, job.id);
        await complete(tx, job.id);
        const pending = await feeEntry(tx, job.id);
        expect(pending).toMatchObject({ stripe_fee_pending: true });
        expect([pending!.stripe_fee, pending!.cult_commons_share].map(cents)).toEqual([0, 0]);
        expect((await totalsOf(tx, job.id)).stripe_fee_pending_count).toBe(1);
        expect(delta(before, await summary(tx, day))).toMatchObject({
          cc: 6000,
          pending: 1,
          line_count: 1,
        });
        await readFee(tx, p, { feeCents: 250 });
        const read = await feeEntry(tx, job.id);
        expect(read).toMatchObject({ stripe_fee_pending: false });
        expect(cents(read!.stripe_fee)).toBe(250);
        expect(delta(before, await summary(tx, day))).toMatchObject({ cc: 5750, pending: 0 });
      });
    });

    it("a reopen takes the fee entry back with the lines; completing again puts it on the new day", async () => {
      await inTransaction(conn, async (tx) => {
        const job = await jobWithLine(tx, "100.00");
        await readFee(tx, await paidPayment(tx, job.id), { feeCents: 120 });
        const first = await complete(tx, job.id);
        expect((await feeEntry(tx, job.id))?.recognized_at).toEqual(first.completed_at);
        await actAs(tx, ADMIN);
        await reopenJob(tx, job.id);
        expect(await entries(tx, job.id)).toEqual([]);
        // Not in the work in progress either: fees on open jobs are held.
        expect(
          await readAsOwner(tx, () =>
            scalar<number>(
              tx,
              "select count(*)::int from reporting.report_lines where document_id = $1 and entry_kind = 'stripe_fee'",
              [job.id],
            ),
          ),
        ).toBe(0);
        const again = await complete(tx, job.id);
        expect((await feeEntry(tx, job.id))?.recognized_at).toEqual(again.completed_at);
        expect(await jobSums(tx, job.id)).toMatchObject({ cc: "28.80", fees: "1.20" });
      });
    });
  },
);
