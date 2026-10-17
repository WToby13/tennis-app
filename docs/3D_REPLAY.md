# Ojo — 3D Replay: research & plan

Turn an Ojo recording (one iPhone, static, behind the baseline) into a 3D space you can
orbit and scrub: the court at true dimensions, a moving 3D body for each player, and the
ball's 3D flight, bounces and hits.

Researched 2026-10-08. Every paper and repo named here is linked under [References](#references).

---

## 1. The idea in one paragraph

A single fixed camera never sees the far side of anything, so no method can *capture*
the whole scene in 3D from Ojo footage. The parts nobody filmed are either **known**
(the court is a 23.77 m × 10.97 m rectangle; a human body follows a parametric model;
a ball obeys physics) or **invented** by a generative model. So the core of this plan
is a model-based **digital twin**: calibrate the camera from the court lines, then fit
a body model to each player and a physics trajectory to the ball, all in **court
coordinates in metres**. The 4D generative work (4DAnyone and similar) comes later as
an optional "make the near player photoreal" layer for highlights, not as the
foundation. This is how Hawk-Eye-style virtual replays and the latest table-tennis
research (TT3D, TT4D) both work.

```
 iPhone video ──► rally windows (already have: TwelveLabs segments)
      │
      ├─► 1. Court keypoints ─► camera K, R, t, lens distortion   (once per recording, re-checked)
      │
      ├─► 2. Player detect + track + masks ─► 2D keypoints ─► 3D body ─► ground-anchored fit
      │
      ├─► 3. Ball 2D track ─► hit/bounce events ─► physics fit ─► 3D trajectory
      │
      ├─► 4. (later) racket 2D keypoints ─► racket pose attached to the hand
      │
      └─► 5. Scene: procedural court + texture taken from the video (+ optional venue splat)
                         │
                         ▼
              rally.json / rally.glb in S3 ──► three.js viewer on /watch/:id
```

---

## 2. What Ojo footage gives us today and what it costs us

Facts from the code:

- Landscape, **1920×1080** (`ios/Ojo/Ojo/CameraRecorder.swift:110`).
- **Ultra-wide lens** first, with wide as the fallback (`CameraRecorder.swift:92`).
- Frame rate left at the default, so **30 fps**.
- Phone static behind the baseline.
- Rallies are already segmented, with `player_1`/`player_2` slots (`web/lib/twelvelabs/`).
- The 1080p-not-720p finding in `infra/transcoder/README.md` is already on record:
  *the ball is the first thing to go*.

Rough geometry. Assumptions: about 100° horizontal field of view on the ultra-wide
(focal length f ≈ 800 px at 1080p); about 69° on the main lens (f ≈ 1400 px); camera
2.5 m high and 1–2 m behind the near baseline. **These are estimates to measure in
Phase 0, not facts.**

| Quantity | Ultra-wide, 1080p30 (today) | Main lens, 1080p60 | Main lens, 4K60 |
|---|---|---|---|
| Ball size at far baseline (~25 m) | ~2 px | ~4 px | ~7 px |
| Ball travel per frame at 100 km/h | ~0.9 m (a streak) | ~0.46 m | ~0.46 m |
| Far player height | ~55 px | ~95 px | ~190 px |
| Near player height | ~250–400 px | larger (may crop) | larger |
| Ground depth per pixel at far baseline | ~30 cm | ~18 cm | ~9 cm |
| Ground depth per pixel at the net | ~7 cm | ~4 cm | ~2 cm |

What follows from the table:
1. **Frame rate matters most for the ball.** At 30 fps a serve is a few blurred
   streaks. SwingVision records at 60 fps for this reason.
2. **Depth precision at the far end is poor and only improves with height.** Ground
   depth per pixel scales roughly with distance² / (focal length × camera height).
   Mounting the phone higher on the fence helps as much as a better lens.
3. **The near player is a good target and the far player is marginal.** Plan for a
   good 3D body on the near player and court position plus a coarse pose on the far
   player, and tell users that.
4. The ultra-wide was presumably chosen to fit the whole court from close behind it.
   Recording changes (§9) trade that against resolution.

---

## 3. Research landscape (what exists, what's usable)

### 3.1 Court and camera calibration
- **Keypoint heatmaps → homography.** The standard approach: detect the 14 line
  intersections, then fit a RANSAC homography to a court template. Examples:
  `abdullahtarek/tennis_analysis` (YOLOv8 + ResNet keypoints), *Automated Tennis
  Player and Ball Tracking with Court Keypoints* (2025), and KaliCalib (basketball,
  same method).
- **Amateur courts.** *Accurate Tennis Court Line Detection on Amateur Recorded
  Matches* (2024) adds shadow removal and net detection on top of Hough lines,
  because models trained on broadcast footage fail on dirty club courts.
- **Our advantage:** the camera doesn't move. We need **one good calibration per
  recording**, plus periodic checks for a knocked phone. A **4-tap manual fallback**
  in the web UI is therefore realistic and makes the system dependable from day one.
- Going from a homography to a full 3D camera: with square pixels and the principal
  point at the centre, one ground-plane homography is enough to solve the focal length
  (Zhang's method). Net-post tops and the net band (0.914 m at centre, 1.07 m at the
  posts) are non-ground points that check and refine it. Court lines must project
  straight, which also lets us estimate ultra-wide distortion.

### 3.2 Ball: 2D detection
- **TrackNet V2/V3/V4.** Heatmap trackers built on several stacked frames. V4 (2024)
  adds motion-attention maps and improves V2 and V3 on tennis.
- **WASB** (BMVC 2023, `nttcom/WASB-SBDT`). A strong multi-sport baseline that
  reports tennis F1 95.6 on broadcast footage. **Start here.**
- **RacketVision** (2025). Benchmark with 1,672 clips covering tennis, badminton and
  table tennis. Includes ball points and **5-keypoint racket annotations**, with
  baselines for WASB, TrackNetV3 and RTMPose.
- All of these are trained on broadcast footage. Expect to **fine-tune on a few
  thousand labelled Ojo frames**, because our ball is smaller and blurrier.

### 3.3 Ball: 2D → 3D (the hard part)
- **MonoTrack** (CVPRW 2022, badminton). End-to-end monocular 3D shuttle
  trajectories using court dimensions, physics, player pose and hit detection. The
  closest blueprint to what we need.
- **SynthNet** (MMSports 2024, **tennis**). A GRU detects hits and bounces, then a
  fully connected net lifts each shot to 3D. Trained only on synthetic data with a
  physics loss.
- **Where Is The Ball** (CVPRW 2025). An LSTM with a canonical, camera-independent 3D
  representation, trained only in simulation, that handles multiple bounces and hits
  and generalises to real footage.
- **TT3D** (2025) and **TT4D** (2026, ACM MM, 140 h of table tennis). TT3D picks the
  bounce state that minimises reprojection error. TT4D lifts the whole unsegmented
  track with a learned network and **recovers racket velocity and orientation at
  impact from the ball's trajectory** (≈26° orientation error, 0.58 m/s velocity
  error against motion capture).
