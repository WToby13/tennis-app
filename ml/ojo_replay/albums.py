"""Each player's album: their best pictures from the whole match, from every side.

    PYTORCH_ENABLE_MPS_FALLBACK=1 .venv/bin/python -m ojo_replay.albums <match-id-prefix>

The input for a 3D avatar of each player (LHM++ takes a handful of pose-free
photos of a person and returns an animatable 3D Gaussian avatar). A match shows
everyone from every side: serving, walking back, turning for each shot, and at
every change of ends the far player comes close to the camera.

1. Detections over the whole match: the rally passes' (every 6th frame, cached
   under rallies/) and, outside rallies, every ALBUM_STRIDE frames. Between
   points is where people walk, face the camera and stand still.
2. Who: inside a point, the structure step's assignment (which kit was at the
   near end); outside, the nearer of the two kits (structure.kit), if clearly.
3. Each picture scored: size in the frame, sharpness (motion blur loses), head
   to feet in view; and which side of them it shows (yaw from the shoulders and
   face keypoints).
4. Per player: the best picture for each of 8 directions round them, then the
   best of the rest, at least MIN_GAP_S apart, cut out against the empty
   court (plate difference, refined by GrabCut). Written to
   out/analysis/<id>/albums/<A|B>/NN.png with album.json, plus a contact sheet.
"""

from __future__ import annotations

import glob
import json
import sys
import time
from dataclasses import asdict
from pathlib import Path

import cv2
import numpy as np

from .camera import Camera
from .players import detect_players
from .structure import kit

ROOT = Path(__file__).resolve().parents[1]
ALBUM_STRIDE = 15  # frames between detections outside rallies (2 fps at 30)
PER_PLAYER = 16
MIN_GAP_S = 4.0
BINS = 8  # directions round the player
# COCO keypoints.
NOSE, L_EYE, R_EYE, L_SH, R_SH, L_HIP, R_HIP, L_ANK, R_ANK = 0, 1, 2, 5, 6, 11, 12, 15, 16


def _paths(prefix: str):
    meta = json.loads(next((ROOT / ".cache" / "matches").glob(prefix + "*.json")).read_text())
    short = meta["id"][:8]
    return meta, ROOT / "out" / "analysis" / short, ROOT / ".cache" / "videos" / f"{short}.mov"


def _rally_detections(out: Path) -> list[dict]:
    seen: dict[tuple[int, str], dict] = {}
    for f in glob.glob(str(out / "rallies" / "*c4.players.json")):
        for p in json.loads(Path(f).read_text())["players"]:
            seen.setdefault((p["frame"], p["side"]), p)
    return sorted(seen.values(), key=lambda p: p["frame"])


def detections(out: Path, video: Path, cam: Camera, fps: float, n_frames: int, rallies: list[tuple[int, int]]) -> list[dict]:
    """Rally detections plus outside-rally ones at ALBUM_STRIDE (cached)."""
    cache = out / "albums" / f"between-s{ALBUM_STRIDE}.json"
    if cache.exists():
        between = json.loads(cache.read_text())
    else:
        inside = np.zeros(n_frames, bool)
        for a, b in rallies:
            inside[a : b + 1] = True
        want = [f for f in range(0, n_frames, ALBUM_STRIDE) if not inside[f]]
        print(f"detecting players in {len(want)} frames between rallies", flush=True)
        between, t0 = [], time.time()
        cap = cv2.VideoCapture(str(video))
        weights = str(ROOT / ".cache" / "weights" / "yolo11l-pose.pt")
        batch: list[tuple[int, np.ndarray]] = []
        wanted, k, f = set(want), 0, 0
        while f <= want[-1]:
            if f in wanted:
                ok, img = cap.read()
                if not ok:
                    break
                batch.append((f, img))
            elif not cap.grab():
                break
            f += 1
            if len(batch) == 40 or (f > want[-1] and batch):
                between += [asdict(p) for p in detect_players(batch, cam, weights, crop_scale=4.0)]
                k += len(batch)
                batch = []
                print(f"  {k}/{len(want)} frames, {(time.time() - t0) / k:.2f} s/frame", flush=True)
        cap.release()
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps(between))
    return sorted(_rally_detections(out) + between, key=lambda p: p["frame"])


