import { storeForRequest } from "@/lib/request";
import { json, notFound } from "@/lib/util";

export const runtime = "nodejs";

/**
 * Mint (or reuse) a revocable share link for a video the caller owns.
 * Returns a token; the client builds the absolute `/watch/<id>?s=<token>` URL.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { store, userId } = await storeForRequest();

  const video = await store.get(id);
  if (!video) return notFound("Video not found");
  if (userId && video.ownerId && video.ownerId !== userId) return notFound("Video not found");

  const { token } = await store.createShareLink(id, userId);
  return json({ token, path: `/watch/${id}?s=${token}` });
}
