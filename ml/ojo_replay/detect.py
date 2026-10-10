"""Run the 2D detectors over each rally and save what they found.

    python -m ojo_replay.detect .cache/short-test/match.json .cache/short-test/short-test.mov out/short-test

Per rally (padded by a second each side): every frame's ball candidates and the
near/far players with keypoints and court positions. Slow steps are cached as
JSON so the 3D fitting can be iterated on without re-running the models.
"""

from __future__ import annotations

import json
import sys
import time
from dataclasses import asdict
from pathlib import Path

import cv2

from .ball2d import detect_ball
from .camera import Camera
from .players import detect_players

ROOT = Path(__file__).resolve().parents[1]
WEIGHTS = ROOT / ".cache" / "weights"
PAD_S = 1.0


def read_frames(video: Path, first: int, last: int):
    cap = cv2.VideoCapture(str(video))
    cap.set(cv2.CAP_PROP_POS_FRAMES, first)
    frames = []
    for i in range(first, last + 1):
        ok, img = cap.read()
        if not ok:
            break
        frames.append((i, img))
    cap.release()
    return frames


def main(match_json: str, video: str, out_dir: str, only: list[int] | None = None) -> None:
    match = json.loads(Path(match_json).read_text())
    cam = Camera.from_match(Path(match_json))
    cap = cv2.VideoCapture(video)
    fps = cap.get(cv2.CAP_PROP_FPS)
    n_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    cap.release()
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    for seg in match["segments"]:
        if only is not None and seg["idx"] not in only:
            continue
        first = max(0, int((seg["startS"] - PAD_S) * fps))
        last = min(n_frames - 1, int((seg["endS"] + PAD_S) * fps))
        t0 = time.time()
        frames = read_frames(Path(video), first, last)
        t_read = time.time() - t0

        t0 = time.time()
        balls = detect_ball(frames, WEIGHTS / "wasb_tennis.pth.tar")
        t_ball = time.time() - t0

        t0 = time.time()
        players = detect_players(frames, cam, str(WEIGHTS / "yolo11l-pose.pt"))
        t_players = time.time() - t0

        rally = {
            "rally": seg["idx"],
            "fps": fps,
            "firstFrame": first,
            "lastFrame": last,
            "ball": [asdict(b) for b in balls],
            "players": [asdict(p) for p in players],
        }
        (out / f"rally{seg['idx']}_2d.json").write_text(json.dumps(rally))
        n = len(frames)
        print(
            f"rally {seg['idx']}: {n} frames | read {t_read:.0f}s | ball {t_ball:.0f}s ({n / t_ball:.1f} fps) "
            f"| players {t_players:.0f}s ({n / t_players:.1f} fps) | {len(balls)} ball candidates, "
            f"{sum(p.side == 'near' for p in players)} near / {sum(p.side == 'far' for p in players)} far player frames"
        )


if __name__ == "__main__":
    only = [int(x) for x in sys.argv[4].split(",")] if len(sys.argv) > 4 else None
    main(sys.argv[1], sys.argv[2], sys.argv[3], only)
