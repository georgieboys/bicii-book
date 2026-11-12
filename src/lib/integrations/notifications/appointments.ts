import "server-only";

import {
  noticeFromRow,
  runAppointmentNotices,
  type AppointmentNoticeRow,
  type NoticeRunSummary,
} from "@/lib/appointment-notices";
import { getServerEnv } from "@/lib/env";
import { emailConfig, sendEmail } from "@/lib/integrations/email/resend";
import { bearerMatches } from "@/lib/integrations/shopify/cron";
import { child } from "@/lib/logger";
import { newRequestId } from "@/lib/request-id";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * The booking email sender (PLAN D163d): a Vercel cron every minute
 * (vercel.json) claims the booking emails the database queued and sends
 * them through Resend. Off while RESEND_API_KEY or EMAIL_FROM is unset: the
 * rows wait. The route needs no secret while CRON_SECRET is unset, because
 * it only sends what the database has already queued, each once; with
 * CRON_SECRET set it asks for it, as the integration cron does.
 */
export async function sendDueAppointmentNotices(
  correlationId = newRequestId(),
): Promise<({ status: "ran" } & NoticeRunSummary) | { status: "off" }> {
  const env = getServerEnv();
  const config = emailConfig(env);
  if (!config) return { status: "off" };
  const supabase = createServiceClient({ correlationId });
  const summary = await runAppointmentNotices({
    claim: async (max) => {
      const { data, error } = await supabase.rpc("claim_appointment_notices", { max_count: max });
      if (error) throw new Error(`claim_appointment_notices failed: ${error.code}`);
      return ((data ?? []) as AppointmentNoticeRow[]).map(noticeFromRow);
    },
    finish: async (id, ok, message) => {
      const { error } = await supabase.rpc("finish_appointment_notice", {
        notice_id: id,
        ok,
        error: message ?? undefined,
      });
      if (error) throw new Error(`finish_appointment_notice failed: ${error.code}`);
    },
    send: async (message) => {
      const result = await sendEmail(config, message);
      return result.ok ? { ok: true } : result;
    },
    adminOrigin: env.ADMIN_ORIGIN ?? null,
  });
  return { status: "ran", ...summary };
}

function respond(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/** GET (the Vercel cron) or POST: send what is due. */
export async function handleAppointmentNoticesRequest(request: Request): Promise<Response> {
  const correlationId = newRequestId();
  const log = child(correlationId, { route: "cron", job: "appointment-notices" });
  const secret = getServerEnv().CRON_SECRET;
  if (secret && !bearerMatches(request.headers.get("authorization"), secret)) {
    log.warn({ status: 401 }, "booking email cron refused a bad bearer");
    return respond(401, { error: "unauthorized" });
  }
  try {
    const result = await sendDueAppointmentNotices(correlationId);
    if (result.status === "ran" && result.claimed > 0) {
      log.info(
        { claimed: result.claimed, sent: result.sent, failed: result.failed },
        "booking emails sent",
      );
    }
    return respond(200, result);
  } catch (err) {
    log.error({ err }, "booking email cron failed");
    return respond(500, { error: "failed" });
  }
}
