import { randomUUID } from "node:crypto";

import type { APIRequestContext } from "@playwright/test";

import { AUTH_USER } from "../fixtures/ids";
import { stripeEvent, stripeWebhookHeaders } from "../fixtures/stripe";
import { sqlTransaction } from "./db";

/**
 * Builds what a rider does on the public site (another repository): a
 * BICII 125 self-supported offer on sale, a rider with a login, a booking
 * paid through a signed Stripe webhook to this Admin (as Stripe would),
 * and a ride recording read and submitted. The RPCs run with the claims of
 * whoever would call them (the manager, an admin, the rider, the parse
 * worker), so every rule applies; only the Auth user and the Storage
 * object (what Auth and the Storage API create) are inserted directly.
 */

export type Query = Parameters<Parameters<typeof sqlTransaction>[0]>[0];

export const TERMS = "2026-11-e2e";

export async function actAs(q: Query, role: "authenticated" | "service_role", sub?: string) {
  await q("reset role");
  await q(`set local role ${role}`);
  await q("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify(sub ? { role, aud: "authenticated", sub } : { role }),
  ]);
}

/** A loop of about 133 km around Singapore, 500 timed points over ten hours. */
function loop(n = 500): Array<[string, number, number]> {
  return Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / (n - 1);
    const at = new Date(Date.parse("2026-11-14T22:00:00Z") + i * 72_000).toISOString();
    return [at, 1.35 + 0.12 * Math.sin(a), 103.82 + 0.25 * Math.cos(a)];
  });
}

export type SubmittedRide = { bookingId: string; submissionId: string; reference: string };

/**
 * A rider's paid booking (the offer published and sales on first). With
 * `hire`, tracker hire is switched on and the booking hires a tracker on
 * the next two days the shop is open.
 */
