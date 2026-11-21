/**
 * Photo buckets and their storage.objects policies (SPEC §8 "Storage
 * policies must enforce visibility"; DATA-MODEL §2):
 *
 *   media-internal  private: active staff read and add; anonymous
 *                   visitors and inactive staff can do nothing; a
 *                   signed-in customer reads only the objects of their own
 *                   customer-visible bike and job photos (Phase 11, D124,
 *                   tested in public-site.test.ts), never an object no
 *                   attachment of theirs points at (below).
 *   media-public    public bucket: files are served at public URLs (which
 *                   skip RLS; stack.smoke.test.ts fetches one), but only
 *                   active staff may read or list it through the API, and
 *                   only they add to it, and only the copy of a recorded
 *                   internal photo of a record that can be public (audit
 *                   2026-11-13 A-24).
 *   both            nobody overwrites an object (no UPDATE policy), and
 *                   staff delete only objects no attachment row points at,
 *                   so a recorded photo leaves only through the RPCs.
 *
 * Storage runs each request as the caller's API role with RLS on
 * storage.objects, which is exactly what these tests do. (The live
 * round trip through the Storage server is in stack.smoke.test.ts.)
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { AUTH_USER, BIKE, CONSIGNMENT_ITEM, CUSTOMER, PRODUCT, STAFF } from "../fixtures/ids";
import {
  attachmentPath,
  customerClaims,
  linkCustomerLogin,
  putStorageObject,
} from "./customer-fixtures";
import { actAs, connect, inTransaction, scalar, staffClaims } from "./harness";

let conn: pg.Client;

beforeAll(async () => {
  conn = await connect();
});

const objectName = () => attachmentPath("bike", BIKE.tanTarmac, randomUUID());

/** Owner setup (an object already in `bucket`), then run `fn` as `who`. */
async function withObject<T>(
  bucket: string,
  who: "anon" | "customer" | "staff" | "inactive staff",
  fn: (tx: pg.Client, name: string) => Promise<T>,
): Promise<T> {
  return inTransaction(conn, async (tx) => {
    const name = objectName();
    await putStorageObject(tx, bucket, name);
    if (who === "anon") {
      await actAs(tx, { role: "anon" });
    } else if (who === "customer") {
      await actAs(tx, customerClaims(await linkCustomerLogin(tx, CUSTOMER.tan)));
    } else {
      if (who === "inactive staff") {
        await tx.query("update public.staff set active = false where id = $1", [STAFF.mechanic2]);
      }
      await actAs(tx, staffClaims(AUTH_USER.mechanic2));
    }
    return fn(tx, name);
  });
}

const visible = (tx: pg.Client, bucket: string, name: string) =>
  scalar<number>(
    tx,
    "select count(*)::int from storage.objects where bucket_id = $1 and name = $2",
    [bucket, name],
  );

const insertAs = (tx: pg.Client, bucket: string) =>
  tx.query("insert into storage.objects (bucket_id, name, metadata) values ($1, $2, '{}')", [
    bucket,
    objectName(),
  ]);

/** Storage's own guard blocks SQL deletes unless this is set (the Storage API sets it). */
const allowDelete = (tx: pg.Client) =>
  tx.query("select set_config('storage.allow_delete_query', 'true', true)");

describe("buckets", () => {
  it("media-internal is private and media-public public, both photo-only up to 20 MiB", async () => {
    const { rows } = await conn.query(
      `select id, public, file_size_limit::int as limit, allowed_mime_types
         from storage.buckets where id in ('media-internal', 'media-public') order by id`,
    );
    const photos = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];
    expect(rows).toEqual([
      { id: "media-internal", public: false, limit: 20971520, allowed_mime_types: photos },
      { id: "media-public", public: true, limit: 20971520, allowed_mime_types: photos },
    ]);
  });
});

describe("media-internal", () => {
  it("anonymous visitors cannot read or write it", async () => {
    await withObject("media-internal", "anon", async (tx, name) => {
      expect(await visible(tx, "media-internal", name)).toBe(0);
      await expect(insertAs(tx, "media-internal")).rejects.toMatchObject({ code: "42501" });
    });
  });

  it("a signed-in customer cannot read or write it, not even their own bike's photos", async () => {
    await withObject("media-internal", "customer", async (tx, name) => {
      expect(await visible(tx, "media-internal", name)).toBe(0);
      expect(
        await scalar(
          tx,
          "select count(*)::int from storage.objects where bucket_id = 'media-internal'",
        ),
      ).toBe(0);
      await expect(insertAs(tx, "media-internal")).rejects.toMatchObject({ code: "42501" });
    });
    await withObject("media-internal", "customer", async (tx, name) => {
      const upd = await tx.query(
        "update storage.objects set metadata = '{}' where bucket_id = 'media-internal' and name = $1",
        [name],
      );
      expect(upd.rowCount).toBe(0);
      await allowDelete(tx);
      const del = await tx.query(
        "delete from storage.objects where bucket_id = 'media-internal' and name = $1",
        [name],
      );
      expect(del.rowCount).toBe(0);
    });
  });

  it("active staff upload, read, and delete an object no attachment points at", async () => {
    await withObject("media-internal", "staff", async (tx, name) => {
      expect(await visible(tx, "media-internal", name)).toBe(1);
      await insertAs(tx, "media-internal");
      await allowDelete(tx);
      const del = await tx.query(
        "delete from storage.objects where bucket_id = 'media-internal' and name = $1",
        [name],
      );
      expect(del.rowCount).toBe(1);
    });
  });

  it("inactive staff cannot read or write it", async () => {
    await withObject("media-internal", "inactive staff", async (tx, name) => {
      expect(await visible(tx, "media-internal", name)).toBe(0);
      await expect(insertAs(tx, "media-internal")).rejects.toMatchObject({ code: "42501" });
    });
  });
});

