"""A match as a 3D scene for the app's 3D view: every rally's ball flights and
both players, on a court that wears the real court's surface.

    python -m ojo_replay.scene <match-id-prefix> [--out <dir>]

Built from what `analyze` and `structure` already cached in out/analysis/<id>/,
so it costs seconds, not another pass over the video:

- **Ball.** Each fitted shot's flight is simulated again from its fitted launch
  (position, velocity, bounce coefficients), the same physics as the fit, one
  point per video frame. The whole-match run keeps the launch, not the path.
- **Players.** Their feet on the court where they were detected (every
  `player-stride` frames), and, where VideoPose3D is installed, 3D skeletons
  lifted from the 2D keypoints and stood on the court through the calibration
  (`pose3d`). Without it the app draws a plain figure at the feet.
- **Court.** A clean plate of the recording (players and ball removed by a
  median) warped top-down through the calibration: the 3D court has the real
  court's colour, lines and wear.

Coordinates are court metres (x across, + to the camera's right; y along, +
away from the camera; z up), stored as integer centimetres. Times are seconds
from the start of the video, so the app drives the scene from the video's clock.
The shape is `MatchScene` in web/lib/matchScene.ts.
"""

from __future__ import annotations

import base64
import glob
import json
import sys
from pathlib import Path

import cv2
import numpy as np

from .ball3d import fly_bounce
from .camera import Camera

ROOT = Path(__file__).resolve().parents[1]
VERSION = 4  # 2: joints as int8 offsets from an int16 root; 3: surroundings; 4: players' boxes
# The fit's bounce coefficients, for shots fitted before they were kept.
BOUNCE_DEFAULT = (0.75, 0.7)
# Skeletons every this many frames (10 fps at 30): the 2D keypoints they come
# from are every 6th frame, so finer would only be interpolation.
SKELETON_STEP = 3
# Gaps in a player's detections bridged, in frames (about a second).
BRIDGE = 30
# The ground the texture covers, metres: the court plus run-off.
# The ground the texture covers, metres: the court and its run-off out to the
# fences. Across, a club court's usual 3.5 m beyond the doubles lines; along,
# out to the phone, which in every recording so far was on the back fence
# (17.2-19.7 m behind centre court).
TEX_X, TEX_RES = 9.0, 0.04  # half-width, metres per pixel
MIN_HALF_LENGTH = 17.0
PLATE_WIDTH = 1280  # the backdrop's resolution: the walls are seen from far off


def _cm(a) -> list[int]:
    return np.round(np.asarray(a, float) * 100).astype(int).ravel().tolist()


def flight(s: dict, fps: float) -> list[int]:
    """A shot's path, one point per frame from its hit to the next, in cm."""
    n = max(1, int(round((s["t1"] - s["t0"]) * fps)))
    e, mu = s.get("bounce_coef") or BOUNCE_DEFAULT
    path = fly_bounce(np.array(s["p0"]), np.array(s["v0"]), n, fps, e, mu)[0]
    return _cm(path)


def rally_players(out: Path, first: int, last: int) -> list[dict]:
    """Every player detection inside frames first..last, from the per-rally caches
    (windows can overlap after the rally finder changes; one per frame and end)."""
    seen: dict[tuple[int, str], dict] = {}
    for f in glob.glob(str(out / "rallies" / "*c4.players.json")):
        a, b = (int(v) for v in Path(f).name.split("-")[:2])
        if b < first or a > last:
            continue
        for p in json.loads(Path(f).read_text())["players"]:
            if first <= p["frame"] <= last:
                seen.setdefault((p["frame"], p["side"]), p)
    return sorted(seen.values(), key=lambda p: p["frame"])


def _lifter():
    """pose3d.skeletons if VideoPose3D (code and weights) is installed, else None."""
    from . import pose3d

    if not (pose3d.VENDOR.exists() and pose3d.WEIGHTS.exists()):
        return None
    return pose3d.skeletons


FEET = [3, 6]  # Human3.6M feet


def _on_feet(joints: np.ndarray, frames: np.ndarray, det_frames: np.ndarray, det_feet: np.ndarray) -> np.ndarray:
    """Stand each lifted skeleton where the player's feet were detected.

    pose3d places a skeleton along the camera ray through the hips, at the depth
    where its lowest foot meets the court. From behind a baseline that ray is
    shallow (at the far end it drops ~1 m in 10), so a few centimetres wrong in
    the lifted legs move the whole body a metre or more in depth (measured: up to
    1.7 m against the detected feet at the far baseline). The feet detected in
    the image don't carry that amplification, so they decide where the body
    stands; the lifted pose keeps its shape."""
    fx = np.interp(frames, det_frames, det_feet[:, 0])
    fy = np.interp(frames, det_frames, det_feet[:, 1])
    shift = np.column_stack([fx, fy]) - joints[:, FEET, :2].mean(axis=1)
    out = joints.copy()
    out[:, :, :2] += shift[:, None, :]
    return out


