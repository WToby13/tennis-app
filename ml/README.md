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

## Whole-match analysis (replacing TwelveLabs)

The same models over a whole recording, for shot stats instead of a replay:

| Step | Module | What | M1 speed |
|---|---|---|---|
| Recordings | `web/scripts/fetch-matches.mjs` | Your own analysed matches from Supabase: signed URL + TwelveLabs rallies to compare against | – |
| Court | `autocal.py` / `handcal.py` | Automatic: line paint on clean plates from 6 short stretches of the video, candidates anchored on the near baseline, the iPhone ultra-wide lens as a prior (f = 0.37-0.41 W), weighted against fence mesh, then the whole camera polished onto the paint. Right on 15 of 24 recordings (within ~1-9 px of hand calibrations); `status` says whether to trust it, `moved` when the phone moved. Results become the web panel's pins (`post_calibration.py` → `/api/worker/videos/:id/calibration`). `handcal.py` solves from hand-picked landmarks, net posts included | ~3 min |
| Ball | `ballpass.py` | WASB over every frame, windows tiling (step 3), half precision, batch 4. OpenCV's resize, not ffmpeg's: ffmpeg's filtered downscale blurs the ball and lost ~10% of ball frames | ~40 fps |
| Rallies | `rallies.py` | Ball tracked, moving, crossing the net; gaps under 2 s merged | seconds |
| Players + shots | `analyze.py` | Players on rally frames only (every 3rd frame); each rally's 3D shot fit runs in a pool of CPU workers alongside | see report |
| Hits | `hits.py` | Every cut of the ball track (and every uncut candidate) judged by a classifier trained on hand tags (`models/hits.joblib`); fitted shots kept regardless | seconds |
| Report | `report.py` + `viewer/analysis.html` | Shot maps, serve/shot speeds, in/out, distance run, rally intensity, timings → cost | – |
| To the app | `post_analysis.py` | Stats, tracking (ball/players/bounces in pixels) and the rally breakdown → `/api/worker/videos/:id/analysis` (`--out <dir>` for local) | – |
| Worker | `worker.py`, `docker/` | Claims queued matches from the app, runs everything above, posts results; CUDA image for AWS Batch (`infra/analysis_worker.tf`) | – |
| Demo | `demo_local.py` | Loads analysed matches into the app's local mode (see docs/OWN_ANALYSIS_LAUNCH.md §0) | – |
| Ground truth | `viewer/label.html` + `label-server.mjs`, `evaluate.py` | Tag hits/faults/point ends by keyboard; score the pipeline against the tags | – |

```bash
node web/scripts/fetch-matches.mjs ml/.cache/matches        # from web/
.venv/bin/python -m ojo_replay.handcal <plate.png> out/analysis/<id>/calibration.json x,y[,z]=u,v ...
PYTORCH_ENABLE_MPS_FALLBACK=1 caffeinate -i .venv/bin/python -m ojo_replay.analyze <id>
.venv/bin/python -m ojo_replay.report
```

Run long jobs under `caffeinate` on mains power: a sleeping Mac freezes them and
the timings come out 10x too slow.

Results on "Morning session" (31 min, 2026-10-11), against TwelveLabs:

| | Ours | TwelveLabs |
|---|---|---|
| Rally windows | 98 (66 of TwelveLabs' 74 overlapped) | 74 |
| Rallies with a fitted shot | 49 | – |
| Shots | 85 | 305 (its own count; it merged whole sequences of points into "rallies") |
| Points after the on-court check | 28 | 74 |
| Games | 8 | 10 |
| Serving end, points both have | agrees on 21 of 26 | |
| Player identity (kit colour) | clean: changes of ends every ~2 games | |

Time on the M1, per hour of match: ball 48 min (0.8x real time), players 2.3 h,
3D fits 2.9 CPU-hours (in parallel).

Not good enough to replace TwelveLabs yet. Shot recall is the gap: this camera
stands ~20 m back, depth is the weakest direction, and hit/bounce labels from the
along-court velocity fail on most rallies. Next: hits from player proximity and
image motion first, physics second; and a hand-labelled set of a few matches to
tune against (neither TwelveLabs' counts nor guesses are ground truth).

Scored against hand tags on "Afternoon session" (15 min, 32 points, 165 hits,
2026-10-11), `python -m ojo_replay.evaluate 08f3fb94`:

| | Ours | TwelveLabs |
|---|---|---|
| Points found | 31 / 32 | |
| Hits found (recall) | 44% (73 / 165) | |
| Our hits that are real (precision) | 79% (73 / 92) | |
| Serving end | 24 / 32 (first fitted shot 7 / 7, ball 14 / 19, stance 3 / 6) | 18 / 28 |

Hit classifier (`hits.py`, trained on the tags, `models/hits.joblib`): fitted
shots plus cuts it's at least 80% sure of. Held out (trained on one tagged
match, scored on the other):

| | Hits found | Hits real |
|---|---|---|
| Morning session, trained on Afternoon | 28% -> 43% | 68% -> 58% |
| Afternoon session, trained on Morning | 44% -> 61% | 79% -> 66% |

Tried and reverted (2026-10-12): offering the split's uncut candidates to the
classifier and padding rally windows 1.2 s. Held out it lowered hits found
(43% -> 38%, 61% -> 59%) and serving end (24/32 -> 15/29); the code stays
(`hits.UNCUT`) for when there's more tagged data.

Serving end on Morning session: 18 / 19 (TwelveLabs 20 / 21). Retrain after
tagging more: `python -m ojo_replay.hits train <id> <id> ...`.

The tags also showed the session isn't match play (one player served 27 points
running), so the game structure is now imposed only when the measurements bear
it out.

Learned on the way:
- Every recording so far is the iPhone ultra-wide (f = 0.38-0.39 of the frame
  width, ~105 deg), on a fence or tripod 2.8-2.9 m up, 17-19 m behind centre court.
- The court plane alone barely fixes the focal length from behind a baseline; the
  net (posts or tape) does.
- The detector finds balls on the neighbouring courts too; a rally needs a 3D
  check (its bounces on this court), not an image-space one.

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
