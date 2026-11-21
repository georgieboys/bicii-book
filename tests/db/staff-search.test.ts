/**
 * Global staff search (SPEC §5 "Search by customer, brand/model, serial
 * number and BICII ID", §20; DATA-MODEL §16 staff_search):
 *
 *   * finds bikes by short ID and serial number (ignoring case, spaces and
 *     dashes), by brand/model and by owner; customers by name in any word
 *     order, email and phone (with or without spaces or +65); jobs by job
 *     number (Phase 3), never in the archived lists; products by short ID,
 *     SKU (ignoring case, spaces and punctuation) and name/brand words, and
 *     units by short ID, serial number and product name (Phase 4);
 *     consignors by name, email and phone, consignment items by C- ID and
 *     product or consignor name, sales by S- number (Phase 6);
 *     suppliers by name, contact, email and phone, and purchase orders by
 *     PO number, supplier reference and supplier name (Phase 7);
 *   * exact short ID and serial matches rank first (rank 1), above every
 *     fuzzy hit;
 *   * kinds filter and result limit; unknown kinds raise; blank finds
 *     nothing; LIKE metacharacters are literal; archived rows are left out,
 *     or searched alone (archived = true) with the same matching;
 *   * active staff only.
 */
import type pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { SEARCH_KINDS } from "@/lib/search";

import {
  AUTH_USER,
  BIKE,
  CONSIGNMENT_ITEM,
  CONSIGNMENT_ITEM_SHORT_ID,
  CONSIGNOR,
  BIKE_SERIAL,
  BIKE_SHORT_ID,
  CUSTOMER,
  JOB_NUMBER,
  PO_NUMBER,
  PRODUCT,
  PRODUCT_SHORT_ID,
  PURCHASE_ORDER,
  SALE,
  SALE_NUMBER,
  STAFF,
  SUPPLIER,
  UNIT,
  UNIT_SHORT_ID,
  WORK_ORDER,
} from "../fixtures/ids";
import { archiveCustomerUnguarded, customerClaims, linkCustomerLogin } from "./customer-fixtures";
import {
  actAs,
  asAnon,
  asStaff,
  connect,
  inTransaction,
  isolatedDatabase,
  scalar,
  staffClaims,
} from "./harness";
import { ADMIN, makeUnit, writeOff } from "./inventory-fixtures";

let conn: pg.Client;

beforeAll(async () => {
  conn = await connect();
});

type Hit = {
  kind: string;
  id: string;
  title: string;
  subtitle: string | null;
  short_id: string | null;
  rank: number;
};

const search = (tx: pg.Client, q: string | null, kinds: string[] | null = null, max = 20) =>
  tx
    .query<Hit>("select * from public.staff_search($1, $2, $3)", [q, kinds, max])
    .then((r) => r.rows);

/** Searches as mechanic2 (active staff, no permissions). */
const find = (q: string | null, kinds: string[] | null = null, max = 20) =>
  asStaff(conn, STAFF.mechanic2, (tx) => search(tx, q, kinds, max));

const ids = (hits: Hit[]) => hits.map((h) => h.id);

describe("bikes by short ID and serial number", () => {
  it("an exact serial number finds the bike first, ignoring case, spaces and dashes", async () => {
    for (const q of [
      BIKE_SERIAL.tanTarmac,
      "wsbc604123456n",
      "WSBC 6041 2345 6N",
      "wsbc-604123456-n",
    ]) {
      const hits = await find(q);
      expect(hits[0]).toMatchObject({
        kind: "bike",
        id: BIKE.tanTarmac,
        short_id: BIKE_SHORT_ID.tanTarmac,
        rank: 1,
      });
    }
    expect((await find("TRN190045821"))[0]).toMatchObject({ id: BIKE.priyaTern, rank: 1 });
  });

  it("part of a serial number finds the bike", async () => {
    const hits = await find("604123");
    expect(ids(hits)).toContain(BIKE.tanTarmac);
    expect(hits.find((h) => h.id === BIKE.tanTarmac)?.rank).toBeLessThan(1);
  });

  it("a short ID finds the bike first, with or without the dash, in any case", async () => {
    for (const q of ["B-000003", "b-000003", "B000003", " b 000003 "]) {
      expect((await find(q))[0]).toMatchObject({
        kind: "bike",
        id: BIKE.priyaDomane,
        title: "Trek Domane SL 6",
        short_id: "B-000003",
        rank: 1,
      });
    }
  });

  it("exact short ID and serial matches rank above every other kind of hit", async () => {
    await inTransaction(conn, async (tx) => {
      // Records whose words contain the same text, matched fuzzily.
      await tx.query(
        `insert into public.customers (display_name) values
           ('B-000003 Owners Club'), ('WTU291C1234K Fan Club')`,
      );
      await actAs(tx, staffClaims(AUTH_USER.mechanic2));
      for (const q of ["B-000003", BIKE_SERIAL.priyaDomane]) {
        const hits = await search(tx, q);
        expect(hits.length).toBeGreaterThan(1);
        expect(hits[0]).toMatchObject({ id: BIKE.priyaDomane, rank: 1 });
        for (const other of hits.slice(1)) expect(other.rank).toBeLessThan(1);
        expect(hits.some((h) => h.kind === "customer")).toBe(true);
      }
    });
  });
});

