import { storage } from "@/lib/storage";
import { getSupabaseServiceRole, serviceRoleConfigured } from "@/lib/supabase/service";
import { badRequest, json, notFound } from "@/lib/util";
import { workerAuthError } from "@/lib/worker";

export const runtime = "nodejs";

/**
 * The analysis worker stores a match's 3D scene (MatchScene) in two steps,
 * after its analysis (the scene is recorded on that analysis's row):
 *
 * - `{"step": "upload"}` returns `{url, method}` to PUT the scene's JSON to,
 *   straight into storage (it's a few MB, past the host's request limit);
 * - `{"step": "saved", "version": n}` records that it's there.
 *
 * Authorization: Bearer ANALYSIS_WORKER_SECRET.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = workerAuthError(req, "worker/scene");
  if (denied) return denied;
  if (!serviceRoleConfigured()) return json({ error: "Not configured." }, { status: 503 });

  const body = (await req.json().catch(() => null)) as { step?: string; version?: unknown } | null;
  const { id } = await params;
  const db = getSupabaseServiceRole();
  const { data: row } = await db.from("match_analyses").select("video_id").eq("video_id", id).maybeSingle();
  if (!row) return notFound("No analysis for this video yet.");

  if (body?.step === "upload") return json(await storage().getSceneUploadUrl(id));
  if (body?.step === "saved" && typeof body.version === "number") {
    const { error } = await db
      .from("match_analyses")
      .update({ scene_version: body.version, updated_at: new Date().toISOString() })
      .eq("video_id", id);
    if (error) {
      console.error("[worker/scene] update failed", error);
      return json({ error: "Couldn't record the scene." }, { status: 500 });
    }
    return json({ ok: true });
  }
  return badRequest('Expected {"step": "upload"} or {"step": "saved", "version": n}.');
}
