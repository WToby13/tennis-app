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
from .report import summarise

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
    stats["version"] = FIT_VERSION
    stats["generatedAt"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    return meta["id"], stats


def main(prefix: str, *flags: str) -> None:
    video_id, stats = match_stats(prefix)
    body = json.dumps(stats).encode()
    print(f"{video_id}: {len(stats['shots'])} shots, {len(stats['rallies'])} points, "
          f"{len(stats['games'] or [])} games, {len(body) / 1e3:.0f} kB")
    if "--dry-run" in flags:
        return
    if "--out" in flags:  # for the web app's MATCH_STATS_DIR in development
        d = Path(flags[flags.index("--out") + 1])
        d.mkdir(parents=True, exist_ok=True)
        (d / f"{video_id}.json").write_bytes(body)
        print("wrote", d / f"{video_id}.json")
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