describe("customers by name, email and phone", () => {
  it("finds a customer by any of their names, in any word order", async () => {
    for (const q of ["Tan", "wei ming", "Ming Tan", "tan wei ming", "TAN WEI"]) {
      const hits = await find(q, ["customer"]);
      expect(ids(hits)).toEqual([CUSTOMER.tan]);
      expect(hits[0]).toMatchObject({
        title: "Tan Wei Ming",
        subtitle: "weiming.tan@example.com · +65 9123 4567",
      });
    }
    // display_name falls back to first + last.
    expect((await find("ramasamy", ["customer"]))[0]).toMatchObject({
      id: CUSTOMER.priya,
      title: "Priya Ramasamy",
    });
  });

  it("finds a customer by phone, with or without spaces or +65, and by part of it", async () => {
    for (const q of ["9123 4567", "91234567", "+65 9123 4567", "+6591234567", "6591234567"]) {
      expect((await find(q))[0]).toMatchObject({ id: CUSTOMER.tan, rank: 0.95 });
    }
    const partial = await find("4567");
    expect(ids(partial)).toContain(CUSTOMER.tan);
    expect(partial.find((h) => h.id === CUSTOMER.tan)?.rank).toBeLessThan(0.95);
    // A walk-in with a phone number only.
    expect((await find("8678 9012"))[0]).toMatchObject({
      id: CUSTOMER.nurul,
      title: "Nurul Huda Ismail",
    });
  });

  it("finds a customer by email, an exact address ranking high", async () => {
    expect((await find("Priya.Ramasamy@example.com"))[0]).toMatchObject({
      id: CUSTOMER.priya,
      rank: 0.95,
    });
    // Part of an address: the customer first, then her bikes (by owner).
    const partial = await find("priya.rama");
    expect(partial[0]).toMatchObject({ kind: "customer", id: CUSTOMER.priya });
    expect(ids(partial.slice(1)).sort()).toEqual(
      [BIKE.priyaDomane, BIKE.priyaTern, BIKE.priyaCervelo].sort(),
    );
  });
});

describe("bikes by brand, model and owner", () => {
  it("finds bikes by brand or model", async () => {
    // Phase 4's seed adds the shop's ex-demo Brompton (no owner).
    expect(ids(await find("brompton", ["bike"])).sort()).toEqual(
      [BIKE.tanBrompton, BIKE.hafizBrompton, BIKE.shopBrompton].sort(),
    );
    expect(ids(await find("long haul"))).toEqual([BIKE.chloeSurly]);
  });

  it("across all kinds, a brand also finds its products and units (Phase 4)", async () => {
    expect(ids(await find("brompton")).sort()).toEqual(
      [
        BIKE.tanBrompton,
        BIKE.hafizBrompton,
        BIKE.shopBrompton,
        PRODUCT.bromptonTube,
        PRODUCT.brompton,
        UNIT.brompton,
      ].sort(),
    );
  });

  it("finds an owner's bikes by the owner's name, alone or with the brand", async () => {
    const hits = await find("tan");
    expect(hits[0]).toMatchObject({ kind: "customer", id: CUSTOMER.tan });
    expect(ids(hits.filter((h) => h.kind === "bike")).sort()).toEqual(
      [BIKE.tanTarmac, BIKE.tanBrompton].sort(),
    );
    expect(ids(await find("brompton hafiz"))).toEqual([BIKE.hafizBrompton]);
    expect(ids(await find("rahman brompton"))).toEqual([BIKE.hafizBrompton]);
  });

  it("labels a bike without an owner as a shop bike", async () => {
    expect((await find("cervelo"))[0]).toMatchObject({
      kind: "bike",
      id: BIKE.shopCervelo,
      title: "Cervelo Caledonia-5",
      subtitle: "Shop bike · Five Black · S/N CV-CAL5-0921",
      short_id: BIKE_SHORT_ID.shopCervelo,
    });
  });
});

