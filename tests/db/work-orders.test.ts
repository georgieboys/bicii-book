/**
 * Work orders, their status machine, assignments and timeline (SPEC §2, §7,
 * §7.1-§7.3, §8, §23; DATA-MODEL §4, §15, §16; PLAN D9, D15, D16, D18, D19,
 * D22):
 *
 *   * create_work_order checks a bike in atomically (job, J- number, lead and
 *     additional staff, known services, timeline) and is replay-safe by id,
 *     whatever happened to the job, bike or customer since;
 *   * a job's customer owns its bike or the bike is a shop bike (D18);
 *   * the status machine in the database equals src/lib/workshop.ts for all
 *     121 pairs, and set_work_order_status accepts exactly the allowed ones;
 *     completed_at and collected_at are different events (SPEC §23);
 *     reopening and cancelling need a reason; cancelling needs no live lines;
 *   * one event per action; no payload carries a cost, yield, rate or Cult
 *     Commons value; the timeline is append-only;
 *   * one active lead per job, kept in work_orders.lead_mechanic_id (D22);
 *   * photos on a job are internal or customer, never public (D19).
 *
 * Inserting jobs consumes private.seq_short_id_j, so the file only runs on a
 * per-file clone (TESTING.md).
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { WORK_ORDER_STATUSES, transitionRule, type WorkOrderStatus } from "@/lib/workshop";

import { AUTH_USER, STAFF } from "../fixtures/ids";
import {
  archiveCustomerUnguarded,
  attachmentPath,
  customerClaims,
  linkCustomerLogin,
  putStorageObject,
} from "./customer-fixtures";
import { insertAppointment, makeType } from "./appointment-fixtures";
import { actAs, connect, inTransaction, isolatedDatabase, scalar, staffClaims } from "./harness";
import {
  addManualLine,
  addServiceLine,
  createWorkOrder,
  eventTypes,
  events,
  failsWith,
  makeBike,
  makeCustomer,
  makeCustomerWithBike,
  makeService,
  ownerMode,
  setStatus,
  tryAndUndo,
  voidLine,
  walkTo,
  workOrder,
} from "./workshop-fixtures";

let conn: pg.Client;

beforeAll(async () => {
  conn = await connect();
});

const ADMIN = staffClaims(AUTH_USER.admin);
const MECHANIC2 = staffClaims(AUTH_USER.mechanic2);

/** Runs `fn` as the owner (setup), then as `claims`; rolled back. */
async function scenario<T>(
  claims: ReturnType<typeof staffClaims>,
  fn: (tx: pg.Client, ids: { customerId: string; bikeId: string }) => Promise<T>,
): Promise<T> {
  return inTransaction(conn, async (tx) => {
    const ids = await makeCustomerWithBike(tx);
    await actAs(tx, claims);
    return fn(tx, ids);
  });
}

const jobNumber = (n: string) => Number(n.slice(2));

/** Creates a job in its own rolled-back transaction; returns its number. */
async function freshJobNumber(): Promise<number> {
  return scenario(ADMIN, async (tx, ids) => jobNumber((await createWorkOrder(tx, ids)).job_number));
}

const count = (tx: pg.Client, sql: string, params: unknown[] = []) =>
  scalar<number>(tx, `select count(*)::int from (${sql}) s`, params);

