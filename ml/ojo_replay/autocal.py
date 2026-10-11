"""Calibrate the court automatically, no pins: the camera from the painted lines.

    python -m ojo_replay.autocal <video-or-url> <out.json> [debug.jpg]

The manual panel (web/app/CourtCalibration.tsx) needs someone to click corners.
For analysing every upload that step has to go, so this finds the court itself:

1. A clean plate: the per-pixel median of frames sampled across the match, so
   players, balls and passing shadows drop out and the lines are unbroken.
2. Line paint: bright and unsaturated (the same score as web/lib/court/snap.ts),
   kept only where it is thinner than the surroundings (a white top-hat, so sun
   and shade don't matter) and lies on the court surface (the dominant colour of
   the lower image), which rules out clouds, fences and window frames.
3. Straight lines from the paint (Hough), merged and refitted.
4. Every pairing of two across-court lines (baselines / service lines) and two
   along-court lines (sidelines / centre line) with the court model gives a
   ground homography; each is scored by how much of the whole projected court
   lands on paint. The best is refined by re-fitting each model line to the
   paint near where it projects, and re-solving from all their crossings.
5. The camera (focal length, position, orientation) from the homography: square
   pixels and a centred principal point leave the focal length as the only
   unknown, which the homography fixes; then a pose fit to every crossing.

Output matches what the web panel saves (`videos.court_calibration`), so
camera.Camera reads either.
"""

from __future__ import annotations

import itertools
import json
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np

from .camera import DOUBLES, HALF_LENGTH, SERVICE, SINGLES

ACROSS = [HALF_LENGTH, SERVICE, -SERVICE, -HALF_LENGTH]  # y of lines across the court, far to near
ALONG = [-DOUBLES, -SINGLES, 0.0, SINGLES, DOUBLES]  # x of lines along it, left to right
# Where each along-court line is painted (the centre line only between the service lines).
ALONG_SPAN = {-DOUBLES: HALF_LENGTH, -SINGLES: HALF_LENGTH, 0.0: SERVICE, SINGLES: HALF_LENGTH, DOUBLES: HALF_LENGTH}
# Across-court lines: baselines run the doubles width, service lines the singles width.
ACROSS_SPAN = {HALF_LENGTH: DOUBLES, -HALF_LENGTH: DOUBLES, SERVICE: SINGLES, -SERVICE: SINGLES}


def model_segments() -> list[tuple[tuple[float, float], tuple[float, float]]]:
    segs = [((-ACROSS_SPAN[y], y), (ACROSS_SPAN[y], y)) for y in ACROSS]
    segs += [((x, -ALONG_SPAN[x]), (x, ALONG_SPAN[x])) for x in ALONG]
    return segs


# ---------------------------------------------------------------------- frames


def read_samples(video: str, n: int = 31, start: float = 0.04, end: float = 0.96) -> list[np.ndarray]:
    """n frames spread across the video (local file or URL)."""
    dur = float(
        subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video],
            capture_output=True, text=True, check=True,
        ).stdout.strip()
    )
    frames = []
    for t in np.linspace(start * dur, end * dur, n):
        try:
            raw = subprocess.run(
                ["ffmpeg", "-nostdin", "-v", "error", "-ss", f"{t:.2f}", "-i", video, "-frames:v", "1",
                 "-f", "image2pipe", "-vcodec", "png", "-"],
                capture_output=True, timeout=90,  # a stalled remote read shouldn't hang the run
            ).stdout
        except subprocess.TimeoutExpired:
            continue
        img = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR) if raw else None
        if img is not None:
            frames.append(img)
    return frames


def clean_plate(frames: list[np.ndarray]) -> np.ndarray:
    shapes = {f.shape for f in frames}
    shape = max(shapes, key=lambda s: sum(f.shape == s for f in frames))
    stack = np.stack([f for f in frames if f.shape == shape])  # uint8: ~6 MB a 1080p frame
    # Median in row blocks, staying in uint8 (np.median would make a float64 copy
    # of the whole stack: a gigabyte for 21 frames).
    out = np.empty(shape, np.uint8)
    mid = len(stack) // 2
    for r in range(0, shape[0], 64):
        out[r : r + 64] = np.partition(stack[:, r : r + 64], mid, axis=0)[mid]
    return out


# ----------------------------------------------------------------------- paint


