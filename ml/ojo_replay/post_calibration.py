"""Send an automatic court calibration to the web app.

    OJO_APP_URL=https://… ANALYSIS_WORKER_SECRET=… \\
        python -m ojo_replay.post_calibration <video-uuid> <autocal.json>

Posts the result's pins to /api/videos/<id>/calibration/auto, which solves the
camera from them exactly as for a hand save and stores it marked automatic. A
match someone calibrated by hand is left alone (the app answers 409).
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path


def main(video_id: str, path: str) -> None:
    cal = json.loads(Path(path).read_text())
    body = {
        "frameS": cal.get("frameS", 0.0),
        "imageWidth": cal["imageWidth"],
        "imageHeight": cal["imageHeight"],
        "landmarks": cal["landmarks"],
        "status": cal.get("status", "review"),
        "moved": bool(cal.get("moved")),
    }
    req = urllib.request.Request(
        f"{os.environ['OJO_APP_URL'].rstrip('/')}/api/videos/{video_id}/calibration/auto",
        data=json.dumps(body).encode(),
        method="POST",
        headers={"content-type": "application/json", "authorization": f"Bearer {os.environ['ANALYSIS_WORKER_SECRET']}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            saved = json.loads(r.read())["calibration"]
            print(f"saved: {saved['quality']}, {len(saved['landmarks'])} pins, status {saved['autoStatus']}")
    except urllib.error.HTTPError as e:
        print(f"{e.code}: {e.read().decode()[:200]}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