def _steady(joints: np.ndarray, frames: np.ndarray) -> np.ndarray:
    """Calm the skeleton's placement: the feet it stands on are detected every
    few frames with a pixel or two of jitter, which at the far end is tens of
    centimetres, so the whole body would shiver back and forth. The body's shape
    is kept; its position is median-filtered then averaged over ~1/3 s, run by run."""
    root = joints[:, 0, :2].copy()
    runs = np.split(np.arange(len(frames)), np.flatnonzero(np.diff(frames) > 1) + 1)
    for r in runs:
        if len(r) < 5:
            continue
        p = root[r]
        med = np.array([np.median(p[max(0, i - 4) : i + 5], axis=0) for i in range(len(p))])
        k = 5
        root[r] = np.array([med[max(0, i - k) : i + k + 1].mean(axis=0) for i in range(len(med))])
    out = joints.copy()
    out[:, :, :2] += (root - joints[:, 0, :2])[:, None, :]
    return out


def players_3d(cam: Camera, players: list[dict], first: int, last: int, lift) -> dict:
    out: dict[str, dict] = {}
    for side in ("near", "far"):
        ps = [p for p in players if p["side"] == side]
        if not ps:
            continue
        d = {"f": [p["frame"] for p in ps], "feet": _cm([p["feet"] for p in ps]),
             # Where they were in the picture (x1, y1, x2, y2 pixels): the 3D
             # view cuts the real player out of the video there.
             "box": np.round(np.array([p["box"] for p in ps], float)).astype(int).ravel().tolist()}
        if lift and len(ps) >= 10:
            # Bridge detection gaps up to a second (mostly the swing itself,
            # where the pose model loses the player): a body that blinks out
            # mid-stroke is worse than one interpolated across it.
            sk = lift(cam, ps, first, last, reach=BRIDGE // 2).get(side)
            if sk:
                frames = np.array(sk["frames"])
                keep = frames % SKELETON_STEP == 0
                det = np.array([p["frame"] for p in ps]), np.array([p["feet"] for p in ps], float)
                joints = _on_feet(np.array(sk["joints"]), frames, *det)
                cm = np.round(_steady(joints, frames)[keep] * 100)
                # The hips in int16 cm, every joint as an int8 cm offset from
                # them (a body is within 1.27 m of its hips): about half the
                # size of int16 throughout, and skeletons are most of a scene.
                root = np.clip(cm[:, 0], -32767, 32767).astype("<i2")
                rel = np.clip(cm - cm[:, :1], -127, 127).astype("i1")
                d["skeleton"] = {"f": frames[keep].tolist(),
                                 "root": base64.b64encode(root.tobytes()).decode(),
                                 "joints": base64.b64encode(rel.tobytes()).decode()}
        out[side] = d
    return out


def court_texture(cam: Camera, plate: np.ndarray, half_length: float) -> str:
    """The plate warped top-down over the court and run-off, as a JPEG data URL.
    Row 0 is the far end (+y), column 0 the left (-x). Ground the camera didn't
    see takes the surface's median colour.

    Only the near half is the camera's: the far half is seen through the net,
    whose tape, posts and the fence behind smear across it once warped flat. A
    court is the same mirrored across the net, so the far half is the near half
    mirrored: what's beside the court stays on its own side."""
    w, h = int(2 * TEX_X / TEX_RES), int(half_length / TEX_RES)
    xs = -TEX_X + (np.arange(w) + 0.5) * TEX_RES
    ys = -(np.arange(h) + 0.5) * TEX_RES
    gx, gy = np.meshgrid(xs, ys)
    pts = np.column_stack([gx.ravel(), gy.ravel(), np.zeros(gx.size)])
    uv = cam.project(pts).reshape(h, w, 2).astype(np.float32)
    seen = np.isfinite(uv).all(axis=2) & (uv[..., 0] >= 0) & (uv[..., 0] < plate.shape[1] - 1) \
        & (uv[..., 1] >= 0) & (uv[..., 1] < plate.shape[0] - 1)
    uv[~seen] = -1
    img =cv2.remap(plate, uv[..., 0], uv[..., 1], cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
    # The surface's colour from inside the near court, which is only surface
    # (around it are bushes, benches and fences).
    inner = seen & (np.abs(gx) < 4.0) & (gy > -11.0) & (gy < -1.0)
    fill = np.median(img[inner if inner.any() else seen], axis=0).astype(np.uint8)
    img[~seen] = fill
    # Soften the edge of what the camera saw into the fill colour.
    mask = cv2.GaussianBlur(seen.astype(np.float32), (0, 0), 6)[..., None]
    img = (img * mask + fill * (1 - mask)).astype(np.uint8)
    img = np.vstack([img[::-1], img])
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 78])
    return "data:image/jpeg;base64," + base64.b64encode(buf.tobytes()).decode()


