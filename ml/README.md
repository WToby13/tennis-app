# ml/ — 3D replay prototype

Phases 2 and 3 of [`docs/3D_REPLAY.md`](../docs/3D_REPLAY.md), run locally on an
Apple Silicon Mac (M1, 16 GB). Turns one calibrated Ojo recording into a 3D rally:
the ball's flight with bounces, speeds and net heights, and both players as 3D
skeletons on the court.

## Pipeline

| Step | Module | What | M1 speed |
|---|---|---|---|
| Camera | `camera.py` | The calibration saved by the web panel (`videos.court_calibration`), pixels ⇄ court metres | – |
| Ball, 2D | `ball2d.py` | [WASB](https://github.com/nttcom/WASB-SBDT) (BMVC 2023, MIT) tennis weights: 3-frame HRNet heatmaps, then a motion tracker | ~8 fps |
| Players, 2D | `players.py` | YOLO11-L pose + ByteTrack. The far player (~35–45 px tall) is found in a 4× enlarged crop of the far court; detections must stand on this court and be person-sized for where they stand | ~1 fps |
| Ball, 3D | `ball3d.py` | Split the track into flights (dynamic programming over turns/gaps), label cuts as hits from the ball's along-court velocity reversing, then fit each shot as one flight with gravity, drag and a simulated bounce | ~1 min / rally |
| Players, 3D | `pose3d.py` | [VideoPose3D](https://github.com/facebookresearch/VideoPose3D) (CC BY-NC) lifts COCO keypoints to 17 3D joints; placed on the court through the calibration (feet on the ground) | < 1 s |
| Render | `reconstruct.py` | Overlay video per rally: court, 3D ball + shadow, bounces, skeletons, top-down map | ~1 min / rally |
| Replay | `export.py` + `viewer/replay.html` | Self-contained three.js page with the data inlined | – |

## Run

```bash
cd ml
uv venv --python 3.11 && uv pip install -r pyproject.toml
# models + vendored code go in .cache/ (gitignored); see "Setup" below
PYTORCH_ENABLE_MPS_FALLBACK=1 .venv/bin/python -m ojo_replay.detect      .cache/short-test/match.json .cache/short-test/short-test.mov out/short-test
PYTORCH_ENABLE_MPS_FALLBACK=1 .venv/bin/python -m ojo_replay.reconstruct .cache/short-test/match.json .cache/short-test/short-test.mov out/short-test
.venv/bin/python -m ojo_replay.export .cache/short-test/match.json out/short-test
```

`match.json` is the match's `GET /api/videos/:id` fields that matter: `segments`
(rallies) and `calibration`.

### Setup (.cache/, not committed)

- `vendor/WASB-SBDT` and `vendor/VideoPose3D`: `git clone --depth 1` of each repo.
- `weights/wasb_tennis.pth.tar`: WASB tennis model from the repo's MODEL_ZOO (Google Drive).
- `weights/yolo11l-pose.pt`: downloaded by Ultralytics on first use.
- `weights/videopose3d_h36m_coco.bin`: `https://dl.fbaipublicfiles.com/video-pose-3d/pretrained_h36m_detectron_coco.bin`.
- `venv-sam3d` + `vendor/sam-3d-body`: ready for SAM 3D Body once its gated
  Hugging Face weights are accessible (`uvx hf auth login` after access is granted).

## Results on "Short test" (2026-10-09)

Rally 1 (0:31–0:43): serve plus 3 groundstrokes fitted, 90–102 km/h, fits 2–16 px.
The serve lands in the correct (cross-court) service box. Rally 2 (0:56–1:02):
3 shots; the far player's return is flagged as doubtful. The rally breakdown's own
hit count (5 in rally 1) matches the physics split.

## Known limits

- **Depth at the far end.** A pixel covers ~30 cm of court at the far service
  line (1.4 cm at the near baseline). Far bounces carry roughly ±0.5–1 m error;
  in/out calls widen their "close" margin with distance accordingly.
- **30 fps.** Serves blur into streaks; contact frames are often lost, which is
  why hits are found from the physics rather than the image.
- **Body poses** are VideoPose3D, a 2019 stand-in for SAM 3D Body; the far
  player's limbs are rough.
- **Licences**: VideoPose3D and SMPL-family models are non-commercial; fine for
  this prototype, not for the shipped app (see `docs/3D_REPLAY.md` §8).