export async function paidBooking(
  request: APIRequestContext,
  riderName: string,
  options: { hire?: boolean } = {},
): Promise<{ bookingId: string; reference: string }> {
  let prepared: { bookingId: string; paymentId: string; amountCents: number } | null = null;
  await sqlTransaction(async (q) => {
    // One offer for every worker: the first one in publishes it.
    await q("select pg_advisory_xact_lock(hashtext('e2e-adventure-offer'))");
    const [adventure] = await q<{ id: string; has_offer: boolean }>(
      `select a.id, exists (select 1 from public.adventure_offers o
                             where o.revision_id = a.current_revision_id and o.kind = 'self_supported') as has_offer
         from public.adventures a where a.slug = 'bicii-125'`,
    );
    if (!adventure.has_offer) {
      await actAs(q, "authenticated", AUTH_USER.manager);
      const [draft] = await q<{ id: string; version: number }>(
        "select id, version from public.start_adventure_draft($1)",
        [adventure.id],
      );
      await q(
        `select public.update_adventure_draft(
           revision_id => $1, expected_version => $2, name => 'BICII 125', summary => '', description => '',
           note => '', region => '', terrain => 'Road', when_to_start => '', start_finish => '294 River Valley',
           distance_km => 125, nominal_days => 1, time_zone => 'Asia/Singapore', min_elapsed_minutes => null,
           max_elapsed_minutes => 1440, checkpoint_order => 'any', route_url => null, rules => 'Ride it all',
           equipment => '', rider_instructions => '', emergency_procedure => '', staff_notes => '',
           is_planned => false)`,
        [draft.id, draft.version],
      );
      await q("select public.set_adventure_checkpoints($1, $2::jsonb)", [
        draft.id,
        JSON.stringify([
          { label: "Lim Chu Kang", latitude: 1.47, longitude: 103.82, review_radius_m: 500 },
          { label: "Seletar", latitude: 1.35, longitude: 103.57, review_radius_m: 500 },
        ]),
      ]);
      await q("select public.set_adventure_offer($1, 'self_supported', 49, 20, null, 'Pack')", [
        draft.id,
      ]);
      await q("select public.publish_adventure_revision($1, null)", [draft.id]);
    }
    await actAs(q, "authenticated", AUTH_USER.admin);
    await q(
      `select public.publish_adventure_waiver($1, 'E2E waiver', repeat('Test terms for riders. ', 20))
        where not exists (select 1 from public.adventure_waivers w where w.version = $1)`,
      [TERMS],
    );
    await q("select public.set_adventure_sales(true, $1)", [TERMS]);
    if (options.hire) await q("select public.set_adventure_tracker_hire(true, 7)");

    await q("reset role");
    const authUserId = randomUUID();
    await q(
      `insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
       values ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2, now(), now())`,
      [authUserId, `rider-${authUserId.slice(0, 8)}@example.com`],
    );
    const [first, ...rest] = riderName.split(" ");
    await q(
      `insert into public.customers (display_name, first_name, last_name, email, auth_user_id)
       values ($1, $2, $3, $4, $5)`,
      [riderName, first, rest.join(" "), `rider-${authUserId.slice(0, 8)}@example.com`, authUserId],
    );
    const [revision] = await q<{ revision_number: number }>(
      `select r.revision_number from public.adventures a
         join public.adventure_revisions r on r.id = a.current_revision_id where a.slug = 'bicii-125'`,
    );
    const days = options.hire
      ? (
          await q<{ day: string }>(
            `select d::date::text as day from generate_series(private.shop_today() + 1, private.shop_today() + 30, interval '1 day') d
              where private.shop_open_on(d::date) order by d limit 2`,
          )
        ).map((d) => d.day)
      : [null, null];
    await actAs(q, "authenticated", authUserId);
    const requestId = await signWaiver(q);
    const [checkout] = await q<{ booking_id: string; payment_id: string; amount_cents: string }>(
      `select booking_id, payment_id, amount_cents::text from public.prepare_my_adventure_checkout(
         $1, 'bicii-125', 'self_supported', $2, 'M', 'first_name_initial', $3,
         recording_method => $4, hire_collect_on => $5::date, hire_return_on => $6::date)`,
      [
        requestId,
        revision.revision_number,
        TERMS,
        options.hire ? "tracker_hire" : "own_device",
        days[0],
        days[1],
      ],
    );
    prepared = {
      bookingId: checkout.booking_id,
      paymentId: checkout.payment_id,
      amountCents: Number(checkout.amount_cents),
    };
  });
  const { bookingId, paymentId, amountCents } = prepared!;

  // Stripe's confirmation, signed with the test secret, to the real webhook route.
  const raw = JSON.stringify(
    stripeEvent({
      id: `evt_${randomUUID().replace(/-/g, "")}`,
      type: "checkout.session.completed",
      object: {
        id: `cs_test_${randomUUID().replace(/-/g, "")}`,
        object: "checkout.session",
        livemode: false,
        status: "complete",
        payment_status: "paid",
        amount_total: amountCents,
        currency: "sgd",
        payment_intent: `pi_${randomUUID().replace(/-/g, "")}`,
        metadata: { bicii_subject: "adventure", bicii_adventure_payment_id: paymentId },
      },
    }),
  );
  const delivered = await request.post("/api/stripe/webhooks", {
    data: raw,
    headers: stripeWebhookHeaders({ raw }),
  });
  if (!delivered.ok()) throw new Error(`Stripe webhook refused: ${delivered.status()}`);
  let reference = "";
  await sqlTransaction(async (q) => {
    const [b] = await q<{ reference: string; status: string }>(
      "select reference, status::text from public.adventure_bookings where id = $1",
      [bookingId],
    );
    if (b.status !== "confirmed") throw new Error(`Booking not paid: ${b.status}`);
    reference = b.reference;
  });
  return { bookingId, reference };
}

