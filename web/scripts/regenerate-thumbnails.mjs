/**
 * One-time backfill: (re)generate poster thumbnails for every recording in S3.
 *
 * For each ready video it grabs a frame 60s in — or the last frame for clips
 * shorter than a minute — scales it to fit 640×640, and writes the JPEG to
 * `thumbnails/<id>.jpg`, exactly matching what the iOS recorder and the web
 * uploader produce. Covers both iOS uploads (whose thumbnails were made at 60s
 * on-device) and manual web uploads (which historically had none).
 *
 * It reads the video bytes over a presigned S3 URL and lets ffmpeg range-request
 * only what it needs, so it never downloads a whole match. Idempotent: rerunning
 * simply overwrites, and `--skip-existing` leaves already-thumbnailed videos alone.
 *
 * Requires ffmpeg + ffprobe on PATH, plus these env vars (see web/.env):
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (list videos past RLS)
 *   S3_BUCKET, AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
 *
 * Usage (from web/):
 *   node --env-file=.env scripts/regenerate-thumbnails.mjs --dry-run
 *   node --env-file=.env scripts/regenerate-thumbnails.mjs
 *   node --env-file=.env scripts/regenerate-thumbnails.mjs --skip-existing
 *   node --env-file=.env scripts/regenerate-thumbnails.mjs --id <uuid>
 *
 * Flags:
 *   --dry-run          list what would be generated; touch nothing (no ffmpeg needed)
 *   --skip-existing    skip videos that already have a thumbnail in S3
 *   --id <uuid>        process a single video
 *   --limit <n>        process at most n videos
 *   --concurrency <n>  parallel workers (default 4)
 *   --seconds <n>      poster timestamp in seconds (default 60)
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const execFileP = promisify(execFile);

// --- args --------------------------------------------------------------------
const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const opt = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const DRY = has("--dry-run");
const SKIP_EXISTING = has("--skip-existing");
const ONLY_ID = opt("--id", null);
const LIMIT = opt("--limit") ? Number(opt("--limit")) : Infinity;
const CONCURRENCY = Number(opt("--concurrency", "4"));
const SECONDS = Number(opt("--seconds", "60"));

// --- env ---------------------------------------------------------------------
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = process.env.S3_BUCKET;
const REGION = process.env.AWS_REGION ?? "eu-west-1";

const missing = [
  ["NEXT_PUBLIC_SUPABASE_URL", SUPABASE_URL],
  ["SUPABASE_SERVICE_ROLE_KEY", SERVICE_KEY],
  ["S3_BUCKET", BUCKET],
].filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error(`Missing required env: ${missing.join(", ")}`);
  console.error("Set them in web/.env and run with `node --env-file=.env ...`.");
  process.exit(1);
}

// Fit within 640×640 without upscaling (mirrors iOS AVAssetImageGenerator.maximumSize).
const SCALE = "scale=w='min(640,iw)':h='min(640,ih)':force_original_aspect_ratio=decrease";

const thumbnailKey = (id) => `thumbnails/${id}.jpg`;

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const s3 = new S3Client({ region: REGION });

async function assertFfmpeg() {
  for (const bin of ["ffmpeg", "ffprobe"]) {
    try {
      await execFileP(bin, ["-version"], { maxBuffer: 1 << 20 });
    } catch {
      console.error(`${bin} not found on PATH. Install it (e.g. \`brew install ffmpeg\`).`);
      process.exit(1);
    }
  }
}

async function signedVideoUrl(key) {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn: 3600 });
}

async function thumbExists(id) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: thumbnailKey(id) }));
    return true;
  } catch {
    return false;
  }
}

async function probeDuration(url) {
  try {
    const { stdout } = await execFileP(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", url],
      { maxBuffer: 1 << 20 },
    );
    const d = parseFloat(stdout.trim());
    return Number.isFinite(d) && d > 0 ? d : null;
  } catch {
    return null;
  }
}

/**
 * Extract one JPEG frame. For clips >= SECONDS we input-seek to SECONDS (fast,
 * range-served); shorter clips grab the last frame via `-sseof` + `-update`.
 * When the duration is unknown we try the fast path, then fall back to the last
 * frame in case the clip turns out to be shorter than SECONDS.
 */
