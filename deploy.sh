#!/usr/bin/env bash
# ============================================================
# Website Hub — Deploy Script
# Run from the website-hub/ root folder.
# Usage: bash deploy.sh [build|patch|launch|all]
# ============================================================

set -e

WORKERS=("build-worker" "patch-worker" "launch-worker")
WORKER_NAMES=("wh-build" "wh-patch" "wh-launch")

deploy_worker() {
  local dir=$1
  local name=$2
  echo ""
  echo "▶ Deploying $name from ./$dir ..."
  cd "$dir"
  npx wrangler deploy
  cd ..
  echo "✓ $name deployed"
}

case "${1:-all}" in
  build)  deploy_worker "build-worker"  "wh-build"  ;;
  patch)  deploy_worker "patch-worker"  "wh-patch"  ;;
  launch) deploy_worker "launch-worker" "wh-launch" ;;
  all)
    for i in "${!WORKERS[@]}"; do
      deploy_worker "${WORKERS[$i]}" "${WORKER_NAMES[$i]}"
    done
    echo ""
    echo "✅ All workers deployed."
    echo ""
    echo "Next steps:"
    echo "  1. Check each worker appears in Cloudflare dashboard"
    echo "  2. Bootstrap the SPA (see README.md)"
    echo "  3. Delete KV key: system:claude_model"
    ;;
  *)
    echo "Usage: bash deploy.sh [build|patch|launch|all]"
    exit 1
    ;;
esac