def paint_mask(img: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """(paint pixels, court-surface region), both uint8 0/1."""
    f = img.astype(np.float32)
    b, g, r = f[..., 0], f[..., 1], f[..., 2]
    score = 0.299 * r + 0.587 * g + 0.114 * b - 0.6 * (f.max(axis=2) - f.min(axis=2))
    H, W = score.shape
    k = max(15, int(round(W / 60)) | 1)  # wider than the nearest line's paint
    tophat = score - cv2.morphologyEx(score, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (k, k)))

    # The court surface: the dominant colour of the lower half (where the court
    # always is in an Ojo recording), grown over its own lines.
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    lower = hsv[H // 2 :].reshape(-1, 3)
    lower = lower[lower[:, 1] > 50]
    hue = int(np.bincount(lower[:, 0], minlength=180).argmax()) if len(lower) else 10
    dh = np.abs(((hsv[..., 0].astype(int) - hue) + 90) % 180 - 90)
    surface = ((dh < 12) & (hsv[..., 1] > 50)).astype(np.uint8)
    surface = cv2.morphologyEx(surface, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    surface = cv2.morphologyEx(surface, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * k + 1, 2 * k + 1)))
    # Keep the biggest piece (the court, not a bit of the next one through a fence).
    n, lab, stats, _ = cv2.connectedComponentsWithStats(surface)
    if n > 1:
        surface = (lab == 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))).astype(np.uint8)
    region = cv2.dilate(surface, np.ones((9, 9), np.uint8))

    vals = tophat[region > 0]
    thr = max(18.0, float(np.percentile(vals, 97)) * 0.5) if len(vals) else 25.0
    paint = ((tophat > thr) & (region > 0)).astype(np.uint8)
    # Sunlit walls, bags and benches are thick: drop whatever survives an erosion
    # wider than any line's paint. (Measured per region, not per connected piece:
    # a court's lines all join up into one big, thin network.)
    t = max(9, int(round(W / 120)) | 1)
    thick = cv2.morphologyEx(paint, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (t, t)))
    paint = paint & (1 - cv2.dilate(thick, np.ones((5, 5), np.uint8)))
    # Lines are long; worn clay, footprints and stray balls are short. Keep pieces
    # that stretch at least a few percent of the frame.
    n, lab, stats, _ = cv2.connectedComponentsWithStats(paint, connectivity=8)
    extent = np.hypot(stats[:, cv2.CC_STAT_WIDTH], stats[:, cv2.CC_STAT_HEIGHT])
    keep = extent >= W / 30
    keep[0] = False
    paint = keep[lab].astype(np.uint8)
    return paint, surface


# ----------------------------------------------------------------------- lines


