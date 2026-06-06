# Website Hub — Master Context
_Read this first. Every session. Before touching any file._
_Last updated: 2026-06-05_

## What this is

Website Hub is a fully automated website-as-a-service platform for South African small businesses. Owner: Pierre du Plessis. Solo founder, no coding background, builds entirely via AI-assisted sessions from an Android phone using Termux.

- **Repo:** github.com/pierreduplessis6912-gif/Website-hub
- **Production:** preview.websitehub.co.za
- **Admin:** preview.websitehub.co.za/admin (key: rotate before launch — see Security section)
- **Goal:** R1M ARR by December 25, 2026

---

## Infrastructure

| Service | Detail |
|---------|--------|
| Cloudflare Workers | 5 workers — wh-build, wh-patch, wh-launch, wh-pulse, wh-reactivate |
| Cloudflare D1 | database_id: 9c422081-af06-4c1b-b59e-f40e0d08fefa |
| Cloudflare KV | SITES namespace: b63e5b885ead4c02a9e184dd6477e711 |
| Cloudflare R2 | wh-assets bucket |
| Cloudflare Zone | websitehub.co.za — Zone ID: e6b58b08eb80ea03a46d010455f6b25d |
| CF Account ID | 4c559b9dff9fae56803b9c275b518597 |
| DNSimple | Account: 175950 — domain registration for Standard/Premium |
| Evolution API | https://evolution.websitehub.co.za — instance: wa1 — WhatsApp |
| GitHub Actions | Deploy on push to main — all 5 workers deploy simultaneously |

---

## Architecture (locked — do not change without discussion)

### First principle: Zero human touch
Every customer flow must complete without Pierre intervening.
Every failure must self-resolve or auto-escalate via WhatsApp to WH_PHONE.

### Data layer
- **D1** = single source of truth. Write here first, always. Never expires.
- **KV** = read cache only. Write after D1.
- **Queue** = async build pipeline. Carries clientId + manage_token only.

