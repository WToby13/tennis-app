"""Phase 3, second half: each player as a 3D skeleton on the court.

Stand-in until SAM 3D Body (gated on Hugging Face) is available: VideoPose3D
(Pavllo et al., CVPR 2019; github.com/facebookresearch/VideoPose3D, CC BY-NC)
lifts a sequence of 2D COCO keypoints (what YOLO11-pose gives) to 17 3D joints
in the camera's frame, using 243 frames of context to resolve depth.

Placing it on the court uses the calibration: the skeleton is rotated from the
camera's frame into court axes, then slid along the camera ray through the hips
until the lowest foot touches the ground. It therefore matches the image from
the camera's viewpoint and stands on the court rather than floating.
"""

from __future__ import annotations

import functools
import sys
from pathlib import Path

import numpy as np
import torch

from .camera import Camera

VENDOR = Path(__file__).resolve().parents[1] / ".cache" / "vendor" / "VideoPose3D"
WEIGHTS = Path(__file__).resolve().parents[1] / ".cache" / "weights" / "videopose3d_h36m_coco.bin"

# Human3.6M 17-joint output: names and parents (for drawing bones).
JOINTS = [
    "hip", "r_hip", "r_knee", "r_foot", "l_hip", "l_knee", "l_foot", "spine", "thorax",
    "neck", "head", "l_shoulder", "l_elbow", "l_wrist", "r_shoulder", "r_elbow", "r_wrist",
]
PARENTS = [-1, 0, 1, 2, 0, 4, 5, 0, 7, 8, 9, 8, 11, 12, 8, 14, 15]
FEET = [3, 6]
RECEPTIVE = 243


@functools.cache
def _load(device: str):
    sys.path.insert(0, str(VENDOR))
    from common.model import TemporalModel  # noqa: E402

    model = TemporalModel(17, 2, 17, filter_widths=[3, 3, 3, 3, 3], causal=False, dropout=0.25, channels=1024)
    ck = torch.load(WEIGHTS, map_location="cpu", weights_only=False)
    model.load_state_dict(ck["model_pos"])
    return model.to(device).eval()


def _fill_gaps(frames: np.ndarray, kps: np.ndarray, all_frames: np.ndarray) -> np.ndarray:
    """Per-frame (17, 2) keypoints over every frame in `all_frames`, linearly
    interpolating frames where the player wasn't detected."""
    out = np.zeros((len(all_frames), 17, 2))
    for j in range(17):
        for c in range(2):
            out[:, j, c] = np.interp(all_frames, frames, kps[:, j, c])
    return out


# The model learnt from Human3.6M, where a person spans roughly this much of the
# normalised image height (nose to ankles), centred. Ours are far smaller and
# off-centre, so each player's keypoints are re-centred and re-scaled to match.
TARGET_EXTENT = 0.8


def _canonical(kps: np.ndarray) -> np.ndarray:
    """(T, 17, 2) pixels -> centred, scaled to the training size, per frame."""
    hips = (kps[:, 11] + kps[:, 12]) / 2
    extent = np.linalg.norm(kps[:, 0] - (kps[:, 15] + kps[:, 16]) / 2, axis=1)
    # Body size changes slowly; smooth it so a crouch isn't read as moving away.
    k = 31
    pad = np.pad(extent, (k // 2, k // 2), mode="edge")
    extent = np.convolve(pad, np.ones(k) / k, mode="valid")
    return (kps - hips[:, None]) / extent[:, None, None] * TARGET_EXTENT


@torch.no_grad()
def lift(kps_2d: np.ndarray, device: str = "cpu") -> np.ndarray:
    """(T, 17, 2) image keypoints -> (T, 17, 3) root-relative joints in a virtual
    camera looking straight at the player (x right, y down, z forward), metres."""
    model = _load(device)
    x = _canonical(kps_2d)
    pad = (RECEPTIVE - 1) // 2
    x = np.pad(x, ((pad, pad), (0, 0), (0, 0)), mode="edge")
    pred = model(torch.from_numpy(x[None].astype(np.float32)).to(device))[0].cpu().numpy()
    # Test-time flip, as in the paper: mirror the input, mirror back, average.
    kl, kr = [1, 3, 5, 7, 9, 11, 13, 15], [2, 4, 6, 8, 10, 12, 14, 16]  # COCO left/right
    jl, jr = [4, 5, 6, 11, 12, 13], [1, 2, 3, 14, 15, 16]  # H36M left/right
    xf = x.copy()
    xf[..., 0] *= -1
    xf[:, kl + kr] = xf[:, kr + kl]
    pf = model(torch.from_numpy(xf[None].astype(np.float32)).to(device))[0].cpu().numpy()
    pf[..., 0] *= -1
    pf[:, jl + jr] = pf[:, jr + jl]
    return (pred + pf) / 2


def _virtual_to_camera(cam: Camera, px: np.ndarray) -> np.ndarray:
    """Per frame, the rotation taking the virtual camera (looking straight at the
    player) into the real one, whose ray to the player is off-axis."""
    d = np.column_stack([(px - cam.K[:2, 2]) / cam.K[0, 0], np.ones(len(px))])
    d /= np.linalg.norm(d, axis=1, keepdims=True)
    z = np.array([0.0, 0.0, 1.0])
    out = np.zeros((len(px), 3, 3))
    for i, di in enumerate(d):
        v = np.cross(z, di)
        c = float(z @ di)
        vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
        out[i] = np.eye(3) + vx + vx @ vx / (1 + c)
    return out


def place_on_court(cam: Camera, joints_virtual: np.ndarray, hip_px: np.ndarray) -> np.ndarray:
    """Root-relative virtual-camera joints (T, 17, 3) -> court coordinates (T, 17, 3).

    Rotate into the real camera, then into court axes, then put the root on the
    camera ray through the hips' pixel at the distance where the lowest foot is
    on the ground.
    """
    rv = _virtual_to_camera(cam, hip_px)
    joints_cam = np.einsum("tij,tkj->tki", rv, joints_virtual)
    rel = joints_cam @ cam.R  # camera -> court axes (R is court -> camera)
    rays = cam.ray(hip_px)
    c = cam.position
    foot_z = rel[:, FEET, 2].min(axis=1)  # lowest foot, relative to the root
    s = (-foot_z - c[2]) / rays[:, 2]  # root.z + foot_z = 0 on the ray
    root = c + s[:, None] * rays
    return root[:, None, :] + rel


def skeletons(
    cam: Camera, players: list[dict], first: int, last: int, device: str = "cpu", reach: int = 5
) -> dict[str, dict]:
    """Per side: frame numbers and (T, 17, 3) court-space joints, on frames within
    `reach` frames of a detection (between detections the keypoints are
    interpolated, so further out is a guess)."""
    out: dict[str, dict] = {}
    all_frames = np.arange(first, last + 1)
    for side in ("near", "far"):
        ps = sorted((p for p in players if p["side"] == side), key=lambda p: p["frame"])
        if len(ps) < 10:
            continue
        frames = np.array([p["frame"] for p in ps])
        kps = np.array([p["keypoints"] for p in ps])[:, :, :2]
        seq = _fill_gaps(frames, kps, all_frames)
        rel = lift(seq, device)
        hips = (seq[:, 11] + seq[:, 12]) / 2  # COCO hips
        joints = place_on_court(cam, rel, hips)
        # Only report frames near a real detection; long gaps are guesses.
        near_detection = np.array([np.min(np.abs(frames - f)) <= reach for f in all_frames])
        out[side] = {
            "frames": all_frames[near_detection].tolist(),
            "joints": np.round(joints[near_detection], 3).tolist(),
        }
    return out
