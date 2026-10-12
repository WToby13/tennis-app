import { metadata } from "@/lib/metadata";
import { OJO_RUNNING, ojoClaimable } from "@/lib/ojoEngine";
import { storage } from "@/lib/storage";
import { getSupabaseServiceRole, serviceRoleConfigured } from "@/lib/supabase/service";
import { json } from "@/lib/util";
import { workerAuthError } from "@/lib/worker";

export const runtime = "nodejs";

/**
 * Hand the analysis worker matches to analyse (lib/ojoEngine.ts), claiming
 * each one so two workers don't take the same match. Authorization: Bearer
 * ANALYSIS_WORKER_SECRET. `?limit=` caps how many (default 1).
 *
 * Each job carries a signed URL for the original recording, its duration, the
 * owner's player names, and the court calibration when there is one.
 */
export async function POST(req: Request) {
  const denied = workerAuthError(req, "worker/jobs");
  if (denied) return denied;
  if (!serviceRoleConfigured()) return json({ error: "Not configured." }, { status: 503 });

  const limit = Math.min(Math.max(Number(new URL(req.url).searchParams.get("limit") ?? 1) || 1, 1), 10);
  const store = metadata(getSupabaseServiceRole(), null, true);
  const inFlight = await store.listInFlightAnalyses(50);
  const jobs = [];
  for (const video of inFlight) {
    if (jobs.length >= limit) break;
    if (!ojoClaimable(video.analysisTaskId)) continue;
    await store.update(video.id, { analysisTaskId: `${OJO_RUNNING}${new Date().toISOString()}` });
    jobs.push({
      id: video.id,
      title: video.title,
      durationS: video.durationS,
      url: await storage().getPlaybackUrl(video.id, video.key),
      players: video.analysisPlayers ?? null,
      courtCalibration: video.courtCalibration ?? null,
    });
  }
  return json({ jobs });
}
