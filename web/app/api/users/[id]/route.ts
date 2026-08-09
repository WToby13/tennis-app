import { loadAccount } from "@/lib/library";
import { socialForRequest, storeForRequest } from "@/lib/request";
import { storage } from "@/lib/storage";
import { json, notFound } from "@/lib/util";

export const runtime = "nodejs";

/**
 * A public profile: display name, follow state/counts, and the user's viewable
 * matches. `id` may be the literal `me`, which resolves to the caller — that way
 * a client needing its own profile doesn't have to look up its id first.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: requested } = await params;
  const { social, userId } = await socialForRequest();
  const { store } = await storeForRequest();

  const id = requested === "me" ? userId : requested;
  if (!id) return notFound("User not found");
  const isSelf = Boolean(userId && userId === id);

  const [profile, videos, account] = await Promise.all([
    social.profileSummary(id),
    store.listByOwner(id),
    isSelf ? loadAccount(id) : null,
  ]);
  if (!profile) return notFound("User not found");

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

  return json({ profile, videos: withThumbs, isSelf, account });
}
