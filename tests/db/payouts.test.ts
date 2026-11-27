/**
 * D276 month-end payouts (PLAN D276; ADR-030; DATA-MODEL §19 "Month-end payouts"; R-137).
 * The invariants, per shop month on the sale date basis:
 *
 *   own    = Σ (sale_total - cult_commons_share) of the recognised service
 *            lines on jobs the mechanic led
 *   other  = the same over jobs led by someone without a rule, or by nobody
 *   labour = the month's non-reversed ad hoc labour (reserve_labour)
 *   pay    = greatest(least(cap, own + greatest(other - labour, 0)), 0)
 *            (the owner's amendment, 2026-11-28; several mechanics are
 *            topped up in staff-name order)
 *   reserve change = own + other - labour - pay (may be < 0); the balance
 *            is the running sum of the changes
 *   Cult Commons owed = report_period_summary's cult_commons_share (net of
 *                the D273/D274 fees)
 *   outstanding = owed - non-reversed payouts against the month
 *
 * Payouts are append-only, replay-safe by id with a fingerprint, reversed
 * with a reason; everything is admin only.
 *
 * Jobs are owner inserts in 2023 (no seed reaches it), so the file runs
 * only on a per-file clone, in rolled-back transactions.
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { paymentIntentObject } from "../fixtures/stripe";
import { STAFF } from "../fixtures/ids";
import { createAuthUser, customerClaims } from "./customer-fixtures";
import { actAs, connect, inTransaction, isolatedDatabase, scalar, type Claims } from "./harness";
import { ADMIN, MANAGER, MECHANIC1, completeJob, newJob } from "./inventory-fixtures";
import { ANON, SERVICE, pay, tag, type Pay } from "./payment-fixtures";
import { completedPath, insertJob, money, sgt } from "./reporting-fixtures";
import { addManualLine, failsWith, ownerMode } from "./workshop-fixtures";

let conn: pg.Client;

beforeAll(async () => {
  conn = await connect();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Row = {
  party: string;
  staff_id: string | null;
  consignor_id: string | null;
  display_name: string;
  period_month: string;
  service_revenue: string | null;
  service_after_cc: string | null;
  top_up: string | null;
  monthly_cap: string | null;
  owed: string | null;
  paid: string | null;
  outstanding: string | null;
  carry_over: string | null;
  carry_from: string | null;
  balance: string | null;
  item_count: number | null;
};

const MONEY_COLUMNS = [
  "service_revenue",
  "service_after_cc",
  "top_up",
  "monthly_cap",
  "owed",
  "paid",
  "outstanding",
  "carry_over",
  "balance",
] as const;

/** payout_summary for the month, as the admin, money as fixed-2 strings. */
async function summary(tx: pg.Client, month: string): Promise<Row[]> {
  await actAs(tx, ADMIN);
  const { rows } = await tx.query<Row>(
    `select party, staff_id, consignor_id, display_name, to_char(period_month, 'YYYY-MM-DD') as period_month,
            service_revenue::text, service_after_cc::text, top_up::text, monthly_cap::text, owed::text, paid::text,
            outstanding::text, carry_over::text, to_char(carry_from, 'YYYY-MM-DD') as carry_from,
            balance::text, item_count
       from public.payout_summary($1::date)`,
    [month],
  );
  return rows.map((r) => {
    const out = { ...r };
    for (const c of MONEY_COLUMNS) out[c] = money(r[c]);
    return out;
  });
}

const mechanicRow = (rows: Row[], staffId: string) =>
  rows.find((r) => r.party === "mechanic" && r.staff_id === staffId) ?? null;
const partyRow = (rows: Row[], party: string) => {
  const row = rows.find((r) => r.party === party);
  if (!row) throw new Error(`no ${party} row`);
  return row;
};

/** A job completed on `day` (sale basis) with one line, led by `lead`. Owner insert. */
async function jobOn(
  tx: pg.Client,
  day: string,
  lead: string | null,
  price: string,
  type: "service" | "manual" | "inventory" = "service",
  cost = "0.00",
) {
  await ownerMode(tx);
  return insertJob(tx, {
    checkedInAt: sgt(day, "09:00"),
    leadMechanicId: lead,
    path: completedPath(sgt(day, "11:00"), sgt(day, "16:00")),
    lines: [{ type, unitSale: price, unitCost: cost, createdAt: sgt(day, "10:00") }],
  });
}

