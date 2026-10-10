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
| Players, 3D | `body_sam.py` | [SAM 3D Body](https://github.com/facebookresearch/sam-3d-body) (gated, SAM License): a body mesh per player per frame from the 2D box and the calibrated camera, placed on the court; simplified to a 5 cm grid and stored as int16 mm. Every other frame | ~3 s / player-frame |
| Players, 3D (light) | `pose3d.py` | [VideoPose3D](https://github.com/facebookresearch/VideoPose3D) (CC BY-NC) skeletons, the fallback where no mesh exists | < 1 s |
| Render | `reconstruct.py` | Overlay video per rally: court, 3D ball + shadow, bounces, body meshes (2D skeletons where there is no mesh), top-down map. `--render-only` redraws from the saved fit | ~25 s / rally |
| Replay | `export.py` + `viewer/replay.html` | Self-contained three.js page with the data inlined | – |

## Run

```bash
cd ml
uv venv --python 3.11 && uv pip install -r pyproject.toml
# models + vendored code go in .cache/ (gitignored); see "Setup" below
PYTORCH_ENABLE_MPS_FALLBACK=1 .venv/bin/python -m ojo_replay.detect      .cache/short-test/match.json .cache/short-test/short-test.mov out/short-test
PYTORCH_ENABLE_MPS_FALLBACK=1 .venv/bin/python -m ojo_replay.reconstruct .cache/short-test/match.json .cache/short-test/short-test.mov out/short-test
SAM3D_DEVICE=mps PYTORCH_ENABLE_MPS_FALLBACK=1 .cache/venv-sam3d/bin/python -m ojo_replay.body_sam .cache/short-test/match.json .cache/short-test/short-test.mov out/short-test 2
.venv/bin/python -m ojo_replay.export .cache/short-test/match.json out/short-test
```

`match.json` is the match's `GET /api/videos/:id` fields that matter: `segments`
(rallies) and `calibration`.

### Setup (.cache/, not committed)

- `vendor/WASB-SBDT` and `vendor/VideoPose3D`: `git clone --depth 1` of each repo.
- `weights/wasb_tennis.pth.tar`: WASB tennis model from the repo's MODEL_ZOO (Google Drive).
- `weights/yolo11l-pose.pt`: downloaded by Ultralytics on first use.
- `weights/videopose3d_h36m_coco.bin`: `https://dl.fbaipublicfiles.com/video-pose-3d/pretrained_h36m_detectron_coco.bin`.
- `venv-sam3d` + `vendor/sam-3d-body` + `weights/sam-3d-body-dinov3` (2.8 GB,
  gated: request access on Hugging Face, then `uvx hf auth login`). The vendored
  code is patched for Apple Silicon: its `"cuda"` calls take `SAM3D_DEVICE`, and
  the MHR body model (float64, which MPS lacks) runs on the CPU.

## Results on "Short test" (2026-10-10)

Checked against what happened on court:

- Rally 1 (0:31–0:43): six shots, serve to the far player's shot into the net,
  all fitted (2–9 px). Correct.
- Rally 2 (0:56–1:02): serve (in), return into the net. Correct; the serve's
  bounce is placed ~0.9 m deeper than it was (far-court depth bias).

Hits come from the physics split (a cut where the ball's along-court velocity
reverses), corrected by the rules of a rally: hits alternate ends, one bounce
between them, and a hit needs the ball at the hitter.

## Known limits

- **Depth at the far end.** A pixel covers ~30 cm of court at the far service
  line (1.4 cm at the near baseline). Far bounces carry roughly ±0.5–1 m error;
  in/out calls widen their "close" margin with distance accordingly.
- **30 fps.** Serves blur into streaks; contact frames are often lost, which is
  why hits are found from the physics rather than the image.
- **Body meshes** are fitted frame by frame (no smoothing over time yet); the far
  player is ~45 px tall, so their limbs are rough.
- **Licences**: SAM 3D Body is under Meta's SAM License (commercial use allowed
  with conditions; read it before shipping). VideoPose3D is non-commercial; fine
  for this prototype only (see `docs/3D_REPLAY.md` §8).