describe.skipIf(!isolatedDatabase())("check-in: create_work_order", () => {
  it("creates the job, its J- number, staff, services and timeline in that order", async () => {
    await inTransaction(conn, async (tx) => {
      const { customerId, bikeId } = await makeCustomerWithBike(tx);
      const serviceId = await makeService(tx, { name: "Puncture Repair", price: "80.00" });
      await actAs(tx, ADMIN);
      await tx.query("select set_config('request.headers', $1, true)", [
        JSON.stringify({ "x-correlation-id": "req-checkin-0001" }),
      ]);
      const lineId = randomUUID();
      const job = await createWorkOrder(tx, {
        customerId,
        bikeId,
        requestedWork: "  Brakes squeal; full service ",
        intakeNotes: "Scratch on top tube",
        leadId: STAFF.mechanic1,
        additional: [STAFF.mechanic2, STAFF.mechanic2, STAFF.mechanic1],
        services: [{ line_id: lineId, service_id: serviceId }],
      });
      expect(job).toMatchObject({
        status: "received",
        customer_id: customerId,
        bike_id: bikeId,
        appointment_id: null,
        lead_mechanic_id: STAFF.mechanic1,
        requested_work: "Brakes squeal; full service",
        intake_notes: "Scratch on top tube",
        created_by: STAFF.admin,
        currency: "SGD",
      });
      expect(job.job_number).toMatch(/^J-[0-9]{6}$/);
      expect(job.status_changed_at).toEqual(job.checked_in_at);

      const second = await createWorkOrder(tx, { customerId, bikeId });
      expect(jobNumber(second.job_number)).toBe(jobNumber(job.job_number) + 1);

      const log = await events(tx, job.id);
      expect(log.map((e) => [e.event_type, e.payload])).toEqual([
        [
          "checked_in",
          {
            job_number: job.job_number,
            customer_id: customerId,
            bike_id: bikeId,
            requested_work: "Brakes squeal; full service",
          },
        ],
        ["assignment_changed", { action: "assigned", staff_id: STAFF.mechanic1, role: "lead" }],
        [
          "assignment_changed",
          { action: "assigned", staff_id: STAFF.mechanic2, role: "additional" },
        ],
        [
          "line_added",
          expect.objectContaining({ line_id: lineId, line_type: "service", sale_total: 80 }),
        ],
      ]);
      for (const e of log) {
        expect(e).toMatchObject({
          actor_staff_id: STAFF.admin,
          actor_user_id: AUTH_USER.admin,
          correlation_id: "req-checkin-0001",
        });
      }
      expect(log[0].created_at).toEqual(job.checked_in_at);
    });
  });

  it("is atomic: a bad service line rolls the whole job back; its number is never reused", async () => {
    const before = await freshJobNumber();
    await expect(
      scenario(ADMIN, (tx, ids) =>
        createWorkOrder(tx, {
          ...ids,
          leadId: STAFF.mechanic1,
          services: [{ line_id: randomUUID(), service_id: randomUUID() }],
        }),
      ),
    ).rejects.toMatchObject({ code: "P0002" });
    expect(await freshJobNumber()).toBe(before + 2);

    await scenario(ADMIN, async (tx, ids) => {
      for (const services of [
        [{ line_id: "not-a-uuid", service_id: randomUUID() }],
        [{ line_id: randomUUID(), service_id: randomUUID(), quantity: "two" }],
        Array.from({ length: 21 }, () => ({ line_id: randomUUID(), service_id: randomUUID() })),
      ]) {
        await failsWith(tx, () => createWorkOrder(tx, { ...ids, services }), { code: "22023" });
      }
      await failsWith(
        tx,
        () =>
          createWorkOrder(tx, {
            ...ids,
            additional: Array.from({ length: 11 }, () => randomUUID()),
          }),
        { code: "22023" },
      );
      expect(
        await count(tx, "select 1 from public.work_orders where customer_id = $1", [
          ids.customerId,
        ]),
      ).toBe(0);
    });
  });

  it("replays by id: the same row, and no new event, line or assignment", async () => {
    await inTransaction(conn, async (tx) => {
      const ids = await makeCustomerWithBike(tx);
      const serviceId = await makeService(tx);
      await actAs(tx, ADMIN);
      const args = {
        id: randomUUID(),
        ...ids,
        leadId: STAFF.mechanic1,
        services: [{ line_id: randomUUID(), service_id: serviceId }],
      };
      const first = await createWorkOrder(tx, args);
      const counts = async () => [
        (await events(tx, first.id)).length,
        await count(tx, "select 1 from public.work_order_line_items where work_order_id = $1", [
          first.id,
        ]),
        await count(tx, "select 1 from public.work_order_assignments where work_order_id = $1", [
          first.id,
        ]),
      ];
      const before = await counts();
      expect(await createWorkOrder(tx, { ...args, leadId: STAFF.mechanic2 })).toEqual(first);
      expect(await counts()).toEqual(before);
    });
  });

  it("replays after the bike changed hands, the customer was archived and the job completed", async () => {
    const id = randomUUID();
    let original = 0;
    await inTransaction(conn, async (tx) => {
      const ids = await makeCustomerWithBike(tx);
      const other = await makeCustomer(tx);
      await actAs(tx, ADMIN);
      const job = await createWorkOrder(tx, { id, ...ids });
      original = jobNumber(job.job_number);
      await walkTo(tx, id, "completed");
      await tx.query("select public.transfer_bike_ownership($1, $2, 'Sold it')", [
        ids.bikeId,
        other,
      ]);
      await ownerMode(tx);
      // The job is still open, so only the owner can archive (A-22).
      await archiveCustomerUnguarded(tx, ids.customerId);
      await actAs(tx, ADMIN);
      const before = await events(tx, id);
      const replay = await createWorkOrder(tx, { id, ...ids });
      expect(replay.id).toBe(id);
      expect(replay.job_number).toBe(job.job_number);
      expect(replay.status).toBe("completed");
      expect(await events(tx, id)).toEqual(before);

      // No number was burned by the replay.
      const next = await createWorkOrder(tx, {
        customerId: other,
        bikeId: ids.bikeId,
      });
      expect(jobNumber(next.job_number)).toBe(original + 1);
    });
  });

  it("refuses the same id for another bike or customer (work_order_conflict)", async () => {
    await scenario(ADMIN, async (tx, ids) => {
      const job = await createWorkOrder(tx, ids);
      await ownerMode(tx);
      const otherBike = await makeBike(tx, ids.customerId);
      await actAs(tx, ADMIN);
      await failsWith(tx, () => createWorkOrder(tx, { id: job.id, ...ids, bikeId: otherBike }), {
        code: "P0001",
        message: "work_order_conflict",
      });
    });
  });

  it("refuses archived customers and archived bikes", async () => {
    await inTransaction(conn, async (tx) => {
      const a = await makeCustomerWithBike(tx);
      const b = await makeCustomerWithBike(tx);
      await tx.query("update public.customers set archived_at = now() where id = $1", [
        a.customerId,
      ]);
      await tx.query("update public.bikes set archived_at = now() where id = $1", [b.bikeId]);
      await actAs(tx, MECHANIC2);
      await failsWith(tx, () => createWorkOrder(tx, a), {
        code: "P0001",
        message: "work_order_customer_archived",
      });
      await failsWith(tx, () => createWorkOrder(tx, b), {
        code: "P0001",
        message: "work_order_bike_archived",
      });
    });
  });

  it("D18: the job's customer must own the bike, or the bike must be a shop bike", async () => {
    await inTransaction(conn, async (tx) => {
      const owner = await makeCustomerWithBike(tx);
      const stranger = await makeCustomer(tx);
      const shopBike = await makeBike(tx, null);
      await actAs(tx, MECHANIC2);
      await failsWith(
        tx,
        () => createWorkOrder(tx, { customerId: stranger, bikeId: owner.bikeId }),
        { code: "P0001", message: "bike_owner_mismatch" },
      );
      expect((await createWorkOrder(tx, { customerId: stranger, bikeId: shopBike })).status).toBe(
        "received",
      );
    });
  });

  it("needs the requested work, known records and active staff", async () => {
    await scenario(MECHANIC2, async (tx, ids) => {
      for (const requestedWork of [null, "", "   "]) {
        await failsWith(tx, () => createWorkOrder(tx, { ...ids, requestedWork }), {
          code: "P0001",
          message: "requested_work_required",
        });
      }
      await failsWith(tx, () => createWorkOrder(tx, { ...ids, customerId: randomUUID() }), {
        code: "P0002",
      });
      await failsWith(tx, () => createWorkOrder(tx, { ...ids, leadId: randomUUID() }), {
        code: "P0002",
      });
      await ownerMode(tx);
      await tx.query("update public.staff set active = false where id = $1", [STAFF.mechanic1]);
      await actAs(tx, MECHANIC2);
      await failsWith(tx, () => createWorkOrder(tx, { ...ids, leadId: STAFF.mechanic1 }), {
        code: "P0001",
        message: "staff_inactive",
      });
      expect(
        await count(tx, "select 1 from public.work_orders where customer_id = $1", [
          ids.customerId,
        ]),
      ).toBe(0);
    });
  });

  it("is for active staff only: signed-in customers and inactive staff are refused", async () => {
    await inTransaction(conn, async (tx) => {
      const ids = await makeCustomerWithBike(tx);
      const login = await linkCustomerLogin(tx, ids.customerId);
      await tx.query("update public.staff set active = false where id = $1", [STAFF.mechanic2]);
      for (const claims of [customerClaims(login), MECHANIC2]) {
        await actAs(tx, claims);
        await failsWith(tx, () => createWorkOrder(tx, ids), { code: "42501" });
      }
    });
  });

  it("nobody writes work orders directly", async () => {
    await scenario(ADMIN, async (tx, ids) => {
      const job = await createWorkOrder(tx, ids);
      for (const [sql, params] of [
        [
          "insert into public.work_orders (customer_id, bike_id, requested_work) values ($1, $2, 'x')",
          [ids.customerId, ids.bikeId],
        ],
        ["update public.work_orders set status = 'in_progress' where id = $1", [job.id]],
        ["delete from public.work_orders where id = $1", [job.id]],
        [
          "insert into public.work_order_assignments (work_order_id, staff_id, role) values ($1, $2, 'lead')",
          [job.id, STAFF.admin],
        ],
      ] as const) {
        await failsWith(tx, () => tx.query(sql, [...params]), { code: "42501" });
      }
    });
  });
});

