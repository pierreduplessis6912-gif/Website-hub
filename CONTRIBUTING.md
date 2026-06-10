# Website Hub — Contributing & Deployment SOP

## The Golden Rules

### Rule 1 — Never patch live code without pulling first
```bash
cd ~/Website-hub && git pull origin main
# Make your changes
git add -A && git commit -m "describe change" && git push origin main
```

### Rule 2 — End every session with a clean commit
Before closing any session:
```bash
cd ~/Website-hub && git add -A && git commit -m "session: describe what was done" && git push origin main
```

### Rule 3 — Archetype changes go through Claude
Claude pushes archetype changes directly via GitHub API. Never edit archetypes locally and leave them uncommitted.

### Rule 4 — Bootstrap HTML separately from Worker code
- HTML pages (blast.html, godmode.html, preview.html): `curl .../admin/bootstrap-X`
- Worker code (index.js, archetypes): needs GitHub Actions deploy (green)

### Rule 5 — Secrets never in code
- Admin key: via prompt in browser
- API keys: Cloudflare env vars only
- Never hardcode secrets in any file committed to the repo

### Rule 6 — Repo stays public for free Actions minutes
Public repo = unlimited GitHub Actions minutes = free deploys

---

## Deployment Flow

### Normal deploy (code changes)
1. Claude pushes via GitHub API
2. GitHub Actions runs automatically
3. Wait for green
4. Bootstrap any HTML if needed

### Emergency deploy (Actions down / minutes exhausted)
```bash
cd ~/Website-hub/build-worker
node node_modules/.bin/rollup src/index.js --file dist/worker.js --format esm
# Then use Cloudflare API deploy script
```

---

## File Structure

| File | What it is | How to deploy |
|------|-----------|---------------|
| `build-worker/src/index.js` | Main Worker logic | GitHub Actions |
| `build-worker/src/archetypes/*.js` | Site templates | GitHub Actions |
| `build-worker/src/design-db.js` | Industry → personality map | GitHub Actions |
| `design-db.js` | ROOT design-db (imported by Worker) | GitHub Actions |
| `blast.html` | Blast dashboard | bootstrap-blast |
| `godmode.html` | God Mode builder | bootstrap-godmode |
| `preview.html` | Client preview/manage page | bootstrap-preview |

---

## Key URLs

| URL | What |
|-----|------|
| `websitehub.co.za` | Landing page |
| `websitehub.co.za/blast` | Blast dashboard |
| `websitehub.co.za/godmode` | God Mode builder |
| `preview.websitehub.co.za/SLUG` | Client site |
| `preview.websitehub.co.za/manage/TOKEN` | Client manage panel |

---

## Admin Key
`ADMIN_KEY_CLAUDEROX` — used in all `/admin/*` endpoints

## GitHub Token
Rotates when expired. Generate at: https://github.com/settings/tokens/new
Scope: `repo` only. No expiry.
