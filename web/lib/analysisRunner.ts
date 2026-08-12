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
import { type AnalysisWindow, mergeWindowSegments, planWindows } from "./twelvelabs/windows";

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
  const started = video.analysisTaskId || video.analysisWindows?.length;
  return video.hasAnalysisProxy || started ? "analysing" : "compressing";
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
 * Proxies are NOT deleted when a run finishes.
 *
 * They used to be, on the grounds that keeping one means storing a large match
 * twice. But the proxy is the expensive artefact: rebuilding it costs ~16
 * minutes of Fargate for a 32-minute match, and deleting it immediately meant
 * every retry — including retries of runs that failed for reasons that had
 * nothing to do with the video — paid that again. Two failures in a row while
 * iterating on analysis quality made the trade obvious.
 *
 * A bucket lifecycle rule (infra/main.tf) expires `proxies/` after 48 hours
 * instead, so retries within that window are near-instant and nothing is
 * retained indefinitely. A 406 MB proxy costs roughly a cent to hold for two
 * days.
 *
 * The consequence is that `videos.has_analysis_proxy` can outlive the object,
 * so anything about to *use* a proxy must confirm it's still there —
 * `proxyIsAvailable` below, rather than the flag alone.
 */

/**
 * Whether this match's proxy is still usable, correcting the flag if not.
 *
 * Returns false both when no proxy was ever made and when the lifecycle rule has
 * since removed it; either way the caller needs to transcode before analysing.
 */
export async function proxyIsAvailable(store: MetadataStore, video: Video): Promise<boolean> {
  if (!video.hasAnalysisProxy) return false;
  if (await storage().analysisProxyExists(video.id)) return true;
  // Expired out from under us — clear the flag so the next step re-transcodes.
  await store.update(video.id, { hasAnalysisProxy: false });
  return false;
}

/**
 * Smooth the raw per-point segments, store them, and flip the row to ready —
 * unless the raw output shows the model templated its answers, in which case the
 * run is reported as failed.
 *
 * That last part is not defensive coding for a hypothetical: a real 32-minute
 * match came back with one identity, one role and four distinct `what_you_see`
 * strings across 96 points, and no gap over twice the median. The smoother
 * dutifully fitted a structure to it and produced a confident-looking breakdown
 * of a match it had learned nothing about. Showing that is worse than saying the
 * run failed, because there's no way for a viewer to tell it apart from a good
 * one.
 */
export async function finalizeReady(
  store: MetadataStore,
  id: string,
  raw: Omit<VideoSegment, "id">[],
): Promise<Video> {
  const { segments, report } = raw.length ? smoothTennis(raw) : { segments: raw, report: null };
  if (report) console.info("[analyze] smoother report", JSON.stringify(report));

  if (report?.degenerate) {
    console.warn("[analyze] degenerate output — refusing to present it", id, JSON.stringify(report));
    // Leave any previous good result in place rather than replacing it with this.
    return store.update(id, {
      analysisStatus: "failed",
      analysisError:
        "The AI returned the same answer for every point, so the breakdown wouldn't be meaningful. This usually clears on a re-run.",
    });
  }

  await store.replaceSegments(id, RALLY_KIND, segments);
  return store.update(id, {
    analysisStatus: "ready",
    analyzedAt: new Date().toISOString(),
    analysisError: null,
  });
}

/** Fail a run and return the updated row. The proxy is left for a retry. */
async function failRun(store: MetadataStore, video: Video, message: string): Promise<Video> {
  return store.update(video.id, {
    analysisStatus: "failed",
    analysisError: message,
  });
}

/**
 * How many TwelveLabs calls a single match may have in flight at once.
 *
 * Windows are independent, so the temptation is to fire all of them — but a
 * 2-hour match plans 27 windows, and 27 simultaneous creates (then 27 polls
 * every 5 seconds, from both the owner's tab and the cron) is a good way to
 * meet a rate limit. Five keeps a long match comfortably parallel while staying
 * a polite client.
 */
const WINDOW_CONCURRENCY = 5;

/** Run `fn` over `items` a few at a time, preserving order. */
async function inBatches<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += WINDOW_CONCURRENCY) {
    out.push(...(await Promise.all(items.slice(i, i + WINDOW_CONCURRENCY).map(fn))));
  }
  return out;
}

