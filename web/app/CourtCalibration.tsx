"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CloseIcon } from "./icons";
import { COURT_SEGMENTS, DEFAULT_SEQUENCE, LANDMARKS, LANDMARK_BY_ID } from "@/lib/court/model";
import { snapToCrossing } from "@/lib/court/snap";
import { projectSegment, solveCalibration, type CourtCalibration } from "@/lib/court/solve";

const FRAME_S = 1 / 30; // the watch page's frame-step granularity
const GROUPS = ["Corners", "Service lines", "Centre marks", "Net"] as const;
const HALF_LENGTH = 11.885;
const LOUPE_PX = 168;
const LOUPE_ZOOM = 5;
/** Pin numbers shown on the frame and in the list, in LANDMARKS order. */
const NUMBER = new Map(LANDMARKS.map((l, i) => [l.id, i + 1]));

type Pins = Record<string, { x: number; y: number }>;

interface Props {
  videoId: string;
  src: string;
  /** Where the main player was, so the panel opens on the frame being watched. */
  startS: number;
  initial: CourtCalibration | null;
  onClose: () => void;
  onSaved: (calibration: CourtCalibration | null) => void;
}

/**
 * Court calibration: drag pins onto known court landmarks on one paused frame,
 * and the whole court is drawn back over the picture from the solved camera.
 * If every line sits on the paint, the camera is right. See docs/3D_REPLAY.md
 * §5 Stage 1 for why this is manual and what it feeds.
 */
