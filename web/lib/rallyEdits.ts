import type { VideoSegment } from "./metadata/types";
import { ROLE_RECEIVING, ROLE_SERVING } from "./twelvelabs/rally";

/**
 * Hand corrections to a finished rally breakdown.
 *
 * The smoother is right about *when* the rallies are — that comes from the
 * video's own gaps — and wrong often enough about *who served* them, because
 * that is fitted from noisy per-point votes (see lib/twelvelabs/smooth.ts). So
 * the one thing this lets an owner change is the server, and everything the
 * smoother derived from the server is re-derived to match rather than left
 * behind saying something else.
 *
 * Shared by the API route that persists an edit and by the panel that previews
 * it, so what the timeline shows while you edit is what gets written.
 */

export type ServerSlot = "player_1" | "player_2";

/** Pending hand corrections to a breakdown, both keyed by a rally's stored `idx`. */
export interface RallyCorrections {
  /** Who actually served, for the rallies the model got wrong. */
  servers: Record<number, ServerSlot>;
  /** Rallies that aren't rallies, to drop entirely. */
  deleted: number[];
}

export const NO_CORRECTIONS: RallyCorrections = { servers: {}, deleted: [] };

/** How many changes are pending — what the Save button counts. A server edit on
 *  a rally that is also being deleted is moot, so it isn't counted twice. */
export function countCorrections({ servers, deleted }: RallyCorrections): number {
  const dropped = new Set(deleted);
  return (
    dropped.size + Object.keys(servers).filter((idx) => !dropped.has(Number(idx))).length
  );
}

/** A segment as far as this module cares: an index and a metadata bag. */
type Editable = { idx: number; metadata: Record<string, unknown> };

const OTHER: Record<ServerSlot, ServerSlot> = {
  player_1: "player_2",
  player_2: "player_1",
};

const asStr = (v: unknown): string | null => (typeof v === "string" ? v : null);

export const isServerSlot = (v: unknown): v is ServerSlot =>
  v === "player_1" || v === "player_2";

/**
 * Number the service games off the server sequence.
 *
 * In singles the serve alternates every game, so a run of consecutive rallies
 * with one server *is* one service game — there is no such thing as two games in
 * a row served by the same player. That makes the server the ground truth and
 * `game` a derived field, which is why correcting one rally can split a game in
 * two or merge two into one, and why the whole match is renumbered rather than
 * patched from the edit outwards.
 *
 * A rally the model couldn't call (no server) joins whichever game is running
 * rather than starting one: it says nothing, and a gap in the votes is not a
 * hold of serve.
 */
function renumberGames<T extends Editable>(segments: T[]): T[] {
  let game = 0;
  let running: string | null = null;
  return segments.map((s, i) => {
    const server = asStr(s.metadata.server);
    if (i === 0 || (server && running && server !== running)) game++;
    if (server) running = server;
    return { ...s, metadata: { ...s.metadata, game } };
  });
}

/**
 * Which end the serve now comes from, as `{ serving_side, near_role }` — or `{}`
 * when there is no honest answer and the old values are better left alone.
 *
 * `near_player` is the good answer: it names who was standing at the near end
 * for that stretch of the match, which is a fact about the changeover schedule
 * and not about who served, so it survives the edit and the side follows from
 * it. Rows written before that field existed fall back on the geometry instead —
 * the two players are at opposite ends, so handing the serve to the other one
 * necessarily flips the side it comes from. Only a row with neither is left as
 * it was, which is the one case where guessing would be worse than saying
 * nothing.
 */
function servingSide(
  metadata: Record<string, unknown>,
  server: ServerSlot,
): { serving_side: string; near_role: string } | Record<string, never> {
  const near = asStr(metadata.near_player);
  const was = asStr(metadata.serving_side);
  const previous = asStr(metadata.server);

  const fromNear = near
    ? near === server
    : was === "near" || was === "far"
      ? previous && previous !== server
        ? was === "far" // it flips to the other end
        : was === "near"
      : null;

  if (fromNear === null) return {};
  return {
    serving_side: fromNear ? "near" : "far",
    near_role: fromNear ? ROLE_SERVING : ROLE_RECEIVING,
  };
}

/**
 * Apply a set of corrections and re-derive what follows from them: the
 * receiver, which end the serve came from, and the service games.
 *
 * Deleted rallies are dropped before the regrouping, so removing the odd point
 * a model invented out of a ball being fetched can also close the false game
 * boundary it opened. `idx` is deliberately left alone — it is the key the
 * corrections themselves are written against, and renumbering it mid-edit would
 * make every pending change point at the wrong rally. `reindex` does that once,
 * at the end, on the way to the store.
 *
 * Returns the input untouched when there is nothing to apply, so the no-op path
 * costs nothing and never renumbers a match nobody edited.
 */
export function applyCorrections<T extends Editable>(
  segments: T[],
  corrections: RallyCorrections,
): T[] {
  if (countCorrections(corrections) === 0) return segments;
  const dropped = new Set(corrections.deleted);
  const kept = segments.filter((s) => !dropped.has(s.idx));
  const corrected = kept.map((s) => {
    const server = corrections.servers[s.idx];
    if (!server) return s;
    return {
      ...s,
      metadata: {
        ...s.metadata,
        server,
        receiver: OTHER[server],
        ...servingSide(s.metadata, server),
      },
    };
  });
  return renumberGames(corrected);
}

/**
 * Close the gaps in `idx` left by a deletion. The store orders rallies by it, so
 * it has to run 0..n-1 — but only once the corrections have been applied, never
 * while they are still being made against the old numbers.
 */
export function reindex<T extends Editable>(segments: T[]): T[] {
  return segments.map((s, i) => (s.idx === i ? s : { ...s, idx: i }));
}

/** Parse a request body into corrections, or say what's wrong with it. */
export function parseCorrections(
  raw: unknown,
): { corrections: RallyCorrections } | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "Expected an object of corrections." };
  }
  const body = raw as Record<string, unknown>;

  const servers: Record<number, ServerSlot> = {};
  if (body.servers !== undefined) {
    if (!body.servers || typeof body.servers !== "object" || Array.isArray(body.servers)) {
      return { error: "`servers` must be an object of rally index → player." };
    }
    for (const [key, value] of Object.entries(body.servers as Record<string, unknown>)) {
      const idx = Number(key);
      if (!Number.isInteger(idx) || idx < 0) return { error: `Bad rally index "${key}".` };
      if (!isServerSlot(value)) return { error: `Bad server for rally ${key}.` };
      servers[idx] = value;
    }
  }

  const deleted: number[] = [];
  if (body.deleted !== undefined) {
    if (!Array.isArray(body.deleted)) return { error: "`deleted` must be an array of rally indexes." };
    for (const value of body.deleted) {
      if (!Number.isInteger(value) || (value as number) < 0) {
        return { error: `Bad rally index ${JSON.stringify(value)}.` };
      }
      if (!deleted.includes(value as number)) deleted.push(value as number);
    }
  }

  return { corrections: { servers, deleted } };
}

/** Strip the store-assigned id, for handing a corrected list back to replaceSegments. */
export const withoutIds = (segments: VideoSegment[]): Omit<VideoSegment, "id">[] =>
  segments.map(({ id: _id, ...rest }) => rest);
