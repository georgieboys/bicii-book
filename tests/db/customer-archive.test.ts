/**
 * Archiving a customer (audit A-22; DATA-MODEL §2):
 *
 *   * customers_guard_archive refuses archiving, for every writer, while the
 *     customer has a job that is not collected or cancelled, a booked,
 *     confirmed or arrived appointment that has not ended, an open unexpired
 *     quote or a live balance link, a consignor that is not archived, an
 *     adventure booking waiting for payment or paid and not finished
 *     (certified), or a hired tracker not returned (customer_has_open_work);
 *   * an archive is stamped with the database's now(), whatever was sent; a
 *     replay keeps the first date; unarchiving is never refused.
 *
 * Inserting jobs and bikes consumes the short-id sequences, so the file only
 * runs on a per-file clone (TESTING.md).
 */
import type pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { AUTH_USER, STAFF } from "../fixtures/ids";
import { makeRider, offerOn125, openSales, paidBooking, submitted } from "./adventure-fixtures";
import { cancel, insertAppointment, makeType } from "./appointment-fixtures";
import { createConsignor } from "./consignment-fixtures";
import { actAs, connect, inTransaction, isolatedDatabase, scalar, staffClaims } from "./harness";
import { checkout, pay, reservation, setup } from "./tracker-fixtures";
import {
  createWorkOrder,
  failsWith,
  makeCustomer,
  makeCustomerWithBike,
  ownerMode,
  setStatus,
  walkTo,
} from "./workshop-fixtures";

let conn: pg.Client;

beforeAll(async () => {
  conn = await connect();
});

const ADMIN = staffClaims(AUTH_USER.admin);
const MECHANIC2 = staffClaims(AUTH_USER.mechanic2);

const OPEN_WORK = { code: "P0001", message: "customer_has_open_work" };

/** Archives as whoever `tx` is, sending a made-up date the trigger must ignore. */
const archive = (tx: pg.Client, customerId: string) =>
  tx.query("update public.customers set archived_at = '2000-01-01T00:00:00Z' where id = $1", [
    customerId,
  ]);

const unarchive = (tx: pg.Client, customerId: string) =>
  tx.query("update public.customers set archived_at = null where id = $1", [customerId]);

/** Whether the customer is archived at exactly the transaction's now(). */
const archivedNow = (tx: pg.Client, customerId: string) =>
  scalar<boolean>(tx, "select archived_at = now() from public.customers where id = $1", [
    customerId,
  ]);

/** An open job for a new customer (made as the admin); tx stays the admin. */
async function customerWithJob(tx: pg.Client): Promise<{ customerId: string; jobId: string }> {
  const ids = await makeCustomerWithBike(tx);
  await actAs(tx, ADMIN);
  const job = await createWorkOrder(tx, ids);
  return { customerId: ids.customerId, jobId: job.id };
}