async function setRule(tx: pg.Client, staffId: string, cap: string, from: string) {
  await actAs(tx, ADMIN);
  const { rows } = await tx.query<{ id: string; effective_from: string; monthly_cap: string }>(
    `select id, to_char(effective_from, 'YYYY-MM-DD') as effective_from, monthly_cap::text
       from public.set_service_pay_rule($1, $2, $3::date)`,
    [staffId, cap, from],
  );
  return rows[0];
}

type PayoutArgs = {
  id?: string;
  kind: "mechanic_pay" | "cult_commons" | "reserve_labour";
  amount: string;
  month?: string | null;
  staffId?: string | null;
  payee?: string | null;
  paidAt?: string | null;
  reference?: string | null;
  notes?: string | null;
};

async function recordPayout(tx: pg.Client, a: PayoutArgs, claims: Claims = ADMIN) {
  await actAs(tx, claims);
  const id = a.id ?? randomUUID();
  const { rows } = await tx.query<{ payout_id: string; replayed: boolean }>(
    `select payout_id, replayed from public.record_payout($1, $2::public.payout_kind, $3, $4::date, $5, $6, $7::timestamptz, $8, $9)`,
    [
      id,
      a.kind,
      a.amount,
      a.month ?? null,
      a.staffId ?? null,
      a.payee ?? null,
      a.paidAt ?? null,
      a.reference ?? null,
      a.notes ?? null,
    ],
  );
  return rows[0];
}

async function reversePayout(tx: pg.Client, payoutId: string, reason: string) {
  await actAs(tx, ADMIN);
  const { rows } = await tx.query<{ payout_id: string; reason: string }>(
    "select payout_id, reason from public.reverse_payout($1, $2)",
    [payoutId, reason],
  );
  return rows[0];
}

const JAN = "2023-01-01";
const FEB = "2023-02-01";
const MAR = "2023-03-01";

// ---------------------------------------------------------------------------
// 1. What is owed
// ---------------------------------------------------------------------------

