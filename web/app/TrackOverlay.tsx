"use client";

import { useEffect, useRef } from "react";
import type { MatchTracks } from "@/lib/matchStats";

/**
 * Our tracking drawn over the playing video: the ball and a short trail, each
 * player boxed in their colour, and each bounce with its speed for a moment
 * after it lands. Sits on top of the <video> (pointer-events off) and follows
 * its picture, letterboxing included, frame by frame.
 */

const TRAIL = 12; // frames
const BOUNCE_HOLD_S = 2.2;
const COLOURS = { A: "#f0954e", B: "#64a2ec", "": "#d8d2c6" } as const;
const CALL = { in: "#7fd18b", close: "#f2c14e", out: "#ef6f62", net: "#d8d2c6" } as const;

/** Index of the last element <= x in a sorted array, or -1. */
function floorIndex(arr: number[], x: number): number {
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= x) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export function TrackOverlay({
  tracks,
  videoRef,
}: {
  tracks: MatchTracks;
  videoRef: React.RefObject<HTMLVideoElement | null>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let raf = 0;
    const bt = tracks.bounces.map((b) => b.t);
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const video = videoRef.current, canvas = canvasRef.current;
      if (!video || !canvas) return;
      // The canvas covers the element; the picture sits inside it (contain).
      const cw = video.clientWidth, ch = video.clientHeight, dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
        canvas.width = Math.round(cw * dpr);
        canvas.height = Math.round(ch * dpr);
      }
      const g = canvas.getContext("2d");
      if (!g) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, cw, ch);
      const s = Math.min(cw / tracks.width, ch / tracks.height);
      const ox = (cw - tracks.width * s) / 2, oy = (ch - tracks.height * s) / 2;
      const X = (u: number) => ox + u * s, Y = (v: number) => oy + v * s;
      const t = video.currentTime;
      const f = Math.round(t * tracks.fps);

      // Players: the nearest detection within a few frames (they were sampled).
      const P = tracks.players;
      let k = floorIndex(P.f, f);
      const near: number[] = [];
      for (let j = Math.max(0, k - 3); j <= Math.min(P.f.length - 1, k + 4); j++) {
        if (Math.abs(P.f[j] - f) <= 4) near.push(j);
      }
      const bySide = new Map<string, number>();
      for (const j of near) {
        const prev = bySide.get(P.side[j]);
        if (prev === undefined || Math.abs(P.f[j] - f) < Math.abs(P.f[prev] - f)) bySide.set(P.side[j], j);
      }
      g.lineWidth = 2;
      g.font = "600 13px system-ui, sans-serif";
      for (const j of bySide.values()) {
        const [x1, y1, x2, y2] = P.box[j];
        const c = COLOURS[P.who[j]];
        g.strokeStyle = c;
        g.strokeRect(X(x1), Y(y1), (x2 - x1) * s, (y2 - y1) * s);
        if (P.who[j]) {
          g.fillStyle = c;
          g.fillText(P.who[j], X(x1), Y(y1) - 5);
        }
      }

      // Ball and trail.
      const B = tracks.ball;
      k = floorIndex(B.f, f);
      for (let j = Math.max(0, k - TRAIL); j <= k; j++) {
        if (j < 0 || f - B.f[j] > TRAIL) continue;
        const last = B.f[j] === f;
        g.beginPath();
        g.arc(X(B.u[j]), Y(B.v[j]), last ? 6 : 2.5, 0, Math.PI * 2);
        if (last) {
          g.strokeStyle = "#ffe14d";
          g.lineWidth = 2.5;
          g.stroke();
        } else {
          g.fillStyle = `rgba(255, 225, 77, ${0.35 + (0.5 * (TRAIL - (f - B.f[j]))) / TRAIL})`;
          g.fill();
        }
      }

      // The latest bounce, for a moment after it lands.
      const bi = floorIndex(bt, t);
      if (bi >= 0 && t - bt[bi] < BOUNCE_HOLD_S) {
        const b = tracks.bounces[bi];
        const c = CALL[b.landing ?? "net"] ?? CALL.net;
        g.strokeStyle = c;
        g.lineWidth = 2.5;
        g.beginPath();
        g.ellipse(X(b.u), Y(b.v), 14, 6, 0, 0, Math.PI * 2);
        g.stroke();
        const label = `${b.speed} km/h${b.landing && b.landing !== "net" ? ` · ${b.landing}` : ""}`;
        g.font = "600 13px system-ui, sans-serif";
        const w = g.measureText(label).width + 12;
        g.fillStyle = "rgba(15, 12, 9, 0.75)";
        g.fillRect(X(b.u) + 16, Y(b.v) - 11, w, 22);
        g.fillStyle = c;
        g.fillText(label, X(b.u) + 22, Y(b.v) + 5);
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [tracks, videoRef]);

  return <canvas ref={canvasRef} className="track-overlay" aria-hidden="true" />;
}
