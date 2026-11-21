/**
 * The customer job projection (SPEC §4.2, §7, §23 "Customers cannot read
 * internal notes, costs, yield ..."; DATA-MODEL §15 "Customer access"; PLAN
 * D8, D17, D19), on the seeded jobs:
 *
 *   * a signed-in customer reads nothing of the workshop tables and views;
 *   * my_work_orders lists exactly their own jobs (cancelled hidden) with
 *     customer-safe columns and the coarse customer status;
 *   * my_work_order_lines shows live lines' sale side only;
 *   * my_work_order_timeline shows check-in, customer-status changes and
 *     customer-visible photos that still exist, nothing else;
 *   * my_work_order_attachments never shows an internal photo;
 *   * customer B gets nothing for A's job; D17: a job stays with the
 *     customer it was for, after a transfer and after the bike is archived;
 *   * staff without a customers row get nothing; anonymous callers cannot
 *     call any of them.
 *
 * Every test runs in a rolled-back transaction and reads the seed only, so
 * the file also runs against an existing seeded database.
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import {
  AUTH_USER,
  BIKE,
  BIKE_SHORT_ID,
  CUSTOMER,
  JOB_NUMBER,
  LINE,
  REPORT_JOB,
  REPORT_JOB_NUMBER,
  STAFF,
  WORK_ORDER,
} from "../fixtures/ids";
import {
  archiveCustomerUnguarded,
  attachmentPath,
  customerClaims,
  linkCustomerLogin,
} from "./customer-fixtures";
import { actAs, asAnon, asStaff, connect, inTransaction, scalar, staffClaims } from "./harness";

let conn: pg.Client;

beforeAll(async () => {
  conn = await connect();
});

const JOB_COLUMNS = [
  "bike_id",
  "bike_short_id",
  "bike_title",
  "checked_in_at",
  "collected_at",
  "completed_at",
  "currency",
  "id",
  "job_number",
  "ready_for_collection_at",
  "sale_total",
  "status",
].sort();

/**
 * Tan's non-cancelled jobs, newest first (checked_in_at desc): H5 on the
 * Brompton, H4 on the Tarmac and H1 on the Brompton (Phase 5), J-000001 on
 * the Tarmac.
 */
const TAN_JOBS = [
  REPORT_JOB.rounding,
  REPORT_JOB.lossLine,
  REPORT_JOB.serviceOnly,
  WORK_ORDER.tanTarmacCollected,
];

const LINE_COLUMNS = [
  "currency",
  "description",
  "id",
  "quantity",
  "sale_total",
  "unit_sale_price",
].sort();

const TIMELINE_COLUMNS = ["attachment_id", "created_at", "id", "kind", "status"].sort();

const ATTACHMENT_COLUMNS = [
  "caption",
  "created_at",
  "height",
  "id",
  "media_type",
  "storage_bucket",
  "storage_path",
  "visibility",
  "width",
].sort();

/** Words that must never reach a customer from the seeded jobs. */
const NEVER_SHOWN =
  /spongy|scratches|pads at 40%|GP5000 upgrade by phone|Waiting for the customer|0\.75% wear|bring it back|press-fit|requested_work|internal_notes|intake_notes|completion_notes|approval|lead_mechanic|cost|yield|cult_commons|actor|assigned/i;

const rowsOf = (tx: pg.Client, sql: string, params: unknown[] = []) =>
  tx.query(sql, params).then((r) => r.rows);

/**
 * Runs `fn` as a signed-in customer: links a new login to the seeded
 * customer (as the owner), runs `setup` as the owner, then switches identity.
 */
async function asCustomer<T>(
  customerId: string,
  fn: (tx: pg.Client) => Promise<T>,
  setup: (tx: pg.Client) => Promise<void> = async () => {},
): Promise<T> {
  return inTransaction(conn, async (tx) => {
    const login = await linkCustomerLogin(tx, customerId);
    await setup(tx);
    await actAs(tx, customerClaims(login));
    return fn(tx);
  });
}

/** Photos on a job, inserted as the owner (the trigger writes photo_added). */
async function addJobPhotos(
  tx: pg.Client,
  workOrderId: string,
  visibilities: ("internal" | "customer")[],
): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const visibility of visibilities) {
    const id = randomUUID();
    await tx.query(
      `insert into public.attachments
         (id, entity_type, entity_id, storage_bucket, storage_path, media_type, visibility, caption)
       values ($1, 'work_order', $2, 'media-internal', $3, 'image/jpeg', $4, $5)`,
      [id, workOrderId, attachmentPath("work_order", workOrderId, id), visibility, `${visibility}`],
    );
    ids[visibility] = id;
  }
  return ids;
}