def find_lines(paint: np.ndarray, max_lines: int = 24) -> list[np.ndarray]:
    """Infinite image lines (a, b, c), a*x + b*y + c = 0 with a^2 + b^2 = 1."""
    H, W = paint.shape
    segs = cv2.HoughLinesP(paint * 255, 1, np.pi / 720, threshold=40, minLineLength=W // 25, maxLineGap=W // 100)
    if segs is None:
        return []
    segs = segs[:, 0].astype(np.float64)
    ys, xs = np.nonzero(paint)
    pts = np.column_stack([xs, ys]).astype(np.float64)
    lines: list[np.ndarray] = []
    used = np.zeros(len(segs), bool)
    order = np.argsort(-np.hypot(segs[:, 2] - segs[:, 0], segs[:, 3] - segs[:, 1]))
    for i in order:
        if used[i]:
            continue
        x1, y1, x2, y2 = segs[i]
        line = _line_through((x1, y1), (x2, y2))
        # Refine on the paint near it, twice, narrowing.
        for band in (6.0, 3.0):
            near = np.abs(pts @ line[:2] + line[2]) < band
            if near.sum() < 30:
                break
            line = _tls(pts[near])
        # Swallow every Hough segment that lies on this line.
        for j in order:
            if not used[j]:
                d = np.abs(np.array([segs[j, 0], segs[j, 2]]) * line[0] + np.array([segs[j, 1], segs[j, 3]]) * line[1] + line[2])
                if d.max() < 5:
                    used[j] = True
        used[i] = True
        # Support: the length of Hough segments lying on it (pixel counts along
        # an infinite line would reward lines threading through clutter).
        on = np.maximum(
            np.abs(segs[:, 0] * line[0] + segs[:, 1] * line[1] + line[2]),
            np.abs(segs[:, 2] * line[0] + segs[:, 3] * line[1] + line[2]),
        ) < 4
        support = float(np.hypot(segs[on, 2] - segs[on, 0], segs[on, 3] - segs[on, 1]).sum())
        if support > W / 12:
            lines.append(np.append(line, support))
    lines.sort(key=lambda l: -l[3])
    # Merge near-duplicates (the two edges of a thick line).
    out: list[np.ndarray] = []
    for l in lines:
        if all(not _same(l, m, W, H) for m in out):
            out.append(l)
    return [l[:3] for l in out[:max_lines]]


def _line_through(p, q) -> np.ndarray:
    d = np.array([q[0] - p[0], q[1] - p[1]], float)
    n = np.array([-d[1], d[0]]) / np.linalg.norm(d)
    return np.array([n[0], n[1], -(n[0] * p[0] + n[1] * p[1])])


def _tls(pts: np.ndarray) -> np.ndarray:
    c = pts.mean(axis=0)
    _, _, vt = np.linalg.svd(pts - c, full_matrices=False)
    n = vt[1]
    return np.array([n[0], n[1], -(n @ c)])


def _same(l, m, W, H) -> bool:
    if abs(l[0] * m[1] - l[1] * m[0]) > np.sin(np.radians(2)):
        return False
    # Distance between the lines at a few points across the image.
    for x in (0.2 * W, 0.5 * W, 0.8 * W):
        if abs(l[1]) > 0.3:
            y = -(l[0] * x + l[2]) / l[1]
            if abs(m[0] * x + m[1] * y + m[2]) > 6:
                return False
        else:
            y = x * H / W
            xx = -(l[1] * y + l[2]) / l[0]
            if abs(m[0] * xx + m[1] * y + m[2]) > 6:
                return False
    return True


def _meet(l, m) -> np.ndarray | None:
    p = np.cross(l, m)
    return None if abs(p[2]) < 1e-9 else p[:2] / p[2]


# --------------------------------------------------------------------- fitting


def _samples(step: float = 0.05) -> np.ndarray:
    pts = []
    for (x1, y1), (x2, y2) in model_segments():
        n = max(2, int(np.hypot(x2 - x1, y2 - y1) / step))
        t = np.linspace(0, 1, n)
        pts.append(np.column_stack([x1 + (x2 - x1) * t, y1 + (y2 - y1) * t]))
    return np.vstack(pts)


def _project(Hm: np.ndarray, pts: np.ndarray) -> np.ndarray:
    p = np.column_stack([pts, np.ones(len(pts))]) @ Hm.T
    with np.errstate(divide="ignore", invalid="ignore"):
        return p[:, :2] / p[:, 2:3]


def line_weight(paint: np.ndarray) -> np.ndarray:
    """What landing on each pixel is worth: paint near it (dilated a pixel),
    counted less where paint is dense. A line is thin, so most of its
    neighbourhood is bare court; fence mesh and nets are paint all over, and a
    court laid over them would otherwise score well for nothing."""
    near = cv2.dilate(paint, np.ones((3, 3), np.uint8)).astype(np.float32)
    density = cv2.blur(paint.astype(np.float32), (21, 21))
    return near * np.clip(1.0 - 2.5 * density, 0.0, 1.0)


def score(Hm: np.ndarray, near_paint: np.ndarray, surface: np.ndarray, samples: np.ndarray) -> float:
    """Paint pixels the projected court covers, less the court pixels it misses."""
    H, W = near_paint.shape
    uv = _project(Hm, samples)
    ok = np.isfinite(uv).all(axis=1)
    uv = uv[ok]
    inside = (uv[:, 0] >= 0) & (uv[:, 0] < W) & (uv[:, 1] >= 0) & (uv[:, 1] < H)
    if inside.sum() < 50:
        return -1e9
    px = np.unique(np.floor(uv[inside]).astype(int), axis=0)
    w = near_paint[px[:, 1], px[:, 0]]
    hit = w > 0
    # Only count a miss where the court surface is visible (a line behind the
    # fence or off the playable area may just be hidden).
    on_court = surface[px[:, 1], px[:, 0]] > 0
    return float(w.sum() - 0.6 * (~hit & on_court).sum())


# Ojo is filmed on an iPhone's ultra-wide lens: four matches calibrated by hand
# from their net posts all came out at f = 0.38-0.39 of the image width, the
# camera 2.8-2.9 m up and 17-19 m behind centre court.
LENS = (0.37, 0.41)


def _rigid(Hm: np.ndarray, W: int, H: int) -> tuple[float, float, np.ndarray | None]:
    """How far the homography is from a real camera with the Ojo lens:
    (error, best f, camera position). K^-1 H must hold two perpendicular,
    equal-length rotation columns; a court matched to the wrong lines doesn't."""
    best = (9.0, 0.0, None)
    for f in np.linspace(LENS[0] * W, LENS[1] * W, 8):
        G = np.diag([1 / f, 1 / f, 1.0]) @ np.array([[1, 0, -W / 2], [0, 1, -H / 2], [0, 0, 1.0]]) @ Hm
        a, b = G[:, 0], G[:, 1]
        na, nb = np.linalg.norm(a), np.linalg.norm(b)
        err = abs(na - nb) / ((na + nb) / 2) + abs(a @ b) / (na * nb)
        if err < best[0]:
            lam = 2 / (na + nb)
            r1, r2 = a * lam, b * lam
            t = G[:, 2] * lam
            if t[2] < 0:  # the court in front of the camera
                r1, r2, t = -r1, -r2, -t
            R = np.column_stack([r1, r2, np.cross(r1, r2)])
            best = (float(err), float(f), -R.T @ t)
    return best


def _plausible(Hm: np.ndarray, W: int, H: int) -> bool:
    """Far baseline above the near one, left on the left, court not inverted."""
    c = _project(Hm, np.array([[-DOUBLES, -HALF_LENGTH], [DOUBLES, -HALF_LENGTH], [DOUBLES, HALF_LENGTH], [-DOUBLES, HALF_LENGTH], [0, 0]]))
    if not np.isfinite(c).all():
        return False
    # Every court point must be in front of the camera: the homography's w keeps one sign.
    w = np.column_stack([np.array([[-DOUBLES, -HALF_LENGTH], [DOUBLES, -HALF_LENGTH], [DOUBLES, HALF_LENGTH], [-DOUBLES, HALF_LENGTH]]), np.ones(4)]) @ Hm[2]
    if not ((w > 0).all() or (w < 0).all()):
        return False
    nl, nr, fr, fl, mid = c
    if not (fl[1] < nl[1] and fr[1] < nr[1] and nl[0] < nr[0] and fl[0] < fr[0]):
        return False
    # The far baseline is shorter on screen than the near one (perspective).
    if np.linalg.norm(fr - fl) > np.linalg.norm(nr - nl):
        return False
    # Centre court roughly within the frame.
    if not (-0.25 * W < mid[0] < 1.25 * W and -0.25 * H < mid[1] < 1.25 * H):
        return False
    # And the court big on screen: the service boxes (between the service lines)
    # cover at least a percent of the frame (~2.5% from behind the baseline on an ultra-wide). A court shrunk onto the net mesh
    # would otherwise match plenty of white.
    box = _project(Hm, np.array([[-SINGLES, -SERVICE], [SINGLES, -SERVICE], [SINGLES, SERVICE], [-SINGLES, SERVICE]]))
    return cv2.contourArea(box.astype(np.float32)) > 0.01 * W * H


def _on_surface(Hm: np.ndarray, surface: np.ndarray) -> bool:
    """The court's own ground (the service boxes, sampled) lies on court-coloured pixels."""
    H, W = surface.shape
    g = np.array([[x, y] for x in (-3, -1, 1, 3) for y in (-5, -2, 2, 5)], float)
    uv = _project(Hm, g)
    ok = np.isfinite(uv).all(axis=1) & (uv[:, 0] >= 0) & (uv[:, 0] < W) & (uv[:, 1] >= 0) & (uv[:, 1] < H)
    if ok.sum() < 8:
        return False
    px = uv[ok].astype(int)
    return (surface[px[:, 1], px[:, 0]] > 0).mean() > 0.8


def search(lines: list[np.ndarray], paint: np.ndarray, surface: np.ndarray) -> tuple[np.ndarray, float] | None:
    H, W = paint.shape
    near_paint = line_weight(paint)
    coarse, fine = _samples(0.3), _samples(0.05)
    # Across-court lines face the camera, so they run near-horizontal; along-court
    # lines head for the vanishing point (as shallow as ~30 deg on an ultra-wide).
    across = [l for l in lines if abs(l[1]) > np.cos(np.radians(15))][:8]
    along = [l for l in lines if abs(l[1]) <= np.cos(np.radians(15))][:10]

    def y_at_centre(l):
        return -(l[0] * W / 2 + l[2]) / l[1]

    def x_at(l, y):
        return -(l[1] * y + l[2]) / l[0]

    across.sort(key=y_at_centre)  # top (far) first
    along_pairs = []
    for lc, ld in itertools.combinations(along, 2):
        # Sidelines converge away from the camera: they meet above the court.
        vp = _meet(lc, ld)
        if vp is None or vp[1] > min(y_at_centre(l) for l in across[:1] or [lc]) + 0.1 * H:
            continue
        along_pairs.append((lc, ld))
    cands: list[tuple[float, np.ndarray]] = []
    for la, lb in itertools.combinations(across, 2):
        ymid = (y_at_centre(la) + y_at_centre(lb)) / 2
        for lc, ld in along_pairs:
            if x_at(lc, ymid) > x_at(ld, ymid):
                lc, ld = ld, lc
            img = [_meet(la, lc), _meet(la, ld), _meet(lb, lc), _meet(lb, ld)]
            if any(p is None for p in img):
                continue
            img = np.array(img, np.float32)
            for ya, yb in itertools.combinations(ACROSS, 2):  # far before near, as on screen
                for xc, xd in itertools.combinations(ALONG, 2):
                    world = np.array([[xc, ya], [xd, ya], [xc, yb], [xd, yb]], np.float32)
                    Hm = cv2.getPerspectiveTransform(world, img)
                    if not _plausible(Hm, W, H) or not _on_surface(Hm, surface):
                        continue
                    err, _, pos = _rigid(Hm, W, H)
                    # A phone on a fence or tripod, behind the near baseline.
                    if err > 0.12 or pos is None or not (1.0 < pos[2] < 5.0 and pos[1] < -HALF_LENGTH + 1):
                        continue
                    cands.append((_quick(Hm, near_paint, surface, coarse), Hm))
    if not cands:
        return None
    cands.sort(key=lambda c: -c[0])
    best = max(cands[:40], key=lambda c: score(c[1], near_paint, surface, fine))
    return best[1], score(best[1], near_paint, surface, fine)


def search_anchored(lines: list[np.ndarray], paint: np.ndarray, surface: np.ndarray) -> tuple[np.ndarray, float] | None:
    """Court hypotheses anchored on the near baseline.

    Measured on five calibrated matches: the near baseline is always the
    strongest across-court line found, the sidelines are found but anywhere in
    the ranking, and the service lines often not at all (thin, faint, far). So:
    the strongest across line or two as the near baseline, any line above it as
    one of the other three across lines, and any two of many along lines as two
    of the five along lines. The known lens rejects most combinations before
    they're scored (`_rigid`): a real camera can't produce them.
    """
    H, W = paint.shape
    near_paint = line_weight(paint)
    coarse, fine = _samples(0.3), _samples(0.05)
    across = [l for l in lines if abs(l[1]) > np.cos(np.radians(15))]
    along = [l for l in lines if abs(l[1]) <= np.cos(np.radians(15))][:18]

    def y_at(l, x=W / 2):
        return -(l[0] * x + l[2]) / l[1]

    def x_at(l, y):
        return -(l[1] * y + l[2]) / l[0]

    cands: list[tuple[float, np.ndarray]] = []
    for base in across[:2]:
        yb = y_at(base)
        others = [l for l in across if y_at(l) < yb - 8][:30]
        for lc, ld in itertools.combinations(along, 2):
            if x_at(lc, yb) > x_at(ld, yb):
                lc, ld = ld, lc
            p_bc, p_bd = _meet(base, lc), _meet(base, ld)
            if p_bc is None or p_bd is None:
                continue
            for top in others:
                p_tc, p_td = _meet(top, lc), _meet(top, ld)
                if p_tc is None or p_td is None:
                    continue
                img = np.array([p_tc, p_td, p_bc, p_bd], np.float32)
                for y_top in ACROSS[:3]:  # far base, far service, near service
                    for xc, xd in itertools.combinations(ALONG, 2):
                        world = np.array([[xc, y_top], [xd, y_top], [xc, -HALF_LENGTH], [xd, -HALF_LENGTH]], np.float32)
                        Hm = cv2.getPerspectiveTransform(world, img)
                        err, _, pos = _rigid(Hm, W, H)
                        if err > 0.12 or pos is None or not (0.8 < pos[2] < 8.0):
                            continue
                        if not _plausible(Hm, W, H) or not _on_surface(Hm, surface):
                            continue
                        cands.append((_quick(Hm, near_paint, surface, coarse), Hm))
    if not cands:
        return None
    cands.sort(key=lambda c: -c[0])
    best = max(cands[:40], key=lambda c: score(c[1], near_paint, surface, fine))
    return best[1], score(best[1], near_paint, surface, fine)


def _quick(Hm, near_paint, surface, samples) -> float:
    H, W = near_paint.shape
    uv = _project(Hm, samples)
    ok = np.isfinite(uv).all(axis=1) & (uv[:, 0] >= 0) & (uv[:, 0] < W) & (uv[:, 1] >= 0) & (uv[:, 1] < H)
    if ok.sum() < 20:
        return -1e9
    px = np.unique(uv[ok].astype(int), axis=0)
    w = near_paint[px[:, 1], px[:, 0]]
    return float(w.sum() - 0.6 * ((w == 0) & (surface[px[:, 1], px[:, 0]] > 0)).sum())


def refine(Hm: np.ndarray, paint: np.ndarray, iters: int = 4) -> tuple[np.ndarray, float]:
    """Re-fit every model line to the paint near where it projects, then solve
    the homography from all their crossings. Returns (H, rms px of paint to line)."""
    H, W = paint.shape
    ys, xs = np.nonzero(paint)
    pts = np.column_stack([xs, ys]).astype(np.float64)
    rms = float("nan")
    for it in range(iters):
        band = [8.0, 5.0, 3.0, 3.0][min(it, 3)]
        fitted: dict[tuple, np.ndarray] = {}
        errs = []
        for seg in model_segments():
            (x1, y1), (x2, y2) = seg
            t = np.linspace(0.02, 0.98, 60)
            uv = _project(Hm, np.column_stack([x1 + (x2 - x1) * t, y1 + (y2 - y1) * t]))
            ok = np.isfinite(uv).all(axis=1) & (uv[:, 0] >= 0) & (uv[:, 0] < W) & (uv[:, 1] >= 0) & (uv[:, 1] < H)
            if ok.sum() < 8:
                continue
            uv = uv[ok]
            line = _tls(uv)
            lo, hi = uv.min(axis=0) - band, uv.max(axis=0) + band
            box = (pts[:, 0] >= lo[0]) & (pts[:, 0] <= hi[0]) & (pts[:, 1] >= lo[1]) & (pts[:, 1] <= hi[1])
            cand = pts[box]
            near = cand[np.abs(cand @ line[:2] + line[2]) < band]
            if len(near) < 25:
                continue
            new = _tls(near)
            errs.append(np.abs(near @ new[:2] + new[2]))
            fitted[seg] = new
        world, img = [], []
        for (s1, l1), (s2, l2) in itertools.combinations(fitted.items(), 2):
            p = _seg_cross(s1, s2)
            if p is None:
                continue
            q = _meet(l1, l2)
            if q is None or not (-W < q[0] < 2 * W and -H < q[1] < 2 * H):
                continue
            world.append(p)
            img.append(q)
        if len(world) < 4:
            break
        Hn, _ = cv2.findHomography(np.array(world), np.array(img), 0)
        if Hn is None:
            break
        Hm = Hn
        rms = float(np.sqrt(np.mean(np.concatenate(errs) ** 2))) if errs else rms
    return Hm, rms


def _seg_cross(s1, s2):
    """Court point where two model lines meet (extended as lines), or None if parallel."""
    l1 = np.cross([*s1[0], 1.0], [*s1[1], 1.0])
    l2 = np.cross([*s2[0], 1.0], [*s2[1], 1.0])
    p = np.cross(l1, l2)
    if abs(p[2]) < 1e-9:
        return None
    return p[:2] / p[2]


# ---------------------------------------------------------------------- camera


def _pose(Hm: np.ndarray, f: float, W: int, H: int):
    K = np.array([[f, 0, W / 2], [0, f, H / 2], [0, 0, 1.0]])
    world = np.array([[x, y, 0.0] for x in ALONG for y in ACROSS])
    img = _project(Hm, world[:, :2])
    ok, rvec, tvec = cv2.solvePnP(world, img, K, None, flags=cv2.SOLVEPNP_ITERATIVE)
    if not ok:
        return None
    R, _ = cv2.Rodrigues(rvec)
    return K, R, tvec.ravel()


def _net_tape(n: int = 80) -> np.ndarray:
    """Points along the top of the net: 0.914 m in the middle, 1.07 m at the posts."""
    x = np.linspace(-6.4, 6.4, n)
    return np.column_stack([x, np.zeros(n), 0.914 + (1.07 - 0.914) * np.abs(x) / 6.4])


def camera_from_homography(Hm: np.ndarray, W: int, H: int, paint: np.ndarray | None = None) -> dict | None:
    """The camera, given the ground homography.

    Square pixels and a centred principal point leave the focal length as the one
    unknown, but from behind a baseline the ground plane alone hardly fixes it
    (the court's vanishing points sit far out to the sides). The net does: it
    stands 0.914-1.07 m off the ground, and its white tape is in the paint. So
    each focal length on a scan gets its pose from the homography, and the one
    that puts the net tape on paint wins. Without paint (or without a clear
    winner) it falls back to the homography's own estimate.
    """
    cands = []
    if paint is not None:
        near = cv2.dilate(paint, np.ones((5, 5), np.uint8))
        tape = _net_tape()
        for f in np.linspace(LENS[0] * W, LENS[1] * W, 36):
            pose = _pose(Hm, f, W, H)
            if pose is None:
                continue
            K, R, t = pose
            pos = -R.T @ t
            if not (1.0 < pos[2] < 5.0):  # on a tripod, fence or bench
                continue
            cam = tape @ R.T + t
            if (cam[:, 2] <= 0).any():
                continue
            uv = cam[:, :2] / cam[:, 2:3] * f + K[:2, 2]
            ok = (uv[:, 0] >= 0) & (uv[:, 0] < W) & (uv[:, 1] >= 0) & (uv[:, 1] < H)
            if ok.sum() < len(uv) // 2:
                continue
            px = uv[ok].astype(int)
            cands.append((float((near[px[:, 1], px[:, 0]] > 0).mean()), f))
    f, from_net = None, False
    if cands:
        best = max(cands)
        # A clear peak: the tape lies on paint for this f and not for most others.
        if best[0] > 0.5 and best[0] > np.median([c[0] for c in cands]) + 0.25:
            # Centre of the run of focal lengths that score near the best.
            good = [c[1] for c in cands if c[0] >= best[0] - 0.05]
            f, from_net = float(np.exp(np.mean(np.log(good)))), True
    net_score = max(cands)[0] if cands else None
    if f is None:
        f = _rigid(Hm, W, H)[1] or 0.385 * W
    pose = _pose(Hm, f, W, H)
    if pose is None:
        return None
    K, R, t = pose
    pos = -R.T @ t
    if pos[2] <= 0.2:
        return None
    return {
        "f": f, "cx": W / 2, "cy": H / 2,
        "hfovDeg": float(np.degrees(2 * np.arctan(W / (2 * f)))),
        "position": pos.tolist(), "rotation": R.ravel().tolist(), "translation": t.tolist(),
        "focalFrom": "net" if from_net else "ground",
        "netScore": net_score,
    }


def polish(cam: dict, paint: np.ndarray, W: int, H: int) -> tuple[dict, np.ndarray, float]:
    """Nudge the whole camera (pose and focal length, within the lens's range)
    so the projected court lines sit on line paint. Each line sample counts for
    the screen length it covers, so the near court, large and clearly painted,
    leads; distances are capped so clutter can't pull. Starts from the
    homography's camera, which is already close; returns (camera, homography,
    mean distance px)."""
    from scipy.optimize import minimize

    good = (line_weight(paint) > 0.3).astype(np.uint8)
    dt = cv2.distanceTransform(1 - good, cv2.DIST_L2, 3)
    cap = 12.0
    world, seg = [], []
    for k, ((x1, y1), (x2, y2)) in enumerate(model_segments()):
        n = max(2, int(np.hypot(x2 - x1, y2 - y1) / 0.04))
        t = np.linspace(0, 1, n)
        world.append(np.column_stack([x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, np.zeros(n)]))
        seg.append(np.full(n, k))
    world, seg = np.vstack(world), np.concatenate(seg)
    R0 = np.array(cam["rotation"]).reshape(3, 3)
    r0, _ = cv2.Rodrigues(R0)
    x0 = np.concatenate([r0.ravel(), cam["translation"], [cam["f"] / W]])

    def unpack(x):
        R, _ = cv2.Rodrigues(x[:3])
        return R, x[3:6], x[6] * W

    def cost(x):
        if not (LENS[0] <= x[6] <= LENS[1]):
            return 1e3
        R, t, f = unpack(x)
        pc = world @ R.T + t
        if (pc[:, 2] <= 0.5).any():
            return 1e3
        uv = pc[:, :2] / pc[:, 2:3] * f + [W / 2, H / 2]
        step = np.linalg.norm(np.diff(uv, axis=0), axis=1)
        w = np.append(np.where(np.diff(seg) == 0, step, 0), 0)
        ins = (uv[:, 0] >= 0) & (uv[:, 0] < W - 1) & (uv[:, 1] >= 0) & (uv[:, 1] < H - 1)
        if w[ins].sum() < W / 4:
            return 1e3
        px = uv[ins].astype(int)
        d = np.minimum(dt[px[:, 1], px[:, 0]], cap)
        return float((d * w[ins]).sum() / w[ins].sum())

    scale = np.array([0.01, 0.01, 0.01, 0.2, 0.2, 0.2, 0.005])
    r = minimize(lambda z: cost(x0 + z * scale), np.zeros(7), method="Powell",
                 options={"xtol": 1e-3, "ftol": 1e-4, "maxfev": 4000})
    x = x0 + r.x * scale
    if cost(x) > cost(x0):
        x = x0
    R, t, f = unpack(x)
    pos = -R.T @ t
    K = np.array([[f, 0, W / 2], [0, f, H / 2], [0, 0, 1.0]])
    Hm = K @ np.column_stack([R[:, 0], R[:, 1], t])
    Hm /= Hm[2, 2]
    out = {**cam, "f": float(f), "hfovDeg": float(np.degrees(2 * np.arctan(W / (2 * f)))),
           "position": pos.tolist(), "rotation": R.ravel().tolist(), "translation": t.tolist()}
    return out, Hm, cost(x)


# ------------------------------------------------------------------------ main


# The web panel's landmarks (web/lib/court/model.ts), so an automatic result
# opens there as pins to check and drag.
POST_X, POST_TOP = 6.4, 1.07
PANEL_LANDMARKS = {
    "far_left_doubles": (-DOUBLES, HALF_LENGTH, 0), "far_right_doubles": (DOUBLES, HALF_LENGTH, 0),
    "near_right_doubles": (DOUBLES, -HALF_LENGTH, 0), "near_left_doubles": (-DOUBLES, -HALF_LENGTH, 0),
    "far_left_singles": (-SINGLES, HALF_LENGTH, 0), "far_right_singles": (SINGLES, HALF_LENGTH, 0),
    "near_right_singles": (SINGLES, -HALF_LENGTH, 0), "near_left_singles": (-SINGLES, -HALF_LENGTH, 0),
    "far_t": (0, SERVICE, 0), "near_t": (0, -SERVICE, 0),
    "far_left_service": (-SINGLES, SERVICE, 0), "far_right_service": (SINGLES, SERVICE, 0),
    "near_left_service": (-SINGLES, -SERVICE, 0), "near_right_service": (SINGLES, -SERVICE, 0),
    "left_post_top": (-POST_X, 0, POST_TOP), "right_post_top": (POST_X, 0, POST_TOP),
    "left_post_base": (-POST_X, 0, 0), "right_post_base": (POST_X, 0, 0),
}


def panel_pins(cam: dict, W: int, H: int) -> list[dict]:
    """The panel's landmarks where this camera puts them, those inside the frame."""
    R = np.array(cam["rotation"]).reshape(3, 3)
    t = np.array(cam["translation"])
    out = []
    for lid, p in PANEL_LANDMARKS.items():
        c = R @ np.array(p, float) + t
        if c[2] <= 0.5:
            continue
        u, v = c[0] / c[2] * cam["f"] + W / 2, c[1] / c[2] * cam["f"] + H / 2
        if 4 <= u < W - 4 and 4 <= v < H - 4:
            out.append({"id": lid, "x": round(float(u), 1), "y": round(float(v), 1)})
    return out


def confident(r: dict) -> bool:
    """Whether to trust an automatic result without a person checking it. The
    mean distance from the fitted lines to line paint (`linePx`) separated right
    from wrong on 25 recordings: right ones sit under ~4 px. And the camera must
    be somewhere a phone can be: behind the near baseline, 1.2-6 m up."""
    x, y, z = r["camera"]["position"]
    return r["linePx"] <= 4.0 and 1.2 <= z <= 6.0 and y < -HALF_LENGTH and abs(x) < 8


def read_window(video: str, start: float, span: float = 40.0, n: int = 9) -> list[np.ndarray]:
    """n frames over a short stretch: a clean plate even if the phone moves later."""
    frames = []
    for t in np.linspace(start, start + span, n):
        try:
            raw = subprocess.run(
                ["ffmpeg", "-nostdin", "-v", "error", "-ss", f"{t:.2f}", "-i", video, "-frames:v", "1",
                 "-f", "image2pipe", "-vcodec", "png", "-"],
                capture_output=True, timeout=90,  # a stalled remote read shouldn't hang the run
            ).stdout
        except subprocess.TimeoutExpired:
            continue
        img = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR) if raw else None
        if img is not None:
            frames.append(img)
    return frames


