"""The ball over a whole match, in one streaming pass.

    python -m ojo_replay.ballpass <video> <out.npz> [step]

OpenCV decodes and shrinks each frame to the detector's 512x288 input. WASB
sees three consecutive frames per window; with `step` 1 the windows slide one
frame at a time and every frame's heatmap is the average of the three
windows that contain it (best, 3x the work), with `step` 3 they tile the video
and every frame is seen once.

Per frame it keeps the strongest few heatmap blobs, in full-resolution pixels,
which is all the tracker downstream needs.
"""

from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path

import cv2
import numpy as np
import torch

from .ball2d import IN_H, IN_W, MEAN, STD, _blobs, best_device, load_wasb

WEIGHTS = Path(__file__).resolve().parents[1] / ".cache" / "weights" / "wasb_tennis.pth.tar"
KEEP = 4  # candidates kept per frame


def probe(video: str) -> tuple[int, int, float, float]:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
         "stream=width,height,avg_frame_rate:format=duration", "-of", "default=nw=1", video],
        capture_output=True, text=True, check=True,
    ).stdout
    kv = dict(line.split("=", 1) for line in out.strip().splitlines())
    num, den = kv["avg_frame_rate"].split("/")
    return int(kv["width"]), int(kv["height"]), float(num) / float(den), float(kv["duration"])


def frames_small(video: str, start: float = 0.0, duration: float | None = None):
    """Yield RGB uint8 frames at the detector's input size.

    Decoded and shrunk by OpenCV, as the detector was trained: its linear resize
    samples only the nearest source pixels, which keeps a 3-6 px ball crisp at
    512x288. ffmpeg's scaler filters properly for a downscale and blurs the ball
    away; on a checked rally that lost ~10% of the ball frames, and shots with them.
    """
    cap = cv2.VideoCapture(video)
    fps = cap.get(cv2.CAP_PROP_FPS)
    if start:
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(round(start * fps)))
    left = int(round(duration * fps)) if duration else None
    try:
        while left is None or left > 0:
            ok, img = cap.read()
            if not ok:
                break
            yield cv2.cvtColor(cv2.resize(img, (IN_W, IN_H), interpolation=cv2.INTER_LINEAR), cv2.COLOR_BGR2RGB)
            if left is not None:
                left -= 1
    finally:
        cap.release()


@torch.no_grad()
def run(video: str, step: int = 3, device: str | None = None, batch: int = 4, threshold: float = 0.5,
        start: float = 0.0, duration: float | None = None) -> dict:
    device = device or best_device()
    W, H, fps, dur = probe(video)
    # Half precision, small batches: measured on an M1 (16 GB), 59 ms a window
    # against 90 in float32, and larger batches get slower, not faster.
    dtype = torch.float16 if device != "cpu" else torch.float32
    model = load_wasb(WEIGHTS, device).to(dtype)
    mean = torch.tensor(MEAN, device=device).view(1, 3, 1, 1)
    std = torch.tensor(STD, device=device).view(1, 3, 1, 1)
    sx, sy = W / IN_W, H / IN_H
    first = int(round(start * fps))

    cands = np.full((int((duration or dur) * fps) + 64, KEEP, 3), np.nan, np.float32)
    buf: list[np.ndarray] = []  # frames not yet fully processed
    base = 0  # index (from `first`) of buf[0]
    acc: dict[int, np.ndarray] = {}
    cnt: dict[int, int] = {}
    t0 = time.time()
    n = 0
    timing = {"decode": 0.0, "model": 0.0, "blobs": 0.0}

    def flush(upto: int) -> None:
        """Turn heatmaps of frames < upto into candidates."""
        tb = time.time()
        for i in sorted(k for k in acc if k < upto):
            hm = acc.pop(i) / cnt.pop(i)
            blobs = sorted(_blobs(hm, threshold), key=lambda b: -b[2])[:KEEP]
            if i >= len(cands):
                continue
            for j, (x, y, s) in enumerate(blobs):
                cands[i, j] = ((x + 0.5) * sx, (y + 0.5) * sy, s)
        timing["blobs"] += time.time() - tb

    def infer(starts: list[int]) -> None:
        tm = time.time()
        x = np.stack([np.stack(buf[s - base : s - base + 3]) for s in starts])  # B x 3 x H x W x 3
        t = torch.from_numpy(x).to(device).float().div_(255)  # B,3,H,W,C
        t = t.permute(0, 1, 4, 2, 3).reshape(-1, 3, IN_H, IN_W)
        t = ((t - mean) / std).reshape(len(starts), 9, IN_H, IN_W).to(dtype)
        hm = torch.sigmoid(model(t)[0].float()).cpu().numpy()
        timing["model"] += time.time() - tm
        for k, s in enumerate(starts):
            for d in range(3):
                i = s + d
                acc[i] = acc.get(i, 0) + hm[k, d]
                cnt[i] = cnt.get(i, 0) + 1

    pending: list[int] = []
    next_start = 0
    td = time.time()
    for img in frames_small(video, start, duration):
        timing["decode"] += time.time() - td
        buf.append(img)
        n += 1
        while next_start + 3 <= base + len(buf):
            pending.append(next_start)
            next_start += step
        if len(pending) >= batch:
            infer(pending)
            pending = []
            flush(next_start)
            drop = next_start - base
            if drop > 0:
                del buf[:drop]
                base += drop
        if n % (int(fps) * 120) == 0:
            el = time.time() - t0
            print(f"  {n / fps / 60:.0f} min of video in {el / 60:.1f} min ({n / el:.0f} fps)", flush=True)
        td = time.time()
    if pending:
        infer(pending)
    flush(10**12)
    el = time.time() - t0
    return {
        "cands": cands[:n], "fps": fps, "first": first, "width": W, "height": H, "frames": n,
        "seconds": el, "step": step, "timing": timing,
    }


def main(video: str, out: str, step: str = "3") -> None:
    r = run(video, int(step))
    np.savez_compressed(out, cands=r["cands"], fps=r["fps"], first=r["first"], width=r["width"], height=r["height"])
    t = r["timing"]
    print(f"{r['frames']} frames in {r['seconds']:.0f}s = {r['frames'] / r['seconds']:.0f} fps "
          f"(decode {t['decode']:.0f}s, model {t['model']:.0f}s, blobs {t['blobs']:.0f}s), step {r['step']}")


if __name__ == "__main__":
    main(*sys.argv[1:])
