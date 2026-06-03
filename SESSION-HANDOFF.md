# Website Hub — Session Handoff D12
**Date:** 2026-06-03
**Status:** Major session — scraper working, GBP enrichment working, intake cleaned up

---

## CRITICAL INFRASTRUCTURE ADDED TODAY

### Oracle VPS Places Proxy
- **IP:** 84.8.128.245
- **Port:** 3001
- **URL:** https://places-proxy.websitehub.co.za (Cloudflare Tunnel)
- **File:** ~/places-proxy.js on VPS
- **Auth:** x-proxy-secret: mysecretkey123
- **API Key:** AIzaSyD167Z_n41uqRjqZx1k1vtc0Q0Ev2brDG8 (hardcoded in places-proxy.js)
- **Why:** Cloudflare Workers cannot call Google Places API directly (IP blocked). All Places API calls route through this proxy.
- **PM2:** Running as 'places-proxy', auto-starts on reboot
- **Managed by:** pm2 + cloudflared tunnel

### Request format to proxy:
```json
{
  "url": "https://places.googleapis.com/v1/places:searchText",
  "method": "POST",
  "fieldMask": "places.id,places.displayName,places.formattedAddress,...",
  "postBody": { "textQuery": "...", "regionCode": "ZA" }
}
```

### callPlacesProxy() helper in build-worker
All Google Places calls go through `callPlacesProxy(env, url, method, postBody, extraHeaders)`.
Never call places.googleapis.com directly from any worker — it will be blocked.

---

## SESSION ACCOMPLISHMENTS

### Scraper Working ✅
- `/admin/scrape` endpoint works via proxy
- Filters businesses without websites
- Inserts prospects into D1 `prospects` table
- Test: `curl -s -X POST "https://preview.websitehub.co.za/admin/scrape" -H "x-admin-key: ADMIN_KEY_CLAUDEROX" -H "Content-Type: application/json" -d '{"industry":"salon","province":"WC","limit":3}'`

### GBP Enrichment Working ✅
- Silent GBP lookup fires when customer selects address on /start
- place_id stored in D1 clients table (gbp_place_id, gbp_data columns)
- Substance build reads gbp_data from D1 and injects into Claude prompt
- Result: Classic Touch Unisex Hair & Beauty Salon — real services, real copy from GBP

### Address Autocomplete on /start ✅
- Address field added to start-v3.html
- Calls /address-suggest endpoint → routes through proxy → Google Places Autocomplete
- Returns place_id + description
- place_id sent with intake payload → background GBP lookup fires

### Intake Cards Cleaned Up ✅
- Area card removed (duplicate of start page address field)
- GBP card removed (enrichment now silent)
- Correct order: industry → services → hero-photo → about → [standard gate] social → logo → [premium gate] gallery → map → contact-form
- Express default plan everywhere (pkgKey fallback = 'express')

### BETA Promo Code ✅
- BETA code = 100% discount
- Calls /activate-free in launch-worker (skips PayFast)
- processPayment() in preview.html checks finalAmount === 0

### Outbound Cron in pulse-worker ✅
- runOutboundScrape() added
- Calls /admin/scrape via fetch
- Respects dry_run config flag
- dry_run currently set to 'true' in D1 config — change to 'false' when ready

---

## CURRENT STATE

### Config in D1 (key items):
- dry_run: 'true' — flip to 'false' to enable auto-building from queue
- outbound_enabled: 'true'
- google_maps_key: 'AIzaSyD167Z_n41uqRjqZx1k1vtc0Q0Ev2brDG8' (stored here as backup)
- daily_scrape_limit: 20
- target_provinces: ["KZN"] (add more as needed)

### Google OAuth:
- OAuth app published to Production (no longer Testing mode)
- Refresh token valid but NOT used for Places API (uses API key instead)
- Places API uses Maps Platform API Key via VPS proxy

### Workers deployed (all green):
- build-worker: scrape, GBP enrichment, address autocomplete, all via proxy
- launch-worker: activate-free endpoint added
- pulse-worker: outbound scrape cron added
- patch-worker, reactivate-worker: unchanged

### Cloudflare DNS:
- websitehub.co.za A record: GREY CLOUD (DNS only) — required for domain-proxy.php to work from workers
- places-proxy.websitehub.co.za CNAME: orange cloud → Cloudflare Tunnel → Oracle VPS port 3001

---

## KNOWN ISSUES / NEXT SESSION

1. **Config store** — set-config writes to D1, but the admin panel sometimes reads from KV config blob. Need to consolidate.
2. **dry_run toggle** in admin panel doesn't render — JS added but HTML pattern didn't match.
3. **Approve & Build flow** — queue shows prospects but end-to-end approve → build → WhatsApp not tested.
4. **Address autocomplete** on /start — field added, not yet tested in browser.
5. **Express price** — shows R399 in intake but R299 in PRICING object. Check consistency.
6. **Admin endpoint audit** — many debug/temp endpoints added over sessions, need cleanup.
7. **deploy.yml cleanup** — fix_deploy*.py scripts in repo root, should be removed.
8. **Zululand Flooring beta** — clean slug will be 'zululandflooring', delete old records first.

---

## SNAG LIST STATUS

✅ 1. Clean slug generation
✅ 3. 54 industries + search bar  
✅ 4. Unsplash — dropped "south africa"
✅ 5. Industry field on start page
✅ 8. Hero photo card — open to all plans
✅ 10. Express default + R399
✅ Package carries through to checkout (build-status returns package field)
✅ Intake defaults to Express — gates in correct order

⏳ 2. Gate ordering — DONE but needs visual test
⏳ 6. OG card WhatsApps — committed but reverted, needs redo
⏳ 7. Email routing per package
⏳ 9. Gallery photos R2
⏳ 11. Yearly subscriptions
⏳ 12. Invoice design

---

## KEY COMMANDS

### Reset a stuck build:
```bash
curl -s -X POST "https://preview.websitehub.co.za/admin/delete-client" \
  -H "x-admin-key: ADMIN_KEY_CLAUDEROX" \
  -H "Content-Type: application/json" \
  -d '{"slug":"SLUG_HERE"}'
```

### Bootstrap KV files:
```bash
cd ~/Website-hub && git pull
curl -s -X POST "https://preview.websitehub.co.za/admin/bootstrap-intake" -H "x-admin-key: ADMIN_KEY_CLAUDEROX" -H "Content-Type: text/html" --data-binary @intake.html
curl -s -X POST "https://preview.websitehub.co.za/admin/bootstrap-preview" -H "x-admin-key: ADMIN_KEY_CLAUDEROX" -H "Content-Type: text/html" --data-binary @preview.html
curl -s -X POST "https://preview.websitehub.co.za/admin/bootstrap-start" -H "x-admin-key: ADMIN_KEY_CLAUDEROX" -H "Content-Type: text/html" --data-binary @start-v3.html
```

### Check health:
```bash
curl -s "https://preview.websitehub.co.za/admin/health" -H "x-admin-key: ADMIN_KEY_CLAUDEROX"
```

### Manual scrape:
```bash
curl -s -X POST "https://preview.websitehub.co.za/admin/scrape" -H "x-admin-key: ADMIN_KEY_CLAUDEROX" -H "Content-Type: application/json" -d '{"industry":"plumber","province":"KZN","limit":10}'
```

### SSH to Oracle VPS:
```bash
ssh -i ~/storage/downloads/ssh-key-2026-05-30.key ubuntu@84.8.128.245
```

### Check VPS services:
```bash
pm2 list          # places-proxy should be online
docker ps         # evolution_api, postgres, redis should be up
sudo systemctl status cloudflared  # tunnel should be active
```
