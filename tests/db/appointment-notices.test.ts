/**
 * Booking alerts and confirmations (PLAN D163; DATA-MODEL §3 "Booking
 * emails"). An appointment booked online queues, in the same transaction:
 * one shop alert for each chosen staff member (active, by staff id) and
 * each listed address, and one confirmation to the customer's email. A
 * customer's own cancellation queues a shop alert (with their reason) and
 * a confirmation to them; a cancellation by staff queues only the
 * customer's email. Staff bookings queue nothing. The Admin's sender claims
 * due rows and records each result (service_role only); nobody else reads
 * the outbox.
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { AUTH_USER, STAFF, STAFF_EMAIL } from "../fixtures/ids";
import {
  book,
  bookMine,
  cancel,
  cancelMine,
  futureDay,
  makeType,
  sgt,
  standardSchedule,
} from "./appointment-fixtures";
import { customerClaims, linkCustomerLogin } from "./customer-fixtures";
import { actAs, connect, inTransaction, scalar, staffClaims } from "./harness";
import { readAsOwner } from "./inventory-fixtures";
import { failsWith, makeCustomer, ownerMode } from "./workshop-fixtures";

let conn: pg.Client;

beforeAll(async () => {
  conn = await connect();
});

const ADMIN = staffClaims(AUTH_USER.admin);
const MANAGER = staffClaims(AUTH_USER.manager);
const SERVICE = { role: "service_role" as const };
const p0001 = (message: string) => ({ code: "P0001", message });

type Notice = {
  kind: "booked" | "cancelled";
  audience: "shop" | "customer";
  recipient: string;
  cancelled_by: "staff" | "customer" | null;
  reason: string | null;
  status: "pending" | "sent" | "failed";
  attempts: number;
};

/** The appointment's queued emails, read as the owner, in a stable order. */
const notices = (tx: pg.Client, appointmentId: string) =>
  readAsOwner(tx, async () => {
    const { rows } = await tx.query<Notice>(
      `select kind::text, audience::text, recipient::text, cancelled_by::text, reason,
              status::text, attempts
         from private.appointment_notices
        where appointment_id = $1
        order by kind, audience, recipient`,
      [appointmentId],
    );
    return rows;
  });

/** public.set_booking_alert_recipients as whoever `tx` is. */
const setRecipients = (tx: pg.Client, staffIds: string[], emails: string[]) =>
  tx.query("select public.set_booking_alert_recipients($1::uuid[], $2::text[])", [
    staffIds,
    emails,
  ]);

/** A customer with a login and an email, the standard schedule and a public type. */
async function onlineCustomer(tx: pg.Client, { withEmail = true }: { withEmail?: boolean } = {}) {
  await standardSchedule(tx);
  const day = await futureDay(tx);
  const typeId = await makeType(tx, {
    durationMinutes: 30,
    name: `Tune-up ${randomUUID().slice(0, 6)}`,
  });
  const customerId = await makeCustomer(tx, "Alex Rider");
  const address = withEmail ? `alex-${randomUUID().slice(0, 8)}@example.com` : null;
  await tx.query("update public.customers set first_name = 'Alex', email = $1 where id = $2", [
    address,
    customerId,
  ]);
  const authUserId = await linkCustomerLogin(tx, customerId);
  return { day, typeId, customerId, authUserId, address };
}

