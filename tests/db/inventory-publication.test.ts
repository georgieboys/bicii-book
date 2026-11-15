/**
 * Publication by hand and the anonymous public projection (SPEC §11, §15,
 * §23 "Public QR pages expose only explicitly published records";
 * DATA-MODEL §11, §14, §15, §16; PLAN D9, D26 PUBLICATION-MACHINE).
 *
 *   * reporting.public_items is the only anonymous inventory surface:
 *     published (public or sold) products and their units, an exact list
 *     of public columns, the price from private.selling_price and public
 *     photos only (a unit's bike photos stop at the sale);
 *   * set_publication_status walks the D26 machine with the manual-only
 *     rules (never 'sold'; from 'sold' only 'archived') and the products
 *     trigger's requirements, and its accepted targets equal
 *     src/lib/inventory.ts manualPublicationTargets for every state.
 *
 * Tests create products, units and jobs (short-ID sequences), so the file
 * runs only on a per-file clone (TESTING.md). Every test that writes stock
 * ends with assertLedgerConsistent().
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import {
  manualPublicationTargets,
  PUBLICATION_STATUSES,
  type PublicationStatus,
} from "@/lib/inventory";

import {
  CUSTOMER,
  PRODUCT_CATEGORY,
  SEEDED_PUBLIC_PRODUCT_SHORT_IDS,
  STAFF,
} from "../fixtures/ids";
import { customerClaims, linkCustomerLogin } from "./customer-fixtures";
import { actAs, connect, inTransaction, isolatedDatabase, scalar } from "./harness";
import {
  ADMIN,
  MECHANIC1,
  MECHANIC2,
  addPart,
  addPublicPhoto,
  addStock,
  assertLedgerConsistent,
  completeJob,
  makeProduct,
  makeUnit,
  newJob,
  publication,
  publicItems,
  publishProduct,
  readAsOwner,
  setPublication,
  unit,
  type PublicItem,
} from "./inventory-fixtures";
import { failsWith, makeBike, ownerMode, setStatus, tryAndUndo } from "./workshop-fixtures";

let conn: pg.Client;

beforeAll(async () => {
  conn = await connect();
});

const inTx = <T>(fn: (tx: pg.Client) => Promise<T>) => inTransaction(conn, fn);

const ANON = { role: "anon" as const };

const PUBLIC_COLUMNS = [
  "kind",
  "short_id",
  "slug",
  "name",
  "description",
  "brand",
  "category",
  "condition",
  "sale_price",
  "currency",
  "availability",
  "photos",
  "updated_at",
  // Phase 10 step 2 (D84): the Buy-online link, null unless published,
  // synced and available.
  "buy_online_url",
  // D244: the product group a row is one choice of, and its option value.
  "group_short_id",
  "group_name",
  "option_name",
  "option_value",
];

const shortIdOf = (tx: pg.Client, table: string, id: string) =>
  scalar<string>(tx, `select short_id from public.${table} where id = $1`, [id]);

/** A storage path → the photo object public_items shows for it. */
const photoPaths = (item: PublicItem | undefined) => (item?.photos ?? []).map((p) => p.path);

const pathOf = (tx: pg.Client, attachmentId: string) =>
  scalar<string>(tx, "select storage_path from public.attachments where id = $1", [attachmentId]);

const bySid = (items: PublicItem[], sid: string) => items.find((i) => i.short_id === sid);

