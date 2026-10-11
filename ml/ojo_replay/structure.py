"""Who is who, who served, and the games: the match's structure from measurements.

    python -m ojo_replay.structure <match-id-prefix>

Reads out/analysis/<id>/analysis.json and the cached per-rally players, writes
structure.json next to it. Three steps:

1. Identity. Each player's kit (shirt and shorts colour, from the pose
   keypoints' torso and hips) is sampled a few times per rally. Two players
   wear two kits, so each rally is either (near = A, far = B) or the reverse,
   whichever matches the two running references better; the references are
   re-estimated from the assignments until they settle.

2. Serve. The first shot of a rally, if the fit caught it, says which end
   served and from which side (deuce or ad, from where across the court it was
   hit). If the serve itself was missed, the first ball seen next to a player,
   then where the players stand (the server behind the baseline, near the
   middle), stand in.

3. Games. Tennis is rigid: one server per game, alternating; the first point of
   a game is served from the deuce side and the sides alternate; ends change
   after games 1, 3, 5, ... A dynamic programme over the points finds the game
   boundaries and the two starting unknowns (who served first, who started at
   the camera end) that disagree least with the per-point measurements. This
   is the same idea as web/lib/twelvelabs/smooth.ts, fed measured serves and
   kits instead of a video model's guesses.
"""

from __future__ import annotations

import glob
import json
import sys
from pathlib import Path

import cv2
import numpy as np

from .camera import HALF_LENGTH
from .report import on_this_court

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / ".cache"

# COCO keypoints: shoulders 5, 6; hips 11, 12; knees 13, 14.
SHOULDERS, HIPS, KNEES = (5, 6), (11, 12), (13, 14)
SAMPLES_PER_SIDE = 5


# ------------------------------------------------------------------ 1. kits


def _region(img: np.ndarray, kp: np.ndarray, top: tuple, bottom: tuple, box) -> np.ndarray | None:
    """Pixels between two keypoint pairs (e.g. shoulders to hips), as Lab."""
    pts = kp[list(top) + list(bottom)]
    if (pts[:, 2] < 0.3).any():
        return None
    x1, x2 = pts[:, 0].min(), pts[:, 0].max()
    y1, y2 = pts[:2, 1].mean(), pts[2:, 1].mean()
    if y2 - y1 < 3:
        return None
    # Inset a little: the edges are background.
    w = x2 - x1
    x1, x2 = x1 + 0.15 * w, x2 - 0.15 * w
    y1, y2 = y1 + 0.1 * (y2 - y1), y2 - 0.1 * (y2 - y1)
    H, W = img.shape[:2]
    xa, xb = int(max(0, x1)), int(min(W, max(x2, x1 + 2)))
    ya, yb = int(max(0, y1)), int(min(H, max(y2, y1 + 2)))
    crop = img[ya:yb, xa:xb]
    if crop.size < 3 * 6:
        return None
    return cv2.cvtColor(crop, cv2.COLOR_BGR2Lab).reshape(-1, 3).astype(np.float32)


def kit(img: np.ndarray, player: dict) -> np.ndarray | None:
    """Shirt and shorts colour: median Lab of the torso and of the hips-to-knees."""
    kp = np.array(player["keypoints"], float)
    torso = _region(img, kp, SHOULDERS, HIPS, player["box"])
    legs = _region(img, kp, HIPS, KNEES, player["box"])
    if torso is None:
        return None
    t = np.median(torso, axis=0)
    l = np.median(legs, axis=0) if legs is not None else t
    return np.concatenate([t, l])


def rally_kits(video: Path, players: list[dict]) -> dict[str, np.ndarray | None]:
    """Median kit per end over a few frames spread through the rally."""
    cap = cv2.VideoCapture(str(video))
    out: dict[str, np.ndarray | None] = {}
    for side in ("near", "far"):
        mine = [p for p in players if p["side"] == side and p["conf"] > 0.4]
        if not mine:
            out[side] = None
            continue
        pick = [mine[i] for i in np.linspace(0, len(mine) - 1, min(SAMPLES_PER_SIDE, len(mine))).astype(int)]
        vecs = []
        for p in pick:
            cap.set(cv2.CAP_PROP_POS_FRAMES, p["frame"])
            ok, img = cap.read()
            if ok:
                v = kit(img, p)
                if v is not None:
                    vecs.append(v)
        out[side] = np.median(vecs, axis=0) if vecs else None
    cap.release()
    return out