### Worker architecture
- **wh-build** = single public entry point for preview.websitehub.co.za/*
- **wh-launch** = called via Service Binding (LAUNCH_WORKER) from build worker — NOT publicly routed
- **wh-patch** = called via Service Binding (PATCH_WORKER) from build worker
- **wh-pulse** = cron worker — daily health checks, renewals, post-go-live touches
- **wh-reactivate** = handles reactivations after suspension

### Service Bindings (CRITICAL)
Build worker uses `env.LAUNCH_WORKER.fetch(request)` to call launch worker.
Routes `/internal-golive`, `/go-live-link`, `/activate-free` are proxied via service binding.
Never add public Cloudflare routes to launch/patch workers — build worker catches everything.

### shared-services.js (CRITICAL)
One source of truth: `build-worker/src/shared-services.js`
GitHub Actions deploy workflow COPIES it to all other workers on every deploy.
NEVER edit shared-services.js in any worker except build-worker.
Changes to any other worker's shared-services.js will be overwritten on next deploy.

### One token per client: manage_token
Generated once in createClient. Used everywhere:
- D1: manage_token column
- KV: build_status:{manage_token}
- URL: /manage/{manage_token}
- WhatsApp links

---

## Pricing & Plans (as of 2026-06-05)

| Plan | Price | Domain | Status |
|------|-------|--------|--------|
| Express | R399/mo | slug.websitehub.co.za (free CNAME) | PRE-LAUNCH — full site as launch bonus |
| Standard | R699/mo | slug.co.za (DNSimple $10.90/yr) | Launches in 2 weeks |
| Premium | R999/mo | slug.co.za + full features | Launches in 2 weeks |

**Pre-launch strategy:** 2 weeks Express-only at R399. Full 5-page archetype site as early access bonus. After 2 weeks, Express becomes 1-page only. Early access customers keep full site forever at R399.

**Express go-live flow:** Creates DNS CNAME `slug` → `preview.websitehub.co.za` on websitehub.co.za zone via Cloudflare API. No DNSimple needed. No Cloudflare Pro needed.

**Standard/Premium go-live flow:** DNSimple registers `slug.co.za` → Cloudflare Custom Hostnames (requires Pro plan — upgrade websitehub.co.za zone to Pro when Standard launches).

---

## The 5 Archetypes

Built in `build-worker/src/archetypes/`. Each is a complete HTML file with `{{token}}` placeholders.

| Archetype | Industries | Style |
|-----------|-----------|-------|
| experience.js | hospitality, personal_care, wellness, event_creative | Cormorant Garamond, warm gold/cream, botanical SVG, particles |
| emergency.js | trade_authority, technical_expertise | Barlow Condensed 900, rust accent, always-visible phone strip |
| trust.js | professional_trust, medical_trust | Playfair Display, navy/gold, credentials bar |
| local.js | community_local, retail_utility | Fraunces serif, amber warmth, paper grain texture |
| results.js | transformation | Syne display, dark cinematic green, stats bar |

Routing in `build-worker/src/index.js` → `detectArchetypeFromPersonality(personalityCategory, industry)`

---

## Build Pipeline

1. `/start` → intake form (3 fields) → `/intake`
2. `handleIntake` → creates client in D1 → queues substance build
3. `handleSubstanceBuild` → GBP data fetch → Claude Pass 1 (content JSON) → `tokenReplace()` → archetype HTML
4. KV writes: `site:{slug}` AND `preview:{slug}` simultaneously
5. Client sees preview at `preview.websitehub.co.za/{slug}`
6. Client taps "Activate" → `/activate-free` (Express) or PayFast (paid)
7. `handleGoLiveInternal` fires via `ctx.waitUntil`:
   - KV writes `live:{domain}` 
   - D1 status → `live`
   - DNS CNAME created (Express) OR domain registered via DNSimple (Standard/Premium)
   - CF Custom Hostname bound (Standard/Premium only)
   - WhatsApp to client + owner

---

## KV Key Patterns

```
site:{slug}              — built HTML (substance build output)
preview:{slug}           — preview HTML (same as site, with watermark)
live:{domain}            — live HTML (watermark removed, served by hostname)
live:{domain}:index      — live HTML index page
draft:{slug}:{page}      — panel choice overrides
build_status:{token}     — build progress
app:admin                — admin panel HTML (bootstrapped via /admin/bootstrap-admin)
app:start                — /start intake form
app:preview              — preview page HTML
app:manage               — manage panel HTML
health:{service}         — service health status
optout:{phone}           — POPIA opt-out flag
```

---

## Go-Live Pipeline (detailed)

`handleGoLiveInternal` in `launch-worker/src/index.js`:

1. `go_live_started` logged
2. Apply panel choices to draft KV
3. Strip watermark, write `live:{domain}` and `live:{domain}:index` to KV
4. D1 update: status=live, go_live_date, next_invoice_date, domain
5. Push to showcase queue (newest 5 slugs)
6. CF hostname binding — Standard/Premium only (skipped for Express)
7. Domain setup:
   - Express → `createSubdomainCname(slug, env)` → Cloudflare DNS API
   - Standard/Premium → `registerDomainViaProxy(slug, env)` → DNSimple API
8. Email routing (Premium only)
9. WhatsApp to client (if phone exists)
10. Post go-live KV keys set (d1, d7, upsell, winback)
11. Owner WhatsApp notification
12. `site_went_live` logged

---

## Secrets (per worker)

### wh-build
ANTHROPIC_KEY, ADMIN_KEY, UNSPLASH_ACCESS_KEY, EVOLUTION_API_KEY (mysecretkey123), EVOLUTION_API_URL, EVOLUTION_INSTANCE (wa1), WH_PHONE (27790128508), CF_API_TOKEN, CF_ZONE_ID, CF_ACCOUNT_ID

### wh-launch
ADMIN_KEY, EVOLUTION_API_KEY (mysecretkey123), EVOLUTION_API_URL, EVOLUTION_INSTANCE (wa1), WH_PHONE, CF_API_TOKEN, CF_ZONE_ID, CF_ACCOUNT_ID, DNSIMPLE_TOKEN, DNSIMPLE_ACCOUNT_ID (175950)

### wh-reactivate
ADMIN_KEY, EVOLUTION_API_KEY (mysecretkey123), EVOLUTION_API_URL, EVOLUTION_INSTANCE (wa1), WH_PHONE, CF_API_TOKEN, CF_ZONE_ID, CF_ACCOUNT_ID, DNSIMPLE_TOKEN, DNSIMPLE_ACCOUNT_ID

### wh-pulse, wh-patch
EVOLUTION_API_KEY (mysecretkey123), EVOLUTION_API_URL, EVOLUTION_INSTANCE (wa1), WH_PHONE

**CRITICAL:** Evolution API key is `mysecretkey123` (lowercase m). Capital M = 401 Unauthorized.

---

## Admin Endpoints

All require `x-admin-key` header.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| /admin/health | GET | System health + recent events |
| /admin/clients | GET | Client list with manage_token and phone |
| /admin/query | POST | Raw SQL (all queries allowed — SECURE BEFORE LAUNCH) |
| /admin/force-live | POST | Force client live + trigger go-live pipeline |
| /admin/reset-build | POST | Reset client to preview_ready |
| /admin/trigger-rebuild | POST | Queue new substance build |
| /admin/register-domain | POST | Trigger DNSimple domain registration |
| /admin/test-whatsapp | POST | Send test WhatsApp message |
| /admin/bootstrap-admin | POST | Upload new admin.html to KV |
| /admin/migrate | POST | Run D1 migration SQL |

---

## DNSimple Integration

- Account ID: 175950
- Token: stored as DNSIMPLE_ACCOUNT_ID + DNSIMPLE_TOKEN secrets on wh-launch and wh-reactivate
- Contact: "Website Hub" — created as registrant for all domains
- .co.za price: $10.90/year
- WHOIS privacy: false (.co.za does not support it)
- Auto-renew: true

## Cloudflare Custom Hostnames
- Requires Pro plan on websitehub.co.za zone ($20/month)
- Only needed for Standard/Premium (own domain customers)
- Express uses free CNAME subdomain — no Pro plan needed

---

## Termux Constraints

- Wrangler CLI does not work in Termux — never use it
- All deploys via GitHub push to main
- Python scripts must use heredoc syntax: `python3 - << 'PYEOF'`
- No emoji in Python scripts
- No backtick template literals in Python
- File paths: use `$HOME` not `~` in curl commands
- GitHub token for pushes: rotate before launch (currently exposed in chat history)

---

## Security — TODO BEFORE LAUNCH (Sunday)

1. Rotate ADMIN_KEY (currently exposed in chat history as ADMIN_KEY_CLAUDEROX)
2. Rotate GitHub token (exposed in chat history)
3. Rotate DNSIMPLE_TOKEN (exposed in chat history)
4. Rotate CF_API_TOKEN (exposed in chat history)
5. Lock admin/query back to SELECT only
6. Add auth to /internal-golive
7. Rate limiting on admin endpoints
8. Delete CPANEL_PASSWORD from all workers (cPanel is dead)

---

## What's Working (2026-06-05)

- ✅ Full build pipeline — intake → GBP → Claude → archetype → preview
- ✅ All 5 archetypes built and routing correctly
- ✅ Express go-live — CNAME created, WhatsApp fires, client + owner notified
- ✅ Service binding build→launch worker
- ✅ Evolution WhatsApp from all workers (mysecretkey123 lowercase)
- ✅ DNSimple domain registration (Standard/Premium — $10.90/domain)
- ✅ Admin panel with Operations buttons per client
- ✅ Events feed showing in admin dashboard
- ✅ /internal-golive route working via service binding

## What's NOT Working / Pending

- ❌ Cloudflare Custom Hostnames — needs Pro plan ($20/mo) for Standard/Premium
- ❌ registerdomain.co.za API — all actions return "Action not found" (support ticket open, now replaced by DNSimple)
- ❌ Admin panel Operations buttons — cache issue, not showing new version
- ❌ Classic Touch mom's domain — registered in DNSimple but not pointed anywhere yet (temporary: host on cPanel)
- ❌ PayFast verification — dragging due to business profile change
- ❌ Manage panel countdown timer (2-week pre-launch window)
- ❌ Express 1-page version (after pre-launch, Express strips to 1 page)
- ❌ Existing domain flow (customer already has domain → nameserver change instructions)
- ❌ WhatsApp inbox in admin panel
- ❌ Opt-in/opt-out webhook handler for Evolution

## Pending Security Work (Sunday)
See Security section above.

---

## Real Customers

| Business | Slug | Status | Plan | Domain |
|---------|------|--------|------|--------|
| Classic Touch Salon (Pierre's mom) | classictouchsalon | live | premium | classictouchsalon.co.za (registered DNSimple, not pointed yet) |
| Izinga Flora | izingaflora2 | live | express | izingaflora2.websitehub.co.za ✅ |

---

## Working Style

- Pierre works from Android phone via Termux
- Prefers complete file replacements over patches
- Single commands over multi-step processes
- Zero human intervention in all automated flows
- Honest pushback welcomed
- Never mention AI/Claude to customers — always "Website Hub team"
- Never use desktop-first UX assumptions

---

## Session Update 2026-06-06

### What changed this session

**Pipeline fully working end to end:**
- `/start` → `/intake` → build → `/preview/{token}` → PayFast → go-live → `slug.websitehub.co.za`
- Post-build WhatsApp sends to `/preview/{token}` — the SPA with iframe + Go Live button
- preview.html is the customer SPA — served from `app:preview` KV key at `/preview/{token}`
- Go Live button in preview.html calls `/go-live-link` → PayFast R399 subscription
- PayFast webhook at `/payfast-webhook` → `handleGoLiveInternal` → CNAME → live

**Service bindings complete:**
- ALL routes go through build worker (wh-build) wildcard `preview.websitehub.co.za/*`
- Launch and patch workers have NO public routes — called via service binding only
- Proxied routes: `/internal-golive`, `/go-live-link`, `/activate-free`, `/manage-panel`, `/client-status`, `/submit-revision`, `/cancel-site`, `/go-live`, `/payfast-webhook`
- Removed conflicting routes from `patch-worker/wrangler.toml` and `launch-worker/wrangler.toml`

**Key files:**
- `preview.html` → `app:preview` KV → `/preview/{token}` — customer SPA with iframe + Go Live
- `manage.html` → `app:manage` KV → `/manage/{token}` — post-live management dashboard  
- `start-v3.html` → `app:start-v2` KV → `/start` — intake form, sends `package:legacy`
- `admin.html` → `app:admin` KV → `/admin` — operator dashboard with Operations buttons + Purge Cache

**Legacy plan:**
- Package name: `legacy` — maps to `express` in pkgKey() and packageKey()
- Price: R399/month
- Domain: `slug.websitehub.co.za` — free CNAME on websitehub.co.za zone
- Full 5-page archetype site during pre-launch window (2 weeks)
- After pre-launch: Express returns, Legacy grandfathered at R399 forever
- Start-v3 sends `package:'legacy'` to `/intake`

**PayFast:**
- VERIFIED ✅ — can take real payments
- buildPayFastLink now supports subscription params (frequency=3 monthly, cycles=0 infinite)
- notifyUrl fixed to use `preview.websitehub.co.za/payfast-webhook` not workers.dev
- R399 subscription from day one — no R0 trial

**Admin operations:**
- 🧹 Purge Cache button in dashboard — calls `/admin/purge-cache` → CF API purge_everything
- CF_API_TOKEN, CF_ZONE_ID, CF_ACCOUNT_ID now on wh-build for cache purge
- `/admin/query` allows all SQL (SELECT + UPDATE) — LOCK DOWN BEFORE LAUNCH

**DNSimple:**
- Token: `dnsimple_u_bRjDRdaHxMHh1l0XCnRRH4TKxWW1tTz0`
- Account: 175950
- Contact created: "Website Hub" as registrant
- .co.za price: $10.90/year, whois_privacy: false

**Classic Touch Salon (mom):**
- Site live at `preview.websitehub.co.za/classictouchsalon`
- Domain `classictouchsalon.co.za` registered in DNSimple, A record → 156.38.165.210 (cPanel)
- Emails created in cPanel: info@, hello@, bookings@classictouchsalon.co.za
- Manage panel: `preview.websitehub.co.za/manage/6117ae0e-7e16-4a4c-97f7-dec0778e5512`

**Test client:**
- terayneelectricalmaintenance — package=legacy, retainer=0 in D1
- manage_token: 3d5a607c-a8af-478b-8a71-af379bf51892
- Preview SPA: `preview.websitehub.co.za/preview/3d5a607c-a8af-478b-8a71-af379bf51892`

**registerdomain.co.za:**
- Support ticket open — all API actions return "Action not found"
- Replaced by DNSimple for Standard/Premium domain registration
- PHP proxy at `websitehub.co.za/domain-proxy.php` still exists but irrelevant

**Sunday security checklist (MUST DO BEFORE LAUNCH):**
1. Rotate ADMIN_KEY (ADMIN_KEY_CLAUDEROX exposed in chat)
2. Rotate GitHub token (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 exposed)
3. Rotate DNSIMPLE_TOKEN (exposed in chat)
4. Rotate CF_API_TOKEN (exposed in chat)  
5. Lock `/admin/query` back to SELECT only
6. Add auth to `/internal-golive`
7. Delete CPANEL_PASSWORD from all workers
8. Rate limiting on admin endpoints

---

## Session Update 2026-06-07

### Domain Architecture (FINAL)
- **`websitehub.co.za`** — the whole platform. One domain. Everything.
  - `/` → landing page (app:landing)
  - `/start` → intake form (app:start-v2)
  - `/preview/{token}` → customer preview SPA (app:preview)
  - `/manage/{token}` → manage panel (app:manage)
  - `/admin` → operator dashboard (app:admin)
  - `/privacy`, `/terms`, `/aup`, `/cancellation`, `/dpa`, `/referral-terms` → legal docs
  - All API routes fall through to normal routing
- **`preview.websitehub.co.za`** — client sites ONLY
  - `slug.websitehub.co.za` → live Express/promo client sites via CNAME
  - `preview.websitehub.co.za/{slug}` → built site preview
  - All platform routes also work here (same worker, same routes)
- **`www.websitehub.co.za`** → same as main domain

### Build Worker Routing (locked)
- Hostname check fires FIRST in fetch handler
- `websitehub.co.za` and `www.websitehub.co.za` → serve platform pages from KV
- API routes (intake, domain-check, build-status etc) fall through to normal routing
- Unknown paths on main domain → landing page

### Legal Pages (all bootstrapped)
All served from KV, available on both `websitehub.co.za` and `preview.websitehub.co.za`:
- `app:landing` → landing-v4.html (footer has real legal links)
- `app:privacy` → privacy.html (Airtable/Twilio/Anthropic removed)
- `app:terms` → terms.html
- `app:referral-terms` → referral-terms.html
- `app:aup` → aup.html
- `app:cancellation` → cancellation.html
- `app:dpa` → dpa.html

### Preview SPA (preview.html → app:preview)
Major rebuild this session:
- Build fees: Express R5,000 · Standard R7,000 · Premium R9,000
- Monthly retainers: R399 · R699 · R999 (invoiced separately — NOT via PayFast)
- PayFast charges build fee ONLY (one-time)
- No annual toggle, no promo code input field
- Plan sheet auto-shows pricing with build fee in description
- Legal links in confirm screen → websitehub.co.za/terms etc
- Bottom bar: "{build fee} · then R{retainer}/mo"
- processPayment sends buildAmount not monthly retainer

### Promo Pipeline (LAUNCH2026)
- URL: `/preview/{token}?promo=LAUNCH2026`
- detectPromo() reads ?promo= param on load
- Premium plan force-selected and locked
- Express and Standard plan rows locked (opacity .4, pointer-events none)
- Promo banner slides in above bottom bar: "🎁 Exclusive offer applied — saving R9,000"
- Plan sheet: Premium shows ~~R9,000~~ → Free, ~~R999~~ → R599/mo
- Confirm screen: build fee struck through → Free, retainer struck through → R599/mo
- "You're saving R9,000 today 🎉" callout
- PayFast: R0 build fee (promo.buildAmount = 0), R599/mo
- promoCode passed to /go-live-link for storage
- Month 3: pulse worker to trigger domain upgrade (PENDING — not built yet)

### Promo Code Object
```js
const PROMO_CODES = {
  LAUNCH2026: { plan:'premium', buildAmount:0, monthly:599, buildFee:'Free', label:'🎁 Exclusive offer applied', saving:'R9,000' },
};
```

### Start Intake (start-v3.html → app:start-v2)
- Business name search → Google Places autocomplete (kept — needed for GBP accuracy)
- Domain badge in step 1 is now an editable input field
- Customer can customise their slug directly in the badge
- Live availability check via `/check-slug?slug={slug}` endpoint
- Address field: "Where are you based?" with area/suburb autocomplete
- Slug from badge input is used as slug_requested in intake POST
- package sent: 'standard' (main pipeline — no legacy)
- No plan cards in start — plan selection happens in preview SPA
- Button: "Build my site →" calls submitIntake() directly

### /check-slug Endpoint
- GET /check-slug?slug={slug}
- Checks D1 for existing clients with that slug (non-lead status)
- Returns { slug, available: true/false }
- Used for real-time availability in the domain badge

### PayFast (VERIFIED — ready for payments)
- Build fee only — one time payment
- Retainer invoiced separately via accounting system
- buildPayFastLink supports subscription params but not used for main pipeline
- notifyUrl: preview.websitehub.co.za/payfast-webhook (proxied via service binding)
- /payfast-webhook → service binding → launch worker → handleGoLiveInternal

### Pending — PayFast End-to-End Test
- Not yet tested with real payment
- Need to confirm: payment → webhook → go-live → site live → WhatsApp
- Test with terayneelectricalmaintenance (package=legacy, retainer=0 in D1)
- Next session priority

### Pending — registerdomain.co.za API
- Support ticket open
- Pierre has documentation to try
- Should be wired as backup to DNSimple for Standard/Premium domain registration

### Pending — Promo Month-3 Domain Upgrade
- Promo clients get slug.websitehub.co.za for months 1-2
- Month 3 (60 days after go-live): automatic upgrade to slug.co.za
- Pulse worker needs d60 sequence: DNSimple register + CF hostname bind
- promoCode needs to be stored on client record in D1

### Design System (PINNED — not blocking)
- Three demo cards built: wh-intake-card-demo.html, wh-intake-v2.html, wh-intake-v3.html, wh-intake-v4.html
- Direction agreed: warm, Cormorant Garamond, conversational one-field-at-a-time flow, gold accent
- Light theme preferred over dark
- No emoji in UI — SVG icons only
- Not blocking launch — revisit after first paying customer

### Security — Sunday (MUST BEFORE LAUNCH)
1. Rotate ADMIN_KEY (ADMIN_KEY_CLAUDEROX exposed)
2. Rotate GitHub token (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 exposed)
3. Rotate DNSIMPLE_TOKEN (exposed)
4. Rotate CF_API_TOKEN (exposed)
5. Lock /admin/query to SELECT only
6. Add auth to /internal-golive
7. Rate limiting on admin endpoints
8. Delete CPANEL_PASSWORD from workers

### URLs (all working)
- https://websitehub.co.za — landing
- https://websitehub.co.za/start — intake
- https://websitehub.co.za/privacy — privacy policy
- https://websitehub.co.za/terms — terms
- https://preview.websitehub.co.za/preview/{token} — customer preview SPA
- https://preview.websitehub.co.za/manage/{token} — manage panel
- https://preview.websitehub.co.za/admin — operator dashboard
- https://izingaflora2.websitehub.co.za — live Express client site

---

## Session Update 2026-06-07 (continued)

### wh-sites Worker
- New dedicated worker for serving client sites from KV
- Wildcard route: `*.websitehub.co.za/*`
- Reads `live:{hostname}` and `live:{hostname}:{page}` from KV
- System subdomains (evolution, preview, www, mail, etc) pass through via `fetch(request)` — not served from KV
- Cache: `public, max-age=300, stale-while-revalidate=3600`
- Added to deploy workflow — 6 workers total now

### Evolution Fix
- `evolution.websitehub.co.za` was being caught by wh-sites wildcard
- Fixed: system subdomain list in wh-sites passes through to origin
- Evolution now responds 200 correctly
- Build worker WhatsApps were silently failing — now logging errors to events table

### WhatsApp Debugging
- `logHealth` writes to KV not D1 — was silently failing when `health_log` table didn't exist
- Added direct error logging to events table for Evolution failures
- Build WhatsApps now log `whatsapp_send` error events with Evolution response
- Root cause of missing WhatsApps: Evolution 404 because wildcard was intercepting evolution.websitehub.co.za

### Start Intake Flow (FIXED)
- After build completes, redirects to `/preview/{manage_token}` — NOT `/{slug}/`
- Old flow was redirecting to raw site then showing intake cards
- New flow: build completes → preview SPA with iframe + Go Live button

### Promo Pipeline (COMPLETE)
- `promo_code` column added to clients table (migration 0003)
- OG card preserves `?promo=` param through redirect to `/preview/{token}`
- Post-build WhatsApp includes promo param if `client.promo_code` is set
- `/admin/promo-blast` endpoint: scrape + auto-approve + premium build + LAUNCH2026
- Promo Blast button in admin → Prospecting panel
- `handleGoLiveLink` reads `promoCode` from request, sets correct recurring amount (R599)
- PayFast amount check skipped for promo payments (`customStr2` contains `_promo_`)

### Promo Code Object (in preview.html and launch worker)
```js
LAUNCH2026: { plan:'premium', buildAmount:0, monthly:599, buildFee:'Free', saving:'R9,000' }
```

### Landing Page
- Pricing section replaced with scrolling carousel
- Three cards: Express R5,000 build/R399mo · Standard R7,000/R699mo · Premium R9,000/R999mo
- Standard card highlighted as POPULAR
- Swipe dots indicator
- Footer has real legal links

### websitehub.co.za (unified platform)
- All platform routes served from build worker on main domain
- Landing, legal, start, preview, manage, admin, intake all work on websitehub.co.za
- preview.websitehub.co.za still works — same worker, same routes
- www.websitehub.co.za also works

### Pending
- PayFast end-to-end test (R0 promo and R5k normal)
- Sunday security audit (rotate all exposed secrets)
- Promo month-3 domain upgrade in pulse worker (d60 sequence)
- Build WhatsApp — verify fixed after Evolution wildcard fix
- Cookie Crumble — needs rebuild + promo WhatsApp resent
- places-proxy.websitehub.co.za — may also be affected by wildcard (check)
- registerdomain.co.za API — support ticket open, Pierre has docs

---

## Session Update 2026-06-07 (registerdomain.co.za)

### registerdomain.co.za API — WIRED ✅

**Status:** Auth working, proxy working, credits confirmed. Domain lookup/register blocked by account permissions — email support to enable.

**Architecture:**
- Worker → cPanel proxy (`classictouchsalon.co.za/rd-proxy.php`) → registerdomain.co.za
- Proxy bypasses Cloudflare IP restriction (registerdomain blocks Cloudflare IPs)
- Proxy secret: `mysecretkey123`
- Proxy location: `/home/websiteh/classictouchsalon.co.za/rd-proxy.php`

**Token formula (CRITICAL — took 4.5 hours to get right):**
```js
// PHP: base64_encode(hash_hmac("sha256", apiKey, email:gmdate("y-m-d H")))
// hash_hmac returns HEX string by default — base64 encode the HEX string, NOT raw bytes
const hexStr = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2,'0')).join('');
return btoa(hexStr);
// 2-digit year: "26-06-07 20" not "2026-06-07 20"
```

**Confirmed working:**
- `GET /billing/credits` → returns `"271.00"` ✅
- Auth headers: `username: loc10@live.co.za` + `token: {generated}`

**Blocked by permissions:**
- `POST /domains/lookup` → "Action is not allowed"
- `POST /order/domains/register` → likely same issue
- Email registerdomain support to enable domain API permissions for reseller account

**Registrar priority:**
1. registerdomain.co.za (primary) — SA reseller, cheaper, no verification emails
2. DNSimple (fallback) — sends verification emails, not zero-touch, last resort

**Pending:**
- Email registerdomain support to enable domain lookup + registration permissions
- Test `/domains/websitehub.co.za/information` (free, no charge) to confirm domain endpoints
- Test `/order/domains/register` once permissions enabled (R50 test domain)
- Remove `test-rd.php` from classictouchsalon.co.za cPanel after testing done

### Other wins this session
- Cookie Crumble — promo code set, WhatsApp sent with OG card link
- Pricing carousel live on websitehub.co.za landing page
- Start flow fixed — redirects to /preview/{token} after build, not raw site
- Build WhatsApp errors now logged to events table
- wh-sites passthrough fixed for Evolution and system subdomains
- classictouchsalon.co.za — A record added to DNSimple, DNS propagating
