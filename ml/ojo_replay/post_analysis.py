"""Send a match's analysis to the web app (shown on its watch page).

    OJO_APP_URL=https://… ANALYSIS_WORKER_SECRET=… \\
        python -m ojo_replay.post_analysis <match-id-prefix> [--dry-run | --out <dir>]

Builds MatchStats (web/lib/matchStats.ts) from out/analysis/<id>/ with the same
summary as the report, without the internal parts (timings, cost, comparison
with TwelveLabs), and posts it to /api/worker/videos/<uuid>/analysis.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from .analyze import FIT_VERSION
from .report import lands_elsewhere, summarise

ROOT = Path(__file__).resolve().parents[1]
INTERNAL = ("id", "title", "calibration", "compare", "detected", "timing", "cost", "settings")


def match_stats(prefix: str) -> tuple[str, dict]:
    meta = json.loads(next((ROOT / ".cache" / "matches").glob(prefix + "*.json")).read_text())
    out = ROOT / "out" / "analysis" / meta["id"][:8]
    a = json.loads((out / "analysis.json").read_text())
    if (out / "structure.json").exists():
        a["structure"] = json.loads((out / "structure.json").read_text())
    s = summarise(a)
    stats = {k: v for k, v in s.items() if k not in INTERNAL}
    stats["movement"] = movement(out, a, a.get("structure"))
    stats["version"] = FIT_VERSION
    stats["generatedAt"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    return meta["id"], stats


# Where players stood during play, binned on their own half of the court, every
# player drawn as if at the camera end (the far player's positions turned
# round), so both read the same way. Metres from the net: x across, y back.
CELL = 0.75
GRID_X = (-7.5, 7.5)
GRID_Y = (-16.5, 0.0)


def movement(out: Path, a: dict, st: dict | None) -> dict:
    """Counts of sampled player positions in play, per player (A / B, or the
    end when we don't know who's who) and per role (serving / receiving)."""
    import glob

    import numpy as np

    from .camera import Camera
    from .players import feet_pixel

    cam = Camera.from_calibration(json.loads((out / "calibration.json").read_text()))
    fps = a["fps"]
    point_of: dict[int, dict] = {}
    for p in (st or {}).get("points", []):
        for idx in p.get("rallies") or [p["rally"]]:
            point_of[idx] = p
    windows = [(int(r["startS"] * fps), int(r["endS"] * fps), r["idx"]) for r in a["rallies"]]
    nx = int(round((GRID_X[1] - GRID_X[0]) / CELL))
    ny = int(round((GRID_Y[1] - GRID_Y[0]) / CELL))
    grids: dict[str, np.ndarray] = {}
    seen = set()
    for f in glob.glob(str(out / "rallies" / "*c4.players.json")):
        for p in json.loads(Path(f).read_text())["players"]:
            key = (p["frame"], p["side"])
            if key in seen:
                continue
            seen.add(key)
            idx = next((k for lo, hi, k in windows if lo <= p["frame"] <= hi), None)
            if idx is None:
                continue
            uv = feet_pixel(np.array(p["box"]), np.array(p["keypoints"]))
            x, y = cam.to_ground(uv[None])[0][:2]
            if p["side"] == "far":
                x, y = -x, -y
            i, j = int((x - GRID_X[0]) / CELL), int((y - GRID_Y[0]) / CELL)
            if not (0 <= i < nx and 0 <= j < ny):
                continue
            pt = point_of.get(idx)
            if pt and pt.get("nearPlayer"):
                who = pt["nearPlayer"] if p["side"] == "near" else ("B" if pt["nearPlayer"] == "A" else "A")
            else:
                who = p["side"]
            end = pt.get("serverEnd") if pt else None
            role = "any" if end is None else ("serving" if end == p["side"] else "receiving")
            g = grids.setdefault(f"{who}:{role}", np.zeros((ny, nx), int))
            g[j, i] += 1
    return {"cell": CELL, "x0": GRID_X[0], "y0": GRID_Y[0], "nx": nx, "ny": ny,
            "grids": {k: v.ravel().tolist() for k, v in grids.items()}}


def build_tracks(prefix: str) -> dict:
    """What the watch page draws over the video: the ball by frame (inside rallies,
    in pixels of the source video), players' boxes by sampled frame with who they
    are, and each fitted bounce already projected to pixels."""
    import glob

    import numpy as np

    from . import rallies as RL
    from .camera import Camera

    meta = json.loads(next((ROOT / ".cache" / "matches").glob(prefix + "*.json")).read_text())
    out = ROOT / "out" / "analysis" / meta["id"][:8]
    a = json.loads((out / "analysis.json").read_text())
    st = json.loads((out / "structure.json").read_text()) if (out / "structure.json").exists() else None
    cam = Camera.from_calibration(json.loads((out / "calibration.json").read_text()))
    fps = a["fps"]
    z = np.load(out / "ball.npz")
    ball = RL.tracked(z["cands"], cam, fps)
    near_of: dict[int, str] = {}
    if st:
        for p in st["points"]:
            for idx in p.get("rallies", [p["rally"]]):
                near_of[idx] = p["nearPlayer"]

    def other(w):
        return "B" if w == "A" else "A"

    bf, bu, bv = [], [], []
    for r in a["rallies"]:
        for f in range(max(0, int((r["startS"] - 1) * fps)), min(len(ball), int((r["endS"] + 1) * fps))):
            if np.isfinite(ball[f, 0]):
                bf.append(f)
                bu.append(int(round(ball[f, 0])))
                bv.append(int(round(ball[f, 1])))
    pf, ps, pw, pb = [], [], [], []
    rally_of_frame = [(int(r["startS"] * fps), int(r["endS"] * fps), r["idx"]) for r in a["rallies"]]
    seen = set()
    for f in glob.glob(str(out / "rallies" / "*c4.players.json")):
        for p in json.loads(Path(f).read_text())["players"]:
            key = (p["frame"], p["side"])
            if key in seen:
                continue
            seen.add(key)
            idx = next((k for lo, hi, k in rally_of_frame if lo <= p["frame"] <= hi), None)
            if idx is None:
                continue
            near = near_of.get(idx)
            who = (near if p["side"] == "near" else other(near)) if near else ""
            pf.append(p["frame"])
            ps.append(p["side"][0])
            pw.append(who)
            pb.append([int(round(v)) for v in p["box"]])
    order = np.argsort(pf)
    bounces = []
    for r in a["rallies"]:
        near = near_of.get(r["idx"])
        for s in r["shots"]:
            if not s.get("bounce") or lands_elsewhere(s):
                continue
            t, x, y = s["bounce"]
            uv = cam.project(np.array([[x, y, 0.0]]))[0]
            if not np.isfinite(uv).all():
                continue
            who = (near if s["hitter"] == "near" else other(near)) if near else ""
            bounces.append({"t": round(t, 3), "u": int(round(uv[0])), "v": int(round(uv[1])),
                            "speed": round(s["speed_kmh"]), "landing": s.get("landing"), "who": who})
    return {
        "fps": fps, "width": cam.width, "height": cam.height,
        "ball": {"f": bf, "u": bu, "v": bv},
        "players": {"f": [pf[i] for i in order], "side": [ps[i] for i in order],
                    "who": [pw[i] for i in order], "box": [pb[i] for i in order]},
        "bounces": sorted(bounces, key=lambda b: b["t"]),
    }


def build_segments(prefix: str) -> list[dict]:
    """The rally breakdown in the shape the app reads (what TwelveLabs' smoothed
    output had): per point, its time span, game, server and receiver (player_1 =
    A, player_2 = B, the two kits), which end served, who was at the camera end,
    and how many shots."""
    meta = json.loads(next((ROOT / ".cache" / "matches").glob(prefix + "*.json")).read_text())
    out = ROOT / "out" / "analysis" / meta["id"][:8]
    a = json.loads((out / "analysis.json").read_text())
    st_path = out / "structure.json"
    if not st_path.exists():
        return []
    st = json.loads(st_path.read_text())
    slot = {"A": "player_1", "B": "player_2", None: None}
    hits_of = {r["idx"]: len(r.get("hits", r["shots"])) for r in a["rallies"]}
    segs = []
    for p in st["points"]:
        server = slot.get(p.get("server"))
        receiver = None if server is None else ("player_2" if server == "player_1" else "player_1")
        near = slot.get(p.get("nearPlayer"))
        shots = sum(hits_of.get(i, 0) for i in p.get("rallies", [p["rally"]]))
        segs.append({
            "startS": round(p["start"], 2),
            "endS": round(p["end_s"], 2),
            "metadata": {
                "game": None if p.get("game") is None else p["game"] + 1,
                "server": server,
                "receiver": receiver,
                "serving_side": p.get("serverEnd"),
                "near_player": near,
                "near_role": None if server is None else ("serving" if server == near else "receiving"),
                "shots": shots,
                "times_ball_was_hit": shots,
                "second_serve": bool(p.get("fault")),
                "source": "ojo",
            },
        })
    return segs


def main(prefix: str, *flags: str) -> None:
    video_id, stats = match_stats(prefix)
    tracks = build_tracks(prefix)
    segments = build_segments(prefix)
    body = json.dumps({**stats, "tracks": tracks, "segments": segments}).encode()
    print(f"{video_id}: {stats.get('hits', len(stats['shots']))} shots ({len(stats['shots'])} fitted), "
          f"{len(stats['rallies'])} rallies, {len(stats['games'] or [])} games, "
          f"{len(tracks['ball']['f'])} ball frames, {len(body) / 1e3:.0f} kB")
    if "--dry-run" in flags:
        return
    if "--out" in flags:  # for the web app's MATCH_STATS_DIR in development
        d = Path(flags[flags.index("--out") + 1])
        d.mkdir(parents=True, exist_ok=True)
        (d / f"{video_id}.json").write_text(json.dumps(stats))
        (d / f"{video_id}.tracks.json").write_text(json.dumps(tracks))
        (d / f"{video_id}.segments.json").write_text(json.dumps(segments))
        print("wrote", d / f"{video_id}.json", "and .tracks.json")
        return
    req = urllib.request.Request(
        f"{os.environ['OJO_APP_URL'].rstrip('/')}/api/worker/videos/{video_id}/analysis",
        data=body, method="POST",
        headers={"content-type": "application/json", "authorization": f"Bearer {os.environ['ANALYSIS_WORKER_SECRET']}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            print("saved:", r.read().decode()[:200])
    except urllib.error.HTTPError as e:
        print(f"{e.code}: {e.read().decode()[:200]}")


if __name__ == "__main__":
    main(*sys.argv[1:])
