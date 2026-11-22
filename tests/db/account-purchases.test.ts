/**
 * Purchases on the site account (PLAN D263): my_purchases() lists the
 * signed-in customer's in-store and online sales; an online order belongs to
 * them through a linked Shopify customer or the email they verified with a
 * sign-in code, which also links the Shopify customer for staff (audited).
 *
 * Tests create products, customers and sales, so the file runs only on a
 * per-file clone, in rolled-back transactions.
 */
import { createHash, randomUUID } from "node:crypto";

import type pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { LOCATION } from "../fixtures/ids";
import { orderPaidPayload, SHOPIFY_TEST_SHOP } from "../fixtures/shopify";
import { recordSale } from "./consignment-fixtures";
import { createAuthUser, customerClaims } from "./customer-fixtures";
import { actAs, connect, inTransaction, isolatedDatabase, scalar } from "./harness";
import { ADMIN, addStock, makeProduct, readAsOwner } from "./inventory-fixtures";
import { SERVICE } from "./payment-fixtures";
import { makeCustomer, ownerMode } from "./workshop-fixtures";

let conn: pg.Client;

beforeAll(async () => {
  conn = await connect();
});

let sequence = 0;
const idBase = 7_700_000_000 + Math.floor(Math.random() * 90_000) * 10_000;
const nextShopifyId = () => idBase + ++sequence;

const inTx = <T>(fn: (tx: pg.Client) => Promise<T>) =>
  inTransaction(conn, async (tx) => {
    await actAs(tx, ADMIN);
    return fn(tx);
  });

/** Fires the deferred triggers now, as a commit would. */
async function flush(tx: pg.Client) {
  await tx.query("set constraints all immediate");
  await tx.query("set constraints all deferred");
}

/** A customer with a login; confirmed unless told otherwise. Returns ids and email. */
async function customerWithLogin(tx: pg.Client, confirmed = true) {
  await ownerMode(tx);
  const customerId = await makeCustomer(tx);
  const email = `buyer-${randomUUID().slice(0, 8)}@example.com`;
  const authUserId = await createAuthUser(tx, email);
  if (confirmed) {
    await tx.query("update auth.users set email_confirmed_at = now() where id = $1", [authUserId]);
  }
  await tx.query("update public.customers set auth_user_id = $1 where id = $2", [
    authUserId,
    customerId,
  ]);
  await flush(tx);
  await actAs(tx, ADMIN);
  return { customerId, authUserId, email };
}

/** A stocked product with a Shopify variant; returns its id and variant number. */
async function onlineProduct(tx: pg.Client) {
  await ownerMode(tx);
  const productId = await makeProduct(tx, { price: "40.00", cost: "15.00" });
  await actAs(tx, ADMIN);
  await addStock(tx, productId, 5, { locationId: LOCATION.shopFloor });
  const variant = nextShopifyId();
  await readAsOwner(tx, () =>
    tx.query(
      "update public.products set shopify_product_id = $2, shopify_variant_id = $3 where id = $1",
      [
        productId,
        `gid://shopify/Product/${nextShopifyId()}`,
        `gid://shopify/ProductVariant/${variant}`,
      ],
    ),
  );
  return { productId, variant };
}

/** Records and processes a paid order as the service role; returns its sale id. */
async function deliverOrder(
  tx: pg.Client,
  variant: number,
  customer: { id: number; email: string | null },
): Promise<string> {
  const orderId = nextShopifyId();
  const payload = orderPaidPayload({
    orderId,
    name: `#P${orderId}`,
    customer,
    lines: [
      {
        lineItemId: nextShopifyId(),
        productId: null,
        variantId: variant,
        title: "Bell",
        variantTitle: null,
        quantity: 1,
        price: "40.00",
      },
    ],
  });
  const raw = JSON.stringify(payload);
  await actAs(tx, SERVICE);
  const recorded = await tx.query<{ event_id: string }>(
    `select event_id from public.record_shopify_webhook('orders/paid', $1, null, $2, '2026-07', null,
          '{}'::jsonb, $3::jsonb, $4, $5, true, null, null)`,
    [
      `purchases-${randomUUID()}`,
      SHOPIFY_TEST_SHOP,
      raw,
      createHash("sha256").update(raw).digest("hex"),
      Buffer.byteLength(raw),
    ],
  );
  const { rows } = await tx.query<{ sale_id: string | null }>(
    "select sale_id from public.process_shopify_order_paid($1)",
    [recorded.rows[0].event_id],
  );
  await flush(tx);
  await actAs(tx, ADMIN);
  if (!rows[0].sale_id) throw new Error("order not recorded");
  return rows[0].sale_id;
}

type Purchase = {
  sale_id: string;
  source: string;
  total: string;
  refunded: string;
  lines: Array<Record<string, unknown>>;
};

