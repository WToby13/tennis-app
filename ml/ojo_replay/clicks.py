"""The court from three clicks: a rough camera from the clicks, snapped onto the paint.

    python -m ojo_replay.clicks <video> <frameS> <clicks.json> <out.json> [debug.jpg]

Automatic detection (autocal) fails mostly at its first step, finding a line to
anchor on, in hard light: long shadows, low sun, a cluttered background. A
person finds the near court at a glance. So the owner clicks three points they
can see clearly (any of the panel's landmarks; the two near singles corners and
a T are the easy ones) and this does the rest:

1. Seeds: the camera has 7 unknowns (position, rotation, focal length) and three
   clicks give 6 equations, so the focal length comes from the lens instead.
   Phone ultra-wides sit in a narrow range (autocal.LENS); for each focal length
   on a scan, the three clicks fix the pose (P3P, up to four solutions each).
2. Snap: each plausible seed is pulled onto the painted lines, by autocal's own
   polish (and refine + polish), so every visible metre of line counts, not
   just three clicks.
3. Keep the best snap that still passes through the clicks (it mustn't latch
   onto a fence rail and drift away from what the owner pointed at). If none
   does, the unsnapped seed, marked for review.

Four or more clicks work too (solved directly, no lens scan needed).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import cv2
import numpy as np

from . import autocal as A

# A snapped court must still put each clicked landmark within this of the click.
CLICK_TOL_FRAC = 0.02  # of the image width: ~38 px at 1920
CLICK_TOL_MIN = 12.0


def _cam(R: np.ndarray, t: np.ndarray, f: float, W: int, H: int) -> dict:
    return {
        "f": float(f), "cx": W / 2, "cy": H / 2,
        "hfovDeg": float(np.degrees(2 * np.arctan(W / (2 * f)))),
        "position": (-R.T @ t).tolist(), "rotation": R.ravel().tolist(), "translation": np.asarray(t, float).tolist(),
        "focalFrom": "clicks",
    }


def _homography(cam: dict, W: int, H: int) -> np.ndarray:
    R = np.array(cam["rotation"]).reshape(3, 3)
    t = np.array(cam["translation"])
    K = np.array([[cam["f"], 0, W / 2], [0, cam["f"], H / 2], [0, 0, 1.0]])
    Hm = K @ np.column_stack([R[:, 0], R[:, 1], t])
    return Hm / Hm[2, 2]


def reproject(cam: dict, ids: list[str], W: int, H: int) -> np.ndarray:
    R = np.array(cam["rotation"]).reshape(3, 3)
    t = np.array(cam["translation"])
    pc = np.array([A.PANEL_LANDMARKS[i] for i in ids], float) @ R.T + t
    return pc[:, :2] / pc[:, 2:3] * cam["f"] + [W / 2, H / 2]


def _plausible(cam: dict) -> bool:
    x, y, z = cam["position"]
    return 0.5 < z < 10.0 and y < 0 and abs(x) < 15


def seeds(clicks: dict[str, tuple[float, float]], W: int, H: int) -> list[dict]:
    """Cameras that put the clicked landmarks exactly (3 clicks) or best (4+) on the clicks."""
    ids = [i for i in clicks if i in A.PANEL_LANDMARKS]
    if len(ids) < 3:
        raise ValueError("need at least three known court points")
    obj = np.array([A.PANEL_LANDMARKS[i] for i in ids], np.float64)
    img = np.array([clicks[i] for i in ids], np.float64)
    out = []
    for f in np.linspace(A.LENS[0] * W, A.LENS[1] * W, 9):
        K = np.array([[f, 0, W / 2], [0, f, H / 2], [0, 0, 1.0]])
        if len(ids) == 3:
            n, rvecs, tvecs = cv2.solveP3P(obj, img, K, None, flags=cv2.SOLVEPNP_P3P)
            sols = list(zip(rvecs, tvecs)) if n else []
        else:
            ok, rvec, tvec = cv2.solvePnP(obj, img, K, None, flags=cv2.SOLVEPNP_SQPNP)
            sols = [(rvec, tvec)] if ok else []
        for rvec, tvec in sols:
            R, _ = cv2.Rodrigues(rvec)
            cam = _cam(R, tvec.ravel(), f, W, H)
            if _plausible(cam):
                out.append(cam)
    return out


def snap(plate: np.ndarray, clicks: dict[str, tuple[float, float]], debug: str | None = None) -> dict:
    H, W = plate.shape[:2]
    paint, surface = A.paint_mask(plate)
    ids = [i for i in clicks if i in A.PANEL_LANDMARKS]
    target = np.array([clicks[i] for i in ids], float)
    tol = max(CLICK_TOL_MIN, CLICK_TOL_FRAC * W)
    cands = seeds(clicks, W, H)
    if not cands:
        raise RuntimeError("those points don't fit any camera; check each is on the right landmark")

    def off(cam):
        return float(np.max(np.linalg.norm(reproject(cam, ids, W, H) - target, axis=1)))

    best = None  # (linePx, cam, Hm)
    for seed in cands:
        tries = [seed]
        Hr, _ = A.refine(_homography(seed, W, H), paint)
        via = A.camera_from_homography(Hr, W, H, paint)
        if via is not None:
            tries.append(via)
        for start in tries:
            cam, Hm, line_px = A.polish(start, paint, W, H)
            if _plausible(cam) and off(cam) <= tol and (best is None or line_px < best[0]):
                best = (line_px, cam, Hm)
    snapped = best is not None
    if not snapped:  # nothing on the paint agreed with the clicks: the clicks alone
        seed = min(cands, key=lambda c: abs(c["f"] - 0.39 * W))
        best = (float("nan"), seed, _homography(seed, W, H))
    line_px, cam, Hm = best

    near_paint = A.line_weight(paint)
    uv = A._project(Hm, A._samples(0.05))
    ok = np.isfinite(uv).all(axis=1) & (uv[:, 0] >= 0) & (uv[:, 0] < W) & (uv[:, 1] >= 0) & (uv[:, 1] < H)
    px = np.unique(np.floor(uv[ok]).astype(int), axis=0)
    cover = float((near_paint[px[:, 1], px[:, 0]] > 0).mean()) if len(px) else 0.0
    result = {
        "model": "pinhole", "source": "clicks", "camera": {**cam, "focalFrom": "clicks"},
        "quality": "good" if cover > 0.7 else "fair" if cover > 0.5 else "poor", "version": 1,
        "imageWidth": W, "imageHeight": H, "homography": Hm.ravel().tolist(),
        "coverage": cover, "linePx": line_px, "snapped": snapped,
        "clickPx": round(off(cam), 1), "clicks": {i: list(map(float, clicks[i])) for i in ids},
    }
    result["status"] = "auto" if snapped and A.confident(result) else "review"
    result["landmarks"] = A.panel_pins(cam, W, H)
    if debug:
        vis = plate.copy()
        vis[paint > 0] = (255, 0, 255)
        for (x1, y1), (x2, y2) in A.model_segments():
            t = np.linspace(0, 1, 200)
            uv = A._project(Hm, np.column_stack([x1 + (x2 - x1) * t, y1 + (y2 - y1) * t]))
            uv = uv[np.isfinite(uv).all(axis=1)].astype(np.int32)
            cv2.polylines(vis, [uv.reshape(-1, 1, 2)], False, (0, 255, 255), 2)
        for i in ids:
            cv2.circle(vis, tuple(int(v) for v in clicks[i]), 10, (0, 255, 0), 3)
        cv2.putText(vis, f"{result['status']} snapped={snapped} lines {line_px:.1f}px clicks {result['clickPx']}px",
                    (20, 50), 0, 1.4, (0, 255, 0), 3)
        cv2.imwrite(debug, vis)
    return result


def calibrate(video: str, frame_s: float, clicks: dict[str, tuple[float, float]], debug: str | None = None) -> dict:
    """From the clicks on the frame at frame_s: a clean plate of the 20 s around it
    (the camera can be moved later in the match; the clicks belong to this one)."""
    frames = A.read_window(video, max(0.0, frame_s - 10.0), 20.0)
    if len(frames) < 3:
        raise RuntimeError("couldn't read the video around that frame")
    return {**snap(A.clean_plate(frames), clicks, debug), "frameS": frame_s}


def main(video: str, frame_s: str, clicks_json: str, out: str, debug: str | None = None) -> None:
    clicks = {k: tuple(v) for k, v in json.loads(Path(clicks_json).read_text()).items()}
    r = calibrate(video, float(frame_s), clicks, debug)
    Path(out).write_text(json.dumps(r))
    print(f"{r['status']}: snapped={r['snapped']}, lines {r['linePx']:.1f}px off paint, clicks within {r['clickPx']}px, "
          f"f {r['camera']['f']:.0f}, camera at {np.round(r['camera']['position'], 2).tolist()}")


if __name__ == "__main__":
    main(*sys.argv[1:6])