def yaw(kp: np.ndarray) -> float | None:
    """Which way they face, degrees: 0 toward the camera, 180 away, +90 turned
    to the image's right. From the shoulders' order and spread and the face."""
    ls, rs, lh, rh = kp[L_SH], kp[R_SH], kp[L_HIP], kp[R_HIP]
    if min(ls[2], rs[2], lh[2], rh[2]) < 0.3:
        return None
    torso = np.linalg.norm((ls[:2] + rs[:2]) / 2 - (lh[:2] + rh[:2]) / 2)
    if torso < 5:
        return None
    # Facing the camera, their left shoulder is on the image's right.
    c = float(np.clip((ls[0] - rs[0]) / (0.5 * torso), -1, 1))
    face = max(kp[NOSE][2], kp[L_EYE][2], kp[R_EYE][2])
    if face > 0.6:
        c = max(c, 0.05)  # a visible face can't be facing away
    # Which side: the nose sits toward the way they're turned.
    mid = (ls[0] + rs[0]) / 2
    side = np.sign(kp[NOSE][0] - mid) if kp[NOSE][2] > 0.3 else np.sign(lh[0] + rh[0] - 2 * mid) or 1.0
    return float(np.degrees(np.arctan2(side * np.sqrt(max(0.0, 1 - c * c)), c)))


def score(img: np.ndarray, p: dict) -> dict | None:
    """How good a picture of them this is, or None if unusable."""
    kp = np.array(p["keypoints"], float)
    x1, y1, x2, y2 = p["box"]
    H, W = img.shape[:2]
    h = y2 - y1
    if h < 40 or x1 < 2 or y1 < 2 or x2 > W - 2 or y2 > H - 2:
        return None  # too small, or cut by the frame's edge
    if kp[[NOSE, L_ANK, R_ANK], 2].min() < 0.25:
        return None  # head or feet missing
    a = yaw(kp)
    if a is None:
        return None
    crop = cv2.cvtColor(img[int(y1) : int(y2), int(x1) : int(x2)], cv2.COLOR_BGR2GRAY)
    crop = cv2.resize(crop, (max(8, int(crop.shape[1] * 256 / crop.shape[0])), 256))
    sharp = float(cv2.Laplacian(crop, cv2.CV_32F).var())
    complete = float(kp[:, 2].mean())
    return {"h": float(h), "sharp": sharp, "complete": complete, "yaw": a,
            "value": h * min(sharp / 150.0, 1.5) * complete}


def who(p: dict, img: np.ndarray, kits: dict, points: list[dict], fps: float) -> str | None:
    t = p["frame"] / fps
    for pt in points:
        if pt["start"] - 0.5 <= t <= pt["end_s"] + 0.5 and pt.get("nearPlayer"):
            near = pt["nearPlayer"]
            return near if p["side"] == "near" else ("B" if near == "A" else "A")
    v = kit(img, p)
    if v is None:
        return None
    dA, dB = np.linalg.norm(v - kits["A"]), np.linalg.norm(v - kits["B"])
    if abs(dA - dB) / (dA + dB + 1e-6) < 0.15:
        return None
    return "A" if dA < dB else "B"


def cut_out(img: np.ndarray, plate: np.ndarray, box: list[float]) -> np.ndarray:
    """The player as RGBA: differs-from-the-empty-court, refined by GrabCut."""
    H, W = img.shape[:2]
    x1, y1, x2, y2 = box
    pw, ph = 0.25 * (x2 - x1), 0.08 * (y2 - y1)
    xa, ya = int(max(0, x1 - pw)), int(max(0, y1 - ph))
    xb, yb = int(min(W, x2 + pw)), int(min(H, y2 + ph))
    crop, bg = img[ya:yb, xa:xb], plate[ya:yb, xa:xb]
    diff = np.linalg.norm(cv2.GaussianBlur(crop, (5, 5), 0).astype(np.float32) - cv2.GaussianBlur(bg, (5, 5), 0).astype(np.float32), axis=2)
    mask = np.full(crop.shape[:2], cv2.GC_PR_BGD, np.uint8)
    mask[diff > 25] = cv2.GC_PR_FGD
    mask[diff > 55] = cv2.GC_FGD
    inner = np.zeros_like(mask, bool)
    inner[int(y1 - ya) : int(y2 - ya), int(x1 - xa) : int(x2 - xa)] = True
    mask[~inner] = cv2.GC_BGD
    try:
        bgd, fgd = np.zeros((1, 65), np.float64), np.zeros((1, 65), np.float64)
        cv2.grabCut(crop, mask, None, bgd, fgd, 4, cv2.GC_INIT_WITH_MASK)
    except cv2.error:
        pass
    alpha = np.where((mask == cv2.GC_FGD) | (mask == cv2.GC_PR_FGD), 255, 0).astype(np.uint8)
    # Keep the largest piece (the person), soften the edge a little.
    n, lab, stats, _ = cv2.connectedComponentsWithStats(alpha)
    if n > 1:
        alpha = np.where(lab == 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA])), 255, 0).astype(np.uint8)
    alpha = cv2.GaussianBlur(alpha, (3, 3), 0)
    return np.dstack([crop, alpha])


