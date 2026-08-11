import type { VideoSegment } from "../metadata/types";

/**
 * Post-processing smoother for TwelveLabs tennis rally segmentation — a faithful
 * TypeScript port of smooth_tennis.py (see docs/twelvelabs-tennis-handover.md §3).
 *
 * The model's per-point guesses are noisy but a match is rigidly structured, so
 * we fit that structure to the votes:
 *   - the server ALTERNATES every game;
 *   - a game (one player's service turn) is >= 4 points;
 *   - near_player_role == "serving"  iff  the near player is the server;
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
  role: string; // near_player_role (raw)
  shotsRaw: number | null; // times_ball_was_hit (raw)
}

export interface SmoothReport {
  gamesDetected: number;
  serverPhaseStartsWith: string;
  /** Which identity candidate won, e.g. "changeover start=player_1 offset=1" or "constant player_1". */
  identityFit: string;
  serverAgreementWithRaw: number;
  gameLengths: number[];
  /**
   * Share of points taking the most common value for each raw field. 1.0 means
   * the model gave the identical answer every single time.
   */
  identityUniformity: number;
  roleUniformity: number;
  /** Largest gap between points, over the median gap. Below ~2 there is no
   *  changeover structure in the timings at all. */
  gapSpread: number;
  /** Distinct `what_you_see` strings over total points. 1.0 means every point was
   *  described afresh; a low value means a handful of sentences were recycled. */
  descriptionDiversity: number;
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

/** Most common of P1/P2 in `values`, first-seen on ties; `fallback` if none. */
function majorityOr(values: (string | null)[], fallback: string): string {
  const counts = new Map<string, number>();
  for (const v of values) if (v === P1 || v === P2) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | null = null;
  let bestC = 0;
  for (const [k, c] of counts) if (c > bestC) [best, bestC] = [k, c]; // strict > keeps first-seen
  return best ?? fallback;
}

