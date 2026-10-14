/**
 * Indent parts and customer quotes (Phase 13 step 1; PLAN D140-D147,
 * ADR-024; DATA-MODEL §5, §15, §16):
 *
 *   propose_part / propose_service  an item on an open job with no stock
 *                       movement and no line; totals unchanged (D140).
 *   send_quote          returns a 43-character token once; only its
 *                       SHA-256 is stored; one open quote per job (D141).
 *   quote_by_token, answer_quote    anyone holding the link sees the
 *                       quote (never costs or contact details) and answers
 *                       every item once while it is open (D142, D143).
 *   order_part_requests manage_purchasing puts approved parts on the
 *                       supplier's draft purchase order (D145).
 *   part_request_arrivals, indent_reservations, fit_part_request
 *                       receipts cover requests first requested first;
 *                       fitting adds one ordinary line (D146).
 *
 * Template: purchasing.test.ts (rolled-back transactions, owner inserts,
 * actAs for identity). The race commits, so it runs only on this file's
 * clone.
 */
import { createHash, randomUUID } from "node:crypto";

import type pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { LOCATION, STAFF } from "../fixtures/ids";
import {
  actAs,
  connect,
  inTransaction,
  isolatedDatabase,
  openConnections,
  scalar,
} from "./harness";
import {
  ADMIN,
  MANAGER,
  MECHANIC1,
  MECHANIC2,
  completeJob,
  makeProduct,
  newJob,
  onHand,
} from "./inventory-fixtures";
import {
  answer,
  answerAll,
  fit,
  orderParts,
  proposePart,
  proposeService,
  quoteByToken,
  quoted,
  sendQuote,
  setup,
} from "./indent-fixtures";
import { grantPurchasing, receive } from "./purchasing-fixtures";
import { eventTypes, failsWith, ownerMode } from "./workshop-fixtures";

let conn: pg.Client;

beforeAll(async () => {
  conn = await connect();
});

const p0001 = (message: string) => ({ code: "P0001", message });
const denied = { code: "42501" };
const ANON = { role: "anon" } as const;

const requestStatus = (tx: pg.Client, id: string) =>
  scalar<string>(tx, "select status::text from public.job_part_requests where id = $1", [id]);

const lineCount = (tx: pg.Client, workOrderId: string) =>
  scalar<number>(
    tx,
    "select count(*)::int from public.work_order_line_items where work_order_id = $1 and voided_at is null",
    [workOrderId],
  );

