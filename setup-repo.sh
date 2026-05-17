#!/bin/bash
# =====================================================================
# Website Hub — setup-repo.sh
# Run from ~/Website-hub in Termux after downloading all files to
# ~/storage/downloads/
#
# What this does:
#   1. Removes junk (nested Website-hub/ dir, empty main file, old SPA)
#   2. Updates build/launch/patch workers with new architecture code
#   3. Creates pulse-worker/ and reactivate-worker/ from scratch
#   4. Creates templates/ directory with emergency templates
#   5. Places preview-manage-new.html and deploy.yml at root
#   6. Commits and pushes to GitHub
# =====================================================================

set -e  # Stop on any error

REPO=~/Website-hub
DL=~/storage/downloads

# Colour helpers
green() { echo -e "\033[32m$1\033[0m"; }
red()   { echo -e "\033[31m$1\033[0m"; }
cyan()  { echo -e "\033[36m$1\033[0m"; }

cyan ""
cyan "=== Pre-flight: checking downloads exist ==="
REQUIRED=(
  "build-worker.js"
  "shared-services.js"
  "patch-worker.js"
  "launch-worker.js"
  "pulse-worker.js"
  "reactivate-worker.js"
  "preview-manage-new.html"
  "deploy.yml"
  "pulse-wrangler.toml"
  "reactivate-wrangler.toml"
  "emergency-css.html"
  "emergency-index.html"
  "emergency-services.html"
  "emergency-about.html"
  "emergency-contact.html"
  "emergency-p5.html"
)
MISSING=0
for f in "${REQUIRED[@]}"; do
  if [ -f "$DL/$f" ]; then
    green "  found: $f"
  else
    red "  MISSING: $f"
    MISSING=$((MISSING + 1))
  fi
done

if [ $MISSING -gt 0 ]; then
  red ""
  red "Pre-flight failed: $MISSING file(s) missing from ~/storage/downloads/"
  red "Download them from Claude, then re-run this script."
  exit 1
fi

cd "$REPO"
cyan ""
cyan "=== Step 1: Remove junk ==="
rm -rf Website-hub/         && green "  removed nested Website-hub/"
rm -f  main                 && green "  removed empty main file"
rm -f  build-worker/src/index.html && green "  removed old SPA from build-worker/src/"

cyan ""
cyan "=== Step 2: Update build-worker ==="
cp "$DL/build-worker.js"    build-worker/src/index.js       && green "  build-worker/src/index.js"
cp "$DL/shared-services.js" build-worker/src/shared-services.js && green "  build-worker/src/shared-services.js"

cyan ""
cyan "=== Step 3: Update patch-worker ==="
cp "$DL/patch-worker.js"    patch-worker/src/index.js       && green "  patch-worker/src/index.js"
cp "$DL/shared-services.js" patch-worker/src/shared-services.js && green "  patch-worker/src/shared-services.js"

cyan ""
cyan "=== Step 4: Update launch-worker ==="
cp "$DL/launch-worker.js"   launch-worker/src/index.js      && green "  launch-worker/src/index.js"
cp "$DL/shared-services.js" launch-worker/src/shared-services.js && green "  launch-worker/src/shared-services.js"

cyan ""
cyan "=== Step 5: Create pulse-worker ==="
mkdir -p pulse-worker/src
cp "$DL/pulse-worker.js"    pulse-worker/src/index.js       && green "  pulse-worker/src/index.js"
cp "$DL/shared-services.js" pulse-worker/src/shared-services.js && green "  pulse-worker/src/shared-services.js"
cp "$DL/pulse-wrangler.toml" pulse-worker/wrangler.toml     && green "  pulse-worker/wrangler.toml"

cyan ""
cyan "=== Step 6: Create reactivate-worker ==="
mkdir -p reactivate-worker/src
cp "$DL/reactivate-worker.js"   reactivate-worker/src/index.js       && green "  reactivate-worker/src/index.js"
cp "$DL/shared-services.js"     reactivate-worker/src/shared-services.js && green "  reactivate-worker/src/shared-services.js"
cp "$DL/reactivate-wrangler.toml" reactivate-worker/wrangler.toml    && green "  reactivate-worker/wrangler.toml"

cyan ""
cyan "=== Step 7: Create templates directory ==="
mkdir -p templates
cp "$DL/emergency-css.html"      templates/ && green "  templates/emergency-css.html"
cp "$DL/emergency-index.html"    templates/ && green "  templates/emergency-index.html"
cp "$DL/emergency-services.html" templates/ && green "  templates/emergency-services.html"
cp "$DL/emergency-about.html"    templates/ && green "  templates/emergency-about.html"
cp "$DL/emergency-contact.html"  templates/ && green "  templates/emergency-contact.html"
cp "$DL/emergency-p5.html"       templates/ && green "  templates/emergency-p5.html"

cyan ""
cyan "=== Step 8: Root files ==="
cp "$DL/preview-manage-new.html" preview-manage-new.html     && green "  preview-manage-new.html"
cp "$DL/deploy.yml"              .github/workflows/deploy.yml && green "  .github/workflows/deploy.yml"

cyan ""
cyan "=== Step 9: Verify no Kaspersky pollution ==="
POLLUTED=0
for f in $(find . -name "*.html" -not -path '*/.git/*'); do
  if grep -q "kaspersky-labs" "$f" 2>/dev/null; then
    red "  POLLUTED: $f"
    POLLUTED=$((POLLUTED + 1))
  fi
done
[ $POLLUTED -eq 0 ] && green "  All HTML files clean" || red "  $POLLUTED polluted file(s) — do not push"
[ $POLLUTED -gt 0 ] && exit 1

cyan ""
cyan "=== Step 10: Commit and push ==="
git config --global user.email "pierreduplessis6912@gmail.com"
git config --global user.name "pierreduplessis6912-gif"
git add -A
git status
git commit -m "Replace old 4-pass pipeline with new 7-worker modular architecture

- build/patch/launch: updated to template-based pipeline
- pulse-worker: new (daily cron, dunning, referrals, leaderboard)
- reactivate-worker: new (Meta webhook, inbound WA, opt-outs)
- templates/: emergency archetype templates (clean, no AV pollution)
- preview-manage-new.html: SPA with routing fixes and async meta load
- deploy.yml: fixed reactivate deploy (removed missing package.json step)
- removed: nested Website-hub/ directory, empty main file, old SPA"

git push origin main

cyan ""
green "=== Done! ==="
green "GitHub Actions will now deploy all 5 workers to Cloudflare."
green "Watch the Actions tab, then run the KV bootstrap once it's green."