const myJobs = (tx: pg.Client) => rowsOf(tx, "select * from public.my_work_orders()");
const myJobIds = async (tx: pg.Client) => (await myJobs(tx)).map((r) => r.id as string);
const myLines = (tx: pg.Client, id: string) =>
  rowsOf(tx, "select * from public.my_work_order_lines($1)", [id]);
const myTimeline = (tx: pg.Client, id: string) =>
  rowsOf(tx, "select * from public.my_work_order_timeline($1)", [id]);
const myPhotos = (tx: pg.Client, id: string) =>
  rowsOf(tx, "select * from public.my_work_order_attachments($1)", [id]);

/** The timeline as [kind, status or attachment id] pairs. */
const timelineShape = async (tx: pg.Client, id: string) =>
  (await myTimeline(tx, id)).map((r) => [r.kind, r.status ?? r.attachment_id]);

describe("a signed-in customer and the workshop tables", () => {
  it("reads nothing at all, although the seed has their jobs, lines and staff", async () => {
    await asCustomer(CUSTOMER.tan, async (tx) => {
      for (const relation of [
        "work_orders",
        "work_order_assignments",
        "work_order_events",
        "work_order_line_items",
        "services",
        "categories",
        "cult_commons_rates",
        "work_order_totals",
        "work_order_totals_staff",
        "work_order_line_items_staff",
        "services_staff",
      ]) {
        expect({
          relation,
          n: await scalar(tx, `select count(*)::int from public.${relation}`),
        }).toEqual({ relation, n: 0 });
      }
    });
  });
});

describe("my_work_orders", () => {
  it("lists exactly the caller's non-cancelled jobs, with customer-safe columns only", async () => {
    const rows = await asCustomer(CUSTOMER.tan, myJobs);
    // Tan's Brompton job J-000008 was cancelled; the rest are his, newest
    // first (Phase 5 adds H4 on the Tarmac and H1, H5 on the Brompton).
    expect(rows.map((r) => r.id)).toEqual(TAN_JOBS);
    const tarmac = rows.find((r) => r.id === WORK_ORDER.tanTarmacCollected)!;
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(JOB_COLUMNS);
    expect(tarmac).toMatchObject({
      job_number: JOB_NUMBER.tanTarmacCollected,
      bike_id: BIKE.tanTarmac,
      bike_short_id: BIKE_SHORT_ID.tanTarmac,
      bike_title: "Specialized Tarmac SL7 Expert",
      status: "collected",
      currency: "SGD",
      sale_total: "290.00",
    });
    for (const stamp of [
      "checked_in_at",
      "completed_at",
      "ready_for_collection_at",
      "collected_at",
    ]) {
      expect(tarmac[stamp]).toBeInstanceOf(Date);
    }
    expect(JSON.stringify(rows)).not.toMatch(NEVER_SHOWN);
  });

  it("lists newest first, with the coarse customer status and the live lines' total", async () => {
    const priya = await asCustomer(CUSTOMER.priya, myJobs);
    expect(
      priya.map((r) => [r.job_number, r.status, r.sale_total, r.completed_at === null]),
    ).toEqual([
      // Diagnosing reads as received; the voided bottom bracket is not in the total.
      [JOB_NUMBER.priyaTernDiagnosing, "received", "80.00", true],
      [JOB_NUMBER.priyaDomaneReady, "ready_for_collection", "300.00", false],
      [REPORT_JOB_NUMBER.overdue, "awaiting_parts", "150.00", true],
      [REPORT_JOB_NUMBER.uncollected, "ready_for_collection", "120.00", false],
    ]);
    const chloe = await asCustomer(CUSTOMER.chloe, myJobs);
    expect(chloe.map((r) => [r.job_number, r.status])).toEqual([
      [REPORT_JOB_NUMBER.todayReceived, "received"],
      [REPORT_JOB_NUMBER.todayCollected, "collected"],
      [JOB_NUMBER.chloeGiantInProgress, "in_progress"],
      [REPORT_JOB_NUMBER.partsOnly, "collected"],
      [JOB_NUMBER.chloeSurlyAwaitingParts, "awaiting_parts"],
    ]);
    const daniel = await asCustomer(CUSTOMER.daniel, myJobs);
    expect(daniel.map((r) => [r.job_number, r.status, r.sale_total])).toEqual([
      [REPORT_JOB_NUMBER.todayInProgress, "in_progress", "90.00"],
      [REPORT_JOB_NUMBER.combined, "collected", "1000.00"],
      [JOB_NUMBER.danielCannondaleAwaitingCustomer, "awaiting_customer", "0.00"],
    ]);
  });

  it("maps every internal status to the customer status (D17)", async () => {
    await inTransaction(conn, async (tx) => {
      const pairs = await rowsOf(
        tx,
        `select s::text as status, private.customer_job_status(s)::text as customer
           from unnest(enum_range(null::public.work_order_status)) s`,
      );
      expect(Object.fromEntries(pairs.map((p) => [p.status, p.customer]))).toEqual({
        received: "received",
        diagnosing: "received",
        awaiting_customer: "awaiting_customer",
        awaiting_parts: "awaiting_parts",
        ready_to_start: "received",
        in_progress: "in_progress",
        paused: "in_progress",
        completed: "completed",
        ready_for_collection: "ready_for_collection",
        collected: "collected",
        cancelled: null,
      });
    });
  });
});

