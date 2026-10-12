"""Calibrate from a few hand-picked court landmarks (the panel's job, offline).

    python -m ojo_replay.handcal <plate.png> <out.json> x,y[,z]=u,v [...]

Court points in metres (as in camera.py; z defaults to 0) paired with their
pixels on the clean plate. As in the web panel's solver, points off the ground
(the net-post tops, 1.07 m) are what fix the focal length: each focal length on
a scan gets its pose from all the points, and the one that reprojects them best
wins.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import cv2
import numpy as np

from . import autocal as A


def solve(world: np.ndarray, img: np.ndarray, W: int, H: int) -> tuple[float, np.ndarray, np.ndarray, float]:
    """(f, R, t, rms px) for square pixels and a centred principal point."""
    best = None
    ground = np.abs(world[:, 2]) < 1e-9
    Hm, _ = cv2.findHomography(world[ground, :2], img[ground], 0)

    def fit(f):
        K = np.array([[f, 0, W / 2], [0, f, H / 2], [0, 0, 1.0]])
        # Seed from the ground points' homography, then use every point.
        seed = A._pose(Hm, f, W, H)
        if seed is None:
            return None
        rvec0, _ = cv2.Rodrigues(seed[1])
        ok, rvec, tvec = cv2.solvePnP(world, img, K, None, rvec0, seed[2].reshape(3, 1), True, cv2.SOLVEPNP_ITERATIVE)
        if not ok:
            return None
        proj, _ = cv2.projectPoints(world, rvec, tvec, K, None)
        rms = float(np.sqrt(np.mean(np.sum((proj[:, 0] - img) ** 2, axis=1))))
        return rms, cv2.Rodrigues(rvec)[0], tvec.ravel()

    for f in np.geomspace(0.25 * W, 1.5 * W, 160):
        r = fit(f)
        if r and (best is None or r[0] < best[0]):
            best = (r[0], f)
    lo, hi = best[1] / 1.03, best[1] * 1.03
    for _ in range(40):  # golden-section on the bracket
        m1, m2 = lo + 0.382 * (hi - lo), lo + 0.618 * (hi - lo)
        if fit(m1)[0] < fit(m2)[0]:
            hi = m2
        else:
            lo = m1
    f = (lo + hi) / 2
    rms, R, t = fit(f)
    return f, R, t, rms


def calibrate(plate: np.ndarray, pairs: list[tuple[tuple[float, ...], tuple[float, float]]], debug: str | None = None) -> dict:
    H, W = plate.shape[:2]
    world = np.array([(*p[0], 0.0)[:3] for p in pairs], float)
    img = np.array([p[1] for p in pairs], float)
    f, R, t, rms = solve(world, img, W, H)
    pos = -R.T @ t
    cam = {
        "f": f, "cx": W / 2, "cy": H / 2, "hfovDeg": float(np.degrees(2 * np.arctan(W / (2 * f)))),
        "position": pos.tolist(), "rotation": R.ravel().tolist(), "translation": t.tolist(),
        "focalFrom": "landmarks",
    }
    K = np.array([[f, 0, W / 2], [0, f, H / 2], [0, 0, 1.0]])
    Hm = K @ np.column_stack([R[:, 0], R[:, 1], t])
    Hm /= Hm[2, 2]
    paint, _ = A.paint_mask(plate)
    near = cv2.dilate(paint, np.ones((3, 3), np.uint8))
    uv = A._project(Hm, A._samples(0.05))
    ok = np.isfinite(uv).all(axis=1) & (uv[:, 0] >= 0) & (uv[:, 0] < W) & (uv[:, 1] >= 0) & (uv[:, 1] < H)
    px = np.unique(np.floor(uv[ok]).astype(int), axis=0)
    cover = float((near[px[:, 1], px[:, 0]] > 0).mean())
    cal = {
        "model": "pinhole", "source": "hand", "camera": cam, "quality": "good" if rms < 2.5 else "fair",
        "version": 1, "imageWidth": W, "imageHeight": H, "homography": Hm.ravel().tolist(),
        "rms": rms, "coverage": cover, "lines": 0,
    }
    if debug:
        from .camera import Camera

        c = Camera.from_calibration(cal)
        vis = plate.copy()
        for (x1, y1), (x2, y2) in A.model_segments():
            t_ = np.linspace(0, 1, 200)
            q = c.project(np.column_stack([x1 + (x2 - x1) * t_, y1 + (y2 - y1) * t_, np.zeros_like(t_)]))
            cv2.polylines(vis, [q[np.isfinite(q).all(1)].astype(np.int32).reshape(-1, 1, 2)], False, (0, 255, 255), 1)
        q = c.project(A._net_tape())
        cv2.polylines(vis, [q.astype(np.int32).reshape(-1, 1, 2)], False, (255, 0, 255), 1)
        for w_, i_ in zip(world, img):
            cv2.circle(vis, tuple(int(v) for v in i_), 6, (0, 255, 0), 1)
        cv2.imwrite(debug, vis)
    return cal


def main() -> None:
    plate = cv2.imread(sys.argv[1])
    pairs = []
    for arg in sys.argv[3:]:
        w, i = arg.split("=")
        pairs.append((tuple(map(float, w.split(","))), tuple(map(float, i.split(",")))))
    out = Path(sys.argv[2])
    out.parent.mkdir(parents=True, exist_ok=True)
    cal = calibrate(plate, pairs, str(out.with_suffix(".jpg")))
    Path(out).write_text(json.dumps(cal))
    c = cal["camera"]
    print(f"{cal['quality']}: landmark rms {cal['rms']:.2f}px, line cover {cal['coverage']:.2f}, f {c['f']:.0f} "
          f"(hfov {c['hfovDeg']:.0f}), camera at {np.round(c['position'], 2).tolist()}")


if __name__ == "__main__":
    main()
