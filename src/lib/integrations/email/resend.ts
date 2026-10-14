/**
 * Transactional email through Resend's HTTP API (Phase 13 step 3; PLAN
 * D144, ADR-024): the Admin sends quote emails itself (Auth's emails go
 * through Supabase's own SMTP settings). Off unless RESEND_API_KEY and
 * EMAIL_FROM are both set. `fetch` is injected so the unit tests check the
 * request without the network. Nothing from Resend's answer is echoed to a
 * user: callers get a reason, never Resend's message.
 */

export const RESEND_ENDPOINT = "https://api.resend.com/emails";

export type EmailConfig = { apiKey: string; from: string };

export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Resend keeps one email per key for 24 hours, so a retried send is not doubled. */
  idempotencyKey: string;
};

export type EmailResult =
  { ok: true; id: string } | { ok: false; reason: "rejected" | "unavailable"; status?: number };

/** Both variables, or null (email off). */
export function emailConfig(env: {
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
}): EmailConfig | null {
  return env.RESEND_API_KEY && env.EMAIL_FROM
    ? { apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM }
    : null;
}

export async function sendEmail(
  config: EmailConfig,
  message: EmailMessage,
  fetchImpl: typeof fetch = fetch,
): Promise<EmailResult> {
  let response: Response;
  try {
    response = await fetchImpl(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": message.idempotencyKey,
      },
      body: JSON.stringify({
        from: config.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        html: message.html,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  if (!response.ok) {
    // 4xx: the key, the sender's domain or the address was refused; 5xx and
    // 429: Resend could not take it now.
    const retryable = response.status === 429 || response.status >= 500;
    return { ok: false, reason: retryable ? "unavailable" : "rejected", status: response.status };
  }
  const body = (await response.json().catch(() => null)) as { id?: unknown } | null;
  return { ok: true, id: typeof body?.id === "string" ? body.id : "" };
}
