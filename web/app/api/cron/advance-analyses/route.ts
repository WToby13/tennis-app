import { advanceAnalysis, stageOf } from "@/lib/analysisRunner";
import { config } from "@/lib/config";
import { metadata } from "@/lib/metadata";
import { getSupabaseServiceRole } from "@/lib/supabase/service";
import { json } from "@/lib/util";

export const runtime = "nodejs";
/** Bounded below; the sweep also self-limits by wall clock (see BUDGET_MS). */
export const maxDuration = 60;

/** Stop starting new work after this, so the function never hits its own ceiling. */
const BUDGET_MS = 45_000;
/** Rows to consider per sweep. The oldest are taken first, so nothing starves. */
const BATCH = 25;

/**
 * Advance every in-flight analysis, independently of anyone having a page open.
 *
 * Without this the pipeline only moves while an owner watches it: `GET /analyze`
 * is what polls TwelveLabs and writes results back, so closing the tab pauses a
 * run and can leave an analysis proxy sitting in S3. This sweep is what makes the
 * pipeline actually asynchronous. The interactive poll still exists — it just
 * makes progress feel immediate rather than being the only thing that drives it.
 *
 * Runs under the service role because there is no caller: it has to see every
 * user's rows. Every step it performs is idempotent, so overlapping with an
 * interactive poll is harmless.
 */
export async function GET(req: Request) {
  // Vercel signs cron invocations with CRON_SECRET. Fail closed: an unprotected
  // endpoint here would let anyone drive other people's analyses.
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("[cron] CRON_SECRET is not set — refusing to run");
    return json({ error: "not configured" }, { status: 503 });
  }
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return json({ error: "unauthorized" }, { status: 401 });
  }

  if (!config.authEnabled) return json({ skipped: "local mode" });

  const started = Date.now();
  const store = metadata(getSupabaseServiceRole(), null, true);

  let inFlight;
  try {
    inFlight = await store.listInFlightAnalyses(BATCH);
  } catch (err) {
    console.error("[cron] couldn't list in-flight analyses", err);
    return json({ error: "list failed" }, { status: 500 });
  }

  const results: Record<string, number> = {};
  let examined = 0;

  for (const video of inFlight) {
    if (Date.now() - started > BUDGET_MS) break; // finish next sweep
    examined++;
    try {
      const after = await advanceAnalysis(store, video);
      const key =
        after.analysisStatus === "processing" ? stageOf(after) : after.analysisStatus;
      results[key] = (results[key] ?? 0) + 1;
    } catch (err) {
      // One bad row must not stop the sweep.
      console.error("[cron] advance failed", video.id, err);
      results.errored = (results.errored ?? 0) + 1;
    }
  }

  const summary = { inFlight: inFlight.length, examined, results, ms: Date.now() - started };
  console.info("[cron] advance-analyses", JSON.stringify(summary));
  return json(summary);
}
