"use client";

import { useEffect, useMemo, useState } from "react";
import type { MatchStats as Stats, PlayerStats, Shot, Who } from "@/lib/matchStats";

/**
 * Our own analysis of the match: where every tracked shot bounced, each
 * player's serve and rally numbers, and the service games. Renders nothing
 * until the analysis worker has stored one (match_analyses).
 */

// Court in metres; drawn far end up, as the camera sees it.
const HALF = 11.885, SERVICE = 6.4, SINGLES = 4.115, DOUBLES = 5.485;
const PAD_X = 3, PAD_Y = 4, S = 12;
const W = (2 * DOUBLES + 2 * PAD_X) * S, H = (2 * HALF + 2 * PAD_Y) * S;
const X = (x: number) => (x + DOUBLES + PAD_X) * S;
const Y = (y: number) => (HALF + PAD_Y - y) * S;
const LINES: [number, number, number, number][] = [
  [-DOUBLES, -HALF, DOUBLES, -HALF], [-DOUBLES, HALF, DOUBLES, HALF],
  [-DOUBLES, -HALF, -DOUBLES, HALF], [DOUBLES, -HALF, DOUBLES, HALF],
  [-SINGLES, -HALF, -SINGLES, HALF], [SINGLES, -HALF, SINGLES, HALF],
  [-SINGLES, SERVICE, SINGLES, SERVICE], [-SINGLES, -SERVICE, SINGLES, -SERVICE],
  [0, -SERVICE, 0, SERVICE],
];

type Filter = "all" | "serves" | Who | "near" | "far";

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const num = (v: number | null | undefined, unit = "") => (v == null ? "–" : `${Math.round(v)}${unit}`);

