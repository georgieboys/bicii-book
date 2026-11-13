import { expect, test } from "@playwright/test";

import { AUTH_USER } from "../fixtures/ids";
import {
  actAs,
  departureFor,
  newRider,
  paidBooking,
  prepareCheckout,
  type Query,
  stripeSays,
  submittedRide,
  supportedOn,
  trackerInService,
} from "./adventure-helpers";
import { sql, sqlTransaction } from "./db";
import { signIn, toast } from "./helpers";

/**
 * The handoff's required end-to-end scenarios (§20.6) that the other
 * adventure specs don't already walk: two riders on one group date and the
 * date cancelled; a supported date with its included tracker; a changes-
 * requested resubmission; a failed payment and a retry; a late tracker
 * point after the tracker went to another rider; and an ownership attack
 * between two customer accounts. (A free visitor is the public site's own
 * test; paid own-device certification is adventures-review.spec; a paid
 * hire with collection and return is adventures-trackers.spec.)
 *
 * The rider's side is built as the public site and Stripe would
 * (adventure-helpers.ts): RPCs with the rider's claims and signed webhooks
 * to this Admin's real route. Staff act on the screens.
 */

const tag = (name: string) => `${name.slice(0, 1)}${Date.now().toString(36).slice(-5)}`;

async function riderOf(bookingId: string): Promise<string> {
  const [r] = await sql<{ auth_user_id: string }>(
    `select c.auth_user_id from public.adventure_bookings b
       join public.customers c on c.id = b.customer_id where b.id = $1`,
    [bookingId],
  );
  return r.auth_user_id;
}

async function bookingStatus(bookingId: string): Promise<string> {
  const [b] = await sql<{ status: string }>(
    "select status::text from public.adventure_bookings where id = $1",
    [bookingId],
  );
  return b.status;
}

test("two riders share a group date; cancelling it keeps both tickets", async ({
  page,
  request,
}, testInfo) => {
  const t = tag(testInfo.project.name);
  const a = await paidBooking(request, `Asha ${t}`);
  const b = await paidBooking(request, `Bryn ${t}`);
  const meeting = `Peers ${t}`;
  let date = { id: "", version: 0 };
  await sqlTransaction(async (q) => {
    date = await departureFor(q, "self_supported_group", meeting, 12);
    for (const [booking, show] of [
      [a.bookingId, true],
      [b.bookingId, false],
    ] as const) {
      await actAs(q, "authenticated", await riderAuth(q, booking));
      await q("select public.join_adventure_departure($1, $2, $3, $4)", [
        booking,
        date.id,
        date.version,
        show,
      ]);
    }
    // P05: the peer rider paid the solo price; joining charged nothing more.
    await q("reset role");
    const totals = await q<{ total: string }>(
      "select total::text from public.adventure_bookings where id = any($1::uuid[])",
      [[a.bookingId, b.bookingId]],
    );
    expect(totals.map((x) => x.total)).toEqual(["49.00", "49.00"]);
    await actAs(q, "authenticated", AUTH_USER.manager);
    const [pub] = await q<{ taken: number; riders: string[] }>(
      "select taken, riders from public.public_adventure_departures('bicii-125') where id = $1",
      [date.id],
    );
    expect(pub).toEqual({ taken: 2, riders: [`Asha ${t.slice(0, 1).toUpperCase()}.`] });
    await q("reset role");
  });

  await signIn(page, "manager", `/adventures/departures/${date.id}`);
  await expect(page.getByText("2 of 4 places")).toBeVisible();
  const riders = page.getByRole("list", { name: "Riders" });
  await expect(riders.getByRole("link", { name: `Asha ${t}` })).toBeVisible();
  await expect(riders.getByRole("link", { name: `Bryn ${t}` })).toBeVisible();
  await expect(riders.getByText("Name shown publicly")).toHaveCount(1);

  await page.getByRole("button", { name: "Cancel date" }).click();
  await page.getByRole("dialog").getByLabel("Reason").fill("Thunderstorm warning");
  await page.getByRole("dialog").getByRole("button", { name: "Cancel date" }).click();
  await expect(toast(page, "Date cancelled")).toBeVisible();

  // S09: the tickets stand, and each rider is told by email.
  expect(await bookingStatus(a.bookingId)).toBe("confirmed");
  expect(await bookingStatus(b.bookingId)).toBe("confirmed");
  const notices = await sql<{ n: number }>(
    `select count(*)::int as n from private.adventure_notices
      where booking_id = any($1::uuid[]) and kind = 'departure_cancelled'`,
    [[a.bookingId, b.bookingId]],
  );
  expect(notices[0].n).toBe(2);
});

