/**
 * Product groups (PLAN D241-D245; DATA-MODEL §6 "Product groups", §13):
 * several products sold as one style. Membership rules, the group the sync
 * worker pushes (product_group_sync_state), recording a group push
 * (record_product_group_push), members sharing the group's Shopify product
 * in record_product_sync_result, and the public view's group columns and
 * variant Buy-online link.
 *
 * Tests create products and groups (the P and G sequences), so the file
 * runs only on a per-file clone, in rolled-back transactions. The enqueue
 * triggers are deferred to commit; `flush` fires them as a commit does.
 */
import { createHash, randomUUID } from "node:crypto";

import type pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { SHOPIFY_SETTINGS } from "../fixtures/ids";
import { actAs, connect, inTransaction, isolatedDatabase, type Claims } from "./harness";
import {
  ADMIN,
  MECHANIC2,
  addPublicPhoto,
  addStock,
  makeProduct,
  publish,
  readAsOwner,
} from "./inventory-fixtures";
import { failsWith, ownerMode } from "./workshop-fixtures";

const SERVICE: Claims = { role: "service_role" };
const STOREFRONT = "https://shop.example.test";

let conn: pg.Client;

beforeAll(async () => {
  conn = await connect();
});

let sequence = 0;
const idBase = 8_700_000_000 + Math.floor(Math.random() * 90_000) * 10_000;
const nextShopifyId = () => idBase + ++sequence;
const gid = (kind: string) => `gid://shopify/${kind}/${nextShopifyId()}`;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const inTx = <T>(fn: (tx: pg.Client) => Promise<T>) =>
  inTransaction(conn, async (tx) => {
    await actAs(tx, ADMIN);
    return fn(tx);
  });

async function flush(tx: pg.Client): Promise<void> {
  await tx.query("set constraints all immediate");
  await tx.query("set constraints all deferred");
}

async function asService<T>(tx: pg.Client, fn: () => Promise<T>): Promise<T> {
  await actAs(tx, SERVICE);
  try {
    return await fn();
  } finally {
    await actAs(tx, ADMIN);
  }
}

/** A new group as whoever `tx` is. */
async function makeGroup(
  tx: pg.Client,
  o: { name?: string; optionName?: string; brand?: string | null } = {},
): Promise<{ id: string; short_id: string }> {
  const id = randomUUID();
  await tx.query(
    "insert into public.product_groups (id, name, option_name, brand) values ($1, $2, $3, $4)",
    [id, o.name ?? "Retro saddle", o.optionName ?? "Colour", o.brand ?? null],
  );
  const { rows } = await tx.query<{ id: string; short_id: string }>(
    "select id, short_id from public.product_groups where id = $1",
    [id],
  );
  return rows[0];
}

const join = (tx: pg.Client, productId: string, groupId: string | null, option: string | null) =>
  tx.query("update public.products set product_group_id = $2, option_value = $3 where id = $1", [
    productId,
    groupId,
    option,
  ]);

/** A public quantity product with a photo and stock, in `groupId` as `option`; ends as the admin. */
async function member(
  tx: pg.Client,
  groupId: string,
  option: string,
  o: { price?: string; stock?: number; sku?: string } = {},
): Promise<string> {
  await ownerMode(tx);
  const productId = await makeProduct(tx, { price: o.price ?? "26.56", sku: o.sku });
  await addPublicPhoto(tx, "product", productId);
  await publish(tx, productId);
  await actAs(tx, ADMIN);
  await join(tx, productId, groupId, option);
  if ((o.stock ?? 3) > 0) await addStock(tx, productId, o.stock ?? 3);
  return productId;
}

const setPublish = (tx: pg.Client, productId: string, on: boolean) =>
  tx.query("select public.set_publish_online($1, $2)", [productId, on]);

type GroupState = {
  short_id: string;
  handle: string;
  name: string;
  option_name: string;
  shopify_product_id: string | null;
  members: {
    product_id: string;
    sku: string;
    option_value: string;
    price: number | string | null;
    variant_id: string | null;
    effective_online: boolean;
    photo_paths: string[];
  }[];
} | null;

const groupState = (tx: pg.Client, productId: string) =>
  asService(tx, async () => {
    const { rows } = await tx.query<{ s: GroupState }>(
      "select public.product_group_sync_state($1) as s",
      [productId],
    );
    return rows[0].s;
  });

const queued = (tx: pg.Client, productId: string) =>
  readAsOwner(tx, async () => {
    const { rows } = await tx.query<{ id: string }>(
      `select id from public.integration_retry_queue
        where kind = 'product_sync' and product_id = $1 and status = 'queued'`,
      [productId],
    );
    return rows;
  });

