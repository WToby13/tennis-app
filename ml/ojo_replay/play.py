"""Play or not: is a stretch of ball movement part of a point, or the time between?

    python -m ojo_replay.play train <match-id-prefix> ...    # fit on hand-tagged matches
    python -m ojo_replay.play eval  <train-prefix> <test-prefix>   # held out

Rally detection (rallies.find) sees a tennis ball moving over the court. So
does feeding the ball to the server, knocking it back after a point, or
fetching it from the net: on two hand-tagged matches about a fifth of the
stretches found were between points. Two things tell them apart:

1. A point starts with a serve, and a serve looks like nothing else: the server
   behind their baseline near the middle, an arm above the head at contact, a
   hit from high up, landing in the diagonal service box.
2. Play has pace and movement: shots at rally speed, landing in the court,
   both players moving; a feed is slow and loopy, to someone standing still.

Each stretch gets features for both, and a small classifier fitted on the
labeller's tags (ml/labels/) says play or not. The structure step then builds
points only from play (structure.py), trimming a feed off a point's start or
end, and the report leaves the rest out of the shot map and the rallies.
"""

from __future__ import annotations

import glob
import json
import sys
from pathlib import Path

import numpy as np

from .camera import HALF_LENGTH, SINGLES

ROOT = Path(__file__).resolve().parents[1]
MODEL = ROOT / "models" / "play.joblib"
THRESHOLD = 0.35  # below this a stretch is "not play"; low on purpose: dropping real play costs more

FEATURES = [
    "dur", "hits", "shots", "speed_max", "speed_mean", "landed_in", "landed_out",
    "first_after_s", "first_speed", "first_height", "first_behind", "first_across", "first_box",
    "arm_up", "server_ready", "near_moved", "far_moved", "gap_before", "gap_after",
    "peak_height", "ball_seen",
]


def players_by_frame(out: Path) -> list[dict]:
    """Every player detection the analysis cached, in frame order."""
    seen = {}
    for f in glob.glob(str(out / "rallies" / "*c4.players.json")):
        for p in json.loads(Path(f).read_text())["players"]:
            seen[(p["frame"], p["side"])] = p
    return sorted(seen.values(), key=lambda p: p["frame"])


def _arm_up(p: dict) -> bool:
    """A wrist above the head: the serve's toss and contact (or a smash)."""
    kp = p.get("keypoints")
    if not kp:
        return False
    nose, lw, rw = kp[0], kp[9], kp[10]
    head_y = nose[1] if nose[2] > 0.3 else p["box"][1] + 0.12 * (p["box"][3] - p["box"][1])
    return any(w[2] > 0.3 and w[1] < head_y for w in (lw, rw))


SERVE_GAP_S = 7.0  # a serve is an arm-up hit after this long with no hit (3.5 and 5 split more real points)
SERVE_LEAD_S = 1.0  # a point starts this long before the serve's contact (the toss)
END_AFTER_S = 2.5  # and ends this long after its last hit (the ball's last flight and bounce)
SERVE_STANCE = True  # and the server stands behind their baseline


def hits_with_arms(a: dict, players: list[dict]) -> list[dict]:
    """Every hit in the match, in time order, with whether the hitter's arm was
    above their head at contact."""
    fps = a["fps"]
    frames = np.array([p["frame"] for p in players]) if players else np.zeros(0)
    out = []
    for r in a["rallies"]:
        for h in r.get("hits", []):
            arm, behind = False, False
            if len(frames):
                lo, hi = np.searchsorted(frames, [(h["t"] - 0.8) * fps, (h["t"] + 0.3) * fps])
                mine = [p for p in players[lo:hi] if p["side"] == h["end"]]
                arm = any(_arm_up(p) for p in mine)
                behind = any(p.get("feet") and abs(p["feet"][1]) > HALF_LENGTH - 0.6 for p in mine)
            out.append({**h, "arm": arm, "behind": behind, "rally": r["idx"]})
    return sorted(out, key=lambda h: h["t"])