def surroundings(plate: np.ndarray, half_length: float) -> dict:
    """What the 3D view needs to wrap the court in the recording's own
    surroundings: the plate (fences, trees, buildings, sky), which the viewer
    projects back through the calibrated phone onto walls standing at the
    fences, and the sky's colour for above them."""
    h, w = plate.shape[:2]
    small = cv2.resize(plate, (PLATE_WIDTH, round(h * PLATE_WIDTH / w)), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", small, [cv2.IMWRITE_JPEG_QUALITY, 80])
    sky = np.median(plate[: max(1, h // 12)].reshape(-1, 3), axis=0)[::-1]  # BGR -> RGB
    return {
        "plate": "data:image/jpeg;base64," + base64.b64encode(buf.tobytes()).decode(),
        "halfWidth": TEX_X,
        "halfLength": half_length,
        "sky": [int(c) for c in sky],
    }


def plate_for(short: str, cal: dict) -> np.ndarray | None:
    """A clean plate of the recording: autocal's, else a median of frames from it."""
    from . import autocal

    cached = ROOT / ".cache" / "plates" / f"{short}.png"
    if cached.exists():
        return cv2.imread(str(cached))
    video = ROOT / ".cache" / "videos" / f"{short}.mov"
    if not video.exists():
        return None
    frames = autocal.read_window(str(video), float(cal.get("frameS", 60.0)), 20.0, n=9)
    return autocal.clean_plate(frames) if len(frames) >= 3 else None


def build_scene(prefix: str) -> tuple[str, dict]:
    meta = json.loads(next((ROOT / ".cache" / "matches").glob(prefix + "*.json")).read_text())
    short = meta["id"][:8]
    out = ROOT / "out" / "analysis" / short
    a = json.loads((out / "analysis.json").read_text())
    st = json.loads((out / "structure.json").read_text()) if (out / "structure.json").exists() else None
    cal = json.loads((out / "calibration.json").read_text())
    cam = Camera.from_calibration(cal)
    fps = a["fps"]
    near_of: dict[int, str] = {}
    for p in (st or {}).get("points", []):
        for idx in p.get("rallies") or [p["rally"]]:
            near_of[idx] = p.get("nearPlayer") or ""
    lift = _lifter()

    rallies = []
    for r in a["rallies"]:
        first, last = int(r["startS"] * fps), int(r["endS"] * fps)
        near = near_of.get(r["idx"], "")
        far = {"A": "B", "B": "A"}.get(near, "")
        shots = [{
            "hitter": s["hitter"],
            "t0": s["t0"], "t1": s["t1"],
            "speed": round(s["speed_kmh"]),
            "landing": s.get("landing"),
            "bounce": s.get("bounce"),
            "net": s.get("net_clearance_m"),
            "doubt": s.get("doubtful"),
            "path": flight(s, fps),
        } for s in r["shots"]]
        rallies.append({
            "idx": r["idx"], "start": r["startS"], "end": r["endS"],
            "who": {"near": near, "far": far},
            "shots": shots,
            "players": players_3d(cam, rally_players(out, first, last), first, last, lift),
        })
        print(f"[scene {short}] rally {r['idx']}: {len(shots)} shots, "
              f"{ {k: len(v['f']) for k, v in rallies[-1]['players'].items()} } detections", flush=True)

    plate = plate_for(short, cal)
    half_length = round(max(MIN_HALF_LENGTH, -float(cam.position[1])), 2)
    c = cal["camera"]
    scene = {
        "version": VERSION,
        "fps": fps,
        "camera": {"position": np.round(cam.position, 3).tolist(), "rotation": np.ravel(c["rotation"]).tolist(),
                   "f": c["f"], "cx": c["cx"], "cy": c["cy"], "width": cal["imageWidth"], "height": cal["imageHeight"]},
        "court": None if plate is None else {
            "texture": court_texture(cam, plate, half_length), "halfWidth": TEX_X, "halfLength": half_length},
        "surroundings": None if plate is None else surroundings(plate, half_length),
        "body": "videopose3d" if lift else None,
        "rallies": rallies,
    }
    return meta["id"], scene


def main(prefix: str, *flags: str) -> None:
    video_id, scene = build_scene(prefix)
    body = json.dumps(scene, separators=(",", ":"))
    print(f"{video_id}: {len(scene['rallies'])} rallies, {len(body) / 1e6:.2f} MB")
    if "--out" in flags:
        d = Path(flags[flags.index("--out") + 1])
        d.mkdir(parents=True, exist_ok=True)
        (d / f"{video_id}.scene.json").write_text(body)
        print("wrote", d / f"{video_id}.scene.json")


if __name__ == "__main__":
    main(*sys.argv[1:])