describe.skipIf(!isolatedDatabase())("status machine (D15, D16)", () => {
  it("completed_at and collected_at represent different events", async () => {
    await scenario(ADMIN, async (tx, { customerId, bikeId }) => {
      const job = await createWorkOrder(tx, { customerId, bikeId });
      const started = await setStatus(tx, job.id, "in_progress");
      await setStatus(tx, job.id, "paused");
      const resumed = await setStatus(tx, job.id, "in_progress");
      expect(resumed.started_at).toEqual(started.started_at);
      await setStatus(tx, job.id, "completed");
      await setStatus(tx, job.id, "ready_for_collection");
      const done = await setStatus(tx, job.id, "collected");
      expect(done.started_at).toEqual(started.started_at);

      const { rows } = await tx.query(
        `select checked_in_at < started_at as started_after_check_in,
                started_at < completed_at as completed_after_start,
                completed_at < ready_for_collection_at as ready_after_completed,
                ready_for_collection_at < collected_at as collected_after_ready,
                collected_at > completed_at as distinct_events,
                status_changed_at = collected_at as status_changed_is_collection
           from public.work_orders where id = $1`,
        [job.id],
      );
      expect(Object.values(rows[0]).every(Boolean)).toBe(true);
      expect(await eventTypes(tx, job.id)).toEqual([
        "checked_in",
        "status_changed",
        "status_changed",
        "status_changed",
        "completed",
        "ready_for_collection",
        "collected",
      ]);
    });
  });

  it("collected cannot precede completed", async () => {
    await scenario(ADMIN, async (tx, ids) => {
      const job = await createWorkOrder(tx, ids);
      await failsWith(tx, () => setStatus(tx, job.id, "collected"), {
        code: "P0001",
        message: "work_order_transition_invalid",
      });
      await setStatus(tx, job.id, "in_progress");
      await failsWith(tx, () => setStatus(tx, job.id, "collected"), {
        code: "P0001",
        message: "work_order_transition_invalid",
      });
      await failsWith(tx, () => setStatus(tx, job.id, "ready_for_collection"), {
        code: "P0001",
        message: "work_order_transition_invalid",
      });
      expect((await workOrder(tx, job.id)).collected_at).toBeNull();
    });
  });

  it("the database's transition table equals transitionRule in src/lib/workshop.ts (121 pairs)", async () => {
    const { rows } = await conn.query<{ from: WorkOrderStatus; to: WorkOrderStatus; rule: string }>(
      `select f::text as from, t::text as to, private.work_order_transition_rule(f, t) as rule
         from unnest(enum_range(null::public.work_order_status)) f
        cross join unnest(enum_range(null::public.work_order_status)) t`,
    );
    expect(rows).toHaveLength(121);
    for (const r of rows) {
      expect({ from: r.from, to: r.to, rule: r.rule }).toEqual({
        from: r.from,
        to: r.to,
        rule: transitionRule(r.from, r.to),
      });
    }
  });

  it("set_work_order_status accepts exactly the allowed off-diagonal pairs (110)", async () => {
    await scenario(MECHANIC2, async (tx, ids) => {
      let checked = 0;
      for (const from of WORK_ORDER_STATUSES) {
        const job = await createWorkOrder(tx, ids);
        await walkTo(tx, job.id, from);
        expect((await workOrder(tx, job.id)).status).toBe(from);
        for (const to of WORK_ORDER_STATUSES) {
          if (to === from) continue;
          checked++;
          const rule = transitionRule(from, to);
          if (rule === null) {
            await failsWith(tx, () => setStatus(tx, job.id, to, "A reason"), {
              code: "P0001",
              message: "work_order_transition_invalid",
            });
            continue;
          }
          if (rule === "reason_required") {
            await failsWith(tx, () => setStatus(tx, job.id, to, "   "), {
              code: "P0001",
              message: "reason_required",
            });
          }
          const moved = await tryAndUndo(tx, () => setStatus(tx, job.id, to, "A reason"));
          expect(moved.status).toBe(to);
        }
      }
      expect(checked).toBe(110);
    });
  });

  // set_work_order_status checks the table itself before it updates, so the
  // test above never reaches the trigger's copy. Direct writers (the owner,
  // a seed, a future definer path) only have the trigger.
  it("the trigger enforces the same table and reasons for direct writers (110 pairs)", async () => {
    await scenario(MECHANIC2, async (tx, ids) => {
      const direct = (id: string, to: WorkOrderStatus) =>
        tx.query("update public.work_orders set status = $2 where id = $1 returning status", [
          id,
          to,
        ]);
      let checked = 0;
      for (const from of WORK_ORDER_STATUSES) {
        await actAs(tx, MECHANIC2);
        const job = await createWorkOrder(tx, ids);
        await walkTo(tx, job.id, from);
        await ownerMode(tx);
        for (const to of WORK_ORDER_STATUSES) {
          if (to === from) continue;
          checked++;
          const rule = transitionRule(from, to);
          await tx.query("select private.set_change_reason(null)");
          if (rule === null) {
            await tx.query("select private.set_change_reason('A reason')");
            await failsWith(tx, () => direct(job.id, to), {
              code: "P0001",
              message: "work_order_transition_invalid",
            });
            continue;
          }
          if (rule === "reason_required") {
            await failsWith(tx, () => direct(job.id, to), {
              code: "P0001",
              message: "reason_required",
            });
            await tx.query("select private.set_change_reason('A reason')");
          }
          const moved = await tryAndUndo(tx, () => direct(job.id, to));
          expect(moved.rows[0].status).toBe(to);
        }
        await tx.query("select private.set_change_reason(null)");
      }
      expect(checked).toBe(110);
    });
  });

  it("the same status is a replay: row unchanged, no event (11 diagonal pairs)", async () => {
    await scenario(MECHANIC2, async (tx, ids) => {
      for (const status of WORK_ORDER_STATUSES) {
        const job = await createWorkOrder(tx, ids);
        const reached = await walkTo(tx, job.id, status);
        const before = await events(tx, job.id);
        expect(await setStatus(tx, job.id, status)).toEqual(reached);
        expect(await events(tx, job.id)).toEqual(before);
      }
    });
  });

  it("reopening needs a reason, clears the completion stamps, keeps started_at and the earlier event", async () => {
    await scenario(ADMIN, async (tx, ids) => {
      for (const from of ["completed", "ready_for_collection"] as const) {
        const job = await createWorkOrder(tx, ids);
        const done = await walkTo(tx, job.id, from);
        await failsWith(tx, () => setStatus(tx, job.id, "in_progress"), {
          code: "P0001",
          message: "reason_required",
        });
        const reopened = await setStatus(tx, job.id, "in_progress", "Brake rub came back");
        expect(reopened).toMatchObject({
          status: "in_progress",
          completed_at: null,
          ready_for_collection_at: null,
          started_at: done.started_at,
        });
        const log = await events(tx, job.id);
        expect(log.map((e) => e.event_type)).toContain("completed");
        expect(log.at(-1)).toMatchObject({
          event_type: "reopened",
          payload: { from, to: "in_progress", note: "Brake rub came back" },
        });
        const again = await setStatus(tx, job.id, "completed");
        expect(again.completed_at!.getTime()).toBeGreaterThanOrEqual(done.completed_at!.getTime());
      }
    });
  });

  it("cancelling needs a reason and no live lines (D16)", async () => {
    await scenario(ADMIN, async (tx, ids) => {
      const job = await createWorkOrder(tx, ids);
      const line = await addManualLine(tx, { workOrderId: job.id, price: "20.00" });
      await failsWith(tx, () => setStatus(tx, job.id, "cancelled"), {
        code: "P0001",
        message: "reason_required",
      });
      await failsWith(tx, () => setStatus(tx, job.id, "cancelled", "Customer withdrew"), {
        code: "P0001",
        message: "work_order_has_lines",
      });
      await voidLine(tx, line, "Not needed");
      const cancelled = await setStatus(tx, job.id, "cancelled", "Customer withdrew");
      expect(cancelled).toMatchObject({
        status: "cancelled",
        cancellation_reason: "Customer withdrew",
      });
      expect(cancelled.cancelled_at).toEqual(cancelled.status_changed_at);
      expect((await events(tx, job.id)).at(-1)).toMatchObject({
        event_type: "cancelled",
        payload: { from: "received", to: "cancelled", note: "Customer withdrew" },
      });
    });
  });

  it("the trigger refuses cancelling with live lines for the owner too", async () => {
    await scenario(ADMIN, async (tx, ids) => {
      const job = await createWorkOrder(tx, ids);
      await addManualLine(tx, { workOrderId: job.id, price: "20.00" });
      await ownerMode(tx);
      await tx.query("select private.set_change_reason('Owner cancel')");
      await failsWith(
        tx,
        () =>
          tx.query("update public.work_orders set status = 'cancelled' where id = $1", [job.id]),
        { code: "P0001", message: "work_order_has_lines" },
      );
    });
  });

  it("the owner cannot change stamps, identity or the lead without the proper path", async () => {
    await scenario(ADMIN, async (tx, ids) => {
      const job = await createWorkOrder(tx, { ...ids, leadId: STAFF.mechanic1 });
      await setStatus(tx, job.id, "in_progress");
      await ownerMode(tx);
      const other = await makeCustomerWithBike(tx);
      for (const [set, params] of [
        ["completed_at = now()", []],
        ["started_at = null", []],
        ["status_changed_at = status_changed_at + interval '1 minute'", []],
        ["job_number = 'J-999999'", []],
        ["customer_id = $2", [other.customerId]],
        ["bike_id = $2", [other.bikeId]],
        ["checked_in_at = checked_in_at - interval '1 day'", []],
        ["lead_mechanic_id = $2", [STAFF.mechanic2]],
        ["lead_mechanic_id = null", []],
      ] as const) {
        await failsWith(
          tx,
          () => tx.query(`update public.work_orders set ${set} where id = $1`, [job.id, ...params]),
          { code: "P0001", message: "work_order_immutable" },
        );
      }
      // A status move whose time goes backwards (backfills must move forward).
      await failsWith(
        tx,
        () =>
          tx.query(
            `update public.work_orders
                set status = 'paused', status_changed_at = status_changed_at - interval '1 hour'
              where id = $1`,
            [job.id],
          ),
        { code: "22023" },
      );
      // An insert starts as received, with no stamps and no lead.
      await failsWith(
        tx,
        () =>
          tx.query(
            "insert into public.work_orders (customer_id, bike_id, requested_work, status) values ($1, $2, 'x', 'completed')",
            [other.customerId, other.bikeId],
          ),
        { code: "P0001", message: "work_order_transition_invalid" },
      );
      // The owner's own valid move is stamped and recorded like any other.
      const { rows } = await tx.query(
        "update public.work_orders set status = 'paused' where id = $1 returning status",
        [job.id],
      );
      expect(rows[0].status).toBe("paused");
    });
  });

  it("an appointment is linked to a job at most once: null -> value once, then work_order_immutable (D40)", async () => {
    await scenario(ADMIN, async (tx, ids) => {
      const job = await createWorkOrder(tx, { ...ids, leadId: STAFF.mechanic1 });
      await setStatus(tx, job.id, "in_progress");
      await ownerMode(tx);
      /** The whole row bar updated_at (set_updated_at moves it on every write). */
      const row = async () => {
        const { rows } = await tx.query("select * from public.work_orders where id = $1", [job.id]);
        delete rows[0].updated_at;
        return rows[0];
      };
      // A checked_in appointment of a customer and bike (owner insert: the
      // link triggers accept only those, D40).
      const type = await makeType(tx);
      const checkedIn = (customerId: string, bikeId: string) =>
        insertAppointment(tx, {
          customerId,
          bikeId,
          typeId: type,
          startsAt: new Date(Date.now() - 60 * 60_000).toISOString(),
          endsAt: new Date(Date.now() - 30 * 60_000).toISOString(),
          status: "checked_in",
        });
      const appointmentId = await checkedIn(ids.customerId, ids.bikeId);
      const before = await row();
      const eventsBefore = await events(tx, job.id);
      const setAppointment = (value: string | null) =>
        tx.query("update public.work_orders set appointment_id = $2 where id = $1", [
          job.id,
          value,
        ]);

      // null -> a value: once, nothing else on the row changes, and exactly
      // one appointment_linked event (created false) joins the timeline.
      await setAppointment(appointmentId);
      expect(await row()).toEqual({ ...before, appointment_id: appointmentId });
      // (Dated at the later of the two check-ins: inside one test
      // transaction that is the job's, so the event sits after checked_in.)
      const linked = await events(tx, job.id);
      const known = new Set(eventsBefore.map((e) => e.id));
      expect(linked.filter((e) => known.has(e.id))).toEqual(eventsBefore);
      expect(linked.filter((e) => !known.has(e.id)).map((e) => [e.event_type, e.payload])).toEqual([
        [
          "appointment_linked",
          expect.objectContaining({ appointment_id: appointmentId, created: false }),
        ],
      ]);

      // Leaving it as it is changes nothing and records nothing more.
      await setAppointment(appointmentId);
      await tx.query(
        "update public.work_orders set internal_notes = 'Linked to the booking' where id = $1",
        [job.id],
      );
      expect((await workOrder(tx, job.id)).appointment_id).toBe(appointmentId);
      expect(
        (await events(tx, job.id)).filter((e) => e.event_type === "appointment_linked"),
      ).toHaveLength(1);

      // Once linked it never changes and is never cleared, even to another
      // checked_in appointment of the same customer and bike.
      const another = await checkedIn(ids.customerId, ids.bikeId);
      for (const value of [another, randomUUID(), null]) {
        await failsWith(tx, () => setAppointment(value), {
          code: "P0001",
          message: "work_order_immutable",
          detail:
            "A job keeps its number, customer, bike and check-in time, and its appointment once linked.",
        });
      }
      expect((await workOrder(tx, job.id)).appointment_id).toBe(appointmentId);

      // private.create_work_order (check-in's new-job path) stores it at
      // insert, with one appointment_linked event (created true) right after
      // checked_in; it is just as fixed afterwards.
      const other = await makeCustomerWithBike(tx);
      const booked = await checkedIn(other.customerId, other.bikeId);
      const { rows } = await tx.query<{ id: string; appointment_id: string }>(
        `select (w).id, (w).appointment_id from (
           select private.create_work_order(
             $1, $2, $3, $4, 'Booked service', null, null, '{}'::uuid[], '[]'::jsonb, $5
           ) w
         ) s`,
        [STAFF.admin, randomUUID(), other.customerId, other.bikeId, booked],
      );
      expect(rows[0].appointment_id).toBe(booked);
      expect(
        (await events(tx, rows[0].id)).map((e) => [e.event_type, e.payload.created ?? null]),
      ).toEqual([
        ["checked_in", null],
        ["appointment_linked", true],
      ]);
      for (const value of [another, randomUUID(), null]) {
        await failsWith(
          tx,
          () =>
            tx.query("update public.work_orders set appointment_id = $2 where id = $1", [
              rows[0].id,
              value,
            ]),
          { code: "P0001", message: "work_order_immutable" },
        );
      }
    });
  });
});