def identities(kits: list[dict[str, np.ndarray | None]]) -> tuple[list[float | None], np.ndarray, np.ndarray]:
    """P(near player is A) per rally, and the two kits A and B."""
    both = [k for k in kits if k["near"] is not None and k["far"] is not None]
    if not both:
        return [None] * len(kits), np.zeros(6), np.zeros(6)
    # Seed with the rally whose two kits differ most (the clearest view of both).
    seed = max(both, key=lambda k: np.linalg.norm(k["near"] - k["far"]))
    A, B = seed["near"].copy(), seed["far"].copy()
    orient = [None] * len(kits)
    for _ in range(8):
        votes_a, votes_b = [], []
        for i, k in enumerate(kits):
            same = swap = 0.0
            if k["near"] is not None:
                same += np.linalg.norm(k["near"] - A)
                swap += np.linalg.norm(k["near"] - B)
            if k["far"] is not None:
                same += np.linalg.norm(k["far"] - B)
                swap += np.linalg.norm(k["far"] - A)
            if k["near"] is None and k["far"] is None:
                orient[i] = None
                continue
            orient[i] = float(1 / (1 + np.exp(-(swap - same) / 8.0)))  # Lab units
            near_is_a = orient[i] >= 0.5
            if k["near"] is not None:
                (votes_a if near_is_a else votes_b).append(k["near"])
            if k["far"] is not None:
                (votes_b if near_is_a else votes_a).append(k["far"])
        if votes_a and votes_b:
            A, B = np.median(votes_a, axis=0), np.median(votes_b, axis=0)
    return orient, A, B


# ----------------------------------------------------------------- 2. serve


def _side(x: float, near: bool) -> str:
    """Deuce or ad, from where across the court the serve was hit. The near
    server faces +Y, so their right (deuce) is +X; the far server's is -X."""
    return "deuce" if (x > 0) == near else "ad"


def serve(rally: dict, players: list[dict], fps: float) -> dict:
    """Which end served and from which side, with what evidence."""
    shots = rally["shots"]
    if shots and shots[0]["t0"] - rally["startS"] < 2.5:
        s = shots[0]
        near = s["hitter"] == "near"
        return {"end": s["hitter"], "side": _side(s["p0"][0], near), "from": "first shot", "conf": 0.9}
    # Where the players stand in the first second: the server is behind their
    # baseline, near the middle; the receiver is usually further across.
    t_end = (rally["startS"] + 1.2) * fps
    early = [p for p in players if p["frame"] <= t_end]
    best = None
    for p in early:
        x, y = p["feet"]
        behind = abs(y) - HALF_LENGTH
        if behind > -0.5 and abs(x) < 3.5:
            score = behind - 0.3 * abs(x)
            if best is None or score > best[0]:
                best = (score, p)
    if best:
        p = best[1]
        near = p["side"] == "near"
        return {"end": p["side"], "side": _side(p["feet"][0], near), "from": "stance", "conf": 0.6}
    return {"end": None, "side": None, "from": None, "conf": 0.0}


# ----------------------------------------------------------------- 3. games

MAX_POINTS = 40  # longest game considered (deuce games run long)


def fit_games(points: list[dict], gaps: list[float]) -> dict:
    """Game boundaries and match phase that best explain the per-point evidence.

    Per point: serve end (near/far), serve side (deuce/ad), P(near is A).
    Unknowns: who serves game 0 (A/B), who is near in game 0 (A/B), and where
    each game ends. Game g's server alternates; the ends change after games
    1, 3, 5, ... (before games 2, 4, 6, ...). A point's index within its game
    fixes its side (deuce first).
    """
    n = len(points)
    best = None
    for a_serves_first in (True, False):
        for a_near_first in (True, False):
            # cost[j][g4]: best cost with the current point at index j of a
            # game whose number mod 4 is g4.
            INF = 1e18
            cost = np.full((MAX_POINTS, 4), INF)
            back = np.zeros((n, MAX_POINTS, 4, 2), dtype=int)  # previous (j, g4)
            for i, pt in enumerate(points):
                new = np.full((MAX_POINTS, 4), INF)
                for g4 in range(4):
                    for j in range(MAX_POINTS):
                        if i == 0:
                            prev = 0.0 if (j == 0 and g4 == 0) else INF
                            pj, pg = 0, 0
                        elif j > 0:
                            prev, pj, pg = cost[j - 1, g4], j - 1, g4
                        else:
                            # A new game: the last one had at least 3 points
                            # seen (a game is 4+, and the odd rally is missed).
                            g_prev = (g4 - 1) % 4
                            cands = cost[2:, g_prev]
                            k = int(np.argmin(cands))
                            prev, pj, pg = cands[k], k + 2, g_prev
                            # Ends change after the 1st, 3rd, 5th... game (an
                            # even index): a long pause there fits, a long
                            # pause between other games is a little odd.
                            changeover = g_prev % 2 == 0
                            if gaps[i] > 50:
                                prev += -1.0 if changeover else 0.5
                        if prev >= INF:
                            continue
                        c = prev + _point_cost(pt, j, g4, a_serves_first, a_near_first)
                        if j > 0 and gaps[i] > 75:
                            c += 1.5  # a changeover-length pause inside a game
                        if c < new[j, g4]:
                            new[j, g4] = c
                            back[i, j, g4] = (pj, pg)
                cost = new
            j, g4 = np.unravel_index(int(np.argmin(cost)), cost.shape)
            total = float(cost[j, g4])
            if best is None or total < best[0]:
                best = (total, a_serves_first, a_near_first, back, (int(j), int(g4)))
    total, a_first, a_near, back, (j, g4) = best
    # Trace back the games.
    idx = [None] * n
    for i in range(n - 1, -1, -1):
        idx[i] = (j, g4)
        j, g4 = back[i, j, g4]
    game = -1
    out = []
    for i, (j, g4) in enumerate(idx):
        if j == 0:
            game += 1
        server_a = (game % 2 == 0) == a_first
        changeovers = (game + 1) // 2
        near_a = a_near if changeovers % 2 == 0 else not a_near
        out.append({
            "game": game, "pointInGame": int(j),
            "server": "A" if server_a else "B",
            "serverEnd": "near" if server_a == near_a else "far",
            "side": "deuce" if j % 2 == 0 else "ad",
            "nearPlayer": "A" if near_a else "B",
        })
    return {"cost": total, "points": out, "games": game + 1}