- *Uplifting Table Tennis* (2025) warns that models trained on synthetic data degrade
  on the noisy, sparse detections in real video. Plan for gaps and false positives.
- **Our extra anchor that broadcast work lacks:** a bounce happens **on the court
  plane**, so its 3D position comes directly from the homography, with no depth
  guess. A hit happens **at the racket**, near the player's wrist, which the 3D body
  gives us. Each flight between events is then a short ballistic arc pinned at both
  ends, a well-posed fit even with a single camera.

### 3.4 Players: detection, tracking, masks
- Any modern person detector (YOLO family / RT-DETR) + ByteTrack, filtered to people
  standing inside the court polygon plus a margin. This drops other courts,
  spectators and ball kids.
- **SAM 3** (Meta, Nov 2025; SAM License). Text-prompted video segmentation and
  tracking ("tennis player"). Gives clean masks and stable identities, and the masks
  help both pose fitting and avatar extraction.

### 3.5 Players: 3D body
| Method | Input | Output | Notes | Licence |
|---|---|---|---|---|
| **GVHMR** (SIGGRAPH Asia 2024) | video | SMPL-X in world coordinates | Strong, used inside 4DAnyone | **Non-commercial only** (checked the LICENSE file) |
| **PromptHMR / -Vid** (2025) | video + box/mask prompts | SMPL-X in world coordinates | Good with two interacting people; metric SLAM + depth | check |
| **SAM 3D Body** (Meta, CVPR 2026 oral) | single image + prompts | MHR mesh incl. hands & feet | Video needs temporal smoothing (ComfyUI pipelines already do this and export BVH/GLB) | SAM License (commercial use allowed with conditions; verify) |
| WHAM, TRAM, 4DHumans/HMR2 | video / image | SMPL | Older baselines | mostly non-commercial |

