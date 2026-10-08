"""Phase 2, second half: the ball in 3D.

One camera sees only a direction to the ball, not how far away it is. Physics
supplies the rest, in three steps (the MonoTrack / TT3D approach, see
docs/3D_REPLAY.md §3.3):

1. Split. The 2D track is cut into the fewest pieces that are each one airborne
   flight. Candidate cut points are sharp turns and tracking gaps (the ball is
   often lost for a few frames at the racket); dynamic programming keeps the
   cuts that a single projectile can't fly through. A serve toss is one arc, so
   its peak is never a cut.
2. Label. A cut where the ball is on the court is a bounce; one where it is at a
   player's racket, at that player's depth (from the calibration), is a hit.
3. Fit. Each shot, hit to next hit, as one flight with gravity, air drag and a
   simulated bounce (so a bounce too gentle to show as a kink in the image is
   still found). The fit minimises the pixel distance between that flight,
   projected through the calibrated camera, and the ball in every frame, with
   the launch held near the hitter at racket height.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy.optimize import least_squares

from .camera import HALF_LENGTH, SINGLES, Camera

G = 9.81
# Quadratic drag, k = rho * Cd * A / (2 m) for a tennis ball (Cd ~0.55).
DRAG = 0.5 * 1.2 * 0.55 * np.pi * 0.0335**2 / 0.0577
GRAVITY = np.array([0.0, 0.0, -G])
SUBSTEPS = 4  # integration steps per video frame


@dataclass
class Shot:
    hitter: str  # "near" | "far"
    t0: float  # seconds from the start of the video
    t1: float
    p0: list[float]
    v0: list[float]
    samples: list[list[float]] = field(default_factory=list)  # t, x, y, z
    bounce: list[float] | None = None  # t, x, y
    speed_kmh: float = 0.0
    net_clearance_m: float | None = None
    rms_px: float = 0.0
    n_obs: int = 0
    landing: str | None = None  # "in" | "out" | "close" (singles court) | None
    doubtful: str | None = None  # why this shot's numbers shouldn't be trusted, if so


# How close to a line a bounce has to be before the fit can't call it. A bounce
# is placed to within a few pixels, and a pixel covers more court the further
# from the camera (about 1.4 cm at the near baseline here, 30 cm at the far
# service line), so the margin grows with distance. Inside it, a call would be
# a guess.
LINE_MARGIN_MIN = 0.15
LINE_MARGIN_PX = 2.5


def metres_per_pixel(cam: Camera, x: float, y: float) -> float:
    """Ground distance one pixel covers at (x, y), along the court."""
    a = cam.project(np.array([[x, y, 0.0], [x, y + 0.1, 0.0]]))
    return 0.1 / max(float(np.linalg.norm(a[1] - a[0])), 1e-6)


def call(cam: Camera, x: float, y: float) -> str:
    """In / out / close for a bounce, against the singles court."""
    margin = max(LINE_MARGIN_MIN, LINE_MARGIN_PX * metres_per_pixel(cam, x, y))
    inside = min(SINGLES - abs(x), HALF_LENGTH - abs(y))  # metres inside the nearest line
    if inside > margin:
        return "in"
    if inside < -margin:
        return "out"
    return "close"


# ---------------------------------------------------------------------------
# Flight model


def fly_bounce(
    p0: np.ndarray, v0: np.ndarray, n_frames: int, fps: float, e: float, mu: float
) -> tuple[np.ndarray, float | None]:
    """Like `fly`, but the court is solid: the ball bounces, keeping a fraction
    `e` of its vertical speed and `mu` of its horizontal speed. Returns the
    positions at each frame and the time (s) of the first bounce."""
    dt = 1.0 / (fps * SUBSTEPS)
    p, v = np.asarray(p0, float).copy(), np.asarray(v0, float).copy()
    out = np.empty((n_frames + 1, 3))
    out[0] = p
    t, bounce_t = 0.0, None
    for i in range(1, n_frames + 1):
        for _ in range(SUBSTEPS):
            a1 = GRAVITY - DRAG * np.linalg.norm(v) * v
            vm = v + a1 * dt / 2
            a2 = GRAVITY - DRAG * np.linalg.norm(vm) * vm
            p_new = p + vm * dt
            v = v + a2 * dt
            if p_new[2] < 0 and v[2] < 0:
                frac = p[2] / max(p[2] - p_new[2], 1e-9)
                p_new = p + (p_new - p) * frac
                p_new[2] = 0.0
                v = np.array([v[0] * mu, v[1] * mu, -v[2] * e])
                if bounce_t is None:
                    bounce_t = t + dt * frac
            p = p_new
            t += dt
        out[i] = p
    return out, bounce_t


def fit_shot(cam: Camera, f: np.ndarray, uv: np.ndarray, fps: float, hitter: dict | None, side: str):
    """One shot, hit to next hit: launch position and velocity, and the bounce's
    energy loss, fitted so the flight (with its bounce) projects onto the track."""
    f = f - f[0]
    n = int(f[-1])
    toward = 1.0 if side == "near" else -1.0  # +Y is away from the camera
    feet = np.array(hitter["feet"]) if hitter else None

    def residuals(x):
        path, _ = fly_bounce(x[:3], x[3:6], n, fps, x[6], x[7])
        r = np.nan_to_num((cam.project(path[f]) - uv).ravel(), nan=400.0)
        if feet is None:
            return r
        off = np.abs(x[:2] - feet)
        prior = np.concatenate([np.maximum(off - [1.0, 0.8], 0) * 60.0, [max(0.35 - x[2], 0.0, x[2] - 3.3) * 60.0]])
        return np.concatenate([r, prior])

    start = np.array([*feet, 1.1]) if feet is not None else cam.position + 12 * cam.ray(uv[:1])[0]
    lo = [-np.inf, -np.inf, 0.0, -70, -70, -40, 0.55, 0.45]
    hi = [np.inf, np.inf, 4.0, 70, 70, 40, 0.9, 0.95]
    best = None
    for speed in (16.0, 27.0):
        for elev in (0.02, 0.18):
            d = np.array([0.0, toward, elev])
            x0 = np.concatenate([start, speed * d / np.linalg.norm(d), [0.75, 0.7]])
            r = least_squares(residuals, x0, bounds=(lo, hi), loss="soft_l1", f_scale=5.0, max_nfev=120)
            if best is None or r.cost < best.cost:
                best = r
    return best.x


def _parabola_fit(cam: Camera, frames: np.ndarray, uv: np.ndarray, fps: float) -> tuple[float, np.ndarray | None]:
    """How well one drag-free flight explains these observations (robust px^2).

    Used only to decide where to cut, so the cheap closed form is enough. A few
    starting depths cover the near and the far half of the court.
    """
    t = (frames - frames[0]) / fps
    if len(t) < 4:
        return 0.0, None

    def res(x):
        p0, v0 = x[:3], x[3:]
        pos = p0 + np.outer(t, v0) + 0.5 * np.outer(t**2, GRAVITY)
        r = (cam.project(pos) - uv).ravel()
        return np.nan_to_num(r, nan=400.0)

    best, best_x = np.inf, None
    rays = cam.ray(uv[[0, -1]])
    c = cam.position
    T = max(t[-1], 1e-3)
    for d0 in (6.0, 14.0, 26.0):
        for d1 in (6.0, 14.0, 26.0):
            a, b = c + d0 * rays[0], c + d1 * rays[1]
            v0 = (b - a) / T - 0.5 * GRAVITY * T
            r = least_squares(res, np.concatenate([a, v0]), loss="soft_l1", f_scale=4.0, max_nfev=60)
            if 2 * r.cost < best:
                best, best_x = 2 * r.cost, r.x
    return best, best_x


# ---------------------------------------------------------------------------
# 1. Split


def _candidates(frames: np.ndarray, uv: np.ndarray, half: int = 6) -> list[int]:
    """Indices into `frames` where a flight might end: sharp turns and gaps."""
    idx = set()
    for i, f in enumerate(frames):
        before = (frames >= f - half) & (frames < f)
        after = (frames > f) & (frames <= f + half)
        if before.sum() >= 3 and after.sum() >= 3:
            a = np.array([np.polyfit(frames[before] - f, uv[before, k], 1)[0] for k in (0, 1)])
            b = np.array([np.polyfit(frames[after] - f, uv[after, k], 1)[0] for k in (0, 1)])
            if np.linalg.norm(a) > 1.0 and np.linalg.norm(b) > 1.0:
                cos = a @ b / (np.linalg.norm(a) * np.linalg.norm(b))
                if cos < np.cos(np.radians(20)):
                    idx.add(i)
        if i + 1 < len(frames) and frames[i + 1] - f > 3:
            idx.add(i)  # the ball was lost here; a hit often hides in the gap
    # Neighbouring candidates are one event; keep every other frame at most.
    out, last = [], -10
    for i in sorted(idx):
        if i - last >= 2:
            out.append(i)
            last = i
    return out


def split(
    cam: Camera, frames: np.ndarray, uv: np.ndarray, fps: float, penalty: float = 1500.0
) -> tuple[list[int], list[np.ndarray | None]]:
    """Cut indices (into `frames`) minimising total flight misfit + a cost per
    cut, and each resulting piece's drag-free flight (p0, v0)."""
    inner = [i for i in _candidates(frames, uv) if 3 <= i <= len(frames) - 4]
    cands = sorted(set([0] + inner + [len(frames) - 1]))
    n = len(cands)
    cache: dict[tuple[int, int], tuple[float, np.ndarray | None]] = {}

    def fit(a: int, b: int):
        if (a, b) not in cache:
            i, j = cands[a], cands[b]
            cache[(a, b)] = _parabola_fit(cam, frames[i : j + 1], uv[i : j + 1], fps)
        return cache[(a, b)]

    best = np.full(n, np.inf)
    prev = np.zeros(n, dtype=int)
    best[0] = 0.0
    for b in range(1, n):
        for a in range(b - 1, -1, -1):
            # A single flight longer than ~2.2 s doesn't happen in a rally.
            if (frames[cands[b]] - frames[cands[a]]) / fps > 2.2:
                break
            c = best[a] + fit(a, b)[0] + penalty
            if c < best[b]:
                best[b], prev[b] = c, a
    chain, b = [n - 1], n - 1
    while b > 0:
        b = prev[b]
        chain.append(b)
    chain.reverse()
    cuts = [cands[k] for k in chain]
    pieces = [fit(a, b)[1] for a, b in zip(chain[:-1], chain[1:])]
    return cuts, pieces


