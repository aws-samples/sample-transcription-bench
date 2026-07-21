#!/usr/bin/env bash
# scripts/deploy.sh
#
# One-command deployment for TranscribeBench. Reads `.deploy-config` (created
# from `.deploy-config.example` on first run), then runs the deployment
# phases end-to-end:
#
#   1. SageMaker model artifacts upload  (skippable: --skip-sagemaker)
#   2. cdk bootstrap (idempotent)        (skippable: --skip-bootstrap)
#   3. cdk deploy                        + write frontend/.env.production
#   4. Sample audio upload to S3         (skippable: --skip-samples)
#   5. frontend build + Amplify deploy   (creates the app on first run)
#
# Flags:
#   --frontend-only      run frontend phase only
#   --sagemaker-only     run sagemaker phase only
#   --skip-sagemaker     skip the sagemaker phase
#   --skip-samples       skip uploading sample audio after cdk deploy
#   --skip-bootstrap     skip the cdk bootstrap step
#   --config <path>      use a different config file (default: .deploy-config)
#   -h, --help           show this help

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
CONFIG_PATH="${REPO_ROOT}/.deploy-config"
RUN_SAGEMAKER=1
RUN_BACKEND=1
RUN_SAMPLES=1
RUN_FRONTEND=1
RUN_BOOTSTRAP=1

usage() {
  sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --frontend-only)   RUN_SAGEMAKER=0; RUN_BACKEND=0; RUN_SAMPLES=0; shift ;;
    --sagemaker-only)  RUN_BACKEND=0; RUN_SAMPLES=0; RUN_FRONTEND=0; shift ;;
    --skip-sagemaker)  RUN_SAGEMAKER=0; shift ;;
    --skip-samples)    RUN_SAMPLES=0; shift ;;
    --skip-bootstrap)  RUN_BOOTSTRAP=0; shift ;;
    --config)          CONFIG_PATH="$2"; shift 2 ;;
    -h|--help)         usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

# ---------------------------------------------------------------------------
# Pretty printing
# ---------------------------------------------------------------------------
say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✔\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31m✘ %s\033[0m\n' "$*" >&2; exit 1; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found on PATH: $1"
}

require_cmd aws
require_cmd npx
require_cmd jq
require_cmd curl
require_cmd zip

# ---------------------------------------------------------------------------
# Phase 0: load (or bootstrap) deploy config
# ---------------------------------------------------------------------------
if [ ! -f "$CONFIG_PATH" ]; then
  warn "Config file not found at $CONFIG_PATH"
  if [ -t 0 ] && [ -t 1 ]; then
    read -r -p "Create one from .deploy-config.example now? [Y/n] " ans
    ans="${ans:-Y}"
    if [[ "$ans" =~ ^[Yy] ]]; then
      cp "$REPO_ROOT/.deploy-config.example" "$CONFIG_PATH"
      ok "Created $CONFIG_PATH — open it, set AWS_REGION (and optionally AWS_PROFILE), then re-run."
      exit 0
    fi
  fi
  die "Copy .deploy-config.example to $CONFIG_PATH and fill it in, then re-run."
fi

# shellcheck disable=SC1090
. "$CONFIG_PATH"

# Resolve region: explicit > aws configure > us-west-2 default
if [ -z "${AWS_REGION:-}" ]; then
  AWS_REGION="$(aws configure get region 2>/dev/null || true)"
fi
if [ -z "${AWS_REGION:-}" ]; then
  AWS_REGION="us-west-2"
  warn "AWS_REGION not set; defaulting to us-west-2"
fi
export AWS_REGION
export AWS_DEFAULT_REGION="$AWS_REGION"

# Resolve account ID: explicit > sts get-caller-identity
if [ -z "${AWS_ACCOUNT_ID:-}" ]; then
  AWS_ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text 2>/dev/null || true)"
fi
if [ -z "${AWS_ACCOUNT_ID:-}" ] || [ "$AWS_ACCOUNT_ID" = "None" ]; then
  die "Could not determine AWS account ID. Verify your credentials with 'aws sts get-caller-identity'."
fi
export AWS_ACCOUNT_ID

# CDK reads these
export CDK_DEFAULT_ACCOUNT="$AWS_ACCOUNT_ID"
export CDK_DEFAULT_REGION="$AWS_REGION"

STACK_NAME="${STACK_NAME:-AudioTranscriptionStack}"
SAGEMAKER_MODEL_BUCKET="${SAGEMAKER_MODEL_BUCKET:-sagemaker-${AWS_REGION}-${AWS_ACCOUNT_ID}}"
AMPLIFY_BRANCH="${AMPLIFY_BRANCH:-main}"

