# Website Hub — Master Context
_Read this first. Every session. Before touching any file._
_Last updated: 2026-06-08_

---

## What this is

Website Hub is a fully automated website-as-a-service platform for South African small businesses. Owner: Pierre du Plessis. Solo founder, no coding background, builds entirely via AI-assisted sessions from an Android phone using Termux.

- **Repo:** github.com/pierreduplessis6912-gif/Website-hub (public)
- **Production:** websitehub.co.za (landing) + preview.websitehub.co.za (platform)
- **Admin:** preview.websitehub.co.za/admin — key: ADMIN_KEY_CLAUDEROX
- **Goal:** R1M ARR by December 25, 2026
- **Live clients:** Classic Touch Salon (classictouchsalon) — Pierre's mom

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
| Cloudflare Workers | 6 workers — see below |
| Cloudflare D1 | database_id: 9c422081-af06-4c1b-b59e-f40e0d08fefa |
| Cloudflare KV | SITES namespace: b63e5b885ead4c02a9e184dd6477e711 |
| Cloudflare R2 | wh-assets bucket |
| Cloudflare Zone | websitehub.co.za — Zone ID: e6b58b08eb80ea03a46d010455f6b25d |
| CF Account ID | 4c559b9dff9fae56803b9c275b518597 |
| Evolution API | https://evolution.websitehub.co.za — instance: wa1 — key: mysecretkey123 |
| PayFast | Live mode — TEST_MODE = "false" — merchant: 13581217 |
| cPanel Proxy | classictouchsalon.co.za/rd-proxy.php — secret: mysecretkey123 |
| Registerdomain | API key in launch-worker wrangler.toml |
| GitHub Actions | Smart deploy — only changed workers — wrangler-action@v4, wrangler 3.90.0 |

---

## DNS (Cloudflare zone — websitehub.co.za)

