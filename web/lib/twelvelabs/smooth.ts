import type { VideoSegment } from "../metadata/types";
import { NEAR_OTHER, NEAR_SAME, SERVE_BOTTOM, SERVE_TOP, SWAP_YES } from "./rally";

/**
 * Post-processing smoother for TwelveLabs tennis rally segmentation — a faithful
 * TypeScript port of smooth_tennis.py (see docs/twelvelabs-tennis-handover.md §3).
 *
 * The model's per-point guesses are noisy but a match is rigidly structured, so
 * we fit that structure to the votes:
 *   - the server ALTERNATES every game;
 *   - a game (one player's service turn) is >= 4 points;
 *   - serve_came_from == "bottom"  iff  the near player is the server;
 *   - players change ends every 2 games, so near identity is constant for ~2
 *     games then flips.
 * The whole match is fixed by two unknowns (who serves game 1; which player is
 * near in game 1 + when the first end-change lands), so we try the candidate
 * phases and keep the best fit — robust even under heavy per-point noise.
 */

const P1 = "player_1";
const P2 = "player_2";
const UNK = "unclear";
const other = (p: string) => (p === P1 ? P2 : P1);

type Seg = Omit<VideoSegment, "id">;

interface Point {
  seg: Seg;
  start: number | null;
  end: number | null;
  dur: number | null;
  near: string; // near_player_identity (raw)
  /**
   * `near` as a boolean: true = the near player is the one this point's WINDOW
   * saw first, false = the other player, null = no usable answer.
   *
   * Window-relative, and that is the point. It says nothing on its own about
   * which of the two players in the match this is — only `mergeWindowSegments`
   * (linking windows through their overlap) and the fit below can turn a run of
   * these into a match-wide identity.
   */
  rel: boolean | null;
  /** true = the players changed ends in the gap before this point. */
  swappedBefore: boolean | null;
  role: string; // serve_came_from (raw), kept as-is for the uniformity report
  /** true = the near player served this point; null = no usable answer. */
  serveNear: boolean | null;
  shotsRaw: number | null; // times_ball_was_hit (raw)
}

/**
 * The raw output's own vital signs, measured before any structure is fitted to
 * it.
 *
 * Separate from the fit because the fit always succeeds: it will lay games and
 * servers over a template and report high confidence for them. These are the
 * numbers that say whether there was anything there to fit.
 */
export interface RawQuality {
  points: number;
  /**
   * Share of points taking the most common value for each raw enum. 1.0 means
   * the model gave the identical answer every single time.
   */
  identityUniformity: number;
  roleUniformity: number;
  /** Largest gap between points, over the median gap. Below ~2 there is no
   *  changeover structure in the timings at all. */
  gapSpread: number;
  /**
   * Distinct `what_you_see` strings over total points. 1.0 means every point was
   * described afresh; a low value means a handful of sentences were recycled.
   *
   * NOTE this is capped by the number of points, so it is only comparable
   * between runs of similar length — 12 distinct strings is 0.13 over 95 points
   * and 0.86 over 14.
   */
  descriptionDiversity: number;
  /**
   * Share of points taking the most common duration, and the most common gap,
   * rounded to the second. Modal share rather than a distinct-value count
   * because only the former is scale-free: real tennis points cluster hard
   * around a few lengths, so counting distinct durations mostly measures how
   * many points there are (128 rallies can never exceed ~0.23 when durations
   * span 2-30s), while "how often does the SAME number come back" means the
   * same thing at 14 points as at 128.
   *
   * 1.0 on both is a literal grid — the shape the model emits when it has
   * stopped watching and started generating.
   */
  durationUniformity: number;
  gapUniformity: number;
}