def points(a: dict, players: list[dict]) -> list[dict]:
    """The match's points: each starts with a serve and holds the play after it.

    The analysis's point windows group stretches of ball movement, so a window
    can hold the feed before a serve, the knock-back after a point, or several
    points run together. Each window is cut at its serves (an arm above the head
    at contact, after a pause in hitting); a stretch without a serve stays a
    point only with two or more hits (a real exchange whose serve the pose
    missed), and every point ends shortly after its last hit. Checked on two
    hand-tagged matches: false points 11 -> 1, all but one real point kept."""
    hits = hits_with_arms(a, players)
    spans = a.get("points") or [{"startS": r["startS"], "endS": r["endS"]} for r in a["rallies"]]
    out = []
    for sp in spans:
        s0, s1 = sp["startS"], sp["endS"]
        mine = [h for h in hits if s0 - 0.5 <= h["t"] <= s1 + 0.5]
        serves = [h for i, h in enumerate(mine)
                  if h["arm"] and (h["behind"] or not SERVE_STANCE) and (i == 0 or h["t"] - mine[i - 1]["t"] >= SERVE_GAP_S)]
        cuts = [h["t"] for h in serves]
        pieces = []
        if not cuts:
            pieces.append((s0, s1, mine, False))
        else:
            before = [h for h in mine if h["t"] < cuts[0] - 0.2]
            if before:
                pieces.append((s0, cuts[0] - SERVE_LEAD_S, before, False))
            for k, c in enumerate(cuts):
                nxt = cuts[k + 1] if k + 1 < len(cuts) else None
                inside = [h for h in mine if h["t"] >= c - 0.2 and (nxt is None or h["t"] < nxt - 0.2)]
                pieces.append((max(s0, c - SERVE_LEAD_S), (nxt - SERVE_LEAD_S) if nxt else s1, inside, True))
        for p0, p1, inside, served in pieces:
            if not served and len(inside) < 2:
                continue  # a feed, a knock-back, the ball fetched: not a point
            if inside:
                p1 = min(p1, inside[-1]["t"] + END_AFTER_S)
            if p1 - p0 >= 1.0:
                out.append({"startS": round(p0, 2), "endS": round(p1, 2), "served": served, "hits": len(inside)})
    return out


def features(a: dict, players: list[dict], ball: np.ndarray | None) -> list[dict]:
    """One row per stretch of play the analysis found (a["rallies"])."""
    from .report import serve_call

    fps = a["fps"]
    frames = np.array([p["frame"] for p in players]) if players else np.zeros(0)
    rs = a["rallies"]
    rows = []
    for i, r in enumerate(rs):
        s0, s1 = r["startS"], r["endS"]
        shots = r["shots"]
        good = [s for s in shots if not s.get("doubtful")]
        speeds = [s["speed_kmh"] for s in good]
        landed = [s.get("landing") for s in good if s.get("landing")]
        first = shots[0] if shots else None
        hit_t = r["hits"][0]["t"] if r.get("hits") else (first["t0"] if first else None)
        hit_end = r["hits"][0]["end"] if r.get("hits") else (first["hitter"] if first else None)
        # The hitter's arm at the first hit, and whether anyone stands like a
        # server (behind a baseline, near the middle) as the stretch starts.
        arm = 0.0
        if hit_t is not None and len(frames):
            lo, hi = np.searchsorted(frames, [(hit_t - 0.8) * fps, (hit_t + 0.3) * fps])
            arm = float(any(_arm_up(p) for p in players[lo:hi] if p["side"] == hit_end))
        ready = 0.0
        if len(frames):
            lo, hi = np.searchsorted(frames, [(s0 - 0.5) * fps, (s0 + 1.5) * fps])
            ready = float(any(abs(p["feet"][1]) > HALF_LENGTH - 0.5 and abs(p["feet"][0]) < SINGLES * 0.8
                              for p in players[lo:hi] if p.get("feet")))
        seen = 0.0
        if ball is not None:
            seg = ball[int(s0 * fps):int(s1 * fps)]
            seen = float(np.isfinite(seg[:, 0]).mean()) if len(seg) else 0.0
        peak = max((max(q[3] for q in s["samples"]) for s in good if s.get("samples")), default=0.0)
        rows.append({
            "idx": r["idx"], "startS": s0, "endS": s1,
            "dur": s1 - s0,
            "hits": len(r.get("hits", shots)),
            "shots": len(good),
            "speed_max": max(speeds, default=0.0),
            "speed_mean": float(np.mean(speeds)) if speeds else 0.0,
            "landed_in": sum(l in ("in", "close") for l in landed),
            "landed_out": sum(l in ("out", "net") for l in landed),
            "first_after_s": (hit_t - s0) if hit_t is not None else 9.0,
            "first_speed": first["speed_kmh"] if first else 0.0,
            "first_height": first["p0"][2] if first else 0.0,
            "first_behind": (abs(first["p0"][1]) - HALF_LENGTH) if first else -9.0,
            "first_across": abs(first["p0"][0]) if first else 9.0,
            "first_box": float(serve_call(first) in ("in", "close")) if first else 0.0,
            "arm_up": arm,
            "server_ready": ready,
            "near_moved": r["near"]["distance_m"] or 0.0,
            "far_moved": r["far"]["distance_m"] or 0.0,
            "gap_before": s0 - rs[i - 1]["endS"] if i else 60.0,
            "gap_after": rs[i + 1]["startS"] - s1 if i + 1 < len(rs) else 60.0,
            "peak_height": peak,
            "ball_seen": seen,
        })
    return rows