describe("jobs by job number (Phase 3)", () => {
  it("an exact job number finds the job first, with or without the dash, in any case", async () => {
    for (const q of [JOB_NUMBER.chloeGiantInProgress, "j000004", "J000004", " j-000004 "]) {
      const hits = await find(q);
      expect(hits[0]).toMatchObject({
        kind: "work_order",
        id: WORK_ORDER.chloeGiantInProgress,
        title: "Giant TCR Advanced Pro 1",
        short_id: "J-000004",
        rank: 1,
      });
      expect(hits[0].subtitle).toBe("Chloe Lim · Both wheels out of true after a pothole.");
      for (const other of hits.slice(1)) expect(other.rank).toBeLessThan(1);
    }
  });

  it("part of a job number finds the job at 0.6", async () => {
    const hits = await find("000004", ["work_order"]);
    expect(hits).toEqual([
      expect.objectContaining({
        id: WORK_ORDER.chloeGiantInProgress,
        short_id: "J-000004",
        rank: 0.6,
      }),
    ]);
    // Every seeded job contains "00000"; at least three characters are needed.
    expect((await find("00000", ["work_order"])).map((h) => h.short_id).sort()).toEqual(
      Object.values(JOB_NUMBER).sort(),
    );
    expect(await find("04", ["work_order"])).toEqual([]);
  });

  it("finds jobs in every status, cancelled and collected included", async () => {
    for (const key of ["tanBromptonCancelled", "tanTarmacCollected"] as const) {
      expect((await find(JOB_NUMBER[key], ["work_order"]))[0]).toMatchObject({
        id: WORK_ORDER[key],
        rank: 1,
      });
    }
  });

  it("the kinds filter keeps jobs in or out", async () => {
    const all = await find("000004");
    // "000004" is also in Phase 6's seeded C-000004 and S-000004, and in
    // Phase 7's seeded PO-000004.
    expect(new Set(all.map((h) => h.kind))).toEqual(
      new Set(["bike", "work_order", "consignment_item", "sale", "purchase_order"]),
    );
    expect(new Set((await find("000004", ["work_order"])).map((h) => h.kind))).toEqual(
      new Set(["work_order"]),
    );
    expect((await find("J-000004", ["bike", "customer"])).map((h) => h.kind)).not.toContain(
      "work_order",
    );
  });

  it("jobs are never archived, so the archived lists never show one", async () => {
    await asStaff(conn, STAFF.mechanic2, async (tx) => {
      for (const kinds of [null, ["work_order"]]) {
        const { rows } = await tx.query<Hit>(
          "select * from public.staff_search($1, $2, 20, true)",
          [JOB_NUMBER.chloeGiantInProgress, kinds],
        );
        expect(rows.filter((h) => h.kind === "work_order")).toEqual([]);
      }
    });
  });
});