describe.skipIf(!isolatedDatabase())("timeline events", () => {
  it("records details, approval and notes, one event per action, and nothing for no-ops", async () => {
    await scenario(MECHANIC2, async (tx, ids) => {
      const job = await createWorkOrder(tx, { ...ids, intakeNotes: "Dent" });
      const update = (args: unknown[]) =>
        tx
          .query("select (w).* from (select public.update_work_order($1, $2, $3, $4, $5) w) s", [
            job.id,
            ...args,
          ])
          .then((r) => r.rows[0]);

      await update([null, "Dent on top tube", "Customer in a hurry", null]);
      await update([null, null, null, null]);
      await update([null, " Dent on top tube ", null, null]);
      await failsWith(tx, () => update(["  ", null, null, null]), {
        code: "P0001",
        message: "requested_work_required",
      });
      const cleared = await update([null, "", null, null]);
      expect(cleared.intake_notes).toBeNull();

      const flag = (flagged: boolean, note: string | null) =>
        tx.query("select public.set_approval_flag($1, $2, $3)", [job.id, flagged, note]);
      await flag(true, "Customer OK'd extra work by phone");
      await flag(true, "Customer OK'd extra work by phone");
      // A null note keeps the stored one (the switch); '' clears it.
      await flag(false, null);
      expect(await workOrder(tx, job.id)).toMatchObject({
        approval_flag: false,
        approval_note: "Customer OK'd extra work by phone",
      });
      await flag(false, "");
      expect((await workOrder(tx, job.id)).approval_note).toBeNull();

      await ownerMode(tx);
      const otherIds = await makeCustomerWithBike(tx);
      await actAs(tx, MECHANIC2);
      const other = await createWorkOrder(tx, otherIds);

      const noteId = randomUUID();
      const addNote = (id: string, workOrderId: string, kind: string, body: string) =>
        tx.query("select (e).* from (select public.add_work_order_note($1, $2, $3, $4) e) s", [
          id,
          workOrderId,
          kind,
          body,
        ]);
      const note = await addNote(noteId, job.id, "note", "  Called the customer  ");
      expect(note.rows[0]).toMatchObject({
        event_type: "note_added",
        payload: { note_id: noteId, body: "Called the customer" },
      });
      // A retry after a lost response finds the note it already wrote.
      const replay = await addNote(noteId, job.id, "note", "  Called the customer  ");
      expect(replay.rows[0].id).toBe(note.rows[0].id);
      const diagnosisId = randomUUID();
      await addNote(diagnosisId, job.id, "diagnosis", "Worn pads");
      await failsWith(tx, () => addNote(randomUUID(), job.id, "note", "  "), {
        code: "P0001",
        message: "note_required",
      });
      await failsWith(tx, () => addNote(randomUUID(), randomUUID(), "note", "x"), {
        code: "P0002",
      });
      await failsWith(tx, () => addNote(noteId, other.id, "note", "Called the customer"), {
        code: "P0001",
        message: "note_conflict",
      });
      await failsWith(tx, () => addNote(null as unknown as string, job.id, "note", "x"), {
        code: "22004",
      });

      const log = await events(tx, job.id);
      expect(log.map((e) => [e.event_type, e.payload])).toEqual([
        ["checked_in", expect.any(Object)],
        [
          "details_changed",
          {
            intake_notes: { from: "Dent", to: "Dent on top tube" },
            internal_notes: { from: null, to: "Customer in a hurry" },
          },
        ],
        ["details_changed", { intake_notes: { from: "Dent on top tube", to: null } }],
        ["approval_flagged", { flagged: true, note: "Customer OK'd extra work by phone" }],
        ["approval_flagged", { flagged: false, note: "Customer OK'd extra work by phone" }],
        ["approval_flagged", { flagged: false, note: null }],
        ["note_added", { note_id: noteId, body: "Called the customer" }],
        ["diagnosis_added", { note_id: diagnosisId, body: "Worn pads" }],
      ]);
      expect(log.every((e) => e.actor_staff_id === STAFF.mechanic2)).toBe(true);

      // Collected jobs keep their notes open but not their flag.
      await walkTo(tx, job.id, "collected");
      await failsWith(tx, () => flag(false, null), { code: "P0001", message: "work_order_closed" });
      await update([null, null, null, "Pads replaced"]);
      await addNote(randomUUID(), job.id, "note", "Customer happy");
    });
  });

  it("no payload carries a cost, yield, rate or Cult Commons value", async () => {
    await inTransaction(conn, async (tx) => {
      const ids = await makeCustomerWithBike(tx);
      const serviceId = await makeService(tx, {
        name: "Hub Overhaul",
        price: "35.00",
        cost: "7.00",
      });
      await actAs(tx, ADMIN);
      const job = await createWorkOrder(tx, {
        ...ids,
        requestedWork: "Keep the old cables separate; accurate torque please",
        intakeNotes: "Separate rattle",
        leadId: STAFF.mechanic1,
        services: [{ line_id: randomUUID(), service_id: serviceId }],
      });
      const manual = await addManualLine(tx, {
        workOrderId: job.id,
        description: "Custom cable routing",
        price: "95.00",
        cost: "62.00",
      });
      const service = await addServiceLine(tx, { workOrderId: job.id, serviceId, cost: "9.00" });
      await voidLine(tx, service, "Duplicate");
      await tx.query("select public.assign_staff($1, $2, 'lead')", [job.id, STAFF.mechanic2]);
      await tx.query("select public.set_approval_flag($1, true, 'Approved at 62 dollars? no')", [
        job.id,
      ]);
      await tx.query("select public.add_work_order_note($1, $2, 'diagnosis', 'Frayed cable')", [
        randomUUID(),
        job.id,
      ]);
      await walkTo(tx, job.id, "completed");
      await setStatus(tx, job.id, "in_progress", "Recheck");
      await setStatus(tx, job.id, "completed");
      await setStatus(tx, job.id, "collected");
      expect(manual).toEqual(expect.any(String));

      const { rows } = await tx.query<{ key: string | null; scalar: string | null; kind: string }>(
        `with recursive nodes(key, value) as (
           select null::text, e.payload from public.work_order_events e where e.work_order_id = $1
           union all
           select c.key, c.value
             from nodes n
            cross join lateral (
              select o.key, o.value
                from jsonb_each(case when jsonb_typeof(n.value) = 'object' then n.value else '{}'::jsonb end) o
              union all
              select null, a.value
                from jsonb_array_elements(case when jsonb_typeof(n.value) = 'array' then n.value else '[]'::jsonb end) a
            ) c
         )
         select key, jsonb_typeof(value) as kind,
                case when jsonb_typeof(value) in ('object', 'array') then null else value #>> '{}' end as scalar
           from nodes`,
        [job.id],
      );
      const keys = rows.map((r) => r.key).filter((k): k is string => k !== null);
      expect(keys.length).toBeGreaterThan(20);
      expect(keys.filter((k) => /cost|yield|cult|commons|rate/i.test(k))).toEqual([]);

      const scalars = rows.map((r) => r.scalar).filter((s): s is string => s !== null);
      const isCost = (s: string) =>
        s === "62" || s === "62.00" || (/^-?\d+(\.\d+)?$/.test(s) && Number(s) === 62);
      expect(scalars.filter(isCost)).toEqual([]);
      // The sale side is fine to show, and free text is not checked against
      // the key pattern ("separate", "accurate").
      expect(scalars.some((s) => Number(s) === 95)).toBe(true);
      expect(scalars.some((s) => /separate/.test(s))).toBe(true);
      expect(new Set(await eventTypes(tx, job.id))).toEqual(
        new Set([
          "checked_in",
          "assignment_changed",
          "line_added",
          "line_voided",
          "approval_flagged",
          "diagnosis_added",
          "status_changed",
          "completed",
          "reopened",
          "collected",
        ]),
      );
    });
  });

  it("work_order_events is append-only for every writer, the owner included", async () => {
    await scenario(ADMIN, async (tx, ids) => {
      const job = await createWorkOrder(tx, ids);
      for (const sql of [
        "update public.work_order_events set payload = '{}' where work_order_id = $1",
        "delete from public.work_order_events where work_order_id = $1",
        "insert into public.work_order_events (work_order_id, event_type) values ($1, 'note_added')",
      ]) {
        await failsWith(tx, () => tx.query(sql, [job.id]), { code: "42501" });
      }
      await ownerMode(tx);
      for (const sql of [
        "update public.work_order_events set payload = '{}' where work_order_id = $1",
        "delete from public.work_order_events where work_order_id = $1",
      ]) {
        await failsWith(tx, () => tx.query(sql, [job.id]), {
          code: "P0001",
          message: "work_order_history_append_only",
        });
      }
    });
  });

  it("work_order_timeline lists newest first with actor and assignment-subject names", async () => {
    await scenario(MECHANIC2, async (tx, ids) => {
      const job = await createWorkOrder(tx, { ...ids, leadId: STAFF.mechanic1 });
      await setStatus(tx, job.id, "diagnosing");
      const { rows } = await tx.query(
        "select event_type::text, actor_display_name, subject_staff_id, subject_display_name from public.work_order_timeline($1)",
        [job.id],
      );
      expect(rows).toEqual([
        {
          event_type: "status_changed",
          actor_display_name: expect.any(String),
          subject_staff_id: null,
          subject_display_name: null,
        },
        {
          event_type: "assignment_changed",
          actor_display_name: expect.any(String),
          subject_staff_id: STAFF.mechanic1,
          subject_display_name: expect.any(String),
        },
        {
          event_type: "checked_in",
          actor_display_name: expect.any(String),
          subject_staff_id: null,
          subject_display_name: null,
        },
      ]);
      expect(rows[1].subject_display_name).not.toBe(rows[1].actor_display_name);
      expect(await count(tx, "select * from public.work_order_timeline($1, 1)", [job.id])).toBe(1);
      expect(await count(tx, "select * from public.work_order_timeline($1, -5)", [job.id])).toBe(1);
      // At most 2000 rows, whatever is asked (the page asks one more than it shows).
      await ownerMode(tx);
      await tx.query(
        `insert into public.work_order_events (work_order_id, event_type, payload)
         select $1, 'note_added', jsonb_build_object('body', 'n' || g) from generate_series(1, 2001) g`,
        [job.id],
      );
      await actAs(tx, ADMIN);
      expect(await count(tx, "select * from public.work_order_timeline($1, 5000)", [job.id])).toBe(
        2000,
      );
      expect(await count(tx, "select * from public.work_order_timeline($1, 201)", [job.id])).toBe(
        201,
      );
    });
  });
});

