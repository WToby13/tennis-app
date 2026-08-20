import { socialForRequest } from "@/lib/request";
import { storage } from "@/lib/storage";
import { json } from "@/lib/util";

export const runtime = "nodejs";

/** Home feed: matches shared by people you follow + your own, newest first. */
export async function GET() {
  const { social, userId } = await socialForRequest();
  const items = await social.getFeed();
  const withThumbs = await Promise.all(
    items.map(async (i) => ({
      ...i,
      thumbnailUrl: await storage()
        .getThumbnailUrl(i.id)
        .catch(() => null),
    })),
  );
  // The viewer's own id, so a card can tell whose match it is showing and hide
  // the report/block menu on the viewer's own posts.
  return json({ feed: withThumbs, viewerId: userId });
}