describe("booking emails are queued with the booking (D163)", () => {
  it("an online booking queues an alert for each chosen staff member and address, and the customer's confirmation", async () => {
    await inTransaction(conn, async (tx) => {
      const { day, typeId, authUserId, address } = await onlineCustomer(tx);
      await actAs(tx, ADMIN);
      await setRecipients(
        tx,
        [STAFF.mechanic1, STAFF.manager],
        ["team@example.com", " Team@Example.COM ", "desk@example.com"],
      );
      await actAs(tx, customerClaims(authUserId));
      const appt = await bookMine(tx, {
        typeId,
        startsAt: sgt(day, "10:00"),
        customerNote: "Squeaky brakes",
      });

      expect(await notices(tx, appt.id)).toEqual(
        [
          ["shop", STAFF_EMAIL.mechanic1],
          ["shop", STAFF_EMAIL.manager],
          ["shop", "team@example.com"],
          ["shop", "desk@example.com"],
          ["customer", address],
        ]
          .map(([audience, recipient]) => ({
            kind: "booked",
            audience,
            recipient: recipient!.toLowerCase(),
            cancelled_by: null,
            reason: null,
            status: "pending",
            attempts: 0,
          }))
          .sort((a, b) =>
            `${a.kind}${a.audience}${a.recipient}`.localeCompare(
              `${b.kind}${b.audience}${b.recipient}`,
            ),
          ),
      );

      // A replayed booking (same id) queues nothing more.
      await bookMine(tx, {
        id: appt.id,
        typeId,
        startsAt: sgt(day, "10:00"),
        customerNote: "Squeaky brakes",
      });
      expect(await notices(tx, appt.id)).toHaveLength(5);
    });
  });

  it("a staff booking queues nothing, and neither do bookings with no recipients and no customer email", async () => {
    await inTransaction(conn, async (tx) => {
      const { day, typeId, customerId } = await onlineCustomer(tx);
      await actAs(tx, ADMIN);
      await setRecipients(tx, [STAFF.manager], ["team@example.com"]);
      const byStaff = await book(tx, { customerId, typeId, startsAt: sgt(day, "11:00") });
      expect(await notices(tx, byStaff.id)).toEqual([]);

      await ownerMode(tx);
      const none = await onlineCustomer(tx, { withEmail: false });
      await actAs(tx, ADMIN);
      await setRecipients(tx, [], []);
      await actAs(tx, customerClaims(none.authUserId));
      const quiet = await bookMine(tx, { typeId: none.typeId, startsAt: sgt(none.day, "12:00") });
      expect(await notices(tx, quiet.id)).toEqual([]);
    });
  });

  it("a deactivated staff member gets no alert, even while still listed", async () => {
    await inTransaction(conn, async (tx) => {
      const { day, typeId, authUserId } = await onlineCustomer(tx);
      await actAs(tx, ADMIN);
      await setRecipients(tx, [STAFF.mechanic1, STAFF.mechanic2], []);
      await readAsOwner(tx, () =>
        tx.query("update public.staff set active = false where id = $1", [STAFF.mechanic2]),
      );
      await actAs(tx, customerClaims(authUserId));
      const appt = await bookMine(tx, { typeId, startsAt: sgt(day, "10:30") });
      const shop = (await notices(tx, appt.id)).filter((n) => n.audience === "shop");
      expect(shop.map((n) => n.recipient)).toEqual([STAFF_EMAIL.mechanic1]);
    });
  });

  it("a customer's cancellation alerts the shop with their reason and confirms it to them", async () => {
    await inTransaction(conn, async (tx) => {
      const { day, typeId, authUserId, address } = await onlineCustomer(tx);
      await actAs(tx, ADMIN);
      await setRecipients(tx, [], ["team@example.com"]);
      await actAs(tx, customerClaims(authUserId));
      const appt = await bookMine(tx, { typeId, startsAt: sgt(day, "14:00") });
      await cancelMine(tx, appt.id, "  Away that week  ");

      const cancelled = (await notices(tx, appt.id)).filter((n) => n.kind === "cancelled");
      expect(cancelled).toEqual([
        {
          kind: "cancelled",
          audience: "customer",
          recipient: address,
          cancelled_by: "customer",
          reason: null,
          status: "pending",
          attempts: 0,
        },
        {
          kind: "cancelled",
          audience: "shop",
          recipient: "team@example.com",
          cancelled_by: "customer",
          reason: "Away that week",
          status: "pending",
          attempts: 0,
        },
      ]);
    });
  });

  it("a cancellation without a reason carries none; a staff cancellation only tells the customer", async () => {
    await inTransaction(conn, async (tx) => {
      const { day, typeId, authUserId, address } = await onlineCustomer(tx);
      await actAs(tx, ADMIN);
      await setRecipients(tx, [], ["team@example.com"]);
      await actAs(tx, customerClaims(authUserId));
      const mine = await bookMine(tx, { typeId, startsAt: sgt(day, "15:00") });
      const theirs = await bookMine(tx, { typeId, startsAt: sgt(day, "16:00") });
      await cancelMine(tx, mine.id);
      expect(
        (await notices(tx, mine.id)).find((n) => n.kind === "cancelled" && n.audience === "shop")
          ?.reason,
      ).toBeNull();

      await actAs(tx, ADMIN);
      await cancel(tx, theirs.id, "Mechanic off sick (internal)");
      const cancelled = (await notices(tx, theirs.id)).filter((n) => n.kind === "cancelled");
      expect(cancelled).toEqual([
        {
          kind: "cancelled",
          audience: "customer",
          recipient: address,
          cancelled_by: "staff",
          reason: null,
          status: "pending",
          attempts: 0,
        },
      ]);
    });
  });
});

describe("who sets the recipients (D163b)", () => {
  it("only an admin, with active staff and real addresses, at most 10 of each", async () => {
    await inTransaction(conn, async (tx) => {
      await actAs(tx, MANAGER);
      await failsWith(tx, () => setRecipients(tx, [], ["team@example.com"]), { code: "42501" });

      await actAs(tx, ADMIN);
      await failsWith(
        tx,
        () => setRecipients(tx, [randomUUID()], []),
        p0001("booking_alert_staff_invalid"),
      );
      await failsWith(
        tx,
        () => setRecipients(tx, [], ["not an address"]),
        p0001("booking_alert_email_invalid"),
      );
      await failsWith(
        tx,
        () =>
          setRecipients(
            tx,
            [],
            Array.from({ length: 11 }, (_, i) => `person${i}@example.com`),
          ),
        p0001("booking_alert_too_many"),
      );

      await setRecipients(
        tx,
        [STAFF.manager, STAFF.manager],
        [" Team@Example.com", "", "team@example.com"],
      );
      const saved = await scalar<{ staff: string[]; emails: string[] }>(
        tx,
        `select json_build_object('staff', booking_alert_staff_ids, 'emails', booking_alert_emails)
           from public.shop_settings where id = 1`,
      );
      expect(saved).toEqual({ staff: [STAFF.manager], emails: ["team@example.com"] });
    });
  });
});

