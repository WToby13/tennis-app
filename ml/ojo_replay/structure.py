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


def _ball_at_player(ball: np.ndarray | None, players: list[dict], lo: int, hi: int) -> str | None:
    """Which end's player the ball is first seen beside in frames lo..hi: the
    server bounces it and tosses it before serving, so the ball's first stretch
    is next to them."""
    if ball is None or not players:
        return None
    frames = np.array([p["frame"] for p in players])
    votes = []
    for f in range(max(0, lo), min(len(ball), hi)):
        if not np.isfinite(ball[f, 0]):
            continue
        near = [p for p in players if abs(p["frame"] - f) <= 6]
        best = None
        for p in near:
            x1, y1, x2, y2 = p["box"]
            h = max(y2 - y1, 1.0)
            d = np.hypot(ball[f, 0] - (x1 + x2) / 2, ball[f, 1] - (y1 + y2) / 2) / h
            if d < 1.0 and (best is None or d < best[0]):
                best = (d, p["side"])
        if best:
            votes.append(best[1])
        if len(votes) >= 12:
            break
    if len(votes) < 4:
        return None
    near_votes = sum(v == "near" for v in votes)
    if near_votes >= 0.75 * len(votes):
        return "near"
    if near_votes <= 0.25 * len(votes):
        return "far"
    return None


