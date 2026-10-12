"""The whole match, as analysed: one overlay video to watch end to end.

    python -m ojo_replay.matchvideo <match-id-prefix> [width]

Reads out/analysis/<id>/ (analysis.json, structure.json, ball.npz, cached
players) and the downloaded video; writes out/analysis/<id>/match.mp4.

On every frame: the tracked ball and a short trail; inside rallies, each player
boxed in their colour (A or B, when the kits told them apart); a shot's bounce
with its speed and call, held until the next one; and a strip with the game,
the server and the side. Between rallies the strip says so, so what the
pipeline counts as play is visible at a glance.
"""

from __future__ import annotations

import glob
import json
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np

from .camera import COURT_LINES, Camera
from . import rallies as RL

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / ".cache"
COL = {"A": (46, 122, 224), "B": (207, 120, 47), None: (200, 200, 200)}  # BGR
CALL = {"in": (90, 200, 90), "close": (60, 180, 230), "out": (70, 70, 230), "net": (200, 200, 200)}


def court_map(h: int):
    """A small top-down court (far end at the top) and court->pixel mapping."""
    s = h / 30.0
    w = int(14.0 * s)
    img = np.full((h, w, 3), (62, 92, 168), np.uint8)  # clay

    def to_px(x, y):
        return int(w / 2 + x * s), int(h / 2 - y * s)

    for (x1, y1), (x2, y2) in COURT_LINES:
        cv2.line(img, to_px(x1, y1), to_px(x2, y2), (240, 240, 240), 1, cv2.LINE_AA)
    cv2.line(img, to_px(-6.4, 0), to_px(6.4, 0), (40, 40, 40), 2)
    return img, to_px