/**
 * Start every window of a match and record their task ids.
 *
 * All-or-nothing: if any window fails to start, the ones that did are abandoned
 * (they're read-only work on TwelveLabs' side and cost nothing to leave) and the
 * run is failed, rather than leaving a match that can never finalize because one
 * of its windows doesn't exist.
 */
export async function startWindows(
  store: MetadataStore,
  video: Video,
  url: string,
  windows: AnalysisWindow[],
): Promise<Video> {
  const started = await inBatches(windows, async (w) => {
    const task = await createAnalysisTask(
      // `toEnd` windows send no end_time at all — see AnalysisWindow.toEnd.
      buildRallyRequest(url, {
        startTimeSec: w.startS,
        endTimeSec: w.toEnd ? undefined : w.endS,
      }),
    );
    return { ...w, taskId: task.task_id };
  });
  // A single window is the ordinary case for a short match; keep it on the
  // simple column so nothing downstream has to care.
  if (started.length === 1) {
    return store.update(video.id, {
      analysisStatus: "processing",
      analysisTaskId: started[0].taskId,
      analysisWindows: null,
      analysisError: null,
    });
  }
  return store.update(video.id, {
    analysisStatus: "processing",
    analysisTaskId: null,
    analysisWindows: started,
    analysisError: null,
  });
}

/**
 * Poll every window of a windowed run. Finalizes only once all of them are
 * ready, so a breakdown is never built from a partial match.
 */
async function advanceWindowed(
  store: MetadataStore,
  video: Video,
  windows: AnalysisWindow[],
): Promise<Video> {
  // Poll a few at a time and stop at the first window that isn't ready: nothing
  // can be finalized until all of them are, so checking the rest is wasted calls
  // against a rate limit. Windows finish at roughly the same time, so the common
  // case is either "the first batch isn't done" or a full sweep at the end.
  const done: { window: AnalysisWindow; task: Awaited<ReturnType<typeof getAnalysisTask>> }[] = [];
  for (let i = 0; i < windows.length; i += WINDOW_CONCURRENCY) {
    const batch = await Promise.all(
      windows.slice(i, i + WINDOW_CONCURRENCY).map(async (w) => ({
        window: w,
        task: await getAnalysisTask(w.taskId as string),
      })),
    );
    const failed = batch.find((t) => t.task.status === "failed");
    if (failed) {
      const err = failed.task.error;
      const message = (typeof err === "string" ? err : err?.message) ?? "Analysis failed";
      return failRun(store, video, message);
    }
    const ready = batch.filter((t) => t.task.status === "ready");
    done.push(...ready);
    if (ready.length < batch.length) break; // not all done — try again next tick
  }

  if (done.length < windows.length) {
    console.info(`[analyze] ${video.id}: ${done.length}/${windows.length} windows ready`);
    return video;
  }

  const merged = mergeWindowSegments(
    done.map(({ window, task }) => ({ window, segments: normalizeSegments(task, RALLY_KIND) })),
  );
  console.info(`[analyze] ${video.id}: merged ${windows.length} windows → ${merged.length} rallies`);
  const ready = await finalizeReady(store, video.id, merged);
  await store.update(video.id, { analysisWindows: null });
  return ready;
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

  const windows = video.analysisWindows?.filter((w) => w.taskId) ?? [];
  if (windows.length) {
    try {
      return await advanceWindowed(store, video, windows);
    } catch (err) {
      // A transient poll error must not wedge the row.
      console.error("[analyze] windowed poll error", video.id, err);
      return video;
    }
  }

  // Waiting on the transcoder.
  if (!video.analysisTaskId) {
    if (!video.hasAnalysisProxy || !config.twelvelabs.enabled) return video;
    try {
      const url = await storage().getAnalysisProxyUrl(video.id);
      return await startWindows(store, video, url, planWindows(video.durationS));
    } catch (err) {
      const code = err instanceof TwelveLabsApiError ? err.code : undefined;
      return failRun(store, video, friendlyAnalyzeError(code, err instanceof Error ? err.message : ""));
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
      return finalizeReady(store, video.id, raw);
    }
    if (task.status === "failed") {
      const message =
        (typeof task.error === "string" ? task.error : task.error?.message) ?? "Analysis failed";
      return store.update(video.id, {
        analysisStatus: "failed",
        analysisError: message,
      });
    }
    // Still queued/pending — leave it; the next tick tries again.
    return video;
  } catch (err) {
    // A transient poll error must not wedge the row.
    console.error("[analyze] poll error", video.id, err);
    return video;
  }
}
