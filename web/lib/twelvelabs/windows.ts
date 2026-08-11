import type { VideoSegment } from "../metadata/types";

/**
 * Splitting a long match into short analysis windows.
 *
 * Measured, on one 31.7-minute match:
 *
 *   whole match in one call  → 95 "rallies" on a perfect 12s/8s grid, one
 *                              identity, four sentences rotated 22/22/22/21.
 *                              The timings were invented.
 *   one 5-minute window      → 14 rallies, irregular realistic timings, and the
 *                              near-player identity flipping exactly at a 45s
 *                              changeover. 55 seconds to run.
 *
 * Pegasus doesn't lose the video, it loses the thread: past some number of
 * segments the cheapest continuation becomes a copy of the last one, and once
 * that starts it's self-reinforcing. Short windows keep every call inside the
 * range where it still describes what it sees.
 *
 * Windows are independent tasks, so they run concurrently — a 32-minute match
 * becomes ~7 calls of about a minute rather than one long degrading one, which
 * is faster as well as better.
 *
 * Cost: TwelveLabs bills per input minute, and the overlap means each minute of
 * match is submitted WINDOW_S / (WINDOW_S - WINDOW_OVERLAP_S) times — about 11%
 * more billed input than a single call. On a 2-hour match that's roughly $0.40.
 */

/** Long enough to hold 2-3 games, short enough to stay well inside the good range. */
export const WINDOW_S = 300;

/**
 * Windows overlap so a rally straddling a boundary is fully contained in one of
 * them. 30s comfortably exceeds the longest plausible point; the duplicate
 * copies this creates are removed by `mergeWindowSegments`.
 */
export const WINDOW_OVERLAP_S = 30;

/**
 * Below this, a match goes in a single call. Splitting a short match would add
 * seam handling for no benefit — the degradation only shows up on long ones.
 */
export const WINDOW_MIN_SPLIT_S = 480;

export interface AnalysisWindow {
  startS: number;
  endS: number;
  taskId?: string;
}

/**
 * The windows to analyse for a match of `durationS`, optionally skipping the
 * first `startAtS` seconds of warm-up. A short match yields exactly one window
 * covering the whole thing, so callers have a single code path.
 */
export function planWindows(durationS: number | null, startAtS = 0): AnalysisWindow[] {
  const start = Math.max(0, Math.floor(startAtS));
  if (!durationS || !Number.isFinite(durationS) || durationS <= start) {
    return [{ startS: start, endS: 0 }]; // unknown duration → one open-ended window
  }
  const total = durationS - start;
  if (total <= WINDOW_MIN_SPLIT_S) return [{ startS: start, endS: Math.ceil(durationS) }];

  const windows: AnalysisWindow[] = [];
  const step = WINDOW_S - WINDOW_OVERLAP_S;
  for (let s = start; s < durationS; s += step) {
    const endS = Math.min(Math.ceil(s + WINDOW_S), Math.ceil(durationS));
    windows.push({ startS: Math.floor(s), endS });
    if (endS >= durationS) break;
  }
  // A final sliver shorter than the overlap carries no rally the previous window
  // doesn't already have.
  const last = windows[windows.length - 1];
  if (windows.length > 1 && last.endS - last.startS <= WINDOW_OVERLAP_S) windows.pop();
  return windows;
}

/**
 * Whether a window's segments came back relative to the window or absolute to
 * the match.
 *
 * TwelveLabs' docs say `start_time` shifts the analysis window and that returned
 * timestamps stay absolute, but that isn't worth betting a whole breakdown on:
 * if it ever returns window-relative times instead, every segment silently lands
 * at the wrong point in the video and the result still *looks* fine. Both are
 * cheap to tell apart — window-relative output is entirely inside the window's
 * own length — so detect rather than assume.
 */
function looksRelative(segments: Omit<VideoSegment, "id">[], w: AnalysisWindow): boolean {
  if (w.startS <= 0 || segments.length === 0) return false;
  const maxEnd = Math.max(...segments.map((s) => s.endS ?? 0));
  const length = w.endS > w.startS ? w.endS - w.startS : WINDOW_S;
  return maxEnd <= length * 1.05;
}

/** True when two segments are near-certainly the same rally seen from two windows. */
function isDuplicate(a: Omit<VideoSegment, "id">, b: Omit<VideoSegment, "id">): boolean {
  const [as, ae] = [a.startS, a.endS];
  const [bs, be] = [b.startS, b.endS];
  if (as == null || ae == null || bs == null || be == null) return false;
  const overlap = Math.min(ae, be) - Math.max(as, bs);
  if (overlap <= 0) return false;
  const shorter = Math.min(ae - as, be - bs);
  return shorter > 0 && overlap / shorter >= 0.5;
}

/**
 * Stitch per-window results into one match-long list: put every segment on the
 * match's clock, order them, and drop the duplicates the overlap produced.
 *
 * `idx` is renumbered at the end because it's the segment's position in the
 * match, and each window numbered its own from zero.
 */
export function mergeWindowSegments(
  results: { window: AnalysisWindow; segments: Omit<VideoSegment, "id">[] }[],
): Omit<VideoSegment, "id">[] {
  const all: Omit<VideoSegment, "id">[] = [];
  for (const { window, segments } of results) {
    const shift = looksRelative(segments, window) ? window.startS : 0;
    for (const s of segments) {
      all.push({
        ...s,
        startS: s.startS == null ? null : s.startS + shift,
        endS: s.endS == null ? null : s.endS + shift,
      });
    }
  }

  all.sort((a, b) => (a.startS ?? 0) - (b.startS ?? 0) || (a.endS ?? 0) - (b.endS ?? 0));

  const merged: Omit<VideoSegment, "id">[] = [];
  for (const seg of all) {
    const prev = merged[merged.length - 1];
    if (prev && isDuplicate(prev, seg)) continue; // keep the earlier window's copy
    merged.push(seg);
  }
  return merged.map((s, i) => ({ ...s, idx: i }));
}