/** lead_mechanic_id equals the active lead assignment (or null). */
async function expectLeadInSync(tx: pg.Client, workOrderId: string) {
  const { rows } = await tx.query(
    `select w.lead_mechanic_id,
            (select a.staff_id from public.work_order_assignments a
              where a.work_order_id = w.id and a.role = 'lead' and a.unassigned_at is null) as active_lead
       from public.work_orders w where w.id = $1`,
    [workOrderId],
  );
  expect(rows[0].lead_mechanic_id).toBe(rows[0].active_lead);
  return rows[0].lead_mechanic_id as string | null;
}

const assign = (tx: pg.Client, workOrderId: string, staffId: string, role = "additional") =>
  tx
    .query("select (a).* from (select public.assign_staff($1, $2, $3) a) s", [
      workOrderId,
      staffId,
      role,
    ])
    .then((r) => r.rows[0]);

const unassign = (tx: pg.Client, workOrderId: string, staffId: string) =>
  tx
    .query("select (a).* from (select public.unassign_staff($1, $2) a) s", [workOrderId, staffId])
    .then((r) => r.rows[0]);

const activeAssignments = (tx: pg.Client, workOrderId: string) =>
  tx
    .query(
      `select staff_id, role::text from public.work_order_assignments
        where work_order_id = $1 and unassigned_at is null order by role, staff_id`,
      [workOrderId],
    )
    .then((r) => r.rows);

