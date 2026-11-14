/**
 * Tracker hire fixtures (Phase C): open shop days, hire switched on,
 * devices in service, a checkout with or without hire, a payment through a
 * verified Stripe event, and a hire's reservation. Each helper acts as the
 * role it needs.
 */

import { AUTH_USER } from "../fixtures/ids";
import {
  offerOn125,
  openSales,
  signWaiver,
  TERMS,
  type Rider,
  type Sale,
} from "./adventure-fixtures";
import { customerClaims } from "./customer-fixtures";
import { actAs, scalar, staffClaims, type Connection } from "./harness";
import { deliver, tag } from "./payment-fixtures";

/** The next `n` days after today the shop is open (shop time). */
export async function openDays(tx: Connection, n: number): Promise<string[]> {
  await tx.query("reset role");
  const { rows } = await tx.query<{ day: string }>(
    `select d::date::text as day from pg_catalog.generate_series(private.shop_today() + 1, private.shop_today() + 60, interval '1 day') d
      where private.shop_open_on(d::date) order by d limit $1`,
    [n],
  );
  return rows.map((r) => r.day);
}

export async function hireOn(tx: Connection, maxDays = 7): Promise<void> {
  await actAs(tx, staffClaims(AUTH_USER.admin));
  await tx.query("select public.set_adventure_tracker_hire(true, $1)", [maxDays]);
}

/** Devices in service, as the manager. Returns their ids. */
export async function devices(tx: Connection, n: number): Promise<string[]> {
  await actAs(tx, staffClaims(AUTH_USER.manager));
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const t = tag();
    const id = await scalar<string>(
      tx,
      "select id from public.register_tracking_device($1, 'fake', $2, 'Fake 1')",
      [`T-${t.slice(0, 6)}`, `fake-${t}`],
    );
    await tx.query("select public.set_tracking_device_state($1, 'in_service', '')", [id]);
    ids.push(id);
  }
  return ids;
}

export type Prepared = {
  booking_id: string;
  payment_id: string;
  amount: string;
  amount_cents: string;
};

export async function checkout(
  tx: Connection,
  rider: Rider,
  sale: Sale,
  collect: string | null,
  back: string | null,
) {
  await actAs(tx, customerClaims(rider.authUserId));
  const { rows } = await tx.query<Prepared>(
    `select booking_id, payment_id, amount::text, amount_cents::text from public.prepare_my_adventure_checkout(
       $1, 'bicii-125', 'self_supported', $2, 'M', 'first_name_initial', $3,
       recording_method => $4, hire_collect_on => $5::date, hire_return_on => $6::date)`,
    [
      await signWaiver(tx),
      sale.revisionNumber,
      TERMS,
      collect ? "tracker_hire" : "own_device",
      collect,
      back,
    ],
  );
  return rows[0];
}

export async function pay(tx: Connection, p: Prepared): Promise<void> {
  await deliver(tx, "checkout.session.completed", {
    id: `cs_test_${tag()}`,
    object: "checkout.session",
    livemode: false,
    status: "complete",
    payment_status: "paid",
    amount_total: Number(p.amount_cents),
    currency: "sgd",
    payment_intent: `pi_${tag()}`,
    metadata: { bicii_subject: "adventure", bicii_adventure_payment_id: p.payment_id },
  });
}

export async function reservation(tx: Connection, bookingId: string) {
  await tx.query("reset role");
  const { rows } = await tx.query(
    "select id, status::text, hold_until is not null as held, collect_on::text, return_on::text, days from public.tracker_reservations where booking_id = $1",
    [bookingId],
  );
  return rows[0] as {
    id: string;
    status: string;
    held: boolean;
    collect_on: string;
    return_on: string;
    days: number;
  };
}

/** BICII 125 on sale with hire on and exactly `fleet` trackers in service (others retired and other hires cancelled, in this transaction). */
export async function setup(tx: Connection, fleet = 1) {
  await tx.query("reset role");
  // Only this test's fleet and hires count (the database may hold others,
  // committed by an earlier E2E run): in this transaction, every other
  // hire is cancelled and every other tracker retired.
  await tx.query(
    `update public.tracker_reservations set status = 'cancelled', hold_until = null, cancel_reason = 'test isolation'
      where status in ('held', 'confirmed')`,
  );
  await tx.query(
    "update public.tracking_devices set service_state = 'retired' where service_state = 'in_service'",
  );
  const sale = await offerOn125(tx);
  await openSales(tx);
  await hireOn(tx);
  const ids = await devices(tx, fleet);
  const days = await openDays(tx, 6);
  return { sale, devices: ids, days };
}
