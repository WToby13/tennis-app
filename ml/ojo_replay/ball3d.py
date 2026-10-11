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

from .camera import HALF_LENGTH, NET_CENTRE, POST, POST_HEIGHT, SINGLES, Camera

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
    landing: str | None = None  # "in" | "out" | "close" (singles court), "net", or None
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


def net_height(x: float) -> float:
    """Top of the net at x: 0.914 m at the centre strap, 1.07 m at the posts."""
    return NET_CENTRE + (POST_HEIGHT - NET_CENTRE) * min(abs(x), POST) / POST


def fly_bounce(
    p0: np.ndarray, v0: np.ndarray, n_frames: int, fps: float, e: float, mu: float
) -> tuple[np.ndarray, float | None, float | None, np.ndarray | None]:
    """A flight with gravity and drag over a solid court and a real net.

    The ball bounces off the court keeping a fraction `e` of its vertical speed
    and `mu` of its horizontal speed. If it meets the net below the tape it
    stops there and drops. Returns the positions at each frame, the times (s)
    of the first bounce and of hitting the net, and where it first bounced
    (None where they didn't happen).

    Plain floats rather than 3-element arrays: this runs tens of thousands of
    times per rally inside the fit, and numpy's per-call overhead on tiny
    arrays was most of its cost."""
    dt = 1.0 / (fps * SUBSTEPS)
    px, py, pz = (float(c) for c in p0)
    vx, vy, vz = (float(c) for c in v0)
    k, g = DRAG, G
    out = np.empty((n_frames + 1, 3))
    out[0] = (px, py, pz)
    t, bounce_t, net_t, bounce_p = 0.0, None, None, None
    for i in range(1, n_frames + 1):
        for _ in range(SUBSTEPS):
            s1 = k * (vx * vx + vy * vy + vz * vz) ** 0.5
            mx = vx + (-s1 * vx) * dt / 2
            my = vy + (-s1 * vy) * dt / 2
            mz = vz + (-g - s1 * vz) * dt / 2
            s2 = k * (mx * mx + my * my + mz * mz) ** 0.5
            nx, ny, nz = px + mx * dt, py + my * dt, pz + mz * dt
            vx, vy, vz = vx - s2 * mx * dt, vy - s2 * my * dt, vz + (-g - s2 * mz) * dt
            if net_t is None and py * ny < 0:
                w = py / (py - ny)
                cx, cz = px + (nx - px) * w, pz + (nz - pz) * w
                if abs(cx) <= POST and 0 <= cz < net_height(cx):
                    # Into the net: it stops on the hitter's side and drops.
                    net_t = t + dt * w
                    nx, ny, nz = cx, 0.05 * (1.0 if py > 0 else -1.0), cz
                    vx, vy, vz = 0.0, 0.0, min(vz, 0.0)
            if nz < 0 and vz < 0:
                frac = pz / max(pz - nz, 1e-9)
                nx, ny, nz = px + (nx - px) * frac, py + (ny - py) * frac, 0.0
                vx, vy, vz = vx * mu, vy * mu, -vz * e
                if net_t is not None:
                    vx = vy = vz = 0.0  # a ball dropped from the net doesn't rally on
                if bounce_t is None:
                    bounce_t, bounce_p = t + dt * frac, np.array([nx, ny, nz])
            px, py, pz = nx, ny, nz
            t += dt
        out[i] = (px, py, pz)
    return out, bounce_t, net_t, bounce_p


