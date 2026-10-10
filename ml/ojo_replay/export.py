"""Bundle a match's reconstruction into the 3D replay page.

    python -m ojo_replay.export .cache/short-test/match.json out/short-test

Reads rally{n}.json (from reconstruct) and lifts the players to 3D skeletons,
then writes out/<match>/replay.html: viewer/replay.html with the data inlined.
"""

from __future__ import annotations

import base64
import json
import sys
from pathlib import Path

import numpy as np

from .camera import Camera
from .pose3d import skeletons

ROOT = Path(__file__).resolve().parents[1]


def _smooth(x: np.ndarray, k: int) -> np.ndarray:
    pad = np.pad(x, ((k // 2, k // 2), (0, 0)), mode="edge")
    kern = np.ones(k) / k
    return np.column_stack([np.convolve(pad[:, i], kern, mode="valid") for i in range(x.shape[1])])


def movement(sk: dict | None, fps: float) -> dict:
    """Distance run and top speed from the hips' path over the court.

    The placed skeleton jitters most along the camera's line of sight (depth is
    the least certain direction), and summing jitter reads as running. So the
    path is median-filtered, then averaged over half a second, and top speed is
    taken over half-second windows.
    """
    if not sk or len(sk["frames"]) < 20:
        return {"distance": None, "topSpeed": None}
    frames = np.array(sk["frames"])
    hips = np.array(sk["joints"])[:, 0, :2]
    runs = np.split(np.arange(len(frames)), np.where(np.diff(frames) > 1)[0] + 1)
    dist, top = 0.0, 0.0
    half = int(fps * 0.5)
    for r in runs:
        if len(r) < 2 * half:
            continue
        p = hips[r]
        med = np.array([np.median(p[max(0, i - 3) : i + 4], axis=0) for i in range(len(p))])
        sm = _smooth(med, half | 1)
        step = np.linalg.norm(np.diff(sm, axis=0), axis=1)
        dist += float(step.sum())
        disp = np.linalg.norm(sm[half:] - sm[:-half], axis=1) / 0.5
        top = max(top, float(disp.max()))
    return {"distance": round(dist, 1), "topSpeed": round(top, 1)}


def bodies(path: Path) -> dict:
    """SAM 3D Body meshes for the page: per side, frame numbers, faces, and
    vertices as base64 little-endian int16 millimetres (decoded in the page)."""
    if not path.exists():
        return {}
    z = np.load(path)
    out = {}
    for side in ("near", "far"):
        if f"{side}_frames" not in z:
            continue
        v = z[f"{side}_verts_mm"].astype("<i2")
        out[side] = {
            "frames": z[f"{side}_frames"].tolist(),
            "faces": z[f"{side}_faces"].ravel().tolist(),
            "nverts": int(v.shape[1]),
            "verts": base64.b64encode(v.tobytes()).decode(),
        }
    return out


def main(match_json: str, out_dir: str) -> None:
    match = json.loads(Path(match_json).read_text())
    cam = Camera.from_match(Path(match_json))
    out = Path(out_dir)
    cal = match["calibration"]
    rallies = []
    for seg in match["segments"]:
        r = json.loads((out / f"rally{seg['idx']}.json").read_text())
        raw = json.loads((out / f"rally{seg['idx']}_2d.json").read_text())
        fps = r["fps"]
        sk = skeletons(cam, r["players"], raw["firstFrame"], raw["lastFrame"])
        shots = r["shots"]
        nets = [s["net_clearance_m"] for s in shots if s.get("net_clearance_m") is not None and s["net_clearance_m"] > 0]
        rallies.append({
            "idx": seg["idx"],
            "fps": fps,
            "start": raw["firstFrame"] / fps,
            "end": raw["lastFrame"] / fps,
            "shots": shots,
            "skeletons": sk,
            "bodies": bodies(out / f"rally{seg['idx']}_bodies.npz"),
            "stats": {
                "duration": (seg["endS"] - seg["startS"]),
                "shots": len(shots),
                "fastest": max((s["speed_kmh"] for s in shots), default=None),
                "lowestNet": min(nets) if nets else None,
                "near": movement(sk.get("near"), fps),
                "far": movement(sk.get("far"), fps),
            },
        })
        print(f"rally {seg['idx']}: {len(shots)} shots, skeleton frames { {k: len(v['frames']) for k, v in sk.items()} }, stats {rallies[-1]['stats']}")

    data = {
        "title": f"{match['title']} in 3D",
        "subtitle": f"{len(rallies)} rallies rebuilt from one phone · camera {cal['camera']['position'][2]:.1f} m up, "
        f"{-11.885 - cal['camera']['position'][1]:.1f} m behind the baseline",
        "camera": {
            "position": cal["camera"]["position"],
            "rotation": cal["camera"]["rotation"],
            "f": cal["camera"]["f"],
            "width": cal["imageWidth"],
            "height": cal["imageHeight"],
        },
        "rallies": rallies,
        "confidence": CONFIDENCE,
        "notes": NOTES,
    }
    html = (ROOT / "viewer" / "replay.html").read_text().replace("/*__DATA__*/null", json.dumps(data, separators=(",", ":")))
    (out / "replay.html").write_text(html)
    print(f"wrote {out / 'replay.html'} ({len(html) / 1e6:.1f} MB)")


CONFIDENCE = [
    {"level": ["hi", "Solid"], "what": "Court, net and camera position. Calibrated from six snapped landmarks, 0.5 px fit."},
    {"level": ["hi", "Solid"], "what": "Where each player stands and how far they ran. Feet are pinned to the court through the calibration."},
    {"level": ["mid", "Approximate"], "what": "Ball path and bounce spots. One camera can't see depth, so each shot is a physics fit to the 2D track; errors grow toward the far baseline."},
    {"level": ["mid", "Approximate"], "what": "Shot speed. Comes from the fitted launch; fair for groundstrokes, least reliable for serves (30 fps blur)."},
    {"level": ["mid", "Approximate"], "what": "Body shape and pose. SAM 3D Body meshes, fitted per frame (every other frame, blended between); the far player is ~45 px tall, so their limbs are rough."},
]
NOTES = [
    "<b>How it was made.</b> One iPhone, ultra-wide, 30 fps. The court calibration from the web panel gives the camera. WASB finds the ball in each frame, YOLO11-pose finds both players (the far one in a 4× enlarged crop), SAM 3D Body turns each into a 3D body mesh (VideoPose3D skeletons as the lighter alternative), and each shot is fitted as a physical flight with gravity, air drag and a bounce.",
    "<b>What's next.</b> 60 fps recording for the ball, racket pose, and smoothing body motion over time rather than frame by frame.",
]

if __name__ == "__main__":
    main(*sys.argv[1:3])
