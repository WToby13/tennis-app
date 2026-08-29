import { currentAdmin } from "@/lib/admin/guard";
import { resolveReport } from "@/lib/admin/queries";
import { json, notFound } from "@/lib/util";

export const runtime = "nodejs";

/**
 * Resolve (or reopen) one report.
 *
 * Checks `currentAdmin()` for itself rather than trusting that the caller came
 * from a page the layout already gated — the layout hides the UI, it does not
 * protect the endpoint, and this one writes with the service role. A 404 for
 * everyone else, matching the pages: no reason to confirm the route exists.
 *
 * Body: { resolved: boolean }.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await currentAdmin())) return notFound("Not found");

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const resolved = body?.resolved !== false;

  try {
    await resolveReport(id, resolved);
  } catch (err) {
    console.error("[admin] resolve report failed", err);
    return json({ error: "Couldn't update that report" }, { status: 500 });
  }

  return json({ ok: true, resolved });
}
