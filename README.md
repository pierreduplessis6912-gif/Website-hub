# Website Hub

Zero-touch website creation and hosting for South African small businesses.

---

## THE FLOW — How it works, how it has always worked, how it will always work

There are two types of customers: **Inbound** and **Outbound (Scrape/Prospect)**.

Both converge at the same substance intake and follow the same path to go-live.

---

### INBOUND CUSTOMER

```
1. Landing page (start-v2)
   └─ Domain availability check (/domain-check)
   └─ Fills: business name, industry, phone, email, package
   └─ POST /intake → D1 INSERT clients (status='lead', source='website')
   └─ Returns: { slug, manage_token, clientId }

2. Building screen (PWA polls /build-status?token=...)
   └─ Queue: pre_build fires → triggerPreBuild()
      ├─ Pass 1: Brand intelligence (Claude) — inferred tone, hero angle, taglines
      ├─ Pass 2: Skeleton content (Claude) — hero, services, CTAs, word-limited JSON
      ├─ Pass 3: Mobile UX check (Claude, non-fatal) — fixes failing fields only
      └─ KV write: preview:skeleton:{slug}
      └─ D1: status='preview_ready'

3. Substance intake (PWA — the card questions)
   └─ Cards: industry, services, differentiators, CTA, audience, testimonial, logo, palette
   └─ Upgrade gates visible — locked features shown with delta price
   └─ Client upgrades inline (Express → Standard → Premium) — unlocks more cards
   └─ POST /trigger-rebuild → D1 UPDATE clients + BUILD_QUEUE.send(substance_build)

4. Building screen (PWA polls again)
   └─ Queue: substance_build fires → triggerSubstanceBuild()
      ├─ Pass 1: Personality + brand direction (Claude) — hero layout, opening strategy, colours
      ├─ Pass 2: Full copy per section (Claude) — voice-specific, no templates
      ├─ Pass 3: Photo fetch (Unsplash, industry-matched)
      ├─ Generates full HTML with structural CSS + design tokens
      └─ KV write: preview:{slug} (with watermark — about/contact gated behind CTA)
      └─ D1: status='preview_ready'

5. Preview → Go Live
   └─ PWA shows preview with "Go Live" CTA
   └─ POST /go-live-link (launch-worker) → generates PayFast URL
   └─ Client pays → PayFast ITN → POST /payfast-webhook
   └─ handleGoLiveInternal():
      ├─ Apply panel choices to drafts
      ├─ Strip watermark → write live:{domain}:{page} in KV
      ├─ D1: status='live', go_live_date, next_invoice_date, domain
      ├─ CF custom hostname bind (non-fatal)
      ├─ Domain registration via proxy (non-fatal)
      ├─ Zoho email provisioning (non-fatal, Premium only)
      ├─ Go-live WhatsApp → client
      ├─ Schedule D+1 / D+7 / D+30 / D+90 KV touch keys
      └─ Owner WhatsApp notification
```

---

### OUTBOUND (SCRAPE/PROSPECT) CUSTOMER

```
1. Prospect sourced (Google Places via admin dashboard or cron)
   └─ D1 INSERT prospects (status='approved')

2. Cron fires (handleCron in build-worker)
   └─ SELECT prospects WHERE status='approved' AND contacted_at IS NULL
   └─ D1 INSERT clients (source='outbound', status='lead')
   └─ Queue: pre_build (isOutbound=true)

3. Pre-build fires → same triggerPreBuild() as inbound
   └─ Watermark applied (strong CTA overlay — "Claim this site free →")
   └─ Preview stored in KV
   └─ WhatsApp sent to prospect with preview link + CTA

4. Prospect taps link → sees their preview site
   └─ Watermark CTA: "Claim this site free →" → /start URL
   └─ *** CONVERGES WITH INBOUND AT START PAGE ***
   └─ Prospect fills intake (same as inbound Step 1 — domain, phone, email)
   └─ Then goes through substance intake (Step 3 above)
   └─ Then build → preview → go live (Steps 4–5 above)
```

**Both inbound and outbound converge at the substance intake and follow the identical path from there to go-live.**

---

### POST GO-LIVE