describe("products and units (Phase 4)", () => {
  it("an exact SKU finds the product at rank 1, typed in any case, with spaces or without dashes", async () => {
    for (const q of ["SHI-L05A-RF", "shi l05a rf", "shil05arf", " Shi-L05a-Rf "]) {
      const hits = await find(q);
      expect(hits[0]).toMatchObject({
        kind: "product",
        id: PRODUCT.brakePads,
        title: "Road disc brake pads, resin (pair)",
        subtitle: "SHI-L05A-RF · Shimano · 34 in stock",
        short_id: PRODUCT_SHORT_ID.brakePads,
        rank: 1,
      });
      for (const other of hits.slice(1)) expect(other.rank).toBeLessThan(1);
    }
  });

  it("part of a SKU finds the product at 0.7; three characters at least", async () => {
    // "l05arf" is in the SKU's key (SHIL05ARF) but in none of its words.
    const hits = await find("l05arf", ["product"]);
    expect(hits).toEqual([expect.objectContaining({ id: PRODUCT.brakePads, rank: 0.7 })]);
    // Every Shimano SKU starts SHI.
    expect(ids(await find("shi-", ["product"])).sort()).toEqual(
      [PRODUCT.brakePads, PRODUCT.cassette, PRODUCT.hydraulicHose].sort(),
    );
    expect(await find("5ar", ["product"])).toEqual([
      expect.objectContaining({ id: PRODUCT.brakePads, rank: 0.7 }),
    ]);
    // Two characters are too few for a SKU match (only the word match is left).
    expect((await find("5a", ["product"])).map((h) => h.rank < 0.7)).toEqual([true]);
  });

  it("exact P- and U- IDs rank 1, with or without the dash, in any case", async () => {
    for (const q of [PRODUCT_SHORT_ID.gp5000Tyre, "p000002", "P 000002"]) {
      expect((await find(q))[0]).toMatchObject({
        kind: "product",
        id: PRODUCT.gp5000Tyre,
        title: "Grand Prix 5000 700x25c tyre",
        subtitle: "CON-GP5K-25 · Continental · 12 in stock",
        short_id: "P-000002",
        rank: 1,
      });
    }
    for (const q of [UNIT_SHORT_ID.colnago, "u000001", "U 000001"]) {
      expect((await find(q))[0]).toMatchObject({
        kind: "inventory_unit",
        id: UNIT.colnago,
        title: "Colnago C64 Disc 52s (pre-owned)",
        subtitle: "Available · Shop floor · S/N COL-C64-11873",
        short_id: "U-000001",
        rank: 1,
      });
    }
  });

  it("products are found by name and brand words; subtitles show the ledger on-hand or 'Unique item'", async () => {
    const hits = await find("grand prix", ["product"]);
    expect(hits).toEqual([
      expect.objectContaining({
        id: PRODUCT.gp5000Tyre,
        subtitle: "CON-GP5K-25 · Continental · 12 in stock",
      }),
    ]);
    expect(hits[0].rank).toBeGreaterThanOrEqual(0.45);
    expect(hits[0].rank).toBeLessThan(0.86);
    // The road tube's stock is at two locations (40 + 20).
    expect((await find("SCH-SV20-60", ["product"]))[0]).toMatchObject({
      subtitle: "SCH-SV20-60 · Schwalbe · 60 in stock",
    });
    // Phase 6's consigned Colnago (another product with the same brand)
    // ranks alongside it, so the seeded shop bike is picked by id.
    expect(
      (await find("colnago", ["product"])).find((h) => h.id === PRODUCT.colnago),
    ).toMatchObject({
      id: PRODUCT.colnago,
      subtitle: "Colnago · Unique item",
    });
  });

  it("a unit is found by its serial number, exactly (1.0) or in part (0.7), and by its product's name", async () => {
    expect((await find("col c64 11873", ["inventory_unit"]))[0]).toMatchObject({
      id: UNIT.colnago,
      rank: 1,
    });
    expect(await find("SRY-BC-551", ["inventory_unit"])).toEqual([
      expect.objectContaining({ id: UNIT.surly, rank: 0.7 }),
    ]);
    expect(ids(await find("bridge club", ["inventory_unit"]))).toEqual([UNIT.surly]);
    // The shop bike shares the serial: both rank 1.
    const both = await find("2209183344");
    expect(
      both
        .filter((h) => h.rank === 1)
        .map((h) => h.id)
        .sort(),
    ).toEqual([BIKE.shopBrompton, UNIT.brompton].sort());
  });

  it("an inactive product is still found, marked Inactive", async () => {
    await inTransaction(conn, async (tx) => {
      await tx.query("update public.products set active = false where id = $1", [PRODUCT.barTape]);
      await actAs(tx, staffClaims(AUTH_USER.mechanic2));
      expect((await search(tx, "LS-DSP32"))[0]).toMatchObject({
        id: PRODUCT.barTape,
        subtitle: "LS-DSP32 · Lizard Skins · 7 in stock · Inactive",
        rank: 1,
      });
    });
  });

  it("archived products and units are left out, and are the only hits with archived = true", async () => {
    const archived = (tx: pg.Client, q: string, kinds: string[] | null = null) =>
      tx
        .query<Hit>("select * from public.staff_search($1, $2, 20, true)", [q, kinds])
        .then((r) => r.rows);
    // The seed's discontinued chain is archived.
    expect(await find("KMC-X10-OLD")).toEqual([]);
    expect(ids(await find("kmc", ["product"]))).toEqual([PRODUCT.chainX11]);
    await asStaff(conn, STAFF.mechanic2, async (tx) => {
      expect(ids(await archived(tx, "KMC-X10-OLD"))).toEqual([PRODUCT.chainX10Archived]);
      expect(ids(await archived(tx, "kmc", ["product"]))).toEqual([PRODUCT.chainX10Archived]);
      expect(await archived(tx, UNIT_SHORT_ID.colnago)).toEqual([]);
    });
  });

  it.skipIf(!isolatedDatabase())(
    "an archived unit is found only with archived = true",
    async () => {
      await inTransaction(conn, async (tx) => {
        await actAs(tx, ADMIN);
        const u = await makeUnit(tx, PRODUCT.surly, { serial: "SRY-ARCH-0001" });
        await writeOff(tx, u.unit_id);
        await tx.query("update public.inventory_units set archived_at = now() where id = $1", [
          u.unit_id,
        ]);
        await actAs(tx, staffClaims(AUTH_USER.mechanic2));
        expect(ids(await search(tx, "SRY-ARCH-0001"))).toEqual([]);
        expect(ids(await search(tx, u.short_id))).toEqual([]);
        const { rows } = await tx.query<Hit>(
          "select * from public.staff_search($1, $2, 20, true)",
          ["bridge club", ["inventory_unit"]],
        );
        expect(rows).toEqual([
          expect.objectContaining({
            id: u.unit_id,
            subtitle: "Written off · Shop floor · S/N SRY-ARCH-0001",
          }),
        ]);
      });
    },
  );
});

