"use client";

import { useEffect, useMemo, useState } from "react";
import type { MatchStats as Stats, Movement, PlayerStats, Shot, Who } from "@/lib/matchStats";

/**
 * Our own analysis of the match, under the video: each player's numbers, then
 * two court views laid out like a broadcast graphic, the hitter always on the
 * left playing to the right:
 *
 * - placement: where each shot was struck (left) and where it bounced (right);
 *   hover one to join them, click to play it;
 * - position and zones: where the player stood during points (left) and how
 *   their shots that landed in spread over nine zones (right).
 *
 * Then the best rallies and the service games. Renders nothing until the
 * analysis worker has stored an analysis (match_analyses).
 */

// Court in metres. Drawn lengthwise: screen x runs along the court (net in the
// middle), screen y across it. Every shot is turned so its hitter is on the
// left, the way you'd see it from their end.
const HALF = 11.885, SERVICE = 6.4, SINGLES = 4.115, DOUBLES = 5.485;
const PAD_L = 4.8, PAD_W = 2.2, S = 22;
const W = (2 * HALF + 2 * PAD_L) * S, H = (2 * DOUBLES + 2 * PAD_W) * S;
const U = (y: number) => (y + HALF + PAD_L) * S;
const V = (x: number) => (x + DOUBLES + PAD_W) * S;
const LINES: [number, number, number, number][] = [
  [-DOUBLES, -HALF, DOUBLES, -HALF], [-DOUBLES, HALF, DOUBLES, HALF],
  [-DOUBLES, -HALF, -DOUBLES, HALF], [DOUBLES, -HALF, DOUBLES, HALF],
  [-SINGLES, -HALF, -SINGLES, HALF], [SINGLES, -HALF, SINGLES, HALF],
  [-SINGLES, SERVICE, SINGLES, SERVICE], [-SINGLES, -SERVICE, SINGLES, -SERVICE],
  [0, -SERVICE, 0, SERVICE],
];

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const num = (v: number | null | undefined, unit = "") => (v == null ? "–" : `${Math.round(v)}${unit}`);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** A point as seen from the hitter's end: the far end's shots turned round. */
const facing = (p: [number, number], hitter: Shot["hitter"]): [number, number] =>
  hitter === "far" ? [-p[0], -p[1]] : p;

type Stroke = "serve" | "forehand" | "backhand";
// Forehand / backhand aren't detected yet; rally shots count as forehands until they are.
const strokeOf = (s: Shot): Stroke => (s.serve ? "serve" : s.stroke ?? "forehand");
const isIn = (s: Shot) => s.landing === "in" || s.landing === "close";
const isOut = (s: Shot) => s.landing === "out" || s.landing === "net";

// --- Filters ------------------------------------------------------------------

type Selection = { players: Set<string>; strokes: Set<Stroke>; roles: Set<string> };
const ROLES: [string, string][] = [["serving", "Serving"], ["receiving", "Receiving"]];
const STROKES: [Stroke, string][] = [["serve", "Serve"], ["forehand", "Forehand"], ["backhand", "Backhand"]];

function allOf(players: [string, string][]): Selection {
  return {
    players: new Set(players.map(([v]) => v)),
    strokes: new Set(STROKES.map(([v]) => v)),
    roles: new Set(ROLES.map(([v]) => v)),
  };
}

/** A shot passes when each group includes its value; unknown values only when the whole group is on. */
function passes(sel: Selection, player: string | undefined, stroke: Stroke | null, role: string | null | undefined, groups: { players: number; roles: number }) {
  const okPlayer = player ? sel.players.has(player) : sel.players.size === groups.players;
  const okRole = role ? sel.roles.has(role) : sel.roles.size === groups.roles;
  const okStroke = stroke === null || sel.strokes.has(stroke);
  return okPlayer && okRole && okStroke;
}