def fit_shot(
    cam: Camera,
    f: np.ndarray,
    uv: np.ndarray,
    fps: float,
    hitter: dict | None,
    side: str,
    bounce_hint: float | None = None,
):
    """One shot, hit to next hit: launch position and velocity, and the bounce's
    energy loss, fitted so the flight (with its bounce) projects onto the track.

    Left free, the fit finds flights that bounce at the hitter's feet or never
    bounce at all. Two things it knows rule those out: when the track was cut
    with a bounce between the hits (`bounce_hint`, seconds after the hit), the
    simulated bounce is pulled to that moment; and a shot can't bounce on its
    own side of the net except right at the net (a net ball).
    """
    f = f - f[0]
    n = int(f[-1])
    toward = 1.0 if side == "near" else -1.0  # +Y is away from the camera
    feet = np.array(hitter["feet"]) if hitter else None

    def residuals(x):
        path, bounce_t, _, bounce_p = fly_bounce(x[:3], x[3:6], n, fps, x[6], x[7])
        r = [np.nan_to_num((cam.project(path[f]) - uv).ravel(), nan=400.0)]
        if feet is not None:
            off = np.abs(x[:2] - feet)
            r.append(np.maximum(off - [1.0, 0.8], 0) * 60.0)  # an arm and a racket away
            r.append([max(0.35 - x[2], 0.0, x[2] - 3.3) * 60.0])  # racket height
        if bounce_hint is not None:
            # Seconds off the labelled bounce, at ~3 px per frame; no bounce at
            # all costs as much as being half a second out.
            r.append([abs((bounce_t if bounce_t is not None else bounce_hint + 0.5) - bounce_hint) * fps * 3.0])
        own = bounce_p is not None and (bounce_p[1] < 0) == (side == "near")
        r.append([max(abs(bounce_p[1]) - 1.5, 0.0) * 40.0 if own else 0.0])  # own side, away from the net
        return np.concatenate([np.ravel(np.asarray(v, float)) for v in r])

    if feet is not None:
        start = np.array([*feet, 1.1])
    else:
        # No hitter detected: start along the first sight-line, at racket height.
        start = cam.position + 12 * cam.ray(uv[:1])[0]
        start[2] = float(np.clip(start[2], 0.3, 3.0))
    lo = [-np.inf, -np.inf, 0.0, -70, -70, -40, 0.55, 0.45]
    hi = [np.inf, np.inf, 4.0, 70, 70, 40, 0.9, 0.95]
    best = None
    for speed in (12.0, 20.0, 28.0):
        for elev in (0.02, 0.15, 0.3):
            d = np.array([0.0, toward, elev])
            x0 = np.concatenate([start, speed * d / np.linalg.norm(d), [0.75, 0.7]])
            r = least_squares(residuals, x0, bounds=(lo, hi), loss="soft_l1", f_scale=5.0, max_nfev=120)
            if best is None or r.cost < best.cost:
                best = r
    return best.x


PIECE_LO = np.array([-12.0, -22.0, 0.0, -70.0, -70.0, -40.0])
PIECE_HI = np.array([12.0, 22.0, 4.5, 70.0, 70.0, 40.0])


def _linear_flight(cam: Camera, t: np.ndarray, uv: np.ndarray) -> np.ndarray | None:
    """Least-squares (p0, v0) of a drag-free flight, from the linearised
    projection equations. None if the system is degenerate."""
    f, cx, cy = cam.K[0, 0], cam.K[0, 2], cam.K[1, 2]
    R, tc = cam.R, cam.t
    rows, rhs = [], []
    for ti, (u, v) in zip(t, uv):
        A = np.hstack([R, R * ti])  # camera coords = A @ [p0, v0] + b
        b = R @ (0.5 * GRAVITY * ti**2) + tc
        for k, w in ((0, u - cx), (1, v - cy)):
            row = w * A[2] - f * A[k]
            rows.append(row)
            rhs.append(f * b[k] - w * b[2])
    A = np.array(rows)
    # Scale rows so far points (large depth) don't dominate.
    sol, _, rank, _ = np.linalg.lstsq(A, np.array(rhs), rcond=None)
    return sol if rank == 6 else None


def _parabola_fit(cam: Camera, frames: np.ndarray, uv: np.ndarray, fps: float) -> tuple[float, np.ndarray | None]:
    """How well one drag-free flight explains these observations (robust px^2).

    Used only to decide where to cut, so the cheap closed form is enough. A few
    starting depths cover the near and the far half of the court.
    """
    t = (frames - frames[0]) / fps
    if len(t) < 4:
        return 0.0, None

    f, pp = cam.K[0, 0], cam.K[:2, 2]
    R = cam.R
    g_cam = (0.5 * np.outer(t**2, GRAVITY)) @ R.T + cam.t  # gravity + offset, camera frame
    tt = t[:, None]

    def cam_pts(x):
        return x[:3] @ R.T + tt * (x[3:] @ R.T) + g_cam  # N x 3

    def res(x):
        P = cam_pts(x)
        z = np.where(P[:, 2] > 1e-3, P[:, 2], np.nan)
        r = (P[:, :2] / z[:, None] * f + pp - uv).ravel()
        return np.nan_to_num(r, nan=400.0)

    def jac(x):
        # d(pixel)/d(p0, v0): the camera point moves by R dp0 + t R dv0.
        P = cam_pts(x)
        z = np.maximum(P[:, 2], 1e-3)
        J = np.empty((len(t), 2, 6))
        for k in (0, 1):
            dP = R[k][None, :] / z[:, None] - (P[:, k] / z**2)[:, None] * R[2][None, :]  # N x 3
            J[:, k, :3] = f * dP
            J[:, k, 3:] = f * dP * tt
        return J.reshape(-1, 6)

    best, best_x = np.inf, None
    rays = cam.ray(uv[[0, -1]])
    c = cam.position
    T = max(t[-1], 1e-3)
    # Seed from the linear solution: with gravity known and no drag, the
    # pinhole equations (u - cx) Zc = f Xc, (v - cy) Zc = f Yc are linear in the
    # launch point and velocity. When that refines to a good fit it is the fit;
    # otherwise three more starts (the ball near, mid-court, far) settle it.
    # Measured on a checked rally: no good flight lost against nine starts.
    seed = _linear_flight(cam, t, uv)
    if seed is not None:
        r = least_squares(res, seed, jac=jac, loss="soft_l1", f_scale=4.0, max_nfev=60)
        best, best_x = 2 * r.cost, r.x
    if best_x is None or best > 16.0 * len(t):
        for d in (6.0, 14.0, 26.0):
            a, b = c + d * rays[0], c + d * rays[1]
            v0 = (b - a) / T - 0.5 * GRAVITY * T
            r = least_squares(res, np.concatenate([a, v0]), jac=jac, loss="soft_l1", f_scale=4.0, max_nfev=60)
            if 2 * r.cost < best:
                best, best_x = 2 * r.cost, r.x
    if best_x is not None and not np.all((best_x >= PIECE_LO) & (best_x <= PIECE_HI)):
        # A short or noisy piece can "fit" from kilometres away at absurd speed.
        # Refit it on or near the court, at a speed a racket can produce. Only
        # then: bounding every piece flips the direction of some short, sound ones.
        best, best_x = np.inf, None
        for d0 in (6.0, 14.0, 26.0):
            for d1 in (6.0, 14.0, 26.0):
                a, b = c + d0 * rays[0], c + d1 * rays[1]
                v0 = (b - a) / T - 0.5 * GRAVITY * T
                x0 = np.clip(np.concatenate([a, v0]), PIECE_LO + 1e-6, PIECE_HI - 1e-6)
                r = least_squares(res, x0, jac=jac, bounds=(PIECE_LO, PIECE_HI), loss="soft_l1", f_scale=4.0, max_nfev=60)
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