describe("consignors, consignment items and sales (Phase 6)", () => {
  it("an exact C- ID finds the consignment item at rank 1, with or without its dash, in any case", async () => {
    for (const q of [CONSIGNMENT_ITEM_SHORT_ID.cervelo, "c000002", "C 000002"]) {
      const hits = await find(q, ["consignment_item"]);
      expect({ q, hit: hits[0] }).toMatchObject({
        q,
        hit: {
          kind: "consignment_item",
          id: CONSIGNMENT_ITEM.cervelo,
          short_id: "C-000002",
          title: "Cervélo R3 (2017), 56 cm",
          rank: 1,
        },
      });
      expect(hits[0].subtitle).toMatch(/^Daniel Ong · Sold · U-\d{6}$/);
    }
    const all = await find(CONSIGNMENT_ITEM_SHORT_ID.cervelo);
    expect(all[0]).toMatchObject({
      kind: "consignment_item",
      id: CONSIGNMENT_ITEM.cervelo,
      rank: 1,
    });
    expect((await find("rapha jersey", ["consignment_item"]))[0]).toMatchObject({
      id: CONSIGNMENT_ITEM.jerseys,
      subtitle: "Chloe Lim · Active · Qty 6",
    });
  });

  it("a consignor is found by name words, email and phone digits", async () => {
    expect((await find("kelvin", ["consignor"]))[0]).toMatchObject({
      kind: "consignor",
      id: CONSIGNOR.kelvin,
      title: "Kelvin Yeo",
      subtitle: "+65 9876 5432",
      short_id: null,
    });
    expect((await find("98765432", ["consignor"]))[0]).toMatchObject({
      id: CONSIGNOR.kelvin,
      rank: 0.95,
    });
    expect((await find("chloe.lim@example.com", ["consignor"]))[0]).toMatchObject({
      id: CONSIGNOR.chloe,
      rank: 0.95,
    });
    // Kelvin's items are found by his name too.
    expect(ids(await find("kelvin", ["consignment_item"]))).toEqual(
      expect.arrayContaining([CONSIGNMENT_ITEM.colnago, CONSIGNMENT_ITEM.crankset]),
    );
  });

  it("an exact S- number finds the sale at rank 1 with its total, customer and day", async () => {
    for (const q of [SALE_NUMBER.cervelo, "s000003", "S 000003"]) {
      expect({ q, hit: (await find(q, ["sale"]))[0] }).toMatchObject({
        q,
        hit: {
          kind: "sale",
          id: SALE.cervelo,
          short_id: "S-000003",
          title: "S-000003 · $1,000.00",
          rank: 1,
        },
      });
    }
    expect((await find(SALE_NUMBER.cervelo, ["sale"]))[0].subtitle).toMatch(
      /^Hafiz Rahman · \d{1,2} \w{3} \d{4}$/,
    );
    expect((await find(SALE_NUMBER.tubes, ["sale"]))[0].subtitle).toMatch(/^Walk-in · /);
  });

  it("archived consignors only with archived = true; consignment items and sales never", async () => {
    await inTransaction(conn, async (tx) => {
      await tx.query(
        `insert into public.consignors (id, display_name, phone, archived_at)
         values ('6a000000-0000-4000-8000-0000000000aa', 'Archie Retired', '+65 9111 2222', now())`,
      );
      await actAs(tx, staffClaims(AUTH_USER.mechanic2));
      const q = (text: string, kinds: string[], archived: boolean) =>
        tx
          .query<Hit>("select * from public.staff_search($1, $2, 20, $3)", [text, kinds, archived])
          .then((r) => ids(r.rows));
      expect(await q("archie", ["consignor"], false)).toEqual([]);
      expect(await q("archie", ["consignor"], true)).toEqual([
        "6a000000-0000-4000-8000-0000000000aa",
      ]);
      expect(await q("kelvin", ["consignor"], true)).toEqual([]);
      expect(await q(CONSIGNMENT_ITEM_SHORT_ID.cervelo, ["consignment_item"], true)).toEqual([]);
      expect(await q(SALE_NUMBER.cervelo, ["sale"], true)).toEqual([]);
    });
  });
});