export function MatchStats({
  videoId,
  onSeek,
  onLoaded,
}: {
  videoId: string;
  onSeek: (s: number) => void;
  /** Whether this match has an analysis, once known (the page shows tracking then). */
  onLoaded?: (has: boolean) => void;
}) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  useEffect(() => {
    let live = true;
    fetch(`/api/videos/${videoId}/match-stats`)
      .then((r) => (r.ok ? r.json() : { stats: null }))
      .then((d) => {
        if (!live) return;
        setStats(d.stats ?? null);
        onLoaded?.(Boolean(d.stats));
      })
      .catch(() => live && setStats(null));
    return () => {
      live = false;
    };
  }, [videoId, onLoaded]);

  const byPerson = Boolean(stats?.people);
  const colour = (s: Shot) =>
    byPerson ? (s.player === "B" ? "var(--player-b)" : s.player === "A" ? "var(--player-a)" : "var(--muted)")
             : s.hitter === "far" ? "var(--player-b)" : "var(--player-a)";

  const shown = useMemo(
    () =>
      (stats?.shots ?? []).filter((s) => {
        if (!s.bounce) return false;
        if (filter === "serves") return s.serve;
        if (filter === "A" || filter === "B") return s.player === filter;
        if (filter === "near" || filter === "far") return s.hitter === filter;
        return true;
      }),
    [stats, filter],
  );

  if (!stats) return null;

  const filters: [Filter, string][] = [
    ["all", "All"],
    ["serves", "Serves"],
    ...(byPerson
      ? ([["A", "Player A"], ["B", "Player B"]] as [Filter, string][])
      : ([["near", "Camera end"], ["far", "Far end"]] as [Filter, string][])),
  ];
  const cards: [string, PlayerStats, string][] = byPerson
    ? [["Player A", stats.people!.A, "var(--player-a)"], ["Player B", stats.people!.B, "var(--player-b)"]]
    : [["Camera end", stats.near, "var(--player-a)"], ["Far end", stats.far, "var(--player-b)"]];

  return (
    <section className="mstats" aria-labelledby="mstats-title">
      <div className="segments-head">
        <h3 id="mstats-title">
          Shot analysis <span className="mstats-beta">Beta</span>
        </h3>
        <span className="seg-count">
          {stats.points ?? stats.rallies.length} points · {stats.hits ?? stats.shots.length} shots
        </span>
      </div>
      <p className="seg-hint muted">
        Every shot we tracked, with its speed and where it bounced. Tap a bounce or a game to jump there.
      </p>

      <div className="mstats-grid">
        <div className="mstats-map">
          <div className="mstats-filters" role="group" aria-label="Which shots">
            {filters.map(([f, label]) => (
              <button
                key={f}
                type="button"
                className={`mstats-chip ${filter === f ? "on" : ""}`}
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
              >
                {label}
              </button>
            ))}
          </div>
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Where the shots bounced">
            <rect x={0} y={0} width={W} height={H} rx={10} fill="var(--surface-2)" />
            {LINES.map(([a, b, c, d], i) => (
              <line key={i} x1={X(a)} y1={Y(b)} x2={X(c)} y2={Y(d)} stroke="var(--text)" strokeOpacity={0.55} strokeWidth={1.5} />
            ))}
            <line x1={X(-6.4)} y1={Y(0)} x2={X(6.4)} y2={Y(0)} stroke="var(--text)" strokeWidth={2.5} />
            <text x={W / 2} y={Y(HALF) - 10} textAnchor="middle" fontSize={11} fill="var(--muted)">far end</text>
            <text x={W / 2} y={Y(-HALF) + 20} textAnchor="middle" fontSize={11} fill="var(--muted)">camera end</text>
            {shown.map((s, i) => {
              const [x, y] = s.bounce!;
              if (Math.abs(x) > DOUBLES + PAD_X || Math.abs(y) > HALF + PAD_Y) return null;
              const out = s.landing === "out";
              const c = colour(s);
              return (
                <circle
                  key={i}
                  cx={X(x)}
                  cy={Y(y)}
                  r={s.serve ? 5 : 4}
                  fill={out ? "none" : c}
                  stroke={out ? c : "var(--bg)"}
                  strokeWidth={out ? 2 : 1}
                  opacity={s.doubt ? 0.45 : 0.95}
                  style={{ cursor: "pointer" }}
                  onClick={() => onSeek(Math.max(0, s.t - 1))}
                >
                  <title>
                    {`${s.serve ? "Serve" : "Shot"} at ${mmss(s.t)}: ${Math.round(s.speed)} km/h, ${s.landing ?? "uncalled"}`}
                  </title>
                </circle>
              );
            })}
          </svg>
          <div className="mstats-legend muted">
            <span><i style={{ background: "var(--player-a)" }} />{byPerson ? "Player A" : "Camera end"}</span>
            <span><i style={{ background: "var(--player-b)" }} />{byPerson ? "Player B" : "Far end"}</span>
            <span><i className="ring" />Called out</span>
          </div>
        </div>

        <div className="mstats-cards">
          {cards.map(([label, p, c]) => (
            <div key={label} className="mstats-card" style={{ borderTopColor: c }}>
              <h4>
                {label}
                {p.swatch && (
                  <span className="mstats-kit" title="Shirt and shorts">
                    <i style={{ background: p.swatch[0] }} />
                    <i style={{ background: p.swatch[1] }} />
                  </span>
                )}
              </h4>
              <dl>
                <div><dt>Serve, avg</dt><dd>{num(p.serveAvg)}<small> km/h</small></dd></div>
                <div><dt>Serve, max</dt><dd>{num(p.serveMax)}<small> km/h</small></dd></div>
                <div><dt>Rally shot, avg</dt><dd>{num(p.shotAvg)}<small> km/h</small></dd></div>
                <div><dt>Rally shot, max</dt><dd>{num(p.shotMax)}<small> km/h</small></dd></div>
                <div><dt>Landed in</dt><dd>{num(p.inPct)}<small>%</small></dd></div>
                <div><dt>Into the net</dt><dd>{num(p.netPct)}<small>%</small></dd></div>
                {p.firstServeIn != null && (
                  <div><dt>1st serves in</dt><dd>{num(p.firstServeIn)}<small>%</small></dd></div>
                )}
                <div><dt>Ran in rallies</dt><dd>{num(p.distance)}<small> m</small></dd></div>
              </dl>
            </div>
          ))}
        </div>
      </div>

      {stats.games && stats.games.length > 0 && (
        <div className="mstats-games">
          <h4 className="muted">Service games</h4>
          <div className="mstats-strip">
            {stats.games.map((g, i) => (
              <span key={i} className="mstats-gamewrap">
                <button
                  type="button"
                  className="mstats-game"
                  style={{ borderTopColor: g.server === "A" ? "var(--player-a)" : "var(--player-b)" }}
                  onClick={() => onSeek(Math.max(0, g.start - 2))}
                  title={`Game ${i + 1} at ${mmss(g.start)}: player ${g.server} served from the ${g.serverEnd === "near" ? "camera" : "far"} end`}
                >
                  <b>{g.server}</b>
                  <span>{g.points} pts</span>
                </button>
                {g.changeoverAfter && <span className="mstats-swap" title="Players change ends">⇄</span>}
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
