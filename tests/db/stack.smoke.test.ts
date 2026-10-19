/**
 * Live devstack smoke test (not a database-only test): signs in through the
 * gateway with supabase-js exactly as the app will (an email code, PLAN
 * D10/D70: signInWithOtp, the code read from the devstack's mail catcher,
 * verifyOtp), checks the code rules Auth enforces, calls an RPC through
 * PostgREST, and round-trips an object through Storage.
 *
 * Needs `npm run db:reset && npm run devstack:start`. Skips, saying so, when
 * the gateway is not reachable, unless BICII_REQUIRE_STACK=1 (CI), where an
 * unreachable gateway fails the file instead. Creates only throwaway data:
 * unique .test addresses (deleted afterwards) and sessions.
 */
import { randomUUID } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { ANON_KEY, SERVICE_ROLE_KEY, devDatabaseUrl } from "../../scripts/devstack/config.mjs";
import { mailCursor, waitForMessage } from "../../scripts/devstack/mail-client.mjs";
import { classifyCodeRequestError } from "@/lib/auth/sign-in-errors";
import type { Database } from "@/lib/database.types";

import { BIKE, STAFF, STAFF_EMAIL } from "../fixtures/ids";
import { STACK_URL, anonClient, serviceClient, stackReachable, staffClient } from "./stack";

/** A real 2x2 JPEG (269 bytes), so Storage sees a genuine photo. */
const TINY_JPEG = Buffer.from(
  "/9j/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABAb/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCOACqH/9k=",
  "base64",
);

const url = STACK_URL;
const reachable = await stackReachable("stack smoke");

const options = { auth: { persistSession: false, autoRefreshToken: false } };

/** A unique throwaway address for this run. */
function throwawayEmail(label: string) {
  return `stack-${label}-${Date.now()}-${randomUUID().slice(0, 8)}@bicii.test`;
}

/**
 * Asks Auth to email a code and returns it, with the message. Auth refuses a
 * second email to one address within max_frequency (1 s on the devstack)
 * with 429 over_email_send_rate_limit: wait that out and ask again.
 */
async function emailCode(client: SupabaseClient<Database>, email: string) {
  const after = await mailCursor(email);
  for (let attempt = 0; ; attempt++) {
    const { error } = await client.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false },
    });
    if (!error) break;
    if (error.code !== "over_email_send_rate_limit" || attempt >= 5) throw error;
    await new Promise((resolve) => setTimeout(resolve, 1100));
  }
  const message = await waitForMessage({ to: email, after });
  expect(message.code).toMatch(/^\d{6}$/);
  return { code: message.code as string, message };
}

const throwawayUsers: string[] = [];

/** A confirmed throwaway login (no staff row), deleted after the file. */
async function throwawayLogin(label: string) {
  const email = throwawayEmail(label);
  const { data, error } = await serviceClient().auth.admin.createUser({
    email,
    email_confirm: true,
  });
  if (error) throw error;
  throwawayUsers.push(data.user.id);
  return email;
}

afterAll(async () => {
  if (!reachable) return;
  for (const id of throwawayUsers) await serviceClient().auth.admin.deleteUser(id);
});

