import fs from "node:fs/promises";
import path from "node:path";
import { config } from "@/lib/config";
import { getSupabaseServer } from "@/lib/supabase/server";
import { json } from "@/lib/util";

export const runtime = "nodejs";

/**
 * A match's own analysis (MatchStats), or null when it hasn't been analysed.
 * Read as the caller, so row-level security decides: anyone who can see the
 * match can see its analysis.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Development only: analyses written by `ml/ojo_replay/post_analysis.py --out
  // <dir>`, so the section can be worked on without a database row.
  const devDir = process.env.NODE_ENV !== "production" ? process.env.MATCH_STATS_DIR : undefined;
  if (devDir && /^[0-9a-f-]{36}$/.test(id)) {
    const file = await fs.readFile(path.join(devDir, `${id}.json`), "utf8").catch(() => null);
    if (file) return json({ stats: JSON.parse(file), updatedAt: null });
  }
  if (!config.authEnabled) return json({ stats: null }); // local mode keeps no analyses
  const supabase = await getSupabaseServer();
  const { data, error } = await supabase
    .from("match_analyses")
    .select("data, pipeline_version, updated_at")
    .eq("video_id", id)
    .maybeSingle();
  if (error) {
    // Before migration 0023 the table doesn't exist; treat as "not analysed".
    if (error.code === "42P01" || error.code === "PGRST205") return json({ stats: null });
    console.error("[match-stats] read failed", error);
    return json({ error: "Couldn't load the analysis." }, { status: 500 });
  }
  return json({ stats: data?.data ?? null, updatedAt: data?.updated_at ?? null });
}