describe("query handling", () => {
  it("returns typed hits", async () => {
    const [hit] = await find("tarmac");
    expect(Object.keys(hit).sort()).toEqual([
      "id",
      "kind",
      "rank",
      "short_id",
      "subtitle",
      "title",
    ]);
    expect(typeof hit.rank).toBe("number");
  });

  it("treats % and _ as plain characters", async () => {
    for (const q of ["%", "_", "%%", "a%", "\\"]) {
      expect(await find(q)).toEqual([]);
    }
  });

  it("returns nothing for a blank query", async () => {
    for (const q of [null, "", "   "]) expect(await find(q)).toEqual([]);
  });

  it("filters by kind and limits the number of hits", async () => {
    expect(new Set((await find("tan", ["bike"])).map((h) => h.kind))).toEqual(new Set(["bike"]));
    expect(new Set((await find("tan", ["customer"])).map((h) => h.kind))).toEqual(
      new Set(["customer"]),
    );
    expect(await find("tan", [])).toEqual([]);
    expect(await find("tan", null, 1)).toHaveLength(1);
    expect(await find("tan", null, 0)).toHaveLength(1); // clamped to 1..100
  });

  it("never returns more than 100 hits", async () => {
    await inTransaction(conn, async (tx) => {
      await tx.query(
        "insert into public.customers (last_name) select 'Lee ' || n from generate_series(1, 120) n",
      );
      await actAs(tx, staffClaims(AUTH_USER.mechanic2));
      expect(await search(tx, "lee", null, 1000)).toHaveLength(100);
      expect(await search(tx, "lee", null, null as unknown as number)).toHaveLength(20);
    });
  });

  it("raises 22023 for a kind it does not know", async () => {
    // product and inventory_unit are known since Phase 4, supplier since Phase 7.
    await expect(find("tan", ["not_a_kind"])).rejects.toMatchObject({ code: "22023" });
    await expect(find("tan", ["product", "inventory_unit"])).resolves.toEqual([]);
    await expect(find("tan", ["bike", null as unknown as string])).rejects.toMatchObject({
      code: "22023",
    });
  });

  it("leaves out archived customers and bikes", async () => {
    await inTransaction(conn, async (tx) => {
      await archiveCustomerUnguarded(tx, CUSTOMER.tan);
      await tx.query("update public.bikes set archived_at = now() where id = $1", [BIKE.tanTarmac]);
      await actAs(tx, staffClaims(AUTH_USER.mechanic2));
      expect(ids(await search(tx, "tan wei ming", ["customer"]))).toEqual([]);
      expect(await search(tx, BIKE_SERIAL.tanTarmac)).toEqual([]);
      // His other bike is still found, by his name too.
      expect(ids(await search(tx, "tan", ["bike"]))).toEqual([BIKE.tanBrompton]);
    });
  });

  it("with archived = true searches archived records only, matching exactly as for active ones", async () => {
    await inTransaction(conn, async (tx) => {
      await archiveCustomerUnguarded(tx, CUSTOMER.tan);
      await tx.query("update public.bikes set archived_at = now() where id = $1", [BIKE.tanTarmac]);
      await actAs(tx, staffClaims(AUTH_USER.mechanic2));
      const archived = (q: string, kinds: string[] | null = null) =>
        tx
          .query<Hit>("select * from public.staff_search($1, $2, 20, true)", [q, kinds])
          .then((r) => ids(r.rows));
      const digits = BIKE_SHORT_ID.tanTarmac.replace("B-", "");
      // The short ID with or without its dash, the serial in any form, the owner's name.
      for (const q of [BIKE_SHORT_ID.tanTarmac, `B${digits}`, `b ${digits}`, "wsbc 6041 2345 6n"]) {
        expect(await archived(q, ["bike"])).toEqual([BIKE.tanTarmac]);
      }
      expect(await archived("tan wei ming", ["bike"])).toEqual([BIKE.tanTarmac]);
      expect(await archived("tan wei ming", ["customer"])).toEqual([CUSTOMER.tan]);
      // Active records are not in the archived results.
      expect(await archived("tan", ["bike"])).not.toContain(BIKE.tanBrompton);
    });
  });
});

