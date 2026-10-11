"""Hit or not: a learned decision for each place the ball track was cut.

The physics split (ball3d) proposes cuts: places where one flight ends and the
next begins. Which are hits (and by which end) was decided by rules: the
along-court velocity reversing, alternation, the ball at the hitter. Against a
hand-tagged match those rules kept 62% of hits at 46% precision, and the 3D fit
filter that followed bought precision with recall (44% at 79%).

Here every cut is described by what's around it, the ball's motion and where
the players are, and a small classifier trained on hand tags decides.
"""

from __future__ import annotations

import numpy as np

FEATURES = [
    "speed_before", "speed_after", "turn_deg", "flip_v", "v_after", "v_before", "seen_before", "seen_after",
    "near_d", "near_dx", "near_dy", "far_d", "far_dx", "far_dy", "near_seen", "far_seen",
    "phys_near", "phys_far", "phys_bounce", "rule_near", "rule_far", "dt_prev", "dt_next", "ball_y",
]


def _slope(frames: np.ndarray, uv: np.ndarray) -> np.ndarray | None:
    if len(frames) < 3:
        return None
    t = frames - frames.mean()
    return np.array([np.polyfit(t, uv[:, k], 1)[0] for k in (0, 1)])


def features(f: int, ball: np.ndarray, players: dict[int, dict[str, dict]], phys: str, rule: str,
             dt_prev: float, dt_next: float, width: int, k: int = 6, offset: int = 0) -> np.ndarray:
    """One cut at frame f. `ball` holds the track from frame `offset` on (a
    slice is enough). Pixel quantities are scaled to a 1920-wide frame."""
    players = {fr - offset: v for fr, v in players.items()} if offset else players
    f = f - offset
    scale = 1920.0 / width
    idx_b = np.arange(max(0, f - k), f)
    idx_a = np.arange(f + 1, min(len(ball), f + k + 1))
    ob = idx_b[np.isfinite(ball[idx_b, 0])]
    oa = idx_a[np.isfinite(ball[idx_a, 0])]
    vb = _slope(ob.astype(float), ball[ob]) if len(ob) else None
    va = _slope(oa.astype(float), ball[oa]) if len(oa) else None
    sb = float(np.linalg.norm(vb)) * scale if vb is not None else -1.0
    sa = float(np.linalg.norm(va)) * scale if va is not None else -1.0
    if vb is not None and va is not None and sb > 0.5 and sa > 0.5:
        turn = float(np.degrees(np.arccos(np.clip(vb @ va / (np.linalg.norm(vb) * np.linalg.norm(va)), -1, 1))))
        flip = float(vb[1] * va[1] < 0)
    else:
        turn, flip = -1.0, -1.0
    # Ball position at the cut: the nearest tracked frame.
    seen = np.flatnonzero(np.isfinite(ball[max(0, f - 3): f + 4, 0]))
    pos = ball[max(0, f - 3) + seen[np.argmin(np.abs(seen - min(3, f)))]] if len(seen) else None
    out = [sb, sa, turn, flip,
           float(va[1]) * scale if va is not None else 0.0, float(vb[1]) * scale if vb is not None else 0.0,
           len(ob) / max(1, len(idx_b)), len(oa) / max(1, len(idx_a))]
    for side in ("near", "far"):
        p = None
        for df in (0, -1, 1, -2, 2, -3, 3, -4, 4, -5, 5, -6, 6):
            p = players.get(f + df, {}).get(side)
            if p:
                break
        if p is None or pos is None:
            out += [9.0, 9.0, 9.0, 0.0]
            continue
        x1, y1, x2, y2 = p["box"]
        h = max(y2 - y1, 1.0)
        dx = (pos[0] - (x1 + x2) / 2) / h
        dy = (pos[1] - (y1 + y2) / 2) / h
        out += [float(np.hypot(dx, dy)), float(abs(dx)), float(dy), 1.0]
    # near_seen/far_seen were appended per side above; reorder to FEATURES.
    near = out[8:12]
    far = out[12:16]
    out = out[:8] + near[:3] + far[:3] + [near[3], far[3]]
    out += [float(phys == "near"), float(phys == "far"), float(phys == "bounce"),
            float(rule == "near"), float(rule == "far"), min(dt_prev, 5.0), min(dt_next, 5.0),
            float(pos[1]) * scale if pos is not None else -1.0]
    return np.array(out, dtype=float)


# ------------------------------------------------------------------ model

MODEL = __import__("pathlib").Path(__file__).resolve().parents[1] / "models" / "hits.joblib"
# Fitted shots are kept regardless; a cut without one counts as a hit when the
# classifier is at least this sure. Cross-validated on a tagged match: recall
# 44% -> 62%, precision 79% -> 75%.
THRESHOLD = 0.8