def serve(rally: dict, players: list[dict], fps: float, ball: np.ndarray | None = None) -> dict:
    """Which end served and from which side, with what evidence.

    Checked against a hand-tagged match: the first fitted shot named the
    serving end right 13 times out of 13; where the players stand got it wrong
    about half the time, so it's only the last resort. In between: the ball,
    which is first seen beside the server (bouncing it, then the toss)."""
    shots = rally["shots"]
    if shots and shots[0]["t0"] - rally["startS"] < 2.5:
        s = shots[0]
        near = s["hitter"] == "near"
        return {"end": s["hitter"], "side": _side(s["p0"][0], near), "from": "first shot", "conf": 0.9}
    start = int(rally["startS"] * fps)
    end = _ball_at_player(ball, players, start - int(3 * fps), start + int(1.0 * fps))
    if end is not None:
        mine = [p for p in players if p["side"] == end and abs(p["frame"] - start) < 2 * fps]
        side = _side(float(np.median([p["feet"][0] for p in mine])), end == "near") if mine else None
        return {"end": end, "side": side, "from": "ball", "conf": 0.75}
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
        return {"end": p["side"], "side": _side(p["feet"][0], near), "from": "stance", "conf": 0.3}
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
    # Points: the analysis's point windows (stretches of play grouped, see
    # rallies.find), each with the shots and players of the stretches inside.
    # Every window counts, not only those with a shot landing on this court:
    # against a hand-tagged match that check dropped 24 real windows to remove 7
    # noise ones. Older runs without point windows use the stretches as points.
    from . import rallies as RL
    from .camera import Camera

    cam = Camera.from_calibration(json.loads((out / "calibration.json").read_text()))
    z = np.load(out / "ball.npz")
    ball = RL.tracked(z["cands"], cam, fps)
    files = sorted(glob.glob(str(out / "rallies" / "*c4.players.json")))
    windows = [(int(Path(f).name.split("-")[0]), int(Path(f).name.split("-")[1]), f) for f in files]
    stretches = a["rallies"]
    # Points start with a serve (play.points): feeds and knock-backs between
    # points are left out, and windows that ran points together are cut apart.
    from . import play

    spans = play.points(a, play.players_by_frame(out))

    entries, kits = [], []
    for k, span in enumerate(spans):
        s0, s1 = span["startS"], span["endS"]
        inside = [r for r in stretches if min(r["endS"], s1) - max(r["startS"], s0) > 0.2]
        shots = sorted((sh for r in inside for sh in r["shots"]), key=lambda sh: sh["t0"])
        lo, hi = int(s0 * fps), int(s1 * fps)
        players = sorted(
            {(p["frame"], p["side"]): p for a0, b0, f in windows if b0 >= lo and a0 <= hi
             for p in json.loads(Path(f).read_text())["players"] if lo <= p["frame"] <= hi}.values(),
            key=lambda p: p["frame"],
        )
        shots = [sh for sh in shots if s0 - 0.5 <= sh["t0"] <= s1]
        point = {"startS": s0, "endS": s1, "shots": shots}
        sv = serve(point, players, fps, ball)
        kits.append(rally_kits(video, players))
        entries.append({**sv, "start": s0, "end_s": s1, "rally": k, "rallies": [r["idx"] for r in inside], "shots": shots,
                        "served": span.get("served", False), "hits": span.get("hits")})
    # A first serve that missed (the serve alone, out or into the net) and the
    # second serve from the same end shortly after are one point. A serve seen
    # (play.points) with nothing hit after it, and another serve soon after,
    # is the same: the fault's bounce is rarely fitted, so "out" is rarely known.
    points, point_kits = [], []
    for i, (e, k) in enumerate(zip(entries, kits)):
        nxt = entries[i + 1] if i + 1 < len(entries) else None
        lone_miss = len(e["shots"]) == 1 and e["shots"][0].get("landing") in ("out", "net") and e["from"] == "first shot"
        unreturned = e["served"] and (e["hits"] or 0) <= 1 and len(e["shots"]) <= 1
        if (lone_miss and nxt and nxt["start"] - e["end_s"] < 30 and nxt["end"] in (e["end"], None)) or (
                unreturned and nxt and nxt["served"] and nxt["start"] - e["end_s"] < 12 and nxt["end"] in (e["end"], None)):
            nxt["fault"] = True
            nxt["faultRally"] = e["rally"]
            nxt["start"] = e["start"]  # the point (and its clip) starts at the first serve
            continue
        points.append(e)
        point_kits.append(k)
    kits = point_kits
    orient, A, B = identities(kits)
    # A is the player at the camera end on the first point their kit is seen:
    # the app's "Player 1 (starts near)", so the names the owner gives line up
    # with the breakdown, the shot analysis and the tracking alike.
    first = next((o for o in orient if o is not None), None)
    if first is not None and first < 0.5:
        orient = [None if o is None else 1.0 - o for o in orient]
        A, B = B, A
    for p, o in zip(points, orient):
        p["pNearA"] = o
    gaps = [999.0] + [points[i]["start"] - points[i - 1]["end_s"] for i in range(1, len(points))]
    fit = fit_games(points, gaps)
    # Casual sessions don't always follow match rules (one player serving many
    # points running, no changes of ends). Impose the game structure only where
    # the measurements bear it out; otherwise report what was measured per point.
    sure = [(p, q) for p, q in zip(points, fit["points"]) if p["end"] is not None and p["conf"] >= 0.75]
    agree = sum(p["end"] == q["serverEnd"] for p, q in sure) / len(sure) if sure else 0.0
    regular = len(sure) >= 6 and agree >= 0.8
    if not regular:
        for p, q in zip(points, fit["points"]):
            near_a = p["pNearA"] is None or p["pNearA"] >= 0.5
            q["nearPlayer"] = "A" if near_a else "B"
            q["serverEnd"] = p["end"]
            q["server"] = None if p["end"] is None else ("A" if (p["end"] == "near") == near_a else "B")
            q["side"] = p["side"]
            q["game"] = None
    result = {
        "kits": {"A": A.round(1).tolist(), "B": B.round(1).tolist()},
        "games": fit["games"] if regular else None,
        "regular": regular,
        "structureAgreement": round(agree, 2),
        "points": [{**{k: v for k, v in p.items() if k != "shots"}, **q} for p, q in zip(points, fit["points"])],
        "pointsFrom": "serves",
    }
    (out / "structure.json").write_text(json.dumps(result))

    # Agreement with TwelveLabs' (smoothed) labels on rallies both found.
    tl = a.get("twelvelabs", [])
    agree_end = agree_n = 0
    for p in result["points"]:
        m = next((t for t in tl if min(t["endS"], p["end_s"]) - max(t["startS"], p["start"]) > 1.0), None)
        if m and m["metadata"].get("serving_side") in ("near", "far"):
            agree_n += 1
            agree_end += m["metadata"]["serving_side"] == p["serverEnd"]
    measured = sum(p["end"] is not None for p in points)
    print(f"[{mid}] {'match play' if regular else 'not match play'} (structure agrees with {agree:.0%} of sure serves); "
          f"{len(points)} points ({sum(bool(p.get('fault')) for p in points)} after a first-serve fault), {fit['games'] if regular else '-'} games; serve measured on {measured} "
          f"({sum(p['from'] == 'first shot' for p in points)} first shot, {sum(p['from'] == 'ball' for p in points)} ball, {sum(p['from'] == 'stance' for p in points)} stance); kit seen on "
          f"{sum(o is not None for o in orient)}; serving end agrees with TwelveLabs on {agree_end}/{agree_n}")


if __name__ == "__main__":
    main(sys.argv[1])
