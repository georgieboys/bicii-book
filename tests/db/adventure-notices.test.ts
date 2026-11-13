/**
 * Adventures Phase B, emails (DATA-MODEL §20 "Emails", D183-D184): which
 * booking events queue which emails, and the outbox's claim rules, built
 * so the booking emails' weaknesses cannot recur here (RISKS R-100: claims
 * used attempts and gave up early; a late success stayed failed).
 *
 * Rolled-back transactions; the outbox is read as the table owner.
 */
import type pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { AUTH_USER } from "../fixtures/ids";
import {
  makeRider,
  offerOn125,
  openSales,
  paidBooking,
  submitted,
  type Rider,
} from "./adventure-fixtures";
import { actAs, connect, inTransaction, scalar, staffClaims, type Connection } from "./harness";
import { SERVICE } from "./payment-fixtures";

let conn: pg.Client;

beforeAll(async () => {
  conn = await connect();
});

const ALL_TRUE = JSON.stringify({
  identity: true,
  coverage: true,
  checkpoints: true,
  chronology: true,
  time_window: true,
  distance: true,
});

/** A rider with an email address (the fixture's customers have none). */
async function riderWithEmail(tx: Connection): Promise<Rider & { email: string }> {
  const rider = await makeRider(tx);
  const email = `rider-${rider.customerId.slice(0, 8)}@example.com`;
  await tx.query("reset role");
  await tx.query("update public.customers set email = $2, first_name = 'Dana' where id = $1", [
    rider.customerId,
    email,
  ]);
  return { ...rider, email };
}

async function shopRecipients(tx: Connection): Promise<void> {
  await tx.query("reset role");
  await tx.query(
    "update public.shop_settings set booking_alert_emails = array['team@example.com', 'mech@example.com'] where id = 1",
  );
}

async function notices(tx: Connection, bookingId: string) {
  await tx.query("reset role");
  const { rows } = await tx.query<{
    kind: string;
    audience: string;
    recipient: string;
    status: string;
  }>(
    `select kind::text, audience::text, recipient::text, status::text from private.adventure_notices
      where booking_id = $1 order by created_at, audience, recipient`,
    [bookingId],
  );
  return rows;
}

async function decide(tx: Connection, submissionId: string, decision: string, message = "") {
  await actAs(tx, staffClaims(AUTH_USER.manager));
  await tx.query("select public.decide_adventure_review($1, $2, $3::jsonb, $4, $5, $6, '')", [
    submissionId,
    decision,
    ALL_TRUE,
    decision === "approved" ? 128.5 : null,
    decision === "approved" ? "2026-11-15" : null,
    message,
  ]);
}

type Claimed = { id: string; claim_token: string; kind: string; attempts: number };

async function claim(tx: Connection, max = 5): Promise<Claimed[]> {
  await actAs(tx, SERVICE);
  const { rows } = await tx.query<Claimed>("select * from public.claim_adventure_notices($1)", [
    max,
  ]);
  return rows;
}

async function finish(
  tx: Connection,
  c: { id: string; claim_token: string },
  result: string,
  error: string | null = null,
) {
  await actAs(tx, SERVICE);
  return scalar<boolean>(tx, "select public.finish_adventure_notice($1, $2, $3, $4)", [
    c.id,
    c.claim_token,
    result,
    error,
  ]);
}

/** Lets every claim on the booking's rows lapse, as if 5 minutes passed. */
async function lapse(tx: Connection): Promise<void> {
  await tx.query("reset role");
  await tx.query(
    `update private.adventure_notices
        set claimed_until = case when claim_token is not null then now() - interval '1 second' end,
            next_attempt_at = least(next_attempt_at, now())`,
  );
}

async function clearOutbox(tx: Connection): Promise<void> {
  await tx.query("reset role");
  await tx.query("delete from private.adventure_notices");
}

