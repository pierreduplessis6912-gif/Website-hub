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