def _agree(a: dict, b: dict, tol: float = 15.0) -> bool:
    """Two stretches see the same camera. Fits of a still camera differ by 1-10 px
    (measured on 5 matches); a phone that was moved differs by 50+."""
    g = np.array([[x, y] for x in (-5.485, 0, 5.485) for y in (-11.885, -6.4, 0, 6.4, 11.885)])
    pa = _project(np.array(a["homography"]).reshape(3, 3), g)
    pb = _project(np.array(b["homography"]).reshape(3, 3), g)
    return float(np.median(np.linalg.norm(pa - pb, axis=1))) < tol


def calibrate(video: str, debug: str | None = None, windows: int = 6) -> dict:
    """The court from a video. Calibrates a few short stretches spread through
    it (a phone on a fence gets bumped; a whole-match median of a moving camera
    is a blur), keeps the best, and says whether the stretches agree.

    The result carries `landmarks` as the web panel's pins, `status` "auto"
    (trust it) or "review" (show it in the panel to check), and `moved` when
    confident stretches disagree, i.e. the camera moved during the recording.
    """
    dur = float(subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video],
        capture_output=True, text=True, check=True,
    ).stdout.strip())
    span = min(40.0, dur / (windows + 1))
    results = []
    for k, start in enumerate(np.linspace(0.03 * dur, 0.97 * dur - span, windows)):
        frames = read_window(video, float(start), span)
        if len(frames) < 3:
            continue
        try:
            r = calibrate_plate(clean_plate(frames), debug.replace(".jpg", f"_{k}.jpg") if debug else None)
        except RuntimeError:
            continue
        r["frameS"] = round(float(start + span / 2), 2)
        r["confident"] = confident(r)
        results.append(r)
    if not results:
        raise RuntimeError("no court found in any stretch of the video")
    best = min(results, key=lambda r: (not r["confident"], r["linePx"]))
    sure = [r for r in results if r["confident"]]
    moved = any(not _agree(a, b) for a, b in itertools.combinations(sure, 2))
    W, H = best["imageWidth"], best["imageHeight"]
    best = {**best, "status": "auto" if best["confident"] and not moved else "review", "moved": moved,
            "landmarks": panel_pins(best["camera"], W, H),
            "windows": [{"frameS": r["frameS"], "linePx": round(r["linePx"], 2), "confident": r["confident"],
                         "homography": r["homography"]} for r in results]}
    return best


