"""Phase 3, first half: find the two players, frame by frame, in court coordinates.

YOLO11-pose gives every person's box and 17 COCO keypoints. The calibrated camera
puts each person's feet on the court, which is what separates our players from
the next court's players, spectators and the person at the fence, and says who
is at the near end and who at the far end.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np
from ultralytics import YOLO

from .camera import DOUBLES, HALF_LENGTH, Camera

# COCO keypoint indices.
L_ANKLE, R_ANKLE = 15, 16
L_WRIST, R_WRIST = 9, 10

# How far outside the lines a player can be and still be playing on this court.
SIDE_MARGIN = 3.0  # metres beyond the doubles sidelines
END_MARGIN = 6.5  # metres behind the baselines


@dataclass
class PlayerFrame:
    frame: int
    side: str  # "near" | "far"
    box: list[float]  # x1, y1, x2, y2 (pixels)
    keypoints: list[list[float]]  # 17 x (u, v, confidence)
    feet: list[float]  # court x, y (metres)
    conf: float
    track_id: int | None = None
    extras: dict = field(default_factory=dict)


def feet_pixel(box: np.ndarray, kps: np.ndarray) -> np.ndarray:
    """Where the player touches the ground in the image: between the ankles if
    the model is confident about them, else the bottom-centre of the box."""
    ankles = kps[[L_ANKLE, R_ANKLE]]
    good = ankles[:, 2] > 0.4
    if good.any():
        u = ankles[good, 0].mean()
        # Ankles sit a little above the ground; nudge down by ~2% of box height.
        v = ankles[good, 1].max() + 0.02 * (box[3] - box[1])
        return np.array([u, v])
    return np.array([(box[0] + box[2]) / 2, box[3]])


def on_court(xy: np.ndarray) -> bool:
    return abs(xy[0]) <= DOUBLES + SIDE_MARGIN and abs(xy[1]) <= HALF_LENGTH + END_MARGIN


def plausible_height(cam: Camera, feet: np.ndarray, box: np.ndarray) -> bool:
    """A person standing at `feet` is 1.0-2.2 m tall (crouching to upright, arms
    up); their box can't be much shorter or taller than that projects to. Rules
    out fragments, benches and a net post read as a person."""
    base = np.array([feet[0], feet[1], 0.0])
    top = cam.project(np.array([base, base + [0, 0, 1.8]]))
    expected = abs(top[0, 1] - top[1, 1])
    h = box[3] - box[1]
    return 0.5 * expected <= h <= 1.5 * expected


def far_crop(cam: Camera, pad: int = 24) -> tuple[int, int, int, int]:
    """Image rectangle holding the far half of the court (plus margins) up to
    head height. Far players are ~35 px tall on an ultra-wide frame, too small
    for the detector at full-frame scale, so this region is enlarged and
    searched again."""
    xs = [-(DOUBLES + SIDE_MARGIN), DOUBLES + SIDE_MARGIN]
    ys = [0.0, HALF_LENGTH + END_MARGIN]
    zs = [0.0, 2.3]
    corners = np.array([[x, y, z] for x in xs for y in ys for z in zs])
    uv = cam.project(corners)
    uv = uv[np.isfinite(uv).all(axis=1)]
    x1, y1 = np.floor(uv.min(axis=0)).astype(int) - pad
    x2, y2 = np.ceil(uv.max(axis=0)).astype(int) + pad
    return max(0, x1), max(0, y1), min(cam.width, x2), min(cam.height, y2)


def _people(model, img, imgsz, device, tracker: bool):
    run = model.track if tracker else model.predict
    kw = {"persist": True} if tracker else {}
    res = run(img, imgsz=imgsz, device=device, conf=0.25, verbose=False, classes=[0], **kw)[0]
    if res.boxes is None or len(res.boxes) == 0:
        return []
    ids = res.boxes.id.cpu().numpy().astype(int) if (tracker and res.boxes.id is not None) else [None] * len(res.boxes)
    return list(zip(res.boxes.xyxy.cpu().numpy(), res.boxes.conf.cpu().numpy(), ids, res.keypoints.data.cpu().numpy()))


def detect_players(
    frames: list[tuple[int, np.ndarray]],
    cam: Camera,
    weights: str,
    device: str = "mps",
    imgsz: int = 1280,
    crop_scale: float = 4.0,
) -> list[PlayerFrame]:
    """Pose over each frame, plus an enlarged pass over the far court; keep at
    most one player per end, by confidence."""
    model = YOLO(weights)
    far_model = YOLO(weights)  # separate instance: its own tracker state
    cx1, cy1, cx2, cy2 = far_crop(cam)
    out: list[PlayerFrame] = []
    for idx, img in frames:
        found = _people(model, img, imgsz, device, tracker=True)
        crop = cv2.resize(img[cy1:cy2, cx1:cx2], None, fx=crop_scale, fy=crop_scale, interpolation=cv2.INTER_CUBIC)
        # Kept at full enlarged size: shrinking it back to `imgsz` would undo the zoom.
        crop_sz = int(np.ceil(crop.shape[1] / 32) * 32)
        for box, conf, tid, kp in _people(far_model, crop, crop_sz, device, tracker=True):
            box = box / crop_scale + [cx1, cy1, cx1, cy1]
            kp = kp.copy()
            kp[:, 0] = kp[:, 0] / crop_scale + cx1
            kp[:, 1] = kp[:, 1] / crop_scale + cy1
            found.append((box, conf, None if tid is None else 1000 + tid, kp))
        best: dict[str, PlayerFrame] = {}
        for box, conf, tid, kp in found:
            feet = cam.to_ground(feet_pixel(box, kp)[None])[0, :2]
            if not on_court(feet) or not plausible_height(cam, feet, box):
                continue
            side = "near" if feet[1] < 0 else "far"
            cand = PlayerFrame(
                frame=idx,
                side=side,
                box=np.round(box, 1).tolist(),
                keypoints=np.round(kp, 2).tolist(),
                feet=feet.round(3).tolist(),
                conf=float(conf),
                track_id=None if tid is None else int(tid),
            )
            # One per end: the most confident (a ball kid or coach at the same end
            # is rarer than a missed detection, and less confident).
            if side not in best or cand.conf > best[side].conf:
                best[side] = cand
        out.extend(best.values())
    return out
