/**
 * D270 staff counter payments (amends D161a): any active staff member
 * records counter money, a quote's deposit included; one recorded by
 * someone who is not an admin waits for an admin's review
 * (needs_review, review_counter_payment); voiding stays admin only.
 *
 *   record_counter_payment   require_staff; needs_review = not an admin.
 *   review_counter_payment   admins only; idempotent; P0002 when unknown.
 *   counter_payments_immutable  lets the one review through, nothing else.
 *   quote_deposits / quote_by_token  a mechanic's counter deposit makes
 *                            the deposit paid in the same transaction.
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { STAFF } from "../fixtures/ids";
import { actAs, connect, inTransaction, isolatedDatabase, scalar } from "./harness";
import { ADMIN, MANAGER, MECHANIC2, newJob, readAsOwner } from "./inventory-fixtures";
import { ANON, answered, voidCounter } from "./payment-fixtures";
import { addManualLine, events, failsWith, ownerMode } from "./workshop-fixtures";

let conn: pg.Client;

beforeAll(async () => {
  conn = await connect();
});

const DENIED = { code: "42501" };

/** record_counter_payment (cash, now) as whoever `tx` is; returns its id. */
async function recordAs(
  tx: pg.Client,
  a: { workOrderId: string; amount: string; quoteId?: string | null },
): Promise<string> {
  const { rows } = await tx.query<{ counter_payment_id: string }>(
    `select counter_payment_id
       from public.record_counter_payment($1, $2, $3, $4, 'cash')`,
    [randomUUID(), a.workOrderId, a.quoteId ?? null, a.amount],
  );
  return rows[0].counter_payment_id;
}

const review = (tx: pg.Client, id: string) =>
  tx.query("select public.review_counter_payment($1)", [id]);

type ReviewRow = {
  recorded_by: string;
  needs_review: boolean;
  reviewed_at: string | null;
  reviewed_by: string | null;
};

/** The payment's review columns (read as the owner). */
const reviewRow = (tx: pg.Client, id: string) =>
  readAsOwner(tx, async () => {
    const { rows } = await tx.query<ReviewRow>(
      `select recorded_by, needs_review, reviewed_at::text, reviewed_by
         from public.counter_payments where id = $1`,
      [id],
    );
    return rows[0];
  });

/** What Today lists for an admin: needs review, not reviewed, not voided. */
const toReview = (tx: pg.Client, workOrderId: string) =>
  readAsOwner(tx, async () => {
    const { rows } = await tx.query<{ id: string }>(
      `select c.id from public.counter_payments c
        where c.work_order_id = $1 and c.needs_review and c.reviewed_at is null
          and not exists (select 1 from public.counter_payment_voids v where v.counter_payment_id = c.id)
        order by c.created_at`,
      [workOrderId],
    );
    return rows.map((r) => r.id);
  });

/** A new open job with an 80.00 manual line (as ADMIN). */
async function billedJob(tx: pg.Client) {
  const job = await newJob(tx);
  await addManualLine(tx, { workOrderId: job.id, description: "Labour", price: "80.00" });
  return job;
}