describe.skipIf(!isolatedDatabase())("assignments (D22)", () => {
  it("one lead per job: a new lead takes over and the previous lead leaves the job", async () => {
    await scenario(MECHANIC2, async (tx, ids) => {
      const job = await createWorkOrder(tx, ids);
      expect(await expectLeadInSync(tx, job.id)).toBeNull();
      await assign(tx, job.id, STAFF.mechanic1, "lead");
      expect(await expectLeadInSync(tx, job.id)).toBe(STAFF.mechanic1);
      await assign(tx, job.id, STAFF.admin, "lead");
      expect(await expectLeadInSync(tx, job.id)).toBe(STAFF.admin);
      expect(await activeAssignments(tx, job.id)).toEqual([
        { staff_id: STAFF.admin, role: "lead" },
      ]);
      const closed = await tx.query(
        "select unassigned_at is not null as closed, unassigned_by from public.work_order_assignments where work_order_id = $1 and staff_id = $2",
        [job.id, STAFF.mechanic1],
      );
      expect(closed.rows).toEqual([{ closed: true, unassigned_by: STAFF.mechanic2 }]);
      expect(
        (await events(tx, job.id))
          .filter((e) => e.event_type === "assignment_changed")
          .map((e) => e.payload),
      ).toEqual([
        { action: "assigned", staff_id: STAFF.mechanic1, role: "lead" },
        { action: "unassigned", staff_id: STAFF.mechanic1, role: "lead" },
        { action: "assigned", staff_id: STAFF.admin, role: "lead" },
      ]);
    });
  });

  it("switches additional to lead, replays as a no-op and unassigns replay-safely", async () => {
    await scenario(MECHANIC2, async (tx, ids) => {
      const job = await createWorkOrder(tx, ids);
      const additional = await assign(tx, job.id, STAFF.mechanic1);
      const before = (await events(tx, job.id)).length;
      expect((await assign(tx, job.id, STAFF.mechanic1)).id).toBe(additional.id);
      expect((await events(tx, job.id)).length).toBe(before);

      const lead = await assign(tx, job.id, STAFF.mechanic1, "lead");
      expect(lead.id).not.toBe(additional.id);
      expect(await activeAssignments(tx, job.id)).toEqual([
        { staff_id: STAFF.mechanic1, role: "lead" },
      ]);
      expect(await expectLeadInSync(tx, job.id)).toBe(STAFF.mechanic1);

      const removed = await unassign(tx, job.id, STAFF.mechanic1);
      expect(removed).toMatchObject({ id: lead.id, unassigned_by: STAFF.mechanic2 });
      expect(await expectLeadInSync(tx, job.id)).toBeNull();
      const after = (await events(tx, job.id)).length;
      expect((await unassign(tx, job.id, STAFF.mechanic1)).id).toBeNull();
      expect((await events(tx, job.id)).length).toBe(after);
    });
  });

  it("assigns active staff only, and not on a collected or cancelled job", async () => {
    await scenario(ADMIN, async (tx, ids) => {
      const job = await createWorkOrder(tx, ids);
      await failsWith(tx, () => assign(tx, job.id, randomUUID()), { code: "P0002" });
      await failsWith(tx, () => assign(tx, randomUUID(), STAFF.mechanic1), { code: "P0002" });
      await ownerMode(tx);
      await tx.query("update public.staff set active = false where id = $1", [STAFF.mechanic2]);
      await actAs(tx, ADMIN);
      await failsWith(tx, () => assign(tx, job.id, STAFF.mechanic2), {
        code: "P0001",
        message: "staff_inactive",
      });
      await assign(tx, job.id, STAFF.mechanic1, "lead");
      for (const closed of ["collected", "cancelled"] as const) {
        const other = await createWorkOrder(tx, { ...ids, leadId: STAFF.mechanic1 });
        await walkTo(tx, other.id, closed);
        await failsWith(tx, () => assign(tx, other.id, STAFF.admin), {
          code: "P0001",
          message: "work_order_closed",
        });
        await failsWith(tx, () => unassign(tx, other.id, STAFF.mechanic1), {
          code: "P0001",
          message: "work_order_closed",
        });
        expect(await expectLeadInSync(tx, other.id)).toBe(STAFF.mechanic1);
      }
    });
  });

  it("assignment rows are immutable except closing them once", async () => {
    await scenario(ADMIN, async (tx, ids) => {
      const job = await createWorkOrder(tx, { ...ids, leadId: STAFF.mechanic1 });
      const removed = await unassign(tx, job.id, STAFF.mechanic1);
      await assign(tx, job.id, STAFF.mechanic2, "lead");
      await ownerMode(tx);
      for (const [sql, id] of [
        [
          "update public.work_order_assignments set role = 'additional' where work_order_id = $1 and unassigned_at is null",
          job.id,
        ],
        ["update public.work_order_assignments set unassigned_at = null where id = $1", removed.id],
        [
          "update public.work_order_assignments set unassigned_at = now() + interval '1 day' where id = $1",
          removed.id,
        ],
        ["delete from public.work_order_assignments where work_order_id = $1", job.id],
      ] as const) {
        await failsWith(tx, () => tx.query(sql, [id]), {
          code: "P0001",
          message: "assignment_immutable",
        });
      }
      await failsWith(
        tx,
        () =>
          tx.query(
            "insert into public.work_order_assignments (work_order_id, staff_id, role) values ($1, $2, 'lead')",
            [job.id, STAFF.admin],
          ),
        { code: "23505", constraint: "work_order_assignments_one_lead_key" },
      );
      expect(await expectLeadInSync(tx, job.id)).toBe(STAFF.mechanic2);
    });
  });
});

