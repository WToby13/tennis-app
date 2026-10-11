import { isMatchStats } from "@/lib/matchStats";
import { getSupabaseServiceRole, serviceRoleConfigured } from "@/lib/supabase/service";
import { badRequest, json, notFound } from "@/lib/util";
import { workerAuthError } from "@/lib/worker";

export const runtime = "nodejs";

const MAX_BYTES = 2_000_000; // a two-hour match is a few hundred kB

/**
 * The analysis worker stores a match's analysis here (MatchStats, replacing
 * any earlier run). Authorization: Bearer ANALYSIS_WORKER_SECRET.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = workerAuthError(req, "worker/analysis");
  if (denied) return denied;
  if (!serviceRoleConfigured()) return json({ error: "Not configured." }, { status: 503 });

  const text = await req.text();
  if (text.length > MAX_BYTES) return badRequest("Analysis too large.");
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return badRequest("Expected a JSON body.");
  }
  if (!isMatchStats(data)) return badRequest("Not a match analysis.");

  const { id } = await params;
  const db = getSupabaseServiceRole();
  const { data: video } = await db.from("videos").select("id").eq("id", id).maybeSingle();
  if (!video) return notFound("Video not found");

  const { error } = await db.from("match_analyses").upsert({
    video_id: id,
    pipeline_version: data.version,
    data,
    updated_at: new Date().toISOString(),
  });
  if (error) {
    console.error("[worker/analysis] upsert failed", error);
    return json({ error: "Couldn't save the analysis." }, { status: 500 });
  }
  return json({ ok: true, shots: data.shots.length });
}