```
Client is Live
├─ Retainer payments → PayFast ITN → recurring retainer handler → D1 update
├─ Inbound WhatsApp → reactivate-worker /inbound-reply
│   ├─ YES (within 7 days of go-live) → GBP opt-in → launch-worker /google-profile
│   ├─ UPGRADE / PREMIUM → launch-worker /upgrade → PayFast link → rebuild
│   ├─ CANCEL → owner alert, manual admin decision
│   ├─ REACTIVATE → reactivateInternal() → site back live
│   └─ STOP → permanent opt-out (optout:{phone} KV key, no TTL)
├─ Non-payment → /suspend-site → suspended:{domain} KV → suspended page served
├─ Reinstatement → payment → PayFast ITN → reinstateInternal()
└─ Cancellation → /cancel-site → 3 options:
    ├─ archive  — site suspended, KV kept, win-back eligible at 90 days
    ├─ file     — live KV deleted, suspended:{domain} permanent
    └─ domain   — all KV deleted, CF hostname unbound
```

---

## REPO STRUCTURE

```
Website-hub/
├── .github/
│   └── workflows/
│       └── deploy.yml              ← GitHub Actions — deploys all 5 workers on push to main
│
├── build-worker/
│   ├── wrangler.toml
│   └── src/
│       ├── index.js                ← Intake, pre-build, substance build, site serving, outbound cron
│       └── shared-services.js      ← SOURCE OF TRUTH — copied to all workers by deploy.yml
│
├── patch-worker/
│   ├── wrangler.toml
│   └── src/
│       ├── index.js                ← Revisions, photo uploads, asset management
│       └── shared-services.js      ← Copied from build-worker/src/ by deploy.yml
│
├── launch-worker/
│   ├── wrangler.toml
│   └── src/
│       ├── index.js                ← PayFast webhooks, go-live, suspend, upgrade, GBP, Zoho
│       └── shared-services.js      ← Copied from build-worker/src/ by deploy.yml
│
├── pulse-worker/
│   ├── wrangler.toml
│   └── src/
│       ├── index.js                ← Autonomy sweep (cron */5), health checks, win-back, referral leaderboard
│       └── shared-services.js      ← Copied from build-worker/src/ by deploy.yml
│
├── reactivate-worker/
│   ├── wrangler.toml
│   └── src/
│       ├── index.js                ← Inbound WhatsApp routing, cancel, reactivate, opt-out
│       └── shared-services.js      ← Copied from build-worker/src/ by deploy.yml
│
├── design-db.js                    ← Personality genome system, design briefs, CSS variables
├── photo-db.js                     ← Industry photo query pools for Unsplash
├── intake-experience.html          ← PWA source (design source of truth)
├── preview-manage-new.html         ← Preview/manage SPA
├── docs/
│   └── PWA-WIRING-MAP.md           ← PWA screen map, endpoint wiring, build steps
└── templates/                      ← KV template restoration source (30 archetype templates)
```

---

## WORKER RESPONSIBILITIES

| Worker | Trigger | Owns |
|---|---|---|
| **build-worker** | HTTP + Queue + Cron | Intake, pre-build, substance build, site serving, outbound cron |
| **patch-worker** | HTTP + Queue | Revisions, photo uploads, vision extraction, asset management |
| **launch-worker** | HTTP | PayFast webhooks, go-live, suspend/reinstate, upgrade, GBP, Zoho invoicing |
| **pulse-worker** | Cron (every 5 min) | Autonomy sweep, health monitoring, win-back, referral leaderboard |
| **reactivate-worker** | HTTP (Meta webhook) | Inbound WhatsApp routing, cancel, reactivate, opt-out |

---

## SHARED SERVICES

`build-worker/src/shared-services.js` is the **single source of truth** for all shared logic.

The `deploy.yml` copies it to every other worker's `src/` directory before deploying. **Never edit the copy — always edit the source.**

Exports include: `PRICING`, `PACKAGE_CAPS`, `callClaudeInternal`, `sendWhatsApp`, `normaliseSaPhone`, `isTestMode`, `getClientById`, `getClientBySlug`, `getClientByToken`, `updateClient`, `queryClients`, `logEvent`, `logActivity`, `logHealth`, `hasMessageBeenSent`, `getMonthlyVisits`, `vestReferral`, and all pricing/package helpers.

---

## DEPLOYMENT

All deployments go via **git push to main**. GitHub Actions handles everything.

```bash
# From ~/Website-hub on Termux or laptop:
git add -A
git commit -m "your message"
git push
```

**Never use Wrangler CLI or the Cloudflare API directly from Termux.** Both are blocked.