export async function submittedRide(
  request: APIRequestContext,
  riderName: string,
): Promise<SubmittedRide> {
  const { bookingId } = await paidBooking(request, riderName);
  let result: SubmittedRide | null = null;
  await sqlTransaction(async (q) => {
    // One worker at a time: the claim below must only find this rider's file.
    await q("select pg_advisory_xact_lock(hashtext('e2e-adventure-parse'))");
    const [booking] = await q<{ reference: string; auth_user_id: string; status: string }>(
      `select b.reference, c.auth_user_id, b.status::text from public.adventure_bookings b
         join public.customers c on c.id = b.customer_id where b.id = $1`,
      [bookingId],
    );
    if (booking.status !== "confirmed") throw new Error(`Booking not paid: ${booking.status}`);
    await actAs(q, "authenticated", booking.auth_user_id);
    const [file] = await q<{ file_id: string; storage_path: string }>(
      `select file_id, storage_path from public.prepare_my_adventure_upload(
         $1, 'activity', null, 'ride.gpx', 'application/gpx+xml', 50000)`,
      [bookingId],
    );
    await q("reset role");
    await q(
      `insert into storage.objects (bucket_id, name, metadata)
       values ('adventure-evidence', $1, jsonb_build_object('mimetype', 'application/gpx+xml', 'size', 50000))`,
      [file.storage_path],
    );
    await actAs(q, "authenticated", booking.auth_user_id);
    await q("select public.finalise_my_adventure_upload($1)", [file.file_id]);
    await actAs(q, "service_role");
    await q("select public.claim_adventure_parse_jobs(50)");
    const points = loop();
    await q("select public.finish_adventure_parse($1, true, '', $2, 'e2e', $3::jsonb)", [
      file.file_id,
      "d".repeat(64),
      JSON.stringify({
        format: "gpx",
        started_at: points[0][0],
        finished_at: points[points.length - 1][0],
        distance_km: 133.4,
        has_times: true,
        points,
      }),
    ]);
    await actAs(q, "authenticated", booking.auth_user_id);
    await q("select public.submit_my_adventure_evidence($1, 'Clockwise, lunch at Seletar.')", [
      bookingId,
    ]);
    await q("reset role");
    const [submission] = await q<{ id: string }>(
      `select s.id from public.adventure_submissions s
         join public.adventure_attempts a on a.id = s.attempt_id
        where a.booking_id = $1 and s.state = 'submitted'`,
      [bookingId],
    );
    result = { bookingId, submissionId: submission.id, reference: booking.reference };
  });
  return result!;
}

// ---------------------------------------------------------------------------
// Building blocks for the handoff §20.6 scenarios (adventures-scenarios.spec)
// ---------------------------------------------------------------------------

/** A rider with a login (Auth user and customer record). */
export async function newRider(
  q: Query,
  riderName: string,
): Promise<{ authUserId: string; customerId: string }> {
  await q("reset role");
  const authUserId = randomUUID();
  await q(
    `insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
     values ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2, now(), now())`,
    [authUserId, `rider-${authUserId.slice(0, 8)}@example.com`],
  );
  const [first, ...rest] = riderName.split(" ");
  const [c] = await q<{ id: string }>(
    `insert into public.customers (display_name, first_name, last_name, email, auth_user_id)
     values ($1, $2, $3, $4, $5) returning id`,
    [riderName, first, rest.join(" "), `rider-${authUserId.slice(0, 8)}@example.com`, authUserId],
  );
  return { authUserId, customerId: c.id };
}

/**
 * BICII 125's supported offer (S$149, one day) published alongside the
 * self-supported one, and supported sales on. Call after paidBooking has
 * published the self-supported offer.
 */
export async function supportedOn(q: Query): Promise<void> {
  await q("select pg_advisory_xact_lock(hashtext('e2e-adventure-offer'))");
  const [a] = await q<{ id: string; has: boolean }>(
    `select a.id, exists (select 1 from public.adventure_offers o
                           where o.revision_id = a.current_revision_id and o.kind = 'supported') as has
       from public.adventures a where a.slug = 'bicii-125'`,
  );
  if (!a.has) {
    await actAs(q, "authenticated", AUTH_USER.manager);
    const [draft] = await q<{ id: string }>("select id from public.start_adventure_draft($1)", [
      a.id,
    ]);
    await q(
      "select public.set_adventure_offer($1, 'supported', 149, null, 1, 'Support van and a tracker')",
      [draft.id],
    );
    await q("select public.publish_adventure_revision($1, null)", [draft.id]);
  }
  await actAs(q, "authenticated", AUTH_USER.admin);
  await q("select public.set_adventure_tracker_hire(true, 7)");
  await q("select public.set_adventure_supported_sales(true)");
  await q("reset role");
}

/** A tracker in service, so a date or hire in this test has one free. */
export async function trackerInService(q: Query, label: string): Promise<string> {
  await actAs(q, "authenticated", AUTH_USER.manager);
  const [d] = await q<{ id: string }>(
    "select id from public.register_tracking_device($1, 'fake', $2, 'E2E')",
    [label, `ESN-${label}`],
  );
  await q("select public.set_tracking_device_state($1, 'in_service', '')", [d.id]);
  await q("reset role");
  return d.id;
}

