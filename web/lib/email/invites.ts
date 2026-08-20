import { config } from "../config";
import { sendEmail } from "./send";
import { participantAdded, participantInvite } from "./templates";

/** The link that claims an invite — works signed-out, survives a different signup email. */
export function inviteUrl(token: string): string {
  return `${config.appUrl}/invite/${token}`;
}

/** One invite and whether the mail actually went out. */
export interface InviteResult {
  email: string;
  /** Always present, so the inviter can send it by hand when `sent` is false. */
  url: string;
  sent: boolean;
}

/**
 * Email people tagged on a match who don't have an Ojo account yet.
 *
 * Returns a result per invite rather than swallowing failures. That matters:
 * with an unverified Resend domain (or no key at all) every send fails silently,
 * and the inviter's only clue is that their friend never turns up. The caller
 * hands these back to the UI, which offers the link to copy instead.
 */
export async function sendParticipantInvites(opts: {
  invites: Array<{ email: string; token: string }>;
  matchTitle: string;
  inviterName?: string | null;
}): Promise<InviteResult[]> {
  const seen = new Set<string>();
  const unique = opts.invites.filter(({ email }) => {
    const key = email.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const settled = await Promise.allSettled(
    unique.map(async ({ email, token }) => {
      const url = inviteUrl(token);
      const { subject, html, text } = participantInvite({
        matchTitle: opts.matchTitle,
        inviteUrl: url,
        inviterName: opts.inviterName,
      });
      const res = await sendEmail({ to: email, subject, html, text });
      return { email, url, sent: res.ok };
    }),
  );

  return settled.map((outcome, i) =>
    outcome.status === "fulfilled"
      ? outcome.value
      : { email: unique[i].email, url: inviteUrl(unique[i].token), sent: false },
  );
}

/**
 * Tell people who already have an account that they're in a match. They get
 * library access from the tag itself, so this is only a notification — best
 * effort, and never allowed to fail a save.
 */
export async function sendParticipantAdded(opts: {
  videoId: string;
  matchTitle: string;
  emails: string[];
  inviterName?: string | null;
}): Promise<void> {
  const watchUrl = `${config.appUrl}/watch/${opts.videoId}`;
  const unique = Array.from(
    new Set(opts.emails.map((e) => e.trim().toLowerCase()).filter(Boolean)),
  );
  const { subject, html, text } = participantAdded({
    matchTitle: opts.matchTitle,
    watchUrl,
    inviterName: opts.inviterName,
  });
  await Promise.allSettled(unique.map((to) => sendEmail({ to, subject, html, text })));
}
