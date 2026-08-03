import { storeForRequest } from "@/lib/request";
import { storage } from "@/lib/storage";
import { json, notFound } from "@/lib/util";

export const runtime = "nodejs";

/** Delete a video and its stored assets. Owner-only. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { store, userId } = await storeForRequest();

  const video = await store.get(id);
  if (!video) return notFound("Video not found");
  if (userId && video.ownerId && video.ownerId !== userId) return notFound("Video not found");

  await storage().deleteVideoAssets(video.id, video.key);
  await store.delete(video.id); // RLS also enforces owner-only delete in auth mode

  return json({ ok: true });
}

/** Video detail, including a playback URL once it's ready. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { store } = await storeForRequest();
  const video = await store.get(id);
  if (!video) return notFound("Video not found");

  const playbackUrl =
    video.status === "ready" ? await storage().getPlaybackUrl(video.id, video.key) : null;

  const thumbnailUrl = await storage()
    .getThumbnailUrl(video.id)
    .catch(() => null);

  return json({ video, playbackUrl, thumbnailUrl });
}