export interface SmoothReport extends RawQuality {
  gamesDetected: number;
  serverPhaseStartsWith: string;
  /** Which identity candidate won, e.g. "changeover start=player_1 offset=1" or "constant player_1". */
  identityFit: string;
  /**
   * How many independent identity frames the run had to be fitted over. 1 means
   * the overlap linked every window into one frame and the fit had a single
   * unknown; higher means that many seams were unreadable, and each one cost a
   * free flip bit. Worth watching — it is the honest measure of how much of the
   * identity track is observed rather than inferred.
   */
  linkGroups: number;
  /** Agreement between the fitted server and the raw `serve_came_from` field. */
  serverAgreementWithRole: number;
  gameLengths: number[];
  /**
   * The raw output carries no usable structure, so the fit below it is
   * meaningless however confident it looks. Seen for real: a 32-minute match came
   * back with one identity, one role and four distinct `what_you_see` strings
   * across 96 points, and no gap over twice the median — the model had emitted a
   * template rather than watching the video. Presenting that as a breakdown is
   * worse than admitting the run failed.
   */
  degenerate: boolean;
}

/** Share of the most common non-null value in `values`. 1 = perfectly uniform. */
function uniformity(values: (string | null)[]): number {
  const known = values.filter((v): v is string => v != null && v !== UNK);
  if (!known.length) return 1;
  const counts = new Map<string, number>();
  for (const v of known) counts.set(v, (counts.get(v) ?? 0) + 1);
  return Math.max(...counts.values()) / known.length;
}

/** Distinct values over `total`, as a 0-1 score. 1.0 = every value different. */
function diversityOf(values: string[], total: number): number {
  return total ? new Set(values).size / total : 1;
}

/** Share of the most common value, rounded to the second. 1 = every one the same. */
function numericUniformity(values: (number | null)[]): number {
  const known = values.filter((v): v is number => v != null).map((v) => Math.round(v));
  if (!known.length) return 0;
  const counts = new Map<number, number>();
  for (const v of known) counts.set(v, (counts.get(v) ?? 0) + 1);
  return Math.max(...counts.values()) / known.length;
}

/**
 * The identity answer as a boolean relative to its own window's first point.
 *
 * `player_1` / `player_2` are the pre-windowing vocabulary and are still read,
 * mapping to first/other. That is exactly right for a single-call run, where
 * `player_1` WAS the first near player, and harmless for anything else: a
 * windowed run is re-analysed rather than re-smoothed, so old multi-window rows
 * never reach here.
 */
function relLabel(v: unknown): boolean | null {
  if (v === NEAR_SAME || v === P1) return true;
  if (v === NEAR_OTHER || v === P2) return false;
  return null;
}

/**
 * Whether the near player served this point.
 *
 * `serving` / `receiving` are the previous field's vocabulary and are still
 * read, so a row analysed before the change still smooths correctly.
 */
function serveLabel(v: unknown): boolean | null {
  if (v === SERVE_BOTTOM || v === "serving") return true;
  if (v === SERVE_TOP || v === "receiving") return false;
  return null;
}

/**
 * Read the model's raw per-point fields off the segments. Shared by the smoother
 * and by `assessRaw`, so both interpret the output the same way.
 */
function toPoints(segments: Seg[]): Point[] {
  return segments.map((s) => {
    const m = s.metadata ?? {};
    const start = s.startS;
    const end = s.endS;
    return {
      seg: s,
      start,
      end,
      dur: start != null && end != null ? end - start : null,
      near: typeof m.near_player_identity === "string" ? m.near_player_identity : UNK,
      rel: relLabel(m.near_player_identity),
      role: typeof m.serve_came_from === "string"
        ? m.serve_came_from
        : typeof m.near_player_role === "string"
          ? m.near_player_role
          : UNK,
      serveNear: serveLabel(m.serve_came_from ?? m.near_player_role),
      swappedBefore:
        m.players_swapped_ends_before == null
          ? null
          : m.players_swapped_ends_before === SWAP_YES,
      shotsRaw: typeof m.times_ball_was_hit === "number" ? m.times_ball_was_hit : null,
    };
  });
}

/** The gaps between consecutive points, where both timestamps are known. */
function gapsBetween(pts: Point[]): number[] {
  const gaps: number[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i].end;
    const b = pts[i + 1].start;
    if (a != null && b != null) gaps.push(b - a);
  }
  return gaps;
}

