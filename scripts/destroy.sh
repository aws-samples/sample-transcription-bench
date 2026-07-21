#!/usr/bin/env bash
# scripts/destroy.sh
#
# Tear-down counterpart to `scripts/deploy.sh`. Reads `.deploy-config` and
# removes everything `deploy.sh` provisions in the target AWS account:
#
#   1. Amplify app                       (skippable: --skip-amplify)
#   2. CDK stack (cdk destroy)           (skippable: --skip-backend)
#   3. CloudWatch log groups             (skippable: --skip-logs)
#   4. SageMaker model bucket            (skippable: --skip-sagemaker)
#   5. CDK bootstrap stack (CDKToolkit)  (off by default; opt-in: --remove-bootstrap)
#
# The CDK stack takes care of the audio bucket, DynamoDB table, Cognito
# User Pool / Identity Pool, Lambdas, API Gateway, and SageMaker
# endpoints. CDK's `LogGroup` construct defaults to `RemovalPolicy.RETAIN`
# though, and SageMaker endpoint log groups (`/aws/sagemaker/Endpoints/*`)
# are managed by SageMaker rather than CDK, so both accumulate across
# repeated deploy/destroy cycles. Phase 3 sweeps them up.
#
# Flags:
#   --amplify-only        only delete the Amplify app
#   --backend-only        only run cdk destroy
#   --logs-only           only delete CloudWatch log groups
#   --sagemaker-only      only empty + delete the SageMaker model bucket
#   --skip-amplify        skip Amplify deletion
#   --skip-backend        skip cdk destroy
#   --skip-logs           skip CloudWatch log group cleanup
#   --skip-sagemaker      skip SageMaker model bucket deletion
#   --remove-bootstrap    also delete the shared CDKToolkit bootstrap stack
#                         (use with care — affects every CDK app in the
#                         account/region, not just this one)
#   --config <path>       use a different config file (default: .deploy-config)
#   -y, --yes             skip the interactive confirmation prompt
#   -h, --help            show this help

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
CONFIG_PATH="${REPO_ROOT}/.deploy-config"
RUN_AMPLIFY=1
RUN_BACKEND=1
RUN_LOGS=1
RUN_SAGEMAKER=1
RUN_BOOTSTRAP=0
ASSUME_YES=0

usage() {
  # Print the leading comment block (everything from line 2 up to the first
  # non-`#` line), stripping the leading `# ` from each line.
  awk 'NR==1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --amplify-only)      RUN_BACKEND=0; RUN_LOGS=0; RUN_SAGEMAKER=0; shift ;;
    --backend-only)      RUN_AMPLIFY=0; RUN_LOGS=0; RUN_SAGEMAKER=0; shift ;;
    --logs-only)         RUN_AMPLIFY=0; RUN_BACKEND=0; RUN_SAGEMAKER=0; shift ;;
    --sagemaker-only)    RUN_AMPLIFY=0; RUN_BACKEND=0; RUN_LOGS=0; shift ;;
    --skip-amplify)      RUN_AMPLIFY=0; shift ;;
    --skip-backend)      RUN_BACKEND=0; shift ;;
    --skip-logs)         RUN_LOGS=0; shift ;;
    --skip-sagemaker)    RUN_SAGEMAKER=0; shift ;;
    --remove-bootstrap)  RUN_BOOTSTRAP=1; shift ;;
    --config)            CONFIG_PATH="$2"; shift 2 ;;
    -y|--yes)            ASSUME_YES=1; shift ;;
    -h|--help)           usage; exit 0 ;;
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

# ---------------------------------------------------------------------------
# Phase 0: load deploy config
# ---------------------------------------------------------------------------
if [ ! -f "$CONFIG_PATH" ]; then
  die "Config file not found at $CONFIG_PATH. Nothing to tear down without knowing the target account/region."
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