describe("propose_part and propose_service (D140)", () => {
  it("adds a request with no stock movement and no line, at the product's price; replay-safe", async () => {
    await inTransaction(conn, async (tx) => {
      const s = await setup(tx);
      const before = await lineCount(tx, s.job.id);
      const id = randomUUID();
      expect(
        await proposePart(tx, { id, workOrderId: s.job.id, productId: s.productId, quantity: 2 }),
      ).toBe(id);
      expect(
        await proposePart(tx, { id, workOrderId: s.job.id, productId: s.productId, quantity: 2 }),
      ).toBe(id);
      const { rows } = await tx.query(
        "select kind::text, status::text, quantity::text, unit_sale_price::text, line_total::text from public.job_part_requests where id = $1",
        [id],
      );
      expect(rows[0]).toEqual({
        kind: "part",
        status: "proposed",
        quantity: "2.00",
        unit_sale_price: "120.00",
        line_total: "240.00",
      });
      expect(await lineCount(tx, s.job.id)).toBe(before);
      await ownerMode(tx);
      expect(
        await scalar<number>(
          tx,
          "select count(*)::int from public.inventory_movements where product_id = $1",
          [s.productId],
        ),
      ).toBe(0);
      expect(await eventTypes(tx, s.job.id)).toContain("part_requested");
    });
  });

  it("refuses products a purchase order cannot order, missing prices, closed jobs and conflicting replays", async () => {
    await inTransaction(conn, async (tx) => {
      const s = await setup(tx);
      await ownerMode(tx);
      const unique = await makeProduct(tx, { tracking: "unique" });
      const inactive = await makeProduct(tx, { active: false });
      const unpriced = await makeProduct(tx, { price: null });
      await actAs(tx, ADMIN);
      for (const productId of [unique]) {
        await failsWith(
          tx,
          () => proposePart(tx, { workOrderId: s.job.id, productId }),
          p0001("indent_product_invalid"),
        );
      }
      await failsWith(
        tx,
        () => proposePart(tx, { workOrderId: s.job.id, productId: inactive }),
        p0001("product_inactive"),
      );
      await failsWith(
        tx,
        () => proposePart(tx, { workOrderId: s.job.id, productId: unpriced }),
        p0001("part_price_missing"),
      );
      await failsWith(
        tx,
        () => proposePart(tx, { workOrderId: s.job.id, productId: s.productId, quantity: 0 }),
        p0001("quantity_invalid"),
      );
      const id = await proposePart(tx, { workOrderId: s.job.id, productId: s.productId });
      await failsWith(
        tx,
        () => proposePart(tx, { id, workOrderId: s.job.id, productId: unpriced }),
        p0001("part_request_conflict"),
      );
      await completeJob(tx, s.job.id);
      await failsWith(
        tx,
        () => proposePart(tx, { workOrderId: s.job.id, productId: s.productId }),
        p0001("work_order_locked"),
      );
    });
  });

  it("lets any staff member propose, but only purchase-cost holders set a cost or supplier (D147)", async () => {
    await inTransaction(conn, async (tx) => {
      const s = await setup(tx);
      await actAs(tx, MECHANIC2);
      await proposePart(tx, { workOrderId: s.job.id, productId: s.productId });
      await failsWith(
        tx,
        () => proposePart(tx, { workOrderId: s.job.id, productId: s.productId, cost: "10.00" }),
        denied,
      );
      await failsWith(
        tx,
        () =>
          proposePart(tx, {
            workOrderId: s.job.id,
            productId: s.productId,
            supplierId: s.supplierId,
          }),
        denied,
      );
      await actAs(tx, MECHANIC1); // view_costs
      await proposePart(tx, {
        workOrderId: s.job.id,
        productId: s.productId,
        cost: "10.00",
        supplierId: s.supplierId,
      });
      await proposeService(tx, { workOrderId: s.job.id, serviceId: s.serviceId, quantity: "1.5" });
    });
  });
});

describe("access (D147)", () => {
  it("staff read requests and quotes, never the cost, supplier or token hash directly; the staff view gates them", async () => {
    await inTransaction(conn, async (tx) => {
      const q = await quoted(tx);
      await actAs(tx, MECHANIC2);
      expect(
        await scalar<number>(
          tx,
          "select count(*)::int from public.job_part_requests where work_order_id = $1",
          [q.job.id],
        ),
      ).toBe(2);
      await failsWith(
        tx,
        () => tx.query("select expected_unit_cost from public.job_part_requests"),
        denied,
      );
      await failsWith(
        tx,
        () => tx.query("select supplier_id from public.job_part_requests"),
        denied,
      );
      await failsWith(tx, () => tx.query("select token_hash from public.quotes"), denied);
      expect(
        await scalar<number>(
          tx,
          "select count(*)::int from public.job_part_requests_staff where id = $1",
          [q.partId],
        ),
      ).toBe(0);
      await failsWith(
        tx,
        () => tx.query("select public.propose_part($1, $2, $3)", [randomUUID(), q.job.id, null]),
        {
          code: "22004",
        },
      );
      await actAs(tx, MECHANIC1);
      const { rows } = await tx.query(
        "select expected_unit_cost::text, supplier_id from public.job_part_requests_staff where id = $1",
        [q.partId],
      );
      expect(rows).toEqual([{ expected_unit_cost: "70.00", supplier_id: q.supplierId }]);
    });
  });

  it("anon and customers read no table; anon reaches only the two token functions", async () => {
    await inTransaction(conn, async (tx) => {
      await quoted(tx);
      await actAs(tx, ANON);
      for (const table of [
        "job_part_requests",
        "quotes",
        "quote_items",
        "job_part_requests_staff",
      ]) {
        await failsWith(tx, () => tx.query(`select count(*) from public.${table}`), denied);
      }
      await failsWith(
        tx,
        () => tx.query("select public.part_request_arrivals($1)", [randomUUID()]),
        denied,
      );
      await failsWith(
        tx,
        () => tx.query("select public.withdraw_quote($1)", [randomUUID()]),
        denied,
      );
      expect(await quoteByToken(tx, "x".repeat(43))).toBeNull();
      expect(await quoteByToken(tx, "not a token")).toBeNull();
    });
  });
});

