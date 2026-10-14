"""A court's surroundings as a 3D Gaussian splat, in court coordinates, for the 3D view.

    # 1. the splat, in the phone's frame (stand-in: Apple SHARP, research-only weights,
    #    so for development; the shipped splat comes from the Matrix-3D run on a GPU)
    .cache/venv-sharp/bin/python -m ojo_replay.venue_splat predict <match-id-prefix>
    # 2. into court coordinates, scaled on the court, written for the viewer
    .venv/bin/python -m ojo_replay.venue_splat place <match-id-prefix> [--out <dir>]

The surroundings don't change between matches on the same court, so this is
once per court (per calibration), not per match.

Step 1 runs on the recording's clean plate (players and ball removed) with the
calibrated focal length. Step 2 turns the splat from the phone's frame (OpenCV:
x right, y down, z forward) into the court's (metres from centre court, +x
right, +y away, +z up) through the calibration, and corrects its scale: a
single image only roughly knows how far away things are, but the court is
exactly where the calibration says, so every splat on the court's surface says
how much the depth is off (median of true / predicted distance along its ray).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]


def _paths(prefix: str) -> tuple[str, Path]:
    meta = json.loads(next((ROOT / ".cache" / "matches").glob(prefix + "*.json")).read_text())
    short = meta["id"][:8]
    return meta["id"], ROOT / "out" / "analysis" / short


def predict(prefix: str, device: str = "mps") -> Path:
    """The plate as Gaussians in the phone's frame (SHARP), to out/analysis/<id>/venue_cam.ply."""
    import torch
    from PIL import Image
    from sharp.cli.predict import DEFAULT_MODEL_URL, predict_image
    from sharp.models import PredictorParams, create_predictor
    from sharp.utils.gaussians import save_ply

    _, out = _paths(prefix)
    cal = json.loads((out / "calibration.json").read_text())
    image = np.asarray(Image.open(ROOT / ".cache" / "plates" / f"{out.name}.png").convert("RGB"))
    model = create_predictor(PredictorParams())
    model.load_state_dict(torch.hub.load_state_dict_from_url(DEFAULT_MODEL_URL, progress=True))
    model.eval().to(device)
    gaussians = predict_image(model, image, float(cal["camera"]["f"]), torch.device(device))
    path = out / "venue_cam.ply"
    save_ply(gaussians, float(cal["camera"]["f"]), image.shape[:2], path)
    print(f"wrote {path}")
    return path


def _read_ply(path: Path) -> tuple[dict[str, np.ndarray], list[str]]:
    """The vertex element of a binary little-endian 3DGS .ply, as named float32 columns."""
    raw = path.read_bytes()
    end = raw.index(b"end_header\n") + len(b"end_header\n")
    header = raw[:end].decode().splitlines()
    count, names, in_vertex = 0, [], False
    for line in header:
        parts = line.split()
        if parts[:2] == ["element", "vertex"]:
            count, in_vertex = int(parts[2]), True
        elif parts[:1] == ["element"]:
            in_vertex = False
        elif parts[:1] == ["property"] and in_vertex:
            assert parts[1] == "float", f"unexpected property type {parts[1]}"
            names.append(parts[2])
    data = np.frombuffer(raw, dtype="<f4", count=count * len(names), offset=end).reshape(count, len(names))
    return {n: data[:, i].copy() for i, n in enumerate(names)}, names


def _write_ply(path: Path, cols: dict[str, np.ndarray], names: list[str]) -> None:
    n = len(cols[names[0]])
    header = ["ply", "format binary_little_endian 1.0", f"element vertex {n}"]
    header += [f"property float {name}" for name in names] + ["end_header", ""]
    data = np.column_stack([cols[name] for name in names]).astype("<f4")
    path.write_bytes("\n".join(header).encode() + data.tobytes())


