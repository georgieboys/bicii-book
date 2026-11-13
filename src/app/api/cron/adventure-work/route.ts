import { handleAdventureWork } from "@/lib/integrations/adventures/work-cron";

/** Reads uploaded adventure ride files (D176). Needs CRON_SECRET (fails closed). */
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  return handleAdventureWork(request);
}
