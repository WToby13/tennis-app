/**
 * Which engine breaks a match down into rallies, servers and games.
 *
 * ANALYSIS_ENGINE=twelvelabs (the default): today's TwelveLabs pipeline. Our
 * own analysis (ml/) still shows in the "Shot analysis" section when a worker
 * has posted one, so both can be compared side by side.
 *
 * ANALYSIS_ENGINE=own: "AI breakdown" queues a job for our analysis worker
 * instead. The worker pulls jobs (/api/worker/jobs), analyses the match and
 * posts the result (/api/worker/videos/:id/analysis), which fills the same
 * rally breakdown TwelveLabs did.
 *
 * A job is marked by its analysis task id: "ojo:queued" until a worker claims
 * it, then "ojo:running:<when>". The TwelveLabs poller leaves those alone.
 */
export const OJO_QUEUED = "ojo:queued";
export const OJO_RUNNING = "ojo:running:";

/** Claimed but not finished after this long: offered to a worker again. */
export const OJO_STALE_MS = 3 * 60 * 60 * 1000;

export function ownEngine(): boolean {
  return process.env.ANALYSIS_ENGINE === "own";
}

export function isOjoTask(taskId: string | null | undefined): boolean {
  return typeof taskId === "string" && taskId.startsWith("ojo:");
}

/** A job a worker may take: queued, or claimed so long ago its worker died. */
export function ojoClaimable(taskId: string | null | undefined, now = Date.now()): boolean {
  if (taskId === OJO_QUEUED) return true;
  if (taskId?.startsWith(OJO_RUNNING)) {
    const at = Date.parse(taskId.slice(OJO_RUNNING.length));
    return Number.isFinite(at) && now - at > OJO_STALE_MS;
  }
  return false;
}

/**
 * Start a worker for a queued match: one AWS Batch job (infra/analysis_worker.tf)
 * when ANALYSIS_BATCH_JOB_QUEUE and ANALYSIS_BATCH_JOB_DEFINITION are set. Best
 * effort: if it fails the match stays queued for any worker that polls.
 */
export async function startWorker(videoId: string): Promise<void> {
  const queue = process.env.ANALYSIS_BATCH_JOB_QUEUE;
  const definition = process.env.ANALYSIS_BATCH_JOB_DEFINITION;
  if (!queue || !definition) return;
  try {
    const { BatchClient, SubmitJobCommand } = await import("@aws-sdk/client-batch");
    const { config } = await import("./config");
    const client = new BatchClient({ region: config.aws.region });
    await client.send(
      new SubmitJobCommand({ jobName: `analysis-${videoId.slice(0, 8)}`, jobQueue: queue, jobDefinition: definition }),
    );
  } catch (err) {
    console.error("[ojo] couldn't submit the analysis job; it stays queued", videoId, err);
  }
}
