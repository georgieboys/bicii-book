/**
 * Helpers for Phase 1 database tests: customer logins and Storage objects.
 * All of them run as the connection's owner (superuser) inside the caller's
 * transaction; switch identity afterwards with actAs().
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";

/** A new Supabase Auth login (auth.users row); returns its id. */
export async function createAuthUser(tx: pg.Client, email: string): Promise<string> {
  const id = randomUUID();
  await tx.query(
    `insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
     values ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2, now(), now())`,
    [id, email],
  );
  return id;
}

/** Gives an existing customers row a login (what Phase 11 sign-up will do); returns the Auth id. */
export async function linkCustomerLogin(
  tx: pg.Client,
  customerId: string,
  email = `customer-${customerId.slice(-4)}-${randomUUID().slice(0, 8)}@example.com`,
): Promise<string> {
  const authUserId = await createAuthUser(tx, email);
  const { rowCount } = await tx.query(
    "update public.customers set auth_user_id = $1 where id = $2",
    [authUserId, customerId],
  );
  if (rowCount !== 1) throw new Error(`No customers row ${customerId}`);
  return authUserId;
}

/** Claims of a signed-in customer (or any Auth user) for actAs(). */
export function customerClaims(authUserId: string) {
  return { role: "authenticated" as const, aud: "authenticated", sub: authUserId };
}

/** `{entity_type}/{entity_id}/{attachment_id}.{ext}` (DATA-MODEL §2). */
export function attachmentPath(
  entityType: string,
  entityId: string,
  attachmentId: string,
  ext = "jpg",
): string {
  return `${entityType}/${entityId}/${attachmentId}.${ext}`;
}

/**
 * The storage.objects row an upload through the Storage API leaves behind
 * (metadata as Storage writes it: mimetype and size).
 */
export async function putStorageObject(
  tx: pg.Client,
  bucket: string,
  name: string,
  { mimetype = "image/jpeg", size = 48_213 }: { mimetype?: string; size?: number } = {},
): Promise<void> {
  await tx.query(
    `insert into storage.objects (bucket_id, name, metadata)
     values ($1, $2, jsonb_build_object('mimetype', $3::text, 'size', $4::int))`,
    [bucket, name, mimetype, size],
  );
}

/**
 * Archives a customer as the owner with triggers skipped, for tests of what
 * an archived customer who still has open work sees or may do. Every other
 * writer goes through customers_guard_archive, which refuses that
 * (customer_has_open_work, A-22); seeded customers have open jobs.
 */
export async function archiveCustomerUnguarded(tx: pg.Client, customerId: string): Promise<void> {
  await tx.query("set local session_replication_role = replica");
  const { rowCount } = await tx.query(
    "update public.customers set archived_at = now() where id = $1",
    [customerId],
  );
  await tx.query("set local session_replication_role = origin");
  if (rowCount !== 1) throw new Error(`No customers row ${customerId}`);
}