describe("send_quote and quote_by_token (D141, D143)", () => {
  it("returns a 43-character token once and stores only its SHA-256", async () => {
    await inTransaction(conn, async (tx) => {
      const quoteId = randomUUID();
      const s = await setup(tx);
      const partId = await proposePart(tx, {
        workOrderId: s.job.id,
        productId: s.productId,
        quantity: 2,
      });
      const token = await sendQuote(tx, {
        id: quoteId,
        workOrderId: s.job.id,
        requestIds: [partId],
      });
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      await ownerMode(tx);
      const hash = await scalar<Buffer>(tx, "select token_hash from public.quotes where id = $1", [
        quoteId,
      ]);
      expect(hash.equals(createHash("sha256").update(token).digest())).toBe(true);
      const row = await scalar<Record<string, unknown>>(
        tx,
        "select to_jsonb(q) - 'token_hash' from public.quotes q where id = $1",
        [quoteId],
      );
      expect(JSON.stringify(row)).not.toContain(token);
      expect(await requestStatus(tx, partId)).toBe("quoted");
      await actAs(tx, ADMIN);
      await failsWith(
        tx,
        () => sendQuote(tx, { id: quoteId, workOrderId: s.job.id, requestIds: [partId] }),
        p0001("quote_already_sent"),
      );
    });
  });

  it("shows the job, bike, first name, items and total, and nothing else", async () => {
    await inTransaction(conn, async (tx) => {
      const q = await quoted(tx);
      await actAs(tx, ANON);
      const quote = await quoteByToken(tx, q.token);
      expect(Object.keys(quote!).sort()).toEqual([
        "answered_at",
        "answered_name",
        "bike",
        "currency",
        "deposit",
        "expires_at",
        "first_name",
        "items",
        "job_number",
        "sent_at",
        "status",
        "total",
      ]);
      expect(quote).toMatchObject({
        status: "open",
        job_number: q.job.job_number,
        currency: "SGD",
      });
      expect(Number(quote!.total)).toBe(265);
      expect(quote!.items!.map((i) => [i.kind, Number(i.quantity), Number(i.line_total)])).toEqual([
        ["part", 2, 240],
        ["service", 1, 25],
      ]);
      expect(JSON.stringify(quote)).not.toMatch(/70\.00|cost|supplier|email|phone|note/i);
      // Phase 14 step 2: no Stripe id or URL; the shipped percent is 0, so
      // no deposit is asked.
      expect(JSON.stringify(quote)).not.toMatch(/cs_|pi_|re_|evt_|https?:/i);
      expect(quote!.deposit).toBeNull();
    });
  });

  it("keeps one open quote per job: sending again withdraws the previous one and its link", async () => {
    await inTransaction(conn, async (tx) => {
      const q = await quoted(tx);
      const second = await sendQuote(tx, { workOrderId: q.job.id, requestIds: [q.partId] });
      await actAs(tx, ANON);
      expect(await quoteByToken(tx, q.token)).toEqual({
        status: "withdrawn",
        job_number: q.job.job_number,
      });
      expect((await quoteByToken(tx, second))!.items).toHaveLength(1);
      // A withdrawn quote shows no items; any answer is refused before they are read.
      await failsWith(tx, () => answer(tx, q.token, []), p0001("quote_not_open"));
      await ownerMode(tx);
      expect(await requestStatus(tx, q.serviceRequestId)).toBe("proposed");
      expect(
        await scalar<number>(
          tx,
          "select count(*)::int from public.quotes where work_order_id = $1 and status = 'open'",
          [q.job.id],
        ),
      ).toBe(1);
    });
  });

  it("refuses items that are not proposed on this job, and bad validity", async () => {
    await inTransaction(conn, async (tx) => {
      const q = await quoted(tx);
      const other = await setup(tx);
      const foreign = await proposePart(tx, {
        workOrderId: other.job.id,
        productId: other.productId,
      });
      await failsWith(
        tx,
        () => sendQuote(tx, { workOrderId: q.job.id, requestIds: [foreign] }),
        p0001("part_request_not_proposed"),
      );
      await failsWith(
        tx,
        () => sendQuote(tx, { workOrderId: other.job.id, requestIds: [foreign], days: 31 }),
        p0001("quote_validity_invalid"),
      );
      await failsWith(
        tx,
        () => sendQuote(tx, { workOrderId: other.job.id, requestIds: [foreign, foreign] }),
        p0001("quote_items_invalid"),
      );
    });
  });

  it("shows an expired quote as expired and refuses to answer it", async () => {
    await inTransaction(conn, async (tx) => {
      const q = await quoted(tx);
      await ownerMode(tx);
      await tx.query(
        "update public.quotes set expires_at = now() - interval '1 minute' where work_order_id = $1",
        [q.job.id],
      );
      await actAs(tx, ANON);
      expect(await quoteByToken(tx, q.token)).toEqual({
        status: "expired",
        job_number: q.job.job_number,
      });
      await failsWith(tx, () => answer(tx, q.token, []), p0001("quote_expired"));
    });
  });
});

