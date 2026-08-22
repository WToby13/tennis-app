import type { VideoSegment } from "../metadata/types";
import { NEAR_OTHER, NEAR_SAME } from "./rally";

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
 * them, and — since `near_player_identity` is only meaningful within its own
 * window — so that the shared stretch contains enough rallies to tell whether
 * two adjacent windows anchored that field to the same player. See
 * `overlapFlip`. The duplicate copies the overlap creates are removed by
 * `mergeWindowSegments`.
 *
 * Stays at 30s, sized against the longest plausible POINT, even though the
 * second job would prefer more. Widening it was tried and measured: a point plus
 * the gap after it runs 20-45s, so 30s holds one rally or none — but 60s holds
 * only one or two, and a seam landing on a changeover (a 70-90s gap, and exactly
 * the seam where the near player actually swaps) can swallow a 120s overlap
 * whole. Across 10 simulated matches x 3 gap regimes, 60s scored identically to
 * 30s to the percentage point, for 25% more billed input instead of 11%.
 *
 * So the link is a bonus when it fires, not the mechanism. What actually
 * recovers the identity track is the per-group fit in ./smooth.ts, which reaches
 * 100% on those same matches with every seam unlinked.
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
  /**
   * Run to the end of the video instead of sending an explicit end_time.
   *
   * Set on the last window, because the duration we plan against and the
   * duration TwelveLabs validates against are not the same number. We know the
   * SOURCE's duration from the upload; the API measures the PROXY it's given,
   * and re-encoding shifts it — a 1903.722s match produced a 1903.567s proxy,
   * and asking for end_time=1904 was rejected outright:
   *
   *   "end_time must not exceed the video duration (1903.567 seconds)"
   *
   * No margin fixes that reliably, since the drift depends on the encode. The
   * last window simply doesn't say where to stop, and `endS` stays for the
   * merge and for display.
   */
  toEnd?: boolean;
  taskId?: string;
  /**
   * How many times this window has been RE-submitted after coming back
   * templated. Absent means it is on its first run. Per-window rather than
   * per-run because a bad window is a local event: the rest of the match
   * usually came back fine and there is no reason to pay for it twice.
   */
  attempt?: number;
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
  const end = Math.floor(durationS);
  const total = end - start;
  if (total <= WINDOW_MIN_SPLIT_S) return [{ startS: start, endS: end, toEnd: true }];

  const windows: AnalysisWindow[] = [];
  const step = WINDOW_S - WINDOW_OVERLAP_S;
  for (let s = start; s < end; s += step) {
    const endS = Math.min(Math.floor(s + WINDOW_S), end);
    windows.push({ startS: Math.floor(s), endS });
    if (endS >= end) break;
  }
  // A final sliver shorter than the overlap carries no rally the previous window
  // doesn't already have.
  if (windows.length > 1) {
    const last = windows[windows.length - 1];
    if (last.endS - last.startS <= WINDOW_OVERLAP_S) windows.pop();
  }
  // Whichever window now ends the match runs to the end of the file rather than
  // to a computed timestamp. See `toEnd`.
  windows[windows.length - 1].toEnd = true;
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
  const length = w.endS > w.startS ? w.endS - w.startS : WINDOW_S;
  const maxEnd = Math.max(...segments.map((s) => s.endS ?? 0));
  const minStart = Math.min(...segments.map((s) => s.startS ?? 0));
  // Both must hold. "Fits inside the window's length" alone is not enough: an
  // ABSOLUTE segment early in window [270,570] ends around 290, which also fits
  // inside 300 and would be shifted a second time. Absolute output additionally
  // can't start before the window does, and that's what separates the two.
  // Where the tests still can't distinguish them — only possible for a segment
  // lying entirely within [startS, length], so at most the first window after
  // the origin — we fall through to absolute, which is the documented behaviour.
  return maxEnd <= length * 1.05 && minStart < w.startS;
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

type Seg = Omit<VideoSegment, "id">;

/** A point's identity answer as a boolean, or null when it didn't give one. */
function relLabel(seg: Seg): boolean | null {
  const v = (seg.metadata ?? {}).near_player_identity;
  if (v === NEAR_SAME) return true;
  if (v === NEAR_OTHER) return false;
  return null;
}

/** Swap `same_as_first` for `other_player` and vice versa. */
function invert(seg: Seg): Seg {
  const rel = relLabel(seg);
  if (rel == null) return seg;
  return {
    ...seg,
    metadata: { ...(seg.metadata ?? {}), near_player_identity: rel ? NEAR_OTHER : NEAR_SAME },
  };
}