| Route | Worker |
|-------|--------|
| websitehub.co.za/* | wh-build |
| preview.websitehub.co.za/* | wh-build |
| *.websitehub.co.za/* | wh-sites |

Wildcard A record `*` → proxied → Cloudflare.
Routes managed manually in Cloudflare zone — NOT in wrangler.toml (causes conflicts).

---

## Worker Architecture (6 workers)

| Worker | Job | Bindings |
|--------|-----|----------|
| wh-build | Public entry point, admin, builds, intake, OG cards, incoming WhatsApp | DB, SITES, R2, Queue, LAUNCH_WORKER, PATCH_WORKER |
| wh-launch | Go-live, PayFast webhook, email provisioning, subscriptions, manage panel API | DB, SITES |
| wh-patch | Revisions | DB, SITES, R2 |
| wh-pulse | Daily cron — dunning, post-golive touches, promo nudge, referral vesting, win-back | DB, SITES |
| wh-reactivate | Reactivations after suspension | DB, SITES |
| wh-sites | Serve live client sites from KV by hostname | SITES |

### Data layer rules (LOCKED)
- **D1** = single source of truth. Write here first, always.
- **KV** = read cache only. Write after D1. Key: `live:{domain}`, `preview:{slug}`, `app:{page}`
- **Queue** = carries clientId only. Never secrets.

---

## Packages & Pricing

| Package | Build Fee | Monthly | Domain |
|---------|-----------|---------|--------|
| Hub | R7,000 | R699/mo | slug.websitehub.co.za |
| Hub Pro | R7,000 | R999/mo | slug.co.za (registered via registerdomain) |
| Promo (LAUNCH2026) | R0 | R599/mo | slug.websitehub.co.za |

- `packageKey()` in shared-services.js maps all legacy names (express/standard/premium) → hub/hub_pro
- Only upgrade path: Hub → Hub Pro (+R300/mo)
- All plans: gallery, 2 email reroutes, WhatsApp + Call FAB, referral program (promo only)
- Hub: 2 revisions/month. Hub Pro: 5 revisions/month.

---

## Build Pipeline

**Trigger:** intake → D1 insert → Queue → `triggerFullBuild`

**6 passes:**
1. Pass 0 — archetype selection (emergency/trust/experience/local/results)
2. Pass 1 — brand + GBP data fetch
3. Pass 2 — skeleton HTML
4. Pass 3 — UX layer (non-fatal)
5. Pass 4 — rich brand + GBP photos
6. Pass 5 — content
7. Pass 6 — quality gate (non-fatal)

**Build time:** ~60 seconds. One Claude API call (Anthropic). One WhatsApp on completion.

**Archetypes:** 5 files in `build-worker/src/archetypes/` — emergency.js, experience.js, local.js, results.js, trust.js. All have dual FAB (📞 Call + 💬 WhatsApp), rating badge top-right, photo gallery carousel.

**Photo sources:** GBP photos via cPanel proxy → Unsplash fallback.

---

## Go-Live Flow (PayFast)

1. Client taps Go Live in preview SPA → PayFast subscription created
   - `frequency: 3` (monthly), `cycles: 0` (infinite)
   - `notify_url`: preview.websitehub.co.za/payfast-webhook
   - `return_url`: preview.websitehub.co.za/manage/{token}
2. PayFast fires webhook → wh-launch `/payfast-webhook`
3. Signature verified → `handleGoLivePayment` → `handleGoLiveInternal`
4. `handleGoLiveInternal`:
   - Writes `live:{domain}` to KV
   - Updates D1 status → live
   - Provisions email reroutes (hello@ + info@) via Cloudflare Email Routing API
   - Sends go-live WhatsApp to client
   - Sends 🎉 I GOT A SALE to WH_PHONE and Kimmy (27798916569)
5. `payfast_token` stored on client for cancellation

**Cancellation:** Client taps Cancel in manage panel → `/cancel-subscription` → PayFast API cancel → status → cancellation_pending → site live until next_invoice_date → pulse suspends.

---

## Email Rerouting (Cloudflare Email Routing API)

- Provisioned on go-live: `hello@{domain}` + `info@{domain}` → client's personal email
- Free on all Cloudflare plans
- Hub clients: on websitehub.co.za zone
- Hub Pro clients: on their own .co.za zone (added to Cloudflare on registration)
- Token: `CF_API_TOKEN` secret on wh-launch (Zone: Email Routing Rules: Edit + Zone: DNS: Edit + Zone: SSL: Edit + Zone: Zone: Read)

---

## WhatsApp Touchpoints (Complete)

| Trigger | Recipient | Message |
|---------|-----------|---------|
| Build complete (outbound promo) | Client | Brand intro, R7k value, today only, R599/mo |
| Build complete (outbound non-promo) | Client | Brand intro, R7k build fee, R699/mo |
| Build complete (inbound) | Client | "Your site is ready" + OG card link |
| 24hr nudge (promo, no payment) | Client | "Complimentary build worth R7k still waiting" |
| Go-live | Client | Site URL, manage panel, emails, next invoice, referral link |
| D1 check-in | Client | "How's it going, any tweaks?" |
| D7 | Client | Referral nudge — 10 friends → Hub Pro domain free |
| D30 Hub | Client | Upgrade R300/mo or refer 10 free |
| D30 Hub Pro | Client | "Hope it's bringing in customers" |
| Dunning D0 | Client | Payment due today |
| Dunning D3 | Client | 3 days late nudge |
| Dunning D7 | Client | Suspension warning |
| Win-back (D90) | Client | Reactivation offer, no rebuild fee within a year |
| Go-live | WH_PHONE | LIVE: business, domain, plan, retainer |
| Every sale | WH_PHONE + 27798916569 | 🎉 I GOT A SALE |
| Client reply (incoming WA) | WH_PHONE | Forwarded with business name + reply link |
| Email setup request | Client | Personalised Gmail Send-As instructions |

---

## Referral Program

- **Eligibility:** Promo clients only (promo_code = LAUNCH2026)
- **Mechanic:** Share `websitehub.co.za/r/{slug}` — referred friends get same promo deal automatically
- **Reward:** 10 live referrals → Hub Pro upgrade (own .co.za domain registered free)
- **Automation:** Pulse worker `runReferralVesting` checks daily → upgrades → WhatsApp
- **Manage panel:** Progress bar 0/10, copy link, WhatsApp share button
- **No leaderboard. No cash. No credit. Domain upgrade only.**
- Terms: /referral-terms

---

## KV Key Schema

```
app:landing          — landing-v4.html
app:start-v2         — start-v3.html (intake form)
app:preview          — preview.html (preview SPA)
app:manage           — manage.html (manage panel SPA)
app:admin            — admin.html
app:privacy          — privacy.html
app:terms            — terms.html
app:cancellation     — cancellation.html
app:aup              — aup.html
app:dpa              — dpa.html
app:referral-terms   — referral-terms.html

preview:{slug}       — built HTML (pre-live, watermarked)
live:{domain}        — live HTML (served by wh-sites)
site:{slug}          — raw built HTML

promo_nudge_sent:{clientId}    — guard: 24hr nudge sent
post_golive_d1:{clientId}      — schedule: D1 check-in
post_golive_d7:{clientId}      — schedule: D7 referral nudge
upsell:{clientId}              — schedule: D30 upsell
winback_eligible:{clientId}    — schedule: D90 win-back
rate:intake:ip:{ip}            — rate limit: 3/hr per IP
rate:intake:global:{date}      — rate limit: 50/day global
optout:{phone}                 — POPIA opt-out flag
```

---

## D1 Schema (clients table — key columns)

```sql
id, business_name, client_name, slug, phone, email
package          — hub | hub_pro | promo (legacy: express/standard/premium)
retainer         — 599 | 699 | 999
promo_code       — LAUNCH2026 | null
status           — lead | building | preview_ready | live | cancellation_pending | suspended | cancelled
manage_token     — UUID (client's auth token for manage panel)
referral_slug    — short slug for referral link
referred_by      — slug of referring client
domain           — null (Hub) | slug.co.za (Hub Pro)
payfast_token    — PayFast subscription token (for cancel API)
visits           — counter (incremented by /{slug}/ping)
wa_taps          — counter (incremented by /{slug}/wa)
go_live_date, next_invoice_date, payment_date
```

---

## Brand Stack

| Element | Value |
|---------|-------|
| Background | #0e0c09 |
| Accent | #00f0ff (cyan) |
| Text | #f0ede8 |
| Display font | Syne (400/600/700/800) |
| Body font | DM Sans (300/400/500) |
| Mono font | DM Mono (400/500) |
| Google Fonts import | Syne + DM Sans + DM Mono |

All customer-facing pages use this stack: landing, start, preview, manage, all legal pages.

---

## Customer-Facing Pages

| URL | KV Key | File | Description |
|-----|--------|------|-------------|
| websitehub.co.za | app:landing | landing-v4.html | Dark glassmorphism landing |
| /start | app:start-v2 | start-v3.html | Intake form |
| /preview/{token} | app:preview | preview.html | Preview SPA + payment |
| /manage/{token} | app:manage | manage.html | Client manage panel |
| /privacy | app:privacy | privacy.html | POPIA privacy policy |
| /terms | app:terms | terms.html | Terms of service |
| /cancellation | app:cancellation | cancellation.html | Cancellation policy |
| /aup | app:aup | aup.html | Acceptable use policy |
| /dpa | app:dpa | dpa.html | Data processing agreement |
| /referral-terms | app:referral-terms | referral-terms.html | Referral programme terms |

**Bootstrap command pattern:**
```bash
curl -s -X POST "https://preview.websitehub.co.za/admin/bootstrap-{page}" \
  -H "x-admin-key: ADMIN_KEY_CLAUDEROX" -H "Content-Type: text/html" \
  --data-binary @"$HOME/Website-hub/{file}.html"
```

---

## Legal & Compliance

- **POPIA registered:** Information Regulator of South Africa — Reg. No. 2026-024548
- **Information Officer:** B.P. du Plessis
- **Subscription disclosure:** On all pricing surfaces — "monthly recurring debit until cancelled"
- **Cancellation:** Self-serve in manage panel → PayFast API cancel → site live until billing period end
- **STOP opt-out:** Reply STOP to any WhatsApp → optout:{phone} KV flag → no further messages

---

## Security

| Surface | Protection |
|---------|-----------|
| /admin/* | x-admin-key: ADMIN_KEY_CLAUDEROX |
| /manage/* /preview/* | UUID manage_token required |
| /payfast-webhook | PayFast ITN signature verification |
| /whatsapp-incoming | Evolution apikey header verification |
| /intake | IP rate limit 3/hr + phone dedup 24hr + global 50/day |
| /trigger-rebuild | Valid manage_token required |
| Public HTML | No secrets, no admin endpoints |

**Cloudflare secrets set on workers (not in wrangler.toml):**
- wh-build: ANTHROPIC_KEY, EVOLUTION_URL, EVOLUTION_KEY, EVOLUTION_INSTANCE, WH_PHONE, GOOGLE_MAPS_API_KEY, DOMAIN_PROXY_SECRET, UNSPLASH_ACCESS_KEY, ADMIN_KEY
- wh-launch: CF_API_TOKEN (Email Routing), PAYFAST_MERCHANT_KEY, PAYFAST_PASSPHRASE, PAYFAST_SANDBOX_MERCHANT_ID, PAYFAST_SANDBOX_MERCHANT_KEY, DOMAIN_PROXY_SECRET, ADMIN_KEY

---

## GitHub Actions (Smart Deploy)

Uses `dorny/paths-filter` — only deploys workers whose files changed.
- build-worker changes → deploys wh-build only (~30s)
- launch-worker changes → deploys wh-launch only (~30s)
- HTML file changes → 0 workers deployed (bootstrap manually)

**Important:** HTML files (landing, start, preview, manage, legal) are NOT deployed by GitHub Actions. They must be bootstrapped manually to KV after each change.

---

## Admin Routes (all require x-admin-key)

```
POST /admin/query               — raw D1 SQL
POST /admin/migrate             — run migration SQL
POST /admin/force-live          — force client live (bypasses payment)
POST /admin/trigger-rebuild     — rebuild a client's site by slug
POST /admin/delete-kv           — delete KV keys by array
POST /admin/purge-cache         — clear SPA cache from KV
POST /admin/bootstrap-{page}    — write HTML to KV
POST /admin/delete-client       — delete client by slug
POST /admin/test-whatsapp       — send test WhatsApp
POST /admin/simulate-payment    — simulate PayFast payment (testing)
GET  /admin/health              — platform health check
GET  /admin/clients             — all clients JSON
```

On wh-launch:
```
POST /admin/simulate-payment    — trigger full go-live pipeline for testing
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
0007_visit_counters.sql         — visits, wa_taps columns
0008_payfast_token.sql          — payfast_token column
```

**Run migration:**
```bash
curl -s -X POST "https://preview.websitehub.co.za/admin/migrate" \
  -H "x-admin-key: ADMIN_KEY_CLAUDEROX" \
  -H "Content-Type: application/json" \
  -d '{"sql":"ALTER TABLE clients ADD COLUMN new_col TEXT"}'
```

---

## Known Issues / Pending

1. **@lid WhatsApp** — Android users send @lid JID. Evolution contacts API lookup attempted but may not resolve. Debug logging in events table (`event_type = 'incoming_debug'`).
2. **0008_payfast_token migration** — needs running on D1 if not yet done.
3. **PayFast sandbox webhooks** — unreliable in sandbox. Live webhooks work correctly. Use `/admin/simulate-payment` for testing.
4. **DOMAIN_PROXY_SECRET** — should be set as Cloudflare secret on wh-build and wh-launch (value: mysecretkey123). Fallback hardcoded so not breaking.
5. **Enrichment worker** — deprecated Claude model string on line 369. Fix before use.

---

## Useful Commands

```bash
# Pull latest (ALWAYS FIRST)
cd ~/Website-hub && git pull --rebase origin main

# Check deploy status
curl -s -H "Authorization: token {GITHUB_TOKEN}" \
  "https://api.github.com/repos/pierreduplessis6912-gif/Website-hub/actions/runs?per_page=1" | \
  python3 -c "import sys,json; r=json.load(sys.stdin)['workflow_runs'][0]; print(r['conclusion'] or 'running', r['head_commit']['message'][:50])"

# Purge cache
curl -s -X POST "https://preview.websitehub.co.za/admin/purge-cache" \
  -H "x-admin-key: ADMIN_KEY_CLAUDEROX"

# Check D1 clients
curl -s -X POST "https://preview.websitehub.co.za/admin/query" \
  -H "x-admin-key: ADMIN_KEY_CLAUDEROX" \
  -H "Content-Type: application/json" \
  -d '{"sql":"SELECT business_name, slug, status, package FROM clients ORDER BY created_at DESC LIMIT 10"}'

# Simulate payment (test go-live pipeline)
curl -s -X POST "https://wh-launch.pierreduplessis6912.workers.dev/admin/simulate-payment" \
  -H "x-admin-key: ADMIN_KEY_CLAUDEROX" \
  -H "Content-Type: application/json" \
  -d '{"slug":"yourslug","amount":599}'

# Test WhatsApp
curl -s -X POST "https://preview.websitehub.co.za/admin/test-whatsapp" \
  -H "x-admin-key: ADMIN_KEY_CLAUDEROX" \
  -H "Content-Type: application/json" \
  -d '{"to":"27790128508","message":"Test"}'
```
