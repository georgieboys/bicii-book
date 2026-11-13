/**
 * Adventure fixtures (Phase B): a published BICII 125 offer, sales on, a
 * rider with a login, and a booking paid through a verified Stripe event.
 * Each helper acts as the role it needs and leaves `tx` acting as it.
 */
import { randomUUID } from "node:crypto";

import { AUTH_USER } from "../fixtures/ids";
import { customerClaims, linkCustomerLogin } from "./customer-fixtures";
import { actAs, scalar, staffClaims, type Connection } from "./harness";
import { deliver, tag } from "./payment-fixtures";
import { makeCustomer } from "./workshop-fixtures";

export const TERMS = "2026-11-test";

export type Sale = { revisionNumber: number; adventureId: string };
export type Rider = { customerId: string; authUserId: string };

/** As the manager: BICII 125 with two checkpoints and a self-supported offer, published. */
export async function offerOn125(tx: Connection, price = 49): Promise<Sale> {
  await actAs(tx, staffClaims(AUTH_USER.manager));
  const adventureId = await scalar<string>(
    tx,
    "select id from public.adventures where slug = 'bicii-125'",
  );
  const { rows } = await tx.query<{ id: string; version: number; revision_number: number }>(
    "select id, version, revision_number from public.start_adventure_draft($1)",
    [adventureId],
  );
  const draft = rows[0];
  await tx.query(
    `select public.update_adventure_draft(
       revision_id => $1, expected_version => $2, name => 'BICII 125', summary => '', description => '',
       note => '', region => '', terrain => 'Road', when_to_start => '', start_finish => '294 River Valley',
       distance_km => 125, nominal_days => 1, time_zone => 'Asia/Singapore', min_elapsed_minutes => null,
       max_elapsed_minutes => 1440, checkpoint_order => 'any', route_url => null, rules => 'Ride it all',
       equipment => '', rider_instructions => 'Buyers only', emergency_procedure => 'Call the shop',
       staff_notes => 'Staff only', is_planned => false)`,
    [draft.id, draft.version],
  );
  await tx.query("select public.set_adventure_checkpoints($1, $2::jsonb)", [
    draft.id,
    JSON.stringify([{ label: "Lim Chu Kang" }, { label: "Seletar" }]),
  ]);
  await tx.query("select public.set_adventure_offer($1, 'self_supported', $2, 20, null, 'Pack')", [
    draft.id,
    price,
  ]);
  await tx.query("select public.publish_adventure_revision($1, null)", [draft.id]);
  return { revisionNumber: draft.revision_number, adventureId };
}

export async function openSales(tx: Connection): Promise<void> {
  await actAs(tx, staffClaims(AUTH_USER.admin));
  await tx.query("select public.set_adventure_sales(true, $1)", [TERMS]);
}

export async function makeRider(tx: Connection): Promise<Rider> {
  await tx.query("reset role");
  const customerId = await makeCustomer(tx);
  const authUserId = await linkCustomerLogin(tx, customerId);
  return { customerId, authUserId };
}

/** A booking for `rider`, paid through a verified checkout.session.completed. Returns its id. */
export async function paidBooking(tx: Connection, rider: Rider, sale: Sale): Promise<string> {
  await actAs(tx, customerClaims(rider.authUserId));
  const { rows } = await tx.query<{ booking_id: string; payment_id: string; amount_cents: string }>(
    `select booking_id, payment_id, amount_cents::text
       from public.prepare_my_adventure_checkout($1, 'bicii-125', 'self_supported', $2, 'M', 'first_name_initial', $3)`,
    [randomUUID(), sale.revisionNumber, TERMS],
  );
  const p = rows[0];
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
  return p.booking_id;
}