function FilterBar({
  sel,
  onChange,
  players,
  strokes = true,
  label,
}: {
  sel: Selection;
  onChange: (s: Selection) => void;
  players: [string, string][];
  strokes?: boolean;
  label: string;
}) {
  // Each group keeps at least one choice on: an empty group would show nothing.
  const toggle = <K extends keyof Selection>(key: K, v: string) => {
    const next = new Set(sel[key] as Set<string>);
    if (next.has(v)) {
      if (next.size === 1) return;
      next.delete(v);
    } else next.add(v);
    onChange({ ...sel, [key]: next });
  };
  const group = <K extends keyof Selection>(key: K, title: string, opts: [string, string][]) => (
    <div className="mstats-fgroup" role="group" aria-label={title}>
      <span className="mstats-flabel">{title}</span>
      {opts.map(([v, l]) => {
        const on = (sel[key] as Set<string>).has(v);
        return (
          <button key={v} type="button" className={`mstats-chip ${on ? "on" : ""}`} aria-pressed={on} onClick={() => toggle(key, v)}>
            {l}
          </button>
        );
      })}
    </div>
  );
  return (
    <div className="mstats-filters" aria-label={label}>
      {group("players", "Players", players)}
      {strokes && group("strokes", "Shot", STROKES)}
      {group("roles", "Rally", ROLES)}
    </div>
  );
}

// --- Court -------------------------------------------------------------------

function Court({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <svg className="mstats-court" viewBox={`0 0 ${W} ${H}`} role="group" aria-label={label}>
      <rect x={0} y={0} width={W} height={H} rx={12} fill="var(--court)" />
      <rect x={U(-HALF)} y={V(-DOUBLES)} width={2 * HALF * S} height={2 * DOUBLES * S} fill="var(--court-in)" />
      {children}
    </svg>
  );
}

function Lines() {
  return (
    <g pointerEvents="none">
      {LINES.map(([x1, y1, x2, y2], i) => (
        <line key={i} x1={U(y1)} y1={V(x1)} x2={U(y2)} y2={V(x2)} stroke="var(--court-line)" strokeWidth={2} />
      ))}
      <line x1={U(0)} y1={V(-DOUBLES - 0.9)} x2={U(0)} y2={V(DOUBLES + 0.9)} stroke="var(--court-line)" strokeOpacity={0.7} strokeWidth={4} />
    </g>
  );
}

function Cross({ x, y, r, colour, width = 2.5 }: { x: number; y: number; r: number; colour: string; width?: number }) {
  return (
    <g stroke={colour} strokeWidth={width} strokeLinecap="round">
      <line x1={x - r} y1={y - r} x2={x + r} y2={y + r} />
      <line x1={x - r} y1={y + r} x2={x + r} y2={y - r} />
    </g>
  );
}

// --- Main ----------------------------------------------------------------------

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

  if (!stats) return null;
  return <Analysis stats={stats} onSeek={onSeek} />;
}