def main(prefix: str, width: int = 960) -> None:
    meta = json.loads(next((CACHE / "matches").glob(prefix + "*.json")).read_text())
    mid = meta["id"][:8]
    out = ROOT / "out" / "analysis" / mid
    a = json.loads((out / "analysis.json").read_text())
    st = json.loads((out / "structure.json").read_text()) if (out / "structure.json").exists() else None
    cam = Camera.from_calibration(json.loads((out / "calibration.json").read_text()))
    fps = a["fps"]
    z = np.load(out / "ball.npz")
    ball = RL.tracked(z["cands"], cam, fps)

    # Players by frame (detections were every few frames: hold each for a few).
    players: dict[int, list[dict]] = {}
    for f in glob.glob(str(out / "rallies" / "*c4.players.json")):
        for p in json.loads(Path(f).read_text())["players"]:
            players.setdefault(p["frame"], []).append(p)
    sampled = np.array(sorted(players))

    point_of = {p["rally"]: p for p in (st["points"] if st else [])}
    windows = [(int(r["startS"] * fps), int(r["endS"] * fps), r) for r in a["rallies"]]

    src = CACHE / "videos" / f"{mid}.mov"
    cap = cv2.VideoCapture(str(src))
    W0, H0 = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    scale = width / W0
    H = int(round(H0 * scale / 2) * 2)
    dest = out / "match.mp4"
    enc = subprocess.Popen(
        ["ffmpeg", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{width}x{H}",
         "-r", str(fps), "-i", "-", "-i", str(src), "-map", "0:v", "-map", "1:a?", "-c:v", "libx264",
         "-preset", "veryfast", "-crf", "26", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k",
         "-shortest", "-movflags", "+faststart", str(dest)],
        stdin=subprocess.PIPE,
    )
    map_base, to_map = court_map(int(H * 0.36))
    w_idx = 0
    f = 0
    last_bounce = None
    while True:
        ok, img = cap.read()
        if not ok:
            break
        while w_idx < len(windows) and windows[w_idx][1] < f:
            w_idx += 1
        in_rally = w_idx < len(windows) and windows[w_idx][0] <= f <= windows[w_idx][1]
        rally = windows[w_idx][2] if in_rally else None
        point = point_of.get(rally["idx"]) if rally else None

        # Players: nearest sampled detection within 4 frames.
        if in_rally and len(sampled):
            k = int(np.searchsorted(sampled, f))
            near = [sampled[j] for j in (k - 1, k) if 0 <= j < len(sampled) and abs(sampled[j] - f) <= 4]
            if near:
                g = min(near, key=lambda s: abs(s - f))
                for p in players[g]:
                    who = None
                    if point:
                        who = point["nearPlayer"] if p["side"] == "near" else ("B" if point["nearPlayer"] == "A" else "A")
                    x1, y1, x2, y2 = map(int, p["box"])
                    cv2.rectangle(img, (x1, y1), (x2, y2), COL[who], 2)
                    if who:
                        cv2.putText(img, who, (x1, y1 - 6), cv2.FONT_HERSHEY_SIMPLEX, 0.9, COL[who], 2, cv2.LINE_AA)

        # Ball and trail.
        for g in range(max(0, f - 12), f + 1):
            if np.isfinite(ball[g, 0]):
                r = 3 if g < f else 7
                cv2.circle(img, (int(ball[g, 0]), int(ball[g, 1])), r, (0, 235, 255), -1 if g < f else 2, cv2.LINE_AA)

        # Shots: the latest bounce in this rally, with speed and call.
        if rally:
            t = f / fps
            done = [s for s in rally["shots"] if s.get("bounce") and s["bounce"][0] <= t]
            last_bounce = done[-1] if done else None
            if last_bounce:
                _, bx, by = last_bounce["bounce"]
                uv = cam.project(np.array([[bx, by, 0.0]]))[0]
                if np.isfinite(uv).all():
                    c = CALL.get(last_bounce.get("landing"), (200, 200, 200))
                    cv2.ellipse(img, (int(uv[0]), int(uv[1])), (16, 7), 0, 0, 360, c, 2, cv2.LINE_AA)
                    cv2.putText(img, f"{last_bounce['speed_kmh']:.0f} km/h {last_bounce.get('landing') or ''}",
                                (int(uv[0]) + 18, int(uv[1]) + 6), cv2.FONT_HERSHEY_SIMPLEX, 0.8, c, 2, cv2.LINE_AA)
        else:
            last_bounce = None

        small = cv2.resize(img, (width, H), interpolation=cv2.INTER_AREA)

        # Top strip.
        cv2.rectangle(small, (0, 0), (width, 30), (25, 25, 25), -1)
        mm, ss = divmod(int(f / fps), 60)
        if rally:
            txt = f"{mm}:{ss:02d}  rally {rally['idx'] + 1}  {len(rally['shots'])} shots fitted"
            if point:
                txt += f"  |  game {point['game'] + 1}  server {point['server']} ({'camera' if point['serverEnd'] == 'near' else 'far'} end, {point['side']})"
                if point.get("fault"):
                    txt += "  2nd serve"
            elif rally["shots"]:
                txt += "  |  not counted (no shot landed on this court)"
            else:
                txt += "  |  not counted (no shots fitted)"
        else:
            txt = f"{mm}:{ss:02d}  between points"
        cv2.putText(small, txt, (8, 21), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (235, 235, 235), 1, cv2.LINE_AA)

        # Court map with this rally's bounces.
        if rally:
            m = map_base.copy()
            for s in rally["shots"]:
                if s.get("bounce") and s["bounce"][0] <= f / fps:
                    p = point_of.get(rally["idx"])
                    who = None
                    if p:
                        who = p["nearPlayer"] if s["hitter"] == "near" else ("B" if p["nearPlayer"] == "A" else "A")
                    cv2.circle(m, to_map(s["bounce"][1], s["bounce"][2]), 3, COL[who], -1, cv2.LINE_AA)
            mh, mw = m.shape[:2]
            small[H - mh - 8 : H - 8, width - mw - 8 : width - 8] = m

        enc.stdin.write(small.tobytes())
        f += 1
        if f % (int(fps) * 300) == 0:
            print(f"  {f / fps / 60:.0f} min rendered", flush=True)
    cap.release()
    enc.stdin.close()
    enc.wait()
    print(f"wrote {dest} ({dest.stat().st_size / 1e6:.0f} MB)")


if __name__ == "__main__":
    main(sys.argv[1], *(int(x) for x in sys.argv[2:3]))