describe("the sender's claim and result (service_role only)", () => {
  type Claimed = {
    id: string;
    kind: string;
    audience: string;
    recipient: string;
    attempts: number;
    customer_name: string;
    customer_first_name: string | null;
    appointment_type: string;
    customer_note: string | null;
    public_site_url: string | null;
  };

  const claim = (tx: pg.Client, max = 10) =>
    tx
      .query<Claimed>("select * from public.claim_appointment_notices($1)", [max])
      .then((r) => r.rows);
  const finish = (tx: pg.Client, id: string, ok: boolean, error: string | null = null) =>
    tx.query("select public.finish_appointment_notice($1, $2, $3)", [id, ok, error]);

  async function queued(tx: pg.Client) {
    const { day, typeId, authUserId } = await onlineCustomer(tx);
    await actAs(tx, ADMIN);
    await setRecipients(tx, [], ["team@example.com"]);
    await actAs(tx, customerClaims(authUserId));
    const appt = await bookMine(tx, { typeId, startsAt: sgt(day, "09:30"), customerNote: "Hi" });
    return appt.id;
  }

  it("claims each due email once with what it needs, and records sent", async () => {
    await inTransaction(conn, async (tx) => {
      const appointmentId = await queued(tx);
      await actAs(tx, SERVICE);
      const first = (await claim(tx, 50)).filter((c) => c.recipient === "team@example.com");
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({
        kind: "booked",
        audience: "shop",
        attempts: 1,
        customer_name: "Alex Rider",
        customer_first_name: "Alex",
        customer_note: "Hi",
      });
      expect(first[0].appointment_type).toMatch(/^Tune-up /);
      // Claimed rows are not handed out again while claimed.
      expect((await claim(tx, 50)).filter((c) => c.recipient === "team@example.com")).toEqual([]);

      await finish(tx, first[0].id, true);
      const sent = (await notices(tx, appointmentId)).find(
        (n) => n.recipient === "team@example.com",
      );
      expect(sent).toMatchObject({ status: "sent", attempts: 1 });
      // Finishing again changes nothing.
      await finish(tx, first[0].id, false, "late");
      expect(
        (await notices(tx, appointmentId)).find((n) => n.recipient === "team@example.com"),
      ).toMatchObject({ status: "sent" });
    });
  });

  it("a failure waits and retries; the fifth failure gives up", async () => {
    await inTransaction(conn, async (tx) => {
      const appointmentId = await queued(tx);
      const id = await readAsOwner(tx, () =>
        scalar<string>(
          tx,
          "select id::text from private.appointment_notices where appointment_id = $1 and audience = 'shop'",
          [appointmentId],
        ),
      );
      await actAs(tx, SERVICE);
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        // Make it due again (the backoff would otherwise hold it).
        await readAsOwner(tx, () =>
          tx.query(
            "update private.appointment_notices set next_attempt_at = now() - interval '1 second' where id = $1",
            [id],
          ),
        );
        const claimed = (await claim(tx, 50)).find((c) => c.id === id);
        expect(claimed?.attempts).toBe(attempt);
        await finish(tx, id, false, "Resend unavailable (503)");
        const row = (await notices(tx, appointmentId)).find((n) => n.audience === "shop");
        expect(row?.status).toBe(attempt < 5 ? "pending" : "failed");
      }
      const later = await readAsOwner(tx, () =>
        scalar<boolean>(
          tx,
          "select next_attempt_at > now() from private.appointment_notices where id = $1",
          [id],
        ),
      );
      expect(later).toBe(true);
    });
  });

  it("no API role but service_role may claim or finish, and none reads the outbox", async () => {
    await inTransaction(conn, async (tx) => {
      const appointmentId = await queued(tx);
      for (const claims of [ADMIN, { role: "anon" as const }]) {
        await actAs(tx, claims);
        await failsWith(tx, () => claim(tx), { code: "42501" });
        await failsWith(tx, () => finish(tx, randomUUID(), true), { code: "42501" });
        await failsWith(
          tx,
          () =>
            tx.query("select count(*) from private.appointment_notices where appointment_id = $1", [
              appointmentId,
            ]),
          { code: "42501" },
        );
      }
    });
  });
});
