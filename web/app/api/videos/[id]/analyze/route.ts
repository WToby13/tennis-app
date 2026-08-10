import { needsAnalysisProxy } from "@/lib/analysisProxy";
import { config } from "@/lib/config";
import { storeForRequest } from "@/lib/request";
import { startProxyTranscode, transcodeEnabled } from "@/lib/transcode";
import { storage } from "@/lib/storage";
import type { MetadataStore, Video, VideoSegment } from "@/lib/metadata/types";
import {
  TwelveLabsApiError,
  TwelveLabsNotConfiguredError,
  createAnalysisTask,
  getAnalysisTask,
} from "@/lib/twelvelabs/client";
import { RALLY_KIND, buildRallyRequest } from "@/lib/twelvelabs/rally";
import { smoothTennis } from "@/lib/twelvelabs/smooth";
import { type AnalysisTask, normalizeSegments } from "@/lib/twelvelabs/types";
import { badRequest, json, notFound, sanitizePlayers } from "@/lib/util";

export const runtime = "nodejs";

/**
 * Hard ceiling before we even call TwelveLabs, so an oversized match gets a
 * clear message instead of a raw 400.
 *
 * NOTE the docs contradict themselves on the real number: the Pegasus model page
 * says 2 GB, the upload-methods page says 4 GB for public URLs, and the analyze
 * endpoint doesn't state one. 4 GB is kept here because it's what this code was
 * originally written against (apparently from an actual rejection) and lowering
 * it would newly fail matches that work today. The *proxy* threshold in
 * lib/analysisProxy.ts is the conservative one — a match over it gets
 * re-encoded rather than rejected, which sidesteps the ambiguity entirely.
 */
const MAX_ANALYSIS_BYTES = 4_000_000_000; // 4.0 GB (decimal, matches TwelveLabs' units)
const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

/** Turn a TwelveLabs error code (or raw message) into something worth showing a user. */
function friendlyAnalyzeError(code: string | undefined, fallback: string): string {
  switch (code) {
    case "video_filesize_too_large":
      return `This match is too large for AI analysis (max ${gb(MAX_ANALYSIS_BYTES)}). Automatic compression is coming soon.`;
    case "video_duration_too_long":
      return "This match is too long for AI analysis (max 2 hours).";
    case "usage_limit_exceeded":
      return "The AI analysis usage limit has been reached — try again later.";
    default:
      return fallback || "AI analysis failed. Please try again.";
  }
}

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

/**
 * Canned rallies for local dev without a TwelveLabs key. Built in the REAL API
 * response shape (result.data = JSON string keyed by definition id) with the new
 * field schema, so local verification exercises the real parser AND the smoother:
 * 3 games × 4 points, server alternating, near identity flipping after game 2,
 * plus a couple of 'unclear' fields and deliberately-low shot counts.
 */
function stubSegments(): Omit<VideoSegment, "id">[] {
  const games = [
    { near: "player_1", role: "serving", base: 4 }, // game 1: P1 serves, near = P1
    { near: "player_1", role: "receiving", base: 130 }, // game 2: P2 serves, near still P1
    { near: "player_2", role: "receiving", base: 260 }, // game 3: P1 serves, ends changed → near P2
  ];
  const rally: Record<string, unknown>[] = [];
  let idx = 0;
  for (const g of games) {
    let t = g.base;
    for (let p = 0; p < 4; p++) {
      const dur = 8 + p; // 8..11s
      rally.push({
        start_time: t,
        end_time: t + dur,
        metadata: {
          what_you_see: `Point ${idx + 1}: near player ${g.role === "serving" ? "serves" : "returns"}.`,
          near_player_role: idx === 2 ? "unclear" : g.role, // noise: one unclear role
          near_player_identity: idx === 5 ? "unclear" : g.near, // noise: one unclear identity
          times_ball_was_hit: 2 + (p % 3), // deliberately low → exercises the shot floor
        },
      });
      t += dur + 8; // 8s gap within a game (big gaps between games via `base`)
      idx++;
    }
  }
  const task: AnalysisTask = {
    task_id: STUB_TASK_ID,
    status: "ready",
    result: { data: JSON.stringify({ [RALLY_KIND]: rally }) },
  };
  return normalizeSegments(task, RALLY_KIND);
}

