import { LANDMARK_BY_ID } from "./model";
import type { PlacedLandmark, SolveInput } from "./solve";

/**
 * Validate a calibration request's pins. Shared with the analysis worker's
 * route, so automatic and hand-placed pins pass the same checks.
 */
export function parsePins(
  body: unknown,
  durationS: number | null | undefined,
): SolveInput | { error: string } {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== "object") return { error: "Expected a JSON body." };
  const { imageWidth, imageHeight, frameS } = b;
  const dimension = (v: unknown): v is number =>
    typeof v === "number" && Number.isInteger(v) && v >= 64 && v <= 8192;
  if (!dimension(imageWidth) || !dimension(imageHeight)) return { error: "Bad image size." };
  if (typeof frameS !== "number" || !Number.isFinite(frameS) || frameS < 0) return { error: "Bad frame time." };
  if (durationS != null && frameS > durationS + 1) return { error: "Frame is past the end of the match." };

  if (!Array.isArray(b.landmarks) || b.landmarks.length > LANDMARK_BY_ID.size) {
    return { error: "Expected a list of landmarks." };
  }
  const landmarks: PlacedLandmark[] = [];
  const seen = new Set<string>();
  for (const raw of b.landmarks as unknown[]) {
    const l = raw as Record<string, unknown> | null;
    const lid = typeof l?.id === "string" ? l.id : "";
    if (!LANDMARK_BY_ID.has(lid)) return { error: `Unknown landmark "${lid}".` };
    if (seen.has(lid)) return { error: `Landmark "${lid}" appears twice.` };
    seen.add(lid);
    const { x, y } = l as { x: unknown; y: unknown };
    // A pin has to be on the frame (a little slack for the edge pixels).
    if (
      typeof x !== "number" || typeof y !== "number" ||
      !(x >= -2 && x <= imageWidth + 2 && y >= -2 && y <= imageHeight + 2)
    ) {
      return { error: `Landmark "${lid}" is off the frame.` };
    }
    landmarks.push({ id: lid, x, y });
  }
  return { imageWidth, imageHeight, frameS, landmarks };
}