def pick(cands: list[dict], fps: float) -> list[dict]:
    """The best per direction, then the best of the rest, spread in time."""
    chosen: list[dict] = []
    far_enough = lambda c: all(abs(c["frame"] - o["frame"]) / fps >= MIN_GAP_S for o in chosen)  # noqa: E731
    by_value = sorted(cands, key=lambda c: -c["value"])
    for b in range(BINS):
        lo = -180 + b * 360 / BINS
        best = next((c for c in by_value if lo <= c["yaw"] < lo + 360 / BINS and far_enough(c)), None)
        if best:
            chosen.append(best)
    for c in by_value:
        if len(chosen) >= PER_PLAYER:
            break
        if c not in chosen and far_enough(c):
            chosen.append(c)
    return chosen


def contact_sheet(items: list[tuple[np.ndarray, str]], path: Path, cell: int = 220) -> None:
    cols = 8
    rows = max(1, (len(items) + cols - 1) // cols)
    sheet = np.full((rows * (cell + 24), cols * cell, 3), 40, np.uint8)
    for i, (rgba, label) in enumerate(items):
        r, c = divmod(i, cols)
        h, w = rgba.shape[:2]
        s = min((cell - 8) / h, (cell - 8) / w)
        im = cv2.resize(rgba, (max(1, int(w * s)), max(1, int(h * s))), interpolation=cv2.INTER_AREA)
        a = im[:, :, 3:4].astype(np.float32) / 255
        tile = np.full((cell, cell, 3), 70, np.uint8)
        oy, ox = (cell - im.shape[0]) // 2, (cell - im.shape[1]) // 2
        region = tile[oy : oy + im.shape[0], ox : ox + im.shape[1]]
        region[:] = (im[:, :, :3] * a + region * (1 - a)).astype(np.uint8)
        sheet[r * (cell + 24) : r * (cell + 24) + cell, c * cell : (c + 1) * cell] = tile
        cv2.putText(sheet, label, (c * cell + 4, r * (cell + 24) + cell + 17), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (230, 230, 230), 1)
    cv2.imwrite(str(path), sheet)


def main(prefix: str) -> None:
    meta, out, video = _paths(prefix)
    a = json.loads((out / "analysis.json").read_text())
    st = json.loads((out / "structure.json").read_text())
    cam = Camera.from_calibration(json.loads((out / "calibration.json").read_text()))
    fps = a["fps"]
    n_frames = int(a["durationS"] * fps)
    rallies = [(int(r["startS"] * fps), int(r["endS"] * fps)) for r in a["rallies"]]
    kits = {k: np.array(v) for k, v in st["kits"].items()}
    plate = cv2.imread(str(ROOT / ".cache" / "plates" / f"{out.name}.png"))

    dets = detections(out, video, cam, fps, n_frames, rallies)
    print(f"{len(dets)} detections; scoring", flush=True)

    # Pass 1: score every detection (one sequential read of the needed frames).
    by_frame: dict[int, list[dict]] = {}
    for p in dets:
        by_frame.setdefault(p["frame"], []).append(p)
    frames = sorted(by_frame)
    cands: dict[str, list[dict]] = {"A": [], "B": []}
    cap = cv2.VideoCapture(str(video))
    f, t0 = 0, time.time()
    for target in frames:
        while f < target:
            cap.grab()
            f += 1
        ok, img = cap.read()
        f += 1
        if not ok:
            break
        for p in by_frame[target]:
            s = score(img, p)
            if not s:
                continue
            w = who(p, img, kits, st["points"], fps)
            if w:
                cands[w].append({**s, "frame": p["frame"], "side": p["side"], "box": p["box"]})
    cap.release()
    print(f"scored in {time.time() - t0:.0f}s: A {len(cands['A'])}, B {len(cands['B'])} usable pictures", flush=True)

    # Pass 2: the album pictures, cut out.
    cap = cv2.VideoCapture(str(video))
    for who_, cs in cands.items():
        chosen = sorted(pick(cs, fps), key=lambda c: c["yaw"])
        d = out / "albums" / who_
        d.mkdir(parents=True, exist_ok=True)
        for old in d.glob("*.png"):
            old.unlink()
        sheet = []
        for i, c in enumerate(chosen):
            cap.set(cv2.CAP_PROP_POS_FRAMES, c["frame"])
            ok, img = cap.read()
            if not ok:
                continue
            rgba = cut_out(img, plate, c["box"])
            c["file"] = f"{i:02d}.png"
            cv2.imwrite(str(d / c["file"]), rgba)
            m, s = divmod(c["frame"] / fps, 60)
            sheet.append((rgba, f"{int(m)}:{s:04.1f} {c['side']} {c['yaw']:+.0f}deg {int(c['h'])}px"))
        (d / "album.json").write_text(json.dumps({"player": who_, "fps": fps, "pictures": chosen}, indent=1))
        contact_sheet(sheet, out / "albums" / f"{who_}.jpg")
        print(f"player {who_}: {len(chosen)} pictures -> {d}", flush=True)
    cap.release()


if __name__ == "__main__":
    main(sys.argv[1])
