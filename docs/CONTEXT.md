# Website Hub — Master Context
_Read this first. Every session. Before touching any file._
_Last updated: 2026-06-08 — Session: WE ARE ALIVE 🔥_

---

## What this is

Website Hub is a fully automated website-as-a-service platform for South African small businesses. Owner: Pierre du Plessis. Solo founder, no coding background, builds entirely via AI-assisted sessions from an Android phone using Termux.

- **Repo:** github.com/pierreduplessis6912-gif/Website-hub (public)
- **Production:** websitehub.co.za (landing) + preview.websitehub.co.za (platform)
- **Admin:** preview.websitehub.co.za/admin — key: ADMIN_KEY_CLAUDEROX
- **Goal:** R1M ARR by December 25, 2026
- **Live clients:** Classic Touch Salon (classictouchsalon) — Pierre's mom
- **First blast sent:** 0-Three-5 Shisanyama & Carwash (Richards Bay)
- **Pipeline status:** FULLY WORKING end-to-end as of 2026-06-08

---

## Critical workflow rule
**Always run before reading or editing any file:**
```bash
cd ~/Website-hub && git pull --rebase origin main
```
GitHub API returns stale cached content. Always pull first.

---

## Infrastructure

| Service | Detail |
|---------|--------|
| Cloudflare Workers | 5 workers — wh-build, wh-launch, wh-patch, wh-pulse, wh-reactivate |
| Cloudflare D1 | database_id: 9c422081-af06-4c1b-b59e-f40e0d08fefa |
| Cloudflare KV | SITES namespace: b63e5b885ead4c02a9e184dd6477e711 |
| Cloudflare R2 | wh-assets bucket |
| Cloudflare Zone | websitehub.co.za — Zone ID: e6b58b08eb80ea03a46d010455f6b25d |
| CF Account ID | 4c559b9dff9fae56803b9c275b518597 |
| Evolution API | https://evolution.websitehub.co.za — instance: wa1 |
| Evolution global key | mysecretkey123 (admin/webhook ops) |
| Evolution instance key | D6FFAA8F-8454-4052-BD1C-F73E037DF5D3 (sending messages — use this) |
| PayFast | LIVE mode — TEST_MODE = "false" — merchant: 13581217 |
| GitHub Actions | Deploy all 5 workers on every push to main |

**NOTE: wh-sites was fired and merged into wh-build on 2026-06-08.**

---

## DNS (Cloudflare zone — websitehub.co.za)

