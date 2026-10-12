"""Where the rallies are, from the ball alone.

A rally is the ball in play: tracked, moving, and crossing the net. Holding the
ball, bouncing it before a serve, or feeding balls back across between points
fail one test or another:

- balls lying still (spares on the court) are dropped before tracking;

- the tracked ball moves for most of a one-second window (not lying still, not
  lost behind a player for long), and not up and down in one spot: a server
  bouncing the ball is moving but dead, and separates a fault from the second
  serve and one point from the next;
- moving stretches less than `MERGE_S` apart are one rally (the ball is lost for
  a moment at a hit, against the far fence, or misread as a dribble);
- the ball crosses the net, on screen, at least once (a serve does; a bounce
  before serving doesn't), and the rally lasts at least `MIN_S`.
"""

from __future__ import annotations

import numpy as np

from .ball2d import BallCandidate, track_ball
from .camera import Camera

MERGE_S = 2.0  # stretches of play, for the shot fit
POINT_MERGE_S = 4.0  # points, for who served and the score
MIN_S = 2.0
PAD_S = 0.6  # 1.2 was tried (tagged points ran past the edges): it cost serving-end accuracy (24/32 -> 15/29)


def static(cands: np.ndarray, fps: float, width: int) -> np.ndarray:
    """(frames, KEEP) mask of detections that are balls lying still: another
    detection within a few pixels both half a second before and after. Spare
    balls on the court are real tennis balls, and the tracker would hop onto
    them whenever the ball in play is hidden."""
    n, k = cands.shape[:2]
    lag = int(0.5 * fps)
    tol = 10.0 * width / 1920  # a heatmap cell is ~4 px at full size; centroids jitter
    out = np.zeros((n, k), bool)
    xy = cands[:, :, :2]
    for f in range(lag, n - lag):
        for j in range(k):
            if not np.isfinite(xy[f, j, 0]):
                continue
            before = np.nanmin(np.linalg.norm(xy[f - lag] - xy[f, j], axis=1), initial=np.inf)
            after = np.nanmin(np.linalg.norm(xy[f + lag] - xy[f, j], axis=1), initial=np.inf)
            out[f, j] = before < tol and after < tol
    return out


def tracked(cands: np.ndarray, cam: Camera, fps: float = 30.0) -> np.ndarray:
    """(frames, KEEP, 3) candidates -> (frames, 2) tracked ball, NaN where none."""
    still = static(cands, fps, cam.width)
    flat = [
        BallCandidate(int(f), float(c[0]), float(c[1]), float(c[2]))
        for f in range(len(cands))
        for j, c in enumerate(cands[f])
        if np.isfinite(c[0]) and not still[f, j]
    ]
    track = track_ball(flat, max_jump=160.0 * cam.width / 1920)
    out = np.full((len(cands), 2), np.nan)
    for f, c in track.items():
        out[f] = (c.u, c.v)
    return out


def _net_row(cam: Camera, u: np.ndarray) -> np.ndarray:
    """Image row of the net tape (~1 m up) at image column u."""
    xs = np.linspace(-6.4, 6.4, 50)
    uv = cam.project(np.column_stack([xs, np.zeros_like(xs), np.full_like(xs, 0.95)]))
    return np.interp(u, uv[:, 0], uv[:, 1])


def dribbles(ball: np.ndarray, fps: float, cam: Camera) -> np.ndarray:
    """Frames where a server is bouncing the ball: up and down in one narrow
    column, reversing again and again. A shot straight down the middle is a
    narrow column on screen too, but reverses at most once (its bounce), and a
    toss once before it's hit. And a dribble stays low: within what 1.3 m looks
    like where it bounces, while a rally's ball travels the court. Moving, but
    dead."""
    width = cam.width
    n = len(ball)
    win = int(1.0 * fps)
    col = 25.0 * width / 1920
    amp = 8.0 * width / 1920
    out = np.zeros(n, bool)
    have = np.flatnonzero(np.isfinite(ball[:, 0]))
    for k, i in enumerate(have):
        j = np.searchsorted(have, i + win)
        idx = have[k:j]
        if len(idx) < win // 3:
            continue
        u, v = ball[idx, 0], ball[idx, 1]
        # Spread across, robust to the odd stray detection beside the column.
        if np.subtract(*np.percentile(u, [90, 10])) >= col or np.ptp(v) <= col:
            continue
        keep = np.abs(u - np.median(u)) < col
        v = v[keep]
        # How tall 1.3 m stands on screen where this ball bounces.
        foot = cam.to_ground(np.array([[np.median(u), v.max()]]))[0]
        if not np.isfinite(foot).all() or abs(foot[1]) > 30:
            continue
        top = cam.project(np.array([[foot[0], foot[1], 1.3]]))[0]
        if not np.isfinite(top).all() or np.ptp(v) > 1.2 * (v.max() - top[1]):
            continue
        # Count direction reversals in v, ignoring wiggles under `amp` pixels.
        turns, ref, direction = 0, v[0], 0
        for y in v[1:]:
            d = y - ref
            if abs(d) < amp:
                continue
            sgn = 1 if d > 0 else -1
            if direction and sgn != direction:
                turns += 1
            direction, ref = sgn, y
        if turns >= 2:
            out[i : i + win] = True
    return out


def find(ball: np.ndarray, fps: float, cam: Camera, points: bool = False) -> list[tuple[float, float]]:
    """Stretches of play (default: tight, for fitting shots) or whole points
    (`points`: bridges short gaps and misread dribbles, for the serve and score)."""
    n = len(ball)
    have = np.isfinite(ball[:, 0])
    # Moving: displacement over 2 frames, scaled to a 1080p frame.
    scale = 1920 / cam.width
    step = np.full(n, np.nan)
    step[2:] = np.linalg.norm(ball[2:] - ball[:-2], axis=1) * scale / 2
    dead = dribbles(ball, fps, cam)
    moving = have & (np.nan_to_num(step) > 1.5) & ~dead
    win = max(1, int(fps))
    frac = np.convolve(moving.astype(float), np.ones(win) / win, mode="same")
    on = frac > 0.35
    # Runs of "on", then merge across short gaps.
    edges = np.flatnonzero(np.diff(np.r_[0, on.astype(int), 0]))
    runs = [[a, b] for a, b in zip(edges[::2], edges[1::2])]
    merged: list[list[int]] = []
    for a, b in runs:
        # For points, dribbles may be bridged: checked against a hand-tagged
        # match, 28 of them fired inside real points, and refusing to bridge
        # split 17 of 32 points in pieces (bridging gaps under 4 s split 1, and
        # merged 5 pairs). For fitting, the tight stretches fit much better
        # (hit recall 44% against 21%), so there a dribble still ends one.
        gap = a - merged[-1][1] if merged else None
        if merged and (gap < POINT_MERGE_S * fps if points else (gap < MERGE_S * fps and not dead[merged[-1][1] : a].any())):
            merged[-1][1] = b
        else:
            merged.append([a, b])
    side = np.where(have, np.sign(ball[:, 1] - _net_row(cam, np.nan_to_num(ball[:, 0]))), 0)
    out = []
    for a, b in merged:
        if (b - a) < MIN_S * fps:
            continue
        s = side[a:b][side[a:b] != 0]
        crossings = int((np.diff(s) != 0).sum()) if len(s) > 1 else 0
        if crossings < 1:
            continue
        out.append((max(0.0, a / fps - PAD_S), min(n / fps, b / fps + PAD_S)))
    return out