test("a supported date with its included tracker", async ({ page, request }, testInfo) => {
  const t = tag(testInfo.project.name);
  await paidBooking(request, `Seed ${t}`); // publishes the self-supported offer
  const label = `S-${t}`;
  const meeting = `Van ${t}`;
  let date = { id: "", version: 0 };
  let prepared = { bookingId: "", paymentId: "", amountCents: 0 };
  await sqlTransaction(async (q) => {
    await supportedOn(q);
    await trackerInService(q, label);
    date = await departureFor(q, "supported", meeting, 14, 2);
    const rider = await newRider(q, `Sol ${t}`);
    prepared = await prepareCheckout(q, rider.authUserId, "supported", date.id);
  });
  // P04, P06: S$149 for a one-day supported ride, no separate hire charge.
  expect(prepared.amountCents).toBe(14_900);
  await stripeSays(request, prepared, "paid");
  expect(await bookingStatus(prepared.bookingId)).toBe("confirmed");
  const lines = await sql<{ kind: string }>(
    "select kind from public.adventure_booking_lines where booking_id = $1",
    [prepared.bookingId],
  );
  expect(lines.map((l) => l.kind)).toEqual(["certification"]);
  const [res] = await sql<{ status: string }>(
    "select status::text from public.tracker_reservations where booking_id = $1",
    [prepared.bookingId],
  );
  expect(res.status).toBe("confirmed");

  await signIn(page, "manager", `/adventures/departures/${date.id}`);
  await expect(page.getByText("1 of 2 places")).toBeVisible();
  await page.getByRole("button", { name: `Check in Sol ${t}` }).click();
  await expect(toast(page, "Checked in")).toBeVisible();
  await expect(page.getByRole("list", { name: "Riders" }).getByText(/Checked in/)).toBeVisible();

  // The included tracker is collected like any hire, on the date's day.
  await page.goto(`/adventures/bookings/${prepared.bookingId}`);
  await expect(page.getByRole("heading", { name: "Tracker hire" })).toBeVisible();
});

test("changes requested, then the rider sends the ride again", async ({
  page,
  request,
}, testInfo) => {
  const rider = `Remy ${tag(testInfo.project.name)}`;
  const ride = await submittedRide(request, rider);

  await signIn(page, "manager", `/adventures/reviews/${ride.submissionId}`);
  await page.getByRole("button", { name: "Start review" }).click();
  await page.getByLabel("Decision").selectOption("changes_requested");
  await page.getByLabel("Message to the rider").fill("Add the Seletar checkpoint photo.");
  await page.getByRole("button", { name: "Send back to the rider" }).click();
  await expect(page.getByText(/Version 1: .*changes/i)).toBeVisible();

  // E06: the rider adds a file and sends a second version; no new purchase.
  const second = await resubmit(ride.bookingId);
  const purchases = await sql<{ n: number }>(
    `select count(*)::int as n from public.adventure_bookings b
      where b.customer_id = (select customer_id from public.adventure_bookings where id = $1)`,
    [ride.bookingId],
  );
  expect(purchases[0].n).toBe(1);

  await page.goto(`/adventures/reviews/${second}`);
  await expect(page.getByText(/version 2/)).toBeVisible();
  await expect(page.getByText(/Version 1: .*changes/i)).toBeVisible();
});

test("a failed payment, then the rider pays on a retry", async ({ request }, testInfo) => {
  const t = tag(testInfo.project.name);
  await paidBooking(request, `Seed ${t}`); // the offer on sale
  let rider = "";
  let first = { bookingId: "", paymentId: "", amountCents: 0 };
  await sqlTransaction(async (q) => {
    rider = (await newRider(q, `Faye ${t}`)).authUserId;
    first = await prepareCheckout(q, rider, "self_supported");
  });
  await stripeSays(request, first, "failed");
  // C07, C14: not paid, and nothing pretends it was.
  expect(await bookingStatus(first.bookingId)).not.toBe("confirmed");
  // A repeated failure changes nothing.
  await stripeSays(request, first, "failed");

  let retry = { bookingId: "", paymentId: "", amountCents: 0 };
  await sqlTransaction(async (q) => {
    retry = await prepareCheckout(q, rider, "self_supported");
  });
  await stripeSays(request, retry, "paid");
  await stripeSays(request, retry, "paid"); // C04: a repeated paid event
  expect(await bookingStatus(retry.bookingId)).toBe("confirmed");
  const confirmed = await sql<{ n: number; notices: number }>(
    `select count(*)::int as n,
            (select count(*)::int from private.adventure_notices nn
              where nn.booking_id = $2 and nn.kind = 'ticket_paid') as notices
       from public.adventure_bookings b
       join public.customers c on c.id = b.customer_id
      where c.auth_user_id = $1 and b.status = 'confirmed'`,
    [rider, retry.bookingId],
  );
  expect(confirmed[0]).toEqual({ n: 1, notices: 1 });
});

