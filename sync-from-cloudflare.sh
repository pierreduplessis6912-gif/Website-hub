#!/usr/bin/env bash
# ============================================================
# Website Hub — Cloudflare Sync Report
#
# Verifies that what's in your local repo and main branch matches
# what's actually deployed on Cloudflare (workers, KV, D1, R2).
#
# Usage:
#   cd ~/Website-hub
#   bash sync-from-cloudflare.sh
#
# Requires: wrangler (you already use it), gh (optional), git
# All Cloudflare API calls go through wrangler — no direct curls.
# ============================================================

set -uo pipefail

# ── CONFIG ─────────────────────────────────────────────────
WORKERS=(
  "build-worker:wh-build"
  "patch-worker:wh-patch"
  "launch-worker:wh-launch"
  "pulse-worker:wh-pulse"
  "reactivate-worker:wh-reactivate"
)
KV_BINDING="SITES"
D1_DB="website-hub-db"
R2_BUCKET="wh-assets"

KV_HTML_KEYS=("app:start-v2" "app:intake-experience" "app:preview-manage")
ARCHETYPES=("emergency" "experience" "local" "results" "trust")
TPL_PAGES=("index" "services" "about" "contact" "css" "p5")

# ── LOCATE REPO ────────────────────────────────────────────
if [ -d "build-worker" ] && [ -d "migrations" ]; then
  REPO_ROOT="$PWD"
elif [ -d "$HOME/Website-hub/build-worker" ]; then
  REPO_ROOT="$HOME/Website-hub"
else
  echo "✗ Can't find Website-hub repo. cd into it first."
  exit 1
fi
cd "$REPO_ROOT"
REPORT="$REPO_ROOT/cf-sync-report"
rm -rf "$REPORT"
mkdir -p "$REPORT"/{kv,d1,r2,secrets,meta,diffs,actions}

echo "▶ Repo: $REPO_ROOT"
echo "▶ Report → $REPORT"

# ── HELPERS ────────────────────────────────────────────────
hdr()  { printf "\n═══ %s ═══\n" "$1"; }
ok()   { printf "  ✓ %s\n" "$*"; }
bad()  { printf "  ✗ %s\n" "$*"; }
warn() { printf "  ⚠ %s\n" "$*"; }

ISSUES=0
note_issue() { ISSUES=$((ISSUES+1)); }

# ── 1. GIT: LOCAL vs origin/main ───────────────────────────
hdr "1. Local git vs origin/main"
git fetch origin main >/dev/null 2>&1 || warn "git fetch failed (offline?)"
local_sha=$(git rev-parse HEAD 2>/dev/null || echo "?")
remote_sha=$(git rev-parse origin/main 2>/dev/null || echo "?")
echo "  Local HEAD:  $local_sha"
echo "  origin/main: $remote_sha"
if [ "$local_sha" = "$remote_sha" ]; then
  ok "Local matches origin/main"
else
  warn "Local is BEHIND origin/main — run 'git pull' first"
  note_issue
  git log --oneline "$local_sha..$remote_sha" 2>/dev/null | head -20 | sed 's/^/    /'
fi
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  warn "Uncommitted local changes:"
  git status --short | head -20 | sed 's/^/    /'
fi

# ── 2. GITHUB ACTIONS — last 5 deploy runs ─────────────────
hdr "2. GitHub Actions deploy status"
if command -v gh >/dev/null 2>&1; then
  gh run list --limit 5 --workflow="Deploy Workers" > "$REPORT/actions/recent.txt" 2>&1 \
    || gh run list --limit 5 > "$REPORT/actions/recent.txt" 2>&1
  head -6 "$REPORT/actions/recent.txt" | sed 's/^/  /'
  if grep -q "completed.*failure\|completed.*startup_failure" "$REPORT/actions/recent.txt" 2>/dev/null; then
    warn "Recent deploys failed — see $REPORT/actions/recent.txt"
    note_issue
  else
    ok "Recent runs look clean"
  fi
else
  warn "gh CLI not installed — skipping Actions check"
fi

# ── 3. DEPLOYED WORKER METADATA ────────────────────────────
hdr "3. Deployed worker versions"
for spec in "${WORKERS[@]}"; do
  dir="${spec%%:*}"; name="${spec##*:}"
  if [ ! -d "$dir" ]; then bad "$name — local folder missing"; note_issue; continue; fi
  out="$REPORT/meta/$name.deployments.txt"
  if (cd "$dir" && npx wrangler deployments list 2>&1 | head -25 > "$out"); then
    latest=$(grep -m1 -E "Version|Created|Tag" "$out" | head -1 | tr -d '\n' | cut -c1-100)
    ok "$name — see $out"
  else
    bad "$name — deployments list failed (auth? not logged in?)"
    note_issue
  fi
done

