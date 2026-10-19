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

/**
 * Our analysis labels the match timeline (the rally breakdown, kind "rally")
 * wherever a worker has posted one, whichever engine ran. TwelveLabs' breakdown
 * is kept alongside under this kind: archived when ours replaces it, and where
 * a TwelveLabs run finishes on a match that already has ours.
 */
export const TWELVELABS_KIND = "rally_twelvelabs";

/** Whether a breakdown is ours (build_segments marks each segment). */
export function isOurBreakdown(segments: { metadata?: Record<string, unknown> | null }[]): boolean {
  return segments.some((s) => s.metadata?.source === "ojo");
}
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

/** Batch is configured for this deployment (infra/analysis_worker.tf). */
function batchTarget(): { queue: string; definition: string } | null {
  const queue = process.env.ANALYSIS_BATCH_JOB_QUEUE;
  const definition = process.env.ANALYSIS_BATCH_JOB_DEFINITION;
  return queue && definition ? { queue, definition } : null;
}

async function batchClient() {
  const { BatchClient } = await import("@aws-sdk/client-batch");
  const { config } = await import("./config");
  return new BatchClient({ region: config.aws.region });
}

/**
 * Start a worker for a queued match: one AWS Batch job (infra/analysis_worker.tf)
 * when ANALYSIS_BATCH_JOB_QUEUE and ANALYSIS_BATCH_JOB_DEFINITION are set. Best
 * effort: if it fails the match stays queued, and the cron sweep submits again
 * (ensureWorkers). Returns false only when a submit was tried and failed.
 *
 * The job is named after the match, but a worker run with `--once` claims
 * whichever match is next (/api/worker/jobs), so the name is a label only.
 */
export async function startWorker(videoId: string): Promise<boolean> {
  const target = batchTarget();
  if (!target) return true;
  try {
    const { SubmitJobCommand } = await import("@aws-sdk/client-batch");
    const client = await batchClient();
    await client.send(
      new SubmitJobCommand({
        jobName: `analysis-${videoId.slice(0, 8)}`,
        jobQueue: target.queue,
        jobDefinition: target.definition,
      }),
    );
    return true;
  } catch (err) {
    // Stable prefix so a log alert can match it.
    console.error("[ojo] worker submit failed; the match stays queued", videoId, err);
    return false;
  }
}

/** Every status of a Batch job that hasn't finished: each will claim, or has claimed, a match. */
const ACTIVE_JOB_STATUSES = ["SUBMITTED", "PENDING", "RUNNABLE", "STARTING", "RUNNING"] as const;

/** Unfinished jobs on the analysis queue, or null if Batch couldn't be asked. */
async function activeWorkerJobs(queue: string): Promise<number | null> {
  try {
    const { ListJobsCommand } = await import("@aws-sdk/client-batch");
    const client = await batchClient();
    let count = 0;
    for (const jobStatus of ACTIVE_JOB_STATUSES) {
      let nextToken: string | undefined;
      do {
        const page = await client.send(new ListJobsCommand({ jobQueue: queue, jobStatus, nextToken }));
        count += page.jobSummaryList?.length ?? 0;
        nextToken = page.nextToken;
      } while (nextToken);
    }
    return count;
  } catch (err) {
    console.error("[ojo] couldn't list analysis jobs; not resubmitting this sweep", err);
    return null;
  }
}

/** Upper bound on submits per sweep, whatever the arithmetic says. */
const MAX_SUBMITS_PER_SWEEP = 5;

/**
 * How many workers to submit: one per claimable match that no unfinished job
 * will pick up. Each job claims exactly one match (`--once`), and a RUNNING job
 * has either claimed one already or is about to, so every unfinished job is
 * counted against the backlog. A job wedged on a match only holds things up
 * until its 4-hour timeout (infra/analysis_worker.tf).
 */
export function workersNeeded(claimable: number, activeJobs: number): number {
  return Math.min(Math.max(claimable - activeJobs, 0), MAX_SUBMITS_PER_SWEEP);
}

export type EnsureWorkersResult = {
  claimable: number;
  activeJobs: number | null;
  submitted: number;
  failed: number;
};

/**
 * Called by the cron sweep: make sure every match waiting for our engine
 * (queued, or claimed by a worker that went quiet; see ojoClaimable) has a
 * Batch job coming for it. Without this, a failed submit when the owner tapped
 * AI Analysis leaves the match queued for good. Idempotent: it submits only
 * the shortfall between claimable matches and unfinished jobs on the queue.
 */
export async function ensureWorkers(
  videos: { id: string; analysisTaskId?: string | null }[],
  now = Date.now(),
): Promise<EnsureWorkersResult> {
  const waiting = videos.filter((v) => ojoClaimable(v.analysisTaskId, now));
  const result: EnsureWorkersResult = { claimable: waiting.length, activeJobs: null, submitted: 0, failed: 0 };
  const target = batchTarget();
  if (!waiting.length || !target) return result;

  result.activeJobs = await activeWorkerJobs(target.queue);
  if (result.activeJobs === null) return result;

  // Oldest first (listInFlightAnalyses' order), only for the job's name.
  for (const video of waiting.slice(0, workersNeeded(waiting.length, result.activeJobs))) {
    if (await startWorker(video.id)) result.submitted++;
    else result.failed++;
  }
  return result;
}
