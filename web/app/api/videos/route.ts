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

/** List all videos, newest first, each with a (best-effort) thumbnail URL. */
export async function GET() {
  const { store } = await storeForRequest();
  const videos = await store.list();
  const withThumbs = await Promise.all(
    videos.map(async (v) => ({ ...v, thumbnailUrl: await thumbnailUrl(v.id) })),
  );
  return json({ videos: withThumbs });
}