say "Tear-down target"
printf '   AWS account : %s\n' "$AWS_ACCOUNT_ID"
printf '   AWS region  : %s\n' "$AWS_REGION"
printf '   AWS profile : %s\n' "${AWS_PROFILE:-<default credential chain>}"
printf '   Stack       : %s\n' "$STACK_NAME"
[ "$RUN_AMPLIFY" -eq 1 ]   && printf '   Amplify app : %s\n' "${AMPLIFY_APP_ID:-<none configured>}"
[ "$RUN_LOGS" -eq 1 ]      && printf '   Log groups  : %s* + /aws/lambda/%s* + /aws/sagemaker/Endpoints/SageMakerByocEndpoints*\n' \
                              "$STACK_NAME" "$STACK_NAME"
[ "$RUN_SAGEMAKER" -eq 1 ] && printf '   SM bucket   : s3://%s\n' "$SAGEMAKER_MODEL_BUCKET"
[ "$RUN_BOOTSTRAP" -eq 1 ] && printf '   Bootstrap   : CDKToolkit (will be removed)\n'

# ---------------------------------------------------------------------------
# Confirmation
# ---------------------------------------------------------------------------
if [ "$ASSUME_YES" -ne 1 ]; then
  if [ ! -t 0 ] || [ ! -t 1 ]; then
    die "Refusing to run a destructive teardown non-interactively without --yes."
  fi
  printf '\n\033[1;31mThis will permanently delete the resources listed above.\033[0m\n'
  read -r -p "Type the account ID (${AWS_ACCOUNT_ID}) to confirm: " typed
  if [ "$typed" != "$AWS_ACCOUNT_ID" ]; then
    die "Account ID did not match — aborting."
  fi
fi

# ---------------------------------------------------------------------------
# Phase 1: Amplify app
# ---------------------------------------------------------------------------
if [ "$RUN_AMPLIFY" -eq 1 ]; then
  if [ -n "${AMPLIFY_APP_ID:-}" ]; then
    say "Phase 1/5  Deleting Amplify app $AMPLIFY_APP_ID"
    if aws amplify get-app --app-id "$AMPLIFY_APP_ID" --region "$AWS_REGION" >/dev/null 2>&1; then
      aws amplify delete-app \
        --app-id "$AMPLIFY_APP_ID" \
        --region "$AWS_REGION" \
        --output json >/dev/null
      ok "Amplify app $AMPLIFY_APP_ID deleted"
    else
      warn "Amplify app $AMPLIFY_APP_ID not found in $AWS_REGION — already deleted?"
    fi

    # Strip the auto-added AMPLIFY_APP_ID export from .deploy-config so a
    # subsequent deploy.sh run creates a fresh app instead of trying to reuse
    # the dead ID.
    if grep -qE '^[[:space:]]*export AMPLIFY_APP_ID=' "$CONFIG_PATH" 2>/dev/null; then
      tmp="$(mktemp)"
      # Drop the export line and the auto-added comment immediately above
      # it, if present.
      awk '
        /^# Auto-added by scripts\/deploy\.sh on first deploy$/ { saved=$0; next }
        /^[[:space:]]*export AMPLIFY_APP_ID=/ { saved=""; next }
        { if (saved != "") { print saved; saved="" } print }
        END { if (saved != "") print saved }
      ' "$CONFIG_PATH" > "$tmp"
      mv "$tmp" "$CONFIG_PATH"
      ok "Removed AMPLIFY_APP_ID from $CONFIG_PATH"
    fi
  else
    say "Phase 1/5  Amplify (no AMPLIFY_APP_ID configured — nothing to delete)"
  fi
else
  say "Phase 1/5  Amplify (skipped)"
fi

