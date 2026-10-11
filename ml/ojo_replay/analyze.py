"""A whole match, end to end: court, ball, rallies, players, shots, stats.

    python -m ojo_replay.analyze <match-id-prefix> [--step 3] [--player-stride 6] [--no-keep]

Reads `.cache/matches/<id>.json` (from web/scripts/fetch-matches.mjs: signed
URL, and the TwelveLabs rallies to compare against), and writes
`out/analysis/<id>/analysis.json` with every shot (who hit it, when, speed,
where it bounced, in/out), every rally, per-player movement, match totals, and
how long each stage took, which is the cost measure.

Stages:
  1. download (kept in .cache/videos unless --no-keep)
  2. calibrate the court (autocal)
  3. ball over the whole match at the detector's input size (ballpass)
  4. rallies from the ball (rallies)
  5. players at full resolution, rallies only, every `player-stride` frames
     (each rally's players and shots cached under rallies/, so a run resumes)
  6. each rally's shots in 3D (ball3d.reconstruct, as for the replay)
"""

from __future__ import annotations

import argparse
import json
import os
from concurrent.futures import ProcessPoolExecutor
import subprocess
import time
from dataclasses import asdict
from pathlib import Path

import cv2
import numpy as np

from . import autocal, ballpass, rallies
from .ball3d import reconstruct
from .camera import Camera
from .players import detect_players

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / ".cache"
WEIGHTS = CACHE / "weights"
# Bump when the ball tracking or 3D fit changes, so cached shots aren't reused.
FIT_VERSION = "f6"


def download(url: str, dest: Path) -> float:
    t0 = time.time()
    if not dest.exists():
        tmp = dest.with_suffix(".part")
        subprocess.run(["curl", "-sS", "--fail", "-C", "-", "-o", str(tmp), url], check=True)
        tmp.rename(dest)
    return time.time() - t0


def read_range(video: Path, first: int, last: int, stride: int):
    """Full-resolution frames first..last (inclusive), every `stride`th."""
    cap = cv2.VideoCapture(str(video))
    cap.set(cv2.CAP_PROP_POS_FRAMES, first)
    out = []
    for i in range(first, last + 1):
        if (i - first) % stride:
            if not cap.grab():
                break
            continue
        ok, img = cap.read()
        if not ok:
            break
        out.append((i, img))
    cap.release()
    return out


def _cached_windows(cache: Path, stride: int) -> list[tuple[int, int, Path]]:
    out = []
    for f in cache.glob(f"*-s{stride}c4.players.json"):
        a, b = f.name.split("-")[:2]
        out.append((int(a), int(b), f))
    return out


def cached_players(cache: Path, first: int, last: int, stride: int) -> tuple[list[dict], list[tuple[int, int]]]:
    """Detections already made inside [first, last], and the stretches no cached
    window covers (to detect)."""
    covered = np.zeros(last - first + 1, bool)
    players: dict[tuple[int, str], dict] = {}
    for a, b, f in _cached_windows(cache, stride):
        lo, hi = max(a, first), min(b, last)
        if lo > hi:
            continue
        covered[lo - first : hi - first + 1] = True
        for p in json.loads(f.read_text())["players"]:
            if lo <= p["frame"] <= hi:
                players[(p["frame"], p["side"])] = p
    gaps, k = [], 0
    while k < len(covered):
        if covered[k]:
            k += 1
            continue
        j = k
        while j < len(covered) and not covered[j]:
            j += 1
        if j - k >= stride:
            gaps.append((first + k, first + j - 1))
        k = j
    return list(players.values()), gaps


def reused_seconds(cache: Path, first: int, last: int, stride: int) -> float:
    """The detection time the reused part cost when it was first measured."""
    total = 0.0
    for a, b, f in _cached_windows(cache, stride):
        lo, hi = max(a, first), min(b, last)
        if lo <= hi:
            d = json.loads(f.read_text())
            if not d.get("combined"):  # a combined window's time is already counted
                total += d["seconds"] * (hi - lo + 1) / (b - a + 1)
    return total


def path_stats(points: list[tuple[int, float, float]], fps: float) -> dict:
    """Distance and top speed from feet positions (frame, x, y), smoothed: the
    depth of a placed player jitters, and summed jitter would read as running."""
    if len(points) < 6:
        return {"distance_m": 0.0, "top_speed_ms": None}
    p = np.array(points, float)
    runs = np.split(np.arange(len(p)), np.flatnonzero(np.diff(p[:, 0]) > 8) + 1)
    dist, top = 0.0, 0.0
    for r in runs:
        if len(r) < 6:
            continue
        q = p[r]
        med = np.array([np.median(q[max(0, i - 2) : i + 3, 1:], axis=0) for i in range(len(q))])
        k = 3
        sm = np.array([med[max(0, i - k) : i + k + 1].mean(axis=0) for i in range(len(med))])
        dist += float(np.linalg.norm(np.diff(sm, axis=0), axis=1).sum())
        dt = np.diff(q[:, 0]) / fps
        v = np.linalg.norm(np.diff(sm, axis=0), axis=1) / np.maximum(dt, 1e-6)
        if len(v) >= 3:
            top = max(top, float(np.convolve(v, np.ones(3) / 3, mode="valid").max()))
    return {"distance_m": round(dist, 1), "top_speed_ms": round(top, 1) if top else None}


