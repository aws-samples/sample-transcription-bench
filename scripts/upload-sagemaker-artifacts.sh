#!/usr/bin/env bash
# Downloads the Qwen3-ASR-0.6B model weights from HuggingFace, packages them
# WITH inference code inside model.tar.gz, and uploads to the SageMaker
# model bucket for BYOC deployment.
#
# The PyTorch Serving container looks for code/inference.py inside the model
# tarball to discover custom handlers. This is how the SageMaker Python SDK's
# PyTorchModel bundles source_dir into the archive.
#
# Inputs (env, all optional):
#   AWS_ACCOUNT_ID            auto-detected via `aws sts get-caller-identity`
#   AWS_REGION                falls back to `aws configure get region`
#   SAGEMAKER_MODEL_BUCKET    falls back to `sagemaker-${AWS_REGION}-${AWS_ACCOUNT_ID}`
#
# Prerequisites:
#   - .venv at the repo root with `huggingface_hub` installed
#   - AWS CLI configured with credentials for the target account
#
# Run this once before `scripts/deploy.sh` (or it'll be invoked for you).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PYTHON="$REPO_ROOT/.venv/bin/python3"

[ -x "$PYTHON" ] || {
  echo "ERROR: $PYTHON not found. Create the venv first:" >&2
  echo "  python3 -m venv .venv && .venv/bin/pip install huggingface_hub" >&2
  exit 1
}

if [ -z "${AWS_ACCOUNT_ID:-}" ]; then
  AWS_ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text 2>/dev/null || true)"
fi
if [ -z "${AWS_REGION:-}" ]; then
  AWS_REGION="$(aws configure get region 2>/dev/null || true)"
fi
[ -n "${AWS_ACCOUNT_ID:-}" ] && [ "$AWS_ACCOUNT_ID" != "None" ] \
  || { echo "ERROR: could not determine AWS_ACCOUNT_ID" >&2; exit 1; }
[ -n "${AWS_REGION:-}" ] \
  || { echo "ERROR: AWS_REGION not set and not configured in AWS CLI" >&2; exit 1; }

BUCKET="${SAGEMAKER_MODEL_BUCKET:-sagemaker-${AWS_REGION}-${AWS_ACCOUNT_ID}}"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT INT TERM
echo "Working directory: $TMP_DIR"
echo "Target bucket    : s3://$BUCKET ($AWS_REGION)"

# --- Ensure destination bucket exists ---
echo "=== Ensuring bucket s3://$BUCKET exists ==="
if ! aws s3api head-bucket --bucket "$BUCKET" --region "$AWS_REGION" 2>/dev/null; then
  echo "Creating bucket $BUCKET in $AWS_REGION..."
  if [ "$AWS_REGION" = "us-east-1" ]; then
    aws s3api create-bucket --bucket "$BUCKET" --region "$AWS_REGION"
  else
    aws s3api create-bucket \
      --bucket "$BUCKET" \
      --region "$AWS_REGION" \
      --create-bucket-configuration LocationConstraint="$AWS_REGION"
  fi
fi

# ============================================================
# QWEN3 ASR 0.6B
# ============================================================
echo ""
echo "=========================================="
echo "  Qwen3 ASR 0.6B"
echo "=========================================="

QWEN_DIR="$TMP_DIR/qwen-asr"
mkdir -p "$QWEN_DIR/code"

echo "Downloading Qwen3-ASR-0.6B from HuggingFace..."
"$PYTHON" -c "
from huggingface_hub import snapshot_download
snapshot_download(repo_id='Qwen/Qwen3-ASR-0.6B', local_dir='$QWEN_DIR')
print('Download complete.')
"

cp "$REPO_ROOT/backend/workers/sagemaker/qwen-asr/inference.py" "$QWEN_DIR/code/"
cp "$REPO_ROOT/backend/workers/sagemaker/qwen-asr/requirements.txt" "$QWEN_DIR/code/"

echo "Packaging model.tar.gz..."
tar -czf "$TMP_DIR/qwen-model.tar.gz" -C "$QWEN_DIR" .

echo "Uploading model.tar.gz to S3..."
aws s3 cp "$TMP_DIR/qwen-model.tar.gz" \
  "s3://$BUCKET/qwen-asr/model.tar.gz" --region "$AWS_REGION"

QWEN_ETAG=$(aws s3api head-object --bucket "$BUCKET" --key "qwen-asr/model.tar.gz" \
  --region "$AWS_REGION" --query 'ETag' --output text | tr -d '"')
echo "Qwen model.tar.gz ETag: $QWEN_ETAG"

echo ""
echo "Done. Qwen ASR artifacts uploaded to s3://$BUCKET/qwen-asr/model.tar.gz"

# ============================================================
# DISTIL-WHISPER LARGE V3 (BYOC, mirrors the Qwen pattern)
#
# We swapped openai/whisper-large-v3 -> distil-whisper/distil-large-v3.
# Same architecture family (Whisper encoder-decoder) but the decoder is
# 2 layers instead of 32, giving ~6x faster inference at ~1% WER cost on
# English. This keeps us under the SageMaker real-time sync 60 s
# InvokeEndpoint cap without switching to InvokeEndpointWithResponseStream
# or moving off real-time inference.
#
# We keep the S3 key, container inference code path, endpoint construct
# name, and DynamoDB modelId (`sagemaker-whisper-large-v3`) unchanged so
# no infra rename is needed. Only the model weights and the display name
# in the catalog change.
#
# Trade-off: distil-large-v3 is English-only. If multilingual matters
# again later, switch back to openai/whisper-large-v3 (all the code here
# works identically for either).
# ============================================================
echo ""
echo "=========================================="
echo "  Distil-Whisper Large v3"
echo "=========================================="

