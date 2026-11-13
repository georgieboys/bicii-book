/**
 * Adventure fixtures (Phase B): a published BICII 125 offer, sales on, a
 * rider with a login, and a booking paid through a verified Stripe event.
 * Each helper acts as the role it needs and leaves `tx` acting as it.
 */
import { randomUUID } from "node:crypto";

import { AUTH_USER } from "../fixtures/ids";
import { customerClaims, linkCustomerLogin, putStorageObject } from "./customer-fixtures";
import { actAs, scalar, staffClaims, type Connection } from "./harness";
import { deliver, SERVICE, tag } from "./payment-fixtures";
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

/** A paid booking whose rider has submitted a parsed, timed recording. Returns the submission id. */
export async function submitted(
  tx: Connection,
  rider: Rider,
  sale: Sale,
): Promise<{ bookingId: string; submissionId: string }> {
  const bookingId = await paidBooking(tx, rider, sale);
  await actAs(tx, customerClaims(rider.authUserId));
  const { rows } = await tx.query<{ file_id: string; storage_path: string }>(
    `select file_id, storage_path from public.prepare_my_adventure_upload($1, 'activity', null, 'ride.gpx', 'application/gpx+xml', 1000)`,
    [bookingId],
  );
  await tx.query("reset role");
  await putStorageObject(tx, "adventure-evidence", rows[0].storage_path, {
    mimetype: "application/gpx+xml",
    size: 1000,
  });
  await actAs(tx, customerClaims(rider.authUserId));
  await tx.query("select public.finalise_my_adventure_upload($1)", [rows[0].file_id]);
  await actAs(tx, SERVICE);
  await tx.query("select public.claim_adventure_parse_jobs(10)");
  await tx.query("select public.finish_adventure_parse($1, true, '', $2, 't', $3::jsonb)", [
    rows[0].file_id,
    "b".repeat(64),
    JSON.stringify({
      format: "gpx",
      started_at: "2026-11-14T07:00:00Z",
      finished_at: "2026-11-15T01:00:00Z",
      distance_km: 131.2,
      has_times: true,
      points: [
        ["2026-11-14T07:00:00Z", 1.3, 103.8],
        ["2026-11-15T01:00:00Z", 1.31, 103.81],
      ],
    }),
  ]);
  await actAs(tx, customerClaims(rider.authUserId));
  await tx.query("select public.submit_my_adventure_evidence($1, '')", [bookingId]);
  await tx.query("reset role");
  const submissionId = await scalar<string>(
    tx,
    `select s.id from public.adventure_submissions s join public.adventure_attempts t on t.id = s.attempt_id
      where t.booking_id = $1 and s.state = 'submitted'`,
    [bookingId],
  );
  return { bookingId, submissionId };
}