describe.skipIf(!reachable)("devstack through the gateway", () => {
  it("the seeded admin signs in with an emailed code and reads my_staff_profile via RPC", async () => {
    const supabase = createClient<Database>(url, ANON_KEY, options);
    const { code, message } = await emailCode(supabase, STAFF_EMAIL.admin);
    // Our template, served to Auth by the mail catcher (supabase/templates).
    expect(message.subject).toBe("Your BICII sign-in code");
    expect(message.envelopeTo).toEqual([STAFF_EMAIL.admin]);
    expect(message.html).toContain("It expires in 10 minutes.");

    const { data: session, error: verifyError } = await supabase.auth.verifyOtp({
      email: STAFF_EMAIL.admin,
      token: code,
      type: "email",
    });
    expect(verifyError).toBeNull();
    expect(session.user?.email).toBe(STAFF_EMAIL.admin);

    const { data, error } = await supabase.rpc("my_staff_profile").single();
    expect(error).toBeNull();
    expect(data).toMatchObject({ id: STAFF.admin, role: "admin", active: true });
    expect(data?.permissions).toHaveLength(7);
    await supabase.auth.signOut();
  });

  it("asking for a code for an unknown email creates no login and sends no email", async () => {
    const email = throwawayEmail("unknown");
    const after = await mailCursor(email);
    const { error } = await anonClient().auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false },
    });
    // Auth's own answer to the API caller. The Admin shows the same "Check
    // your email" screen as for a staff email and never this error (D70).
    expect(error?.status).toBe(422);
    expect(error?.code).toBe("otp_disabled");

    const db = new pg.Client({ connectionString: devDatabaseUrl() });
    await db.connect();
    try {
      const { rows } = await db.query(
        "select count(*)::int as n from auth.users where email = $1",
        [email],
      );
      expect(rows[0].n).toBe(0);
    } finally {
      await db.end();
    }
    await expect(waitForMessage({ to: email, after, timeoutMs: 1500 })).rejects.toThrow(
      /No email to/,
    );
  });

  it("asking twice in a row: Auth's answers differ by account, the Admin's classification does not (D70)", async () => {
    // The per-address interval (max_frequency: 1 s here, 60 s hosted)
    // applies only to an address with a login. Hold it open the way 60 s
    // would (Auth times it from auth.users.recovery_sent_at).
    const withLogin = await throwawayLogin("twice");
    const unknown = throwawayEmail("twice-unknown");
    const ask = async (email: string) =>
      (await anonClient().auth.signInWithOtp({ email, options: { shouldCreateUser: false } }))
        .error;
    await emailCode(anonClient(), withLogin);
    const db = new pg.Client({ connectionString: devDatabaseUrl() });
    await db.connect();
    try {
      await db.query(
        "update auth.users set recovery_sent_at = now() + interval '5 minutes' where email = $1",
        [withLogin],
      );
    } finally {
      await db.end();
    }
    const refused = await ask(withLogin);
    expect(refused?.status).toBe(429);
    expect(refused?.code).toBe("over_email_send_rate_limit");
    const unknownAnswers = [await ask(unknown), await ask(unknown)];
    for (const error of unknownAnswers) expect(error?.code).toBe("otp_disabled");

    // What the Admin makes of them: "sent" every time, so one screen.
    expect(classifyCodeRequestError(refused)).toBe("sent");
    expect(unknownAnswers.map(classifyCodeRequestError)).toEqual(["sent", "sent"]);
  });

  it("setting a password needs reauthentication once a session is a day old (secure password change)", async () => {
    // Staff have no password path (D10), but Auth's PUT /user is reachable
    // with any session: without reauthentication, a stolen session could
    // set a password and later sign in without the mailbox.
    const email = await throwawayLogin("password");
    const { code } = await emailCode(anonClient(), email);
    const client = anonClient();
    const { data, error } = await client.auth.verifyOtp({ email, token: code, type: "email" });
    expect(error).toBeNull();
    const sessionId = JSON.parse(
      Buffer.from(data.session!.access_token.split(".")[1], "base64url").toString(),
    ).session_id as string;
    const db = new pg.Client({ connectionString: devDatabaseUrl() });
    await db.connect();
    try {
      const aged = await db.query(
        "update auth.sessions set created_at = now() - interval '25 hours' where id = $1",
        [sessionId],
      );
      expect(aged.rowCount).toBe(1);
    } finally {
      await db.end();
    }
    const { error: updateError } = await client.auth.updateUser({
      password: `Stack-${randomUUID()}`,
    });
    expect(updateError?.code).toBe("reauthentication_needed");
    await client.auth.signOut();
  });

  it("a code works once", async () => {
    const email = await throwawayLogin("once");
    const { code } = await emailCode(anonClient(), email);
    const first = anonClient();
    const { error: firstError } = await first.auth.verifyOtp({ email, token: code, type: "email" });
    expect(firstError).toBeNull();
    await first.auth.signOut();

    const { data, error } = await anonClient().auth.verifyOtp({
      email,
      token: code,
      type: "email",
    });
    expect(data.session).toBeNull();
    expect(error?.status).toBe(403);
    expect(error?.code).toBe("otp_expired");
  });

  it("a newer code voids an older one", async () => {
    const email = await throwawayLogin("newer");
    const { code: older } = await emailCode(anonClient(), email);
    const { code: newer } = await emailCode(anonClient(), email);
    expect(newer).not.toBe(older);

    const { data, error } = await anonClient().auth.verifyOtp({
      email,
      token: older,
      type: "email",
    });
    expect(data.session).toBeNull();
    expect(error?.code).toBe("otp_expired");

    const client = anonClient();
    const { error: newerError } = await client.auth.verifyOtp({
      email,
      token: newer,
      type: "email",
    });
    expect(newerError).toBeNull();
    await client.auth.signOut();
  });

  it("denies anonymous reads of staff", async () => {
    const anon = createClient<Database>(url, ANON_KEY, options);
    const { data, error } = await anon.from("staff").select("id");
    expect(data).toBeNull();
    expect(error?.code).toBe("42501");
  });

  it("staff upload a photo to media-internal through a signed URL and record it; anonymous visitors cannot fetch it", async () => {
    const staff = await staffClient("mechanic2");

    // The app's flow (ADR-001 A7): the server mints a signed upload URL for
    // the exact path, the phone uploads to it, the server records the row.
    const id = randomUUID();
    const path = `bike/${BIKE.shopCervelo}/${id}.jpg`;
    const bucket = staff.storage.from("media-internal");
    const { data: signed, error: signError } = await bucket.createSignedUploadUrl(path);
    expect(signError).toBeNull();
    const { error: uploadError } = await bucket.uploadToSignedUrl(
      path,
      signed!.token,
      new Blob([TINY_JPEG], { type: "image/jpeg" }),
    );
    expect(uploadError).toBeNull();

    const { data: row, error: recordError } = await staff.rpc("record_attachment", {
      attachment_id: id,
      entity_type: "bike",
      entity_id: BIKE.shopCervelo,
      storage_bucket: "media-internal",
      storage_path: path,
      media_type: "image/jpeg",
    });
    expect(recordError).toBeNull();
    expect(row).toMatchObject({ id, byte_size: TINY_JPEG.length, created_by: STAFF.mechanic2 });

    const anon = createClient<Database>(url, ANON_KEY, options);
    const { data: anonFile, error: anonError } = await anon.storage
      .from("media-internal")
      .download(path);
    expect(anonFile).toBeNull();
    expect(anonError).not.toBeNull();
    const { data: staffFile, error: staffError } = await bucket.download(path);
    expect(staffError).toBeNull();
    expect(staffFile?.size).toBe(TINY_JPEG.length);

    // Recorded, so not even its uploader can remove it with a bare Storage call.
    const { data: refused } = await bucket.remove([path]);
    expect(refused).toEqual([]);
    const { data: stillThere } = await bucket.download(path);
    expect(stillThere?.size).toBe(TINY_JPEG.length);

    // Clean up the way the app deletes: RPC with a reason, then the object.
    const { data: deleted, error: deleteError } = await staff.rpc("delete_attachment", {
      attachment_id: id,
      reason: "Stack smoke test cleanup",
    });
    expect(deleteError).toBeNull();
    expect(deleted).toMatchObject([{ id, storage_path: path }]);
    // A replay through PostgREST is an empty list, not a row of nulls.
    const { data: replay, error: replayError } = await staff.rpc("delete_attachment", {
      attachment_id: id,
      reason: "Stack smoke test cleanup",
    });
    expect(replayError).toBeNull();
    expect(replay).toEqual([]);
    const { data: removed, error: removeError } = await bucket.remove([path]);
    expect(removeError).toBeNull();
    expect(removed).toHaveLength(1);
    await staff.auth.signOut();
  });

  it("staff can upload to the photo buckets only at an attachment's own path (audit 2026-10-18)", async () => {
    const staff = await staffClient("mechanic2");
    const id = randomUUID();
    const refusedPaths = [
      `notes/${id}.jpg`,
      `bike/${BIKE.shopCervelo}/${id}.html`,
      `bike/${BIKE.shopCervelo}/${id}/x.jpg`,
      `bike/${BIKE.shopCervelo}/${id.toUpperCase()}.jpg`,
      `invoice/${BIKE.shopCervelo}/${id}.jpg`,
    ];
    for (const bucketName of ["media-internal", "media-public"]) {
      const bucket = staff.storage.from(bucketName);
      for (const path of refusedPaths) {
        const { data, error } = await bucket.upload(
          path,
          new Blob([TINY_JPEG], { type: "image/jpeg" }),
        );
        expect(data, `${bucketName}/${path}`).toBeNull();
        expect(error, `${bucketName}/${path}`).not.toBeNull();
      }
    }
    await staff.auth.signOut();
  });

  it("uploads and downloads an object through Storage with the service key", async () => {
    const service = createClient<Database>(url, SERVICE_ROLE_KEY, options);
    const bucket = "devstack-smoke";
    const { error: bucketError } = await service.storage.createBucket(bucket, { public: false });
    if (bucketError && !/already exists/i.test(bucketError.message)) throw bucketError;

    const path = `smoke/${Date.now()}.txt`;
    const body = `bicii devstack ${new Date().toISOString()}`;
    const { error: uploadError } = await service.storage
      .from(bucket)
      .upload(path, new Blob([body], { type: "text/plain" }));
    expect(uploadError).toBeNull();

    const { data: file, error: downloadError } = await service.storage.from(bucket).download(path);
    expect(downloadError).toBeNull();
    expect(await file?.text()).toBe(body);

    const { error: removeError } = await service.storage.from(bucket).remove([path]);
    expect(removeError).toBeNull();
  });
});
