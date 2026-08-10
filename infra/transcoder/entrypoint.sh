#!/bin/sh
# Analysis-proxy transcoder — one Fargate task per match.
#
# Deliberately dumb: the web app owns the encoding spec (web/lib/analysisProxy.ts)
# and passes the ffmpeg arguments in, so there is exactly one definition of what a
# proxy is. This script only moves bytes and reports the outcome.
#
# Streaming rather than buffering matters here: a 2-hour master can be 13 GB, so
# it is downloaded to the task's ephemeral disk (configured large enough) and
# deleted as soon as the encode is done.
set -eu

# The ffmpeg arguments arrive as this script's positional parameters, supplied by
# the ECS command override — which is already a string array, so there's no
# quoting or JSON parsing to get wrong.
: "${VIDEO_ID:?VIDEO_ID is required}"
: "${S3_BUCKET:?S3_BUCKET is required}"
: "${SOURCE_KEY:?SOURCE_KEY is required}"
: "${PROXY_KEY:?PROXY_KEY is required}"
: "${SUPABASE_URL:?SUPABASE_URL is required}"
: "${SUPABASE_SERVICE_ROLE_KEY:?SUPABASE_SERVICE_ROLE_KEY is required}"
[ "$#" -gt 0 ] || { echo "no ffmpeg arguments given" >&2; exit 2; }

WORK=/tmp/work
mkdir -p "$WORK"
SRC="$WORK/source"
OUT="$WORK/proxy.mp4"

cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# Mark the match failed and stop. The web app surfaces analysis_error verbatim.
fail() {
  echo "transcode failed: $1" >&2
  curl -sS -X PATCH \
    "${SUPABASE_URL}/rest/v1/videos?id=eq.${VIDEO_ID}" \
    -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"analysis_status\":\"failed\",\"analysis_error\":$(printf '%s' "$1" | sed 's/"/\\"/g; s/^/"/; s/$/"/')}" \
    >/dev/null || true
  exit 1
}

echo "[1/4] downloading s3://${S3_BUCKET}/${SOURCE_KEY}"
aws s3 cp "s3://${S3_BUCKET}/${SOURCE_KEY}" "$SRC" --only-show-errors \
  || fail "Couldn't read the match from storage."

echo "[2/4] encoding proxy"
ffmpeg -nostdin -y -i "$SRC" "$@" "$OUT" </dev/null \
  || fail "Couldn't compress this match for analysis."

rm -f "$SRC" # the master is no longer needed; free the disk before uploading

SIZE=$(wc -c < "$OUT")
echo "[3/4] uploading proxy (${SIZE} bytes) to s3://${S3_BUCKET}/${PROXY_KEY}"
aws s3 cp "$OUT" "s3://${S3_BUCKET}/${PROXY_KEY}" \
  --content-type video/mp4 --only-show-errors \
  || fail "Couldn't store the compressed copy."

echo "[4/4] marking proxy ready"
# The web app polls for this flag and only then starts the TwelveLabs task.
curl -sS -f -X PATCH \
  "${SUPABASE_URL}/rest/v1/videos?id=eq.${VIDEO_ID}" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"has_analysis_proxy":true}' \
  >/dev/null || fail "Compressed the match but couldn't record it."

echo "done"
