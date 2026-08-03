import { storeForRequest } from "@/lib/request";
import { storage } from "@/lib/storage";
import { json, notFound } from "@/lib/util";

export const runtime = "nodejs";

/**
 * Presign a direct upload of a video's poster thumbnail (a JPEG).
 * The recorder PUTs the image straight to storage, same as video parts.
 * Only the owner may upload a thumbnail for their video.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { store, userId } = await storeForRequest();

  const video = await store.get(id);
  if (!video) return notFound("Video not found");
  // In auth mode, restrict to the owner (RLS lets any signed-in user *read* rows).
  if (userId && video.ownerId && video.ownerId !== userId) return notFound("Video not found");

  const { url, method } = await storage().getThumbnailUploadUrl(id);
  return json({ url, method });
}
