import { deriveMatchStatus } from "@/lib/matchStatus";
import { storeForRequest } from "@/lib/request";
import { storage } from "@/lib/storage";
import { json } from "@/lib/util";

export const runtime = "nodejs";

/** A thumbnail URL, or null if storage can't produce one (never fails the list). */
async function thumbnailUrl(id: string): Promise<string | null> {
  try {
    return await storage().getThumbnailUrl(id);
  } catch {
    return null;
  }
}

/**
 * List all videos, newest first, each with a (best-effort) thumbnail URL and its
 * derived `matchStatus` (upload / analysis / share) — the one status model both
 * the web app and iOS render. See lib/matchStatus.ts.
 *
 * `matchStatus` is deliberately a NEW field rather than a richer `status`: the
 * existing `status` is a bare string that both clients already decode (iOS as a
 * non-optional String), so replacing it would break them.
 */
export async function GET() {
  const { store } = await storeForRequest();
  const videos = await store.list();
  const withThumbs = await Promise.all(
    videos.map(async (v) => ({
      ...v,
      thumbnailUrl: await thumbnailUrl(v.id),
      matchStatus: deriveMatchStatus(v, v),
    })),
  );
  return json({ videos: withThumbs });
}
