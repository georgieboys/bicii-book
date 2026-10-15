/**
 * Indent parts and quotes fixtures (Phase 13; D140-D147), extracted
 * unchanged from indent-parts.test.ts so the Phase 14 deposit tests
 * (indent-deposits.test.ts) build the same jobs, quotes and orders.
 * Every helper acts as whoever `tx` currently is, except setup() and
 * quoted(), which leave `tx` acting as ADMIN.
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";

import { actAs, scalar } from "./harness";
import { ADMIN, makeProduct, newJob } from "./inventory-fixtures";
import { makeSupplier } from "./purchasing-fixtures";
import { makeService, ownerMode } from "./workshop-fixtures";

export type Quote = {
  status: string;
  job_number: string;
  bike?: string;
  first_name?: string | null;
  currency?: string;
  total?: string;
  items?: {
    id: string;
    kind: string;
    description: string;
    quantity: string;
    unit_sale_price: string;
    line_total: string;
    decision: string | null;
  }[];
  answered_name?: string | null;
  // Phase 14 step 2 (D151, D158): null, or the deposit the page may show.
  deposit?: { percent: number; amount: string | null; status: string } | null;
};

export async function proposePart(
  tx: pg.Client,
  a: {
    id?: string;
    workOrderId: string;
    productId: string;
    quantity?: number;
    price?: string | null;
    cost?: string | null;
    supplierId?: string | null;
  },
): Promise<string> {
  return scalar<string>(tx, "select public.propose_part($1, $2, $3, $4, $5, $6, $7)", [
    a.id ?? randomUUID(),
    a.workOrderId,
    a.productId,
    a.quantity ?? 1,
    a.price ?? null,
    a.cost ?? null,
    a.supplierId ?? null,
  ]);
}

export async function proposeService(
  tx: pg.Client,
  a: { id?: string; workOrderId: string; serviceId: string; quantity?: string; price?: string },
): Promise<string> {
  return scalar<string>(tx, "select public.propose_service($1, $2, $3, $4, $5)", [
    a.id ?? randomUUID(),
    a.workOrderId,
    a.serviceId,
    a.quantity ?? "1",
    a.price ?? null,
  ]);
}

export async function sendQuote(
  tx: pg.Client,
  a: { id?: string; workOrderId: string; requestIds: string[]; days?: number },
): Promise<string> {
  return scalar<string>(tx, "select public.send_quote($1, $2, $3, 'whatsapp', $4)", [
    a.id ?? randomUUID(),
    a.workOrderId,
    a.requestIds,
    a.days ?? 7,
  ]);
}

export const quoteByToken = (tx: pg.Client, token: string) =>
  scalar<Quote | null>(tx, "select public.quote_by_token($1)", [token]);

export async function answer(
  tx: pg.Client,
  token: string,
  decisions: { item_id: string; approve: unknown }[] | unknown,
  name: string | null = "Tan Ah Kow",
): Promise<Quote> {
  return scalar<Quote>(tx, "select public.answer_quote($1, $2::jsonb, $3)", [
    token,
    JSON.stringify(decisions),
    name,
  ]);
}

/** Every item of the quote behind `token`, approved or not by `approve(description)`. */
export async function answerAll(
  tx: pg.Client,
  token: string,
  approve: (description: string) => boolean = () => true,
): Promise<Quote> {
  const quote = await quoteByToken(tx, token);
  return answer(
    tx,
    token,
    quote!.items!.map((i) => ({ item_id: i.id, approve: approve(i.description) })),
  );
}

export async function orderParts(
  tx: pg.Client,
  requestIds: string[],
  supplierId: string,
  poId: string = randomUUID(),
  moveToWaiting = true,
): Promise<string> {
  return scalar<string>(tx, "select public.order_part_requests($1, $2, $3, $4)", [
    requestIds,
    supplierId,
    poId,
    moveToWaiting,
  ]);
}

export const fit = (
  tx: pg.Client,
  requestId: string,
  lineId = randomUUID(),
  locationId: string | null = null,
) =>
  scalar<string>(tx, "select public.fit_part_request($1, $2, $3)", [requestId, lineId, locationId]);

/**
 * Runs `fn` as whoever `tx` is, with the two D149b/c work_orders triggers
 * of 20261014000900 switched off for the transaction, to build the state of
 * a job that changed status before them (production's J-000002): completed
 * or collected with approved or ordered items, and an open quote left on
 * it. The triggers are switched back on before it returns. Owner-only
 * (ALTER TABLE); never in a transaction that commits while they are off.
 */
export async function beforeTheGuard<T>(tx: pg.Client, fn: () => Promise<T>): Promise<T> {
  const toggle = async (on: boolean) => {
    const role = await scalar<string>(tx, "select current_user::text");
    await tx.query("reset role");
    const owner = await scalar<string>(tx, "select current_user::text");
    const verb = on ? "enable" : "disable";
    await tx.query(
      `alter table public.work_orders
         ${verb} trigger work_orders_require_settled_requests,
         ${verb} trigger work_orders_withdraw_open_quote`,
    );
    if (role !== owner) await tx.query(`set local role ${role}`);
  };
  await toggle(false);
  // On a failure the test's transaction is rolled back, which undoes the
  // ALTER too (and an aborted transaction could not run another one).
  const result = await fn();
  await toggle(true);
  return result;
}

/**
 * A fresh job (as ADMIN), an indent product (no stock), a supplier and a
 * fitting service, created as the owner; leaves `tx` acting as ADMIN.
 */
export async function setup(tx: pg.Client) {
  const job = await newJob(tx);
  await ownerMode(tx);
  const productId = await makeProduct(tx, { price: "120.00", cost: "70.00" });
  const supplierId = await makeSupplier(tx);
  const serviceId = await makeService(tx, {
    name: `Fit ${randomUUID().slice(0, 6)}`,
    price: "25.00",
  });
  await actAs(tx, ADMIN);
  return { job, productId, supplierId, serviceId };
}

/** setup() plus a part and a fitting service proposed and quoted; acting as ADMIN. */
export async function quoted(tx: pg.Client) {
  const s = await setup(tx);
  const partId = await proposePart(tx, {
    workOrderId: s.job.id,
    productId: s.productId,
    quantity: 2,
    cost: "70.00",
    supplierId: s.supplierId,
  });
  const serviceRequestId = await proposeService(tx, {
    workOrderId: s.job.id,
    serviceId: s.serviceId,
  });
  const token = await sendQuote(tx, {
    workOrderId: s.job.id,
    requestIds: [partId, serviceRequestId],
  });
  return { ...s, partId, serviceRequestId, token };
}
