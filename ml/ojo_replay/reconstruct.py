"""Turn a rally's 2D detections into a 3D rally, and draw it over the video.

    python -m ojo_replay.reconstruct .cache/short-test/match.json .cache/short-test/short-test.mov out/short-test

Writes, per rally:
  rally{n}.json      shots (3D ball flight, bounce, speed, net clearance) and
                     players (court position per frame, 2D keypoints)
  rally{n}.mp4       the video with the reconstruction drawn on it (body meshes
                     where body_sam.py has made them), plus a top-down court map

Add --render-only to redraw the videos from the saved fit.
"""

from __future__ import annotations

import json
import subprocess
import sys
from dataclasses import asdict
from pathlib import Path

import cv2
import numpy as np

from .ball2d import BallCandidate, track_ball
from .ball3d import reconstruct
from .camera import COURT_LINES, DOUBLES, HALF_LENGTH, NET_CENTRE, POST, POST_HEIGHT, Camera
from .detect import read_frames

SKELETON = [(5, 7), (7, 9), (6, 8), (8, 10), (5, 6), (5, 11), (6, 12), (11, 12), (11, 13), (13, 15), (12, 14), (14, 16), (0, 5), (0, 6)]
COLORS = {"near": (60, 166, 240), "far": (255, 140, 60)}  # BGR: near orange, far blue (as in the 3D replay)
BALL = (60, 230, 255)


def court_map(shape_h: int) -> tuple[np.ndarray, callable]:
    """A top-down court image and a function court (x, y) -> map pixel."""
    margin = 3.0
    w_m, h_m = 2 * (DOUBLES + margin), 2 * (HALF_LENGTH + margin)
    s = shape_h / h_m
    img = np.full((shape_h, int(w_m * s), 3), (38, 60, 120), np.uint8)  # clay-ish

    def to_px(x: float, y: float) -> tuple[int, int]:
        return int((x + DOUBLES + margin) * s), int((HALF_LENGTH + margin - y) * s)

    for (x1, y1), (x2, y2) in COURT_LINES:
        cv2.line(img, to_px(x1, y1), to_px(x2, y2), (235, 235, 235), 1, cv2.LINE_AA)
    cv2.line(img, to_px(-POST, 0), to_px(POST, 0), (200, 200, 200), 2, cv2.LINE_AA)
    return img, to_px


def load_bodies(path: Path) -> dict:
    """SAM 3D Body meshes for a rally (from body_sam.py), per side."""
    if not path.exists():
        return {}
    z = np.load(path)
    return {
        side: (z[f"{side}_frames"], z[f"{side}_verts_mm"].astype(np.float32) / 1000, z[f"{side}_faces"])
        for side in ("near", "far")
        if f"{side}_frames" in z
    }


def mesh_at(body, f: int) -> np.ndarray | None:
    """A player's mesh at frame f, blended between the frames processed, or
    None if no mesh is within a couple of frames (the player was lost)."""
    frames, verts, _ = body
    i = int(np.searchsorted(frames, f))
    if i < len(frames) and frames[i] == f:
        return verts[i]
    lo, hi = i - 1, i
    if lo < 0 or hi >= len(frames) or frames[hi] - frames[lo] > 4:
        near = lo if lo >= 0 and (hi >= len(frames) or f - frames[lo] <= frames[hi] - f) else hi
        return verts[near] if 0 <= near < len(frames) and abs(frames[near] - f) <= 2 else None
    w = (f - frames[lo]) / (frames[hi] - frames[lo])
    return (1 - w) * verts[lo] + w * verts[hi]