describe("my_work_order_lines", () => {
  it("shows the live lines' description, quantity, unit price and total only", async () => {
    const rows = await asCustomer(CUSTOMER.priya, (tx) => myLines(tx, WORK_ORDER.priyaDomaneReady));
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(LINE_COLUMNS);
    expect(rows).toEqual([
      {
        id: LINE.priyaDomaneBasicService,
        description: "Basic Service",
        quantity: "1.00",
        unit_sale_price: "80.00",
        sale_total: "80.00",
        currency: "SGD",
      },
      {
        id: LINE.priyaDomaneTyreInstallation,
        description: "Tyre Installation",
        quantity: "2.00",
        unit_sale_price: "15.00",
        sale_total: "30.00",
        currency: "SGD",
      },
      {
        id: LINE.priyaDomaneTyres,
        description: "Continental GP5000 700×28c tyre",
        quantity: "2.00",
        unit_sale_price: "95.00",
        sale_total: "190.00",
        currency: "SGD",
      },
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/62|124|cost|yield|cult/i);
  });

  it("leaves out voided lines", async () => {
    const rows = await asCustomer(CUSTOMER.priya, (tx) =>
      myLines(tx, WORK_ORDER.priyaTernDiagnosing),
    );
    expect(rows.map((r) => r.id)).toEqual([LINE.priyaTernBasicService]);
  });
});

describe("my_work_order_timeline", () => {
  it("shows check-in and each change of the customer status, without actors or notes", async () => {
    const rows = await asCustomer(CUSTOMER.tan, (tx) =>
      myTimeline(tx, WORK_ORDER.tanTarmacCollected),
    );
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(TIMELINE_COLUMNS);
    expect(rows.map((r) => [r.kind, r.status, r.attachment_id])).toEqual([
      ["checked_in", "received", null],
      ["status", "in_progress", null],
      ["status", "completed", null],
      ["status", "ready_for_collection", null],
      ["status", "collected", null],
    ]);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].created_at.getTime()).toBeGreaterThan(rows[i - 1].created_at.getTime());
    }
  });

  it("received -> diagnosing, notes, approvals, assignments and lines produce no entry", async () => {
    // J-000009: assigned, two lines (one voided), diagnosing. J-000002: an approval.
    expect(
      await asCustomer(CUSTOMER.priya, (tx) => timelineShape(tx, WORK_ORDER.priyaTernDiagnosing)),
    ).toEqual([["checked_in", "received"]]);
    expect(
      await asCustomer(CUSTOMER.priya, (tx) => timelineShape(tx, WORK_ORDER.priyaDomaneReady)),
    ).toEqual([
      ["checked_in", "received"],
      ["status", "in_progress"],
      ["status", "completed"],
      ["status", "ready_for_collection"],
    ]);
    // J-000005: a note, then awaiting parts.
    expect(
      await asCustomer(CUSTOMER.chloe, (tx) =>
        timelineShape(tx, WORK_ORDER.chloeSurlyAwaitingParts),
      ),
    ).toEqual([
      ["checked_in", "received"],
      ["status", "awaiting_parts"],
    ]);
  });

  it("in_progress <-> paused produce no entry; completing and reopening do", async () => {
    await inTransaction(conn, async (tx) => {
      const chloe = await linkCustomerLogin(tx, CUSTOMER.chloe);
      const job = WORK_ORDER.chloeGiantInProgress;
      await actAs(tx, staffClaims(AUTH_USER.mechanic1));
      for (const [status, note] of [
        ["paused", null],
        ["in_progress", null],
        ["paused", null],
        ["completed", null],
        ["in_progress", "Wheel still rubs the pad"],
      ]) {
        await tx.query("select public.set_work_order_status($1, $2, $3)", [job, status, note]);
      }
      await actAs(tx, customerClaims(chloe));
      expect(await timelineShape(tx, job)).toEqual([
        ["checked_in", "received"],
        // diagnosing at +1h reads as received: no entry.
        ["status", "in_progress"],
        ["status", "completed"],
        ["status", "in_progress"],
      ]);
      expect(JSON.stringify(await myTimeline(tx, job))).not.toMatch(/rubs the pad/);
    });
  });

  it("shows customer photos that still exist, never internal, hidden or deleted ones", async () => {
    await inTransaction(conn, async (tx) => {
      const job = WORK_ORDER.chloeGiantInProgress;
      const kept = await addJobPhotos(tx, job, ["internal", "customer"]);
      const hidden = await addJobPhotos(tx, job, ["customer"]);
      const deleted = await addJobPhotos(tx, job, ["customer"]);
      await tx.query("update public.attachments set visibility = 'internal' where id = $1", [
        hidden.customer,
      ]);
      await tx.query("select private.set_change_reason('Blurry')");
      await tx.query("delete from public.attachments where id = $1", [deleted.customer]);
      const chloe = await linkCustomerLogin(tx, CUSTOMER.chloe);
      await actAs(tx, customerClaims(chloe));
      expect(await timelineShape(tx, job)).toEqual([
        ["checked_in", "received"],
        ["status", "in_progress"],
        ["photo", kept.customer],
      ]);
    });
  });
});