def _point_cost(pt: dict, j: int, g4: int, a_first: bool, a_near: bool) -> float:
    server_a = (g4 % 2 == 0) == a_first
    changeovers = (g4 + 1) // 2  # mod-4 game number -> changeovers so far, mod 2
    near_a = a_near if changeovers % 2 == 0 else not a_near
    end = "near" if server_a == near_a else "far"
    side = "deuce" if j % 2 == 0 else "ad"
    c = 0.0
    if pt["end"] is not None and pt["end"] != end:
        c += 3.0 * pt["conf"]
    if pt["side"] is not None and pt["side"] != side:
        c += 1.2 * pt["conf"]
    if pt["pNearA"] is not None:
        p = pt["pNearA"] if near_a else 1 - pt["pNearA"]
        c += -np.log(max(p, 0.02)) * 1.5
    return c


# ------------------------------------------------------------------ driver


def main(prefix: str) -> None:
    meta_path = next((CACHE / "matches").glob(prefix + "*.json"))
    mid = json.loads(meta_path.read_text())["id"][:8]
    out = ROOT / "out" / "analysis" / mid
    a = json.loads((out / "analysis.json").read_text())
    fps = a["fps"]
    video = CACHE / "videos" / f"{mid}.mov"
    rallies = [r for r in a["rallies"] if on_this_court(r)]
    files = sorted(glob.glob(str(out / "rallies" / "*c4.players.json")))
    starts = {int(Path(f).name.split("-")[0]): f for f in files}

    entries, kits = [], []
    for r in rallies:
        first = int(r["startS"] * fps)
        key = min(starts, key=lambda s: abs(s - first)) if starts else None
        players = json.loads(Path(starts[key]).read_text())["players"] if key is not None and abs(key - first) < 5 else []
        sv = serve(r, players, fps)
        kits.append(rally_kits(video, players))
        entries.append({**sv, "start": r["startS"], "end_s": r["endS"], "rally": r["idx"], "shots": r["shots"]})
    # A first serve that missed (the serve alone, out or into the net) and the
    # second serve from the same end shortly after are one point.
    points, point_kits = [], []
    for i, (e, k) in enumerate(zip(entries, kits)):
        nxt = entries[i + 1] if i + 1 < len(entries) else None
        lone_miss = len(e["shots"]) == 1 and e["shots"][0].get("landing") in ("out", "net") and e["from"] == "first shot"
        if lone_miss and nxt and nxt["start"] - e["end_s"] < 30 and nxt["end"] in (e["end"], None):
            nxt["fault"] = True
            nxt["faultRally"] = e["rally"]
            continue
        points.append(e)
        point_kits.append(k)
    kits = point_kits
    orient, A, B = identities(kits)
    for p, o in zip(points, orient):
        p["pNearA"] = o
    gaps = [999.0] + [points[i]["start"] - points[i - 1]["end_s"] for i in range(1, len(points))]
    fit = fit_games(points, gaps)
    result = {
        "kits": {"A": A.round(1).tolist(), "B": B.round(1).tolist()},
        "games": fit["games"],
        "points": [{**{k: v for k, v in p.items() if k != "shots"}, **q} for p, q in zip(points, fit["points"])],
    }
    (out / "structure.json").write_text(json.dumps(result))

    # Agreement with TwelveLabs' (smoothed) labels on rallies both found.
    tl = a.get("twelvelabs", [])
    agree_end = agree_n = 0
    for p in result["points"]:
        r = next((r for r in rallies if r["idx"] == p["rally"]), None)
        m = next((t for t in tl if min(t["endS"], r["endS"]) - max(t["startS"], r["startS"]) > 1.0), None)
        if m and m["metadata"].get("serving_side") in ("near", "far"):
            agree_n += 1
            agree_end += m["metadata"]["serving_side"] == p["serverEnd"]
    measured = sum(p["end"] is not None for p in points)
    print(f"[{mid}] {len(points)} points ({sum(bool(p.get('fault')) for p in points)} after a first-serve fault), {fit['games']} games; serve measured on {measured} "
          f"({sum(p['from'] == 'first shot' for p in points)} from the first shot); kit seen on "
          f"{sum(o is not None for o in orient)}; serving end agrees with TwelveLabs on {agree_end}/{agree_n}")


if __name__ == "__main__":
    main(sys.argv[1])
