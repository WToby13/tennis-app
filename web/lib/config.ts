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

  /**
   * Auth + Supabase metadata turn on automatically once Supabase is configured.
   * With no Supabase env, the app stays in zero-auth local mode for dev.
   */
  authEnabled: Boolean(supabaseUrl && supabaseAnonKey),
};
