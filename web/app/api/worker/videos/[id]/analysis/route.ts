import { isMatchStats } from "@/lib/matchStats";
import { metadata } from "@/lib/metadata";
import { RALLY_KIND } from "@/lib/twelvelabs/rally";
import { isOjoTask } from "@/lib/ojoEngine";
import { getSupabaseServiceRole, serviceRoleConfigured } from "@/lib/supabase/service";
import { badRequest, json, notFound } from "@/lib/util";
import { workerAuthError } from "@/lib/worker";

export const runtime = "nodejs";

const MAX_BYTES = 8_000_000; // stats are tens of kB; tracks ~0.8 MB per half hour

/**
 * The analysis worker stores a match's analysis here (MatchStats, replacing
 * any earlier run). Authorization: Bearer ANALYSIS_WORKER_SECRET.
 *
 * With `segments` (rallies with game, server, ends and shots, in the shape the
 * rally breakdown reads) and a run our engine owns (lib/ojoEngine.ts), it also
 * fills the rally breakdown and finishes the run, as TwelveLabs' result did.
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
  // Tracks and segments travel with the stats but are stored apart.
  const { tracks, segments, ...stats } = data as typeof data & { tracks?: unknown; segments?: unknown };

  const { id } = await params;
  const db = getSupabaseServiceRole();
  const { data: video } = await db.from("videos").select("id").eq("id", id).maybeSingle();
  if (!video) return notFound("Video not found");

  const { error } = await db.from("match_analyses").upsert({
    video_id: id,
    pipeline_version: stats.version,
    data: stats,
    tracks: tracks ?? null,
    updated_at: new Date().toISOString(),
  });
  if (error) {
    console.error("[worker/analysis] upsert failed", error);
    return json({ error: "Couldn't save the analysis." }, { status: 500 });
  }
  // Our engine's run: the breakdown comes from this analysis.
  const store = metadata(db, null, true);
  const row = await store.get(id);
  let breakdown = false;
  if (row && isOjoTask(row.analysisTaskId) && Array.isArray(segments)) {
    const clean = segments
      .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
      .map((s, i) => ({
        kind: RALLY_KIND,
        idx: i,
        startS: typeof s.startS === "number" ? s.startS : null,
        endS: typeof s.endS === "number" ? s.endS : null,
        metadata: (s.metadata && typeof s.metadata === "object" ? s.metadata : {}) as Record<string, unknown>,
      }));
    await store.replaceSegments(id, RALLY_KIND, clean);
    await store.update(id, {
      analysisStatus: "ready",
      analyzedAt: new Date().toISOString(),
      analysisError: null,
      analysisTaskId: null,
    });
    breakdown = true;
  }
  return json({ ok: true, shots: stats.shots.length, tracks: Boolean(tracks), breakdown });
}