say "Deployment target"
printf '   AWS account : %s\n' "$AWS_ACCOUNT_ID"
printf '   AWS region  : %s\n' "$AWS_REGION"
printf '   AWS profile : %s\n' "${AWS_PROFILE:-<default credential chain>}"
printf '   Stack       : %s\n' "$STACK_NAME"

# ---------------------------------------------------------------------------
# Phase 1: SageMaker artifacts
# ---------------------------------------------------------------------------
if [ "$RUN_SAGEMAKER" -eq 1 ]; then
  say "Phase 1/5  Uploading SageMaker model artifacts"

  # Auto-create the venv if missing or broken. The artifact upload script
  # needs huggingface_hub to download the Qwen weights. A stale .venv/ from
  # an earlier Python install (with a now-missing interpreter symlink) will
  # also trip `python3 -m venv` — wipe and rebuild in that case.
  VENV_DIR="$REPO_ROOT/.venv"
  VENV_PY="$VENV_DIR/bin/python3"
  if [ ! -x "$VENV_PY" ] || ! "$VENV_PY" -c '' >/dev/null 2>&1; then
    require_cmd python3
    if [ -d "$VENV_DIR" ]; then
      warn "Existing .venv is broken or empty — rebuilding from scratch"
      rm -rf "$VENV_DIR"
    fi
    say "Creating .venv and installing huggingface_hub"
    python3 -m venv "$VENV_DIR"
    "$VENV_DIR/bin/pip" install --quiet --upgrade pip
    "$VENV_DIR/bin/pip" install --quiet huggingface_hub
    ok "venv ready at $VENV_DIR"
  fi

  AWS_ACCOUNT_ID="$AWS_ACCOUNT_ID" AWS_REGION="$AWS_REGION" \
    SAGEMAKER_MODEL_BUCKET="$SAGEMAKER_MODEL_BUCKET" \
    bash "$SCRIPT_DIR/upload-sagemaker-artifacts.sh"
  ok "SageMaker artifacts uploaded to s3://$SAGEMAKER_MODEL_BUCKET"
else
  say "Phase 1/5  SageMaker artifacts (skipped)"
fi

# ---------------------------------------------------------------------------
# Phase 2 + 3: CDK bootstrap + deploy
# ---------------------------------------------------------------------------
if [ "$RUN_BACKEND" -eq 1 ]; then
  if [ "$RUN_BOOTSTRAP" -eq 1 ]; then
    say "Phase 2/5  cdk bootstrap (idempotent)"
    npx cdk bootstrap "aws://${AWS_ACCOUNT_ID}/${AWS_REGION}"
    ok "Bootstrap complete"
  else
    say "Phase 2/5  cdk bootstrap (skipped)"
  fi

  say "Phase 3/5  cdk deploy"
  CDK_CONTEXT_ARGS=()
  CDK_CONTEXT_ARGS+=("--context" "stack_name=${STACK_NAME}")
  CDK_CONTEXT_ARGS+=("--context" "sagemaker_model_bucket=${SAGEMAKER_MODEL_BUCKET}")
  if [ -n "${USER_POOL_NAME:-}" ]; then
    CDK_CONTEXT_ARGS+=("--context" "user_pool_name=${USER_POOL_NAME}")
  fi

  # Load SageMaker model artifact ETags (if the upload phase ran) and
  # forward them into CDK context. The CfnModel bakes these into the
  # container env map, so a new tarball -> new ETag -> CFN replaces the
  # Model -> endpoint rolls. See `sagemaker-byoc-endpoints.ts`.
  ETAG_FILE="$REPO_ROOT/.sagemaker-model-etags"
  if [ -f "$ETAG_FILE" ]; then
    # shellcheck disable=SC1090
    . "$ETAG_FILE"
    [ -n "${WHISPER_MODEL_ETAG:-}" ] \
      && CDK_CONTEXT_ARGS+=("--context" "whisper_model_etag=${WHISPER_MODEL_ETAG}")
    [ -n "${QWEN_MODEL_ETAG:-}" ] \
      && CDK_CONTEXT_ARGS+=("--context" "qwen_model_etag=${QWEN_MODEL_ETAG}")
    [ -n "${PARAKEET_MODEL_ETAG:-}" ] \
      && CDK_CONTEXT_ARGS+=("--context" "parakeet_model_etag=${PARAKEET_MODEL_ETAG}")
  fi

  npx cdk deploy "${CDK_CONTEXT_ARGS[@]}" --require-approval never
  ok "Stack deployed"

  # ---- write frontend/.env.production from CFN outputs ---------------------
  say "Writing frontend/.env.production from stack outputs"
  OUTPUTS_JSON="$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --query 'Stacks[0].Outputs' \
    --output json)"

  read_out() {
    printf '%s' "$OUTPUTS_JSON" | jq -r --arg k "$1" '.[] | select(.OutputKey==$k) | .OutputValue'
  }

  REST_API_URL="$(read_out RestApiUrl)"
  WS_URL="$(read_out WebSocketUrl)"
  USER_POOL_ID="$(read_out UserPoolId)"
  USER_POOL_CLIENT_ID="$(read_out UserPoolClientId)"
  IDENTITY_POOL_ID="$(read_out IdentityPoolId)"
  AWS_REGION_OUT="$(read_out AwsRegion)"
  AUDIO_BUCKET_NAME="$(read_out AudioBucketName)"

  for var in REST_API_URL WS_URL USER_POOL_ID USER_POOL_CLIENT_ID IDENTITY_POOL_ID AWS_REGION_OUT AUDIO_BUCKET_NAME; do
    eval "v=\${$var}"
    [ -n "$v" ] || die "Stack output for $var was empty — check CloudFormation."
  done

  cat > "$REPO_ROOT/frontend/.env.production" <<EOF
