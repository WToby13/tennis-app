"""Score the pipeline against hand labels from the labelling page.

    python -m ojo_replay.evaluate <match-id-prefix>

Labels (ml/labels/<id>.json, from viewer/label.html) mark each hit (and which
end it came from), faults and the end of each point. Only the stretches the
labeller actually watched are scored. Reported:

- hits: recall (labelled hits we fitted a shot for, within MATCH_S and from
  the same end) and precision (our shots inside watched time that match one);
- serves: the serving end, on points both found;
- points: labelled points we found a rally for;
- calls: on bounces tagged in or out (I / O in the labeller), what our fitted
  bounce nearest it (within MATCH_S) called. "close" is our "can't tell".
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MATCH_S = 0.4  # a fitted shot's start within this of the labelled contact


def points_from(events: list[dict]) -> list[list[dict]]:
    pts, cur = [], []
    for e in sorted(events, key=lambda e: e["t"]):
        cur.append(e)
        if e["type"] == "end":
            pts.append(cur)
            cur = []
    if cur:
        pts.append(cur)
    return pts


def main(prefix: str) -> None:
    lab_path = next((ROOT / "labels").glob(prefix + "*.json"))
    labels = json.loads(lab_path.read_text())
    mid = lab_path.stem
    a = json.loads((ROOT / "out" / "analysis" / mid / "analysis.json").read_text())
    watched = labels.get("reviewed", [])
    # The labeller only logs stretches played at speed, not frame-stepping or
    # skipping ahead through dead time, so its log undercounts. Tagging is
    # sequential: score from the first mark to the last.
    ts = [e["t"] for e in labels["events"]]
    if ts:
        watched = [[min(ts) - 3.0, max(ts) + 3.0]]

    def seen(t: float) -> bool:
        return any(lo <= t <= hi for lo, hi in watched)

    hits = [e for e in labels["events"] if e["type"] == "hit" and seen(e["t"])]
    # Hits (fitted shots plus classifier-confident cuts) when the run has them.
    if all("hits" in r for r in a["rallies"]):
        shots = [(h["t"], h["end"]) for r in a["rallies"] for h in r["hits"] if seen(h["t"])]
    else:
        shots = [(s["t0"], s["hitter"]) for r in a["rallies"] for s in r["shots"] if seen(s["t0"])]
    used = set()
    found = 0
    for h in hits:
        best = None
        for k, (t, end) in enumerate(shots):
            if k in used or end != h["end"] or abs(t - h["t"]) > MATCH_S:
                continue
            if best is None or abs(t - h["t"]) < abs(shots[best][0] - h["t"]):
                best = k
        if best is not None:
            used.add(best)
            found += 1
    recall = found / len(hits) if hits else None
    precision = len(used) / len(shots) if shots else None

    pts = [p for p in points_from(labels["events"]) if seen(p[0]["t"])]
    windows = [(r["startS"], r["endS"]) for r in a["rallies"]]
    pts_found = sum(any(lo - 1 <= p[0]["t"] <= hi + 1 for lo, hi in windows) for p in pts)

    serve_ok = serve_n = 0
    st_path = ROOT / "out" / "analysis" / mid / "structure.json"
    if st_path.exists():
        st = json.loads(st_path.read_text())
        for p in pts:
            serve = next((e for e in p if e["type"] == "hit"), None)
            if not serve:
                continue
            # Our point whose window holds the serve (a little slack: our window
            # can start just after contact, once the dribble and toss are cut).
            ours = next((q for q in st["points"] if q["start"] - 2.0 <= serve["t"] <= q.get("end_s", q["start"] + 30)), None)
            if ours and ours["serverEnd"] is not None:
                serve_n += 1
                serve_ok += ours["serverEnd"] == serve["end"]

    calls: dict[tuple[str, str], int] = {}
    ours_b = [(s["bounce"][0], s.get("landing")) for r in a["rallies"] for s in r["shots"] if s.get("bounce")]
    for e in labels["events"]:
        if e["type"] != "bounce" or not e.get("call") or not seen(e["t"]):
            continue
        near = min(ours_b, key=lambda b: abs(b[0] - e["t"]), default=None)
        got = near[1] if near and abs(near[0] - e["t"]) <= MATCH_S else "no bounce"
        calls[(e["call"], got)] = calls.get((e["call"], got), 0) + 1

    watched_s = sum(hi - lo for lo, hi in watched)
    pct = lambda x: "–" if x is None else f"{100 * x:.0f}%"  # noqa: E731
    print(f"[{mid}] watched {watched_s / 60:.1f} min; {len(hits)} labelled hits in {len(pts)} points")
    print(f"  hits: recall {pct(recall)} ({found}/{len(hits)}), precision {pct(precision)} ({len(used)}/{len(shots)})")
    print(f"  points found: {pts_found}/{len(pts)}")
    print(f"  serving end right: {serve_ok}/{serve_n}")
    if calls:
        for truth in ("in", "out"):
            row = {got: n for (t, got), n in calls.items() if t == truth}
            if row:
                print(f"  tagged {truth:3s} -> ours: " + ", ".join(f"{g} {n}" for g, n in sorted(row.items(), key=lambda x: -x[1])))


if __name__ == "__main__":
    main(sys.argv[1])
