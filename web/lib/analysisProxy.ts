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
 * The size we aim the proxy at.
 *
 * TwelveLabs' own docs disagree with themselves — the Pegasus model page says
 * 2 GB, the upload-methods page says 4 GB for public URLs, and the analyze
 * endpoint doesn't say. We target well under the *lower* figure so it doesn't
 * matter which one the API actually enforces.
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
 * Video bitrate (bits/sec) for a proxy of `durationS`, sized to land near
 * PROXY_TARGET_BYTES. Longer match → lower bitrate, same resolution.
 *
 * A 2-hour match lands around 1.8 Mbps, close to the 1.7 Mbps that tested clean.
 */
export function proxyVideoBitrate(durationS: number, sourceBitrate?: number): number {
  if (!Number.isFinite(durationS) || durationS <= 0) return MIN_VIDEO_BITRATE;
  const budget = (PROXY_TARGET_BYTES * 8) / durationS - AUDIO_BITRATE;
  const capped = sourceBitrate && sourceBitrate > 0 ? Math.min(budget, sourceBitrate) : budget;
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