# ── 4. KV INVENTORY ────────────────────────────────────────
hdr "4. KV namespace ($KV_BINDING) inventory"
kv_list="$REPORT/kv/keys.json"
if (cd build-worker && npx wrangler kv key list --binding="$KV_BINDING" --remote > "$kv_list" 2>/dev/null); then
  total=$(grep -c '"name"' "$kv_list" 2>/dev/null | tr -d ' \n' || echo "0")
  ok "Listed $total keys → $kv_list"

  # Critical app HTML
  echo "  Critical app HTML:"
  for k in "${KV_HTML_KEYS[@]}"; do
    if grep -q "\"$k\"" "$kv_list" 2>/dev/null; then
      ok "    $k present"
      safe_name=$(echo "$k" | tr ':/' '__')
      (cd build-worker && npx wrangler kv key get --binding="$KV_BINDING" --remote "$k" > "$REPORT/kv/$safe_name.html" 2>/dev/null) || true
    else
      bad "    $k MISSING from KV"
      note_issue
    fi
  done

  # Templates: 5 archetypes × 6 pages = 30
  echo "  Templates (expecting 30):"
  found=0; missing=()
  for a in "${ARCHETYPES[@]}"; do
    for p in "${TPL_PAGES[@]}"; do
      if grep -q "\"template:$a:$p\"" "$kv_list" 2>/dev/null; then
        found=$((found+1))
      else
        missing+=("template:$a:$p")
      fi
    done
  done
  if [ "$found" -eq 30 ]; then
    ok "    All 30 templates in KV"
  else
    warn "    Only $found/30 templates — missing:"
    printf '      %s\n' "${missing[@]}"
    note_issue
  fi

  # Flag keys we care about
  echo "  Config/flag keys:"
  for k in "config:outbound" "flag:OUTBOUND_ENABLED" "flag:REFERRAL_ENABLED" "system:claude_model"; do
    if grep -q "\"$k\"" "$kv_list" 2>/dev/null; then
      ok "    $k present"
    else
      warn "    $k not set"
    fi
  done
else
  bad "wrangler kv key list failed — check auth (npx wrangler login) + binding name in build-worker/wrangler.toml"
  note_issue
fi

# ── 5. D1 SCHEMA EXPORT ─────────────────────────────────────
hdr "5. D1 schema ($D1_DB)"
d1_schema="$REPORT/d1/schema.sql"
if (cd build-worker && npx wrangler d1 export "$D1_DB" --remote --no-data --output="$d1_schema" >/dev/null 2>&1); then
  ok "Schema exported → $d1_schema"
  if [ -f migrations/0001_initial_schema.sql ]; then
    # Normalised diff: just compare CREATE TABLE / CREATE INDEX lines
    diff_out="$REPORT/diffs/d1-schema.diff"
    diff <(grep -iE "^create (table|index)" "$d1_schema" | sort) \
         <(grep -iE "^create (table|index)" migrations/0001_initial_schema.sql | sort) \
         > "$diff_out" 2>&1
    if [ ! -s "$diff_out" ]; then
      ok "Deployed schema matches migrations/0001_initial_schema.sql"
    else
      warn "Schema DIFFERS from migration → $diff_out"
      note_issue
    fi
  fi
else
  bad "d1 export failed — check $D1_DB exists and you're logged in"
  note_issue
fi

# ── 6. R2 BUCKET ───────────────────────────────────────────
hdr "6. R2 bucket ($R2_BUCKET)"
r2_list="$REPORT/r2/objects.txt"
if (cd build-worker && npx wrangler r2 object list "$R2_BUCKET" --remote > "$r2_list" 2>/dev/null) \
  || (cd build-worker && npx wrangler r2 object get "$R2_BUCKET" --remote > "$r2_list" 2>/dev/null); then
  count=$(grep -cE '^[a-zA-Z0-9]' "$r2_list" 2>/dev/null | tr -d ' \n' || echo "0")
  ok "$count R2 objects in $R2_BUCKET → $r2_list"
else
  warn "r2 listing failed (may need different perms — not critical)"
fi

# ── 7. SECRETS (names only — never values) ─────────────────
hdr "7. Secret NAMES per worker"
for spec in "${WORKERS[@]}"; do
  dir="${spec%%:*}"; name="${spec##*:}"
  [ -d "$dir" ] || continue
  out="$REPORT/secrets/$name.txt"
  if (cd "$dir" && npx wrangler secret list > "$out" 2>&1); then
    n=$(grep -c '"name"' "$out" 2>/dev/null | tr -d ' \n' || echo "0")
    ok "$name — $n secrets set"
  else
    warn "$name — secret list failed"
  fi
done

# ── 8. KV HTML vs LOCAL FILE DIFF ──────────────────────────
hdr "8. KV HTML vs local file (drift check)"
# Map KV key → expected local file
KV_KEY_FILES=(
  "app:start-v2|start-v2.html"
  "app:intake-experience|intake-experience.html"
  "app:preview-manage|preview-manage-new.html"
)
for entry in "${KV_KEY_FILES[@]}"; do
  kvkey="${entry%%|*}"
  local_file="${entry##*|}"
  safe_name=$(echo "$kvkey" | tr ':/' '__')
  kv_file="$REPORT/kv/$safe_name.html"
  [ -f "$kv_file" ]    || { warn "$kvkey not pulled — skipping"; continue; }
  [ -f "$local_file" ] || { warn "$local_file not in repo — skipping"; continue; }
  diff_out="$REPORT/diffs/$safe_name.diff"
  diff -u "$kv_file" "$local_file" > "$diff_out" 2>&1 || true
  if [ ! -s "$diff_out" ]; then
    ok "$kvkey  ==  $local_file"
  else
    lines=$(wc -l < "$diff_out" | tr -d ' ')
    warn "$kvkey  ≠  $local_file  ($lines diff lines) → $diff_out"
    note_issue
  fi
done

# ── SUMMARY ────────────────────────────────────────────────
echo
echo "═══════════════════════════════════════════════════════════"
if [ "$ISSUES" -eq 0 ]; then
  echo " ✅ NO DRIFT DETECTED — local + GitHub + Cloudflare aligned"
else
  echo " ⚠  $ISSUES drift/issue(s) flagged — see $REPORT"
fi
echo "═══════════════════════════════════════════════════════════"
echo
echo " Open these files first:"
echo "   $REPORT/kv/keys.json              all KV keys in production"
echo "   $REPORT/diffs/                    every drift, diffed"
echo "   $REPORT/d1/schema.sql             deployed D1 schema"
echo "   $REPORT/actions/recent.txt        last 5 GH Actions deploys"
echo
echo " Re-run anytime — overwrites the report folder."