/** Measure a batch of raw segments — a whole match, or a single window. */
export function assessRaw(segments: Seg[]): RawQuality {
  const pts = toPoints(segments);
  const gaps = gapsBetween(pts);
  const sorted = [...gaps].sort((x, y) => x - y);
  const medGap = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  const descriptions = pts.map((p) =>
    String((p.seg.metadata as Record<string, unknown>)?.what_you_see ?? ""),
  );
  return {
    points: pts.length,
    identityUniformity: uniformity(pts.map((p) => p.near)),
    roleUniformity: uniformity(pts.map((p) => p.role)),
    gapSpread: medGap > 0 ? Math.max(...gaps) / medGap : 0,
    descriptionDiversity: diversityOf(
      descriptions.filter((d) => d !== ""),
      descriptions.length,
    ),
    durationUniformity: numericUniformity(pts.map((p) => p.dur)),
    gapUniformity: numericUniformity(gaps),
  };
}

/**
 * Long enough for a constant enum to be impossible rather than merely unusual.
 *
 * Subtler than it looks, and an earlier version of this got it wrong. Ends
 * change after ODD games, so the near player is the server for two games
 * running: game 1 (server near), swap ends, game 2 (the new near player serves),
 * then two games receiving. Role and identity are therefore each legitimately
 * constant across TWO whole games. With `splitLongGames` capping a game at 15
 * points, two games is up to 30 — so only past 32 points is constancy proof of
 * anything.
 */
const LONG_ENOUGH_TO_JUDGE_FIELDS = 32;

/**
 * Whether a WHOLE MATCH's raw output betrays a template rather than a reading of
 * the video. Four independent tests; any one alone is damning, so they are OR'd,
 * and each is gated on enough points for its claim to hold.
 *
 *  - Constant role / constant identity: see LONG_ENOUGH_TO_JUDGE_FIELDS. A real
 *    5-minute window of 14 points came back all-serving with a clean identity
 *    flip at a 45s changeover — physically correct, and a 12-point threshold
 *    would have thrown it away.
 *  - No timing structure: a real changeover is 60-90s against a 15-25s
 *    inter-point gap, so the longest gap should dwarf the median. When the
 *    longest is barely twice the median, the timings were invented.
 *  - Recycled prose: seen at 12 distinct strings across 95 points, four of which
 *    covered 87 in a flat 22/22/22/21 rotation. The threshold is deliberately
 *    far below anything a genuine run produces (a clean run scores 1.0).
 */
export function degenerateMatch(q: RawQuality): boolean {
  const constantRole = q.points >= LONG_ENOUGH_TO_JUDGE_FIELDS && q.roleUniformity >= 0.98;
  const constantIdentity = q.points >= LONG_ENOUGH_TO_JUDGE_FIELDS && q.identityUniformity >= 0.98;
  const noTimingStructure = q.points >= 12 && q.gapSpread < 2.5;
  const recycledProse = q.points >= 20 && q.descriptionDiversity < 0.25;
  return constantRole || constantIdentity || noTimingStructure || recycledProse;
}

/**
 * A window has to hold this many points before its variety means anything. A
 * 5-minute window is 2-3 games, so a genuine one lands around 12-15 points;
 * below 8 the distinct-value ratios are too coarse to tell a template from a
 * short, unremarkable stretch of play.
 */
const WINDOW_MIN_POINTS_TO_JUDGE = 8;

/**
 * The bar for calling a window's timings a grid.
 *
 * Set from real data, and set high, because the first pass at this was wrong in
 * an instructive way. It used "share of DISTINCT durations" with a 0.4 bar,
 * calibrated against simulated points whose lengths were drawn evenly across
 * 5-21s. Real rallies are nothing like that — they pile up on a few short
 * lengths — so on three real matches (30 windows) that rule flagged 10 of them,
 * including a window whose own prose was entirely distinct. It would have failed
 * most re-runs.
 *
 * Measured across those 30 windows, all of them genuine:
 *
 *   duration modal share  0.10 .. 0.78
 *   gap      modal share  0.10 .. 1.00   (yes — one real window has identical gaps)
 *   prose    modal share  0.06 .. 0.46
 *
 * So neither axis separates on its own. What no real window did was max out
 * BOTH: the worst pair seen was 0.78 / 1.00. A generated grid sits at 1.00 /
 * 1.00 — same point length and same gap, every time — which is what the
 * recorded 32-minute failure looked like (a flat 12s-on, 8s-off).
 */
