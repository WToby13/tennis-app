import { Resend } from "resend";

import { config } from "@/lib/config";
import { json } from "@/lib/util";

export const runtime = "nodejs";

/**
 * Inbound mail → your real inbox.
 *
 * `support@ojotennis.com` and `privacy@ojotennis.com` are published in the
 * privacy policy, the terms and the App Store listing, and a reviewer does
 * sometimes write to the support address. Resend can *receive* mail for the
 * domain but has no forwarding switch — receiving raises an `email.received`
 * webhook carrying only metadata, and turning that into a forward is this file.
 *
 * `passthrough` (the default) re-sends the original message intact rather than
 * wrapping it, and `replyTo` is set to whoever wrote in — so hitting Reply in
 * Gmail answers *them*, not yourself. That is the whole reason this is worth
 * having over a plain re-send.
 */
export async function POST(req: Request) {
  const { webhookSecret, forwardTo, from, apiKey } = config.email.inbound;

  if (!webhookSecret || !forwardTo) {
    // Refuse rather than accept-and-drop: a 500 makes Resend retry, so mail
    // waits for the config instead of disappearing while it is missing.
    console.error("[inbound] RESEND_WEBHOOK_SECRET or INBOUND_FORWARD_TO unset");
    return json({ error: "inbound forwarding not configured" }, { status: 500 });
  }

  // The raw body, not a re-serialised parse — the signature covers the exact
  // bytes and JSON.stringify(JSON.parse(x)) is not guaranteed to reproduce them.
  const payload = await req.text();
  const resend = new Resend(apiKey);

  let event: { type?: string; data?: { email_id?: string; from?: string; subject?: string } };
  try {
    event = resend.webhooks.verify({
      payload,
      headers: {
        id: req.headers.get("svix-id") ?? "",
        timestamp: req.headers.get("svix-timestamp") ?? "",
        signature: req.headers.get("svix-signature") ?? "",
      },
      webhookSecret,
    }) as typeof event;
  } catch {
    // This endpoint is public by necessity, so an unverified caller is the
    // expected failure mode, not an exceptional one.
    return json({ error: "bad signature" }, { status: 401 });
  }

  if (event.type !== "email.received") return json({ ignored: event.type ?? "unknown" });

  const emailId = event.data?.email_id;
  if (!emailId) {
    console.error("[inbound] email.received with no email_id");
    return json({ error: "no email id" }, { status: 400 });
  }

  const { error } = await resend.emails.receiving.forward({
    emailId,
    to: forwardTo,
    from,
    // Answer the person who wrote in, not the forwarding address.
    ...(event.data?.from ? { replyTo: event.data.from } : {}),
  });

  if (error) {
    // `restricted_api_key` here means RESEND_INBOUND_API_KEY is a sending-only
    // key: forwarding reads the received message, which needs full access.
    console.error("[inbound] forward failed", error);
    // 500 so Resend retries — losing a support email is the worse outcome.
    return json({ error: "forward failed" }, { status: 500 });
  }

  console.log(`[inbound] forwarded "${event.data?.subject ?? "(no subject)"}" to ${forwardTo}`);
  return json({ forwarded: true });
}
