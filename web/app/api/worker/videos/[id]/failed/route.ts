import { metadata } from "@/lib/metadata";
import { isOjoTask } from "@/lib/ojoEngine";
import { getSupabaseServiceRole, serviceRoleConfigured } from "@/lib/supabase/service";
import { json, notFound } from "@/lib/util";
import { workerAuthError } from "@/lib/worker";

export const runtime = "nodejs";

/**
 * The analysis worker couldn't analyse this match: end the run as failed with
 * a message the owner sees. Only touches runs our engine owns.
 * Body: { error: string }.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = workerAuthError(req, "worker/failed");
  if (denied) return denied;
  if (!serviceRoleConfigured()) return json({ error: "Not configured." }, { status: 503 });
  const { id } = await params;
  const store = metadata(getSupabaseServiceRole(), null, true);
  const video = await store.get(id);
  if (!video) return notFound("Video not found");
  if (!isOjoTask(video.analysisTaskId)) return json({ error: "Not our run." }, { status: 409 });
  const body = (await req.json().catch(() => null)) as { error?: unknown } | null;
  const message = typeof body?.error === "string" && body.error.trim()
    ? body.error.slice(0, 300)
    : "The analysis didn't finish. Please try again.";
  await store.update(id, { analysisStatus: "failed", analysisError: message, analysisTaskId: null });
  return json({ ok: true });
}
