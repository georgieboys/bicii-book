/**
 * Booking alerts and confirmations (PLAN D163; DATA-MODEL §3 "Booking
 * emails"). An appointment booked online queues, in the same transaction:
 * one shop alert for each chosen staff member (active, by staff id) and
 * each listed address, and one confirmation to the customer's email. A
 * customer's own cancellation queues a shop alert (with their reason) and
 * a confirmation to them; a cancellation by staff queues only the
 * customer's email. Staff bookings queue nothing. The Admin's sender claims
 * due rows under a claim token and records each result with it
 * (service_role only); nobody else reads the outbox. An attempt counts when
 * a result is recorded, an unreached row is released, and a late success is
 * recorded even after the row was given up (R-100).
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

describe("the sender's claim and result (service_role only; R-100)", () => {
  type Claimed = {
    id: string;
    claim_token: string;
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

  type Outcome = "sent" | "failed" | "released";

  const claim = (tx: pg.Client, max = 10) =>
    tx
      .query<Claimed>("select * from public.claim_appointment_notices($1)", [max])
      .then((r) => r.rows);
  const claimOne = async (tx: pg.Client, id: string) =>
    (await claim(tx, 20)).find((c) => c.id === id);
  const finish = (
    tx: pg.Client,
    id: string,
    token: string,
    result: Outcome,
    error: string | null = null,
  ) =>
    scalar<boolean>(tx, "select public.finish_appointment_notice($1, $2, $3, $4)", [
      id,
      token,
      result,
      error,
    ]);

  type Row = {
    status: string;
    attempts: number;
    claims: number;
    claimed: boolean;
    last_error: string | null;
    sent: boolean;
  };
  /** One outbox row's sending state, read as the owner. */
  const row = (tx: pg.Client, id: string) =>
    readAsOwner(tx, async () => {
      const { rows } = await tx.query<Row>(
        `select status::text, attempts, claims, claim_token is not null as claimed, last_error,
                sent_at is not null as sent
           from private.appointment_notices where id = $1`,
        [id],
      );
      return rows[0];
    });
  /** Makes the row due again and lets its claim lapse (time stands still in a transaction). */
  const lapse = (tx: pg.Client, id: string) =>
    readAsOwner(tx, () =>
      tx.query(
        `update private.appointment_notices
            set next_attempt_at = least(next_attempt_at, now() - interval '1 second'),
                claimed_until = case when claimed_until is not null then now() - interval '1 second' end
          where id = $1`,
        [id],
      ),
    );

  async function queued(tx: pg.Client) {
    const { day, typeId, authUserId } = await onlineCustomer(tx);
    await actAs(tx, ADMIN);
    await setRecipients(tx, [], ["team@example.com"]);
    await actAs(tx, customerClaims(authUserId));
    const appt = await bookMine(tx, { typeId, startsAt: sgt(day, "09:30"), customerNote: "Hi" });
    const id = await readAsOwner(tx, () =>
      scalar<string>(
        tx,
        "select id::text from private.appointment_notices where appointment_id = $1 and audience = 'shop'",
        [appt.id],
      ),
    );
    return { appointmentId: appt.id, id };
  }

  it("claims each due email once with what it needs and a claim token, and records sent", async () => {
    await inTransaction(conn, async (tx) => {
      const { appointmentId, id } = await queued(tx);
      await actAs(tx, SERVICE);
      const first = (await claim(tx, 50)).filter((c) => c.recipient === "team@example.com");
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({
        id,
        kind: "booked",
        audience: "shop",
        // Claiming uses no attempt.
        attempts: 0,
        customer_name: "Alex Rider",
        customer_first_name: "Alex",
        customer_note: "Hi",
      });
      expect(first[0].claim_token).toMatch(/^[0-9a-f-]{36}$/);
      expect(first[0].appointment_type).toMatch(/^Tune-up /);
      // Claimed rows are not handed out again while claimed.
      expect((await claim(tx, 50)).filter((c) => c.recipient === "team@example.com")).toEqual([]);

      expect(await finish(tx, id, first[0].claim_token, "sent")).toBe(true);
      expect(
        (await notices(tx, appointmentId)).find((n) => n.recipient === "team@example.com"),
      ).toMatchObject({ status: "sent", attempts: 0 });
      expect(await row(tx, id)).toMatchObject({ claimed: false, sent: true, last_error: null });
      // Finishing again changes nothing.
      expect(await finish(tx, id, first[0].claim_token, "failed", "late")).toBe(false);
      expect(await row(tx, id)).toMatchObject({ status: "sent", attempts: 0 });
    });
  });

  it("a failure counts an attempt, waits and retries; the fifth failure gives up", async () => {
    await inTransaction(conn, async (tx) => {
      const { id } = await queued(tx);
      await actAs(tx, SERVICE);
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        // Make it due again (the backoff would otherwise hold it).
        await lapse(tx, id);
        const claimed = await claimOne(tx, id);
        expect(claimed?.attempts).toBe(attempt - 1);
        expect(
          await finish(tx, id, claimed!.claim_token, "failed", "Resend unavailable (503)"),
        ).toBe(true);
        expect(await row(tx, id)).toMatchObject({
          status: attempt < 5 ? "pending" : "failed",
          attempts: attempt,
          claimed: false,
          last_error: "Resend unavailable (503)",
        });
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

  it("claims that lapse without a result use no attempt (A-10)", async () => {
    await inTransaction(conn, async (tx) => {
      const { id } = await queued(tx);
      await actAs(tx, SERVICE);
      for (let i = 1; i <= 6; i += 1) {
        await lapse(tx, id);
        const claimed = await claimOne(tx, id);
        expect(claimed?.attempts).toBe(0);
      }
      // Before R-100 the sixth claim marked the row failed; now it is still
      // pending, claimed, with no attempt used.
      expect(await row(tx, id)).toMatchObject({
        status: "pending",
        attempts: 0,
        claims: 6,
        claimed: true,
      });
    });
  });

  it("only the current claim's result is recorded; a stale token is a no-op", async () => {
    await inTransaction(conn, async (tx) => {
      const { id } = await queued(tx);
      await actAs(tx, SERVICE);
      const stale = (await claimOne(tx, id))!.claim_token;
      await lapse(tx, id);
      const current = (await claimOne(tx, id))!.claim_token;
      expect(current).not.toBe(stale);

      for (const result of ["sent", "failed", "released"] as const) {
        expect(await finish(tx, id, stale, result, "old run")).toBe(false);
      }
      expect(await row(tx, id)).toMatchObject({
        status: "pending",
        attempts: 0,
        claims: 2,
        claimed: true,
        last_error: null,
      });
      expect(await finish(tx, id, randomUUID(), "sent")).toBe(false);

      expect(await finish(tx, id, current, "sent")).toBe(true);
      expect(await row(tx, id)).toMatchObject({ status: "sent", sent: true });
    });
  });

  it("an email the run did not reach is released: no attempt, the claim given back, due at once", async () => {
    await inTransaction(conn, async (tx) => {
      const { id } = await queued(tx);
      await actAs(tx, SERVICE);
      const claimed = await claimOne(tx, id);
      expect(await finish(tx, id, claimed!.claim_token, "released")).toBe(true);
      expect(await row(tx, id)).toMatchObject({
        status: "pending",
        attempts: 0,
        claims: 0,
        claimed: false,
      });
      // Released again under the same token: nothing to release.
      expect(await finish(tx, id, claimed!.claim_token, "released")).toBe(false);
      // Due at once, without waiting for a backoff or a lapsed claim.
      expect((await claimOne(tx, id))?.attempts).toBe(0);

      await failsWith(tx, () => finish(tx, id, claimed!.claim_token, "bounced" as Outcome), {
        code: "22023",
      });
    });
  });

  it("15 unanswered claims give up, and a success arriving after that is still recorded (A-20)", async () => {
    await inTransaction(conn, async (tx) => {
      const { id } = await queued(tx);
      await actAs(tx, SERVICE);
      const token = (await claimOne(tx, id))!.claim_token;
      // The fifteenth claim, its send still in flight when the claim lapses.
      await readAsOwner(tx, () =>
        tx.query(
          "update private.appointment_notices set claims = 15, claimed_until = now() - interval '1 second' where id = $1",
          [id],
        ),
      );
      expect(await claimOne(tx, id)).toBeUndefined();
      expect(await row(tx, id)).toMatchObject({
        status: "failed",
        attempts: 0,
        last_error: "No result was recorded after 15 claims.",
      });

      // The send then succeeds: the delivered email is recorded as sent.
      expect(await finish(tx, id, token, "sent")).toBe(true);
      expect(await row(tx, id)).toMatchObject({
        status: "sent",
        sent: true,
        claimed: false,
        last_error: null,
      });
    });
  });

  it("no API role but service_role may claim or finish, and none reads the outbox", async () => {
    await inTransaction(conn, async (tx) => {
      const { appointmentId } = await queued(tx);
      for (const claims of [ADMIN, { role: "anon" as const }]) {
        await actAs(tx, claims);
        await failsWith(tx, () => claim(tx), { code: "42501" });
        await failsWith(tx, () => finish(tx, randomUUID(), randomUUID(), "sent"), {
          code: "42501",
        });
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
