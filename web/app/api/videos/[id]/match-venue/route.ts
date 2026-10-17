import fs from "node:fs/promises";
import path from "node:path";
import { notFound } from "@/lib/util";

export const runtime = "nodejs";

/**
 * The court's surroundings as a 3D Gaussian splat (ml/ojo_replay/venue_splat.py),
 * in court coordinates, for the 3D view's "Your court". The body is the splat
 * file; `x-splat-format` says which (spz or ply).
 *
 * Development only for now: files from `venue_splat.py place <id> --out <dir>`.
 * In production a splat will live in storage beside the scene (several MB) and
 * this will hand out its URL; until the GPU pipeline produces them there are
 * none, and the view keeps its projected walls.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const devDir = process.env.NODE_ENV !== "production" ? process.env.MATCH_STATS_DIR : undefined;
  if (!devDir || !/^[0-9a-f-]{36}$/.test(id)) return notFound("No venue splat");
  for (const format of ["spz", "ply"]) {
    const bytes = await fs.readFile(path.join(devDir, `${id}.venue.${format}`)).catch(() => null);
    if (bytes) {
      return new Response(new Uint8Array(bytes), {
        headers: { "content-type": "application/octet-stream", "x-splat-format": format, "cache-control": "no-store" },
      });
    }
  }
  return notFound("No venue splat");
}