/** A group or supported date for BICII 125 `days` from now (as the manager). */
export async function departureFor(
  q: Query,
  kind: "self_supported_group" | "supported",
  meetingPoint: string,
  days: number,
  capacity = 4,
): Promise<{ id: string; version: number }> {
  // The first day the shop is open, `days` or more from today (a supported
  // date's tracker is collected that day).
  const [day] = await q<{ day: string }>(
    `select d::date::text as day from generate_series(private.shop_today() + $1::int, private.shop_today() + $1::int + 30, interval '1 day') d
      where private.shop_open_on(d::date) order by d limit 1`,
    [days],
  );
  await actAs(q, "authenticated", AUTH_USER.manager);
  const [d] = await q<{ id: string; version: number }>(
    `select id, version from public.create_adventure_departure(
       (select id from public.adventures where slug = 'bicii-125'), $1,
       ($2::date + time '07:00') at time zone 'Asia/Singapore',
       ($2::date + time '19:00') at time zone 'Asia/Singapore',
       $3, $4, 'Coffee first', '')`,
    [kind, day.day, meetingPoint, capacity],
  );
  await q("reset role");
  return d;
}

export type Prepared = { bookingId: string; paymentId: string; amountCents: number };

/** The rider's checkout, as the public site's Admin endpoint prepares it. */
export async function prepareCheckout(
  q: Query,
  authUserId: string,
  kind: "self_supported" | "supported",
  departureId: string | null = null,
): Promise<Prepared> {
  await q("reset role");
  const [revision] = await q<{ revision_number: number }>(
    `select r.revision_number from public.adventures a
       join public.adventure_revisions r on r.id = a.current_revision_id where a.slug = 'bicii-125'`,
  );
  await actAs(q, "authenticated", authUserId);
  const requestId = await signWaiver(q);
  const [c] = await q<{ booking_id: string; payment_id: string; amount_cents: string }>(
    `select booking_id, payment_id, amount_cents::text from public.prepare_my_adventure_checkout(
       $1, 'bicii-125', $2, $3, 'M', 'first_name_initial', $4, departure_id => $5)`,
    [requestId, kind, revision.revision_number, TERMS, departureId],
  );
  await q("reset role");
  return { bookingId: c.booking_id, paymentId: c.payment_id, amountCents: Number(c.amount_cents) };
}

/** As the rider `q` acts as: the waiver signed for a new checkout request (D215). */
async function signWaiver(q: Query): Promise<string> {
  const requestId = randomUUID();
  await q(
    `select public.sign_my_adventure_waiver($1, $2, 'Test Rider', 'Test Contact', '+65 6000 0000', true, true, true, true, true)`,
    [requestId, TERMS],
  );
  return requestId;
}

/** Stripe's event for this payment, signed with the test secret, to the real webhook route. */
export async function stripeSays(
  request: APIRequestContext,
  p: Prepared,
  outcome: "paid" | "failed" | "expired",
): Promise<void> {
  const type =
    outcome === "paid"
      ? "checkout.session.completed"
      : outcome === "failed"
        ? "checkout.session.async_payment_failed"
        : "checkout.session.expired";
  const raw = JSON.stringify(
    stripeEvent({
      id: `evt_${randomUUID().replace(/-/g, "")}`,
      type,
      object: {
        id: `cs_test_${randomUUID().replace(/-/g, "")}`,
        object: "checkout.session",
        livemode: false,
        status: outcome === "expired" ? "expired" : "complete",
        payment_status: outcome === "paid" ? "paid" : "unpaid",
        amount_total: p.amountCents,
        currency: "sgd",
        payment_intent: outcome === "expired" ? null : `pi_${randomUUID().replace(/-/g, "")}`,
        metadata: { bicii_subject: "adventure", bicii_adventure_payment_id: p.paymentId },
      },
    }),
  );
  const delivered = await request.post("/api/stripe/webhooks", {
    data: raw,
    headers: stripeWebhookHeaders({ raw }),
  });
  if (!delivered.ok()) throw new Error(`Stripe webhook refused: ${delivered.status()}`);
}
