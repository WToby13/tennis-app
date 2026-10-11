import { parsePins } from "@/lib/court/pins";
import { solveCalibration } from "@/lib/court/solve";
import { metadata } from "@/lib/metadata";
import { getSupabaseServiceRole, serviceRoleConfigured } from "@/lib/supabase/service";
import { badRequest, json, notFound } from "@/lib/util";
import { workerAuthError } from "@/lib/worker";

export const runtime = "nodejs";

/**
 * The analysis worker saves its automatic court detection here.
 *
 * Authorization: Bearer ANALYSIS_WORKER_SECRET.
 * Body: the same pins as a hand save ({ frameS, imageWidth, imageHeight,
 * landmarks }), plus `status` ("auto": its lines sit on the paint well enough
 * to trust; "review": someone should check them) and `moved` (the camera moved
 * during the recording).
 *
 * The camera is solved from the pins exactly as for a hand save. A calibration
 * a person placed is never replaced (409): theirs is the better one.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = workerAuthError(req, "worker/calibration");
  if (denied) return denied;
  if (!serviceRoleConfigured()) return json({ error: "Not configured." }, { status: 503 });

  const { id } = await params;
  const store = metadata(getSupabaseServiceRole(), null, true);
  const video = await store.get(id);
  if (!video) return notFound("Video not found");
  const existing = video.courtCalibration;
  if (existing && existing.source !== "auto") {
    return json({ error: "This match was calibrated by hand; keeping that." }, { status: 409 });
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const parsed = parsePins(body, video.durationS);
  if ("error" in parsed) return badRequest(parsed.error);
  const solved = solveCalibration(parsed);
  if (!solved.ok) return badRequest(solved.error);

  const calibration = {
    ...solved.calibration,
    source: "auto" as const,
    autoStatus: body?.status === "auto" ? ("auto" as const) : ("review" as const),
    moved: body?.moved === true,
  };
  await store.update(id, { courtCalibration: calibration });
  return json({ calibration });
}
