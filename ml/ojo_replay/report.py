"""Bundle every analysed match into one self-contained page: shot maps, speeds,
rallies, movement, the comparison with TwelveLabs, and what it cost to run.

    python -m ojo_replay.report [out.html]

Reads out/analysis/*/analysis.json, derives what the page shows (serves and
their service-box calls, per-player speeds, rally intensity), and inlines it
into viewer/analysis.html.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

from .camera import DOUBLES, HALF_LENGTH, SERVICE, SINGLES

ROOT = Path(__file__).resolve().parents[1]

# Measured on the M1 for this prototype, per stage; the cloud figures are what
# a single NVIDIA L4 (AWS g6.xlarge) should do with the same models in half
# precision, ~6-8x an M1 GPU for these networks. Estimates until benchmarked.
CLOUD = {"gpu_per_hour": 0.98, "gpu_speedup": 6.0, "spot_per_hour": 0.40, "twelvelabs_per_min": 0.0292}


def serve_call(shot: dict) -> str | None:
    """In / out / close for a serve, against the diagonal service box."""
    if not shot.get("bounce"):
        return "net" if shot.get("landing") == "net" else None
    _, x, y = shot["bounce"]
    server_x = shot["p0"][0]
    far_end = shot["hitter"] == "near"  # a near-end serve lands in the far half
    in_y = 0 <= y <= SERVICE if far_end else -SERVICE <= y <= 0
    # Cross-court: the box on the other side of the centre line from the server
    # (as seen from the server's own end; both ends share the court's x axis).
    want_left = server_x > 0
    in_x = (-SINGLES <= x <= 0) if want_left else (0 <= x <= SINGLES)
    # Distance to the nearest edge of the box, for a "close" call.
    xs = (-SINGLES, 0.0) if want_left else (0.0, SINGLES)
    ys = (0.0, SERVICE) if far_end else (-SERVICE, 0.0)
    dx = max(xs[0] - x, 0, x - xs[1])
    dy = max(ys[0] - y, 0, y - ys[1])
    inside_margin = min(abs(x - xs[0]), abs(x - xs[1]), abs(y - ys[0]), abs(y - ys[1]))
    margin = 0.35 if far_end else 0.15  # far bounces are placed less precisely
    if in_x and in_y:
        return "close" if inside_margin < margin else "in"
    return "close" if max(dx, dy) < margin else "out"


def rank(values: list[float]) -> np.ndarray:
    v = np.asarray(values, float)
    if len(v) < 2:
        return np.ones_like(v) * 0.5
    order = v.argsort().argsort()
    return order / (len(v) - 1)


def lands_elsewhere(shot: dict) -> bool:
    """A flight whose bounce is well off this court: a ball on the next court,
    or one being knocked back after the point. Not a shot of this match."""
    if not shot.get("bounce"):
        return False
    _, x, y = shot["bounce"]
    return abs(x) > DOUBLES + 3.0 or abs(y) > HALF_LENGTH + 6.0


def on_this_court(rally: dict) -> bool:
    """A rally played here: at least one fitted shot bounces on or near this
    court, or goes into its net. Balls on the next court fit, if at all, to
    bounces far outside it."""
    for s in rally["shots"]:
        if s.get("doubtful"):
            continue
        if s.get("landing") == "net":
            return True
        if s.get("bounce"):
            _, x, y = s["bounce"]
            if abs(x) < SINGLES + 3.0 and abs(y) < HALF_LENGTH + 2.0:
                return True
    return False


def compare(ours: list[dict], theirs: list[dict]) -> dict:
    tl = [(s["startS"], s["endS"]) for s in theirs]
    mine = [(r["startS"], r["endS"]) for r in ours]

    def ov(a, b):
        return min(a[1], b[1]) - max(a[0], b[0]) > 0.5 * min(a[1] - a[0], b[1] - b[0])

    return {
        "ours": len(mine), "twelvelabs": len(tl),
        "ours_matched": sum(any(ov(o, t) for t in tl) for o in mine),
        "twelvelabs_matched": sum(any(ov(t, o) for o in mine) for t in tl),
    }


def summarise(a: dict) -> dict:
    detected = a["rallies"]
    # Every stretch of play counts: against hand tags, requiring a shot to land
    # on this court dropped far more real play than noise. (Kept for the record:
    # on_this_court.)
    rallies = detected
    # A serve is the first contact of a point, not merely the first shot we
    # fitted in a stretch of play: when the serve itself wasn't fitted, that's
    # a rally ball, and judging it against the service box called it out.
    opener = {}  # stretch idx -> serving end (None: unknown), for stretches that open a point
    if a.get("structure"):
        for p in a["structure"]["points"]:
            first = (p.get("rallies") or [p["rally"]])[0]
            opener[first] = p.get("serverEnd")
    else:
        opener = {r["idx"]: None for r in rallies}

    def is_serve(r: dict, k: int, s: dict) -> bool:
        if k != 0 or r["idx"] not in opener:
            return False
        first = r.get("hits") or [{"t": s["t0"]}]
        end = opener[r["idx"]]
        return abs(first[0]["t"] - s["t0"]) <= 0.5 and (end is None or end == s["hitter"])

    shots = []
    for r in rallies:
        for k, s in enumerate(r["shots"]):
            serve = is_serve(r, k, s)
            shots.append({
                "rally": r["idx"], "serve": serve, "hitter": s["hitter"], "t": s["t0"],
                "speed": s["speed_kmh"], "bounce": s["bounce"][1:] if s.get("bounce") else None,
                "landing": serve_call(s) if serve else s.get("landing"),
                "net": s.get("net_clearance_m"),
                "doubt": s.get("doubtful") or ("lands off this court" if lands_elsewhere(s) else None),
            })
    # Intensity: shots, pace and how far both players ran per second, each as a
    # rank within the match, averaged. "High" is the top sixth with 4+ shots.
    rows = []
    for r in rallies:
        good = [s["speed_kmh"] for s in r["shots"] if not s.get("doubtful")]
        dur = max(r["endS"] - r["startS"], 1.0)
        run = (r["near"]["distance_m"] or 0) + (r["far"]["distance_m"] or 0)
        rows.append({
            # Shots in the rally: every hit found, fitted or not (speeds and
            # bounces come only from the fitted ones).
            "idx": r["idx"], "start": r["startS"], "end": r["endS"], "shots": len(r.get("hits", r["shots"])),
            "avgSpeed": round(float(np.mean(good)), 1) if good else None,
            "maxSpeed": round(float(np.max(good)), 1) if good else None,
            "run": round(run, 1), "runRate": run / dur,
            "nearRun": r["near"]["distance_m"], "farRun": r["far"]["distance_m"],
        })
    if rows:
        score = (rank([x["shots"] for x in rows]) + rank([x["avgSpeed"] or 0 for x in rows]) + rank([x["runRate"] for x in rows])) / 3
        cut = np.quantile(score, 5 / 6) if len(score) > 3 else 1.1
        for x, sc in zip(rows, score):
            x["intensity"] = round(float(sc), 3)
            x["high"] = bool(sc >= cut and x["shots"] >= 4)
            x.pop("runRate")

    struct = a.get("structure")
    who: dict[int, dict] = {}
    if struct:
        for p in struct["points"]:
            # A point holds one or more stretches of play (the analysis's rallies).
            for idx in p.get("rallies", [p["rally"]]):
                who[idx] = p
        for s_ in shots:
            p = who.get(s_["rally"])
            if p:
                near = p["nearPlayer"]
                s_["player"] = near if s_["hitter"] == "near" else ("B" if near == "A" else "A")

    def player(side: str, key: str = "hitter") -> dict:
        mine = [s for s in shots if s.get(key) == side and not s["doubt"]]
        serves = [s["speed"] for s in mine if s["serve"]]
        other = [s["speed"] for s in mine if not s["serve"]]
        landed = [s for s in mine if not s["serve"] and s["landing"] in ("in", "out", "close", "net")]
        if key == "player":
            dist = sum((r["near"]["distance_m"] or 0) if who[r["idx"]]["nearPlayer"] == side else (r["far"]["distance_m"] or 0)
                       for r in rallies if r["idx"] in who)
        else:
            dist = sum((r[side]["distance_m"] or 0) for r in rallies)
        return {
            "shots": len([s for s in shots if s.get(key) == side]),
            "serves": len(serves), "serveAvg": _avg(serves), "serveMax": _max(serves),
            "shotAvg": _avg(other), "shotMax": _max(other),
            "inPct": round(100 * sum(s["landing"] in ("in", "close") for s in landed) / len(landed)) if landed else None,
            "netPct": round(100 * sum(s["landing"] == "net" for s in landed) / len(landed)) if landed else None,
            "distance": round(dist, 0),
        }

    t = a["timing"]
    dur_h = a["durationS"] / 3600
    # Wall-clock work after the download. Player detection and the 3D fits
    # overlap when run together; older runs did them one after the other.
    overlap = t.get("players_and_shots_wall", t.get("players", 0) + t.get("shots", 0))
    compute = t.get("calibrate", 0) + t.get("ball", 0) + t.get("rallies", 0) + overlap
    gpu = t.get("ball", 0) + t.get("players", 0)
    cloud_gpu_h = gpu / CLOUD["gpu_speedup"] / 3600
    return {
        "id": a["id"][:8], "title": a["title"], "durationS": round(a["durationS"]),
        "calibration": {"source": "auto", **a["calibration"]},
        "compare": compare(rallies, a.get("twelvelabs", [])),
        "detected": len(detected),
        "shots": shots, "rallies": rows,
        "hits": sum(len(r.get("hits", r["shots"])) for r in rallies),
        "points": len(a["structure"]["points"]) if a.get("structure") else len(rallies), "near": player("near"), "far": player("far"),
        "people": {k: {**player(k, "player"), **_serving(struct, k), "kit": struct["kits"][k], "swatch": _swatch(struct["kits"][k])} for k in ("A", "B")} if struct else None,
        # Games only when the play followed match rules (structure.py decides).
        "games": _games(struct) if struct and struct.get("regular", True) else None,
        "timing": {k: round(v) for k, v in t.items()},
        "cost": {
            "m1SecondsPerHour": round(compute / dur_h),
            "cloudGpuMinutesPerHour": round(cloud_gpu_h / dur_h * 60, 1),
            "cloudPerHour": round(cloud_gpu_h / dur_h * CLOUD["gpu_per_hour"], 3),
            "spotPerHour": round(cloud_gpu_h / dur_h * CLOUD["spot_per_hour"], 3),
            "twelvelabsPerHour": round(60 * CLOUD["twelvelabs_per_min"] * 1.11, 2),
        },
        "settings": a.get("settings", {}),
    }


def _swatch(lab6: list[float]) -> list[str]:
    """Shirt and shorts colour (Lab, OpenCV's 8-bit scale) as hex."""
    import cv2

    out = []
    for i in (0, 3):
        px = np.uint8([[lab6[i : i + 3]]])
        b, g, r = cv2.cvtColor(px, cv2.COLOR_Lab2BGR)[0, 0]
        out.append(f"#{r:02x}{g:02x}{b:02x}")
    return out


def _serving(struct: dict, who: str) -> dict:
    """Points served and first serves in, from the fitted structure."""
    pts = [p for p in struct["points"] if p["server"] == who]
    faults = sum(bool(p.get("fault")) for p in pts)
    return {"pointsServed": len(pts), "firstServeIn": round(100 * (len(pts) - faults) / len(pts)) if pts else None}


def _games(struct: dict) -> list[dict]:
    games: list[dict] = []
    for p in struct["points"]:
        if not games or games[-1]["game"] != p["game"]:
            games.append({"game": p["game"], "server": p["server"], "serverEnd": p["serverEnd"],
                          "start": p["start"], "points": 0, "agree": 0, "measured": 0})
        g = games[-1]
        g["points"] += 1
        if p["end"] is not None:
            g["measured"] += 1
            g["agree"] += p["end"] == p["serverEnd"]
    for i, g in enumerate(games):
        g["changeoverAfter"] = g["game"] % 2 == 0 and i + 1 < len(games)
    return games


def _avg(v):
    return round(float(np.mean(v)), 1) if v else None


def _max(v):
    return round(float(np.max(v)), 1) if v else None


def main(out: str | None = None) -> None:
    matches = []
    for p in sorted((ROOT / "out" / "analysis").glob("*/analysis.json")):
        a = json.loads(p.read_text())
        st = p.parent / "structure.json"
        if st.exists():
            a["structure"] = json.loads(st.read_text())
        matches.append(summarise(a))
    matches.sort(key=lambda m: -m["durationS"])
    page = (ROOT / "viewer" / "analysis.html").read_text()
    data = json.dumps({"matches": matches, "court": {"half": HALF_LENGTH, "service": SERVICE, "singles": SINGLES}, "cloud": CLOUD})
    page = page.replace("/*__DATA__*/null", data.replace("</", "<\\/"))
    dest = Path(out) if out else ROOT / "out" / "analysis" / "report.html"
    dest.write_text(page)
    print(f"wrote {dest} ({len(matches)} matches, {dest.stat().st_size / 1e3:.0f} kB)")


if __name__ == "__main__":
    main(*sys.argv[1:])
