import { storeForRequest } from "@/lib/request";
import { storage } from "@/lib/storage";
import { json, notFound } from "@/lib/util";

export const runtime = "nodejs";

/** Video detail, including a playback URL once it's ready. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { store } = await storeForRequest();
  const video = await store.get(id);
  if (!video) return notFound("Video not found");

  const playbackUrl =
    video.status === "ready" ? await storage().getPlaybackUrl(video.id, video.key) : null;

  return json({ video, playbackUrl });
}
