import { config } from "@/lib/config";
import { sendEmail } from "@/lib/email/send";
import { socialForRequest, storeForRequest } from "@/lib/request";
import type { ReportReason } from "@/lib/social";
import { badRequest, json, notFound } from "@/lib/util";

export const runtime = "nodejs";

const REASONS: ReportReason[] = ["abuse", "sexual", "violence", "spam", "other"];

/**
 * Report a match or a comment as objectionable.
 *
 * App Store Review Guideline 1.2 requires this on any app carrying
 * user-generated content, together with blocking (`/api/users/[id]/block`) and
 * a published EULA (`/terms`). The listing commits to acting on a report within
 * 24 hours, which is what the email nudge is for.
 *
 * The reported user and the offending text are resolved here, not taken from
 * the request: a client could otherwise mis-attribute a report, and the
 * snapshot has to be what the server could actually see.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);

  const targetKind = body?.targetKind;
  if (targetKind !== "match" && targetKind !== "comment") {
    return badRequest("targetKind must be 'match' or 'comment'");
  }
  const targetId = typeof body?.targetId === "string" ? body.targetId : "";
  if (!targetId) return badRequest("targetId is required");

  const reason = body?.reason as ReportReason;
  if (!REASONS.includes(reason)) {
    return badRequest(`reason must be one of ${REASONS.join(", ")}`);
  }
  const details = typeof body?.details === "string" ? body.details.trim().slice(0, 2000) : null;

  const { social, userId } = await socialForRequest();
  const { store } = await storeForRequest();

  // Resolve who is responsible and what was said, under the caller's own RLS —
  // so you can only report something you were actually able to see.
  let reportedUserId: string | null = null;
  let contentSnapshot: string | null = null;

  if (targetKind === "match") {
    const video = await store.get(targetId);
    if (!video) return notFound("Match not found");
    reportedUserId = video.ownerId;
    contentSnapshot = video.title;
  } else {
    const videoId = typeof body?.videoId === "string" ? body.videoId : "";
    if (!videoId) return badRequest("videoId is required when reporting a comment");
    const comment = (await social.listComments(videoId)).find((c) => c.id === targetId);
    if (!comment) return notFound("Comment not found");
    reportedUserId = comment.authorId;
    contentSnapshot = comment.body;
  }

  await social.report({ targetKind, targetId, reportedUserId, contentSnapshot, reason, details });

  await notify({ targetKind, targetId, reportedUserId, contentSnapshot, reason, details, userId });

  return json({ reported: true });
}

/** Email the report to whoever triages them. Never fails the request. */
async function notify(r: {
  targetKind: string;
  targetId: string;
  reportedUserId: string | null;
  contentSnapshot: string | null;
  reason: string;
  details: string | null;
  userId: string | null;
}): Promise<void> {
  if (!config.moderation.reportsTo) {
    console.warn(
      `[moderation] MODERATION_EMAIL unset — ${r.reason} report on ${r.targetKind} ${r.targetId} ` +
        `saved to content_reports but nobody was told`,
    );
    return;
  }

  const rows: Array<[string, string]> = [
    ["Reason", r.reason],
    ["Target", `${r.targetKind} ${r.targetId}`],
    ["Reported user", r.reportedUserId ?? "unknown"],
    ["Reported by", r.userId ?? "unknown"],
    ["Content", r.contentSnapshot ?? "—"],
    ["Details", r.details ?? "—"],
  ];

  await sendEmail({
    to: config.moderation.reportsTo,
    subject: `Ojo: ${r.reason} report on a ${r.targetKind}`,
    text: rows.map(([k, v]) => `${k}: ${v}`).join("\n"),
    html:
      `<h2>Content report</h2><table cellpadding="4">` +
      rows
        .map(
          ([k, v]) =>
            `<tr><td><strong>${k}</strong></td><td>${escapeHtml(v)}</td></tr>`,
        )
        .join("") +
      `</table><p>Open the row in <code>content_reports</code> and set ` +
      `<code>resolved_at</code> once actioned — the App Store listing commits to 24 hours.</p>`,
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