# ---------------------------------------------------------------------------
# 2. Label


def _nearby_players(players: dict[int, dict[str, dict]], f: int) -> dict[str, dict]:
    """Players around frame f; they drop out of single frames."""
    nearby: dict[str, dict] = {}
    for df in (0, -1, 1, -2, 2, -3, 3, -4, 4, -5, 5, -6, 6):
        for side, p in players.get(f + df, {}).items():
            nearby.setdefault(side, p)
    return nearby


def label_cuts(pieces: list[np.ndarray | None]) -> list[str]:
    """Hit or bounce at each cut, from how the ball moves along the court.

    A hit sends the ball back the way it came: its along-court velocity (+Y is
    away from the camera) reverses, and the player at the end it was heading for
    hit it. A bounce only flips the vertical motion. A serve toss barely moves
    along the court, so a toss followed by a fast flight away is a serve.
    The image alone can't make this call: a ball high over the near player's
    head and one at the far baseline share the same pixels.
    """
    def vy(p):
        return None if p is None else float(p[4])

    labels = ["start"]
    for a, b in zip(pieces[:-1], pieces[1:]):
        before, after = vy(a), vy(b)
        if before is None or after is None:
            labels.append("bounce")
        elif abs(before) < 3.0 and abs(after) > 5.0:
            labels.append("near" if after > 0 else "far")  # a serve out of the toss
        elif before * after < 0 and abs(before) > 2.0 and abs(after) > 2.0:
            labels.append("near" if before < 0 else "far")
        else:
            labels.append("bounce")
    labels.append("end")
    # The very first piece: a flight that starts heading away from an end began
    # with a hit there (a serve whose toss wasn't tracked).
    first = vy(pieces[0]) if pieces else None
    if first is not None and abs(first) > 5.0:
        labels[0] = "near" if first > 0 else "far"
    return labels