const GRID_UNIFORMITY = 0.95;

/**
 * Recycled prose, at window scale — and only the flagrant version of it.
 *
 * The match-scale bar (0.25) can't be reused: it was set against 12 distinct
 * strings over 95 points, and the same four-sentence rotation inside a 14-point
 * window scores 0.29, above it. Raising the bar to catch that would cross into
 * real data, which ran 0.37 and up. 0.15 sits far below both, so it only fires
 * when a window is down to one or two sentences — with the point floor raised,
 * since 0.15 is unreachable below ~13 points anyway.
 */
const WINDOW_PROSE_DIVERSITY = 0.15;
const WINDOW_PROSE_MIN_POINTS = 15;

/**
 * Whether ONE window's raw output is a template.
 *
 * Narrower than it first looks, deliberately. `degenerateMatch` can't simply be
 * pointed at a window — three of its four thresholds are unreachable at this
 * size (32 points for the enums, 20 for the prose, against a window holding
 * 10-20) and the fourth is wrong here, since `gapSpread` looks for a changeover
 * standing out from the inter-point gaps and changeovers only come every two
 * games, so a good 5-minute window can contain none.
 *
 * But the honest finding from calibrating this against real matches is that a
 * window is simply too small to judge subtly. At 10-20 points, a model that has
 * stopped watching and a stretch of genuinely repetitive play produce
 * distributions that overlap on every soft measure — distinct durations,
 * distinct gaps, modal prose. Only the flagrant case separates cleanly.
 *
 * So this catches the flagrant case and nothing else: a literal grid, or a
 * window narrated with one or two sentences. Partial templating inside a single
 * window will get through, and `degenerateMatch` on the stitched result remains
 * the wider net. A guard that fired on real footage would be far worse than one
 * that misses — it fails the run and spends a retry to reach the same place.
 */
export function degenerateWindow(q: RawQuality): boolean {
  if (q.points < WINDOW_MIN_POINTS_TO_JUDGE) return false;
  const griddedTimings =
    q.durationUniformity >= GRID_UNIFORMITY && q.gapUniformity >= GRID_UNIFORMITY;
  const oneOrTwoSentences =
    q.points >= WINDOW_PROSE_MIN_POINTS && q.descriptionDiversity < WINDOW_PROSE_DIVERSITY;
  return griddedTimings || oneOrTwoSentences;
}

/** Most common of P1/P2 in `values`, first-seen on ties; `fallback` if none. */
function majorityOr(values: (string | null)[], fallback: string): string {
  const counts = new Map<string, number>();
  for (const v of values) if (v === P1 || v === P2) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | null = null;
  let bestC = 0;
  for (const [k, c] of counts) if (c > bestC) [best, bestC] = [k, c]; // strict > keeps first-seen
  return best ?? fallback;
}

/**
 * Split any game that has run implausibly long.
 *
 * A service game is 4 points at minimum and typically 4–7, occasionally 8–12,
 * and hardly ever past ~15 even through repeated deuces. So a detected "game"
 * well past that is not a marathon hold — it's two or more games whose boundary
 * the gap detector missed, and leaving it merged throws the server alternation
 * out of phase for the whole remainder of the match.
 *
 * Each over-long run is cut at its largest internal gap (the most likely missed
 * changeover), provided both halves keep at least `minGame` points, and the
 * halves are then reconsidered in turn.
 */