describe("what is queued (D183)", () => {
  it("paid, ride sent, changes, certified and pack ready; nothing for a revocation or a collected pack", async () => {
    await inTransaction(conn, async (tx) => {
      await shopRecipients(tx);
      const sale = await offerOn125(tx);
      await openSales(tx);
      const rider = await riderWithEmail(tx);
      const { bookingId, submissionId } = await submitted(tx, rider, sale);
      expect(await notices(tx, bookingId)).toEqual([
        { kind: "ticket_paid", audience: "customer", recipient: rider.email, status: "pending" },
        {
          kind: "ride_submitted",
          audience: "shop",
          recipient: "mech@example.com",
          status: "pending",
        },
        {
          kind: "ride_submitted",
          audience: "shop",
          recipient: "team@example.com",
          status: "pending",
        },
      ]);

      await decide(tx, submissionId, "changes_requested", "Add the Seletar photo.");
      const kinds = (await notices(tx, bookingId)).map((n) => `${n.kind}:${n.audience}`);
      expect(kinds.filter((k) => k === "changes_requested:customer")).toHaveLength(1);
      expect(kinds).not.toContain("certified:customer");
    });
  });

  it("certified, then pack ready (once per ready), never for fulfilled or revoked", async () => {
    await inTransaction(conn, async (tx) => {
      const sale = await offerOn125(tx);
      await openSales(tx);
      const rider = await riderWithEmail(tx);
      const { bookingId, submissionId } = await submitted(tx, rider, sale);
      await clearOutbox(tx);
      await decide(tx, submissionId, "approved", "Well ridden.");
      await tx.query("reset role");
      const pack = await scalar<string>(
        tx,
        "select id from public.adventure_fulfilments where booking_id = $1",
        [bookingId],
      );
      const cert = await scalar<string>(
        tx,
        "select id from public.adventure_certificates where booking_id = $1",
        [bookingId],
      );
      await actAs(tx, staffClaims(AUTH_USER.manager));
      await tx.query("select public.set_adventure_pack_status($1, 'ready', '')", [pack]);
      await tx.query("select public.set_adventure_pack_status($1, 'fulfilled', '')", [pack]);
      await actAs(tx, staffClaims(AUTH_USER.admin));
      await tx.query("select public.revoke_adventure_certificate($1, 'Test')", [cert]);
      expect((await notices(tx, bookingId)).map((n) => n.kind)).toEqual([
        "certified",
        "pack_ready",
      ]);
    });
  });

  it("a payment flag alerts the shop; a rider without an email gets nothing", async () => {
    await inTransaction(conn, async (tx) => {
      await shopRecipients(tx);
      const sale = await offerOn125(tx);
      await openSales(tx);
      const rider = await makeRider(tx); // no email
      const bookingId = await paidBooking(tx, rider, sale);
      expect(await notices(tx, bookingId)).toEqual([]);
      await tx.query("select private.flag_adventure_booking($1, 'Paid twice', null, null)", [
        bookingId,
      ]);
      expect((await notices(tx, bookingId)).map((n) => `${n.kind}:${n.recipient}`)).toEqual([
        "payment_attention:mech@example.com",
        "payment_attention:team@example.com",
      ]);
    });
  });
});

