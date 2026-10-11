import fs from "node:fs/promises";
import path from "node:path";
import { config } from "@/lib/config";
import { getSupabaseServer } from "@/lib/supabase/server";
import { json } from "@/lib/util";

export const runtime = "nodejs";

/**
 * What the watch page draws over the video (MatchTracks), or null. Read as the
 * caller, so row-level security decides, as for the stats.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Development only: files from `post_analysis.py --out <dir>`.
  const devDir = process.env.NODE_ENV !== "production" ? process.env.MATCH_STATS_DIR : undefined;
  if (devDir && /^[0-9a-f-]{36}$/.test(id)) {
    const file = await fs.readFile(path.join(devDir, `${id}.tracks.json`), "utf8").catch(() => null);
    if (file) return json({ tracks: JSON.parse(file) });
  }
  if (!config.authEnabled) return json({ tracks: null });
  const supabase = await getSupabaseServer();
  const { data, error } = await supabase.from("match_analyses").select("tracks").eq("video_id", id).maybeSingle();
  if (error) {
    if (error.code === "42P01" || error.code === "PGRST205") return json({ tracks: null });
    console.error("[match-tracks] read failed", error);
    return json({ error: "Couldn't load the tracking." }, { status: 500 });
  }
  return json({ tracks: data?.tracks ?? null });
}