function splitLongGames(
  games: [number, number][],
  pts: Point[],
  minGame: number,
  maxGame: number,
): [number, number][] {
  const out: [number, number][] = [];
  const queue = [...games];

  while (queue.length) {
    const [a, b] = queue.shift()!;
    if (b - a <= maxGame) {
      out.push([a, b]);
      continue;
    }

    // Best cut = biggest gap, among positions that leave both sides viable.
    let bestAt = -1;
    let bestGap = -1;
    for (let i = a + minGame; i <= b - minGame; i++) {
      const prev = pts[i - 1].end;
      const next = pts[i].start;
      if (prev == null || next == null) continue;
      const gap = next - prev;
      if (gap > bestGap) {
        bestGap = gap;
        bestAt = i;
      }
    }

    if (bestAt < 0) {
      out.push([a, b]); // nothing safe to cut on — leave it and let the report flag it
      continue;
    }
    queue.unshift([a, bestAt], [bestAt, b]); // re-examine both halves
  }

  return out.sort((x, y) => x[0] - y[0]);
}

/**
 * Split the point sequence into games. Players rest / change ends between games,
 * so a large TIME GAP before a point is a far more reliable boundary cue than the
 * noisy fields. Boundaries fall where the gap exceeds gapK × the median gap; any
 * game shorter than minGame (a false split from a mid-game ball-retrieval gap) is
 * merged back into the neighbour it split from.
 *
 * On gapK, which was 2.0 and was measurably too high. Most gaps in a match are
 * the within-game ones (15-25s), so they set the median at around 20s and a
 * multiplier of 2.0 puts the threshold at ~40s. But the gap where a game ends is
 * only 35-50s, so roughly half of all game boundaries fell UNDER the threshold
 * and were missed — and a missed boundary is not a small error: it merges two
 * games, which inverts the server for every game after it and drags the identity
 * pattern out of phase with them.
 *
 * The two error directions are not symmetric, which is what makes erring low
 * correct. A false split leaves a game under `minGame`, and the merge-back loop
 * below repairs it. A missed boundary has no equivalent repair — `splitLongGames`
 * only intervenes past 15 points, and two merged 5-point games make 10.
 *
 * Measured over 10 simulated 8-game matches x 3 gap regimes (typical, tight, and
 * one with frequent 32-42s ball-retrieval gaps mid-game), scoring every point on
 * getting BOTH near player and server right:
 *
 *   gapK  2.0 → 25-50%    (0-2 of 10 matches got the game count right)
 *   gapK  1.6 → 73-98%
 *   gapK  1.5 → 88-100%
 *   gapK  1.4 → 97-100%   (9-10 of 10)
 *   gapK  1.3 → 97-100%   (identical to 1.4)
 *
 * 1.4 sits in the flat part rather than on the edge of it: 1.3 buys nothing more,
 * and the ball-retrieval regime scores the same at 1.6 as at 1.3, so the
 * merge-back really is absorbing the false splits it creates.
 */
/**
 * The share of points that may be flagged as a changeover before the field is
 * disbelieved entirely.
 *
 * Ends change after every odd game, so in a match of ~20 games about a tenth of
 * points follow one. Much past that and the model is not reporting changeovers,
 * it is answering yes out of habit — and a field answering yes out of habit
 * would shatter the match into a game per point. Below the bar we trust it;
 * above it we fall back to the timings alone, which is where this started.
 */
const MAX_PLAUSIBLE_SWAP_SHARE = 0.25;

/**
 * The points the model says a changeover happened before — or nothing at all,
 * when it reported so many that it clearly wasn't watching for them.
 *
 * One definition, used twice: a changeover both ends a game and swaps who is
 * nearest the camera, so it feeds `detectGames` and the identity fit alike.
 */
function trustedSwaps(pts: Point[]): number[] {
  const answered = pts.filter((p) => p.swappedBefore != null).length;
  if (!answered) return [];
  const swaps = pts.map((p, i) => (p.swappedBefore ? i : -1)).filter((i) => i > 0);
  return swaps.length / answered <= MAX_PLAUSIBLE_SWAP_SHARE ? swaps : [];
}

