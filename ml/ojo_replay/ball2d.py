"""Phase 2, first half: find the ball in each frame (2D).

WASB (BMVC 2023, github.com/nttcom/WASB-SBDT) with its tennis weights: an HRNet
that takes three consecutive frames at 512x288 and returns a ball heatmap for
each. Windows slide one frame at a time, so every frame is seen in up to three
windows and its heatmaps are averaged. Blobs above threshold become candidates;
a light tracker then keeps the one that continues the ball's motion, because
balls on the next court, at the fence and in a pocket are all real balls too.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
import torch
import yaml

VENDOR = Path(__file__).resolve().parents[1] / ".cache" / "vendor" / "WASB-SBDT" / "src"
IN_W, IN_H = 512, 288
MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


@dataclass
class BallCandidate:
    frame: int
    u: float
    v: float
    score: float


def load_wasb(weights: Path, device: str) -> torch.nn.Module:
    sys.path.insert(0, str(VENDOR))
    from models.hrnet import HRNet  # noqa: E402  (vendored, see .cache/vendor)

    from omegaconf import OmegaConf

    # WASB reads its config by attribute (cfg.MODEL.EXTRA), as OmegaConf gives.
    cfg = OmegaConf.create(yaml.safe_load((VENDOR / "configs" / "model" / "wasb.yaml").read_text()))
    model = HRNet(cfg)
    state = torch.load(weights, map_location="cpu", weights_only=False)["model_state_dict"]
    model.load_state_dict(state)
    return model.to(device).eval()


def _prep(img_bgr: np.ndarray) -> np.ndarray:
    rgb = cv2.cvtColor(cv2.resize(img_bgr, (IN_W, IN_H), interpolation=cv2.INTER_LINEAR), cv2.COLOR_BGR2RGB)
    return ((rgb.astype(np.float32) / 255.0 - MEAN) / STD).transpose(2, 0, 1)  # 3 x H x W


def _blobs(hm: np.ndarray, threshold: float) -> list[tuple[float, float, float]]:
    """Connected components above threshold -> (x, y, summed score), heatmap pixels."""
    if hm.max() <= threshold:
        return []
    mask = (hm > threshold).astype(np.uint8)
    n, labels = cv2.connectedComponents(mask)
    out = []
    for m in range(1, n):
        ys, xs = np.where(labels == m)
        w = hm[ys, xs]
        out.append((float((xs * w).sum() / w.sum()), float((ys * w).sum() / w.sum()), float(w.sum())))
    return out


@torch.no_grad()
def detect_ball(
    frames: list[tuple[int, np.ndarray]],
    weights: Path,
    device: str = "mps",
    threshold: float = 0.5,
    batch: int = 8,
) -> list[BallCandidate]:
    model = load_wasb(weights, device)
    idxs = [i for i, _ in frames]
    full_h, full_w = frames[0][1].shape[:2]
    prepped = [_prep(img) for _, img in frames]
    n = len(prepped)
    acc = np.zeros((n, IN_H, IN_W), dtype=np.float32)
    cnt = np.zeros(n, dtype=np.float32)
    starts = list(range(0, n - 2))
    for b in range(0, len(starts), batch):
        chunk = starts[b : b + batch]
        x = np.stack([np.concatenate(prepped[s : s + 3], axis=0) for s in chunk])  # B x 9 x H x W
        hm = torch.sigmoid(model(torch.from_numpy(x).to(device))[0]).cpu().numpy()  # B x 3 x H x W
        for k, s in enumerate(chunk):
            acc[s : s + 3] += hm[k]
            cnt[s : s + 3] += 1
    acc /= np.maximum(cnt, 1)[:, None, None]
    sx, sy = full_w / IN_W, full_h / IN_H
    out = []
    for i in range(n):
        for x, y, s in _blobs(acc[i], threshold):
            # Heatmap pixel centres -> full-resolution pixel coordinates.
            out.append(BallCandidate(idxs[i], (x + 0.5) * sx, (y + 0.5) * sy, s))
    return out


def track_ball(cands: list[BallCandidate], max_jump: float = 160.0, max_gap: int = 6) -> dict[int, BallCandidate]:
    """Keep, per frame, the candidate that continues the ball's motion.

    Constant-velocity prediction from the last two kept detections; a candidate
    within `max_jump` pixels of the prediction continues the track, otherwise the
    strongest candidate starts a new one once the old track has gone quiet.
    """
    by_frame: dict[int, list[BallCandidate]] = {}
    for c in cands:
        by_frame.setdefault(c.frame, []).append(c)
    kept: dict[int, BallCandidate] = {}
    hist: list[BallCandidate] = []
    for f in sorted(by_frame):
        opts = by_frame[f]
        if hist and f - hist[-1].frame <= max_gap:
            last = hist[-1]
            if len(hist) >= 2 and last.frame - hist[-2].frame <= max_gap:
                prev = hist[-2]
                dt0 = last.frame - prev.frame
                vel = np.array([last.u - prev.u, last.v - prev.v]) / dt0
            else:
                vel = np.zeros(2)
            pred = np.array([last.u, last.v]) + vel * (f - last.frame)
            near = [c for c in opts if np.hypot(c.u - pred[0], c.v - pred[1]) < max_jump * (f - last.frame)]
            if near:
                best = min(near, key=lambda c: np.hypot(c.u - pred[0], c.v - pred[1]) / (1 + c.score))
                kept[f] = best
                hist.append(best)
                continue
            continue  # nothing plausible this frame; keep the track open
        best = max(opts, key=lambda c: c.score)
        kept[f] = best
        hist = [best]
    return kept
