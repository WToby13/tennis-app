import { LANDMARK_BY_ID } from "@/lib/court/model";
import { solveCalibration, type PlacedLandmark } from "@/lib/court/solve";
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
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { store, userId } = await storeForRequest();

  const video = await store.get(id);
  if (!video) return notFound("Video not found");
  if (userId && video.ownerId !== userId) return notFound("Video not found");

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return badRequest("Expected a JSON body.");

  const { imageWidth, imageHeight, frameS } = body;
  const dimension = (v: unknown): v is number =>
    typeof v === "number" && Number.isInteger(v) && v >= 64 && v <= 8192;
  if (!dimension(imageWidth) || !dimension(imageHeight)) return badRequest("Bad image size.");
  if (typeof frameS !== "number" || !Number.isFinite(frameS) || frameS < 0) {
    return badRequest("Bad frame time.");
  }
  if (video.durationS != null && frameS > video.durationS + 1) return badRequest("Frame is past the end of the match.");

  if (!Array.isArray(body.landmarks) || body.landmarks.length > LANDMARK_BY_ID.size) {
    return badRequest("Expected a list of landmarks.");
  }
  const landmarks: PlacedLandmark[] = [];
  const seen = new Set<string>();
  for (const raw of body.landmarks as unknown[]) {
    const l = raw as Record<string, unknown> | null;
    const lid = typeof l?.id === "string" ? l.id : "";
    if (!LANDMARK_BY_ID.has(lid)) return badRequest(`Unknown landmark "${lid}".`);
    if (seen.has(lid)) return badRequest(`Landmark "${lid}" appears twice.`);
    seen.add(lid);
    const { x, y } = l as { x: unknown; y: unknown };
    // A pin has to be on the frame (a little slack for the edge pixels).
    if (
      typeof x !== "number" || typeof y !== "number" ||
      !(x >= -2 && x <= imageWidth + 2 && y >= -2 && y <= imageHeight + 2)
    ) {
      return badRequest(`Landmark "${lid}" is off the frame.`);
    }
    landmarks.push({ id: lid, x, y });
  }

  const solved = solveCalibration({ imageWidth, imageHeight, frameS, landmarks });
  if (!solved.ok) return badRequest(solved.error);

  await store.update(id, { courtCalibration: solved.calibration });
  return json({ calibration: solved.calibration });
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
