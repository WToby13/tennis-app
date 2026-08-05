import { socialForRequest, storeForRequest } from "@/lib/request";
import { storage } from "@/lib/storage";
import { json, notFound } from "@/lib/util";

export const runtime = "nodejs";

/** A public profile: display name, follow state/counts, and the user's viewable matches. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { social, userId } = await socialForRequest();
  const { store } = await storeForRequest();

  const profile = await social.profileSummary(id);
  if (!profile) return notFound("User not found");

  const videos = await store.listByOwner(id);
  const withThumbs = await Promise.all(
    videos.map(async (v) => ({
      id: v.id,
      title: v.title,
      status: v.status,
      durationS: v.durationS,
      sizeBytes: v.sizeBytes,
      createdAt: v.createdAt,
      thumbnailUrl: await storage()
        .getThumbnailUrl(v.id)
        .catch(() => null),
    })),
  );

  return json({ profile, videos: withThumbs, isSelf: Boolean(userId && userId === id) });
}