describe.skipIf(!isolatedDatabase())(
  "public QR pages expose only explicitly published records",
  () => {
    it("anon sees published products and their units only, with public columns, prices and photos", async () => {
      await inTx(async (tx) => {
        await ownerMode(tx);
        // Not published: a draft, an internal-only and an archived product,
        // each with a public photo, and a unique product's unit.
        const draft = await makeProduct(tx, { publication: "draft", name: "Draft pump" });
        const internal = await makeProduct(tx, { name: "Internal pump" });
        const archived = await makeProduct(tx, { name: "Archived pump" });
        const internalUnique = await makeProduct(tx, { tracking: "unique", name: "Hidden frame" });
        for (const id of [draft, internal, archived, internalUnique]) {
          await addPublicPhoto(tx, "product", id);
        }

        // Published: a counted product in stock, one with none, a unique product.
        const pump = await makeProduct(tx, {
          name: "Track pump",
          price: "45.00",
          cost: "20.00",
          sku: "LZ-TRACK-1",
        });
        await tx.query(
          "update public.products set description = 'Steel barrel, 220 psi.', brand = 'Lezyne', category_id = $2 where id = $1",
          [pump, PRODUCT_CATEGORY.care],
        );
        const first = await addPublicPhoto(tx, "product", pump, {
          createdAt: "2026-01-01T00:00:00Z",
          caption: "Side view",
        });
        const internalPhoto = await addPublicPhoto(tx, "product", pump, { visibility: "internal" });
        const second = await addPublicPhoto(tx, "product", pump, {
          createdAt: "2026-01-02T00:00:00Z",
        });
        const soldOut = await makeProduct(tx, { name: "Floor pump", price: "60.00" });
        await addPublicPhoto(tx, "product", soldOut);

        const bike = await makeBike(tx, null);
        const frame = await makeProduct(tx, {
          tracking: "unique",
          name: "Steel frame",
          price: "900.00",
        });
        const productPhoto = await addPublicPhoto(tx, "product", frame, {
          createdAt: "2026-01-02T00:00:00Z",
        });
        const bikePhoto = await addPublicPhoto(tx, "bike", bike, {
          createdAt: "2026-01-01T00:00:00Z",
        });

        await actAs(tx, ADMIN);
        const frameUnit = await makeUnit(tx, frame, {
          bikeId: bike,
          serial: "SER-HIDDEN-1",
          condition: "Like new",
          price: "1200.00",
          cost: "700.00",
        });
        await makeUnit(tx, internalUnique);
        await ownerMode(tx);
        const unitPhoto = await addPublicPhoto(tx, "inventory_unit", frameUnit.unit_id, {
          createdAt: "2026-01-03T00:00:00Z",
        });
        await actAs(tx, ADMIN);
        await addStock(tx, pump, 5);
        await setPublication(tx, archived, "archived");
        for (const id of [pump, soldOut, frame]) await publishProduct(tx, id);

        await ownerMode(tx);
        const path = {
          first: await pathOf(tx, first),
          second: await pathOf(tx, second),
          internalPhoto: await pathOf(tx, internalPhoto),
          productPhoto: await pathOf(tx, productPhoto),
          bikePhoto: await pathOf(tx, bikePhoto),
          unitPhoto: await pathOf(tx, unitPhoto),
        };
        const sid = {
          pump: await shortIdOf(tx, "products", pump),
          soldOut: await shortIdOf(tx, "products", soldOut),
          frame: await shortIdOf(tx, "products", frame),
          draft: await shortIdOf(tx, "products", draft),
        };

        await actAs(tx, ANON);
        const items = await publicItems(tx);
        // Only the three published products and the published one's unit,
        // besides the seed's own published products (Phase 10's syncedTyre).
        expect(items.map((i) => i.short_id).sort()).toEqual(
          [
            sid.pump,
            sid.soldOut,
            sid.frame,
            frameUnit.short_id,
            ...SEEDED_PUBLIC_PRODUCT_SHORT_IDS,
          ].sort(),
        );
        // Unknown and unpublished IDs are equally absent (the /q page 404s).
        for (const missing of [sid.draft, "P-999999", "U-999999"]) {
          const { rowCount } = await tx.query(
            "select 1 from reporting.public_items where short_id = $1",
            [missing],
          );
          expect(rowCount).toBe(0);
        }

        // Exactly the public columns: nothing cost-like, no serial, internal
        // note, location, ownership, consignor or SKU can appear.
        const { rows: columns } = await tx.query<{ column_name: string }>(
          `select column_name from information_schema.columns
          where table_schema = 'reporting' and table_name = 'public_items' order by ordinal_position`,
        );
        expect(columns.map((c) => c.column_name)).toEqual(PUBLIC_COLUMNS);
        for (const item of items) expect(Object.keys(item)).toEqual(PUBLIC_COLUMNS);
        expect(JSON.stringify(items)).not.toMatch(/SER-HIDDEN-1|LZ-TRACK-1|700\.00/);

        const pumpRow = bySid(items, sid.pump);
        expect(pumpRow).toMatchObject({
          kind: "product",
          slug: `track-pump-${sid.pump.toLowerCase()}`,
          name: "Track pump",
          description: "Steel barrel, 220 psi.",
          brand: "Lezyne",
          category: "Care",
          condition: null,
          sale_price: "45.00",
          currency: "SGD",
          availability: "available",
        });
        // Public photos only, oldest first, with exactly these keys.
        expect(photoPaths(pumpRow)).toEqual([path.first, path.second]);
        expect(photoPaths(pumpRow)).not.toContain(path.internalPhoto);
        expect(pumpRow?.photos[0]).toEqual({
          bucket: "media-public",
          path: path.first,
          width: 1600,
          height: 1200,
          caption: "Side view",
        });
        expect(bySid(items, sid.soldOut)).toMatchObject({
          availability: "sold_out",
          photos: expect.any(Array),
        });

        // A unique product: its own photos; the unit: its own, then the
        // product's, then the bike's.
        expect(bySid(items, sid.frame)).toMatchObject({
          kind: "product",
          condition: null,
          sale_price: "900.00",
          availability: "available",
        });
        expect(photoPaths(bySid(items, sid.frame))).toEqual([path.productPhoto]);
        const unitRow = bySid(items, frameUnit.short_id);
        expect(unitRow).toMatchObject({
          kind: "unit",
          slug: `steel-frame-${sid.frame.toLowerCase()}`,
          name: "Steel frame",
          condition: "Like new",
          sale_price: "1200.00",
          availability: "available",
        });
        expect(photoPaths(unitRow)).toEqual([path.unitPhoto, path.productPhoto, path.bikePhoto]);

        // sale_price is private.selling_price for every row.
        await ownerMode(tx);
        for (const item of items) {
          const expected =
            item.kind === "product"
              ? await scalar<string>(
                  tx,
                  "select private.selling_price(id, null)::text from public.products where short_id = $1",
                  [item.short_id],
                )
              : await scalar<string>(
                  tx,
                  "select private.selling_price(product_id, id)::text from public.inventory_units where short_id = $1",
                  [item.short_id],
                );
          expect(item.sale_price).toBe(expected);
        }
        // A price change shows at once (no copy is kept).
        await tx.query("update public.inventory_units set sale_price = 1150 where id = $1", [
          frameUnit.unit_id,
        ]);
        await actAs(tx, ANON);
        expect(bySid(await publicItems(tx), frameUnit.short_id)?.sale_price).toBe("1150.00");

        // anon reaches private.selling_price only through the view.
        await failsWith(tx, () => tx.query("select private.selling_price(null, null)"), {
          code: "42501",
        });
        await ownerMode(tx);
        await assertLedgerConsistent(tx);
      });
    });

    it("a sold unit and its product show sold; a sold-then-archived product exposes none of its units", async () => {
      await inTx(async (tx) => {
        await ownerMode(tx);
        const productId = await makeProduct(tx, { tracking: "unique", name: "Ex-demo folder" });
        await addPublicPhoto(tx, "product", productId);
        await actAs(tx, ADMIN);
        const sold = await makeUnit(tx, productId);
        await publishProduct(tx, productId);
        const productSid = await shortIdOf(tx, "products", productId);
        const job = await newJob(tx);
        await addPart(tx, { workOrderId: job.id, productId, unitId: sold.unit_id });

        // On a job (held): the unit and the product are unavailable.
        await actAs(tx, ANON);
        let items = await publicItems(tx);
        expect(bySid(items, sold.short_id)?.availability).toBe("unavailable");
        expect(bySid(items, productSid)?.availability).toBe("unavailable");

        await actAs(tx, ADMIN);
        await completeJob(tx, job.id);
        expect(await publication(tx, productId)).toBe("sold");
        await actAs(tx, ANON);
        items = await publicItems(tx);
        expect(bySid(items, sold.short_id)?.availability).toBe("sold");
        expect(bySid(items, productSid)?.availability).toBe("sold");

        // A written-off unit never shows.
        await ownerMode(tx);
        const other = await makeProduct(tx, { tracking: "unique", name: "Second folder" });
        await addPublicPhoto(tx, "product", other);
        await actAs(tx, ADMIN);
        const [keep, broken] = [await makeUnit(tx, other), await makeUnit(tx, other)];
        await publishProduct(tx, other);
        await tx.query("select public.write_off_unit($1, $2, 'Frame cracked')", [
          randomUUID(),
          broken.unit_id,
        ]);
        await actAs(tx, ANON);
        items = await publicItems(tx);
        expect(bySid(items, keep.short_id)).toBeDefined();
        expect(bySid(items, broken.short_id)).toBeUndefined();

        // Sold, then archived: neither the product nor its units.
        await actAs(tx, ADMIN);
        await setPublication(tx, productId, "archived", "Sold and collected");
        await actAs(tx, ANON);
        items = await publicItems(tx);
        expect(bySid(items, productSid)).toBeUndefined();
        expect(bySid(items, sold.short_id)).toBeUndefined();
        await ownerMode(tx);
        await assertLedgerConsistent(tx);
      });
    });

    it("a unit's linked-bike photos include those taken before the sale and never those after", async () => {
      await inTx(async (tx) => {
        await ownerMode(tx);
        const bike = await makeBike(tx, null);
        const productId = await makeProduct(tx, { tracking: "unique", name: "Shop bike for sale" });
        const before = await addPublicPhoto(tx, "bike", bike, {
          createdAt: "2026-01-01T00:00:00Z",
        });
        await actAs(tx, ADMIN);
        const u = await makeUnit(tx, productId, { bikeId: bike });
        await publishProduct(tx, productId);
        const job = await newJob(tx);
        await addPart(tx, { workOrderId: job.id, productId, unitId: u.unit_id });
        await completeJob(tx, job.id);
        expect((await unit(tx, u.unit_id)).status).toBe("sold");
        // Exact to the microsecond (a JS Date would drop them).
        const soldAt = await scalar<string>(
          tx,
          "select sold_at::text from public.inventory_units where id = $1",
          [u.unit_id],
        );

        // The buyer's bike is photographed after the sale (e.g. on a later job).
        await ownerMode(tx);
        const after = await addPublicPhoto(tx, "bike", bike, {
          createdAt: await scalar<string>(
            tx,
            "select ($1::timestamptz + interval '1 minute')::text",
            [soldAt],
          ),
        });
        const atSale = await addPublicPhoto(tx, "bike", bike, { createdAt: soldAt });
        await actAs(tx, ANON);
        const row = bySid(await publicItems(tx), u.short_id);
        expect(row?.availability).toBe("sold");
        expect(photoPaths(row)).toEqual([await readAsOwner(tx, () => pathOf(tx, before))]);
        await ownerMode(tx);
        expect(photoPaths(row)).not.toContain(await pathOf(tx, after));
        expect(photoPaths(row)).not.toContain(await pathOf(tx, atSale));
        await assertLedgerConsistent(tx);
      });
    });

    it("bike photos stay cut off at the first handover to a buyer, even after a reopen and re-completion (D29)", async () => {
      await inTx(async (tx) => {
        await ownerMode(tx);
        const bike = await makeBike(tx, null);
        const productId = await makeProduct(tx, { tracking: "unique", name: "Shop bike again" });
        const before = await addPublicPhoto(tx, "bike", bike, {
          createdAt: "2026-01-01T00:00:00Z",
        });
        await actAs(tx, ADMIN);
        const u = await makeUnit(tx, productId, { bikeId: bike });
        await publishProduct(tx, productId);
        const job = await newJob(tx);
        await addPart(tx, { workOrderId: job.id, productId, unitId: u.unit_id });
        await completeJob(tx, job.id);
        const handOver = (to: string | null, reason: string) =>
          tx.query("select public.transfer_bike_ownership($1, $2, $3)", [bike, to, reason]);
        await handOver(job.customer_id, "Sold on the job");
        // While the job is closed and the bike is the buyer's, a reopen is refused.
        await failsWith(tx, () => setStatus(tx, job.id, "in_progress", "Pending cost"), {
          code: "P0001",
          message: "bike_with_customer",
        });

        // The buyer's bike is photographed; later it comes back to the shop,
        // the job is reopened and completed again (sold_at moves forward).
        await ownerMode(tx);
        const afterHandover = await addPublicPhoto(tx, "bike", bike, {
          createdAt: await scalar<string>(tx, "select clock_timestamp()::text"),
        });
        await actAs(tx, ADMIN);
        await handOver(null, "Buyer returned the bike");
        await setStatus(tx, job.id, "in_progress", "Pending cost");
        await setStatus(tx, job.id, "completed");
        // The photo predates the new sold_at, so sold_at alone would show it.
        await ownerMode(tx);
        expect(
          await scalar<boolean>(
            tx,
            `select a.created_at < u.sold_at from public.attachments a, public.inventory_units u
              where a.id = $1 and u.id = $2`,
            [afterHandover, u.unit_id],
          ),
        ).toBe(true);

        await actAs(tx, ANON);
        const row = bySid(await publicItems(tx), u.short_id);
        expect(row?.availability).toBe("sold");
        await ownerMode(tx);
        expect(photoPaths(row)).toEqual([await pathOf(tx, before)]);
        expect(photoPaths(row)).not.toContain(await pathOf(tx, afterHandover));
        await assertLedgerConsistent(tx);
      });
    });

    it("signed-in customers and staff see the same rows as anon", async () => {
      await inTx(async (tx) => {
        await ownerMode(tx);
        const productId = await makeProduct(tx, { name: "Bell" });
        await addPublicPhoto(tx, "product", productId);
        const authUserId = await linkCustomerLogin(tx, CUSTOMER.priya);
        await actAs(tx, ADMIN);
        await publishProduct(tx, productId);

        const bell = await shortIdOf(tx, "products", productId);
        await actAs(tx, ANON);
        const anon = await publicItems(tx);
        // The bell and the seed's own published products (Phase 10).
        expect(anon.map((i) => i.short_id).sort()).toEqual(
          [bell, ...SEEDED_PUBLIC_PRODUCT_SHORT_IDS].sort(),
        );
        await actAs(tx, customerClaims(authUserId));
        expect(await publicItems(tx)).toEqual(anon);
        await actAs(tx, MECHANIC2);
        expect(await publicItems(tx)).toEqual(anon);
      });
    });
  },
);