VITE_API_ENDPOINT=$REST_API_URL
VITE_WS_ENDPOINT=$WS_URL
VITE_USER_POOL_ID=$USER_POOL_ID
VITE_USER_POOL_CLIENT_ID=$USER_POOL_CLIENT_ID
VITE_IDENTITY_POOL_ID=$IDENTITY_POOL_ID
VITE_AWS_REGION=$AWS_REGION_OUT
EOF
  ok "frontend/.env.production written"
else
  say "Phase 2-3/5  Backend (skipped)"
fi

# ---------------------------------------------------------------------------
# Phase 4: upload sample audio into the audio bucket under samples/
# ---------------------------------------------------------------------------
if [ "$RUN_SAMPLES" -eq 1 ]; then
  # Resolve the bucket name. If the backend phase ran in this invocation we
  # already have it; otherwise re-read it from CFN so this phase still works
  # standalone (e.g. via --frontend-only re-runs that drop samples back in).
  if [ -z "${AUDIO_BUCKET_NAME:-}" ]; then
    AUDIO_BUCKET_NAME="$(aws cloudformation describe-stacks \
      --stack-name "$STACK_NAME" \
      --query "Stacks[0].Outputs[?OutputKey=='AudioBucketName'].OutputValue | [0]" \
      --output text 2>/dev/null | sed 's/^None$//')"
  fi

  if [ -n "${AUDIO_BUCKET_NAME:-}" ]; then
    say "Phase 4/5  Uploading sample audio to s3://${AUDIO_BUCKET_NAME}/samples/"
    bash "$SCRIPT_DIR/upload-sample-audio.sh" "$AUDIO_BUCKET_NAME"
    ok "Sample audio uploaded"
  else
    warn "Could not resolve AudioBucketName — skipping sample upload."
  fi
else
  say "Phase 4/5  Sample audio (skipped)"
fi

# ---------------------------------------------------------------------------
# Phase 4: frontend + Amplify
# ---------------------------------------------------------------------------
if [ "$RUN_FRONTEND" -eq 1 ]; then
  say "Phase 5/5  Frontend build + Amplify deploy"
  AMPLIFY_APP_ID="${AMPLIFY_APP_ID:-}" \
  AMPLIFY_BRANCH="$AMPLIFY_BRANCH" \
  AWS_REGION="$AWS_REGION" \
    bash "$SCRIPT_DIR/deploy-frontend.sh"

  # If deploy-frontend.sh created a new app, it writes the ID to
  # .deploy-amplify-app-id so we can persist it back into .deploy-config.
  NEW_APP_ID_FILE="$REPO_ROOT/.deploy-amplify-app-id"
  if [ -f "$NEW_APP_ID_FILE" ]; then
    NEW_APP_ID="$(cat "$NEW_APP_ID_FILE")"
    rm -f "$NEW_APP_ID_FILE"
    if ! grep -q '^export AMPLIFY_APP_ID=' "$CONFIG_PATH" 2>/dev/null; then
      printf '\n# Auto-added by scripts/deploy.sh on first deploy\nexport AMPLIFY_APP_ID="%s"\n' "$NEW_APP_ID" \
        >> "$CONFIG_PATH"
      ok "Persisted new AMPLIFY_APP_ID=$NEW_APP_ID to $CONFIG_PATH"
    fi
    AMPLIFY_APP_ID="$NEW_APP_ID"
  fi

  if [ -n "${AMPLIFY_APP_ID:-}" ]; then
    printf '\n\033[1;32mApp URL:\033[0m  https://%s.%s.amplifyapp.com\n' "$AMPLIFY_BRANCH" "$AMPLIFY_APP_ID"
  fi
fi

say "Done"
echo "  Sign in at the URL above with:"
echo "    email    : john.doe@example.com"
echo "    password : Test123!Demo"
