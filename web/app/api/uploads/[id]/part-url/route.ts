import { storeForRequest } from "@/lib/request";
import { storage } from "@/lib/storage";
import { badRequest, json, notFound } from "@/lib/util";

export const runtime = "nodejs";

/**
 * Get a URL to upload one part directly to storage.
 * Body: { partNumber }  Returns: { url, method, partNumber }
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const partNumber = Number(body?.partNumber);
  if (!Number.isInteger(partNumber) || partNumber < 1) {
    return badRequest("partNumber must be a positive integer");
  }

  const { store } = await storeForRequest();
  const video = await store.get(id);
  if (!video || !video.uploadId) return notFound("Upload not found");

  const { url, method } = await storage().getPartUploadUrl(video.key, video.uploadId, partNumber);
  return json({ url, method, partNumber });
}
