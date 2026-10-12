#!/usr/bin/env bash
# Build (and optionally push) the analysis worker image.
#
#   ml/docker/build.sh                 # build locally as ojo-analysis-worker
#   ml/docker/build.sh <ecr-repo-url>  # build for linux/amd64 and push :latest
#
# Needs ml/.cache/weights/{wasb_tennis.pth.tar,yolo11l-pose.pt} (see ml/README.md
# "Setup"); the WASB source is cloned at the revision the pipeline was built on.
set -euo pipefail
ML="$(cd "$(dirname "$0")/.." && pwd)"
WASB_REV=923462cacdeb3353b84ddebdedb3f4b7a8553b0f
CTX="$(mktemp -d)"
trap 'rm -rf "$CTX"' EXIT

mkdir -p "$CTX/cache/weights" "$CTX/cache/vendor"
cp "$ML/docker/Dockerfile" "$ML/docker/requirements.txt" "$CTX/"
cp -R "$ML/ojo_replay" "$CTX/ojo_replay"
find "$CTX/ojo_replay" -name __pycache__ -prune -exec rm -rf {} +
cp -R "$ML/models" "$CTX/models"
cp "$ML/.cache/weights/wasb_tennis.pth.tar" "$ML/.cache/weights/yolo11l-pose.pt" "$CTX/cache/weights/"
git clone --quiet https://github.com/nttcom/WASB-SBDT.git "$CTX/cache/vendor/WASB-SBDT"
git -C "$CTX/cache/vendor/WASB-SBDT" checkout --quiet "$WASB_REV"
rm -rf "$CTX/cache/vendor/WASB-SBDT/.git"

if [ $# -ge 1 ]; then
  REPO="$1"
  aws ecr get-login-password | docker login --username AWS --password-stdin "${REPO%%/*}"
  docker buildx build --platform linux/amd64 -t "$REPO:latest" --push "$CTX"
else
  docker build -t ojo-analysis-worker "$CTX"
fi