def _quat_mul(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Hamilton product, (w, x, y, z), a applied after b."""
    aw, ax, ay, az = a
    bw, bx, by, bz = b.T
    return np.column_stack([
        aw * bw - ax * bx - ay * by - az * bz,
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
    ])


def _quat_of(m: np.ndarray) -> np.ndarray:
    """Rotation matrix -> unit quaternion (w, x, y, z)."""
    w = np.sqrt(max(0.0, 1 + m[0, 0] + m[1, 1] + m[2, 2])) / 2
    x = np.copysign(np.sqrt(max(0.0, 1 + m[0, 0] - m[1, 1] - m[2, 2])) / 2, m[2, 1] - m[1, 2])
    y = np.copysign(np.sqrt(max(0.0, 1 - m[0, 0] + m[1, 1] - m[2, 2])) / 2, m[0, 2] - m[2, 0])
    z = np.copysign(np.sqrt(max(0.0, 1 - m[0, 0] - m[1, 1] + m[2, 2])) / 2, m[1, 0] - m[0, 1])
    q = np.array([w, x, y, z])
    return q / np.linalg.norm(q)


def place(prefix: str, out_dir: str | None = None) -> Path:
    """venue_cam.ply -> court coordinates, scale corrected on the court surface."""
    from .camera import DOUBLES, HALF_LENGTH, Camera

    video_id, out = _paths(prefix)
    cam = Camera.from_calibration(json.loads((out / "calibration.json").read_text()))
    cols, names = _read_ply(out / "venue_cam.ply")
    p = np.column_stack([cols["x"], cols["y"], cols["z"]]).astype(float)

    # Scale: splats whose pixel falls on the court surface, true vs predicted depth.
    ok = p[:, 2] > 0.1
    uv = p[ok, :2] / p[ok, 2:3] * cam.K[0, 0] + cam.K[:2, 2]
    ground = cam.to_ground(uv)
    on_court = (np.abs(ground[:, 0]) < DOUBLES - 0.3) & (np.abs(ground[:, 1]) < HALF_LENGTH - 0.3) & (ground[:, 1] < -0.5)
    true_depth = np.linalg.norm(ground[on_court] - cam.position, axis=1)
    pred_depth = np.linalg.norm(p[ok][on_court], axis=1)
    scale = float(np.median(true_depth / pred_depth))
    spread = np.percentile(true_depth / pred_depth / scale, [10, 90])
    print(f"scale {scale:.3f} from {on_court.sum()} court splats (10-90%: {spread[0]:.2f}-{spread[1]:.2f})")

    # Camera frame -> court frame: x_court = R^T (s x_cam - t).
    court = (p * scale - cam.t) @ cam.R
    cols["x"], cols["y"], cols["z"] = court[:, 0], court[:, 1], court[:, 2]
    if "scale_0" in cols:
        for k in ("scale_0", "scale_1", "scale_2"):
            cols[k] = cols[k] + np.log(scale)  # log-scales
    if "rot_0" in cols:
        q = np.column_stack([cols["rot_0"], cols["rot_1"], cols["rot_2"], cols["rot_3"]])
        q /= np.linalg.norm(q, axis=1, keepdims=True)
        q = _quat_mul(_quat_of(cam.R.T), q)
        for i in range(4):
            cols[f"rot_{i}"] = q[:, i]

    # Keep the surroundings only. The court itself the viewer draws exactly (its
    # texture and lines, scene.py): two surfaces in the same place would
    # flicker. Also drop splats too faint to see.
    from .scene import MIN_HALF_LENGTH, TEX_X

    half_length = max(MIN_HALF_LENGTH, -float(cam.position[1]))
    on_surface = (np.abs(court[:, 0]) < TEX_X) & (np.abs(court[:, 1]) < half_length) & (court[:, 2] < 0.25)
    faint = 1 / (1 + np.exp(-cols["opacity"])) < 0.03
    keep = ~on_surface & ~faint
    cols = {k: v[keep] for k, v in cols.items()}
    print(f"kept {keep.sum()} of {len(keep)} splats (court surface {on_surface.sum()}, faint {faint.sum()})")

    path = Path(out_dir) / f"{video_id}.venue.ply" if out_dir else out / "venue.ply"
    path.parent.mkdir(parents=True, exist_ok=True)
    _write_ply(path, cols, names)
    print(f"wrote {path} ({len(cols['x'])} splats, {path.stat().st_size / 1e6:.1f} MB)")
    return path


if __name__ == "__main__":
    cmd, prefix, *rest = sys.argv[1:]
    if cmd == "predict":
        predict(prefix, *rest)
    else:
        place(prefix, rest[rest.index("--out") + 1] if "--out" in rest else None)
