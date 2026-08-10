import { config } from "./config";
import type { MetadataStore, Video, VideoSegment } from "./metadata/types";
import { storage } from "./storage";
import {
  TwelveLabsApiError,
  createAnalysisTask,
  getAnalysisTask,
} from "./twelvelabs/client";
import { RALLY_KIND, buildRallyRequest } from "./twelvelabs/rally";
import { smoothTennis } from "./twelvelabs/smooth";
import { normalizeSegments } from "./twelvelabs/types";

/**
 * Moving one in-flight analysis forward by a step.
 *
 * There are two callers — the owner's poll (`GET /api/videos/:id/analyze`) and
 * the cron sweep (`/api/cron/advance-analyses`) — and they must behave
 * identically, so the logic lives here rather than in either route. The cron is
 * what makes a run independent of anyone having a page open; the interactive
 * poll just makes it feel immediate.
 *
 * Every step is idempotent and safe to run concurrently with the other caller:
 * the worst case is two pollers seeing the same "ready" task, and the second
 * simply rewrites the same segments.
 */

/** Where a run has got to, for the UI to label. */
export type AnalysisStage = "compressing" | "analysing" | "done";

export function stageOf(video: Video): AnalysisStage {
  if (video.analysisStatus !== "processing") return "done";
  return video.hasAnalysisProxy || video.analysisTaskId ? "analysing" : "compressing";
}

/** Turn a TwelveLabs error code (or raw message) into something worth showing a user. */
export function friendlyAnalyzeError(code: string | undefined, fallback: string): string {
  switch (code) {
    case "video_filesize_too_large":
      return "This match is too large for AI analysis even after compression.";
    case "video_duration_too_long":
      return "This match is too long for AI analysis (max 2 hours).";
    case "usage_limit_exceeded":
      return "The AI analysis usage limit has been reached — try again later.";
    default:
      return fallback || "AI analysis failed. Please try again.";
  }
}

/**
 * Delete a match's analysis proxy once the run is over, whatever the outcome.
 * The proxy exists only to satisfy the size limit; keeping it would mean paying
 * to store every large match twice. Best-effort and idempotent.
 */
export async function discardProxy(store: MetadataStore, video: Video): Promise<void> {
  if (!video.hasAnalysisProxy) return;
  try {
    await storage().deleteAnalysisProxy(video.id);
    await store.update(video.id, { hasAnalysisProxy: false });
  } catch (err) {
    console.warn("[analyze] proxy cleanup failed", video.id, err);
  }
}

/** Smooth the raw per-point segments, store them, and flip the row to ready. */
export async function finalizeReady(
  store: MetadataStore,
  id: string,
  raw: Omit<VideoSegment, "id">[],
): Promise<Video> {
  const { segments, report } = raw.length ? smoothTennis(raw) : { segments: raw, report: null };
  if (report) console.info("[analyze] smoother report", JSON.stringify(report));
  await store.replaceSegments(id, RALLY_KIND, segments);
  return store.update(id, {
    analysisStatus: "ready",
    analyzedAt: new Date().toISOString(),
    analysisError: null,
  });
}

/**
 * Advance one match by whatever step it's due, and return the updated row.
 *
 * - transcoding, proxy not ready yet → nothing to do
 * - transcoding, proxy now ready     → hand it to TwelveLabs
 * - TwelveLabs running               → poll; finalize or fail
 *
 * `stubTaskId` lets the dev stub resolve on the first poll without this module
 * needing to know anything about local mode.
 */
export async function advanceAnalysis(
  store: MetadataStore,
  video: Video,
  opts?: { stubTaskId?: string; onStub?: () => Omit<VideoSegment, "id">[] },
): Promise<Video> {
  if (video.analysisStatus !== "processing") return video;

  // Waiting on the transcoder.
  if (!video.analysisTaskId) {
    if (!video.hasAnalysisProxy || !config.twelvelabs.enabled) return video;
    try {
      const url = await storage().getAnalysisProxyUrl(video.id);
      const task = await createAnalysisTask(buildRallyRequest(url));
      return await store.update(video.id, { analysisTaskId: task.task_id });
    } catch (err) {
      const code = err instanceof TwelveLabsApiError ? err.code : undefined;
      const message = friendlyAnalyzeError(code, err instanceof Error ? err.message : "");
      const failed = await store.update(video.id, {
        analysisStatus: "failed",
        analysisError: message,
      });
      await discardProxy(store, failed);
      return failed;
    }
  }

  // Dev stub resolves immediately.
  if (opts?.stubTaskId && video.analysisTaskId === opts.stubTaskId && opts.onStub) {
    return finalizeReady(store, video.id, opts.onStub());
  }

  try {
    const task = await getAnalysisTask(video.analysisTaskId);
    if (task.status === "ready") {
      const raw = normalizeSegments(task, RALLY_KIND);
      if (raw.length === 0) {
        // Ready but nothing parsed → likely a result-shape mismatch. Log the raw
        // shape (truncated) so it can be diagnosed from server logs.
        console.warn(
          "[analyze] ready task produced 0 segments; raw result:",
          JSON.stringify(task.result)?.slice(0, 2000),
        );
      }
      const done = await finalizeReady(store, video.id, raw);
      await discardProxy(store, done);
      return done;
    }
    if (task.status === "failed") {
      const message =
        (typeof task.error === "string" ? task.error : task.error?.message) ?? "Analysis failed";
      const failed = await store.update(video.id, {
        analysisStatus: "failed",
        analysisError: message,
      });
      await discardProxy(store, failed);
      return failed;
    }
    // Still queued/pending — leave it; the next tick tries again.
    return video;
  } catch (err) {
    // A transient poll error must not wedge the row.
    console.error("[analyze] poll error", video.id, err);
    return video;
  }
}
