"""Phase 3, body meshes: each player as a SAM 3D Body mesh on the court.

    SAM3D_DEVICE=mps PYTORCH_ENABLE_MPS_FALLBACK=1 .cache/venv-sam3d/bin/python -m ojo_replay.body_sam \\
        .cache/short-test/match.json .cache/short-test/short-test.mov out/short-test [stride]

Runs in its own environment (.cache/venv-sam3d), separate from the detectors.
SAM 3D Body (Meta, CVPR 2026; gated weights on Hugging Face, SAM License) takes
each player's box from the 2D pass and the calibrated camera's intrinsics, and
returns a full body mesh in that camera's frame. The calibration then puts it on
the court, and a light correction along the camera ray stands its lowest point on
the ground, as for the skeletons.

A full mesh every frame for two players is far too heavy for a web page, so the
mesh is simplified once (vertices merged on a 5 cm grid of the first good fit)
and every frame keeps the same reduced vertex set and faces.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import cv2
import numpy as np
import torch

from .camera import Camera

ROOT = Path(__file__).resolve().parents[1]
VENDOR = ROOT / ".cache" / "vendor" / "sam-3d-body"
WEIGHTS = ROOT / ".cache" / "weights" / "sam-3d-body-dinov3"


def load(device: str):
    sys.path.insert(0, str(VENDOR))
    from sam_3d_body.build_models import load_sam_3d_body  # noqa: E402
    from sam_3d_body.sam_3d_body_estimator import SAM3DBodyEstimator  # noqa: E402

    model, cfg = load_sam_3d_body(
        str(WEIGHTS / "model.ckpt"), device=device, mhr_path=str(WEIGHTS / "assets" / "mhr_model.pt")
    )
    # The MHR body model computes in float64, which Apple's GPU (MPS) can't, so
    # it stays on the CPU while the image network runs on the GPU. (The vendored
    # head moves its inputs across to match.)
    for name, module in model.named_modules():
        if name.split(".")[-1] == "mhr":
            module.to("cpu")
    return SAM3DBodyEstimator(model, cfg)


def simplify(verts: np.ndarray, faces: np.ndarray, cell: float = 0.05):
    """Vertex clustering: one vertex per `cell`-sized cube. Returns the kept
    vertex indices (into the full mesh) and faces re-indexed to them."""
    keys = np.floor(verts / cell).astype(np.int64)
    _, first, inverse = np.unique(keys, axis=0, return_index=True, return_inverse=True)
    inverse = inverse.ravel()
    f = inverse[faces]
    f = f[(f[:, 0] != f[:, 1]) & (f[:, 1] != f[:, 2]) & (f[:, 0] != f[:, 2])]
    return first, f


def to_court(cam: Camera, verts_cam: np.ndarray) -> np.ndarray:
    """Camera-frame vertices -> court coordinates, lowest point on the ground."""
    court = (verts_cam - cam.t) @ cam.R  # R is court -> camera
    root = court.mean(axis=0)
    ray = root - cam.position
    ray /= np.linalg.norm(ray)
    # Slide along the camera ray (depth is what a single view gets least right)
    # until the lowest vertex touches the court.
    lowest = court[:, 2].min()
    s = -lowest / ray[2] if abs(ray[2]) > 1e-6 else 0.0
    return court + s * ray


def main(match_json: str, video: str, out_dir: str, stride: int = 2) -> None:
    import os

    device = os.environ.get("SAM3D_DEVICE", "mps")
    cam = Camera.from_match(Path(match_json))
    K = torch.tensor(cam.K, dtype=torch.float32)[None]
    est = load(device)
    out = Path(out_dir)
    match = json.loads(Path(match_json).read_text())
    for seg in match["segments"]:
        raw = json.loads((out / f"rally{seg['idx']}_2d.json").read_text())
        by_frame: dict[int, dict[str, dict]] = {}
        for p in raw["players"]:
            by_frame.setdefault(p["frame"], {})[p["side"]] = p
        frames = list(range(raw["firstFrame"], raw["lastFrame"] + 1, stride))
        cap = cv2.VideoCapture(video)
        result: dict[str, dict] = {"near": {"frames": [], "verts": []}, "far": {"frames": [], "verts": []}}
        keep: dict[str, tuple[np.ndarray, np.ndarray]] = {}
        t0 = time.time()
        for n, f in enumerate(frames):
            cap.set(cv2.CAP_PROP_POS_FRAMES, f)
            ok, img = cap.read()
            if not ok:
                break
            rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
            for side, p in by_frame.get(f, {}).items():
                x1, y1, x2, y2 = p["box"]
                pad = 0.12 * (y2 - y1)
                box = np.array([[x1 - pad, y1 - pad, x2 + pad, y2 + pad]], dtype=np.float32)
                res = est.process_one_image(rgb, bboxes=box, cam_int=K, inference_type="body")
                if not res:
                    continue
                r = res[0]
                verts = r["pred_vertices"] + r["pred_cam_t"]
                court = to_court(cam, verts)
                if side not in keep:
                    keep[side] = simplify(court, est.faces)
                idx, _ = keep[side]
                result[side]["frames"].append(f)
                result[side]["verts"].append(np.round(court[idx], 3).astype(np.float32))
            if n % 20 == 0:
                print(f"rally {seg['idx']}: {n + 1}/{len(frames)} frames, {(time.time() - t0) / (n + 1):.1f} s/frame", flush=True)
        cap.release()
        # Millimetres as int16 (court coordinates stay within +/-32 m): a quarter
        # of the size of text, and well inside how precisely the mesh is placed.
        arrays = {}
        for side, d in result.items():
            if not d["frames"]:
                continue
            idx, faces = keep[side]
            arrays[f"{side}_frames"] = np.array(d["frames"], dtype=np.int32)
            arrays[f"{side}_faces"] = faces.astype(np.int32)
            arrays[f"{side}_verts_mm"] = np.clip(np.round(np.stack(d["verts"]) * 1000), -32767, 32767).astype(np.int16)
        np.savez_compressed(out / f"rally{seg['idx']}_bodies.npz", **arrays)
        shapes = {k: v.shape for k, v in arrays.items() if k.endswith("verts_mm")}
        print(f"rally {seg['idx']}: wrote meshes {shapes} in {time.time() - t0:.0f}s", flush=True)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]) if len(sys.argv) > 4 else 2)