describe.skipIf(!isolatedDatabase())("photos on a job (D19)", () => {
  const record = (
    tx: pg.Client,
    a: { id: string; entityType?: string; entityId: string; visibility?: string },
  ) => {
    const entityType = a.entityType ?? "work_order";
    const visibility = a.visibility ?? "internal";
    return tx
      .query(
        `select (r).* from (
           select public.record_attachment($1, $2::public.attachment_entity, $3, $4, $5, 'image/jpeg',
                                           null, 1600, 1200, null, $6::public.attachment_visibility) r
         ) s`,
        [
          a.id,
          entityType,
          a.entityId,
          visibility === "public" ? "media-public" : "media-internal",
          attachmentPath(entityType, a.entityId, a.id),
          visibility,
        ],
      )
      .then((r) => r.rows[0]);
  };

  it("records internal and customer photos of a job, each on its timeline", async () => {
    await scenario(MECHANIC2, async (tx, ids) => {
      const job = await createWorkOrder(tx, ids);
      const internal = randomUUID();
      const shared = randomUUID();
      await ownerMode(tx);
      await putStorageObject(tx, "media-internal", attachmentPath("work_order", job.id, internal));
      await putStorageObject(tx, "media-internal", attachmentPath("work_order", job.id, shared));
      await actAs(tx, MECHANIC2);
      await record(tx, { id: internal, entityId: job.id });
      await record(tx, { id: shared, entityId: job.id, visibility: "customer" });
      const added = (await events(tx, job.id)).filter((e) => e.event_type === "photo_added");
      expect(added.map((e) => e.payload)).toEqual([
        { attachment_id: internal, visibility: "internal" },
        { attachment_id: shared, visibility: "customer" },
      ]);

      await tx.query("select * from public.delete_attachment($1, 'Blurry')", [internal]);
      expect((await events(tx, job.id)).at(-1)).toMatchObject({
        event_type: "photo_removed",
        actor_staff_id: STAFF.mechanic2,
        payload: { attachment_id: internal, reason: "Blurry" },
      });
    });
  });

  it("refuses unknown jobs, products and consignment items (P0002; consignment items arrive in Phase 6)", async () => {
    await scenario(MECHANIC2, async (tx) => {
      const id = randomUUID();
      const nowhere = randomUUID();
      await ownerMode(tx);
      await putStorageObject(tx, "media-internal", attachmentPath("work_order", nowhere, id));
      await putStorageObject(tx, "media-internal", attachmentPath("product", nowhere, id));
      await putStorageObject(tx, "media-internal", attachmentPath("consignment_item", nowhere, id));
      await actAs(tx, MECHANIC2);
      await failsWith(tx, () => record(tx, { id, entityId: nowhere }), { code: "P0002" });
      await failsWith(tx, () => record(tx, { id, entityType: "product", entityId: nowhere }), {
        code: "P0002",
      });
      await failsWith(
        tx,
        () => record(tx, { id, entityType: "consignment_item", entityId: nowhere }),
        { code: "P0002" },
      );
    });
  });

  it("never makes a job photo public: record_attachment, set_attachment_visibility, CHECK", async () => {
    await scenario(MECHANIC2, async (tx, ids) => {
      const job = await createWorkOrder(tx, ids);
      const direct = randomUUID();
      const moved = randomUUID();
      await ownerMode(tx);
      await putStorageObject(tx, "media-public", attachmentPath("work_order", job.id, direct));
      await putStorageObject(tx, "media-internal", attachmentPath("work_order", job.id, moved));
      await putStorageObject(tx, "media-public", attachmentPath("work_order", job.id, moved));
      await actAs(tx, MECHANIC2);
      await failsWith(
        tx,
        () => record(tx, { id: direct, entityId: job.id, visibility: "public" }),
        {
          code: "P0001",
          message: "attachment_work_order_never_public",
        },
      );
      await record(tx, { id: moved, entityId: job.id });
      await failsWith(
        tx,
        () =>
          tx.query("select public.set_attachment_visibility($1, 'public', 'media-public', $2)", [
            moved,
            attachmentPath("work_order", job.id, moved),
          ]),
        { code: "P0001", message: "attachment_work_order_never_public" },
      );
      await tx.query("select public.set_attachment_visibility($1, 'customer')", [moved]);
    });
    const { rows } = await conn.query(
      `select pg_get_constraintdef(oid) as def from pg_constraint
        where conrelid = 'public.attachments'::regclass and conname = 'attachments_work_order_never_public'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].def).toMatch(/work_order/);
  });
});
