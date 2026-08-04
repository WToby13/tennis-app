import { randomUUID } from "node:crypto";
import { config } from "@/lib/config";
import { sendParticipantInvites } from "@/lib/email/invites";
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
    visibility: "private",
    recordedAt: body.recordedAt ?? null,
    createdAt: new Date().toISOString(),
    deletedAt: null,
  });

  // Optional participants chosen in the recorder's post-record shelf.
  if (Array.isArray(body.participants) && body.participants.length) {
    const clean = body.participants
      .map((p: Record<string, unknown>) => ({
        userId: typeof p?.userId === "string" && p.userId ? p.userId : null,
        displayName: typeof p?.displayName === "string" ? p.displayName.trim() : "",
        email:
          typeof p?.email === "string" && p.email.trim() ? p.email.trim().toLowerCase() : null,
      }))
      .filter((p: { displayName: string }) => p.displayName.length > 0);
    if (clean.length) {
      await store.setParticipants(video.id, clean).catch(() => {});
      const emails = clean
        .filter((p: { userId: string | null; email: string | null }) => p.userId === null && p.email)
        .map((p: { email: string | null }) => p.email as string);
      if (emails.length) {
        await sendParticipantInvites({ videoId: video.id, matchTitle: video.title, emails });
      }
    }
  }

  return json({
    videoId: video.id,
    key: video.key,
    uploadId,
    partSizeBytes: config.partSizeBytes,
  });
}