describe.skipIf(!isolatedDatabase())("Staff counter payments (D270)", () => {
  it("a mechanic records a payment; it is flagged for review and counts at once", async () => {
    await inTransaction(conn, async (tx) => {
      const job = await billedJob(tx);
      await actAs(tx, MECHANIC2);
      const id = await recordAs(tx, { workOrderId: job.id, amount: "30.00" });

      expect(await reviewRow(tx, id)).toEqual({
        recorded_by: STAFF.mechanic2,
        needs_review: true,
        reviewed_at: null,
        reviewed_by: null,
      });
      expect(await toReview(tx, job.id)).toEqual([id]);
      // It counts on the job without waiting for the review.
      const paid = await readAsOwner(tx, () =>
        scalar<string>(
          tx,
          "select paid_at_counter::text from public.work_order_payment_totals where work_order_id = $1",
          [job.id],
        ),
      );
      expect(paid).toBe("30.00");
      // The timeline names the mechanic.
      const recorded = await readAsOwner(tx, async () =>
        (await events(tx, job.id)).filter((e) => e.event_type === "counter_payment_recorded"),
      );
      expect(recorded.map((e) => e.actor_staff_id)).toEqual([STAFF.mechanic2]);
      // Staff read the review columns.
      expect(
        await scalar<boolean>(
          tx,
          "select needs_review from public.counter_payments where id = $1",
          [id],
        ),
      ).toBe(true);
    });
  });

  it("a manager's payment is flagged too; an admin's is not", async () => {
    await inTransaction(conn, async (tx) => {
      const job = await billedJob(tx);
      await actAs(tx, MANAGER);
      const managers = await recordAs(tx, { workOrderId: job.id, amount: "10.00" });
      await actAs(tx, ADMIN);
      const admins = await recordAs(tx, { workOrderId: job.id, amount: "5.00" });
      expect((await reviewRow(tx, managers)).needs_review).toBe(true);
      expect((await reviewRow(tx, admins)).needs_review).toBe(false);
      expect(await toReview(tx, job.id)).toEqual([managers]);
    });
  });

  it("an admin reviews it, once; mechanics and managers cannot; an unknown id is P0002", async () => {
    await inTransaction(conn, async (tx) => {
      const job = await billedJob(tx);
      await actAs(tx, MECHANIC2);
      const id = await recordAs(tx, { workOrderId: job.id, amount: "30.00" });

      for (const claims of [MECHANIC2, MANAGER, ANON]) {
        await actAs(tx, claims);
        await failsWith(tx, () => review(tx, id), DENIED);
      }
      expect((await reviewRow(tx, id)).reviewed_at).toBeNull();

      await actAs(tx, ADMIN);
      await review(tx, id);
      const first = await reviewRow(tx, id);
      expect(first.reviewed_by).toBe(STAFF.admin);
      expect(first.reviewed_at).not.toBeNull();
      expect(await toReview(tx, job.id)).toEqual([]);

      // Idempotent: the first review stands.
      await actAs(tx, ADMIN);
      await review(tx, id);
      expect(await reviewRow(tx, id)).toEqual(first);

      await actAs(tx, ADMIN);
      await failsWith(tx, () => review(tx, randomUUID()), {
        code: "P0002",
        message: "counter_payment_not_found",
      });
    });
  });

  it("the review is the only change a row takes: no other column, and never twice", async () => {
    await inTransaction(conn, async (tx) => {
      const job = await billedJob(tx);
      await actAs(tx, MECHANIC2);
      const id = await recordAs(tx, { workOrderId: job.id, amount: "30.00" });
      const immutable = { code: "P0001", message: "counter_payment_immutable" };

      // No API role writes the columns, admins included.
      await actAs(tx, ADMIN);
      await failsWith(
        tx,
        () =>
          tx.query(
            "update public.counter_payments set reviewed_at = now(), reviewed_by = $2 where id = $1",
            [id, STAFF.admin],
          ),
        DENIED,
      );

      await ownerMode(tx);
      await failsWith(
        tx,
        () =>
          tx.query(
            "update public.counter_payments set reviewed_at = now(), reviewed_by = $2, note = 'x' where id = $1",
            [id, STAFF.admin],
          ),
        immutable,
      );
      await failsWith(
        tx,
        () =>
          tx.query("update public.counter_payments set needs_review = false where id = $1", [id]),
        immutable,
      );
      await actAs(tx, ADMIN);
      await review(tx, id);
      await ownerMode(tx);
      await failsWith(
        tx,
        () =>
          tx.query(
            "update public.counter_payments set reviewed_at = now(), reviewed_by = $2 where id = $1",
            [id, STAFF.manager],
          ),
        immutable,
      );
      await failsWith(
        tx,
        () =>
          tx.query(
            "update public.counter_payments set reviewed_at = null, reviewed_by = null where id = $1",
            [id],
          ),
        immutable,
      );
    });
  });

  it("a mechanic cannot void a counter payment; an admin can, and it leaves the review list", async () => {
    await inTransaction(conn, async (tx) => {
      const job = await billedJob(tx);
      await actAs(tx, MECHANIC2);
      const id = await recordAs(tx, { workOrderId: job.id, amount: "30.00" });

      for (const claims of [MECHANIC2, MANAGER]) {
        await actAs(tx, claims);
        await failsWith(
          tx,
          () =>
            tx.query("select public.void_counter_payment($1, 'recorded_in_error', $2)", [
              id,
              "Typed on the wrong job",
            ]),
          DENIED,
        );
      }
      expect(await toReview(tx, job.id)).toEqual([id]);

      await voidCounter(tx, id);
      expect(
        await readAsOwner(tx, () =>
          scalar<number>(
            tx,
            "select count(*)::int from public.counter_payment_voids where counter_payment_id = $1",
            [id],
          ),
        ),
      ).toBe(1);
      expect(await toReview(tx, job.id)).toEqual([]);
      // A voided one can still be reviewed (idempotent, harmless).
      await actAs(tx, ADMIN);
      await review(tx, id);
      expect((await reviewRow(tx, id)).reviewed_by).toBe(STAFF.admin);
    });
  });

  it("a mechanic's counter deposit marks the quote's deposit paid in the same transaction, and the quote page stops asking", async () => {
    await inTransaction(conn, async (tx) => {
      const d = await answered(tx); // a 120.00 deposit at 50%, acting as ADMIN
      const before = await readAsOwner(tx, () =>
        scalar<string>(tx, "select state from public.quote_deposits where quote_id = $1", [
          d.quoteId,
        ]),
      );
      expect(before).toBe("due");

      await actAs(tx, MECHANIC2);
      const id = await recordAs(tx, {
        workOrderId: d.job.id,
        quoteId: d.quoteId,
        amount: "120.00",
      });

      const row = await readAsOwner(tx, async () => {
        const { rows } = await tx.query<{ state: string; counter_payment_id: string | null }>(
          "select state, counter_payment_id from public.quote_deposits where quote_id = $1",
          [d.quoteId],
        );
        return rows[0];
      });
      expect(row).toEqual({ state: "paid", counter_payment_id: id });
      expect((await reviewRow(tx, id)).needs_review).toBe(true);

      await actAs(tx, ANON);
      const view = await scalar<{ deposit: { status: string } | null }>(
        tx,
        "select public.quote_by_token($1)",
        [d.token],
      );
      expect(view.deposit).toMatchObject({ status: "paid" });
    });
  });
});