# ---------------------------------------------------------------------------
# Phase 2: cdk destroy
# ---------------------------------------------------------------------------
if [ "$RUN_BACKEND" -eq 1 ]; then
  say "Phase 2/5  cdk destroy ($STACK_NAME)"
  if aws cloudformation describe-stacks \
       --stack-name "$STACK_NAME" --region "$AWS_REGION" >/dev/null 2>&1; then
    CDK_CONTEXT_ARGS=()
    CDK_CONTEXT_ARGS+=("--context" "stack_name=${STACK_NAME}")
    CDK_CONTEXT_ARGS+=("--context" "sagemaker_model_bucket=${SAGEMAKER_MODEL_BUCKET}")
    if [ -n "${USER_POOL_NAME:-}" ]; then
      CDK_CONTEXT_ARGS+=("--context" "user_pool_name=${USER_POOL_NAME}")
    fi
    npx cdk destroy "${CDK_CONTEXT_ARGS[@]}" --force
    ok "Stack $STACK_NAME destroyed"
  else
    warn "Stack $STACK_NAME not found in $AWS_REGION — already destroyed?"
  fi
else
  say "Phase 2/5  cdk destroy (skipped)"
fi

# ---------------------------------------------------------------------------
# Phase 3: CloudWatch log group cleanup
#
# CDK's LogGroup construct default is RemovalPolicy.RETAIN, so cdk destroy
# leaves every log group behind. SageMaker endpoint log groups
# (`/aws/sagemaker/Endpoints/*`) are created by SageMaker itself, not CDK,
# so they persist regardless of any RemovalPolicy setting. Both accumulate
# across repeated deploys because CDK generates new random suffixes each
# time, producing a fresh set of orphaned groups per deploy.
#
# We sweep three prefixes:
#   - `${STACK_NAME}-*`                       CDK auto-generated log group names
#                                             (e.g. `AudioTranscriptionStack-EvaluatorEvaluatorLogGroup...`)
#   - `/aws/lambda/${STACK_NAME}-*`           any Lambda that fell back to
#                                             the /aws/lambda/<fn> default
#   - `/aws/sagemaker/Endpoints/SageMakerByocEndpoints*`
#                                             SageMaker BYOC endpoint logs
#
# The SageMaker prefix isn't stack-scoped; it targets the endpoint
# construct name defined in `infra/lib/main-stack.ts` and will match every
# past incarnation of both the Whisper and Qwen endpoints in this account
# and region.
# ---------------------------------------------------------------------------
delete_log_groups_with_prefix() {
  local prefix="$1"
  local next_token=""
  local deleted=0

  while :; do
    local args=(--log-group-name-prefix "$prefix" --region "$AWS_REGION" --output json)
    [ -n "$next_token" ] && args+=(--starting-token "$next_token")

    local page
    page="$(aws logs describe-log-groups "${args[@]}" 2>/dev/null || echo '{}')"

    local names
    names="$(printf '%s' "$page" | jq -r '.logGroups[]?.logGroupName')"
    if [ -n "$names" ]; then
      while IFS= read -r name; do
        [ -z "$name" ] && continue
        if aws logs delete-log-group \
             --log-group-name "$name" \
             --region "$AWS_REGION" 2>/dev/null; then
          printf '  deleted: %s\n' "$name"
          deleted=$((deleted + 1))
        else
          # Concurrent deletes or ResourceNotFoundException — log and move on.
          printf '  skipped (already gone or in use): %s\n' "$name"
        fi
      done <<< "$names"
    fi

    next_token="$(printf '%s' "$page" | jq -r '.nextToken // empty')"
    [ -z "$next_token" ] && break
  done

  printf '  %d log group(s) matched prefix "%s"\n' "$deleted" "$prefix"
}

if [ "$RUN_LOGS" -eq 1 ]; then
  say "Phase 3/5  Deleting CloudWatch log groups"
  delete_log_groups_with_prefix "${STACK_NAME}-"
  delete_log_groups_with_prefix "/aws/lambda/${STACK_NAME}-"
  delete_log_groups_with_prefix "/aws/sagemaker/Endpoints/SageMakerByocEndpoints"
  ok "Log group cleanup complete"
else
  say "Phase 3/5  CloudWatch log groups (skipped)"
fi