describe.skipIf(!isolatedDatabase())("D276: mechanic service pay and the reserve", () => {
  it("the owner's example: 5,000 of service is 3,500 after CC: 3,000 to the mechanic, 500 to the reserve", async () => {
    await inTransaction(conn, async (tx) => {
      await setRule(tx, STAFF.mechanic1, "3000.00", JAN);
      await jobOn(tx, "2023-01-10", STAFF.mechanic1, "5000.00");
      const rows = await summary(tx, "2023-01-20");
      expect(rows.every((r) => r.period_month === JAN)).toBe(true);
      expect(mechanicRow(rows, STAFF.mechanic1)).toMatchObject({
        service_revenue: "5000.00",
        service_after_cc: "3500.00",
        top_up: "0.00",
        monthly_cap: "3000.00",
        owed: "3000.00",
        paid: "0.00",
        outstanding: "3000.00",
        carry_over: "0.00",
      });
      expect(partyRow(rows, "reserve")).toMatchObject({
        owed: "500.00",
        paid: "0.00",
        carry_over: "0.00",
        balance: "500.00",
      });
      expect(partyRow(rows, "cult_commons")).toMatchObject({
        owed: "1500.00",
        paid: "0.00",
        outstanding: "1500.00",
        carry_over: "0.00",
      });
      // Total = the mechanic + Cult Commons + what consignors are owed now.
      const consignors = partyRow(rows, "consignors");
      expect(partyRow(rows, "total").owed).toBe((4500 + Number(consignors.owed)).toFixed(2));
    });
  });

  it("below the cap: 2,000 of service pays 1,400 and adds nothing to the reserve", async () => {
    await inTransaction(conn, async (tx) => {
      await setRule(tx, STAFF.mechanic1, "3000.00", JAN);
      await jobOn(tx, "2023-01-05", STAFF.mechanic1, "1200.00");
      await jobOn(tx, "2023-01-25", STAFF.mechanic1, "800.00");
      const rows = await summary(tx, JAN);
      expect(mechanicRow(rows, STAFF.mechanic1)).toMatchObject({
        service_revenue: "2000.00",
        service_after_cc: "1400.00",
        owed: "1400.00",
      });
      expect(partyRow(rows, "reserve")).toMatchObject({ owed: "0.00", balance: "0.00" });
    });
  });

  it("a cap change from a later month leaves earlier months as they were; unpaid months carry over", async () => {
    await inTransaction(conn, async (tx) => {
      await setRule(tx, STAFF.mechanic1, "3000.00", JAN);
      await jobOn(tx, "2023-01-10", STAFF.mechanic1, "5000.00");
      await jobOn(tx, "2023-02-10", STAFF.mechanic1, "5000.00");
      const janBefore = await summary(tx, JAN);
      // The date is taken to its month.
      expect(await setRule(tx, STAFF.mechanic1, "1000.00", "2023-02-14")).toMatchObject({
        effective_from: FEB,
        monthly_cap: "1000.00",
      });
      expect(await summary(tx, JAN)).toEqual(janBefore);
      const feb = await summary(tx, FEB);
      expect(mechanicRow(feb, STAFF.mechanic1)).toMatchObject({
        monthly_cap: "1000.00",
        owed: "1000.00",
        outstanding: "1000.00",
        carry_over: "3000.00",
        carry_from: JAN,
      });
      expect(partyRow(feb, "reserve")).toMatchObject({
        owed: "2500.00",
        carry_over: "500.00",
        balance: "3000.00",
      });
      expect(partyRow(feb, "cult_commons")).toMatchObject({
        owed: "1500.00",
        carry_over: "1500.00",
        carry_from: JAN,
      });
      // Repeating the rule in force for a month changes nothing.
      const again = await setRule(tx, STAFF.mechanic1, "1000.00", FEB);
      const count = await scalar<number>(
        tx,
        "select count(*)::int from public.service_pay_rules where staff_id = $1",
        [STAFF.mechanic1],
      );
      expect(again.monthly_cap).toBe("1000.00");
      expect(count).toBe(2);
      // Rules are append-only.
      await ownerMode(tx);
      await failsWith(
        tx,
        () =>
          tx.query("update public.service_pay_rules set monthly_cap = 5 where id = $1", [again.id]),
        { code: "P0001", message: "payout_immutable" },
      );
      await actAs(tx, ADMIN);
      await failsWith(tx, () => setRule(tx, STAFF.mechanic1, "-1.00", MAR), {
        code: "23514",
      });
    });
  });

  it("service on jobs led by someone without a rule, or by nobody, tops the mechanic up to the cap; the rest goes to the reserve", async () => {
    await inTransaction(conn, async (tx) => {
      await setRule(tx, STAFF.mechanic1, "3000.00", JAN);
      await jobOn(tx, "2023-01-11", STAFF.mechanic2, "4000.00");
      await jobOn(tx, "2023-01-12", null, "1000.00");
      const rows = await summary(tx, JAN);
      expect(mechanicRow(rows, STAFF.mechanic2)).toBeNull();
      expect(mechanicRow(rows, STAFF.mechanic1)).toMatchObject({
        service_revenue: "0.00",
        service_after_cc: "0.00",
        top_up: "3000.00",
        owed: "3000.00",
      });
      expect(partyRow(rows, "reserve")).toMatchObject({
        service_revenue: "5000.00",
        service_after_cc: "3500.00",
        owed: "500.00",
        balance: "500.00",
      });
    });
  });

  it("parts and custom lines never count as service, though their Cult Commons is owed", async () => {
    await inTransaction(conn, async (tx) => {
      await setRule(tx, STAFF.mechanic1, "3000.00", JAN);
      await jobOn(tx, "2023-01-13", STAFF.mechanic1, "300.00", "manual");
      await jobOn(tx, "2023-01-14", STAFF.mechanic1, "500.00", "inventory", "300.00");
      const rows = await summary(tx, JAN);
      expect(mechanicRow(rows, STAFF.mechanic1)).toMatchObject({
        service_revenue: "0.00",
        service_after_cc: "0.00",
        owed: "0.00",
      });
      expect(partyRow(rows, "reserve").owed).toBe("0.00");
      // 30% of 300 and 30% of the part's 200 yield.
      expect(partyRow(rows, "cult_commons").owed).toBe("150.00");
    });
  });
});

// ---------------------------------------------------------------------------
// 1b. The owner's amendment (2026-11-28): other service pays labour, then
//     tops the mechanic up to the cap, then goes to the reserve
// ---------------------------------------------------------------------------