/** Forward- then backward-fill 'unclear'/null from the nearest known neighbour. */
function fillUnclear(seq: (string | null)[]): (string | null)[] {
  const out = [...seq];
  let last: string | null = null;
  for (let i = 0; i < out.length; i++) {
    if (out[i] === UNK || out[i] == null) out[i] = last;
    else last = out[i];
  }
  let nxt: string | null = null;
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i] == null) out[i] = nxt;
    else nxt = out[i];
  }
  return out;
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
 */
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

  const cuts = [0, ...boundaries.map((i) => i + 1), pts.length];
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
  opts?: { minGame?: number; maxGame?: number; hitsPerSec?: number; gapK?: number },
): { segments: Seg[]; report: SmoothReport } {
  const minGame = opts?.minGame ?? 4;
  // Service games run 4-7 points typically, 8-12 sometimes, and hardly ever past
  // this even through repeated deuces — beyond it, a missed boundary is far more
  // likely than a real hold. See splitLongGames.
  const maxGame = opts?.maxGame ?? 15;
  const hitsPerSec = opts?.hitsPerSec ?? 0.5;
  const gapK = opts?.gapK ?? 2.0;

  const pts: Point[] = segments.map((s) => {
    const m = s.metadata ?? {};
    const start = s.startS;
    const end = s.endS;
    return {
      seg: s,
      start,
      end,
      dur: start != null && end != null ? end - start : null,
      near: typeof m.near_player_identity === "string" ? m.near_player_identity : UNK,
      role: typeof m.near_player_role === "string" ? m.near_player_role : UNK,
      shotsRaw: typeof m.times_ball_was_hit === "number" ? m.times_ball_was_hit : null,
    };
  });

  // Implied server per point, combining BOTH noisy fields.
  const implied: (string | null)[] = pts.map((p) => {
    if (p.near === UNK || p.near == null || p.role === UNK || p.role == null) return null;
    return p.role === "serving" ? p.near : other(p.near);
  });

  const games = splitLongGames(detectGames(pts, minGame, gapK), pts, minGame, maxGame);
  const G = games.length;

  // Fit strict server alternation across games (2 candidate phases).
  const altPattern = (start: string) =>
    Array.from({ length: G }, (_, g) => (g % 2 === 0 ? start : other(start)));
  const obsSrv = games.map(([a, b]) => majorityOr(implied.slice(a, b), P1));
  let bestSrv = P1;
  let bestSrvScore = -1;
  for (const s of [P1, P2]) {
    const score = altPattern(s).reduce((acc, v, i) => acc + (v === obsSrv[i] ? 1 : 0), 0);
    if (score > bestSrvScore) [bestSrv, bestSrvScore] = [s, score];
  }
  const srvFit = altPattern(bestSrv);

  // Fit the near-player identity per game. Two families of candidate:
  //  - CHANGEOVER: players change ends after odd games, so the near player is
  //    constant for ~2 games then flips. `offset` covers "change after game 1"
  //    (offset 1, standard tennis) vs "pairs from game 1" (offset 0). = 4 candidates.
  //  - CONSTANT: casual play where players never swap ends → near player never
  //    changes. = 2 candidates.
  // Changeover candidates are listed first so they win ties (the standard case);
  // a constant fit only wins when it *strictly* explains the data better.
  const nearFilled = fillUnclear(pts.map((p) => p.near));
  const gameNearObs = games.map(([a, b]) => majorityOr(nearFilled.slice(a, b), P1));
  const idPattern = (start: string, offset: number) =>
    Array.from({ length: G }, (_, g) =>
      Math.floor((g + offset) / 2) % 2 === 0 ? start : other(start),
    );
  const candidates: { label: string; pattern: string[] }[] = [];
  for (const s of [P1, P2]) {
    for (const o of [0, 1]) {
      candidates.push({ label: `changeover start=${s} offset=${o}`, pattern: idPattern(s, o) });
    }
  }
  for (const s of [P1, P2]) {
    candidates.push({ label: `constant ${s}`, pattern: Array.from({ length: G }, () => s) });
  }
  let bestId = candidates[0];
  let bestIdScore = -1;
  for (const c of candidates) {
    const score = c.pattern.reduce((acc, v, i) => acc + (v === gameNearObs[i] ? 1 : 0), 0);
    if (score > bestIdScore) [bestId, bestIdScore] = [c, score];
  }
  const idFit = bestId.pattern;

  // Stamp cleaned values back onto every point + apply the shot floor.
  const out: Seg[] = segments.map((s) => s);
  for (let gi = 0; gi < games.length; gi++) {
    const [a, b] = games[gi];
    const server = srvFit[gi];
    const near = idFit[gi];
    const role = near === server ? "serving" : "receiving";
    for (let i = a; i < b; i++) {
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

  // Confidence: how much the raw per-point data agreed with the fitted server.
  const known = implied.map((x, i) => ({ x, i })).filter((o) => o.x != null);
  const srvAgree = known.length
    ? known.filter((o) => o.x === (out[o.i].metadata as Record<string, unknown>).server).length /
      known.length
    : 0;

  // How much the model actually varied its answers, and whether the timings hold
  // any changeover structure. Both are computed from the RAW fields — a fit can
  // look decisive while resting on input that says the same thing every time.
  const identityUniformity = uniformity(pts.map((p) => p.near));
  const roleUniformity = uniformity(pts.map((p) => p.role));

  const gapList: number[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i].end;
    const b = pts[i + 1].start;
    if (a != null && b != null) gapList.push(b - a);
  }
  const sortedGaps = [...gapList].sort((x, y) => x - y);
  const medGap = sortedGaps.length ? sortedGaps[Math.floor(sortedGaps.length / 2)] : 0;
  const gapSpread = medGap > 0 ? Math.max(...gapList) / medGap : 0;

  // How much the prose varied. A model reading the video describes each point
  // differently; a model that has stopped reading cycles a handful of sentences.
  const descriptions = pts.map((p) =>
    String((p.seg.metadata as Record<string, unknown>)?.what_you_see ?? ""),
  );
  const distinct = new Set(descriptions.filter((d) => d !== "")).size;
  const descriptionDiversity = descriptions.length ? distinct / descriptions.length : 1;

  // Four independent ways the raw output betrays a template rather than a reading
  // of the video. Any one alone is damning, so they're OR'd, and each is gated on
  // enough points for the claim to hold.
  //
  //  - Constant role: the server alternates every game and a game is >= 4 points,
  //    so 12 points span at least two games and the role MUST flip. Seen at 1.000
  //    across 95 points.
  //  - Constant identity: ends change every two games, so by 24 points the near
  //    player must have swapped. Needs more points than role does, because a
  //    handful of games can legitimately share an end.
  //  - No timing structure: a real changeover is 60-90s against a 15-25s
  //    inter-point gap, so the longest gap should dwarf the median. When the
  //    longest is barely twice the median, the timings were invented.
  //  - Recycled prose: seen at 12 distinct strings across 95 points, four of which
  //    covered 87 in a flat 22/22/22/21 rotation. Threshold is deliberately far
  //    below anything a genuine run produces (a clean run scores 1.0).
  const constantRole = pts.length >= 12 && roleUniformity >= 0.98;
  const constantIdentity = pts.length >= 24 && identityUniformity >= 0.98;
  const noTimingStructure = pts.length >= 12 && gapSpread < 2.5;
  const recycledProse = descriptions.length >= 20 && descriptionDiversity < 0.25;
  const degenerate = constantRole || constantIdentity || noTimingStructure || recycledProse;

  return {
    segments: out,
    report: {
      gamesDetected: G,
      serverPhaseStartsWith: bestSrv,
      identityFit: bestId.label,
      serverAgreementWithRaw: Math.round(srvAgree * 1000) / 1000,
      gameLengths: games.map(([a, b]) => b - a),
      identityUniformity: Math.round(identityUniformity * 1000) / 1000,
      roleUniformity: Math.round(roleUniformity * 1000) / 1000,
      gapSpread: Math.round(gapSpread * 100) / 100,
      descriptionDiversity: Math.round(descriptionDiversity * 1000) / 1000,
      degenerate,
    },
  };
}
