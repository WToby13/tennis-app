import { getSupabaseServiceRole } from "../supabase/service";

/**
 * Acting on a report: taking the content down, and putting the account that
 * posted it out.
 *
 * Guideline 1.2's fourth precaution is not a control in the app — it is a thing
 * the operator has to be able to *do*, "within 24 hours by removing the content
 * and ejecting the user who provided the offending content". Until this file
 * existed the queue at /admin/reports could only mark a report resolved, which
 * records a decision without carrying it out.
 *
 * Both actions run on the service role, reached only after `currentAdmin()` has
 * matched the session against ADMIN_EMAIL — same contract as the rest of
 * `lib/admin`.
 */

interface ReportRow {
  id: string;
  target_kind: string;
  target_id: string;
  reported_user_id: string | null;
}

async function loadReport(reportId: string): Promise<ReportRow> {
  const db = getSupabaseServiceRole();
  const { data, error } = await db
    .from("content_reports")
    .select("id, target_kind, target_id, reported_user_id")
    .eq("id", reportId)
    .maybeSingle();
  if (error) throw new Error(`report lookup failed: ${error.message}`);
  if (!data) throw new Error("report not found");
  return data as ReportRow;
}

/** Stamp the report as actioned, keeping the first timestamp if there is one. */
async function markResolved(reportId: string): Promise<void> {
  const db = getSupabaseServiceRole();
  const { error } = await db
    .from("content_reports")
    .update({ resolved_at: new Date().toISOString() })
    .eq("id", reportId)
    .is("resolved_at", null);
  if (error) throw new Error(`resolve failed: ${error.message}`);
}

/**
 * Take down what was reported.
 *
 * A comment is deleted outright — there is no reading it back, and the report
 * keeps `content_snapshot` so the record of what was said survives the row.
 *
 * A match is soft-deleted, the same way its owner deleting it works: `deleted_at`
 * is what every read path already filters on, so one write removes it from the
 * feed, from profiles, from search and from anyone's library at once. The file
 * itself is left to the ordinary deletion path rather than being purged from
 * inside a moderation action.
 */
export async function removeReportedContent(reportId: string): Promise<{ removed: string }> {
  const report = await loadReport(reportId);
  const db = getSupabaseServiceRole();

  if (report.target_kind === "comment") {
    const { error } = await db.from("match_comments").delete().eq("id", report.target_id);
    if (error) throw new Error(`comment removal failed: ${error.message}`);
    await markResolved(reportId);
    return { removed: "comment" };
  }

  if (report.target_kind === "match") {
    const { error } = await db
      .from("videos")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", report.target_id);
    if (error) throw new Error(`match removal failed: ${error.message}`);
    await markResolved(reportId);
    return { removed: "match" };
  }

  throw new Error(`unknown target kind: ${report.target_kind}`);
}

/**
 * Eject the account that posted it.
 *
 * A ban rather than a delete: deleting would cascade away the matches other
 * people have in their libraries and the comments other people replied to, and
 * would destroy the evidence behind any report still open against them. Banned
 * accounts cannot obtain a session, so they cannot post, comment or sign in —
 * and the ban can be lifted if an appeal turns out to be right.
 *
 * A hundred years, because GoTrue takes a duration rather than "forever".
 */
export async function ejectUser(reportId: string): Promise<{ ejected: string }> {
  const report = await loadReport(reportId);
  if (!report.reported_user_id) throw new Error("that report has no account attached");

  const db = getSupabaseServiceRole();
  const { error } = await db.auth.admin.updateUserById(report.reported_user_id, {
    ban_duration: `${24 * 365 * 100}h`,
  });
  if (error) throw new Error(`eject failed: ${error.message}`);

  await markResolved(reportId);
  return { ejected: report.reported_user_id };
}
