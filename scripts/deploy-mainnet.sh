#!/usr/bin/env bash
set -euo pipefail

# Deploy NYC Transit Live to ecloud mainnet-alpha (verifiable build).
# Expects: current branch pushed to origin/main; .env.mainnet present.

cd "$(dirname "$0")/.."

APP_ID="0x751847d2C430E3B5a843D017EA8d0A3d453377D0"
REPO="https://github.com/mmurrs/NYCTransitx402"
ENV_FILE=".env.mainnet"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "FATAL: $ENV_FILE missing" >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "FATAL: working tree dirty — commit and push first" >&2
  git status --short
  exit 1
fi

COMMIT="$(git rev-parse HEAD)"
REMOTE_COMMIT="$(git rev-parse origin/main 2>/dev/null || echo '')"
if [[ "$COMMIT" != "$REMOTE_COMMIT" ]]; then
  echo "FATAL: HEAD ($COMMIT) != origin/main ($REMOTE_COMMIT) — push first" >&2
  exit 1
fi

echo "Deploying commit $COMMIT to $APP_ID on mainnet-alpha..."

ECLOUD_ENV=mainnet-alpha ecloud compute app upgrade "$APP_ID" \
  --environment mainnet-alpha \
  --verifiable \
  --repo "$REPO" \
  --commit "$COMMIT" \
  --build-dockerfile Dockerfile \
  --env-file "$ENV_FILE" \
  --env BASE_URL=https://transit402.dev \
  --env MPP_REALM=transit402.dev \
  --instance-type g1-micro-1v \
  --log-visibility public \
  --resource-usage-monitoring enable