def reconstruct(
    cam: Camera,
    track: dict[int, tuple[float, float]],
    players_by_frame: dict[int, dict[str, dict]],
    fps: float,
    last_frame: int,
) -> list[Shot]:
    frames = np.array(sorted(track))
    if len(frames) < 10:
        return []
    uv = np.array([track[f] for f in frames])
    cuts, pieces = split(cam, frames, uv, fps)
    cut_frames = [int(frames[i]) for i in cuts]
    labels = label_cuts(pieces)

    # Shots run from one hit to the next. Each is fitted as one flight with its
    # bounce simulated, so a bounce too gentle to show as a kink is still found.
    hit_idx = [k for k, lab in enumerate(labels) if lab in ("near", "far")]
    shots: list[Shot] = []
    for h, k0 in enumerate(hit_idx):
        k1 = hit_idx[h + 1] if h + 1 < len(hit_idx) else len(labels) - 1
        a, b = cuts[k0], cuts[k1]
        if b - a < 6:
            continue
        side = labels[k0]
        hitter = _nearby_players(players_by_frame, cut_frames[k0]).get(side)
        x = fit_shot(cam, frames[a : b + 1], uv[a : b + 1], fps, hitter, side)
        n = int(frames[b] - frames[a])
        path, bounce_t = fly_bounce(x[:3], x[3:6], n, fps, x[6], x[7])
        fi = frames[a : b + 1] - frames[a]
        err = np.linalg.norm(cam.project(path[fi]) - uv[a : b + 1], axis=1)
        t0 = frames[a] / fps
        shot = Shot(
            hitter=side,
            t0=round(float(t0), 4),
            t1=round(float(frames[b] / fps), 4),
            p0=np.round(x[:3], 3).tolist(),
            v0=np.round(x[3:6], 3).tolist(),
            samples=[[round(float(t0 + j / fps), 4), *[round(float(c), 3) for c in q]] for j, q in enumerate(path)],
            speed_kmh=round(float(np.linalg.norm(x[3:6]) * 3.6), 1),
            rms_px=round(float(np.sqrt(np.mean(np.minimum(err, 60) ** 2))), 2),
            n_obs=int(len(err)),
        )
        if bounce_t is not None:
            j = min(int(round(bounce_t * fps)), len(path) - 1)
            bp = fly_bounce(x[:3], x[3:6], max(j, 1), fps, x[6], x[7])[0][-1]
            shot.bounce = [round(float(t0 + bounce_t), 4), round(float(bp[0]), 3), round(float(bp[1]), 3)]
            shot.landing = call(cam, bp[0], bp[1])
            # A shot can't bounce on its hitter's own side and play on; if the
            # fit says it did, the fit is wrong somewhere (or it was a net cord).
            own_side = (bp[1] < 0) == (side == "near")
            if own_side:
                shot.doubtful = "bounces on the hitter's own side"
        if shot.rms_px > 15:
            shot.doubtful = shot.doubtful or "loose fit to the ball track"
        ys = path[:, 1]
        cross = np.where(np.diff(np.sign(ys)) != 0)[0]
        if len(cross):
            i = cross[0]
            w = ys[i] / (ys[i] - ys[i + 1])
            shot.net_clearance_m = round(float(path[i, 2] + w * (path[i + 1, 2] - path[i, 2])), 2)
        shots.append(shot)
    # Keep only flights the fit can stand behind: a shot that misses its own
    # track by more than ~22 px, or leaves the racket faster than any rally
    # ball, is the fit failing (ball being bounced before a serve, dead ball
    # after the point), and showing it would be making it up.
    return [s for s in shots if s.rms_px <= 22 and s.speed_kmh <= 200]


def events(cam: Camera, track: dict[int, tuple[float, float]], players: dict[int, dict[str, dict]], fps: float):
    """(time, label) of each cut, for inspection."""
    frames = np.array(sorted(track))
    uv = np.array([track[f] for f in frames])
    cuts, pieces = split(cam, frames, uv, fps)
    labels = label_cuts(pieces)
    return [(round(int(frames[i]) / fps, 2), lab) for i, lab in zip(cuts, labels)], [None if p is None else np.round(p[3:], 1).tolist() for p in pieces]