async function purchasesOf(tx: pg.Client, authUserId: string): Promise<Purchase[]> {
  await actAs(tx, customerClaims(authUserId));
  const { rows } = await tx.query<Purchase>(
    "select sale_id, source::text, total::text, refunded::text, lines from public.my_purchases()",
  );
  await actAs(tx, ADMIN);
  return rows;
}

const shopifyIdOf = (tx: pg.Client, customerId: string) =>
  readAsOwner(tx, () =>
    scalar<string | null>(tx, "select shopify_customer_id from public.customers where id = $1", [
      customerId,
    ]),
  );

describe.skipIf(!isolatedDatabase())("purchases on the site account (D263)", () => {
  it("an online order placed with the verified email shows, links the Shopify customer, and later orders attach", async () => {
    await inTx(async (tx) => {
      const me = await customerWithLogin(tx);
      const { variant } = await onlineProduct(tx);
      const shopifyCustomer = nextShopifyId();
      const first = await deliverOrder(tx, variant, {
        id: shopifyCustomer,
        email: me.email.toUpperCase(),
      });
      expect(await shopifyIdOf(tx, me.customerId)).toBe(
        `gid://shopify/Customer/${shopifyCustomer}`,
      );
      const audit = await readAsOwner(tx, () =>
        tx.query(
          `select reason, payload ->> 'matched_by' as matched_by from public.integration_audit_events
            where customer_id = $1 and event_type = 'customer_linked'`,
          [me.customerId],
        ),
      );
      expect(audit.rows).toEqual([
        { reason: "Matched by verified email (D263)", matched_by: "verified_email" },
      ]);

      // A later order of the same Shopify customer, under another email,
      // attaches to the customer when it is recorded (D86's link).
      const second = await deliverOrder(tx, variant, {
        id: shopifyCustomer,
        email: "someone-else@example.com",
      });
      const owner = await readAsOwner(tx, () =>
        scalar<string | null>(tx, "select customer_id from public.sales where id = $1", [second]),
      );
      expect(owner).toBe(me.customerId);

      const mine = await purchasesOf(tx, me.authUserId);
      expect(mine.map((p) => p.sale_id).sort()).toEqual([first, second].sort());
      expect(mine[0]).toMatchObject({ source: "online_shopify", total: "40.00", refunded: "0" });
      expect(Object.keys(mine[0].lines[0]).sort()).toEqual([
        "description",
        "quantity",
        "total",
        "unit_price",
      ]);
    });
  });

  it("shows in-store sales, never another customer's order, and no match for an unconfirmed login", async () => {
    await inTx(async (tx) => {
      const me = await customerWithLogin(tx);
      const other = await customerWithLogin(tx);
      const unconfirmed = await customerWithLogin(tx, false);
      const { productId, variant } = await onlineProduct(tx);

      const inStore = await recordSale(tx, {
        lines: [{ product_id: productId, quantity: 1 }],
        customerId: me.customerId,
      });
      await deliverOrder(tx, variant, { id: nextShopifyId(), email: other.email });
      await deliverOrder(tx, variant, { id: nextShopifyId(), email: unconfirmed.email });

      expect((await purchasesOf(tx, me.authUserId)).map((p) => p.sale_id)).toEqual([
        inStore.sale_id,
      ]);
      expect(await purchasesOf(tx, other.authUserId)).toHaveLength(1);
      expect(await purchasesOf(tx, unconfirmed.authUserId)).toEqual([]);
      expect(await shopifyIdOf(tx, unconfirmed.customerId)).toBeNull();
    });
  });

  it("a customer who signs in after ordering is linked from the latest matching order", async () => {
    await inTx(async (tx) => {
      const { variant } = await onlineProduct(tx);
      const email = `later-${randomUUID().slice(0, 8)}@example.com`;
      const shopifyCustomer = nextShopifyId();
      const sale = await deliverOrder(tx, variant, { id: shopifyCustomer, email });

      await ownerMode(tx);
      const customerId = await makeCustomer(tx);
      const authUserId = await createAuthUser(tx, email);
      await tx.query("update auth.users set email_confirmed_at = now() where id = $1", [
        authUserId,
      ]);
      await tx.query("update public.customers set auth_user_id = $1 where id = $2", [
        authUserId,
        customerId,
      ]);
      await flush(tx);
      await actAs(tx, ADMIN);

      expect(await shopifyIdOf(tx, customerId)).toBe(`gid://shopify/Customer/${shopifyCustomer}`);
      expect((await purchasesOf(tx, authUserId)).map((p) => p.sale_id)).toEqual([sale]);
    });
  });

  it("only a signed-in customer may ask", async () => {
    await inTx(async (tx) => {
      await actAs(tx, { role: "anon" });
      await expect(tx.query("select * from public.my_purchases()")).rejects.toMatchObject({
        code: "42501",
      });
    });
  });
});
