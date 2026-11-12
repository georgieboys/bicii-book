import { handleAppointmentNoticesRequest } from "@/lib/integrations/notifications/appointments";

/**
 * Booking emails (vercel.json, every minute; PLAN D163): sends the alerts
 * and confirmations the database queued. proxy.ts does not run under
 * /api/cron, so a signed-out GET reaches the handler instead of /login.
 */
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  return handleAppointmentNoticesRequest(request);
}

export async function POST(request: Request): Promise<Response> {
  return handleAppointmentNoticesRequest(request);
}
