// @vitest-environment node
/**
 * GET/POST /api/cron/appointment-notices (PLAN D163d): with CRON_SECRET set
 * a missing or wrong bearer is refused before any service-role client
 * exists; without it the route runs (it only sends what the database
 * queued). Off while the email configuration is unset (no RPC); a failed
 * claim is a bare 500. Every answer is no-store. runAppointmentNotices
 * itself is tests/unit/appointment-notices.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const env: Record<string, string | undefined> = {};
vi.mock("@/lib/env", () => ({ getServerEnv: () => env }));

const rpc = vi.fn();
const createServiceClient = vi.fn(() => ({ rpc }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient }));

const sendEmail = vi.fn();
vi.mock("@/lib/integrations/email/resend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/integrations/email/resend")>()),
  sendEmail: (...args: unknown[]) => sendEmail(...args),
}));

const { handleAppointmentNoticesRequest } =
  await import("@/lib/integrations/notifications/appointments");
const { NOTICES_PER_RUN } = await import("@/lib/appointment-notices");

const SECRET = "cron-secret-1";
const req = (authorization?: string, method = "GET") =>
  new Request("http://localhost:3000/api/cron/appointment-notices", {
    method,
    headers: authorization ? { authorization } : {},
  });

beforeEach(() => {
  for (const k of Object.keys(env)) delete env[k];
  Object.assign(env, { RESEND_API_KEY: "re_test", EMAIL_FROM: "shop@example.test" });
  rpc.mockReset();
  createServiceClient.mockClear();
  sendEmail.mockReset();
  // Nothing due: the claim returns no rows.
  rpc.mockResolvedValue({ data: [], error: null });
});

describe("handleAppointmentNoticesRequest", () => {
  it("with CRON_SECRET set, refuses a missing, malformed or wrong bearer before any client", async () => {
    env.CRON_SECRET = SECRET;
    for (const auth of [
      undefined,
      SECRET,
      `Basic ${SECRET}`,
      "Bearer cron-secret-2",
      `Bearer ${SECRET}x`,
      "Bearer ",
    ]) {
      const res = await handleAppointmentNoticesRequest(req(auth));
      expect(res.status).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("with CRON_SECRET set, runs for the right bearer (GET and POST)", async () => {
    env.CRON_SECRET = SECRET;
    for (const method of ["GET", "POST"]) {
      const res = await handleAppointmentNoticesRequest(req(`Bearer ${SECRET}`, method));
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toMatchObject({ status: "ran", claimed: 0 });
    }
    expect(createServiceClient).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenCalledWith("claim_appointment_notices", { max_count: NOTICES_PER_RUN });
  });

  it("without CRON_SECRET, runs without a header", async () => {
    const res = await handleAppointmentNoticesRequest(req());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ status: "ran", claimed: 0, sent: 0, failed: 0 });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("is off while the email configuration is unset: no client, no RPC", async () => {
    for (const unset of ["RESEND_API_KEY", "EMAIL_FROM"]) {
      Object.assign(env, { RESEND_API_KEY: "re_test", EMAIL_FROM: "shop@example.test" });
      delete env[unset];
      const res = await handleAppointmentNoticesRequest(req());
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({ status: "off" });
    }
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("a failed claim is a 500 with no detail of the error", async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { code: "42501", message: "permission denied for function claim_appointment_notices" },
    });
    const res = await handleAppointmentNoticesRequest(req());
    expect(res.status).toBe(500);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ error: "failed" });
    expect(body).not.toMatch(/42501|permission|claim_appointment_notices/);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe("the route module", () => {
  it("runs on Node with a 60 s budget and hands GET and POST to the handler", async () => {
    vi.doMock("@/lib/integrations/notifications/appointments", () => ({
      handleAppointmentNoticesRequest: async (r: Request) => new Response(`notices ${r.method}`),
    }));
    const route = await import("@/app/api/cron/appointment-notices/route");
    expect(route.runtime).toBe("nodejs");
    expect(route.maxDuration).toBe(60);
    expect(Object.keys(route).sort()).toEqual(["GET", "POST", "maxDuration", "runtime"]);
    expect(await (await route.GET(req())).text()).toBe("notices GET");
    expect(await (await route.POST(req(undefined, "POST"))).text()).toBe("notices POST");
    vi.doUnmock("@/lib/integrations/notifications/appointments");
  });
});
