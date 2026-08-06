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
  opts?: { minGame?: number; hitsPerSec?: number; gapK?: number },
): { segments: Seg[]; report: SmoothReport } {
  const minGame = opts?.minGame ?? 4;
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

  const games = detectGames(pts, minGame, gapK);
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

  return {
    segments: out,
    report: {
      gamesDetected: G,
      serverPhaseStartsWith: bestSrv,
      identityFit: bestId.label,
      serverAgreementWithRaw: Math.round(srvAgree * 1000) / 1000,
      gameLengths: games.map(([a, b]) => b - a),
    },
  };
}