// ---------------------------------------------------------------------------
// set_publication_status
// ---------------------------------------------------------------------------

type Tracking = "quantity" | "unique";

/**
 * A priced product with a public photo, in publication state `from`, with
 * `available` available units (unique only; quantity products have none).
 * 'sold' with an available unit is unreachable (a unit that becomes
 * available restores public, D26), so `from` 'sold' ignores `available`.
 * Leaves `tx` acting as the admin.
 */
async function productIn(
  tx: pg.Client,
  from: PublicationStatus,
  tracking: Tracking,
  available: 0 | 1,
): Promise<string> {
  await ownerMode(tx);
  const productId = await makeProduct(tx, {
    tracking,
    publication: from === "draft" ? "draft" : "internal_only",
  });
  await addPublicPhoto(tx, "product", productId);
  await actAs(tx, ADMIN);
  const needsUnit =
    tracking === "unique" && (available === 1 || from === "public" || from === "sold");
  const first = needsUnit ? await makeUnit(tx, productId) : null;
  if (from === "archived") await setPublication(tx, productId, "archived");
  if (from === "public" || from === "sold") await setPublication(tx, productId, "public");
  if (from === "sold" && first) {
    const job = await newJob(tx);
    await addPart(tx, { workOrderId: job.id, productId, unitId: first.unit_id });
    await completeJob(tx, job.id);
  }
  if (from === "public" && first && available === 0) {
    const job = await newJob(tx);
    await addPart(tx, { workOrderId: job.id, productId, unitId: first.unit_id });
  }
  expect(await publication(tx, productId)).toBe(from);
  return productId;
}