def _at_racket(uv: np.ndarray, player: dict | None, slack: float = 15.0) -> bool:
    """Whether the ball's pixel is within racket reach of a player.

    Reach is scaled by the player's height in the image (a person is ~1.75 m):
    arm plus racket reaches ~1.7 m to the side and a serve ~1 m above the head.
    Box width is no guide: a side-on far player is 16 px wide. `slack` covers
    the far player's coarse box and a contact a frame or two from the cut."""
    if player is None:
        return False
    x1, y1, x2, y2 = player["box"]
    h = y2 - y1
    u, v = uv
    cx = (x1 + x2) / 2
    return abs(u - cx) <= 0.97 * h + slack and y1 - 0.6 * h - slack <= v <= y2 + slack


def apply_rules(labels: list[str], cut_uv: list[np.ndarray], cut_frames: list[int], players) -> list[str]:
    """Correct the physics labels with the rules of a rally.

    Short pieces give unreliable along-court directions, so a bounce and the
    hit right after it can swap. Tennis settles it: hits alternate ends, the
    ball bounces at most once between them, and a hit needs the ball at the
    hitter. A "hit" where the ball isn't at that player is a bounce; a second
    bounce before the other player has hit is their hit, if the ball is at them.
    """
    out = list(labels)
    last_hitter, bounces = None, 0
    for k in range(len(out)):
        lab = out[k]
        if lab in ("start", "end"):
            continue
        near = _nearby_players(players, cut_frames[k])
        if lab in ("near", "far"):
            # A player who wasn't detected around the cut is no evidence either
            # way (the far player is ~40 px and sometimes missed): then the
            # physics label stands.
            hitter = near.get(lab)
            if lab == last_hitter or (hitter is not None and not _at_racket(cut_uv[k], hitter)):
                lab = "bounce"
        if lab == "bounce" and last_hitter is not None and bounces >= 1:
            other = "far" if last_hitter == "near" else "near"
            # Unless the physics already puts that player's hit at the next cut:
            # then this "bounce" is a spurious mid-flight cut, not a missed hit.
            nxt = next((labels[j] for j in range(k + 1, len(labels)) if labels[j] != "bounce"), None)
            if nxt != other and _at_racket(cut_uv[k], near.get(other)):
                lab = other
        out[k] = lab
        if lab in ("near", "far"):
            last_hitter, bounces = lab, 0
        else:
            bounces += 1
    return out


def _trim_dead_ball(frames: np.ndarray, uv: np.ndarray, still_px: float = 2.0, run: int = 6):
    """Drop the stretches at the start and end where the ball isn't in play: in
    a hand or pocket before the serve, lying by the net after the point. A ball
    that moves under `still_px` a frame for `run` frames is out of play there."""
    step = np.r_[np.inf, np.linalg.norm(np.diff(uv, axis=0), axis=1) / np.maximum(np.diff(frames), 1)]
    moving = step >= still_px
    first, last = 0, len(frames) - 1
    while last > run and not moving[last - run + 1 : last + 1].any():
        last -= 1
    while first < last - run and not moving[first + 1 : first + run + 1].any():
        first += 1
    return frames[first : last + 1], uv[first : last + 1]


