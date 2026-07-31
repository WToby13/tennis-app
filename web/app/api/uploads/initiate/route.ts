import { randomUUID } from "node:crypto";
import { config } from "@/lib/config";
import { storeForRequest } from "@/lib/request";
import { storage } from "@/lib/storage";
import { badRequest, extForContentType, json } from "@/lib/util";

export const runtime = "nodejs";

/**
 * Start a multipart upload.
 * Body: { title, contentType, sizeBytes, recordedAt? }
 * Returns: { videoId, key, uploadId, partSizeBytes }
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body?.title || !body?.contentType || typeof body?.sizeBytes !== "number") {
    return badRequest("title, contentType and sizeBytes are required");
  }

  const { store, userId } = await storeForRequest();

  const videoId = randomUUID();
  const key = `videos/${videoId}.${extForContentType(body.contentType)}`;
  const { uploadId } = await storage().initiateMultipart(key, body.contentType);

  const video = await store.create({
    id: videoId,
    ownerId: userId,
    title: String(body.title),
    key,
    uploadId,
    contentType: String(body.contentType),
    sizeBytes: body.sizeBytes,
    partSizeBytes: config.partSizeBytes,
    durationS: null,
    status: "uploading",
    recordedAt: body.recordedAt ?? null,
    createdAt: new Date().toISOString(),
  });

  return json({
    videoId: video.id,
    key: video.key,
    uploadId,
    partSizeBytes: config.partSizeBytes,
  });
}