describe("my_work_order_attachments", () => {
  it("returns the job's customer photos with the my_bike_attachments columns, never internal ones", async () => {
    let ids: Record<string, string> = {};
    const rows = await asCustomer(
      CUSTOMER.chloe,
      (tx) => myPhotos(tx, WORK_ORDER.chloeGiantInProgress),
      async (tx) => {
        ids = await addJobPhotos(tx, WORK_ORDER.chloeGiantInProgress, ["internal", "customer"]);
      },
    );
    expect(rows.map((r) => r.id)).toEqual([ids.customer]);
    expect(rows[0]).toMatchObject({ visibility: "customer", storage_bucket: "media-internal" });
    expect(Object.keys(rows[0]).sort()).toEqual(ATTACHMENT_COLUMNS);
  });

  it("returns nothing for a cancelled job", async () => {
    const rows = await asCustomer(
      CUSTOMER.tan,
      async (tx) => ({
        photos: await myPhotos(tx, WORK_ORDER.tanBromptonCancelled),
        lines: await myLines(tx, WORK_ORDER.tanBromptonCancelled),
        timeline: await myTimeline(tx, WORK_ORDER.tanBromptonCancelled),
      }),
      async (tx) => {
        await addJobPhotos(tx, WORK_ORDER.tanBromptonCancelled, ["customer"]);
      },
    );
    expect(rows).toEqual({ photos: [], lines: [], timeline: [] });
  });
});

describe("customer A and customer B", () => {
  it("B gets nothing for A's job: no listing, lines, timeline or photos", async () => {
    const result = await asCustomer(
      CUSTOMER.priya,
      async (tx) => ({
        jobs: (await myJobIds(tx)).includes(WORK_ORDER.tanTarmacCollected),
        lines: await myLines(tx, WORK_ORDER.tanTarmacCollected),
        timeline: await myTimeline(tx, WORK_ORDER.tanTarmacCollected),
        photos: await myPhotos(tx, WORK_ORDER.tanTarmacCollected),
      }),
      async (tx) => {
        await addJobPhotos(tx, WORK_ORDER.tanTarmacCollected, ["customer"]);
      },
    );
    expect(result).toEqual({ jobs: false, lines: [], timeline: [], photos: [] });
  });

  it("an unknown job id returns nothing rather than an error", async () => {
    const id = randomUUID();
    expect(
      await asCustomer(CUSTOMER.tan, async (tx) => [
        ...(await myLines(tx, id)),
        ...(await myTimeline(tx, id)),
        ...(await myPhotos(tx, id)),
      ]),
    ).toEqual([]);
  });
});