function Analysis({ stats, onSeek }: { stats: Stats; onSeek: (s: number) => void }) {
  const byPerson = Boolean(stats.people);
  const players: [string, string][] = byPerson
    ? [["A", "Player A"], ["B", "Player B"]]
    : [["near", "Camera end"], ["far", "Far end"]];
  const playerOf = (s: Shot) => (byPerson ? s.player : s.hitter);
  const colourOf = (who: string | undefined) =>
    who === "A" || who === "near" ? "var(--player-a)" : who === "B" || who === "far" ? "var(--player-b)" : "var(--muted)";

  const [placeSel, setPlaceSel] = useState(() => allOf(players));
  const [zoneSel, setZoneSel] = useState(() => allOf(players));
  const [hot, setHot] = useState<number | null>(null);

  const groups = { players: players.length, roles: ROLES.length };

  // Every fitted shot with somewhere to draw: a bounce on the far side of the
  // net, or the net itself. A bounce on the hitter's own side is the fit failing.
  const placed = useMemo(
    () =>
      stats.shots
        .map((s, i) => ({ s, i, from: s.from ? facing(s.from, s.hitter) : null, at: s.bounce ? facing(s.bounce, s.hitter) : null }))
        // Struck on the hitter's own side, within the drawing (a start beyond
        // that is the fit reaching back past the contact).
        .filter(({ s, from, at }) =>
          from && from[1] < 0.5 && from[1] > -HALF - PAD_L + 0.4 && Math.abs(from[0]) < DOUBLES + PAD_W - 0.4 &&
          (at ? at[1] > 0 : s.landing === "net")),
    [stats],
  );

  const shown = placed.filter(({ s }) => passes(placeSel, playerOf(s), strokeOf(s), s.role, groups));
  const hotShot = hot === null ? null : placed.find((p) => p.i === hot) ?? null;

  const play = (s: Shot) => {
    onSeek(Math.max(0, s.t - 1));
    const video = document.querySelector("video");
    const r = video?.getBoundingClientRect();
    if (video && r && (r.bottom < 80 || r.top > window.innerHeight - 80)) video.scrollIntoView({ behavior: "smooth", block: "center" });
  };

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

      {/* Placement: struck (left) → bounced (right). */}
      <div className="mstats-block">
        <div className="mstats-block-head">
          <h4>Shot placement</h4>
          <span className="muted">{shown.length} shots</span>
        </div>
        <FilterBar sel={placeSel} onChange={(s) => { setPlaceSel(s); setHot(null); }} players={players} label="Which shots to place" />
        <div>
          <Court label="Where each shot was hit from (left) and where it bounced (right)">
            <Lines />
            <text x={U(-HALF / 2)} y={18} textAnchor="middle" className="mstats-courtlabel">HIT FROM</text>
            <text x={U(HALF / 2)} y={18} textAnchor="middle" className="mstats-courtlabel">BOUNCED</text>
            {hotShot && (() => {
              const { s, from, at } = hotShot;
              const end = at ?? [from![0] * 0.15, 0];
              return (
                <line
                  x1={U(clamp(from![1], -HALF - PAD_L + 0.4, 0))} y1={V(clamp(from![0], -DOUBLES - PAD_W + 0.4, DOUBLES + PAD_W - 0.4))}
                  x2={U(end[1])} y2={V(end[0])}
                  stroke={colourOf(playerOf(s))} strokeWidth={2.5} strokeDasharray={at ? undefined : "5 4"} pointerEvents="none"
                />
              );
            })()}
            {shown.map(({ s, i, from, at }) => {
              const c = colourOf(playerOf(s));
              const hx = U(clamp(from![1], -HALF - PAD_L + 0.4, 0)), hy = V(clamp(from![0], -DOUBLES - PAD_W + 0.4, DOUBLES + PAD_W - 0.4));
              const bounceShown = at && at[1] < HALF + PAD_L - 0.3 && Math.abs(at[0]) < DOUBLES + PAD_W - 0.3;
              const bx = at ? U(at[1]) : 0, by = at ? V(at[0]) : 0;
              const dim = hot !== null && hot !== i;
              const what = `${strokeOf(s) === "serve" ? "Serve" : "Shot"} by ${players.find(([v]) => v === playerOf(s))?.[1] ?? "unknown"} at ${mmss(s.t)}, ${Math.round(s.speed)} km/h, ${s.landing === "net" ? "into the net" : s.landing ?? "uncalled"}`;
              return (
                <g
                  key={i}
                  className="mstats-shot"
                  role="button"
                  tabIndex={0}
                  aria-label={`${what}. Play it`}
                  opacity={dim ? 0.18 : s.doubt ? 0.5 : 1}
                  onMouseEnter={() => setHot(i)}
                  onMouseLeave={() => setHot((h) => (h === i ? null : h))}
                  onFocus={() => setHot(i)}
                  onBlur={() => setHot((h) => (h === i ? null : h))}
                  onClick={() => play(s)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      play(s);
                    }
                  }}
                >
                  <circle cx={hx} cy={hy} r={10} fill="transparent" />
                  {isOut(s) ? (
                    <Cross x={hx} y={hy} r={4.5} colour={c} />
                  ) : isIn(s) ? (
                    <circle cx={hx} cy={hy} r={5} fill="none" stroke={c} strokeWidth={2.5} />
                  ) : (
                    <circle cx={hx} cy={hy} r={2.5} fill={c} />
                  )}
                  {bounceShown && (
                    <>
                      <circle cx={bx} cy={by} r={10} fill="transparent" />
                      {s.landing === "out" ? (
                        <Cross x={bx} y={by} r={4.5} colour={c} />
                      ) : (
                        <circle cx={bx} cy={by} r={5} fill={c} stroke="var(--court-ink)" strokeWidth={1.2} />
                      )}
                    </>
                  )}
                </g>
              );
            })}
          </Court>
        </div>
        <p className="mstats-caption" aria-live="polite">
          {hotShot ? (
            <>
              <b style={{ color: colourOf(playerOf(hotShot.s)) }}>
                {players.find(([v]) => v === playerOf(hotShot.s))?.[1] ?? "Unknown player"}
              </b>
              {` · ${strokeOf(hotShot.s) === "serve" ? "Serve" : "Rally shot"} · ${Math.round(hotShot.s.speed)} km/h · `}
              {hotShot.s.landing === "net" ? "into the net" : hotShot.s.landing === "close" ? "on the line" : hotShot.s.landing ?? "not called"}
              {` · ${mmss(hotShot.s.t)} · click to play`}
            </>
          ) : (
            <>
              Hit from: <span className="mstats-key">○</span> landed in, <span className="mstats-key">×</span> out or into the net.
              Bounced: <span className="mstats-key">●</span> in, <span className="mstats-key">×</span> out. Hover a shot to join
              them; click to play it.
            </>
          )}
        </p>
      </div>

      {/* Position (left) and placement zones (right). */}
      <PositionAndZones
        stats={stats}
        sel={zoneSel}
        onSel={setZoneSel}
        players={players}
        placed={placed.filter(({ s }) => passes(zoneSel, playerOf(s), strokeOf(s), s.role, groups))}
      />

      {stats.rallies.length > 0 && (
        <div className="mstats-best">
          <h4 className="muted">Best rallies</h4>
          <ol>
            {[...stats.rallies]
              .filter((r) => r.shots >= 3)
              .sort((a, b) => b.intensity - a.intensity)
              .slice(0, 5)
              .map((r) => (
                <li key={r.idx}>
                  <button type="button" onClick={() => onSeek(Math.max(0, r.start - 1))}>
                    <span className="mstats-best-time">{mmss(r.start)}</span>
                    <span>{r.shots} shots</span>
                    <span>{r.maxSpeed != null ? `${Math.round(r.maxSpeed)} km/h top` : ""}</span>
                    <span>{r.run ? `${Math.round(r.run)} m run` : ""}</span>
                    {r.high && <span className="mstats-hot">High intensity</span>}
                  </button>
                </li>
              ))}
          </ol>
        </div>
      )}

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

