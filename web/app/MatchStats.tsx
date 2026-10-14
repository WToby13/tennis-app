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

/** The owner's names for players A (player_1, starts at the camera end) and B. */
export type PlayerNames = { A: string | null; B: string | null };

const nameOf = (names: PlayerNames | undefined, who: "A" | "B") =>
  names?.[who] || (who === "A" ? "Player 1" : "Player 2");
/** Short label for tight spots: a first name, or P1 / P2. */
const shortOf = (names: PlayerNames | undefined, who: "A" | "B") =>
  names?.[who]?.split(/\s+/)[0] || (who === "A" ? "P1" : "P2");

export function MatchStats({
  videoId,
  onSeek,
  onLoaded,
  names,
}: {
  videoId: string;
  onSeek: (s: number) => void;
  names?: PlayerNames;
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
  return <Analysis stats={stats} onSeek={onSeek} names={names} />;
}

function Analysis({ stats, onSeek, names }: { stats: Stats; onSeek: (s: number) => void; names?: PlayerNames }) {
  const byPerson = Boolean(stats.people);
  const players: [string, string][] = byPerson
    ? [["A", nameOf(names, "A")], ["B", nameOf(names, "B")]]
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
    ? [[nameOf(names, "A"), stats.people!.A, "var(--player-a)"], [nameOf(names, "B"), stats.people!.B, "var(--player-b)"]]
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

      <div className="mstats-body">
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

      <div className="mstats-pair">
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
            <text x={U(-HALF / 2)} y={24} textAnchor="middle" className="mstats-courtlabel">HIT FROM</text>
            <text x={U(HALF / 2)} y={24} textAnchor="middle" className="mstats-courtlabel">BOUNCED</text>
            {hotShot && (() => {
              const { s, from, at } = hotShot;
              const end = at ?? [from![0] * 0.15, 0];
              return (
                <line
                  x1={U(clamp(from![1], -HALF - PAD_L + 0.4, 0))} y1={V(clamp(from![0], -DOUBLES - PAD_W + 0.4, DOUBLES + PAD_W - 0.4))}
                  x2={U(end[1])} y2={V(end[0])}
                  stroke={colourOf(playerOf(s))} strokeWidth={3.5} strokeDasharray={at ? undefined : "7 6"} pointerEvents="none"
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
                  <circle cx={hx} cy={hy} r={12} fill="transparent" />
                  {isOut(s) ? (
                    <Cross x={hx} y={hy} r={6.5} colour={c} width={3} />
                  ) : isIn(s) ? (
                    <circle cx={hx} cy={hy} r={7} fill="none" stroke={c} strokeWidth={3} />
                  ) : (
                    <circle cx={hx} cy={hy} r={3.5} fill={c} />
                  )}
                  {bounceShown && (
                    <>
                      <circle cx={bx} cy={by} r={12} fill="transparent" />
                      {s.landing === "out" ? (
                        <Cross x={bx} y={by} r={6.5} colour={c} width={3} />
                      ) : (
                        <circle cx={bx} cy={by} r={7} fill={c} stroke="var(--court-ink)" strokeWidth={1.5} />
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

      </div>

      <BestRallies stats={stats} onSeek={onSeek} byPerson={byPerson} playerOf={playerOf} colourOf={colourOf} name={(w) => players.find(([v]) => v === w)?.[1] ?? "Unknown"} />

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
                  title={`Game ${i + 1} at ${mmss(g.start)}: ${nameOf(names, g.server === "A" ? "A" : "B")} served from the ${g.serverEnd === "near" ? "camera" : "far"} end`}
                >
                  <b>{shortOf(names, g.server === "A" ? "A" : "B")}</b>
                  <span>{g.points} pts</span>
                </button>
                {g.changeoverAfter && <span className="mstats-swap" title="Players change ends">⇄</span>}
              </span>
            ))}
          </div>
        </div>
      )}
      </div>
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

  // Nine zones for where shots were struck from, drawn on the right half as
  // the hitter's own half reflected across the net (so it lines up with the
  // heatmap): in front of the service line, between it and the baseline, and
  // behind the baseline; by left / middle / right thirds of the singles width
  // (the outer thirds run out to the edge). Each shows the shots hit from
  // there and how many of them landed in.
  const DEPTH = [0, SERVICE, HALF, HALF + PAD_L];
  const ACROSS = [-DOUBLES - PAD_W, -SINGLES / 3, SINGLES / 3, DOUBLES + PAD_W];
  const band = (edges: number[], v: number) => edges.findIndex((e, k) => k < edges.length - 1 && v >= e && v < edges[k + 1]);
  const zones = Array.from({ length: 9 }, () => ({ inn: 0, out: 0 }));
  let landedIn = 0, out = 0, net = 0;
  for (const { s, from } of placed) {
    if (!from || !(isIn(s) || isOut(s))) continue;
    if (s.landing === "net") net++;
    else if (s.landing === "out") out++;
    else landedIn++;
    const deep = band(DEPTH, -from[1]), across = band(ACROSS, from[0]);
    if (deep < 0 || across < 0) continue;
    if (isIn(s)) zones[deep * 3 + across].inn++;
    else zones[deep * 3 + across].out++;
  }
  const called = landedIn + out + net;
  const maxZone = Math.max(1, ...zones.map((z) => z.inn + z.out));

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
          {zones.map(({ inn, out: o }, z) => {
            const across = z % 3, deep = Math.floor(z / 3);
            return (
              <rect
                key={z}
                x={U(DEPTH[deep])} y={V(ACROSS[across])}
                width={(DEPTH[deep + 1] - DEPTH[deep]) * S} height={(ACROSS[across + 1] - ACROSS[across]) * S}
                fill="var(--zone)" opacity={0.06 + 0.6 * ((inn + o) / maxZone)}
              />
            );
          })}
          <Lines />
          <g stroke="var(--court-line)" strokeOpacity={0.5} strokeDasharray="4 5" pointerEvents="none">
            {[1, 2].map((k) => (
              <line key={k} x1={U(0)} y1={V(ACROSS[k])} x2={U(DEPTH[3])} y2={V(ACROSS[k])} />
            ))}
            <line x1={U(SERVICE)} y1={V(ACROSS[0])} x2={U(SERVICE)} y2={V(ACROSS[3])} />
            <line x1={U(HALF)} y1={V(ACROSS[0])} x2={U(HALF)} y2={V(ACROSS[3])} />
          </g>
          {zones.map(({ inn, out: o }, z) => {
            const across = z % 3, deep = Math.floor(z / 3);
            const cx = U((DEPTH[deep] + DEPTH[deep + 1]) / 2), cy = V((ACROSS[across] + ACROSS[across + 1]) / 2);
            const n = inn + o;
            return (
              <g key={z} pointerEvents="none" opacity={n ? 1 : 0.55}>
                <rect x={cx - 44} y={cy - 23} width={88} height={48} rx={7} fill="var(--zone)" opacity={0.9} />
                <text x={cx} y={cy + 2} textAnchor="middle" className="mstats-zonepct">{n ? `${Math.round((100 * inn) / n)}% in` : "–"}</text>
                <text x={cx} y={cy + 19} textAnchor="middle" className="mstats-zonen">
                  {n ? `${inn} in · ${o} out` : "no shots"}
                </text>
              </g>
            );
          })}
          <text x={U(-HALF / 2)} y={24} textAnchor="middle" className="mstats-courtlabel">POSITION IN POINTS</text>
          <text x={U(HALF / 2)} y={24} textAnchor="middle" className="mstats-courtlabel">HIT FROM · % IN</text>
        </Court>
      </div>
      <p className="mstats-caption">
        Left: where they stood while the ball was in play, brighter for more time (the shot type filter doesn&rsquo;t apply
        here). Right: their own half again, mirrored across the net, split into nine zones by where each shot was hit
        from, with how many of those landed in (&ldquo;out&rdquo; includes the net). Brighter zones had more shots. Forehand and backhand aren&rsquo;t detected yet,
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

// --- Best rallies ------------------------------------------------------------------

/**
 * The most intense rallies, and the one picked drawn on a court: player A's end
 * on the left, B's on the right, each shot from where it was struck to where
 * it bounced, and on to the next contact.
 */
function BestRallies({
  stats,
  onSeek,
  byPerson,
  playerOf,
  colourOf,
  name,
}: {
  stats: Stats;
  onSeek: (s: number) => void;
  byPerson: boolean;
  playerOf: (s: Shot) => string | undefined;
  colourOf: (who: string | undefined) => string;
  name: (who: string | undefined) => string;
}) {
  const best = useMemo(
    () => [...stats.rallies].filter((r) => r.shots >= 3).sort((a, b) => b.intensity - a.intensity).slice(0, 5),
    [stats],
  );
  const [picked, setPicked] = useState<number | null>(null);
  const rally = best.find((r) => r.idx === picked) ?? best[0];
  if (!rally) return null;

  const shots = stats.shots.filter((s) => s.rally === rally.idx && s.from).sort((a, b) => a.t - b.t);
  // Turn the court so player A (or the camera end) is on the left.
  const left = byPerson
    ? shots.find((s) => s.player === "A")?.hitter ?? (shots.find((s) => s.player === "B")?.hitter === "near" ? "far" : "near")
    : "near";
  const turn = (p: [number, number]): [number, number] => (left === "near" ? p : [-p[0], -p[1]]);
  const inside = (p: [number, number]): [number, number] => [
    clamp(p[0], -DOUBLES - PAD_W + 0.5, DOUBLES + PAD_W - 0.5),
    clamp(p[1], -HALF - PAD_L + 0.5, HALF + PAD_L - 0.5),
  ];
  const steps = shots.map((s) => {
    const hit = inside(turn(s.from!));
    // A bounce on the hitter's own side is the fit failing; leave it out.
    let bounce = s.bounce ? turn(s.bounce) : null;
    if (bounce && Math.sign(bounce[1]) === Math.sign(hit[1])) bounce = null;
    if (bounce && (Math.abs(bounce[0]) > DOUBLES + PAD_W - 0.3 || Math.abs(bounce[1]) > HALF + PAD_L - 0.3)) bounce = null;
    return { s, hit, bounce, c: colourOf(playerOf(s)) };
  });
  const P = ([x, y]: [number, number]) => [U(y), V(x)] as const;
  const leftWho = byPerson ? "A" : "near", rightWho = byPerson ? "B" : "far";

  return (
    <div className="mstats-block">
      <div className="mstats-block-head">
        <h4>Best rallies</h4>
        <span className="muted">tap one to play it</span>
      </div>
      <div className="mstats-pair">
        <ol className="mstats-best">
          {best.map((r, k) => (
            <li key={r.idx}>
              <button
                type="button"
                className={r.idx === rally.idx ? "on" : ""}
                aria-pressed={r.idx === rally.idx}
                onMouseEnter={() => setPicked(r.idx)}
                onFocus={() => setPicked(r.idx)}
                onClick={() => {
                  setPicked(r.idx);
                  onSeek(Math.max(0, r.start - 1));
                }}
              >
                <span className="mstats-best-rank">{k + 1}</span>
                <span className="mstats-best-main">
                  <b>{mmss(r.start)}</b> · {r.shots} shots
                  {r.high && <span className="mstats-hot">High intensity</span>}
                </span>
                <span className="mstats-best-sub muted">
                  {[r.maxSpeed != null ? `${Math.round(r.maxSpeed)} km/h top` : null, r.run ? `${Math.round(r.run)} m run` : null]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </button>
            </li>
          ))}
        </ol>
        <div className="mstats-block">
          <Court label={`Rally at ${mmss(rally.start)}: ${name(leftWho)} on the left, ${name(rightWho)} on the right`}>
            <Lines />
            <text x={U(-HALF / 2)} y={24} textAnchor="middle" className="mstats-courtlabel" style={{ fill: colourOf(leftWho), opacity: 1 }}>
              {name(leftWho).toUpperCase()}
            </text>
            <text x={U(HALF / 2)} y={24} textAnchor="middle" className="mstats-courtlabel" style={{ fill: colourOf(rightWho), opacity: 1 }}>
              {name(rightWho).toUpperCase()}
            </text>
            {/* The ball's path: struck → bounce (solid), bounce → next contact (dashed). */}
            {steps.map(({ hit, bounce, c }, k) => {
              const next = steps[k + 1]?.hit;
              const [hx, hy] = P(hit);
              const segs: React.ReactNode[] = [];
              if (bounce) {
                const [bx, by] = P(bounce);
                segs.push(<line key="a" x1={hx} y1={hy} x2={bx} y2={by} stroke={c} strokeWidth={3} />);
                if (next) {
                  const [nx, ny] = P(next);
                  segs.push(<line key="b" x1={bx} y1={by} x2={nx} y2={ny} stroke={c} strokeWidth={2} strokeDasharray="6 6" opacity={0.8} />);
                }
              } else if (next) {
                const [nx, ny] = P(next);
                segs.push(<line key="a" x1={hx} y1={hy} x2={nx} y2={ny} stroke={c} strokeWidth={3} />);
              }
              return <g key={k} pointerEvents="none">{segs}</g>;
            })}
            {steps.map(({ s, hit, bounce, c }, k) => {
              const [hx, hy] = P(hit);
              return (
                <g
                  key={k}
                  className="mstats-shot"
                  role="button"
                  tabIndex={0}
                  aria-label={`Shot ${k + 1} by ${name(playerOf(s))}, ${Math.round(s.speed)} km/h, ${s.landing ?? "uncalled"}. Play it`}
                  onClick={() => onSeek(Math.max(0, s.t - 1))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSeek(Math.max(0, s.t - 1));
                    }
                  }}
                >
                  {bounce &&
                    (s.landing === "out" ? (
                      <Cross x={P(bounce)[0]} y={P(bounce)[1]} r={6.5} colour={c} width={3} />
                    ) : (
                      <circle cx={P(bounce)[0]} cy={P(bounce)[1]} r={6.5} fill={c} stroke="var(--court-ink)" strokeWidth={1.5} />
                    ))}
                  <circle cx={hx} cy={hy} r={12} fill="var(--court-ink)" stroke={c} strokeWidth={3} />
                  <text x={hx} y={hy + 5} textAnchor="middle" className="mstats-rallyn">{k + 1}</text>
                </g>
              );
            })}
          </Court>
          <p className="mstats-caption">
            {steps.length
              ? `Numbered circles are where each shot was struck, dots where it bounced (× out), dashes the ball on to the next contact. ${steps.length} of ${rally.shots} shots tracked; tap one to play it.`
              : "We couldn't follow the ball's flight in this rally closely enough to draw it."}
          </p>
        </div>
      </div>
    </div>
  );
}
