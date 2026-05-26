# Website Hub — Master Context
_Read this first. Every session. Before touching any file._

## What this is

Website Hub is a productised website service for South African small businesses. Cloudflare Workers + KV + D1 + R2 + Queues. Owner: Pierre du Plessis. Repo: github.com/pierreduplessis6912-gif/Website-hub. Production: preview.websitehub.co.za

## System status (2026-05-25) — ALL 5 WORKERS GREEN

build-worker (wh-build) · patch-worker (wh-patch) · launch-worker (wh-launch) · pulse-worker (wh-pulse) · reactivate-worker (wh-reactivate)

D1 ok · KV ok (30 templates) · R2 ok · PayFast live · RegisterDomain HMAC live · WhatsApp + Resend live · Pulse cron daily

retainer=0 in shared-services.js = INTENTIONAL beta pricing for Zululand Flooring. Revert to 999 after beta.

## Design source of truth: intake-experience.html

--bg:#0a0a0f · --cyan:#00f0ff · --purple:#b829dd · --magenta:#ff00a0
Fonts: Inter + JetBrains Mono
Glass cards: backdrop-filter:blur(20px), border:1px solid rgba(255,255,255,0.08)
Card entry: translateY(40px) → translateY(0) animation
Background: animated gradient orb + grid overlay
Plans: full vertical cards

NEVER USE: Syne, DM Sans, #ff5500, horizontal ticket strips (that is preview-manage-new.html — wrong file)

## File roles

intake-experience.html — DESIGN SOURCE OF TRUTH. In KV as app:intake-experience
websitehub-pwa-v2.html — PWA shell to build from. NOT deployed. Fix design to match above.
docs/PWA-WIRING-MAP.md — Full wiring spec. Read before any PWA code.
start-v2.html — Lead capture, stays separate. In KV as app:start-v2.
admin-dashboard-v8.html — Operator dashboard. NOT deployed yet.
preview-manage-new.html — IGNORE for design. Wrong aesthetic. Has useful backend wiring logic only.

## Architecture (locked)

TWO BUILDS ALWAYS — preview build (initial data) + production build (after all cards). Full 3-pass each. No skipping.

INBOUND: /start → 3 fields → /intake → preview build → screen-init circles → screen-experience (iframe + collapsible cards) → production build → confirm → PayFast → dashboard

OUTBOUND: scrape → preview build → WhatsApp OG card → tap → screen-experience (already built) → 8 cards pre-filled → production build → confirm → PayFast → dashboard

Cards slide up (translateY). Collapsible over live iframe. Customer interacts with real site behind cards.
/intake-preview = cosmetic only ([data-live] updates). Never triggers rebuild.
Production rebuild fires explicitly after last card via POST /trigger-rebuild (needs building).

BRAND LANGUAGE: Never "AI is..." Always "Website Hub is..." Never mention Claude/AI/ML to customers.

PLANS: Express R699 · Standard R999 · Premium R1499. Full vertical cards not ticket strip.

## Live endpoints (full specs in docs/PWA-WIRING-MAP.md)

POST /intake (build) · POST /intake-preview (build) · GET /preview-meta (build)
GET /build-status (build) · GET /analytics (build) · GET /manage-panel (patch)
POST /patch-preview (patch) · POST /upload-assets (patch) · POST /go-live-link (launch)
POST /cancel-site (reactivate)

STILL NEEDED: POST /trigger-rebuild (HIGH) · GET /client-status · GET /og-image

## Priorities

🔴 Zululand Flooring beta
🟡 PWA build (PWA-WIRING-MAP.md steps 1-13)
🟡 Deploy admin-dashboard-v8.html
🟡 Outbound flow flip (PR C)
⚪ Revert retainer to R999 post-beta
⚪ Zoho Mail (blocked)

## Constraints

- Termux cannot reach api.cloudflare.com — use wrangler or worker endpoint
- Never curl -d @file for KV bootstrap — use Node.js HTTPS (see PWA-WIRING-MAP.md s12)
- shared-services.js duplicated in all 5 workers — changes go in all 5
- Deploy via GitHub Actions (push to main) only — ignore deploy.sh
- JS syntax check: node --check file.mjs (must use .mjs extension)

---

## Architecture decisions (locked)

### First principle: Zero human touch
Every customer flow must complete without Pierre intervening.
Every failure must self-resolve or auto-escalate via WhatsApp/dashboard.
No step in the system should require a human to unblock it.
This principle applies to every piece of code written going forward.

### Three-layer model

D1   = single source of truth. Write here first, always. Never expires.
KV   = read cache only. Write after D1. On miss, fall back to D1.
Queue = async communication. Carries clientId + manage_token only.

### One token per client: manage_token

Generated once in createClient. Flows through everything:
- D1: stored as manage_token column
- Queue message: buildToken = manage_token
- KV key: build_status:{manage_token}
- URL: /manage/{manage_token}
- PWA polling: /build-status?token={manage_token}
- WhatsApp + email links

handleIntake must NOT generate its own UUID. Use result.manage_token.

THE BUG (found 2026-05-26): handleIntake generated a separate UUID for
URL/KV/queue while D1 stored a different manage_token. KV expired after
1 hour and D1 lookup by token always failed. Fix: remove the second UUID.

### KV_KEYS registry
Every KV key pattern must be registered in KV_KEYS in shared-services.js
before use. No raw strings in worker code. Ever. All 5 workers import from
shared-services so all speak the same language. When a new key is needed,
add it to KV_KEYS first.

Registry gaps to fill (next PR):
  BUILD_STATUS:        (token) => build_status:{token}
  SITE_PAGE:           (slug, page) => preview:{slug}:{page}
  DRAFT_PAGE:          (slug, page) => draft:{slug}:{page}
  CONTENT:             (slug) => content:{slug}
  INTAKE_BRIEF:        (slug) => intake_brief:{slug}
  APP_PWA:             app:pwa
  APP_START:           app:start-v2
  APP_ADMIN:           app:admin
  PORTFOLIO_CANDIDATE: (slug) => portfolio_candidate:{slug}

### KV TTL standards
BUILD_STATUS ready:   24 hours
BUILD_STATUS building: 1 hour
SITE_PAGE:            35 days
INTAKE_BRIEF:         6 hours
APP_* HTML blobs:     No TTL (manual bootstrap to update)

### handleBuildStatus correct pattern
1. Read KV BUILD_STATUS(token) — if ready, return immediately
2. On KV miss — query D1 WHERE manage_token = token
3. If D1 ready — update KV with 24hr TTL, return ready
4. If D1 building — return building with slug
5. Never swallow errors with catch(e) {} — always return error message

### Next PR
- Remove duplicate crypto.randomUUID() from handleIntake
- Add missing KV_KEYS to shared-services.js
- Rewrite handleBuildStatus per pattern above
- Copy shared-services.js to all 5 workers
