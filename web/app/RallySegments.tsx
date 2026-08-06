"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Status = "none" | "processing" | "ready" | "failed";

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

const PLAYER: Record<string, string> = { player_1: "Player 1", player_2: "Player 2" };
const playerLabel = (p: string | null | undefined) => (p && PLAYER[p]) || "Unknown";
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
 * Two lanes: service games (grouped) and raw rallies. Bars seek on click and show
 * their fields on hover. Owner-only trigger; anyone who can see the match sees it.
 */
export function RallySegments({
  videoId,
  canRun,
  durationS,
  initialStatus,
  initialSegments,
  initialError,
  onSeek,
}: {
  videoId: string;
  canRun: boolean;
  durationS: number | null;
  initialStatus: Status;
  initialSegments: Segment[];
  initialError: string | null;
  onSeek: (seconds: number) => void;
}) {
  const [status, setStatus] = useState<Status>(initialStatus);
  const [segments, setSegments] = useState<Segment[]>(initialSegments);
  const [error, setError] = useState<string | null>(initialError);
  const [busy, setBusy] = useState(false);
  const [trim, setTrim] = useState(""); // optional "skip warm-up to" (m:ss)
  const active = useRef(true);

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

  const run = useCallback(async () => {
    setBusy(true);
    setError(null);
    const startTimeSec = parseTrim(trim);
    try {
      const res = await fetch(`/api/videos/${videoId}/analyze`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(startTimeSec ? { startTimeSec } : {}),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setStatus(data.analysisStatus ?? "processing");
      } else {
        setStatus("failed");
        setError(data.error ?? "Couldn't start analysis.");
      }
    } finally {
      setBusy(false);
    }
  }, [videoId, trim]);

  const games = useMemo(() => buildServiceGames(segments), [segments]);

  // Per-player service-game counts, for the legend (only players who served show).
  const serveCounts = useMemo(() => {
    const c: Record<string, number> = { player_1: 0, player_2: 0 };
    for (const g of games) if (g.server === "player_1" || g.server === "player_2") c[g.server]++;
    return c;
  }, [games]);

  // Total timeline length: stored duration, else the last rally's end.
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

  const pct = (x: number) => `${Math.min(100, Math.max(0, (x / total) * 100))}%`;
  const spanPct = (a: number, b: number) => `${Math.max(0.4, ((b - a) / total) * 100)}%`;
  // Anchor the hover tooltip left/right for edge bars so it doesn't clip off-screen.
  const tipClass = (x: number) => {
    const lp = (x / total) * 100;
    return lp < 12 ? "tip-left" : lp > 88 ? "tip-right" : "";
  };

  if (!canRun && segments.length === 0) return null;

  const button = canRun ? (
    status === "processing" ? (
      <button className="btn" disabled>
        Analyzing rallies…
      </button>
    ) : status === "ready" ? (
      <button className="btn secondary btn-sm" onClick={run} disabled={busy}>
        Re-analyze
      </button>
    ) : status === "failed" ? (
      <button className="btn" onClick={run} disabled={busy}>
        Try again
      </button>
    ) : (
      <button className="btn" onClick={run} disabled={busy}>
        AI Breakdown <span className="beta-badge">Beta</span>
      </button>
    )
  ) : null;

  return (
    <section className="segments">
      <div className="segments-head">
        <h3>
          Rallies{segments.length > 0 && <span className="seg-count">{segments.length}</span>}
        </h3>
        <div className="seg-actions">
          {canRun && status !== "processing" && (
            <label className="trim-control" title="Skip warm-up — start the analysis at this time (m:ss)">
              <span className="muted">Skip to</span>
              <input
                type="text"
                value={trim}
                onChange={(e) => setTrim(e.target.value)}
                placeholder="0:00"
                inputMode="numeric"
                aria-label="Skip warm-up to (minutes:seconds)"
              />
            </label>
          )}
          {button}
        </div>
      </div>

      {canRun && status === "none" && segments.length === 0 && (
        <p className="muted seg-hint">Break this match into rallies with AI.</p>
      )}
      {status === "processing" && (
        <p className="muted seg-hint">Analyzing rallies… this can take a few minutes.</p>
      )}
      {status === "ready" && segments.length === 0 && (
        <p className="muted seg-hint">No rallies were detected in this match. Try Re-analyze.</p>
      )}
      {status === "failed" && error && <p className="muted seg-hint">{error}</p>}

      {segments.length > 0 && (
        <div className="timeline">
          {/* Players + serve summary */}
          <div className="players-legend">
            {(["player_1", "player_2"] as const).map((p) => (
              <span key={p} className="player-tag">
                <span className={`player-dot ${p}`} />
                {playerLabel(p)}
                <span className="muted">
                  {" · "}
                  {serveCounts[p]} service {serveCounts[p] === 1 ? "game" : "games"}
                </span>
              </span>
            ))}
          </div>

          {/* Row 1 — service games */}
          <div className="tl-row">
            <div className="tl-row-label">Service games</div>
            <div className="tl-lane">
              {games.map((g, i) => (
                <button
                  key={`g${i}`}
                  className={`tl-bar tl-bar-game ${g.server ?? ""}`}
                  style={{ left: pct(g.startS), width: spanPct(g.startS, g.endS) }}
                  onClick={() => onSeek(g.startS)}
                  title={`${playerLabel(g.server)} serving`}
                >
                  <span className="tl-bar-label">{playerLabel(g.server)}</span>
                  <span className={`tl-tip ${tipClass(g.startS)}`}>
                    <span className="tl-tip-strong">{playerLabel(g.server)} serving</span>
                    <span className="tl-tip-meta">
                      Game {g.game} · {g.points} {g.points === 1 ? "point" : "points"}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Row 2 — raw rallies */}
          <div className="tl-row">
            <div className="tl-row-label">Rallies</div>
            <div className="tl-lane">
              {segments.map((s) => {
                const start = s.startS ?? 0;
                const end = s.endS ?? start;
                const server = asStr(s.metadata.server);
                const receiver = asStr(s.metadata.receiver);
                const side = asStr(s.metadata.serving_side); // near | far
                const shots = asNum(s.metadata.shots);
                const what = asStr(s.metadata.what_you_see);
                const roles = server
                  ? `${playerLabel(server)} serving${receiver ? ` · ${playerLabel(receiver)} receiving` : ""}`
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
                    onClick={() => onSeek(start)}
                    title={`${fmtTime(start)}–${fmtTime(end)}`}
                  >
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
      )}
    </section>
  );
}
