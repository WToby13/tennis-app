import { config } from "../config";
import { sendEmail } from "./send";
import { participantInvite } from "./templates";

/**
 * Email guests who were tagged by email so they can join and inherit the match.
 * Best-effort and non-blocking-critical: failures are logged, never thrown, so a
 * flaky email provider can't break saving participants.
 */
export async function sendParticipantInvites(opts: {
  videoId: string;
  matchTitle: string;
  emails: string[];
  inviterName?: string | null;
}): Promise<void> {
  const watchUrl = `${config.appUrl}/watch/${opts.videoId}`;
  const unique = Array.from(new Set(opts.emails.map((e) => e.trim().toLowerCase()).filter(Boolean)));
  await Promise.allSettled(
    unique.map((email) => {
      const { subject, html, text } = participantInvite({
        matchTitle: opts.matchTitle,
        watchUrl,
        inviterName: opts.inviterName,
      });
      return sendEmail({ to: email, subject, html, text });
    }),
  );
}
