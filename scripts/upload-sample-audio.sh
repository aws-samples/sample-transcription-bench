#!/usr/bin/env bash
# Upload sample audio files to the S3 audio bucket under the samples/ prefix.
# Usage: ./scripts/upload-sample-audio.sh <bucket-name>
#
# The bucket name is output by CDK as AudioBucketName.

set -euo pipefail

BUCKET="${1:?Usage: $0 <audio-bucket-name>}"
AUDIO_DIR="$(cd "$(dirname "$0")/../audio" && pwd)"

echo "Uploading sample audio files to s3://${BUCKET}/samples/ ..."

for file in "$AUDIO_DIR"/*.wav; do
  [ -f "$file" ] || continue
  filename="$(basename "$file")"
  echo "  → ${filename}"
  aws s3 cp "$file" "s3://${BUCKET}/samples/${filename}" --quiet
done

echo "Done."