describe.skipIf(!isolatedDatabase())("archiving a customer (A-22)", () => {
  it("is refused while a job is open, and stamped with now() once it is collected", async () => {
    await inTransaction(conn, async (tx) => {
      const { customerId, jobId } = await customerWithJob(tx);
      await actAs(tx, MECHANIC2);
      await failsWith(tx, () => archive(tx, customerId), OPEN_WORK);
      await actAs(tx, ADMIN);
      await walkTo(tx, jobId, "completed");
      await actAs(tx, MECHANIC2);
      // Completed is not collected: the bike is still in the shop.
      await failsWith(tx, () => archive(tx, customerId), OPEN_WORK);
      await actAs(tx, ADMIN);
      await setStatus(tx, jobId, "collected");
      await actAs(tx, MECHANIC2);
      await archive(tx, customerId);
      expect(await archivedNow(tx, customerId)).toBe(true);
    });
  });

  it("is refused for the owner too, and allowed once the job is cancelled", async () => {
    await inTransaction(conn, async (tx) => {
      const { customerId, jobId } = await customerWithJob(tx);
      await ownerMode(tx);
      await failsWith(tx, () => archive(tx, customerId), OPEN_WORK);
      await actAs(tx, ADMIN);
      await walkTo(tx, jobId, "cancelled");
      await ownerMode(tx);
      await archive(tx, customerId);
      expect(await archivedNow(tx, customerId)).toBe(true);
    });
  });

  it("is refused while a booking has not ended; past and cancelled bookings do not count", async () => {
    await inTransaction(conn, async (tx) => {
      const customerId = await makeCustomer(tx);
      const typeId = await makeType(tx);
      const at = (days: number, minutes = 30) => {
        const start = new Date(Date.now() + days * 86_400_000);
        return {
          startsAt: start.toISOString(),
          endsAt: new Date(start.getTime() + minutes * 60_000).toISOString(),
        };
      };
      // A booking that ended without anyone marking it does not hold archiving.
      await insertAppointment(tx, { customerId, typeId, ...at(-3), status: "booked" });
      const upcoming = await insertAppointment(tx, {
        customerId,
        typeId,
        ...at(401),
        status: "booked",
        source: "customer",
      });
      await actAs(tx, MECHANIC2);
      await failsWith(tx, () => archive(tx, customerId), OPEN_WORK);
      await cancel(tx, upcoming, "Customer called to cancel");
      await archive(tx, customerId);
      expect(await archivedNow(tx, customerId)).toBe(true);
    });
  });

  it("is refused while a closed job still has an open quote or a live payment link", async () => {
    await inTransaction(conn, async (tx) => {
      const { customerId, jobId } = await customerWithJob(tx);
      await walkTo(tx, jobId, "cancelled");
      await ownerMode(tx);
      // Rows the RPCs would not leave on a cancelled job, written as the owner
      // so each clause is tested on its own.
      const { rows: quote } = await tx.query<{ id: string }>(
        `insert into public.quotes (id, work_order_id, token_hash, channel, currency, total, expires_at, sent_by)
         values (gen_random_uuid(), $1, sha256(gen_random_uuid()::text::bytea), 'link', 'SGD', 10.00,
                 now() + interval '7 days', $2)
         returning id`,
        [jobId, STAFF.admin],
      );
      await actAs(tx, MECHANIC2);
      await failsWith(tx, () => archive(tx, customerId), OPEN_WORK);
      await ownerMode(tx);
      await tx.query(
        "update public.quotes set status = 'withdrawn', withdrawn_at = now() where id = $1",
        [quote[0].id],
      );
      const { rows: link } = await tx.query<{ id: string }>(
        `insert into public.balance_links (id, work_order_id, token_hash, channel, expires_at, amount_at_send, sent_by)
         values (gen_random_uuid(), $1, sha256(gen_random_uuid()::text::bytea), 'link',
                 now() + interval '7 days', 10.00, $2)
         returning id`,
        [jobId, STAFF.admin],
      );
      await actAs(tx, MECHANIC2);
      await failsWith(tx, () => archive(tx, customerId), OPEN_WORK);
      await ownerMode(tx);
      await tx.query(
        `update public.balance_links set withdrawn_at = now(), withdrawn_reason = 'collected'
          where id = $1`,
        [link[0].id],
      );
      await actAs(tx, MECHANIC2);
      await archive(tx, customerId);
      expect(await archivedNow(tx, customerId)).toBe(true);
    });
  });

  it("is refused while the customer is a consignor that is not archived", async () => {
    await inTransaction(conn, async (tx) => {
      const customerId = await makeCustomer(tx);
      const consignorId = await createConsignor(tx, { customerId });
      await actAs(tx, MECHANIC2);
      await failsWith(tx, () => archive(tx, customerId), OPEN_WORK);
      await ownerMode(tx);
      await tx.query("update public.consignors set archived_at = now() where id = $1", [
        consignorId,
      ]);
      await actAs(tx, MECHANIC2);
      await archive(tx, customerId);
      expect(await archivedNow(tx, customerId)).toBe(true);
    });
  });

  it("is refused while an adventure booking is waiting for payment or paid, until it is cancelled", async () => {
    await inTransaction(conn, async (tx) => {
      const { sale, days } = await setup(tx, 1);
      const rider = await makeRider(tx);
      const adventure = {
        ...OPEN_WORK,
        detail: expect.stringContaining("an adventure booking"),
      };
      // Waiting for payment: the place and the tracker are held for them.
      const pending = await checkout(tx, rider, sale, days[0], days[1]);
      await actAs(tx, MECHANIC2);
      await failsWith(tx, () => archive(tx, rider.customerId), adventure);
      // Paid: the rider needs their login to ride and to ask to cancel.
      await pay(tx, pending);
      await actAs(tx, MECHANIC2);
      await failsWith(tx, () => archive(tx, rider.customerId), adventure);
      await ownerMode(tx);
      await failsWith(tx, () => archive(tx, rider.customerId), adventure);
      await actAs(tx, ADMIN);
      await tx.query("select public.cancel_adventure_booking($1, 'Rider asked')", [
        pending.booking_id,
      ]);
      await actAs(tx, MECHANIC2);
      await archive(tx, rider.customerId);
      expect(await archivedNow(tx, rider.customerId)).toBe(true);
    });
  });

  it("is allowed once the paid ride is certified", async () => {
    await inTransaction(conn, async (tx) => {
      const sale = await offerOn125(tx);
      await openSales(tx);
      const rider = await makeRider(tx);
      const { submissionId } = await submitted(tx, rider, sale);
      // Sent for review is not finished: the rider still follows the outcome.
      await actAs(tx, MECHANIC2);
      await failsWith(tx, () => archive(tx, rider.customerId), OPEN_WORK);
      await actAs(tx, staffClaims(AUTH_USER.manager));
      await tx.query(
        `select * from public.decide_adventure_review($1, 'approved', $2::jsonb, 128.5, '2026-11-15', '', 'internal')`,
        [
          submissionId,
          JSON.stringify({
            identity: true,
            coverage: true,
            checkpoints: true,
            chronology: true,
            time_window: true,
            distance: true,
          }),
        ],
      );
      await actAs(tx, MECHANIC2);
      await archive(tx, rider.customerId);
      expect(await archivedNow(tx, rider.customerId)).toBe(true);

      // A second rider who only paid is still held.
      const other = await makeRider(tx);
      await paidBooking(tx, other, sale);
      await actAs(tx, MECHANIC2);
      await failsWith(tx, () => archive(tx, other.customerId), OPEN_WORK);
    });
  });

  it("is refused while a hired tracker is out, whatever the booking's state", async () => {
    await inTransaction(conn, async (tx) => {
      const {
        sale,
        days,
        devices: [device],
      } = await setup(tx, 1);
      const rider = await makeRider(tx);
      const hire = await checkout(tx, rider, sale, days[0], days[1]);
      await pay(tx, hire);
      const reservationId = (await reservation(tx, hire.booking_id)).id;
      await actAs(tx, staffClaims(AUTH_USER.manager));
      const assignmentId = await scalar<string>(
        tx,
        "select id from public.issue_adventure_tracker($1, $2, 'Charged, case ok')",
        [reservationId, device],
      );
      // cancel_adventure_booking refuses while the tracker is out, so the
      // booking is closed as the owner to test the tracker clause on its own.
      await ownerMode(tx);
      await tx.query(
        `update public.adventure_bookings
            set status = 'cancelled', cancelled_at = now(), confirmed_at = null
          where id = $1`,
        [hire.booking_id],
      );
      await actAs(tx, MECHANIC2);
      await failsWith(tx, () => archive(tx, rider.customerId), {
        ...OPEN_WORK,
        detail: expect.stringContaining("a hired tracker that has not been returned"),
      });
      await ownerMode(tx);
      await tx.query(
        `update public.tracker_assignments
            set returned_at = now(), received_by = $2, return_condition = 'good'
          where id = $1`,
        [assignmentId, STAFF.admin],
      );
      await actAs(tx, MECHANIC2);
      await archive(tx, rider.customerId);
      expect(await archivedNow(tx, rider.customerId)).toBe(true);
    });
  });

  it("keeps the first archive date on a replay and always allows unarchiving", async () => {
    await inTransaction(conn, async (tx) => {
      const { customerId, jobId } = await customerWithJob(tx);
      await walkTo(tx, jobId, "cancelled");
      await actAs(tx, MECHANIC2);
      await archive(tx, customerId);
      const first = await scalar<Date>(
        tx,
        "select archived_at from public.customers where id = $1",
        [customerId],
      );
      await tx.query(
        "update public.customers set archived_at = '2030-01-01T00:00:00Z' where id = $1",
        [customerId],
      );
      expect(
        await scalar<Date>(tx, "select archived_at from public.customers where id = $1", [
          customerId,
        ]),
      ).toEqual(first);
      await unarchive(tx, customerId);
      expect(
        await scalar(tx, "select archived_at from public.customers where id = $1", [customerId]),
      ).toBeNull();
    });
  });
});
