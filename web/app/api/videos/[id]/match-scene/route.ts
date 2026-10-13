import fs from "node:fs/promises";
import path from "node:path";
import { config } from "@/lib/config";
import { storage } from "@/lib/storage";
import { getSupabaseServer } from "@/lib/supabase/server";
import { json } from "@/lib/util";

export const runtime = "nodejs";

/**
 * Where to fetch the match's 3D scene (MatchScene): `{url}`, or `{url: null}`
 * when it has none. Read as the caller, so row-level security decides who may
 * have the URL, as for the stats and tracking. The scene itself comes from
 * storage, a few MB, straight to the browser.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Development only: files from `scene.py --out <dir>` / `demo_local.py`.
  const devDir = process.env.NODE_ENV !== "production" ? process.env.MATCH_STATS_DIR : undefined;
  if (devDir && /^[0-9a-f-]{36}$/.test(id)) {
    const file = await fs.readFile(path.join(devDir, `${id}.scene.json`), "utf8").catch(() => null);
    if (file) return new Response(`{"scene":${file}}`, { headers: { "content-type": "application/json" } });
  }
  if (!config.authEnabled) return json({ url: null });
  const supabase = await getSupabaseServer();
  const { data, error } = await supabase.from("match_analyses").select("scene_version").eq("video_id", id).maybeSingle();
  if (error) {
    // Before migration 0024 the column doesn't exist: no 3D view, not an error.
    if (["42P01", "PGRST205", "42703", "PGRST204"].includes(error.code)) return json({ url: null });
    console.error("[match-scene] read failed", error);
    return json({ error: "Couldn't load the 3D scene." }, { status: 500 });
  }
  if (!data?.scene_version) return json({ url: null });
  return json({ url: await storage().getSceneUrl(id), version: data.scene_version });
}