/**
 * One shared rally is not evidence — `near_player_identity` is a noisy field and
 * a single disagreement is as likely to be a misread as a real inversion. Two
 * agreeing pairs is the least that can outvote one bad read.
 *
 * Worth keeping high even though it means the link often abstains at a 30s
 * overlap. A WRONG link is worse than no link: it welds two windows into one
 * mistaken frame and removes the free orientation bit that ../smooth.ts would
 * otherwise have used to correct them. Abstaining costs one extra unknown;
 * guessing costs a wrong answer the fit can no longer reach.
 */
const MIN_LINK_VOTES = 2;

/**
 * Whether window B labelled identity the opposite way round from window A.
 *
 * This is the whole reason the overlap is worth paying for. Each window is its
 * own task, and `near_player_identity` is relative to the first point of ITS
 * clip — so `same_as_first` in one window and `same_as_first` in the next are
 * not claims about the same person, and concatenating them (which is what this
 * function used to do implicitly) invents an identity track nobody observed.
 *
 * The overlap fixes that, because the rallies inside it are the SAME physical
 * points scored twice by two models with two different anchors. If both call a
 * shared point `same_as_first`, the two anchors are the same player. If they
 * disagree, the anchors are opposite and B's labels need inverting. That is the
 * only cross-window evidence in a run that isn't the model guessing about a
 * match it never saw.
 *
 * Returns null when the overlap is too thin to decide (or splits evenly), which
 * is a real outcome, not a defensive branch: a seam landing on a changeover has
 * both the longest gap in the match and the fewest rallies to compare. The
 * caller starts a new link group there and leaves the orientation to the
 * structural fit in ../twelvelabs/smooth.ts.
 */
function overlapFlip(a: Seg[], b: Seg[]): boolean | null {
  let same = 0;
  let opposite = 0;
  for (const x of a) {
    const rx = relLabel(x);
    if (rx == null) continue;
    const y = b.find((cand) => isDuplicate(x, cand));
    if (!y) continue;
    const ry = relLabel(y);
    if (ry == null) continue;
    if (rx === ry) same++;
    else opposite++;
  }
  if (same + opposite < MIN_LINK_VOTES || same === opposite) return null;
  return opposite > same;
}

export interface MergedWindows {
  segments: Seg[];
  /**
   * Parallel to `segments`: which link group each one came from. Windows the
   * overlap could chain together share a group and have already been put in a
   * consistent orientation; a break starts a new group, whose orientation
   * relative to the others is unknown and is left for the smoother to fit.
   */
  linkGroups: number[];
}

/**
 * Stitch per-window results into one match-long list: put every segment on the
 * match's clock, reconcile the windows' independent identity labels, order them,
 * and drop the duplicates the overlap produced.
 *
 * `idx` is renumbered at the end because it's the segment's position in the
 * match, and each window numbered its own from zero.
 */
export function mergeWindowSegments(
  results: { window: AnalysisWindow; segments: Seg[] }[],
): MergedWindows {
  // Absolute time first: `overlapFlip` matches rallies by their timestamps, so
  // it can only run once every window is on the match's clock.
  const parts = [...results]
    .sort((x, y) => x.window.startS - y.window.startS)
    .map(({ window, segments }) => {
      const shift = looksRelative(segments, window) ? window.startS : 0;
      return segments.map((s) => ({
        ...s,
        startS: s.startS == null ? null : s.startS + shift,
        endS: s.endS == null ? null : s.endS + shift,
      }));
    });

  // Chain each window to the one before it through their shared rallies. A
  // window whose link can't be resolved opens a new group rather than being
  // guessed at.
  const groupOf: number[] = [];
  const flipped: boolean[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (i === 0) {
      groupOf[i] = 0;
      flipped[i] = false;
      continue;
    }
    const flip = overlapFlip(parts[i - 1], parts[i]);
    if (flip == null) {
      groupOf[i] = groupOf[i - 1] + 1;
      flipped[i] = false; // first window of a new group defines its orientation
    } else {
      groupOf[i] = groupOf[i - 1];
      flipped[i] = flipped[i - 1] !== flip; // XOR: fold into the group's frame
    }
  }

  const all: { seg: Seg; group: number }[] = [];
  for (let i = 0; i < parts.length; i++) {
    for (const seg of parts[i]) {
      all.push({ seg: flipped[i] ? invert(seg) : seg, group: groupOf[i] });
    }
  }

  all.sort(
    (a, b) =>
      (a.seg.startS ?? 0) - (b.seg.startS ?? 0) || (a.seg.endS ?? 0) - (b.seg.endS ?? 0),
  );

  const merged: { seg: Seg; group: number }[] = [];
  for (const entry of all) {
    const prev = merged[merged.length - 1];
    // Keep the earlier window's copy. Which one survives no longer matters for
    // identity — both are in the same frame once the flip above is applied.
    if (prev && isDuplicate(prev.seg, entry.seg)) continue;
    merged.push(entry);
  }

  return {
    segments: merged.map(({ seg }, i) => ({ ...seg, idx: i })),
    linkGroups: merged.map(({ group }) => group),
  };
}
