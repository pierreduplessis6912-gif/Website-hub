# Website Hub

**Automated website-as-a-service platform for South African small businesses.**

Built by a solo founder on an Android phone using Termux and Claude AI.

---

## What it does

1. **Scrape** — finds businesses without websites on Google Places
2. **Build** — generates a professional website in 60 seconds using Claude AI + GBP data
3. **Blast** — sends a WhatsApp with their preview site and a promo offer
4. **Convert** — customer taps link, sees their site, pays R599/month
5. **Go live** — site deploys to their subdomain or custom .co.za domain

---

## Pricing

| Plan | Price | Domain |
|------|-------|--------|
| Hub | R599/month | slug.websitehub.co.za |
| Hub Pro | R999/month | yourdomain.co.za |

Promo code `LAUNCH2026` waives the build fee.

---

## Architecture

| Component | Technology |
|-----------|-----------|
| Workers | Cloudflare Workers (wh-build, wh-patch, wh-launch, wh-pulse, wh-reactivate) |
| Database | Cloudflare D1 (SQLite) |
| Cache | Cloudflare KV |
| Storage | Cloudflare R2 |
| Queue | Cloudflare Queues |
| WhatsApp | Evolution API |
| Payments | PayFast |
| AI | Anthropic Claude |
| Photos | Google Places API + Unsplash |
| DNS | DNSimple |

---

## Key files

- `build-worker/src/index.js` — main build worker (4000+ lines)
- `build-worker/src/archetypes/` — 5 site archetypes (emergency, experience, trust, local, results)
- `design-db.js` — industry → personality → archetype mapping (ROOT, imported by Worker)
- `blast.html` — admin blast dashboard
- `godmode.html` — admin custom build interface
- `preview.html` — client preview and manage panel

---

## Admin access

- Blast: `websitehub.co.za/blast`
- God Mode: `websitehub.co.za/godmode`
- Admin key: `ADMIN_KEY_CLAUDEROX`

---

## See also

- `CONTRIBUTING.md` — deployment SOP and rules
- `docs/CONTEXT.md` — full session history and architecture decisions
