import "server-only";

import {
  adventureNoticeFromRow,
  runAdventureNotices,
  type AdventureNoticeRow,
  type AdventureNoticeSummary,
} from "@/lib/adventure-notices";
import { emailConfig, sendEmail } from "@/lib/integrations/email/resend";
import type { ServiceSupabase } from "@/lib/integrations/shopify/deps";

/**
 * The adventure email sender (D184): claims due rows and sends them through
 * Resend, inside the adventure-work cron. Off while RESEND_API_KEY or
 * EMAIL_FROM is unset: the rows wait and no claim is made.
 */
export async function sendDueAdventureNotices(
  supabase: ServiceSupabase,
  env: { RESEND_API_KEY?: string; EMAIL_FROM?: string; ADMIN_ORIGIN?: string },
  options: { max: number; deadlineMs: number; now?: () => number },
): Promise<({ status: "ran" } & AdventureNoticeSummary) | { status: "off" }> {
  const config = emailConfig(env);
  if (!config) return { status: "off" };
  const summary = await runAdventureNotices(
    {
      claim: async (max) => {
        const { data, error } = await supabase.rpc("claim_adventure_notices", { max_count: max });
        if (error) throw new Error(`claim_adventure_notices failed: ${error.code}`);
        return ((data ?? []) as AdventureNoticeRow[]).map(adventureNoticeFromRow);
      },
      finish: async (notice, result, message) => {
        const { error } = await supabase.rpc("finish_adventure_notice", {
          notice_id: notice.id,
          claim_token: notice.claimToken,
          result,
          error: message ?? undefined,
        });
        if (error) throw new Error(`finish_adventure_notice failed: ${error.code}`);
      },
      send: async (message) => {
        const result = await sendEmail(config, message);
        return result.ok ? { ok: true } : result;
      },
      adminOrigin: env.ADMIN_ORIGIN ?? null,
      now: options.now ?? Date.now,
    },
    options,
  );
  return { status: "ran", ...summary };
}
