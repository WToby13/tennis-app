import { parsePins } from "@/lib/court/pins";
import { solveCalibration } from "@/lib/court/solve";
import { storeForRequest } from "@/lib/request";
import { badRequest, json, notFound } from "@/lib/util";

export const runtime = "nodejs";

/**
 * Save a match's court calibration. Owner only — the same rights as naming the
 * players, enforced by the owner-only videos UPDATE policy underneath.
 *
 * Body: {
 *   frameS: number,                       // the frame the pins were placed on
 *   imageWidth: number, imageHeight: number,  // the video's native resolution
 *   landmarks: [{ id: "far_left_doubles", x: 512.3, y: 288.1 }, …]
 * }
 *
 * Only the pins are taken from the request. The camera is solved again here,
 * so what's stored always follows from the pins, whatever a client computed.
 * A save here is a person's, so it replaces any automatic calibration. Three
 * pins make a quick court (source "clicks"), which the analysis worker snaps
 * onto the painted lines and replaces with the refined pins.
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { store, userId } = await storeForRequest();

  const video = await store.get(id);
  if (!video) return notFound("Video not found");
  if (userId && video.ownerId !== userId) return notFound("Video not found");

  const parsed = parsePins(await req.json().catch(() => null), video.durationS);
  if ("error" in parsed) return badRequest(parsed.error);

  const solved = solveCalibration(parsed);
  if (!solved.ok) return badRequest(solved.error);

  const calibration = { ...solved.calibration, source: solved.calibration.quick ? ("clicks" as const) : ("manual" as const) };
  await store.update(id, { courtCalibration: calibration });
  return json({ calibration });
}
/** Remove a match's court calibration. Owner only. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { store, userId } = await storeForRequest();

  const video = await store.get(id);
  if (!video) return notFound("Video not found");
  if (userId && video.ownerId !== userId) return notFound("Video not found");

  await store.update(id, { courtCalibration: null });
  return json({ calibration: null });
}

