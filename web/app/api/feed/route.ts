import { socialForRequest } from "@/lib/request";
import { storage } from "@/lib/storage";
import { json } from "@/lib/util";

export const runtime = "nodejs";

/** Home feed: matches shared by people you follow + your own, newest first. */
export async function GET() {
  const { social } = await socialForRequest();
  const items = await social.getFeed();
  const withThumbs = await Promise.all(
    items.map(async (i) => ({
      ...i,
      thumbnailUrl: await storage()
        .getThumbnailUrl(i.id)
        .catch(() => null),
    })),
  );
  return json({ feed: withThumbs });
}