describe("media-public", () => {
  it("only active staff read or list it through the API: not anonymous visitors, not customers", async () => {
    await withObject("media-public", "anon", async (tx, name) => {
      expect(await visible(tx, "media-public", name)).toBe(0);
    });
    await withObject("media-public", "customer", async (tx, name) => {
      expect(await visible(tx, "media-public", name)).toBe(0);
    });
    await withObject("media-public", "inactive staff", async (tx, name) => {
      expect(await visible(tx, "media-public", name)).toBe(0);
    });
    await withObject("media-public", "staff", async (tx, name) => {
      expect(await visible(tx, "media-public", name)).toBe(1);
    });
  });

  it("only active staff write it", async () => {
    await withObject("media-public", "anon", async (tx) => {
      await expect(insertAs(tx, "media-public")).rejects.toMatchObject({ code: "42501" });
    });
    await withObject("media-public", "customer", async (tx, name) => {
      await tx.query("savepoint s");
      await expect(insertAs(tx, "media-public")).rejects.toMatchObject({ code: "42501" });
      await tx.query("rollback to savepoint s");
      const upd = await tx.query(
        "update storage.objects set metadata = '{}' where bucket_id = 'media-public' and name = $1",
        [name],
      );
      expect(upd.rowCount).toBe(0);
      await allowDelete(tx);
      const del = await tx.query(
        "delete from storage.objects where bucket_id = 'media-public' and name = $1",
        [name],
      );
      expect(del.rowCount).toBe(0);
    });
    await withObject("media-public", "staff", async (tx, name) => {
      // An object no attachment row points at in media-internal is refused
      // (A-24; the copy of a recorded photo is tested below).
      await tx.query("savepoint s");
      await expect(insertAs(tx, "media-public")).rejects.toMatchObject({ code: "42501" });
      await tx.query("rollback to savepoint s");
      await allowDelete(tx);
      const del = await tx.query(
        "delete from storage.objects where bucket_id = 'media-public' and name = $1",
        [name],
      );
      expect(del.rowCount).toBe(1);
    });
  });

  it("anonymous visitors list nothing in either bucket", async () => {
    await inTransaction(conn, async (tx) => {
      await putStorageObject(tx, "media-internal", objectName());
      await putStorageObject(tx, "media-public", objectName());
      await actAs(tx, { role: "anon" });
      const { rows } = await tx.query("select distinct bucket_id from storage.objects");
      expect(rows).toEqual([]);
    });
  });
});

describe("recorded photos", () => {
  /** An object in `bucket` with an attachments row pointing at it (as the owner). */
  async function recorded(tx: pg.Client, bucket: "media-internal" | "media-public") {
    const id = randomUUID();
    const name = attachmentPath("bike", BIKE.tanTarmac, id);
    await putStorageObject(tx, bucket, name);
    await tx.query(
      `insert into public.attachments
         (id, entity_type, entity_id, storage_bucket, storage_path, media_type, visibility, width, height)
       values ($1, 'bike', $2, $3, $4, 'image/jpeg', $5, 640, 480)`,
      [id, BIKE.tanTarmac, bucket, name, bucket === "media-public" ? "public" : "internal"],
    );
    return { id, name };
  }

  it("staff cannot delete or overwrite an object an attachment points at, in either bucket", async () => {
    for (const bucket of ["media-internal", "media-public"] as const) {
      await inTransaction(conn, async (tx) => {
        const { name } = await recorded(tx, bucket);
        await actAs(tx, staffClaims(AUTH_USER.mechanic2));
        expect(await visible(tx, bucket, name)).toBe(1);
        const upd = await tx.query(
          `update storage.objects set metadata = '{"mimetype": "image/png"}'
            where bucket_id = $1 and name = $2`,
          [bucket, name],
        );
        expect(upd.rowCount).toBe(0);
        await allowDelete(tx);
        const del = await tx.query(
          "delete from storage.objects where bucket_id = $1 and name = $2",
          [bucket, name],
        );
        expect(del.rowCount).toBe(0);
        await tx.query("reset role");
        expect(await visible(tx, bucket, name)).toBe(1);
      });
    }
  });

  it("once the row is gone (deleted with a reason) staff may remove its object", async () => {
    await inTransaction(conn, async (tx) => {
      const { id, name } = await recorded(tx, "media-internal");
      await actAs(tx, staffClaims(AUTH_USER.mechanic2));
      await tx.query("select * from public.delete_attachment($1, 'Blurred')", [id]);
      await allowDelete(tx);
      const del = await tx.query(
        "delete from storage.objects where bucket_id = 'media-internal' and name = $1",
        [name],
      );
      expect(del.rowCount).toBe(1);
    });
  });

  it("the copy left in the other bucket after a move is removable, the current object is not", async () => {
    await inTransaction(conn, async (tx) => {
      const { name } = await recorded(tx, "media-public");
      // The private original a move to public left behind.
      await putStorageObject(tx, "media-internal", name);
      await actAs(tx, staffClaims(AUTH_USER.mechanic2));
      await allowDelete(tx);
      const del = await tx.query(
        "delete from storage.objects where name = $1 and bucket_id in ('media-internal', 'media-public')",
        [name],
      );
      expect(del.rowCount).toBe(1);
      await tx.query("reset role");
      const { rows } = await tx.query("select bucket_id from storage.objects where name = $1", [
        name,
      ]);
      expect(rows).toEqual([{ bucket_id: "media-public" }]);
    });
  });
});

