import { storeForRequest } from "@/lib/request";
import { storage } from "@/lib/storage";
import { json, notFound } from "@/lib/util";

export const runtime = "nodejs";

/** Parts already uploaded, so the client can resume where it left off. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { store } = await storeForRequest();
  const video = await store.get(id);
  if (!video || !video.uploadId) return notFound("Upload not found");

  const parts = await storage().listParts(video.key, video.uploadId);
  return json({ parts, partSizeBytes: video.partSizeBytes });
}
