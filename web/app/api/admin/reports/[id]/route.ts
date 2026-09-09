import { currentAdmin } from "@/lib/admin/guard";
import { ejectUser, removeReportedContent } from "@/lib/admin/moderation";
import { resolveReport } from "@/lib/admin/queries";
import { json, notFound } from "@/lib/util";

export const runtime = "nodejs";

/**
 * Act on one report.
 *
 * Checks `currentAdmin()` for itself rather than trusting that the caller came
 * from a page the layout already gated — the layout hides the UI, it does not
 * protect the endpoint, and this one writes with the service role. A 404 for
 * everyone else, matching the pages: no reason to confirm the route exists.
 *
 * Body is one of:
 *   { resolved: boolean }   toggle the queue state, changing nothing else
 *   { action: "remove" }    take the reported content down
 *   { action: "eject" }     ban the account that posted it
 *
 * The two actions resolve the report themselves, so acting on one is a single
 * click rather than a thing to remember afterwards. Guideline 1.2 asks for both
 * within 24 hours of a report.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await currentAdmin())) return notFound("Not found");

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const action = body?.action;

  try {
    if (action === "remove") return json({ ok: true, ...(await removeReportedContent(id)) });
    if (action === "eject") return json({ ok: true, ...(await ejectUser(id)) });

    const resolved = body?.resolved !== false;
    await resolveReport(id, resolved);
    return json({ ok: true, resolved });
  } catch (err) {
    console.error(`[admin] report action ${action ?? "resolve"} failed`, err);
    // The message is the operator's own, and every one of them is written for a
    // person deciding what to do next ("that report has no account attached"),
    // so it is worth more than a generic 500 string.
    return json({ error: err instanceof Error ? err.message : "Couldn't do that" }, { status: 500 });
  }
}