// --- Position heatmap and the nine zones ----------------------------------------

type Placed = { s: Shot; i: number; from: [number, number] | null; at: [number, number] | null };

function PositionAndZones({
  stats,
  sel,
  onSel,
  players,
  placed,
}: {
  stats: Stats;
  sel: Selection;
  onSel: (s: Selection) => void;
  players: [string, string][];
  placed: Placed[];
}) {
  const heat = useMemo(() => sumGrids(stats.movement, sel), [stats.movement, sel]);

  // Nine zones over the receiving half of the singles court: three deep (net
  // to baseline) by three across. Shaded by how many shots landed in each.
  const zoneOf = (x: number, y: number) => {
    if (Math.abs(x) > SINGLES || y < 0 || y > HALF) return null;
    const across = Math.min(2, Math.floor(((x + SINGLES) / (2 * SINGLES)) * 3));
    const deep = Math.min(2, Math.floor((y / HALF) * 3));
    return deep * 3 + across;
  };
  const counts = Array(9).fill(0) as number[];
  let landedIn = 0, out = 0, net = 0;
  for (const { s, at } of placed) {
    if (s.landing === "net") net++;
    else if (s.landing === "out") out++;
    else if (at && isIn(s)) {
      const z = zoneOf(at[0], at[1]);
      if (z !== null) {
        counts[z]++;
        landedIn++;
      }
    }
  }
  const called = landedIn + out + net;
  const maxZone = Math.max(1, ...counts);
  const zw = (2 * SINGLES) / 3, zd = HALF / 3;

  return (
    <div className="mstats-block">
      <div className="mstats-block-head">
        <h4>Court position &amp; placement</h4>
        <span className="muted">
          {called ? `${Math.round((100 * landedIn) / called)}% in · ${out} out · ${net} net` : "no called shots"}
        </span>
      </div>
      <FilterBar sel={sel} onChange={onSel} players={players} label="Whose position and shots" />
      <div>
        <Court label="Where the player stood during points (left) and where their shots landed in, by zone (right)">
          <defs>
            <filter id="mstats-blur" x="-10%" y="-10%" width="120%" height="120%">
              <feGaussianBlur stdDeviation={heat ? heat.cell * S * 0.3 : 0} />
            </filter>
            <clipPath id="mstats-clip">
              <rect x={0} y={0} width={W / 2} height={H} />
            </clipPath>
          </defs>
          {heat && (
            <g clipPath="url(#mstats-clip)">
              <g filter="url(#mstats-blur)">
                {heat.cells.map(({ x, y, v }, k) => (
                  <rect
                    key={k}
                    x={U(y)} y={V(x)} width={heat.cell * S + 0.5} height={heat.cell * S + 0.5}
                    fill="var(--heat)" opacity={Math.min(1, Math.pow(v / heat.max, 0.45) * 1.2)}
                  />
                ))}
              </g>
            </g>
          )}
          {counts.map((n, z) => {
            const across = z % 3, deep = Math.floor(z / 3);
            return (
              <rect
                key={z}
                x={U(deep * zd)} y={V(-SINGLES + across * zw)} width={zd * S} height={zw * S}
                fill="var(--zone)" opacity={0.08 + 0.62 * (n / maxZone)}
              />
            );
          })}
          <Lines />
          {[1, 2].map((k) => (
            <g key={k} stroke="var(--court-line)" strokeOpacity={0.45} strokeDasharray="4 5" pointerEvents="none">
              <line x1={U(k * zd)} y1={V(-SINGLES)} x2={U(k * zd)} y2={V(SINGLES)} />
              <line x1={U(0)} y1={V(-SINGLES + k * zw)} x2={U(HALF)} y2={V(-SINGLES + k * zw)} />
            </g>
          ))}
          {counts.map((n, z) => {
            const across = z % 3, deep = Math.floor(z / 3);
            const cx = U(deep * zd + zd / 2), cy = V(-SINGLES + across * zw + zw / 2);
            const pct = landedIn ? Math.round((100 * n) / landedIn) : 0;
            return (
              <g key={z} pointerEvents="none">
                <rect x={cx - 30} y={cy - 17} width={60} height={40} rx={6} fill="var(--zone)" opacity={0.85} />
                <text x={cx} y={cy + 2} textAnchor="middle" className="mstats-zonepct">{pct}%</text>
                <text x={cx} y={cy + 17} textAnchor="middle" className="mstats-zonen">{n} {n === 1 ? "shot" : "shots"}</text>
              </g>
            );
          })}
          <text x={U(-HALF / 2)} y={18} textAnchor="middle" className="mstats-courtlabel">POSITION IN POINTS</text>
          <text x={U(HALF / 2)} y={18} textAnchor="middle" className="mstats-courtlabel">WHERE SHOTS LANDED IN</text>
        </Court>
      </div>
      <p className="mstats-caption">
        Left: where they stood while the ball was in play, brighter for more time (the shot type filter doesn&rsquo;t apply
        here). Right: of the shots that landed in, the share in each zone. Forehand and backhand aren&rsquo;t detected yet,
        so every rally shot counts as a forehand for now.
      </p>
    </div>
  );
}

function sumGrids(m: Movement | undefined, sel: Selection) {
  if (!m) return null;
  const sum = new Array(m.nx * m.ny).fill(0) as number[];
  for (const [key, g] of Object.entries(m.grids)) {
    const [who, role] = key.split(":");
    if (!sel.players.has(who)) continue;
    if (role === "any" ? sel.roles.size !== ROLES.length : !sel.roles.has(role)) continue;
    for (let k = 0; k < g.length; k++) sum[k] += g[k];
  }
  const cells: { x: number; y: number; v: number }[] = [];
  let max = 0;
  sum.forEach((v, k) => {
    if (!v) return;
    const i = k % m.nx, j = Math.floor(k / m.nx);
    cells.push({ x: m.x0 + i * m.cell, y: m.y0 + j * m.cell, v });
    max = Math.max(max, v);
  });
  return max ? { cells, max, cell: m.cell } : null;
}