test("a late point lands with its rider after the tracker went to someone else", async ({
  page,
  request,
}, testInfo) => {
  const t = tag(testInfo.project.name);
  const label = `R-${t}`;
  let device = "";
  await sqlTransaction(async (q) => {
    device = await trackerInService(q, label);
  });
  const a = await paidBooking(request, `Ari ${t}`, { hire: true });
  const b = await paidBooking(request, `Bea ${t}`, { hire: true });
  let attemptA = "";
  await sqlTransaction(async (q) => {
    // Rider A rides with the tracker, finishes and returns it.
    const assignment = await issue(q, a.bookingId, device);
    await q("set local session_replication_role = replica");
    await q(
      "update public.tracker_assignments set issued_at = now() - interval '4 hours' where id = $1",
      [assignment],
    );
    await q("set local session_replication_role = origin");
    const [x] = await q<{ attempt_id: string }>(
      "select attempt_id from public.tracker_assignments where id = $1",
      [assignment],
    );
    attemptA = x.attempt_id;
    await actAs(q, "authenticated", AUTH_USER.manager);
    await q(
      `select public.correct_adventure_capture($1, now() - interval '3 hours', now() - interval '1 hour', 'E2E: the ride window')`,
      [attemptA],
    );
    await q("select public.return_adventure_tracker($1, 'good', '')", [assignment]);
    // The same tracker goes to rider B.
    await issue(q, b.bookingId, device);
  });

  // The feed then delivers a point recorded during A's ride.
  await sqlTransaction(async (q) => {
    await actAs(q, "authenticated", AUTH_USER.admin);
    const [feed] = await q<{ id: string }>(
      "select id from public.save_tracking_feed(null, 'fake', $1, $2, true)",
      [`E2E ${t}`, `TRACKING_FEED_E2E_${t.toUpperCase()}`],
    );
    await q("reset role");
    await q(
      "update public.tracking_feeds set next_request_at = now() - interval '1 second', lease_until = null, lease_token = null where id = $1",
      [feed.id],
    );
    await actAs(q, "service_role");
    const claimed = await q<{ feed_id: string; lease_token: string }>(
      "select * from public.claim_tracking_feed()",
    );
    const lease = claimed.find((c) => c.feed_id === feed.id) ?? claimed[0];
    await q("select public.store_tracking_messages($1, $2, $3::jsonb, true, now(), null)", [
      lease.feed_id,
      lease.lease_token,
      JSON.stringify([
        {
          providerMessageId: `late-${t}`,
          providerDeviceId: `ESN-${label}`,
          recordedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
          kind: "position",
          latitude: 1.33,
          longitude: 103.84,
        },
      ]),
    ]);
    await q("reset role");
  });
  const [m] = await sql<{ attempt_id: string | null }>(
    "select attempt_id from public.tracking_messages where provider_message_id = $1",
    [`late-${t}`],
  );
  expect(m.attempt_id).toBe(attemptA);

  // Staff see the tracker out with rider B, and A's ride kept its point.
  await signIn(page, "manager", "/adventures/handovers");
  await expect(
    page
      .getByRole("list", { name: "Out with riders" })
      .getByRole("listitem")
      .filter({ hasText: b.reference }),
  ).toContainText(label);
});

test("one customer cannot touch another's booking", async ({ request }, testInfo) => {
  const t = tag(testInfo.project.name);
  const a = await paidBooking(request, `Own ${t}`);
  const b = await paidBooking(request, `Other ${t}`);
  const intruder = await riderOf(b.bookingId);
  const attempts: [string, unknown[]][] = [
    ["select public.request_my_adventure_cancellation($1, 'mine now')", [a.bookingId]],
    ["select * from public.my_adventure_ride_points($1)", [a.bookingId]],
    ["select * from public.create_my_ride_share($1, 6)", [a.bookingId]],
    ["select public.revoke_my_ride_share($1)", [a.bookingId]],
    [
      "select * from public.prepare_my_adventure_upload($1, 'activity', null, 'x.gpx', 'application/gpx+xml', 10)",
      [a.bookingId],
    ],
    ["select public.start_my_adventure_ride($1)", [a.bookingId]],
    ["select public.submit_my_adventure_evidence($1, '')", [a.bookingId]],
  ];
  for (const [statement, values] of attempts) {
    await expect(
      sqlTransaction(async (q) => {
        await actAs(q, "authenticated", intruder);
        await q(statement, values);
      }),
      statement,
    ).rejects.toMatchObject({ code: "42501" });
  }
  // Reads return nothing rather than someone else's rows.
  await sqlTransaction(async (q) => {
    await actAs(q, "authenticated", intruder);
    for (const fn of [
      "my_adventure_booking",
      "my_adventure_evidence",
      "my_adventure_outcome",
      "my_adventure_tracker",
      "my_adventure_ride",
      "my_adventure_departure",
      "my_ride_share",
    ]) {
      const rows = await q(`select * from public.${fn}($1)`, [a.bookingId]);
      expect(
        rows.filter((r) => Object.values(r).some((v) => v !== null)),
        fn,
      ).toEqual([]);
    }
    const mine = await q<{ id: string }>("select id from public.my_adventure_bookings()");
    expect(mine.map((r) => r.id)).toEqual([b.bookingId]);
    await q("reset role");
  });
  // D207: a ticket never changes hands, not even by direct SQL.
  await expect(
    sql(
      "update public.adventure_bookings set customer_id = (select customer_id from public.adventure_bookings where id = $2) where id = $1",
      [a.bookingId, b.bookingId],
    ),
  ).rejects.toMatchObject({ message: "adventure_booking_immutable" });
});

