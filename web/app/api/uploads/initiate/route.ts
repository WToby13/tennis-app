import { randomUUID } from "node:crypto";
import { track } from "@/lib/analytics/server";
import { config, partSizeFor } from "@/lib/config";
import { cleanParticipants, saveParticipants } from "@/lib/participants";
import { storeForRequest } from "@/lib/request";
import { storage } from "@/lib/storage";
import { getSupabaseServer } from "@/lib/supabase/server";
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

  // Scale the part size to the file so a long match doesn't turn into hundreds
  // of presign round trips before a single byte moves. Both clients upload with
  // whatever we return here.
  const partSizeBytes = partSizeFor(body.sizeBytes, config.partSizeBytes);

  const video = await store.create({
    id: videoId,
    ownerId: userId,
    title: String(body.title),
    key,
    uploadId,
    contentType: String(body.contentType),
    sizeBytes: body.sizeBytes,
    partSizeBytes,
    durationS: null,
    status: "uploading",
    visibility: "private",
    recordedAt: body.recordedAt ?? null,
    createdAt: new Date().toISOString(),
    deletedAt: null,
    analysisStatus: "none",
    analysisTaskId: null,
    analysisWindows: null,
    analysisError: null,
    analyzedAt: null,
    analysisPlayers: null,
    hasAnalysisProxy: false,
  });

  // Players chosen in the recorder's post-record shelf. Same path the web editor
  // takes, so an invite behaves identically whichever end it was typed at.
  //
  // Failures here must not sink the upload — the bytes are the point, and the
  // player list is editable afterwards — but they are no longer swallowed
  // silently: `invites` reports back so the recorder can show what happened.
  let invites: Awaited<ReturnType<typeof saveParticipants>>["invites"] = [];
  const clean = cleanParticipants(body.participants);
  if (clean.length) {
    try {
      ({ invites } = await saveParticipants({
        store,
        supabase: config.authEnabled ? await getSupabaseServer() : null,
        userId,
        videoId: video.id,
        matchTitle: video.title,
        participants: clean,
        before: [],
      }));
    } catch (err) {
      console.error("[initiate] saving participants failed", err);
    }
  }

  // The denominator for upload reliability. Recorded from here rather than from
  // the client so it means "a multipart upload was genuinely created", which is
  // the thing `upload_completed` is measured against.
  track("upload_started", {
    userId,
    videoId: video.id,
    props: {
      sizeBytes: body.sizeBytes,
      partSizeBytes,
      parts: Math.ceil(body.sizeBytes / partSizeBytes),
      contentType: String(body.contentType),
    },
  });

  return json({
    videoId: video.id,
    key: video.key,
    uploadId,
    partSizeBytes,
    invites,
  });
}
