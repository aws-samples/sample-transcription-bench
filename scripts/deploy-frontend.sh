#!/usr/bin/env bash
# scripts/deploy-frontend.sh
#
# Builds the frontend Vite bundle and pushes it to AWS Amplify hosting via
# the manual zip-upload flow.
#
# Inputs (env):
#   AWS_REGION       (required)
#   AWS_PROFILE      (optional)
#   AMPLIFY_APP_ID   (optional) reuse an existing Amplify app; if empty,
#                    a new app + branch is created and its ID is written
#                    to .deploy-amplify-app-id so the caller can persist it.
#   AMPLIFY_BRANCH   (optional, default: main)
#
# Designed to be invoked by scripts/deploy.sh, but can also run standalone
# (the env vars above must be set in the caller's shell).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

: "${AWS_REGION:?AWS_REGION must be set}"
AMPLIFY_BRANCH="${AMPLIFY_BRANCH:-main}"
ZIP_PATH="${TMPDIR:-/tmp}/transcribe-bench-frontend-deploy.zip"

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✔\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m✘ %s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Build the bundle.
# ---------------------------------------------------------------------------
say "Building frontend"
[ -f "$REPO_ROOT/frontend/.env.production" ] \
  || die "frontend/.env.production missing. Run scripts/deploy.sh (it writes this file from CFN outputs)."

(
  cd "$REPO_ROOT/frontend"
  if [ ! -d node_modules ]; then
    npm ci
  fi
  npm run build
)
ok "Build artifacts in frontend/dist/"

say "Zipping bundle"
rm -f "$ZIP_PATH"
(
  cd "$REPO_ROOT/frontend/dist"
  zip -r -q "$ZIP_PATH" .
)
ok "Created $ZIP_PATH"

# ---------------------------------------------------------------------------
# Ensure an Amplify app + branch exist.
# ---------------------------------------------------------------------------
if [ -z "${AMPLIFY_APP_ID:-}" ]; then
  say "No AMPLIFY_APP_ID set — creating a new Amplify app"
  CREATE_APP_JSON="$(aws amplify create-app \
    --name "transcribe-bench" \
    --description "TranscribeBench frontend (created by scripts/deploy-frontend.sh)" \
    --custom-rules '[{"source":"</^[^.]+$|\\.(?!(css|gif|ico|jpg|js|png|txt|svg|woff|woff2|ttf|map|json|webp)$)([^.]+$)/>","target":"/index.html","status":"200"}]' \
    --region "$AWS_REGION" \
    --output json)"
  AMPLIFY_APP_ID="$(printf '%s' "$CREATE_APP_JSON" | jq -r '.app.appId')"
  [ -n "$AMPLIFY_APP_ID" ] && [ "$AMPLIFY_APP_ID" != "null" ] \
    || die "amplify create-app did not return an appId"
  ok "Created Amplify app $AMPLIFY_APP_ID"

  aws amplify create-branch \
    --app-id "$AMPLIFY_APP_ID" \
    --branch-name "$AMPLIFY_BRANCH" \
    --region "$AWS_REGION" \
    --output json >/dev/null
  ok "Created branch $AMPLIFY_BRANCH"

  # Surface the new ID to the caller (scripts/deploy.sh) so it can persist
  # it back into .deploy-config.
  printf '%s' "$AMPLIFY_APP_ID" > "$REPO_ROOT/.deploy-amplify-app-id"
else
  say "Reusing Amplify app $AMPLIFY_APP_ID"
  # Make sure the branch exists; create-branch is not idempotent.
  if ! aws amplify get-branch --app-id "$AMPLIFY_APP_ID" \
        --branch-name "$AMPLIFY_BRANCH" --region "$AWS_REGION" >/dev/null 2>&1; then
    aws amplify create-branch \
      --app-id "$AMPLIFY_APP_ID" \
      --branch-name "$AMPLIFY_BRANCH" \
      --region "$AWS_REGION" \
      --output json >/dev/null
    ok "Created missing branch $AMPLIFY_BRANCH"
  fi
fi

# ---------------------------------------------------------------------------
# Push the bundle.
# ---------------------------------------------------------------------------
say "Creating Amplify deployment slot"
DEPLOY_JSON="$(aws amplify create-deployment \
  --app-id "$AMPLIFY_APP_ID" \
  --branch-name "$AMPLIFY_BRANCH" \
  --region "$AWS_REGION" \
  --output json)"

JOB_ID="$(printf '%s' "$DEPLOY_JSON" | jq -r '.jobId')"
UPLOAD_URL="$(printf '%s' "$DEPLOY_JSON" | jq -r '.zipUploadUrl')"
[ -n "$JOB_ID" ] && [ "$JOB_ID" != "null" ] || die "create-deployment did not return jobId"
[ -n "$UPLOAD_URL" ] && [ "$UPLOAD_URL" != "null" ] || die "create-deployment did not return zipUploadUrl"

say "Uploading bundle (job $JOB_ID)"
curl -sS -T "$ZIP_PATH" "$UPLOAD_URL"
ok "Upload complete"

say "Starting deployment"
aws amplify start-deployment \
  --app-id "$AMPLIFY_APP_ID" \
  --branch-name "$AMPLIFY_BRANCH" \
  --job-id "$JOB_ID" \
  --region "$AWS_REGION" \
  --output json >/dev/null
ok "Deployment $JOB_ID started"

printf '\n  https://%s.%s.amplifyapp.com\n' "$AMPLIFY_BRANCH" "$AMPLIFY_APP_ID"
