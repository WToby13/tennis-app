import { sendEmail } from "@/lib/email/send";
import { config } from "@/lib/config";
import { socialForRequest } from "@/lib/request";
import { badRequest, json } from "@/lib/util";

export const runtime = "nodejs";

/**
 * Block / unblock a user. Blocking hides their matches and comments from the
 * caller and the caller's from them, and drops any follow between the two.
 *
 * Required by App Store Review Guideline 1.2 alongside `/api/reports`.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { social, userId } = await socialForRequest();
  if (userId && userId === id) return badRequest("You can't block yourself");

  await social.blockUser(id);

  // Guideline 1.2 asks that blocking "notify the developer of the inappropriate
  // content", not only that it hide it. A block is a weaker signal than a report
  // — people block for reasons that are not abuse at all — so this is sent as a
  // separate, lower-priority notice rather than filed in `content_reports`,
  // which is the queue we commit to actioning within 24 hours.
  void notifyBlock({ blockedId: id, byUserId: userId });

  return json({ blocked: true });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { social } = await socialForRequest();
  await social.unblockUser(id);
  return json({ blocked: false });
}

/** Tell the operator a block happened. Never the caller's problem if it fails. */
async function notifyBlock(b: { blockedId: string; byUserId: string | null }): Promise<void> {
  try {
    if (!config.moderation.reportsTo) {
      console.warn(`[moderation] MODERATION_EMAIL unset — ${b.byUserId} blocked ${b.blockedId}, nobody told`);
      return;
    }
    const rows: Array<[string, string]> = [
      ["Blocked user", b.blockedId],
      ["Blocked by", b.byUserId ?? "unknown"],
    ];
    await sendEmail({
      to: config.moderation.reportsTo,
      subject: "Ojo: a user was blocked",
      text: rows.map(([k, v]) => `${k}: ${v}`).join("\n"),
      html:
        `<h2>User blocked</h2><table cellpadding="4">` +
        rows.map(([k, v]) => `<tr><td><strong>${k}</strong></td><td>${v}</td></tr>`).join("") +
        `</table><p>Their matches and comments are already hidden from each other, ` +
        `both ways, and any follow between them has been dropped. No action is ` +
        `required — this is a signal, not a report. Repeated blocks against the ` +
        `same account are worth looking into.</p>`,
    });
  } catch (err) {
    console.error("[moderation] block notification failed", err);
  }
}