describe.skipIf(!isolatedDatabase())("D276 amendment: other service, labour and the top-up", () => {
  /** January's mechanic1 and reserve rows. */
  const jan = async (tx: pg.Client) => {
    const rows = await summary(tx, JAN);
    return { mech: mechanicRow(rows, STAFF.mechanic1), reserve: partyRow(rows, "reserve") };
  };
  const labour = (tx: pg.Client, amount: string) =>
    recordPayout(tx, { kind: "reserve_labour", amount, payee: "Ah Seng", month: JAN });

  it("own 5,000 (3,500 after CC), no other, no labour: pay 3,000, reserve +500", async () => {
    await inTransaction(conn, async (tx) => {
      await setRule(tx, STAFF.mechanic1, "3000.00", JAN);
      await jobOn(tx, "2023-01-10", STAFF.mechanic1, "5000.00");
      const { mech, reserve } = await jan(tx);
      expect(mech).toMatchObject({ service_after_cc: "3500.00", top_up: "0.00", owed: "3000.00" });
      expect(reserve).toMatchObject({ service_after_cc: "0.00", paid: "0.00", owed: "500.00" });
    });
  });

  it("own 1,400, other 700, labour 300: pay 1,400 + 400 = 1,800, reserve 0", async () => {
    await inTransaction(conn, async (tx) => {
      await setRule(tx, STAFF.mechanic1, "3000.00", JAN);
      await jobOn(tx, "2023-01-10", STAFF.mechanic1, "2000.00");
      await jobOn(tx, "2023-01-11", null, "1000.00");
      await labour(tx, "300.00");
      const { mech, reserve } = await jan(tx);
      expect(mech).toMatchObject({
        service_after_cc: "1400.00",
        top_up: "400.00",
        owed: "1800.00",
      });
      expect(reserve).toMatchObject({
        service_after_cc: "700.00",
        paid: "300.00",
        owed: "0.00",
        balance: "0.00",
      });
    });
  });

  it("own 1,400, other 2,800, labour 200: pay 3,000, reserve 1,400 + 2,800 - 200 - 3,000 = 1,000", async () => {
    await inTransaction(conn, async (tx) => {
      await setRule(tx, STAFF.mechanic1, "3000.00", JAN);
      await jobOn(tx, "2023-01-10", STAFF.mechanic1, "2000.00");
      await jobOn(tx, "2023-01-11", STAFF.mechanic2, "4000.00");
      await labour(tx, "200.00");
      const { mech, reserve } = await jan(tx);
      expect(mech).toMatchObject({ top_up: "1600.00", owed: "3000.00" });
      expect(reserve).toMatchObject({
        service_after_cc: "2800.00",
        paid: "200.00",
        owed: "1000.00",
        balance: "1000.00",
      });
    });
  });

  it("own 1,400, no other, labour 500: pay 1,400, reserve -500", async () => {
    await inTransaction(conn, async (tx) => {
      await setRule(tx, STAFF.mechanic1, "3000.00", JAN);
      await jobOn(tx, "2023-01-10", STAFF.mechanic1, "2000.00");
      await labour(tx, "500.00");
      const { mech, reserve } = await jan(tx);
      expect(mech).toMatchObject({ top_up: "0.00", owed: "1400.00" });
      expect(reserve).toMatchObject({ paid: "500.00", owed: "-500.00", balance: "-500.00" });
    });
  });

  it("labour recorded after the mechanic was paid restates the month's pay: over by the difference", async () => {
    await inTransaction(conn, async (tx) => {
      await setRule(tx, STAFF.mechanic1, "3000.00", JAN);
      await jobOn(tx, "2023-01-10", STAFF.mechanic1, "2000.00");
      await jobOn(tx, "2023-01-11", null, "1000.00");
      expect((await jan(tx)).mech?.owed).toBe("2100.00");
      await recordPayout(tx, {
        kind: "mechanic_pay",
        amount: "2100.00",
        month: JAN,
        staffId: STAFF.mechanic1,
      });
      // The labour is recorded and is not refused (operator first).
      const l = await labour(tx, "700.00");
      let { mech, reserve } = await jan(tx);
      expect(mech).toMatchObject({
        top_up: "0.00",
        owed: "1400.00",
        paid: "2100.00",
        outstanding: "-700.00",
      });
      expect(reserve).toMatchObject({ owed: "0.00", balance: "0.00" });
      // Reversing the labour restores it.
      await reversePayout(tx, l.payout_id, "Not this month");
      ({ mech, reserve } = await jan(tx));
      expect(mech).toMatchObject({ owed: "2100.00", outstanding: "0.00" });
      expect(reserve).toMatchObject({ paid: "0.00", owed: "0.00" });
    });
  });

  it("with two mechanics, the other revenue tops them up in staff-name order", async () => {
    await inTransaction(conn, async (tx) => {
      // mechanic1 is Marcus Tan, mechanic2 Nur Aisyah (supabase/seed.sql).
      await setRule(tx, STAFF.mechanic1, "3000.00", JAN);
      await setRule(tx, STAFF.mechanic2, "3000.00", JAN);
      await jobOn(tx, "2023-01-10", STAFF.mechanic1, "2000.00"); // own 1,400
      await jobOn(tx, "2023-01-11", STAFF.mechanic2, "2000.00"); // own 1,400
      await jobOn(tx, "2023-01-12", null, "3000.00"); // other 2,100
      const rows = await summary(tx, JAN);
      expect(mechanicRow(rows, STAFF.mechanic1)).toMatchObject({
        top_up: "1600.00",
        owed: "3000.00",
      });
      expect(mechanicRow(rows, STAFF.mechanic2)).toMatchObject({
        top_up: "500.00",
        owed: "1900.00",
      });
      expect(partyRow(rows, "reserve")).toMatchObject({
        service_after_cc: "2100.00",
        owed: "0.00",
      });
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Cult Commons is the Reports figure
// ---------------------------------------------------------------------------

/** A Stripe balance payment of `amount` on the job, paid now. */
async function paidPayment(tx: pg.Client, workOrderId: string, amount: string): Promise<Pay> {
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
  await pay(tx, p);
  return p;
}

/** record_stripe_read of the intent with a fee of feeCents, taxCents of it GST. */
async function readFee(tx: pg.Client, p: Pay, feeCents: number, taxCents: number) {
  await actAs(tx, SERVICE);
  const intent = {
    ...paymentIntentObject({ id: p.pi, status: "succeeded", amountCents: p.cents }),
    latest_charge: {
      id: `ch_${p.pi.slice(3)}`,
      object: "charge",
      balance_transaction: {
        id: `txn_${tag()}`,
        object: "balance_transaction",
        amount: p.cents,
        fee: feeCents,
        net: p.cents - feeCents,
        currency: "sgd",
        created: Math.floor(Date.now() / 1000),
        fee_details: [
          {
            type: "stripe_fee",
            amount: feeCents - taxCents,
            currency: "sgd",
            description: "Stripe processing fees",
          },
          { type: "tax", amount: taxCents, currency: "sgd", description: "GST" },
        ],
        source: `ch_${p.pi.slice(3)}`,
      },
    },
  };
  const { rows } = await tx.query<{ outcome: string }>(
    "select outcome from public.record_stripe_read($1, $2::jsonb, $3)",
    [p.paymentId, JSON.stringify(intent), `corr-${tag()}`],
  );
  return rows[0];
}

describe.skipIf(!isolatedDatabase())(
  "D276: Cult Commons owed is the month's Reports figure",
  () => {
    it("equals report_period_summary's cult_commons_share for the month, net of a Stripe fee", async () => {
      await inTransaction(conn, async (tx) => {
        const month = await scalar<string>(
          tx,
          "select to_char(date_trunc('month', private.shop_today()::timestamp), 'YYYY-MM-DD')",
        );
        const monthEnd = await scalar<string>(
          tx,
          "select to_char((date_trunc('month', private.shop_today()::timestamp) + interval '1 month - 1 day')::date, 'YYYY-MM-DD')",
        );
        const reports = async () => {
          await actAs(tx, ADMIN);
          return money(
            await scalar<string>(
              tx,
              "select cult_commons_share::text from public.report_period_summary($1::date, $2::date, 'sale')",
              [month, monthEnd],
            ),
          );
        };
        const before = partyRow(await summary(tx, month), "cult_commons").owed;
        expect(before).toBe(await reports());

        // A 200.00 job paid by Stripe with a 4.10 fee (0.34 GST): CC 60.00 less 3.76.
        const job = await newJob(tx);
        await actAs(tx, ADMIN);
        await addManualLine(tx, { workOrderId: job.id, price: "200.00", cost: "0.00" });
        const p = await paidPayment(tx, job.id, "200.00");
        expect((await readFee(tx, p, 410, 34)).outcome).toBe("stripe_fee_recorded");
        await actAs(tx, ADMIN);
        await completeJob(tx, job.id);

        const after = partyRow(await summary(tx, month), "cult_commons").owed;
        expect(after).toBe(await reports());
        expect((Number(after) - Number(before)).toFixed(2)).toBe("56.24");
      });
    });
  },
);

// ---------------------------------------------------------------------------
// 3. Payouts
// ---------------------------------------------------------------------------

describe.skipIf(!isolatedDatabase())("D276: recording and reversing payouts", () => {
  it("payouts reduce outstanding, replay once, refuse a different request, and reversing restores it", async () => {
    await inTransaction(conn, async (tx) => {
      await setRule(tx, STAFF.mechanic1, "3000.00", JAN);
      await jobOn(tx, "2023-01-10", STAFF.mechanic1, "5000.00");
      const id = randomUUID();
      const args: PayoutArgs = {
        id,
        kind: "mechanic_pay",
        amount: "1000",
        month: "2023-01-31",
        staffId: STAFF.mechanic1,
        paidAt: sgt("2023-02-01", "10:00"),
        reference: " PayNow 123 ",
      };
      expect(await recordPayout(tx, args)).toEqual({ payout_id: id, replayed: false });
      // A replay ("1000" and "1000.00" are the same amount; the reference trimmed).
      expect(
        await recordPayout(tx, { ...args, amount: "1000.00", reference: "PayNow 123" }),
      ).toEqual({ payout_id: id, replayed: true });
      await failsWith(tx, () => recordPayout(tx, { ...args, amount: "1200.00" }), {
        code: "P0001",
        message: "payout_conflict",
      });
      let jan = await summary(tx, JAN);
      expect(mechanicRow(jan, STAFF.mechanic1)).toMatchObject({
        owed: "3000.00",
        paid: "1000.00",
        outstanding: "2000.00",
      });

      const cc = await recordPayout(tx, { kind: "cult_commons", amount: "1500.00", month: JAN });
      expect(partyRow(await summary(tx, JAN), "cult_commons")).toMatchObject({
        paid: "1500.00",
        outstanding: "0.00",
      });

      // Over the outstanding is allowed (operator first): "Over by".
      await recordPayout(tx, {
        kind: "mechanic_pay",
        amount: "2500.00",
        month: JAN,
        staffId: STAFF.mechanic1,
      });
      jan = await summary(tx, JAN);
      expect(mechanicRow(jan, STAFF.mechanic1)?.outstanding).toBe("-500.00");

      // Reversal restores it; a second reversal is the same one.
      const rev = await reversePayout(tx, id, "  Wrong amount  ");
      expect(rev).toEqual({ payout_id: id, reason: "Wrong amount" });
      expect(await reversePayout(tx, id, "Another reason")).toEqual(rev);
      await failsWith(tx, () => reversePayout(tx, cc.payout_id, "   "), {
        code: "P0001",
        message: "reason_required",
      });
      jan = await summary(tx, JAN);
      expect(mechanicRow(jan, STAFF.mechanic1)).toMatchObject({
        paid: "2500.00",
        outstanding: "500.00",
      });
      // February carries what January still owes.
      const feb = await summary(tx, FEB);
      expect(mechanicRow(feb, STAFF.mechanic1)).toMatchObject({
        carry_over: "500.00",
        carry_from: JAN,
      });
      expect(partyRow(feb, "cult_commons")).toMatchObject({ carry_over: "0.00", carry_from: null });

      // The month's list: newest first, the reversal on its row.
      await actAs(tx, ADMIN);
      const { rows: listed } = await tx.query<{
        id: string;
        kind: string;
        payee: string;
        amount: string;
        reference: string | null;
        reversal_reason: string | null;
      }>(
        "select id, kind::text, payee, amount::text, reference, reversal_reason from public.list_payouts($1::date)",
        [JAN],
      );
      expect(listed).toHaveLength(3);
      expect(listed.find((r) => r.id === id)).toMatchObject({
        kind: "mechanic_pay",
        amount: "1000.00",
        reference: "PayNow 123",
        reversal_reason: "Wrong amount",
      });
      expect(listed.find((r) => r.id === cc.payout_id)).toMatchObject({
        payee: "Cult Commons",
        reversal_reason: null,
      });

      // Append-only for every writer.
      await ownerMode(tx);
      await failsWith(
        tx,
        () => tx.query("update public.payouts set amount = 1 where id = $1", [id]),
        { code: "P0001", message: "payout_immutable" },
      );
      await failsWith(tx, () => tx.query("delete from public.payout_reversals"), {
        code: "P0001",
        message: "payout_immutable",
      });
    });
  });

  it("refuses a payout without its payee or month, with a stray payee, or dated in the future", async () => {
    await inTransaction(conn, async (tx) => {
      await failsWith(
        tx,
        () => recordPayout(tx, { kind: "mechanic_pay", amount: "10.00", month: JAN }),
        { code: "P0001", message: "payout_payee_required" },
      );
      await failsWith(
        tx,
        () =>
          recordPayout(tx, {
            kind: "reserve_labour",
            amount: "10.00",
            staffId: STAFF.mechanic2,
            payee: "Someone",
          }),
        { code: "P0001", message: "payout_payee_required" },
      );
      await failsWith(tx, () => recordPayout(tx, { kind: "reserve_labour", amount: "10.00" }), {
        code: "P0001",
        message: "payout_payee_required",
      });
      await failsWith(
        tx,
        () =>
          recordPayout(tx, {
            kind: "cult_commons",
            amount: "10.00",
            month: JAN,
            staffId: STAFF.mechanic1,
          }),
        { code: "P0001", message: "payout_payee_unexpected" },
      );
      await failsWith(tx, () => recordPayout(tx, { kind: "cult_commons", amount: "10.00" }), {
        code: "P0001",
        message: "payout_month_required",
      });
      await failsWith(
        tx,
        () =>
          recordPayout(tx, {
            kind: "cult_commons",
            amount: "10.00",
            month: JAN,
            paidAt: new Date(Date.now() + 86_400_000).toISOString(),
          }),
        { code: "P0001", message: "payout_paid_in_future" },
      );
      await failsWith(
        tx,
        () => recordPayout(tx, { kind: "cult_commons", amount: "0.00", month: JAN }),
        { code: "23514" },
      );
    });
  });

  it("the reserve balance runs across months, takes ad hoc labour and may go below zero", async () => {
    await inTransaction(conn, async (tx) => {
      await setRule(tx, STAFF.mechanic1, "3000.00", JAN);
      await jobOn(tx, "2023-01-10", STAFF.mechanic1, "5000.00"); // own 3,500
      await jobOn(tx, "2023-02-10", null, "1000.00"); // other 700
      // Ad hoc labour by someone who is not staff, paid in January.
      await recordPayout(tx, {
        kind: "reserve_labour",
        amount: "200.00",
        payee: "  Ah Seng  ",
        paidAt: sgt("2023-01-28", "12:00"),
      });
      // And by a staff member, for February.
      await recordPayout(tx, {
        kind: "reserve_labour",
        amount: "100.00",
        staffId: STAFF.mechanic2,
        month: FEB,
        paidAt: sgt("2023-02-20", "12:00"),
      });
      // January: 3,500 + 0 - 200 - 3,000 = +300.
      expect(partyRow(await summary(tx, JAN), "reserve")).toMatchObject({
        owed: "300.00",
        paid: "200.00",
        carry_over: "0.00",
        balance: "300.00",
      });
      // February: the other 700 less 100 of labour tops the mechanic up by 600.
      const feb = await summary(tx, FEB);
      expect(mechanicRow(feb, STAFF.mechanic1)).toMatchObject({ top_up: "600.00", owed: "600.00" });
      expect(partyRow(feb, "reserve")).toMatchObject({
        service_after_cc: "700.00",
        owed: "0.00",
        paid: "100.00",
        carry_over: "300.00",
        balance: "300.00",
      });
      await recordPayout(tx, {
        kind: "reserve_labour",
        amount: "1000.00",
        payee: "Ah Seng",
        month: MAR,
        paidAt: sgt("2023-03-02", "12:00"),
      });
      expect(partyRow(await summary(tx, MAR), "reserve")).toMatchObject({
        owed: "-1000.00",
        paid: "1000.00",
        carry_over: "300.00",
        balance: "-700.00",
      });
      await actAs(tx, ADMIN);
      const payees = (
        await tx.query<{ payee: string }>("select payee from public.list_payouts($1::date)", [JAN])
      ).rows.map((r) => r.payee);
      expect(payees).toEqual(["Ah Seng"]);
    });
  });
});

describe.skipIf(!isolatedDatabase())("D276: where tracking starts", () => {
  it("counts carry-over and the reserve from the first pay rule's month; payouts, reversed or not, never move it", async () => {
    await inTransaction(conn, async (tx) => {
      // January and February were settled outside the app.
      await jobOn(tx, "2023-01-10", STAFF.mechanic1, "1000.00"); // CC 300, 700 after CC
      await jobOn(tx, "2023-02-10", STAFF.mechanic1, "1000.00");
      await setRule(tx, STAFF.mechanic1, "3000.00", MAR);
      await jobOn(tx, "2023-03-10", STAFF.mechanic1, "5000.00");
      const before = await summary(tx, MAR);
      expect(partyRow(before, "cult_commons")).toMatchObject({
        owed: "1500.00",
        carry_over: "0.00",
        carry_from: null,
      });
      expect(partyRow(before, "reserve")).toMatchObject({
        owed: "500.00",
        carry_over: "0.00",
        balance: "500.00",
      });
      expect(mechanicRow(before, STAFF.mechanic1)).toMatchObject({
        carry_over: "0.00",
        carry_from: null,
      });

      // A Cult Commons payment for January by mistake, then reversed; and a
      // real one for February and ad hoc labour in January.
      const wrong = await recordPayout(tx, { kind: "cult_commons", amount: "300.00", month: JAN });
      await reversePayout(tx, wrong.payout_id, "Wrong month");
      await recordPayout(tx, { kind: "cult_commons", amount: "300.00", month: FEB });
      await recordPayout(tx, {
        kind: "reserve_labour",
        amount: "50.00",
        payee: "Ah Seng",
        month: JAN,
      });
      expect(await summary(tx, MAR)).toEqual(before);

      // A month before tracking starts shows its own figures, no carry-over.
      const feb = await summary(tx, FEB);
      expect(partyRow(feb, "cult_commons")).toMatchObject({
        owed: "300.00",
        paid: "300.00",
        outstanding: "0.00",
        carry_over: "0.00",
      });
      expect(partyRow(feb, "reserve")).toMatchObject({ owed: "700.00", carry_over: "0.00" });
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Access: admins only
// ---------------------------------------------------------------------------

describe.skipIf(!isolatedDatabase())("D276: only admins see or record payouts", () => {
  it("a manager, a mechanic, a customer and anon read nothing and can call no payout RPC", async () => {
    await inTransaction(conn, async (tx) => {
      await setRule(tx, STAFF.mechanic1, "3000.00", JAN);
      const p = await recordPayout(tx, { kind: "cult_commons", amount: "10.00", month: JAN });
      await ownerMode(tx);
      const customer = customerClaims(
        await createAuthUser(tx, `payouts-${randomUUID().slice(0, 8)}@example.com`),
      );
      const calls: [string, unknown[]][] = [
        ["select * from public.payout_summary($1::date)", [JAN]],
        ["select * from public.list_payouts($1::date)", [JAN]],
        ["select * from public.set_service_pay_rule($1, '1', $2::date)", [STAFF.mechanic1, FEB]],
        [
          "select * from public.record_payout($1, 'cult_commons', '1', $2::date)",
          [randomUUID(), JAN],
        ],
        ["select * from public.reverse_payout($1, 'No')", [p.payout_id]],
      ];
      for (const claims of [MANAGER, MECHANIC1, customer]) {
        await actAs(tx, claims);
        for (const table of ["payouts", "payout_reversals", "service_pay_rules"]) {
          expect(
            await scalar<number>(tx, `select count(*)::int from public.${table}`),
            `${table}`,
          ).toBe(0);
        }
        for (const [sql, params] of calls) {
          await failsWith(tx, () => tx.query(sql, params), { code: "42501" });
        }
      }
      await actAs(tx, ANON);
      for (const table of ["payouts", "payout_reversals", "service_pay_rules"]) {
        await failsWith(tx, () => tx.query(`select 1 from public.${table}`), { code: "42501" });
      }
      for (const [sql, params] of calls) {
        await failsWith(tx, () => tx.query(sql, params), { code: "42501" });
      }
      // The admin reads them; nobody reads the fingerprint.
      await actAs(tx, ADMIN);
      expect(await scalar<number>(tx, "select count(*)::int from public.payouts")).toBe(1);
      await failsWith(tx, () => tx.query("select request_fingerprint from public.payouts"), {
        code: "42501",
      });
    });
  });
});