- **CalTennis** (June 2026, Caltech, Perona's group). 51 h, 40 players, 2–6
  synchronized cameras, monocular-to-3D benchmark. Finding: **joint angles are now
  accurate, but depth and foot contact are not**. Our calibrated court fixes exactly
  that. Body motion can come from any method in the table; position comes from our
  own fit with feet on the court plane and keypoints reprojected through our known
  camera. Use CalTennis to evaluate if its data is released.
- **Vid2Player3D** (SIGGRAPH 2023, NVIDIA/Stanford; code at `nv-tlabs/vid2player3d`).
  Extracted tennis motion from broadcast video and cleaned it with **physics-based
  imitation**, because raw estimates were "low quality". Physics cleanup is a
  late-stage option for us too, but too much to start with.

### 3.6 Players: appearance (only needed beyond stylised figures)
- **LHM** (ICCV 2025, Alibaba). One image in, an animatable **3D Gaussian avatar**
  bound to SMPL-X out, in seconds. Use the best frame of each player as input, then
  drive the avatar with our recovered motion. Works for the near player; the far
  player's 55 px is too few.
- **4DAnyone** (SIGGRAPH Asia 2026, Apache-2.0, but depends on GVHMR and SMPL-X).
  Generates 6–48 consistent views of one person from a portrait 1080p+ video, ~27 s
  per 121 frames on an RTX 4090, input to 4D Gaussian splatting. Highlights only, near
  player only. Front views are invented, because we film players from behind.
- **Generative re-camera** for whole-frame novel views: ReCamMaster, TrajectoryCrafter
  (ICCV 2025), GEN3C (CVPR 2025). Small camera moves only; they fail at large orbits,
  which is the feature we want. Not core.

### 3.7 General monocular 4D scene reconstruction
- Shape of Motion (ICCV 2025), MoSca (CVPR 2025), MegaSaM, VGGT, CUT3R. Excellent
  for handheld video with parallax. A **static camera provides no parallax**, so
  these methods reduce to a depth prior and won't produce useful views far from the
  original. **Not worth it for the court.** They might help the venue backdrop.

### 3.8 Rendering on the web
- **three.js + @react-three/fiber** fits the existing Next.js 15 / React 19 app.
- **Spark** (World Labs, MIT). Gaussian-splat renderer for three.js on WebGL2, which
  covers phones. Mixes splats with ordinary meshes and has had level-of-detail
  streaming since v2.0. Only needed for avatars and venue splats.

### 3.9 Competitor reference
- **SwingVision**: single iPhone at 60 fps; ball, court and player tracking; 3D
  trajectory; line calls with Apple Watch challenges; ITF-approved for some uses. It
  sets user expectations for tracking. **Ojo's difference is the orbitable 3D replay
  inside a social review app**, not line calling.

---

## 4. Coordinate system & data contracts

**Court frame:** origin at the centre of the court on the ground. +X across the court
(doubles sideline at ±5.485 m, singles at ±4.115 m). +Y along the court toward the far
baseline (baselines at ±11.885 m, service lines at ±6.40 m). +Z up. Net at Y=0, 0.914 m
at the centre and 1.07 m at the posts (posts at X=±6.40 m for doubles). All units in
metres and seconds; times are seconds from the start of the video, matching the
`startS`/`endS` the rally segments already use.

**Per recording, `calibration.json`:**
```jsonc
{
  "version": 1,
  "image": [1920, 1080], "fps": 30,
  "K": [[fx,0,cx],[0,fy,cy],[0,0,1]], "dist": [k1, k2],
  "R": [[...]], "t": [...],                  // court → camera
  "keypoints": [{ "name": "far_left_doubles", "px": [x, y], "conf": 0.97 }],
  "reprojErrorPx": 1.4,
  "source": "auto" | "manual",
  "validFrom": 0, "validTo": 3612.5           // split if the phone was bumped
}
```

**Per rally, `rally.json` (+ `rally.glb`):**
```jsonc
{
  "rallyId": "...", "t0": 812.4, "t1": 826.9, "fps": 30,
  "ball": { "samples": [[t, x, y, z, conf]],
            "events":  [{ "t": 813.1, "type": "hit" | "bounce" | "net", "pos": [x, y, z], "player": "player_1" }] },
  "players": [{ "slot": "player_1", "side": "near", "quality": "full" | "coarse",
                "anim": "rally.glb#player_1" }],   // skinned mesh animation in the court frame
  "pipeline": { "version": "0.3.0", "models": { "ball": "wasb-ojo-ft2", "body": "..." } }
}
```
Size estimate: 2 players × ~55 joints × a quaternion × 30 fps × 15 s ≈ 400 KB raw,
under 100 KB compressed. Cheap to store and stream next to the video.

---

## 5. Pipeline design, stage by stage

### Stage 1: Camera calibration

**v1 is manual landmark placement; auto-detection comes later.** The camera never
moves, so 10 seconds of user input per recording replaces a trained model.
- The user drags pins onto **4 or more** known court points: doubles corners, the two
  service-line "T"s, service line × singles sideline, net-post bases. Any visible
  subset works, so a near corner cropped out of frame is fine. A zoom loupe appears
  while dragging. Each pin then **snaps** to the true intersection by fitting the two
  white lines in a small window around it, which is classical image processing and
  needs no ML.
- **Net-post tops (1.07 m)** are worth one extra pin. They're the only points off the
  ground, and they pin down focal length and camera height, which court corners alone
  determine only weakly.
- **Instant self-check:** the whole court template plus the net is reprojected over
  the frame. If every line sits on the paint, the user confirms. If not, the user
  drags the pin that's off. Store the per-line residual as the quality score.
- Best done **on the iPhone before recording** on the live preview, with the user
  standing at the court. It doubles as the framing guide (§9) and gives a reference
  for detecting a bumped phone. Do it on the web player for recordings that already
  exist.

Then:
1. Build a **background plate**: the median of ~50 frames spread over the recording
   removes the players and ball.
2. Detect court keypoints on the plate (fine-tuned heatmap model, Hough lines as a
   fallback), then fit a RANSAC homography to the template.
3. Upgrade to the full camera with Zhang's focal solve, then bundle-adjust f, the
   distortion terms k1/k2, R and t over every keypoint, sampled points along each
   line, and the net top.
4. **Quality gate:** reprojection error under ~2 px, otherwise ask for 4 taps in the
   web UI. Store the result in `match_calibrations`.
5. **Bump detection:** every ~30 s, compare court edges against the plate. On a jump,
   split the calibration.
6. **Free output:** a **rectified top-down court texture** made by warping the plate
   through the inverse homography. That gives the 3D court its real colours, wear and
   shadows instead of a generic green.

### Stage 2: Players
1. Detect and track people, then keep tracks inside the court polygon plus a 2 m
   margin. Label each player near or far by Y position, and map to `player_1`/`player_2`
   using the existing slots and server labels. Players change ends on odd games.
2. Masks from SAM 3 (optional at first).
3. 2D whole-body keypoints (RTMPose / ViTPose) give the per-frame evidence.
4. 3D body: run a video model (GVHMR or PromptHMR-Vid for the prototype, SAM 3D Body
   + smoothing on the path to commercial use) in **camera space**.
5. **Our ground-anchored fit** (the main piece of IP), solved per rally:
   - minimise 2D keypoint reprojection error through the *known* camera;
   - feet on Z=0 during detected contacts (a velocity threshold on the ankle joints);
   - temporal smoothness;
   - shape β shared across the whole recording, so each player keeps a consistent
     body shape. CalTennis notes body shape varying between frames as a common flaw.
6. Mark the far player as `quality: "coarse"` when they're below ~80 px tall: court
   position and facing direction are reliable, limbs are approximate.

### Stage 3: Ball
1. 2D detection: WASB on 3–5 stacked frames, fine-tuned on Ojo frames. The detector
   must be robust to balls on other courts and balls lying on the ground. Drop
   detections that don't move, or that sit outside our court's extended volume.
2. Link detections into tracklets and fill gaps (Kalman filter in image space).
3. Events:
   - **bounce**: a sharp change in vertical image velocity, with the ball near the
     ground plane;
   - **hit**: direction reversal near a player's wrist or racket;
   - **net**: the track ends at the net band.
4. 3D fit, per flight segment between events:
   - state: p₀ (3), v₀ (3), plus optional spin ω (1–3) with gravity, drag and Magnus
     force;
   - anchors: bounce on Z=0 at its homography position, hit within ~0.8 m of the
     hitting wrist;
   - links between segments: across a bounce, horizontal velocity loses some speed to
     friction and vertical velocity flips with a restitution of about 0.7–0.8,
     depending on surface. Fit these per court surface.
   - minimise 2D reprojection error with robust loss (Levenberg-Marquardt, warm-started
     from a straight line).
5. **v2:** a learned lifter in the style of *Where Is The Ball* / SynthNet, trained
   on **synthetic rallies rendered through each recording's own calibrated camera**.
   We can generate unlimited perfectly labelled training data, because we know K, R,
   t, the court, and the physics.
6. Derived stats, nearly free once the 3D ball exists: serve speed, net-clearance
   height, bounce maps, depth of shot, rally tempo. **Line calls** come from the bounce
   position, but show them as *estimated* with a confidence. At 30 fps with
   ~30 cm/px depth at the far baseline they won't match Hawk-Eye, and claiming
   otherwise would hurt trust.

### Stage 4: Racket (later)
- 2D: RTMPose with the RacketVision 5-keypoint scheme (tennis PCK@0.2 ≈ 90% on
  broadcast footage), fine-tuned on Ojo frames.
- 3D: a rigid racket attached to the hand joint, with roll and pitch solved from the
  2D head and handle keypoints. At contact, cross-check with the TT4D-style inverse
  solution from the ball's change of velocity.
- Until then, render a racket fixed to the wrist and aligned with the forearm. It
  looks right most of the time.

### Stage 5: Scene
Choose by cost:
1. **Procedural court + plate texture** (default): the true geometry, the net mesh,
   and the texture from Stage 1. Cheap and accurate.
2. **Video-as-backdrop**: project the original frame onto simple surrounding geometry
   (fences, a back wall). Looks perfect from the original camera position and
   degrades gracefully as you orbit.
3. **Venue splat** (optional, per court not per match): someone walks around the
   court once with a phone, and the capture is turned into 3D Gaussian splats with
   nerfstudio or gsplat, or exported from a phone app such as Scaniverse, Polycam or
   Luma. Register it to the court frame using the lines. Reuse it for every match
   played there. Implies a **`venues`** concept in the data model.

### Stage 6 (optional): photoreal players
- **Avatar path:** LHM on the near player's sharpest unoccluded frame produces a
  Gaussian avatar, driven by the Stage 2 motion and rendered with Spark. One
  generation per player per recording, rendered live in the viewer.
- **Generative path:** 4DAnyone on a portrait crop of a highlight, for an orbitable
  photoreal clip of a single stroke. Expensive, per clip, highlights only.

---

## 6. Viewer (web first)

New route or panel on `/watch/:id`: **"3D"** toggle per rally.
- three.js scene: court, players (stylised mannequins in each player's colour first),
  ball with a fading trail, bounce marks, shadows, net.
- **Synced with the video:** the same timeline drives both, and scrubbing one moves
  the other. Frame-step and slow-mo already exist in the player.
- **Camera presets:** original camera, broadcast high, behind the receiver, top-down
  tactics, side-on at the net, free orbit (touch: pinch/drag).
- **AR overlay mode:** render the 3D scene through the *calibrated original camera*
  on top of the video. This is also the **main debugging tool**: if the overlay
  lines up, the reconstruction is right.
- **Readouts:** serve speed, ball height over the net, bounce dot with in/out
  confidence.
- Load assets from S3 through signed CloudFront URLs, the same path as video.
- iOS: start with a `WKWebView` on the same page. Move to native RealityKit only if
  usage justifies it.

---

## 7. Infrastructure

- **GPU compute** is needed for detection, pose and avatars. The current transcoder
  is CPU Fargate, which won't do. Options:
  - **Modal / RunPod serverless**: pay per second, fastest to set up, Python-native.
    **Recommended for Phases 0–4.**
  - **AWS Batch or ECS on g6/L4 EC2**: matches the existing Terraform and
    data-locality setup. Move here if volume grows.
- **Trigger:** the same on-demand pattern as the analysis proxy. After rally
  segmentation finishes, queue a reconstruction job covering **only rally windows**
  (play is ~25–35% of match time).
- **Cost estimate (validate in Phase 0):** ~300–450 frames per rally; detection,
  pose and ball tracking on an L4 at ~20–40 fps comes to roughly 15–30 GPU-seconds
  per rally, so **~30–60 GPU-minutes per hour of tennis, about $0.50–$1 per match**.
  Avatars add ~1 min per player. 4DAnyone highlights add ~0.5–2 min each.
- **Data model (Supabase):**
  - `match_calibrations`: match_id, version, K/R/t/dist, reprojection error, source,
    validity window;
  - `rally_reconstructions`: rally_id, status, pipeline version, S3 keys, quality
    flags;
  - later, `venues` + `venue_assets`.
  - Status flows through the existing shared match-status model.
- **Versioning:** store `pipeline.version` with every output, so improvements can
  re-run old matches selectively.

---

## 8. Licensing (decide before building the product path)

| Component | Licence | Implication |
|---|---|---|
| GVHMR | educational / research / non-profit only (LICENSE checked) | Prototype only |
| SMPL / SMPL-X body model | research only; commercial via **Meshcapade** (listed from ~€1,500/yr micro tier) | Affects GVHMR, PromptHMR, LHM, 4DAnyone, WHAM… |
| 4DAnyone | Apache-2.0, but depends on GVHMR + SMPL-X | Effectively non-commercial unless those are replaced or licensed |
| SAM 3, SAM 3D Body (+ MHR rig) | Meta SAM License, commercial use reportedly allowed with conditions | **Best candidate for the shipped path.** Read the LICENSE file |
| WASB, TrackNet, RTMPose, LHM | check each repo | Our own fine-tuned weights are ours if the base allows |
| Spark | MIT | fine |

**Decided 2026-10-13:** VideoPose3D (CC BY-NC 4.0; weights trained on Human3.6M,
research use) drives the 3D view's skeletons, in production too, while Ojo has no
revenue of any kind: no paid tier, no ads, no sponsorship. It's credited in the
view with a link to the licence. **Before Ojo makes money, swap it out**: SAM 3D
Body is royalty-free for commercial use (the cost is GPU time; `body_sam.py` takes
~3 s per player-frame on the M1), or license a body model.

Recommendation: prototype with whatever works best. Build the product path on SAM 3D
Body (MHR) plus our own ground-anchored fit, *or* budget for a Meshcapade licence.
Avoid shipping anything GVHMR-derived. *(Not legal advice. Confirm before launch.)*

---

## 9. Recording changes (iOS), the cheapest quality gains

In order of value:
1. **60 fps** (`activeVideoMinFrameDuration` on the capture device). Halves ball blur
   and doubles the data for the trajectory fit. Bitrate goes up about 1.5×, which
   needs checking against the upload and storage budget in `CameraRecorder`.
2. **Lock exposure, focus and white balance** after the first seconds, and keep
   **geometric distortion correction** on. Never let a virtual multi-camera device
   switch lenses mid-recording, because that would change the calibration.
3. **Setup guide overlay:** a court-outline ghost on the preview, plus "mount higher,
   whole court in frame, both baselines visible". Height is the cheapest depth
   improvement there is.
4. **Lens choice:** main 1× lens when the phone can stand far enough back; ultra-wide
   otherwise. Record which lens was used in match metadata.
5. **4K is a later option.** It doubles linear resolution but roughly 3× the bytes,
   so it only makes sense with on-device downsampling for playback, or with
   processing done before upload.
6. Optionally record the device's focal length in metadata to seed calibration.

---

## 10. Phased roadmap with exit criteria

Each phase is independently useful and stops if its gate fails.

### Phase 0: Feasibility spike (1–2 weeks part-time, offline, one machine + rented GPU)
- Pick **3 rallies** from real Ojo matches: a serve plus return, a baseline rally, a
  net approach. Include one ultra-wide 30 fps clip as recorded today and, if
  possible, one 1× 60 fps clip recorded on purpose.
- Notebook pipeline:
  1. calibration from **manual** taps;
  2. WASB off the shelf;
  3. GVHMR on both players;
  4. physics fit of the ball between hand-labelled events;
  5. export JSON.
- A throwaway three.js page that renders the result and the AR overlay.
- **Measure:**
  - calibration reprojection error;
  - ball detection recall at the far end;
  - pixel heights of both players;
  - GPU time per rally;
  - the overlay error, judged by eye.
- **Gate:** near player and ball overlay line up convincingly on at least 2 of the 3
  rallies. If the ball fails on 30 fps ultra-wide but works on 60 fps 1×, Phase 0.5
  becomes mandatory.

### Phase 0.5: Recording upgrades (iOS, ~1 week, parallel with Phase 1)
- §9 items 1–3. Measure the effect on Phase 0 metrics with a before/after clip from
  the same court.

### Phase 1: Calibration you can trust (1–2 weeks)
- Manual landmark placement (Stage 1): web player first, then the iOS pre-record
  screen. Loupe, line-snap, net-post pin, live reprojected overlay.
- Bundle adjustment with distortion, bump detection, rectified court texture.
- Every confirmed calibration becomes a labelled training example. An automatic court
  detector can be trained later from those, and it then only needs to *suggest* pin
  positions.
- **Gate:** under 2 px reprojection error on all court lines (not just the clicked
  points) for 30 recordings from at least 5 different courts. Median user time under
  20 s.
- **Built (web), 2026-10-08:**
  - "Calibrate court" on `/watch/:id`, owner only, hidden on phones.
  - Pieces:
    - `web/app/CourtCalibration.tsx` — the panel;
    - `web/lib/court/` — court model, solver, line snap;
    - `PUT`/`DELETE /api/videos/:id/calibration` — re-solves on the server;
    - `videos.court_calibration` — migration `0022`.
  - The solver uses a leave-one-out refit to name a misplaced pin.
  - Tested on a synthetic court rendered through a known camera: camera position
    within ~4 cm, focal length within 0.5%.
  - Still open:
    - lens distortion (pinhole only today);
    - bump detection;
    - the background plate;
    - the iOS pre-record screen;
    - **snap in production**, which needs CORS on the CloudFront distribution: a
      response-headers policy allowing GET from the app's origin. Without it the
      panel works but pins don't snap.

### Prototype status, 2026-10-09: Phases 2 and 3 run end to end on "Short test"

- Built in `ml/` (see [`ml/README.md`](../ml/README.md)) and run locally on an M1.
- **Ball:** WASB detection, physics split and labelling, per-shot flight fit with a
  simulated bounce.
- **Players:** YOLO11-pose with a 4× far-court crop, VideoPose3D lifting, placed on
  the court through the calibration.
- **Outputs:**
  - overlay videos;
  - a three.js replay with a per-shot breakdown.
- **Rally 1 result:** the physics split recovers the same 5 hits the rally
  breakdown counted, and the serve lands in the correct service box.
- **Biggest limit:** far-court depth (about 30 cm per pixel). 60 fps and a higher
  mount are still the cheapest wins.
- **Stand-in:** SAM 3D Body is wired up but waiting on gated Hugging Face access;
  VideoPose3D stands in.

### Phase 2: Ball in 3D (3–5 weeks)
- Fine-tune WASB on ~3–5k labelled Ojo frames, prioritising far court, night and
  clay. Event detection; physics fitter with surface-specific bounce coefficients.
- **Ground truth day:** 2–3 iPhones synchronised by an audio clap, triangulating the
  ball on one court.
- **Gate:** median bounce-position error under 30 cm on the near half and under 60 cm
  on the far half, with net-crossing height within 15 cm.

### Phase 3: Players in 3D (3–5 weeks)
- Tracking and identities, slot mapping including end changes, ground-anchored fit,
  quality flags.
- Swap in the licence-clean body model (SAM 3D Body) and compare.
- **Gate:** against the multi-phone triangulation, foot position error under 20 cm on
  the near player and under 50 cm on the far player. No visible foot sliding.

### Phase 4: Viewer MVP (2–3 weeks)
- Stylised players, ball trail, bounce marks, presets, synced timeline, AR overlay,
  in the web app behind a flag.
- **Gate:** your playing group uses it on real matches. Track it with the existing
  analytics (`3d_view_opened`, time in 3D, preset used).
- **Built (web + worker), 2026-10-13:** "3D view" on `/watch/:id` for every match our
  own analysis has run on.
  - **Scene** (`ml/ojo_replay/scene.py`): built from what the whole-match analysis
    already cached, ~15 s a match, 1–3 MB:
    - every fitted shot's flight, simulated again from its fitted launch;
    - both players' feet where detected, and 3D skeletons lifted from their 2D
      keypoints where VideoPose3D is installed (bridging detection gaps up to 1 s);
    - the court's own surface: a clean plate warped top-down through the
      calibration. Only the near half is the camera's (the far half is seen through
      the net), so the far half is the near half mirrored across the net.
  - **Skeletons stand on the detected feet**, not where pose3d's hip-ray placement
    puts them. From behind the baseline that ray is shallow, so a few cm wrong in the
    lifted legs moved the far player up to 1.7 m in depth. Now within 4 cm (near) /
    9 cm (far) of the detected feet, median.
  - **Storage:** the scene goes to `scenes/<id>.json` beside the thumbnails through a
    presigned PUT; `match_analyses.scene_version` (migration `0024`) records it. It
    can't go through the app: the scene grows with match length, past the host's
    4.5 MB request limit.
  - **Viewer** (`web/app/Replay3D.tsx`, three.js, loaded only when opened):
    - the video is the clock, so play, scrub, frame-step, slow-mo and next rally
      all drive the scene;
    - presets ease between Phone (the AR overlay, through the calibrated camera),
      Broadcast, Behind the hitter (follows each shot), Side on and Top down;
    - dragging gives free orbit; a click plays and pauses;
    - the video plays in a corner; a readout shows the shot's speed, net clearance
      and ball height.
  - **Venues** (`web/app/Replay3DVenues.ts`, 2026-10-13), a switch in the view:
    - *Your court*: walls at the fences (the phone's own fence, ±9 m across) painted
      with the clean plate projected back through the calibrated phone, so the real
      fences, trees and buildings stand where the video shows them. Wall the phone
      never saw takes its mirror across the net; where both were seen the sharper wins
      (cos/distance²); what's still stretched one way is blurred to read as
      out-of-focus background. Scene version 3 carries the plate (~200 kB).
    - *Stadium*: the same match on a procedural clay show court in the style of
      Court Philippe-Chatrier: wide clay run-off, green walls with our name,
      two tiers of stands with ~16,000 seated people (two instanced meshes), a
      white roof ring, the umpire's chair. No photos or marks of the real venue.
  - **Not yet:**
    - skeletons come from VideoPose3D (CC BY-NC 4.0, credited in the view): in
      the worker image while Ojo earns nothing, to be replaced before it does
      (§8). Without it a scene draws plain figures at the feet;
    - body meshes;
    - racket;
    - `time in 3D` / preset analytics.

### Phase 5: Productionise (2 weeks)
- GPU worker triggered after rally segmentation, Supabase tables, status, retries,
  cost logging, re-run by pipeline version.

### Phase 6: Realism (open-ended, pick by demand)
- Racket pose; venue splats; LHM avatars for the near player; physics cleanup of
  motion (Vid2Player3D style).

### Phase 7: Generative highlights & stats
- 4DAnyone or a successor for one-tap "spin around this shot" clips.
- Stats layer: serve speed, placement heatmaps, estimated line calls with confidence.

---

## 11. Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Ball undetectable at the far end (ultra-wide, 30 fps) | High today | 60 fps, higher mount, 1× lens; fine-tuning; physics fills gaps between anchors |
| Far player too small for a usable 3D body | High | Honest `coarse` quality flag; position plus facing direction still makes a good tactical view |
| Phone knocked mid-match | Medium | Bump detection splits the calibration; manual re-tap |
| Balls and players from other courts | Medium | Court-volume filter, track-continuity rules |
| Doubles (4 players) | Certain eventually | Singles first. The schema already supports N players |
| Night lighting / clay / shadows | Medium | Include them in fine-tune data; median plate removes moving shadows |
| GPU cost creep | Low–Medium | Rally windows only; on-demand per match; batch processing |
| Licensing blocks commercial launch | **High if ignored** | §8: decide the model path before Phase 3 |
| Over-claiming accuracy (line calls) | Medium | Show confidence; never present it as an official call |
| Generative layers invent detail (fake faces, rackets) | Certain | Label generated views as such; keep the model-based view as the default |

---

## 12. Open decisions

1. **Commercial intent and timeline.** Decides SAM 3D Body vs. a Meshcapade licence
   vs. research models. Needed before Phase 3.
2. **Recording changes:** are you willing to move to 60 fps, and to ask users to
   mount higher or use 1×? This has the biggest effect on quality per hour of work.
3. **GPU provider** for Phases 0–4: Modal/RunPod or AWS.
4. **Singles-only for v1?** (Recommended.)
5. **Ground-truth day:** can you get 2–3 phones and an hour on one court?

---

## References

Court & calibration
- Accurate Tennis Court Line Detection on Amateur Recorded Matches — https://arxiv.org/abs/2404.06977
- Automated Tennis Player and Ball Tracking with Court Keypoints Detection — https://arxiv.org/abs/2511.04126
- tennis_analysis (YOLOv8 + court keypoints) — https://github.com/abdullahtarek/tennis_analysis
- KaliCalib (basketball court registration) — https://arxiv.org/abs/2209.07795

Ball
- TrackNetV4 — https://arxiv.org/abs/2409.14543
- WASB, Widely Applicable Strong Baseline (BMVC 2023) — https://github.com/nttcom/WASB-SBDT
- RacketVision benchmark — https://arxiv.org/abs/2511.17045
- MonoTrack (CVPRW 2022) — https://arxiv.org/abs/2204.01899
- SynthNet (tennis, MMSports 2024) — https://pure.itu.dk/en/publications/synthnet-leveraging-synthetic-data-for-3d-trajectory-estimation-f/
- Where Is The Ball (CVPRW 2025) — https://arxiv.org/abs/2506.05763 · https://where-is-the-ball.github.io/
- TT3D — https://arxiv.org/abs/2504.10035
- TT4D (ACM MM 2026) — https://arxiv.org/abs/2605.01234
- Uplifting Table Tennis — https://arxiv.org/abs/2511.20250

Players
- GVHMR — https://github.com/zju3dv/GVHMR
- PromptHMR — https://arxiv.org/abs/2504.06397
- SAM 3D Body — https://arxiv.org/abs/2602.15989 · https://github.com/facebookresearch/sam-3d-body
- SAM 3 — https://github.com/facebookresearch/sam3
- CalTennis dataset & benchmark — https://arxiv.org/abs/2606.20542
- Vid2Player3D (SIGGRAPH 2023) — https://research.nvidia.com/labs/toronto-ai/vid2player3d · https://github.com/nv-tlabs/vid2player3d
- LHM (ICCV 2025) — https://arxiv.org/abs/2503.10625 · https://github.com/aigc3d/LHM
- 4DAnyone — https://github.com/ant-research/4DAnyone
- SMPL-X licence — https://smpl-x.is.tue.mpg.de/modellicense.html · Meshcapade — https://meshcapade.com/assets/body-models

Scene & generative
- Shape of Motion — https://arxiv.org/abs/2407.13764
- MoSca — https://arxiv.org/abs/2405.17421
- VGGT — https://arxiv.org/abs/2503.11651 · CUT3R — https://arxiv.org/abs/2501.12387
- ReCamMaster — https://arxiv.org/abs/2503.11647 · TrajectoryCrafter — https://arxiv.org/abs/2503.05638 · GEN3C — https://research.nvidia.com/labs/toronto-ai/publication/2025_cvpr_gen3c

Rendering & market
- Spark (three.js Gaussian splats) — https://github.com/sparkjsdev/spark · https://worldlabs.ai/blog/spark-2.0
- SwingVision — https://apps.apple.com/US/app/id989461317
