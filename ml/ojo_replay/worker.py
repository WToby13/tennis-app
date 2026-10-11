"""The analysis worker: takes matches from the app, analyses them, posts results.

    OJO_APP_URL=https://… ANALYSIS_WORKER_SECRET=… python -m ojo_replay.worker [--once] [--keep]

Each job (POST /api/worker/jobs) is one match the owner asked to analyse with
ANALYSIS_ENGINE=own. For each:

1. download the recording (signed URL from the app);
2. the court: the owner's calibration if they placed one, else automatic
   detection, whose pins are posted back for the calibration panel;
3. ball, rallies, players, shots (analyze), then who is who, serves and games
   (structure);
4. post stats, tracking and the rally breakdown (post_analysis), which
   finishes the run in the app.

Any failure is reported (/api/worker/videos/:id/failed) so the owner sees a
message rather than a spinner. `--once` handles one job and exits (for a
container per job, e.g. AWS Batch); otherwise it polls.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import traceback
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
POLL_S = 60


def _api(path: str, body: dict | None = None, timeout: int = 60) -> dict:
    req = urllib.request.Request(
        f"{os.environ['OJO_APP_URL'].rstrip('/')}{path}",
        data=json.dumps(body or {}).encode(),
        method="POST",
        headers={"content-type": "application/json", "authorization": f"Bearer {os.environ['ANALYSIS_WORKER_SECRET']}"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b"{}")


def _run(*args: str) -> None:
    """A pipeline step in its own process (frees GPU memory between steps)."""
    env = {**os.environ, "PYTHONWARNINGS": "ignore", "PYTORCH_ENABLE_MPS_FALLBACK": "1"}
    subprocess.run([sys.executable, "-m", *args], cwd=ROOT, env=env, check=True)


def handle(job: dict, keep: bool = False) -> None:
    from . import autocal

    vid, short = job["id"], job["id"][:8]
    print(f"[worker] {short} {job.get('title')!r}: start", flush=True)
    # The pipeline's match record (as fetch-matches.mjs writes for local runs).
    (ROOT / ".cache" / "matches").mkdir(parents=True, exist_ok=True)
    (ROOT / ".cache" / "matches" / f"{short}.json").write_text(json.dumps(
        {"id": vid, "title": job.get("title"), "durationS": job.get("durationS"), "url": job["url"], "segments": []}))
    out = ROOT / "out" / "analysis" / short
    out.mkdir(parents=True, exist_ok=True)
    video = ROOT / ".cache" / "videos" / f"{short}.mov"
    video.parent.mkdir(parents=True, exist_ok=True)
    if not video.exists():
        subprocess.run(["curl", "-sS", "--fail", "-o", str(video), job["url"]], check=True)

    cal = job.get("courtCalibration")
    if cal and cal.get("source") != "auto":
        (out / "calibration.json").write_text(json.dumps({**cal, "source": "manual"}))
    else:
        found = autocal.calibrate(str(video), str(out / "calibration.jpg"))
        (out / "calibration.json").write_text(json.dumps(found))
        try:
            _api(f"/api/worker/videos/{vid}/calibration", {
                "frameS": found.get("frameS", 0.0), "imageWidth": found["imageWidth"],
                "imageHeight": found["imageHeight"], "landmarks": found["landmarks"],
                "status": found.get("status", "review"), "moved": bool(found.get("moved")),
            })
        except Exception as e:  # the analysis still uses it; the panel just won't show pins
            print(f"[worker] {short}: couldn't post the calibration: {e}", flush=True)

    _run("ojo_replay.analyze", short)
    _run("ojo_replay.structure", short)
    _run("ojo_replay.post_analysis", short)
    if not keep:
        video.unlink(missing_ok=True)
    print(f"[worker] {short}: done", flush=True)


def main(*flags: str) -> None:
    once, keep = "--once" in flags, "--keep" in flags
    while True:
        try:
            jobs = _api("/api/worker/jobs?limit=1").get("jobs", [])
        except Exception as e:
            print(f"[worker] couldn't reach the app: {e}", flush=True)
            jobs = []
        for job in jobs:
            try:
                handle(job, keep)
            except Exception as e:
                traceback.print_exc()
                msg = "The analysis couldn't find the court in this recording." if "court" in str(e).lower() \
                    else "The analysis didn't finish. Please try again."
                try:
                    _api(f"/api/worker/videos/{job['id']}/failed", {"error": msg})
                except Exception:
                    pass
        if once:
            return
        if not jobs:
            time.sleep(POLL_S)


if __name__ == "__main__":
    main(*sys.argv[1:])