const productRow = (tx: pg.Client, productId: string) =>
  readAsOwner(tx, async () => {
    const { rows } = await tx.query<{
      short_id: string;
      shopify_product_id: string | null;
      shopify_variant_id: string | null;
      shopify_handle: string | null;
      shopify_inventory_item_id: string | null;
    }>(
      `select p.short_id, p.shopify_product_id, p.shopify_variant_id, s.shopify_handle, s.shopify_inventory_item_id
         from public.products p left join public.shopify_product_sync s on s.product_id = p.id
        where p.id = $1`,
      [productId],
    );
    return rows[0];
  });

describe.skipIf(!isolatedDatabase())("product groups: membership (D241, D242)", () => {
  it("gives a group a G- number and takes members with unique option values", async () => {
    await inTx(async (tx) => {
      const group = await makeGroup(tx);
      expect(group.short_id).toMatch(/^G-[0-9]{6}$/);
      const black = await member(tx, group.id, "Black");
      await member(tx, group.id, "Brown");

      await ownerMode(tx);
      const other = await makeProduct(tx);
      await actAs(tx, ADMIN);
      await failsWith(tx, () => join(tx, other, group.id, " black "), {
        code: "23505",
        constraint: "products_group_option_value_key",
      });
      await failsWith(tx, () => join(tx, other, group.id, null), {
        code: "23514",
        constraint: "products_group_option_pair",
      });

      // Leaving a group before Shopify is fine.
      await join(tx, black, null, null);
      expect((await groupState(tx, other)) ?? null).toBeNull();
    });
  });

  it("refuses an archived group, and archiving a group with live members", async () => {
    await inTx(async (tx) => {
      const group = await makeGroup(tx);
      const productId = await member(tx, group.id, "Green");
      await failsWith(
        tx,
        () =>
          tx.query("update public.product_groups set archived_at = now() where id = $1", [
            group.id,
          ]),
        { code: "P0001", message: "product_group_has_members" },
      );
      await join(tx, productId, null, null);
      await tx.query("update public.product_groups set archived_at = now() where id = $1", [
        group.id,
      ]);
      await failsWith(tx, () => join(tx, productId, group.id, "Green"), {
        code: "P0001",
        message: "product_group_archived",
      });
    });
  });

  it("keeps a product on Shopify in its group", async () => {
    await inTx(async (tx) => {
      const group = await makeGroup(tx);
      const productId = await member(tx, group.id, "Red");
      await ownerMode(tx);
      await tx.query(
        "update public.products set shopify_product_id = $2, shopify_variant_id = $3 where id = $1",
        [productId, gid("Product"), gid("ProductVariant")],
      );
      await actAs(tx, ADMIN);
      await failsWith(tx, () => join(tx, productId, null, null), {
        code: "P0001",
        message: "product_group_shopify_linked",
      });
      // Its option value may still be renamed.
      await tx.query("update public.products set option_value = 'Cherry red' where id = $1", [
        productId,
      ]);
    });
  });

  it("needs manage_inventory to make a group", async () => {
    await inTx(async (tx) => {
      await actAs(tx, MECHANIC2);
      await failsWith(tx, () => makeGroup(tx), { code: "42501" });
    });
  });
});