describe("answer_quote (D142)", () => {
  it("records every item's answer once, sets the job's approval and its note", async () => {
    await inTransaction(conn, async (tx) => {
      const q = await quoted(tx);
      await actAs(tx, ANON);
      const result = await answerAll(tx, q.token, (d) => !d.startsWith("Fit"));
      expect(result.status).toBe("answered");
      expect(result.answered_name).toBe("Tan Ah Kow");
      expect(result.items!.map((i) => i.decision)).toEqual(["approved", "declined"]);
      await failsWith(tx, () => answerAll(tx, q.token), p0001("quote_not_open"));
      await ownerMode(tx);
      expect(await requestStatus(tx, q.partId)).toBe("approved");
      expect(await requestStatus(tx, q.serviceRequestId)).toBe("declined");
      const { rows } = await tx.query(
        "select approval_flag, approval_note from public.work_orders where id = $1",
        [q.job.id],
      );
      expect(rows[0].approval_flag).toBe(true);
      expect(rows[0].approval_note).toMatch(
        /^Quote answered online by Tan Ah Kow on .+: 1 of 2 items approved\.$/,
      );
      const events = await eventTypes(tx, q.job.id);
      expect(events).toEqual(
        expect.arrayContaining(["quote_sent", "quote_answered", "approval_flagged"]),
      );
      expect(await lineCount(tx, q.job.id)).toBe(0);
    });
  });

  it("leaves the approval flag off when everything is declined", async () => {
    await inTransaction(conn, async (tx) => {
      const q = await quoted(tx);
      await actAs(tx, ANON);
      await answerAll(tx, q.token, () => false);
      await ownerMode(tx);
      expect(
        await scalar<boolean>(tx, "select approval_flag from public.work_orders where id = $1", [
          q.job.id,
        ]),
      ).toBe(false);
    });
  });

  it("refuses incomplete, duplicated, foreign and malformed answers, and a missing name", async () => {
    await inTransaction(conn, async (tx) => {
      const q = await quoted(tx);
      await actAs(tx, ANON);
      const items = (await quoteByToken(tx, q.token))!.items!;
      const [a, b] = items.map((i) => i.id);
      const incomplete = p0001("quote_answer_incomplete");
      await failsWith(tx, () => answer(tx, q.token, [{ item_id: a, approve: true }]), incomplete);
      await failsWith(
        tx,
        () =>
          answer(tx, q.token, [
            { item_id: a, approve: true },
            { item_id: a, approve: false },
          ]),
        incomplete,
      );
      await failsWith(
        tx,
        () =>
          answer(tx, q.token, [
            { item_id: a, approve: true },
            { item_id: randomUUID(), approve: true },
          ]),
        incomplete,
      );
      await failsWith(
        tx,
        () =>
          answer(tx, q.token, [
            { item_id: a, approve: true },
            { item_id: b, approve: "yes" },
          ]),
        incomplete,
      );
      await failsWith(
        tx,
        () =>
          answer(tx, q.token, [
            { item_id: a, approve: true },
            { item_id: "x".repeat(36), approve: true },
          ]),
        incomplete,
      );
      await failsWith(tx, () => answer(tx, q.token, { a: true }), incomplete);
      await failsWith(
        tx,
        () =>
          answer(
            tx,
            q.token,
            [
              { item_id: a, approve: true },
              { item_id: b, approve: true },
            ],
            "  ",
          ),
        p0001("quote_name_required"),
      );
      await failsWith(tx, () => answer(tx, "x".repeat(43), []), {
        code: "P0002",
        message: "quote_not_found",
      });
      await failsWith(tx, () => answer(tx, "short", []), {
        code: "P0002",
        message: "quote_not_found",
      });
      expect((await answerAll(tx, q.token)).status).toBe("answered");
    });
  });

  it("refuses an answer once the job is no longer open", async () => {
    await inTransaction(conn, async (tx) => {
      const q = await quoted(tx);
      await completeJob(tx, q.job.id);
      await actAs(tx, ANON);
      await failsWith(tx, () => answerAll(tx, q.token), p0001("quote_not_open"));
    });
  });

  it.skipIf(!isolatedDatabase())(
    "answers once when two people submit at the same time",
    async () => {
      const setupConn = await connect();
      const q = await inTransaction(setupConn, (tx) => quoted(tx), { commit: true });
      const [c1, c2] = await openConnections(2);
      const run = (c: pg.Client) =>
        inTransaction(
          c,
          async (tx) => {
            await actAs(tx, ANON);
            try {
              await answerAll(tx, q.token);
              await tx.query("select pg_sleep(0.2)");
              return "answered";
            } catch (err) {
              return (err as { message?: string }).message ?? "error";
            }
          },
          { commit: true },
        );
      const results = await Promise.all([run(c1), run(c2)]);
      expect(results.sort()).toEqual(["answered", "quote_not_open"]);
      expect(
        await scalar<number>(
          setupConn,
          "select count(*)::int from public.work_order_events where work_order_id = $1 and event_type = 'quote_answered'",
          [q.job.id],
        ),
      ).toBe(1);
    },
  );
});