describe("D17: a job stays with the customer it was for", () => {
  it("after a transfer the previous owner keeps their job history; the new owner does not see it", async () => {
    await inTransaction(conn, async (tx) => {
      const tan = await linkCustomerLogin(tx, CUSTOMER.tan);
      const priya = await linkCustomerLogin(tx, CUSTOMER.priya);
      await actAs(tx, staffClaims(AUTH_USER.admin));
      await tx.query("select public.transfer_bike_ownership($1, $2, 'Sold to Priya')", [
        BIKE.tanTarmac,
        CUSTOMER.priya,
      ]);

      await actAs(tx, customerClaims(tan));
      expect(await myJobIds(tx)).toEqual(TAN_JOBS);
      expect(await myLines(tx, WORK_ORDER.tanTarmacCollected)).toHaveLength(2);
      expect(await myTimeline(tx, WORK_ORDER.tanTarmacCollected)).toHaveLength(5);

      await actAs(tx, customerClaims(priya));
      for (const tarmacJob of [WORK_ORDER.tanTarmacCollected, REPORT_JOB.lossLine]) {
        expect(await myJobIds(tx)).not.toContain(tarmacJob);
      }
      expect(await myLines(tx, WORK_ORDER.tanTarmacCollected)).toEqual([]);
      expect(await myTimeline(tx, WORK_ORDER.tanTarmacCollected)).toEqual([]);
    });
  });

  it("on the seeded sale: Daniel sees only his own job, Nurul only the Bianchi's", async () => {
    expect(await asCustomer(CUSTOMER.daniel, myJobIds)).toEqual([
      REPORT_JOB.todayInProgress,
      REPORT_JOB.combined,
      WORK_ORDER.danielCannondaleAwaitingCustomer,
    ]);
    expect(await asCustomer(CUSTOMER.nurul, myJobIds)).toEqual([WORK_ORDER.nurulBianchiReceived]);
  });

  it("a job on a bike archived afterwards is still listed, with its lines and photos", async () => {
    let photo = "";
    const result = await asCustomer(
      CUSTOMER.tan,
      async (tx) => ({
        jobs: await myJobIds(tx),
        lines: (await myLines(tx, WORK_ORDER.tanTarmacCollected)).length,
        photos: (await myPhotos(tx, WORK_ORDER.tanTarmacCollected)).map((r) => r.id),
        bikes: await rowsOf(tx, "select id from public.my_bikes()"),
      }),
      async (tx) => {
        photo = (await addJobPhotos(tx, WORK_ORDER.tanTarmacCollected, ["customer"])).customer;
        await tx.query("update public.bikes set archived_at = now() where id = $1", [
          BIKE.tanTarmac,
        ]);
      },
    );
    expect(result).toEqual({
      jobs: TAN_JOBS,
      lines: 2,
      photos: [photo],
      // The bike itself is gone from the customer's bikes (Phase 1 rule).
      bikes: [{ id: BIKE.tanBrompton }],
    });
  });
});

describe("staff, archived customers and anonymous callers", () => {
  it("staff without a customers row get empty results", async () => {
    await asStaff(conn, STAFF.mechanic1, async (tx) => {
      expect(await myJobs(tx)).toEqual([]);
      expect(await myLines(tx, WORK_ORDER.priyaDomaneReady)).toEqual([]);
      expect(await myTimeline(tx, WORK_ORDER.priyaDomaneReady)).toEqual([]);
      expect(await myPhotos(tx, WORK_ORDER.priyaDomaneReady)).toEqual([]);
    });
  });

  it("an archived customer sees nothing", async () => {
    expect(
      // Tan has open jobs, so only the owner can archive him (A-22).
      await asCustomer(CUSTOMER.tan, myJobs, (tx) => archiveCustomerUnguarded(tx, CUSTOMER.tan)),
    ).toEqual([]);
  });

  it("anonymous callers cannot call any of them", async () => {
    for (const sql of [
      "select * from public.my_work_orders()",
      `select * from public.my_work_order_lines('${WORK_ORDER.priyaDomaneReady}')`,
      `select * from public.my_work_order_timeline('${WORK_ORDER.priyaDomaneReady}')`,
      `select * from public.my_work_order_attachments('${WORK_ORDER.priyaDomaneReady}')`,
    ]) {
      await expect(asAnon(conn, (tx) => tx.query(sql))).rejects.toMatchObject({ code: "42501" });
    }
  });
});