describe("access", () => {
  it("is for active staff only", async () => {
    await expect(asAnon(conn, (tx) => search(tx, "tan"))).rejects.toMatchObject({ code: "42501" });
    await expect(
      inTransaction(conn, async (tx) => {
        await actAs(tx, customerClaims(await linkCustomerLogin(tx, CUSTOMER.priya)));
        return search(tx, "tan");
      }),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      inTransaction(conn, async (tx) => {
        await tx.query("update public.staff set active = false where id = $1", [STAFF.mechanic2]);
        await actAs(tx, staffClaims(AUTH_USER.mechanic2));
        return search(tx, "tan");
      }),
    ).rejects.toMatchObject({ code: "42501" });
  });
});

describe("suppliers and purchase orders (Phase 7)", () => {
  const archivedSearch = (q: string, kinds: string[] | null = null) =>
    asStaff(conn, STAFF.mechanic2, (tx) =>
      tx
        .query<Hit>("select * from public.staff_search($1, $2, 20, true)", [q, kinds])
        .then((r) => r.rows),
    );

  it("finds a supplier by name words in any order and by its contact", async () => {
    for (const q of ["velo parts", "Parts Velo", "asia velo", "kenneth", "LIM KENNETH"]) {
      const hits = await find(q, ["supplier"]);
      expect(ids(hits), q).toEqual([SUPPLIER.veloParts]);
      expect(hits[0]).toMatchObject({
        kind: "supplier",
        title: "Velo Parts Asia Pte Ltd",
        subtitle: "Kenneth Lim · +65 6123 4501 · sales@veloparts.test",
        short_id: null,
      });
      expect(hits[0].rank).toBeGreaterThanOrEqual(0.5);
      expect(hits[0].rank).toBeLessThanOrEqual(0.9);
    }
    expect(ids(await find("tropic tyre", ["supplier"]))).toEqual([SUPPLIER.tropicTyre]);
  });

  it("an exact email or phone number finds the supplier at 0.95; part of the phone at 0.6", async () => {
    expect((await find("Sales@VeloParts.test"))[0]).toMatchObject({
      kind: "supplier",
      id: SUPPLIER.veloParts,
      rank: 0.95,
    });
    for (const q of ["+65 6123 4501", "+6561234501", "6123 4501", "61234501"]) {
      expect((await find(q))[0], q).toMatchObject({
        kind: "supplier",
        id: SUPPLIER.veloParts,
        rank: 0.95,
      });
    }
    expect(await find("6234", ["supplier"])).toEqual([
      expect.objectContaining({ id: SUPPLIER.tropicTyre, rank: 0.6 }),
    ]);
  });

  it("an exact PO number finds the PO at rank 1, with or without the dash, in any case", async () => {
    const expected = await scalar<string>(
      conn,
      "select to_char(private.shop_today() - 1, 'FMDD Mon YYYY')",
    );
    for (const q of [PO_NUMBER.partial, "po 000002", "PO000002", " po-000002 "]) {
      const hits = await find(q);
      expect(hits[0], q).toEqual({
        kind: "purchase_order",
        id: PURCHASE_ORDER.partial,
        title: "Velo Parts Asia Pte Ltd",
        subtitle: `Partially received · expected ${expected} · 28 of 30 received`,
        short_id: "PO-000002",
        rank: 1,
      });
      for (const other of hits.slice(1)) expect(other.rank).toBeLessThan(1);
    }
  });

  it("a PO is found by its supplier reference at 0.95 and by part of its number at 0.6", async () => {
    for (const q of ["SO-7781", "so 7781", "so7781"]) {
      expect(await find(q), q).toEqual([
        expect.objectContaining({ kind: "purchase_order", id: PURCHASE_ORDER.partial, rank: 0.95 }),
      ]);
    }
    expect(await find("000004", ["purchase_order"])).toEqual([
      expect.objectContaining({ id: PURCHASE_ORDER.draft, short_id: PO_NUMBER.draft, rank: 0.6 }),
    ]);
    // Every seeded number contains PO00000.
    const all = await find("PO-00000", ["purchase_order"]);
    expect(ids(all).sort()).toEqual(Object.values(PURCHASE_ORDER).sort());
    expect(new Set(all.map((h) => h.rank))).toEqual(new Set([0.6]));
  });

  it("POs are found by their supplier's name words, cancelled ones included, below the supplier", async () => {
    const hits = await find("tropic tyre");
    expect(hits[0]).toMatchObject({ kind: "supplier", id: SUPPLIER.tropicTyre });
    const pos = hits.filter((h) => h.kind === "purchase_order");
    expect(ids(pos).sort()).toEqual(
      [PURCHASE_ORDER.awaitingDelivery, PURCHASE_ORDER.cancelled].sort(),
    );
    for (const po of pos) {
      expect(po.rank).toBeGreaterThanOrEqual(0.4);
      expect(po.rank).toBeLessThan(hits[0].rank);
      expect(po.title).toBe("Tropic Tyre & Tube Co");
    }
    expect(pos.find((h) => h.id === PURCHASE_ORDER.cancelled)?.subtitle).toBe(
      "Cancelled · 0 of 20 received",
    );
    expect(pos.find((h) => h.id === PURCHASE_ORDER.awaitingDelivery)?.subtitle).toMatch(
      /^Submitted · expected \d{1,2} [A-Z][a-z]{2} \d{4} · 0 of 6 received$/,
    );
  });

  it("an archived supplier is found only with archived = true", async () => {
    expect(await find("old spoke")).toEqual([]);
    expect(await archivedSearch("old spoke")).toEqual([
      expect.objectContaining({
        kind: "supplier",
        id: SUPPLIER.oldSpoke,
        title: "Old Spoke Trading",
      }),
    ]);
    expect(ids(await archivedSearch("velo", ["supplier"]))).toEqual([]);
  });

  it("POs are never archived: archived = true returns no PO", async () => {
    for (const q of [PO_NUMBER.partial, "so 7781", "velo parts", "PO-00000"]) {
      expect(
        (await archivedSearch(q)).filter((h) => h.kind === "purchase_order"),
        q,
      ).toEqual([]);
    }
  });

  it("the kinds filter keeps suppliers and POs in or out", async () => {
    expect(new Set((await find("kenneth")).map((h) => h.kind))).toEqual(
      new Set(["supplier", "purchase_order"]),
    );
    expect(new Set((await find("kenneth", ["supplier"])).map((h) => h.kind))).toEqual(
      new Set(["supplier"]),
    );
    expect(new Set((await find("kenneth", ["purchase_order"])).map((h) => h.kind))).toEqual(
      new Set(["purchase_order"]),
    );
    expect(
      await find("kenneth", ["customer", "bike", "work_order", "product", "inventory_unit"]),
    ).toEqual([]);
  });

  it("every kind that existed before still returns its seeded hits", async () => {
    const cases: [string, string, string][] = [
      ["customer", "tan wei ming", CUSTOMER.tan],
      ["bike", BIKE_SHORT_ID.priyaDomane, BIKE.priyaDomane],
      ["work_order", JOB_NUMBER.chloeGiantInProgress, WORK_ORDER.chloeGiantInProgress],
      ["product", PRODUCT_SHORT_ID.gp5000Tyre, PRODUCT.gp5000Tyre],
      ["inventory_unit", UNIT_SHORT_ID.colnago, UNIT.colnago],
    ];
    for (const [kind, q, id] of cases) {
      expect((await find(q, [kind]))[0], kind).toMatchObject({ kind, id });
      expect((await find(q))[0], kind).toMatchObject({ kind, id });
    }
  });

  it("staff_search knows every SEARCH_KINDS entry the app asks for (merge guard)", async () => {
    // src/lib/domain/search.ts asks for every SEARCH_KINDS entry, so a kind
    // the database does not know (22023) breaks the app's search. A merge
    // that drops a staff_search branch fails here.
    for (const kind of SEARCH_KINDS) {
      await expect(find("anything", [kind]), kind).resolves.toBeInstanceOf(Array);
    }
    await expect(find("anything", [...SEARCH_KINDS])).resolves.toBeInstanceOf(Array);
  });
});
