#!/usr/bin/env bash
# Build (and optionally push) the analysis worker image.
#
#   ml/docker/build.sh                 # build locally as ojo-analysis-worker
#   ml/docker/build.sh <ecr-repo-url>  # build for linux/amd64 and push :latest
#
# Needs ml/.cache/weights/{wasb_tennis.pth.tar,yolo11l-pose.pt,videopose3d_h36m_coco.bin}
# (see ml/README.md "Setup"); the WASB and VideoPose3D sources are cloned at the
# revisions the pipeline was built on.
#
# VideoPose3D (the 3D view's skeletons) is CC BY-NC 4.0, and its weights come
# from Human3.6M (research use): fine while Ojo earns nothing, to be replaced
# (SAM 3D Body) before it does. See docs/3D_REPLAY.md §8.
#
# With a repo, the image is built first and pushed after, so a missing AWS
# login costs only the push: `aws ecr get-login-password | docker login …` then
# `docker push <repo>:latest`.
set -euo pipefail
ML="$(cd "$(dirname "$0")/.." && pwd)"
WASB_REV=923462cacdeb3353b84ddebdedb3f4b7a8553b0f
VIDEOPOSE3D_REV=1afb1ca0f1237776518469876342fc8669d3f6a9
CTX="$(mktemp -d)"
trap 'rm -rf "$CTX"' EXIT

mkdir -p "$CTX/cache/weights" "$CTX/cache/vendor"
cp "$ML/docker/Dockerfile" "$ML/docker/requirements.txt" "$CTX/"
cp -R "$ML/ojo_replay" "$CTX/ojo_replay"
find "$CTX/ojo_replay" -name __pycache__ -prune -exec rm -rf {} +
cp -R "$ML/models" "$CTX/models"
cp "$ML/.cache/weights/wasb_tennis.pth.tar" "$ML/.cache/weights/yolo11l-pose.pt" \
   "$ML/.cache/weights/videopose3d_h36m_coco.bin" "$CTX/cache/weights/"
git clone --quiet https://github.com/nttcom/WASB-SBDT.git "$CTX/cache/vendor/WASB-SBDT"
git -C "$CTX/cache/vendor/WASB-SBDT" checkout --quiet "$WASB_REV"
rm -rf "$CTX/cache/vendor/WASB-SBDT/.git"
git clone --quiet https://github.com/facebookresearch/VideoPose3D.git "$CTX/cache/vendor/VideoPose3D"
git -C "$CTX/cache/vendor/VideoPose3D" checkout --quiet "$VIDEOPOSE3D_REV"
rm -rf "$CTX/cache/vendor/VideoPose3D/.git"

if [ $# -ge 1 ]; then
  REPO="$1"
  docker buildx build --platform linux/amd64 -t "$REPO:latest" --load "$CTX"
  aws ecr get-login-password | docker login --username AWS --password-stdin "${REPO%%/*}"
  docker push "$REPO:latest"
else
  docker build -t ojo-analysis-worker "$CTX"
fi
