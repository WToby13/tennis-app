import { config } from "@/lib/config";
import { storeForRequest } from "@/lib/request";
import { storage } from "@/lib/storage";
import type { MetadataStore, Video, VideoSegment } from "@/lib/metadata/types";
import {
  TwelveLabsNotConfiguredError,
  createAnalysisTask,
  getAnalysisTask,
} from "@/lib/twelvelabs/client";
import { RALLY_KIND, buildRallyRequest } from "@/lib/twelvelabs/rally";
import { normalizeSegments } from "@/lib/twelvelabs/types";
import { badRequest, json, notFound } from "@/lib/util";

export const runtime = "nodejs";

/**
 * AI rally segmentation (TwelveLabs). Owner-only.
 *  POST → start an analysis (mint a video URL, create a TwelveLabs task).
 *  GET  → poll: advance a processing task, writing segments back when it's ready.
 *
 * There's no background worker; the authenticated owner's poll drives the state
 * machine, so all writes happen under their session/RLS (no service role needed).
 * The watch page polls the GET every few seconds while status is 'processing'.
 *
 * When no API key is set: in local dev mode we fall back to a canned stub so the
 * UI can be exercised end-to-end; in auth mode we return a clear 503.
 */

const STUB_TASK_ID = "stub-task";

/** Canned rallies for local dev without a TwelveLabs key. */
function stubSegments(): Omit<VideoSegment, "id">[] {
  const rallies = [
    { startS: 4, endS: 18, serving_player: "near_bottom" },
    { startS: 26, endS: 33, serving_player: "cannot_tell" },
    { startS: 41, endS: 58, serving_player: "near_bottom" },
    { startS: 66, endS: 72, serving_player: "far_top" },
  ];
  return rallies.map((r, idx) => ({
    kind: RALLY_KIND,
    idx,
    startS: r.startS,
    endS: r.endS,
    metadata: {
      what_you_see: "Stub rally for local dev (no TwelveLabs key set).",
      serving_player: r.serving_player,
    },
  }));
}

/** Resolve + owner-check the video for the caller. Returns null on no-access. */
async function ownedVideo(
  id: string,
): Promise<{ store: MetadataStore; userId: string | null; video: Video } | null> {
  const { store, userId } = await storeForRequest();
  const video = await store.get(id);
  if (!video) return null;
  // Owner-only (local no-auth mode has no userId, so it's allowed).
  if (userId && video.ownerId && video.ownerId !== userId) return null;
  return { store, userId, video };
}

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const owned = await ownedVideo(id);
  if (!owned) return notFound("Video not found");
  const { store, video } = owned;

  if (video.status !== "ready") return badRequest("This match isn't ready to analyze yet.");

  // Dev stub: no key + local mode → mark processing with a stub task id.
  if (!config.twelvelabs.enabled) {
    if (config.authEnabled) return json({ error: "AI analysis isn't configured." }, { status: 503 });
    await store.update(id, {
      analysisStatus: "processing",
      analysisTaskId: STUB_TASK_ID,
      analysisError: null,
    });
    return json({ analysisStatus: "processing" });
  }

  try {
    const url = await storage().getPlaybackUrl(video.id, video.key);
    const task = await createAnalysisTask(buildRallyRequest(url));
    await store.update(id, {
      analysisStatus: "processing",
      analysisTaskId: task.task_id,
      analysisError: null,
    });
    return json({ analysisStatus: "processing" });
  } catch (err) {
    if (err instanceof TwelveLabsNotConfiguredError) {
      return json({ error: "AI analysis isn't configured." }, { status: 503 });
    }
    const message = err instanceof Error ? err.message : "Failed to start analysis";
    await store.update(id, { analysisStatus: "failed", analysisError: message });
    return json({ analysisStatus: "failed", error: message }, { status: 502 });
  }
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const owned = await ownedVideo(id);
  if (!owned) return notFound("Video not found");
  let { store, video } = owned;

  // Advance a processing task.
  if (video.analysisStatus === "processing" && video.analysisTaskId) {
    if (video.analysisTaskId === STUB_TASK_ID) {
      // Dev stub: resolve to canned rallies on first poll.
      await store.replaceSegments(id, RALLY_KIND, stubSegments());
      video = await store.update(id, {
        analysisStatus: "ready",
        analyzedAt: new Date().toISOString(),
        analysisError: null,
      });
    } else {
      try {
        const task = await getAnalysisTask(video.analysisTaskId);
        if (task.status === "ready") {
          await store.replaceSegments(id, RALLY_KIND, normalizeSegments(task, RALLY_KIND));
          video = await store.update(id, {
            analysisStatus: "ready",
            analyzedAt: new Date().toISOString(),
            analysisError: null,
          });
        } else if (task.status === "failed") {
          const message =
            (typeof task.error === "string" ? task.error : task.error?.message) ??
            "Analysis failed";
          video = await store.update(id, { analysisStatus: "failed", analysisError: message });
        }
        // else still queued/pending/processing — leave as is; the client re-polls.
      } catch (err) {
        // Transient poll errors shouldn't wedge the row; report but keep processing.
        console.error("[analyze] poll error", err);
      }
    }
  }

  const segments = await store.getSegments(id, RALLY_KIND).catch(() => []);
  return json({
    analysisStatus: video.analysisStatus,
    analysisError: video.analysisError,
    segments,
  });
}