/**
 * Drop a match's analysis proxy once the run is over, whatever the outcome.
 *
 * The proxy only ever exists to satisfy TwelveLabs' size limit; keeping it would
 * mean paying to store every match twice. Best-effort and idempotent — if the
 * delete fails the flag stays set and the next terminal state retries it.
 */
async function discardProxy(store: MetadataStore, video: Video): Promise<void> {
  if (!video.hasAnalysisProxy) return;
  try {
    await storage().deleteAnalysisProxy(video.id);
    await store.update(video.id, { hasAnalysisProxy: false });
  } catch (err) {
    console.warn("[analyze] proxy cleanup failed", video.id, err);
  }
}

/**
 * Shared "task is ready" finalize: run the structural smoother over the raw
 * per-point segments, store the cleaned result, and flip the row to ready.
 * Returns the updated video.
 */
async function finalizeReady(
  store: MetadataStore,
  id: string,
  raw: Omit<VideoSegment, "id">[],
): Promise<Video> {
  const { segments, report } = raw.length
    ? smoothTennis(raw)
    : { segments: raw, report: null };
  if (report) console.info("[analyze] smoother report", JSON.stringify(report));
  await store.replaceSegments(id, RALLY_KIND, segments);
  return store.update(id, {
    analysisStatus: "ready",
    analyzedAt: new Date().toISOString(),
    analysisError: null,
  });
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

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const owned = await ownedVideo(id);
  if (!owned) return notFound("Video not found");
  const { store, video } = owned;

  if (video.status !== "ready") return badRequest("This match isn't ready to analyze yet.");

  // Optional warm-up trim: analyse only from this second onward.
  const body = await req.json().catch(() => null);
  const startTimeSec =
    typeof body?.startTimeSec === "number" && body.startTimeSec > 0 ? body.startTimeSec : undefined;
  // Optional owner-assigned player names, persisted with the analysis.
  const players = body?.players ? sanitizePlayers(body.players) : null;
  const playersPatch = players ? { analysisPlayers: players } : {};

  // Pre-flight size guard: skip the call (and the raw 400) for oversized files.
  // A match with a proxy is exempt — the proxy is what gets sent, and it's sized
  // to fit by construction.
  if (!video.hasAnalysisProxy && video.sizeBytes && video.sizeBytes > MAX_ANALYSIS_BYTES) {
    const msg = `This match is too large for AI analysis (${gb(video.sizeBytes)}, max ${gb(MAX_ANALYSIS_BYTES)}). Automatic compression is coming soon.`;
    await store.update(id, { analysisStatus: "failed", analysisError: msg, analysisTaskId: null });
    return json({ analysisStatus: "failed", error: msg }, { status: 400 });
  }

  // Too big to send as-is → compress it first. The match sits in 'processing'
  // with no task id, which is how a poll tells "transcoding" from "analysing"
  // (see GET below) without needing another column.
  if (!video.hasAnalysisProxy && needsAnalysisProxy(video.sizeBytes)) {
    if (!transcodeEnabled()) {
      const msg = `This match is too large for AI analysis (${gb(video.sizeBytes)}). Automatic compression isn't set up yet.`;
      await store.update(id, { analysisStatus: "failed", analysisError: msg, analysisTaskId: null });
      return json({ analysisStatus: "failed", error: msg }, { status: 503 });
    }
    try {
      await startProxyTranscode(video);
      await store.update(id, {
        analysisStatus: "processing",
        analysisTaskId: null,
        analysisError: null,
        ...playersPatch,
      });
      return json({ analysisStatus: "processing", stage: "compressing" });
    } catch (err) {
      const msg = "Couldn't start compressing this match. Please try again.";
      console.error("[analyze] transcode start failed", err);
      await store.update(id, { analysisStatus: "failed", analysisError: msg });
      return json({ analysisStatus: "failed", error: msg }, { status: 502 });
    }
  }

  // Dev stub: no key + local mode → mark processing with a stub task id.
  if (!config.twelvelabs.enabled) {
    if (config.authEnabled) return json({ error: "AI analysis isn't configured." }, { status: 503 });
    await store.update(id, {
      analysisStatus: "processing",
      analysisTaskId: STUB_TASK_ID,
      analysisError: null,
      ...playersPatch,
    });
    return json({ analysisStatus: "processing" });
  }

  try {
    // Analyse the proxy when one exists — it's the same match at a size the API
    // will accept. Empirically the breakdown is indistinguishable from the
    // original at full resolution; see lib/analysisProxy.ts.
    const url = video.hasAnalysisProxy
      ? await storage().getAnalysisProxyUrl(video.id)
      : await storage().getPlaybackUrl(video.id, video.key);
    const task = await createAnalysisTask(buildRallyRequest(url, { startTimeSec }));
    await store.update(id, {
      analysisStatus: "processing",
      analysisTaskId: task.task_id,
      analysisError: null,
      ...playersPatch,
    });
    return json({ analysisStatus: "processing" });
  } catch (err) {
    if (err instanceof TwelveLabsNotConfiguredError) {
      return json({ error: "AI analysis isn't configured." }, { status: 503 });
    }
    const code = err instanceof TwelveLabsApiError ? err.code : undefined;
    const message = friendlyAnalyzeError(code, err instanceof Error ? err.message : "");
    await store.update(id, { analysisStatus: "failed", analysisError: message });
    return json({ analysisStatus: "failed", error: message }, { status: 502 });
  }
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const owned = await ownedVideo(id);
  if (!owned) return notFound("Video not found");
  let { store, video } = owned;

  // Processing with no task id means the Fargate transcoder is still building the
  // proxy. Once it flips has_analysis_proxy, hand the proxy to TwelveLabs and the
  // normal polling below takes over from the next tick.
  if (video.analysisStatus === "processing" && !video.analysisTaskId) {
    if (video.hasAnalysisProxy && config.twelvelabs.enabled) {
      try {
        const url = await storage().getAnalysisProxyUrl(video.id);
        const task = await createAnalysisTask(buildRallyRequest(url));
        video = await store.update(id, { analysisTaskId: task.task_id });
      } catch (err) {
        const code = err instanceof TwelveLabsApiError ? err.code : undefined;
        const message = friendlyAnalyzeError(code, err instanceof Error ? err.message : "");
        video = await store.update(id, { analysisStatus: "failed", analysisError: message });
        await discardProxy(store, video);
      }
    }
    // Otherwise the transcode is still running — the client keeps polling.
    return json({
      analysisStatus: video.analysisStatus,
      analysisError: video.analysisError,
      stage: video.hasAnalysisProxy ? "analysing" : "compressing",
      segments: [],
    });
  }

  // Advance a processing task.
  if (video.analysisStatus === "processing" && video.analysisTaskId) {
    if (video.analysisTaskId === STUB_TASK_ID) {
      // Dev stub: resolve to canned rallies on first poll.
      video = await finalizeReady(store, id, stubSegments());
    } else {
      try {
        const task = await getAnalysisTask(video.analysisTaskId);
        if (task.status === "ready") {
          const raw = normalizeSegments(task, RALLY_KIND);
          if (raw.length === 0) {
            // Ready but nothing parsed → likely a result-shape mismatch. Log the
            // raw shape (truncated) so it can be diagnosed from server logs.
            console.warn(
              "[analyze] ready task produced 0 segments; raw result:",
              JSON.stringify(task.result)?.slice(0, 2000),
            );
          }
          video = await finalizeReady(store, id, raw);
          await discardProxy(store, video); // the run is over — stop paying to store it twice
        } else if (task.status === "failed") {
          const message =
            (typeof task.error === "string" ? task.error : task.error?.message) ??
            "Analysis failed";
          video = await store.update(id, { analysisStatus: "failed", analysisError: message });
          await discardProxy(store, video);
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