Deploy order (enforced by `needs:` in deploy.yml):
```
deploy-build → deploy-patch → deploy-launch → deploy-pulse → deploy-reactivate
```

shared-services is synced to each worker before its deploy step:
```yaml
- name: Sync shared-services
  run: cp build-worker/src/shared-services.js {worker}/src/shared-services.js
```

---

## INFRASTRUCTURE

| Resource | Purpose |
|---|---|
| **D1** (`wh-d1`) | All client data — clients, builds, events, visits, photos, referrals, invoices, messages, prospects |
| **KV** (`SITES`) | HTML blobs (preview/draft/live), PWA shells, config, health state, activity logs |
| **R2** (`ASSETS`) | Client photos, logos, gallery uploads, autonomy reasoning store |
| **BUILD_QUEUE** | Decouples intake from build — pre_build and substance_build job types |

---

## PRICING

| Package | Retainer | Pages | Features |
|---|---|---|---|
| Express | R299/mo | 1 (single scroll) | Domain, WhatsApp CTA, 1 revision/mo |
| Standard | R699/mo | 1 (single scroll) | + Analytics, referral rewards, extra pages available |
| Premium | R999/mo | 5 | + Gallery, unlimited revisions, email accounts |

Add-ons: Extra page R300 · Extra revision R500

---

## SECRETS (GitHub Actions)

Set via `gh secret set` or the GitHub repo settings. Injected into workers via `wrangler-action`.

**build-worker:**
`ANTHROPIC_KEY`, `UNSPLASH_ACCESS_KEY`, `WH_PHONE`, `ADMIN_KEY`, `EVOLUTION_API_URL`, `EVOLUTION_API_KEY`, `EVOLUTION_INSTANCE`

**launch-worker:**
`PAYFAST_MERCHANT_ID`, `PAYFAST_MERCHANT_KEY`, `PAYFAST_SANDBOX_MERCHANT_ID`, `PAYFAST_SANDBOX_MERCHANT_KEY`, `CF_ACCOUNT_ID`, `CF_API_TOKEN`, `CF_ZONE_ID`, `ANTHROPIC_KEY`, `WH_PHONE`, `ADMIN_KEY`, `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN`, `ZOHO_ORG_ID`, `REGISTERDOMAIN_API_KEY`, `DOMAIN_PROXY_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`

**pulse-worker:**
`ANTHROPIC_KEY`, `WH_PHONE`, `ADMIN_KEY`

**reactivate-worker:**
`META_VERIFY_TOKEN`, `META_WEBHOOK_SECRET`, `WH_PHONE`, `ADMIN_KEY`

---

## KV WRITES

KV can only be written via worker admin endpoints — never via the Cloudflare API directly.

```bash
# Example: write a KV key via the admin endpoint
curl -X POST https://wh-build.pierreduplessis6912.workers.dev/admin/set-config \
  -H "x-admin-key: ADMIN_KEY_CLAUDEROX" \
  -H "Content-Type: application/json" \
  -d '{ "flags": { "referralSystemLive": true } }'
```

---

## WORKER URLS

| Worker | URL |
|---|---|
| wh-build | `https://wh-build.pierreduplessis6912.workers.dev` |
| wh-patch | `https://wh-patch.pierreduplessis6912.workers.dev` |
| wh-launch | `https://wh-launch.pierreduplessis6912.workers.dev` |
| wh-pulse | `https://wh-pulse.pierreduplessis6912.workers.dev` |
| wh-reactivate | `https://wh-reactivate.pierreduplessis6912.workers.dev` |
| Preview domain | `https://preview.websitehub.co.za` |

---

## KEY RULES

- **shared-services.js** — edit only in `build-worker/src/`. The deploy pipeline distributes it.
- **KV writes** — always through worker admin endpoints, never the CF API.
- **Deployments** — always via `git push`. Never Wrangler CLI from Termux.
- **Test mode** — `isTestMode(env)` gates all external integrations. `TEST_MODE=false` is live.
- **CRLF line endings** — watch for this in Termux-edited files. Causes silent string replacement failures.
- **Autonomy kill switch** — KV key `autonomy:enabled` = `"false"` stops pulse-worker's sweep instantly.
- **Budget ceiling** — 50 Claude calls/day ($0.50 max). Over limit → WhatsApp Pierre, stop.

---

*Last updated: June 2026 — 5-worker architecture, D1-native, autonomy loop live*