async function extractFrame(url, dur) {
  const shortClip = dur != null && dur < SECONDS;
  const lastFrame = (win) => [
    "-y", "-sseof", String(-win), "-i", url, "-vf", SCALE, "-q:v", "3", "-update", "1", "__OUT__",
  ];
  const atSeconds = () => [
    "-y", "-ss", String(SECONDS), "-i", url, "-frames:v", "1", "-vf", SCALE, "-q:v", "3", "__OUT__",
  ];

  const strategies = shortClip
    ? [lastFrame(Math.min(3, Math.max(0.5, dur)))]
    : [atSeconds(), lastFrame(3)]; // fallback covers "duration unknown but actually short"

  for (const strat of strategies) {
    const tmp = join(tmpdir(), `ojo-thumb-${randomUUID()}.jpg`);
    const args = strat.map((a) => (a === "__OUT__" ? tmp : a));
    try {
      await execFileP("ffmpeg", args, { maxBuffer: 16 * 1024 * 1024 });
      const bytes = await readFile(tmp);
      await unlink(tmp).catch(() => {});
      if (bytes.length > 0) return bytes;
    } catch {
      await unlink(tmp).catch(() => {});
    }
  }
  return null;
}

async function processVideo(v, i, total) {
  const tag = `[${i + 1}/${total}] ${v.id}`;
  if (!v.key) {
    console.log(`${tag}  SKIP (no storage key)`);
    return "skip";
  }
  if (SKIP_EXISTING && (await thumbExists(v.id))) {
    console.log(`${tag}  SKIP (thumbnail exists)`);
    return "skip";
  }

  const url = await signedVideoUrl(v.key);
  let dur = v.duration_s ?? null;
  if (!DRY && dur == null) dur = await probeDuration(url);

  const target =
    dur == null
      ? `${SECONDS}s (or last frame if shorter)`
      : dur < SECONDS
        ? `last frame (${dur.toFixed(1)}s clip)`
        : `${SECONDS}s`;

  if (DRY) {
    console.log(`${tag}  would generate @ ${target}`);
    return "dry";
  }

  const bytes = await extractFrame(url, dur);
  if (!bytes) {
    console.log(`${tag}  FAIL (no frame decoded)`);
    return "fail";
  }
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: thumbnailKey(v.id),
      Body: bytes,
      ContentType: "image/jpeg",
    }),
  );
  console.log(`${tag}  OK @ ${target} (${(bytes.length / 1024).toFixed(0)} KB)`);
  return "ok";
}

async function runPool(items, worker, concurrency) {
  const results = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      try {
        results[i] = await worker(items[i], i, items.length);
      } catch (e) {
        console.log(`[${i + 1}/${items.length}] ${items[i].id}  ERROR ${e.message}`);
        results[i] = "fail";
      }
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  if (!DRY) await assertFfmpeg();

  let query = supabase
    .from("videos")
    .select("id, key, duration_s, status")
    .is("deleted_at", null)
    .eq("status", "ready")
    .order("created_at", { ascending: true });
  if (ONLY_ID) query = query.eq("id", ONLY_ID);

  const { data, error } = await query;
  if (error) {
    console.error(`Failed to list videos: ${error.message}`);
    process.exit(1);
  }

  let videos = data ?? [];
  if (Number.isFinite(LIMIT)) videos = videos.slice(0, LIMIT);

  console.log(
    `${DRY ? "[dry-run] " : ""}${videos.length} video(s) — poster @ ${SECONDS}s / last frame` +
      `${SKIP_EXISTING ? ", skipping existing" : ""}, concurrency ${CONCURRENCY}\n`,
  );

  const results = await runPool(videos, processVideo, CONCURRENCY);

  const tally = results.reduce((acc, r) => ((acc[r] = (acc[r] ?? 0) + 1), acc), {});
  console.log(
    `\nDone. ok=${tally.ok ?? 0} skip=${tally.skip ?? 0} fail=${tally.fail ?? 0}` +
      (DRY ? ` dry=${tally.dry ?? 0}` : ""),
  );
  if ((tally.fail ?? 0) > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