| Route | Worker |
|-------|--------|
| websitehub.co.za/* | wh-build |
| preview.websitehub.co.za/* | wh-build |
| *.websitehub.co.za/* | wh-build |

wh-build handles everything — platform routes AND client site serving by hostname detection.
No wildcard A record needed. No wh-sites. No zone route conflicts.

---

## Worker Architecture (5 workers — wh-sites FIRED)

| Worker | Job |
|--------|-----|
| wh-build | Public entry point, admin, builds, intake, WhatsApp incoming, client site serving by hostname |
| wh-launch | PayFast, go-live, email provisioning, manage panel API, subscriptions |
| wh-patch | Revisions |
| wh-pulse | Daily cron — dunning, follow-ups, referral vesting, win-back |
| wh-reactivate | Reactivations after suspension |

### How wh-build serves client sites
At the top of the fetch handler, wh-build checks if hostname ends with `.websitehub.co.za` AND is not a system subdomain (preview, evolution, www, etc.). If it's a client subdomain, it serves `live:{hostname}` from KV directly. System subdomains pass through via `fetch(request)`.

### Data layer rules (LOCKED)
- **D1** = single source of truth. Write here first, always.
- **KV** = read cache only. `live:{domain}`, `preview:{slug}`, `app:{page}`
- **Queue** = carries clientId + silent flag only.

---

## Packages & Pricing

| Package | Build Fee | Monthly | Domain |
|---------|-----------|---------|--------|
| Hub | R7,000 | R699/mo | slug.websitehub.co.za |
| Hub Pro | R7,000 | R999/mo | slug.co.za (registered via registerdomain) |
| Promo (LAUNCH2026) | R0 | R599/mo | slug.websitehub.co.za |

- All packages: full single-page site, gallery, map embed, nav bar, 2 email reroutes
- Hub: 2 revisions/month. Hub Pro: 5 revisions/month.
- Promo clients only get referral program (10 referrals → Hub Pro upgrade free)

---

## Build Pipeline

**Trigger:** POST /intake → D1 insert → Queue → triggerFullBuild

**6 passes (archetypes):** pass0 archetype selection → pass1 brand → pass2 skeleton → pass3 UX → pass4 rich brand → pass5 content → pass6 quality

**Build time:** ~60 seconds. One Claude API call.

**Archetypes (5):** emergency, experience, local, results, trust
All archetypes include:
- ✅ Sticky nav bar
- ✅ Hero section with photo
- ✅ Services section
- ✅ Reviews (from GBP)
- ✅ Gallery carousel (GBP photos → Unsplash fallback by industry)
- ✅ Google Maps embed
- ✅ Contact section with WhatsApp + Call FAB
- ✅ Footer
- ✅ Licence check (self-hosting redirects to websitehub.co.za)

**Domain in built HTML:** Uses `slug.websitehub.co.za` for Hub/Promo, `slug.co.za` for Hub Pro.

---

## GBP Lookup

Intake accepts:
- `place_id` — direct Places API lookup
- `gbp_url` — full or short Maps URL (short URLs auto-resolved at intake via fetch redirect)
- Falls back to name+area text search if no place_id found

GBP data saved to D1: `gbp_data` (JSON), `gbp_place_id`

**Gallery photos:** GBP photos → Unsplash API fallback by industry (uses `UNSPLASH_ACCESS_KEY` secret on wh-build)

---

## Blast → Preview → Go-Live Flow

**Blast (admin panel):**
1. Fill: business name, phone, industry, area, Google Maps URL
2. POST /intake → build queued → ~60s build → WhatsApp to client with OG card
3. Owner gets: `✅ FULL BUILD: Business Name [fingerprint] [time]ms`

**Preview SPA (/preview/{token}):**
- Promo applied from URL param OR from `promo_code` in client record (no URL param needed)
- Shows R0 build fee + R599/mo for promo clients
- Shows R7,000 + R699/mo for Hub clients
- Go Live → PayFast subscription

**Go-live (PayFast webhook → wh-launch):**
1. Writes `live:{domain}` to KV
2. Status → live
3. Provisions hello@ + info@ email reroutes
4. Go-live WhatsApp to client
5. 🎉 I GOT A SALE to WH_PHONE + 27798916569

---

## Silent Rebuild

Admin can rebuild without sending client WhatsApp:
```bash
curl -s -X POST "https://preview.websitehub.co.za/admin/trigger-rebuild" \
  -H "x-admin-key: ADMIN_KEY_CLAUDEROX" \
  -H "Content-Type: application/json" \
  -d '{"slug":"clientslug","silent":true}'
```
Owner still gets `✅ FULL BUILD [SILENT]` notification. Client gets nothing.
Also available as 🔇 button in admin panel.

---

## WhatsApp (Evolution API v1.8.6)

**CRITICAL:** Use instance key `D6FFAA8F-8454-4052-BD1C-F73E037DF5D3` for sending messages.
Global key `mysecretkey123` is for admin/webhook ops only.

All workers that send WhatsApp (wh-build, wh-launch) need:
- `EVOLUTION_API_URL` = https://evolution.websitehub.co.za
- `EVOLUTION_API_KEY` = D6FFAA8F-8454-4052-BD1C-F73E037DF5D3
- `EVOLUTION_INSTANCE` = wa1
- `WH_PHONE` = 27790128508

Webhook: Evolution POSTs to `preview.websitehub.co.za/whatsapp-incoming` with `apikey: mysecretkey123` header. wh-build verifies this header.

**Number format:** Pass without `+` prefix — `27790128508` not `+27790128508`.

---

## Licence Protection

Every built site has JS that checks `window.location.hostname` on load.
Allowed: `slug.websitehub.co.za`, `slug.co.za`, `preview.websitehub.co.za`, `localhost`
Any other domain → instant redirect to `websitehub.co.za`.
Self-hosters bounce. Paying clients never notice.

---

## Referral Program

- Eligibility: Promo clients only (promo_code = LAUNCH2026)
- 10 live referrals → Hub Pro upgrade (free .co.za domain)
- Referral link: `websitehub.co.za/r/{slug}` — passes promo to friend
- Pulse worker checks daily → auto-upgrades → WhatsApp
- Manage panel: progress bar 0/10, WhatsApp share button
- Terms: /referral-terms

---

## Brand Stack

| Element | Value |
|---------|-------|
| Background | #0e0c09 |
| Accent | #00f0ff |
| Text | #f0ede8 |
| Display | Syne (400/600/700/800) |
| Body | DM Sans (300/400/500) |
| Mono | DM Mono (400/500) |

All customer-facing pages use this stack: landing, start, preview, manage, all legal pages.

---

## Customer-Facing Pages

| URL | KV Key | File |
|-----|--------|------|
| websitehub.co.za | app:landing | landing-v4.html |
| /start | app:start-v2 | start-v3.html |
| /preview/{token} | app:preview | preview.html |
| /manage/{token} | app:manage | manage.html |
| /privacy | app:privacy | privacy.html |
| /terms | app:terms | terms.html |
| /cancellation | app:cancellation | cancellation.html |
| /aup | app:aup | aup.html |
| /dpa | app:dpa | dpa.html |
| /referral-terms | app:referral-terms | referral-terms.html |

**Bootstrap all pages:**
```bash
cd ~/Website-hub && git pull origin main && \
for page in landing:landing-v4 start-v2:start-v3 preview:preview manage:manage admin:admin privacy:privacy terms:terms cancellation:cancellation aup:aup dpa:dpa referral-terms:referral-terms; do
  kv="${page%%:*}"; file="${page##*:}"
  curl -s -X POST "https://preview.websitehub.co.za/admin/bootstrap-${kv}" \
    -H "x-admin-key: ADMIN_KEY_CLAUDEROX" -H "Content-Type: text/html" \
    --data-binary @"$HOME/Website-hub/${file}.html" && echo " ✅ ${kv}"
done
```

---

## Legal & Compliance

- POPIA registered — Information Regulator of South Africa — Reg. No. 2026-024548
- All 6 legal pages have consistent footer with all links
- Monthly subscription disclosure on all pricing surfaces
- Self-serve cancellation in manage panel
- STOP opt-out: reply STOP → `optout:{phone}` KV flag

---

## Security

| Surface | Protection |
|---------|-----------|
| /admin/* | x-admin-key: ADMIN_KEY_CLAUDEROX |
| /manage/* /preview/* | UUID manage_token |
| /payfast-webhook | PayFast ITN signature |
| /whatsapp-incoming | Evolution apikey header |
| /intake | IP 3/hr + phone dedup 24hr + global 50/day |
| Built sites | Licence check — wrong domain → redirect |

---

## KV Key Schema

```
app:landing, app:start-v2, app:preview, app:manage, app:admin
app:privacy, app:terms, app:cancellation, app:aup, app:dpa, app:referral-terms

preview:{slug}       — built HTML (pre-live, watermarked)
live:{domain}        — live HTML (served by wh-build hostname routing)
site:{slug}          — raw built HTML

rate:intake:ip:{ip}            — rate limit: 3/hr
rate:intake:global:{date}      — rate limit: 50/day
optout:{phone}                 — POPIA opt-out
promo_nudge_sent:{clientId}    — 24hr nudge guard
```

---

## D1 Schema (clients — key columns)

```sql
id, business_name, client_name, slug, phone, email
package          — hub | hub_pro | promo
retainer         — 599 | 699 | 999
promo_code       — LAUNCH2026 | null
status           — lead | building | preview_ready | live | cancellation_pending | suspended | cancelled
manage_token     — UUID
referral_slug    — short slug
referred_by      — slug of referrer
domain           — null (Hub) | slug.co.za (Hub Pro)
gbp_place_id     — Google Places ID
gbp_data         — JSON blob of GBP data
payfast_token    — for cancel API
visits, wa_taps  — counters
go_live_date, next_invoice_date
```

---

## Migrations Applied

```
0001_initial_schema.sql
0002_config_and_credits.sql
0003_promo_code_on_clients.sql
0004_design_fingerprint.sql
0005_social_handles.sql
0006_referred_by.sql
0007_visit_counters.sql
0008_payfast_token.sql
```

---

## Useful Commands

```bash
# Always first
cd ~/Website-hub && git pull --rebase origin main

# Health check
curl -s "https://preview.websitehub.co.za/health"

# Check recent events
curl -s -X POST "https://preview.websitehub.co.za/admin/health" \
  -H "x-admin-key: ADMIN_KEY_CLAUDEROX"

# Query D1
curl -s -X POST "https://preview.websitehub.co.za/admin/query" \
  -H "x-admin-key: ADMIN_KEY_CLAUDEROX" \
  -H "Content-Type: application/json" \
  -d '{"sql":"SELECT business_name, slug, status, package FROM clients ORDER BY created_at DESC LIMIT 10"}'

# Silent rebuild
curl -s -X POST "https://preview.websitehub.co.za/admin/trigger-rebuild" \
  -H "x-admin-key: ADMIN_KEY_CLAUDEROX" \
  -H "Content-Type: application/json" \
  -d '{"slug":"clientslug","silent":true}'

# Test WhatsApp
curl -s -X POST "https://preview.websitehub.co.za/admin/test-whatsapp" \
  -H "x-admin-key: ADMIN_KEY_CLAUDEROX" \
  -H "Content-Type: application/json" \
  -d '{"to":"27790128508","message":"Test"}'

# Simulate payment (full go-live test)
curl -s -X POST "https://wh-launch.pierreduplessis6912.workers.dev/admin/simulate-payment" \
  -H "x-admin-key: ADMIN_KEY_CLAUDEROX" \
  -H "Content-Type: application/json" \
  -d '{"slug":"clientslug","amount":599}'
```

---

## Known Issues / Pending

1. **@lid WhatsApp** — Android users show as @lid JID. Debug logging in events table (`event_type = incoming_debug`).
2. **0-Three-5 GBP data** — short URL wasn't resolved at original intake. GBP photos not in build. Site rebuilt with Unsplash fallback. Acceptable for now.
3. **Map section** — Google Maps embed added to all archetypes but requires `address` from GBP data. Businesses without GBP data won't show map.
4. **DOMAIN_PROXY_SECRET** — should be Cloudflare secret on wh-build + wh-launch (value: mysecretkey123). Fallback hardcoded.
5. **Enrichment worker** — deprecated Claude model string on line 369. Fix before use.