// ---------------------------------------------------------------------------

async function riderAuth(q: Query, bookingId: string): Promise<string> {
  await q("reset role");
  const [r] = await q<{ auth_user_id: string }>(
    `select c.auth_user_id from public.adventure_bookings b
       join public.customers c on c.id = b.customer_id where b.id = $1`,
    [bookingId],
  );
  return r.auth_user_id;
}

/** Gives the booking's reserved tracker out as the manager; returns the assignment. */
async function issue(q: Query, bookingId: string, deviceId: string): Promise<string> {
  await q("reset role");
  const [res] = await q<{ id: string }>(
    "select id from public.tracker_reservations where booking_id = $1",
    [bookingId],
  );
  await actAs(q, "authenticated", AUTH_USER.manager);
  const [a] = await q<{ id: string }>("select id from public.issue_adventure_tracker($1, $2, '')", [
    res.id,
    deviceId,
  ]);
  await q("reset role");
  return a.id;
}

/** The rider adds another recording and sends version 2; returns its submission id. */
async function resubmit(bookingId: string): Promise<string> {
  const rider = await riderOf(bookingId);
  let id = "";
  await sqlTransaction(async (q) => {
    await q("select pg_advisory_xact_lock(hashtext('e2e-adventure-parse'))");
    await actAs(q, "authenticated", rider);
    const [file] = await q<{ file_id: string; storage_path: string }>(
      `select file_id, storage_path from public.prepare_my_adventure_upload(
         $1, 'activity', null, 'ride-2.gpx', 'application/gpx+xml', 40000)`,
      [bookingId],
    );
    await q("reset role");
    await q(
      `insert into storage.objects (bucket_id, name, metadata)
       values ('adventure-evidence', $1, jsonb_build_object('mimetype', 'application/gpx+xml', 'size', 40000))`,
      [file.storage_path],
    );
    await actAs(q, "authenticated", rider);
    await q("select public.finalise_my_adventure_upload($1)", [file.file_id]);
    await actAs(q, "service_role");
    // A new version re-reads the files it carries over from version 1, and
    // older waiting files are claimed first: claim until this draft's files
    // are all taken, and read each of them.
    const track = JSON.stringify({
      format: "gpx",
      started_at: "2026-11-14T22:00:00Z",
      finished_at: "2026-11-15T08:00:00Z",
      distance_km: 131.9,
      has_times: true,
      points: [
        ["2026-11-14T22:00:00Z", 1.35, 103.82],
        ["2026-11-15T08:00:00Z", 1.36, 103.83],
      ],
    });
    await q("reset role");
    const mine = await q<{ id: string }>(
      `select f.id from public.adventure_evidence_files f
         where f.submission_id = (select submission_id from public.adventure_evidence_files where id = $1)
           and f.kind = 'activity' and f.state = 'uploaded'`,
      [file.file_id],
    );
    const waiting = new Set(mine.map((m) => m.id));
    await actAs(q, "service_role");
    for (let i = 0; i < 30 && waiting.size > 0; i++) {
      const claimed = await q<{ file_id: string }>(
        "select file_id from public.claim_adventure_parse_jobs(10)",
      );
      if (claimed.length === 0) break;
      for (const c of claimed) {
        if (!waiting.delete(c.file_id)) continue;
        await q("select public.finish_adventure_parse($1, true, '', $2, 'e2e', $3::jsonb)", [
          c.file_id,
          "e".repeat(64),
          track,
        ]);
      }
    }
    await actAs(q, "authenticated", rider);
    await q("select public.submit_my_adventure_evidence($1, 'Added the Seletar photo.')", [
      bookingId,
    ]);
    await q("reset role");
    const [s] = await q<{ id: string }>(
      `select s.id from public.adventure_submissions s
         join public.adventure_attempts a on a.id = s.attempt_id
        where a.booking_id = $1 and s.state = 'submitted'`,
      [bookingId],
    );
    id = s.id;
  });
  return id;
}