def _trim_dribble(frames: np.ndarray, uv: np.ndarray, window: int = 18, column_px: float = 25.0):
    """Drop a server's ball-bouncing at the start: the ball goes up and down in
    a narrow column for a second or more. A serve's toss is in a column too,
    but brief, and the serve itself leaves it at once, so a window that stays
    in a column for most of a second (`window` frames) is still the dribble."""
    first = 0
    while first < len(frames) - 10:
        w = (frames >= frames[first]) & (frames < frames[first] + window)
        if w.sum() < 6:
            break
        u, v = uv[w, 0], uv[w, 1]
        if np.ptp(u) < column_px and np.ptp(v) > column_px:
            first += 1
            continue
        break
    return frames[first:], uv[first:]


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
    frames, uv = _trim_dead_ball(frames, uv)
    frames, uv = _trim_dribble(frames, uv)
    if len(frames) < 10:
        return []
    cuts, pieces = split(cam, frames, uv, fps)
    cut_frames = [int(frames[i]) for i in cuts]
    labels = apply_rules(label_cuts(pieces), [uv[i] for i in cuts], cut_frames, players_by_frame)

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
        bounce_frame = next((cut_frames[k] for k in range(k0 + 1, k1) if labels[k] == "bounce"), None)
        # The cut that marks a hit often lands a few frames before contact (the
        # ball is lost at the racket), and those frames are the incoming ball.
        # Try starting the flight a little later and keep the best fit.
        best = None
        for delay in (0, 3, 6, 9):
            a2 = int(np.searchsorted(frames, frames[a] + delay))
            if b - a2 < 8:
                break
            hint = (bounce_frame - frames[a2]) / fps if bounce_frame and bounce_frame > frames[a2] else None
            x = fit_shot(cam, frames[a2 : b + 1], uv[a2 : b + 1], fps, hitter, side, hint)
            path, bounce_t, net_t, _ = fly_bounce(x[:3], x[3:6], int(frames[b] - frames[a2]), fps, x[6], x[7])
            err = np.linalg.norm(cam.project(path[frames[a2 : b + 1] - frames[a2]]) - uv[a2 : b + 1], axis=1)
            score = float(np.sqrt(np.mean(np.minimum(err, 60) ** 2)))
            if best is None or score < best[0] - 0.5:  # later only if clearly better
                best = (score, a2, x, path, bounce_t, net_t, err)
        if best is None:
            continue
        _, a, x, path, bounce_t, net_t, err = best
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
        if net_t is not None and (bounce_t is None or net_t < bounce_t):
            shot.landing = "net"
        elif bounce_t is not None:
            j = min(int(round(bounce_t * fps)), len(path) - 1)
            bp = fly_bounce(x[:3], x[3:6], max(j, 1), fps, x[6], x[7])[0][-1]
            shot.bounce = [round(float(t0 + bounce_t), 4), round(float(bp[0]), 3), round(float(bp[1]), 3)]
            shot.landing = call(cam, bp[0], bp[1])
            # A shot can't bounce on its hitter's own side and play on; if the
            # fit says it did, the fit is wrong somewhere (or it was a net cord).
            own_side = (bp[1] < 0) == (side == "near")
            if own_side and abs(bp[1]) < 1.5:
                # First contact on its own side, right at the net: the ball went
                # into the net and dropped. No other flight lands there.
                shot.landing, shot.bounce = "net", None
            elif own_side:
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
        if shot.landing == "net":
            break  # the point is over; anything after is the ball being fetched
    # Keep only flights the fit can stand behind: a shot that misses its own
    # track by more than ~22 px, or leaves the racket faster than any rally
    # ball, is the fit failing (ball being bounced before a serve, dead ball
    # after the point), and showing it would be making it up.
    global last_unfiltered
    last_unfiltered = shots  # for diagnosing what the filter drops
    return [s for s in shots if s.rms_px <= 22 and s.speed_kmh <= 200]


def events(cam: Camera, track: dict[int, tuple[float, float]], players: dict[int, dict[str, dict]], fps: float):
    """(time, label) of each cut, for inspection."""
    frames = np.array(sorted(track))
    uv = np.array([track[f] for f in frames])
    frames, uv = _trim_dead_ball(frames, uv)
    cuts, pieces = split(cam, frames, uv, fps)
    labels = apply_rules(label_cuts(pieces), [uv[i] for i in cuts], [int(frames[i]) for i in cuts], players)
    return [(round(int(frames[i]) / fps, 2), lab) for i, lab in zip(cuts, labels)], [None if p is None else np.round(p[3:], 1).tolist() for p in pieces]
