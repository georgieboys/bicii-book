/**
 * Frame grades (PLAN D260): twelve grades, C to S++, each with a suggested
 * price; a product may carry one, which its public page shows; anyone reads
 * the grades for the site; only admins change a suggested price.
 */
import type pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { actAs, connect, inTransaction, isolatedDatabase, type Claims } from "./harness";
import {
  ADMIN,
  MECHANIC1,
  addPublicPhoto,
  makeProduct,
  publish,
  readAsOwner,
} from "./inventory-fixtures";
import { failsWith, ownerMode } from "./workshop-fixtures";

const ANON: Claims = { role: "anon" };

let conn: pg.Client;

beforeAll(async () => {
  conn = await connect();
});

const inTx = <T>(fn: (tx: pg.Client) => Promise<T>) =>
  inTransaction(conn, async (tx) => {
    await actAs(tx, ADMIN);
    return fn(tx);
  });

describe.skipIf(!isolatedDatabase())("frame grades (D260)", () => {
  it("anyone reads the twelve grades in order with their suggested prices", () =>
    inTx(async (tx) => {
      await actAs(tx, ANON);
      const { rows } = await tx.query<{ grade: string; price: string }>(
        "select grade, suggested_price::text as price from public.public_frame_grades()",
      );
      expect(rows.map((r) => `${r.grade} ${r.price}`)).toEqual([
        "C 200.00",
        "C+ 250.00",
        "C++ 300.00",
        "B 400.00",
        "B+ 500.00",
        "B++ 600.00",
        "A 800.00",
        "A+ 1000.00",
        "A++ 1200.00",
        "S 1500.00",
        "S+ 2000.00",
        "S++ 2500.00",
      ]);
    }));

  it("a product takes a known grade only, and its public page shows it", () =>
    inTx(async (tx) => {
      await ownerMode(tx);
      const id = await makeProduct(tx, { tracking: "quantity", price: "600.00" });
      await addPublicPhoto(tx, "product", id);
      await publish(tx, id);
      await actAs(tx, ADMIN);
      await tx.query("update public.products set frame_grade = 'B++' where id = $1", [id]);
      await failsWith(
        tx,
        () => tx.query("update public.products set frame_grade = 'D' where id = $1", [id]),
        { code: "23503" },
      );
      const shown = await readAsOwner(tx, () =>
        tx.query<{ frame_grade: string | null }>(
          `select v.frame_grade from reporting.public_items v
             join public.products p on p.short_id = v.short_id where p.id = $1`,
          [id],
        ),
      );
      expect(shown.rows).toEqual([{ frame_grade: "B++" }]);
    }));

  it("only admins change a suggested price", () =>
    inTx(async (tx) => {
      await actAs(tx, MECHANIC1);
      const none = await tx.query(
        "update public.frame_grades set suggested_price = 999 where grade = 'C' returning grade",
      );
      expect(none.rowCount).toBe(0);
      await actAs(tx, ADMIN);
      const done = await tx.query<{ price: string }>(
        "update public.frame_grades set suggested_price = 220 where grade = 'C' returning suggested_price::text as price",
      );
      expect(done.rows).toEqual([{ price: "220.00" }]);
    }));
});
