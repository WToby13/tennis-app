import { needsAnalysisProxy } from "@/lib/analysisProxy";
import {
  advanceAnalysis,
  proxyIsAvailable,
  finalizeReady,
  friendlyAnalyzeError,
  stageOf,
  startWindows,
} from "@/lib/analysisRunner";
import { config } from "@/lib/config";
import { storeForRequest } from "@/lib/request";
import { startProxyTranscode, transcodeEnabled } from "@/lib/transcode";
import { storage } from "@/lib/storage";
import type { MetadataStore, Video, VideoSegment } from "@/lib/metadata/types";
import { TwelveLabsApiError, TwelveLabsNotConfiguredError } from "@/lib/twelvelabs/client";
import {
  NEAR_OTHER,
  NEAR_SAME,
  NEAR_UNCLEAR,
  RALLY_KIND,
  SERVE_BOTTOM,
  SERVE_TOP,
} from "@/lib/twelvelabs/rally";
import { planWindows } from "@/lib/twelvelabs/windows";
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

/**
 * Pegasus rejects video over 2 hours whatever it weighs, and unlike size this is
 * a limit compression can't get around — so it's worth failing fast rather than
 * after an hour of transcoding.
 */
const MAX_ANALYSIS_SECONDS = 2 * 60 * 60;

const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;
const hhmm = (s: number) => `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;

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
  // `near` is window-relative now (see NEAR_SAME / NEAR_OTHER in twelvelabs/rally.ts):
  // the stub is a single call, so "first near player of the clip" is game 1's.
  const games = [
    { near: NEAR_SAME, serve: SERVE_BOTTOM, base: 4 }, // game 1: near player serves
    { near: NEAR_SAME, serve: SERVE_TOP, base: 130 }, // game 2: far end serves, near unchanged
    { near: NEAR_OTHER, serve: SERVE_TOP, base: 260 }, // game 3: ends changed → the other is near
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
          what_you_see: `Point ${idx + 1}: near player ${g.serve === SERVE_BOTTOM ? "serves" : "returns"}.`,
          serve_came_from: idx === 2 ? NEAR_UNCLEAR : g.serve, // noise: one unclear serve
          near_player_identity: idx === 5 ? NEAR_UNCLEAR : g.near, // noise: one unclear identity
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

  // Proxies survive a run now (48h, then a bucket lifecycle rule), so a retry
  // can reuse one instead of paying for another ~16-minute transcode. Ask
  // storage rather than trusting the flag: the object may already have expired.
  const hasProxy = await proxyIsAvailable(store, video);

  // Duration is the one limit compression cannot get around: Pegasus rejects
  // video over 2 hours whatever it weighs. Check it before doing an hour of
  // transcoding for a match that can never be analysed.
  if (video.durationS && video.durationS > MAX_ANALYSIS_SECONDS) {
    const msg = `This match is too long for AI analysis (${hhmm(video.durationS)}, max ${hhmm(MAX_ANALYSIS_SECONDS)}).`;
    await store.update(id, { analysisStatus: "failed", analysisError: msg, analysisTaskId: null, analysisWindows: null });
    return json({ analysisStatus: "failed", error: msg }, { status: 400 });
  }

  // Too big to send as-is → compress it first. The match sits in 'processing'
  // with no task id, which is how a poll tells "transcoding" from "analysing"
  // (see GET below) without needing another column.
  //
  // This has to come BEFORE any byte-size rejection. It used to come after, so a
  // 5.6 GB match was turned away with "too large, automatic compression is
  // coming soon" — by the very code path whose whole job is to compress it. The
  // proxy threshold (~2 GB) sits well below MAX_ANALYSIS_BYTES, so anything big
  // enough to worry about is compressible and never reaches that check.
  if (!hasProxy && needsAnalysisProxy(video.sizeBytes)) {
    if (!transcodeEnabled()) {
      const msg = `This match is too large for AI analysis (${gb(video.sizeBytes)}). Automatic compression isn't set up yet.`;
      await store.update(id, { analysisStatus: "failed", analysisError: msg, analysisTaskId: null, analysisWindows: null });
      return json({ analysisStatus: "failed", error: msg }, { status: 503 });
    }
    try {
      await startProxyTranscode(video);
      await store.update(id, {
        analysisStatus: "processing",
        analysisTaskId: null,
        // The window plan is stored now, before the transcode, because this
        // request is the only place that knows `startTimeSec` — the poll that
        // eventually starts the analysis runs minutes later with nothing but the
        // row. Storing it as a plan (windows with no taskId yet) rather than a
        // bare offset also pins the exact slices a retry will use.
        analysisWindows: planWindows(video.durationS, startTimeSec),
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

  // Backstop for the direct path only, now that compression has had its turn:
  // anything reaching here is either under the proxy threshold or already has a
  // proxy, so this should be unreachable. It stays so that a future change to
  // the threshold surfaces as a clear message rather than a raw 400 from the API.
  if (!hasProxy && video.sizeBytes && video.sizeBytes > MAX_ANALYSIS_BYTES) {
    const msg = `This match is too large for AI analysis (${gb(video.sizeBytes)}, max ${gb(MAX_ANALYSIS_BYTES)}).`;
    await store.update(id, { analysisStatus: "failed", analysisError: msg, analysisTaskId: null, analysisWindows: null });
    return json({ analysisStatus: "failed", error: msg }, { status: 400 });
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
    const url = hasProxy
      ? await storage().getAnalysisProxyUrl(video.id)
      : await storage().getPlaybackUrl(video.id, video.key);
    // Long matches go out as several short windows, run concurrently; short ones
    // come back as a single window and take the plain single-task path.
    const windows = planWindows(video.durationS, startTimeSec);
    if (players) await store.update(id, playersPatch);
    await startWindows(store, video, url, windows);
    return json({ analysisStatus: "processing", windows: windows.length });
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
  const { store } = owned;

  // The same step the cron sweep performs — shared so the interactive poll and
  // the background sweep can never disagree about how a run progresses.
  const video = await advanceAnalysis(store, owned.video, {
    stubTaskId: STUB_TASK_ID,
    onStub: stubSegments,
  });

  const segments = await store.getSegments(id, RALLY_KIND).catch(() => []);
  return json({
    analysisStatus: video.analysisStatus,
    analysisError: video.analysisError,
    stage: stageOf(video),
    segments,
  });
}