def draw_mesh(out: np.ndarray, cam: Camera, verts: np.ndarray, faces: np.ndarray, color) -> None:
    """Shaded, back-to-front body mesh, blended over the frame so the real
    player still shows through."""
    tri = verts[faces]  # (F, 3, 3) court coords
    n = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    n /= np.linalg.norm(n, axis=1, keepdims=True) + 1e-9
    centre = tri.mean(axis=1)
    to_cam = cam.position - centre
    to_cam /= np.linalg.norm(to_cam, axis=1, keepdims=True)
    n *= np.sign((n * to_cam).sum(axis=1, keepdims=True))  # face the camera
    light = np.array([0.3, -0.4, 0.86])  # from above, behind the camera
    shade = 0.45 + 0.55 * np.clip(n @ light, 0, 1)
    depth = ((centre - cam.position) ** 2).sum(axis=1)
    px = cam.project(tri.reshape(-1, 3)).reshape(-1, 3, 2)
    layer = out.copy()
    mask = np.zeros(out.shape[:2], np.uint8)
    for k in np.argsort(-depth):  # far faces first
        pts = px[k]
        if not np.isfinite(pts).all():
            continue
        c = tuple(int(v * shade[k]) for v in color)
        q = np.round(pts).astype(np.int32)
        cv2.fillConvexPoly(layer, q, c, cv2.LINE_AA)
        cv2.fillConvexPoly(mask, q, 255)
    sel = mask > 0
    out[sel] = (0.62 * layer[sel] + 0.38 * out[sel]).astype(np.uint8)


def draw_frame(img, f, fps, cam, track, players, shots, map_base, to_map, trail, bodies=None):
    out = img.copy()
    # Court lines from the calibration.
    for (x1, y1), (x2, y2) in COURT_LINES:
        p = cam.project(np.array([[x1, y1, 0], [x2, y2, 0]]))
        if np.isfinite(p).all():
            cv2.line(out, tuple(p[0].astype(int)), tuple(p[1].astype(int)), (255, 255, 255), 1, cv2.LINE_AA)
    net = cam.project(np.array([[-POST, 0, POST_HEIGHT], [0, 0, NET_CENTRE], [POST, 0, POST_HEIGHT]]))
    cv2.polylines(out, [net.astype(int)], False, (180, 220, 180), 1, cv2.LINE_AA)

    # Players: SAM 3D Body meshes where there are some, else 2D skeletons.
    drawn = set()
    for side, body in (bodies or {}).items():
        v = mesh_at(body, f)
        if v is not None:
            draw_mesh(out, cam, v, body[2], COLORS[side])
            drawn.add(side)
    for side, p in players.get(f, {}).items():
        if side in drawn:
            continue
        kp = np.array(p["keypoints"])
        for a, b in SKELETON:
            if kp[a, 2] > 0.3 and kp[b, 2] > 0.3:
                cv2.line(out, tuple(kp[a, :2].astype(int)), tuple(kp[b, :2].astype(int)), COLORS[side], 2, cv2.LINE_AA)

    # Raw ball detection (small ring) and the fitted 3D ball with its shadow.
    if f in track:
        cv2.circle(out, tuple(np.array(track[f]).astype(int)), 9, (255, 255, 0), 1, cv2.LINE_AA)
    t = f / fps
    hud = []
    for s in shots:
        if s["t0"] - 1e-6 <= t <= s["t1"] + 1e-6:
            arr = np.array(s["samples"])
            i = int(np.argmin(np.abs(arr[:, 0] - t)))
            xyz = arr[i, 1:]
            trail.append(xyz)
            ball_px = cam.project(xyz[None])[0]
            shadow_px = cam.project(np.array([[xyz[0], xyz[1], 0.0]]))[0]
            if np.isfinite(ball_px).all() and np.isfinite(shadow_px).all():
                cv2.ellipse(out, tuple(shadow_px.astype(int)), (7, 3), 0, 0, 360, (30, 30, 30), -1, cv2.LINE_AA)
                cv2.line(out, tuple(shadow_px.astype(int)), tuple(ball_px.astype(int)), (90, 90, 90), 1, cv2.LINE_AA)
                cv2.circle(out, tuple(ball_px.astype(int)), 6, BALL, -1, cv2.LINE_AA)
            hud.append(f"{s['hitter']} player  {s['speed_kmh']:.0f} km/h  ball {xyz[2]:.1f} m up")
            if s.get("net_clearance_m") is not None:
                hud.append(f"over the net by {s['net_clearance_m']:.2f} m")
        if s.get("bounce") and s["bounce"][0] <= t <= s["bounce"][0] + 1.0:
            b = s["bounce"]
            ring = [[b[1] + 0.12 * np.cos(a), b[2] + 0.12 * np.sin(a), 0] for a in np.linspace(0, 2 * np.pi, 24)]
            pr = cam.project(np.array(ring))
            if np.isfinite(pr).all():
                col = {"in": (80, 220, 80), "out": (60, 60, 230)}.get(s["landing"], (60, 190, 230))
                cv2.polylines(out, [pr.astype(int)], True, col, 2, cv2.LINE_AA)
                cv2.putText(out, s["landing"].upper(), tuple((pr.mean(0) + [14, -10]).astype(int)), cv2.FONT_HERSHEY_SIMPLEX, 0.7, col, 2, cv2.LINE_AA)
    for k, line in enumerate(hud[:2]):
        cv2.putText(out, line, (30, 60 + 34 * k), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (0, 0, 0), 4, cv2.LINE_AA)
        cv2.putText(out, line, (30, 60 + 34 * k), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (255, 255, 255), 2, cv2.LINE_AA)

    # Top-down map: players' feet, the ball's ground track and height, bounces.
    m = map_base.copy()
    for side, p in players.get(f, {}).items():
        cv2.circle(m, to_map(*p["feet"]), 7, COLORS[side], -1, cv2.LINE_AA)
    for a, b in zip(trail[-40:], trail[-39:]):
        cv2.line(m, to_map(a[0], a[1]), to_map(b[0], b[1]), BALL, 1, cv2.LINE_AA)
    if trail:
        x, y, z = trail[-1]
        cv2.circle(m, to_map(x, y), int(4 + 2 * min(z, 4)), BALL, -1, cv2.LINE_AA)
    for s in shots:
        if s.get("bounce") and s["bounce"][0] <= t:
            col = {"in": (80, 220, 80), "out": (60, 60, 230)}.get(s["landing"], (60, 190, 230))
            cv2.drawMarker(m, to_map(s["bounce"][1], s["bounce"][2]), col, cv2.MARKER_TILTED_CROSS, 10, 2)
    mh, mw = m.shape[:2]
    out[20 : 20 + mh, out.shape[1] - mw - 20 : out.shape[1] - 20] = m
    return out