WHISPER_DIR="$TMP_DIR/whisper-large-v3"
mkdir -p "$WHISPER_DIR/code"

echo "Downloading distil-whisper/distil-large-v3 from HuggingFace..."
# `allow_patterns` keeps the tarball lean — we only need the safetensors
# weights and the processor/tokenizer configs the BYOC inference handler
# loads. Original pickled .bin files would double the size.
"$PYTHON" -c "
from huggingface_hub import snapshot_download
snapshot_download(
    repo_id='distil-whisper/distil-large-v3',
    local_dir='$WHISPER_DIR',
    allow_patterns=[
        '*.json',
        '*.txt',
        'preprocessor_config.json',
        'generation_config.json',
        'tokenizer.json',
        'tokenizer_config.json',
        'normalizer.json',
        'special_tokens_map.json',
        'added_tokens.json',
        'vocab.json',
        'merges.txt',
        'model.safetensors',
    ],
)
print('Download complete.')
"

cp "$REPO_ROOT/backend/workers/sagemaker/whisper-large-v3/inference.py" "$WHISPER_DIR/code/"
cp "$REPO_ROOT/backend/workers/sagemaker/whisper-large-v3/requirements.txt" "$WHISPER_DIR/code/"

echo "Packaging model.tar.gz..."
tar -czf "$TMP_DIR/whisper-model.tar.gz" -C "$WHISPER_DIR" .

echo "Uploading model.tar.gz to S3..."
aws s3 cp "$TMP_DIR/whisper-model.tar.gz" \
  "s3://$BUCKET/whisper-large-v3/model.tar.gz" --region "$AWS_REGION"

WHISPER_ETAG=$(aws s3api head-object --bucket "$BUCKET" --key "whisper-large-v3/model.tar.gz" \
  --region "$AWS_REGION" --query 'ETag' --output text | tr -d '"')
echo "Distil-Whisper model.tar.gz ETag: $WHISPER_ETAG"

echo ""
echo "Done. Distil-Whisper artifacts uploaded to s3://$BUCKET/whisper-large-v3/model.tar.gz"

# ============================================================
# NVIDIA PARAKEET TDT 0.6B v3 (BYOC)
#
# NeMo model — different loader path from HF transformers, hence its
# own inference.py under backend/workers/sagemaker/nvidia-parakeet/.
# HuggingFace only publishes the single .nemo checkpoint (no config
# files, no tokenizer files) since NeMo bundles everything inside the
# .nemo archive itself.
# ============================================================
echo ""
echo "=========================================="
echo "  NVIDIA Parakeet TDT 0.6B v3"
echo "=========================================="

PARAKEET_DIR="$TMP_DIR/nvidia-parakeet"
mkdir -p "$PARAKEET_DIR/code"
PARAKEET_NEMO_FILE="parakeet-tdt-0.6b-v3.nemo"

echo "Downloading nvidia/parakeet-tdt-0.6b-v3 from HuggingFace..."
"$PYTHON" -c "
from huggingface_hub import hf_hub_download
path = hf_hub_download(
    repo_id='nvidia/parakeet-tdt-0.6b-v3',
    filename='$PARAKEET_NEMO_FILE',
    local_dir='$PARAKEET_DIR',
)
print('Download complete:', path)
"

cp "$REPO_ROOT/backend/workers/sagemaker/nvidia-parakeet/inference.py"    "$PARAKEET_DIR/code/"
cp "$REPO_ROOT/backend/workers/sagemaker/nvidia-parakeet/requirements.txt" "$PARAKEET_DIR/code/"

echo "Packaging model.tar.gz..."
tar -czf "$TMP_DIR/parakeet-model.tar.gz" -C "$PARAKEET_DIR" .

echo "Uploading model.tar.gz to S3..."
aws s3 cp "$TMP_DIR/parakeet-model.tar.gz" \
  "s3://$BUCKET/nvidia-parakeet/model.tar.gz" --region "$AWS_REGION"

PARAKEET_ETAG=$(aws s3api head-object --bucket "$BUCKET" --key "nvidia-parakeet/model.tar.gz" \
  --region "$AWS_REGION" --query 'ETag' --output text | tr -d '"')
echo "Parakeet model.tar.gz ETag: $PARAKEET_ETAG"

echo ""
echo "Done. Parakeet artifacts uploaded to s3://$BUCKET/nvidia-parakeet/model.tar.gz"

# ============================================================
# Persist ETags so scripts/deploy.sh can pass them to CDK.
#
# CDK bakes these into each container's env map. Any change to the
# tarball changes the ETag -> CDK sees CfnModel props changed -> CFN
# creates a new Model resource -> EndpointConfig is replaced -> the
# endpoint blue/green rolls with the new artifact. This is what makes
# `scripts/deploy.sh` after `scripts/upload-sagemaker-artifacts.sh`
# actually pick up code / weight changes; without it, SageMaker
# snapshots the artifact at Model creation time and re-uploads to the
# same S3 key are silently ignored.
# ============================================================
ETAG_FILE="$REPO_ROOT/.sagemaker-model-etags"
cat > "$ETAG_FILE" <<EOF
# Auto-generated by scripts/upload-sagemaker-artifacts.sh. Consumed by
# scripts/deploy.sh -> CDK context. Do not edit by hand and do not commit.
export WHISPER_MODEL_ETAG="$WHISPER_ETAG"
export QWEN_MODEL_ETAG="$QWEN_ETAG"
export PARAKEET_MODEL_ETAG="$PARAKEET_ETAG"
EOF
echo ""
echo "Wrote artifact ETags to $ETAG_FILE"
