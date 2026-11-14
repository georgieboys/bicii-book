/**
 * The owner's sales terms (2026-11-14, D212-D218):
 *
 *   waivers      sealed versions, published by an admin; sales need one;
 *                the first version is the text in docs/adventures
 *   signing      no booking without the rider's signature for that request
 *                under the current version; every declaration ticked; the
 *                signature links to its booking and never changes after
 *   sizes        T-shirts S to XXL
 *   board        on the finisher board only under a name the rider chose
 *   refunds      cancellable and refundable until the ride is sent for
 *                review, never after
 *   late fees    a tracker back after its return day and the grace owes a
 *                fee per further day, emailed and settled by an admin
 *
 * Rolled-back transactions.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import type pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { AUTH_USER } from "../fixtures/ids";
import {
  makeRider,
  offerOn125,
  openSales,
  paidBooking,
  submitted,
  TERMS,
  type Rider,
  type Sale,
} from "./adventure-fixtures";
import { customerClaims } from "./customer-fixtures";
import { actAs, connect, inTransaction, scalar, staffClaims, type Connection } from "./harness";
import { checkout, pay, reservation, setup } from "./tracker-fixtures";
import { failsWith } from "./workshop-fixtures";

let conn: pg.Client;

beforeAll(async () => {
  conn = await connect();
});

const refused = (message: string) => ({ code: "P0001", message });

async function prepare(tx: Connection, rider: Rider, sale: Sale, requestId: string, size = "M") {
  await actAs(tx, customerClaims(rider.authUserId));
  const { rows } = await tx.query<{ booking_id: string }>(
    `select booking_id from public.prepare_my_adventure_checkout($1, 'bicii-125', 'self_supported', $2, $3, 'first_name_initial', $4)`,
    [requestId, sale.revisionNumber, size, TERMS],
  );
  return rows[0].booking_id;
}

describe("waivers (D215)", () => {
  it("publishes the first version unchanged from docs/adventures", async () => {
    const md = readFileSync("docs/adventures/waiver-2026-11-14.md", "utf8");
    const body = md.split("\n---\n")[1].trim();
    await inTransaction(conn, async (tx) => {
      await actAs(tx, { role: "anon" });
      const { rows } = await tx.query(
        "select version, title, body, body_sha256 from public.adventure_waiver('2026-11-14')",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].body).toBe(body);
      expect(rows[0].body_sha256).toBe(createHash("sha256").update(body, "utf8").digest("hex"));
    });
  });

  it("is published by an admin only, never changes, and is what sales need", async () => {
    await inTransaction(conn, async (tx) => {
      const body = "Terms. ".repeat(40);
      await actAs(tx, staffClaims(AUTH_USER.manager));
      await failsWith(
        tx,
        () => tx.query("select public.publish_adventure_waiver('v-test', 'Waiver', $1)", [body]),
        { code: "42501" },
      );
      await actAs(tx, staffClaims(AUTH_USER.admin));
      await failsWith(
        tx,
        () => tx.query("select public.publish_adventure_waiver('v-test', 'Waiver', 'too short')"),
        refused("adventure_waiver_text"),
      );
      await failsWith(
        tx,
        () => tx.query("select public.set_adventure_sales(true, 'v-test')"),
        refused("adventure_waiver_unknown"),
      );
      await tx.query("select public.publish_adventure_waiver('v-test', 'Waiver', $1)", [body]);
      await failsWith(
        tx,
        () => tx.query("select public.publish_adventure_waiver('v-test', 'Waiver', $1)", [body]),
        refused("adventure_waiver_exists"),
      );
      await tx.query("select public.set_adventure_sales(true, 'v-test')");
      await tx.query("reset role");
      await failsWith(
        tx,
        () =>
          tx.query(
            "update public.adventure_waivers set body = body || '.' where version = 'v-test'",
          ),
        refused("adventure_waiver_sealed"),
      );
      await failsWith(
        tx,
        () => tx.query("delete from public.adventure_waivers where version = 'v-test'"),
        refused("adventure_waiver_sealed"),
      );
      await actAs(tx, { role: "anon" });
      expect(await scalar<string>(tx, "select version from public.adventure_waiver()")).toBe(
        "v-test",
      );
    });
  });
});

describe("signing (D215, D217)", () => {
  it("no booking without the rider's own signature, every box ticked, under the current version", async () => {
    await inTransaction(conn, async (tx) => {
      const sale = await offerOn125(tx);
      await openSales(tx);
      const rider = await makeRider(tx);
      const other = await makeRider(tx);

      const unsigned = randomUUID();
      await failsWith(
        tx,
        () => prepare(tx, rider, sale, unsigned),
        refused("adventure_waiver_unsigned"),
      );

      const sign = (r: Rider, id: string, over: Partial<Record<string, unknown>> = {}) => {
        const v = {
          terms: TERMS,
          name: "Aisha Tan",
          contact: "Ben Tan",
          phone: "+65 9123 4567",
          ticks: [true, true, true, true, true],
          ...over,
        } as { terms: string; name: string; contact: string; phone: string; ticks: boolean[] };
        return actAs(tx, customerClaims(r.authUserId)).then(() =>
          tx.query(
            "select * from public.sign_my_adventure_waiver($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
            [id, v.terms, v.name, v.contact, v.phone, ...v.ticks],
          ),
        );
      };
      const id = randomUUID();
      await failsWith(
        tx,
        () => sign(rider, id, { ticks: [true, true, false, true, true] }),
        refused("adventure_waiver_incomplete"),
      );
      await failsWith(
        tx,
        () => sign(rider, id, { name: "Aisha" }),
        refused("adventure_waiver_name"),
      );
      await failsWith(
        tx,
        () => sign(rider, id, { phone: "call me" }),
        refused("adventure_emergency_contact"),
      );
      await failsWith(
        tx,
        () => sign(rider, id, { terms: "2026-01" }),
        refused("adventure_terms_changed"),
      );
      // Another rider's signature for the same request id is no signature for this rider.
      await sign(other, id);
      await failsWith(tx, () => prepare(tx, rider, sale, id), refused("adventure_waiver_unsigned"));

      const mine = randomUUID();
      await sign(rider, mine, { name: "  Aisha   Tan " });
      // Re-signing before paying replaces the details.
      await sign(rider, mine, { contact: "Chen Tan" });
      await failsWith(
        tx,
        () => prepare(tx, rider, sale, mine, "XS"),
        refused("adventure_size_invalid"),
      );
      await failsWith(
        tx,
        () => prepare(tx, rider, sale, mine, "XXXL"),
        refused("adventure_size_invalid"),
      );
      const bookingId = await prepare(tx, rider, sale, mine, "XXL");
      // A retry of the same request is the same booking and the same signature.
      expect(await prepare(tx, rider, sale, mine, "XXL")).toBe(bookingId);
      const again = await sign(rider, mine, { name: "Someone Else" });
      await tx.query("reset role");
      const { rows } = await tx.query(
        `select s.id, s.booking_id, s.signed_name, s.emergency_contact_name, s.waiver_version, s.waiver_sha256 = w.body_sha256 as hash_matches
           from public.adventure_waiver_signatures s join public.adventure_waivers w on w.version = s.waiver_version
          where s.request_id = $1 and s.customer_id = $2`,
        [mine, rider.customerId],
      );
      expect(rows).toEqual([
        {
          id: again.rows[0].signature_id,
          booking_id: bookingId,
          signed_name: "Aisha Tan",
          emergency_contact_name: "Chen Tan",
          waiver_version: TERMS,
          hash_matches: true,
        },
      ]);
      await failsWith(
        tx,
        () =>
          tx.query(
            "update public.adventure_waiver_signatures set signed_name = 'X Y' where booking_id = $1",
            [bookingId],
          ),
        refused("adventure_waiver_signed"),
      );
      await failsWith(
        tx,
        () =>
          tx.query("delete from public.adventure_waiver_signatures where booking_id = $1", [
            bookingId,
          ]),
        refused("adventure_waiver_signed"),
      );

      // The rider sees their own terms; staff who run rides see the
      // signature and emergency contact; a mechanic and a rider don't.
      await actAs(tx, customerClaims(rider.authUserId));
      expect(
        (
          await tx.query(
            "select waiver_version, signed_name, refundable from public.my_adventure_terms($1)",
            [bookingId],
          )
        ).rows,
      ).toEqual([{ waiver_version: TERMS, signed_name: "Aisha Tan", refundable: false }]);
      expect(
        await scalar<number>(tx, "select count(*)::int from public.adventure_waiver_signatures"),
      ).toBe(0);
      await actAs(tx, customerClaims(other.authUserId));
      expect(
        (await tx.query("select * from public.my_adventure_terms($1)", [bookingId])).rows,
      ).toEqual([]);
      await actAs(tx, staffClaims(AUTH_USER.manager));
      expect(
        await scalar<string>(
          tx,
          "select emergency_contact_phone from public.adventure_waiver_signatures where booking_id = $1",
          [bookingId],
        ),
      ).toBe("+65 9123 4567");
      await actAs(tx, staffClaims(AUTH_USER.mechanic1));
      expect(
        await scalar<number>(tx, "select count(*)::int from public.adventure_waiver_signatures"),
      ).toBe(0);
    });
  });
});

describe("the finisher board name (D218)", () => {
  it("is the rider's choice of name or none, theirs to change, and staff can take it down", async () => {
    await inTransaction(conn, async (tx) => {
      const sale = await offerOn125(tx);
      await openSales(tx);
      const rider = await makeRider(tx);
      const other = await makeRider(tx);
      const bookingId = await paidBooking(tx, rider, sale);
      const shown = () =>
        scalar<string | null>(
          tx,
          "select board_name from public.adventure_bookings where id = $1",
          [bookingId],
        );

      await tx.query("reset role");
      expect(await shown()).toBeNull();
      await actAs(tx, customerClaims(rider.authUserId));
      await failsWith(
        tx,
        () => tx.query("select public.set_my_board_name($1, 'see https://x.example')", [bookingId]),
        refused("adventure_board_name_invalid"),
      );
      await failsWith(
        tx,
        () => tx.query("select public.set_my_board_name($1, 'me@example.com')", [bookingId]),
        refused("adventure_board_name_invalid"),
      );
      await tx.query("select public.set_my_board_name($1, ' Captain   Cadence ')", [bookingId]);
      await actAs(tx, customerClaims(other.authUserId));
      await failsWith(
        tx,
        () => tx.query("select public.set_my_board_name($1, 'Not Mine')", [bookingId]),
        { code: "42501" },
      );
      await tx.query("reset role");
      expect(await shown()).toBe("Captain Cadence");
      expect(
        await scalar<string>(
          tx,
          "select finisher_name::text from public.adventure_bookings where id = $1",
          [bookingId],
        ),
      ).toBe("preferred_name");

      await actAs(tx, customerClaims(rider.authUserId));
      await tx.query("select public.set_my_board_name($1, '')", [bookingId]);
      await tx.query("reset role");
      expect(await shown()).toBeNull();
      expect(
        await scalar<string>(
          tx,
          "select finisher_name::text from public.adventure_bookings where id = $1",
          [bookingId],
        ),
      ).toBe("hidden");

      await actAs(tx, customerClaims(rider.authUserId));
      await tx.query("select public.set_my_board_name($1, 'Rude Name')", [bookingId]);
      await actAs(tx, staffClaims(AUTH_USER.mechanic1));
      await failsWith(
        tx,
        () => tx.query("select public.hide_adventure_board_name($1, 'Not suitable')", [bookingId]),
        { code: "42501" },
      );
      await actAs(tx, staffClaims(AUTH_USER.manager));
      await tx.query("select public.hide_adventure_board_name($1, 'Not suitable')", [bookingId]);
      await tx.query("reset role");
      expect(await shown()).toBeNull();
      expect(
        await scalar<number>(
          tx,
          "select count(*)::int from public.adventure_booking_events where booking_id = $1 and kind = 'board_name_changed'",
          [bookingId],
        ),
      ).toBe(4);
    });
  });
});

describe("board names, the owner's rules (audit A-49, D229)", () => {
  it("refuses invisible, direction and shop words, also in full-width; a taken-down name stays locked", async () => {
    await inTransaction(conn, async (tx) => {
      const sale = await offerOn125(tx);
      await openSales(tx);
      const rider = await makeRider(tx);
      const bookingId = await paidBooking(tx, rider, sale);
      await actAs(tx, customerClaims(rider.authUserId));
      for (const bad of [
        "A\u200bB",
        "Ali\u202eecs",
        "BICII Official",
        "ｂｉｃｉｉ fan",
        "Shop Staff",
        "admin",
      ]) {
        await failsWith(
          tx,
          () => tx.query("select public.set_my_board_name($1, $2)", [bookingId, bad]),
          refused("adventure_board_name_invalid"),
        );
      }
      await tx.query("select public.set_my_board_name($1, 'Rude Name')", [bookingId]);
      await actAs(tx, staffClaims(AUTH_USER.manager));
      await tx.query("select public.hide_adventure_board_name($1, 'Not suitable')", [bookingId]);
      await actAs(tx, customerClaims(rider.authUserId));
      await failsWith(
        tx,
        () => tx.query("select public.set_my_board_name($1, 'Back Again')", [bookingId]),
        refused("adventure_board_name_locked"),
      );
      await actAs(tx, staffClaims(AUTH_USER.manager));
      await failsWith(
        tx,
        () => tx.query("select public.unlock_adventure_board_name($1)", [bookingId]),
        {
          code: "42501",
        },
      );
      await actAs(tx, staffClaims(AUTH_USER.admin));
      await tx.query("select public.unlock_adventure_board_name($1)", [bookingId]);
      await actAs(tx, customerClaims(rider.authUserId));
      await tx.query("select public.set_my_board_name($1, 'Kind Name')", [bookingId]);
    });
  });
});

describe("no floods (audit A-50, D231)", () => {
  it("a repeated cancellation request within a day records nothing new", async () => {
    await inTransaction(conn, async (tx) => {
      const sale = await offerOn125(tx);
      await openSales(tx);
      const rider = await makeRider(tx);
      const bookingId = await paidBooking(tx, rider, sale);
      await actAs(tx, customerClaims(rider.authUserId));
      await tx.query("select public.request_my_adventure_cancellation($1, 'Injured')", [bookingId]);
      await tx.query("select public.request_my_adventure_cancellation($1, 'Injured again')", [
        bookingId,
      ]);
      await tx.query("reset role");
      expect(
        await scalar<number>(
          tx,
          "select count(*)::int from public.adventure_booking_events where booking_id = $1 and kind = 'cancellation_requested'",
          [bookingId],
        ),
      ).toBe(1);
    });
  });
});

describe("refunds (D212)", () => {
  it("can be asked for until the ride is sent for review, and never after", async () => {
    await inTransaction(conn, async (tx) => {
      const sale = await offerOn125(tx);
      await openSales(tx);
      const early = await makeRider(tx);
      const earlyBooking = await paidBooking(tx, early, sale);
      await actAs(tx, customerClaims(early.authUserId));
      expect(
        await scalar<boolean>(tx, "select refundable from public.my_adventure_terms($1)", [
          earlyBooking,
        ]),
      ).toBe(true);
      await tx.query("select public.request_my_adventure_cancellation($1, 'Injured')", [
        earlyBooking,
      ]);

      const late = await makeRider(tx);
      const { bookingId } = await submitted(tx, late, sale);
      await actAs(tx, customerClaims(late.authUserId));
      expect(
        (
          await tx.query(
            "select refundable, sent_for_review_at is not null as sent from public.my_adventure_terms($1)",
            [bookingId],
          )
        ).rows,
      ).toEqual([{ refundable: false, sent: true }]);
      await failsWith(
        tx,
        () =>
          tx.query("select public.request_my_adventure_cancellation($1, 'Changed my mind')", [
            bookingId,
          ]),
        refused("adventure_not_refundable"),
      );

      // An admin may still cancel (a broken rule); the record says no refund.
      await actAs(tx, staffClaims(AUTH_USER.admin));
      await tx.query("select public.cancel_adventure_booking($1, 'Borrowed recording')", [
        bookingId,
      ]);
      await tx.query("select public.cancel_adventure_booking($1, 'Rider asked')", [earlyBooking]);
      await tx.query("reset role");
      const { rows } = await tx.query(
        `select booking_id, (detail ->> 'refundable')::boolean as refundable from public.adventure_booking_events
          where kind = 'booking_cancelled' and booking_id = any($1::uuid[]) order by refundable`,
        [[bookingId, earlyBooking]],
      );
      expect(rows).toEqual([
        { booking_id: bookingId, refundable: false },
        { booking_id: earlyBooking, refundable: true },
      ]);
    });
  });
});

describe("tracker late fees (D213)", () => {
  async function returnedLate(tx: Connection, daysAfterReturnDay: number) {
    const {
      sale,
      days,
      devices: [d1],
    } = await setup(tx, 1);
    const rider = await makeRider(tx);
    await tx.query("update public.customers set email = $2 where id = $1", [
      rider.customerId,
      `rider-${randomUUID().slice(0, 8)}@example.test`,
    ]);
    const p = await checkout(tx, rider, sale, days[0], days[1]);
    await pay(tx, p);
    const hire = await reservation(tx, p.booking_id);
    await actAs(tx, staffClaims(AUTH_USER.manager));
    const assignment = await scalar<string>(
      tx,
      "select id from public.issue_adventure_tracker($1, $2, 'ok')",
      [hire.id, d1],
    );
    await tx.query("reset role");
    await tx.query(
      "update public.tracker_reservations set collect_on = private.shop_today() - $2::int - 1, return_on = private.shop_today() - $2::int where id = $1",
      [hire.id, daysAfterReturnDay],
    );
    const due = await scalar<string>(tx, "select (private.shop_today() - $1::int)::text", [
      daysAfterReturnDay,
    ]);
    await actAs(tx, staffClaims(AUTH_USER.manager));
    const preview = await scalar<string>(
      tx,
      "select public.tracker_late_fee_if_returned_today($1::date)::text",
      [due],
    );
    await tx.query("select public.return_adventure_tracker($1, 'good', '')", [assignment]);
    await tx.query("reset role");
    return { bookingId: p.booking_id, rider, preview };
  }

  it("the grace day is free; each day after it costs the day rate, recorded and emailed", async () => {
    await inTransaction(conn, async (tx) => {
      const onTime = await returnedLate(tx, 1);
      expect(onTime.preview).toBe("0.00");
      expect(
        await scalar<number>(
          tx,
          "select count(*)::int from public.tracker_late_fees where booking_id = $1",
          [onTime.bookingId],
        ),
      ).toBe(0);

      const late = await returnedLate(tx, 3);
      expect(late.preview).toBe("40.00");
      const { rows } = await tx.query(
        "select days_late, per_day::text, amount::text, status::text from public.tracker_late_fees where booking_id = $1",
        [late.bookingId],
      );
      expect(rows).toEqual([{ days_late: 2, per_day: "20.00", amount: "40.00", status: "owed" }]);
      expect(
        await scalar<string>(
          tx,
          "select n.kind::text from private.adventure_notices n where n.booking_id = $1 and n.kind = 'tracker_late_fee'",
          [late.bookingId],
        ),
      ).toBe("tracker_late_fee");
      expect(
        await scalar<string>(
          tx,
          "select detail ->> 'note' from public.adventure_booking_events where booking_id = $1 and kind = 'late_fee_recorded'",
          [late.bookingId],
        ),
      ).toMatch(/late fee is \$40\.00 \(\$20\.00 a day\), payable at the shop/);
      await actAs(tx, customerClaims(late.rider.authUserId));
      expect(
        await scalar<string>(tx, "select late_fees_owed::text from public.my_adventure_terms($1)", [
          late.bookingId,
        ]),
      ).toBe("40.00");
    });
  });

  it("an admin settles a fee once: paid, or waived with a reason", async () => {
    await inTransaction(conn, async (tx) => {
      const late = await returnedLate(tx, 4);
      const fee = await scalar<string>(
        tx,
        "select id from public.tracker_late_fees where booking_id = $1",
        [late.bookingId],
      );
      await actAs(tx, staffClaims(AUTH_USER.manager));
      await failsWith(
        tx,
        () => tx.query("select public.settle_tracker_late_fee($1, 'paid', 'Cash')", [fee]),
        { code: "42501" },
      );
      await actAs(tx, staffClaims(AUTH_USER.admin));
      await failsWith(
        tx,
        () => tx.query("select public.settle_tracker_late_fee($1, 'waived', ' ')", [fee]),
        refused("reason_required"),
      );
      await tx.query("select public.settle_tracker_late_fee($1, 'paid', 'PayNow at the counter')", [
        fee,
      ]);
      await failsWith(
        tx,
        () => tx.query("select public.settle_tracker_late_fee($1, 'waived', 'x')", [fee]),
        refused("late_fee_settled"),
      );
      await tx.query("reset role");
      expect(
        (
          await tx.query(
            "select status::text, amount::text, settle_note from public.tracker_late_fees where id = $1",
            [fee],
          )
        ).rows,
      ).toEqual([{ status: "paid", amount: "60.00", settle_note: "PayNow at the counter" }]);
      await actAs(tx, customerClaims(late.rider.authUserId));
      expect(
        await scalar<string>(tx, "select late_fees_owed::text from public.my_adventure_terms($1)", [
          late.bookingId,
        ]),
      ).toBe("0.00");
    });
  });
});