/** The refusal set_publication_status gives for a manual move, or null when it is accepted. */
function expectedRefusal(
  from: PublicationStatus,
  to: PublicationStatus,
  tracking: Tracking,
  available: number,
): string | null {
  if (to === "sold" || (from === "sold" && to !== "archived")) return "publication_sold_by_sale";
  const allowed: Record<PublicationStatus, PublicationStatus[]> = {
    draft: ["internal_only", "archived"],
    internal_only: ["public", "archived"],
    public: ["internal_only", "sold", "archived"],
    sold: ["public", "archived"],
    archived: ["internal_only"],
  };
  if (!allowed[from].includes(to)) return "publication_transition_invalid";
  if (to === "public" && tracking === "unique" && available < 1) {
    return "publication_requires_available_unit";
  }
  return null;
}

// Every reachable (tracking, available units) case; a quantity product is
// never 'sold' (only unique products are sold, D26).
const CASES: { tracking: Tracking; available: 0 | 1 }[] = [
  { tracking: "quantity", available: 0 },
  { tracking: "unique", available: 0 },
  { tracking: "unique", available: 1 },
];

describe.skipIf(!isolatedDatabase())("set_publication_status (PUBLICATION-MACHINE by hand)", () => {
  it("accepts exactly manualPublicationTargets from every state, and refuses the rest with the right code", async () => {
    await inTx(async (tx) => {
      for (const { tracking, available } of CASES) {
        for (const from of PUBLICATION_STATUSES) {
          if (tracking === "quantity" && from === "sold") continue;
          // Unreachable: an available unit on a sold product restores public
          // (refresh_unique_publication; tested below).
          if (from === "sold" && available === 1) continue;
          const productId = await productIn(tx, from, tracking, available);
          const accepted: PublicationStatus[] = [];
          for (const to of PUBLICATION_STATUSES) {
            if (to === from) continue;
            const refusal = expectedRefusal(from, to, tracking, available);
            const outcome = await tryAndUndo(tx, () =>
              setPublication(tx, productId, to).then(
                (r) => ({ ok: true as const, r }),
                (error: { code?: string; message?: string }) => ({ ok: false as const, error }),
              ),
            );
            const where = `${tracking}/${available} ${from} -> ${to}`;
            if (outcome.ok) {
              expect(refusal, where).toBeNull();
              expect(outcome.r.publication_status, where).toBe(to);
              accepted.push(to);
            } else {
              expect(outcome.error, where).toMatchObject({ code: "P0001", message: refusal });
            }
          }
          expect(accepted.sort(), `${tracking}/${available} from ${from}`).toEqual(
            manualPublicationTargets(from, {
              trackingType: tracking,
              availableUnits: available,
            }).sort(),
          );
        }
      }
      await ownerMode(tx);
      await assertLedgerConsistent(tx);
    });
  });

  it("refuses a manual sold and sold -> public; allows sold -> archived", async () => {
    await inTx(async (tx) => {
      const sold = await productIn(tx, "sold", "unique", 0);
      for (const to of ["sold", "public", "internal_only"]) {
        await failsWith(tx, () => setPublication(tx, sold, to), {
          code: "P0001",
          message: "publication_sold_by_sale",
        });
      }
      const pub = await productIn(tx, "public", "unique", 1);
      await failsWith(tx, () => setPublication(tx, pub, "sold"), {
        code: "P0001",
        message: "publication_sold_by_sale",
      });
      expect(await setPublication(tx, sold, "archived", "Collected")).toMatchObject({
        product_id: sold,
        publication_status: "archived",
      });
      await ownerMode(tx);
      await assertLedgerConsistent(tx);
    });
  });

  it("a unit registered on a sold product restores it to public (the system restore)", async () => {
    await inTx(async (tx) => {
      const productId = await productIn(tx, "sold", "unique", 0);
      const added = await makeUnit(tx, productId);
      expect(await publication(tx, productId)).toBe("public");
      const last = await scalar<Record<string, unknown>>(
        tx,
        `select payload from public.product_events
          where product_id = $1 and event_type = 'publication_changed'
          order by created_at desc, id desc limit 1`,
        [productId],
      );
      expect(last).toEqual({ from: "sold", to: "public" });

      await actAs(tx, ANON);
      const items = await publicItems(tx);
      const sid = await readAsOwner(tx, () => shortIdOf(tx, "products", productId));
      expect(bySid(items, sid)?.availability).toBe("available");
      expect(bySid(items, added.short_id)?.availability).toBe("available");
      await ownerMode(tx);
      await assertLedgerConsistent(tx);
    });
  });

  it("the same status is a no-op with no event", async () => {
    await inTx(async (tx) => {
      const productId = await productIn(tx, "public", "quantity", 0);
      const count = () =>
        scalar<number>(
          tx,
          "select count(*)::int from public.product_events where product_id = $1 and event_type = 'publication_changed'",
          [productId],
        );
      const before = await count();
      const slug = await scalar<string>(
        tx,
        "select public_slug from public.products where id = $1",
        [productId],
      );
      expect(await setPublication(tx, productId, "public", "Again")).toEqual({
        product_id: productId,
        publication_status: "public",
        public_slug: slug,
      });
      expect(await count()).toBe(before);
    });
  });

  it("enforces the photo and price requirements", async () => {
    await inTx(async (tx) => {
      await ownerMode(tx);
      const noPhoto = await makeProduct(tx, { name: "No photo" });
      const noPrice = await makeProduct(tx, { name: "No price", price: null });
      await addPublicPhoto(tx, "product", noPrice);
      const internalOnly = await makeProduct(tx, { name: "Internal photo" });
      await addPublicPhoto(tx, "product", internalOnly, { visibility: "internal" });
      await actAs(tx, ADMIN);
      await failsWith(tx, () => setPublication(tx, noPhoto, "public"), {
        code: "P0001",
        message: "publication_requires_photo",
      });
      await failsWith(tx, () => setPublication(tx, internalOnly, "public"), {
        code: "P0001",
        message: "publication_requires_photo",
      });
      await failsWith(tx, () => setPublication(tx, noPrice, "public"), {
        code: "P0001",
        message: "publication_requires_price",
      });
      // A unique product with an available unit but no price anywhere.
      await ownerMode(tx);
      const unpricedUnique = await makeProduct(tx, { tracking: "unique", price: null });
      await addPublicPhoto(tx, "product", unpricedUnique);
      await actAs(tx, ADMIN);
      const u = await makeUnit(tx, unpricedUnique);
      await failsWith(tx, () => setPublication(tx, unpricedUnique, "public"), {
        code: "P0001",
        message: "publication_requires_price",
      });
      await tx.query("update public.inventory_units set sale_price = 300 where id = $1", [
        u.unit_id,
      ]);
      expect((await setPublication(tx, unpricedUnique, "public")).publication_status).toBe(
        "public",
      );
      await ownerMode(tx);
      await assertLedgerConsistent(tx);
    });
  });

  it("publication_requires_available_unit for a unique product with no available unit", async () => {
    await inTx(async (tx) => {
      const none = await productIn(tx, "internal_only", "unique", 0);
      await failsWith(tx, () => setPublication(tx, none, "public"), {
        code: "P0001",
        message: "publication_requires_available_unit",
      });
      // A written-off unit does not count.
      const u = await makeUnit(tx, none);
      await tx.query("select public.write_off_unit($1, $2, 'Water damage')", [
        randomUUID(),
        u.unit_id,
      ]);
      await failsWith(tx, () => setPublication(tx, none, "public"), {
        code: "P0001",
        message: "publication_requires_available_unit",
      });
      await ownerMode(tx);
      await assertLedgerConsistent(tx);
    });
  });

  it("assigns the slug once and keeps it through unpublish and republish; 'item' when the name has no letters or digits", async () => {
    await inTx(async (tx) => {
      const productId = await productIn(tx, "internal_only", "quantity", 0);
      await ownerMode(tx);
      await tx.query("update public.products set name = 'Mini-Pump  (Road)' where id = $1", [
        productId,
      ]);
      const sid = (await shortIdOf(tx, "products", productId)).toLowerCase();
      await actAs(tx, ADMIN);
      expect(
        await scalar(tx, "select public_slug from public.products where id = $1", [productId]),
      ).toBeNull();
      const first = await setPublication(tx, productId, "public");
      expect(first.public_slug).toBe(`mini-pump-road-${sid}`);
      await setPublication(tx, productId, "internal_only");
      await tx.query("update public.products set name = 'Renamed pump' where id = $1", [productId]);
      await setPublication(tx, productId, "archived");
      await setPublication(tx, productId, "internal_only");
      expect((await setPublication(tx, productId, "public")).public_slug).toBe(first.public_slug);

      await ownerMode(tx);
      const symbols = await makeProduct(tx, { name: "★ ★ ★" });
      await addPublicPhoto(tx, "product", symbols);
      await actAs(tx, ADMIN);
      expect((await setPublication(tx, symbols, "public")).public_slug).toBe(
        `item-${(await shortIdOf(tx, "products", symbols)).toLowerCase()}`,
      );
    });
  });

  it("records publication_changed with {from, to}, the actor and the reason", async () => {
    await inTx(async (tx) => {
      const productId = await productIn(tx, "internal_only", "quantity", 0);
      await setPublication(tx, productId, "public", "  Ready for the window  ");
      await setPublication(tx, productId, "internal_only");
      const { rows } = await tx.query<{
        payload: Record<string, unknown>;
        reason: string | null;
        actor_staff_id: string;
      }>(
        `select payload, reason, actor_staff_id from public.product_events
          where product_id = $1 and event_type = 'publication_changed' order by created_at, id`,
        [productId],
      );
      expect(rows).toEqual([
        {
          payload: { from: "internal_only", to: "public" },
          reason: "Ready for the window",
          actor_staff_id: STAFF.admin,
        },
        {
          payload: { from: "public", to: "internal_only" },
          reason: null,
          actor_staff_id: STAFF.admin,
        },
      ]);
      await failsWith(tx, () => setPublication(tx, productId, "archived", "x".repeat(501)), {
        code: "P0001",
        message: "reason_too_long",
      });
    });
  });

  it("needs manage_inventory; an unknown product is P0002", async () => {
    await inTx(async (tx) => {
      const productId = await productIn(tx, "internal_only", "quantity", 0);
      for (const claims of [MECHANIC1, MECHANIC2]) {
        await actAs(tx, claims);
        await failsWith(tx, () => setPublication(tx, productId, "public"), { code: "42501" });
      }
      await actAs(tx, ADMIN);
      await failsWith(tx, () => setPublication(tx, randomUUID(), "public"), { code: "P0002" });
      await actAs(tx, ANON);
      await failsWith(tx, () => setPublication(tx, productId, "public"), { code: "42501" });
      expect(await readAsOwner(tx, () => publication(tx, productId))).toBe("internal_only");
    });
  });
});