def main(match_json: str, video: str, out_dir: str, render_only: bool = False) -> None:
    match = json.loads(Path(match_json).read_text())
    cam = Camera.from_match(Path(match_json))
    out = Path(out_dir)
    for seg in match["segments"]:
        raw = json.loads((out / f"rally{seg['idx']}_2d.json").read_text())
        fps = raw["fps"]
        track = {f: (c.u, c.v) for f, c in track_ball([BallCandidate(**b) for b in raw["ball"]]).items()}
        players: dict[int, dict[str, dict]] = {}
        for p in raw["players"]:
            players.setdefault(p["frame"], {})[p["side"]] = p
        saved = out / f"rally{seg['idx']}.json"
        if render_only and saved.exists():
            shots = json.loads(saved.read_text())["shots"]  # reuse the fit; only redraw
        else:
            shots = [asdict(s) for s in reconstruct(cam, track, players, fps, raw["lastFrame"])]
            saved.write_text(json.dumps({"rally": seg["idx"], "fps": fps, "shots": shots, "players": raw["players"]}))
        for s in shots:
            b = (
                f"bounce ({s['bounce'][1]:+.2f}, {s['bounce'][2]:+.2f}) {s['landing']}"
                if s["bounce"]
                else ("into the net" if s["landing"] == "net" else "no bounce")
            )
            print(f"rally {seg['idx']} {s['hitter']:>4} hit at {s['t0']:.2f}s  {s['speed_kmh']:5.1f} km/h  {b}  net {s['net_clearance_m']}  fit {s['rms_px']} px over {s['n_obs']} frames")

        frames = read_frames(Path(video), raw["firstFrame"], raw["lastFrame"])
        h, w = frames[0][1].shape[:2]
        map_base, to_map = court_map(int(h * 0.42))
        bodies = load_bodies(out / f"rally{seg['idx']}_bodies.npz")
        tmp = out / f"rally{seg['idx']}_raw.mp4"
        vw = cv2.VideoWriter(str(tmp), cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))
        trail: list = []
        for f, img in frames:
            vw.write(draw_frame(img, f, fps, cam, track, players, shots, map_base, to_map, trail, bodies))
        vw.release()
        final = out / f"rally{seg['idx']}.mp4"
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(tmp), "-c:v", "libx264", "-crf", "23", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(final)], check=True)
        tmp.unlink()
        print(f"wrote {final}")


if __name__ == "__main__":
    main(*sys.argv[1:4], render_only="--render-only" in sys.argv)