def fit_rally(cam: Camera, track: dict, by_frame: dict, fps: float, last: int) -> tuple[list[dict], float, str | None, list]:
    """One rally's shots in 3D (CPU), in a worker process, and the labelled
    cuts the hit decision (hits.decide, in the main process) works from."""
    from . import ball3d

    t0 = time.process_time()
    try:
        shots = [asdict(s) for s in reconstruct(cam, track, by_frame, fps, last)]
        err, cuts = None, list(ball3d.last_cuts)
    except Exception as e:  # one bad rally shouldn't sink the match
        shots, err, cuts = [], str(e), []
    for s in shots:
        s.pop("samples", None)
    return shots, time.process_time() - t0, err, cuts


def compare(ours: list[tuple[float, float]], theirs: list[dict]) -> dict:
    """Rally overlap with TwelveLabs' (neither is ground truth)."""
    tl = [(s["startS"], s["endS"]) for s in theirs if s["kind"] == "rally"]

    def overlaps(a, b):
        inter = min(a[1], b[1]) - max(a[0], b[0])
        return inter > 0.5 * min(a[1] - a[0], b[1] - b[0])

    matched_ours = sum(any(overlaps(o, t) for t in tl) for o in ours)
    matched_tl = sum(any(overlaps(t, o) for o in ours) for t in tl)
    return {"ours": len(ours), "twelvelabs": len(tl), "ours_matched": matched_ours, "twelvelabs_matched": matched_tl}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("match")
    ap.add_argument("--step", type=int, default=3)
    ap.add_argument("--player-stride", type=int, default=6)
    ap.add_argument("--no-keep", action="store_true")
    ap.add_argument("--max-rallies", type=int, default=0)
    ap.add_argument("--no-fit", action="store_true", help="ball and players only (the GPU work), no 3D fits")
    args = ap.parse_args()

    meta_path = next((CACHE / "matches").glob(args.match + "*.json"))
    meta = json.loads(meta_path.read_text())
    mid = meta["id"][:8]
    out = ROOT / "out" / "analysis" / mid
    out.mkdir(parents=True, exist_ok=True)
    timing: dict[str, float] = {}
    log = lambda m: print(f"[{mid}] {m}", flush=True)  # noqa: E731

    if Path(meta["url"]).exists():
        video = Path(meta["url"])
    else:
        video = CACHE / "videos" / f"{mid}.mov"
        video.parent.mkdir(exist_ok=True)
        timing["download"] = download(meta["url"], video)
        log(f"downloaded {video.stat().st_size / 1e9:.1f} GB in {timing['download']:.0f}s")

    t0 = time.time()
    cal_path = out / "calibration.json"
    if cal_path.exists():
        cal = json.loads(cal_path.read_text())
    else:
        cal = autocal.calibrate(str(video), str(out / "calibration.jpg"))
        cal_path.write_text(json.dumps(cal))
    timing["calibrate"] = time.time() - t0
    cam = Camera.from_calibration(cal)
    # Ours (autocal/handcal) or the web panel's (solve.ts): both carry the camera.
    log(f"court: {cal.get('source', 'panel')}, {cal.get('quality')}, f {cal['camera']['f']:.0f}")

    t0 = time.time()
    bp_path = out / "ball.npz"
    if bp_path.exists():
        z = np.load(bp_path)
        cands, fps, n_frames = z["cands"], float(z["fps"]), len(z["cands"])
        timing["ball"] = float(z["seconds"])
    else:
        r = ballpass.run(str(video), args.step)
        cands, fps, n_frames = r["cands"], r["fps"], r["frames"]
        np.savez_compressed(bp_path, cands=cands, fps=fps, seconds=r["seconds"])
        timing["ball"] = time.time() - t0
    log(f"ball: {n_frames} frames in {timing['ball']:.0f}s ({n_frames / timing['ball']:.0f} fps)")

    t0 = time.time()
    ball = rallies.tracked(cands, cam, fps)
    found = rallies.find(ball, fps, cam)
    timing["rallies"] = time.time() - t0
    cmp = compare(found, meta["segments"])
    log(f"rallies: {len(found)} (TwelveLabs {cmp['twelvelabs']}; overlap {cmp['ours_matched']}/{cmp['twelvelabs_matched']})")
    if args.max_rallies:
        found = found[: args.max_rallies]

    # Players need the GPU and go one rally at a time; each rally's 3D fit is
    # CPU work and runs in a pool alongside, so the two overlap.
    timing["players"] = 0.0
    timing["shots_cpu"] = 0.0
    pool = ProcessPoolExecutor(max_workers=max(1, min(4, (os.cpu_count() or 4) - 2)))
    jobs = []
    by_frames: dict[int, dict] = {}
    feet: dict[str, list] = {"near": [], "far": []}
    t_loop = time.time()
    # Each rally's players and shots are cached, so an interrupted run resumes.
    cache = out / "rallies"
    cache.mkdir(exist_ok=True)
    for k, (s0, s1) in enumerate(found):
        first, last = int(s0 * fps), min(n_frames - 1, int(s1 * fps))
        pfile = cache / f"{first}-{last}-s{args.player_stride}c4.players.json"
        if pfile.exists():
            pdata = json.loads(pfile.read_text())
            timing["players"] += pdata["seconds"]
            players = pdata["players"]
        else:
            # Reuse detections cached for overlapping windows (a change to the
            # rally finder moves the windows, not the players); detect the rest.
            reused, gaps = cached_players(cache, first, last, args.player_stride)
            t0 = time.time()
            players = reused
            for a, b in gaps:
                frames = read_range(video, a, b, args.player_stride)
                # The far court enlarged 4x: at 2.5x a 40 px far player was found
                # in 0 of 21 frames, at 4x in 18, for about the same time.
                players += [asdict(p) for p in detect_players(frames, cam, str(WEIGHTS / "yolo11l-pose.pt"), crop_scale=4.0)]
            dt = time.time() - t0
            # Charge reused work at the rate it was measured, so timings stay a
            # cost measure rather than a cache-hit measure.
            dt += reused_seconds(cache, first, last, args.player_stride)
            timing["players"] += dt
            players.sort(key=lambda p: p["frame"])
            pfile.write_text(json.dumps({"seconds": dt, "players": players, "combined": bool(reused)}))
        by_frame: dict[int, dict[str, dict]] = {}
        for p in players:
            by_frame.setdefault(p["frame"], {})[p["side"]] = p
            feet[p["side"]].append((p["frame"], *p["feet"]))
        by_frames[k] = by_frame
        sfile = cache / f"{first}-{last}-s{args.player_stride}c4-{FIT_VERSION}.shots.json"
        if args.no_fit:
            continue
        if sfile.exists():
            jobs.append((k, s0, s1, first, last, sfile, None))
        else:
            track = {f: (float(ball[f, 0]), float(ball[f, 1])) for f in range(first, last + 1) if np.isfinite(ball[f, 0])}
            jobs.append((k, s0, s1, first, last, sfile, pool.submit(fit_rally, cam, track, by_frame, fps, last)))
        if k % 10 == 0:
            log(f"rally {k + 1}/{len(found)}: players {timing['players']:.0f}s so far")
    if args.no_fit:
        pool.shutdown()
        log(f"detection only: players {timing['players']:.0f}s for {len(found)} rallies")
        return
    from . import hits as H

    hit_model = H.load()
    rally_out = []
    for k, s0, s1, first, last, sfile, fut in jobs:
        if fut is None:
            shots, cpu, err, cuts = json.loads(sfile.read_text())
        else:
            shots, cpu, err, cuts = fut.result()
            sfile.write_text(json.dumps([shots, cpu, err, cuts]))
        hits = H.decide(hit_model, cuts, ball, 0, by_frames[k], fps, cam.width, [(s["t0"], s["hitter"]) for s in shots],
                        window=(first, last))
        timing["shots_cpu"] += cpu
        if err:
            log(f"rally {k}: fit failed: {err}")
        rally_out.append({
            "idx": k, "startS": round(s0, 2), "endS": round(s1, 2), "shots": shots, "hits": hits,
            "cuts": [[round(t, 3), a, b] for t, a, b in cuts],
            "near": path_stats([q for q in feet["near"] if first <= q[0] <= last], fps),
            "far": path_stats([q for q in feet["far"] if first <= q[0] <= last], fps),
        })
    pool.shutdown()
    # Wall time of this pass; on a resumed run, the cached work's own time.
    timing["players_and_shots_wall"] = max(time.time() - t_loop, timing["players"])

    result = {
        "id": meta["id"], "title": meta["title"], "durationS": n_frames / fps, "fps": fps,
        "calibration": {"quality": cal.get("quality"), "coverage": cal.get("coverage"),
                        "rms": cal.get("rms", cal.get("rmsErrorPx")), "source": cal.get("source", "auto")},
        "rallies": rally_out, "compare": cmp, "timing": timing,
        # Whole points (stretches of play grouped), for the serve and the score.
        "points": [{"startS": round(a, 2), "endS": round(b, 2)} for a, b in rallies.find(ball, fps, cam, points=True)],
        "settings": {"step": args.step, "playerStride": args.player_stride},
        "twelvelabs": [s for s in meta["segments"] if s["kind"] == "rally"],
    }
    (out / "analysis.json").write_text(json.dumps(result))
    log("timing " + ", ".join(f"{k} {v:.0f}s" for k, v in timing.items()))
    log(f"{sum(len(r['shots']) for r in rally_out)} shots in {len(rally_out)} rallies")
    if args.no_keep and video.parent == CACHE / "videos":
        video.unlink()


if __name__ == "__main__":
    main()