# ---------------------------------------------------------------------------
# Phase 4: SageMaker model bucket
#
# `upload-sagemaker-artifacts.sh` creates this bucket outside the CDK stack,
# so `cdk destroy` does not touch it. Empty it (including any non-current
# versions and delete-markers in case versioning was ever turned on) and
# then remove the bucket itself.
# ---------------------------------------------------------------------------
empty_versioned_bucket() {
  local bucket="$1"

  while :; do
    local payload
    payload="$(aws s3api list-object-versions \
      --bucket "$bucket" \
      --region "$AWS_REGION" \
      --max-items 1000 \
      --output json 2>/dev/null || echo '{}')"

    local to_delete
    to_delete="$(printf '%s' "$payload" | jq -c '
      {
        Objects: ([(.Versions // []), (.DeleteMarkers // [])]
                  | add
                  | map({Key: .Key, VersionId: .VersionId})),
        Quiet: true
      }
    ')"

    local count
    count="$(printf '%s' "$to_delete" | jq '.Objects | length')"
    if [ "$count" -eq 0 ]; then
      break
    fi

    aws s3api delete-objects \
      --bucket "$bucket" \
      --region "$AWS_REGION" \
      --delete "$to_delete" \
      >/dev/null
  done
}

if [ "$RUN_SAGEMAKER" -eq 1 ]; then
  say "Phase 4/5  Deleting SageMaker model bucket s3://$SAGEMAKER_MODEL_BUCKET"
  if aws s3api head-bucket \
       --bucket "$SAGEMAKER_MODEL_BUCKET" \
       --region "$AWS_REGION" 2>/dev/null; then
    empty_versioned_bucket "$SAGEMAKER_MODEL_BUCKET"
    aws s3api delete-bucket \
      --bucket "$SAGEMAKER_MODEL_BUCKET" \
      --region "$AWS_REGION"
    ok "Bucket s3://$SAGEMAKER_MODEL_BUCKET deleted"
  else
    warn "Bucket s3://$SAGEMAKER_MODEL_BUCKET not found in $AWS_REGION — already deleted?"
  fi
else
  say "Phase 4/5  SageMaker model bucket (skipped)"
fi

# ---------------------------------------------------------------------------
# Phase 5: CDK bootstrap stack (opt-in)
#
# CDKToolkit is shared by every CDK app in the account/region. Only delete
# it when the operator explicitly asks.
# ---------------------------------------------------------------------------
if [ "$RUN_BOOTSTRAP" -eq 1 ]; then
  say "Phase 5/5  Removing CDKToolkit bootstrap stack"

  # Empty the staging bucket first (CFN can't delete a non-empty bucket).
  STAGING_BUCKET="$(aws cloudformation describe-stacks \
    --stack-name CDKToolkit \
    --region "$AWS_REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='BucketName'].OutputValue | [0]" \
    --output text 2>/dev/null | sed 's/^None$//')"

  if [ -n "${STAGING_BUCKET:-}" ]; then
    say "Emptying CDK staging bucket s3://$STAGING_BUCKET"
    empty_versioned_bucket "$STAGING_BUCKET"
    ok "Staging bucket emptied"
  fi

  if aws cloudformation describe-stacks \
       --stack-name CDKToolkit --region "$AWS_REGION" >/dev/null 2>&1; then
    aws cloudformation delete-stack \
      --stack-name CDKToolkit \
      --region "$AWS_REGION"
    say "Waiting for CDKToolkit stack delete to complete"
    aws cloudformation wait stack-delete-complete \
      --stack-name CDKToolkit \
      --region "$AWS_REGION"
    ok "CDKToolkit stack deleted"
  else
    warn "CDKToolkit stack not found in $AWS_REGION — already gone?"
  fi
else
  say "Phase 5/5  CDKToolkit bootstrap (skipped — pass --remove-bootstrap to remove)"
fi

say "Done"
echo "  All requested resources have been removed from $AWS_ACCOUNT_ID/$AWS_REGION."