describe("the outbox's claims (D184; R-100)", () => {
  async function oneNotice(tx: Connection): Promise<string> {
    const sale = await offerOn125(tx);
    await openSales(tx);
    const rider = await riderWithEmail(tx);
    await clearOutbox(tx);
    const bookingId = await paidBooking(tx, rider, sale);
    await tx.query("reset role");
    return scalar<string>(tx, "select id from private.adventure_notices where booking_id = $1", [
      bookingId,
    ]);
  }

  it("returns what the email needs, under a claim token", async () => {
    await inTransaction(conn, async (tx) => {
      const id = await oneNotice(tx);
      await actAs(tx, SERVICE);
      const { rows } = await tx.query("select * from public.claim_adventure_notices(5)");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id,
        kind: "ticket_paid",
        audience: "customer",
        attempts: 0,
        adventure_name: "BICII 125",
        adventure_slug: "bicii-125",
        rider_first_name: "Dana",
      });
      expect(rows[0].reference).toMatch(/^AV-\d{6}$/);
      expect(rows[0].claim_token).toMatch(/^[0-9a-f-]{36}$/);
      // Claimed: not claimable again until it lapses.
      expect(await claim(tx)).toEqual([]);
    });
  });

  it("claims that lapse without a result use no attempt and do not give up early", async () => {
    await inTransaction(conn, async (tx) => {
      await oneNotice(tx);
      for (let i = 0; i < 8; i++) {
        expect(await claim(tx)).toHaveLength(1);
        await lapse(tx);
      }
      await tx.query("reset role");
      expect(
        (await tx.query("select status::text, attempts, claims from private.adventure_notices"))
          .rows,
      ).toEqual([{ status: "pending", attempts: 0, claims: 8 }]);
    });
  });

  it("only the claim that holds the token records a result", async () => {
    await inTransaction(conn, async (tx) => {
      await oneNotice(tx);
      const [first] = await claim(tx);
      await lapse(tx);
      const [second] = await claim(tx);
      expect(second.claim_token).not.toBe(first.claim_token);
      expect(await finish(tx, first, "failed", "Email unavailable")).toBe(false);
      expect(await finish(tx, second, "sent")).toBe(true);
      await tx.query("reset role");
      expect(
        (await tx.query("select status::text, attempts from private.adventure_notices")).rows,
      ).toEqual([{ status: "sent", attempts: 0 }]);
    });
  });

  it("released rows come back at once and unused; failures back off and the fifth is final", async () => {
    await inTransaction(conn, async (tx) => {
      await oneNotice(tx);
      const [c] = await claim(tx);
      expect(await finish(tx, c, "released")).toBe(true);
      await tx.query("reset role");
      expect(
        (await tx.query("select attempts, claims, claimed_until from private.adventure_notices"))
          .rows,
      ).toEqual([{ attempts: 0, claims: 0, claimed_until: null }]);

      for (let i = 1; i <= 5; i++) {
        const [row] = await claim(tx);
        expect(row).toBeDefined();
        await finish(tx, row, "failed", "Email unavailable (503)");
        await tx.query("reset role");
        const { rows } = await tx.query(
          "select status::text, attempts, next_attempt_at > now() + make_interval(mins => 5 * attempts) - interval '5 seconds' as backed_off from private.adventure_notices",
        );
        expect(rows[0]).toMatchObject({
          attempts: i,
          status: i < 5 ? "pending" : "failed",
          backed_off: true,
        });
        await lapse(tx);
      }
      expect(await claim(tx)).toEqual([]);
    });
  });

  it("15 unanswered claims give up, and a send still in flight then records its success", async () => {
    await inTransaction(conn, async (tx) => {
      await oneNotice(tx);
      let last: Claimed | undefined;
      for (let i = 0; i < 15; i++) {
        [last] = await claim(tx);
        await lapse(tx);
      }
      expect(await claim(tx)).toEqual([]); // the sweep gives up
      await tx.query("reset role");
      expect(await scalar<string>(tx, "select status::text from private.adventure_notices")).toBe(
        "failed",
      );
      expect(await finish(tx, last!, "sent")).toBe(true);
      await tx.query("reset role");
      expect(
        (
          await tx.query(
            "select status::text, sent_at is not null as sent, last_error from private.adventure_notices",
          )
        ).rows,
      ).toEqual([{ status: "sent", sent: true, last_error: null }]);
    });
  });

  it("nobody but the service role works the outbox", async () => {
    await inTransaction(conn, async (tx) => {
      await actAs(tx, staffClaims(AUTH_USER.admin));
      await expect(tx.query("select public.claim_adventure_notices(5)")).rejects.toMatchObject({
        code: "42501",
      });
    });
  });
});
