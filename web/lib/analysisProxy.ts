/**
 * The analysis proxy: a smaller re-encode of a match, made solely to get it
 * under TwelveLabs' input limit, and deleted once the breakdown is done.
 *
 * The recipe here was settled empirically, not from the docs — a 33-minute
 * 3.84 GB match was encoded two ways at the same 406 MB and run through the real
 * analysis:
 *
 *   1080p @ ~1.7 Mbps  → results indistinguishable from the original ✅
 *    720p @ ~1.7 Mbps  → the ball is the first thing to go ❌
 *
 * So at a fixed byte budget, spend it on RESOLUTION, not bitrate. The ball is a
 * handful of bright pixels: halving linear resolution loses it outright, while
 * compression noise at full resolution leaves it detectable. Keep the source
 * dimensions and frame rate; lower only the bitrate.
 *
 * (The prompt in ./twelvelabs/rally.ts leans on the overhead serve motion and on
 * the ball crossing the net — posture survives almost anything, the ball does
 * not. That's what makes resolution the axis worth protecting.)
 */

const MIB = 1024 * 1024;

/**
 * The size budget a proxy has to stay inside.
 *
 * TwelveLabs' own docs disagree with themselves — the Pegasus model page says
 * 2 GB, the upload-methods page says 4 GB for public URLs, and the analyze
 * endpoint doesn't say. We stay well under the *lower* figure so it doesn't
 * matter which one the API actually enforces.
 *
 * Nothing computes against this any more: VIDEO_BITRATE is fixed, and the
 * worst case it can produce (2 hours, the API's own duration ceiling) is
 * ~1.53 GB. It's kept as the bound that choice is justified against.
 */
export const PROXY_TARGET_BYTES = 1_600 * MIB; // ~1.68 GB

/**
 * Above this, a match gets a proxy before analysis. Deliberately the
 * conservative end of the doc ambiguity: a needless proxy costs a few minutes of
 * compute, a missed one costs a failed analysis.
 */
export const PROXY_THRESHOLD_BYTES = 1_900 * MIB; // ~1.99 GB

/** Never bother going below this — the result stops being worth analysing. */
const MIN_VIDEO_BITRATE = 800_000;
/** No point re-encoding a match to a higher bitrate than it already has. */
const AUDIO_BITRATE = 96_000;

export function needsAnalysisProxy(sizeBytes: number): boolean {
  return sizeBytes > PROXY_THRESHOLD_BYTES;
}

/**
 * The bitrate the comparison above was actually run at, and what every proxy now
 * gets regardless of duration.
 *
 * This used to be derived from PROXY_TARGET_BYTES / duration, which made it a
 * function of match length: a 33-minute match came out at 6.9 Mbps and a 2-hour
 * one at 1.8 Mbps. That was solving a problem that doesn't exist — TwelveLabs
 * caps input at 2 hours, and 2 hours at this bitrate is ~1.62 GB (video+audio),
 * already inside PROXY_TARGET_BYTES. So one fixed bitrate satisfies the size
 * limit for every input the API will accept. Note the 2-hour case clears it by
 * only ~4%: raising this constant means re-checking that sum.
 *
 * Fixing it also means every match is analysed under identical conditions, which
 * matters more than the bytes: when a breakdown comes back wrong, encode quality
 * is one fewer variable to rule out.
 */
const VIDEO_BITRATE = 1_700_000;

/**
 * Video bitrate (bits/sec) for a proxy, capped at the source's own bitrate so a
 * lightly-encoded match is never re-encoded *upward*.
 *
 * `durationS` no longer affects the answer; it stays in the signature because
 * callers pass it and a future size-aware rule would need it again.
 */
export function proxyVideoBitrate(_durationS: number, sourceBitrate?: number): number {
  const capped =
    sourceBitrate && sourceBitrate > 0 ? Math.min(VIDEO_BITRATE, sourceBitrate) : VIDEO_BITRATE;
  return Math.max(MIN_VIDEO_BITRATE, Math.round(capped));
}

/**
 * The ffmpeg arguments for a proxy encode, as the single definition both the
 * transcoder and any local reproduction should use.
 *
 * `-movflags +faststart` is not incidental: the proxy comes out streamable, so
 * whatever generates it also solves the moov-atom problem for free.
 */
export function proxyFfmpegArgs(durationS: number, sourceBitrate?: number): string[] {
  const v = proxyVideoBitrate(durationS, sourceBitrate);
  return [
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-b:v", `${Math.round(v / 1000)}k`,
    "-maxrate", `${Math.round((v * 1.25) / 1000)}k`,
    "-bufsize", `${Math.round((v * 2.5) / 1000)}k`,
    "-g", "60",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", `${AUDIO_BITRATE / 1000}k`,
    "-movflags", "+faststart",
  ];
}