export function CourtCalibration({ videoId, src, startS, initial, onClose, onSaved }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const loupeRef = useRef<HTMLCanvasElement>(null);
  /**
   * The current frame at native resolution. It's what's shown (a paused video
   * element doesn't reliably paint its frame, notably in Safari) and what the
   * snap reads pixels from.
   */
  const frameRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ id: string; isNew: boolean } | null>(null);

  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [frameS, setFrameS] = useState(initial?.frameS ?? startS);
  const [pins, setPins] = useState<Pins>(() =>
    Object.fromEntries((initial?.landmarks ?? []).map((l) => [l.id, { x: l.x, y: l.y }])),
  );
  const [activeId, setActiveId] = useState<string | null>(() =>
    initial ? null : DEFAULT_SEQUENCE[0],
  );
  const [loupe, setLoupe] = useState<{ x: number; y: number } | null>(null);
  const [showLines, setShowLines] = useState(true);
  const [snapOn, setSnapOn] = useState(true);
  const [snapNote, setSnapNote] = useState<string | null>(null);
  /** Video px per CSS px, so pins stay the same on-screen size at any zoom. */
  const [k, setK] = useState(1);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  // Reading pixels needs the video to load with CORS. Same-origin (local mode)
  // always can. A CDN without CORS headers can't, and then the video is
  // reloaded without the attribute and the snap is switched off.
  const sameOrigin = useMemo(() => {
    try {
      return new URL(src, window.location.href).origin === window.location.origin;
    } catch {
      return false;
    }
  }, [src]);
  const [corsFailed, setCorsFailed] = useState(false);
  const [canSnap, setCanSnap] = useState<boolean | null>(null);

  const captureFrame = useCallback(() => {
    const v = videoRef.current;
    const c = frameRef.current;
    if (!v || !c || !v.videoWidth) return;
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(v, 0, 0);
    try {
      ctx.getImageData(0, 0, 1, 1); // throws if the frame is cross-origin
      setCanSnap(true);
    } catch {
      setCanSnap(false);
    }
  }, []);

  // Keep pin sizes constant on screen as the stage resizes.
  useEffect(() => {
    const el = stageRef.current;
    if (!el || !dims) return;
    const ro = new ResizeObserver(() => setK(dims.w / Math.max(1, el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [dims]);

  const seekTo = useCallback((t: number) => {
    const v = videoRef.current;
    if (!v) return;
    const end = Number.isFinite(v.duration) ? v.duration : t;
    v.currentTime = Math.min(Math.max(0, t), end);
  }, []);

  const solved = useMemo(() => {
    if (!dims) return null;
    const landmarks = Object.entries(pins).map(([id, p]) => ({ id, x: p.x, y: p.y }));
    if (landmarks.length === 0) return null;
    return solveCalibration({ imageWidth: dims.w, imageHeight: dims.h, frameS, landmarks });
  }, [pins, dims, frameS]);
  const calibration = solved?.ok ? solved.calibration : null;

  const toVideo = useCallback(
    (clientX: number, clientY: number) => {
      const svg = svgRef.current;
      const ctm = svg?.getScreenCTM();
      if (!svg || !ctm || !dims) return null;
      const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
      return { x: Math.min(Math.max(p.x, 0), dims.w), y: Math.min(Math.max(p.y, 0), dims.h) };
    },
    [dims],
  );

  const snapAt = useCallback(
    (x: number, y: number): [number, number] | null => {
      const c = frameRef.current;
      if (!c || !dims || !canSnap) return null;
      // Search far enough to forgive a drop a few screen pixels off. When the
      // frame is shown small, each screen pixel spans several video pixels.
      const r = Math.max(12, Math.round((20 * dims.w) / 1920), Math.round(10 * k));
      const sx = Math.max(0, Math.round(x) - r);
      const sy = Math.max(0, Math.round(y) - r);
      const ex = Math.min(dims.w, Math.round(x) + r);
      const ey = Math.min(dims.h, Math.round(y) + r);
      if (ex - sx < 8 || ey - sy < 8) return null;
      const img = c.getContext("2d", { willReadFrequently: true })!.getImageData(sx, sy, ex - sx, ey - sy);
      const p = snapToCrossing({ data: img.data, width: img.width, height: img.height }, x - sx, y - sy);
      return p ? [p[0] + sx, p[1] + sy] : null;
    },
    [dims, canSnap, k],
  );

  const nextUnplaced = (placed: Pins) => DEFAULT_SEQUENCE.find((id) => !placed[id]) ?? null;

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>, pinId?: string) => {
    const id = pinId ?? activeId;
    if (!id) return;
    const p = toVideo(e.clientX, e.clientY);
    if (!p) return;
    e.preventDefault();
    e.stopPropagation();
    svgRef.current?.setPointerCapture(e.pointerId);
    dragRef.current = { id, isNew: !pins[id] };
    setActiveId(id);
    setSnapNote(null);
    // Grabbing a pin keeps its spot until it moves; placing one drops it here.
    if (!pinId) setPins((prev) => ({ ...prev, [id]: p }));
    setLoupe(pinId ? pins[pinId] : p);
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const p = toVideo(e.clientX, e.clientY);
    if (!p) return;
    setPins((prev) => ({ ...prev, [drag.id]: p }));
    setLoupe(p);
  };

  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    setLoupe(null);
    if (!drag) return;
    const dropped = toVideo(e.clientX, e.clientY) ?? pins[drag.id];
    let next = { ...pins, [drag.id]: dropped };
    const def = LANDMARK_BY_ID.get(drag.id);
    if (snapOn && canSnap && def?.snaps && !e.altKey) {
      const s = snapAt(dropped.x, dropped.y);
      if (s) next = { ...next, [drag.id]: { x: s[0], y: s[1] } };
      setSnapNote(s ? "Snapped to the line crossing." : "No line crossing found nearby, so it stays where you dropped it.");
    }
    setPins(next);
    // Walk the four corners in order; a point picked from the list is a one-off.
    if (drag.isNew) setActiveId(DEFAULT_SEQUENCE.includes(drag.id) ? nextUnplaced(next) : null);
  };

  const removePin = useCallback((id: string) => {
    setPins((prev) => {
      const { [id]: _removed, ...rest } = prev;
      return rest;
    });
  }, []);

  // Keyboard: arrows nudge the selected pin, Delete removes it, Esc closes.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.target as HTMLElement | null)?.closest("input, textarea")) return;
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (!activeId || !pins[activeId]) return;
      const step = e.shiftKey ? 5 : 0.5;
      const d =
        e.key === "ArrowLeft" ? [-step, 0] : e.key === "ArrowRight" ? [step, 0] :
        e.key === "ArrowUp" ? [0, -step] : e.key === "ArrowDown" ? [0, step] : null;
      if (d) {
        setPins((prev) => ({ ...prev, [activeId]: { x: prev[activeId].x + d[0], y: prev[activeId].y + d[1] } }));
      } else if (e.key === "Delete" || e.key === "Backspace") {
        removePin(activeId);
      } else return;
      e.preventDefault();
      e.stopPropagation();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [activeId, pins, onClose, removePin]);

  // The loupe: a magnified, unsmoothed view under the pin being dragged.
  useEffect(() => {
    const c = loupeRef.current;
    const v = frameRef.current;
    if (!c || !v || !loupe) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = LOUPE_PX * dpr;
    c.height = LOUPE_PX * dpr;
    const ctx = c.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    const span = LOUPE_PX / LOUPE_ZOOM;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(v, loupe.x - span / 2, loupe.y - span / 2, span, span, 0, 0, c.width, c.height);
    const mid = c.width / 2;
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = dpr;
    ctx.beginPath();
    ctx.moveTo(mid, 0);
    ctx.lineTo(mid, mid - 8 * dpr);
    ctx.moveTo(mid, mid + 8 * dpr);
    ctx.lineTo(mid, c.height);
    ctx.moveTo(0, mid);
    ctx.lineTo(mid - 8 * dpr, mid);
    ctx.moveTo(mid + 8 * dpr, mid);
    ctx.lineTo(c.width, mid);
    ctx.stroke();
  }, [loupe]);

  const save = async () => {
    if (!dims || !calibration) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/videos/${videoId}/calibration`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          frameS,
          imageWidth: dims.w,
          imageHeight: dims.h,
          landmarks: Object.entries(pins).map(([id, p]) => ({ id, x: p.x, y: p.y })),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Couldn't save the calibration.");
      onSaved(data.calibration);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the calibration.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/videos/${videoId}/calibration`, { method: "DELETE" });
      if (!res.ok) throw new Error("Couldn't remove the calibration.");
      onSaved(null);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't remove the calibration.");
    } finally {
      setSaving(false);
    }
  };

  const residual = new Map(calibration?.residuals.map((r) => [r.id, r.errorPx]) ?? []);
  const suspect = calibration?.suspect ?? null;
  const placedCount = Object.keys(pins).length;
  const active = activeId ? LANDMARK_BY_ID.get(activeId) : null;

  return (
    <div className="modal-overlay calib-overlay" onClick={onClose}>
      <div className="modal-card calib-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h2 style={{ fontSize: 18, margin: 0 }}>Calibrate the court</h2>
            <p className="muted" style={{ fontSize: 13, margin: "4px 0 0" }}>
              {initial?.source === "auto"
                ? initial.autoStatus === "auto"
                  ? "These pins were placed automatically and the court lines fit the paint. Check every line sits on the paint; drag any pin that's off, then save."
                  : "These pins were placed automatically, but the fit is uncertain. Check each one carefully and drag any that's off the landmark, then save."
                : "Place at least four court points. The whole court is then redrawn over the frame, and if every line sits on the paint, the camera is right."}
              {initial?.source === "auto" && initial.moved
                ? " The camera moved during this recording, so these pins only hold for part of it."
                : ""}
            </p>
          </div>
          <button className="modal-close" aria-label="Close" onClick={onClose}>
            <CloseIcon size={20} />
          </button>
        </div>

        <div className="calib-body">
          <div className="calib-main">
            <div
              ref={stageRef}
              className="calib-stage"
              style={dims ? { width: `min(100%, calc(64vh * ${dims.w / dims.h}))` } : undefined}
            >
              <canvas ref={frameRef} className="calib-frame" />
              <video
                key={corsFailed ? "plain" : "cors"}
                ref={videoRef}
                className="calib-source"
                src={src}
                crossOrigin={!sameOrigin && !corsFailed ? "anonymous" : undefined}
                muted
                playsInline
                preload="auto"
                onLoadedMetadata={(e) => {
                  const v = e.currentTarget;
                  setDims({ w: v.videoWidth, h: v.videoHeight });
                  seekTo(frameS);
                }}
                onLoadedData={captureFrame}
                onSeeked={(e) => {
                  setFrameS(e.currentTarget.currentTime);
                  captureFrame();
                }}
                onError={() => {
                  if (!sameOrigin && !corsFailed) setCorsFailed(true);
                  else setError("This video couldn't be loaded.");
                }}
              />
              {dims && (
                <svg
                  ref={svgRef}
                  viewBox={`0 0 ${dims.w} ${dims.h}`}
                  className={activeId ? "placing" : undefined}
                  onPointerDown={(e) => onPointerDown(e)}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onPointerCancel={onPointerUp}
                >
                  {showLines &&
                    calibration &&
                    COURT_SEGMENTS.map((s, i) => {
                      const seg = projectSegment(calibration.camera, s.a, s.b);
                      if (!seg) return null;
                      return (
                        <line
                          key={i}
                          x1={seg[0][0]}
                          y1={seg[0][1]}
                          x2={seg[1][0]}
                          y2={seg[1][1]}
                          className={s.kind === "net" ? "calib-net" : "calib-line"}
                          vectorEffect="non-scaling-stroke"
                        />
                      );
                    })}
                  {suspect && pins[suspect.id] && (
                    <g className="calib-suspect">
                      <line
                        x1={pins[suspect.id].x}
                        y1={pins[suspect.id].y}
                        x2={suspect.expected[0]}
                        y2={suspect.expected[1]}
                        vectorEffect="non-scaling-stroke"
                      />
                      <circle cx={suspect.expected[0]} cy={suspect.expected[1]} r={7 * k} vectorEffect="non-scaling-stroke" />
                    </g>
                  )}
                  {Object.entries(pins).map(([id, p]) => {
                    const isActive = id === activeId;
                    const isSuspect = suspect?.id === id;
                    return (
                      <g
                        key={id}
                        className={`calib-pin${isActive ? " active" : ""}${isSuspect ? " suspect" : ""}`}
                        onPointerDown={(e) => onPointerDown(e as unknown as React.PointerEvent<SVGSVGElement>, id)}
                      >
                        <circle cx={p.x} cy={p.y} r={9 * k} className="hit" />
                        <circle cx={p.x} cy={p.y} r={5 * k} vectorEffect="non-scaling-stroke" />
                        <line x1={p.x - 2.5 * k} y1={p.y} x2={p.x + 2.5 * k} y2={p.y} vectorEffect="non-scaling-stroke" />
                        <line x1={p.x} y1={p.y - 2.5 * k} x2={p.x} y2={p.y + 2.5 * k} vectorEffect="non-scaling-stroke" />
                        <text x={p.x + 8 * k} y={p.y - 7 * k} fontSize={11 * k}>
                          {NUMBER.get(id)}
                        </text>
                      </g>
                    );
                  })}
                </svg>
              )}
              {loupe && dims && (
                <canvas
                  ref={loupeRef}
                  className="calib-loupe"
                  style={loupe.x < dims.w / 2 ? { right: 10 } : { left: 10 }}
                />
              )}
            </div>

            <div className="calib-toolbar">
              <div className="calib-steps" role="group" aria-label="Choose the frame">
                <button className="btn secondary btn-sm" onClick={() => seekTo(frameS - 10)}>−10s</button>
                <button className="btn secondary btn-sm" onClick={() => seekTo(frameS - 1)}>−1s</button>
                <button className="btn secondary btn-sm" onClick={() => seekTo(frameS - FRAME_S)} title="Previous frame">−1f</button>
                <span className="mono calib-time">{formatTime(frameS)}</span>
                <button className="btn secondary btn-sm" onClick={() => seekTo(frameS + FRAME_S)} title="Next frame">+1f</button>
                <button className="btn secondary btn-sm" onClick={() => seekTo(frameS + 1)}>+1s</button>
                <button className="btn secondary btn-sm" onClick={() => seekTo(frameS + 10)}>+10s</button>
              </div>
              <label className="calib-toggle">
                <input type="checkbox" checked={showLines} onChange={(e) => setShowLines(e.target.checked)} />
                Court overlay
              </label>
              <label className="calib-toggle" title={canSnap === false ? "This video's host doesn't allow reading its pixels, so pins can't snap." : undefined}>
                <input
                  type="checkbox"
                  checked={snapOn && canSnap !== false}
                  disabled={canSnap === false}
                  onChange={(e) => setSnapOn(e.target.checked)}
                />
                Snap to lines{canSnap === false ? " (unavailable)" : ""}
              </label>
            </div>
            <p className="muted calib-hint">
              {active
                ? <>Placing <b>{NUMBER.get(active.id)}. {active.label}</b>: click it on the frame.</>
                : "Pick a point from the list, or drag a pin to move it."}{" "}
              Pins snap to the painted lines when dropped; hold Alt (⌥) to skip snapping. Arrow keys
              nudge the selected pin (Shift for bigger steps). Choose a frame where nobody is standing
              on the lines.
              {snapNote && <> <span className="calib-note">{snapNote}</span></>}
            </p>
          </div>

          <aside className="calib-side">
            <QualityCard placedCount={placedCount} solved={solved} />

            <div className="calib-list">
              <p className="muted" style={{ fontSize: 12, margin: "0 0 6px" }}>
                Use the outer (doubles) corners. If the court only has singles lines, use the
                singles corners instead.
              </p>
              {GROUPS.map((group) => (
                <div key={group} className="calib-group">
                  <span className="lbl">{group}</span>
                  {LANDMARKS.filter((l) => l.group === group).map((l) => {
                    const placed = Boolean(pins[l.id]);
                    const err = residual.get(l.id);
                    return (
                      <div
                        key={l.id}
                        className={`calib-item${l.id === activeId ? " active" : ""}${placed ? " placed" : ""}${suspect?.id === l.id ? " suspect" : ""}`}
                      >
                        <button className="calib-item-main" onClick={() => setActiveId(l.id)}>
                          <span className="calib-num">{NUMBER.get(l.id)}</span>
                          <span className="calib-label">{l.label}</span>
                          {placed && err !== undefined && calibration && calibration.redundancy > 0 && (
                            <span className="mono calib-err">{err.toFixed(1)} px</span>
                          )}
                        </button>
                        {placed && (
                          <button className="calib-remove" aria-label={`Remove ${l.label}`} onClick={() => removePin(l.id)}>
                            ×
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>

            {error && <p className="calib-error">{error}</p>}
            <div className="calib-actions">
              <button className="btn" onClick={save} disabled={!calibration || saving}>
                {saving ? "Saving…" : "Save calibration"}
              </button>
              <button className="btn secondary" onClick={() => setPins({})} disabled={placedCount === 0 || saving}>
                Clear pins
              </button>
              {initial &&
                (confirmRemove ? (
                  <button className="btn danger" onClick={remove} disabled={saving}>
                    Remove saved calibration
                  </button>
                ) : (
                  <button className="btn-link danger" onClick={() => setConfirmRemove(true)} disabled={saving}>
                    Remove…
                  </button>
                ))}
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

function QualityCard({
  placedCount,
  solved,
}: {
  placedCount: number;
  solved: ReturnType<typeof solveCalibration> | null;
}) {
  if (!solved) {
    return (
      <div className="calib-quality">
        <span className="calib-badge none">Not calibrated</span>
        <p>Place the four doubles corners to start.</p>
      </div>
    );
  }
  if (!solved.ok) {
    return (
      <div className="calib-quality">
        <span className="calib-badge none">{placedCount} placed</span>
        <p>{solved.error}</p>
      </div>
    );
  }
  const c = solved.calibration;
  const [x, y, z] = c.camera.position;
  const behind = -HALF_LENGTH - y;
  const verdict = {
    unchecked: "Fits, but unchecked. Four points always fit some camera. Add a fifth (a T, or a net-post top, which also pins down the lens) so mistakes show up.",
    good: "Good fit. Check that the redrawn lines sit on the paint across the whole court.",
    fair: "Rough fit. A pin is probably slightly off. Zoom in with the loupe and nudge it.",
    poor: "Poor fit. A pin is on the wrong landmark, or left and right are swapped.",
  }[c.quality];
  return (
    <div className="calib-quality">
      <span className={`calib-badge ${c.quality}`}>
        {c.quality === "unchecked" ? "Unchecked" : c.quality[0].toUpperCase() + c.quality.slice(1)}
        {c.redundancy > 0 && ` · ${c.rmsErrorPx.toFixed(1)} px`}
      </span>
      <p>{verdict}</p>
      {c.warnings.map((w) => (
        <p key={w} className="calib-warning">{w}</p>
      ))}
      <div className="detail-row">
        <span className="k">Camera height</span>
        <span className="mono">{z.toFixed(2)} m</span>
      </div>
      <div className="detail-row">
        <span className="k">{behind >= 0 ? "Behind the near baseline" : "In front of the near baseline"}</span>
        <span className="mono">{Math.abs(behind).toFixed(2)} m</span>
      </div>
      <div className="detail-row">
        <span className="k">Off the centre line</span>
        <span className="mono">
          {Math.abs(x).toFixed(2)} m {Math.abs(x) < 0.05 ? "" : x < 0 ? "left" : "right"}
        </span>
      </div>
      <div className="detail-row">
        <span className="k">Field of view</span>
        <span className="mono" title="Ultra-wide is about 100–110°, the main lens about 65–70°">
          {c.camera.hfovDeg.toFixed(0)}°
        </span>
      </div>
    </div>
  );
}

function formatTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec.toFixed(2).padStart(5, "0")}`;
}
