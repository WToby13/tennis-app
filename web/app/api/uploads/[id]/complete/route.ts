import { track } from "@/lib/analytics/server";
import { config } from "@/lib/config";
import { storeForRequest } from "@/lib/request";
import { storage } from "@/lib/storage";
import type { UploadedPart } from "@/lib/storage";
import { badRequest, json, notFound } from "@/lib/util";

export const runtime = "nodejs";

/**
 * Finish a multipart upload.
 * Body: { parts: [{ partNumber, etag, size? }], durationS?, platform?, partRetries? }
 *
 * `platform` and `partRetries` are optional and analytics-only: how many part
 * PUTs had to be retried is the single best measure of whether a long upload on
 * club Wi-Fi still works, and only the client can count them. Older builds omit
 * both and are unaffected.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parts: UploadedPart[] = Array.isArray(body?.parts) ? body.parts : [];
  if (parts.length === 0) return badRequest("parts is required");

  const { store, userId } = await storeForRequest();
  const video = await store.get(id);
  if (!video || !video.uploadId) return notFound("Upload not found");

  await storage().completeMultipart(video.key, video.uploadId, parts);

  // Local backend serves the assembled file directly, so it's immediately ready.
  // On S3, only hold at "processing" if the faststart pipeline is enabled to flip
  // it to "ready"; otherwise mark ready now so uploads are playable immediately.
  const status =
    config.storageBackend === "s3" && config.faststartEnabled ? "processing" : "ready";
  const updated = await store.update(id, {
    status,
    uploadId: null,
    durationS: typeof body?.durationS === "number" ? body.durationS : video.durationS,
  });

  // The match now exists and is watchable. This is the denominator for share
  // rate (docs/GTM.md §6) and the numerator for upload reliability.
  track("upload_completed", {
    userId,
    videoId: id,
    platform: body?.platform === "ios" ? "ios" : "web",
    props: {
      sizeBytes: video.sizeBytes,
      durationS: typeof body?.durationS === "number" ? body.durationS : video.durationS,
      parts: parts.length,
      partRetries: typeof body?.partRetries === "number" ? body.partRetries : 0,
    },
  });

  return json({ video: updated });
}
