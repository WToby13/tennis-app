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
  server: string | null; // near_bottom | far_top | null (unknown)
  startS: number;
  endS: number;
  rallies: number;
}

function fmtTime(s: number | null): string {
  if (s == null) return "--:--";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

const SERVE: Record<string, string> = { near_bottom: "Near", far_top: "Far" };
const serveLabel = (sp: string | null) => (sp && SERVE[sp]) || "Unclear";
const isClearServe = (sp: string) => sp === "near_bottom" || sp === "far_top";

function serveOf(s: Segment): string {
  return typeof s.metadata.serving_player === "string" ? s.metadata.serving_player : "cannot_tell";
}

/**
 * Group consecutive rallies into service games: a run of points where the same
 * player serves, from the first such rally to the last before the *other* player
 * clearly takes over. A 'cannot_tell' rally is absorbed into the current game and
 * never counts as a switch (Toby's call — matches the model's run-length prior).
 */
function buildServiceGames(segs: Segment[]): ServiceGame[] {
  const games: ServiceGame[] = [];
  let cur: ServiceGame | null = null;

  for (const s of segs) {
    const sp = serveOf(s);
    const start = s.startS ?? 0;
    const end = s.endS ?? start;

    if (!cur) {
      cur = { server: isClearServe(sp) ? sp : null, startS: start, endS: end, rallies: 1 };
      continue;
    }
    if (!isClearServe(sp)) {
      // cannot_tell → part of the current game.
      cur.endS = end;
      cur.rallies++;
    } else if (cur.server === null || sp === cur.server) {
      // First clear server for a so-far-unknown game, or the same server continuing.
      cur.server = sp;
      cur.endS = end;
      cur.rallies++;
    } else {
      // The other player is clearly serving now → new game.
      games.push(cur);
      cur = { server: sp, startS: start, endS: end, rallies: 1 };
    }
  }
  if (cur) games.push(cur);
  return games;
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
    try {
      const res = await fetch(`/api/videos/${videoId}/analyze`, { method: "POST" });
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
  }, [videoId]);

  const games = useMemo(() => buildServiceGames(segments), [segments]);

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
        {button}
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
          {/* Row 1 — service games */}
          <div className="tl-row">
            <div className="tl-row-label">Service games</div>
            <div className="tl-lane">
              {games.map((g, i) => (
                <button
                  key={`g${i}`}
                  className="tl-bar tl-bar-game"
                  style={{ left: pct(g.startS), width: spanPct(g.startS, g.endS) }}
                  onClick={() => onSeek(g.startS)}
                  title={`${serveLabel(g.server)} serving`}
                >
                  <span className="tl-tip">
                    <span className="tl-tip-strong">{serveLabel(g.server)} serving</span>
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
                const sp = serveOf(s);
                const what = s.metadata.what_you_see;
                return (
                  <button
                    key={s.id}
                    className="tl-bar tl-bar-rally"
                    style={{ left: pct(start), width: spanPct(start, end) }}
                    onClick={() => onSeek(start)}
                    title={`${fmtTime(start)}–${fmtTime(end)}`}
                  >
                    <span className="tl-tip">
                      <span className="tl-tip-strong">
                        {fmtTime(start)}–{fmtTime(end)}
                      </span>
                      {sp !== "cannot_tell" && (
                        <span className="tl-tip-meta">{serveLabel(sp)} serve</span>
                      )}
                      {typeof what === "string" && what && (
                        <span className="tl-tip-what">{what}</span>
                      )}
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
