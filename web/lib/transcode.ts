import { ECSClient, RunTaskCommand } from "@aws-sdk/client-ecs";
import { proxyFfmpegArgs } from "./analysisProxy";
import { config } from "./config";
import { analysisProxyKey } from "./storage/types";

/**
 * Kick off a one-shot Fargate task that builds a match's analysis proxy.
 *
 * There's no S3 event or worker queue in front of this: the proxy is only built
 * when someone actually asks for a breakdown, so matches nobody analyses never
 * cost anything to transcode.
 *
 * The container is deliberately dumb — it moves bytes and runs the ffmpeg
 * arguments we hand it, so the encoding spec has exactly one definition
 * (lib/analysisProxy.ts). See infra/transcoder/.
 */
export class TranscodeNotConfiguredError extends Error {}

export function transcodeEnabled(): boolean {
  const t = config.transcode;
  return Boolean(t.cluster && t.taskDefinition && t.subnets.length);
}

export async function startProxyTranscode(video: {
  id: string;
  key: string;
  durationS: number | null;
  sizeBytes: number;
}): Promise<string> {
  const t = config.transcode;
  if (!transcodeEnabled()) {
    throw new TranscodeNotConfiguredError("Video compression isn't configured.");
  }

  // Duration is what sizes the encode. If it's somehow missing, derive a rough
  // one from bytes at the recorder's ~15 Mbps so we still produce something sane
  // rather than falling back to the minimum bitrate for a two-hour match.
  const durationS = video.durationS && video.durationS > 0
    ? video.durationS
    : (video.sizeBytes * 8) / 15_000_000;

  const client = new ECSClient({ region: config.aws.region });
  const res = await client.send(
    new RunTaskCommand({
      cluster: t.cluster,
      taskDefinition: t.taskDefinition,
      launchType: "FARGATE",
      count: 1,
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: t.subnets,
          securityGroups: t.securityGroups.length ? t.securityGroups : undefined,
          // Public IP so the task can reach S3 and Supabase without a NAT
          // gateway, which would cost more per month than the transcoding does.
          assignPublicIp: "ENABLED",
        },
      },
      overrides: {
        containerOverrides: [
          {
            name: t.containerName,
            // ECS takes a string array, so the ffmpeg arguments arrive already
            // tokenised — no shell quoting to get wrong.
            command: proxyFfmpegArgs(durationS),
            environment: [
              { name: "VIDEO_ID", value: video.id },
              { name: "S3_BUCKET", value: config.aws.bucket },
              { name: "SOURCE_KEY", value: video.key },
              { name: "PROXY_KEY", value: analysisProxyKey(video.id) },
            ],
          },
        ],
      },
    }),
  );

  const failure = res.failures?.[0];
  if (failure) throw new Error(`ECS refused the task: ${failure.reason ?? "unknown"}`);
  const arn = res.tasks?.[0]?.taskArn;
  if (!arn) throw new Error("ECS returned no task");
  return arn;
}
