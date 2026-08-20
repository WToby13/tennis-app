/** Decode a private key that may be supplied as raw PEM or base64-encoded PEM. */
function readPrivateKey(raw: string | undefined): string {
  if (!raw) return "";
  if (raw.includes("BEGIN")) return raw.replaceAll("\\n", "\n");
  // Base64 is the friendly way to put a multi-line PEM in a single env var.
  try {
    return Buffer.from(raw, "base64").toString("utf8");
  } catch {
    return raw;
  }
}

const cloudfrontDomain = process.env.CLOUDFRONT_DOMAIN ?? "";
const keyPairId = process.env.CLOUDFRONT_KEY_PAIR_ID ?? "";
const privateKey = readPrivateKey(process.env.CLOUDFRONT_PRIVATE_KEY);

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

/**
 * Part size for a multipart upload of `sizeBytes`.
 *
 * Every part costs a `/part-url` round trip before its bytes can move, so a fixed
 * 8 MB part size means ~750 sequential presigns for a 6 GB match — minutes of
 * latency before the first byte, and presigned URLs (1 h TTL) that can expire
 * before their turn comes up. Scaling the part size keeps the count bounded.
 *
 * S3 allows 10,000 parts at a 5 MiB minimum; the 300 target leaves plenty of
 * headroom while keeping each chunk small enough to buffer comfortably.
 */
const MIB = 1024 * 1024;
const TARGET_PARTS = 300;
const MAX_PART_SIZE = 512 * MIB;

export function partSizeFor(sizeBytes: number, base: number): number {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return base;
  const needed = Math.ceil(sizeBytes / TARGET_PARTS);
  const rounded = Math.ceil(needed / MIB) * MIB; // whole MiB parts
  return Math.min(MAX_PART_SIZE, Math.max(base, rounded));
}

export const config = {
  storageBackend: (process.env.STORAGE_BACKEND ?? "local") as "local" | "s3",
  partSizeBytes: Number(process.env.PART_SIZE_BYTES ?? 8 * 1024 * 1024),

  /**
   * When true, `complete` marks a video "processing" and something downstream
   * (the faststart Lambda) flips it to "ready". Leave false until that pipeline
   * exists, so S3 uploads become playable immediately.
   */
  faststartEnabled: process.env.FASTSTART_ENABLED === "true",

  aws: {
    region: process.env.AWS_REGION ?? "eu-west-1",
    bucket: process.env.S3_BUCKET ?? "",
  },

  cloudfront: {
    domain: cloudfrontDomain,
    keyPairId,
    privateKey,
    /** Sign playback URLs when we have both a key pair id and a private key. */
    signUrls: Boolean(keyPairId && privateKey),
    signedUrlTtlSeconds: Number(process.env.CLOUDFRONT_URL_TTL_SECONDS ?? 6 * 60 * 60),
  },

  supabase: {
    url: supabaseUrl,
    anonKey: supabaseAnonKey,
  },

  /** Public base URL, for links in emails and elsewhere. */
  appUrl: process.env.NEXT_PUBLIC_APP_URL ?? "https://ojotennis.com",

  /** Transactional email via Resend. Sending is a no-op until the API key is set. */
  email: {
    resendApiKey: process.env.RESEND_API_KEY ?? "",
    from: process.env.EMAIL_FROM ?? "Ojo Tennis <no-reply@ojotennis.com>",
    enabled: Boolean(process.env.RESEND_API_KEY),

    /**
     * Inbound mail, forwarded to a real inbox by `/api/inbound`.
     *
     * The published addresses (`support@`, `privacy@`) have to reach a human —
     * they are in the privacy policy, the terms and the App Store listing.
     * Resend receives them and raises a webhook; the route turns that into a
     * forward. `from` must be on the verified sending domain, because the
     * forward is a fresh send: the original sender's address goes in Reply-To,
     * not in From, or the message fails SPF and lands in spam.
     */
    inbound: {
      webhookSecret: process.env.RESEND_WEBHOOK_SECRET ?? "",
      forwardTo: process.env.INBOUND_FORWARD_TO ?? "",
      from: process.env.INBOUND_FORWARD_FROM ?? "Ojo Tennis <no-reply@ojotennis.com>",
      /**
       * Its own key, because forwarding has to *read* the received message and
       * `RESEND_API_KEY` is deliberately sending-only — it fails this call with
       * `restricted_api_key`. Rather than widen the key that every outbound
       * email uses, inbound gets a full-access one of its own. Falls back to
       * the main key so the wiring still works if you would rather use one.
       */
      apiKey: process.env.RESEND_INBOUND_API_KEY || process.env.RESEND_API_KEY || "",
      /**
       * The only domain this deployment forwards mail for.
       *
       * Resend webhooks cannot be scoped to a domain — a webhook is an endpoint
       * plus a list of events — so if the Resend account holds more than one
       * domain, every endpoint on it is called for every inbound message. This
       * is what keeps another project's mail out of Ojo's forwarder and out of
       * Ojo's logs.
       */
      domain: process.env.INBOUND_DOMAIN ?? "ojotennis.com",
    },
  },

  /**
   * Where content reports are emailed. Every report is written to
   * `content_reports` regardless — this is only the nudge that gets them looked
   * at, and the App Store listing commits to acting on one within 24 hours. If
   * it's unset the route says so loudly in the logs rather than failing the
   * report, because losing the user's flag is the worse outcome.
   */
  moderation: {
    reportsTo: process.env.MODERATION_EMAIL ?? "",
  },

  /**
   * TwelveLabs video AI (rally segmentation). Analysis is a no-op / degrades to a
   * dev stub until the API key is set, so local dev works without it.
   */
  twelvelabs: {
    apiKey: process.env.TWELVELABS_API_KEY ?? "",
    baseUrl: process.env.TWELVELABS_BASE_URL ?? "https://api.twelvelabs.io/v1.3",
    enabled: Boolean(process.env.TWELVELABS_API_KEY),
  },

  /**
   * Fargate transcoder that builds analysis proxies (see lib/transcode.ts and
   * infra/transcoder/). Unset in dev — a match too large to analyse then just
   * reports that, rather than silently doing nothing.
   */
  transcode: {
    cluster: process.env.TRANSCODE_ECS_CLUSTER ?? "",
    taskDefinition: process.env.TRANSCODE_TASK_DEFINITION ?? "",
    containerName: process.env.TRANSCODE_CONTAINER_NAME ?? "transcoder",
    subnets: (process.env.TRANSCODE_SUBNETS ?? "").split(",").filter(Boolean),
    securityGroups: (process.env.TRANSCODE_SECURITY_GROUPS ?? "").split(",").filter(Boolean),
  },

  /**
   * Auth + Supabase metadata turn on automatically once Supabase is configured.
   * With no Supabase env, the app stays in zero-auth local mode for dev.
   */
  authEnabled: Boolean(supabaseUrl && supabaseAnonKey),
};
