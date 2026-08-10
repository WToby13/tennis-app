import { loadLibrary } from "@/lib/library";
import { json } from "@/lib/util";

export const runtime = "nodejs";

/**
 * List all videos, newest first, each with a (best-effort) thumbnail URL and its
 * derived `matchStatus` (upload / analysis / share) — the one status model both
 * the web app and iOS render. See lib/matchStatus.ts.
 *
 * `matchStatus` is deliberately a NEW field rather than a richer `status`: the
 * existing `status` is a bare string that both clients already decode (iOS as a
 * non-optional String), so replacing it would break them.
 *
 * The library page renders the same payload server-side via `loadLibrary`; this
 * route is what the client re-fetches after uploads and removals.
 */
export async function GET() {
  return json({ videos: await loadLibrary() });
}