describe.skipIf(!isolatedDatabase())(
  "product groups: Shopify and the public view (D243-D245)",
  () => {
    it("pushes one Shopify product per group, shared by its members", async () => {
      await inTx(async (tx) => {
        await tx.query("select public.set_shopify_settings($1, $2, $3, null)", [
          SHOPIFY_SETTINGS.onlineLocationId,
          STOREFRONT,
          SHOPIFY_SETTINGS.acceptTestOrders,
        ]);
        const group = await makeGroup(tx, { brand: "BICII" });
        const black = await member(tx, group.id, "Black", { sku: `SST-${nextShopifyId()}` });
        const brown = await member(tx, group.id, "Brown", { price: "28.00" });
        const unpublished = await member(tx, group.id, "Blue");

        await setPublish(tx, black, true);
        await setPublish(tx, brown, true);
        await flush(tx);

        const state = await groupState(tx, black);
        expect(state).toMatchObject({
          short_id: group.short_id,
          handle: `bicii-${group.short_id.toLowerCase()}`,
          option_name: "Colour",
          shopify_product_id: null,
        });
        // Only members published online (with a price) are variants.
        expect(state!.members.map((m) => m.product_id)).toEqual([black, brown]);
        expect(state!.members[1]).toMatchObject({ option_value: "Brown", effective_online: true });
        expect(Number(state!.members[1].price)).toBe(28);
        expect(state!.members[0].photo_paths).toHaveLength(1);
        expect(state!.members.some((m) => m.product_id === unpublished)).toBe(false);

        const handle = await asService(tx, async () => {
          const { rows } = await tx.query<{ handle: string }>(
            "select handle from public.product_sync_state($1)",
            [brown],
          );
          return rows[0].handle;
        });
        expect(handle).toBe(state!.handle);

        // black's job pushes the group: every variant's ids are stored and
        // brown is queued (it already was; one queued job stays).
        const productGid = gid("Product");
        const variants = [
          {
            product_id: black,
            variant_id: gid("ProductVariant"),
            inventory_item_id: gid("InventoryItem"),
          },
          {
            product_id: brown,
            variant_id: gid("ProductVariant"),
            inventory_item_id: gid("InventoryItem"),
          },
        ];
        await asService(tx, () =>
          tx.query("select public.record_product_group_push($1, $2, $3, $4, $5::jsonb)", [
            group.id,
            black,
            productGid,
            sha("group-1"),
            JSON.stringify(variants),
          ]),
        );
        const brownRow = await productRow(tx, brown);
        expect(brownRow).toMatchObject({
          shopify_product_id: productGid,
          shopify_variant_id: variants[1].variant_id,
          shopify_inventory_item_id: variants[1].inventory_item_id,
          shopify_handle: state!.handle,
        });
        expect(await queued(tx, brown)).toHaveLength(1);

        // Both members' own pushes share the group's Shopify product.
        for (const [i, productId] of [black, brown].entries()) {
          await asService(tx, () =>
            tx.query(
              `select public.record_product_sync_result($1, null, 'pushed', $2, $3, $4, null, 3, 26.56,
                                                      $5, '2026-10', null, null, null)`,
              [
                productId,
                productGid,
                variants[i].variant_id,
                variants[i].inventory_item_id,
                sha(productId),
              ],
            ),
          );
        }
        expect((await productRow(tx, black)).shopify_handle).toBe(state!.handle);

        // The same hash again queues nobody new.
        await asService(tx, () =>
          tx.query("select public.record_product_group_push($1, $2, $3, $4, $5::jsonb)", [
            group.id,
            black,
            productGid,
            sha("group-1"),
            JSON.stringify(variants),
          ]),
        );

        // A different Shopify product for the group is refused.
        await actAs(tx, SERVICE);
        await failsWith(
          tx,
          () =>
            tx.query("select public.record_product_group_push($1, $2, $3, $4, '[]'::jsonb)", [
              group.id,
              black,
              gid("Product"),
              sha("group-2"),
            ]),
          { code: "P0001", message: "shopify_ids_conflict" },
        );
        await actAs(tx, ADMIN);

        // The public view names the group and option; Buy online opens the variant.
        // (brown's queued job would settle it; the owner marks it synced here.)
        await ownerMode(tx);
        await tx.query(
          "update public.shopify_product_sync set sync_status = 'synced' where product_id = $1",
          [brown],
        );
        await actAs(tx, ADMIN);
        const { rows } = await tx.query<{
          group_short_id: string;
          group_name: string;
          option_name: string;
          option_value: string;
          buy_online_url: string | null;
        }>(
          `select group_short_id, group_name, option_name, option_value, buy_online_url
           from reporting.public_items where short_id = $1`,
          [brownRow.short_id],
        );
        expect(rows[0]).toMatchObject({
          group_short_id: group.short_id,
          group_name: "Retro saddle",
          option_name: "Colour",
          option_value: "Brown",
        });
        expect(rows[0].buy_online_url).toBe(
          `${STOREFRONT}/products/${state!.handle}?variant=${variants[1].variant_id.split("/").pop()}`,
        );
      });
    });

    it("queues every member when the group changes", async () => {
      await inTx(async (tx) => {
        const group = await makeGroup(tx);
        const a = await member(tx, group.id, "S");
        const b = await member(tx, group.id, "M");
        await setPublish(tx, a, true);
        await setPublish(tx, b, true);
        await flush(tx);
        await ownerMode(tx);
        await tx.query(
          `update public.integration_retry_queue
            set status = 'dismissed', resolved_at = now(), resolution_reason = 'test'
          where product_id in ($1, $2) and status = 'queued'`,
          [a, b],
        );
        await actAs(tx, ADMIN);
        await tx.query("update public.product_groups set option_name = 'Size' where id = $1", [
          group.id,
        ]);
        await flush(tx);
        expect(await queued(tx, a)).toHaveLength(1);
        expect(await queued(tx, b)).toHaveLength(1);
      });
    });
  },
);