def _load(mid: str):
    from . import rallies as RL
    from .camera import Camera

    out = ROOT / "out" / "analysis" / mid
    a = json.loads((out / "analysis.json").read_text())
    cam = Camera.from_calibration(json.loads((out / "calibration.json").read_text()))
    ball = RL.tracked(np.load(out / "ball.npz")["cands"], cam, a["fps"])
    return a, players_by_frame(out), ball


def tagged_points(labels: dict) -> list[tuple[float, float]]:
    """(start, end) of each point the labeller tagged: first hit to "point over"."""
    pts, cur = [], []
    for e in sorted(labels["events"], key=lambda e: e["t"]):
        cur.append(e)
        if e["type"] == "end":
            hits = [x["t"] for x in cur if x["type"] == "hit"]
            if hits:
                pts.append((min(hits) - 0.5, e["t"] + 0.3))
            cur = []
    return pts


def labelled_rows(mid: str) -> list[dict]:
    """Feature rows inside the tagged span, each with y = 1 (play), 0 (between
    points) or None (straddles a point's edge: left out of training)."""
    labels = json.loads(next((ROOT / "labels").glob(mid + "*.json")).read_text())
    ts = [e["t"] for e in labels["events"]]
    lo, hi = min(ts) - 3, max(ts) + 3
    pts = tagged_points(labels)
    a, players, ball = _load(mid)
    rows = []
    for row in features(a, players, ball):
        if not (lo <= row["startS"] <= hi):
            continue
        ov = sum(max(0.0, min(row["endS"], b) - max(row["startS"], s)) for s, b in pts) / max(row["dur"], 1e-6)
        row["y"] = 1 if ov >= 0.5 else 0 if ov <= 0.15 else None
        row["mid"] = mid
        rows.append(row)
    return rows


def _xy(rows):
    X = np.array([[r[f] for f in FEATURES] for r in rows], float)
    return X, np.array([r["y"] for r in rows], int)


def _fit(rows):
    from sklearn.ensemble import HistGradientBoostingClassifier

    X, y = _xy([r for r in rows if r["y"] is not None])
    return HistGradientBoostingClassifier(max_depth=3, max_iter=150, learning_rate=0.08,
                                          min_samples_leaf=6, l2_regularization=1.0,
                                          class_weight="balanced").fit(X, y)


def train(*prefixes: str) -> None:
    import joblib

    rows = [r for p in prefixes for r in labelled_rows(p)]
    model = _fit(rows)
    MODEL.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump({"model": model, "features": FEATURES, "trained_on": list(prefixes)}, MODEL)
    n = [r for r in rows if r["y"] is not None]
    print(f"trained on {len(n)} stretches ({sum(r['y'] for r in n)} play, {sum(1 - r['y'] for r in n)} between points) -> {MODEL}")


def evaluate(train_prefix: str, test_prefix: str) -> None:
    model = _fit(labelled_rows(train_prefix))
    rows = [r for r in labelled_rows(test_prefix) if r["y"] is not None]
    X, y = _xy(rows)
    p = model.predict_proba(X)[:, 1]
    for th in (0.2, 0.35, 0.5):
        keep = p >= th
        print(f"[{test_prefix} held out] threshold {th}: between-points removed {int(((~keep) & (y == 0)).sum())}/{int((y == 0).sum())}, "
              f"real play lost {int(((~keep) & (y == 1)).sum())}/{int((y == 1).sum())}")


_cached = None


def scores(a: dict, players: list[dict], ball: np.ndarray | None) -> dict[int, float]:
    """Each stretch's probability of being play, by its idx (1.0 for all without a model)."""
    global _cached
    rows = features(a, players, ball)
    if not MODEL.exists():
        return {r["idx"]: 1.0 for r in rows}
    if _cached is None:
        import joblib

        _cached = joblib.load(MODEL)
    X = np.array([[r[f] for f in _cached["features"]] for r in rows], float)
    p = _cached["model"].predict_proba(X)[:, 1] if len(rows) else []
    return {r["idx"]: float(v) for r, v in zip(rows, p)}


if __name__ == "__main__":
    cmd, *args = sys.argv[1:]
    {"train": train, "eval": evaluate}[cmd](*args)
