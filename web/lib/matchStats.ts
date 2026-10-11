/**
 * Our own analysis of a match (ml/ pipeline), as stored in match_analyses.data
 * and shown on the watch page. Built by ml/ojo_replay/report.py summarise().
 *
 * Court coordinates are metres from centre court: +x to the camera's right,
 * +y away from the camera. "near" is the camera end. Players A and B are told
 * apart by their kit, so their stats follow them across changes of ends.
 */
export type End = "near" | "far";
export type Who = "A" | "B";

export interface PlayerStats {
  shots: number;
  serves: number;
  serveAvg: number | null;
  serveMax: number | null;
  shotAvg: number | null;
  shotMax: number | null;
  inPct: number | null;
  netPct: number | null;
  distance: number;
  pointsServed?: number;
  firstServeIn?: number | null;
  /** Shirt and shorts colour, as hex. */
  swatch?: [string, string];
}

export interface Shot {
  rally: number;
  serve: boolean;
  hitter: End;
  player?: Who;
  /** Seconds into the video. */
  t: number;
  speed: number;
  bounce: [number, number] | null;
  landing: "in" | "out" | "close" | "net" | null;
  net: number | null;
  doubt: string | null;
}

export interface RallyStats {
  idx: number;
  start: number;
  end: number;
  shots: number;
  avgSpeed: number | null;
  maxSpeed: number | null;
  run: number;
  intensity: number;
  high: boolean;
}

export interface ServiceGame {
  game: number;
  server: Who;
  serverEnd: End;
  start: number;
  points: number;
  changeoverAfter: boolean;
}

export interface MatchStats {
  version: string;
  generatedAt: string;
  durationS: number;
  /** Every hit found. `shots` are the ones whose flight fitted (speed, bounce). */
  hits?: number;
  /** Points played (rallies grouped by the structure step). */
  points?: number;
  shots: Shot[];
  rallies: RallyStats[];
  near: PlayerStats;
  far: PlayerStats;
  people: Record<Who, PlayerStats> | null;
  games: ServiceGame[] | null;
}

/** A light shape check for what the worker posts; the worker is trusted, typos aren't. */
export function isMatchStats(v: unknown): v is MatchStats {
  const m = v as MatchStats | null;
  return (
    !!m &&
    typeof m.version === "string" &&
    typeof m.durationS === "number" &&
    Array.isArray(m.shots) &&
    Array.isArray(m.rallies) &&
    typeof m.near === "object" &&
    typeof m.far === "object"
  );
}

/**
 * What the watch page draws over the video, in pixels of the source video
 * (width × height): the ball by frame inside rallies, players' boxes at the
 * frames they were detected (side n/f, who A/B or ""), and fitted bounces.
 */
export interface MatchTracks {
  fps: number;
  width: number;
  height: number;
  ball: { f: number[]; u: number[]; v: number[] };
  players: { f: number[]; side: ("n" | "f")[]; who: ("A" | "B" | "")[]; box: [number, number, number, number][] };
  bounces: { t: number; u: number; v: number; speed: number; landing: Shot["landing"]; who: "A" | "B" | "" }[];
}