describe("copies into media-public (audit 2026-11-13 A-24)", () => {
  /** A recorded internal photo of `entityType` `entityId` (as the owner). */
  async function internalPhoto(tx: pg.Client, entityType: string, entityId: string) {
    const id = randomUUID();
    const path = attachmentPath(entityType, entityId, id);
    await putStorageObject(tx, "media-internal", path);
    await tx.query(
      `insert into public.attachments
         (id, entity_type, entity_id, storage_bucket, storage_path, media_type, visibility, width, height)
       values ($1, $2, $3, 'media-internal', $4, 'image/jpeg', 'internal', 640, 480)`,
      [id, entityType, entityId, path],
    );
    return { id, path };
  }

  const insertAt = (tx: pg.Client, name: string) =>
    tx.query(
      "insert into storage.objects (bucket_id, name, metadata) values ('media-public', $1, '{}')",
      [name],
    );

  it("a mechanic cannot write a customer or consignment path, even of a recorded internal photo", async () => {
    for (const [entityType, entityId] of [
      ["customer", CUSTOMER.tan],
      ["consignment_item", CONSIGNMENT_ITEM.colnago],
    ] as const) {
      await inTransaction(conn, async (tx) => {
        await actAs(tx, staffClaims(AUTH_USER.mechanic2));
        await tx.query("savepoint s");
        await expect(
          insertAt(tx, attachmentPath(entityType, randomUUID(), randomUUID())),
        ).rejects.toMatchObject({ code: "42501" });
        await tx.query("rollback to savepoint s");
        await tx.query("reset role");
        const { path } = await internalPhoto(tx, entityType, entityId);
        await actAs(tx, staffClaims(AUTH_USER.mechanic2));
        await expect(insertAt(tx, path)).rejects.toMatchObject({ code: "42501" });
      });
    }
  });

  it("a mechanic cannot write a path no recorded internal photo has", async () => {
    await inTransaction(conn, async (tx) => {
      await actAs(tx, staffClaims(AUTH_USER.mechanic2));
      await tx.query("savepoint s");
      // A product that does not exist.
      await expect(
        insertAt(tx, attachmentPath("product", randomUUID(), randomUUID())),
      ).rejects.toMatchObject({ code: "42501" });
      await tx.query("rollback to savepoint s");
      // A real product, but no attachment at that path.
      await expect(
        insertAt(tx, attachmentPath("product", PRODUCT.gp5000Tyre, randomUUID())),
      ).rejects.toMatchObject({ code: "42501" });
    });
  });

  it("the visibility move of a recorded product photo still works: copy, then the RPC", async () => {
    await inTransaction(conn, async (tx) => {
      const { id, path } = await internalPhoto(tx, "product", PRODUCT.gp5000Tyre);
      await actAs(tx, staffClaims(AUTH_USER.mechanic2));
      await insertAt(tx, path);
      const { rows } = await tx.query(
        "select visibility, storage_bucket, storage_path from public.set_attachment_visibility($1, 'public', 'media-public', $2)",
        [id, path],
      );
      expect(rows).toEqual([
        { visibility: "public", storage_bucket: "media-public", storage_path: path },
      ]);
      // The row now names the public copy, so the internal original is removable.
      await allowDelete(tx);
      const del = await tx.query(
        "delete from storage.objects where bucket_id = 'media-internal' and name = $1",
        [path],
      );
      expect(del.rowCount).toBe(1);
    });
  });
});

describe("other buckets", () => {
  it("these policies grant nothing outside media-internal and media-public", async () => {
    await inTransaction(conn, async (tx) => {
      await tx.query(
        "insert into storage.buckets (id, name, public) values ('elsewhere', 'elsewhere', false)",
      );
      await putStorageObject(tx, "elsewhere", "x/y.jpg");
      await actAs(tx, staffClaims(AUTH_USER.admin));
      expect(await visible(tx, "elsewhere", "x/y.jpg")).toBe(0);
      await expect(insertAs(tx, "elsewhere")).rejects.toMatchObject({ code: "42501" });
    });
  });
});