function detectGames(pts: Point[], minGame: number, gapK: number): [number, number][] {
  const gaps: (number | null)[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i].end;
    const b = pts[i + 1].start;
    gaps.push(a != null && b != null ? b - a : null);
  }

  const known = gaps.filter((g): g is number => g != null).sort((x, y) => x - y);
  let boundaries: number[] = [];
  if (known.length) {
    const med = known[Math.floor(known.length / 2)];
    const thr = gapK * med;
    boundaries = gaps.map((g, i) => (g != null && g > thr ? i : -1)).filter((i) => i >= 0);
  }

  // A changeover the model actually watched is better evidence than a gap we
  // inferred, so those points open a game too. They are added to the gap
  // boundaries rather than replacing them: the field is sparse by nature (most
  // game boundaries are not changeovers) and a missed one still has the timing
  // to fall back on.
  // Two observed boundary cues, and between them they cover a whole match.
  //
  // Ends change after games 1, 3, 5, 7 — so `trustedSwaps` marks every ODD
  // game's end and none of the even ones. The serving end fills in the rest: the
  // server holds for a game, so `serve_came_from` is constant within one, and
  // works out to bottom, bottom, top, top, bottom... — it flips after games 2,
  // 4, 6. One cue for the odd boundaries, the other for the even.
  //
  // This matters because the gap cue above has quietly stopped working. The
  // model's segments swallow the pauses (62% of a real match came back inside a
  // "rally"), so only four gaps in 49 minutes cleared 30s where twenty games'
  // worth were needed. These two cues need no gap at all.
  //
  // A serve-end flip counts only when the new answer holds for two points
  // running, because the field is noisy point to point and a lone disagreement
  // is far more likely to be a misread than a game.
  const swapBoundaries = trustedSwaps(pts);
  const serveFlips: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    const prev = pts[i - 1].serveNear;
    const now = pts[i].serveNear;
    if (prev == null || now == null || prev === now) continue;
    if (pts[i + 1]?.serveNear === now || i === pts.length - 1) serveFlips.push(i);
  }

  const cuts = [
    0,
    ...new Set(
      [...boundaries.map((i) => i + 1), ...swapBoundaries, ...serveFlips].sort((a, b) => a - b),
    ),
    pts.length,
  ];
  const games: [number, number][] = [];
  for (let k = 0; k < cuts.length - 1; k++) games.push([cuts[k], cuts[k + 1]]);

  const gapAt = (idx: number): number | null => {
    const g = games[idx][0] - 1;
    return g >= 0 && g < gaps.length ? gaps[g] : null;
  };

  let changed = true;
  while (changed && games.length > 1) {
    changed = false;
    for (let k = 0; k < games.length; k++) {
      const [a, b] = games[k];
      if (b - a < minGame) {
        const leftGap = k > 0 ? gapAt(k) : null;
        const rightGap = k + 1 < games.length ? gapAt(k + 1) : null;
        // Merge toward the side with the SMALLER gap (more likely a false split).
        if (leftGap != null && (rightGap == null || leftGap <= rightGap)) {
          games[k - 1][1] = games[k][1];
          games.splice(k, 1);
        } else {
          games[k][1] = games[k + 1][1];
          games.splice(k + 1, 1);
        }
        changed = true;
        break;
      }
    }
  }
  return games;
}

/**
 * Fit the rigid tennis structure to the noisy per-point fields and stamp cleaned
 * values (game, server, receiver, near_player, near_role, serving_side, shots)
 * onto each segment's metadata. Returns the enriched segments + a QA report.
 */
