"""Load analysed matches into the web app's local mode, for an offline demo.

    python -m ojo_replay.demo_local <match-id-prefix> [...]
    # then: MATCH_STATS_DIR=../ml/out/match-stats npm --prefix web run dev:local

For each match: links the downloaded recording into web/.data, adds (or
updates) its row in the local store with our analysis as its rally breakdown
(as ANALYSIS_ENGINE=own would), and writes its stats, tracking and 3D scene
where the app's MATCH_STATS_DIR reads them. Touches only local files.
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from .post_analysis import build_segments, build_tracks, match_stats
from .scene import build_scene

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT.parent / "web"
DATA = WEB / ".data"
STATS_DIR = ROOT / "out" / "match-stats"


def main(*prefixes: str) -> None:
    db_file, seg_file = DATA / "videos.json", DATA / "segments.json"
    (DATA / "videos" / "videos").mkdir(parents=True, exist_ok=True)
    db = json.loads(db_file.read_text()) if db_file.exists() else []
    segs = json.loads(seg_file.read_text()) if seg_file.exists() else []
    STATS_DIR.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    for prefix in prefixes:
        meta = json.loads(next((ROOT / ".cache" / "matches").glob(prefix + "*.json")).read_text())
        vid, short = meta["id"], meta["id"][:8]
        src = ROOT / ".cache" / "videos" / f"{short}.mov"
        link = DATA / "videos" / "videos" / f"{vid}.mov"
        if not link.exists():
            os.symlink(src, link)
        video_id, stats = match_stats(prefix)
        (STATS_DIR / f"{vid}.json").write_text(json.dumps(stats))
        (STATS_DIR / f"{vid}.tracks.json").write_text(json.dumps(build_tracks(prefix)))
        (STATS_DIR / f"{vid}.scene.json").write_text(json.dumps(build_scene(prefix)[1], separators=(",", ":")))
        breakdown = build_segments(prefix)
        row = next((v for v in db if v["id"] == vid), None) or {
            "id": vid, "ownerId": None, "uploadId": None, "partSizeBytes": 8388608, "visibility": "private",
            "recordedAt": None, "deletedAt": None, "analysisWindows": None, "hasAnalysisProxy": False,
            "courtCalibration": None, "createdAt": now,
        }
        row.update({
            "title": meta["title"], "key": f"videos/{vid}.mov", "contentType": "video/quicktime",
            "sizeBytes": src.stat().st_size, "durationS": meta["durationS"], "status": "ready",
            "analysisStatus": "ready", "analysisTaskId": None, "analysisError": None, "analyzedAt": now,
            "analysisPlayers": {"player_1": "Player A", "player_2": "Player B"},
        })
        db = [v for v in db if v["id"] != vid] + [row]
        segs = [s for s in segs if not (s["videoId"] == vid and s["kind"] == "rally")] + [
            {**s, "kind": "rally", "idx": i, "id": f"{vid}-rally-{i}", "videoId": vid} for i, s in enumerate(breakdown)
        ]
        print(f"{meta['title']}: {len(breakdown)} points in the breakdown, {stats.get('hits', 0)} shots")
    db_file.write_text(json.dumps(db, indent=2))
    seg_file.write_text(json.dumps(segs, indent=2))


if __name__ == "__main__":
    main(*sys.argv[1:])