def load():
    import joblib

    return joblib.load(MODEL) if MODEL.exists() else None


def decide(model, cuts: list[tuple[float, str, str]], ball: np.ndarray, offset: int,
           players: dict[int, dict[str, dict]], fps: float, width: int,
           fitted: list[tuple[float, str]]) -> list[dict]:
    """Hits in one rally: the fitted shots, plus cuts the classifier is sure
    of that no fitted shot already covers."""
    hits = [{"t": round(t, 3), "end": e, "fitted": True} for t, e in fitted]
    if model is None:
        return hits
    rows, times = [], []
    for j, (t, phys, rule) in enumerate(cuts):
        if phys in ("start", "end") or any(abs(t - h["t"]) <= 0.4 for h in hits):
            continue
        dtp = t - cuts[j - 1][0] if j > 0 else 5.0
        dtn = cuts[j + 1][0] - t if j + 1 < len(cuts) else 5.0
        rows.append(features(int(round(t * fps)), ball, players, phys, rule, dtp, dtn, width, offset=offset))
        times.append(t)
    if rows:
        X = np.array(rows)
        p_hit = model["hit"].predict_proba(X)[:, 1]
        p_far = model["end"].predict_proba(X)[:, 1]
        for t, ph, pf in zip(times, p_hit, p_far):
            if ph >= THRESHOLD:
                hits.append({"t": round(t, 3), "end": "far" if pf >= 0.5 else "near", "fitted": False, "p": round(float(ph), 2)})
    return sorted(hits, key=lambda h: h["t"])


def training_rows(mid: str):
    """Features and tags for every cut in the tagged span of a match: from the
    analysis run's saved cuts, its ball track and players, and ml/labels/<mid>.json."""
    import glob
    import json
    from pathlib import Path

    from . import rallies as RL
    from .camera import Camera

    root = Path(__file__).resolve().parents[1]
    out = root / "out" / "analysis" / mid
    a = json.loads((out / "analysis.json").read_text())
    fps = a["fps"]
    cam = Camera.from_calibration(json.loads((out / "calibration.json").read_text()))
    z = np.load(out / "ball.npz")
    ball = RL.tracked(z["cands"], cam, fps)
    players: dict[int, dict[str, dict]] = {}
    for f in glob.glob(str(out / "rallies" / "*c4.players.json")):
        for p in json.loads(Path(f).read_text())["players"]:
            players.setdefault(p["frame"], {})[p["side"]] = p
    labels = json.loads((root / "labels" / f"{mid}.json").read_text())
    tagged = [e for e in labels["events"] if e["type"] == "hit"]
    lo = min(e["t"] for e in labels["events"]) - 3
    hi = max(e["t"] for e in labels["events"]) + 3
    X, y, far, group = [], [], [], []
    for r in a["rallies"]:
        cuts = r.get("cuts", [])
        for j, (t, phys, rule) in enumerate(cuts):
            if not (lo <= t <= hi) or phys in ("start", "end"):
                continue
            dtp = t - cuts[j - 1][0] if j > 0 else 5.0
            dtn = cuts[j + 1][0] - t if j + 1 < len(cuts) else 5.0
            X.append(features(int(round(t * fps)), ball, players, phys, rule, dtp, dtn, cam.width))
            m = [h for h in tagged if abs(h["t"] - t) <= 0.4]
            y.append(int(bool(m)))
            far.append(int(min(m, key=lambda h: abs(h["t"] - t))["end"] == "far") if m else -1)
            group.append(f"{mid}:{r['idx']}")
    return np.array(X), np.array(y), np.array(far), np.array(group)


def train(mids: list[str]) -> None:
    """Fit the hit and end classifiers on every tagged match given; save to MODEL."""
    import joblib
    from sklearn.ensemble import HistGradientBoostingClassifier

    parts = [training_rows(m) for m in mids]
    X = np.vstack([p[0] for p in parts])
    y = np.concatenate([p[1] for p in parts])
    far = np.concatenate([p[2] for p in parts])
    hit = HistGradientBoostingClassifier(max_iter=200, learning_rate=0.05, max_leaf_nodes=15, min_samples_leaf=8).fit(X, y)
    pos = y == 1
    end = HistGradientBoostingClassifier(max_iter=150, learning_rate=0.05, max_leaf_nodes=7, min_samples_leaf=5).fit(X[pos], far[pos])
    MODEL.parent.mkdir(exist_ok=True)
    joblib.dump({"hit": hit, "end": end, "features": FEATURES, "trainedOn": mids, "cuts": int(len(y)), "hits": int(y.sum())}, MODEL)
    print(f"trained on {', '.join(mids)}: {len(y)} cuts, {int(y.sum())} near tagged hits -> {MODEL}")


if __name__ == "__main__":
    import sys

    if sys.argv[1] == "train":
        train(sys.argv[2:])