export function smoothTennis(
  segments: Seg[],
  opts?: {
    minGame?: number;
    maxGame?: number;
    hitsPerSec?: number;
    gapK?: number;
    /**
     * Per-segment link group, from `mergeWindowSegments`. Points in one group
     * have identity labels in a consistent frame; separate groups do not, and
     * each group's orientation is fitted below rather than assumed. Omit for a
     * single-call run — everything is then one group, as it already was.
     */
    linkGroups?: number[];
  },
): { segments: Seg[]; report: SmoothReport } {
  const minGame = opts?.minGame ?? 4;
  // Service games run 4-7 points typically, 8-12 sometimes, and hardly ever past
  // this even through repeated deuces — beyond it, a missed boundary is far more
  // likely than a real hold. See splitLongGames.
  const maxGame = opts?.maxGame ?? 15;
  const hitsPerSec = opts?.hitsPerSec ?? 0.5;
  const gapK = opts?.gapK ?? 1.4;

  const pts = toPoints(segments);

  const games = splitLongGames(detectGames(pts, minGame, gapK), pts, minGame, maxGame);
  const G = games.length;

  // Which game each point belongs to, and which link group it came from.
  const gameOf: number[] = new Array(pts.length).fill(0);
  for (let gi = 0; gi < games.length; gi++) {
    for (let i = games[gi][0]; i < games[gi][1]; i++) gameOf[i] = gi;
  }
  const groupOf = opts?.linkGroups ?? [];
  const groupIds = [...new Set(pts.map((_, i) => groupOf[i] ?? 0))];
  const swapPoints = trustedSwaps(pts);

  // ---- Identity first, because the server now follows from it. -------------
  //
  // Fit the near-player identity per game. Two families of candidate:
  //  - CHANGEOVER: players change ends after ODD games — after game 1, then
  //    after 3, 5, 7 — so the near player holds for two games and flips. That
  //    is `offset` 1, and it is listed first so it wins ties. `offset` 0
  //    ("pairs from game 1") is kept only because a casual match can start its
  //    count anywhere. = 4 candidates.
  //  - CONSTANT: casual play where players never swap ends → near player never
  //    changes. = 2 candidates.
  // Changeover candidates are listed first so they win ties (the standard case);
  // a constant fit only wins when it *strictly* explains the data better.
  //
  // The scoring is what changed with windowing. The raw labels are relative to
  // each WINDOW's own first point, so they cannot be compared across a link
  // group boundary — `mergeWindowSegments` puts every window it could chain
  // through an overlap into one frame, but a seam it couldn't read opens a new
  // group with an unknown orientation. Rather than guess, each group gets a free
  // flip bit, resolved per candidate as whichever orientation agrees with that
  // candidate more often. That is one extra binary unknown per unlinked seam,
  // not per window, and it costs a single pass over the points — no search.
  const idPattern = (start: string, offset: number) =>
    Array.from({ length: G }, (_, g) =>
      Math.floor((g + offset) / 2) % 2 === 0 ? start : other(start),
    );
  // Every candidate is expanded to one entry PER POINT, so a per-game pattern and
  // the per-point one below can be scored the same way.
  const perPoint = (byGame: string[]) => pts.map((_, i) => byGame[gameOf[i]]);
  const candidates: { label: string; pattern: string[] }[] = [];

  // Observed changeovers, if the model reported any it can be believed on. This
  // is the only candidate that isn't a guess about the shape of the match: the
  // near player is whoever they were until the two of them walk past each other,
  // and then they are the other one. It has to earn its place like the rest —
  // if the field is noise it explains the identity labels badly and loses.
  if (swapPoints.length) {
    for (const st of [P1, P2]) {
      let who = st;
      const track = pts.map((p, i) => {
        if (i > 0 && p.swappedBefore) who = other(who);
        return who;
      });
      candidates.push({ label: `observed changeovers start=${st}`, pattern: track });
    }
  }

  for (const st of [P1, P2]) {
    for (const o of [1, 0]) {
      candidates.push({
        label: `changeover start=${st} offset=${o}`,
        pattern: perPoint(idPattern(st, o)),
      });
    }
  }
  for (const st of [P1, P2]) {
    candidates.push({ label: `constant ${st}`, pattern: perPoint(Array.from({ length: G }, () => st)) });
  }

  /** How well a candidate explains the points, letting each group orient itself. */
  const scoreCandidate = (pattern: string[]): number => {
    let total = 0;
    for (const gid of groupIds) {
      let agree = 0;
      let n = 0;
      for (let i = 0; i < pts.length; i++) {
        if ((groupOf[i] ?? 0) !== gid) continue;
        const rel = pts[i].rel;
        if (rel == null) continue;
        n++;
        if (rel === (pattern[i] === P1)) agree++;
      }
      total += Math.max(agree, n - agree); // the group's better orientation
    }
    return total;
  };

  let bestId = candidates[0];
  let bestIdScore = -1;
  for (const c of candidates) {
    const score = scoreCandidate(c.pattern);
    if (score > bestIdScore) [bestId, bestIdScore] = [c, score];
  }
  /** The fitted near player, per point. */
  const idFit = bestId.pattern;

  // ---- Server, from the fitted identity plus the role field. ---------------
  //
  // `serve_came_from` is the one raw field windowing left untouched: which end
  // the serve came from needs no anchor outside the clip. So the implied server
  // is read off the FITTED near player rather than the raw identity label, which
  // keeps the noise in identity from being counted twice — once in the identity
  // fit and again here.
  const implied: (string | null)[] = pts.map((p, i) => {
    if (p.serveNear == null) return null;
    const near = idFit[i];
    return p.serveNear ? near : other(near);
  });

  // Fit strict server alternation across games (2 candidate phases).
  const altPattern = (start: string) =>
    Array.from({ length: G }, (_, g) => (g % 2 === 0 ? start : other(start)));
  const obsSrv = games.map(([a, b]) => majorityOr(implied.slice(a, b), P1));
  let bestSrv = P1;
  let bestSrvScore = -1;
  for (const st of [P1, P2]) {
    const score = altPattern(st).reduce((acc, v, i) => acc + (v === obsSrv[i] ? 1 : 0), 0);
    if (score > bestSrvScore) [bestSrv, bestSrvScore] = [st, score];
  }
  const srvFit = altPattern(bestSrv);

  // Stamp cleaned values back onto every point + apply the shot floor.
  const out: Seg[] = segments.map((s) => s);
  for (let gi = 0; gi < games.length; gi++) {
    const [a, b] = games[gi];
    const server = srvFit[gi];
    for (let i = a; i < b; i++) {
      const near = idFit[i];
      const role = near === server ? "serving" : "receiving";
      const dur = pts[i].dur;
      const floor = dur ? Math.max(1, Math.round(dur * hitsPerSec)) : 1;
      const reported = pts[i].shotsRaw ?? 0;
      out[i] = {
        ...pts[i].seg,
        metadata: {
          ...(pts[i].seg.metadata ?? {}),
          game: gi + 1,
          server,
          receiver: other(server),
          near_player: near,
          near_role: role,
          serving_side: role === "serving" ? "near" : "far",
          shots: Math.max(reported, floor),
        },
      };
    }
  }

  // Confidence: how much the role field agreed with the fitted server. (Before
  // windowing this also folded in the raw identity label; that now feeds the
  // identity fit instead, so this isolates the one field windowing didn't
  // disturb.)
  const known = implied.map((x, i) => ({ x, i })).filter((o) => o.x != null);
  const srvAgree = known.length
    ? known.filter((o) => o.x === (out[o.i].metadata as Record<string, unknown>).server).length /
      known.length
    : 0;

  // How much the model actually varied its answers, and whether the timings hold
  // any changeover structure. Measured from the RAW fields — a fit can look
  // decisive while resting on input that says the same thing every time.
  const q = assessRaw(segments);
  const r3 = (n: number) => Math.round(n * 1000) / 1000;

  return {
    segments: out,
    report: {
      gamesDetected: G,
      serverPhaseStartsWith: bestSrv,
      identityFit: bestId.label,
      linkGroups: groupIds.length,
      serverAgreementWithRole: r3(srvAgree),
      gameLengths: games.map(([a, b]) => b - a),
      points: q.points,
      identityUniformity: r3(q.identityUniformity),
      roleUniformity: r3(q.roleUniformity),
      gapSpread: Math.round(q.gapSpread * 100) / 100,
      descriptionDiversity: r3(q.descriptionDiversity),
      durationUniformity: r3(q.durationUniformity),
      gapUniformity: r3(q.gapUniformity),
      degenerate: degenerateMatch(q),
    },
  };
}
