"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CloseIcon } from "./icons";

type Status = "none" | "processing" | "ready" | "failed";
type Slot = "player_1" | "player_2";
interface Players {
  player_1: string | null;
  player_2: string | null;
}

interface Segment {
  id: string;
  idx: number;
  startS: number | null;
  endS: number | null;
  metadata: Record<string, unknown>;
}

interface ServiceGame {
  game: number;
  server: string | null; // player_1 | player_2 | null (from the smoother)
  startS: number;
  endS: number;
  points: number; // rallies in this service game
}

function fmtTime(s: number | null): string {
  if (s == null) return "--:--";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

const DEFAULT_NAME: Record<Slot, string> = { player_1: "Player 1", player_2: "Player 2" };
const asStr = (v: unknown): string | null => (typeof v === "string" ? v : null);
const asNum = (v: unknown): number | null => (typeof v === "number" ? v : null);

/**
 * Group rallies into service games using the smoother's per-point `game` number:
 * consecutive points sharing a game become one bar, labelled with the smoothed
 * `server` (which player served that game). See lib/twelvelabs/smooth.ts.
 */
function buildServiceGames(segs: Segment[]): ServiceGame[] {
  const games: ServiceGame[] = [];
  for (const s of segs) {
    const start = s.startS ?? 0;
    const end = s.endS ?? start;
    const g = asNum(s.metadata.game);
    const server = asStr(s.metadata.server);
    const cur = games[games.length - 1];
    if (cur && g != null && cur.game === g) {
      cur.endS = Math.max(cur.endS, end);
      cur.points++;
    } else {
      games.push({ game: g ?? games.length + 1, server, startS: start, endS: end, points: 1 });
    }
  }
  return games;
}

/** Parse a warm-up trim input ("m:ss" or plain seconds) → seconds, or undefined. */
function parseTrim(s: string): number | undefined {
  const t = s.trim();
  if (!t) return undefined;
  if (t.includes(":")) {
    const [m, sec] = t.split(":");
    const mm = Number(m);
    const ss = Number(sec);
    if (Number.isFinite(mm) && Number.isFinite(ss)) return mm * 60 + ss;
    return undefined;
  }
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Tick spacing: 2 / 5 / 10 min for real matches; finer only for very short clips. */
function tickIntervalSec(total: number): number {
  if (total <= 4 * 60) return 30;
  if (total <= 24 * 60) return 2 * 60;
  if (total <= 60 * 60) return 5 * 60;
  return 10 * 60;
}

/**
 * AI rally breakdown as a horizontal timeline spanning the video's full length.
 * Two lanes: service games (grouped) and raw rallies, labelled with owner-assigned
 * player names. Bars seek on click and show their fields on hover. The setup panel
 * (start time + player names) drives the owner-only run; names are editable after.
 */
export function RallySegments({
  videoId,
  canRun,
  durationS,
  initialStatus,
  initialSegments,
  initialError,
  initialPlayers,
  participantNames,
  onSeek,
  onPlayersNamed,
  currentTime = 0,
}: {
  videoId: string;
  canRun: boolean;
  durationS: number | null;
  initialStatus: Status;
  initialSegments: Segment[];
  initialError: string | null;
  initialPlayers: Players | null;
  /** Prefill / datalist options: you, plus anyone already tagged on the match. */
  participantNames: string[];
  onSeek: (seconds: number) => void;
  /** Names the owner entered here, to tag on the match as players. */
  onPlayersNamed?: (names: string[]) => void;
  /** Playback position, so the playhead tracks the video across every lane. */
  currentTime?: number;
}) {
  const [status, setStatus] = useState<Status>(initialStatus);
  const [segments, setSegments] = useState<Segment[]>(initialSegments);
  const [error, setError] = useState<string | null>(initialError);
  const [busy, setBusy] = useState(false);
  const [players, setPlayers] = useState<Players>({
    player_1: initialPlayers?.player_1 ?? null,
    player_2: initialPlayers?.player_2 ?? null,
  });
  // Setup panel state.
  const [setupOpen, setSetupOpen] = useState(false);
  const [trim, setTrim] = useState("");
  const [p1Name, setP1Name] = useState("");
  const [p2Name, setP2Name] = useState("");
  const active = useRef(true);

  /** Names offered as prefills and datalist options, de-duplicated. */
  const suggestions = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of participantNames) {
      const name = raw.trim();
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      out.push(name);
    }
    return out;
  }, [participantNames]);

  const nameOf = useCallback(
    (slot: Slot) => {
      const n = players[slot];
      return n && n.trim() ? n : DEFAULT_NAME[slot];
    },
    [players],
  );
  const displayPlayer = useCallback(
    (p: string | null | undefined) => (p === "player_1" || p === "player_2" ? nameOf(p) : "Unknown"),
    [nameOf],
  );

  useEffect(() => {
    if (status !== "processing") return;
    active.current = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const res = await fetch(`/api/videos/${videoId}/analyze`);
        if (!res.ok || !active.current) return;
        const data = await res.json();
        if (!active.current) return;
        setStatus(data.analysisStatus);
        setSegments(data.segments ?? []);
        setError(data.analysisError ?? null);
        if (data.analysisStatus === "processing") timer = setTimeout(poll, 4000);
      } catch {
        if (active.current) timer = setTimeout(poll, 4000);
      }
    }
    timer = setTimeout(poll, 4000);
    return () => {
      active.current = false;
      clearTimeout(timer);
    };
  }, [status, videoId]);

  /**
   * Fill empty slots from the suggestions — you first (you're on court far more
   * often than not), then whoever else is tagged. Without this the panel opened
   * blank every time and the names had to be typed out again on a re-analyse.
   */
  const openSetup = useCallback(() => {
    const taken: string[] = [];
    const fill = (current: string | null): string => {
      if (current && current.trim()) {
        taken.push(current.trim().toLowerCase());
        return current;
      }
      const next = suggestions.find((n) => !taken.includes(n.toLowerCase()));
      if (next) taken.push(next.toLowerCase());
      return next ?? "";
    };
    setP1Name(fill(players.player_1));
    setP2Name(fill(players.player_2));
    setSetupOpen(true);
  }, [players, suggestions]);

  const draftPlayers = (): Players => ({
    player_1: p1Name.trim() || null,
    player_2: p2Name.trim() || null,
  });

  // Start (or re-run) the analysis with the chosen start time + player names.
  const run = useCallback(async () => {
    setBusy(true);
    setError(null);
    const startTimeSec = parseTrim(trim);
    const nextPlayers = draftPlayers();
    try {
      const res = await fetch(`/api/videos/${videoId}/analyze`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...(startTimeSec ? { startTimeSec } : {}), players: nextPlayers }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setPlayers(nextPlayers);
        // Naming the two players here says they played, so tag them on the match
        // rather than making the same names get typed in again under Edit.
        onPlayersNamed?.([nextPlayers.player_1, nextPlayers.player_2].filter((n): n is string => !!n));
        setStatus(data.analysisStatus ?? "processing");
        setSetupOpen(false);
      } else {
        setStatus("failed");
        setError(data.error ?? "Couldn't start analysis.");
      }
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId, trim, p1Name, p2Name]);

  // Save renamed / swapped players without re-running the analysis.
  const saveNames = useCallback(async () => {
    setBusy(true);
    const nextPlayers = draftPlayers();
    try {
      const res = await fetch(`/api/videos/${videoId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ players: nextPlayers }),
      });
      if (res.ok) {
        setPlayers(nextPlayers);
        onPlayersNamed?.([nextPlayers.player_1, nextPlayers.player_2].filter((n): n is string => !!n));
        setSetupOpen(false);
      }
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId, p1Name, p2Name]);

  const swap = useCallback(() => {
    setP1Name(p2Name);
    setP2Name(p1Name);
  }, [p1Name, p2Name]);

  /**
   * Swap the two names on the timeline itself and persist it.
   *
   * player_1/player_2 are positional — whoever the model judged to be nearest
   * the camera at the start — so it gets them the wrong way round often enough
   * that this needed to be one click rather than a trip through the setup modal.
   * Nothing about the analysis changes: the segments still say player_1, only
   * the label attached to that slot moves.
   */
  const swapSaved = useCallback(async () => {
    const next: Players = { player_1: players.player_2, player_2: players.player_1 };
    setPlayers(next); // optimistic — a relabel should feel instant
    setBusy(true);
    try {
      const res = await fetch(`/api/videos/${videoId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ players: next }),
      });
      if (!res.ok) setPlayers(players); // put it back
    } catch {
      setPlayers(players);
    } finally {
      setBusy(false);
    }
  }, [videoId, players]);

  const games = useMemo(() => buildServiceGames(segments), [segments]);

  const serveCounts = useMemo(() => {
    const c: Record<string, number> = { player_1: 0, player_2: 0 };
    for (const g of games) if (g.server === "player_1" || g.server === "player_2") c[g.server]++;
    return c;
  }, [games]);

  const total = useMemo(() => {
    const lastEnd = segments.reduce((m, s) => Math.max(m, s.endS ?? 0), 0);
    return Math.max(durationS ?? 0, lastEnd, 1);
  }, [segments, durationS]);

  const ticks = useMemo(() => {
    const step = tickIntervalSec(total);
    const out: number[] = [];
    for (let t = step; t < total; t += step) out.push(t);
    return out;
  }, [total]);

  /**
   * Lane width in pixels, so a bar can decide whether it has room for its shot
   * count. Bars are positioned in % of the match duration, so the same rally is
   * 40px wide on a desktop and 8px on a phone — the only honest way to know is
   * to measure. Falls back to hiding the labels until the first measurement.
   */
  const laneRef = useRef<HTMLDivElement | null>(null);
  const [laneWidth, setLaneWidth] = useState(0);
  useEffect(() => {
    const el = laneRef.current;
    if (!el) return;
    const measure = () => setLaneWidth(el.getBoundingClientRect().width);
    measure();
    // ResizeObserver catches the cases a window listener misses (the sidebar, or
    // the video finishing layout and reflowing the lane); the listener is the
    // fallback for anywhere the observer doesn't deliver.
    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(([entry]) => setLaneWidth(entry.contentRect.width))
        : null;
    ro?.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [segments.length]);

  /**
   * Room needed for a shot count, per digit. Below this the number spills past
   * the bar's edges (the bar can't clip it — see .tl-bar-rally in globals.css)
   * and reads as noise rather than data.
   */
  const shotsLabelFits = (shots: number, barPx: number) =>
    barPx >= (shots >= 10 ? 17 : 11);

  const pct = (x: number) => `${Math.min(100, Math.max(0, (x / total) * 100))}%`;

  /**
   * Seek to wherever in the match a click landed. Every lane and the scrubber
   * share one coordinate system (full width, % of `total`), so the same handler
   * works for all of them — clicking a bar seeks to that bar, clicking the gap
   * between bars seeks to that moment.
   */
  const seekFromPointer = useCallback(
    (e: React.PointerEvent<HTMLElement> | React.MouseEvent<HTMLElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      if (rect.width <= 0) return;
      const ratio = (e.clientX - rect.left) / rect.width;
      onSeek(Math.min(total, Math.max(0, ratio * total)));
    },
    [onSeek, total],
  );

  /** Drag the scrubber: keep seeking while the pointer is held. */
  const scrubDrag = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (e.buttons !== 1) return;
      seekFromPointer(e);
    },
    [seekFromPointer],
  );

  const spanPct = (a: number, b: number) => `${Math.max(0.4, ((b - a) / total) * 100)}%`;
  const tipClass = (x: number) => {
    const lp = (x / total) * 100;
    return lp < 12 ? "tip-left" : lp > 88 ? "tip-right" : "";
  };

  if (!canRun && segments.length === 0) return null;

  const button = canRun ? (
    status === "processing" ? (
      <button className="btn" disabled>
        Analysing rallies…
      </button>
    ) : status === "ready" ? (
      <button className="btn secondary btn-sm" onClick={openSetup}>
        Re-analyse
      </button>
    ) : status === "failed" ? (
      <button className="btn" onClick={openSetup}>
        Try again
      </button>
    ) : (
      <button className="btn" onClick={openSetup}>
        AI Breakdown <span className="beta-badge">Beta</span>
      </button>
    )
  ) : null;

  return (
    <section className="segments">
      <div className="segments-head">
        <h3>
          AI breakdown
          {segments.length > 0 && (
            <span className="seg-count">
              {segments.length} {segments.length === 1 ? "rally" : "rallies"}
            </span>
          )}
        </h3>
        {button}
      </div>

      {canRun && status === "none" && segments.length === 0 && (
        <p className="muted seg-hint">Break this match into rallies with AI.</p>
      )}
      {status === "processing" && (
        <p className="seg-analysing">Analysing rallies… this can take a few minutes.</p>
      )}

      {/* While a run is in flight, show the shape of the answer: the same two
          lanes the result will fill, each with a full-length bar sweeping a
          highlight left to right, the rows staggered so it reads as one wave. */}
      {status === "processing" && (
        <div className="timeline" aria-hidden="true">
          <div className="tl-row">
            <div className="tl-row-label">Service games</div>
            <div className="tl-lane">
              <div className="tl-bar tl-bar-pending" />
            </div>
          </div>
          <div className="tl-row">
            <div className="tl-row-label">Rallies</div>
            <div className="tl-lane">
              <div className="tl-bar tl-bar-pending tl-bar-pending-2" />
            </div>
          </div>
        </div>
      )}
      {status === "ready" && segments.length === 0 && (
        <p className="muted seg-hint">No rallies were detected in this match. Try Re-analyse.</p>
      )}
      {status === "failed" && error && <p className="muted seg-hint">{error}</p>}

      {/* On a re-analyze the old segments are still loaded; the pending lanes
          above stand in for them until the new result lands. */}
      {segments.length > 0 && status !== "processing" && (
        <div className="timeline">
          {/* Players + serve summary */}
          <div className="players-legend">
            {(["player_1", "player_2"] as const).map((p) => (
              <span key={p} className="player-tag">
                <span className={`player-dot ${p}`} />
                {nameOf(p)}
                <span className="muted">
                  {" · "}
                  {serveCounts[p]} service {serveCounts[p] === 1 ? "game" : "games"}
                </span>
              </span>
            ))}
            {canRun && (
              <>
                {/* The model decides which player is "near at the start"; when it
                    gets that backwards every name on the timeline is wrong, and
                    the fix is a relabel, not another analysis run. */}
                <button
                  className="player-edit"
                  onClick={swapSaved}
                  disabled={busy}
                  title="Swap the two names — no re-analysis needed"
                >
                  Swap names
                </button>
                <button className="player-edit" onClick={openSetup}>
                  Edit players
                </button>
              </>
            )}
          </div>

          {/* One coordinate system for the whole stack, so a single playhead can
              span the service games, the scrubber and the rallies. */}
          <div className="tl-stack">
            <div className="tl-playhead" style={{ left: pct(currentTime) }} aria-hidden="true" />

          {/* Row 1 — service games */}
          <div className="tl-row">
            <div className="tl-row-label">Service games</div>
            <div className="tl-lane" onClick={seekFromPointer}>
              {games.map((g, i) => (
                <button
                  key={`g${i}`}
                  className={`tl-bar tl-bar-game ${g.server ?? ""}`}
                  style={{ left: pct(g.startS), width: spanPct(g.startS, g.endS) }}
                  // Stop the lane's own seek-to-pointer handler running too — a
                  // bar means "the start of this game", not "wherever I clicked".
                  onClick={(e) => {
                    e.stopPropagation();
                    onSeek(g.startS);
                  }}
                  title={`${displayPlayer(g.server)} serving`}
                >
                  <span className="tl-bar-label">{displayPlayer(g.server)}</span>
                  <span className={`tl-tip ${tipClass(g.startS)}`}>
                    <span className="tl-tip-strong">{displayPlayer(g.server)} serving</span>
                    <span className="tl-tip-meta">
                      Game {g.game} · {g.points} {g.points === 1 ? "point" : "points"}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* The scrubber sits between the two lanes, so service games read as
              "above the timeline" and rallies as "below" it. */}
          <div
            className="tl-scrub"
            role="slider"
            aria-label="Seek"
            aria-valuemin={0}
            aria-valuemax={Math.round(total)}
            aria-valuenow={Math.round(currentTime)}
            aria-valuetext={fmtTime(currentTime)}
            tabIndex={0}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              seekFromPointer(e);
            }}
            onPointerMove={scrubDrag}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft") onSeek(Math.max(0, currentTime - 5));
              else if (e.key === "ArrowRight") onSeek(Math.min(total, currentTime + 5));
              else return;
              e.preventDefault();
            }}
          >
            <div className="tl-scrub-track">
              <div className="tl-scrub-fill" style={{ width: pct(currentTime) }} />
            </div>
            <div className="tl-scrub-handle" style={{ left: pct(currentTime) }} />
          </div>

          {/* Row 2 — raw rallies */}
          <div className="tl-row">
            <div className="tl-row-label">Rallies</div>
            <div className="tl-lane tl-lane-rallies" ref={laneRef} onClick={seekFromPointer}>
              {segments.map((s) => {
                const start = s.startS ?? 0;
                const end = s.endS ?? start;
                const server = asStr(s.metadata.server);
                const receiver = asStr(s.metadata.receiver);
                const side = asStr(s.metadata.serving_side); // near | far
                const shots = asNum(s.metadata.shots);
                const what = asStr(s.metadata.what_you_see);
                const roles = server
                  ? `${displayPlayer(server)} serving${receiver ? ` · ${displayPlayer(receiver)} receiving` : ""}`
                  : "";
                const detail = [
                  side === "near" ? "Near end" : side === "far" ? "Far end" : null,
                  shots != null ? `${shots} ${shots === 1 ? "hit" : "hits"}` : null,
                ]
                  .filter(Boolean)
                  .join(" · ");
                return (
                  <button
                    key={s.id}
                    className="tl-bar tl-bar-rally"
                    style={{ left: pct(start), width: spanPct(start, end) }}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSeek(start);
                    }}
                    title={`${fmtTime(start)}–${fmtTime(end)}`}
                  >
                    {shots != null && shotsLabelFits(shots, ((end - start) / total) * laneWidth) && (
                      <span className="tl-bar-shots">{shots}</span>
                    )}
                    <span className={`tl-tip ${tipClass(start)}`}>
                      <span className="tl-tip-strong">
                        {fmtTime(start)}–{fmtTime(end)}
                      </span>
                      {roles && <span className="tl-tip-meta">{roles}</span>}
                      {detail && <span className="tl-tip-meta">{detail}</span>}
                      {what && <span className="tl-tip-what">{what}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Time axis */}
          <div className="tl-axis">
            {ticks.map((t) => (
              <div key={t} className="tl-tick" style={{ left: pct(t) }}>
                <span className="tl-tick-label">{fmtTime(t)}</span>
              </div>
            ))}
          </div>
          </div>
        </div>
      )}

      {setupOpen && (
        <div className="modal-overlay" onClick={() => setSetupOpen(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2 style={{ fontSize: 18 }}>AI breakdown</h2>
              <button className="modal-close" aria-label="Close" onClick={() => setSetupOpen(false)}>
                <CloseIcon size={20} />
              </button>
            </div>

            <div className="field">
              <span className="lbl">Game start</span>
              <label className="trim-control">
                <span className="muted">Skip warm-up to</span>
                <input
                  type="text"
                  value={trim}
                  onChange={(e) => setTrim(e.target.value)}
                  placeholder="0:00"
                  inputMode="numeric"
                />
              </label>
              <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                Leave blank to analyse from the start. Used when you run/re-analyse.
              </p>
            </div>

            <div className="field">
              <span className="lbl">Players</span>
              <div className="court-hint">
                <span>Far end (top of frame)</span>
                <span className="court-net" />
                <span>Near end (bottom of frame)</span>
              </div>
              <div className="player-field">
                <span className="player-dot player_1" />
                <span className="player-field-label">Player 1 — starts near</span>
                <input
                  list="ai-player-names"
                  value={p1Name}
                  onChange={(e) => setP1Name(e.target.value)}
                  placeholder="Name (optional)"
                />
              </div>
              <div className="player-field">
                <span className="player-dot player_2" />
                <span className="player-field-label">Player 2 — starts far</span>
                <input
                  list="ai-player-names"
                  value={p2Name}
                  onChange={(e) => setP2Name(e.target.value)}
                  placeholder="Name (optional)"
                />
              </div>
              <datalist id="ai-player-names">
                {participantNames.map((n) => (
                  <option key={n} value={n} />
                ))}
              </datalist>
              <button className="btn secondary btn-sm" onClick={swap} style={{ marginTop: 4 }}>
                Swap players
              </button>
            </div>

            <div className="modal-actions">
              {status === "ready" ? (
                <>
                  <button className="btn" onClick={saveNames} disabled={busy}>
                    Save names
                  </button>
                  <button className="btn secondary" onClick={run} disabled={busy}>
                    Re-analyse
                  </button>
                </>
              ) : (
                <button className="btn" onClick={run} disabled={busy}>
                  Run AI breakdown
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