describe("order_part_requests (D145)", () => {
  it("needs manage_purchasing and approved parts", async () => {
    await inTransaction(conn, async (tx) => {
      const q = await quoted(tx);
      await actAs(tx, MECHANIC1);
      await failsWith(tx, () => orderParts(tx, [q.partId], q.supplierId), denied);
      await actAs(tx, ADMIN);
      await failsWith(
        tx,
        () => orderParts(tx, [q.partId], q.supplierId),
        p0001("part_request_not_approved"),
      );
      await actAs(tx, ANON);
      await answerAll(tx, q.token);
      await actAs(tx, ADMIN);
      await failsWith(
        tx,
        () => orderParts(tx, [q.serviceRequestId], q.supplierId),
        p0001("part_request_not_approved"),
      );
      await ownerMode(tx);
      await grantPurchasing(tx, STAFF.mechanic2);
      await actAs(tx, MECHANIC2);
      expect(await orderParts(tx, [q.partId], q.supplierId)).toBeTruthy();
    });
  });

  it("puts the parts on the supplier's draft order at the expected cost, links them and moves the job; replay-safe", async () => {
    await inTransaction(conn, async (tx) => {
      const q = await quoted(tx);
      await actAs(tx, ANON);
      await answerAll(tx, q.token);
      await actAs(tx, MANAGER);
      const poId = randomUUID();
      expect(await orderParts(tx, [q.partId], q.supplierId, poId)).toBe(poId);
      expect(await orderParts(tx, [q.partId], q.supplierId, randomUUID())).toBe(poId);
      await ownerMode(tx);
      const { rows } = await tx.query(
        `select o.status::text, o.supplier_id, l.quantity_ordered, l.unit_cost::text, l.notes
           from public.purchase_orders o join public.purchase_order_lines l on l.purchase_order_id = o.id
          where o.id = $1`,
        [poId],
      );
      expect(rows).toEqual([
        {
          status: "draft",
          supplier_id: q.supplierId,
          quantity_ordered: 2,
          unit_cost: "70.00",
          notes: `For ${q.job.job_number}`,
        },
      ]);
      expect(await requestStatus(tx, q.partId)).toBe("ordered");
      expect(
        await scalar<string>(tx, "select status::text from public.work_orders where id = $1", [
          q.job.id,
        ]),
      ).toBe("awaiting_parts");
      expect(await eventTypes(tx, q.job.id)).toContain("part_ordered");
    });
  });

  it("raises the same product's line on the supplier's draft when another job orders it", async () => {
    await inTransaction(conn, async (tx) => {
      const q = await quoted(tx);
      await actAs(tx, ANON);
      await answerAll(tx, q.token);
      await actAs(tx, ADMIN);
      const poId = await orderParts(tx, [q.partId], q.supplierId);
      const other = await newJob(tx);
      const otherPart = await proposePart(tx, {
        workOrderId: other.id,
        productId: q.productId,
        quantity: 1,
      });
      const token = await sendQuote(tx, { workOrderId: other.id, requestIds: [otherPart] });
      await actAs(tx, ANON);
      await answerAll(tx, token);
      await actAs(tx, ADMIN);
      expect(await orderParts(tx, [otherPart], q.supplierId, randomUUID(), false)).toBe(poId);
      await ownerMode(tx);
      expect(
        await scalar<number>(
          tx,
          "select quantity_ordered from public.purchase_order_lines where purchase_order_id = $1",
          [poId],
        ),
      ).toBe(3);
      expect(
        await scalar<string>(tx, "select status::text from public.work_orders where id = $1", [
          other.id,
        ]),
      ).not.toBe("awaiting_parts");
    });
  });
});

