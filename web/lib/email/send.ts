import { config } from "../config";

export interface EmailMessage {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  /** Optional reply-to (e.g. the inviter). */
  replyTo?: string;
}

/**
 * Send one transactional email via Resend. This is the single choke point for
 * all outbound mail — templates render, this delivers. When RESEND_API_KEY is
 * unset (local dev, or before the key is added in Vercel) it logs and no-ops
 * rather than throwing, so callers never need to guard.
 */
export async function sendEmail(msg: EmailMessage): Promise<{ ok: boolean; skipped?: boolean }> {
  if (!config.email.enabled) {
    console.warn(`[email] RESEND_API_KEY unset — skipping "${msg.subject}"`);
    return { ok: false, skipped: true };
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.email.resendApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: config.email.from,
        to: Array.isArray(msg.to) ? msg.to : [msg.to],
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
        ...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
      }),
    });
    if (!res.ok) {
      console.error(`[email] send failed (${res.status})`, await res.text().catch(() => ""));
      return { ok: false };
    }
    return { ok: true };
  } catch (err) {
    console.error("[email] send error", err);
    return { ok: false };
  }
}