def calibrate_plate(plate: np.ndarray, debug: str | None = None) -> dict:
    paint, surface = paint_mask(plate)
    lines = find_lines(paint)
    H, W = paint.shape
    found = search_anchored(find_lines(paint, 40), paint, surface) or search(lines, paint, surface)
    if found is None:
        raise RuntimeError(f"no court found ({len(lines)} lines)")
    Hm, s = found
    # Refining re-fits every line to nearby paint; keep it only if the whole
    # court then sits better on the paint (it can latch onto a fence rail).
    near_paint = line_weight(paint)
    Hr, rms = refine(Hm, paint)
    fine = _samples(0.05)
    if score(Hr, near_paint, surface, fine) >= score(Hm, near_paint, surface, fine):
        Hm = Hr
    cam = camera_from_homography(Hm, W, H, paint)
    if cam is None:
        raise RuntimeError("homography gave no plausible camera")
    cam, Hm, line_px = polish(cam, paint, W, H)
    # Coverage: how much of the visible, on-court model lies on paint.
    near_paint = line_weight(paint)
    uv = _project(Hm, _samples(0.05))
    ok = np.isfinite(uv).all(axis=1) & (uv[:, 0] >= 0) & (uv[:, 0] < W) & (uv[:, 1] >= 0) & (uv[:, 1] < H)
    px = np.unique(np.floor(uv[ok]).astype(int), axis=0)
    cover = float((near_paint[px[:, 1], px[:, 0]] > 0).mean()) if len(px) else 0.0
    quality = "good" if cover > 0.7 and rms < 1.6 else "fair" if cover > 0.5 else "poor"
    result = {
        "model": "pinhole", "source": "auto", "camera": cam, "quality": quality, "version": 1,
        "imageWidth": W, "imageHeight": H, "homography": Hm.ravel().tolist(),
        "rms": rms, "coverage": cover, "lines": len(lines), "linePx": line_px,
    }
    if debug:
        vis = plate.copy()
        vis[paint > 0] = (255, 0, 255)
        for (x1, y1), (x2, y2) in model_segments():
            t = np.linspace(0, 1, 200)
            uv = _project(Hm, np.column_stack([x1 + (x2 - x1) * t, y1 + (y2 - y1) * t]))
            uv = uv[np.isfinite(uv).all(axis=1)].astype(np.int32)
            cv2.polylines(vis, [uv.reshape(-1, 1, 2)], False, (0, 255, 255), 2)
        cv2.putText(vis, f"{quality} cover {cover:.2f} rms {rms:.2f}px f {cam['f']:.0f} hfov {cam['hfovDeg']:.0f}",
                    (20, 50), 0, 1.4, (0, 255, 0), 3)
        cv2.imwrite(debug, vis)
    return result


def main(video: str, out: str, debug: str | None = None) -> None:
    cal = calibrate(video, debug)
    Path(out).write_text(json.dumps(cal))
    c = cal["camera"]
    print(f"{cal['status']}{' (camera moved)' if cal['moved'] else ''}: lines {cal['linePx']:.1f}px off paint, "
          f"f {c['f']:.0f} (hfov {c['hfovDeg']:.0f}), camera at {np.round(c['position'], 2).tolist()}, "
          f"{len(cal['landmarks'])} pins; stretches " + " ".join(f"{w['linePx']:.1f}{'*' if w['confident'] else ''}" for w in cal["windows"]))


if __name__ == "__main__":
    main(*sys.argv[1:4])