describe("arrival and fitting (D146, D140)", () => {
  it("covers requests first requested first, shows arrived parts as reserved, and fits one ordinary line", async () => {
    await inTransaction(conn, async (tx) => {
      const q = await quoted(tx);
      await actAs(tx, ANON);
      await answerAll(tx, q.token);
      await actAs(tx, ADMIN);
      const other = await newJob(tx);
      const later = await proposePart(tx, {
        workOrderId: other.id,
        productId: q.productId,
        quantity: 1,
      });
      const token = await sendQuote(tx, { workOrderId: other.id, requestIds: [later] });
      await actAs(tx, ANON);
      await answerAll(tx, token);
      await actAs(tx, ADMIN);
      const poId = await orderParts(tx, [q.partId], q.supplierId);
      await orderParts(tx, [later], q.supplierId);
      await tx.query("select public.submit_purchase_order($1)", [poId]);
      const lineId = await scalar<string>(
        tx,
        "select id from public.purchase_order_lines where purchase_order_id = $1",
        [poId],
      );

      // Two of three arrive: the first job's two are covered, the later one is not.
      await receive(tx, { poId, lines: [{ lineId, quantity: 2, locationId: LOCATION.shopFloor }] });
      const arrived = async (jobId: string) =>
        (
          await tx.query("select request_id, arrived from public.part_request_arrivals($1)", [
            jobId,
          ])
        ).rows;
      expect(await arrived(q.job.id)).toEqual([{ request_id: q.partId, arrived: true }]);
      expect(await arrived(other.id)).toEqual([{ request_id: later, arrived: false }]);
      expect(
        (
          await tx.query("select job_number, quantity from public.indent_reservations($1)", [
            q.productId,
          ])
        ).rows,
      ).toEqual([{ job_number: q.job.job_number, quantity: 2 }]);

      // Fit: one job_consumption movement of 2 at the quoted price.
      const totalBefore = await scalar<string>(
        tx,
        "select coalesce(sum(sale_total), 0)::text from public.work_order_line_items where work_order_id = $1",
        [q.job.id],
      );
      expect(totalBefore).toBe("0");
      const fitLine = randomUUID();
      expect(await fit(tx, q.partId, fitLine)).toBe(fitLine);
      expect(await fit(tx, q.partId, fitLine)).toBe(fitLine);
      await failsWith(tx, () => fit(tx, q.partId), p0001("part_request_fitted"));
      const { rows } = await tx.query(
        "select line_type::text, quantity::text, unit_sale_price_snapshot::text, sale_total::text from public.work_order_line_items where id = $1",
        [fitLine],
      );
      expect(rows).toEqual([
        {
          line_type: "inventory",
          quantity: "2.00",
          unit_sale_price_snapshot: "120.00",
          sale_total: "240.00",
        },
      ]);
      expect(await onHand(tx, q.productId)).toBe(0);
      await ownerMode(tx);
      expect(
        await scalar<number>(
          tx,
          "select count(*)::int from public.inventory_movements where product_id = $1 and movement_type = 'job_consumption'",
          [q.productId],
        ),
      ).toBe(1);
      expect(await requestStatus(tx, q.partId)).toBe("fitted");
      expect(await eventTypes(tx, q.job.id)).toContain("part_fitted");
      await actAs(tx, ADMIN);
      expect(
        (await tx.query("select * from public.indent_reservations($1)", [q.productId])).rows,
      ).toEqual([]);
    });
  });

  it("fits an approved service as a service line, and refuses proposed or declined items", async () => {
    await inTransaction(conn, async (tx) => {
      const q = await quoted(tx);
      await actAs(tx, ANON);
      await answerAll(tx, q.token);
      await actAs(tx, ADMIN);
      const lineId = await fit(tx, q.serviceRequestId);
      expect(
        await scalar<string>(
          tx,
          "select line_type::text from public.work_order_line_items where id = $1",
          [lineId],
        ),
      ).toBe("service");
      const proposed = await proposePart(tx, { workOrderId: q.job.id, productId: q.productId });
      await failsWith(tx, () => fit(tx, proposed), p0001("part_request_not_approved"));
    });
  });
});

describe("cancel_part_request", () => {
  it("needs a reason, refuses quoted and fitted items, and is replay-safe", async () => {
    await inTransaction(conn, async (tx) => {
      const q = await quoted(tx);
      await failsWith(
        tx,
        () =>
          tx.query("select public.cancel_part_request($1, $2)", [
            q.partId,
            "Customer changed mind",
          ]),
        p0001("part_request_quoted"),
      );
      await actAs(tx, ANON);
      await answerAll(tx, q.token);
      await actAs(tx, MECHANIC2);
      await failsWith(
        tx,
        () => tx.query("select public.cancel_part_request($1, $2)", [q.partId, " "]),
        p0001("reason_required"),
      );
      await tx.query("select public.cancel_part_request($1, $2)", [
        q.partId,
        "Supplier discontinued it",
      ]);
      await tx.query("select public.cancel_part_request($1, $2)", [q.partId, "again"]);
      expect(await requestStatus(tx, q.partId)).toBe("cancelled");
      await actAs(tx, ADMIN);
      await fit(tx, q.serviceRequestId);
      await failsWith(
        tx,
        () => tx.query("select public.cancel_part_request($1, $2)", [q.serviceRequestId, "No"]),
        p0001("part_request_fitted"),
      );
    });
  });
});
